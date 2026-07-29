// ===== 运行模式检测（Tauri vs 浏览器） =====
// 共用代码库：Tauri 桌面端走 plugin-http 直连后端，浏览器端走 Nginx 反代（或用户勾选直连）
// 两种模式完全隔离：isTauri 判定仅在内存中，不写 localStorage，不污染浏览器侧配置
function _detectIsTauri() {
    try {
        return !!(window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined);
    } catch (e) { return false; }
}
const IS_TAURI = _detectIsTauri();

// ===== Tauri 环境下替换 fetch 为 plugin-http invoke =====
(function initTauri() {
    if (!IS_TAURI) return;
    const invoke = (window.__TAURI__?.core?.invoke) ||
                   (window.__TAURI_INTERNALS__?.invoke);
    if (!invoke) return;

    // 关键：保存原生 fetch，IPC 请求（http://ipc.localhost/）必须走原生，否则无限递归
    const nativeFetch = window.fetch.bind(window);
    function isIpcUrl(input) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        return url.indexOf('ipc.localhost') !== -1 || url.indexOf('tauri://') === 0;
    }

    window.fetch = async function (input, init) {
        // IPC 请求直接走原生 fetch，不经过 plugin-http
        if (isIpcUrl(input)) return nativeFetch(input, init);

        init = init || {};
        const req = new Request(input, init);
        const t0 = performance.now();
        try {
            const headersObj = init.headers
                ? (init.headers instanceof Headers ? init.headers : new Headers(init.headers))
                : new Headers();
            const buffer = await req.arrayBuffer();
            const data = buffer.byteLength !== 0 ? Array.from(new Uint8Array(buffer)) : null;

            for (const [key, value] of req.headers.entries()) {
                if (!headersObj.get(key)) headersObj.set(key, value);
            }
            const mappedHeaders = [];
            for (const entry of headersObj.entries()) mappedHeaders.push([entry[0], typeof entry[1] === 'string' ? entry[1] : String(entry[1])]);

            // 第一步：创建请求
            const rid = await invoke('plugin:http|fetch', {
                clientConfig: {
                    method: req.method,
                    url: req.url,
                    headers: mappedHeaders,
                    data: data
                }
            });
            console.log('[Tauri fetch] fetch rid=', rid, '| url=', req.url);

            // 第二步：发送请求
            const sendResp = await invoke('plugin:http|fetch_send', { rid: rid });
            console.log('[Tauri fetch] fetch_send status=', sendResp.status, '| respRid=', sendResp.rid, '| ' + (performance.now() - t0).toFixed(0) + 'ms');
            const status = sendResp.status;
            const statusText = sendResp.statusText;
            const respUrl = sendResp.url || req.url;
            const responseHeaders = sendResp.headers || [];
            const responseRid = sendResp.rid;

            // 第三步：用 ReadableStream 异步消费 body（与官方 @tauri-apps/plugin-http 实现一致）
            // 优势：有背压，不会因空 chunk 死循环 flood IPC 通道
            const NO_BODY_STATUSES = [101, 103, 204, 205, 304];
            const body = NO_BODY_STATUSES.includes(status) ? null : new ReadableStream({
                start: (controller) => {
                    if (init.signal) {
                        if (init.signal.aborted) {
                            controller.error(new Error('Request cancelled'));
                            invoke('plugin:http|fetch_cancel_body', { rid: responseRid }).catch(() => {});
                        }
                        init.signal.addEventListener('abort', () => {
                            controller.error(new Error('Request cancelled'));
                            invoke('plugin:http|fetch_cancel_body', { rid: responseRid }).catch(() => {});
                        });
                    }
                },
                pull: async (controller) => {
                    let chunkData;
                    try {
                        chunkData = await invoke('plugin:http|fetch_read_body', { rid: responseRid });
                    } catch (e) {
                        console.error('[Tauri fetch] fetch_read_body error:', e);
                        controller.error(e);
                        return;
                    }
                    const u8 = new Uint8Array(chunkData);
                    if (u8.byteLength === 0) {
                        console.warn('[Tauri fetch] 收到空响应，关闭流');
                        controller.close();
                        return;
                    }
                    const lastByte = u8[u8.byteLength - 1];
                    const actualData = u8.slice(0, u8.byteLength - 1);
                    if (lastByte === 1) {
                        if (actualData.byteLength > 0) controller.enqueue(actualData);
                        controller.close();
                        console.log('[Tauri fetch] body 读取完成 | ' + (performance.now() - t0).toFixed(0) + 'ms');
                        return;
                    }
                    controller.enqueue(actualData);
                },
                cancel: () => {
                    invoke('plugin:http|fetch_cancel_body', { rid: responseRid }).catch(() => {});
                }
            });

            const res = new Response(body, { status: status, statusText: statusText });
            Object.defineProperty(res, 'url', { value: respUrl, writable: false });
            Object.defineProperty(res, 'headers', { value: new Headers(responseHeaders), writable: false });
            return res;
        } catch (err) {
            console.error('[Tauri fetch error]', err, '| input:', input, '| ' + (performance.now() - t0).toFixed(0) + 'ms');
            throw err;
        }
    };
    console.log('[Tauri] fetch 已替换为 plugin:http invoke，直连后端：' + 'http://60.205.94.101:8080');

    // Ctrl+Alt+Shift+F12 切换 DevTools；拦截 F12 单键（WebView2 默认会打开 DevTools）
    window.addEventListener('keydown', function(e) {
        if (e.key === 'F12') {
            if (e.ctrlKey && e.altKey && e.shiftKey) {
                e.preventDefault();
                invoke('toggle_devtools').catch(function(err) {
                    console.error('[Tauri] toggle_devtools 调用失败:', err);
                });
            } else {
                // 拦截 F12 单键，避免与 Ctrl+Alt+Shift+F12 冲突
                e.preventDefault();
            }
        }
    });
    console.log('[Tauri] 已注册 Ctrl+Alt+Shift+F12 切换 DevTools');
})();

// ===== 运行模式对应的 API / WS / 媒体资源基地址 =====
// Tauri 桌面端：固定走后端完整地址（plugin-http 自带跨域能力，不需要前端反代）
// 浏览器端：默认走 Nginx 同源反代（oc_proxy_mode=on，默认），用户可切换为直连（oc_proxy_mode=off，需要后端支持 CORS）
const BACKEND_HOST = '60.205.94.101:8080';
const BACKEND_ORIGIN = 'http://' + BACKEND_HOST;

// 浏览器模式下：代理模式(默认 on) → 同源反代；off → 直连后端完整地址
const _proxyOn = IS_TAURI ? false : (localStorage.getItem('oc_proxy_mode') !== 'off');

const API_BASE = IS_TAURI
    ? BACKEND_ORIGIN + '/v1'
    : (_proxyOn ? '/v1' : (BACKEND_ORIGIN + '/v1'));
const WS_HOST = IS_TAURI
    ? BACKEND_HOST
    : (_proxyOn ? window.location.host : BACKEND_HOST);
const MEDIA_BASE = IS_TAURI
    ? BACKEND_ORIGIN
    : (_proxyOn ? BACKEND_ORIGIN : '');

