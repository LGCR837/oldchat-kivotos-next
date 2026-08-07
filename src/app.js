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
    console.log('[Tauri] fetch 已替换为 plugin:http invoke，直连后端：' + 'http://oc.mcl0.dpdns.org');

    // 标记 Tauri 环境（CSS 据此启用圆角阴影、三大金刚键、拖动区域）
    document.body.classList.add('tauri-env');

    // 三大金刚键：最小化 / 最大化切换 / 关闭
    const winMinBtn = document.getElementById('winMinBtn');
    const winMaxBtn = document.getElementById('winMaxBtn');
    const winCloseBtn = document.getElementById('winCloseBtn');

    // 根据最大化状态切换图标与圆角
    function syncMaximizeState() {
        invoke('is_window_maximized').then(function(isMax) {
            if (!winMaxBtn) return;
            const icon = winMaxBtn.querySelector('i');
            if (!icon) return;
            if (isMax) {
                icon.className = 'fa-regular fa-clone';
                winMaxBtn.title = '还原';
                document.body.classList.add('is-maximized');
            } else {
                icon.className = 'fa-regular fa-square';
                winMaxBtn.title = '最大化';
                document.body.classList.remove('is-maximized');
            }
        }).catch(function(err) { console.error('[Tauri] is_window_maximized:', err); });
    }

    if (winMinBtn) winMinBtn.addEventListener('click', function() {
        invoke('minimize_window').catch(function(err) { console.error('[Tauri] minimize_window:', err); });
    });
    if (winMaxBtn) winMaxBtn.addEventListener('click', function() {
        invoke('toggle_maximize_window').then(syncMaximizeState).catch(function(err) { console.error('[Tauri] toggle_maximize_window:', err); });
    });
    if (winCloseBtn) winCloseBtn.addEventListener('click', function() {
        invoke('close_window').catch(function(err) { console.error('[Tauri] close_window:', err); });
    });

    // 其他面板的窗口控制（联系人、设置）
    function bindWinControls(prefix) {
        var minBtn = document.getElementById(prefix + 'WinMinBtn');
        var maxBtn = document.getElementById(prefix + 'WinMaxBtn');
        var closeBtn = document.getElementById(prefix + 'WinCloseBtn');
        if (minBtn) minBtn.addEventListener('click', function() { invoke('minimize_window').catch(function(){}); });
        if (maxBtn) maxBtn.addEventListener('click', function() { invoke('toggle_maximize_window').then(syncMaximizeState).catch(function(){}); });
        if (closeBtn) closeBtn.addEventListener('click', function() { invoke('close_window').catch(function(){}); });
    }
    bindWinControls('contacts');
    bindWinControls('settings');
    bindWinControls('musicWin');

    // 监听窗口尺寸变化（拖动边缘最大化 / 系统快捷键还原等场景）
    window.addEventListener('resize', syncMaximizeState);
    // 初始化一次
    syncMaximizeState();

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

// 默认值（硬编码回退）
const DEFAULT_BACKEND_ORIGIN = 'http://oc.mcl0.dpdns.org';
const DEFAULT_MEDIA_ORIGIN   = 'http://60.205.94.101:8080';

// 候选服务器列表（参考服务器发布的 client.md 约定）
const BACKEND_URL_CANDIDATES = [
    'http://oc.mcl0.dpdns.org',
    'https://oc.mcl0.dpdns.org',
    'http://60.205.94.101:8080',
    'http://60.205.94.101:8081',
    'http://127.0.0.1:8080'
];
const MEDIA_URL_CANDIDATES = [
    'http://60.205.94.101:8080',
    'http://60.205.94.101:8081',
    'http://oc.mcl0.dpdns.org',
    'https://oc.mcl0.dpdns.org',
    'http://127.0.0.1:8080'
];

// 从 localStorage 读取用户自定义，没有则回退到默认
function _getSavedBackendOrigin() {
    try { return localStorage.getItem('oc_custom_base_url') || DEFAULT_BACKEND_ORIGIN; }
    catch (e) { return DEFAULT_BACKEND_ORIGIN; }
}
function _getSavedMediaOrigin() {
    try { return localStorage.getItem('oc_custom_media_url') || DEFAULT_MEDIA_ORIGIN; }
    catch (e) { return DEFAULT_MEDIA_ORIGIN; }
}

let BACKEND_ORIGIN = _getSavedBackendOrigin();
let MEDIA_ORIGIN   = _getSavedMediaOrigin();
const BACKEND_HOST = (function() {
    try { return new URL(BACKEND_ORIGIN).host; } catch (e) { return 'oc.mcl0.dpdns.org'; }
})();

// 浏览器模式下：代理模式(默认 on) → 同源反代；off → 直连后端完整地址
const _proxyOn = IS_TAURI ? false : (localStorage.getItem('oc_proxy_mode') !== 'off');

let API_BASE  = IS_TAURI ? (BACKEND_ORIGIN + '/v1') : (_proxyOn ? '/v1' : (BACKEND_ORIGIN + '/v1'));
let WS_HOST   = IS_TAURI ? BACKEND_HOST : (_proxyOn ? window.location.host : BACKEND_HOST);
let MEDIA_BASE = IS_TAURI ? MEDIA_ORIGIN : (_proxyOn ? MEDIA_ORIGIN : '');

// 供设置页更新配置后重新计算
function refreshEndpoints() {
    BACKEND_ORIGIN = _getSavedBackendOrigin();
    MEDIA_ORIGIN   = _getSavedMediaOrigin();
    const host = (function() { try { return new URL(BACKEND_ORIGIN).host; } catch (e) { return BACKEND_HOST; } })();
    WS_HOST   = IS_TAURI ? host : (_proxyOn ? window.location.host : host);
    API_BASE  = IS_TAURI ? (BACKEND_ORIGIN + '/v1') : (_proxyOn ? '/v1' : (BACKEND_ORIGIN + '/v1'));
    MEDIA_BASE = IS_TAURI ? MEDIA_ORIGIN : (_proxyOn ? MEDIA_ORIGIN : '');
}

function resolveMediaUrl(url) {
    if (!url) return url;
    if (/^(https?:|data:|blob:)/.test(url)) return url;
    if (MEDIA_BASE && url.startsWith('/')) return MEDIA_BASE + url;
    return url;
}
// 缓存 resolveMediaUrl 结果，减少重复字符串操作
const mediaUrlCache = new Map();
function cachedResolveMediaUrl(url) {
    if (!url) return url;
    if (mediaUrlCache.has(url)) return mediaUrlCache.get(url);
    const result = resolveMediaUrl(url);
    mediaUrlCache.set(url, result);
    return result;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==================== 媒体文件永久缓存层 ====================
// 两层缓存：
//   1. 内存 Map（快速命中，当前会话）
//   2. IndexedDB（永久存储，跨会话 / 跨关闭）
(function () {
    const DB_NAME = 'oldchat_media_cache_v1';
    const STORE_NAME = 'media';
    const memCache = new Map();  // url -> Blob
    let dbPromise = null;
    let mediasOriginSet = [];   // 延迟初始化，DOMContentLoaded 之后设置

    function openDb() {
        return new Promise((resolve, reject) => {
            try {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                    }
                };
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = (e) => { console.error('[MediaCache] openDb error', e.target.error); reject(e.target.error); };
            } catch (e) { console.error('[MediaCache] openDb ex', e); reject(e); }
        });
    }
    function getDb() {
        if (!dbPromise) dbPromise = openDb();
        return dbPromise;
    }
    function idbGet(url) {
        return getDb().then(db => new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const st = tx.objectStore(STORE_NAME).get(url);
                st.onsuccess = () => resolve(st.result);
                st.onerror = (e) => reject(e.target.error);
            } catch (e) { reject(e); }
        }));
    }
    function idbPut(url, blob, mime) {
        return getDb().then(db => new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put({ url, blob, mime, ts: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) { reject(e); }
        }));
    }

    // 判断 URL 是否属于需要缓存的远程媒体
    function shouldCache(url) {
        if (!url) return false;
        if (/^(data:|blob:|about:|chrome-extension:|tauri:|ipc\.localhost)/i.test(url)) return false;
        if (/^(https?:)?\/\//i.test(url)) return true;
        return false;
    }

    async function fetchAndStore(url) {
        // 使用原生 fetch（绕过 Tauri 的 http 插件层，让它走 webview 网络栈，避免跨域）
        // 但对于非跨域场景也可以走 Tauri。这里统一使用 window.__nativeFetch（已保留） 或 XHR
        let blob;
        let mime = '';
        try {
            const resp = await (typeof window.__nativeFetch === 'function'
                ? window.__nativeFetch(url, { credentials: 'omit', mode: 'cors', cache: 'force-cache' })
                : fetch(url, { credentials: 'omit', mode: 'cors', cache: 'force-cache' }));
            if (!resp || !resp.ok) throw new Error('fetch failed');
            mime = resp.headers ? (resp.headers.get('content-type') || '') : '';
            blob = await resp.blob();
        } catch (e) {
            // fetch 失败兜底：XHR
            blob = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.responseType = 'blob';
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        mime = xhr.getResponseHeader('content-type') || '';
                        resolve(xhr.response);
                    } else reject(new Error('xhr status ' + xhr.status));
                };
                xhr.onerror = () => reject(xhr.statusText || 'network');
                xhr.send();
            });
        }
        if (blob && blob.size) {
            memCache.set(url, blob);
            idbPut(url, blob, mime).catch(() => {});
        }
        return blob;
    }

    async function getBlob(url) {
        if (memCache.has(url)) return memCache.get(url);
        try {
            const rec = await idbGet(url);
            if (rec && rec.blob) { memCache.set(url, rec.blob); return rec.blob; }
        } catch (e) {}
        return await fetchAndStore(url);
    }

    function getCachedUrlOrPass(url, callback) {
        // 返回: { blobUrl } 通过 callback 异步返回，同步返回 false 表示需要等待
        if (!shouldCache(url)) { callback(url); return; }
        getBlob(url).then(blob => {
            try { callback(URL.createObjectURL(blob)); }
            catch (e) { callback(url); }
        }).catch(() => callback(url));
    }

    // 处理单个元素的 src / poster / style.backgroundImage
    function processElement(el) {
        if (!(el instanceof Element)) return;
        const tag = (el.tagName || '').toLowerCase();
        const MEDIA_ATTRS = ['src', 'poster'];
        MEDIA_ATTRS.forEach(attr => {
            const raw = el.getAttribute('data-mc-orig-' + attr);
            const val = raw || el.getAttribute(attr);
            if (!val) return;
            if (!raw && shouldCache(val)) {
                el.setAttribute('data-mc-orig-' + attr, val);
                // 标记正在处理中，防止重复触发
                if (el.getAttribute('data-mc-' + attr + '-loading') === '1') return;
                el.setAttribute('data-mc-' + attr + '-loading', '1');
                getCachedUrlOrPass(val, (newUrl) => {
                    if (newUrl !== val) {
                        try { el.setAttribute(attr, newUrl); } catch (e) {}
                    }
                    el.removeAttribute('data-mc-' + attr + '-loading');
                });
            }
        });
        // style backgroundImage / background
        if (el instanceof HTMLElement && el.style && (el.style.backgroundImage || el.getAttribute('style'))) {
            const bgCss = el.style.cssText || '';
            if (/url\(\s*["']?(https?:)?\/\//i.test(bgCss) || /url\(\s*["']?\/[a-z]/i.test(bgCss)) {
                const orig = el.getAttribute('data-mc-orig-style');
                if (!orig) {
                    el.setAttribute('data-mc-orig-style', bgCss);
                    // 提取所有 url(...) 替换
                    const urlRegex = /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
                    const matches = [];
                    let m;
                    urlRegex.lastIndex = 0;
                    while ((m = urlRegex.exec(bgCss)) !== null) matches.push(m);
                    if (matches.length === 0) return;
                    const newCssPromise = Promise.all(matches.map((m) => {
                        const rawUrl = m[1];
                        const resolved = cachedResolveMediaUrl(rawUrl);  // 用全局的 resolve
                        return new Promise(res => getCachedUrlOrPass(resolved, (nu) => res({ old: m[0], new: `url("${nu}")` })));
                    }));
                    newCssPromise.then(reps => {
                        let css = bgCss;
                        reps.forEach(r => { css = css.replace(r.old, r.new); });
                        el.style.cssText = css;
                    });
                }
            }
        }
    }

    // MutationObserver 拦截 DOM 变化
    let observer = null;
    function startObserver() {
        if (observer) return;
        try {
            observer = new MutationObserver(muts => {
                for (const mut of muts) {
                    if (mut.type === 'childList') {
                        mut.addedNodes.forEach(n => {
                            if (n.nodeType === 1) {
                                processElement(n);
                                if (n.querySelectorAll) {
                                    n.querySelectorAll('img,audio,video,source,track,link[rel~="icon"],link[rel~="apple-touch-icon"]').forEach(processElement);
                                }
                            }
                        });
                    } else if (mut.type === 'attributes') {
                        processElement(mut.target);
                    }
                }
            });
            if (document.body) {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['src', 'poster', 'style', 'href']
                });
                // 初次扫描
                document.body.querySelectorAll('img,audio,video,source,track').forEach(processElement);
            }
        } catch (e) { console.error('[MediaCache] observer init fail', e); }
    }

    // 暴露到全局
    window.__MediaCache = {
        init: () => {
            mediasOriginSet = [
                (typeof MEDIA_ORIGIN !== 'undefined' ? MEDIA_ORIGIN : ''),
                (typeof BACKEND_ORIGIN !== 'undefined' ? BACKEND_ORIGIN : '')
            ].filter(Boolean);
            startObserver();
        },
        getBlob, put: (u, b) => idbPut(u, b, b && b.type), clear: () => {
            memCache.clear();
            return getDb().then(db => new Promise(r => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).clear();
                tx.oncomplete = () => r();
            }));
        }, getSize: () => {
            return getDb().then(db => new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const st = tx.objectStore(STORE_NAME).openCursor();
                    let count = 0;
                    let totalBytes = 0;
                    st.onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor) {
                            count++;
                            const rec = cursor.value;
                            if (rec && rec.blob && rec.blob.size) totalBytes += rec.blob.size;
                            cursor.continue();
                        } else {
                            resolve({ count, totalBytes });
                        }
                    };
                    st.onerror = (e) => reject(e.target.error);
                } catch (e) { reject(e); }
            }));
        }
    };

    // 保留原生 fetch 引用（如 login.html 中已定义则复用）
    if (typeof window.__nativeFetch !== 'function' && typeof window.fetch === 'function') {
        window.__nativeFetch = window.fetch.bind(window);
    }
})();

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


// 复制图片到剪贴板
function copyImageToClipboard(src) {
    if (!src) return;
    // 尝试用 canvas 方式获取图片 blob
    const img = new Image();
    // blob URL 不需要 crossOrigin（且设置 crossOrigin 可能导致加载失败）
    if (!src.startsWith('blob:')) {
        img.crossOrigin = 'anonymous';
    }
    img.onload = function() {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(function(blob) {
            if (blob && navigator.clipboard && navigator.clipboard.write) {
                navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]).catch(function() {
                    // 如果 clipboard write 失败，回退到复制 URL
                    fallbackCopyText(src);
                });
            } else {
                fallbackCopyText(src);
            }
        });
    };
    img.onerror = function() {
        // 如果加载失败，回退到复制 URL
        navigator.clipboard.writeText(src).catch(() => fallbackCopyText(src));
    };
    img.src = src;
}

// 下载图片到本地（触发浏览器下载）
function downloadImage(src) {
    if (!src) return;

    // Tauri 环境：使用原生 Rust 命令下载
    if (IS_TAURI) {
        if (src.startsWith('blob:')) {
            // blob URL：用 canvas 读出像素数据，传给 Rust 保存
            var img = new Image();
            img.onload = function() {
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                canvas.toBlob(function(blob) {
                    if (!blob) { console.error('canvas toBlob 失败'); return; }
                    var reader = new FileReader();
                    reader.onload = function() {
                        var arr = new Uint8Array(reader.result);
                        window.__TAURI_INTERNALS__.invoke('save_image_data', { data: Array.from(arr) })
                            .catch(function(e) { console.error('save_image_data 失败:', e); });
                    };
                    reader.onerror = function() { console.error('FileReader 失败'); };
                    reader.readAsArrayBuffer(blob);
                });
            };
            img.onerror = function() { console.error('图片加载失败'); };
            img.src = src;
        } else {
            // HTTP URL：直接传给 Rust 用 reqwest 下载
            window.__TAURI_INTERNALS__.invoke('save_image', { url: src })
                .catch(function(err) {
                    console.error('Tauri save_image 失败:', err);
                });
        }
        return;
    }

    // 非 Tauri 环境：Web 下载方式
    webDownloadImage(src);
}

// Web 环境下的下载方式（非 Tauri 回退 + Tauri 回退）
function webDownloadImage(src) {
    if (!src) return;
    var filename = 'image_' + Date.now() + '.jpg';

    function saveBlob(blob) {
        // 尝试 msSaveBlob（WebView2 专用）
        if (window.navigator.msSaveBlob) {
            window.navigator.msSaveBlob(blob, filename);
            return;
        }
        // 使用 ObjectURL 创建下载链接
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    }

    function fetchAndSave(imgUrl) {
        fetch(imgUrl)
            .then(function(res) { return res.blob(); })
            .then(function(blob) { saveBlob(blob); })
            .catch(function() { fallbackDownload(imgUrl); });
    }

    function fallbackDownload(imgUrl) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
            var canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(function(blob) {
                if (blob) {
                    saveBlob(blob);
                } else {
                    window.open(imgUrl, '_blank');
                }
            });
        };
        img.onerror = function() {
            window.open(imgUrl, '_blank');
        };
        img.src = imgUrl;
    }

    if (src.startsWith('blob:')) {
        var img = new Image();
        img.onload = function() {
            var canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(function(blob) {
                if (blob) saveBlob(blob);
            });
        };
        img.onerror = function() {};
        img.src = src;
    } else {
        fetchAndSave(src);
    }
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

				// Single finger tap: at 1x = close, zoomed = reset to 1x
			if (wasSingleFinger && didNotMove) {
				hasDragged = false;
				if (img._scale <= 1) {
					closeViewer();
				} else {
					img._scale = 1;
					img._translateX = 0;
					img._translateY = 0;
					img.style.transition = 'transform 0.3s ease';
					applyTransform();
				}
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
	// 支持传入 img 元素（直接使用已加载的 src）或 URL 字符串
	const imgSrc = (typeof src === 'object' && src && src.src) ? src.src : src;
	img.src = imgSrc;
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
    options.headers = options.headers || {};
    options.headers['User-Agent'] = 'OldChatForKivotosNext';
    if (token) {
        options.headers['Authorization'] = 'Bearer ' + token;
    }
    let res = await fetch(fullUrl, options);
    if (res.status === 401) {
        const refreshToken = localStorage.getItem('oc_refresh_token');
        if (refreshToken) {
            const refreshRes = await fetch(API_BASE + '/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'OldChatForKivotosNext' },
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

// ===== 自定义弹窗（替代原生 alert/confirm） =====
const modalOverlay = document.getElementById('customModalOverlay');
const modalTitle = document.getElementById('customModalTitle');
const modalBody = document.getElementById('customModalBody');
const modalConfirmBtn = document.getElementById('customModalConfirmBtn');
const modalCancelBtn = document.getElementById('customModalCancelBtn');

let _modalResolve = null;
let _modalCloseHandler = null;

function _closeModal() {
    modalOverlay.style.display = 'none';
    modalOverlay.removeEventListener('click', _modalCloseHandler);
    document.removeEventListener('keydown', _modalKeyHandler);
    _modalCloseHandler = null;
}

// 先取出 resolve 再关闭，避免 _closeModal 内部清空导致 resolve 丢失
function _resolveModal(value) {
    const r = _modalResolve;
    _modalResolve = null;
    _closeModal();
    if (r) r(value);
}

function _modalKeyHandler(e) {
    const visibleBtns = [];
    if (modalConfirmBtn.style.display !== 'none') visibleBtns.push(modalConfirmBtn);
    if (modalCancelBtn.style.display !== 'none') visibleBtns.push(modalCancelBtn);
    if (visibleBtns.length === 0) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        if (modalCancelBtn.style.display !== 'none') {
            modalCancelBtn.click();
        } else {
            modalConfirmBtn.click();
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        modalConfirmBtn.click();
    } else if (e.key === 'Tab') {
        e.preventDefault();
        const focused = document.activeElement;
        const idx = visibleBtns.indexOf(focused);
        if (idx === -1 || idx === visibleBtns.length - 1) {
            visibleBtns[0].focus();
        } else {
            visibleBtns[idx + 1].focus();
        }
    }
}

function showAlert(text, title = '提示') {
    return new Promise(resolve => {
        modalTitle.textContent = title;
        modalBody.textContent = text;
        modalConfirmBtn.style.display = '';
        modalConfirmBtn.textContent = '确定';
        modalCancelBtn.style.display = 'none';
        modalOverlay.style.display = '';

        _modalResolve = resolve;
        _modalCloseHandler = () => {
            _resolveModal();
        };
        modalOverlay.addEventListener('click', _modalCloseHandler);

        modalConfirmBtn.onclick = () => {
            _resolveModal();
        };
        modalCancelBtn.onclick = null;

        document.addEventListener('keydown', _modalKeyHandler);
        modalConfirmBtn.focus();
    });
}

function showConfirm(text, title = '提示') {
    return new Promise(resolve => {
        modalTitle.textContent = title;
        modalBody.textContent = text;
        modalConfirmBtn.style.display = '';
        modalConfirmBtn.textContent = '确定';
        modalCancelBtn.style.display = '';
        modalOverlay.style.display = '';

        _modalResolve = resolve;
        _modalCloseHandler = (e) => {
            if (e && e.target !== modalOverlay) return;
            _resolveModal(false);
        };
        modalOverlay.addEventListener('click', _modalCloseHandler);

        modalConfirmBtn.onclick = () => {
            _resolveModal(true);
        };
        modalCancelBtn.onclick = () => {
            _resolveModal(false);
        };

        document.addEventListener('keydown', _modalKeyHandler);
        modalConfirmBtn.focus();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // 用户信息缓存（4小时过期）——必须放在最前面，避免 temporal dead zone
    const userProfileCache = new Map();
    const invalidUidCache = new Set();
    const CACHE_TTL = 4 * 60 * 60 * 1000;
    const pendingProfileFetches = new Map();

    // 从 localStorage 读取用户信息（登录页写入）
    const storedUser = JSON.parse(localStorage.getItem('oc_user') || '{}');
    let myUid = storedUser.ncuid || storedUser.uid || '';  // API用
    let myDisplayUid = storedUser.uid || storedUser.ncuid || '';  // 给人看
    let myName = storedUser.display_name || storedUser.username || '';
    let myAvatar = storedUser.avatar_url || '';

    // 登录后立即调用 /v1/me 刷新用户信息（修复登录后只显示 NCUID 不显示昵称头像）
    try {
        const meRes = await apiFetch('/v1/me');
        if (meRes && meRes.ok) {
            const meData = await meRes.json();
            if (meData && !meData.error) {
                // 更新 localStorage
                localStorage.setItem('oc_user', JSON.stringify(meData));
                // 更新内存中的用户信息
                myUid = meData.ncuid || meData.uid || myUid;
                myDisplayUid = meData.uid || meData.ncuid || myDisplayUid;
                myName = meData.display_name || meData.username || myName;
                myAvatar = meData.avatar_url || myAvatar;
                // 缓存到 userProfileCache，供 lookupTitle 查询称号
                meData._ts = Date.now();
                userProfileCache.set(myUid.toUpperCase(), meData);
            }
        }
    } catch (e) {
        console.error('Failed to refresh user info after login', e);
    }

    // ===== NCUID 兼容层 =====
    // ncuid 给机器看（API调用），uid 给人看（界面显示）
    // 注意：ncuid 不一定以 nc_ 开头（官方文档示例值为 USR-ABCD1234）
    // 实际发现：?uid= 参数不接受 ncuid 值（会返回 invalid uid），
    // 因此对 ?uid= 传旧 uid，?ncuid= 传 ncuid。
    // 但 with_uid/to_uid 参数同时接受 uid 和 ncuid。
    // 不再需要前缀判断，但需根据参数名选择正确的标识符。
    function getUid(obj) {
        if (!obj) return '';
        return obj.ncuid || obj.uid || '';
    }
    function getDisplayUid(obj) {
        if (!obj) return '';
        return obj.uid || obj.ncuid || '';
    }
    function getFromUid(obj) {
        if (!obj) return '';
        return obj.from_ncuid || obj.from_uid || obj.sender_ncuid || obj.sender_uid || '';
    }
    function getFromName(obj) {
        if (!obj) return '';
        return obj.from_name || obj.sender_name || obj.display_name || '';
    }
    function getFromAvatar(obj) {
        if (!obj) return '';
        return obj.from_avatar || obj.sender_avatar || obj.avatar_url || '';
    }
    function uidEq(a, b) {
        if (!a || !b) return false;
        return a.toUpperCase() === b.toUpperCase();
    }
    // 判断某个发送者ID是否是自己（兼容 uid/ncuid 两种格式）
    // myUid 优先 ncuid，myDisplayUid 是旧 uid；消息历史可能返回任一格式
    function isSelfUid(fromUid) {
        if (!fromUid) return false;
        return uidEq(fromUid, myUid) || uidEq(fromUid, myDisplayUid);
    }
    // 构建私聊目标参数：服务端 to_uid 同时接受 uid/ncuid
    function toUidParam(id) {
        return { to_uid: id };
    }
    // 构建私聊历史/已读参数：服务端 with_uid 同时接受 uid/ncuid
    function withUidParam(id) {
        return { with_uid: id };
    }
    // 构建用户资料查询参数：?uid= 不接受 ncuid，只传旧 uid
    // 如需要 ncuid 查询，用 ?ncuid= 参数
    function profileQuery(id) {
        return '/v1/users/profile?uid=' + encodeURIComponent(id);
    }

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
    // 底部锚点：保证清空/追加后始终位于容器末尾，避免 scrollHeight 在图片加载前估算不准
    const scrollAnchor = document.createElement('div');
    scrollAnchor.id = 'scroll-anchor';
    scrollAnchor.style.cssText = 'width:100%;height:0;flex-shrink:0;';
    messagesContainer.appendChild(scrollAnchor);
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const moreBtn = document.getElementById('moreBtn');
    const moreMenu = document.getElementById('moreMenu');
    const fileInput = document.getElementById('fileInput');
    const logoutBtn = document.getElementById('logoutBtn');
    const pinSidebarBtn = document.getElementById('pinSidebarBtn');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const themeToggleBtn = document.getElementById('themeToggleBtn');

    // 聊天界面自绘滚动条
    let chatScrollbar = null;
    if (window['dumogu-scrollbar'] && window['dumogu-scrollbar'].DumoguScrollbar) {
        chatScrollbar = new window['dumogu-scrollbar'].DumoguScrollbar({ keepShow: true });
        chatScrollbar.bind(messagesContainer);
        const chatPanel = document.querySelector('.main-panel[data-panel="chat"]');
        if (chatPanel) chatScrollbar.mount(chatPanel);
    }

    const quotePreview = document.getElementById('quotePreview');
    const quotePreviewText = quotePreview.querySelector('.quote-preview-text');
    const cancelQuoteBtn = document.getElementById('cancelQuoteBtn');
    const syncIndicator = document.getElementById('syncIndicator');
    const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

    // 回到底部按钮：显示/隐藏逻辑（淡入淡出）
    function updateScrollToBottomBtn() {
        if (!scrollToBottomBtn) return;
        const distanceFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
        const threshold = 100;
        if (distanceFromBottom > threshold) {
            scrollToBottomBtn.classList.add('visible');
        } else {
            scrollToBottomBtn.classList.remove('visible');
        }
    }
    if (scrollToBottomBtn) {
        scrollToBottomBtn.addEventListener('click', () => {
            scrollToBottom(true, true);
        });
    }

    const emojiPlazaBtn = document.getElementById('emojiPlazaBtn');

    // 侧边栏顶部选项卡切换逻辑
    const sidebarTabs = document.getElementById('sidebarTabs');
    const sidebarPanelsTrack = document.getElementById('sidebarPanelsTrack');
    const tabBtns = sidebarTabs ? sidebarTabs.querySelectorAll('.tab-btn') : [];
    const sidebarPanels = sidebarPanelsTrack ? sidebarPanelsTrack.querySelectorAll('.sidebar-panel') : [];
    const mainPanels = document.querySelectorAll('.chat-area > .main-panel');

    function switchTab(tabName) {
        const targetBtn = sidebarTabs.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if (!targetBtn || targetBtn.classList.contains('active')) return;
        const index = Array.from(tabBtns).indexOf(targetBtn);
        if (index < 0) return;

        // 切换选项卡按钮高亮
        tabBtns.forEach(b => b.classList.remove('active'));
        targetBtn.classList.add('active');

        // 侧边栏面板左右滑动
        if (sidebarPanelsTrack) {
            sidebarPanelsTrack.style.transform = `translateX(-${index * 25}%)`;
        }
        sidebarPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));

        // 右侧主面板淡入淡出
        mainPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));

        // 切换到音乐面板时加载列表（仅首次）
        if (tabName === 'music' && !musicLoaded) {
            loadMusicList();
        }

        // 切换到设置面板时渲染设置页面
        if (tabName === 'settings') {
            renderSettingsPage(currentSettingsTab || 'profile');
        }
    }

    if (sidebarTabs) {
        sidebarTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;
            switchTab(btn.dataset.tab);
        });
    }

    // ===== 音乐列表（侧边栏，复用 contact-item 样式） =====
    const musicList = document.getElementById('musicList');
    const musicTabs = document.getElementById('musicTabs');
    const musicWorkspace = document.getElementById('musicWorkspace');
    let musicTab = 'plaza';          // plaza / ranking / mine
    let musicLoaded = false;         // 是否已加载过
    let musicCurrentPage = 1;
    const musicPageSize = 20;
    let musicData = [];              // 当前已加载的音乐列表（用于上一首/下一首）

    function musicEndpoint() {
        if (musicTab === 'mine') return '/v1/music/plaza/mine';
        if (musicTab === 'ranking') return '/v1/music/plaza/ranking';
        return '/v1/music/plaza';
    }

    function createMusicItem(m) {
        const div = document.createElement('div');
        div.className = 'contact-item music-item';
        div.dataset.musicId = m.id || '';
        div.dataset.musicUrl = m.media_url || m.song_url || '';
        div.dataset.musicName = m.name || '未知歌曲';
        div.dataset.musicArtist = m.owner_name || m.artist || '未知';
        div.dataset.musicCover = m.cover_url ? cachedResolveMediaUrl(m.cover_url) : '';
        const cover = m.cover_url ? cachedResolveMediaUrl(m.cover_url) : 'assets/default-avatar.png';
        const artist = m.owner_name || m.artist || '未知';
        div.innerHTML = `<img class="contact-avatar" src="${cover}" onerror="this.src='assets/default-avatar.png'"><div class="contact-info"><div class="name">${escapeHtml(m.name || '未知歌曲')}</div><div class="uid">${escapeHtml(artist)}</div></div>`;
        div.addEventListener('click', () => playMusic(m));
        return div;
    }

    async function loadMusicList() {
        if (!musicList) return;
        musicList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--secondary-text);">加载中...</div>';
        try {
            const offset = (musicCurrentPage - 1) * musicPageSize;
            const res = await apiFetch(musicEndpoint() + `?limit=${musicPageSize}&offset=${offset}`);
            const data = await res.json();
            const items = (data.items || data.list || data.data || (Array.isArray(data) ? data : [])).filter(Boolean);
            musicData = items;
            musicList.innerHTML = '';
            if (items.length === 0 && musicCurrentPage === 1) {
                musicList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--secondary-text);">暂无音乐</div>';
            } else {
                items.forEach(m => musicList.appendChild(createMusicItem(m)));
                // 加载更多按钮
                if (items.length >= musicPageSize) {
                    const loadMoreDiv = document.createElement('div');
                    loadMoreDiv.style.cssText = 'padding:10px;text-align:center;';
                    const loadMoreBtn = document.createElement('button');
                    loadMoreBtn.className = 'btn';
                    loadMoreBtn.textContent = '加载更多';
                    loadMoreBtn.style.cssText = 'padding:6px 16px;border-radius:16px;border:1px solid var(--border);background:var(--chat-bg);color:var(--text);font-size:12px;cursor:pointer;font-family:inherit;';
                    loadMoreBtn.addEventListener('click', async () => {
                        loadMoreBtn.textContent = '加载中...';
                        loadMoreBtn.disabled = true;
                        musicCurrentPage++;
                        try {
                            const offset2 = (musicCurrentPage - 1) * musicPageSize;
                            const res2 = await apiFetch(musicEndpoint() + `?limit=${musicPageSize}&offset=${offset2}`);
                            const data2 = await res2.json();
                            const items2 = (data2.items || data2.list || data2.data || (Array.isArray(data2) ? data2 : [])).filter(Boolean);
                            musicData = musicData.concat(items2);
                            items2.forEach(m => musicList.insertBefore(createMusicItem(m), loadMoreDiv));
                            if (items2.length < musicPageSize) {
                                loadMoreDiv.remove();
                            } else {
                                loadMoreBtn.textContent = '加载更多';
                                loadMoreBtn.disabled = false;
                            }
                        } catch (e) {
                            loadMoreBtn.textContent = '加载失败，点击重试';
                            loadMoreBtn.disabled = false;
                        }
                    });
                    loadMoreDiv.appendChild(loadMoreBtn);
                    musicList.appendChild(loadMoreDiv);
                }
            }
            musicLoaded = true;
        } catch (e) {
            console.error('[music] load failed:', e);
            musicList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--secondary-text);">加载失败</div>';
        }
    }

    if (musicTabs) {
        musicTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.music-tab-btn');
            if (!btn || btn.classList.contains('active')) return;
            musicTabs.querySelectorAll('.music-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            musicTab = btn.dataset.musicTab;
            musicCurrentPage = 1;
            loadMusicList();
        });
    }

    // ===== 音乐播放器（参考 CRMusic） =====
    let musicAudio = null;             // 全局 audio 元素，跨选项卡不销毁
    let musicLrcObj = null;            // 解析后的歌词数组
    let musicLrcIndex = -1;            // 当前高亮歌词索引
    let musicIsPlaying = false;
    let musicCurrentItem = null;       // 当前播放的音乐对象（调试用：window.musicCurrentItem）
    let musicManualScroll = false;
    let musicManualScrollTimer = null;
    let musicScrollAnim = null;
    let musicLoop = true;              // 默认单曲循环

    // 暴露调试变量到全局
    window.musicCurrentItem = null;
    window.musicAudio = null;

    function ensureMusicAudio() {
        if (musicAudio) return;
        musicAudio = new Audio();
        musicAudio.loop = true;  // 默认单曲循环
        musicAudio.addEventListener('timeupdate', onMusicTimeUpdate);
        musicAudio.addEventListener('loadedmetadata', updateMusicProgressUI);
        musicAudio.addEventListener('play', () => { musicIsPlaying = true; updateMusicPlayBtn(); });
        musicAudio.addEventListener('pause', () => { musicIsPlaying = false; updateMusicPlayBtn(); });
        musicAudio.addEventListener('ended', () => {
            // loop=true 时浏览器自动重播，不会触发 ended；这里仅作为非循环时的兜底
            if (!musicLoop) playNextMusic();
        });
    }

    function toggleMusicLoop() {
        musicLoop = !musicLoop;
        if (musicAudio) musicAudio.loop = musicLoop;
        const btn = musicWorkspace?.querySelector('#musicLoopBtn');
        if (btn) {
            btn.classList.toggle('active', musicLoop);
            btn.innerHTML = musicLoop
                ? '<i class="fa-solid fa-repeat"></i><span class="loop-badge">1</span>'
                : '<i class="fa-solid fa-repeat"></i>';
        }
    }

    // 统一歌词解析入口（自动检测 LRC 或 TTML 格式）
    function parseLyrics(text) {
        if (!text) return [];
        // 检测是否为 TTML 格式
        if (/<p\s+begin=/i.test(text)) {
            return parseTTML(text);
        }
        // 默认按 LRC 解析
        return parseLRC(text);
    }

    // TTML 时间解析：支持 HH:MM:SS.mmm / MM:SS.mmm / SS.mmm / SSs
    function parseTTMLTime(timeStr) {
        if (!timeStr) return -1;
        timeStr = timeStr.trim();
        if (timeStr.endsWith('s')) timeStr = timeStr.slice(0, -1);
        const parts = timeStr.split(/[:.]/);
        let time = 0;
        if (parts.length === 4) {
            time = +parts[0] * 3600 + +parts[1] * 60 + +parts[2] + +parts[3] / 1000;
        } else if (parts.length === 3) {
            time = +parts[0] * 60 + +parts[1] + +parts[2] / 1000;
        } else if (parts.length === 2) {
            time = +parts[0] + +parts[1] / 1000;
        } else if (parts.length === 1) {
            time = +parts[0];
        } else {
            return -1;
        }
        return isNaN(time) ? -1 : time;
    }

    // TTML 解析（使用 DOMParser，支持翻译）
    function parseTTML(ttml) {
        const result = [];
        const parser = new DOMParser();
        const doc = parser.parseFromString(ttml, 'text/xml');
        const ps = doc.getElementsByTagName('p');
        for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            const beginStr = p.getAttribute('begin');
            if (!beginStr) continue;
            const time = parseTTMLTime(beginStr);
            if (time < 0) continue;

            // 提取翻译 span
            let translation = '';
            const spans = p.getElementsByTagName('span');
            for (let j = 0; j < spans.length; j++) {
                if (spans[j].getAttribute('ttm:role') === 'x-translation') {
                    translation = spans[j].textContent;
                    break;
                }
            }

            // 主文本：克隆节点，移除所有 span，取 textContent
            const clone = p.cloneNode(true);
            const cloneSpans = clone.getElementsByTagName('span');
            while (cloneSpans.length > 0) {
                cloneSpans[0].parentNode.removeChild(cloneSpans[0]);
            }
            const text = clone.textContent.trim();
            if (text) result.push({ time, text, translation: translation || '' });
        }
        return result.sort((a, b) => a.time - b.time);
    }

    // LRC 解析：[mm:ss.xx]text 或 [mm:ss.xx]text
    function parseLRC(lrc) {
        const result = [];
        (lrc || '').split("\n").forEach(line => {
            const arr = line.split("]");
            if (!arr[1]) return;
            const timeParts = arr[0].substring(1).split(":");
            let time = 0;
            if (timeParts.length === 3) {
                time = +timeParts[0] * 3600 + +timeParts[1] * 60 + +timeParts[2];
            } else if (timeParts.length === 2) {
                time = +timeParts[0] * 60 + +timeParts[1];
            } else {
                return;
            }
            const text = arr.slice(1).join(']').trim();
            if (text) result.push({ time, text });
        });
        return result.sort((a, b) => a.time - b.time);
    }

    function findLrcIndex() {
        if (!musicLrcObj || musicLrcObj.length === 0) return -1;
        const t = (musicAudio.currentTime || 0) + 0.1;
        if (t < musicLrcObj[0].time) return 0;
        if (t > musicLrcObj[musicLrcObj.length - 1].time) return musicLrcObj.length - 1;
        for (let i = 0; i < musicLrcObj.length; i++) {
            if (t < musicLrcObj[i].time) return Math.max(0, i - 1);
        }
        return 0;
    }

    function smoothScrollLyricsTo(targetTop, duration) {
        const container = musicWorkspace?.querySelector('.music-lyrics-container');
        if (!container) return;
        if (musicScrollAnim) cancelAnimationFrame(musicScrollAnim);
        const startTop = container.scrollTop;
        const dist = targetTop - startTop;
        if (Math.abs(dist) < 1) { container.scrollTop = targetTop; return; }
        let startTime = null;
        const step = (ts) => {
            if (!startTime) startTime = ts;
            const progress = Math.min((ts - startTime) / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 3);
            container.scrollTop = startTop + dist * ease;
            if (progress < 1) musicScrollAnim = requestAnimationFrame(step);
            else musicScrollAnim = null;
        };
        musicScrollAnim = requestAnimationFrame(step);
    }

    function onMusicTimeUpdate() {
        updateMusicProgressUI();
        if (!musicLrcObj || musicLrcObj.length === 0) return;
        const idx = findLrcIndex();
        if (idx === musicLrcIndex || idx < 0) return;
        musicLrcIndex = idx;
        const container = musicWorkspace?.querySelector('.music-lyrics-container');
        if (!container) return;
        const lis = container.querySelectorAll('li');
        lis.forEach(li => li.classList.remove('active'));
        if (lis[idx]) {
            lis[idx].classList.add('active');
            if (!musicManualScroll) {
                const half = container.clientHeight / 2;
                const target = lis[idx].offsetTop + lis[idx].offsetHeight / 2 - half;
                smoothScrollLyricsTo(target, 500);
            }
        }
    }

    function updateMusicProgressUI() {
        if (!musicWorkspace) return;
        const fill = musicWorkspace.querySelector('.music-progress-fill');
        const curEl = musicWorkspace.querySelector('.music-progress-time.cur');
        const durEl = musicWorkspace.querySelector('.music-progress-time.dur');
        const cur = musicAudio.currentTime || 0;
        const dur = musicAudio.duration || 0;
        const pct = dur > 0 ? (cur / dur) * 100 : 0;
        if (fill) fill.style.width = pct + '%';
        if (curEl) curEl.textContent = formatMusicTime(cur);
        if (durEl) durEl.textContent = formatMusicTime(dur);
    }

    function formatMusicTime(s) {
        if (!s || !isFinite(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function updateMusicPlayBtn() {
        if (!musicWorkspace) return;
        const btn = musicWorkspace.querySelector('.music-btn.play-btn i');
        if (btn) {
            btn.className = musicIsPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
        }
        // 同步左侧列表项高亮
        document.querySelectorAll('.music-item').forEach(el => {
            el.classList.toggle('active', musicCurrentItem && el.dataset.musicId == musicCurrentItem.id);
        });
    }

    function renderMusicWorkspace(m) {
        if (!musicWorkspace) return;
        const cover = m.cover_url ? cachedResolveMediaUrl(m.cover_url) : '';
        const bgStyle = cover ? `style="background-image:url('${escapeAttr(cover)}')"` : '';
        // 保留右上角三大金刚键
        const winControls = musicWorkspace.querySelector('.music-win-controls');
        musicWorkspace.innerHTML = '';
        const content = document.createElement('div');
        content.innerHTML = `
            <div class="music-bg-layer" ${bgStyle}></div>
            <div class="music-bg-overlay"></div>
            <div class="music-lyrics-container"><ul></ul></div>
            <div class="music-controls">
                <img class="music-cover" src="${cover || 'assets/default-avatar.png'}" onerror="this.src='assets/default-avatar.png'">
                <div class="music-meta">
                    <span class="music-title">${escapeHtml(m.name || '未知歌曲')}</span>
                    <span class="music-artist">${escapeHtml(m.owner_name || m.artist || '未知')}</span>
                </div>
                <div class="music-progress-wrap">
                    <span class="music-progress-time cur">0:00</span>
                    <div class="music-progress-bar"><div class="music-progress-fill"></div></div>
                    <span class="music-progress-time dur">0:00</span>
                </div>
                <button class="music-btn loop-btn ${musicLoop ? 'active' : ''}" id="musicLoopBtn" title="单曲循环">${musicLoop ? '<i class="fa-solid fa-repeat"></i><span class="loop-badge">1</span>' : '<i class="fa-solid fa-repeat"></i>'}</button>
                <button class="music-btn" id="musicPrevBtn" title="上一首"><i class="fa-solid fa-backward-step"></i></button>
                <button class="music-btn play-btn" id="musicPlayBtn" title="播放/暂停"><i class="fa-solid fa-play"></i></button>
                <button class="music-btn" id="musicNextBtn" title="下一首"><i class="fa-solid fa-forward-step"></i></button>
            </div>
        `;
        while (content.firstChild) musicWorkspace.appendChild(content.firstChild);
        if (winControls) musicWorkspace.appendChild(winControls);
        // 重置歌词容器显示状态（加载前先隐藏，加载成功后再显示）
        const lrcContainer = musicWorkspace.querySelector('.music-lyrics-container');
        if (lrcContainer) lrcContainer.style.display = 'none';
        // 绑定控制按钮
        const playBtn = musicWorkspace.querySelector('#musicPlayBtn');
        const prevBtn = musicWorkspace.querySelector('#musicPrevBtn');
        const nextBtn = musicWorkspace.querySelector('#musicNextBtn');
        const loopBtn = musicWorkspace.querySelector('#musicLoopBtn');
        if (playBtn) playBtn.onclick = toggleMusicPlay;
        if (prevBtn) prevBtn.onclick = playPrevMusic;
        if (nextBtn) nextBtn.onclick = playNextMusic;
        if (loopBtn) loopBtn.onclick = function(e) { e.stopPropagation(); toggleMusicLoop(); };
        // 进度条点击
        const progressBar = musicWorkspace.querySelector('.music-progress-bar');
        if (progressBar) progressBar.onclick = function(e) {
            if (!musicAudio || !musicAudio.duration) return;
            const rect = progressBar.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            musicAudio.currentTime = Math.max(0, Math.min(musicAudio.duration, musicAudio.duration * pct));
        };
        // 歌词容器手动滚动恢复 + 点击跳转
        if (lrcContainer) {
            lrcContainer.addEventListener('wheel', enterMusicManualMode, { passive: true });
            lrcContainer.addEventListener('touchmove', enterMusicManualMode, { passive: true });
            lrcContainer.addEventListener('click', function(e) {
                const li = e.target.closest('li');
                if (!li || li.classList.contains('empty-lrc') || li.dataset.time === undefined) return;
                musicAudio.currentTime = parseFloat(li.dataset.time);
                musicManualScroll = false;
                clearTimeout(musicManualScrollTimer);
            });
        }
    }

    function enterMusicManualMode() {
        musicManualScroll = true;
        clearTimeout(musicManualScrollTimer);
        musicManualScrollTimer = setTimeout(() => {
            musicManualScroll = false;
            onMusicTimeUpdate();
        }, 3000);
    }

    async function loadMusicLyrics(lyricsUrl) {
        if (!musicWorkspace) return;
        const lrcContainer = musicWorkspace.querySelector('.music-lyrics-container');
        const ul = lrcContainer?.querySelector('ul');
        if (!ul || !lrcContainer) return;
        
        // 如果没有歌词URL，直接显示暂无歌词
        if (!lyricsUrl) {
            lrcContainer.style.display = 'none';
            musicLrcObj = null;
            return;
        }
        
        try {
            // 使用 resolveMediaUrl 转换URL（与音频、封面相同的逻辑）
            const fullUrl = cachedResolveMediaUrl(lyricsUrl);
            const res = await fetch(fullUrl);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const lrcText = await res.text();
            
            musicLrcObj = parseLyrics(lrcText);
            musicLrcIndex = -1;
            ul.innerHTML = '';
            if (musicLrcObj.length === 0) {
                // 无歌词时隐藏整个歌词区域
                lrcContainer.style.display = 'none';
            } else {
                lrcContainer.style.display = '';
                const frag = document.createDocumentFragment();
                musicLrcObj.forEach(item => {
                    const li = document.createElement('li');
                    const main = document.createElement('div');
                    main.className = 'lrc-main';
                    main.textContent = item.text;
                    li.appendChild(main);
                    if (item.translation) {
                        const tr = document.createElement('div');
                        tr.className = 'lrc-translation';
                        tr.textContent = item.translation;
                        li.appendChild(tr);
                    }
                    li.dataset.time = item.time;
                    frag.appendChild(li);
                });
                ul.appendChild(frag);
            }
        } catch (e) {
            console.error('[music] lyrics load failed:', e);
            lrcContainer.style.display = 'none';
            musicLrcObj = null;
        }
    }

    async function playMusic(m) {
        ensureMusicAudio();
        const url = m.media_url || m.song_url || '';
        if (!url) { console.warn('[music] no url'); return; }
        const fullUrl = cachedResolveMediaUrl(url);
        musicCurrentItem = m;
        window.musicCurrentItem = m;
        console.log('[music] 播放音乐对象:', m);
        // 紧凑模式下折叠侧边栏，显示音乐工作区
        if (isMobile()) {
            sidebar.classList.add('collapsed');
            expandChat();
        }
        renderMusicWorkspace(m);
        musicAudio.src = fullUrl;
        musicAudio.loop = musicLoop;  // src 变更后重新确保循环状态
        musicLrcObj = null;
        musicLrcIndex = -1;
        try {
            await musicAudio.play();
        } catch (e) {
            console.warn('[music] play failed:', e);
        }
        // 加载歌词（使用数据中自带的 lyrics_url）
        if (m.lyrics_url) {
            loadMusicLyrics(m.lyrics_url);
        } else {
            const lrcContainer = musicWorkspace?.querySelector('.music-lyrics-container');
            if (lrcContainer) lrcContainer.style.display = 'none';
        }
        updateMusicPlayBtn();
    }

    function toggleMusicPlay() {
        if (!musicAudio) return;
        if (musicAudio.paused) {
            musicAudio.play().catch(e => console.warn('[music] play:', e));
        } else {
            musicAudio.pause();
        }
    }

    function playPrevMusic() {
        if (!musicData.length || !musicCurrentItem) return;
        const idx = musicData.findIndex(m => m.id == musicCurrentItem.id);
        if (idx < 0) return;
        const prev = musicData[(idx - 1 + musicData.length) % musicData.length];
        playMusic(prev);
    }

    function playNextMusic() {
        if (!musicData.length || !musicCurrentItem) return;
        const idx = musicData.findIndex(m => m.id == musicCurrentItem.id);
        if (idx < 0) return;
        const next = musicData[(idx + 1) % musicData.length];
        playMusic(next);
    }

    function escapeAttr(s) {
        return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 音乐界面右上角三大金刚键
    const tauriInvoke = (typeof window !== 'undefined') && (window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke);
    if (IS_TAURI && tauriInvoke) {
        const musicWinMinBtn = document.getElementById('musicWinMinBtn');
        const musicWinMaxBtn = document.getElementById('musicWinMaxBtn');
        const musicWinCloseBtn = document.getElementById('musicWinCloseBtn');
        if (musicWinMinBtn) musicWinMinBtn.addEventListener('click', () => {
            tauriInvoke('minimize_window').catch(e => console.error('[music] minimize:', e));
        });
        if (musicWinMaxBtn) musicWinMaxBtn.addEventListener('click', () => {
            tauriInvoke('toggle_maximize_window').catch(e => console.error('[music] maximize:', e));
        });
        if (musicWinCloseBtn) musicWinCloseBtn.addEventListener('click', () => {
            tauriInvoke('close_window').catch(e => console.error('[music] close:', e));
        });
    }

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

    function openSpacePanel(uid, ncuid) {
        // uid 基本校验：非空且非纯空白
        if (!uid && !ncuid) {
            showAlert('无效的用户 ID');
            return;
        }
        // 如果只有一个参数传入，同时作为 uid 和 ncuid 尝试
        if (!ncuid) ncuid = uid;
        if (!uid) uid = ncuid;
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
        const btnBase = 'padding:6px 20px;border-radius:20px;border:none;font-size:14px;font-family:inherit;cursor:pointer;font-weight:500;';
        overlay.innerHTML = `
            <div style="background:var(--header-bg);color:#fff;padding:13px 12px;display:flex;align-items:center;font-size:15px;font-weight:500;flex-shrink:0;position:relative;">
                <button id="sp-close-btn" style="position:absolute;left:12px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;"><i class="fa-solid fa-chevron-left"></i></button>
                <span style="width:100%;text-align:center;">用户空间</span>
            </div>
            <div id="sp-scroll" style="flex:1;overflow-y:auto;position:relative;"></div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.style.opacity = '1');

        const scroll = overlay.querySelector('#sp-scroll');
        scroll.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载中...</div>';

        // 初始化自绘滚动条
        let spScrollbar = null;
        if (window['dumogu-scrollbar'] && window['dumogu-scrollbar'].DumoguScrollbar) {
            spScrollbar = new window['dumogu-scrollbar'].DumoguScrollbar({ keepShow: true });
            spScrollbar.bind(scroll);
            spScrollbar.mount(overlay);
        }

        function closePanel() {
            if (spScrollbar) { spScrollbar.destroy(); spScrollbar = null; }
            overlay.remove();
        }
        overlay.querySelector('#sp-close-btn').addEventListener('click', closePanel);

        // 尝试获取用户资料：优先用 ncuid，失败则用 uid
        async function fetchProfileForPanel() {
            let data = null;
            // 优先 ncuid 路径
            if (ncuid) {
                try {
                    const res = await apiFetch('/v1/users/profile?ncuid=' + encodeURIComponent(ncuid));
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                } catch (e) {}
            }
            // 失败则 uid 路径（注意：ncuid 不能传入 ?uid=，会 400，所以 uid 路径只在 ncuid 路径无结果时尝试）
            if (!data && uid) {
                try {
                    const res = await apiFetch(profileQuery(uid));
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                } catch (e) {}
            }
            return data;
        }

        // 尝试获取动态：优先用 ncuid，失败则用 uid
        async function fetchMomentsForPanel() {
            let data = null;
            // 优先 ncuid 路径（注意：ncuid 不能传入 ?uid=，会 400）
            if (ncuid) {
                try {
                    const res = await apiFetch('/v1/moments/user?ncuid=' + encodeURIComponent(ncuid) + '&limit=50');
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                } catch (e) {}
            }
            // 失败则 uid 路径
            if (!data && uid) {
                try {
                    const res = await apiFetch('/v1/moments/user?uid=' + encodeURIComponent(uid) + '&limit=50');
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                } catch (e) {}
            }
            return data;
        }

        async function load() {
            try {
                const [u, momentsData] = await Promise.all([
                    fetchProfileForPanel(),
                    fetchMomentsForPanel()
                ]);
                if (!u || u.error) {
                    const errMsg = (u && u.error) || '无效的用户 ID';
                    if (u && /invalid|not found|不存在/i.test(u.error)) {
                        if (ncuid) invalidUidCache.add(ncuid.toUpperCase());
                        if (uid) invalidUidCache.add(uid.toUpperCase());
                    }
                    scroll.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">' + errMsg + '</div>';
                    return;
                }
                // 刷新缓存
                u._ts = Date.now();
                const cacheKey = (ncuid || uid || '').toUpperCase();
                userProfileCache.set(cacheKey, u);
                invalidUidCache.delete(cacheKey);
                // 计算关系：self / friend / pending_received / none
                let relation = 'none';
                const profileUid = u.uid || u.user_id || uid || '';
                if (profileUid.toUpperCase() === myUid.toUpperCase() || (ncuid && ncuid.toUpperCase() === myUid.toUpperCase())) {
                    relation = 'self';
                } else if (contacts.friends.some(f => f.uid.toUpperCase() === (profileUid || '').toUpperCase() || (f.displayUid && f.displayUid.toUpperCase() === (profileUid || '').toUpperCase()))) {
                    relation = 'friend';
                } else {
                    // 检查是否有来自该用户的好友申请
                    try {
                        const reqRes = await apiFetch('/v1/friends/requests');
                        const reqData = await reqRes.json();
                        const incoming = (reqData.requests || []).some(r => uidEq(getUid(r) || r.from_ncuid || r.from_uid, profileUid || ncuid || uid));
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
                    momentsHtml = '<div style="padding:0 16px 20px;column-count:3;column-gap:10px;max-width:960px;margin:0 auto;">';
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
                                const resolvedUrl = cachedResolveMediaUrl(mu);
                                // loading="lazy" 延迟加载 + min-height 预留空位避免闪烁
                                media += '<img src="' + resolvedUrl + '" loading="lazy" style="width:100%;min-height:120px;max-height:200px;object-fit:cover;border-radius:8px;cursor:pointer;background:var(--hover);" onclick="openImageViewer(\'' + resolvedUrl.replace(/'/g, "\\'") + '\')" onerror="this.style.display=\'none\'">';
                            });
                            media += '</div>';
                        }
                        momentsHtml += '<div style="background:var(--panel-bg);border-radius:12px;padding:14px 16px;border:1px solid var(--border-color);break-inside:avoid;margin-bottom:10px;" data-moment-id="' + (m.id || '') + '">' +
                            '<div style="font-size:11px;color:var(--secondary-text);margin-bottom:6px;">' + fmtTs(m.created_at) + '</div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.6;white-space:pre-wrap;word-break:break-word;">' + (m.body || '') + '</div>' +
                            media +
                            '<div style="display:flex;gap:16px;margin-top:10px;align-items:center;">' +
                                '<button class="sp-like-btn" data-moment-id="' + (m.id || '') + '" data-liked="' + (m.liked ? '1' : '0') + '" style="background:none;border:none;color:' + (m.liked ? '#ff4757' : 'var(--secondary-text)') + ';font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;"><i class="' + (m.liked ? 'fa-solid' : 'fa-regular') + ' fa-heart"></i> ' + (m.likes || 0) + '</button>' +
                                '<button class="sp-comment-btn" data-moment-id="' + (m.id || '') + '" style="background:none;border:none;color:var(--secondary-text);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-comment"></i> ' + (m.comment_count || m.comments_count || m.total_comments || m.reply_count || (m.comments && m.comments.length) || 0) + '</button>' +
                            '</div>' +
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
                const coverUrl = u.cover_url ? cachedResolveMediaUrl(u.cover_url) : '';
                const coverHtml = coverUrl
                    ? '<div style="position:relative;height:320px;background-image:url(\'' + coverUrl.replace(/'/g, "\\'") + '\');background-size:cover;background-position:center;"></div>'
                    : '';
                scroll.innerHTML =
                    coverHtml +
                    '<div style="background:var(--chat-bg);padding:28px 20px 20px;display:flex;flex-direction:column;align-items:center;' + (coverUrl ? 'margin-top:-40px;position:relative;z-index:1;' : '') + '">' +
                        '<img src="' + cachedResolveMediaUrl(avatar) + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin-bottom:12px;background:var(--border);border:3px solid var(--chat-bg);" onerror="this.src=\'' + defaultAvatar + '\'">' +
                        '<div style="font-size:20px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;justify-content:center;gap:8px;">' + (u.display_name || u.username) + (u.user_title ? '<span style="font-size:11px;color:#333;background:#e8e8e8;padding:1px 7px;border-radius:4px;line-height:18px;font-weight:400;">' + escapeHtml(u.user_title) + '</span>' : '') + '</div>' +
                        '<div style="font-size:12px;color:var(--secondary-text);margin-bottom:4px;">' + getDisplayUid(u) + '</div>' +
                        (u.signature ? '<div style="font-size:13px;color:var(--secondary-text);margin-bottom:12px;text-align:center;max-width:300px;">' + escapeHtml(u.signature) + '</div>' : '') +
                        (btnHtml ? '<div style="display:flex;gap:10px;">' + btnHtml + '</div>' : '') +
                    '</div>' +
                    '<div style="background:var(--chat-bg);color:var(--text);">' +
                    (relation === 'self' ? '<div style="font-size:14px;font-weight:600;padding:14px 16px 8px;">发表动态</div>' + postMomentHtml : '') +
                    '<div style="font-size:14px;font-weight:600;padding:14px 16px 8px;">' + (relation === 'self' ? '我的动态' : 'TA 的动态') + '</div>' +
                    momentsHtml +
                    '</div>';

                // 内容渲染后更新自绘滚动条
                if (spScrollbar) requestAnimationFrame(() => spScrollbar.update());

                // 点赞和评论事件
                scroll.querySelectorAll('.sp-like-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const momentId = btn.dataset.momentId;
                        if (!momentId) return;
                        const isLiked = btn.dataset.liked === '1';
                        const endpoint = isLiked ? '/v1/moments/unlike' : '/v1/moments/like';
                        try {
                            const res = await apiFetch(endpoint, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ moment_id: momentId })
                            });
                            const data = await res.json();
                            if (data.error) { showAlert(data.error); return; }
                            // 更新按钮状态
                            const icon = btn.querySelector('i');
                            const newLiked = !isLiked;
                            btn.dataset.liked = newLiked ? '1' : '0';
                            if (newLiked) {
                                btn.style.color = '#ff4757';
                                icon.className = 'fa-solid fa-heart';
                            } else {
                                btn.style.color = 'var(--secondary-text)';
                                icon.className = 'fa-regular fa-heart';
                            }
                            const countEl = btn.lastChild;
                            const curCount = parseInt(countEl.textContent.trim()) || 0;
                            countEl.textContent = ' ' + (newLiked ? curCount + 1 : Math.max(0, curCount - 1));
                        } catch (e) { console.error(e); }
                    });
                });
                scroll.querySelectorAll('.sp-comment-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const momentId = btn.dataset.momentId;
                        if (!momentId) return;
                        openMomentCommentsPanel(momentId, btn);
                    });
                });

                window.spMsg = function() {
                    closePanel();
                    if (currentConv && currentConv.key === 'direct:' + getUid(u)) return;
                    let found = contacts.friends.find(f => f.uid === getUid(u));
                    if (found) {
                        switchConversation('direct', getUid(u), found.name);
                    } else {
                        switchConversation('direct', getUid(u), u.display_name || u.username);
                    }
                };
                window.spAddFriend = async function() {
                    try {
                        const r = await apiFetch('/v1/friends/request', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(toUidParam(uid)) });
                        const d = await r.json();
                        if (d.error) { showAlert(d.error); return; }
                        load();
                    } catch(e) { showAlert('请求失败'); }
                };
                window.spRespond = async function(action) {
                    try {
                        // 先查询好友申请列表，找到对应 request_id
                        const reqRes = await apiFetch('/v1/friends/requests');
                        const reqData = await reqRes.json();
                        const req = (reqData.requests || []).find(r => uidEq(getUid(r) || r.from_ncuid || r.from_uid, uid));
                        if (!req) { showAlert('未找到好友申请'); return; }
                        const r = await apiFetch('/v1/friends/respond', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({request_id: req.id, accept: action === 'accept'}) });
                        const d = await r.json();
                        if (d.error) { showAlert(d.error); return; }
                        load();
                    } catch(e) { showAlert('请求失败'); }
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
                            if (!text && !file) { showAlert('请输入内容或选择图片'); return; }
                            momentBtn.disabled = true;
                            momentBtn.textContent = '发布中...';
                            try {
                                let imageUrl = '';
                                if (file) {
                                    const upFd = new FormData();
                                    upFd.append('file', file);
                                    const upRes = await apiFetch('/v1/media', { method: 'POST', body: upFd });
                                    const upData = await upRes.json();
                                    if (upData.error) { showAlert(upData.error); momentBtn.disabled = false; momentBtn.textContent = '发布'; return; }
                                    imageUrl = upData.url || '';
                                }
                                const r = await apiFetch('/v1/moments', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({body: text, image_url: imageUrl}) });
                                const d = await r.json();
                                if (d.error) { showAlert(d.error); momentBtn.disabled = false; momentBtn.textContent = '发布'; return; }
                                load();
                            } catch(e) { showAlert('发布失败'); momentBtn.disabled = false; momentBtn.textContent = '发布'; }
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
                await apiFetch('/v1/direct/read', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(withUidParam(convId)) });
            } else {
                await apiFetch('/v1/groups/read', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({group_id: convId}) });
            }
            const convKey = convType + ':' + convId;
            delete unreadCounts[convKey];
            updateUnreadBadge(convKey, 0);
        } catch (e) { console.error(e); }
    }

    // 节流标记已读：WS 消息到达时不立即发送，合并到 2 秒内只发一次
    const _debouncedReadTimers = new Map(); // convKey -> timer
    function debouncedMarkRead(convType, convId) {
        if (!convId) return;
        const convKey = convType + ':' + convId;
        if (_debouncedReadTimers.has(convKey)) {
            clearTimeout(_debouncedReadTimers.get(convKey));
        }
        _debouncedReadTimers.set(convKey, setTimeout(() => {
            _debouncedReadTimers.delete(convKey);
            if (convType === 'direct') {
                apiFetch('/v1/direct/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(withUidParam(convId)) }).catch(() => {});
            } else {
                apiFetch('/v1/groups/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ group_id: convId }) }).catch(() => {});
            }
        }, 2000));
    }

    // 动态评论弹窗：展示评论列表并支持添加
    function openMomentCommentsPanel(momentId, triggerBtn) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
        overlay.innerHTML = `
            <div style="background:var(--header-bg);color:#fff;padding:13px 12px;display:flex;align-items:center;font-size:15px;font-weight:500;flex-shrink:0;position:relative;">
                <button id="mc-back" style="position:absolute;left:12px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;"><i class="fa-solid fa-chevron-left"></i></button>
                <span style="width:100%;text-align:center;">评论</span>
            </div>
            <div id="mc-scroll" style="flex:1;overflow-y:auto;scrollbar-color:rgba(0,0,0,0.2) transparent;padding:12px;"></div>
            <div style="flex-shrink:0;padding:10px 12px;border-top:1px solid var(--border-color);display:flex;gap:8px;background:var(--panel-bg);">
                <input id="mc-input" type="text" placeholder="写下你的评论..." style="flex:1;padding:8px 12px;border-radius:18px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;">
                <button id="mc-send" style="padding:8px 18px;border-radius:18px;border:none;background:var(--header-bg);color:#fff;font-size:14px;cursor:pointer;font-family:inherit;">发送</button>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.style.opacity = '1');

        const scrollEl = overlay.querySelector('#mc-scroll');
        const inputEl = overlay.querySelector('#mc-input');
        const sendBtn = overlay.querySelector('#mc-send');
        const backBtn = overlay.querySelector('#mc-back');

        function closePanel() { overlay.remove(); }
        backBtn.addEventListener('click', closePanel);

        function fmtTs(ts) {
            if (!ts) return '';
            const d = new Date(ts * 1000);
            const pad = n => (n < 10 ? '0' : '') + n;
            return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        async function loadComments() {
            scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载中...</div>';
            try {
                const res = await apiFetch('/v1/moments/comments?moment_id=' + encodeURIComponent(momentId));
                const data = await res.json();
                if (data.error) {
                    scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">' + escapeHtml(data.error) + '</div>';
                    return;
                }
                const comments = data.comments || [];
                if (comments.length === 0) {
                    scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">还没有评论，快来抢沙发~</div>';
                    return;
                }
                scrollEl.innerHTML = comments.map(c => {
                    const cid = getUid(c) || c.from_ncuid || c.from_uid || '';
                    const cname = c.from_name || c.display_name || c.username || (cid ? lookupName(cid) : '') || '匿名用户';
                    const cavatar = c.from_avatar || c.avatar_url || (cid ? lookupAvatar(cid) : '') || '';
                    const avatarSrc = cavatar ? cachedResolveMediaUrl(cavatar) : 'assets/default-avatar.png';
                    return '<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-color);">' +
                        '<img src="' + avatarSrc + '" onerror="this.src=\'assets/default-avatar.png\'" style="width:36px;height:36px;border-radius:50%;flex-shrink:0;cursor:pointer;" data-uid="' + escapeHtml(cid) + '" />' +
                        '<div style="flex:1;min-width:0;">' +
                            '<div style="font-size:13px;font-weight:500;color:var(--text);">' + escapeHtml(cname) + '</div>' +
                            '<div style="font-size:14px;color:var(--text);margin:4px 0;word-break:break-word;white-space:pre-wrap;">' + escapeHtml(c.body || '') + '</div>' +
                            '<div style="font-size:11px;color:var(--secondary-text);">' + fmtTs(c.created_at) + '</div>' +
                        '</div>' +
                    '</div>';
                }).join('');
                // 头像点击跳转用户空间
                scrollEl.querySelectorAll('img[data-uid]').forEach(img => {
                    img.addEventListener('click', () => {
                        const uid = img.dataset.uid;
                        if (uid) { closePanel(); openSpacePanel(uid); }
                    });
                });
            } catch (e) {
                scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载失败</div>';
                console.error(e);
            }
        }

        async function sendComment() {
            const text = inputEl.value.trim();
            if (!text) return;
            sendBtn.disabled = true;
            sendBtn.textContent = '...';
            try {
                const res = await apiFetch('/v1/moments/comment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ moment_id: momentId, body: text })
                });
                const data = await res.json();
                if (data.error) { showAlert(data.error); return; }
                inputEl.value = '';
                // 更新按钮上的评论计数
                if (triggerBtn) {
                    const countEl = triggerBtn.lastChild;
                    const count = parseInt(countEl.textContent.trim()) || 0;
                    countEl.textContent = ' ' + (count + 1);
                }
                loadComments();
            } catch (e) { showAlert('评论失败'); }
            sendBtn.disabled = false;
            sendBtn.textContent = '发送';
        }

        sendBtn.addEventListener('click', sendComment);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendComment();
            }
        });

        loadComments();
    }

    function openCheckinCommentsPanel(postId, triggerBtn) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:var(--bg);display:flex;flex-direction:column;font-family:inherit;opacity:0;transition:opacity 0.2s;';
        overlay.innerHTML = `
            <div style="background:var(--header-bg);color:#fff;padding:13px 12px;display:flex;align-items:center;font-size:15px;font-weight:500;flex-shrink:0;position:relative;">
                <button id="cc-back" style="position:absolute;left:12px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;"><i class="fa-solid fa-chevron-left"></i></button>
                <span style="width:100%;text-align:center;">评论</span>
            </div>
            <div id="cc-scroll" style="flex:1;overflow-y:auto;scrollbar-color:rgba(0,0,0,0.2) transparent;padding:12px;"></div>
            <div style="flex-shrink:0;padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:8px;background:var(--chat-bg);">
                <input id="cc-input" type="text" placeholder="写下你的评论..." style="flex:1;padding:8px 12px;border-radius:18px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;">
                <button id="cc-send" style="padding:8px 18px;border-radius:18px;border:none;background:var(--header-bg);color:#fff;font-size:14px;cursor:pointer;font-family:inherit;">发送</button>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.style.opacity = '1');

        const scrollEl = overlay.querySelector('#cc-scroll');
        const inputEl = overlay.querySelector('#cc-input');
        const sendBtn = overlay.querySelector('#cc-send');
        const backBtn = overlay.querySelector('#cc-back');

        function closePanel() { overlay.remove(); }
        backBtn.addEventListener('click', closePanel);

        function fmtTs(ts) {
            if (!ts) return '';
            // 兼容 Unix 秒时间戳 和 ISO 日期字符串
            let d;
            if (typeof ts === 'number' || /^\d+$/.test(String(ts))) {
                d = new Date(Number(ts) * 1000);
            } else {
                d = new Date(ts);
            }
            if (isNaN(d.getTime())) return '';
            const pad = n => (n < 10 ? '0' : '') + n;
            return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        async function loadComments() {
            scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载中...</div>';
            try {
                const res = await apiFetch('/v1/me/checkin/wall/comments?post_id=' + encodeURIComponent(postId));
                const data = await res.json();
                if (data.error) {
                    scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">' + escapeHtml(data.error) + '</div>';
                    return;
                }
                const comments = data.comments || [];
                if (comments.length === 0) {
                    scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">还没有评论，快来抢沙发~</div>';
                    return;
                }
                scrollEl.innerHTML = comments.map(c => {
                    // 兼容签到墙格式（c.user.*, c.content_text）和动态格式（c.from_*, c.body）
                    const cu = c.user || {};
                    const cid = getUid(cu) || cu.uid || cu.ncuid || getUid(c) || c.from_ncuid || c.from_uid || '';
                    const cname = cu.display_name || cu.username || cu.name || c.from_name || c.display_name || c.username || (cid ? lookupName(cid) : '') || '匿名用户';
                    const cavatar = cu.avatar_url || c.from_avatar || c.avatar_url || (cid ? lookupAvatar(cid) : '') || '';
                    const avatarSrc = cavatar ? cachedResolveMediaUrl(cavatar) : 'assets/default-avatar.png';
                    const body = c.content_text || c.body || c.text || '';
                    return '<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">' +
                        '<img src="' + avatarSrc + '" onerror="this.src=\'assets/default-avatar.png\'" style="width:36px;height:36px;border-radius:50%;flex-shrink:0;cursor:pointer;" data-uid="' + escapeHtml(cid) + '" />' +
                        '<div style="flex:1;min-width:0;">' +
                            '<div style="font-size:13px;font-weight:500;color:var(--text);">' + escapeHtml(cname) + '</div>' +
                            '<div style="font-size:14px;color:var(--text);margin:4px 0;word-break:break-word;white-space:pre-wrap;">' + escapeHtml(body) + '</div>' +
                            '<div style="font-size:11px;color:var(--secondary-text);">' + fmtTs(c.created_at) + '</div>' +
                        '</div>' +
                    '</div>';
                }).join('');
                scrollEl.querySelectorAll('img[data-uid]').forEach(img => {
                    img.addEventListener('click', () => {
                        const uid = img.dataset.uid;
                        if (uid) { closePanel(); openSpacePanel(uid); }
                    });
                });
            } catch (e) {
                scrollEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--secondary-text);">加载失败</div>';
                console.error(e);
            }
        }

        async function sendComment() {
            const text = inputEl.value.trim();
            if (!text) return;
            sendBtn.disabled = true;
            sendBtn.textContent = '...';
            try {
                const res = await apiFetch('/v1/me/checkin/wall/comment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ post_id: postId, body: text })
                });
                const data = await res.json();
                if (data.error) { showAlert(data.error); return; }
                inputEl.value = '';
                if (triggerBtn) {
                    const countEl = triggerBtn.lastChild;
                    const count = parseInt(countEl.textContent.trim()) || 0;
                    countEl.textContent = ' ' + (count + 1);
                }
                loadComments();
            } catch (e) { showAlert('评论失败'); }
            sendBtn.disabled = false;
            sendBtn.textContent = '发送';
        }

        sendBtn.addEventListener('click', sendComment);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendComment();
            }
        });

        loadComments();
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
                    uid: getUid(m),
                    displayUid: getDisplayUid(m),
                    name: m.display_name || m.username || getUid(m),
                    avatar: m.avatar_url || ''
                }));
                const avatar = info.avatar_url || defaultAvatar;
                const isOwner = info.role === 2;

                let membersHtml = '';
                members.forEach(m => {
                    const mUid = m.uid;
                    const isMe = isSelfUid(mUid);
                    membersHtml += `<div class="gm-member-item" data-uid="${escapeHtml(mUid)}" style="cursor:pointer;">` +
                        `<img class="gm-member-avatar" src="${cachedResolveMediaUrl(m.avatar || defaultAvatar)}" onerror="this.src='${defaultAvatar}'">` +
                        `<div class="gm-member-info"><div class="gm-member-name">${escapeHtml(m.name)}</div><div class="gm-member-uid">${escapeHtml(m.displayUid)}</div></div>` +
                        (isMe ? '<span class="gm-member-tag">我</span>' : '') +
                        `</div>`;
                });

                let btnsHtml = '';
                if (!isOwner) {
                    btnsHtml = `<div class="gm-actions"><button class="gm-leave-btn" onclick="gmLeaveGroup()">退出群聊</button></div>`;
                }

                scroll.innerHTML =
                    '<div class="gm-profile">' +
                        `<img class="gm-avatar" src="${cachedResolveMediaUrl(avatar)}" onerror="this.src='${defaultAvatar}'">` +
                        `<div class="gm-name">${escapeHtml(info.name || groupName)}</div>` +
                        `<div class="gm-meta">群聊ID: ${escapeHtml(info.group_id || groupId)}</div>` +
                        `<div class="gm-meta">成员数: ${info.member_count || members.length} 人</div>` +
                    '</div>' +
                    '<div class="gm-section">' +
                        '<div class="gm-section-header"><span>成员列表 (' + members.length + ')</span><button class="gm-invite-btn" onclick="gmShowInvite()">+ 邀请</button></div>' +
                        '<div class="gm-members-list">' + membersHtml + '</div>' +
                    '</div>' +
                    btnsHtml;

                // 成员项点击：打开该成员的用户空间
                scroll.querySelectorAll('.gm-member-item[data-uid]').forEach(item => {
                    item.addEventListener('click', () => {
                        const uid = item.dataset.uid;
                        if (uid && !isSelfUid(uid)) {
                            openSpacePanel(uid);
                        }
                    });
                });

                window.gmShowInvite = function() {
                    openInvitePanel(groupId, members);
                };
                window.gmLeaveGroup = async function() {
                    if (!await showConfirm('确定要退出该群聊吗？')) return;
                    try {
                        const r = await apiFetch('/v1/groups/leave', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ group_id: groupId })
                        });
                        const d = await r.json();
                        if (d.error) { showAlert(d.error); return; }
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
                    } catch (e) { showAlert('请求失败'); }
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
            const existingUids = new Set(existingMembers.map(m => getUid(m).toUpperCase()));
            const friends = (contacts.friends || []).filter(f => !existingUids.has(f.uid.toUpperCase()));
            let friendsHtml = '';
            if (friends.length > 0) {
                friends.forEach(f => {
                    friendsHtml += `<div class="gm-friend-item" data-uid="${escapeHtml(f.uid)}">` +
                        `<img class="gm-friend-avatar" src="${cachedResolveMediaUrl(f.avatar || defaultAvatar)}" onerror="this.src='${defaultAvatar}'">` +
                        `<div class="gm-friend-info"><div class="gm-friend-name">${escapeHtml(f.name)}</div><div class="gm-friend-uid">${escapeHtml(getDisplayUid(f))}</div></div>` +
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
                    if (d.error) { showAlert(d.error); return false; }
                    return true;
                } catch (e) { showAlert('请求失败'); return false; }
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
                if (!uid) { showAlert('请输入 UID'); return; }
                const btn = inviteOverlay.querySelector('#gmUidInviteBtn');
                btn.disabled = true;
                btn.textContent = '邀请中...';
                const ok = await doInvite(uid);
                if (ok) {
                    showAlert('邀请成功');
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
                    apiFetch('/v1/users/profile?ncuid=' + encodeURIComponent(myUid)),
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
                        const displayName = f.remark_name || f.display_name || f.username || getUid(f);
                        friendsHtml += `<div class="mp-req-item" data-uid="${escapeHtml(f.uid)}">` +
                            `<img class="mp-req-avatar" src="${cachedResolveMediaUrl(fAvatar)}" onerror="this.src='${defaultAvatar}'">` +
                            `<div class="mp-req-info"><div class="mp-req-name">${escapeHtml(displayName)}</div>` +
                            `<div class="mp-req-time">${escapeHtml(getDisplayUid(f))}</div></div>` +
                            `<button class="mp-req-chat-btn" data-uid="${escapeHtml(f.uid)}">私聊</button>` +
                            `</div>`;
                    });

                } else {
                    friendsHtml = '<div class="mp-empty">暂无联系人</div>';
                }

                scroll.innerHTML =
                    '<div class="mp-profile">' +
                        `<div class="mp-avatar-wrap" id="mpAvatarWrap">` +
                            `<img class="mp-avatar" id="mpAvatar" src="${cachedResolveMediaUrl(avatar)}" onerror="this.src='${defaultAvatar}'">` +
                            `<div class="mp-avatar-mask">更换头像</div>` +
                        `</div>` +
                        `<input type="file" id="mpAvatarInput" accept="image/*" style="display:none">` +
                        `<div class="mp-field" id="mpNameField"><div class="mp-field-name" id="mpNameText" style="display:flex;align-items:center;gap:8px;"><span>${escapeHtml(currentProfile.display_name || currentProfile.username)}</span>${currentProfile.user_title ? `<span style="font-size:10px;color:#333;background:#e8e8e8;padding:0 6px;border-radius:4px;line-height:16px;font-weight:400;">${escapeHtml(currentProfile.user_title)}</span>` : ''}</div></div>` +
                        `<div class="mp-field" id="mpUidField"><div class="mp-field-uid" id="mpUidText">${escapeHtml(myDisplayUid)}</div></div>` +
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
                        if (d.error) { showAlert(d.error); return; }
                        document.getElementById('mpAvatar').src = cachedResolveMediaUrl(d.avatar_url);
                        currentProfile.avatar_url = d.avatar_url;
                    } catch (err) { showAlert('上传失败'); }
                });

                document.getElementById('mpAddFriendBtn').addEventListener('click', async () => {
                    const input = document.getElementById('mpAddFriendInput');
                    const val = input.value.trim();
                    if (!val) { showAlert('请输入 UID 或昵称'); return; }
                    const btn = document.getElementById('mpAddFriendBtn');
                    btn.disabled = true;
                    btn.textContent = '发送中...';
                    try {
                        const r = await apiFetch('/v1/friends/request', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(toUidParam(val.toUpperCase()))
                        });
                        const d = await r.json();
                        if (d.error) { showAlert(d.error); } else { showAlert('已发送申请'); input.value = ''; }
                    } catch(e) { showAlert('请求失败'); }
                    btn.disabled = false;
                    btn.textContent = '添加';
                });

                document.getElementById('mpJoinGroupBtn').addEventListener('click', async () => {
                    const input = document.getElementById('mpJoinGroupInput');
                    const val = input.value.trim().toUpperCase();
                    if (!val) { showAlert('请输入群聊 ID'); return; }
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
                        if (d.error || d.code) { showAlert(d.error || '加入失败'); } else { showAlert('已加入群聊'); input.value = ''; loadContacts(); }
                    } catch(e) { showAlert('请求失败'); }
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
                            if (d.error) { showAlert(d.error); return; }
                            currentProfile.display_name = newVal;
                            field.innerHTML = `<div class="mp-field-name" id="mpNameText">${escapeHtml(newVal)}</div>`;
                            document.getElementById('sidebarUserName').textContent = newVal;
                        } catch (err) { showAlert('保存失败'); }
                    };
                    input.addEventListener('blur', save);
                    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
                });

                document.getElementById('mpUidField').addEventListener('click', () => {
                    const field = document.getElementById('mpUidField');
                    const val = getUid(currentProfile);
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
                            if (d.error) { showAlert(d.error); return; }
                            currentProfile.ncuid = newVal;
                            field.innerHTML = `<div class="mp-field-uid" id="mpUidText">${escapeHtml(newVal)}</div>`;
                        } catch (err) { showAlert('保存失败'); }
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
                            if (d.error) { showAlert(d.error); return; }
                            currentProfile.signature = newVal;
                            field.innerHTML = `<div class="mp-field-bio" id="mpBioText">${newVal ? escapeHtml(newVal) : '点击添加签名'}</div>`;
                        } catch (err) { showAlert('保存失败'); }
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
    let lastSelectedText = '';  // mouseup 时保存选区文本，供 contextmenu 使用

    // 在消息区域抬起鼠标时保存选区文本（右键 mousedown 可能清除选区）
    document.addEventListener('mouseup', () => {
        const sel = window.getSelection();
        lastSelectedText = (sel && sel.toString()) ? sel.toString() : '';
    });

    // 滚动加载历史消息状态
    const convOffset = {};        // convKey → 当前已加载的消息偏移量
    const convHasMore = {};       // convKey → boolean
    // 会话消息 DOM 缓存（切换会话时保留旧消息 DOM）
    const convCache = {};         // convKey → { fragment, scrollTop, seenMsgIds, offset, hasMore, lastTs }
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

    // 自绘编辑框右键菜单
    function showEditContextMenu(e, el) {
        const menu = document.createElement('div');
        menu.className = 'custom-context-menu';
        // 菜单位置：确保不超出视口
        const x = Math.min(e.clientX, window.innerWidth - 180);
        const y = Math.min(e.clientY, window.innerHeight - 320);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        const hasSelection = el.selectionStart !== null && el.selectionEnd !== null && el.selectionStart !== el.selectionEnd;
        const hasContent = el.value && el.value.length > 0;

        const disabledStyle = 'opacity:0.4;cursor:default;';
        const items = [
            { label: '撤销', action: 'undo', disabled: false },
            { label: '重做', action: 'redo', disabled: false },
            { divider: true },
            { label: '剪切', action: 'cut', disabled: !hasSelection },
            { label: '复制', action: 'copy', disabled: !hasSelection },
            { label: '粘贴', action: 'paste', disabled: false },
            { label: '删除', action: 'delete', disabled: !hasSelection },
            { divider: true },
            { label: '全选', action: 'selectall', disabled: !hasContent },
            { divider: true },
            { label: '清空', action: 'clear', disabled: !hasContent, danger: true }
        ];

        let menuHtml = '';
        items.forEach(item => {
            if (item.divider) {
                menuHtml += '<div class="context-menu-divider"></div>';
            } else {
                const styleAttr = item.disabled ? ' style="' + disabledStyle + '"' : '';
                const colorStyle = item.danger ? ' style="color:#ff6b6b;' + (item.disabled ? 'opacity:0.4;cursor:default;' : '') + '"' : styleAttr;
                menuHtml += '<div class="context-menu-item" data-action="' + item.action + '"' + colorStyle + '>' + item.label + '</div>';
            }
        });
        menu.innerHTML = menuHtml;
        document.body.appendChild(menu);
        requestAnimationFrame(() => menu.classList.add('show'));
        contextMenu = menu;

        menu.addEventListener('click', async (event) => {
            const item = event.target.closest('.context-menu-item');
            if (!item) return;
            const action = item.dataset.action;
            if (item.style.opacity === '0.4') { hideContextMenu(); return; }

            el.focus();
            try {
                if (action === 'undo') {
                    document.execCommand('undo');
                } else if (action === 'redo') {
                    document.execCommand('redo');
                } else if (action === 'cut') {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        const sel = el.value.substring(el.selectionStart, el.selectionEnd);
                        await navigator.clipboard.writeText(sel);
                        el.setRangeText('');
                    } else {
                        document.execCommand('cut');
                    }
                } else if (action === 'copy') {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        const sel = el.value.substring(el.selectionStart, el.selectionEnd);
                        await navigator.clipboard.writeText(sel);
                    } else {
                        document.execCommand('copy');
                    }
                } else if (action === 'paste') {
                    if (navigator.clipboard && navigator.clipboard.readText) {
                        const text = await navigator.clipboard.readText();
                        const start = el.selectionStart;
                        const end = el.selectionEnd;
                        el.setRangeText(text, start, end, 'end');
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    } else {
                        document.execCommand('paste');
                    }
                } else if (action === 'delete') {
                    el.setRangeText('');
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (action === 'selectall') {
                    el.select();
                } else if (action === 'clear') {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } catch (err) {
                console.error('[edit-menu]', err);
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
    }

    emojiPlazaBtn.addEventListener('click', () => {
        showCollectedEmojiPicker();
    });

    const emojiPlazaMoreBtn = document.getElementById('emojiPlazaMoreBtn');
    if (emojiPlazaMoreBtn) {
        emojiPlazaMoreBtn.addEventListener('click', () => {
            moreMenu.classList.remove('show');
            showEmojiPlaza();
        });
    }
    

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
            if (frData.error) { showAlert(frData.error); return; }
            contacts = {
                friends: (frData.friends || []).map(f => ({
                    uid: getUid(f),
                    displayUid: getDisplayUid(f),
                    name: f.display_name || f.username || getUid(f),
                    username: f.username,
                    display_name: f.display_name,
                    avatar: f.avatar_url || '',
                    remark_name: f.remark_name || '',
                    user_title: f.user_title || ''
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
            // 后台预加载联系人资料（填充称号到缓存），节流控制并发数
            const MAX_CONCURRENT_PROFILE_FETCHES = 3;
            let profileFetchIndex = 0;
            function fetchProfileBatch() {
                const batch = [];
                while (profileFetchIndex < contacts.friends.length && batch.length < MAX_CONCURRENT_PROFILE_FETCHES) {
                    const f = contacts.friends[profileFetchIndex++];
                    const cacheKey = f.uid.toUpperCase();
                    if (!userProfileCache.has(cacheKey)) {
                        batch.push(fetchUserProfile(f.displayUid, f.uid).catch(() => {}));
                    }
                }
                if (batch.length > 0) {
                    Promise.all(batch).then(() => {
                        // 继续下一批
                        if (profileFetchIndex < contacts.friends.length) {
                            fetchProfileBatch();
                        }
                    });
                } else if (profileFetchIndex < contacts.friends.length) {
                    // 没有需要请求的，跳过
                    fetchProfileBatch();
                }
            }
            fetchProfileBatch();
            // 加载未读计数（同步等待，避免后续 switchConversation 清红点后被覆盖）
            await loadUnreadCounts();
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
            // 统计私聊未读（按 from_ncuid 分组）
            const directCount = {};
            (dData.messages || []).forEach(m => {
                const uid = m.from_ncuid || m.from_uid;
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
    let wsReconnectAttempts = 0;
    const WS_RECONNECT_BASE_DELAY = 5000; // 初始 5 秒（不要太快退避）
    const WS_RECONNECT_MAX_DELAY = 30000; // 最大 30 秒
    // ECDH 会话密钥
    let wsSessionId = null;
    let wsEncKey = null;
    let wsMacKey = null;

    // 指数退避调度重连
    function scheduleWsReconnect() {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, wsReconnectAttempts), WS_RECONNECT_MAX_DELAY);
        wsReconnectAttempts++;
        console.log('[WS] reconnect in ' + delay + 'ms (attempt ' + wsReconnectAttempts + ')');
        wsReconnectTimer = setTimeout(initWebSocket, delay);
    }

    // Typing 状态
    const typingUsers = new Map(); // convKey -> { uid, name, avatar, timer }
    let typingSendTimer = null;
    let lastTypingSent = 0;
    const TYPING_THROTTLE = 3000; // 每 3 秒最多发送一次

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
                wsReconnectAttempts = 0; // 连接成功，重置重连计数
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
                // 清除所有 typing 状态
                typingUsers.forEach((entry) => clearTimeout(entry.timer));
                typingUsers.clear();
                if (typingIndicator) {
                    typingIndicator.style.display = 'none';
                    typingIndicator.innerHTML = '';
                }
                scheduleWsReconnect();
            };
            ws.onerror = (e) => {
                console.error('[WS] error:', e);
            };
        } catch (e) {
            console.error('[WS] init failed:', e);
            scheduleWsReconnect();
        }
    }

    // 加密发送 WebSocket 消息
    async function encryptAndSendWs(payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!wsEncKey || !wsMacKey) return;
        try {
            const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
            // PKCS7 填充
            const blockSize = 16;
            const padLen = blockSize - (plainBytes.length % blockSize);
            const padded = new Uint8Array(plainBytes.length + padLen);
            padded.set(plainBytes);
            padded.fill(padLen, plainBytes.length);
            // 随机 IV
            const iv = crypto.getRandomValues(new Uint8Array(16));
            const key = await crypto.subtle.importKey('raw', wsEncKey, { name: 'AES-CBC' }, false, ['encrypt']);
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, padded);
            const ciphertext = new Uint8Array(encrypted.slice(0, encrypted.length - 16)); // remove padding from subtle output
            // 实际上 Subtle 已经做了 PKCS7，我们直接用它的输出
            const data = new Uint8Array(encrypted);
            const mac = await Crypto.hmacSha256(wsMacKey, Crypto.concatBytes(iv, data));
            const envelope = JSON.stringify({
                iv: Crypto.bytesToBase64(iv),
                data: Crypto.bytesToBase64(data),
                mac: Crypto.bytesToBase64(mac)
            });
            ws.send(envelope);
        } catch (e) {
            console.error('[WS] encryptAndSend error:', e);
        }
    }

    async function fetchUserProfile(uid, ncuid, forceRefresh) {
        // uid: 旧格式 uid，用于 ?uid= 参数
        // ncuid: 新格式 ncuid，用于 ?ncuid= 参数
        // 实际发现：?uid= 参数不接受 ncuid 值，会返回 invalid uid
        // 因此必须用正确的参数查询
        if (!uid && !ncuid) return null;
        const idForCache = ncuid || uid;
        if (!idForCache || idForCache.toUpperCase() === myUid.toUpperCase()) return null;
        const key = idForCache.toUpperCase();
        // 跳过已知无效的 UID（除非强制刷新，用于重试）
        if (!forceRefresh && invalidUidCache.has(key)) return null;
        if (!forceRefresh && userProfileCache.has(key)) {
            const cached = userProfileCache.get(key);
            if (Date.now() - cached._ts < CACHE_TTL) return cached;
        }
        // 并发去重：已有相同key的请求在进行中，直接复用
        if (pendingProfileFetches.has(key)) {
            return pendingProfileFetches.get(key);
        }
        const promise = (async () => {
            try {
                let data = null;
                // 优先使用 ncuid 参数（?ncuid= 路径）
                if (ncuid) {
                    const res = await apiFetch('/v1/users/profile?ncuid=' + encodeURIComponent(ncuid));
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                }
                // ncuid 查询失败，尝试用 uid 查询（?uid= 路径，注意 ncuid 不能传入 ?uid=）
                if (!data && uid) {
                    const res = await apiFetch('/v1/users/profile?uid=' + encodeURIComponent(uid));
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                }
                // 补充：uid 查询也失败，但 uid 实际上可能是 ncuid（服务器把 ncuid 放进了 from_uid 字段）
                // 尝试用 ?ncuid= 查询 uid 值
                if (!data && uid && !ncuid) {
                    const res = await apiFetch('/v1/users/profile?ncuid=' + encodeURIComponent(uid));
                    if (res.ok) {
                        const d = await res.json();
                        if (d && !d.error) data = d;
                    }
                }
                // 三种都失败（网络错误等情况），不标记无效，允许后续重试
                if (!data) return null;
                // 服务器返回错误信息（理论上上面已过滤，但保留防御性检查）
                if (data.error && /invalid|not found|不存在/i.test(data.error)) {
                    invalidUidCache.add(key);
                    return null;
                }
                // 成功
                data._ts = Date.now();
                userProfileCache.set(key, data);
                invalidUidCache.delete(key);
                return data;
            } catch (e) {}
            return null;
        })();
        pendingProfileFetches.set(key, promise);
        promise.then(() => {
            if (pendingProfileFetches.get(key) === promise) {
                pendingProfileFetches.delete(key);
            }
        }, () => {
            if (pendingProfileFetches.get(key) === promise) {
                pendingProfileFetches.delete(key);
            }
        });
        return promise;
    }

    // 重试加载用户资料（递增间隔 5s → 15s，共2次）
    // isAvatar=true 时更新头像 img 元素，否则更新昵称文本
    function scheduleProfileRetry(uid, ncuid, element, isAvatar, retryCount) {
        if (!uid && !ncuid) return;
        if (!element || !element.isConnected) return;
        retryCount = retryCount || 0;
        if (retryCount >= 2) return;

        const intervals = [5000, 15000];
        setTimeout(async () => {
            if (!element.isConnected) return;
            const profile = await fetchUserProfile(uid, ncuid, true);
            if (!profile) {
                scheduleProfileRetry(uid, ncuid, element, isAvatar, retryCount + 1);
                return;
            }
            if (isAvatar) {
                const newAvatar = profile.avatar_url ? cachedResolveMediaUrl(profile.avatar_url) : 'assets/default-avatar.png';
                if (element.src !== newAvatar) element.src = newAvatar;
            } else {
                const newName = profile.display_name || profile.username || (ncuid || uid || '');
                // 保留称号标签，只更新名称文本
                const nameText = element.childNodes[0];
                if (nameText) nameText.textContent = newName;
                // 更新称号
                if (profile.user_title) {
                    let titleSpan = element.querySelector('.sender-title');
                    if (!titleSpan) {
                        titleSpan = document.createElement('span');
                        titleSpan.className = 'sender-title';
                        element.appendChild(titleSpan);
                    }
                    titleSpan.textContent = profile.user_title;
                }
            }
        }, intervals[retryCount]);
    }

    // 根据 uid 查找联系人显示名
    // 支持按 x.uid（ncuid）和 x.displayUid（旧 uid）两种格式查找
    const lookupNameCache = new Map();
    function lookupName(uid) {
        if (!uid) return '';
        if (uid.toUpperCase() === myUid.toUpperCase()) return myName;
        const upper = uid.toUpperCase();
        // 命中缓存
        if (lookupNameCache.has(upper)) return lookupNameCache.get(upper);
        const f = contacts.friends.find(x => x.uid.toUpperCase() === upper || (x.displayUid && x.displayUid.toUpperCase() === upper));
        if (f) { lookupNameCache.set(upper, f.name); return f.name; }
        const m = groupMembers.find(x => x.uid.toUpperCase() === upper || (x.displayUid && x.displayUid.toUpperCase() === upper));
        if (m) { lookupNameCache.set(upper, m.name); return m.name; }
        const cached = userProfileCache.get(upper);
        if (cached) { const n = cached.display_name || cached.username || uid; lookupNameCache.set(upper, n); return n; }
        lookupNameCache.set(upper, uid);
        return uid;
    }

    const lookupAvatarCache = new Map();
    function lookupAvatar(uid) {
        if (!uid) return '';
        if (uid.toUpperCase() === myUid.toUpperCase()) return myAvatar;
        const upper = uid.toUpperCase();
        // 命中缓存
        if (lookupAvatarCache.has(upper)) return lookupAvatarCache.get(upper);
        const f = contacts.friends.find(x => x.uid.toUpperCase() === upper || (x.displayUid && x.displayUid.toUpperCase() === upper));
        if (f && f.avatar) { lookupAvatarCache.set(upper, f.avatar); return f.avatar; }
        const g = contacts.groups.find(x => x.id === uid);
        if (g && g.avatar) { lookupAvatarCache.set(upper, g.avatar); return g.avatar; }
        const m = groupMembers.find(x => x.uid.toUpperCase() === upper || (x.displayUid && x.displayUid.toUpperCase() === upper));
        if (m && m.avatar) { lookupAvatarCache.set(upper, m.avatar); return m.avatar; }
        const cached = userProfileCache.get(upper);
        if (cached && cached.avatar_url) { lookupAvatarCache.set(upper, cached.avatar_url); return cached.avatar_url; }
        lookupAvatarCache.set(upper, '');
        return '';
    }

    function lookupTitle(uid) {
        if (!uid) return '';
        const upper = uid.toUpperCase();
        // 从缓存资料中查找 user_title 字段
        const cached = userProfileCache.get(upper);
        if (cached && cached.user_title) return cached.user_title;
        return '';
    }

    // 新消息通知：仅 Tauri 生效，由 Rust 端根据窗口状态决定闪烁任务栏 / 系统通知
    function notifyNewMessage(title, body) {
        if (!IS_TAURI) return;
        const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
                       (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (!invoke) return;
        invoke('notify_new_message', { title: String(title || ''), body: String(body || '') }).catch(() => {});
    }

    // 消息预览：非文本类型显示类型标签
    function messagePreview(d) {
        const msgType = d.msg_type || 'text';
        if (msgType === 'image') return '[图片]';
        if (msgType === 'video') return '[视频]';
        if (msgType === 'voice' || msgType === 'audio') return '[语音]';
        if (msgType === 'resource' || msgType === 'file') return '[文件]';
        return d.body || '';
    }

    // 撤回消息后打断连消息链：前后消息重新重组
    function breakRecallChain(target, sep) {
        const prevSibling = sep.previousElementSibling;
        const nextSibling = sep.nextElementSibling;

        // 前序消息：标记为连消息链末尾
        if (prevSibling && prevSibling.classList.contains('message')) {
            prevSibling.classList.remove('consecutive-first');
            if (prevSibling.classList.contains('consecutive')) {
                prevSibling.classList.add('consecutive-last');
            }
        }

        // 后续消息：变为新连消息链首条（显示头像和昵称）
        if (nextSibling && nextSibling.classList.contains('message')) {
            if (nextSibling.classList.contains('consecutive')) {
                nextSibling.classList.remove('consecutive', 'consecutive-last');
                nextSibling.classList.add('consecutive-first');
            }
        }

        lastRenderedMsg = null;
        lastRenderedTs = 0;
    }

    // 创建撤回消息的分隔符（如果是自己的文本消息，附带"重新编辑"链接）
    function createRecallSeparator(recallName, originalMsgEl) {
        const sep = document.createElement('div');
        sep.className = 'time-separator';

        let hasReEdit = false;
        let originalText = '';
        let originalQuote = null;

        if (originalMsgEl) {
            try {
                const rawMsgData = JSON.parse(originalMsgEl.dataset.rawBody || '{}');
                const rawMsgType = rawMsgData.msg_type || originalMsgEl.dataset.msgType;
                if (rawMsgType === 'text') {
                    let body = rawMsgData.body || '';
                    if (body.trim().startsWith('{')) {
                        try {
                            const obj = JSON.parse(body);
                            originalText = obj.text || '';
                            if (obj.quote) originalQuote = obj.quote;
                        } catch (e) {
                            originalText = body;
                        }
                    } else {
                        originalText = body;
                    }
                    if (originalText) hasReEdit = true;
                }
            } catch (e) {}
        }

        if (hasReEdit) {
            const label = document.createElement('span');
            label.textContent = recallName + ' 撤回了一条消息 ';
            const reEdit = document.createElement('a');
            reEdit.textContent = '重新编辑';
            reEdit.className = 'recall-reedit-link';
            reEdit.style.cssText = 'color:var(--accent);cursor:pointer;text-decoration:none;margin-left:6px;';
            reEdit.onclick = (ev) => {
                ev.stopPropagation();
                messageInput.value = originalText;
                messageInput.style.height = 'auto';
                if (originalQuote) {
                    pendingQuote = originalQuote;
                    quotePreviewText.textContent = `引用: ${originalQuote.from_name || ''} - ${(originalQuote.text || '').substring(0, 50)}`;
                    quotePreview.style.display = 'flex';
                }
                messageInput.focus();
                messageInput.setSelectionRange(originalText.length, originalText.length);
            };
            sep.appendChild(label);
            sep.appendChild(reEdit);
        } else {
            sep.textContent = recallName + ' 撤回了一条消息';
        }

        return sep;
    }

    function handleWsMessage(msg) {
        if (!msg) return;
        // 兼容服务器裸消息格式（无 type 包装，直接推送消息对象）
        // 新格式: {id, from_uid, from_ncuid, body, msg_type, created_at, group_id?, sort_seq?, group_seq?}
        if (!msg.type && msg.id && (msg.from_uid || msg.from_ncuid) && msg.msg_type) {
            msg = msg.group_id
                ? { type: 'group_message', data: msg }
                : { type: 'direct_message', data: msg };
        }
        if (!msg || !msg.type) return;
        if (msg.type === 'direct_message') {
            const d = msg.data || {};
            const fromUid = getFromUid(d);
            if (isSelfUid(fromUid)) return;
            notifyNewMessage(lookupName(fromUid), messagePreview(d));
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
                from_name: getFromName(d) || lookupName(fromUid),
                from_avatar: getFromAvatar(d),
                body: d.body || '',
                msg_type: d.msg_type || 'text',
                media_url: d.media_url || null,
                thumb_url: d.thumb_url || null,
                created_at: d.created_at,
            };
            appendMessage(msgObj, convKey, seenMsgIds[convKey]);
            scheduleAutoScroll();
            // 节流标记已读，不每条消息都发请求
            debouncedMarkRead('direct', fromUid);
        } else if (msg.type === 'group_message') {
            const d = msg.data || {};
            const groupId = d.group_id || '';
            const fromUid = getFromUid(d);
            if (isSelfUid(fromUid)) return;
            // 检查群成员缓存：如果该发送者不在缓存中，后台刷新缓存（大群不频繁刷新）
            if (groupId) {
                const cached = groupMembersCache.get(groupId);
                if (cached && !cached.members.some(m => uidEq(m.ncuid, fromUid) || uidEq(m.uid, fromUid))) {
                    // 发送者不在缓存中，后台刷新（不阻塞当前消息处理）
                    refreshGroupMembersCache(groupId);
                }
            }
            const _grp = contacts.groups.find(g => g.id === groupId);
            notifyNewMessage(((_grp && _grp.name) || groupId) + ' · ' + lookupName(fromUid), messagePreview(d));
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
                from_name: getFromName(d) || lookupName(fromUid),
                from_avatar: getFromAvatar(d),
                body: d.body || '',
                msg_type: d.msg_type || 'text',
                media_url: d.media_url || null,
                thumb_url: d.thumb_url || null,
                created_at: d.created_at,
                group_id: groupId,
            };
            appendMessage(msgObj, convKey, seenMsgIds[convKey]);
            scheduleAutoScroll();
            // 节流标记已读
            debouncedMarkRead('group', groupId);
        } else if (msg.type === 'direct_recall') {
            const d = msg.data || {};
            const messageId = d.message_id || '';
            const fromUid = getFromUid(d); // from_ncuid = 撤回者NCUID
            const isMe = uidEq(fromUid, myUid);
            // 在当前会话中查找被撤回的消息
            if (currentConv && currentConv.type === 'direct') {
                const target = document.querySelector(`.message[data-msg-id="${CSS.escape(messageId)}"]`);
                if (target) {
                    const recallName = isMe ? '你' : (lookupName(fromUid) || fromUid);
                    const sep = createRecallSeparator(recallName, isMe ? target : null);
                    target.replaceWith(sep);
                    breakRecallChain(target, sep);
                }
                if (seenMsgIds[currentConv.key]) {
                    seenMsgIds[currentConv.key].delete(messageId);
                }
            }
        } else if (msg.type === 'group_recall') {
            const d = msg.data || {};
            const messageId = d.message_id || '';
            const groupId = d.group_id || '';
            const fromUid = getFromUid(d); // from_ncuid = 撤回者NCUID
            const isMe = uidEq(fromUid, myUid);
            const convKey = `group:${groupId}`;
            if (currentConv && currentConv.key === convKey) {
                const target = document.querySelector(`.message[data-msg-id="${CSS.escape(messageId)}"]`);
                if (target) {
                    const recallName = isMe ? '你' : (lookupName(fromUid) || fromUid);
                    const sep = createRecallSeparator(recallName, isMe ? target : null);
                    target.replaceWith(sep);
                    breakRecallChain(target, sep);
                }
            }
            if (seenMsgIds[convKey]) {
                seenMsgIds[convKey].delete(messageId);
            }
        } else if (msg.type === 'direct_read') {
            // 对方已读，可选更新已读回执（此处仅记录日志）
            // d: {thread_id, reader_uid, read_at}
        } else if (msg.type === 'typing') {
            const d = msg.data || {};
            // 服务器实际格式：{ chat_id, uid, is_group, is_typing }
            // 不是 { from_uid, from_ncuid, group_id }
            const fromUid = d.uid || getFromUid(d);
            console.log('[TYPING] received', fromUid, 'self?', isSelfUid(fromUid), 'currentConv:', currentConv?.key);
            if (!fromUid || isSelfUid(fromUid)) return;
            // 聊天类型判断：is_group 为 true 时是群聊，否则是私聊
            const isGroup = d.is_group === true || !!d.group_id;
            let convKey;
            if (isGroup) {
                const groupId = d.chat_id || d.group_id || '';
                convKey = `group:${groupId}`;
            } else {
                // 私聊 - 使用 uidEq 比较 fromUid 与 currentConv.id，避免格式差异导致匹配失败
                if (currentConv && currentConv.type === 'direct' && uidEq(fromUid, currentConv.id)) {
                    convKey = currentConv.key;
                } else {
                    convKey = `direct:${fromUid}`;
                }
            }
            console.log('[TYPING] convKey:', convKey, 'match:', currentConv?.key === convKey);
            // 仅显示当前会话的 typing 指示器
            if (!currentConv || currentConv.key !== convKey) return;
            const fromName = d.uid ? lookupName(fromUid) : (getFromName(d) || lookupName(fromUid));
            const fromAvatar = getFromAvatar(d);
            // 显示 typing 指示器，5 秒后自动隐藏
            showTypingIndicator(convKey, {
                uid: fromUid,
                name: fromName,
                avatar: fromAvatar
            }, 5000);
        }
    }

    // ===== Typing 指示器 =====
    const typingIndicator = document.getElementById('typingIndicator');

    function showTypingIndicator(convKey, user, timeoutMs) {
        if (!typingIndicator) { console.log('[TYPING] indicator element not found'); return; }
        console.log('[TYPING] showTypingIndicator', convKey, user.name, 'timeout:', timeoutMs);
        // 更新或添加用户到 typingUsers
        if (typingUsers.has(convKey)) {
            const existing = typingUsers.get(convKey);
            clearTimeout(existing.timer);
        }
        const timer = setTimeout(() => {
            hideTypingIndicator(convKey);
        }, timeoutMs || 5000);
        typingUsers.set(convKey, { ...user, timer });
        // 渲染：只显示小头像 + 动态点
        typingIndicator.innerHTML = '';
        const avatar = document.createElement('img');
        avatar.className = 'typing-avatar';
        let avatarUrl = user.avatar
            ? cachedResolveMediaUrl(user.avatar)
            : cachedResolveMediaUrl(lookupAvatar(user.uid) || 'assets/default-avatar.png');
        avatar.src = avatarUrl || 'assets/default-avatar.png';
        avatar.alt = user.name || '';
        avatar.onerror = () => { avatar.onerror = null; avatar.src = 'assets/default-avatar.png'; };
        typingIndicator.appendChild(avatar);
        const dots = document.createElement('span');
        dots.className = 'typing-dots';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('span');
            dots.appendChild(dot);
        }
        typingIndicator.appendChild(dots);
        typingIndicator.style.display = 'flex';
    }

    function hideTypingIndicator(convKey) {
        if (!typingIndicator) return;
        if (convKey && typingUsers.has(convKey)) {
            const entry = typingUsers.get(convKey);
            clearTimeout(entry.timer);
            typingUsers.delete(convKey);
        }
        // 如果当前会话没有其他 typing 用户，隐藏指示器
        if (!currentConv || !typingUsers.has(currentConv.key)) {
            typingIndicator.style.display = 'none';
            typingIndicator.innerHTML = '';
        } else {
            // 还有其他用户，重新渲染
            const entry = typingUsers.get(currentConv.key);
            showTypingIndicator(currentConv.key, entry, 5000);
        }
    }

    // 发送 Typing 状态到服务器（节流 3 秒）
    async function sendTypingStatus() {
        if (!currentConv || !ws || ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now - lastTypingSent < TYPING_THROTTLE) return;
        lastTypingSent = now;
        const payload = { type: 'typing', data: {} };
        if (currentConv.type === 'group') {
            payload.data.chat_id = currentConv.id;
            payload.data.is_group = true;
        } else {
            payload.data.chat_id = currentConv.id;
            payload.data.is_group = false;
        }
        payload.data.uid = myUid || myDisplayUid || '';
        payload.data.is_typing = true;
        await encryptAndSendWs(payload);
    }

    function renderContacts() {
        // 聊天列表（原有）
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
                const div = createContactItem(f.uid, f.name, 'direct', f.avatar, f.displayUid, f.user_title);
            contactList.appendChild(div);
        });
    }
    // 联系人页面
        renderContactsPage();
    }

    async function renderContactsPage() {
        const groupList = document.getElementById('contactsGroupList');
        const friendList = document.getElementById('contactsFriendList');
        const reqList = document.getElementById('friendRequestsList');
        const mainContent = document.getElementById('contactsMainContent');
        if (!groupList || !friendList) return;

        // 群聊
        groupList.innerHTML = '';
        contacts.groups.forEach(g => {
            const div = createContactItem(g.id, g.name, 'group', g.avatar);
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                showContactDetail('group', g.id, g.name, g.avatar, mainContent);
            });
            groupList.appendChild(div);
        });
        if (contacts.groups.length === 0) {
            groupList.innerHTML = '<div style="padding:12px 15px;font-size:12px;color:var(--secondary-text);">暂无群聊</div>';
        }

        // 好友
        friendList.innerHTML = '';
        contacts.friends.forEach(f => {
            const div = createContactItem(f.uid, f.name, 'direct', f.avatar, f.displayUid, f.user_title);
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                showContactDetail('direct', f.uid, f.name, f.avatar, mainContent);
            });
            friendList.appendChild(div);
        });
        if (contacts.friends.length === 0) {
            friendList.innerHTML = '<div style="padding:12px 15px;font-size:12px;color:var(--secondary-text);">暂无好友</div>';
        }

        // 好友申请
        if (reqList) {
            await loadFriendRequests(reqList);
        }
    }

    function showContactDetail(type, id, name, avatar, container) {
        if (!container) return;
        // 高亮左侧选中
        document.querySelectorAll('.sidebar-panel[data-panel="contacts"] .contact-item').forEach(ci => ci.classList.remove('active'));
        const convKey = type + ':' + id;
        const target = document.querySelector(`.sidebar-panel[data-panel="contacts"] [data-conv-key="${convKey}"]`);
        if (target) target.classList.add('active');

        const avatarUrl = avatar ? cachedResolveMediaUrl(avatar) : 'assets/default-avatar.png';
        if (type === 'group') {
            const group = contacts.groups.find(g => g.id === id);
            container.innerHTML = `
                <div class="contacts-detail-panel">
                    <div class="contacts-detail-header">
                        <img src="${avatarUrl}" onerror="this.src='assets/default-avatar.png'">
                        <div class="detail-name">${escapeHtml(name)}</div>
                        <div class="detail-uid">群ID: ${escapeHtml(id)}</div>
                        ${group && group.member_count ? `<div style="font-size:12px;color:var(--secondary-text);margin-bottom:8px;">${group.member_count} 位成员</div>` : ''}
                        <div class="contacts-detail-actions">
                            <button class="btn primary" id="cdSendMessage">发消息</button>
                            <button class="btn" id="cdGroupManage">群管理</button>
                        </div>
                    </div>
                </div>
            `;
            container.querySelector('#cdSendMessage')?.addEventListener('click', () => {
                switchConversation('group', id, name);
                switchTab('chat');
            });
            container.querySelector('#cdGroupManage')?.addEventListener('click', () => {
                openGroupManagePanel(id, name);
            });
        } else {
            const friend = contacts.friends.find(f => f.uid === id);
            const displayId = friend ? friend.displayUid : id;
            const titleText = (friend && friend.user_title) || lookupTitle(id);
            const titleHtml = titleText ? `<span class="detail-title">${escapeHtml(titleText)}</span>` : '';
            container.innerHTML = `
                <div class="contacts-detail-panel">
                    <div class="contacts-detail-header">
                        <img src="${avatarUrl}" onerror="this.src='assets/default-avatar.png'">
                        <div class="detail-name-row">
                            <div class="detail-name-center">
                                <span class="detail-name">${escapeHtml(name)}</span>
                            </div>
                            ${titleHtml}
                        </div>
                        <div class="detail-uid">${escapeHtml(displayId)}</div>
                        <div class="contacts-detail-actions">
                            <button class="btn primary" id="cdSendMessage">发消息</button>
                            <button class="btn" id="cdViewSpace">查看主页</button>
                        </div>
                    </div>
                </div>
            `;
            container.querySelector('#cdSendMessage')?.addEventListener('click', () => {
                switchConversation('direct', id, name);
                switchTab('chat');
            });
            container.querySelector('#cdViewSpace')?.addEventListener('click', () => {
                openSpacePanel(id);
            });
        }
    }

    async function loadFriendRequests(container) {
        container.innerHTML = '<div style="padding:8px 15px;font-size:12px;color:var(--secondary-text);">加载中...</div>';
        try {
            const res = await apiFetch('/v1/friends/requests');
            const data = await res.json();
            const requests = (data.requests || []).filter(r => r.status === 0 || r.status === 'pending');
            container.innerHTML = '';
            if (requests.length === 0) {
                container.innerHTML = '<div style="padding:8px 15px;font-size:12px;color:var(--secondary-text);">暂无新申请</div>';
                return;
            }
            requests.forEach(req => {
                const item = document.createElement('div');
                item.className = 'friend-request-item';
                const avatar = req.avatar_url || req.from_avatar || 'assets/default-avatar.png';
                const name = req.from_display_name || req.from_name || req.display_name || req.from_username || getUid(req) || '未知用户';
                item.innerHTML = `
                    <img class="contact-avatar" src="${cachedResolveMediaUrl(avatar)}" onerror="this.src='assets/default-avatar.png'">
                    <div class="friend-request-info">
                        <div class="name">${escapeHtml(name)}</div>
                        <div class="uid">${escapeHtml(getUid(req) || req.from_uid || '')}</div>
                    </div>
                    <div class="friend-request-actions">
                        <button class="accept-btn" data-req-id="${req.id}">同意</button>
                        <button class="reject-btn" data-req-id="${req.id}">拒绝</button>
                    </div>
                `;
                item.querySelector('.accept-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await respondFriendRequest(req.id, true, container);
                });
                item.querySelector('.reject-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await respondFriendRequest(req.id, false, container);
                });
                item.addEventListener('click', () => {
                    if (getUid(req)) openSpacePanel(getUid(req));
                });
                container.appendChild(item);
            });
        } catch (e) {
            console.error('[friends/requests]', e);
            container.innerHTML = '<div style="padding:8px 15px;font-size:12px;color:var(--secondary-text);">加载失败</div>';
        }
    }

    async function respondFriendRequest(requestId, accept, container) {
        try {
            const res = await apiFetch('/v1/friends/respond', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: requestId, accept })
            });
            const data = await res.json();
            if (data.error) { showAlert(data.error); return; }
            // 刷新
            loadContacts();
        } catch (e) { showAlert('操作失败'); }
    }

    // 添加好友/加入群聊 弹窗
    const addFriendBtn = document.getElementById('addFriendBtn');
    if (addFriendBtn) {
        addFriendBtn.addEventListener('click', () => openAddPanel());
    }

    function openAddPanel() {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-family:inherit;';
        overlay.innerHTML = `
            <div style="background:var(--panel-bg);color:var(--text);width:340px;max-width:90vw;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <div style="background:var(--header-bg);color:#fff;padding:13px 16px;display:flex;align-items:center;font-size:15px;font-weight:500;position:relative;">
                    <span style="width:100%;text-align:center;">添加</span>
                    <button id="ap-close" style="position:absolute;right:10px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="padding:16px;">
                    <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--border-color);">
                        <button class="ap-tab active" data-tab="friend" style="flex:1;padding:10px;background:none;border:none;color:var(--text);font-size:14px;cursor:pointer;border-bottom:2px solid var(--header-bg);font-family:inherit;">添加好友</button>
                        <button class="ap-tab" data-tab="group" style="flex:1;padding:10px;background:none;border:none;color:var(--secondary-text);font-size:14px;cursor:pointer;border-bottom:2px solid transparent;font-family:inherit;">加入群聊</button>
                    </div>
                    <div id="ap-friend" class="ap-panel">
                        <input id="ap-friend-input" type="text" placeholder="请输入对方 UID 或 NCUID" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;margin-bottom:12px;">
                        <button id="ap-friend-btn" style="width:100%;padding:10px;border-radius:8px;border:none;background:var(--header-bg);color:#fff;font-size:14px;cursor:pointer;font-family:inherit;">发送好友请求</button>
                    </div>
                    <div id="ap-group" class="ap-panel" style="display:none;">
                        <input id="ap-group-input" type="text" placeholder="请输入群聊 ID" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;margin-bottom:12px;">
                        <button id="ap-group-btn" style="width:100%;padding:10px;border-radius:8px;border:none;background:var(--header-bg);color:#fff;font-size:14px;cursor:pointer;font-family:inherit;">加入群聊</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const closeBtn = overlay.querySelector('#ap-close');
        function close() { overlay.remove(); }
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        // Tab 切换
        overlay.querySelectorAll('.ap-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                overlay.querySelectorAll('.ap-tab').forEach(t => {
                    t.classList.remove('active');
                    t.style.color = 'var(--secondary-text)';
                    t.style.borderBottom = '2px solid transparent';
                });
                tab.classList.add('active');
                tab.style.color = 'var(--text)';
                tab.style.borderBottom = '2px solid var(--header-bg)';
                const which = tab.dataset.tab;
                overlay.querySelector('#ap-friend').style.display = which === 'friend' ? 'block' : 'none';
                overlay.querySelector('#ap-group').style.display = which === 'group' ? 'block' : 'none';
            });
        });

        // 添加好友
        const friendBtn = overlay.querySelector('#ap-friend-btn');
        friendBtn.addEventListener('click', async () => {
            const val = overlay.querySelector('#ap-friend-input').value.trim();
            if (!val) { showAlert('请输入对方 UID 或 NCUID'); return; }
            friendBtn.disabled = true;
            friendBtn.textContent = '发送中...';
            try {
                const r = await apiFetch('/v1/friends/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(toUidParam(val))
                });
                const d = await r.json();
                if (d.error) { showAlert(d.error); }
                else { showAlert('好友请求已发送'); close(); }
            } catch (e) { showAlert('请求失败'); }
            friendBtn.disabled = false;
            friendBtn.textContent = '发送好友请求';
        });

        // 加入群聊
        const groupBtn = overlay.querySelector('#ap-group-btn');
        groupBtn.addEventListener('click', async () => {
            const val = overlay.querySelector('#ap-group-input').value.trim();
            if (!val) { showAlert('请输入群聊 ID'); return; }
            groupBtn.disabled = true;
            groupBtn.textContent = '加入中...';
            try {
                const r = await apiFetch('/v1/groups/join', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ group_id: val })
                });
                const d = await r.json();
                if (d.error || d.code) { showAlert(d.error || '加入失败'); }
                else { showAlert('已加入群聊'); close(); loadContacts(); }
            } catch (e) { showAlert('请求失败'); }
            groupBtn.disabled = false;
            groupBtn.textContent = '加入群聊';
        });
    }

    function createContactItem(id, name, type, avatar, displayId, userTitle) {
        const div = document.createElement('div');
        div.className = 'contact-item';
        div.dataset.convKey = type + ':' + id;
        div.dataset.type = type;
        div.dataset.id = id;
        div.dataset.name = name;
        // 群聊显示 group_id，私聊显示给人看的 displayId（旧UID），未提供则不显示
        const showId = type === 'group' ? id : (displayId || '');
        const idLine = showId ? `<div class="uid">${escapeHtml(showId)}</div>` : '';
        const avatarUrl = avatar ? cachedResolveMediaUrl(avatar) : 'assets/default-avatar.png';
        // 查找称号：优先使用传入的 userTitle，再从缓存查找
        const titleText = userTitle || lookupTitle(id);
        const titleHtml = titleText ? `<span class="contact-title">${escapeHtml(titleText)}</span>` : '';
        div.innerHTML = `<img class="contact-avatar" src="${avatarUrl}" onerror="this.src='assets/default-avatar.png'"><div class="contact-info"><div class="name">${escapeHtml(name)}${titleHtml}</div>${idLine}</div><span class="unread-badge" style="display:none;"></span>`;
        div.addEventListener('click', (e) => switchConversation(type, id, name, e));
        return div;
    }

    // ===== 会话消息缓存 =====

    // 缓存当前会话的 DOM 和状态
    function cacheCurrentConversation() {
        const key = currentConv?.key;
        if (!key) return;
        // 将当前所有 DOM 节点移入 DocumentFragment（保持事件监听器）
        const fragment = document.createDocumentFragment();
        while (messagesContainer.firstChild) {
            fragment.appendChild(messagesContainer.firstChild);
        }
        convCache[key] = {
            fragment,
            scrollTop: messagesContainer.scrollTop,
            seenMsgIds: seenMsgIds[key] ? new Set(seenMsgIds[key]) : new Set(),
            offset: convOffset[key] || 0,
            hasMore: convHasMore[key] !== false,
            lastTs: lastRenderedTs || 0
        };
        // 移除滚动监听
        if (messagesContainer._scrollHandler) {
            messagesContainer.removeEventListener('scroll', messagesContainer._scrollHandler);
            messagesContainer._scrollHandler = null;
        }
    }

    // 从缓存恢复会话
    function restoreConversation(key) {
        const cached = convCache[key];
        if (!cached) return false;
        // 检查缓存 fragment 是否为空（可能因竞态条件导致空缓存）
        if (!cached.fragment || cached.fragment.childNodes.length === 0) {
            delete convCache[key];
            return false;
        }
        // 恢复缓存的 DOM
        messagesContainer.appendChild(cached.fragment);
        // 恢复底部锚点
        if (messagesContainer.lastChild !== scrollAnchor) {
            messagesContainer.appendChild(scrollAnchor);
        }
        // 恢复滚动位置（同步设置，不依赖 rAF，避免与 switchConversation 中的 scrollToBottom 冲突）
        messagesContainer.scrollTop = cached.scrollTop;
        // 恢复状态
        seenMsgIds[key] = cached.seenMsgIds;
        convOffset[key] = cached.offset;
        convHasMore[key] = cached.hasMore;
        lastRenderedTs = cached.lastTs;
        // 重建 lastRenderedMsg（用于连续消息检测）
        const lastMsgEl = messagesContainer.querySelector('.message:last-child');
        lastRenderedMsg = lastMsgEl ? {
            convKey: key,
            from_uid: lastMsgEl.dataset.fromUid || '',
            element: lastMsgEl
        } : null;
        return true;
    }

    // 后台拉取最新消息（带请求 ID 防竞态）
    // 同步完成后丢弃旧缓存，用最新消息重建 DOM，只缓存最新一页
    let fetchLatestReqId = 0;
    async function fetchLatestMessages(type, id, convKey) {
        const PAGE_SIZE = 30;
        const reqId = ++fetchLatestReqId;
        // 显示同步中指示器
        if (syncIndicator) syncIndicator.style.display = '';
        try {
            // 私聊历史：API 使用 ?with_ncuid= 参数传 NCUID
            const historyUrl = type === 'group'
                ? `/v1/groups/messages/v2?group_id=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=0`
                : `/v1/direct/messages/v2?with_ncuid=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=0`;
            const res = await apiFetch(historyUrl);
            const data = await res.json();
            if (data.error) {
                console.error('[FETCH] API error for', historyUrl, data.error);
                return;
            }
            // 检查是否已切换会话或该请求已过期
            if (reqId !== fetchLatestReqId || currentConv?.key !== convKey) return;

            // ASC 顺序
            const msgs = (data.messages || []).slice().reverse();

            // ====== 增量更新：检查是否已有缓存 DOM，尝试增量追加新消息 ======
            const existingMsgEls = messagesContainer.querySelectorAll('.message[data-msg-id]');
            const existingIds = new Set();
            existingMsgEls.forEach(el => { if (el.dataset.msgId) existingIds.add(el.dataset.msgId); });

            const newMsgs = msgs.filter(m => m.id && !existingIds.has(m.id));

            // 已有消息且无新消息：直接保留当前 DOM，仅更新状态
            if (existingMsgEls.length > 0 && newMsgs.length === 0) {
                convOffset[convKey] = msgs.length;
                convHasMore[convKey] = msgs.length >= PAGE_SIZE;
                // 更新缓存
                delete convCache[convKey];
                if (currentConv?.key) {
                    const frag = document.createDocumentFragment();
                    Array.from(messagesContainer.children).forEach(el => frag.appendChild(el.cloneNode(true)));
                    convCache[currentConv.key] = {
                        fragment: frag,
                        scrollTop: messagesContainer.scrollTop,
                        seenMsgIds: seenMsgIds[currentConv.key] ? new Set(seenMsgIds[currentConv.key]) : new Set(),
                        offset: convOffset[currentConv.key] || 0,
                        hasMore: convHasMore[currentConv.key] !== false,
                        lastTs: lastRenderedTs || 0
                    };
                }
                return;
            }

            // 已有消息且有新消息：增量追加
            if (existingMsgEls.length > 0 && newMsgs.length > 0) {
                // 检查新消息是否在现有消息之后（简单验证：第一条现有消息在 msgs 中的位置）
                const firstExisting = existingMsgEls[0].dataset.msgId;
                const firstExistingIdx = msgs.findIndex(m => m.id === firstExisting);

                if (firstExistingIdx >= 0) {
                    // 找到重叠点，确定需要追加的消息
                    const existingIdSet = new Set();
                    existingMsgEls.forEach(el => { if (el.dataset.msgId) existingIdSet.add(el.dataset.msgId); });

                    // 追加新消息到末尾
                    newMsgs.forEach(msg => {
                        if (reqId !== fetchLatestReqId || currentConv?.key !== convKey) return;
                        appendMessage(msg, convKey, seenMsgIds[convKey] || new Set());
                    });

                    // 更新连续消息标记
                    const allMsgEls = messagesContainer.querySelectorAll('.message');
                    const existingLastIdx = allMsgEls.length - newMsgs.length - 1;
                    if (existingLastIdx >= 0 && allMsgEls[existingLastIdx]) {
                        const prevEl = allMsgEls[existingLastIdx];
                        if (prevEl.classList.contains('consecutive') || prevEl.classList.contains('consecutive-first')) {
                            prevEl.classList.add('consecutive-last');
                            const lastNew = allMsgEls[existingLastIdx + 1];
                            if (lastNew) {
                                lastNew.classList.remove('consecutive-last');
                                if (prevEl.dataset.fromUid === lastNew.dataset.fromUid) {
                                    lastNew.classList.add('consecutive');
                                }
                            }
                        }
                    }

                    // 更新状态
                    convOffset[convKey] = msgs.length;
                    convHasMore[convKey] = msgs.length >= PAGE_SIZE;

                    // 平滑滚动到新消息位置
                    scrollToBottom(true, true);

                    // 缓存最新 DOM
                    delete convCache[convKey];
                    if (currentConv?.key) {
                        const frag = document.createDocumentFragment();
                        Array.from(messagesContainer.children).forEach(el => frag.appendChild(el.cloneNode(true)));
                        convCache[currentConv.key] = {
                            fragment: frag,
                            scrollTop: messagesContainer.scrollTop,
                            seenMsgIds: seenMsgIds[currentConv.key] ? new Set(seenMsgIds[currentConv.key]) : new Set(),
                            offset: convOffset[currentConv.key] || 0,
                            hasMore: convHasMore[currentConv.key] !== false,
                            lastTs: lastRenderedTs || 0
                        };
                    }
                    return;
                }
            }

            // ====== 完整重建路径（无缓存/无新消息/消息顺序异常） ======
            // 重建期间隐藏容器，避免清空容器导致 scrollTop 跳转到顶部
            messagesContainer.style.visibility = 'hidden';
            // 清空容器
            messagesContainer.innerHTML = '';
            // 重置渲染状态
            lastRenderedMsg = null;
            lastRenderedTs = 0;
            // 重置该会话的已见集合
            if (seenMsgIds[convKey]) {
                delete seenMsgIds[convKey];
            }
            if (!seenMsgIds[convKey]) {
                seenMsgIds[convKey] = new Set();
            }
            const currentSeen = seenMsgIds[convKey];

            // 重新渲染所有消息（时间分隔符会基于消息时间戳重新计算，不会错位）
            msgs.forEach(msg => {
                if (reqId !== fetchLatestReqId || currentConv?.key !== convKey) return;
                appendMessage(msg, convKey, currentSeen);
            });

            // 渲染完成后，标记最后一条连消息为末尾
            if (lastRenderedMsg && lastRenderedMsg.element) {
                const el = lastRenderedMsg.element;
                if (el.classList.contains('consecutive') || el.classList.contains('consecutive-first')) {
                    el.classList.add('consecutive-last');
                }
            }

            // 再次检查
            if (reqId !== fetchLatestReqId || currentConv?.key !== convKey) return;

            // 更新状态
            convOffset[convKey] = msgs.length;
            convHasMore[convKey] = msgs.length >= PAGE_SIZE;

            // 先滚动到底部，再缓存（确保缓存中的 scrollTop 是底部位置）
            scrollToBottom(true);

            // 丢弃旧缓存，缓存最新渲染的 DOM（只缓存最新一页）
            // 注意：不能调用 cacheCurrentConversation()，它会清空容器
            delete convCache[convKey];
            if (currentConv?.key) {
                const frag = document.createDocumentFragment();
                Array.from(messagesContainer.children).forEach(el => frag.appendChild(el.cloneNode(true)));
                convCache[currentConv.key] = {
                    fragment: frag,
                    scrollTop: messagesContainer.scrollTop,
                    seenMsgIds: seenMsgIds[currentConv.key] ? new Set(seenMsgIds[currentConv.key]) : new Set(),
                    offset: convOffset[currentConv.key] || 0,
                    hasMore: convHasMore[currentConv.key] !== false,
                    lastTs: lastRenderedTs || 0
                };
            }

            // 触发淡入动画，同时恢复可见性（动画从 opacity: 0 开始，不会闪）
            messagesContainer.classList.remove('fade-in');
            void messagesContainer.offsetWidth;
            messagesContainer.classList.add('fade-in');
            messagesContainer.style.visibility = '';

            // 重新附加滚动加载监听器
            attachScrollListener(type, id, convKey, PAGE_SIZE);

            // 标记已读
            if (type === 'group') {
                await apiFetch('/v1/groups/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ group_id: id }) });
            } else {
                await apiFetch('/v1/direct/read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(withUidParam(id)) });
            }
        } catch (e) {
            console.error(e);
        } finally {
            // 仅当此请求仍是最新的时才隐藏同步指示器
            if (reqId === fetchLatestReqId && syncIndicator) {
                syncIndicator.style.display = 'none';
            }
        }
    }

    // 附加滚动加载历史消息监听器（提取为独立函数，缓存/无缓存路径共用）
    function attachScrollListener(type, id, convKey, PAGE_SIZE) {
        // 移除旧的滚动监听
        if (messagesContainer._scrollHandler) {
            messagesContainer.removeEventListener('scroll', messagesContainer._scrollHandler);
        }
        messagesContainer._scrollHandler = async () => {
            updateScrollToBottomBtn();
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
                    : `/v1/direct/messages/v2?with_ncuid=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=${offset}`;
                const res = await apiFetch(olderUrl);
                const data = await res.json();
                console.log('[LOAD_MORE] response:', olderUrl, 'msgs:', (data.messages||[]).length);
                if (loadReqId !== isLoadingMoreReqId) return;
                if (data.error) {
                    console.error('[LOAD_MORE] API error:', data.error);
                    return;
                }

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
    }

    let _switchingConv = false;
    async function switchConversation(type, id, name, event) {
        // 防止快速双击导致并发切换
        if (_switchingConv) return;
        _switchingConv = true;
        try {
        // 切换会话时隐藏 typing 指示器（不清除 Map，保留其他会话的状态）
        if (typingIndicator) {
            typingIndicator.style.display = 'none';
            typingIndicator.innerHTML = '';
        }
        // 淡出动画
        messagesContainer.classList.remove('fade-in');
        messagesContainer.classList.add('fade-out');
        await new Promise(r => setTimeout(r, 100));

        // 缓存当前会话（此时容器已不可见，但 DOM 仍完整）
        cacheCurrentConversation();

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

        pendingQuote = null;
        quotePreview.style.display = 'none';

        // 移除淡出类
        messagesContainer.classList.remove('fade-out');

        // 尝试从缓存恢复（快速展示，随后 fetchLatestMessages 会重建 DOM 替换缓存）
        if (convCache[convKey]) {
            // 检查 restoreConversation 返回值：false 表示缓存无效（空 fragment 等），需走无缓存路径
            if (restoreConversation(convKey)) {
                // 立即滚动到底部，避免用户看到缓存 DOM 在顶部（restoreConversation 用 rAF 恢复 scrollTop，不够及时）
                scrollToBottom(true);
                // 后台拉取最新消息（会重建 DOM、替换缓存、淡入动画、滚动到底部）
                fetchLatestMessages(type, id, convKey);
                return;
            }
            // 缓存无效，删除缓存后继续走无缓存路径
            delete convCache[convKey];
        }

        // 无缓存：重置状态，直接调用 fetchLatestMessages（会显示同步中并加载）
        messagesContainer.innerHTML = '';
        lastRenderedMsg = null;
        lastRenderedTs = 0;
        convOffset[convKey] = 0;
        convHasMore[convKey] = true;
        if (seenMsgIds[convKey]) {
            delete seenMsgIds[convKey];
        }
        messagesContainer._scrollHandler && messagesContainer.removeEventListener('scroll', messagesContainer._scrollHandler);
        fetchLatestMessages(type, id, convKey);
        } finally {
            _switchingConv = false;
        }
    }

    /**
     * 根据消息数据创建 DOM 元素（不插入、不去重、不合并）
     */
    function createMessageElement(msg, convKey, currentSeen) {
        if (!msg || !msg.id) return null;

        const fromUid = getFromUid(msg) || msg.from_uid || msg.sender_uid || '';
        // 旧 uid（用于 ?uid= API 参数和联系人查找）
        const profileUid = msg.from_uid || msg.sender_uid || '';
        // ncuid（用于 ?ncuid= API 参数，?uid= 不接受 ncuid）
        const profileNcuid = msg.from_ncuid || msg.sender_ncuid || '';
        // 显示用 uid：优先用 from_uid（旧 uid），为兼容性也可用于联系人查找
        const displayUid = profileUid || fromUid;
        // API 查询用：ncuid 走 ?ncuid=，旧 uid 走 ?uid=
        const apiUid = profileUid || '';
        const apiNcuid = profileNcuid || '';
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
            const recallFrom = getFromUid(msg) || msg.from_uid || msg.sender_uid || '';
            const recallName = recallFrom.toUpperCase() === myUid.toUpperCase() ? '你' : (lookupName(recallFrom) || recallFrom || '');
            div.textContent = recallName ? recallName + ' 撤回了一条消息' : (msg.body || '[消息已撤回]');
            div.dataset.msgId = msg.id;
            div.dataset.msgType = 'recall';
            return div;
        }

        const isSelfByUid = isSelfUid(fromUid);
        const isSelfByFlag = msg.is_me === true || msg.isSelf === true;
        const isSelf = isSelfByUid || isSelfByFlag;

        // 共享 Profile 拉取：头像和名称共用同一个 Promise，避免重复请求
        let sharedProfilePromise = null;
        if (!isSelf && (apiUid || apiNcuid)) {
            sharedProfilePromise = fetchUserProfile(apiUid, apiNcuid);
        }

        const sender = isSelf ? (myName || '我') : (msg.from_name || msg.sender_name || msg.display_name || lookupName(displayUid) || displayUid || '未知用户');
        const time = new Date(msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false });
        let content = '';

        if (msgType === 'image') {
            const mediaUrl = msg.media_url || '';
            const imgEl = document.createElement('img');
            imgEl.src = cachedResolveMediaUrl(mediaUrl);
            imgEl.style.cssText = 'max-width:200px;max-height:200px;border-radius:8px;cursor:pointer;';
            imgEl.className = 'chat-image';
            imgEl.onclick = () => openImageViewer(imgEl);
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
                : (msg.from_avatar || msg.sender_avatar || msg.avatar_url || lookupAvatar(displayUid));
            const avatarImg = document.createElement('img');
            avatarImg.src = avatarUrl ? cachedResolveMediaUrl(avatarUrl) : 'assets/default-avatar.png';
            avatarImg.className = 'msg-avatar';
            avatarImg.onerror = () => { avatarImg.src = 'assets/default-avatar.png'; };
            if (sharedProfilePromise && !avatarUrl) {
                sharedProfilePromise.then(profile => {
                    if (profile && profile.avatar_url && avatarImg.isConnected) {
                        avatarImg.src = cachedResolveMediaUrl(profile.avatar_url);
                    } else if (!profile) {
                        scheduleProfileRetry(apiUid, apiNcuid, avatarImg, true);
                    }
                });
            }
            avatarImg.addEventListener('click', (e) => {
                e.stopPropagation();
                const uid = isSelf ? myUid : fromUid;
                const ncuid = isSelf ? '' : profileNcuid;
                if (uid || ncuid) openSpacePanel(uid, ncuid);
            });
            msgDiv.appendChild(avatarImg);

            if (sender) {
                const senderDiv = document.createElement('div');
                senderDiv.className = 'message-sender';
                senderDiv.textContent = sender;
                // 称号标签
                const titleText = lookupTitle(fromUid) || lookupTitle(displayUid) || '';
                if (titleText) {
                    const titleSpan = document.createElement('span');
                    titleSpan.className = 'sender-title';
                    titleSpan.textContent = titleText;
                    senderDiv.appendChild(titleSpan);
                }
                if (sharedProfilePromise && (sender === displayUid || sender === fromUid)) {
                    sharedProfilePromise.then(profile => {
                        if (profile && senderDiv.isConnected) {
                            senderDiv.childNodes[0].textContent = profile.display_name || profile.username || sender;
                            if (profile.user_title) {
                                let titleSpan = senderDiv.querySelector('.sender-title');
                                if (!titleSpan) {
                                    titleSpan = document.createElement('span');
                                    titleSpan.className = 'sender-title';
                                    senderDiv.appendChild(titleSpan);
                                }
                                titleSpan.textContent = profile.user_title;
                            }
                        } else if (!profile) {
                            scheduleProfileRetry(apiUid, apiNcuid, senderDiv, false);
                        }
                    });
                }
                msgDiv.appendChild(senderDiv);
            }

            // 解析 body 中的引用，在图片上方显示 quote-block
            let bodyData = null;
            try { bodyData = JSON.parse(msg.body || '{}'); } catch(e) {}
            if (bodyData && bodyData.quote) {
                const quote = bodyData.quote;
                const qb = document.createElement('div');
                qb.className = 'quote-block-image';
                qb.dataset.quotedId = quote.id || '';
                const qs = document.createElement('div');
                qs.className = 'quote-sender';
                qs.textContent = quote.from_name || '';
                const qt = document.createElement('div');
                qt.textContent = quote.text || '';
                qb.appendChild(qs);
                qb.appendChild(qt);
                msgDiv.appendChild(qb);
                msgDiv.classList.add('has-quote');
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
            content = `<video controls style="max-width:200px;"><source src="${cachedResolveMediaUrl(msg.media_url || '')}"></video>`;
        } else if (msgType === 'audio') {
            content = `<audio controls style="max-width:200px;" src="${cachedResolveMediaUrl(msg.media_url || '')}"></audio>`;
        } else if (msgType === 'resource' || msgType === 'file') {
            // 支持嵌套 v2 JSON body（如音乐分享等）+ 音频文件检测
            let fileName = '';
            let displayText = '';
            let fileUrl = msg.media_url || '';
            const audioRegex = /\.(mp3|m4a|aac|amr|wav|wave|ogg|opus|flac)$/i;

            if (msg.body && msg.body.trim().startsWith('{')) {
                try {
                    const obj = JSON.parse(msg.body);
                    if (obj.v === 2) {
                        displayText = escapeHtml(obj.text || '');
                        if (obj.quote) {
                            const quote = obj.quote;
                            displayText = `<div class="quote-block" data-quoted-id="${escapeHtml(quote.id || '')}">
                                <div class="quote-sender">${escapeHtml(quote.from_name || quote.from_ncuid || quote.from_uid || '')}</div>
                                <div>${escapeHtml(quote.text || '')}</div>
                            </div>` + (displayText ? `<div style="white-space: pre-wrap; word-break: break-word;">${displayText}</div>` : '');
                        }
                        if (obj.mentions && Array.isArray(obj.mentions)) {
                            obj.mentions.forEach(m => {
                                const name = m.name || m.uid || m.ncuid;
                                const regex = new RegExp(`@${escapeRegExp(name)}\u200B?`, 'g');
                                displayText = displayText.replace(regex,
                                    `<span class="mention-highlight" data-uid="${escapeHtml(m.ncuid || m.uid || '')}">@${escapeHtml(name)}</span>`);
                            });
                        }
                        displayText = displayText.replace(/\n/g, '<br>');
                        // 检查 v2 JSON 中的嵌套文件
                        if (obj.file) {
                            fileName = obj.file.name || obj.file.fileName || '';
                            fileUrl = obj.file.url || obj.file.media_url || fileUrl;
                        }
                    } else if (obj.fileName || obj.file_name || obj.name || obj.url) {
                        // 文件元数据 JSON（FileUploadUiTextUtil.buildBody 格式）
                        fileName = obj.fileName || obj.file_name || obj.name || '';
                        fileUrl = obj.url || obj.media_url || obj.download_url || fileUrl;
                    } else {
                        fileName = msg.body;
                    }
                } catch (e) {
                    fileName = msg.body;
                }
            } else {
                fileName = msg.body || '';
            }
            if (!fileName && fileUrl) {
                const urlParts = fileUrl.split('?')[0].split('/');
                fileName = decodeURIComponent(urlParts.pop()) || '文件';
            }

            // 检测是否为音频文件（按文件名或 URL 扩展名）
            const isAudio = audioRegex.test(fileName) || (fileUrl && audioRegex.test(fileUrl));

            if (isAudio && fileUrl) {
                // 音频文件：渲染为嵌套音频播放器
                const voiceHtml = `
                    <div class="voice-message" data-url="${fileUrl}">
                        <div class="voice-top-row">
                            <button class="voice-play-btn">▶</button>
                            <div class="voice-wave" data-url="${fileUrl}">
                                <div class="voice-wave-bg" style="width:0%"></div>
                                <div class="voice-wave-bars">${'<span></span>'.repeat(20)}</div>
                            </div>
                            <span class="voice-duration">0:00</span>
                        </div>
                        <audio preload="metadata" src="${cachedResolveMediaUrl(fileUrl)}"></audio>
                    </div>`;
                content = displayText
                    ? `<div style="margin-bottom:6px;white-space:pre-wrap;word-break:break-word;">${displayText}</div>${voiceHtml}`
                    : voiceHtml;
            } else {
                // 非音频：渲染为文件卡片
                const fileCardHtml = `<div class="file-card">
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(fileName)}</div>
                    </div>
                    <a href="${cachedResolveMediaUrl(fileUrl)}" target="_blank" class="file-download-btn">⬇</a>
                </div>`;
                content = displayText
                    ? `<div style="margin-bottom:6px;">${displayText}</div>${fileCardHtml}`
                    : fileCardHtml;
            }
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
                        <audio preload="metadata" src="${cachedResolveMediaUrl(msg.media_url)}"></audio>
                    </div>`;
            } else {
                const dur = (msg.duration_ms || 0) / 1000;
                const mins = Math.floor(dur / 60);
                const secs = Math.floor(dur % 60);
                const durStr = dur ? mins + ':' + (secs < 10 ? '0' : '') + secs : '0:00';
                content = `[语音 ${durStr}]`;
            }
        } else if (msg.media_url && msgType !== 'text') {
            // 未知消息类型但有 media_url：回退为文件下载链接
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
                        let textBody = escapeHtml(obj.text || '');
                        if (obj.quote) {
                            const quote = obj.quote;
                            quoteHtml = `
                                <div class="quote-block" data-quoted-id="${escapeHtml(quote.id || '')}">
                                    <div class="quote-sender">${escapeHtml(quote.from_name || quote.from_ncuid || quote.from_uid || '')}</div>
                                    <div>${escapeHtml(quote.text || '')}</div>
                                </div>`;
                        }
                        if (obj.mentions && Array.isArray(obj.mentions)) {
                            obj.mentions.forEach(m => {
                                const name = m.name || m.uid || m.ncuid;
                                const regex = new RegExp(`@${escapeRegExp(name)}\u200B?`, 'g');
                                textBody = textBody.replace(regex,
                                    `<span class="mention-highlight" data-uid="${escapeHtml(m.ncuid || m.uid || '')}">@${escapeHtml(name)}</span>`);
                            });
                        }
                        textBody = textBody.replace(/\n/g, '<br>');
                        // 检查 v2 JSON 中的嵌套文件（如音频文件）
                        let nestedFileHtml = '';
                        if (obj.file) {
                            const nFileName = obj.file.name || obj.file.fileName || '';
                            const nFileUrl = obj.file.url || obj.file.media_url || '';
                            const audioRe = /\.(mp3|m4a|aac|amr|wav|wave|ogg|opus|flac)$/i;
                            if (nFileUrl && (audioRe.test(nFileName) || audioRe.test(nFileUrl))) {
                                // 嵌套音频文件：渲染为音频播放器
                                nestedFileHtml = `
                                    <div class="voice-message" data-url="${nFileUrl}" style="margin-top:6px;">
                                        <div class="voice-top-row">
                                            <button class="voice-play-btn">▶</button>
                                            <div class="voice-wave" data-url="${nFileUrl}">
                                                <div class="voice-wave-bg" style="width:0%"></div>
                                                <div class="voice-wave-bars">${'<span></span>'.repeat(20)}</div>
                                            </div>
                                            <span class="voice-duration">0:00</span>
                                        </div>
                                        <audio preload="metadata" src="${cachedResolveMediaUrl(nFileUrl)}"></audio>
                                    </div>`;
                            } else if (nFileUrl) {
                                // 嵌套非音频文件：渲染为文件卡片
                                nestedFileHtml = `<div class="file-card" style="margin-top:6px;">
                                    <div class="file-info"><div class="file-name">${escapeHtml(nFileName || '文件')}</div></div>
                                    <a href="${cachedResolveMediaUrl(nFileUrl)}" target="_blank" class="file-download-btn">⬇</a>
                                </div>`;
                            }
                        }
                        content = quoteHtml + (textBody ? `<div style="white-space: pre-wrap; word-break: break-word;">${textBody}</div>` : '') + nestedFileHtml;
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
            : (msg.from_avatar || msg.sender_avatar || msg.avatar_url || lookupAvatar(displayUid));
        const avatarImg = document.createElement('img');
        avatarImg.src = avatarUrl ? cachedResolveMediaUrl(avatarUrl) : 'assets/default-avatar.png';
        avatarImg.className = 'msg-avatar';
        avatarImg.onerror = () => { avatarImg.src = 'assets/default-avatar.png'; };
        if (sharedProfilePromise && !avatarUrl) {
            sharedProfilePromise.then(profile => {
                if (profile && profile.avatar_url && avatarImg.isConnected) {
                    avatarImg.src = cachedResolveMediaUrl(profile.avatar_url);
                } else if (!profile) {
                    scheduleProfileRetry(apiUid, apiNcuid, avatarImg, true);
                }
            });
        }
        avatarImg.addEventListener('click', (e) => {
            e.stopPropagation();
            const uid = isSelf ? myUid : fromUid;
            const ncuid = isSelf ? '' : profileNcuid;
            if (uid || ncuid) {
                openSpacePanel(uid, ncuid);
            }
        });
        msgDiv.appendChild(avatarImg);

        if (sender) {
            const senderDiv = document.createElement('div');
            senderDiv.className = 'message-sender';
            senderDiv.textContent = sender;
            // 称号标签
            const titleText = lookupTitle(fromUid) || lookupTitle(displayUid) || '';
            if (titleText) {
                const titleSpan = document.createElement('span');
                titleSpan.className = 'sender-title';
                titleSpan.textContent = titleText;
                senderDiv.appendChild(titleSpan);
            }
            if (sharedProfilePromise && (sender === displayUid || sender === fromUid)) {
                sharedProfilePromise.then(profile => {
                    if (profile && senderDiv.isConnected) {
                        senderDiv.childNodes[0].textContent = profile.display_name || profile.username || sender;
                        msgDiv.dataset.fromName = profile.display_name || profile.username || sender;
                        if (profile.user_title) {
                            let titleSpan = senderDiv.querySelector('.sender-title');
                            if (!titleSpan) {
                                titleSpan = document.createElement('span');
                                titleSpan.className = 'sender-title';
                                senderDiv.appendChild(titleSpan);
                            }
                            titleSpan.textContent = profile.user_title;
                        }
                    } else if (!profile) {
                        scheduleProfileRetry(apiUid, apiNcuid, senderDiv, false);
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

        // 阅后即焚支持
        let burnSeconds = 0;
        try {
            const parsed = JSON.parse(msg.body || '{}');
            burnSeconds = parsed.burn_after_seconds || msg.burn_after_seconds || 0;
        } catch (e) {
            burnSeconds = msg.burn_after_seconds || 0;
        }
        if (burnSeconds > 0) {
            msgDiv.classList.add('burn-message');
            bubble.style.setProperty('display', 'none', 'important');
            const burnHint = document.createElement('div');
            burnHint.className = 'burn-hint';
            burnHint.textContent = '阅后即焚';
            msgDiv.insertBefore(burnHint, timeDiv);
            burnHint.addEventListener('click', (e) => {
                e.stopPropagation();
                burnHint.style.display = 'none';
                bubble.style.removeProperty('display');
                msgDiv.classList.add('revealed');
                setTimeout(() => {
                    bubble.style.setProperty('display', 'none', 'important');
                    const recalled = document.createElement('div');
                    recalled.className = 'time-separator';
                    recalled.textContent = sender + ' 撤回了一条消息';
                    msgDiv.appendChild(recalled);
                    msgDiv.classList.add('burned');
                }, burnSeconds * 1000);
            });
        }

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
        // 安全检查：如果当前会话已切换，不追加消息（防止竞态条件导致消息显示在错误会话中）
        if (currentConv?.key !== convKey) return;
    
        if (!currentSeen) {
            if (!seenMsgIds[convKey]) seenMsgIds[convKey] = new Set();
            currentSeen = seenMsgIds[convKey];
        }
    
        if (currentSeen.has(msg.id)) {
            return;
        }

        const fromUid = getFromUid(msg) || msg.from_uid || '';
        const isPlainText = (msg.msg_type || 'text') === 'text' && !(msg.body || '').trim().startsWith('{');
        const msgTs = msg.created_at || 0;

        // 检查是否为连续消息（同发送者、5分钟内、同会话）
        // 使用 uidEq 兼容 uid/ncuid 两种格式
        const isConsecutive = lastRenderedMsg &&
            lastRenderedMsg.convKey === convKey &&
            uidEq(lastRenderedMsg.from_uid, fromUid) &&
            msgTs && lastRenderedTs && (msgTs - lastRenderedTs) <= 300;

        // 检查时间间隔，超过5分钟插入时间分隔符
        if (msgTs && lastRenderedTs && (msgTs - lastRenderedTs) > 300) {
            const sep = createTimeSeparator(msgTs);
            messagesContainer.appendChild(sep);
            if (messagesContainer.lastChild !== scrollAnchor) {
                messagesContainer.appendChild(scrollAnchor);
            }
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
            // 标记上一条消息为连续组的首条，移除其末尾标记
            if (lastRenderedMsg && lastRenderedMsg.element) {
                lastRenderedMsg.element.classList.add('consecutive-first');
                lastRenderedMsg.element.classList.remove('consecutive-last');
            }
        } else {
            // 非连续消息，标记上一条消息（如果存在）为连续组末尾
            if (lastRenderedMsg && lastRenderedMsg.element) {
                lastRenderedMsg.element.classList.remove('consecutive-first');
                if (lastRenderedMsg.element.classList.contains('consecutive')) {
                    lastRenderedMsg.element.classList.add('consecutive-last');
                }
            }
        }
    
        messagesContainer.appendChild(msgDiv);
        // 确保底部锚点始终在末尾，避免图片/长消息追加后锚点不在末尾导致滚动不到底
        if (messagesContainer.lastChild !== scrollAnchor) {
            messagesContainer.appendChild(scrollAnchor);
        }
    
        currentSeen.add(msg.id);
        // 系统/撤回消息打断连消息链
        if (msgDiv.classList.contains('time-separator')) {
            // 标记上一条消息为连消息末尾
            if (lastRenderedMsg && lastRenderedMsg.element) {
                lastRenderedMsg.element.classList.remove('consecutive-first');
                if (lastRenderedMsg.element.classList.contains('consecutive')) {
                    lastRenderedMsg.element.classList.add('consecutive-last');
                }
            }
            lastRenderedMsg = null;
            lastRenderedTs = 0;
            return;
        }
        // 临时消息（temp_开头）不更新 lastRenderedMsg，避免影响连消息判断
        if (!String(msg.id).startsWith('temp_')) {
            lastRenderedMsg = { convKey, from_uid: fromUid, element: msgDiv };
            lastRenderedTs = msgTs;
        }
    }

    // 确保底部锚点始终在容器末尾（innerHTML='' 或缓存移除后需重新挂载）
    function ensureScrollAnchor() {
        if (!scrollAnchor.isConnected || scrollAnchor.parentNode !== messagesContainer) {
            messagesContainer.appendChild(scrollAnchor);
        } else if (messagesContainer.lastChild !== scrollAnchor) {
            messagesContainer.appendChild(scrollAnchor);
        }
    }

    // 新消息自动滚动：合并去抖，避免短时间大量消息时反复判断造成跳帧或"判断到一半已不在底部"
    let _autoScrollTimer = null;
    let _autoScrollForce = false;
    function scheduleAutoScroll(force = false) {
        if (force) _autoScrollForce = true;
        if (_autoScrollTimer != null) return;
        _autoScrollTimer = setTimeout(() => {
            const f = _autoScrollForce;
            _autoScrollForce = false;
            _autoScrollTimer = null;
            scrollToBottom(f);
        }, 30);
    }

    function scrollToBottom(force = false, smooth = false) {
        const behavior = smooth ? 'smooth' : 'auto';
        ensureScrollAnchor();
        if (force) {
            // 强制滚动到底部（切换会话/发送消息后使用）
            requestAnimationFrame(() => {
                ensureScrollAnchor();
                if (smooth) {
                    try { scrollAnchor.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch(e) {}
                } else {
                    try { scrollAnchor.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch(e) {}
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }
                if (chatScrollbar) requestAnimationFrame(() => chatScrollbar.update());
                updateScrollToBottomBtn();
            });
            // 长消息/图片加载可能延迟，再补一次兜底
            setTimeout(() => {
                ensureScrollAnchor();
                if (smooth) {
                    try { scrollAnchor.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch(e) {}
                } else {
                    try { scrollAnchor.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch(e) {}
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }
                if (chatScrollbar) chatScrollbar.update();
                updateScrollToBottomBtn();
            }, 250);
            return;
        }
        // 只在用户已近底部时才自动滚动，避免强制拉到最下方
        const threshold = messagesContainer.clientHeight / 2;
        const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
        if (atBottom) {
            // 自动滚动使用平滑动画
            requestAnimationFrame(() => {
                ensureScrollAnchor();
                try { scrollAnchor.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch(e) {}
                if (chatScrollbar) requestAnimationFrame(() => chatScrollbar.update());
                updateScrollToBottomBtn();
            });
            setTimeout(() => {
                // 再检查一次：图片/长消息加载后仍在底部附近则继续对齐
                const t2 = messagesContainer.clientHeight / 2;
                const at2 = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < t2;
                if (at2) {
                    ensureScrollAnchor();
                    try { scrollAnchor.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch(e) {}
                    if (chatScrollbar) chatScrollbar.update();
                }
                updateScrollToBottomBtn();
            }, 250);
        }
    }

    // 点击引用块跳转到被引用的消息
    messagesContainer.addEventListener('click', function(e) {
        const quoteBlock = e.target.closest('.quote-block, .quote-block-image');
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


    async function sendMessage(body, msgType = 'text', mediaUrl = null, thumbUrl = null, burnAfterSeconds = 0) {
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
                    mentions.push({ uid: member.uid || member.ncuid || '', ncuid: member.ncuid || member.uid || '', name: member.name });
                }
            }
        }

        // 如果文本包含换行、引用或mentions，自动转成 v2 格式
        if (msgType === 'text' && (body.includes('\n') || mentions.length > 0) && !pendingQuote) {
            const v2Obj = { v: 2, text: body };
            if (mentions.length > 0) v2Obj.mentions = mentions;
            body = JSON.stringify(v2Obj);
        }
    
        if (pendingQuote && (msgType === 'text' ? body.trim() : mediaUrl)) {
            const quotePayload = {
                v: 2,
                text: msgType === 'text' ? body : '',
                quote: pendingQuote
            };
            if (mentions.length > 0) quotePayload.mentions = mentions;
            body = JSON.stringify(quotePayload);
        }
    
        const payload = currentConv.type === 'group'
            ? {
                group_id: currentConv.id,
                body: body,
                msg_type: msgType,
                media_url: mediaUrl || '',
                thumb_url: thumbUrl || ''
              }
            : Object.assign({
                body: body,
                msg_type: msgType,
                media_url: mediaUrl || '',
                thumb_url: thumbUrl || ''
              }, toUidParam(currentConv.id));
        if (burnAfterSeconds && burnAfterSeconds > 0) {
            payload.burn_after_seconds = burnAfterSeconds;
        }

        // 立即显示发送中消息（半透明）
        const tempId = 'temp_' + Date.now();
        const tempMsg = {
            id: tempId,
            from_uid: myDisplayUid,
            from_ncuid: myUid,
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
        scrollToBottom(true, true);

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
                        // 保留临时消息上的连消息 class
                        if (tempEl.classList.contains('consecutive')) newEl.classList.add('consecutive');
                        if (tempEl.classList.contains('consecutive-first')) newEl.classList.add('consecutive-first');
                        if (tempEl.classList.contains('consecutive-last')) newEl.classList.add('consecutive-last');
                        tempEl.replaceWith(newEl);
                        lastRenderedMsg = { convKey: currentConv.key, from_uid: getFromUid(msg) || msg.from_uid || '', element: newEl };
                        lastRenderedTs = msg.created_at || 0;
                    }
                    seenMsgIds[currentConv.key]?.delete(tempId);
                    seenMsgIds[currentConv.key]?.add(msg.id);
                } else {
                    appendMessage(msg, currentConv.key, seenMsgIds[currentConv.key]);
                    scrollToBottom(true, true);
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

        // 文本不为空时发送 Typing 状态
        if (val.trim() && currentConv) {
            sendTypingStatus();
        }
    });

    // @mention 弹窗逻辑
    const mentionPopup = document.getElementById('mentionPopup');
    const mentionSearch = document.getElementById('mentionSearch');
    const mentionList = document.getElementById('mentionList');
    let mentionMembers = [];
    let groupMembers = [];
    let mentionActiveIndex = 0;
    // 群成员缓存（大群优化）：group_id -> { members, ts }
    const groupMembersCache = new Map();
    const GROUP_MEMBERS_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

    // 后台刷新群成员缓存（不阻塞当前流程）
    // 大群优化：节流，防并发，最小刷新间隔 30 秒
    const _refreshGroupThrottle = new Map(); // groupId -> last refresh ts
    const _refreshGroupInFlight = new Map(); // groupId -> promise
    const GROUP_MEMBERS_REFRESH_INTERVAL = 30 * 1000; // 30 秒
    async function refreshGroupMembersCache(groupId) {
        if (!groupId) return;
        // 节流检查：30 秒内不重复刷新
        const lastRefresh = _refreshGroupThrottle.get(groupId) || 0;
        if (Date.now() - lastRefresh < GROUP_MEMBERS_REFRESH_INTERVAL) return;
        // 防并发：同一群的刷新请求不重复
        if (_refreshGroupInFlight.has(groupId)) return _refreshGroupInFlight.get(groupId);
        const promise = (async () => {
            try {
                const res = await apiFetch('/v1/groups/members?group_id=' + encodeURIComponent(groupId));
                const data = await res.json();
                const members = (data.members || []).map(m => ({
                    uid: m.uid || '',
                    ncuid: m.ncuid || getUid(m),
                    name: m.display_name || m.username || getUid(m),
                    avatar: m.avatar_url || ''
                }));
                _refreshGroupThrottle.set(groupId, Date.now());
                groupMembersCache.set(groupId, { members, ts: Date.now() });
                // 如果当前会话刚好是这个群，同步更新 mentionMembers
                if (currentConv && currentConv.type === 'group' && currentConv.id === groupId) {
                    groupMembers = members;
                    mentionMembers = members;
                }
            } catch (e) {}
            finally { _refreshGroupInFlight.delete(groupId); }
        })();
        _refreshGroupInFlight.set(groupId, promise);
        return promise;
    }

    async function loadGroupMembers() {
        if (!currentConv || currentConv.type !== 'group') return;
        const groupId = currentConv.id;
        const cached = groupMembersCache.get(groupId);
        if (cached && Date.now() - cached.ts < GROUP_MEMBERS_CACHE_TTL) {
            groupMembers = cached.members;
            mentionMembers = cached.members;
            return;
        }
        try {
            const res = await apiFetch('/v1/groups/members?group_id=' + encodeURIComponent(groupId));
            const data = await res.json();
            // Go 返回 {members: [{uid, username, display_name, avatar_url, role, joined_at}]}
            const members = (data.members || []).map(m => ({
                uid: m.uid || '',           // 旧 uid
                ncuid: m.ncuid || getUid(m), // ncuid（getUid 优先取 ncuid）
                name: m.display_name || m.username || getUid(m),
                avatar: m.avatar_url || ''
            }));
            groupMembers = members;
            mentionMembers = members;
            groupMembersCache.set(groupId, { members, ts: Date.now() });
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
            if (m.ncuid && m.ncuid.toLowerCase().includes(lower)) return true;
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
            item.innerHTML = `<img src="${cachedResolveMediaUrl(m.avatar || 'assets/default-avatar.png')}" onerror="this.src='assets/default-avatar.png'"><span class="mention-name">${escapeHtml(m.name)}</span>`;
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
    messageInput.addEventListener('paste', async (e) => {
        const items = (e.clipboardData || window.clipboardData).items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                e.preventDefault();
                const file = items[i].getAsFile();
                if (!file) continue;
                if (!currentConv) {
                    showAlert('请先选择一个会话');
                    return;
                }
                if (await showConfirm(`是否发送图片 "${file.name || '粘贴的图片'}"？`)) {
                    await uploadAndSend(file);
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
    if (sendEmoticonBtn) {
        sendEmoticonBtn.addEventListener('click', () => {
            showEmoticonPicker();
        });
    }

    // 阅后即焚弹窗
    const sendBurnBtn = document.getElementById('sendBurnBtn');
    const burnDialogOverlay = document.getElementById('burnDialogOverlay');
    const burnDialogCancel = document.getElementById('burnDialogCancel');
    const burnDialogSend = document.getElementById('burnDialogSend');
    const burnTimeSelect = document.getElementById('burnTimeSelect');
    const burnTextInput = document.getElementById('burnTextInput');

    if (sendBurnBtn) {
        sendBurnBtn.addEventListener('click', () => {
            burnTextInput.value = '';
            burnTimeSelect.value = '10';
            burnDialogOverlay.style.display = 'flex';
            burnTextInput.focus();
            moreMenu.classList.remove('show');
        });
    }
    if (burnDialogCancel) burnDialogCancel.addEventListener('click', () => { burnDialogOverlay.style.display = 'none'; });
    if (burnDialogOverlay) burnDialogOverlay.addEventListener('click', (e) => { if (e.target === burnDialogOverlay) burnDialogOverlay.style.display = 'none'; });
    if (burnDialogSend) {
        burnDialogSend.addEventListener('click', () => {
            const text = burnTextInput.value.trim();
            if (!text) { showAlert('请输入内容'); return; }
            const seconds = parseInt(burnTimeSelect.value) || 10;
            const burnPayload = { v: 2, text: text };
            sendMessage(JSON.stringify(burnPayload), 'text', null, null, seconds);
            burnDialogOverlay.style.display = 'none';
        });
    }

    // 红包弹窗
    const sendRedPacketBtn = document.getElementById('sendRedPacketBtn');
    const rpDialogOverlay = document.getElementById('redPacketDialogOverlay');
    const rpDialogCancel = document.getElementById('rpDialogCancel');
    const rpDialogSend = document.getElementById('rpDialogSend');
    const rpAmountInput = document.getElementById('rpAmountInput');
    const rpCountInput = document.getElementById('rpCountInput');
    const rpTitleInput = document.getElementById('rpTitleInput');

    if (sendRedPacketBtn) {
        sendRedPacketBtn.addEventListener('click', () => {
            if (!currentConv) { showAlert('请先选择会话'); return; }
            rpAmountInput.value = '';
            rpCountInput.value = '2';
            rpTitleInput.value = '恭喜发财';
            rpDialogOverlay.style.display = 'flex';
            rpAmountInput.focus();
            moreMenu.classList.remove('show');
        });
    }
    if (rpDialogCancel) rpDialogCancel.addEventListener('click', () => { rpDialogOverlay.style.display = 'none'; });
    if (rpDialogOverlay) rpDialogOverlay.addEventListener('click', (e) => { if (e.target === rpDialogOverlay) rpDialogOverlay.style.display = 'none'; });
    if (rpDialogSend) {
        rpDialogSend.addEventListener('click', async () => {
            if (!currentConv) { showAlert('请先选择会话'); return; }
            const amount = parseFloat(rpAmountInput.value);
            if (!amount || amount < 2) { showAlert('金额不能小于2'); return; }
            const count = parseInt(rpCountInput.value) || 1;
            if (count < 2) { showAlert('个数不能小于2'); return; }
            const title = rpTitleInput.value.trim() || '恭喜发财';
            try {
                const payload = { title: title, total_amount: amount, total_count: count };
                if (currentConv.type === 'group') {
                    payload.group_id = currentConv.id;
                } else {
                    Object.assign(payload, toUidParam(currentConv.id));
                }
                const res = await apiFetch('/v1/redpackets/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const text = await res.text();
                let data = {};
                try { data = JSON.parse(text); } catch (e) {}
                if (data.error) { showAlert(data.error); return; }
                rpDialogOverlay.style.display = 'none';
            } catch (e) { showAlert('发送失败'); }
        });
    }

    fileInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        const file = files[0];
        if (!await showConfirm(`是否发送文件 "${file.name}"？`)) return;
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
        if (!await showConfirm(`是否发送文件 "${file.name}" 到当前会话？`)) return;
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
            from_uid: myDisplayUid,
            from_ncuid: myUid,
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
        scrollToBottom(true, true);
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
                showAlert('上传失败: ' + (upData.error || '未知错误'));
                return;
            }
            // 第二步：发送消息（根据文件类型判断 msg_type）
            const fileName = (file.name || '').toLowerCase();
            let msgType = 'resource';
            if (/\.(jpg|jpeg|png|gif|webp)$/.test(fileName)) msgType = 'image';
            else if (/\.(mp4|3gp)$/.test(fileName)) msgType = 'video';
            else if (/\.(mp3|m4a|aac|amr|wav|wave)$/.test(fileName)) msgType = 'voice';

            let sendPayload = currentConv.type === 'group'
                ? { group_id: currentConv.id, body: '', msg_type: msgType, media_url: upData.url, thumb_url: upData.thumb_url || '' }
                : Object.assign({ body: '', msg_type: msgType, media_url: upData.url, thumb_url: upData.thumb_url || '' }, toUidParam(currentConv.id));
            // 如果编辑框有引用，自动附加到图片/文件消息
            if (pendingQuote) {
                sendPayload.body = JSON.stringify({ v: 2, text: '', quote: pendingQuote });
            }
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
                showAlert('发送失败: ' + (data.error || '未知错误'));
                return;
            }
            const msg = data;
            // 替换临时消息
            if (tempEl) {
                const newEl = createMessageElement(msg, currentConv.key, seenMsgIds[currentConv.key]);
                if (newEl) {
                    // 保留临时消息上的连消息 class
                    if (tempEl.classList.contains('consecutive')) newEl.classList.add('consecutive');
                    if (tempEl.classList.contains('consecutive-first')) newEl.classList.add('consecutive-first');
                    if (tempEl.classList.contains('consecutive-last')) newEl.classList.add('consecutive-last');
                    tempEl.replaceWith(newEl);
                    lastRenderedMsg = { convKey: currentConv.key, from_uid: getFromUid(msg) || msg.from_uid || '', element: newEl };
                    lastRenderedTs = msg.created_at || 0;
                }
            }
            // 发送成功后清除引用
            if (pendingQuote) {
                pendingQuote = null;
                quotePreview.style.display = 'none';
            }
            scrollToBottom(true, true);
        } catch (error) {
            console.error(error);
            if (tempEl) tempEl.remove();
            seenMsgIds[currentConv.key]?.delete(tempId);
            showAlert('网络错误，发送失败');
        }
    }

    document.addEventListener('contextmenu', (e) => {
        hideContextMenu();

        // 1. 编辑框（input/textarea）显示自绘右键菜单
        const editTarget = e.target.closest('input[type="text"], input[type="password"], input[type="search"], input[type="url"], input[type="email"], input:not([type]), textarea');
        if (editTarget) {
            e.preventDefault();
            showEditContextMenu(e, editTarget);
            return;
        }

        // 2. 聊天输入区域除输入框外禁止右键
        if (e.target.closest('.input-area')) {
            e.preventDefault();
            return;
        }

        // 3. 接管所有其他区域的系统右键行为
        e.preventDefault();

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
        
        // 优先判断是否点在消息头像上 —— 显示头像专属菜单
        const avatarEl = e.target.closest('.msg-avatar');
        if (avatarEl) {
            const msgDiv = avatarEl.closest('.message');
            const fromUid = msgDiv ? msgDiv.dataset.fromUid : '';
            const fromName = msgDiv ? msgDiv.dataset.fromName : '';
            const isOwn = fromUid && fromUid.toUpperCase() === myUid.toUpperCase();

            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';

            let menuHtml = '';
            if (!isOwn) {
                menuHtml = `
                    <div class="context-menu-item" data-action="mention">@ TA</div>
                    <div class="context-menu-item" data-action="profile">查看主页</div>
                    <div class="context-menu-divider"></div>
                    <div class="context-menu-item" data-action="copy-name">复制昵称</div>
                    <div class="context-menu-item" data-action="copy-uid">复制ID</div>
                `;
            } else {
                menuHtml = `
                    <div class="context-menu-item" data-action="profile">查看主页</div>
                    <div class="context-menu-divider"></div>
                    <div class="context-menu-item" data-action="copy-name">复制昵称</div>
                    <div class="context-menu-item" data-action="copy-uid">复制ID</div>
                `;
            }
            menu.innerHTML = menuHtml;
            document.body.appendChild(menu);
            requestAnimationFrame(() => menu.classList.add('show'));
            contextMenu = menu;

            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'mention') {
                    if (currentConv && currentConv.type === 'group' && !isOwn) {
                        const insertText = `@${fromName} `;
                        messageInput.value = (messageInput.value || '') + insertText;
                        messageInput.focus();
                    } else if (isOwn) {
                        openSpacePanel(fromUid);
                    } else {
                        // 单聊或非群聊：直接打开对方主页
                        openSpacePanel(fromUid);
                    }
                } else if (action === 'profile') {
                    if (isOwn) {
                        openSpacePanel(myUid);
                    } else {
                        openSpacePanel(fromUid);
                    }
                } else if (action === 'copy-name') {
                    const text = fromName || fromUid || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
                    } else {
                        fallbackCopyText(text);
                    }
                } else if (action === 'copy-uid') {
                    const text = fromUid || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
                    } else {
                        fallbackCopyText(text);
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

        // 其次判断是否在消息上 —— 显示消息菜单
        const msgDiv = e.target.closest('.message');
        if (msgDiv) {
            // 右键 mousedown 可能已清除选区，优先用 getSelection，回退到 mouseup 时保存的文本
            const sel = window.getSelection();
            const selectedText = (sel && sel.toString()) ? sel.toString() : lastSelectedText;
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
            // 图片消息额外增加"另存为"和"收藏为表情"
            const msgType = msgDiv.dataset.msgType;
            if (msgType === 'image') {
                menuHtml += `<div class="context-menu-item" data-action="save-image">另存为</div>`;
                menuHtml += `<div class="context-menu-item" data-action="collect-emoji">收藏为表情</div>`;
            }
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
                    // 根据消息类型获取复制内容
                    let textToCopy = selectedText || '';
                    if (!textToCopy) {
                        const msgType = msgDiv.dataset.msgType;
                        const rawMsg = JSON.parse(msgDiv.dataset.rawBody || '{}');
                        if (msgType === 'image') {
                            // 图片消息：先关闭菜单，再从DOM中复制图像
                            hideContextMenu();
                            const chatImg = msgDiv.querySelector('.chat-image');
                            if (chatImg && chatImg.complete && chatImg.naturalWidth > 0) {
                                try {
                                    const canvas = document.createElement('canvas');
                                    canvas.width = chatImg.naturalWidth;
                                    canvas.height = chatImg.naturalHeight;
                                    canvas.getContext('2d').drawImage(chatImg, 0, 0);
                                    canvas.toBlob(blob => {
                                        if (blob) {
                                            navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]).catch(() => {
                                                const url = rawMsg.media_url || '[图片]';
                                                navigator.clipboard.writeText(url).catch(() => fallbackCopyText(url));
                                            });
                                        } else {
                                            const url = rawMsg.media_url || '[图片]';
                                            navigator.clipboard.writeText(url).catch(() => fallbackCopyText(url));
                                        }
                                    });
                                } catch(e) {
                                    const url = rawMsg.media_url || '[图片]';
                                    navigator.clipboard.writeText(url).catch(() => fallbackCopyText(url));
                                }
                            } else {
                                const url = rawMsg.media_url || '[图片]';
                                navigator.clipboard.writeText(url).catch(() => fallbackCopyText(url));
                            }
                            return;
                        } else if (msgType === 'voice' || msgType === 'audio') {
                            // 语音消息：复制 media_url
                            textToCopy = rawMsg.media_url || '[语音]';
                        } else if (msgType === 'video') {
                            textToCopy = rawMsg.media_url || '[视频]';
                        } else if (msgType === 'resource' || msgType === 'file') {
                            // 文件消息：复制下载链接
                            textToCopy = rawMsg.media_url || rawMsg.body || '[文件]';
                        } else {
                            // 文本消息：复制气泡内文本
                            textToCopy = msgDiv.querySelector('.message-bubble')?.innerText || '';
                        }
                    }
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

                    // 先在本地替换 DOM（在 WebSocket 回调到达前生效），再发请求
                    const timeSep = createRecallSeparator('你', msgDiv);
                    msgDiv.replaceWith(timeSep);
                    breakRecallChain(msgDiv, timeSep);
                    seenMsgIds[currentConv.key]?.delete(msgId);

                    apiFetch(recallUrl, { method: 'DELETE' })
                        .then(r => r.json())
                        .then(d => {
                            if (d.error) {
                                showAlert(d.error || '撤回失败');
                            }
                        }).catch(() => showAlert('网络错误'));
                } else if (action === 'save-image') {
                    const chatImg = msgDiv.querySelector('.chat-image');
                    if (chatImg && chatImg.src) {
                        downloadImage(chatImg.src);
                    }
                } else if (action === 'collect-emoji') {
                    // 收藏为表情：保存相对路径（如 /v1/uploads/media/xxx.jpg）
                    const rawMsg = JSON.parse(msgDiv.dataset.rawBody || '{}');
                    const mediaPath = rawMsg.media_url || '';
                    if (!mediaPath) {
                        showAlert('该图片没有可用的链接');
                    } else if (!addCollectedEmoji(mediaPath)) {
                        showAlert('该表情已在收藏中');
                    } else {
                        showAlert('已收藏为表情');
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
    
        // 判断是否在用户空间/动态面板中的图片上
        const momentImg = e.target.closest('#sp-scroll img, #myProfileScroll img');
        if (momentImg) {
            e.preventDefault();
            const imgSrc = momentImg.src || '';
            if (!imgSrc) return;
            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.innerHTML = `
                <div class="context-menu-item" data-action="copy-img">复制图片</div>
                <div class="context-menu-item" data-action="save-img">另存为</div>
            `;
            document.body.appendChild(menu);
            requestAnimationFrame(() => menu.classList.add('show'));
            contextMenu = menu;

            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'copy-img') {
                    copyImageToClipboard(imgSrc);
                } else if (action === 'save-img') {
                    downloadImage(imgSrc);
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

        // 其次判断是否在聊天面板（data-panel="chat"）的空白处
        const chatPanel = e.target.closest('.main-panel[data-panel="chat"]');
        if (chatPanel) {
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
        try { document.execCommand('copy'); } catch (e) { showAlert('复制失败'); }
        selection.removeAllRanges();
    }

    function fallbackCopyText(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); } catch (e) { showAlert('复制失败'); }
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

    // transition 期间持续更新自绘滚动条位置，避免"跳走再跳回"
    let _scrollbarRAF = null;
    function animateScrollbarUpdate() {
        if (!chatScrollbar) return;
        if (_scrollbarRAF) cancelAnimationFrame(_scrollbarRAF);
        const start = performance.now();
        const tick = (now) => {
            chatScrollbar.update();
            if (now - start < 360) {
                _scrollbarRAF = requestAnimationFrame(tick);
            } else {
                _scrollbarRAF = null;
                chatScrollbar.update();
            }
        };
        _scrollbarRAF = requestAnimationFrame(tick);
    }

    function expandChat() {
        if (isMobile()) {
            chatArea.style.marginLeft = '0px';
        } else {
            chatArea.style.marginLeft = sidebar.classList.contains('collapsed') ? '0px' : '280px';
        }
        animateScrollbarUpdate();
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

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (!nowMobile && wasMobile) {
            // 从手机视图切换到PC，恢复侧边栏
            sidebar.classList.remove('collapsed');
            sidebarPinned = true;
            pinSidebarBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
            pinSidebarBtn.title = '取消固定';
        }
        wasMobile = nowMobile;
        expandChat();
    });

    mobileMenuBtn.addEventListener('click', () => {
        if (!isMobile()) return;
        sidebar.classList.remove('collapsed');
    });

    // 点击群聊标题进入群聊管理
    const chatTitleEl = chatHeader.querySelector('.chat-title');
    chatTitleEl.addEventListener('click', () => {
        if (currentConv && currentConv.type === 'group') {
            openGroupManagePanel(currentConv.id, currentConv.name);
        }
    });
    chatTitleEl.style.cssText = 'cursor:pointer;-webkit-app-region:no-drag;';

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
        if (!url) { showAlert('请输入链接'); return; }
        // URL 格式校验：允许 http(s) 开头或 / 开头的相对路径
        if (!/^https?:\/\//i.test(url) && !/^\//.test(url)) { showAlert('请输入有效的 http(s) 链接或相对路径'); return; }
        // 按 MCL0 官方文档：voice 消息使用 msg_type=voice + media_url，body 为空
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

    // ===== 收藏表情（我的收藏）=====
    const COLLECTED_EMOJI_KEY = 'oc_collected_emojis';
    function loadCollectedEmojis() {
        try {
            const raw = localStorage.getItem(COLLECTED_EMOJI_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.filter(Boolean) : [];
        } catch (e) { return []; }
    }
    function saveCollectedEmojis(list) {
        try { localStorage.setItem(COLLECTED_EMOJI_KEY, JSON.stringify(list)); } catch (e) {}
    }
    function addCollectedEmoji(path) {
        const list = loadCollectedEmojis();
        if (list.includes(path)) return false;
        list.push(path);
        saveCollectedEmojis(list);
        return true;
    }
    function removeCollectedEmoji(path) {
        saveCollectedEmojis(loadCollectedEmojis().filter(p => p !== path));
    }

    // 渲染收藏表情网格（输入框选择器与设置页共用）
    function renderCollectedEmojiGrid(container, onPick, onDelete) {
        const list = loadCollectedEmojis();
        container.innerHTML = '';
        if (list.length === 0) {
            container.innerHTML = '<div class="collected-emoji-empty">还没有收藏的表情<br>在图片消息上右键选择「收藏为表情」</div>';
            return;
        }
        list.forEach(path => {
            const item = document.createElement('div');
            item.className = 'emoticon-item collected-emoji-item';
            const img = document.createElement('img');
            img.src = cachedResolveMediaUrl(path);
            img.loading = 'lazy';
            img.onerror = () => { img.style.visibility = 'hidden'; };
            item.appendChild(img);
            if (onPick) {
                item.addEventListener('click', () => onPick(path));
            }
            if (onDelete) {
                const delBtn = document.createElement('button');
                delBtn.className = 'collected-emoji-del';
                delBtn.title = '删除';
                delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onDelete(path);
                });
                item.appendChild(delBtn);
            }
            container.appendChild(item);
        });
    }

    // 输入框「表情」按钮 → 我的收藏表情选择器
    function showCollectedEmojiPicker() {
        const existing = document.getElementById('collectedEmojiPicker');
        if (existing) { existing.remove(); return; }

        const picker = document.createElement('div');
        picker.id = 'collectedEmojiPicker';
        picker.className = 'emoticon-picker collected-emoji-picker';
        picker.innerHTML = `
            <div class="collected-emoji-header">
                <span>我的收藏</span>
                <button class="collected-emoji-manage" id="collectedEmojiManageBtn" title="在设置中管理">管理</button>
            </div>
            <div class="emoticon-grid" id="collectedEmojiGrid"></div>
        `;
        document.body.appendChild(picker);

        const grid = document.getElementById('collectedEmojiGrid');
        const refresh = () => {
            renderCollectedEmojiGrid(grid, (path) => {
                if (!currentConv) {
                    showAlert('请先在聊天中打开一个会话');
                    return;
                }
                sendMessage('', 'image', path);
                picker.remove();
            });
        };
        refresh();

        document.getElementById('collectedEmojiManageBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            picker.remove();
            switchTab('settings');
            renderSettingsFavorites();
        });

        const closeHandler = (e) => {
            if (!picker.contains(e.target) && e.target !== emojiPlazaBtn && e.target !== emojiPlazaMoreBtn) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    async function showEmoticonPicker() {
        const existing = document.getElementById('emoticonPicker');
        if (existing) existing.remove();

        try {
            const res = await apiFetch('/v1/emoji/plaza?limit=50&offset=0');
            const data = await res.json();
            const items = data.items || [];
            if (items.length === 0) {
                showAlert('没有可用的表情包');
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
                itemEl.innerHTML = `<img src="${cachedResolveMediaUrl(imgUrl)}" loading="lazy">`;
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
            showAlert('加载表情失败');
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
                    div.innerHTML = `<img src="${cachedResolveMediaUrl(imgUrl)}" loading="lazy">`;
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
            if (!panel.contains(e.target) && e.target !== emojiPlazaBtn && e.target !== emojiPlazaMoreBtn) {
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

    // ===== 设置页面 =====
    let currentSettingsTab = 'profile';
    const settingsContent = document.getElementById('settingsContent');

    function renderSettingsPage(tab) {
        currentSettingsTab = tab;
        if (!settingsContent) return;

        // 更新侧边栏按钮高亮
        document.querySelectorAll('.sidebar-panel[data-panel="settings"] .contact-item').forEach(b => {
            b.classList.toggle('active', b.dataset.settings === tab);
        });

        if (tab === 'profile') {
            renderSettingsProfile();
        } else if (tab === 'appearance') {
            renderSettingsAppearance();
        } else if (tab === 'checkin') {
            renderSettingsCheckin();
        } else if (tab === 'about') {
            renderSettingsAbout();
        } else if (tab === 'favorites') {
            renderSettingsFavorites();
        }
    }

    function renderSettingsProfile() {
        const u = storedUser;
        settingsContent.innerHTML = `
            <h3>我的</h3>
            <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;cursor:pointer;" id="settingsProfileCard">
                <img src="${cachedResolveMediaUrl(myAvatar || '')}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;background:var(--border);" onerror="this.src='assets/default-avatar.png'">
                <div>
                    <div style="font-size:18px;font-weight:600;color:var(--text);">${escapeHtml(myName || '未登录')}</div>
                    <div style="font-size:13px;color:var(--secondary-text);">${escapeHtml(myDisplayUid || '')}</div>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-item" id="settingsEditProfile">
                    <span class="label">编辑资料</span>
                    <span class="value"><i class="fa-solid fa-chevron-right"></i></span>
                </div>
                <div class="settings-item" id="settingsMyMoments">
                    <span class="label">我的动态</span>
                    <span class="value"><i class="fa-solid fa-chevron-right"></i></span>
                </div>
                <div class="settings-item" id="settingsMyFavorites">
                    <span class="label">我的收藏</span>
                    <span class="value"><i class="fa-solid fa-chevron-right"></i></span>
                </div>
                <div class="settings-item" id="settingsMyMusic">
                    <span class="label">我的音乐</span>
                    <span class="value"><i class="fa-solid fa-chevron-right"></i></span>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-item" id="settingsLogout" style="color:#ff4757;">
                    <span class="label">退出登录</span>
                    <span class="value"><i class="fa-solid fa-right-from-bracket"></i></span>
                </div>
            </div>
        `;
        document.getElementById('settingsProfileCard')?.addEventListener('click', () => openMyProfile());
        document.getElementById('settingsEditProfile')?.addEventListener('click', () => openMyProfile());
        document.getElementById('settingsMyMoments')?.addEventListener('click', () => openSpacePanel(myUid));
        document.getElementById('settingsMyFavorites')?.addEventListener('click', () => {
            renderSettingsFavorites();
        });
        document.getElementById('settingsMyMusic')?.addEventListener('click', () => {
            switchTab('music');
            musicTab = 'mine';
            musicLoaded = false;
            loadMusicList();
        });
        document.getElementById('settingsLogout')?.addEventListener('click', async () => {
            if (await showConfirm('确定退出登录？')) {
                localStorage.removeItem('oc_access_token');
                localStorage.removeItem('oc_refresh_token');
                localStorage.removeItem('oc_user');
                window.location.href = 'login.html';
            }
        });
    }

    function renderSettingsAppearance() {
        const currentTheme = localStorage.getItem('theme') || 'light';
        settingsContent.innerHTML = `
            <h3>通用</h3>
            <div class="settings-group">
                <div class="settings-item" id="settingsThemeToggle">
                    <span class="label">深色模式</span>
                    <span class="value">${currentTheme === 'dark' ? '已开启' : '已关闭'} <i class="fa-solid fa-chevron-right"></i></span>
                </div>
            </div>
            ${IS_TAURI ? `
            <h3 style="margin-top:20px;">服务器配置</h3>
            <div class="settings-group">
                <div class="settings-input-row">
                    <label>Base URL</label>
                    <input type="text" id="settingsBaseUrl" value="${escapeHtml(BACKEND_ORIGIN)}" placeholder="http://host1 http://host2 ..." style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;outline:none;">
                </div>
                <div class="settings-input-row">
                    <label>Media URL</label>
                    <input type="text" id="settingsMediaUrl" value="${escapeHtml(MEDIA_ORIGIN)}" placeholder="http://host1 http://host2 ..." style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;outline:none;">
                </div>
                <div class="settings-input-row">
                    <label></label>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <button id="settingsSaveUrls">保存并重载</button>
                        <button id="settingsResetUrls" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text);font-size:13px;cursor:pointer;font-family:inherit;">恢复默认</button>
                    </div>
                </div>
            </div>` : ''}
            <h3 style="margin-top:20px;">缓存管理</h3>
            <div class="settings-group">
                <div class="settings-item" id="settingsClearMediaCache" style="color:#ff6b6b;">
                    <span class="label">清除媒体缓存（图片/音频/头像）</span>
                    <span class="value"><i class="fa-solid fa-trash-can"></i></span>
                </div>
                <div style="padding:8px 14px;font-size:12px;color:var(--secondary-text);">
                    <span id="settingsCacheSize">计算中...</span>
                </div>
            </div>
        `;
        document.getElementById('settingsThemeToggle')?.addEventListener('click', () => {
            const newTheme = (localStorage.getItem('theme') || 'light') === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', newTheme);
            applyTheme(newTheme);
            renderSettingsAppearance();
        });
        if (IS_TAURI) {
            const baseInput = document.getElementById('settingsBaseUrl');
            const mediaInput = document.getElementById('settingsMediaUrl');
            // 保存：取空格分割的第一个 URL 作为主地址
            document.getElementById('settingsSaveUrls')?.addEventListener('click', () => {
                const base = baseInput?.value?.trim().split(/\s+/)[0] || '';
                const media = mediaInput?.value?.trim().split(/\s+/)[0] || '';
                if (base) localStorage.setItem('oc_custom_base_url', base);
                else localStorage.removeItem('oc_custom_base_url');
                if (media) localStorage.setItem('oc_custom_media_url', media);
                else localStorage.removeItem('oc_custom_media_url');
                refreshEndpoints();
                window.location.reload();
            });
            // 恢复默认
            document.getElementById('settingsResetUrls')?.addEventListener('click', () => {
                localStorage.removeItem('oc_custom_base_url');
                localStorage.removeItem('oc_custom_media_url');
                refreshEndpoints();
                window.location.reload();
            });
        }
        // 清除媒体缓存
        document.getElementById('settingsClearMediaCache')?.addEventListener('click', async () => {
            if (!await showConfirm('确定清除所有媒体缓存吗？下次访问图片/音频/头像会重新下载。')) return;
            try {
                if (window.__MediaCache && typeof window.__MediaCache.clear === 'function') {
                    await window.__MediaCache.clear();
                }
                // 同时尝试清除 Service Worker 缓存（如有）
                if (window.caches && caches.keys) {
                    try {
                        const keys = await caches.keys();
                        await Promise.all(keys.filter(k => /media/i.test(k) || /oldchat/i.test(k)).map(k => caches.delete(k)));
                    } catch (e) {}
                }
                showAlert('媒体缓存已清除');
                // 清除后刷新缓存大小
                loadCacheSize();
            } catch (e) {
                showAlert('清除失败: ' + (e.message || e));
            }
        });
        // 加载缓存大小
        loadCacheSize();
    }

    async function loadCacheSize() {
        const el = document.getElementById('settingsCacheSize');
        if (!el) return;
        try {
            if (window.__MediaCache && typeof window.__MediaCache.getSize === 'function') {
                const size = await window.__MediaCache.getSize();
                const count = size.count;
                const totalMB = (size.totalBytes / (1024 * 1024)).toFixed(1);
                el.textContent = '共 ' + count + ' 个文件，约 ' + totalMB + ' MB';
            } else {
                el.textContent = '媒体文件永久缓存到本地，清除后下次访问重新下载';
            }
        } catch (e) {
            el.textContent = '媒体文件永久缓存到本地，清除后下次访问重新下载';
        }
    }

    async function renderSettingsCheckin() {
        settingsContent.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:20px;color:var(--secondary-text);">加载中...</div>';
        try {
            let wallData = {};
            try {
                const wallRes = await apiFetch('/v1/me/checkin/wall?limit=50');
                if (wallRes.status === 404) {
                    settingsContent.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:60px 20px;color:var(--secondary-text);"><i class="fa-solid fa-hammer" style="font-size:32px;margin-bottom:12px;display:block;"></i>功能建设中，敬请期待</div>';
                    return;
                }
                const wallText = await wallRes.text();
                try { wallData = JSON.parse(wallText); } catch (e) { console.warn('[checkin] wall not JSON:', wallText.slice(0, 100)); }
            } catch (e) {
                settingsContent.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:60px 20px;color:var(--secondary-text);"><i class="fa-solid fa-hammer" style="font-size:32px;margin-bottom:12px;display:block;"></i>功能建设中，敬请期待</div>';
                return;
            }

            const checkedIn = wallData.checked_in || false;
            const checkinCount = wallData.checkin_count || 0;
            const alreadyPosted = wallData.already_posted || false;
            const items = wallData.featured_messages || [];

            let html = `<h3>签到墙</h3>`;
            html += `<div class="checkin-header">`;
            html += `<button class="checkin-btn" id="checkinDoBtn" ${checkedIn ? 'disabled' : ''}>${checkedIn ? '✓ 今日已签到 (' + checkinCount + '天)' : '签到'}</button>`;
            html += `</div>`;

            // 留言输入
            if (checkedIn && !alreadyPosted) {
                html += `<div style="margin-bottom:16px;display:flex;gap:8px;align-items:center;">`;
                html += `<input type="text" id="checkinMsgInput" placeholder="留下今日一句话..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--bg);color:var(--text);font-family:inherit;outline:none;">`;
                html += `<button class="checkin-btn" id="checkinPostBtn" style="padding:8px 16px;font-size:13px;">留言</button>`;
                html += `</div>`;
            }

            html += `<div class="checkin-wall">`;
            if (items.length === 0) {
                html += '<div style="text-align:center;padding:20px;color:var(--secondary-text);">暂无签到记录</div>';
            }
            items.forEach(item => {
                const u = item.user || {};
                const avatar = u.avatar_url ? cachedResolveMediaUrl(u.avatar_url) : 'assets/default-avatar.png';
                const name = u.display_name || u.username || u.uid || '匿名';
                const contentText = item.content_text || '';
                const imageUrl = item.image_url ? cachedResolveMediaUrl(item.image_url) : '';
                const time = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '';
                html += `<div class="checkin-card" data-post-id="${item.id || ''}">`;
                html += `<div class="checkin-user">`;
                html += `<img src="${avatar}" onerror="this.src='assets/default-avatar.png'">`;
                html += `<div><div class="name">${escapeHtml(name)}</div><div class="time">${time}</div></div>`;
                html += `</div>`;
                if (contentText) html += `<div class="checkin-body">${escapeHtml(contentText)}</div>`;
                if (imageUrl) html += `<img src="${imageUrl}" style="max-width:100%;max-height:200px;border-radius:8px;margin-top:8px;cursor:pointer;" onclick="openImageViewer('${imageUrl}')" onerror="this.style.display='none'">`;
                html += `<div class="checkin-actions">`;
                html += `<button class="checkin-action-btn sp-c-like ${item.liked_by_me ? 'liked' : ''}" data-id="${item.id || ''}" data-liked="${item.liked_by_me || false}">`;
                html += `<i class="fa-${item.liked_by_me ? 'solid' : 'regular'} fa-heart"></i> ${item.like_count || 0}</button>`;
                html += `<button class="checkin-action-btn sp-c-comment" data-id="${item.id || ''}">`;
                html += `<i class="fa-regular fa-comment"></i> ${item.comment_count || 0}</button>`;
                html += `</div></div>`;
            });
            html += '</div>';
            settingsContent.innerHTML = html;

            // 签到按钮
            document.getElementById('checkinDoBtn')?.addEventListener('click', async () => {
                try {
                    const res = await apiFetch('/v1/me/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    const text = await res.text();
                    let data = {};
                    try { data = JSON.parse(text); } catch (e) {}
                    if (data.error) { showAlert(data.error); return; }
                    renderSettingsCheckin();
                } catch (e) { showAlert('签到失败'); }
            });

            // 留言（发布今日话语）
            document.getElementById('checkinPostBtn')?.addEventListener('click', async () => {
                const input = document.getElementById('checkinMsgInput');
                const msg = (input?.value || '').trim();
                if (!msg) { showAlert('请输入留言内容'); return; }
                try {
                    const res = await apiFetch('/v1/me/checkin/wall', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content_text: msg })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (data.error) { showAlert(data.error); return; }
                    renderSettingsCheckin();
                } catch (e) { showAlert('留言失败'); }
            });

            // 点赞
            settingsContent.querySelectorAll('.sp-c-like').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    if (!id) return;
                    const isLiked = btn.dataset.liked === 'true';
                    try {
                        const endpoint = isLiked ? '/v1/me/checkin/wall/unlike' : '/v1/me/checkin/wall/like';
                        const res = await apiFetch(endpoint, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ post_id: id })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (data.error) { showAlert(data.error); return; }
                        renderSettingsCheckin();
                    } catch (e) { console.error(e); }
                });
            });

            // 评论
            settingsContent.querySelectorAll('.sp-c-comment').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    if (!id) return;
                    openCheckinCommentsPanel(id, btn);
                });
            });
        } catch (e) {
            console.error('[checkin]', e);
            settingsContent.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:20px;color:var(--secondary-text);">加载失败</div>';
        }
    }

    function renderSettingsAbout() {
        const GITHUB_URL = 'https://github.com/LGCR837/oldchat-kivotos-next';
        settingsContent.innerHTML = `
            <h3>关于</h3>
            <div class="settings-group">
                <div class="settings-item">
                    <span class="label">应用名称</span>
                    <span class="value">OldChat for Kivotos</span>
                </div>
                <div class="settings-item">
                    <span class="label">运行模式</span>
                    <span class="value">${IS_TAURI ? 'Tauri 桌面端' : '浏览器 (Nginx)'}</span>
                </div>
                <div class="settings-item">
                    <span class="label">后端地址</span>
                    <span class="value">${BACKEND_ORIGIN}</span>
                </div>
                <div class="settings-item" style="cursor:pointer;" id="aboutGithubLink">
                    <span class="label">GitHub 仓库</span>
                    <span class="value" style="color:var(--accent);text-decoration:underline;">${GITHUB_URL}</span>
                </div>
            </div>
        `;
        document.getElementById('aboutGithubLink')?.addEventListener('click', () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(GITHUB_URL).then(() => {
                    showAlert('GitHub 仓库地址已复制到剪贴板', '提示');
                }).catch(() => {
                    fallbackCopyText(GITHUB_URL);
                    showAlert('GitHub 仓库地址已复制到剪贴板', '提示');
                });
            } else {
                fallbackCopyText(GITHUB_URL);
                showAlert('GitHub 仓库地址已复制到剪贴板', '提示');
            }
        });
    }

    // 设置 → 我的收藏（与输入框表情选择器共用同一份 localStorage 数据）
    function renderSettingsFavorites() {
        currentSettingsTab = 'favorites';
        const render = () => {
            const list = loadCollectedEmojis();
            const countEl = document.getElementById('favCount');
            if (countEl) countEl.textContent = `共 ${list.length} 个表情`;
            const grid = document.getElementById('favEmojiGrid');
            renderCollectedEmojiGrid(grid, (path) => {
                if (!currentConv) {
                    showAlert('请先在聊天中打开一个会话');
                    return;
                }
                sendMessage('', 'image', path);
                showAlert('已发送');
            }, (path) => {
                removeCollectedEmoji(path);
                render();
            });
        };

        settingsContent.innerHTML = `
            <h3 style="display:flex;align-items:center;gap:10px;">
                <button class="btn" id="favBack" title="返回我的">返回</button>
                我的收藏
                <span id="favCount" style="font-size:12px;color:var(--secondary-text);font-weight:normal;"></span>
            </h3>
            <div class="emoticon-grid" id="favEmojiGrid"></div>
        `;
        render();

        document.getElementById('favBack')?.addEventListener('click', () => renderSettingsPage('profile'));
    }

    // 设置页面导航点击 — 仅通过侧边栏面板
    document.querySelector('.sidebar-panel[data-panel="settings"]')?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-settings]');
        if (!item) return;
        const tab = item.dataset.settings;
        // 高亮侧边栏
        document.querySelectorAll('.sidebar-panel[data-panel="settings"] .contact-item').forEach(ci => ci.classList.remove('active'));
        item.classList.add('active');
        renderSettingsPage(tab);
    });
    // 默认渲染
    renderSettingsPage('profile');

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

    // 启动媒体永久缓存层（图片/音频/视频/头像/背景图/封面图）
    if (window.__MediaCache && typeof window.__MediaCache.init === 'function') {
        try { window.__MediaCache.init(); } catch (e) { console.error('[MediaCache]', e); }
    }

});