function resolveMediaUrl(url) {
    if (!url) return url;
    if (/^(https?:|data:|blob:)/.test(url)) return url;
    if (MEDIA_BASE && url.startsWith('/')) return MEDIA_BASE + url;
    return url;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTimeSeparator(ts) {
    const now = new Date();
    const d = new Date(ts * 1000);
    const pad = n => (n < 10 ? '0' : '') + n;
    const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const isSameDay = d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (isSameDay) return hhmm;
    const isSameYear = d.getFullYear() === now.getFullYear();
    if (isSameYear) return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hhmm;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hhmm;
}

function createTimeSeparator(ts) {
    const div = document.createElement('div');
    div.className = 'time-separator';
    div.textContent = formatTimeSeparator(ts);
    return div;
}


function openImageViewer(src) {
	let overlay = document.getElementById('imageOverlay');
	let img = document.getElementById('imageOverlayImg');
	let dragging = false;
	let hasDragged = false;
	let startX = 0,
		startY = 0;
	let imgStartX = 0,
		imgStartY = 0;
	if (!overlay) {
		overlay = document.createElement('div');
		overlay.id = 'imageOverlay';
		overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:none;justify-content:center;align-items:center;z-index:99999;opacity:0;transition:opacity 0.25s ease;cursor:grab;user-select:none;touch-action:none;`;
		img = document.createElement('img');
		img.id = 'imageOverlayImg';
		img.style.cssText = `max-width:90%;max-height:90%;object-fit:contain;border-radius:4px;transform:scale(1)translate(0px,0px);transition:transform 0.2s ease;pointer-events:none;user-select:none;`;
		img.draggable = false;
		img._scale = 1;
		img._translateX = 0;
		img._translateY = 0;
		overlay.appendChild(img);
		document.body.appendChild(overlay);

		function closeViewer() {
			overlay.style.opacity = '0';
			img.style.transform = 'scale(1) translate(0px, 0px)';
			img._scale = 1;
			img._translateX = 0;
			img._translateY = 0;
			overlay.addEventListener('transitionend', function handler() {
				overlay.style.display = 'none';
				overlay.removeEventListener('transitionend', handler)
			})
		}

		function applyTransform() {
			const s = img._scale || 1;
			const tx = img._translateX || 0;
			const ty = img._translateY || 0;
			img.style.transform = `scale(${s})translate(${tx}px,${ty}px)`;
		}

		function clampTranslation() {
			const s = img._scale || 1;
			const rect = img.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			let maxTx = 0, maxTy = 0;
			if (rect.width * s > vw) {
				maxTx = (rect.width * s - vw) / (2 * s);
			}
			if (rect.height * s > vh) {
				maxTy = (rect.height * s - vh) / (2 * s);
			}
			img._translateX = Math.max(-maxTx, Math.min(maxTx, img._translateX));
			img._translateY = Math.max(-maxTy, Math.min(maxTy, img._translateY));
		}

		overlay.addEventListener('click', function(e) {
			if (hasDragged) {
				hasDragged = false;
				return
			}
			closeViewer()
		});

		// === PC: mouse drag ===
		overlay.addEventListener('mousedown', function(e) {
			e.preventDefault();
			dragging = true;
			hasDragged = false;
			startX = e.clientX;
			startY = e.clientY;
			imgStartX = img._translateX || 0;
			imgStartY = img._translateY || 0;
			overlay.style.cursor = 'grabbing';
			img.style.transition = 'none'
		});
		window.addEventListener('mousemove', function(e) {
			if (!dragging) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			const scale = img._scale || 1;
			const newX = imgStartX + dx / scale;
			const newY = imgStartY + dy / scale;
			img._translateX = newX;
			img._translateY = newY;
			img.style.transform = `scale(${scale})translate(${newX}px,${newY}px)`;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
				hasDragged = true
			}
		});
		window.addEventListener('mouseup', function() {
			if (dragging) {
				dragging = false;
				overlay.style.cursor = 'grab';
				img.style.transition = 'transform 0.2s ease'
			}
		});

		// === PC: wheel zoom ===
		overlay.addEventListener('wheel', function(e) {
			e.preventDefault();
			let scale = img._scale || 1;
			const delta = e.deltaY > 0 ? -0.2 : 0.2;
			scale = Math.min(5, Math.max(0.5, scale + delta));
			img._scale = scale;
			clampTranslation();
			applyTransform();
		}, { passive: false });

		// === Touch: pinch-to-zoom, pan, double-tap ===
		let touchState = {
			touching: false,
			lastTap: 0,
			pinchStartDist: 0,
			pinchStartScale: 1,
			panStartX: 0,
			panStartY: 0,
			imgStartPanX: 0,
			imgStartPanY: 0,
			fingerCount: 0,
			hasMoved: false,
		};

		function getTouchDist(t1, t2) {
			const dx = t1.clientX - t2.clientX;
			const dy = t1.clientY - t2.clientY;
			return Math.sqrt(dx * dx + dy * dy);
		}

		function getTouchCenter(t1, t2) {
			return {
				x: (t1.clientX + t2.clientX) / 2,
				y: (t1.clientY + t2.clientY) / 2,
			};
		}

		overlay.addEventListener('touchstart', function(e) {
			const touches = e.touches;
			touchState.touching = true;
			touchState.fingerCount = touches.length;
			touchState.hasMoved = false;

			if (touches.length === 1) {
				// Single finger: check double-tap
				const now = Date.now();
				const t = touches[0];
				if (now - touchState.lastTap < 300) {
					// Double tap: toggle zoom
					e.preventDefault();
					if (img._scale > 1.2) {
						img._scale = 1;
						img._translateX = 0;
						img._translateY = 0;
					} else {
						img._scale = 2.5;
						const rect = img.getBoundingClientRect();
						const vw = window.innerWidth;
						const vh = window.innerHeight;
						img._translateX = (vw / 2 - t.clientX) / img._scale;
						img._translateY = (vh / 2 - t.clientY) / img._scale;
						clampTranslation();
					}
					img.style.transition = 'transform 0.3s ease';
					applyTransform();
					touchState.lastTap = 0;
					return;
				}
				touchState.lastTap = now;

				// Single finger pan
				e.preventDefault();
				img.style.transition = 'none';
				touchState.panStartX = t.clientX;
				touchState.panStartY = t.clientY;
				touchState.imgStartPanX = img._translateX || 0;
				touchState.imgStartPanY = img._translateY || 0;
				hasDragged = false;
			} else if (touches.length === 2) {
				// Two fingers: pinch start
				e.preventDefault();
				img.style.transition = 'none';
				touchState.pinchStartDist = getTouchDist(touches[0], touches[1]);
				touchState.pinchStartScale = img._scale || 1;
				touchState.imgStartPanX = img._translateX || 0;
				touchState.imgStartPanY = img._translateY || 0;
				const center = getTouchCenter(touches[0], touches[1]);
				touchState.panStartX = center.x;
				touchState.panStartY = center.y;
				hasDragged = true;
			}
		}, { passive: false });

		overlay.addEventListener('touchmove', function(e) {
			if (!touchState.touching) return;
			const touches = e.touches;

			if (touches.length === 1 && touchState.fingerCount === 1) {
				// Single finger pan
				e.preventDefault();
				const t = touches[0];
				const dx = t.clientX - touchState.panStartX;
				const dy = t.clientY - touchState.panStartY;
				const scale = img._scale || 1;
				img._translateX = touchState.imgStartPanX + dx / scale;
				img._translateY = touchState.imgStartPanY + dy / scale;
				clampTranslation();
				applyTransform();
				if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
					hasDragged = true;
					touchState.hasMoved = true;
				}
			} else if (touches.length === 2) {
				// Two finger pinch
				e.preventDefault();
				const dist = getTouchDist(touches[0], touches[1]);
				const ratio = dist / touchState.pinchStartDist;
				let newScale = touchState.pinchStartScale * ratio;
				newScale = Math.min(5, Math.max(0.5, newScale));
				img._scale = newScale;

				const center = getTouchCenter(touches[0], touches[1]);
				const dx = center.x - touchState.panStartX;
				const dy = center.y - touchState.panStartY;
				img._translateX = touchState.imgStartPanX + dx / newScale;
				img._translateY = touchState.imgStartPanY + dy / newScale;
				clampTranslation();
				applyTransform();
				hasDragged = true;
				touchState.hasMoved = true;
			}
		}, { passive: false });

		function touchEnd(e) {
			if (e.touches.length === 0) {
				const wasSingleFinger = touchState.fingerCount === 1;
				const didNotMove = !touchState.hasMoved;
				touchState.touching = false;
				touchState.fingerCount = 0;
				img.style.transition = 'transform 0.2s ease';

				// Snap back if zoomed out past limits
				if (img._scale < 1) {
					img._scale = 1;
					img._translateX = 0;
					img._translateY = 0;
					applyTransform();
				}
				if (img._scale > 5) {
					img._scale = 5;
					clampTranslation();
					applyTransform();
				}

				// Single finger tap at 1x = close
				if (wasSingleFinger && didNotMove && img._scale <= 1) {
					hasDragged = false;
					closeViewer();
					return;
				}
				hasDragged = didNotMove ? false : true;
			} else if (e.touches.length === 1) {
				// Went from 2 fingers to 1: start pan from remaining finger
				touchState.fingerCount = 1;
				const t = e.touches[0];
				touchState.panStartX = t.clientX;
				touchState.panStartY = t.clientY;
				touchState.imgStartPanX = img._translateX || 0;
				touchState.imgStartPanY = img._translateY || 0;
			}
		}

		overlay.addEventListener('touchend', touchEnd, { passive: false });
		overlay.addEventListener('touchcancel', touchEnd, { passive: false });

	} else {
		img = document.getElementById('imageOverlayImg')
	}
	img.src = src;
	img._scale = 1;
	img._translateX = 0;
	img._translateY = 0;
	img.style.transform = 'scale(1) translate(0px, 0px)';
	overlay.style.display = 'flex';
	requestAnimationFrame(() => {
		overlay.style.opacity = '1'
	})
}

// ==================== 认证 fetch 包装器 ====================
async function apiFetch(url, options = {}) {
    const fullUrl = url.startsWith('/v1/') ? API_BASE + url.slice(3) : url;
    const token = localStorage.getItem('oc_access_token');
    if (token) {
        options.headers = options.headers || {};
        options.headers['Authorization'] = 'Bearer ' + token;
    }
    let res = await fetch(fullUrl, options);
    if (res.status === 401) {
        const refreshToken = localStorage.getItem('oc_refresh_token');
        if (refreshToken) {
            const refreshRes = await fetch(API_BASE + '/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken })
            });
            if (refreshRes.ok) {
                const data = await refreshRes.json();
                localStorage.setItem('oc_access_token', data.access_token);
                localStorage.setItem('oc_refresh_token', data.refresh_token || '');
                if (data.user) localStorage.setItem('oc_user', JSON.stringify(data.user));
                options.headers = options.headers || {};
                options.headers['Authorization'] = 'Bearer ' + data.access_token;
                res = await fetch(fullUrl, options);
            } else {
                localStorage.removeItem('oc_access_token');
                localStorage.removeItem('oc_refresh_token');
                localStorage.removeItem('oc_user');
                window.location.href = 'login.html';
                return;
            }
        } else {
            window.location.href = 'login.html';
            return;
        }
    }
    return res;
}

// ==================== 加密辅助模块（ECDH P-256 + AES-CBC） ====================
const Crypto = {
    async sha256(data) {
        const hash = await crypto.subtle.digest('SHA-256', data);
        return new Uint8Array(hash);
    },
    async hmacSha256(keyBytes, data) {
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign('HMAC', key, data);
        return new Uint8Array(sig);
    },
    base64ToBytes(str) {
        const binary = atob(str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    },
    bytesToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },
    concatBytes(a, b) {
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    },
    timingSafeEqual(a, b) {
        if (a.length !== b.length) return false;
        let result = 0;
        for (let i = 0; i < a.length; i++) {
            result |= a[i] ^ b[i];
        }
        return result === 0;
    },
    pkcs7Unpad(data) {
        if (!data.length) return data;
        const pad = data[data.length - 1];
        if (pad <= 0 || pad > 16) return data;
        return data.slice(0, data.length - pad);
    },
};

// 认证检查：没有 token 直接跳转登录页
if (!localStorage.getItem('oc_access_token')) {
    window.location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', () => {
    // 从 localStorage 读取用户信息（登录页写入）
    const storedUser = JSON.parse(localStorage.getItem('oc_user') || '{}');
    const myUid = storedUser.uid || '';
    const myName = storedUser.display_name || storedUser.username || '';
    const myAvatar = storedUser.avatar_url || '';

    // 设置侧边栏用户名
    const sidebarUserNameEl = document.getElementById('sidebarUserName');
    if (sidebarUserNameEl) sidebarUserNameEl.textContent = myName || '未登录';

    let currentConv = null;
    const seenMsgIds = {};
    let switchRequestId = 0;
    let contacts = { friends: [], groups: [] };

    const contactList = document.getElementById('contactList');
    const chatHeader = document.getElementById('chatHeader');
    const messagesContainer = document.getElementById('messagesContainer');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const moreBtn = document.getElementById('moreBtn');
    const moreMenu = document.getElementById('moreMenu');
    const fileInput = document.getElementById('fileInput');
    const logoutBtn = document.getElementById('logoutBtn');
    const pinSidebarBtn = document.getElementById('pinSidebarBtn');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const headerMenuBtn = document.getElementById('headerMenuBtn');

    const quotePreview = document.getElementById('quotePreview');
    const quotePreviewText = quotePreview.querySelector('.quote-preview-text');
    const cancelQuoteBtn = document.getElementById('cancelQuoteBtn');

    const emojiPlazaBtn = document.getElementById('emojiPlazaBtn');

    const mergeMessages = document.querySelector('meta[name="theme-merge-messages"]')?.content === 'true';
    let lastRenderedMsg = null;

    let pendingQuote = null;
    let lastRenderedTs = 0;

    const defaultAvatar = 'assets/default-avatar.png';

    // 未读消息计数
    const unreadCounts = {};

    function updateUnreadBadge(convKey, count) {
        const item = contactList.querySelector(`[data-conv-key="${convKey}"]`);
        if (!item) return;
        const badge = item.querySelector('.unread-badge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }

    function openSpacePanel(uid) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
        const btnBase = 'padding:6px 20px;border-radius:20px;border:none;font-size:14px;font-family:inherit;cursor:pointer;font-weight:500;';
        overlay.innerHTML = `
            <div style="background:var(--header-bg);color:#fff;padding:13px 12px;display:flex;align-items:center;font-size:15px;font-weight:500;flex-shrink:0;position:relative;">
                <button onclick="this.closest('div[style*=fixed]').remove()" style="position:absolute;left:12px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;"><i class="fa-solid fa-chevron-left"></i></button>
                <span style="width:100%;text-align:center;">用户空间</span>
            </div>
            <div id="sp-scroll" style="flex:1;overflow-y:auto;scrollbar-color:rgba(0,0,0,0.2) transparent;"></div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.style.opacity = '1');

        const scroll = overlay.querySelector('#sp-scroll');
        scroll.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载中...</div>';

        function closePanel() { overlay.remove(); }

        async function load() {
            try {
                const [profRes, momentsRes] = await Promise.all([
                    apiFetch('/v1/users/profile?uid=' + encodeURIComponent(uid)),
                    apiFetch('/v1/moments/user?uid=' + encodeURIComponent(uid) + '&limit=50')
                ]);
                const u = await profRes.json();
                const momentsData = await momentsRes.json();
                if (u.error) { scroll.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">' + u.error + '</div>'; return; }
                // 刷新缓存
                u._ts = Date.now();
                userProfileCache.set(uid.toUpperCase(), u);
                // 计算关系：self / friend / pending_received / none
                let relation = 'none';
                if (uid.toUpperCase() === myUid.toUpperCase()) {
                    relation = 'self';
                } else if (contacts.friends.some(f => f.uid.toUpperCase() === uid.toUpperCase())) {
                    relation = 'friend';
                } else {
                    // 检查是否有来自该用户的好友申请
                    try {
                        const reqRes = await apiFetch('/v1/friends/requests');
                        const reqData = await reqRes.json();
                        const incoming = (reqData.requests || []).some(r => r.from_uid.toUpperCase() === uid.toUpperCase());
                        if (incoming) relation = 'pending_received';
                    } catch (e) {}
                }
                const avatar = u.avatar_url || defaultAvatar;

                let btnHtml = '';
                if (relation !== 'self') {
                    if (relation === 'friend') {
                        btnHtml = '<button style="' + btnBase + 'background:var(--chat-bg);color:var(--accent);border:1.5px solid var(--accent);" onclick="spMsg()">私信</button>';
                    } else if (relation === 'pending_sent') {
                        btnHtml = '<button style="' + btnBase + 'background:var(--hover);color:var(--secondary-text);">已发送申请</button>';
                    } else if (relation === 'pending_received') {
                        btnHtml = '<button style="' + btnBase + 'background:var(--accent);color:#fff;" onclick="spRespond(\'accept\')">接受好友</button>' +
                                 '<button style="' + btnBase + 'background:var(--hover);color:var(--secondary-text);" onclick="spRespond(\'reject\')">拒绝</button>';
                    } else {
                        btnHtml = '<button style="' + btnBase + 'background:var(--accent);color:#fff;" onclick="spAddFriend()">加好友</button>';
                    }
                }

                function fmtTs(ts) {
                    if (!ts) return '';
                    const d = new Date(ts * 1000);
                    const pad = n => (n < 10 ? '0' : '') + n;
                    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
                }

                let momentsHtml = '<div style="text-align:center;padding:40px;color:#999;">暂无动态</div>';
                const mom = momentsData.moments || [];
                if (mom.length > 0) {
                    momentsHtml = '<div style="padding:0 16px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;max-width:960px;margin:0 auto;">';
                    mom.forEach(m => {
                        // image_url 可能是单个 URL 或 JSON 字符串数组
                        let mediaUrls = [];
                        if (m.image_url) {
                            try {
                                const parsed = JSON.parse(m.image_url);
                                if (Array.isArray(parsed)) mediaUrls = parsed;
                                else mediaUrls = [m.image_url];
                            } catch (e) {
                                mediaUrls = [m.image_url];
                            }
                        }
                        let media = '';
                        if (mediaUrls.length > 0) {
                            media = '<div style="margin-top:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;">';
                            mediaUrls.forEach(mu => {
                                media += '<img src="' + resolveMediaUrl(mu) + '" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;cursor:pointer;" onerror="this.style.display=\'none\'">';
                            });
                            media += '</div>';
                        }
                        momentsHtml += '<div style="background:var(--chat-bg);border-radius:12px;padding:14px 16px;border:1px solid var(--border);">' +
                            '<div style="font-size:11px;color:var(--secondary-text);margin-bottom:6px;">' + fmtTs(m.created_at) + '</div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.6;white-space:pre-wrap;word-break:break-word;">' + (m.body || '') + '</div>' +
                            media +
                            (m.likes > 0 ? '<div style="font-size:12px;color:var(--secondary-text);margin-top:8px;">❤ ' + m.likes + '</div>' : '') +
                            '</div>';
                    });
                    momentsHtml += '</div>';
                }
                let postMomentHtml = '';
                if (relation === 'self') {
                    postMomentHtml =
                        '<div style="padding:0 16px 12px;max-width:960px;margin:0 auto;">' +
                            '<div style="background:var(--chat-bg);border-radius:12px;padding:14px 16px;border:1px solid var(--border);">' +
                                '<textarea id="spMomentInput" placeholder="分享新鲜事..." style="width:100%;min-height:60px;border:none;background:transparent;color:var(--text);font-size:14px;font-family:inherit;resize:none;outline:none;line-height:1.6;"></textarea>' +
                                '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">' +
                                    '<div style="display:flex;align-items:center;gap:8px;">' +
                                        '<label style="cursor:pointer;color:var(--secondary-text);font-size:13px;" title="添加图片"><i class="fa-solid fa-image"></i> 图片<input type="file" id="spMomentFile" accept="image/*" style="display:none;"></label>' +
                                        '<span id="spMomentFileName" style="font-size:12px;color:var(--secondary-text);cursor:pointer;" title="点击移除图片"></span>' +
                                    '</div>' +
                                    '<button id="spMomentBtn" style="padding:5px 18px;border-radius:16px;border:none;background:var(--accent);color:#fff;font-size:13px;cursor:pointer;font-family:inherit;font-weight:500;">发布</button>' +
                                '</div>' +
                            '</div>' +
                        '</div>';
                }
                scroll.innerHTML =
                    '<div style="background:var(--chat-bg);padding:28px 20px 20px;display:flex;flex-direction:column;align-items:center;border-bottom:1px solid var(--border);">' +
                        '<img src="' + resolveMediaUrl(avatar) + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin-bottom:12px;background:var(--border);" onerror="this.src=\'' + defaultAvatar + '\'">' +
                        '<div style="font-size:20px;font-weight:600;color:var(--text);margin-bottom:4px;">' + (u.display_name || u.username) + '</div>' +
                        '<div style="font-size:12px;color:var(--secondary-text);margin-bottom:4px;">' + u.uid + '</div>' +
                        (u.signature ? '<div style="font-size:13px;color:var(--secondary-text);margin-bottom:12px;text-align:center;max-width:300px;">' + escapeHtml(u.signature) + '</div>' : '') +
                        (btnHtml ? '<div style="display:flex;gap:10px;">' + btnHtml + '</div>' : '') +
                    '</div>' +
                    (relation === 'self' ? '<div style="font-size:14px;font-weight:600;color:var(--text);padding:14px 16px 8px;">发表动态</div>' + postMomentHtml : '') +
                    '<div style="font-size:14px;font-weight:600;color:var(--text);padding:14px 16px 8px;">' + (relation === 'self' ? '我的动态' : 'TA 的动态') + '</div>' +
                    momentsHtml;

                window.spMsg = function() {
                    closePanel();
                    if (currentConv && currentConv.key === 'direct:' + u.uid) return;
                    let found = contacts.friends.find(f => f.uid === u.uid);
                    if (found) {
                        switchConversation('direct', u.uid, found.name);
                    } else {
                        switchConversation('direct', u.uid, u.display_name || u.username);
                    }
                };
                window.spAddFriend = async function() {
                    try {
                        const r = await apiFetch('/v1/friends/request', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({to_uid: uid}) });
                        const d = await r.json();
                        if (d.error) { alert(d.error); return; }
                        load();
                    } catch(e) { alert('请求失败'); }
                };
                window.spRespond = async function(action) {
                    try {
                        // 先查询好友申请列表，找到对应 request_id
                        const reqRes = await apiFetch('/v1/friends/requests');
                        const reqData = await reqRes.json();
                        const req = (reqData.requests || []).find(r => r.from_uid.toUpperCase() === uid.toUpperCase());
                        if (!req) { alert('未找到好友申请'); return; }
                        const r = await apiFetch('/v1/friends/respond', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({request_id: req.id, accept: action === 'accept'}) });
                        const d = await r.json();
                        if (d.error) { alert(d.error); return; }
                        load();
                    } catch(e) { alert('请求失败'); }
                };

                if (relation === 'self') {
                    const momentFile = document.getElementById('spMomentFile');
                    const momentFileName = document.getElementById('spMomentFileName');
                    const momentBtn = document.getElementById('spMomentBtn');
                    if (momentFile) {
                        momentFile.addEventListener('change', () => {
                            const f = momentFile.files[0];
                            momentFileName.textContent = f ? '已选择: ' + f.name + ' ✕' : '';
                        });
                    }
                    if (momentFileName) {
                        momentFileName.addEventListener('click', () => {
                            if (momentFile) momentFile.value = '';
                            momentFileName.textContent = '';
                        });
                    }
                    if (momentBtn) {
                        momentBtn.addEventListener('click', async () => {
                            const input = document.getElementById('spMomentInput');
                            const text = (input?.value || '').trim();
                            const file = momentFile?.files[0];
                            if (!text && !file) { alert('请输入内容或选择图片'); return; }
                            momentBtn.disabled = true;
                            momentBtn.textContent = '发布中...';
                            try {
                                let imageUrl = '';
                                if (file) {
                                    const upFd = new FormData();
                                    upFd.append('file', file);
                                    const upRes = await apiFetch('/v1/media', { method: 'POST', body: upFd });
                                    const upData = await upRes.json();
                                    if (upData.error) { alert(upData.error); momentBtn.disabled = false; momentBtn.textContent = '发布'; return; }
                                    imageUrl = upData.url || '';
                                }
                                const r = await apiFetch('/v1/moments', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({body: text, image_url: imageUrl}) });
                                const d = await r.json();
                                if (d.error) { alert(d.error); momentBtn.disabled = false; momentBtn.textContent = '发布'; return; }
                                load();
                            } catch(e) { alert('发布失败'); momentBtn.disabled = false; momentBtn.textContent = '发布'; }
                        });
                    }
                }
            } catch(e) {
                scroll.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载失败</div>';
            }
        }
        load();
    }

    async function markAllRead(convType, convId) {
        try {
            if (convType === 'direct') {
                await apiFetch('/v1/direct/read', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({with_uid: convId}) });
            } else {
                await apiFetch('/v1/groups/read', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({group_id: convId}) });
            }
            const convKey = convType + ':' + convId;
            delete unreadCounts[convKey];
            updateUnreadBadge(convKey, 0);
        } catch (e) { console.error(e); }
    }

    function openGroupManagePanel(groupId, groupName) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
        overlay.innerHTML = `
            <div class="gm-header">
                <button class="gm-back" onclick="this.closest('div[style*=fixed]').remove()"><i class="fa-solid fa-chevron-left"></i></button>
                <span>群聊管理</span>
            </div>
            <div id="gm-scroll" style="flex:1;overflow-y:auto;scrollbar-color:rgba(0,0,0,0.2) transparent;"></div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.style.opacity = '1');
        const scroll = overlay.querySelector('#gm-scroll');
        scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载中...</div>';

        async function load() {
            try {
                const [groupsRes, membersRes] = await Promise.all([
                    apiFetch('/v1/groups/list'),
                    apiFetch('/v1/groups/members?group_id=' + encodeURIComponent(groupId))
                ]);
                const groupsData = await groupsRes.json();
                const membersData = await membersRes.json();
                if (groupsData.error) { scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">' + groupsData.error + '</div>'; return; }
                const info = (groupsData.groups || []).find(g => g.group_id === groupId) || {};
                if (membersData.error) { scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">' + membersData.error + '</div>'; return; }
                const members = (membersData.members || []).map(m => ({
                    uid: m.uid,
                    name: m.display_name || m.username || m.uid,
                    avatar: m.avatar_url || ''
                }));
                const avatar = info.avatar_url || defaultAvatar;
                const isOwner = info.role === 2;

                let membersHtml = '';
                members.forEach(m => {
                    const isMe = m.uid.toUpperCase() === myUid.toUpperCase();
                    membersHtml += `<div class="gm-member-item">` +
                        `<img class="gm-member-avatar" src="${resolveMediaUrl(m.avatar || defaultAvatar)}" onerror="this.src='${defaultAvatar}'">` +
                        `<div class="gm-member-info"><div class="gm-member-name">${escapeHtml(m.name)}</div><div class="gm-member-uid">${escapeHtml(m.uid)}</div></div>` +
                        (isMe ? '<span class="gm-member-tag">我</span>' : '') +
                        `</div>`;
                });

                let btnsHtml = '';
                if (!isOwner) {
                    btnsHtml = `<div class="gm-actions"><button class="gm-leave-btn" onclick="gmLeaveGroup()">退出群聊</button></div>`;
                }

                scroll.innerHTML =
                    '<div class="gm-profile">' +
                        `<img class="gm-avatar" src="${resolveMediaUrl(avatar)}" onerror="this.src='${defaultAvatar}'">` +
                        `<div class="gm-name">${escapeHtml(info.name || groupName)}</div>` +
                        `<div class="gm-meta">群聊ID: ${escapeHtml(info.group_id || groupId)}</div>` +
                        `<div class="gm-meta">成员数: ${info.member_count || members.length} 人</div>` +
                    '</div>' +
                    '<div class="gm-section">' +
                        '<div class="gm-section-header"><span>成员列表 (' + members.length + ')</span><button class="gm-invite-btn" onclick="gmShowInvite()">+ 邀请</button></div>' +
                        '<div class="gm-members-list">' + membersHtml + '</div>' +
                    '</div>' +
                    btnsHtml;

                window.gmShowInvite = function() {
                    openInvitePanel(groupId, members);
                };
                window.gmLeaveGroup = async function() {
                    if (!confirm('确定要退出该群聊吗？')) return;
                    try {
                        const r = await apiFetch('/v1/groups/leave', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ group_id: groupId })
                        });
                        const d = await r.json();
                        if (d.error) { alert(d.error); return; }
                        overlay.remove();
                        contacts.groups = contacts.groups.filter(g => g.id !== groupId);
                        renderContacts();
                        if (currentConv && currentConv.type === 'group' && currentConv.id === groupId) {
                            if (contacts.groups.length > 0) {
                                const g = contacts.groups[0];
                                switchConversation('group', g.id, g.name);
                            } else if (contacts.friends.length > 0) {
                                const f = contacts.friends[0];
                                switchConversation('direct', f.uid, f.name);
                            } else {
                                chatArea.innerHTML = '<div style="text-align:center;padding:80px 20px;color:var(--secondary-text);">暂无会话</div>';
                                currentConv = null;
                            }
                        }
                    } catch (e) { alert('请求失败'); }
                };
            } catch (e) {
                scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载失败</div>';
            }
        }

        function fmtTs(ts) {
            if (!ts) return '';
            const d = new Date(ts * 1000);
            const pad = n => (n < 10 ? '0' : '') + n;
            return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        function openInvitePanel(groupId, existingMembers) {
            const inviteOverlay = document.createElement('div');
            inviteOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
            const existingUids = new Set(existingMembers.map(m => m.uid.toUpperCase()));
            const friends = (contacts.friends || []).filter(f => !existingUids.has(f.uid.toUpperCase()));
            let friendsHtml = '';
            if (friends.length > 0) {
                friends.forEach(f => {
                    friendsHtml += `<div class="gm-friend-item" data-uid="${escapeHtml(f.uid)}">` +
                        `<img class="gm-friend-avatar" src="${resolveMediaUrl(f.avatar || defaultAvatar)}" onerror="this.src='${defaultAvatar}'">` +
                        `<div class="gm-friend-info"><div class="gm-friend-name">${escapeHtml(f.name)}</div><div class="gm-friend-uid">${escapeHtml(f.uid)}</div></div>` +
                        `<button class="gm-friend-invite-btn">邀请</button>` +
                        `</div>`;
                });
            } else {
                friendsHtml = '<div style="text-align:center;padding:20px;color:var(--secondary-text);font-size:13px;">没有可邀请的好友（或已全部在群中）</div>';
            }

            inviteOverlay.innerHTML = `
                <div class="gm-header">
                    <button class="gm-back" onclick="this.closest('div[style*=fixed]').remove()"><i class="fa-solid fa-chevron-left"></i></button>
                    <span>邀请成员</span>
                </div>
                <div style="flex:1;overflow-y:auto;padding:12px 0;">
                    <div class="gm-section">
                        <div class="gm-section-header"><span>好友列表</span></div>
                        <div class="gm-friends-list">${friendsHtml}</div>
                    </div>
                    <div class="gm-section" style="margin-top:8px;">
                        <div class="gm-section-header"><span>通过 UID 邀请</span></div>
                        <div class="gm-uid-row">
                            <input class="gm-uid-input" id="gmUidInput" placeholder="输入用户 UID" />
                            <button class="gm-uid-invite-btn" id="gmUidInviteBtn">邀请</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(inviteOverlay);
            requestAnimationFrame(() => inviteOverlay.style.opacity = '1');

            async function doInvite(uid) {
                try {
                    const r = await apiFetch('/v1/groups/invite', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ group_id: groupId, user_uid: uid })
                    });
                    const d = await r.json();
                    if (d.error) { alert(d.error); return false; }
                    return true;
                } catch (e) { alert('请求失败'); return false; }
            }

            inviteOverlay.querySelectorAll('.gm-friend-invite-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const item = btn.closest('.gm-friend-item');
                    const uid = item.dataset.uid;
                    btn.disabled = true;
                    btn.textContent = '邀请中...';
                    const ok = await doInvite(uid);
                    if (ok) {
                        btn.textContent = '已邀请';
                        btn.style.background = 'var(--hover)';
                        btn.style.color = 'var(--secondary-text)';
                    } else {
                        btn.disabled = false;
                        btn.textContent = '邀请';
                    }
                });
            });

            inviteOverlay.querySelector('#gmUidInviteBtn').addEventListener('click', async () => {
                const input = inviteOverlay.querySelector('#gmUidInput');
                const uid = input.value.trim().toUpperCase();
                if (!uid) { alert('请输入 UID'); return; }
                const btn = inviteOverlay.querySelector('#gmUidInviteBtn');
                btn.disabled = true;
                btn.textContent = '邀请中...';
                const ok = await doInvite(uid);
                if (ok) {
                    alert('邀请成功');
                    input.value = '';
                }
                btn.disabled = false;
                btn.textContent = '邀请';
            });
        }

        load();
    }

    function openMyProfile() {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
        overlay.innerHTML = `
            <div class="mp-header">
                <button class="mp-back" onclick="this.closest('div[style*=fixed]').remove()"><i class="fa-solid fa-chevron-left"></i></button>
                <span>个人主页</span>
            </div>
            <div id="mp-scroll" style="flex:1;overflow-y:auto;scrollbar-color:rgba(0,0,0,0.2) transparent;"></div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.style.opacity = '1');
        const scroll = overlay.querySelector('#mp-scroll');
        scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载中...</div>';

        let currentProfile = null;

        function fmtTs(ts) {
            if (!ts) return '';
            const d = new Date(ts * 1000);
            const pad = n => (n < 10 ? '0' : '') + n;
            return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        async function load() {
            try {
                const [profRes, friendsRes] = await Promise.all([
                    apiFetch('/v1/users/profile?uid=' + encodeURIComponent(myUid)),
                    apiFetch('/v1/friends')
                ]);
                const prof = await profRes.json();
                const friendsData = await friendsRes.json();
                if (prof.error) { scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">' + prof.error + '</div>'; return; }
                currentProfile = prof;
                // 刷新缓存
                prof._ts = Date.now();
                userProfileCache.set(myUid.toUpperCase(), prof);
                const avatar = currentProfile.avatar_url || defaultAvatar;
                const friends = friendsData.friends || [];

                let friendsHtml = '';
                if (friends.length > 0) {
                    friends.forEach(f => {
                        const fAvatar = f.avatar_url || defaultAvatar;
                        const displayName = f.remark_name || f.display_name || f.username || f.uid;
                        friendsHtml += `<div class="mp-req-item" data-uid="${escapeHtml(f.uid)}">` +
                            `<img class="mp-req-avatar" src="${resolveMediaUrl(fAvatar)}" onerror="this.src='${defaultAvatar}'">` +
                            `<div class="mp-req-info"><div class="mp-req-name">${escapeHtml(displayName)}</div>` +
                            `<div class="mp-req-time">${escapeHtml(f.uid)}</div></div>` +
                            `<button class="mp-req-chat-btn" data-uid="${escapeHtml(f.uid)}">私聊</button>` +
                            `</div>`;
                    });

                } else {
                    friendsHtml = '<div class="mp-empty">暂无联系人</div>';
                }

                scroll.innerHTML =
                    '<div class="mp-profile">' +
                        `<div class="mp-avatar-wrap" id="mpAvatarWrap">` +
                            `<img class="mp-avatar" id="mpAvatar" src="${resolveMediaUrl(avatar)}" onerror="this.src='${defaultAvatar}'">` +
                            `<div class="mp-avatar-mask">更换头像</div>` +
                        `</div>` +
                        `<input type="file" id="mpAvatarInput" accept="image/*" style="display:none">` +
                        `<div class="mp-field" id="mpNameField"><div class="mp-field-name" id="mpNameText">${escapeHtml(currentProfile.display_name || currentProfile.username)}</div></div>` +
                        `<div class="mp-field" id="mpUidField"><div class="mp-field-uid" id="mpUidText">${escapeHtml(currentProfile.uid)}</div></div>` +
                        `<div class="mp-field" id="mpBioField"><div class="mp-field-bio" id="mpBioText">${currentProfile.signature ? escapeHtml(currentProfile.signature) : '点击添加签名'}</div></div>` +
                        `<button class="mp-space-btn" id="mpSpaceBtn">查看我的空间</button>` +
                    '</div>' +
                    '<div class="mp-section">' +
                        '<div class="mp-section-header">添加好友</div>' +
                        '<div class="mp-uid-row"><input class="mp-uid-input" id="mpAddFriendInput" placeholder="输入对方 UID、用户名或昵称">' +
                        '<button class="gm-uid-invite-btn" id="mpAddFriendBtn">添加</button></div>' +
                    '</div>' +
                    '<div class="mp-section">' +
                        '<div class="mp-section-header">加入群聊</div>' +
                        '<div class="mp-uid-row"><input class="mp-uid-input" id="mpJoinGroupInput" placeholder="输入群聊 ID">' +
                        '<button class="gm-uid-invite-btn" id="mpJoinGroupBtn">加入</button></div>' +
                    '</div>' +
                    '<div class="mp-section">' +
                        '<div class="mp-section-header">联系人 (' + friends.length + ')</div>' +
                        '<div class="mp-req-list">' + friendsHtml + '</div>' +
                    '</div>';

                document.getElementById('mpSpaceBtn').addEventListener('click', () => {
                    overlay.remove();
                    openSpacePanel(myUid);
                });

                document.getElementById('mpAvatarWrap').addEventListener('click', () => {
                    document.getElementById('mpAvatarInput').click();
                });

                document.getElementById('mpAvatarInput').addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const formData = new FormData();
                    formData.append('file', file);
                    try {
                        const r = await apiFetch('/v1/me/avatar', { method: 'POST', body: formData });
                        const d = await r.json();
                        if (d.error) { alert(d.error); return; }
                        document.getElementById('mpAvatar').src = resolveMediaUrl(d.avatar_url);
                        currentProfile.avatar_url = d.avatar_url;
                    } catch (err) { alert('上传失败'); }
                });

                document.getElementById('mpAddFriendBtn').addEventListener('click', async () => {
                    const input = document.getElementById('mpAddFriendInput');
                    const val = input.value.trim();
                    if (!val) { alert('请输入 UID 或昵称'); return; }
                    const btn = document.getElementById('mpAddFriendBtn');
                    btn.disabled = true;
                    btn.textContent = '发送中...';
                    try {
                        const r = await apiFetch('/v1/friends/request', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ to_uid: val.toUpperCase() })
                        });
                        const d = await r.json();
                        if (d.error) { alert(d.error); } else { alert('已发送申请'); input.value = ''; }
                    } catch(e) { alert('请求失败'); }
                    btn.disabled = false;
                    btn.textContent = '添加';
                });

                document.getElementById('mpJoinGroupBtn').addEventListener('click', async () => {
                    const input = document.getElementById('mpJoinGroupInput');
                    const val = input.value.trim().toUpperCase();
                    if (!val) { alert('请输入群聊 ID'); return; }
                    const btn = document.getElementById('mpJoinGroupBtn');
                    btn.disabled = true;
                    btn.textContent = '加入中...';
                    try {
                        const r = await apiFetch('/v1/groups/join', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ group_id: val })
                        });
                        const d = await r.json();
                        if (d.error || d.code) { alert(d.error || '加入失败'); } else { alert('已加入群聊'); input.value = ''; loadContacts(); }
                    } catch(e) { alert('请求失败'); }
                    btn.disabled = false;
                    btn.textContent = '加入';
                });

                document.getElementById('mpNameField').addEventListener('click', () => {
                    const field = document.getElementById('mpNameField');
                    const val = currentProfile.display_name || currentProfile.username;
                    field.innerHTML = `<input class="mp-edit-input" id="mpNameInput" value="${escapeHtml(val)}">`;
                    const input = document.getElementById('mpNameInput');
                    input.focus();
                    input.select();
                    const save = async () => {
                        const newVal = input.value.trim();
                        if (!newVal || newVal === val) {
                            field.innerHTML = `<div class="mp-field-name" id="mpNameText">${escapeHtml(val)}</div>`;
                            return;
                        }
                        try {
                            const r = await apiFetch('/v1/me/profile', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ display_name: newVal })
                            });
                            const d = await r.json();
                            if (d.error) { alert(d.error); return; }
                            currentProfile.display_name = newVal;
                            field.innerHTML = `<div class="mp-field-name" id="mpNameText">${escapeHtml(newVal)}</div>`;
                            document.getElementById('sidebarUserName').textContent = newVal;
                        } catch (err) { alert('保存失败'); }
                    };
                    input.addEventListener('blur', save);
                    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
                });

                document.getElementById('mpUidField').addEventListener('click', () => {
                    const field = document.getElementById('mpUidField');
                    const val = currentProfile.uid;
                    field.innerHTML = `<input class="mp-edit-input" id="mpUidInput" value="${escapeHtml(val)}" style="font-size:13px;font-weight:400;text-transform:uppercase;">`;
                    const input = document.getElementById('mpUidInput');
                    input.focus();
                    input.select();
                    const save = async () => {
                        const newVal = input.value.trim().toUpperCase();
                        if (!newVal || newVal === val) {
                            field.innerHTML = `<div class="mp-field-uid" id="mpUidText">${escapeHtml(val)}</div>`;
                            return;
                        }
                        try {
                            const r = await apiFetch('/v1/me/uid', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ uid: newVal })
                            });
                            const d = await r.json();
                            if (d.error) { alert(d.error); return; }
                            currentProfile.uid = newVal;
                            field.innerHTML = `<div class="mp-field-uid" id="mpUidText">${escapeHtml(newVal)}</div>`;
                        } catch (err) { alert('保存失败'); }
                    };
                    input.addEventListener('blur', save);
                    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
                });

                document.getElementById('mpBioField').addEventListener('click', () => {
                    const field = document.getElementById('mpBioField');
                    const val = currentProfile.signature || '';
                    field.innerHTML = `<input class="mp-edit-input mp-edit-bio" id="mpBioInput" value="${escapeHtml(val)}" placeholder="添加签名">`;
                    const input = document.getElementById('mpBioInput');
                    input.focus();
                    const save = async () => {
                        const newVal = input.value.trim();
                        if (newVal === val) {
                            field.innerHTML = `<div class="mp-field-bio" id="mpBioText">${val ? escapeHtml(val) : '点击添加签名'}</div>`;
                            return;
                        }
                        try {
                            const r = await apiFetch('/v1/me/profile', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ signature: newVal })
                            });
                            const d = await r.json();
                            if (d.error) { alert(d.error); return; }
                            currentProfile.signature = newVal;
                            field.innerHTML = `<div class="mp-field-bio" id="mpBioText">${newVal ? escapeHtml(newVal) : '点击添加签名'}</div>`;
                        } catch (err) { alert('保存失败'); }
                    };
                    input.addEventListener('blur', save);
                    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
                });

                scroll.querySelectorAll('.mp-req-chat-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const uid = btn.dataset.uid;
                        if (!uid) return;
                        overlay.remove();
                        const f = contacts.friends.find(x => x.uid.toUpperCase() === uid.toUpperCase());
                        switchConversation('direct', uid, f ? f.name : uid);
                    });
                });
            } catch (e) {
                scroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载失败</div>';
            }
        }
        load();
    }
    window.openMyProfile = openMyProfile;

    let contextMenu = null;
    let contextMsgId = null;

    // 滚动加载历史消息状态
    const convOffset = {};        // convKey → 当前已加载的消息偏移量
    const convHasMore = {};       // convKey → boolean
    let isLoadingMore = false;
    let isLoadingMoreReqId = 0;

    function hideContextMenu() {
        if (contextMenu) {
            const el = contextMenu;
            el.classList.remove('show');
            el.addEventListener('transitionend', () => el.remove(), { once: true });
            setTimeout(() => el.remove(), 200);
            contextMenu = null;
            contextMsgId = null;
        }
    }

    emojiPlazaBtn.addEventListener('click', () => {
        showEmojiPlaza();
    });
    

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('oc_access_token');
        localStorage.removeItem('oc_refresh_token');
        localStorage.removeItem('oc_user');
        window.location.href = 'login.html';
    });

    // 主题切换
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        // 更新图标
        const icon = themeToggleBtn.querySelector('i');
        if (theme === 'dark') {
            icon.className = 'fa-solid fa-moon';
        } else {
            icon.className = 'fa-solid fa-circle-half-stroke';
        }
    }

    // 初始化主题
    const savedTheme = localStorage.getItem('theme') || 'light';
    applyTheme(savedTheme);

    themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    async function loadContacts() {
        try {
            const [frRes, grRes] = await Promise.all([
                apiFetch('/v1/friends'),
                apiFetch('/v1/groups/list')
            ]);
            const frData = await frRes.json();
            const grData = await grRes.json();
            if (frData.error) { alert(frData.error); return; }
            contacts = {
                friends: (frData.friends || []).map(f => ({
                    uid: f.uid,
                    name: f.display_name || f.username || f.uid,
                    username: f.username,
                    display_name: f.display_name,
                    avatar: f.avatar_url || '',
                    remark_name: f.remark_name || ''
                })),
                groups: (grData.groups || []).map(g => ({
                    id: g.group_id,
                    name: g.name,
                    avatar: g.avatar_url || '',
                    member_count: g.member_count,
                    role: g.role
                }))
            };
            renderContacts();
            // 加载未读计数
            loadUnreadCounts();
        } catch (e) { console.error(e); }
    }

    async function loadUnreadCounts() {
        try {
            const [dRes, gRes] = await Promise.all([
                apiFetch('/v1/direct/unread', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ limit: 200 })
                }),
                apiFetch('/v1/groups/unread', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ limit: 200 })
                })
            ]);
            const dData = await dRes.json();
            const gData = await gRes.json();
            if (dData.error || gData.error) return;
            // 统计私聊未读（按 from_uid 分组）
            const directCount = {};
            (dData.messages || []).forEach(m => {
                const uid = m.from_uid;
                directCount[uid] = (directCount[uid] || 0) + 1;
            });
            for (const [uid, count] of Object.entries(directCount)) {
                const convKey = `direct:${uid}`;
                unreadCounts[convKey] = count;
                updateUnreadBadge(convKey, count);
            }
            // 统计群聊未读（按 group_id 分组）
            const groupCount = {};
            (gData.messages || []).forEach(m => {
                const gid = m.group_id;
                groupCount[gid] = (groupCount[gid] || 0) + 1;
            });
            for (const [groupId, count] of Object.entries(groupCount)) {
                const convKey = `group:${groupId}`;
                unreadCounts[convKey] = count;
                updateUnreadBadge(convKey, count);
            }
        } catch (e) { console.error(e); }
    }

    // WebSocket 连接
    let ws = null;
    let wsReconnectTimer = null;
    // ECDH 会话密钥
    let wsSessionId = null;
    let wsEncKey = null;
    let wsMacKey = null;

    // ECDH P-256 握手，派生 encKey/macKey
    async function ensureWsSession() {
        if (wsSessionId && wsEncKey && wsMacKey) return;
        if (!window.crypto || !crypto.subtle) throw new Error('Crypto not supported');
        const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
        const clientPub = Crypto.bytesToBase64(new Uint8Array(spki));
        const res = await apiFetch('/v1/auth/handshake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_pub: clientPub })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const serverPubBytes = Crypto.base64ToBytes(data.server_pub);
        const serverPub = await crypto.subtle.importKey('spki', serverPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, keys.privateKey, 256);
        const secretBytes = new Uint8Array(secret);
        wsEncKey = await Crypto.sha256(Crypto.concatBytes(secretBytes, new TextEncoder().encode('enc')));
        wsMacKey = await Crypto.sha256(Crypto.concatBytes(secretBytes, new TextEncoder().encode('mac')));
        wsSessionId = data.session_id;
    }

    // 解密 WS 加密信封 {iv, data, mac}
    async function decryptEnvelope(payload) {
        if (!wsEncKey || !wsMacKey) return null;
        let env;
        try { env = JSON.parse(payload); } catch { return null; }
        if (!env.iv || !env.data || !env.mac) return null;
        const iv = Crypto.base64ToBytes(env.iv);
        const ciphertext = Crypto.base64ToBytes(env.data);
        const mac = Crypto.base64ToBytes(env.mac);
        const expected = await Crypto.hmacSha256(wsMacKey, Crypto.concatBytes(iv, ciphertext));
        if (!Crypto.timingSafeEqual(mac, expected)) return null;
        const key = await crypto.subtle.importKey('raw', wsEncKey, { name: 'AES-CBC' }, false, ['decrypt']);
        const plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
        const plainBytes = Crypto.pkcs7Unpad(new Uint8Array(plainBuf));
        return new TextDecoder().decode(plainBytes);
    }

    async function initWebSocket() {
        try {
            await ensureWsSession();
            const token = localStorage.getItem('oc_access_token');
            if (!token || !wsSessionId) return;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${WS_HOST}/v1/ws?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(wsSessionId)}`;
            ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                console.log('[WS] connected');
            };
            ws.onmessage = async (event) => {
                try {
                    // 所有 WS 推送都是加密信封，先解密
                    const plain = await decryptEnvelope(event.data);
                    if (!plain) return;
                    const msg = JSON.parse(plain);
                    handleWsMessage(msg);
                } catch (e) {
                    console.error('[WS] parse error:', e);
                }
            };
            ws.onclose = () => {
                console.log('[WS] closed');
                ws = null;
                // 会话可能已失效，清除后重新握手
                wsSessionId = null;
                wsEncKey = null;
                wsMacKey = null;
                if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
                wsReconnectTimer = setTimeout(initWebSocket, 3000);
            };
            ws.onerror = (e) => {
                console.error('[WS] error:', e);
            };
        } catch (e) {
            console.error('[WS] init failed:', e);
            if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
            wsReconnectTimer = setTimeout(initWebSocket, 5000);
        }
    }

    // 用户信息缓存（4小时过期）
    const userProfileCache = new Map();
    const CACHE_TTL = 4 * 60 * 60 * 1000;

    async function fetchUserProfile(uid, forceRefresh) {
        if (!uid || uid.toUpperCase() === myUid.toUpperCase()) return null;
        const key = uid.toUpperCase();
        if (!forceRefresh && userProfileCache.has(key)) {
            const cached = userProfileCache.get(key);
            if (Date.now() - cached._ts < CACHE_TTL) return cached;
        }
        try {
            const res = await apiFetch('/v1/users/profile?uid=' + encodeURIComponent(uid));
            const data = await res.json();
            if (!data.error) {
                data._ts = Date.now();
                userProfileCache.set(key, data);
                return data;
            }
        } catch (e) {}
        return null;
    }

    // 根据 uid 查找联系人显示名
    function lookupName(uid) {
        if (!uid) return '';
        if (uid.toUpperCase() === myUid.toUpperCase()) return myName;
        const f = contacts.friends.find(x => x.uid.toUpperCase() === uid.toUpperCase());
        if (f) return f.name;
        const m = groupMembers.find(x => x.uid.toUpperCase() === uid.toUpperCase());
        if (m) return m.name;
        const cached = userProfileCache.get(uid.toUpperCase());
        if (cached) return cached.display_name || cached.username || uid;
        return uid;
    }

    function lookupAvatar(uid) {
        if (!uid) return '';
        if (uid.toUpperCase() === myUid.toUpperCase()) return myAvatar;
        const f = contacts.friends.find(x => x.uid.toUpperCase() === uid.toUpperCase());
        if (f && f.avatar) return f.avatar;
        const g = contacts.groups.find(x => x.id === uid);
        if (g && g.avatar) return g.avatar;
        const m = groupMembers.find(x => x.uid.toUpperCase() === uid.toUpperCase());
        if (m && m.avatar) return m.avatar;
        const cached = userProfileCache.get(uid.toUpperCase());
        if (cached && cached.avatar_url) return cached.avatar_url;
        return '';
    }

    function handleWsMessage(msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'direct_message') {
            const d = msg.data || {};
            const fromUid = d.from_uid || '';
            if (fromUid.toUpperCase() === myUid.toUpperCase()) return;
            const convKey = `direct:${fromUid}`;
            // 只在当前会话匹配时才显示消息
            if (!currentConv || currentConv.key !== convKey) {
                // 非当前会话，增加未读计数
                unreadCounts[convKey] = (unreadCounts[convKey] || 0) + 1;
                updateUnreadBadge(convKey, unreadCounts[convKey]);
                return;
            }
            const msgObj = {
                id: d.id,
                from_uid: fromUid,
                from_name: lookupName(fromUid),
                from_avatar: '',
                body: d.body || '',
                msg_type: d.msg_type || 'text',
                media_url: d.media_url || null,
                thumb_url: d.thumb_url || null,
                created_at: d.created_at,
            };
            appendMessage(msgObj, convKey, seenMsgIds[convKey]);
            scrollToBottom(true);
            apiFetch('/v1/direct/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ with_uid: fromUid }) });
        } else if (msg.type === 'group_message') {
            const d = msg.data || {};
            const groupId = d.group_id || '';
            const fromUid = d.from_uid || '';
            if (fromUid.toUpperCase() === myUid.toUpperCase()) return;
            const convKey = `group:${groupId}`;
            // 只在当前会话匹配时才显示消息
            if (!currentConv || currentConv.key !== convKey) {
                // 非当前会话，增加未读计数
                unreadCounts[convKey] = (unreadCounts[convKey] || 0) + 1;
                updateUnreadBadge(convKey, unreadCounts[convKey]);
                return;
            }
            const msgObj = {
                id: d.id,
                from_uid: fromUid,
                from_name: lookupName(fromUid),
                from_avatar: '',
                body: d.body || '',
                msg_type: d.msg_type || 'text',
                media_url: d.media_url || null,
                thumb_url: d.thumb_url || null,
                created_at: d.created_at,
                group_id: groupId,
            };
            appendMessage(msgObj, convKey, seenMsgIds[convKey]);
            scrollToBottom(true);
            apiFetch('/v1/groups/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ group_id: groupId }) });
        } else if (msg.type === 'direct_recall') {
            const d = msg.data || {};
            const messageId = d.message_id || '';
            const fromUid = d.from_uid || '';
            const convKey = `direct:${fromUid}`;
            if (currentConv && currentConv.key === convKey) {
                const target = document.querySelector(`.message[data-msg-id="${CSS.escape(messageId)}"]`);
                if (target) {
                    const sep = document.createElement('div');
                    sep.className = 'time-separator';
                    sep.textContent = '[消息已撤回]';
                    target.replaceWith(sep);
                }
            }
            // 清理已撤回消息的去重记录
            if (seenMsgIds[convKey]) {
                seenMsgIds[convKey].delete(messageId);
            }
        } else if (msg.type === 'group_recall') {
            const d = msg.data || {};
            const messageId = d.message_id || '';
            const groupId = d.group_id || '';
            const convKey = `group:${groupId}`;
            if (currentConv && currentConv.key === convKey) {
                const target = document.querySelector(`.message[data-msg-id="${CSS.escape(messageId)}"]`);
                if (target) {
                    const sep = document.createElement('div');
                    sep.className = 'time-separator';
                    sep.textContent = '[消息已撤回]';
                    target.replaceWith(sep);
                }
            }
            if (seenMsgIds[convKey]) {
                seenMsgIds[convKey].delete(messageId);
            }
        } else if (msg.type === 'direct_read') {
            // 对方已读，可选更新已读回执（此处仅记录日志）
            // d: {thread_id, reader_uid, read_at}
        }
    }

    function renderContacts() {
        contactList.innerHTML = '';
        if (contacts.groups.length > 0) {
            const sep = document.createElement('div');
            sep.style.cssText = 'padding:8px 15px;font-size:11px;color:#999;font-weight:500;';
            sep.textContent = '群聊';
            contactList.appendChild(sep);
            contacts.groups.forEach(g => {
                const div = createContactItem(g.id, g.name, 'group', g.avatar);
                contactList.appendChild(div);
            });
        }
        if (contacts.friends.length > 0) {
            const sep = document.createElement('div');
            sep.style.cssText = 'padding:8px 15px;font-size:11px;color:#999;font-weight:500;';
            sep.textContent = '私聊';
            contactList.appendChild(sep);
            contacts.friends.forEach(f => {
                const div = createContactItem(f.uid, f.name, 'direct', f.avatar);
                contactList.appendChild(div);
            });
        }
    }

    function createContactItem(id, name, type, avatar) {
        const div = document.createElement('div');
        div.className = 'contact-item';
        div.dataset.convKey = type + ':' + id;
        div.dataset.type = type;
        div.dataset.id = id;
        div.dataset.name = name;
        const avatarUrl = avatar ? resolveMediaUrl(avatar) : 'assets/default-avatar.png';
        div.innerHTML = `<img class="contact-avatar" src="${avatarUrl}" onerror="this.src='assets/default-avatar.png'"><div class="contact-info"><div class="name">${escapeHtml(name)}</div><div class="uid">${escapeHtml(id)}</div></div><span class="unread-badge" style="display:none;"></span>`;
        div.addEventListener('click', (e) => switchConversation(type, id, name, e));
        return div;
    }

    async function switchConversation(type, id, name, event) {
        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        } else {
            const convKey = type + ':' + id;
            const target = contactList.querySelector(`[data-conv-key="${convKey}"]`);
            if (target) target.classList.add('active');
        }

        // 清除未读计数
        const convKey = `${type}:${id}`;
        if (unreadCounts[convKey]) {
            delete unreadCounts[convKey];
            updateUnreadBadge(convKey, 0);
        }

        if (isMobile()) {
            sidebar.classList.add('collapsed');
            expandChat();
        }
    
        currentConv = { type, id, name, key: convKey };

        // 加载群成员（用于 @mention）
        if (type === 'group') {
            loadGroupMembers();
        } else {
            mentionMembers = [];
        }

        // 保存到 localStorage，下次自动恢复
        try {
            localStorage.setItem('lastConversation', convKey);
        } catch (e) {}
    
        chatHeader.querySelector('.chat-title').textContent = name;
        headerMenuBtn.style.display = type === 'group' ? 'inline-flex' : 'none';
        messagesContainer.innerHTML = '';
        lastRenderedMsg = null;
        lastRenderedTs = 0;

        // 重置滚动加载状态
        convOffset[convKey] = 0;
        convHasMore[convKey] = true;

        // 清除该会话的已见消息记录，确保历史消息重新显示
        if (seenMsgIds[convKey]) {
            delete seenMsgIds[convKey];
        }

        // 移除旧的滚动监听
        messagesContainer._scrollHandler && messagesContainer.removeEventListener('scroll', messagesContainer._scrollHandler);

        pendingQuote = null;
        quotePreview.style.display = 'none';

        const PAGE_SIZE = 100;
        const reqId = ++switchRequestId;

        try {
            // Go 后端: direct 用 with_uid, group 用 group_id；返回 DESC（新→旧），需反转为 ASC（旧→新）
            // V2 接口用 offset 分页
            const historyUrl = type === 'group'
                ? `/v1/groups/messages/v2?group_id=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=0`
                : `/v1/direct/messages/v2?with_uid=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=0`;
            const res = await apiFetch(historyUrl);
            const data = await res.json();

            if (reqId !== switchRequestId) return;

            if (data.error) {
                console.error(data.error);
                messagesContainer.innerHTML = '<div class="system-msg">加载消息失败，请刷新重试</div>';
                return;
            }

            // Go 返回 DESC 顺序（新→旧），反转为 ASC（旧→新）以便渲染
            const msgs = (data.messages || []).slice().reverse();

            // 记录已加载数量
            convOffset[convKey] = msgs.length;
            convHasMore[convKey] = msgs.length >= PAGE_SIZE;
            console.log('[INIT] msgs loaded:', msgs.length, 'hasMore:', convHasMore[convKey], 'offset:', convOffset[convKey]);

            // 重新创建该会话的已见集合
            if (!seenMsgIds[convKey]) {
                seenMsgIds[convKey] = new Set();
            }
            const currentSeen = seenMsgIds[convKey];

            msgs.forEach(msg => {
                appendMessage(msg, convKey, currentSeen);
            });
            messagesContainer.classList.remove('fade-in');
            void messagesContainer.offsetWidth;
            messagesContainer.classList.add('fade-in');
            scrollToBottom(true);
            // 标记已读
            if (type === 'group') {
                await apiFetch('/v1/groups/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ group_id: id }) });
            } else {
                await apiFetch('/v1/direct/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ with_uid: id }) });
            }

            // 设置滚动到顶部加载更多
            messagesContainer._scrollHandler = async () => {
                if (!convHasMore[convKey] || isLoadingMore) return;
                if (messagesContainer.scrollTop > 5) return;

                console.log('[LOAD_MORE] triggering, offset=', convOffset[convKey]);
                isLoadingMore = true;
                const loadReqId = ++isLoadingMoreReqId;
                const currentHeight = messagesContainer.scrollHeight;
                try {
                    const offset = convOffset[convKey] || 0;
                    const olderUrl = type === 'group'
                        ? `/v1/groups/messages/v2?group_id=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=${offset}`
                        : `/v1/direct/messages/v2?with_uid=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=${offset}`;
                    const res = await apiFetch(olderUrl);
                    const data = await res.json();
                    console.log('[LOAD_MORE] response:', olderUrl, 'msgs:', (data.messages||[]).length);
                    if (loadReqId !== isLoadingMoreReqId) return;
                    if (data.error) return;

                    // Go 返回 DESC（新→旧），反转为 ASC（旧→新）
                    const olderMsgs = (data.messages || []).slice().reverse();
                    if (olderMsgs.length === 0) {
                        convHasMore[convKey] = false;
                        return;
                    }
                    // 更新偏移量
                    convOffset[convKey] += olderMsgs.length;
                    convHasMore[convKey] = olderMsgs.length >= PAGE_SIZE;

                    // 过滤已加载的消息
                    const currentSeen = seenMsgIds[convKey] || new Set();
                    const newMsgs = olderMsgs.filter(msg => msg.id && !currentSeen.has(msg.id));
                    console.log('[LOAD_MORE] filtered:', olderMsgs.length, '→', newMsgs.length, 'seen:', currentSeen.size);
                    if (newMsgs.length === 0) {
                        convHasMore[convKey] = false;
                        return;
                    }

                    // 记录展开时的滚动位置
                    const scrollBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop;

                    // 创建一个 fragment 批量插入
                    const frag = document.createDocumentFragment();
                    let prevTs = 0;
                    newMsgs.forEach((msg) => {
                        const msgTs = msg.created_at || 0;
                        if (prevTs && msgTs && (msgTs - prevTs) > 300) {
                            frag.appendChild(createTimeSeparator(msgTs));
                        }
                        const el = createMessageElement(msg, convKey, seenMsgIds[convKey]);
                        if (el) frag.appendChild(el);
                        prevTs = msgTs;
                    });
                    messagesContainer.insertBefore(frag, messagesContainer.firstChild);

                    // 调整滚动位置，保持可视区域不变
                    messagesContainer.scrollTop = messagesContainer.scrollHeight - scrollBottom;
                } catch (e) {
                    console.error(e);
                } finally {
                    isLoadingMore = false;
                }
            };
            messagesContainer.addEventListener('scroll', messagesContainer._scrollHandler);
        } catch (e) {
            console.error(e);
            if (reqId === switchRequestId) {
                messagesContainer.innerHTML = '<div class="system-msg">网络错误，无法加载消息</div>';
            }
        }
    }

    /**
     * 根据消息数据创建 DOM 元素（不插入、不去重、不合并）
     */
    function createMessageElement(msg, convKey, currentSeen) {
        if (!msg || !msg.id) return null;

        const fromUid = msg.from_uid || msg.sender_uid || '';
        const msgType = msg.msg_type || 'text';

        if (msgType === 'system') {
            const div = document.createElement('div');
            div.className = 'time-separator';
            div.textContent = msg.body || '';
            div.dataset.msgId = msg.id;
            div.dataset.fromUid = fromUid;
            div.dataset.msgType = 'system';
            return div;
        }

        if (msgType === 'recall') {
            const div = document.createElement('div');
            div.className = 'time-separator';
            div.textContent = msg.body || '[消息已撤回]';
            div.dataset.msgId = msg.id;
            div.dataset.msgType = 'recall';
            return div;
        }

        const isSelfByUid = fromUid && myUid && fromUid.toUpperCase() === myUid.toUpperCase();
        const isSelfByFlag = msg.is_me === true || msg.isSelf === true;
        const isSelf = isSelfByUid || isSelfByFlag;

        const sender = isSelf ? '' : (msg.from_name || msg.sender_name || msg.display_name || lookupName(fromUid) || fromUid || '未知用户');
        const time = new Date(msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false });
        let content = '';

        if (msgType === 'image') {
            const mediaUrl = msg.media_url || '';
            const imgEl = document.createElement('img');
            imgEl.src = resolveMediaUrl(mediaUrl);
            imgEl.style.cssText = 'max-width:200px;max-height:200px;border-radius:8px;cursor:pointer;';
            imgEl.className = 'chat-image';
            imgEl.onclick = () => openImageViewer(mediaUrl);
            imgEl.onerror = function() { this.style.display='none'; };

            const msgDiv = document.createElement('div');
            msgDiv.className = `message ${isSelf ? 'self' : 'other'} bare-image`;
            msgDiv.dataset.msgId = msg.id;
            msgDiv.dataset.fromUid = fromUid;
            msgDiv.dataset.fromName = sender || '';
            msgDiv.dataset.msgType = msgType;

            // 头像处理：自己显示自己的头像，对方显示对方的头像
            const avatarUrl = isSelf
                ? myAvatar
                : (msg.from_avatar || msg.sender_avatar || msg.avatar_url || lookupAvatar(fromUid));
            const avatarImg = document.createElement('img');
            avatarImg.src = avatarUrl ? resolveMediaUrl(avatarUrl) : 'assets/default-avatar.png';
            avatarImg.className = 'msg-avatar';
            avatarImg.onerror = () => { avatarImg.src = 'assets/default-avatar.png'; };
            if (!isSelf && !avatarUrl && fromUid) {
                fetchUserProfile(fromUid).then(profile => {
                    if (profile && profile.avatar_url && avatarImg.isConnected) {
                        avatarImg.src = resolveMediaUrl(profile.avatar_url);
                    }
                });
            }
            avatarImg.addEventListener('click', (e) => {
                e.stopPropagation();
                const uid = isSelf ? myUid : fromUid;
                if (uid) openSpacePanel(uid);
            });
            msgDiv.appendChild(avatarImg);

            if (!isSelf && sender) {
                const senderDiv = document.createElement('div');
                senderDiv.className = 'message-sender';
                senderDiv.textContent = sender;
                if (sender === fromUid && fromUid) {
                    fetchUserProfile(fromUid).then(profile => {
                        if (profile && senderDiv.isConnected) {
                            senderDiv.textContent = profile.display_name || profile.username || sender;
                        }
                    });
                }
                msgDiv.appendChild(senderDiv);
            }

            msgDiv.appendChild(imgEl);

            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = time;
            msgDiv.appendChild(timeDiv);

            msgDiv.dataset.rawBody = JSON.stringify(msg) || '';
            return msgDiv;
        }

        if (msgType === 'video') {
            content = `<video controls style="max-width:200px;"><source src="${resolveMediaUrl(msg.media_url || '')}"></video>`;
        } else if (msgType === 'audio') {
            content = `<audio controls style="max-width:200px;" src="${resolveMediaUrl(msg.media_url || '')}"></audio>`;
        } else if (msgType === 'resource') {
            // 支持嵌套 v2 JSON body（如音乐分享等）
            let fileName = '';
            let displayText = '';
            if (msg.body && msg.body.trim().startsWith('{')) {
                try {
                    const obj = JSON.parse(msg.body);
                    if (obj.v === 2) {
                        displayText = obj.text || '';
                        if (obj.quote) {
                            const quote = obj.quote;
                            displayText = `<div class="quote-block" data-quoted-id="${escapeHtml(quote.id || '')}">
                                <div class="quote-sender">${escapeHtml(quote.from_name || quote.from_uid || '')}</div>
                                <div>${escapeHtml(quote.text || '')}</div>
                            </div>` + (displayText ? `<div style="white-space: pre-wrap; word-break: break-word;">${displayText}</div>` : '');
                        }
                        if (obj.mentions && Array.isArray(obj.mentions)) {
                            obj.mentions.forEach(m => {
                                const name = m.name || m.uid;
                                const regex = new RegExp(`@${escapeRegExp(name)}\u200B?`, 'g');
                                displayText = displayText.replace(regex,
                                    `<span class="mention-highlight" data-uid="${escapeHtml(m.uid || '')}">@${escapeHtml(name)}</span>`);
                            });
                        }
                        displayText = displayText.replace(/\n/g, '<br>');
                    } else {
                        fileName = msg.body;
                    }
                } catch (e) {
                    fileName = msg.body;
                }
            } else {
                fileName = msg.body || '';
            }
            if (!fileName && msg.media_url) {
                const urlParts = msg.media_url.split('/');
                fileName = decodeURIComponent(urlParts.pop()) || '文件';
            }
            const fileCardHtml = `<div class="file-card">
                <div class="file-info">
                    <div class="file-name">${escapeHtml(fileName)}</div>
                </div>
                <a href="${resolveMediaUrl(msg.media_url)}" target="_blank" class="file-download-btn">⬇</a>
            </div>`;
            content = displayText
                ? `<div style="margin-bottom:6px;">${displayText}</div>${fileCardHtml}`
                : fileCardHtml;
        } else if (msgType === 'voice') {
            if (msg.media_url) {
                content = `
                    <div class="voice-message" data-url="${msg.media_url}">
                        <div class="voice-top-row">
                            <button class="voice-play-btn">▶</button>
                            <div class="voice-wave" data-url="${msg.media_url}">
                                <div class="voice-wave-bg" style="width:0%"></div>
                                <div class="voice-wave-bars">${'<span></span>'.repeat(20)}</div>
                            </div>
                            <span class="voice-duration">0:00</span>
                        </div>
                        <audio preload="metadata" src="${resolveMediaUrl(msg.media_url)}"></audio>
                    </div>`;
            } else {
                const dur = (msg.duration_ms || 0) / 1000;
                const mins = Math.floor(dur / 60);
                const secs = Math.floor(dur % 60);
                const durStr = dur ? mins + ':' + (secs < 10 ? '0' : '') + secs : '0:00';
                content = `[语音 ${durStr}]`;
            }
        } else if (msgType === 'file' || (msg.media_url && msgType !== 'text')) {
            const fileUrl = msg.media_url || '';
            const fileName = msg.body || fileUrl.split('/').pop();
            content = `<a href="${fileUrl}" target="_blank" class="file-download-btn" style="color:var(--link-other);">📎 ${escapeHtml(fileName)}</a>`;
        } else if (msgType === 'text') {
            let body = msg.body || '';
            let quoteHtml = '';

            if (body.trim().startsWith('{')) {
                try {
                    const obj = JSON.parse(body);
                    if (obj.v === 2) {
                        let textBody = obj.text || '';
                        if (obj.quote) {
                            const quote = obj.quote;
                            quoteHtml = `
                                <div class="quote-block" data-quoted-id="${escapeHtml(quote.id || '')}">
                                    <div class="quote-sender">${escapeHtml(quote.from_name || quote.from_uid || '')}</div>
                                    <div>${escapeHtml(quote.text || '')}</div>
                                </div>`;
                        }
                        if (obj.mentions && Array.isArray(obj.mentions)) {
                            obj.mentions.forEach(m => {
                                const name = m.name || m.uid;
                                const regex = new RegExp(`@${escapeRegExp(name)}\u200B?`, 'g');
                                textBody = textBody.replace(regex,
                                    `<span class="mention-highlight" data-uid="${escapeHtml(m.uid || '')}">@${escapeHtml(name)}</span>`);
                            });
                        }
                        textBody = textBody.replace(/\n/g, '<br>');
                        content = quoteHtml + (textBody ? `<div style="white-space: pre-wrap; word-break: break-word;">${textBody}</div>` : '');
                    } else {
                        body = escapeHtml(body);
                        body = body.replace(/\n/g, '<br>');
                        content = `<div style="white-space: pre-wrap; word-break: break-word;">${body}</div>`;
                    }
                } catch (e) {
                    body = escapeHtml(body);
                    body = body.replace(/\n/g, '<br>');
                    content = `<div style="white-space: pre-wrap; word-break: break-word;">${body}</div>`;
                }
            } else {
                body = escapeHtml(body);
                body = body.replace(/\n/g, '<br>');
                content = `<div style="white-space: pre-wrap; word-break: break-word;">${body}</div>`;
            }
        } else if (msgType === 'red_packet') {
            let packetData = null;
            try {
                if (msg.body && msg.body.trim().startsWith('{')) {
                    packetData = JSON.parse(msg.body);
                }
            } catch (e) {}
            if (packetData && packetData.packet_id) {
                const packetId = packetData.packet_id;
                const totalAmount = packetData.total_amount || '?';
                const totalCount = packetData.total_count || '?';
                content = `
                    <div class="red-packet-card" data-packet-id="${escapeHtml(packetId)}" data-claimed="false">
                        <div class="rp-icon">🧧</div>
                        <div class="rp-info">
                            <div class="rp-title">红包</div>
                            <div class="rp-desc">总额 ${totalAmount} · ${totalCount}个</div>
                        </div>
                        <div class="rp-status">点击领取</div>
                    </div>`;
            } else {
                content = `[红包] ${escapeHtml(msg.body || '')}`;
            }
        } else {
            content = `[${msgType}] ${escapeHtml(msg.body || '')}`;
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${isSelf ? 'self' : 'other'}`;
        msgDiv.dataset.msgId = msg.id;
        msgDiv.dataset.fromUid = fromUid;
        msgDiv.dataset.fromName = sender || '';
        msgDiv.dataset.msgType = msgType;

        // 头像处理：自己显示自己的头像，对方显示对方的头像
        const avatarUrl = isSelf
            ? myAvatar
            : (msg.from_avatar || msg.sender_avatar || msg.avatar_url || lookupAvatar(fromUid));
        const avatarImg = document.createElement('img');
        avatarImg.src = avatarUrl ? resolveMediaUrl(avatarUrl) : 'assets/default-avatar.png';
        avatarImg.className = 'msg-avatar';
        avatarImg.onerror = () => { avatarImg.src = 'assets/default-avatar.png'; };
        if (!isSelf && !avatarUrl && fromUid) {
            fetchUserProfile(fromUid).then(profile => {
                if (profile && profile.avatar_url && avatarImg.isConnected) {
                    avatarImg.src = resolveMediaUrl(profile.avatar_url);
                }
            });
        }
        avatarImg.addEventListener('click', (e) => {
            e.stopPropagation();
            const uid = isSelf ? myUid : msg.from_uid;
            if (uid) {
                openSpacePanel(uid);
            }
        });
        msgDiv.appendChild(avatarImg);

        if (!isSelf && sender) {
            const senderDiv = document.createElement('div');
            senderDiv.className = 'message-sender';
            senderDiv.textContent = sender;
            if (sender === fromUid && fromUid) {
                fetchUserProfile(fromUid).then(profile => {
                    if (profile && senderDiv.isConnected) {
                        senderDiv.textContent = profile.display_name || profile.username || sender;
                        msgDiv.dataset.fromName = profile.display_name || profile.username || sender;
                    }
                });
            }
            msgDiv.appendChild(senderDiv);
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.innerHTML = content;
        msgDiv.appendChild(bubble);

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = time;
        msgDiv.appendChild(timeDiv);

        if (bubble) {
            msgDiv.dataset.plainText = bubble.innerText;
        }
        msgDiv.dataset.rawBody = JSON.stringify(msg) || '';
        return msgDiv;
    }

    function appendMessage(msg, convKey, currentSeen) {
        if (!msg || !msg.id) return;
        if (!convKey) convKey = currentConv?.key;
        if (!convKey) return;
    
        if (!currentSeen) {
            if (!seenMsgIds[convKey]) seenMsgIds[convKey] = new Set();
            currentSeen = seenMsgIds[convKey];
        }
    
        if (currentSeen.has(msg.id)) {
            return;
        }

        const fromUid = msg.from_uid || '';
        const isPlainText = (msg.msg_type || 'text') === 'text' && !(msg.body || '').trim().startsWith('{');
        const msgTs = msg.created_at || 0;

        // 检查是否为连续消息（同发送者、5分钟内、同会话）
        const isConsecutive = lastRenderedMsg &&
            lastRenderedMsg.convKey === convKey &&
            lastRenderedMsg.from_uid === fromUid &&
            msgTs && lastRenderedTs && (msgTs - lastRenderedTs) <= 300;

        // 检查时间间隔，超过5分钟插入时间分隔符
        if (msgTs && lastRenderedTs && (msgTs - lastRenderedTs) > 300) {
            const sep = createTimeSeparator(msgTs);
            messagesContainer.appendChild(sep);
        }

        // 尝试合并连续的同发送者纯文本消息（保留旧逻辑但禁用）
        if (false && mergeMessages && lastRenderedMsg && 
            lastRenderedMsg.convKey === convKey && 
            lastRenderedMsg.from_uid === fromUid &&
            isPlainText &&
            !msg.burn_after_seconds) {
            const time = new Date(msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false });
            const container = lastRenderedMsg.element.querySelector('.message-content');
            const oldTime = container.querySelector('.message-time');
            if (oldTime) oldTime.remove();
            const content = msg.body ? escapeHtml(msg.body).replace(/\n/g, '<br>') : '';
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble merged';
            bubble.innerHTML = content;
            container.appendChild(bubble);
            const newTime = document.createElement('div');
            newTime.className = 'message-time';
            newTime.textContent = time;
            container.appendChild(newTime);
            
            currentSeen.add(msg.id);
            lastRenderedTs = msgTs;
            return;
        }
    
        const msgDiv = createMessageElement(msg, convKey, currentSeen);
        if (!msgDiv) return;

        // 添加连续消息标记
        if (isConsecutive) {
            msgDiv.classList.add('consecutive');
            // 标记上一条消息为连续组的首条
            if (lastRenderedMsg && lastRenderedMsg.element) {
                lastRenderedMsg.element.classList.add('consecutive-first');
            }
        } else {
            // 非连续消息，移除首条标记
            if (lastRenderedMsg && lastRenderedMsg.element) {
                lastRenderedMsg.element.classList.remove('consecutive-first');
            }
        }
    
        messagesContainer.appendChild(msgDiv);
    
        currentSeen.add(msg.id);
        // 临时消息（temp_开头）不更新 lastRenderedMsg，避免影响连消息判断
        if (!String(msg.id).startsWith('temp_')) {
            lastRenderedMsg = { convKey, from_uid: fromUid, element: msgDiv };
            lastRenderedTs = msgTs;
        }
    }

    function scrollToBottom(force = false) {
        if (force) {
            // 强制滚动到底部（切换会话/发送消息后使用）
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            return;
        }
        // 只在用户已近底部时才自动滚动，避免强制拉到最下方
        const threshold = messagesContainer.clientHeight / 2;
        const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
        if (atBottom) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    // 点击引用块跳转到被引用的消息
    messagesContainer.addEventListener('click', function(e) {
        const quoteBlock = e.target.closest('.quote-block');
        if (!quoteBlock) return;
        const quotedId = quoteBlock.dataset.quotedId;
        if (!quotedId) return;
        const targetMsg = document.querySelector(`.message[data-msg-id="${CSS.escape(quotedId)}"]`);
        if (!targetMsg) return;
        targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // 语音消息播放/暂停
    messagesContainer.addEventListener('click', function(e) {
        const playBtn = e.target.closest('.voice-play-btn');
        if (!playBtn) return;
        const voiceMsg = playBtn.closest('.voice-message');
        if (!voiceMsg) return;
        const audio = voiceMsg.querySelector('audio');
        if (!audio) return;

        if (audio.paused) {
            // 暂停其他播放中的语音
            document.querySelectorAll('.voice-message audio').forEach(function(a) {
                if (a !== audio && !a.paused) a.pause();
            });
            audio.play().catch(function() {});
        } else {
            audio.pause();
        }
    });

    // 音频元数据加载完成 → 显示总时长
    messagesContainer.addEventListener('loadedmetadata', function(e) {
        if (e.target.tagName !== 'AUDIO') return;
        const voiceMsg = e.target.closest('.voice-message');
        if (!voiceMsg) return;
        const audio = e.target;
        const dur = audio.duration;
        if (!isFinite(dur)) return;
        const durEl = voiceMsg.querySelector('.voice-duration');
        if (durEl && !voiceMsg.classList.contains('is-playing')) {
            durEl.textContent = formatTime(dur);
        }
    }, true);

    // 播放进度更新 → 波形背景高亮(0-100%) + 秒数
    messagesContainer.addEventListener('timeupdate', function(e) {
        if (e.target.tagName !== 'AUDIO') return;
        const voiceMsg = e.target.closest('.voice-message');
        if (!voiceMsg) return;
        const audio = e.target;
        const dur = audio.duration;
        if (!isFinite(dur) || dur <= 0) return;
        const wave = voiceMsg.querySelector('.voice-wave');
        if (wave && !wave.classList.contains('dragging')) {
            const pct = (audio.currentTime / dur) * 100;
            wave.querySelector('.voice-wave-bg').style.width = pct + '%';
        }
        const durEl = voiceMsg.querySelector('.voice-duration');
        if (durEl) durEl.textContent = formatTime(audio.currentTime) + '/' + formatTime(dur);
    }, true);

    // 在波形上拖拽/点击跳转
    var voiceDrag = { active: false, wave: null };

    messagesContainer.addEventListener('mousedown', function(e) {
        const wave = e.target.closest('.voice-wave');
        if (!wave) return;
        const voiceMsg = wave.closest('.voice-message');
        if (!voiceMsg) return;
        const audio = voiceMsg.querySelector('audio');
        if (!audio) return;
        voiceDrag.active = true;
        voiceDrag.wave = wave;
        wave.classList.add('dragging');
        seekWave(wave, audio, e.clientX);
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!voiceDrag.active || !voiceDrag.wave) return;
        const voiceMsg = voiceDrag.wave.closest('.voice-message');
        if (!voiceMsg) return;
        const audio = voiceMsg.querySelector('audio');
        if (!audio) return;
        seekWave(voiceDrag.wave, audio, e.clientX);
    });

    document.addEventListener('mouseup', function() {
        if (voiceDrag.active && voiceDrag.wave) {
            voiceDrag.wave.classList.remove('dragging');
            voiceDrag.active = false;
            voiceDrag.wave = null;
        }
    });

    function seekWave(wave, audio, clientX) {
        const rect = wave.getBoundingClientRect();
        var ratio = (clientX - rect.left) / rect.width;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        const dur = audio.duration;
        if (!isFinite(dur) || dur <= 0) return;
        audio.currentTime = ratio * dur;
        wave.querySelector('.voice-wave-bg').style.width = (ratio * 100) + '%';
        const durEl = wave.closest('.voice-message').querySelector('.voice-duration');
        if (durEl) durEl.textContent = formatTime(ratio * dur) + '/' + formatTime(dur);
    }

    // 播放开始 → 更新图标/启动波形可视化
    messagesContainer.addEventListener('play', function(e) {
        if (e.target.tagName !== 'AUDIO') return;
        const voiceMsg = e.target.closest('.voice-message');
        if (!voiceMsg) return;
        voiceMsg.classList.add('is-playing');
        voiceMsg.querySelector('.voice-play-btn').textContent = '⏸';
        const wave = voiceMsg.querySelector('.voice-wave');
        if (wave) startVoiceVis(e.target, wave);
        currentlyPlayingVoiceMsg = voiceMsg;
        document.getElementById('nowPlayingBtn').style.display = '';
    }, true);

    // 暂停 → 恢复图标/波形
    messagesContainer.addEventListener('pause', function(e) {
        if (e.target.tagName !== 'AUDIO') return;
        const voiceMsg = e.target.closest('.voice-message');
        if (!voiceMsg) return;
        voiceMsg.querySelector('.voice-play-btn').textContent = '▶';
        stopVoiceVis();
        currentlyPlayingVoiceMsg = null;
        document.getElementById('nowPlayingBtn').style.display = 'none';
        // 播放结束后恢复显示总时长
        const audio = e.target;
        if (audio.currentTime >= audio.duration - 0.1 || audio.currentTime === 0) {
            voiceMsg.classList.remove('is-playing');
            const durEl = voiceMsg.querySelector('.voice-duration');
            if (durEl && isFinite(audio.duration)) {
                durEl.textContent = formatTime(audio.duration);
            }
        }
    }, true);

    // 播放结束 → 重置
    messagesContainer.addEventListener('ended', function(e) {
        if (e.target.tagName !== 'AUDIO') return;
        const voiceMsg = e.target.closest('.voice-message');
        if (!voiceMsg) return;
        voiceMsg.classList.remove('is-playing');
        voiceMsg.querySelector('.voice-play-btn').textContent = '▶';
        const wave = voiceMsg.querySelector('.voice-wave');
        if (wave) { wave.querySelector('.voice-wave-bg').style.width = '0%'; }
        stopVoiceVis();
        const audio = e.target;
        const durEl = voiceMsg.querySelector('.voice-duration');
        if (durEl && isFinite(audio.duration)) durEl.textContent = formatTime(audio.duration);
        // 播放结束 → 隐藏正在播放图标
        currentlyPlayingVoiceMsg = null;
        document.getElementById('nowPlayingBtn').style.display = 'none';
    }, true);

    var currentlyPlayingVoiceMsg = null;

    document.getElementById('nowPlayingBtn').addEventListener('click', function() {
        if (currentlyPlayingVoiceMsg && currentlyPlayingVoiceMsg.isConnected) {
            currentlyPlayingVoiceMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });

    // === 语音波形动画（消息内） ===
    var voiceVisCtx = null;
    var voiceVisCache = {};
    var voiceVis = { rafId: null, audio: null, bars: null };

    function stopVoiceVis() {
        if (voiceVis.rafId) { cancelAnimationFrame(voiceVis.rafId); voiceVis.rafId = null; }
        if (voiceVis.bars) {
            voiceVis.bars.forEach(function(b) { b.style.height = ''; b.style.opacity = ''; });
        }
        voiceVis.audio = null;
        voiceVis.bars = null;
    }

    async function startVoiceVis(audio, wave) {
        stopVoiceVis();

        if (!voiceVisCtx) {
            voiceVisCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (voiceVisCtx.state === 'suspended') voiceVisCtx.resume();
        }

        var url = audio.currentSrc || audio.src;
        if (!url || url.startsWith('blob:')) return;

        var cached = voiceVisCache[url];
        if (!cached) {
            try {
                var resp = await fetch(url);
                var buf = await resp.arrayBuffer();
                var decoded = await voiceVisCtx.decodeAudioData(buf);
                cached = { data: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
                voiceVisCache[url] = cached;
            } catch (e) {
                console.warn('语音波形解码失败:', e);
                return;
            }
        }

        var pcm = cached.data;
        var bars = wave.querySelectorAll('.voice-wave-bars span');
        if (!bars.length) return;

        voiceVis.audio = audio;
        voiceVis.bars = bars;
        var totalSamples = pcm.length;
        var barCount = bars.length;

        function render() {
            if (audio.paused || audio.ended) { stopVoiceVis(); return; }

            var ct = audio.currentTime;
            var dur = audio.duration;
            if (!isFinite(dur) || dur <= 0) {
                voiceVis.rafId = requestAnimationFrame(render);
                return;
            }

            var windowLen = Math.min(totalSamples, Math.floor(totalSamples * 1.5 / dur));
            var midSample = (ct / dur) * totalSamples;
            var startSample = Math.max(0, Math.floor(midSample - windowLen * 0.4));
            var endSample = Math.min(totalSamples, startSample + windowLen);
            if (endSample - startSample < barCount) {
                endSample = Math.min(totalSamples, startSample + barCount);
            }

            var samplesPerBar = Math.max(1, Math.floor((endSample - startSample) / barCount));

            for (var i = 0; i < barCount; i++) {
                var sStart = startSample + i * samplesPerBar;
                var sEnd = Math.min(endSample, sStart + samplesPerBar);
                var sum = 0;
                for (var s = sStart; s < sEnd; s++) {
                    sum += Math.abs(pcm[s]);
                }
                var avg = sum / (sEnd - sStart);
                var val = Math.min(1, avg * 3);
                val = Math.max(0.05, val);
                bars[i].style.height = (val * 22) + 'px';
                bars[i].style.opacity = Math.max(0.2, val * 0.8 + 0.2);
            }

            voiceVis.rafId = requestAnimationFrame(render);
        }

        render();
    }

    // 格式化秒数为 mm:ss
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        var s = Math.floor(seconds);
        var m = Math.floor(s / 60);
        var sec = s % 60;
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }


    async function sendMessage(body, msgType = 'text', mediaUrl = null, thumbUrl = null) {
        if (!currentConv) return;

        // 检测 @mention 并转换为 v2 格式
        const mentions = [];
        if (msgType === 'text' && currentConv.type === 'group') {
            const mentionRegex = /@([^\u200B@]+)/g;
            let match;
            while ((match = mentionRegex.exec(body)) !== null) {
                const name = match[1];
                const member = mentionMembers.find(m => m.name === name);
                if (member) {
                    mentions.push({ uid: member.uid, name: member.name });
                }
            }
        }

        // 如果文本包含换行、引用或mentions，自动转成 v2 格式
        if (msgType === 'text' && (body.includes('\n') || mentions.length > 0) && !pendingQuote) {
            const v2Obj = { v: 2, text: body };
            if (mentions.length > 0) v2Obj.mentions = mentions;
            body = JSON.stringify(v2Obj);
        }
    
        if (pendingQuote && msgType === 'text' && body.trim()) {
            const quotePayload = {
                v: 2,
                text: body,
                quote: pendingQuote
            };
            if (mentions.length > 0) quotePayload.mentions = mentions;
            body = JSON.stringify(quotePayload);
            msgType = 'text';
        }
    
        const payload = currentConv.type === 'group'
            ? {
                group_id: currentConv.id,
                body: body,
                msg_type: msgType,
                media_url: mediaUrl || '',
                thumb_url: thumbUrl || ''
              }
            : {
                to_uid: currentConv.id,
                body: body,
                msg_type: msgType,
                media_url: mediaUrl || '',
                thumb_url: thumbUrl || ''
              };

        // 立即显示发送中消息（半透明）
        const tempId = 'temp_' + Date.now();
        const tempMsg = {
            id: tempId,
            from_uid: myUid,
            from_name: myName,
            from_avatar: myAvatar || '',
            body: msgType === 'text' ? body : '',
            msg_type: msgType,
            media_url: mediaUrl,
            thumb_url: thumbUrl,
            created_at: Math.floor(Date.now() / 1000),
        };
        if (currentConv.type === 'group') {
            tempMsg.group_id = currentConv.id;
        }
        appendMessage(tempMsg, currentConv.key, seenMsgIds[currentConv.key]);
        scrollToBottom(true);

        // 找到临时消息元素，设置半透明
        const tempEl = messagesContainer.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl) {
            tempEl.style.opacity = '0.5';
        }

        // 带重试的发送逻辑
        const sendEndpoint = currentConv.type === 'group' ? '/v1/groups/message/send' : '/v1/direct/send';
        const doSend = async () => {
            const res = await apiFetch(sendEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return await res.json();
        };

        let data = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                data = await doSend();
                if (!data.error) break;
                lastError = data.error;
            } catch (e) {
                lastError = e.message || '网络错误';
            }
            if (attempt === 0) {
                // 等待5秒后重试
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (data && !data.error) {
            if (pendingQuote) {
                pendingQuote = null;
                quotePreview.style.display = 'none';
            }
            const msg = data.message || data;
            if (msg && msg.id) {
                if (tempEl) {
                    const newEl = createMessageElement(msg, currentConv.key, seenMsgIds[currentConv.key]);
                    if (newEl) {
                        // 检查是否为连消息
                        const msgTs = msg.created_at || 0;
                        if (lastRenderedMsg &&
                            lastRenderedMsg.convKey === currentConv.key &&
                            lastRenderedMsg.from_uid === (msg.from_uid || '') &&
                            msgTs && lastRenderedTs && (msgTs - lastRenderedTs) <= 300) {
                            newEl.classList.add('consecutive');
                            if (lastRenderedMsg.element) {
                                lastRenderedMsg.element.classList.add('consecutive-first');
                            }
                        } else {
                            if (lastRenderedMsg && lastRenderedMsg.element) {
                                lastRenderedMsg.element.classList.remove('consecutive-first');
                            }
                        }
                        tempEl.replaceWith(newEl);
                        lastRenderedMsg = { convKey: currentConv.key, from_uid: msg.from_uid || '', element: newEl };
                        lastRenderedTs = msgTs;
                    }
                    seenMsgIds[currentConv.key]?.delete(tempId);
                    seenMsgIds[currentConv.key]?.add(msg.id);
                } else {
                    appendMessage(msg, currentConv.key, seenMsgIds[currentConv.key]);
                    scrollToBottom(true);
                }
            }
        } else {
            // 发送失败，移除临时消息，将文本退回输入框
            if (tempEl) tempEl.remove();
            seenMsgIds[currentConv.key]?.delete(tempId);
            // 将原始文本退回输入框
            if (msgType === 'text') {
                let originalBody = body;
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.v === 2) originalBody = parsed.text || '';
                } catch (e) {}
                messageInput.value = originalBody;
                messageInput.focus();
                messageInput.dispatchEvent(new Event('input'));
            }
        }
    }

    messageInput.addEventListener('keydown', function (e) {
        // @mention 弹窗激活时拦截按键
        if (mentionPopup && mentionPopup.classList.contains('show')) {
            const items = mentionList.querySelectorAll('.mention-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                mentionActiveIndex = Math.min(mentionActiveIndex + 1, items.length - 1);
                items.forEach((el, i) => el.classList.toggle('active', i === mentionActiveIndex));
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                mentionActiveIndex = Math.max(mentionActiveIndex - 1, 0);
                items.forEach((el, i) => el.classList.toggle('active', i === mentionActiveIndex));
                return;
            } else if (e.key === 'Tab' || e.key === ' ') {
                e.preventDefault();
                if (items[mentionActiveIndex]) items[mentionActiveIndex].click();
                return;
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (items[mentionActiveIndex]) {
                    items[mentionActiveIndex].click();
                } else {
                    hideMentionPopup();
                }
                return;
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideMentionPopup();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = this.value.trim();
            if (text) {
                sendMessage(text);
                this.value = '';
                this.style.height = 'auto';
            }
        }
    });

    messageInput.addEventListener('input', function () {
        this.style.height = 'auto';
        const maxH = Math.floor(window.innerHeight * 0.35);
        this.style.height = Math.min(this.scrollHeight, maxH) + 'px';

        // @mention 检测
        const val = this.value;
        const cursorPos = this.selectionStart;
        const textBefore = val.substring(0, cursorPos);
        const atMatch = textBefore.match(/@([^\u200B@]*)$/);
        if (atMatch && currentConv && currentConv.type === 'group') {
            if (!mentionJustInserted) showMentionPopup(atMatch[1]);
        } else {
            hideMentionPopup();
        }
    });

    // @mention 弹窗逻辑
    const mentionPopup = document.getElementById('mentionPopup');
    const mentionSearch = document.getElementById('mentionSearch');
    const mentionList = document.getElementById('mentionList');
    let mentionMembers = [];
    let groupMembers = [];
    let mentionActiveIndex = 0;

    async function loadGroupMembers() {
        if (!currentConv || currentConv.type !== 'group') return;
        try {
            const res = await apiFetch('/v1/groups/members?group_id=' + encodeURIComponent(currentConv.id));
            const data = await res.json();
            // Go 返回 {members: [{uid, username, display_name, avatar_url, role, joined_at}]}
            groupMembers = (data.members || []).map(m => ({
                uid: m.uid,
                name: m.display_name || m.username || m.uid,
                avatar: m.avatar_url || ''
            }));
            mentionMembers = groupMembers;
        } catch (e) {
            mentionMembers = [];
            groupMembers = [];
        }
    }

    function showMentionPopup(filter) {
        mentionPopup.classList.add('show');
        mentionSearch.value = filter;
        filterMentionList(filter);
    }

    function hideMentionPopup() {
        mentionPopup.classList.remove('show');
        mentionActiveIndex = 0;
    }

    // 简易拼音匹配（首字母）
    const pinyinMap = {
        '阿':'a','爱':'ai','安':'an','奥':'ao','吧':'ba','白':'bai','百':'bai','半':'ban','帮':'bang','包':'bao','北':'bei','被':'bei','本':'ben','比':'bi','边':'bian','变':'bian','表':'biao','别':'bie','冰':'bing','并':'bing','波':'bo','不':'bu','才':'cai','菜':'cai','参':'can','长':'chang','常':'chang','超':'chao','车':'che','成':'cheng','程':'cheng','吃':'chi','虫':'chong','出':'chu','川':'chuan','吹':'chui','春':'chun','次':'ci','从':'cong','大':'da','带':'dai','单':'dan','但':'dan','当':'dang','到':'dao','的':'de','地':'de','得':'de','等':'deng','低':'di','地':'di','点':'dian','电':'dian','掉':'diao','丁':'ding','定':'ding','东':'dong','动':'dong','都':'dou','读':'du','度':'du','短':'duan','对':'dui','多':'duo','儿':'er','发':'fa','法':'fa','反':'fan','方':'fang','飞':'fei','非':'fei','分':'fen','风':'feng','夫':'fu','父':'fu','该':'gai','干':'gan','刚':'gang','高':'gao','告':'gao','个':'ge','给':'gei','跟':'gen','更':'geng','工':'gong','公':'gong','功':'gong','共':'gong','够':'gou','古':'gu','故':'gu','关':'guan','观':'guan','管':'guan','光':'guang','广':'guang','贵':'gui','国':'guo','过':'guo','哈':'ha','海':'hai','好':'hao','和':'he','合':'he','何':'he','很':'hen','后':'hou','忽':'hu','花':'hua','华':'hua','话':'hua','画':'hua','坏':'huai','欢':'huan','还':'huan','环':'huan','换':'huan','黄':'huang','回':'hui','会':'hui','活':'huo','火':'huo','或':'huo','几':'ji','机':'ji','急':'ji','集':'ji','几':'ji','计':'ji','记':'ji','继':'ji','加':'jia','家':'jia','假':'jia','间':'jian','见':'jian','件':'jian','建':'jian','将':'jiang','江':'jiang','讲':'jiang','交':'jiao','叫':'jiao','接':'jie','街':'jie','结':'jie','姐':'jie','解':'jie','今':'jin','金':'jin','进':'jin','近':'jin','京':'jing','经':'jing','精':'jing','九':'jiu','久':'jiu','酒':'jiu','就':'jiu','举':'ju','句':'ju','觉':'jue','军':'jun','开':'kai','看':'kan','可':'ke','科':'ke','刻':'ke','客':'ke','空':'kong','口':'kou','快':'kuai','块':'kuai','况':'kuang','来':'lai','蓝':'lan','老':'lao','了':'le','乐':'le','累':'lei','冷':'leng','离':'li','里':'li','理':'li','力':'li','立':'li','利':'li','连':'lian','脸':'lian','两':'liang','亮':'liang','了':'liao','林':'lin','零':'ling','领':'ling','另':'ling','六':'liu','龙':'long','路':'lu','乱':'luan','论':'lun','落':'luo','妈':'ma','马':'ma','吗':'ma','买':'mai','卖':'mai','忙':'mang','毛':'mao','么':'me','没':'mei','美':'mei','门':'men','们':'men','梦':'meng','米':'mi','面':'mian','民':'min','明':'ming','命':'ming','没':'mo','模':'mo','末':'mo','莫':'mo','木':'mu','拿':'na','那':'na','哪':'na','男':'nan','难':'nan','呢':'ne','内':'nei','能':'neng','你':'ni','年':'nian','念':'nian','娘':'niang','鸟':'niao','您':'nin','牛':'niu','农':'nong','女':'nv','欧':'ou','怕':'pa','排':'pai','旁':'pang','跑':'pao','配':'pei','朋':'peng','批':'pi','片':'pian','飘':'piao','平':'ping','破':'po','七':'qi','期':'qi','其':'qi','奇':'qi','起':'qi','气':'qi','千':'qian','前':'qian','强':'qiang','桥':'qiao','切':'qie','亲':'qin','青':'qing','清':'qing','请':'qing','穷':'qiong','秋':'qiu','去':'qu','全':'quan','然':'ran','让':'rang','热':'re','人':'ren','认':'ren','任':'ren','日':'ri','容':'rong','如':'ru','入':'ru','三':'san','色':'se','山':'shan','上':'shang','少':'shao','她':'she','社':'she','身':'shen','深':'shen','生':'sheng','声':'sheng','师':'shi','十':'shi','时':'shi','实':'shi','食':'shi','使':'shi','始':'shi','世':'shi','市':'shi','事':'shi','是':'shi','手':'shou','首':'shou','受':'shou','书':'shu','数':'shu','双':'shuang','谁':'shui','水':'shui','睡':'shui','说':'shuo','思':'si','死':'si','四':'si','送':'song','虽':'sui','岁':'sui','所':'suo','他':'ta','她':'ta','它':'ta','太':'tai','谈':'tan','汤':'tang','糖':'tang','躺':'tang','逃':'tao','特':'te','提':'ti','体':'ti','天':'tian','田':'tian','条':'tiao','跳':'tiao','听':'ting','通':'tong','同':'tong','统':'tong','头':'tou','图':'tu','土':'tu','团':'tuan','推':'tui','脱':'tuo','外':'wai','完':'wan','玩':'wan','万':'wan','王':'wang','往':'wang','望':'wang','为':'wei','位':'wei','味':'wei','文':'wen','问':'wen','我':'wo','握':'wo','五':'wu','物':'wu','西':'xi','习':'xi','系':'xi','细':'xi','下':'xia','夏':'xia','先':'xian','现':'xian','线':'xian','相':'xiang','想':'xiang','向':'xiang','项':'xiang','小':'xiao','笑':'xiao','些':'xie','写':'xie','心':'xin','新':'xin','信':'xin','星':'xing','行':'xing','兴':'xing','醒':'xing','姓':'xing','休':'xiu','需':'xu','许':'xu','续':'xu','选':'xuan','学':'xue','雪':'xue','寻':'xun','呀':'ya','牙':'ya','言':'yan','眼':'yan','演':'yan','验':'yan','央':'yang','样':'yang','要':'yao','也':'ye','业':'ye','叶':'ye','一':'yi','衣':'yi','医':'yi','依':'yi','以':'yi','已':'yi','意':'yi','因':'yin','音':'yin','银':'yin','应':'ying','英':'ying','影':'ying','用':'you','友':'you','有':'you','又':'you','于':'yu','与':'yu','语':'yu','元':'yuan','远':'yuan','院':'yuan','月':'yue','云':'yun','在':'zai','再':'zai','早':'zao','怎':'zen','张':'zhang','长':'zhang','找':'zhao','这':'zhe','着':'zhe','真':'zhen','正':'zheng','之':'zhi','知':'zhi','只':'zhi','指':'zhi','中':'zhong','种':'zhong','重':'zhong','周':'zhou','主':'zhu','住':'zhu','注':'zhu','转':'zhuan','装':'zhuang','准':'zhun','自':'zi','字':'zi','总':'zong','走':'zou','族':'zu','组':'zu','最':'zui','尊':'zun','昨':'zuo','作':'zuo','做':'zuo'
    };

    function getPinyinInitials(str) {
        return str.split('').map(ch => pinyinMap[ch] || ch).join('');
    }

    function filterMentionList(filter) {
        const lower = filter.toLowerCase();
        const filtered = mentionMembers.filter(m => {
            const nameLower = m.name.toLowerCase();
            if (nameLower.includes(lower)) return true;
            if (m.uid.toLowerCase().includes(lower)) return true;
            // 全拼搜索
            const pinyin = getPinyinInitials(m.name).toLowerCase();
            if (pinyin.includes(lower)) return true;
            // 拼音首字母搜索（如 "lgcr" 匹配 "LGCR837-1"）
            const initials = m.name.split('').map(ch => {
                const py = pinyinMap[ch];
                return py ? py[0] : ch.toLowerCase();
            }).join('');
            if (initials.includes(lower)) return true;
            return false;
        });
        mentionActiveIndex = 0;
        renderMentionList(filtered);
    }

    function renderMentionList(list) {
        mentionList.innerHTML = '';
        if (list.length === 0) {
            mentionList.innerHTML = '<div style="padding:12px;text-align:center;color:var(--secondary-text);font-size:13px;">无匹配成员</div>';
            return;
        }
        list.forEach((m, i) => {
            const item = document.createElement('div');
            item.className = 'mention-item' + (i === mentionActiveIndex ? ' active' : '');
            item.innerHTML = `<img src="${resolveMediaUrl(m.avatar || 'assets/default-avatar.png')}" onerror="this.src='assets/default-avatar.png'"><span class="mention-name">${escapeHtml(m.name)}</span>`;
            item.addEventListener('click', () => insertMention(m));
            item.addEventListener('mouseenter', () => {
                mentionActiveIndex = i;
                mentionList.querySelectorAll('.mention-item').forEach((el, j) => el.classList.toggle('active', j === i));
            });
            mentionList.appendChild(item);
        });
    }

    let mentionJustInserted = false;
    function insertMention(member) {
        const val = messageInput.value;
        const cursorPos = messageInput.selectionStart;
        const textBefore = val.substring(0, cursorPos);
        const textAfter = val.substring(cursorPos);
        const newBefore = textBefore.replace(/@[^\u200B@]*$/, '@' + member.name + '\u200B ');
        messageInput.value = newBefore + textAfter;
        messageInput.focus();
        const newPos = newBefore.length;
        messageInput.setSelectionRange(newPos, newPos);
        hideMentionPopup();
        mentionJustInserted = true;
        messageInput.dispatchEvent(new Event('input'));
        mentionJustInserted = false;
    }

    mentionSearch.addEventListener('input', function () {
        filterMentionList(this.value);
    });

    mentionSearch.addEventListener('keydown', function (e) {
        const items = mentionList.querySelectorAll('.mention-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            mentionActiveIndex = Math.min(mentionActiveIndex + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('active', i === mentionActiveIndex));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            mentionActiveIndex = Math.max(mentionActiveIndex - 1, 0);
            items.forEach((el, i) => el.classList.toggle('active', i === mentionActiveIndex));
        } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') {
            e.preventDefault();
            if (items[mentionActiveIndex]) items[mentionActiveIndex].click();
        } else if (e.key === 'Escape') {
            hideMentionPopup();
            messageInput.focus();
        }
    });

    // 点击外部关闭弹窗
    document.addEventListener('click', (e) => {
        if (!mentionPopup.contains(e.target) && e.target !== messageInput) {
            hideMentionPopup();
        }
    });

    // 图片粘贴の上传判定
    messageInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || window.clipboardData).items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                e.preventDefault();
                const file = items[i].getAsFile();
                if (!file) continue;
                if (!currentConv) {
                    alert('请先选择一个会话');
                    return;
                }
                if (confirm(`是否发送图片 "${file.name || '粘贴的图片'}"？`)) {
                    uploadAndSend(file);
                }
                break;
            }
        }
    });

    sendBtn.addEventListener('click', () => {
        const text = messageInput.value.trim();
        if (text) {
            sendMessage(text);
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }
    });

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moreMenu.classList.toggle('show');
    });
    document.addEventListener('click', () => {
        moreMenu.classList.remove('show');
    });

    document.getElementById('sendImageBtn').addEventListener('click', () => {
        fileInput.accept = 'image/*';
        fileInput.click();
    });
    document.getElementById('sendFileBtn').addEventListener('click', () => {
        fileInput.accept = '*';
        fileInput.click();
    });

    const sendEmoticonBtn = document.getElementById('sendEmoticonBtn');
    sendEmoticonBtn.addEventListener('click', () => {
        showEmoticonPicker();
    });

    fileInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        const file = files[0];
        if (!confirm(`是否发送文件 "${file.name}"？`)) return;
        await uploadAndSend(file);
        fileInput.value = '';
    });

    const chatArea = document.querySelector('.chat-area');
    chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    chatArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        const files = e.dataTransfer.files;
        if (!files.length || !currentConv) return;
        const file = files[0];
        if (!confirm(`是否发送文件 "${file.name}" 到当前会话？`)) return;
        await uploadAndSend(file);
    });

    async function uploadAndSend(file) {
        if (!currentConv) return;
        const formData = new FormData();
        formData.append('file', file);

        // 立即显示发送中消息（半透明）
        const tempId = 'temp_' + Date.now();
        const tempMsg = {
            id: tempId,
            from_uid: myUid,
            from_name: myName,
            from_avatar: myAvatar || '',
            body: '',
            msg_type: 'resource',
            media_url: URL.createObjectURL(file),
            thumb_url: null,
            created_at: Math.floor(Date.now() / 1000),
        };
        if (currentConv.type === 'group') {
            tempMsg.group_id = currentConv.id;
        }
        appendMessage(tempMsg, currentConv.key, seenMsgIds[currentConv.key]);
        scrollToBottom(true);
        const tempEl = messagesContainer.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl) {
            tempEl.style.opacity = '0.5';
        }

        try {
            // 第一步：上传文件到 /v1/media
            const upRes = await apiFetch('/v1/media', { method: 'POST', body: formData });
            const upData = await upRes.json();
            if (upData.error || !upData.url) {
                if (tempEl) tempEl.remove();
                seenMsgIds[currentConv.key]?.delete(tempId);
                alert('上传失败: ' + (upData.error || '未知错误'));
                return;
            }
            // 第二步：发送消息（根据文件类型判断 msg_type）
            const fileName = (file.name || '').toLowerCase();
            let msgType = 'resource';
            if (/\.(jpg|jpeg|png|gif|webp)$/.test(fileName)) msgType = 'image';
            else if (/\.(mp4|3gp)$/.test(fileName)) msgType = 'video';
            else if (/\.(mp3|m4a|aac|amr|wav|wave)$/.test(fileName)) msgType = 'voice';

            const sendPayload = currentConv.type === 'group'
                ? { group_id: currentConv.id, body: '', msg_type: msgType, media_url: upData.url, thumb_url: upData.thumb_url || '' }
                : { to_uid: currentConv.id, body: '', msg_type: msgType, media_url: upData.url, thumb_url: upData.thumb_url || '' };
            const sendEndpoint = currentConv.type === 'group' ? '/v1/groups/message/send' : '/v1/direct/send';
            const res = await apiFetch(sendEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sendPayload)
            });
            const data = await res.json();
            if (data.error || !data.id) {
                if (tempEl) tempEl.remove();
                seenMsgIds[currentConv.key]?.delete(tempId);
                alert('发送失败: ' + (data.error || '未知错误'));
                return;
            }
            const msg = data;
            // 替换临时消息
            if (tempEl) {
                const newEl = createMessageElement(msg, currentConv.key, seenMsgIds[currentConv.key]);
                if (newEl) {
                    const msgTs = msg.created_at || 0;
                    if (lastRenderedMsg &&
                        lastRenderedMsg.convKey === currentConv.key &&
                        lastRenderedMsg.from_uid === (msg.from_uid || '') &&
                        msgTs && lastRenderedTs && (msgTs - lastRenderedTs) <= 300) {
                        newEl.classList.add('consecutive');
                        if (lastRenderedMsg.element) {
                            lastRenderedMsg.element.classList.add('consecutive-first');
                        }
                    } else {
                        if (lastRenderedMsg && lastRenderedMsg.element) {
                            lastRenderedMsg.element.classList.remove('consecutive-first');
                        }
                    }
                    tempEl.replaceWith(newEl);
                    lastRenderedMsg = { convKey: currentConv.key, from_uid: msg.from_uid || '', element: newEl };
                    lastRenderedTs = msgTs;
                }
            }
            scrollToBottom(true);
        } catch (error) {
            console.error(error);
            if (tempEl) tempEl.remove();
            seenMsgIds[currentConv.key]?.delete(tempId);
            alert('网络错误，发送失败');
        }
    }

    document.addEventListener('contextmenu', (e) => {
        hideContextMenu();
        
        // 排除输入框区域（textarea 和其父级）
        if (e.target.closest('.input-area') || e.target.closest('textarea') || e.target.closest('#messageInput')) {
            return;  // 让系统默认菜单弹出
        }

        // 联系人列表右键菜单
        const contactItem = e.target.closest('.contact-item');
        if (contactItem) {
            e.preventDefault();
            const convType = contactItem.dataset.type;
            const convId = contactItem.dataset.id;
            const convName = contactItem.dataset.name;
            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            let menuHtml = '';
            if (convType === 'group') {
                menuHtml = '<div class="context-menu-item" data-action="group-manage">群聊管理</div>' +
                    '<div class="context-menu-divider"></div>' +
                    '<div class="context-menu-item" data-action="mark-read">全部已读</div>';
            } else {
                menuHtml = '<div class="context-menu-item" data-action="mark-read">全部已读</div>';
            }
            menu.innerHTML = menuHtml;
            document.body.appendChild(menu);
            requestAnimationFrame(() => menu.classList.add('show'));
            contextMenu = menu;
            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'group-manage') {
                    openGroupManagePanel(convId, convName);
                } else if (action === 'mark-read') {
                    markAllRead(convType, convId);
                }
                hideContextMenu();
            });
            const closeHandler = (ev) => {
                if (!menu.contains(ev.target)) {
                    hideContextMenu();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
            return;
        }
        
        // 优先显示消息菜单
        const msgDiv = e.target.closest('.message');
        if (msgDiv) {
            const sel = window.getSelection();
            const selectedText = sel && sel.toString() ? sel.toString() : '';
            e.preventDefault();
            const msgId = msgDiv.dataset.msgId;
            if (!msgId) return;

            const fromUid = msgDiv.dataset.fromUid;
            const isOwn = fromUid && fromUid.toUpperCase() === myUid.toUpperCase();
            const rawBody = JSON.parse(msgDiv.dataset.rawBody || '{}');
            const msgTime = rawBody.created_at || 0;
            const canRecall = isOwn && msgTime && (Date.now() / 1000 - msgTime) <= 120;

            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';

            let menuHtml = `
                <div class="context-menu-item" data-action="copy">复制</div>
                <div class="context-menu-item" data-action="copy-raw">复制原始消息</div>
                <div class="context-menu-divider"></div>
                <div class="context-menu-item" data-action="quote">引用</div>
            `;
            if (canRecall) {
                menuHtml += `<div class="context-menu-item" data-action="recall" style="color:#ff6b6b;">撤回</div>`;
            }
            menu.innerHTML = menuHtml;
            document.body.appendChild(menu);
            requestAnimationFrame(() => menu.classList.add('show'));
            contextMenu = menu;
            contextMsgId = msgId;
    
            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'copy') {
                    const textToCopy = selectedText || msgDiv.querySelector('.message-bubble')?.innerText || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(textToCopy).catch(() => fallbackCopyText(textToCopy));
                    } else {
                        fallbackCopyText(textToCopy);
                    }
                } else if (action === 'copy-raw') {
                    const rawBody = msgDiv.dataset.rawBody || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(rawBody).catch(() => fallbackCopyText(rawBody));
                    } else {
                        fallbackCopyText(rawBody);
                    }
                } else if (action === 'quote') {
                    const fromUid = msgDiv.dataset.fromUid;
                    const fromName = msgDiv.dataset.fromName;
                    const msgType = msgDiv.dataset.msgType;
                    const plainText = msgDiv.dataset.plainText || '';
    
                    pendingQuote = {
                        id: msgId,
                        from_uid: fromUid,
                        from_name: fromName,
                        type: msgType,
                        text: plainText.substring(0, 200)
                    };
    
                    quotePreviewText.textContent = `引用: ${fromName} - ${plainText.substring(0, 50)}`;
                    quotePreview.style.display = 'flex';
                    messageInput.focus();
                } else if (action === 'recall') {
                    if (!currentConv) return;
                    const recallUrl = currentConv.type === 'group'
                        ? `/v1/groups/messages/${encodeURIComponent(msgId)}`
                        : `/v1/direct/messages/${encodeURIComponent(msgId)}`;
                    apiFetch(recallUrl, { method: 'DELETE' })
                        .then(r => r.json())
                        .then(d => {
                            if (d.error) {
                                alert(d.error || '撤回失败');
                            } else {
                                const recallText = '[消息已撤回]';
                                const timeSep = document.createElement('div');
                                timeSep.className = 'time-separator';
                                timeSep.textContent = recallText;
                                msgDiv.replaceWith(timeSep);
                                // 清理去重记录
                                seenMsgIds[currentConv.key]?.delete(msgId);
                            }
                        }).catch(() => alert('网络错误'));
                }
                hideContextMenu();
            });
    
            const closeHandler = (ev) => {
                if (!menu.contains(ev.target)) {
                    hideContextMenu();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
            return;
        }
    
        // 其次判断是否在右侧聊天区域（.chat-area 或 .messages）的空白处
        // 注意：此时已经排除了 input-area
        const chatArea = e.target.closest('.chat-area');
        if (chatArea) {
            e.preventDefault();
            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.innerHTML = `
                <div class="context-menu-item" data-action="refresh">刷新</div>
            `;
            document.body.appendChild(menu);
            requestAnimationFrame(() => menu.classList.add('show'));
            contextMenu = menu;
    
            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'refresh') {
                    if (currentConv) {
                        const convKey = currentConv.key;
                        switchConversation(currentConv.type, currentConv.id, currentConv.name);
                        setTimeout(() => {
                            const items = contactList.querySelectorAll('.contact-item');
                            items.forEach(item => {
                                if (item.dataset.convKey === convKey) {
                                    item.classList.add('active');
                                }
                            });
                        }, 0);
                    }
                }
                hideContextMenu();
            });
    
            const closeHandler = (ev) => {
                if (!menu.contains(ev.target)) {
                    hideContextMenu();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
            return;
        }
    });



    function fallbackCopy(element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        try { document.execCommand('copy'); } catch (e) { alert('复制失败'); }
        selection.removeAllRanges();
    }

    function fallbackCopyText(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); } catch (e) { alert('复制失败'); }
        document.body.removeChild(textarea);
    }

    cancelQuoteBtn.addEventListener('click', () => {
        pendingQuote = null;
        quotePreview.style.display = 'none';
        messageInput.focus();
    });




    // ===== 侧边栏固定/自动隐藏（绝对定位平移） =====
    let sidebarPinned = true;
    const sidebar = document.querySelector('.sidebar');

    const isMobile = () => window.innerWidth <= 768;

    function expandChat() {
        if (isMobile()) {
            chatArea.style.marginLeft = '0px';
        } else {
            chatArea.style.marginLeft = sidebar.classList.contains('collapsed') ? '0px' : '280px';
        }
    }

    if (isMobile()) {
        sidebar.classList.remove('collapsed');
        sidebarPinned = false;
        expandChat();
    }

    pinSidebarBtn.addEventListener('click', () => {
        if (isMobile()) return;
        sidebarPinned = !sidebarPinned;
        if (sidebarPinned) {
            sidebar.classList.remove('collapsed');
            pinSidebarBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
            pinSidebarBtn.title = '取消固定';
            expandChat();
            setTimeout(expandChat, 350);
        } else {
            sidebar.classList.add('collapsed');
            pinSidebarBtn.innerHTML = '<i class="fa-solid fa-angles-right"></i>';
            pinSidebarBtn.title = '固定侧边栏';
            expandChat();
        }
    });

    // 鼠标移到屏幕最左侧边缘时，如果未固定且隐藏，则展开
    document.addEventListener('mousemove', (e) => {
        if (isMobile()) return;
        if (!sidebarPinned && sidebar.classList.contains('collapsed') && e.clientX < 5) {
            sidebar.classList.remove('collapsed');
            expandChat();
            setTimeout(expandChat, 350);
        }
    });

    // 鼠标离开侧边栏时，如果未固定，自动隐藏（带短延迟）
    let leaveTimer;
    sidebar.addEventListener('mouseleave', () => {
        if (isMobile()) return;
        if (!sidebarPinned && !sidebar.classList.contains('collapsed')) {
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(() => {
                sidebar.classList.add('collapsed');
                expandChat();
            }, 200);
        }
    });
    sidebar.addEventListener('mouseenter', () => {
        clearTimeout(leaveTimer);
    });

    window.addEventListener('resize', () => {
        if (!isMobile()) {
            // 从手机切换到PC，恢复侧边栏
            sidebar.classList.remove('collapsed');
            sidebarPinned = true;
            pinSidebarBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
            pinSidebarBtn.title = '取消固定';
        }
        expandChat();
    });

    mobileMenuBtn.addEventListener('click', () => {
        if (!isMobile()) return;
        sidebar.classList.remove('collapsed');
    });

    headerMenuBtn.addEventListener('click', () => {
        if (currentConv && currentConv.type === 'group') {
            openGroupManagePanel(currentConv.id, currentConv.name);
        }
    });

    // 直链图片/音频发送
    let urlInputMode = 'image'; // 'image' | 'voice'
    const sendUrlImageBtn = document.getElementById('sendUrlImageBtn');
    const sendUrlVoiceBtn = document.getElementById('sendUrlVoiceBtn');
    const urlInputOverlay = document.getElementById('urlInputOverlay');
    const urlImageInput = document.getElementById('urlImageInput');
    const urlInputCancel = document.getElementById('urlInputCancel');
    const urlInputSend = document.getElementById('urlInputSend');
    const urlInputTitle = document.querySelector('.url-input-title');

    function showUrlInput(mode) {
        urlInputMode = mode;
        if (mode === 'image') {
            urlInputTitle.textContent = '输入图片链接';
            urlImageInput.placeholder = 'https://...';
        } else {
            urlInputTitle.textContent = '输入音频链接';
            urlImageInput.placeholder = 'https://...';
        }
        urlInputOverlay.style.display = 'flex';
        urlImageInput.value = '';
        urlImageInput.focus();
    }

    sendUrlImageBtn.addEventListener('click', () => showUrlInput('image'));
    sendUrlVoiceBtn.addEventListener('click', () => showUrlInput('voice'));

    urlInputCancel.addEventListener('click', () => {
        urlInputOverlay.style.display = 'none';
    });
    urlInputOverlay.addEventListener('click', (e) => {
        if (e.target === urlInputOverlay) urlInputOverlay.style.display = 'none';
    });

    urlInputSend.addEventListener('click', () => {
        const url = urlImageInput.value.trim();
        if (!url) { alert('请输入链接'); return; }
        const msgType = urlInputMode === 'image' ? 'image' : 'voice';
        sendMessage('', msgType, url);
        urlInputOverlay.style.display = 'none';
    });
    
    // 红包领取处理（事件委托）
    document.addEventListener('click', async (e) => {
        const card = e.target.closest('.red-packet-card');
        if (!card) return;
        const claimed = card.dataset.claimed === 'true';
        if (claimed) return; // 已领取不再请求

        const packetId = card.dataset.packetId;
        if (!packetId) return;

        // 立即禁用，避免重复点击
        card.dataset.claimed = 'true';
        card.style.pointerEvents = 'none';
        card.querySelector('.rp-status').textContent = '领取中...';

        try {
            const res = await apiFetch('/v1/redpackets/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packet_id: packetId })
            });
            const data = await res.json();
            if (data.error) {
                card.querySelector('.rp-status').textContent = data.error;
                card.style.opacity = '0.7';
            } else {
                // 领取成功，显示金额（如果接口返回 amount 字段）
                const amount = data.amount !== undefined ? data.amount : '';
                card.querySelector('.rp-status').textContent = amount ? `已领取 ${amount}` : '已领取';
                card.style.opacity = '0.7';
                card.style.cursor = 'default';
            }
        } catch (err) {
            card.querySelector('.rp-status').textContent = '网络错误';
            card.style.opacity = '0.7';
        }
    });

    async function showEmoticonPicker() {
        const existing = document.getElementById('emoticonPicker');
        if (existing) existing.remove();

        try {
            const res = await apiFetch('/v1/emoji/plaza?limit=50&offset=0');
            const data = await res.json();
            const items = data.items || [];
            if (items.length === 0) {
                alert('没有可用的表情包');
                return;
            }

            const picker = document.createElement('div');
            picker.id = 'emoticonPicker';
            picker.className = 'emoticon-picker';
            picker.innerHTML = `<div class="emoticon-grid"></div>`;
            const grid = picker.querySelector('.emoticon-grid');

            items.forEach(item => {
                const imgUrl = item.media_url || item.cover_url || '';
                if (!imgUrl) return;
                const itemEl = document.createElement('div');
                itemEl.className = 'emoticon-item';
                itemEl.innerHTML = `<img src="${resolveMediaUrl(imgUrl)}" loading="lazy">`;
                itemEl.addEventListener('click', async () => {
                    picker.remove();
                    // 直接以图片消息发送表情（已有 URL，无需再上传）
                    sendMessage('', 'image', imgUrl);
                });
                grid.appendChild(itemEl);
            });

            document.body.appendChild(picker);

            const closeHandler = (e) => {
                if (!picker.contains(e.target)) {
                    picker.remove();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
        } catch (e) {
            console.error(e);
            alert('加载表情失败');
        }
    }

    let plazaOffset = 0;
    let plazaLoading = false;
    let plazaHasMore = true;

    async function showEmojiPlaza() {
        const existing = document.getElementById('emojiPlazaPanel');
        if (existing) { existing.remove(); return; }

        plazaOffset = 0;
        plazaHasMore = true;

        const panel = document.createElement('div');
        panel.id = 'emojiPlazaPanel';
        panel.className = 'emoticon-picker';
        panel.style.maxHeight = '400px';
        panel.innerHTML = `
            <div class="emoticon-grid" id="plazaGrid"></div>
            <div style="text-align:center; margin-top:8px;" id="plazaLoadMore">
                <button class="btn" id="plazaLoadMoreBtn">加载更多</button>
            </div>
        `;
        document.body.appendChild(panel);

        const grid = document.getElementById('plazaGrid');
        const loadMoreBtn = document.getElementById('plazaLoadMoreBtn');

        const loadPage = async () => {
            if (plazaLoading || !plazaHasMore) return;
            plazaLoading = true;
            loadMoreBtn.textContent = '加载中…';
            try {
                const res = await apiFetch(`/v1/emoji/plaza?limit=20&offset=${plazaOffset}`);
                const data = await res.json();
                const items = data.items || [];
                if (items.length === 0) {
                    plazaHasMore = false;
                    loadMoreBtn.textContent = '没有更多了';
                    loadMoreBtn.disabled = true;
                    return;
                }
                items.forEach(item => {
                    const imgUrl = item.media_url || item.cover_url || '';
                    if (!imgUrl) return;
                    const div = document.createElement('div');
                    div.className = 'emoticon-item';
                    div.innerHTML = `<img src="${resolveMediaUrl(imgUrl)}" loading="lazy">`;
                    div.addEventListener('click', () => {
                        sendMessage('', 'image', imgUrl);
                        panel.remove();
                    });
                    grid.appendChild(div);
                });
                plazaOffset += items.length;
                if (data.has_more === false) plazaHasMore = false;
            } catch(e) { console.error(e); }
            finally {
                plazaLoading = false;
                if (plazaHasMore) loadMoreBtn.textContent = '加载更多';
            }
        };

        loadPage();
        loadMoreBtn.addEventListener('click', loadPage);

        const closeHandler = (e) => {
            if (!panel.contains(e.target) && e.target !== emojiPlazaBtn) {
                panel.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    expandChat();
    loadContacts().then(() => {
        // 读取上次打开的会话
        const lastConv = localStorage.getItem('lastConversation');
        if (lastConv) {
            const [type, id] = lastConv.split(':');
            if (type && id) {
                let found = null;
                if (type === 'direct') {
                    found = contacts.friends.find(f => f.uid === id);
                } else if (type === 'group') {
                    found = contacts.groups.find(g => g.id === id);
                }
                if (found) {
                    const name = found.name || (type === 'direct' ? found.uid : found.id);
                    switchConversation(type, id, name);
                    const items = contactList.querySelectorAll('.contact-item');
                    items.forEach(item => {
                        const convKey2 = type + ':' + id;
                        if (item.dataset.convKey === convKey2) {
                            item.classList.add('active');
                        }
                    });
                }
            }
        }
    });
    // 连接 WebSocket
    initWebSocket();

    // ===== @ 提及点击跳转 =====
    messagesContainer.addEventListener('click', (e) => {
        const mention = e.target.closest('.mention-highlight');
        if (!mention) return;
        e.preventDefault();
        e.stopPropagation();

        const targetUid = mention.dataset.uid;
        if (!targetUid) return;

        const currentMsg = mention.closest('.message');
        if (!currentMsg) return;

        let prev = currentMsg.previousElementSibling;
        while (prev) {
            if (prev.classList.contains('message') && prev.dataset.fromUid === targetUid) {
                prev.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }
            prev = prev.previousElementSibling;
        }
        openSpacePanel(targetUid);
    });

    // 修复：输入法收起后重新滚动到底部，避免最新消息被遮挡
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            setTimeout(() => scrollToBottom(true), 100);
        });
    }

});