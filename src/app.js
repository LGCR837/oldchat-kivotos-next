// ===== Tauri 运行环境检测 =====
// 本应用只支持 Tauri 桌面端：请求走 plugin-http 直连后端，自带跨域能力。
// 此处的检测仅用于「Tauri API 是否可用」的守卫（注入失败时走降级路径），不再区分浏览器运行模式。
// 判定结果仅存在于内存，不写 localStorage。
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

    // 后端 API / 媒体直链走 plugin-http（见 IIFE 外的顶层 tauriHttpFetch 包装）。
    // 关键：不再全局重写 window.fetch，否则本地资源（如 app.css 主题元数据）也会被 plugin-http 拦截。
    window.__tauriHttpFetchImpl = async function (input, init) {
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
    // 注：不再全局重写 window.fetch。后端请求统一通过 IIFE 外的顶层 tauriHttpFetch() 调用本实现。

    // 标记 Tauri 环境（CSS 据此启用圆角阴影、三大金刚键、拖动区域）
    document.body.classList.add('tauri-env');

    // 三大金刚键：最小化 / 最大化切换 / 关闭
    const winMinBtn = document.getElementById('winMinBtn');
    const winMaxBtn = document.getElementById('winMaxBtn');
    const winCloseBtn = document.getElementById('winCloseBtn');

    // 根据最大化状态切换图标与圆角（更新所有界面的最大化/还原按钮）
    function syncMaximizeState() {
        invoke('is_window_maximized').then(function(isMax) {
            if (isMax) document.body.classList.add('is-maximized');
            else document.body.classList.remove('is-maximized');
            // 聊天(winMaxBtn) + 联系人/设置/音乐/发现/法庭/广场/小程序/用户空间：统一更新图标与提示。
            // 注意：聊天按钮 id 是「winMaxBtn」(小写 w 开头)，必须以 "MaxBtn" 结尾匹配，不能用 "WinMaxBtn"。
            const maxBtns = document.querySelectorAll('[id$="MaxBtn"]');
            maxBtns.forEach(function(btn) {
                const icon = btn.querySelector('i');
                if (!icon) return;
                if (isMax) {
                    icon.className = 'fa-regular fa-clone';
                    btn.title = '还原';
                } else {
                    icon.className = 'fa-regular fa-square';
                    btn.title = '最大化';
                }
            });
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
    bindWinControls('discover');
    bindWinControls('courtWin');
    bindWinControls('plaza');

    // CIP 调试器 overlay：最小化/最大化同普通窗口，关闭键只关 overlay
    (function bindCipWinControls() {
        var minBtn = document.getElementById('cipWinMinBtn');
        var maxBtn = document.getElementById('cipWinMaxBtn');
        var closeBtn = document.getElementById('cipWinCloseBtn');
        if (minBtn) minBtn.addEventListener('click', function() { invoke('minimize_window').catch(function(){}); });
        if (maxBtn) maxBtn.addEventListener('click', function() { invoke('toggle_maximize_window').then(syncMaximizeState).catch(function(){}); });
        if (closeBtn) closeBtn.addEventListener('click', function() {
            if (window.CipController && typeof window.CipController.close === 'function') window.CipController.close();
        });
    })();

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

// ===== 后端 API / 媒体直链专用：封装 plugin-http invoke =====
// 仅此函数走 Tauri 的 http 插件（绕过 CORS、受 capabilities 白名单 scope 约束）。
// 普通 fetch（本地资源、同源资源，如读 app.css 主题元数据）一律走浏览器原生 window.fetch，
// 不再被全局劫持，避免本地资源被 plugin-http 的 scope 拦截。
async function tauriHttpFetch(input, init) {
    if (typeof window.__tauriHttpFetchImpl === 'function') {
        return window.__tauriHttpFetchImpl(input, init);
    }
    return window.fetch(input, init);
}

// ===== API / WS / 媒体资源基地址 =====
// 固定走后端完整地址：plugin-http 自带跨域能力，不需要前端反代。
// 用户可在「设置 → 服务器配置」中覆盖 Base URL / Media URL，保存在 localStorage。

// 默认值（硬编码回退）
// 默认候选（按优先级排序）
// 普通内容：优先 oc.mcl0.dpdns.org（延迟最低），降级到 60.205.94.101
const DEFAULT_BACKEND_CANDIDATES = [
    'http://oc.mcl0.dpdns.org',
    'https://oc.mcl0.dpdns.org',
    'http://60.205.94.101:8080'
];
// 媒体文件：优先 60.205.94.101:8080（源服务器，速度最快；files 的音乐资源加载慢），其次 files.mcl0.dpdns.org（CF 原站，非 CDN），最后 oc.mcl0.dpdns.org
const DEFAULT_MEDIA_CANDIDATES = [
    'http://60.205.94.101:8080',
    'http://files.mcl0.dpdns.org',
    'http://oc.mcl0.dpdns.org',
    'https://oc.mcl0.dpdns.org'
];

// 归一化候选项：统一存「裸 origin」，去掉结尾斜杠与用户误加的 /v1 后缀。
// 请求时一律用 base + '/v1/xxx' 拼接，这里若残留 /v1 会拼成 /v1/v1/xxx 而 404。
function _normalizeOrigin(s) {
    let v = String(s || '').trim();
    if (!v) return '';
    v = v.replace(/\/+$/, '');          // 去掉结尾的 /
    v = v.replace(/\/v1$/i, '');        // 去掉误加的 /v1
    v = v.replace(/\/+$/, '');
    return v;
}
// 解析候选列表（空格/逗号分隔），为空时回退默认
function _parseCandidates(raw, defaults) {
    if (!raw) return defaults.slice();
    const arr = String(raw).split(/[\s,]+/).map(_normalizeOrigin).filter(Boolean);
    // 去重，保持原有优先级顺序
    const seen = new Set();
    const out = [];
    for (const u of arr) { if (!seen.has(u)) { seen.add(u); out.push(u); } }
    return out.length ? out : defaults.slice();
}
// 从 localStorage 读取用户自定义候选，没有则回退到默认
function _getSavedBackendCandidates() {
    try { return _parseCandidates(localStorage.getItem('oc_custom_base_url'), DEFAULT_BACKEND_CANDIDATES); }
    catch (e) { return DEFAULT_BACKEND_CANDIDATES.slice(); }
}
function _getSavedMediaCandidates() {
    try { return _parseCandidates(localStorage.getItem('oc_custom_media_url'), DEFAULT_MEDIA_CANDIDATES); }
    catch (e) { return DEFAULT_MEDIA_CANDIDATES.slice(); }
}

let BACKEND_CANDIDATES = _getSavedBackendCandidates();
let MEDIA_CANDIDATES   = _getSavedMediaCandidates();
let BACKEND_ORIGIN = BACKEND_CANDIDATES[0] || 'http://oc.mcl0.dpdns.org';
let MEDIA_ORIGIN   = MEDIA_CANDIDATES[0] || 'http://60.205.94.101:8080';
const BACKEND_HOST = (function() {
    try { return new URL(BACKEND_ORIGIN).host; } catch (e) { return 'oc.mcl0.dpdns.org'; }
})();

// 一次性清理：移除已废弃的浏览器代理模式遗留配置
try { localStorage.removeItem('oc_proxy_mode'); } catch (e) {}

let API_BASE   = BACKEND_ORIGIN + '/v1';
let WS_HOST    = BACKEND_HOST;
let MEDIA_BASE = MEDIA_ORIGIN;

// 供设置页更新配置后重新计算
function refreshEndpoints() {
    BACKEND_CANDIDATES = _getSavedBackendCandidates();
    MEDIA_CANDIDATES   = _getSavedMediaCandidates();
    BACKEND_ORIGIN = BACKEND_CANDIDATES[0] || 'http://oc.mcl0.dpdns.org';
    MEDIA_ORIGIN   = MEDIA_CANDIDATES[0] || 'http://60.205.94.101:8080';
    const host = (function() { try { return new URL(BACKEND_ORIGIN).host; } catch (e) { return BACKEND_HOST; } })();
    WS_HOST    = host;
    API_BASE   = BACKEND_ORIGIN + '/v1';
    MEDIA_BASE = MEDIA_ORIGIN;
}

// 媒体图片加载失败 → 自动降级到下一个候选源（按 MEDIA_CANDIDATES 顺序）
document.addEventListener('error', function(e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    // MediaCache 已接管该图片的候选源降级（缓存层内部逐候选尝试，每个唯一 URL 只抓一次），
    // 跳过此处以免全局监听在原生回退时重复放大请求 2~4 倍。
    if (img.dataset.mcOrigSrc) return;
    const src = img.getAttribute('src') || '';
    const tries = parseInt(img.dataset.mediaTries || '0', 10);
    for (let i = tries; i < MEDIA_CANDIDATES.length - 1; i++) {
        const base = MEDIA_CANDIDATES[i];
        if (base && src.indexOf(base) === 0) {
            img.dataset.mediaTries = String(i + 1);
            img.src = MEDIA_CANDIDATES[i + 1] + src.slice(base.length);
            e.stopPropagation();
            return;
        }
    }
}, true);

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

// 通用防抖：连续触发时只在停止 wait 毫秒后执行最后一次（用于 @ 搜索等高频输入）
function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, wait);
    };
}

// ==================== 媒体文件永久缓存层 ====================
// 两层缓存：
//   1. 内存 Map（快速命中，当前会话）
//   2. IndexedDB（永久存储，跨会话 / 跨关闭）
(function () {
    const DB_NAME = 'oldchat_media_cache_v1';
    const STORE_NAME = 'media';
    const memCache = new Map();  // url -> Blob
    // 1x1 透明 GIF：用于在 observer 拦截到 <img src> 的瞬间抢先替换原生 src，
    // 阻断浏览器向媒体服务器发起原生请求（否则每次重渲染都会先白打一次原生 http，被 no-store 禁缓存 → 请求量爆炸）。
    const MEDIA_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
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

    // 根据已解析的绝对媒体 URL，生成候选源列表（命中 MEDIA_CANDIDATES 中某一个后，按顺序拼出后续候选）
    function mediaCandidateUrls(url) {
        const list = [];
        for (const base of MEDIA_CANDIDATES) {
            if (url.indexOf(base) === 0) {
                const path = url.slice(base.length);
                for (let i = MEDIA_CANDIDATES.indexOf(base); i < MEDIA_CANDIDATES.length; i++) {
                    list.push(MEDIA_CANDIDATES[i] + path);
                }
                break;
            }
        }
        if (list.length === 0) list.push(url);
        return Array.from(new Set(list));
    }

    // 抓取单个 URL（tauriHttpFetch 优先，失败兜底 XHR）
    async function fetchOne(u) {
        let blob;
        try {
            const resp = await tauriHttpFetch(u);
            if (!resp || !resp.ok) throw new Error('fetch status ' + (resp && resp.status));
            blob = await resp.blob();
        } catch (e) {
            blob = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', u, true);
                xhr.responseType = 'blob';
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
                    else reject(new Error('xhr status ' + xhr.status));
                };
                xhr.onerror = () => reject(new Error('xhr network'));
                xhr.send();
            });
        }
        return blob;
    }

    async function fetchAndStore(url) {
        // 媒体缓存预取：走 tauriHttpFetch（plugin-http 无 CORS 限制，媒体域名已在 capabilities 白名单）。
        // 关键修复：候选源降级在【缓存层内部】完成（每个唯一 URL 只抓一次），
        // 避免每个渲染点都触发全局 error 监听的候选链、把请求量放大 2~4 倍。
        const candidates = mediaCandidateUrls(url);
        let lastErr;
        for (const c of candidates) {
            try {
                const blob = await fetchOne(c);
                if (blob && blob.size) {
                    memCache.set(url, blob);
                    idbPut(url, blob, blob.type).catch(() => {});
                    return blob;
                }
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('all media candidates failed: ' + url);
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
        // 视频/音轨交给播放器原生流式加载：MediaCache 把整段视频读进内存 blob 是负优化，
        // 且会打断 ArtPlayer 的加载（先换 GIF 占位再换 blob），故直接跳过。
        if (tag === 'video' || tag === 'source') return;
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
                // 关键修复：立即把原生 src 换成 1x1 透明占位，抢在浏览器向媒体服务器发起原生请求之前。
                // 否则每次重渲染都会先白打一次原生 http（被 no-store 禁缓存），再被 observer 换成 blob → 请求量爆炸。
                el.setAttribute(attr, MEDIA_PLACEHOLDER);
                getCachedUrlOrPass(val, (newUrl) => {
                    try {
                        if (newUrl && newUrl.indexOf('blob:') === 0) {
                            // 命中缓存 / 抓取成功：用 blob URL，零网络
                            el.setAttribute(attr, newUrl);
                        } else {
                            // 缓存未命中或抓取失败：恢复原始远程地址，降级为旧行为（全局 error 监听负责候选链）
                            el.setAttribute(attr, val);
                        }
                    } catch (e) {}
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
                                    n.querySelectorAll('img,audio,track,link[rel~="icon"],link[rel~="apple-touch-icon"]').forEach(processElement);
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
                document.body.querySelectorAll('img,audio,track').forEach(processElement);
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
            // HTTP URL：带鉴权头传给 Rust 用 reqwest 流式下载（媒体接口已加权鉴）
            var dlHeaders = null;
            var dlToken = localStorage.getItem('oc_access_token');
            if (dlToken) dlHeaders = [['Authorization', 'Bearer ' + dlToken]];
            var imgName = src.split('/').pop() || 'image';
            startTauriDownload({ kind: 'image', url: src, headers: dlHeaders, displayName: imgName });
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
        tauriHttpFetch(imgUrl)
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

// 初始化 ArtPlayer 视频播放器（容器插入 DOM 后调用；缓存恢复场景先清空重建）
function initArtPlayers(root) {
    if (typeof Artplayer === 'undefined' || !root || !root.querySelectorAll) return;
    root.querySelectorAll('.video-message').forEach(function (el) {
        if (el.dataset.artInit) return; // 已初始化
        var src = el.getAttribute('data-src') || '';
        if (!src) return;
        el.dataset.artInit = '1';
        try {
            new Artplayer({
                container: el,
                url: src,
                autoplay: false,
                volume: 0.7,
                muted: false,
                playsInline: true,
                fullscreen: true,
                fullscreenWeb: true,
                aspectRatio: true,
                setting: true
            });
        } catch (e) {
            console.error('ArtPlayer 初始化失败:', e);
            delete el.dataset.artInit;
        }
    });
}

// 显示下载进度弹窗（复用现有 .custom-modal 样式），返回 { update, setFallback, setError, close }
function showDownloadModal(displayName, taskId, onCancel) {
    var overlay = document.createElement('div');
    overlay.className = 'custom-modal-overlay';
    overlay.style.zIndex = '21000'; // 略高于普通弹窗
    overlay.innerHTML =
        '<div class="custom-modal" style="max-width:360px;">' +
            '<div class="custom-modal-title">' + escapeHtml(displayName) + ' 下载中…</div>' +
            '<div class="custom-modal-body">' +
                '<div class="dl-progress"><div class="dl-progress-fill"></div></div>' +
                '<div class="dl-info">准备中…</div>' +
            '</div>' +
            '<div class="custom-modal-actions">' +
                '<button class="btn" type="button">取消</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);

    var progressEl = overlay.querySelector('.dl-progress');
    var fill = overlay.querySelector('.dl-progress-fill');
    var info = overlay.querySelector('.dl-info');
    var titleEl = overlay.querySelector('.custom-modal-title');
    var cancelBtn = overlay.querySelector('.btn');
    var closed = false;

    cancelBtn.addEventListener('click', function () {
        if (closed) return;
        cancelBtn.disabled = true;
        cancelBtn.textContent = '取消中…';
        if (onCancel) onCancel();
    });

    function fmt(b) {
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1024 / 1024).toFixed(1) + ' MB';
    }

    return {
        update: function (p) {
            if (closed) return;
            if (p.error) { this.setError(p.error); return; }
            if (p.done) {
                info.textContent = '完成，请选择保存位置…';
                fill.style.width = '100%';
                return;
            }
            if (p.total && p.total > 0) {
                var pct = Math.min(100, Math.round((p.downloaded / p.total) * 100));
                fill.style.width = pct + '%';
                info.textContent = pct + '%  (' + fmt(p.downloaded) + ' / ' + fmt(p.total) + ')';
            } else {
                progressEl.classList.add('dl-indeterminate');
                info.textContent = '下载中… ' + fmt(p.downloaded);
            }
        },
        setFallback: function () {
            if (closed) return;
            progressEl.classList.add('dl-indeterminate');
            info.textContent = '下载中…';
        },
        setError: function (msg) {
            if (closed) return;
            titleEl.textContent = displayName + ' 下载失败';
            info.textContent = String(msg || '未知错误');
            cancelBtn.textContent = '关闭';
            cancelBtn.disabled = false;
        },
        close: function () {
            if (closed) return;
            closed = true;
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
    };
}

// 旧二进制回退：不带 task_id/on_progress 直接调原命令（无进度，最后弹系统保存框）
function _fallbackDownload(opts) {
    var invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    var args = { url: opts.url, headers: opts.headers || null };
    if (opts.kind === 'file') args.filename = opts.filename || null;
    var cmd = opts.kind === 'image' ? 'save_image' : 'save_download';
    return invoke(cmd, args);
}

// 统一发起 Tauri 下载（带进度弹窗 + 取消）；opts: { kind:'file'|'image', url, filename, headers, displayName }
function startTauriDownload(opts) {
    var invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    var ChannelCls = window.__TAURI__?.core?.Channel;
    if (!invoke || !ChannelCls) {
        // 兜底：无 Channel 支持时直接走旧命令（无进度反馈）
        _fallbackDownload(opts).catch(function (e) { console.error('下载失败:', e); });
        return;
    }
    var taskId = 'dl_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    var ch = new ChannelCls();
    var modal = showDownloadModal(opts.displayName || '文件', taskId, function () {
        invoke('cancel_download', { taskId: taskId }).catch(function () {});
    });
    ch.onmessage = function (msg) { modal.update(msg); };
    var args = {
        url: opts.url,
        headers: opts.headers || null,
        taskId: taskId,
        onProgress: ch,
    };
    if (opts.kind === 'file') args.filename = opts.filename || null;
    var cmd = opts.kind === 'image' ? 'save_image' : 'save_download';
    invoke(cmd, args)
        .then(function () { modal.close(); })
        .catch(function (e) {
            var m = (e && e.message) ? e.message : String(e);
            // 当前运行的是旧二进制（save_download 不认 task_id）：自动回退到无进度调用
            if (/invalid args|task_id|taskId|unknown command/i.test(m)) {
                modal.setFallback();
                _fallbackDownload(opts)
                    .then(function () { modal.close(); })
                    .catch(function (e2) { modal.setError((e2 && e2.message) || e2); });
                return;
            }
            if (m === '已取消') modal.close();
            else modal.setError(m);
        });
}

// 下载文件（带鉴权，不再用浏览器直接打开）——文件接口已加权鉴
function downloadFile(url, filename) {
    if (!url) return;
    if (IS_TAURI) {
        var token = localStorage.getItem('oc_access_token');
        var headers = token ? [['Authorization', 'Bearer ' + token]] : [];
        var displayName = filename || (url.split('/').pop() || '文件');
        startTauriDownload({ kind: 'file', url: url, filename: filename || null, headers: headers, displayName: displayName });
        return;
    }
    // 非 Tauri 回退：带鉴权 fetch → blob 保存
    var opts = {};
    var tok = localStorage.getItem('oc_access_token');
    if (tok) opts.headers = { 'Authorization': 'Bearer ' + tok };
    tauriHttpFetch(url, opts)
        .then(function(res) { return res.blob(); })
        .then(function(blob) {
            var a = document.createElement('a');
            var objUrl = URL.createObjectURL(blob);
            a.href = objUrl;
            a.download = filename || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(objUrl); }, 1000);
        })
        .catch(function(e) { console.error('文件下载失败:', e); });
}

// 文件下载按钮：点击走带权鉴下载（不再 target=_blank 浏览器打开）
document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('.file-download-btn') : null;
    if (!el) return;
    e.preventDefault();
    var url = el.getAttribute('data-dl-url');
    if (url) downloadFile(url, el.getAttribute('data-dl-name') || '');
});

// 转发聊天记录卡片：点击展开完整记录弹窗
document.addEventListener('click', function(e) {
    var card = e.target && e.target.closest ? e.target.closest('.forward-card') : null;
    if (!card) return;
    e.preventDefault();
    var raw = card.getAttribute('data-forward');
    if (!raw) return;
    try {
        openForwardModal(JSON.parse(decodeURIComponent(raw)));
    } catch (err) { console.error('解析转发聊天记录失败', err); }
});

function openForwardModal(fwd) {
    if (!fwd) return;
    var items = Array.isArray(fwd.items) ? fwd.items : [];
    var title = fwd.title || '聊天记录';
    var overlay = document.createElement('div');
    overlay.className = 'custom-modal-overlay';
    overlay.style.zIndex = '22000';

    var rows = items.map(function (it) {
        var nm = it.from_name || it.from_ncuid || it.from_uid || '未知用户';
        var avatar = it.from_avatar ? cachedResolveMediaUrl(it.from_avatar) : 'assets/default-avatar.png';
        var bodyHtml;
        if (it.type === 'image') {
            var imgUrl = it.media_url ? cachedResolveMediaUrl(it.media_url) : '';
            bodyHtml = imgUrl ? '<img class="forward-item-img" src="' + escapeHtml(imgUrl) + '" onerror="this.style.display=\'none\'">' : '[图片]';
        } else if (it.type === 'voice' || it.type === 'audio') {
            bodyHtml = '[语音]';
        } else if (it.media_url && it.type && it.type !== 'text') {
            bodyHtml = '[文件]';
        } else {
            bodyHtml = escapeHtml(it.text || '').replace(/\n/g, '<br>');
        }
        return '<div class="forward-item">'
            + '<img class="msg-avatar" src="' + escapeHtml(avatar) + '" onerror="this.src=\'assets/default-avatar.png\'">'
            + '<div class="forward-item-main"><div class="forward-item-name">' + escapeHtml(nm) + '</div>'
            + '<div class="forward-item-text">' + bodyHtml + '</div></div>'
            + '</div>';
    }).join('');

    overlay.innerHTML = '<div class="custom-modal forward-modal">'
        + '<div class="custom-modal-title">' + escapeHtml(title) + ' <span class="forward-count">共 ' + items.length + ' 条</span></div>'
        + '<div class="forward-modal-list">' + rows + '</div>'
        + '<div class="custom-modal-actions"><button class="btn" data-close="1">关闭</button></div>'
        + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay || (e.target.closest && e.target.closest('[data-close]'))) {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
    });
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
// 并发去重：相同 GET 请求复用同一底层响应（克隆给各调用方），减少初始化期间冗余请求
const _inflightGet = new Map();

// ===== v1 → v2 API 路径映射（2026-08-09 文档确认）=====
// 依据：oldchat-docs-20260809/nx3/oldchat-diff-release-vs-dev2.md §9.4（60+ 条映射表）
//      + 12-v2签名机制与响应结构补充.md §5（direct/messages、direct/unread、群消息 v2）
//      + 02-网络层与API通信机制.md（channels/buttons/files/群 members-lookup）
// 说明：
//  - 私聊历史 v1=/v1/direct/messages/v2 → v2=/v2/direct/messages（v2 去掉 /v2 后缀，12 文档 §5.1）
//  - 群历史 v1=/v1/groups/messages/v2 → v2=/v2/groups/messages/v2（02 §2.13.2 保留后缀）
//  - 未列入的端点保持 /v1（auth/login|refresh|handshake|web/register、music/*、emoji/plaza、
//    checkin/wall、public-court、media 上传、messages/search、messages/after、direct|groups/unread、
//    groups/message/send —— 这些文档未确认 v2 路径或响应结构不兼容，保守保留 v1）
const V1_TO_V2 = {
    // 私聊
    '/v1/direct/send': '/v2/direct/send',
    '/v1/direct/read': '/v2/direct/read',
    '/v1/direct/burn/open': '/v2/direct/burn/open',
    '/v1/direct/messages/v2': '/v2/direct/messages',
    // 群组
    '/v1/groups/messages/v2': '/v2/groups/messages/v2',
    '/v1/groups/read': '/v2/groups/read',
    '/v1/groups/burn/open': '/v2/groups/burn/open',
    '/v1/groups/typing': '/v2/groups/typing',
    '/v1/groups/create': '/v2/groups/create',
    '/v1/groups/join': '/v2/groups/join',
    '/v1/groups/leave': '/v2/groups/leave',
    '/v1/groups/invite': '/v2/groups/invite',
    '/v1/groups/invitations': '/v2/groups/invitations',
    '/v1/groups/invitations/respond': '/v2/groups/invitations/respond',
    '/v1/groups/requests': '/v2/groups/requests',
    '/v1/groups/approve': '/v2/groups/approve',
    '/v1/groups/admin': '/v2/groups/admin',
    '/v1/groups/avatar': '/v2/groups/avatar',
    '/v1/groups/kick': '/v2/groups/kick',
    '/v1/groups/name': '/v2/groups/name',
    '/v1/groups/settings': '/v2/groups/settings',
    '/v1/groups/announcement': '/v2/groups/announcement',
    '/v1/groups/announcement/read': '/v2/groups/announcement/read',
    '/v1/groups/dissolve': '/v2/groups/dissolve',
    '/v1/groups/list': '/v2/groups/list',
    '/v1/groups/members': '/v2/groups/members',
    // 红包
    '/v1/redpackets/send': '/v2/redpackets/send',
    '/v1/redpackets/claim': '/v2/redpackets/claim',
    // 好友
    '/v1/friends': '/v2/friends',
    '/v1/friends/request': '/v2/friends/request',
    '/v1/friends/requests': '/v2/friends/requests',
    '/v1/friends/respond': '/v2/friends/respond',
    '/v1/friends/remark': '/v2/friends/remark',
    '/v1/friends/delete': '/v2/friends/delete',
    // 个人
    '/v1/me': '/v2/me',
    '/v1/me/uid': '/v2/me/uid',
    '/v1/me/profile': '/v2/me/profile',
    '/v1/me/avatar': '/v2/me/avatar',
    '/v1/me/cover': '/v2/me/cover',
    '/v1/me/checkin': '/v2/me/checkin',
    '/v1/me/devices': '/v2/me/devices',
    '/v1/me/devices/cleanup': '/v2/me/devices/cleanup',
    '/v1/me/password': '/v2/me/password',
    '/v1/me/presence': '/v2/me/presence',
    '/v1/me/group-invite-preference': '/v2/me/group-invite-preference',
    '/v1/me/group-reports': '/v2/me/group-reports',
    '/v1/me/bug-reports': '/v2/me/bug-reports',
    '/v1/me/user-reports': '/v2/me/user-reports',
    // 动态
    '/v1/moments': '/v2/moments',
    '/v1/moments/like': '/v2/moments/like',
    '/v1/moments/unlike': '/v2/moments/unlike',
    '/v1/moments/comment': '/v2/moments/comment',
    '/v1/moments/comment/delete': '/v2/moments/comment/delete',
    '/v1/moments/comments': '/v2/moments/comments',
    '/v1/moments/delete': '/v2/moments/delete',
    '/v1/moments/user': '/v2/moments/user',
    '/v1/moments/feed': '/v2/moments/feed',
    // 用户 / 聊天 / 交互
    '/v1/users/profile': '/v2/users/profile',
    '/v1/chats/typing': '/v2/chats/typing',
    '/v1/buttons/callback': '/v2/buttons/callback',
    // 频道 / 文件（v2 新增端点，客户端暂未接入，先占位保证未来直接可用）
    '/v1/channels/subscribe': '/v2/channels/subscribe',
    '/v1/channels/unsubscribe': '/v2/channels/unsubscribe',
    '/v1/channels/notifications': '/v2/channels/notifications',
    '/v1/channels/discover': '/v2/channels/discover',
    '/v1/channels/posts/send': '/v2/channels/posts/send',
    '/v1/files/check': '/v2/files/check',
    '/v1/files/upload': '/v2/files/upload',
    '/v1/resources/upload': '/v2/resources/upload'
};

// 命中映射表则把 /v1/xxx 换成 /v2/xxx（精确路径或路径+查询参数）
function mapToV2(url) {
    if (!url || url.indexOf('/v1/') !== 0) return url;
    for (const v1 of Object.keys(V1_TO_V2)) {
        if (url === v1 || url.startsWith(v1 + '?')) {
            return V1_TO_V2[v1] + url.slice(v1.length);
        }
    }
    return url;
}

// v2 → v1 反向映射（v2 接口 401 熔断回退用）
function v2ToV1(url) {
    if (!url || url.indexOf('/v2/') !== 0) return url;
    for (const v1 of Object.keys(V1_TO_V2)) {
        const v2 = V1_TO_V2[v1];
        if (url === v2 || url.startsWith(v2 + '?')) {
            return v1 + url.slice(v2.length);
        }
    }
    return url;
}

// v2 熔断（按端点）：v2 请求 401（该端点服务器实际未迁 v2 / 签名问题）后，仅该 v2 路径回退 v1。
// 避免「主界面 401 → 跳登录页 → 自动登录 → 又 401」的死循环，且不影响其它已支持 v2 的端点。
const v2FailedPaths = new Set();

// 接口版本模式（设置 → 通用 → 接口版本）：'v2优先'(默认) / 'v1优先' / '仅v1' / '仅v2'
//  - v2优先(默认)：优先 v2(有映射时)；失败自动回退 v1
//  - v1优先：优先 v1；若 v1 失败(网络/5xx/路由不存在)且存在 v2 映射，自动回退 v2 重试
//  - 仅v1：始终 v1，绝不走 v2
//  - 仅v2：始终 v2；若某接口无 v2 版本则直接抛错（"如果没有这个接口直接报错"）
// v2 实际可行性(2026-08-10 据官方 v2 文档 api202608100558.md 确认)：ECDH 握手派生
// macKey=sha256(secret||"mac") 与文档 §4.1 完全一致；此前 v2 失败的两点根因 = ①未带 X-Session
// ②signingString 误用了 token 而非 METHOD。现已修正(见 v2SignHeaders)。WS 仍走 v1
// （独立大项，暂不随开关迁移）。
function getApiVersionMode() {
    let m = 'v2优先';
    try { m = localStorage.getItem('oc_api_version') || 'v2优先'; } catch (e) {}
    if (!['v1优先', 'v2优先', '仅v1', '仅v2'].includes(m)) m = 'v2优先';
    return m;
}

// v2 请求签名头（HMAC-SHA256，密钥 = ECDH 握手派生的 wsMacKey）
// 官方文档 §4.4：sign = base64url(HMAC-SHA256(macKey, signingString))
// signingString = METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE
// 且 v2SignMiddleware 强制 X-Session 有效 → 必须带上 handshake 返回的 session_id
// PATH 不含查询参数；nonce = 16 字节随机 → base64 无填充；X-Device-Id = oldchat_device_id（可选，灰度绑定）
async function v2SignHeaders(path, method) {
    const cleanPath = String(path || '').split('?')[0];
    if (!/^\/v2\//.test(cleanPath)) return {};
    const sess = window.__wsSession;
    if (!sess) return {};
    try {
        await sess.ensure();
    } catch (e) {
        return {}; // 握手失败则跳过签名（文档 §6.2：握手失败请求也能发出）
    }
    const macKey = sess.getMacKey();
    if (!macKey || !macKey.length) return {};
    const sessionId = sess.getSessionId();
    if (!sessionId) return {};
    const ts = String(Math.floor(Date.now() / 1000));
    const nonceBytes = new Uint8Array(16);
    try { crypto.getRandomValues(nonceBytes); } catch (e) {}
    const nonce = Crypto.bytesToBase64(nonceBytes).replace(/=+$/, '');
    const meth = (method || 'GET').toUpperCase();
    const data = new TextEncoder().encode(meth + '\n' + cleanPath + '\n' + ts + '\n' + nonce);
    const sig = await Crypto.hmacSha256(macKey, data);
    const sign = Crypto.bytesToBase64(sig).replace(/=+$/, '');
    const hdrs = {
        'X-Session': sessionId,
        'X-Ts': ts,
        'X-Nonce': nonce,
        'X-Sign': sign
    };
    const devId = localStorage.getItem('oldchat_device_id');
    if (devId) hdrs['X-Device-Id'] = devId;
    return hdrs;
}

// v2 请求体加密（08-ECDH 文档 §4：AES-256-CBC + HMAC-SHA256 信封）
// 信封 JSON：{iv, data, mac}，base64(NO_WRAP)；mac = HMAC-SHA256(macKey, iv字节 || data字节)
// 返回加密后的信封 JSON 字符串；密钥/会话缺失或加密失败返回 null（调用方降级明文）
async function v2EncryptBody(plainJson) {
    const sess = window.__wsSession;
    if (!sess) return null;
    const encKey = sess.getEncKey();
    const macKey = sess.getMacKey();
    if (!encKey || !macKey) return null;
    try {
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const key = await crypto.subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['encrypt']);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(plainJson)));
        const mac = await Crypto.hmacSha256(macKey, Crypto.concatBytes(iv, ciphertext));
        return JSON.stringify({
            iv: Crypto.bytesToBase64(iv),
            data: Crypto.bytesToBase64(ciphertext),
            mac: Crypto.bytesToBase64(mac)
        });
    } catch (e) {
        console.warn('[v2] 请求体加密失败:', e);
        return null;
    }
}

// v2 响应体解密（08-ECDH 文档 §5：验证 MAC → AES-CBC 解密 → 可选 gzip 解压）
// 非信封（明文响应）返回 null；成功返回明文 JSON 字符串
async function v2DecryptBody(text) {
    if (!text) return null;
    let env;
    try { env = JSON.parse(text); } catch (e) { return null; }
    if (!env || typeof env !== 'object' || !env.iv || !env.data || !env.mac) return null;
    const sess = window.__wsSession;
    if (!sess) return null;
    const macKey = sess.getMacKey();
    const encKey = sess.getEncKey();
    if (!macKey || !encKey) return null;
    try {
        const iv = Crypto.base64ToBytes(env.iv);
        const data = Crypto.base64ToBytes(env.data);
        const mac = Crypto.base64ToBytes(env.mac);
        const expected = await Crypto.hmacSha256(macKey, Crypto.concatBytes(iv, data));
        if (!Crypto.timingSafeEqual(mac, expected)) return null;
        const key = await crypto.subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['decrypt']);
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data));
        // 尝试 gzip 解压（服务器可能标 X-Enc-Compression: gzip；失败则用原文）
        try {
            const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
            return new TextDecoder().decode(await new Response(stream).arrayBuffer());
        } catch (e) {
            return new TextDecoder().decode(plain);
        }
    } catch (e) {
        return null;
    }
}

// 尝试解密 v2 响应：是信封则解密并包装为新 Response，否则原样返回
async function maybeDecryptV2Response(res) {
    if (!res || !res.ok) return res;
    try {
        const text = await res.text();
        const dec = await v2DecryptBody(text);
        if (dec !== null) {
            return new Response(dec, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        // 非信封（明文响应，如错误详情）→ 原样包装保留 body
        return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
        console.warn('[v2] 响应解密失败:', e);
        return res;
    }
}

async function apiFetch(url, options = {}) {
    // 接口版本模式（设置 → 通用 → 接口版本）。决定 v1/v2 尝试顺序与回退策略：
    //  v2优先(默认): [v2, v1]   v1优先: [v1, v2]   仅v1: [v1]   仅v2: [v2]
    const mode = getApiVersionMode();
    const hasV2 = mapToV2(url) !== url;
    const method = (options.method || 'GET').toUpperCase();

    // 仅v2 但该接口无 v2 版本 → 直接报错（"如果没有这个接口直接报错"）
    if (mode === '仅v2' && !hasV2) {
        throw new Error('该接口不存在 v2 版本：' + url);
    }

    const v2Path = hasV2 ? mapToV2(url).split('?')[0] : null;
    const v2Blocked = !!(v2Path && v2FailedPaths.has(v2Path)); // 该端点此前 v2 失败，本次跳过（仅v2 除外）
    let plan;
    if (mode === '仅v1') plan = ['v1'];
    else if (mode === '仅v2') plan = ['v2'];
    else if (mode === 'v2优先') plan = (hasV2 && !v2Blocked) ? ['v2', 'v1'] : ['v1'];
    else plan = (hasV2 && !v2Blocked) ? ['v1', 'v2'] : ['v1']; // v1优先（非默认回退）

    let lastRes = null, lastErr = null;
    for (let i = 0; i < plan.length; i++) {
        const ver = plan[i];
        const isLast = i === plan.length - 1;
        const targetUrl = ver === 'v2' ? mapToV2(url) : url;
        const strictV2 = (ver === 'v2' && mode === '仅v2');

        // 每次尝试用独立 headers 副本，避免 v2 专属头泄漏到 v1 尝试
        const attemptOptions = Object.assign({}, options);
        attemptOptions.headers = Object.assign({}, options.headers || {});
        attemptOptions.headers['User-Agent'] = 'OldChatForKivotosNext';
        const token = localStorage.getItem('oc_access_token');
        if (token) attemptOptions.headers['Authorization'] = 'Bearer ' + token;

        if (ver === 'v2') {
            let signHdrs = {};
            try { signHdrs = await v2SignHeaders(targetUrl, method); } catch (e) {
                console.warn('[apiFetch] v2 签名失败：', targetUrl, e);
            }
            const sessReady = !!(window.__wsSession && window.__wsSession.getSessionId && window.__wsSession.getSessionId());
            if (signHdrs['X-Sign'] && sessReady) {
                Object.assign(attemptOptions.headers, signHdrs);
            } else if (strictV2) {
                throw new Error('v2 会话未就绪，无法发送 v2 请求：' + targetUrl);
            } else if (!isLast) {
                // 非严格模式且 v2 会话不可用：跳过本次 v2 尝试，交回退版本处理
                continue;
            }
        }

        try {
            const res = await _fetchVersion(targetUrl, attemptOptions, strictV2);
            if (res && res.ok) return res;
            lastRes = res;
            if (isLast) break;
            if (!_isFallbackable(res)) break;
        } catch (e) {
            lastErr = e;
            if (isLast) break;
        }
    }
    if (lastErr && !lastRes) throw lastErr;
    return lastRes;
}

// 单次版本尝试：GET 请求去重 + 候选地址降级
async function _fetchVersion(url, options, strictV2) {
    const isGet = !options.method || String(options.method).toUpperCase() === 'GET';
    if (isGet) {
        const token = localStorage.getItem('oc_access_token');
        const key = url + '|' + (token ? '1' : '0');
        if (_inflightGet.has(key)) {
            try { return (await _inflightGet.get(key)).clone(); } catch (e) { /* clone 失败则重新请求 */ }
        }
        const p = _fetchWithCandidates(url, options, strictV2);
        _inflightGet.set(key, p);
        try {
            const res = await p;
            return res ? res.clone() : res;
        } finally {
            _inflightGet.delete(key);
        }
    }
    return _fetchWithCandidates(url, options, strictV2);
}

// 判断某次失败响应是否值得回退到下一个版本尝试
function _isFallbackable(res) {
    if (!res) return true;               // 网络错误
    if (res.status >= 500) return true;  // 服务端暂不可用
    if (res.status === 404) {            // 路由不存在（非 JSON 404）→ 可能该版本无此接口
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (ct.indexOf('json') === -1) return true;
    }
    return false; // 2xx 已在上层 return；4xx（含 401 鉴权）按语义错误，不回退
}

// 按候选列表顺序请求：网络错误 / 5xx 自动降级到下一个候选
async function _fetchWithCandidates(url, options, strictV2) {
    if (!url.startsWith('/v1/') && !url.startsWith('/v2/')) {
        // 绝对地址（如媒体直链）不走候选降级
        return await tauriHttpFetch(url, options);
    }
    // 注意：候选项存的是「裸 origin」（如 http://oc.mcl0.dpdns.org，不含 /v1）。
    // url 本身已带 /v1 前缀（如 /v1/me），所以必须直接拼接，不能切掉 /v1，
    // 否则会打到 /me 这种不存在的路由，后端返回纯文本 "404 page not found"，
    // 前端 res.json() 就会抛 "Unexpected non-whitespace character after JSON at position 4"。
    let lastErr;
    for (let ci = 0; ci < BACKEND_CANDIDATES.length; ci++) {
        const base = BACKEND_CANDIDATES[ci];
        let res;
        try {
            res = await tauriHttpFetch(base + url, options);
        } catch (e) {
            lastErr = e;
            continue;
        }
        // 5xx 视为服务端暂不可用，尝试下一个候选（先释放 body，避免流悬挂）
        if (res.status >= 500) {
            lastErr = new Error('HTTP ' + res.status);
            try { if (res.body) res.body.cancel(); } catch (e) {}
            continue;
        }
        // 诊断：路由不存在时后端返回纯文本 "404 page not found"，调用方 res.json() 会抛
        // 一个非常难懂的 "Unexpected non-whitespace character after JSON at position 4"。
        // 这里提前把真实 URL 打出来，避免再次出现无从下手的排查。
        if (res.status === 404) {
            const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (ct.indexOf('json') === -1) {
                console.error('[apiFetch] 路由不存在（非 JSON 404），请检查 URL 拼接：' + base + url);
            }
        }
        if (res.status === 401) {
            // v2 端点 401 → 该端点熔断回退 v1 重发（本次即恢复；仅影响该端点，避免登录死循环）
            // 仅v2 模式(strictV2)下不回退 v1，让错误直接上浮
            if (!strictV2 && url.startsWith('/v2/')) {
                // 读取并打印 401 响应体（可能是加密信封，尝试解密）——服务器拒绝原因的关键调试信息
                let bodyText = '';
                try { bodyText = await res.text(); } catch (e) {}
                if (bodyText) {
                    let shown = bodyText;
                    if (options._v2Encrypted) {
                        try {
                            const dec = await v2DecryptBody(bodyText);
                            if (dec !== null) shown = dec;
                        } catch (e) {}
                    }
                    console.warn('[apiFetch] v2 401 响应体：' + base + url + ' → ' + String(shown).slice(0, 300));
                    // 服务端重启导致会话失效：清本地会话，下次 v2 请求自动重新握手
                    if (/invalid_session|missing_session/.test(bodyText) && window.__wsSession && window.__wsSession.clear) {
                        window.__wsSession.clear();
                    }
                }
                const cleanPath = url.split('?')[0];
                if (!v2FailedPaths.has(cleanPath)) {
                    v2FailedPaths.add(cleanPath);
                    console.warn('[apiFetch] v2 端点 401，熔断回退 v1：', url, options.headers);
                }
                const v1Url = v2ToV1(url);
                if (v1Url !== url) {
                    const hdrs = Object.assign({}, options.headers || {});
                    // 回退 v1 需清理 v2 专属头（签名 + 加密标记），否则 v1 服务器可能误判
                    delete hdrs['X-Sign'];
                    delete hdrs['X-Ts'];
                    delete hdrs['X-Nonce'];
                    delete hdrs['X-Device-Id'];
                    delete hdrs['X-Enc'];
                    delete hdrs['X-Session'];
                    delete hdrs['X-Burn-Secure'];
                    delete hdrs['X-Enc-Compression'];
                    for (const fb of BACKEND_CANDIDATES) {
                        try {
                            const r2 = await tauriHttpFetch(fb + v1Url, Object.assign({}, options, { headers: hdrs }));
                            if (r2.status < 500) return r2;
                        } catch (e) { /* 继续下一个候选 */ }
                    }
                }
                // 回退也失败：继续走下方刷新/登出逻辑
            }
            const refreshToken = localStorage.getItem('oc_refresh_token');
            if (refreshToken) {
                try {
                    const refreshRes = await tauriHttpFetch(BACKEND_CANDIDATES[0] + '/v1/auth/refresh', {
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
                        const replay = await tauriHttpFetch(base + url, options);
                        // v2 加密响应解密后返回
                        return options._v2Encrypted ? await maybeDecryptV2Response(replay) : replay;
                    }
                } catch (e) { /* 忽略，走登出流程 */ }
            }
            localStorage.removeItem('oc_access_token');
            localStorage.removeItem('oc_refresh_token');
            localStorage.removeItem('oc_user');
            window.location.href = 'login.html';
            return;
        }
        // v2 加密响应：解密后包装为新 Response，调用方 res.json() 拿到明文
        if (options._v2Encrypted) {
            return await maybeDecryptV2Response(res);
        }
        return res;
    }
    if (lastErr) throw lastErr;
    throw new Error('所有后端候选均不可用');
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

// 认证检查：没有 token 直接跳转登录页（登录页会自动填充并提交，实现直观版自动登录）
if (!localStorage.getItem('oc_access_token')) {
    window.location.href = 'login.html';
}

// ==================== 启动闪屏控制 ====================
// 关闭启动闪屏（index.html 中的 #appSplash），淡出后从 DOM 移除，避免初始化期间白屏
function hideAppSplash() {
    try {
        const s = document.getElementById('appSplash');
        if (!s || s.dataset.hidden === '1') return;
        s.dataset.hidden = '1';
        s.classList.add('hide');
        setTimeout(() => { if (s && s.parentNode) s.parentNode.removeChild(s); }, 400);
    } catch (e) { /* 忽略 */ }
}
// 安全兜底：若初始化异常中断导致闪屏未被正常关闭，最多 20s 强制移除，绝不卡死在白屏
setTimeout(hideAppSplash, 20000);

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
    // 构建加好友参数：ncuid 优先，旧 uid 降级（双写）
    function toUidParam(id) {
        return { to_uid: id, friend_ncuid: id };
    }
    // 构建已读参数：ncuid 优先，旧 uid 降级（双写）
    function withUidParam(id) {
        return { with_uid: id, with_ncuid: id };
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
    let _incomingFriendReqCache = null; // 会话内缓存：好友申请列表（避免每次打开用户主页都拉取 /v1/friends/requests）

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

    // 发现页子页面（除音乐）自绘滚动条：与聊天区一致，隐藏原生滚动条、用 dumogu 接管
    function initSubScrollbar(panelName, scrollSel) {
        const panel = document.querySelector('.main-panel[data-panel="' + panelName + '"]');
        const scroll = panel && panel.querySelector(scrollSel);
        if (!panel || !scroll) return;
        if (!(window['dumogu-scrollbar'] && window['dumogu-scrollbar'].DumoguScrollbar)) return;
        const sb = new window['dumogu-scrollbar'].DumoguScrollbar({ keepShow: true });
        sb.bind(scroll);
        sb.mount(panel);
        // 内容动态变化时刷新滚动条位置/尺寸，避免错位
        const mo = new MutationObserver(function () {
            try { sb.update(); } catch (e) {}
        });
        mo.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    initSubScrollbar('discover', '.discover-main');
    initSubScrollbar('court', '.court-detail');
    initSubScrollbar('plaza', '.plaza-files');
    initSubScrollbar('cip', '.cip-run-area');

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

    // 轨道与面板宽度按实际面板数量计算（不能写死 6 个），
    // 否则新增面板（如资源广场）后 translateX 与面板宽度不匹配，
    // 切换标签页时面板会错位、看起来宽度不一致。
    const sidebarPanelCount = sidebarPanels.length || 1;
    if (sidebarPanelsTrack) sidebarPanelsTrack.style.width = (sidebarPanelCount * 100) + '%';
    sidebarPanels.forEach(p => { p.style.width = (100 / sidebarPanelCount) + '%'; });

    function switchTab(tabName) {
        if (!sidebarPanelsTrack) return;

        // 按目标面板在轨道中的真实位置滑动（与选项卡按钮数量解耦，
        // 这样隐藏的「音乐」面板也能通过发现页跳转进入）
        const panelsArr = Array.from(sidebarPanels);
        const panelIndex = panelsArr.findIndex(p => p.dataset.panel === tabName);
        if (panelIndex < 0) return;
        const total = panelsArr.length;
        const step = 100 / total;

        // 侧边栏面板左右滑动
        sidebarPanelsTrack.style.transform = `translateX(-${panelIndex * step}%)`;
        sidebarPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));

        // 右侧主面板淡入淡出
        mainPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));

        // 发现页子页面（除音乐）切换时内容简易颜色淡入
        if (tabName === 'discover' || tabName === 'court' || tabName === 'plaza' || tabName === 'cip') {
            const p = document.querySelector('.main-panel[data-panel="' + tabName + '"]');
            const content = p && p.querySelector('.discover-main, .court-detail, .plaza-files, .cip-run-area');
            if (content) {
                content.classList.remove('oc-fade-in');
                void content.offsetWidth; // 强制重排以重触发动画
                content.classList.add('oc-fade-in');
            }
        }

        // 选项卡高亮：音乐/公开法庭/小程序是从「发现」进入的子页，保持「发现」高亮
        let highlightTab = tabName;
        if (tabName === 'music') highlightTab = 'discover';
        if (tabName === 'court') highlightTab = 'discover';
        if (tabName === 'plaza') highlightTab = 'discover';
        if (tabName === 'cip') highlightTab = 'discover';
        if (sidebarTabs) {
            sidebarTabs.querySelectorAll('.tab-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.tab === highlightTab);
            });
        }

        // 切换到音乐面板时加载列表（仅首次）
        if (tabName === 'music' && !musicLoaded) {
            loadMusicList();
        }

        // 切换到公开法庭面板时加载案件列表（仅首次）
        if (tabName === 'court' && !courtLoaded) {
            loadCourtCases();
        }

        // 切换到资源广场面板时加载分区列表（仅首次）
        if (tabName === 'plaza' && !plazaLoaded) {
            loadPlazaSections();
        }

        // 切换到小程序面板时加载清单（仅首次）
        if (tabName === 'cip' && !cipLoaded) {
            cipLoaded = true;
            if (window.CipController) window.CipController.refresh();
        }

        // 切换到设置面板时渲染设置页面
        if (tabName === 'settings') {
            renderSettingsPage(currentSettingsTab || 'profile');
        }

        // 回到发现页落地页：清空右侧内容、恢复空状态提示
        if (tabName === 'discover') {
            resetDiscoverMain();
        }

        // 离开发现页：清除发现页左面板板块项的高亮（进入发现页时不清除）
        if (tabName !== 'discover') {
            document.querySelectorAll('.sidebar-panel[data-panel="discover"] .contact-item').forEach(ci => ci.classList.remove('active'));
        }
    }
    window.switchTab = switchTab;

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
            const res = await tauriHttpFetch(fullUrl);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const lrcText = await res.text();
            renderLyricsText(lrcText);
        } catch (e) {
            console.error('[music] lyrics load failed:', e);
            lrcContainer.style.display = 'none';
            musicLrcObj = null;
        }
    }

    // 渲染歌词文本（LRC/TTML 已由 parseLyrics 解析）
    function renderLyricsText(lrcText) {
        const lrcContainer = musicWorkspace?.querySelector('.music-lyrics-container');
        const ul = lrcContainer?.querySelector('ul');
        if (!ul || !lrcContainer) return;
        musicLrcObj = parseLyrics(lrcText || '');
        musicLrcIndex = -1;
        ul.innerHTML = '';
        if (musicLrcObj.length === 0) {
            // 无歌词时隐藏整个歌词区域
            lrcContainer.style.display = 'none';
            return;
        }
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

    // 按 item_id 拉取歌词（v1.4.x 新接口兜底：/v1/music/plaza/lyrics?item_id=）
    // 响应兼容三种形态：歌词文本(lyrics/lrc/lyrics_text) / lyrics_url / 空
    async function fetchMusicLyricsById(itemId) {
        const lrcContainer = musicWorkspace?.querySelector('.music-lyrics-container');
        if (!itemId) { if (lrcContainer) lrcContainer.style.display = 'none'; return; }
        try {
            const res = await apiFetch('/v1/music/plaza/lyrics?item_id=' + encodeURIComponent(itemId));
            const data = await res.json();
            if (data.error) { if (lrcContainer) lrcContainer.style.display = 'none'; return; }
            const lrcText = data.lyrics || data.lrc || data.lyrics_text || (typeof data === 'string' ? data : '');
            if (lrcText) {
                renderLyricsText(lrcText);
            } else if (data.lyrics_url) {
                loadMusicLyrics(data.lyrics_url);
            } else if (lrcContainer) {
                lrcContainer.style.display = 'none';
            }
        } catch (e) {
            console.warn('[music] fetch lyrics by id failed:', e);
            if (lrcContainer) lrcContainer.style.display = 'none';
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
        // 加载歌词：优先数据自带的 lyrics_url；没有则用 v1.4.x 新接口按 item_id 兜底
        if (m.lyrics_url) {
            loadMusicLyrics(m.lyrics_url);
        } else {
            fetchMusicLyricsById(m.id);
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
            markPrioActivity(convKey);
        } else {
            badge.style.display = 'none';
        }
        schedulePriorityApply();
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
                    <div class="window-controls" style="position:absolute;right:12px;display:flex;gap:2px;">
                        <button class="win-ctrl-btn" id="spWinMinBtn" title="最小化"><i class="fa-solid fa-minus"></i></button>
                        <button class="win-ctrl-btn" id="spWinMaxBtn" title="最大化/还原"><i class="fa-regular fa-square"></i></button>
                        <button class="win-ctrl-btn" id="spWinCloseBtn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                    </div>
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

        // 动态卡片交错瀑布流：将 #spMomentsMasonry 内的卡片按「最短列」重新排列（横向交错）
        let spMasonryCards = null;
        let spLayoutRAF = null;
        function layoutSpMasonry() {
            const cont = scroll.querySelector('#spMomentsMasonry');
            if (!cont) return;
            let cards = spMasonryCards;
            if (!cards) { cards = Array.from(cont.children); spMasonryCards = cards; }
            if (!cards.length) return;
            // 先回收卡片到 cont（清除上一次生成的列容器），保证可重复布局
            const frag = document.createDocumentFragment();
            cards.forEach(c => frag.appendChild(c));
            cont.innerHTML = '';
            cont.appendChild(frag);
            const gap = 10;
            const width = cont.clientWidth || 600;
            let cols = Math.max(2, Math.floor((width + gap) / (260 + gap)));
            if (cols > 4) cols = 4;
            cont.style.display = 'flex';
            cont.style.gap = gap + 'px';
            cont.style.alignItems = 'flex-start';
            const colEls = [], colH = [];
            for (let i = 0; i < cols; i++) {
                const col = document.createElement('div');
                col.style.flex = '1 1 0';
                col.style.minWidth = '0';
                col.style.display = 'flex';
                col.style.flexDirection = 'column';
                col.style.gap = gap + 'px';
                cont.appendChild(col);
                colEls.push(col);
                colH.push(0);
            }
            // 保持原始顺序，依次放入当前最矮的列，形成横向交错瀑布流
            cards.forEach(card => {
                let min = 0;
                for (let i = 1; i < cols; i++) if (colH[i] < colH[min]) min = i;
                colEls[min].appendChild(card);
                colH[min] += card.offsetHeight + gap;
            });
        }
        function scheduleSpLayout() {
            if (spLayoutRAF) cancelAnimationFrame(spLayoutRAF);
            spLayoutRAF = requestAnimationFrame(() => { spLayoutRAF = null; layoutSpMasonry(); });
        }
        // 窗口缩放时：重排瀑布流 + 更新自绘滚动条位置，避免错位
        function onSpResize() {
            scheduleSpLayout();
            if (spScrollbar) spScrollbar.update();
        }
        window.addEventListener('resize', onSpResize);

        function closePanel() {
            window.removeEventListener('resize', onSpResize);
            if (spLayoutRAF) cancelAnimationFrame(spLayoutRAF);
            spMasonryCards = null;
            if (spScrollbar) { spScrollbar.destroy(); spScrollbar = null; }
            overlay.remove();
        }
        overlay.querySelector('#sp-close-btn').addEventListener('click', closePanel);

        // 用户空间三大金刚键：控制主窗口（与聊天/发现等界面一致）。
        // 注意：本函数位于 DOMContentLoaded 作用域，访问不到 initTauri IIFE 内的 invoke / syncMaximizeState，
        // 必须在此自行解析 tauriInvoke（同音乐面板做法），否则点击会抛 ReferenceError 而「按不动」。
        const spInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
        const spMinBtn = overlay.querySelector('#spWinMinBtn');
        const spMaxBtn = overlay.querySelector('#spWinMaxBtn');
        const spCloseBtn = overlay.querySelector('#spWinCloseBtn');
        function spSyncMaxIcon() {
            if (!spInvoke || !spMaxBtn) return;
            spInvoke('is_window_maximized').then(function(isMax) {
                const i = spMaxBtn.querySelector('i');
                if (!i) return;
                i.className = isMax ? 'fa-regular fa-clone' : 'fa-regular fa-square';
                spMaxBtn.title = isMax ? '还原' : '最大化';
            }).catch(function(){});
        }
        if (spInvoke) {
            if (spMinBtn) spMinBtn.addEventListener('click', function() { spInvoke('minimize_window').catch(function(){}); });
            if (spMaxBtn) spMaxBtn.addEventListener('click', function() { spInvoke('toggle_maximize_window').then(spSyncMaxIcon).catch(function(){}); });
            if (spCloseBtn) spCloseBtn.addEventListener('click', function() { spInvoke('close_window').catch(function(){}); });
            spSyncMaxIcon(); // 打开时同步一次图标
        }

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
                    // 检查是否有来自该用户的好友申请（会话内缓存，仅首次拉取，之后复用，避免每次打开主页都打 /v1/friends/requests）
                    try {
                        if (!_incomingFriendReqCache) {
                            const reqRes = await apiFetch('/v1/friends/requests');
                            const reqData = await reqRes.json();
                            _incomingFriendReqCache = reqData.requests || [];
                        }
                        const incoming = _incomingFriendReqCache.some(r => uidEq(getUid(r) || r.from_ncuid || r.from_uid, profileUid || ncuid || uid));
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

                spMasonryCards = null;
                let momentsHtml = '<div style="text-align:center;padding:40px;color:#999;">暂无动态</div>';
                const mom = momentsData.moments || [];
                if (mom.length > 0) {
                    momentsHtml = '<div id="spMomentsMasonry" style="padding:0 16px 20px;max-width:960px;margin:0 auto;">';
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
                        momentsHtml += '<div style="background:var(--panel-bg);border-radius:12px;padding:14px 16px;border:1px solid var(--border-color);" data-moment-id="' + (m.id || '') + '">' +
                            '<div style="font-size:11px;color:var(--secondary-text);margin-bottom:6px;">' + fmtTs(m.created_at) + '</div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.6;white-space:pre-wrap;word-break:break-word;">' + (m.body || '') + '</div>' +
                            media +
                            '<div style="display:flex;gap:16px;margin-top:10px;align-items:center;">' +
                                '<button class="sp-like-btn" data-moment-id="' + (m.id || '') + '" data-liked="' + (m.liked ? '1' : '0') + '" style="background:none;border:none;color:' + (m.liked ? '#ff4757' : 'var(--secondary-text)') + ';font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;"><i class="' + (m.liked ? 'fa-solid' : 'fa-regular') + ' fa-heart"></i> ' + (m.likes || 0) + '</button>' +
                                '<button class="sp-comment-btn" data-moment-id="' + (m.id || '') + '" style="background:none;border:none;color:var(--secondary-text);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-comment"></i> ' + (function(){ var c = m.comment_count || m.comments_count || m.total_comments || m.reply_count || (m.comments && m.comments.length) || 0; return c > 0 ? c : '-'; })() + '</button>' +
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

                // 动态卡片：JS 横向交错瀑布流布局（窗口缩放 / 图片加载后自动重排）
                layoutSpMasonry();
                scroll.querySelectorAll('#spMomentsMasonry img').forEach(img => {
                    img.addEventListener('load', scheduleSpLayout);
                    img.addEventListener('error', scheduleSpLayout);
                });

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
                // 评论数懒加载：默认显示 '-'，仅当用户滚动到该动态（进入可视区）时才补查真实数量。
                // 避免打开主页时对每条动态各发一次 moments/comments 的 N+1 请求（服务器压力的主要来源）。
                if (window.__spCommentObserver) { try { window.__spCommentObserver.disconnect(); } catch (e) {} }
                const spCommentObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (!entry.isIntersecting) return;
                        const btn = entry.target;
                        spCommentObserver.unobserve(btn);
                        const momentId = btn.dataset.momentId;
                        if (!momentId) return;
                        const cur = parseInt((btn.textContent || '').replace(/\D/g, '')) || 0;
                        if (cur > 0) return; // 服务端已给非零计数则信任之，跳过
                        apiFetch('/v1/moments/comments?moment_id=' + encodeURIComponent(momentId))
                            .then(r => r.json())
                            .then(data => {
                                const n = (data.comments || []).length;
                                if (n > 0) btn.innerHTML = '<i class="fa-solid fa-comment"></i> ' + n;
                            })
                            .catch(() => {});
                    });
                }, { root: scroll, rootMargin: '120px', threshold: 0.01 });
                window.__spCommentObserver = spCommentObserver;
                scroll.querySelectorAll('.sp-comment-btn').forEach(btn => {
                    const cur = parseInt((btn.textContent || '').replace(/\D/g, '')) || 0;
                    if (cur > 0) return;
                    spCommentObserver.observe(btn);
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
                        _incomingFriendReqCache = null;
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
                        _incomingFriendReqCache = null;
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
                        body: JSON.stringify({ group_id: groupId, user_uid: uid, user_ncuid: uid })
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
        // 手动退出：关闭自动登录，下次启动停在登录页等待手动输入
        localStorage.setItem('oc_auto_login', '0');
        window.location.href = 'login.html';
    });

    // 主题切换
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme-mode', theme);
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
        const current = document.documentElement.getAttribute('data-theme-mode') || 'light';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    // ===== 多主题系统（自定义 .css 主题）=====
    // 主题 = 注入到 <style id="active-theme"> 的一段 CSS（含 :root/[data-theme-mode=light] 与 [data-theme-mode=dark] 两套变量）。
    // 默认主题 = app.css 自身（即不注入任何覆盖）。深度/浅度由 data-theme-mode 控制，与主题正交。
    let USER_THEME_LIST = [];   // 用户主题元数据数组（含 css）
    let USER_THEMES = {};        // id -> css 映射，供即时注入
    let BUILTIN_THEME_META = null;  // 从 app.css 头部 @theme 注释解析出的内置默认主题元数据

    // ===== 插件系统 =====
    // 插件 = 用户放入 <app_config_dir>/plugins/ 的任意 .js 文件；启用状态存 localStorage。
    // 启动时读取插件列表，对「已启用」的插件用间接 eval 在全局作用域执行（行为接近 <script>），
    // 插件可访问 window 上的所有客户端全局接口（app.js 均为 window.xxx）。
    let USER_PLUGIN_LIST = [];   // 用户插件元数据数组
    let PLUGIN_ENABLED = {};     // id -> true/false（localStorage 'oc_plugin_states' 持久化）

    function getInvoke() {
        return (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
            (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
    }

    function loadPluginStates() {
        try { PLUGIN_ENABLED = JSON.parse(localStorage.getItem('oc_plugin_states') || '{}') || {}; }
        catch (e) { PLUGIN_ENABLED = {}; }
    }

    function savePluginStates() {
        try { localStorage.setItem('oc_plugin_states', JSON.stringify(PLUGIN_ENABLED)); } catch (e) {}
    }

    // 读取并执行单个插件源码（(0,eval) 间接执行 → 全局作用域，顶层 var/function 进全局）
    async function loadPlugin(id) {
        const invoke = getInvoke();
        if (!invoke) return;
        try {
            const src = await invoke('read_plugin_source', { id });
            if (!src) return;
            (0, eval)(src);
            console.log('[plugin] loaded:', id);
        } catch (e) {
            console.error('[plugin] failed to load ' + id + ':', e);
        }
    }

    // 从后端读取已安装插件；未记录过状态的插件默认启用；随后执行全部已启用插件（启动时调用）
    async function refreshUserPlugins() {
        if (!IS_TAURI) return;
        const invoke = getInvoke();
        if (!invoke) return;
        try {
            const list = await invoke('list_user_plugins');
            USER_PLUGIN_LIST = Array.isArray(list) ? list : [];
            loadPluginStates();
            // 新插件（首次出现）默认启用：添加即生效
            let changed = false;
            USER_PLUGIN_LIST.forEach(p => {
                if (PLUGIN_ENABLED[p.id] === undefined) { PLUGIN_ENABLED[p.id] = true; changed = true; }
            });
            if (changed) savePluginStates();
            for (const p of USER_PLUGIN_LIST) {
                if (PLUGIN_ENABLED[p.id]) await loadPlugin(p.id);
            }
        } catch (e) {
            console.error('[plugin] refreshUserPlugins failed:', e);
        }
    }

    // 开关插件：启用 → 立即执行；禁用 → JS 副作用无法撤销，询问后刷新应用生效
    async function togglePlugin(id, enabled) {
        PLUGIN_ENABLED[id] = !!enabled;
        savePluginStates();
        if (enabled) {
            await loadPlugin(id);
            renderSettingsPlugins();
            showAlert('插件已启用');
        } else {
            renderSettingsPlugins();
            const ok = await showConfirm('禁用插件「' + id + '」后，需要重新加载界面才能完全移除其效果，是否现在刷新？');
            if (ok) location.reload();
        }
    }

    // ===== 内置主题：ModernBlock（现代化的纯黑白 neo-brutalist 主题）=====
    const MODERN_BLOCK_CSS = `
/*
 * @theme id: modern-block
 * @theme name: ModernBlock
 * @theme description: 现代化的黑白主题
 * @theme author: Aoharu Reverie
 * @theme version: 1.0.0
 * @theme framework: v1
 */

/* 1) 调色板：复用 app.css 的语义变量，仅重映射为纯黑白。
      不触碰任何布局/结构，因此右侧面板等与默认主题渲染路径完全一致，不会变空白。 */
:root, [data-theme-mode="light"] {
  --bg: #ffffff;
  --sidebar-bg: #ffffff;
  --chat-bg: #ffffff;
  --header-bg: #ffffff;       /* 顶栏与下方同色（白底黑字） */
  --text: #000000;
  --secondary-text: #555555;
  --border: #000000;
  --hover: #efefef;
  --active: #e0e0e0;
  --shadow: none;
  --msg-other-bg: #f0f0f0;
  --bubble-other: #f0f0f0;   /* 对面消息：浅灰底 */
  --bubble-self: #000000;    /* 自己消息：黑底 */
  --accent: #000000;
  --accent-dark: #333333;
  --header-height: 46px;
  --link-other: #000000;
  --link-self: #ffffff;
  --scrollbar-thumb: rgba(0,0,0,0.3);
  --scrollbar-thumb-hover: rgba(0,0,0,0.5);
  --rp-grad-start: #000000;
  --rp-grad-end: #333333;
  --panel-bg: #ffffff;
  --border-color: #000000;
  --input-bg: #ffffff;
  --title-bg: #000000;
  --title-text: #ffffff;
  --on-accent: #ffffff;       /* 自己气泡（黑底）之上的文字 */
  --link: #000000;
  --link-hover: #555555;
  --danger: #000000;
  --muted: #777777;
  --surface-2: #f0f0f0;
  --overlay: rgba(0,0,0,0.5);
  --discover-icon-bg: rgba(0,0,0,0.06);
  --discover-icon-fg: #555555;
}
[data-theme-mode="dark"] {
  --bg: #000000;
  --sidebar-bg: #000000;
  --chat-bg: #000000;
  --header-bg: #000000;       /* 顶栏与下方同色（黑底白字） */
  --text: #ffffff;
  --secondary-text: #aaaaaa;
  --border: #ffffff;
  --hover: #1a1a1a;
  --active: #2a2a2a;
  --shadow: none;
  --msg-other-bg: #1c1c1c;
  --bubble-other: #1c1c1c;   /* 深灰底 */
  --bubble-self: #ffffff;     /* 自己消息：白底 */
  --accent: #ffffff;
  --accent-dark: #cccccc;
  --header-height: 46px;
  --link-other: #ffffff;
  --link-self: #000000;
  --scrollbar-thumb: rgba(255,255,255,0.3);
  --scrollbar-thumb-hover: rgba(255,255,255,0.5);
  --rp-grad-start: #ffffff;
  --rp-grad-end: #cccccc;
  --panel-bg: #000000;
  --border-color: #ffffff;
  --input-bg: #000000;
  --title-bg: #ffffff;
  --title-text: #000000;
  --on-accent: #000000;       /* 自己气泡（白底）之上的文字 */
  --link: #ffffff;
  --link-hover: #cccccc;
  --danger: #ffffff;
  --muted: #888888;
  --surface-2: #1c1c1c;
  --overlay: rgba(0,0,0,0.6);
  --discover-icon-bg: rgba(255,255,255,0.12);
  --discover-icon-fg: #cccccc;
}

/* 2) 纯直角：去除所有圆角（仅 border-radius，不动布局） */
* { border-radius: 0 !important; }

/* 2b) 字体：去掉 zyyt 艺术字，改用系统非衬线（排除 Font Awesome 图标类，避免图标变“口”） */
*:not(.fa-solid):not(.fa-regular):not(.fa-brands):not(.fa):not(.fas):not(.far):not(.fab):not(.fa-classic) {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", sans-serif !important;
}

/* 3) 气泡：自己黑底白字（保留硬黑边）、对面浅/深灰底黑/白字（无边框），去三角形伪类。
      背景直接走 app.css 的 var(--bubble-self/other)，不 blanket 覆盖其它层。 */
.message.self .message-bubble:not(.no-frame) {
  background-color: var(--bubble-self) !important;
  color: var(--on-accent) !important;
  border: 2px solid var(--border) !important;
}
.message.other .message-bubble:not(.no-frame) {
  background-color: var(--bubble-other) !important;
  color: var(--text) !important;
}
.message-bubble::before,
.message-bubble::after,
.message-bubble.no-frame::before { display: none !important; }

/* 4) 顶栏：与下方同色，所有文字/图标跟随主题文字色（不再硬编码白，浅色下也清晰可读） */
.chat-header {
  background: var(--header-bg) !important;
  color: var(--text) !important;
}
.chat-header .chat-title,
.chat-header .chat-status,
.chat-header .chat-subtitle { color: var(--text) !important; }
.chat-header .icon-btn,
.chat-header .header-menu-btn,
.chat-header .win-ctrl-btn,
.chat-header button {
  color: var(--text) !important;
  background: transparent !important;
}
.chat-header .icon-btn:hover,
.chat-header .header-menu-btn:hover,
.chat-header .win-ctrl-btn:hover {
  background: var(--hover) !important;
  color: var(--text) !important;
}

/* 4b) 所有窗口控制按钮（min/close 等）跟随主题文字色，避免浅色下白底白字看不见 */
.win-ctrl-btn { color: var(--text) !important; background: transparent !important; }
.win-ctrl-btn:hover { background: var(--hover) !important; color: var(--text) !important; }

/* 4b2) 侧边栏头部：用户名/图标跟随主题文字色（app.css:165 硬编码 #fff，浅色下白底白字） */
.sidebar-header .user-info,
.sidebar-header .icon-btn { color: var(--text) !important; }
.sidebar-header .icon-btn:hover { background: var(--hover) !important; }

/* 4c) Typing 头像：去掉 app.css 的 1px 黑色描边（box-shadow 环，由 --border-color 变黑） */
.typing-indicator .typing-avatar { box-shadow: none !important; }

/* 4d) 二级面板标题栏 + 实心按钮（用户主页/音乐/法庭/添加好友/群管理/好友面板）：
      app.css(.gm-header/.mp-header) 与内联样式均硬编码 color:#fff，浅色下白底白字。
      用 !important 压过内联样式，文字/图标跟随 --text（背景已是 --header-bg）。 */
div[style*="background:var(--header-bg)"] { color: var(--text) !important; }
div[style*="background:var(--header-bg)"] *,
button[style*="background:var(--header-bg)"] { color: var(--text) !important; }
.gm-header, .mp-header,
.gm-header *, .mp-header * { color: var(--text) !important; }

/* 5) 按钮：逐字复刻官网下载页 neo-brutalist——静止无阴影，hover 左上偏移留 3px 黑影并反色，active 复原，0.12s 快速过渡 */
.btn {
  display: inline-block;
  padding: 10px 18px;
  border: 2px solid #000;
  background: #fff;
  color: #000;
  font-weight: 700;
  text-decoration: none;
  margin: 6px 6px 6px 0;
  border-radius: 0;
  white-space: nowrap;
  box-shadow: 0 0 0 #000;
  transition: transform .12s ease, box-shadow .12s ease, background-color .12s ease, color .12s ease;
}
.btn:hover {
  background: #000;
  color: #fff;
  transform: translate(-3px, -3px);
  box-shadow: 3px 3px 0 #000;
}
.btn:active {
  background: #fff;
  color: #000;
  transform: translate(0, 0);
  box-shadow: 0 0 0 #000;
}
.btn:focus-visible {
  background: #000;
  color: #fff;
  outline: none;
}
/* 主按钮：常态实心黑底白字，hover 反色白底黑字 + 白色残影（残影跟随按钮自身颜色），active 复原 */
.btn.primary {
  background: #000;
  color: #fff;
}
.btn.primary:hover {
  background: #fff;
  color: #000;
  transform: translate(-3px, -3px);
  box-shadow: 3px 3px 0 #fff;
}
.btn.primary:active {
  background: #000;
  color: #fff;
  transform: translate(0, 0);
  box-shadow: 0 0 0 #000;
}
`;

    const QQ_BLUE_CSS = `
:root, [data-theme-mode="light"] {
  --bg: #FFFFFF;
  --sidebar-bg: #FFFFFF;
  --chat-bg: #FFFFFF;
  --header-bg: #4C8BFF;                                    /* 渐变兜底纯色（取渐变起点） */
  --header-gradient: linear-gradient(to right, #4C8BFF, #20D1FE);
  --text: #1A1A1A;                                         /* 白底正文用近黑 */
  --secondary-text: #6B7280;
  --border: #E3E8EF;
  --hover: #F0F4F8;
  --active: #E3ECF5;
  --shadow: 0 2px 6px rgba(0,0,0,0.08);
  --msg-other-bg: #F2F4F7;
  --bubble-other: #E5E5E5;                                 /* 对方消息：浅灰底 */
  --bubble-self: #09B8F5;                                  /* 自己消息：蓝底 */
  --accent: #12B7F5;                                       /* 主按钮 */
  --accent-dark: #0FA0D8;                                  /* 主按钮 hover */
  --header-height: 46px;
  --link-other: #0E8FD0;
  --link-self: #E6F8FF;
  --scrollbar-thumb: rgba(0,0,0,0.25);
  --scrollbar-thumb-hover: rgba(0,0,0,0.4);
  --rp-grad-start: #4C8BFF;
  --rp-grad-end: #20D1FE;
  --panel-bg: #FFFFFF;
  --border-color: #E3E8EF;
  --input-bg: #FFFFFF;
  --title-bg: #E5E5E5;                                      /* 称号：浅灰底 */
  --title-text: #000000;                                    /* 称号：黑字 */
  --on-accent: #FFFFFF;                                    /* 自己气泡（蓝底）之上的白字 */
  --link: #0E8FD0;
  --link-hover: #12B7F5;
  --danger: #FF5B5B;
  --muted: #8A93A2;
  --surface-2: #F0F4F8;
  --overlay: rgba(0,0,0,0.5);
  --discover-icon-bg: rgba(74,158,255,0.15);
  --discover-icon-fg: #4a9eff;
}

/* 其他按钮：#878B99 底 + 白字（用 :not(.primary) 避免覆盖主按钮，主按钮走 --accent） */
.btn:not(.primary) {
  background: #878B99 !important;
  color: #FFFFFF !important;
}
.btn:not(.primary):hover {
  background: #757A88 !important;
  color: #FFFFFF !important;
}

/* 对方消息：浅灰底 + 黑字（基类 .message-bubble 硬编码 white，这里压回黑色） */
.message.other .message-bubble {
  color: #000000 !important;
}

/* 去掉自定义字体，改用默认非衬线（system-ui 栈，不含 zyyt 网络字体）。
   必须用 * 全元素选择器 + !important 才能盖掉 app.css 里挂在 .message-bubble/.sidebar-header 等
   具体元素上的 zyyt；排除 Font Awesome 图标类避免图标变“口”。 */
*:not(.fa-solid):not(.fa-regular):not(.fa-brands):not(.fa):not(.fas):not(.far):not(.fab):not(.fa-classic) {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", "微软雅黑", sans-serif !important;
}

/* 对方消息的引用块：#D6D6D7 浅灰底 + 黑字（自己消息不变） */
.message.other .quote-block,
.message.other .quote-block-image {
  background: #D6D6D7 !important;
  color: #000000 !important;
  border-left-color: #BFC0C2 !important;
}
.message.other .quote-block .quote-sender,
.message.other .quote-block-image .quote-sender {
  color: #000000 !important;
}

/* 输入栏 图片/表情/更多：去掉灰底，前景用原本的灰 (#878B99)，hover 仅留极淡灰蒙版 */
.input-buttons .btn:not(.primary) {
  background: transparent !important;
  color: #878B99 !important;
}
.input-buttons .btn:not(.primary):hover {
  background: rgba(135,139,153,0.12) !important;
  color: #878B99 !important;
}
`;

    const BUILTIN_THEMES = {
        'modern-block': {
            id: 'modern-block',
            name: 'ModernBlock',
            description: '现代化的黑白主题',
            author: 'Aoharu Reverie',
            version: '1.0.0',
            framework: 'v1',
            builtin: true,
            css: MODERN_BLOCK_CSS
        },
        'qqblue': {
            id: 'qqblue',
            name: 'QQ Blue',
            description: '经典 QQ 蓝',
            author: 'Aoharu Reverie',
            version: '1.0.0',
            framework: 'v1',
            builtin: true,
            showDayNightToggle: false,
            css: QQ_BLUE_CSS
        }
    };

    // 解析 @theme 注释元数据（与 parseThemeMeta 同规则，但此处不依赖设置块作用域）
    function parseBuiltinMeta(css) {
        const meta = { id: 'default', name: '', description: '', author: '', version: '', framework: 'v1', showDayNightToggle: '' };
        const re = /@theme\s+(\w+)\s*:\s*(.*)/;
        for (const raw of (css || '').split('\n')) {
            const s = raw.trim().replace(/^\*\s?/, '').trim();
            const m = s.match(re);
            if (m && m[1] in meta) meta[m[1]] = m[2].trim();
        }
        return meta;
    }

    // 启动时 fetch 当前 app.css 文本，取出默认主题的显示名称/简介，使在头部 @theme 处修改即可生效
    async function loadBuiltinThemeMeta() {
        try {
            const link = document.querySelector('link[rel="stylesheet"][href$="app.css"]')
                      || document.querySelector('link[href$="app.css"]');
            const href = link ? link.href : (location.pathname.endsWith('/') ? 'app.css' : './app.css');
            const res = await fetch(href, { cache: 'no-cache' });
            if (!res.ok) return;
            const text = await res.text();
            BUILTIN_THEME_META = parseBuiltinMeta(text);
        } catch (e) {
            console.warn('[theme] loadBuiltinThemeMeta failed:', e);
        }
    }

    function injectThemeStyle(css) {
        let el = document.getElementById('active-theme');
        if (!el) {
            el = document.createElement('style');
            el.id = 'active-theme';
            document.head.appendChild(el);
        }
        el.textContent = css;
    }

    function clearThemeStyle() {
        const el = document.getElementById('active-theme');
        if (el) el.remove();
    }

    // 应用某个主题：default 清除覆盖回退 app.css；内置/用户主题注入其 CSS
    function applyThemeById(id) {
        localStorage.setItem('themeId', id);
        if (id === 'default') { clearThemeStyle(); updateThemeToggleVisibility(id); return; }
        const css = USER_THEMES[id] || (BUILTIN_THEMES[id] && BUILTIN_THEMES[id].css);
        if (css) injectThemeStyle(css);
        else clearThemeStyle();
        updateThemeToggleVisibility(id);
    }

    // 根据主题元数据决定是否显示「昼夜切换」按钮。
    // 规则：内置主题看 showDayNightToggle（布尔）；用户主题解析 CSS 内 @theme showDayNightToggle 注释；
    // 未声明 / 'true' / 缺省 → 显示；显式 false → 隐藏。
    function updateThemeToggleVisibility(themeId) {
        const btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        let show = true;
        const builtin = BUILTIN_THEMES[themeId];
        if (builtin && 'showDayNightToggle' in builtin) {
            show = !!builtin.showDayNightToggle;
        } else if (themeId && themeId !== 'default' && USER_THEMES[themeId]) {
            const raw = parseThemeMeta(USER_THEMES[themeId]).showDayNightToggle;
            if (raw === false || raw === 'false') show = false;
            else if (raw === true || raw === 'true') show = true;
        }
        btn.style.display = show ? '' : 'none';
    }

    // 从后端读取已安装用户主题并还原上次选择
    async function refreshUserThemes() {
        if (!IS_TAURI) return;
        const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
            (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (!invoke) return;
        try {
            const list = await invoke('list_user_themes');
            USER_THEME_LIST = Array.isArray(list) ? list : [];
            USER_THEMES = {};
            USER_THEME_LIST.forEach(t => { if (t && t.css) USER_THEMES[t.id] = t.css; });
            const saved = localStorage.getItem('themeId') || 'default';
            if (saved !== 'default') applyThemeById(saved);
        } catch (e) {
            console.error('[theme] refreshUserThemes failed:', e);
        }
    }

    // 启动即还原（在 applyTheme 设置好 data-theme-mode 之后）
    refreshUserThemes();
    loadBuiltinThemeMeta();   // 读取 app.css 头部的 @theme 名称/简介，供设置页显示
    refreshUserPlugins();     // 启动加载已启用的用户插件

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

    // 群消息增量同步：WS 断线重连后，用最后渲染消息的时间戳补齐漏掉的群消息
    // 端点：GET /v1/groups/messages/after?group_id=<GID>&after=<秒级时间戳>（v1.4.x diff §2.2）
    async function syncGroupAfterReconnect() {
        if (!currentConv || currentConv.type !== 'group') return;
        const after = lastRenderedTs || 0;
        if (!after) return; // 当前会话还没有渲染过消息，无从增量
        const groupId = currentConv.id;
        const convKey = currentConv.key;
        try {
            const res = await apiFetch(`/v1/groups/messages/after?group_id=${encodeURIComponent(groupId)}&after=${after}`);
            const data = await res.json();
            if (data.error || !Array.isArray(data.messages)) return;
            // 只保留时间在 after 之后、且未渲染过的消息，避免与实时推送重复
            const existing = new Set();
            messagesContainer.querySelectorAll('.message[data-msg-id]').forEach(el => {
                if (el.dataset.msgId) existing.add(el.dataset.msgId);
            });
            const newMsgs = (data.messages || []).filter(m => m.id && (m.created_at || 0) > after && !existing.has(m.id));
            if (!newMsgs.length) return;
            const seen = seenMsgIds[convKey] || new Set();
            newMsgs.forEach(m => appendMessage(m, convKey, seen));
            scrollToBottom(true, true);
            // 更新会话最后时间戳
            const maxTs = newMsgs.reduce((mx, m) => Math.max(mx, m.created_at || 0), 0);
            if (maxTs > lastRenderedTs) lastRenderedTs = maxTs;
            console.log('[WS] 群增量同步补回 ' + newMsgs.length + ' 条消息');
        } catch (e) {
            console.warn('[WS] 群增量同步失败:', e);
        }
    }

    // ===== 聊天记录搜索（当前会话）=====
    // 端点：GET /v1/direct/messages/search?with_uid=&keyword= ｜ /v1/groups/messages/search?group_id=&keyword=（v1.4.x diff §2.1）
    function openChatSearch() {
        if (!currentConv) { showAlert('请先选择一个会话再搜索。'); return; }
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.style.alignItems = 'flex-start';
        overlay.style.paddingTop = '8vh';
        const box = document.createElement('div');
        box.className = 'custom-modal';
        box.style.maxWidth = '560px';
        box.style.width = 'calc(100vw - 40px)';
        box.style.maxHeight = '72vh';
        box.style.display = 'flex';
        box.style.flexDirection = 'column';

        const title = document.createElement('div');
        title.className = 'custom-modal-title';
        title.textContent = '搜索聊天记录';

        const inputRow = document.createElement('div');
        inputRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;flex-shrink:0;';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '输入关键词搜索当前会话...';
        input.style.cssText = 'flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--chat-bg);color:var(--text);font-size:13px;font-family:inherit;';
        const goBtn = document.createElement('button');
        goBtn.className = 'btn primary';
        goBtn.textContent = '搜索';
        inputRow.appendChild(input);
        inputRow.appendChild(goBtn);

        const list = document.createElement('div');
        list.style.cssText = 'overflow-y:auto;flex:1;min-height:120px;font-size:13px;color:var(--secondary-text);line-height:1.6;';
        list.textContent = '输入关键词开始搜索';

        const foot = document.createElement('div');
        foot.style.cssText = 'display:flex;justify-content:flex-end;margin-top:12px;flex-shrink:0;';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn';
        closeBtn.textContent = '关闭';
        closeBtn.addEventListener('click', () => overlay.remove());
        foot.appendChild(closeBtn);

        box.appendChild(title);
        box.appendChild(inputRow);
        box.appendChild(list);
        box.appendChild(foot);
        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        input.focus();

        async function doSearch() {
            const kw = input.value.trim();
            if (!kw) return;
            const conv = currentConv;
            if (!conv) return;
            list.textContent = '搜索中...';
            try {
                const url = conv.type === 'group'
                    ? `/v1/groups/messages/search?group_id=${encodeURIComponent(conv.id)}&keyword=${encodeURIComponent(kw)}`
                    : `/v1/direct/messages/search?with_uid=${encodeURIComponent(conv._sendToUid || conv.id)}&keyword=${encodeURIComponent(kw)}`;
                const res = await apiFetch(url);
                const data = await res.json();
                if (data.error) { list.textContent = String(data.error); return; }
                const results = data.messages || data.results || [];
                list.innerHTML = '';
                if (!results.length) { list.textContent = '未找到相关消息'; return; }
                results.forEach(m => {
                    const item = document.createElement('div');
                    item.style.cssText = 'padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;margin-bottom:6px;cursor:pointer;background:var(--panel-bg);';
                    item.addEventListener('mouseenter', () => { item.style.background = 'var(--hover)'; });
                    item.addEventListener('mouseleave', () => { item.style.background = 'var(--panel-bg)'; });
                    const head = document.createElement('div');
                    head.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:var(--secondary-text);margin-bottom:4px;';
                    head.textContent = (m.from_name || m.sender || '') + '　' + (m.created_at ? new Date(m.created_at * 1000).toLocaleString('zh-CN', { hour12: false }) : '');
                    const body = document.createElement('div');
                    body.style.cssText = 'color:var(--text);word-break:break-word;white-space:pre-wrap;max-height:48px;overflow:hidden;';
                    body.textContent = String(m.body || '').slice(0, 120);
                    item.appendChild(head);
                    item.appendChild(body);
                    item.addEventListener('click', () => {
                        overlay.remove();
                        jumpToMessage(m.id);
                    });
                    list.appendChild(item);
                });
            } catch (e) {
                list.textContent = '搜索失败：' + (e && e.message ? e.message : e);
            }
        }

        goBtn.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    }

    // 定位并高亮某条消息（若已渲染在列表中）
    function jumpToMessage(messageId) {
        if (!messageId) return;
        const target = messagesContainer.querySelector(`.message[data-msg-id="${CSS.escape(messageId)}"]`);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const prevBg = target.style.backgroundColor;
            target.style.backgroundColor = 'rgba(255, 200, 0, 0.25)';
            setTimeout(() => { target.style.backgroundColor = prevBg; }, 1800);
        } else {
            showAlert('该消息不在当前已加载的会话范围内。\n可先关闭重开会话加载历史后再试，或使用历史消息翻页定位。');
        }
    }

    document.getElementById('chatSearchBtn')?.addEventListener('click', openChatSearch);

    // Typing 状态（多用户支持）
    const typingUsers = new Map(); // convKey -> Map(uid -> { name, avatar, timer })
    let typingSendTimer = null;
    let lastTypingSent = 0;
    const TYPING_THROTTLE = 3000; // 每 3 秒最多发送一次

    // ECDH P-256 握手，派生 encKey/macKey
    // 握手进行中的共享 Promise：并发调用（多个 v2 请求同时触发签名、WS 建立）只握手一次，
    // 避免 handshake 风暴触发后端限流（"too many requests"）
    let wsHandshakePromise = null;

    async function ensureWsSession() {
        if (wsSessionId && wsEncKey && wsMacKey) return;
        if (wsHandshakePromise) return wsHandshakePromise;
        wsHandshakePromise = (async () => {
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
        })().finally(() => {
            wsHandshakePromise = null;
        });
        return wsHandshakePromise;
    }

    // 暴露给顶层 v2 签名/加密使用（apiFetch 在 IIFE 外，取不到闭包变量）
    window.__wsSession = {
        ensure: ensureWsSession,
        getMacKey: () => wsMacKey,
        getEncKey: () => wsEncKey,
        getSessionId: () => wsSessionId,
        clear: () => { wsSessionId = null; wsEncKey = null; wsMacKey = null; }
    };

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
                syncGroupAfterReconnect(); // 断线重连后补齐漏掉的群消息
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
                typingUsers.forEach((userMap) => {
                    userMap.forEach((entry) => clearTimeout(entry.timer));
                });
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
        const body = d.body || '';
        if (body.trim().startsWith('{')) {
            try {
                const obj = JSON.parse(body);
                if (obj.v === 2 && obj.forward_v2) {
                    const n = Array.isArray(obj.forward_v2.items) ? obj.forward_v2.items.length : 0;
                    return (obj.forward_v2.title || obj.text || '聊天记录') + (n ? '（共' + n + '条）' : '');
                }
                if (obj.text) return obj.text;
            } catch (e) {}
        }
        return body;
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
                group_seq: d.group_seq || 0,
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
        // 确保该会话有 Map
        if (!typingUsers.has(convKey)) {
            typingUsers.set(convKey, new Map());
        }
        const userMap = typingUsers.get(convKey);
        // 清除该用户的旧定时器
        if (userMap.has(user.uid)) {
            clearTimeout(userMap.get(user.uid).timer);
        }
        const timer = setTimeout(() => {
            hideTypingIndicator(convKey, user.uid);
        }, timeoutMs || 5000);
        userMap.set(user.uid, { uid: user.uid, name: user.name, avatar: user.avatar, timer });
        // 渲染所有头像
        renderTypingAvatars(convKey);
    }

    let typingLeaveTimer = null;
    function beginTypingLeave() {
        if (!typingIndicator) return;
        if (typingLeaveTimer) return;
        if (typingIndicator.style.display === 'none' && !typingIndicator.innerHTML) return;
        typingIndicator.classList.add('typing-leaving');
        typingLeaveTimer = setTimeout(() => {
            typingLeaveTimer = null;
            typingIndicator.classList.remove('typing-leaving');
            typingIndicator.style.display = 'none';
            typingIndicator.innerHTML = '';
        }, 260);
    }
    function cancelTypingLeave() {
        if (typingLeaveTimer) { clearTimeout(typingLeaveTimer); typingLeaveTimer = null; }
        if (typingIndicator) typingIndicator.classList.remove('typing-leaving');
    }

    function renderTypingAvatars(convKey) {
        if (!typingIndicator) return;
        cancelTypingLeave();
        const userMap = typingUsers.get(convKey);
        if (!userMap || userMap.size === 0) {
            beginTypingLeave();
            return;
        }
        const users = Array.from(userMap.values());
        const avatarCount = users.length;
        // 计算容器宽度：第一个头像完全可见，后续每个偏移14px（挡住左边半个），再加一颗头像宽度
        const containerWidth = 20 + (avatarCount - 1) * 14;

        // 复用容器与点的 DOM，仅更新宽度/位置并靠 CSS transition 平滑过渡，
        // 避免每次新头像进来时整体 innerHTML 重建导致的横向瞬移。
        let container = typingIndicator.querySelector('.typing-avatars-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'typing-avatars-container';
            typingIndicator.appendChild(container);
        }
        container.style.width = containerWidth + 'px';
        container.style.height = '24px';

        let dots = typingIndicator.querySelector('.typing-dots');
        if (!dots) {
            dots = document.createElement('span');
            dots.className = 'typing-dots';
            for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
            typingIndicator.appendChild(dots);
        }
        dots.style.left = containerWidth + 'px';

        // 调和头像：保留仍在场的、新增的淡入、离场的移除，避免整段重建。
        const presentUids = new Set(users.map(u => u.uid));
        Array.from(container.children).forEach((img) => {
            if (img.dataset && img.dataset.uid && !presentUids.has(img.dataset.uid)) {
                img.remove();
            }
        });
        users.forEach((u, index) => {
            let img = null;
            for (const child of container.children) {
                if (child.dataset && child.dataset.uid === u.uid) { img = child; break; }
            }
            if (!img) {
                img = document.createElement('img');
                img.className = 'typing-avatar';
                img.dataset.uid = u.uid;
                const avatarUrl = u.avatar
                    ? cachedResolveMediaUrl(u.avatar)
                    : cachedResolveMediaUrl(lookupAvatar(u.uid) || 'assets/default-avatar.png');
                img.src = avatarUrl || 'assets/default-avatar.png';
                img.alt = u.name || '';
                img.onerror = () => { img.onerror = null; img.src = 'assets/default-avatar.png'; };
                img.classList.add('typing-avatar-enter');
                container.appendChild(img);
            }
            img.style.left = (index * 14) + 'px'; // 每个头像向右偏移14px，右边挡住左边半个
            img.style.zIndex = index + 1;
        });
        typingIndicator.style.display = 'flex';
    }

    function hideTypingIndicator(convKey, removeUid) {
        if (!typingIndicator) return;
        if (convKey && typingUsers.has(convKey)) {
            const userMap = typingUsers.get(convKey);
            if (removeUid && userMap.has(removeUid)) {
                // 只移除指定用户
                clearTimeout(userMap.get(removeUid).timer);
                userMap.delete(removeUid);
            } else if (!removeUid) {
                // 没有指定 uid，移除整个会话
                userMap.forEach((entry) => clearTimeout(entry.timer));
                typingUsers.delete(convKey);
                beginTypingLeave();
                return;
            }
        }
        // 如果当前会话还有用户，重新渲染；否则隐藏
        if (currentConv && typingUsers.has(currentConv.key) && typingUsers.get(currentConv.key).size > 0) {
            renderTypingAvatars(currentConv.key);
        } else {
            beginTypingLeave();
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
        contactList.innerHTML = '';
        // 群聊分区
        const groupSection = document.createElement('div');
        groupSection.className = 'contact-section';
        groupSection.dataset.section = 'group';
        if (contacts.groups.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'contact-section-header';
            sep.textContent = '群聊';
            groupSection.appendChild(sep);
            contacts.groups.forEach(g => groupSection.appendChild(createContactItem(g.id, g.name, 'group', g.avatar)));
        }
        // 私聊分区
        const directSection = document.createElement('div');
        directSection.className = 'contact-section';
        directSection.dataset.section = 'direct';
        if (contacts.friends.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'contact-section-header';
            sep.textContent = '私聊';
            directSection.appendChild(sep);
            contacts.friends.forEach(f => directSection.appendChild(createContactItem(f.uid, f.name, 'direct', f.avatar, f.displayUid, f.user_title)));
        }
        contactList.appendChild(groupSection);
        contactList.appendChild(directSection);
        applyPriority(false);
        renderContactsPage();
    }

    // ===== 重点分区（侧边栏置顶分组）=====
    const PRIORITY_LS_KEY = 'oc_priority_section';
    let _prioClones = [];
    let _prioRaf = 0;
    let _prioAnimating = false;   // 动画进行中：期间新请求只标脏、不中途打断
    let _prioDirty = false;

    function isPriorityEnabled() {
        try { return localStorage.getItem(PRIORITY_LS_KEY) === '1'; } catch (e) { return false; }
    }
    function _prioSection() { return contactList.querySelector('.contact-section[data-section="priority"]'); }
    function _sectionForType(type) {
        return contactList.querySelector('.contact-section[data-section="' + (type === 'group' ? 'group' : 'direct') + '"]');
    }
    function sectionForItem(it) { return _sectionForType(it.dataset.type); }
    function _ensurePrioritySection() {
        let sec = _prioSection();
        if (!sec) {
            sec = document.createElement('div');
            sec.className = 'contact-section priority-section';
            sec.dataset.section = 'priority';
            const sep = document.createElement('div');
            sep.className = 'contact-section-header priority-header';
            sep.textContent = '重点';
            sec.appendChild(sep);
            contactList.insertBefore(sec, contactList.firstChild);
        }
        return sec;
    }
    function _ensureSectionHeaders() {
        ['priority', 'group', 'direct'].forEach(t => {
            const sec = contactList.querySelector('.contact-section[data-section="' + t + '"]');
            if (!sec) return;
            const has = sec.querySelector('.contact-item');
            sec.style.display = has ? '' : 'none';
        });
    }
    const prioLastActivity = {};      // key -> 最近活动时间戳(ms)
    const prioFresh = {};             // key -> 刚标记活跃（本次进入保证至少包含一次，消费即删）
    const prioOpenTimers = {};         // key -> 群聊进入延迟后移入重点的定时器
    // 时长设置（设置 → 通用 → 侧边栏，localStorage 秒数，滑块 0~30，默认 3s）
    const PRIO_ENTER_LS_KEY = 'oc_priority_enter_s';
    const PRIO_ACTIVE_LS_KEY = 'oc_priority_active_s';
    const PRIO_MAX_SEC = 30;
    function getPrioEnterDelay() {
        // 0 = 立即进入；1~30 = 秒；31 = 不自动进入（Infinity，永不触发）；未设置/非法 = 默认 31
        try {
            const v = parseInt(localStorage.getItem(PRIO_ENTER_LS_KEY), 10);
            if (v === 31) return Infinity;
            if (v >= 0) return Math.min(PRIO_MAX_SEC, v) * 1000;
            return Infinity;
        } catch (e) { return Infinity; }
    }
    function getPrioActiveMs() {
        // 0 = 立即移除（0ms，活动型会话下一次归位即移出）；1~30 = 秒；31 = 永不移除（Infinity）；未设置/非法 = 默认 0
        try {
            const v = parseInt(localStorage.getItem(PRIO_ACTIVE_LS_KEY), 10);
            if (v === 31) return Infinity;
            if (v >= 0) return Math.min(PRIO_MAX_SEC, v) * 1000;
            return 0;
        } catch (e) { return 0; }
    }

    function markPrioActivity(key) {
        prioLastActivity[key] = Date.now();
        prioFresh[key] = true; // 刚进入：下次归位保证包含，避免移除=0 时"还没进入就被移除"
    }
    function clearPrioOpenTimer(key) {
        if (prioOpenTimers[key]) { clearTimeout(prioOpenTimers[key]); delete prioOpenTimers[key]; }
    }
    function getPrioritySet(now) {
        now = now || Date.now();
        const set = new Set();
        // 任何有未读的会话都进入重点（直到被读）
        for (const k in unreadCounts) { if (unreadCounts[k] > 0) set.add(k); }
        // 最近活动过的会话（群聊打开后、或当前正在看的）在窗口内保留
        const w = getPrioActiveMs();
        for (const k in prioLastActivity) {
            if (now - prioLastActivity[k] <= w) { set.add(k); continue; }
            // 刚进入（标记时间戳后第一次判定必然 ≥1ms，窗口 0 会直接判死）——保证至少包含一次
            if (prioFresh[k]) { set.add(k); delete prioFresh[k]; }
        }
        return set;
    }
    // 心跳：保持「正在看」的会话活跃（仅当它已进入重点后才刷新，避免提前把群聊拉入），并驱动过期移出
    function prioHeartbeat() {
        if (!isPriorityEnabled()) return;
        if (currentConv && currentConv.key && prioLastActivity[currentConv.key]) {
            markPrioActivity(currentConv.key);
        }
        schedulePriorityApply();
    }
    setInterval(prioHeartbeat, 15000);
    function _resetPrioAnim() {
        _prioClones.forEach(c => c.remove());
        _prioClones = [];
        contactList.querySelectorAll('.contact-item').forEach(it => {
            it.style.transition = ''; it.style.transform = ''; it.style.opacity = ''; it.style.pointerEvents = '';
        });
    }
    function applyPriority(animate) {
        try {
            // 动画进行中又来新请求：不中途打断（否则正在滑动的项会被瞬移归位），只标脏待补跑。
            // 含 animate=false（renderContacts 重建列表）：否则 _resetPrioAnim 会清掉正在垂直 FLIP 的项的 transform → 上下瞬移
            if (_prioAnimating) { _prioDirty = true; return; }
            _resetPrioAnim();
            const enabled = isPriorityEnabled();
            const allItems = Array.from(contactList.querySelectorAll('.contact-item'));
            const first = new Map();
            allItems.forEach(it => {
                const ps = _prioSection();
                first.set(it, { rect: it.getBoundingClientRect(), inPrio: !!(ps && ps.contains(it)) });
            });
            if (!enabled) {
                const prioSec = _prioSection();
                if (prioSec) {
                    Array.from(prioSec.querySelectorAll('.contact-item')).forEach(it => sectionForItem(it).appendChild(it));
                    prioSec.remove();
                }
                _ensureSectionHeaders();
                return;
            }
            const prioSet = getPrioritySet();
            const prioSec = _ensurePrioritySection();
            const prioItems = [];
            const normalItems = [];
            allItems.forEach(it => { if (prioSet.has(it.dataset.convKey)) prioItems.push(it); else normalItems.push(it); });
            const currentKey = currentConv && currentConv.key;
            const currentItem = currentKey ? allItems.find(it => it.dataset.convKey === currentKey) : null;
            const wasCurrentInPrio = !!(currentItem && first.get(currentItem) && first.get(currentItem).inPrio);
            prioItems.forEach(it => { if (it === currentItem && wasCurrentInPrio) return; prioSec.appendChild(it); });
            normalItems.forEach(it => sectionForItem(it).appendChild(it));
            _ensureSectionHeaders();
            if (!animate) return;
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const moved = [];
            allItems.forEach(it => {
                if (currentItem && it === currentItem) return;
                const f = first.get(it);
                const nowPrio = prioSec.contains(it);
                if (f && f.inPrio !== nowPrio) moved.push({ it, fromRect: f.rect });
            });
            if (moved.length > 15) {
                contactList.querySelectorAll('.contact-item').forEach(it => { it.style.transition=''; it.style.transform=''; it.style.opacity=''; });
                return;
            }
            let _hasAnim = moved.length > 0;
            moved.forEach(({ it, fromRect }) => {
                it.style.pointerEvents = 'none';
                const clone = it.cloneNode(true);
                clone.classList.add('prio-anim-clone');
                clone.style.position = 'fixed';
                clone.style.left = fromRect.left + 'px';
                clone.style.top = fromRect.top + 'px';
                clone.style.width = fromRect.width + 'px';
                clone.style.height = fromRect.height + 'px';
                clone.style.margin = '0';
                clone.style.zIndex = '60';
                clone.style.pointerEvents = 'none';
                clone.style.transition = 'transform .42s cubic-bezier(.4,0,.2,1), opacity .42s';
                document.body.appendChild(clone);
                _prioClones.push(clone);
                it.style.transition = 'none';
                it.style.transform = 'translateX(' + window.innerWidth + 'px)';
                it.style.opacity = '0';
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    clone.style.transform = 'translateX(-' + (fromRect.left + fromRect.width + 40) + 'px)';
                    clone.style.opacity = '0';
                    it.style.transition = 'transform .42s cubic-bezier(.4,0,.2,1), opacity .42s';
                    it.style.transform = 'translateX(0)';
                    it.style.opacity = '1';
                }));
                setTimeout(() => {
                    clone.remove();
                    _prioClones = _prioClones.filter(c => c !== clone);
                    it.style.transition = ''; it.style.transform = ''; it.style.opacity = ''; it.style.pointerEvents = '';
                }, 480);
            });
            const lastItems = Array.from(contactList.querySelectorAll('.contact-item'));
            lastItems.forEach(it => {
                if (moved.some(m => m.it === it)) return;
                if (currentItem && it === currentItem) return;
                const f = first.get(it);
                if (!f) return;
                const dy = f.rect.top - it.getBoundingClientRect().top;
                if (Math.abs(dy) > 1) {
                    _hasAnim = true;
                    it.style.transition = 'none';
                    it.style.transform = 'translateY(' + dy + 'px)';
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        it.style.transition = 'transform .42s cubic-bezier(.4,0,.2,1)';
                        it.style.transform = 'translateY(0)';
                        setTimeout(() => { it.style.transition = ''; it.style.transform = ''; }, 460);
                    }));
                }
            });
            // 动画进行中上锁；结束后若期间有新的归位请求，补跑一次（合并爆发，避免中途打断瞬移）
            if (_hasAnim) {
                _prioAnimating = true;
                setTimeout(() => {
                    _prioAnimating = false;
                    if (_prioDirty) { _prioDirty = false; applyPriority(true); }
                }, 500);
            }
        } catch (e) {
            console.error('[applyPriority]', e);
            // 复位锁，避免异常后永久卡在"动画中"导致所有归位请求被吞
            _prioAnimating = false; _prioDirty = false;
            contactList.querySelectorAll('.contact-item').forEach(it => { it.style.transition=''; it.style.transform=''; it.style.opacity=''; it.style.pointerEvents=''; });
        }
    }
    function schedulePriorityApply() {
        if (!isPriorityEnabled()) return;
        // 动画进行中：只标脏、不排队新 rAF，等本次动画结束后由 applyPriority 补跑；避免中途打断瞬移
        if (_prioAnimating) { _prioDirty = true; return; }
        if (_prioRaf) return;
        _prioRaf = requestAnimationFrame(() => { _prioRaf = 0; applyPriority(true); });
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
        // 视频播放器（ArtPlayer）实例不随 DOM 缓存：清空旧播放器 DOM 后重新初始化
        cached.fragment.querySelectorAll('.video-message[data-art-init]').forEach(function (el) {
            el.innerHTML = '';
            delete el.dataset.artInit;
        });
        initArtPlayers(cached.fragment);
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
        // 重建 lastRenderedMsg（用于连续消息检测）。注意容器末尾通常是滚动锚点(scrollAnchor)，
        // 用 .message:last-child 会因此返回 null，故取「所有 .message 中的最后一个」以保证游标正确建立。
        const allMsgs = messagesContainer.querySelectorAll('.message');
        const lastMsgEl = allMsgs.length ? allMsgs[allMsgs.length - 1] : null;
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
            // 群 / 私聊统一：拉最新一页（offset=0）。群消息同步不做 seq 增量续拉
            // （/v2/groups/messages/after 接口有 Bug，已回退为统一的最新一页拉取）。
            const historyUrl = type === 'group'
                ? `/v1/groups/messages/v2?group_id=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=0`
                : `/v1/direct/messages/v2?with_ncuid=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=0`;
            let res, data;
            try {
                res = await apiFetch(historyUrl);
                data = await res.json();
                if (data.error) throw new Error(String(data.error));
            } catch (e) {
                console.error('[FETCH] API error for', historyUrl, e);
                return;
            }
            // 检查是否已切换会话或该请求已过期
            if (reqId !== fetchLatestReqId || currentConv?.key !== convKey) return;

            // 后端返回 DESC（最新在前）→ 反转为 ASC（旧→新）
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
            // 顶部插入「加载中」指示器（拉取更早消息时显示，完成后移除）
            let historySpinner = document.createElement('div');
            historySpinner.className = 'history-loading';
            historySpinner.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 加载中...';
            messagesContainer.insertBefore(historySpinner, messagesContainer.firstChild);
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
                messagesContainer.insertBefore(frag, historySpinner);

                // 先移除顶部加载指示器，再调整滚动位置、保持可视区域不变
                if (historySpinner && historySpinner.parentNode) historySpinner.remove();
                historySpinner = null;
                messagesContainer.scrollTop = messagesContainer.scrollHeight - scrollBottom;
            } catch (e) {
                console.error(e);
            } finally {
                if (historySpinner && historySpinner.parentNode) historySpinner.remove();
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
    
        // 私聊先查找 displayUid（旧 uid）用于 to_uid 参数
        let displayUid = '';
        if (type === 'direct') {
            const friend = contacts.friends.find(f => f.uid === id || f.displayUid === id);
            displayUid = friend ? (friend.displayUid || id) : id;
        }
        const prevConvKey = (currentConv && currentConv.key) || null;
        // 离开旧会话：取消其待定的延迟移入定时器（避免快速预览也被拉入重点）
        if (prevConvKey && prioOpenTimers[prevConvKey]) clearPrioOpenTimer(prevConvKey);
        currentConv = { type, id, name, key: convKey, _sendToUid: displayUid || id };
        // 群聊：进入延迟（0=立即，1~30=秒，31=不自动进入，可在设置调整）后才移入重点区域（私聊仅通过未读进入，读后即自然移出）
        if (type === 'group') {
            clearPrioOpenTimer(convKey);
            const delay = getPrioEnterDelay();
            if (delay !== Infinity) {
                prioOpenTimers[convKey] = setTimeout(() => {
                    delete prioOpenTimers[convKey];
                    markPrioActivity(convKey);
                    schedulePriorityApply();
                }, delay);
            }
        }
        schedulePriorityApply();

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
            // 新格式：优先拉取缩略图(thumb_url → media_url)，原图留作「查看原图」
            const thumbUrl = msg.thumb_url || msg.media_url || '';
            const origUrl = msg.media_url || msg.original_url || '';
            const imgEl = document.createElement('img');
            imgEl.src = cachedResolveMediaUrl(thumbUrl);
            if (origUrl) imgEl.dataset.original = origUrl; // 右键「查看原图」使用
            imgEl.style.cssText = 'max-width:200px;max-height:200px;border-radius:8px;cursor:pointer;';
            imgEl.className = 'chat-image';
            imgEl.onclick = () => openImageViewer(imgEl);
            imgEl.onerror = function() {
                // 缩略图加载失败：尝试一次原图，再失败才隐藏（避免无限循环）
                if (this.dataset.original) {
                    const orig = this.dataset.original;
                    this.dataset.original = '';
                    this.src = cachedResolveMediaUrl(orig);
                } else {
                    this.style.display = 'none';
                }
            };

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
            // ArtPlayer 容器：插入 DOM 后由 initArtPlayers 初始化播放器
            const vUrl = cachedResolveMediaUrl(msg.media_url || '');
            content = `<div class="video-message" data-src="${escapeHtml(vUrl)}" style="width:320px;max-width:100%;aspect-ratio:16/9;background:#000;"></div>`;
        } else if (msgType === 'audio') {
            content = `<audio controls style="max-width:200px;" src="${cachedResolveMediaUrl(msg.media_url || '')}"></audio>`;
        } else if (msgType === 'resource' || msgType === 'file') {
            // 支持嵌套 v2 JSON body（如音乐分享等）+ 音频文件检测
            let fileName = '';
            let displayText = '';
            let fileUrl = msg.media_url || '';
            const audioRegex = /\.(mp3|m4a|aac|amr|wav|wave|ogg|opus|flac)$/i;
            const videoRegex = /\.(mp4|3gp|mov|webm|mkv|avi)$/i;

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

            // 检测是否为音频/视频文件（按文件名或 URL 扩展名）
            const isAudio = audioRegex.test(fileName) || (fileUrl && audioRegex.test(fileUrl));
            const isVideo = videoRegex.test(fileName) || (fileUrl && videoRegex.test(fileUrl));

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
            } else if (isVideo && fileUrl) {
                // 视频文件：内嵌播放器（无外框消息，渲染后由气泡统一加 no-frame）
                const vHtml = `<div class="video-message" data-src="${escapeHtml(cachedResolveMediaUrl(fileUrl))}" style="width:320px;max-width:100%;aspect-ratio:16/9;background:#000;"></div>`;
                content = displayText
                    ? `<div style="margin-bottom:6px;white-space:pre-wrap;word-break:break-word;">${displayText}</div>${vHtml}`
                    : vHtml;
            } else {
                // 非音频/视频：渲染为文件卡片
                const fileCardHtml = `<div class="file-card">
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(fileName)}</div>
                    </div>
                    <a class="file-download-btn" data-dl-url="${escapeHtml(cachedResolveMediaUrl(fileUrl))}" data-dl-name="${escapeHtml(fileName || '')}" style="cursor:pointer;">⬇</a>
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
            content = `<a class="file-download-btn" data-dl-url="${escapeHtml(cachedResolveMediaUrl(fileUrl))}" data-dl-name="${escapeHtml(fileName || '')}" style="color:var(--link-other);cursor:pointer;">📎 ${escapeHtml(fileName)}</a>`;
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
                        if (obj.forward_v2) {
                            // 转发聊天记录（v2）：折叠卡片，点击展开完整记录
                            const fwd = obj.forward_v2;
                            const fwdItems = Array.isArray(fwd.items) ? fwd.items : [];
                            const fwdTitle = fwd.title || obj.text || '聊天记录';
                            const preview = fwdItems.slice(0, 3).map(function (it) {
                                const nm = it.from_name || it.from_ncuid || it.from_uid || '未知';
                                let tx = it.text || '';
                                if (it.type === 'image') tx = '[图片]';
                                else if (it.type === 'voice' || it.type === 'audio') tx = '[语音]';
                                else if (it.type === 'video') tx = '[视频]';
                                else if (it.media_url && it.type && it.type !== 'text') tx = '[文件]';
                                return escapeHtml(nm + '：' + tx);
                            }).join('\n');
                            const fwdData = encodeURIComponent(JSON.stringify(fwd));
                            content = '<div class="forward-card" data-forward="' + fwdData + '">'
                                + '<div class="forward-card-head"><i class="fa-solid fa-clock-rotate-left"></i><span class="forward-card-title">' + escapeHtml(fwdTitle) + '</span></div>'
                                + '<div class="forward-card-preview">' + preview.replace(/\n/g, '<br>') + (fwdItems.length > 3 ? '<br>…' : '') + '</div>'
                                + '<div class="forward-card-hint">点击查看完整聊天记录 ›</div>'
                                + '</div>';
                        } else {
                        textBody = textBody.replace(/\n/g, '<br>');
                        // 检查 v2 JSON 中的嵌套文件（如音频文件）
                        let nestedFileHtml = '';
                        if (obj.file) {
                            const nFileName = obj.file.name || obj.file.fileName || '';
                            const nFileUrl = obj.file.url || obj.file.media_url || '';
                            const audioRe = /\.(mp3|m4a|aac|amr|wav|wave|ogg|opus|flac)$/i;
                            const videoRe = /\.(mp4|3gp|mov|webm|mkv|avi)$/i;
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
                            } else if (nFileUrl && (videoRe.test(nFileName) || videoRe.test(nFileUrl))) {
                                // 嵌套视频文件：内嵌播放器（无外框消息）
                                nestedFileHtml = `<div class="video-message" data-src="${escapeHtml(cachedResolveMediaUrl(nFileUrl))}" style="width:320px;max-width:100%;aspect-ratio:16/9;background:#000;margin-top:6px;"></div>`;
                            } else if (nFileUrl) {
                                // 嵌套非音视频文件：渲染为文件卡片
                                nestedFileHtml = `<div class="file-card" style="margin-top:6px;">
                                    <div class="file-info"><div class="file-name">${escapeHtml(nFileName || '文件')}</div></div>
                                    <a class="file-download-btn" data-dl-url="${escapeHtml(cachedResolveMediaUrl(nFileUrl))}" data-dl-name="${escapeHtml(nFileName || '')}" style="cursor:pointer;">⬇</a>
                                </div>`;
                            }
                        }
                        content = quoteHtml + (textBody ? `<div style="white-space: pre-wrap; word-break: break-word;">${textBody}</div>` : '') + nestedFileHtml;
                        }
                    } else if (obj.v === 3 || (obj.buttons && Array.isArray(obj.buttons))) {
                        // v3 按钮消息：文本 + 内联按钮（Telegram 风格）
                        let textBody = escapeHtml(obj.text || '');
                        textBody = textBody.replace(/\n/g, '<br>');
                        const buttons = (obj.buttons || []).map(function (b) {
                            const label = escapeHtml(b.text != null ? b.text : '');
                            const action = escapeHtml(b.action || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                            const data = escapeHtml(b.data != null ? b.data : '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                            return '<button type="button" class="btn" data-btn-action="' + action + '" data-btn-data="' + data + '">' + label + '</button>';
                        }).join('');
                        content = (textBody ? '<div style="white-space: pre-wrap; word-break: break-word; margin-bottom:8px;">' + textBody + '</div>' : '') +
                            '<div class="msg-buttons">' + buttons + '</div>';
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
        // 红包/视频/转发聊天记录：不显示气泡外框（去掉背景/内边距/小箭头），仅保留卡片或播放器本身
        if (bubble.querySelector('.red-packet-card') || bubble.querySelector('.video-message') || bubble.querySelector('.forward-card')) {
            bubble.classList.add('no-frame');
        }
        // v3 按钮消息：为内联按钮绑定点击事件
        if (bubble) {
            bubble.querySelectorAll('.msg-buttons .btn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    const action = btn.dataset.btnAction;
                    const data = btn.dataset.btnData || '';
                    if (action === 'open_url') {
                        const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
                        if (tauriInvoke) {
                            tauriInvoke('plugin:opener|open_url', { url: data }).catch(function () { window.open(data, '_blank'); });
                        } else {
                            window.open(data, '_blank');
                        }
                    } else {
                        // send_text / reply_msg 等：作为文本消息发送到当前会话
                        if (typeof sendMessage === 'function') {
                            sendMessage(data, 'text');
                        }
                    }
                });
            });
        }
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

        // 「连消息」开关：同一发送者、5 分钟内的连续消息合并为一组（设置 → 主题，默认开启）
        let consecutiveEnabled = true;
        try { consecutiveEnabled = localStorage.getItem('oc_consecutive_messages') !== '0'; } catch (e) {}

        // 检查是否为连续消息（同发送者、5分钟内、同会话）
        // 使用 uidEq 兼容 uid/ncuid 两种格式
        const isConsecutive = consecutiveEnabled && lastRenderedMsg &&
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
        // 初始化本条消息内的 ArtPlayer 视频播放器
        initArtPlayers(msgDiv);
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
        // 临时消息（temp_开头）同样推进连消息游标：用户自己的发送会打断对方的连续消息链。
        // 若不推进，下一条对方消息会错误地与上一条（用户发言之前的那条）连成一组，
        // 造成「中间隔一个消息也被当连消息」的误连。（temp 消息带有真实 created_at，可安全参与判定）
        lastRenderedMsg = { convKey, from_uid: fromUid, element: msgDiv };
        lastRenderedTs = msgTs;
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
        if (targetMsg) {
            targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        // 当前页没有该消息：滚动到顶部并向前加载历史（最多 2 页）查找
        jumpToQuotedMessage(quotedId);
    });

    // 引用跳转：当前页缺失时，向前加载历史最多 2 页，定位被引用消息
    async function jumpToQuotedMessage(quotedId) {
        const convKey = currentConv && currentConv.key;
        if (!convKey) return;
        for (let page = 0; page < 2; page++) {
            const found = document.querySelector(`.message[data-msg-id="${CSS.escape(quotedId)}"]`);
            if (found) { found.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
            if (!convHasMore[convKey]) break;
            // 触发顶部加载（复用现有滚动加载逻辑），等待本次加载完成
            messagesContainer.scrollTop = 0;
            messagesContainer.dispatchEvent(new Event('scroll'));
            let guard = 0;
            while (isLoadingMore && guard < 120) { await new Promise(r => setTimeout(r, 50)); guard++; }
            await new Promise(r => setTimeout(r, 60));
        }
        const found = document.querySelector(`.message[data-msg-id="${CSS.escape(quotedId)}"]`);
        if (found) found.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

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
                var resp = await tauriHttpFetch(url);
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

        // 私聊用 displayUid（旧 uid）作为 to_uid，避免 NCUID 不被服务器接受
        if (currentConv.type === 'direct') {
            const friend = contacts.friends.find(f => f.uid === currentConv.id || f.displayUid === currentConv.id);
            if (friend && friend.displayUid) {
                currentConv._sendToUid = friend.displayUid;
            } else {
                currentConv._sendToUid = currentConv.id;
            }
        }

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
              }, { to_uid: currentConv._sendToUid || currentConv.id, to_ncuid: currentConv.id });
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
                        // 仅当被替换的临时消息「仍是最后一条」时才接管游标。若期间已有其它消息（如 WS 推送）到达，
                        // 临时消息已非末尾，游标已由那些消息正确接管，此处若强行覆盖会把后续同发送者消息误判为不连（「该连没连」）。
                        if (lastRenderedMsg && lastRenderedMsg.element === tempEl) {
                            lastRenderedMsg = { convKey: currentConv.key, from_uid: getFromUid(msg) || msg.from_uid || '', element: newEl };
                            lastRenderedTs = msg.created_at || 0;
                        }
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
            console.error('[SEND] 发送失败', lastError, 'payload:', JSON.stringify(payload));
            if (tempEl) { if (lastRenderedMsg && lastRenderedMsg.element === tempEl) { lastRenderedMsg = null; lastRenderedTs = 0; } tempEl.remove(); }
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
            if (!mentionJustInserted) {
                // 首次打开弹窗立即渲染；输入中改为防抖，避免每敲一字重算并重建全列表
                if (!mentionPopup.classList.contains('show')) {
                    showMentionPopup(atMatch[1]);
                } else {
                    mentionSearch.value = atMatch[1];
                    debouncedFilterMention(atMatch[1]);
                }
            }
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
                const members = (data.members || []).map(m => {
                    const name = m.display_name || m.username || getUid(m);
                    // 预计算拼音（全拼 + 首字母），避免每次按键重算导致大群卡顿
                    const _py = getPinyinInitials(name).toLowerCase();
                    const _ini = name.split('').map(ch => {
                        const p = pinyinMap[ch];
                        return p ? p[0] : ch.toLowerCase();
                    }).join('');
                    return {
                        uid: m.uid || '',
                        ncuid: m.ncuid || getUid(m),
                        name: name,
                        avatar: m.avatar_url || '',
                        _py: _py,
                        _ini: _ini
                    };
                });
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
            const members = (data.members || []).map(m => {
                const name = m.display_name || m.username || getUid(m);
                // 预计算拼音（全拼 + 首字母），避免每次按键重算导致大群卡顿
                const _py = getPinyinInitials(name).toLowerCase();
                const _ini = name.split('').map(ch => {
                    const p = pinyinMap[ch];
                    return p ? p[0] : ch.toLowerCase();
                }).join('');
                return {
                    uid: m.uid || '',            // 旧 uid
                    ncuid: m.ncuid || getUid(m), // ncuid（getUid 优先取 ncuid）
                    name: name,
                    avatar: m.avatar_url || '',
                    _py: _py,
                    _ini: _ini
                };
            });
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
            if (m.uid && m.uid.toLowerCase().includes(lower)) return true;
            if (m.ncuid && m.ncuid.toLowerCase().includes(lower)) return true;
            // 全拼搜索（优先用预计算缓存，避免大群每键重算）
            const pinyin = m._py || getPinyinInitials(m.name).toLowerCase();
            if (pinyin.includes(lower)) return true;
            // 拼音首字母搜索（如 "lgcr" 匹配 "LGCR837-1"，优先用预计算缓存）
            const initials = m._ini || m.name.split('').map(ch => {
                const py = pinyinMap[ch];
                return py ? py[0] : ch.toLowerCase();
            }).join('');
            if (initials.includes(lower)) return true;
            return false;
        });
        mentionActiveIndex = 0;
        renderMentionList(filtered);
    }

    // 防抖版：@ 输入过程中连续触发时只在停顿 140ms 后过滤一次，消除大群卡顿
    const debouncedFilterMention = debounce(filterMentionList, 140);

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
        debouncedFilterMention(this.value);
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
                    Object.assign(payload, { to_uid: currentConv._sendToUid || currentConv.id, to_ncuid: currentConv.id });
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
                if (tempEl) { if (lastRenderedMsg && lastRenderedMsg.element === tempEl) { lastRenderedMsg = null; lastRenderedTs = 0; } tempEl.remove(); }
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
                : Object.assign({ body: '', msg_type: msgType, media_url: upData.url, thumb_url: upData.thumb_url || '' }, { to_uid: currentConv._sendToUid || currentConv.id, to_ncuid: currentConv.id });
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
                if (tempEl) { if (lastRenderedMsg && lastRenderedMsg.element === tempEl) { lastRenderedMsg = null; lastRenderedTs = 0; } tempEl.remove(); }
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
                    // 仅当被替换的临时消息「仍是最后一条」时才接管游标；若期间已有其它消息（如 WS 推送）到达，
                    // 临时消息已非末尾，游标已由那些消息正确接管，此处若强行覆盖会把后续同发送者消息误判为不连（「该连没连」）。
                    if (lastRenderedMsg && lastRenderedMsg.element === tempEl) {
                        lastRenderedMsg = { convKey: currentConv.key, from_uid: getFromUid(msg) || msg.from_uid || '', element: newEl };
                        lastRenderedTs = msg.created_at || 0;
                    }
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
            if (tempEl) { if (lastRenderedMsg && lastRenderedMsg.element === tempEl) { lastRenderedMsg = null; lastRenderedTs = 0; } tempEl.remove(); }
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

        // 侧边栏列表右键菜单（按所属面板隔离，不复用聊天界面菜单）
        const contactItem = e.target.closest('.contact-item');
        if (contactItem) {
            e.preventDefault();
            const panel = contactItem.closest('.sidebar-panel');
            const panelName = panel ? panel.dataset.panel : 'chat';
            const convType = contactItem.dataset.type;
            const convId = contactItem.dataset.id;
            const convName = contactItem.dataset.name;

            // 设置 / 发现面板：导航项，无右键菜单
            if (panelName === 'settings' || panelName === 'discover') { return; }

            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';

            let menuHtml = '';
            if (panelName === 'music') {
                menuHtml = '<div class="context-menu-item" data-action="play">播放</div>' +
                    '<div class="context-menu-item" data-action="copy-link">复制链接</div>';
            } else if (panelName === 'contacts') {
                if (convType === 'group') {
                    menuHtml = '<div class="context-menu-item" data-action="send-msg">发消息</div>' +
                        '<div class="context-menu-item" data-action="group-manage">群聊管理</div>' +
                        '<div class="context-menu-divider"></div>' +
                        '<div class="context-menu-item" data-action="copy-id">复制ID</div>';
                } else {
                    menuHtml = '<div class="context-menu-item" data-action="send-msg">发消息</div>' +
                        '<div class="context-menu-item" data-action="profile">查看主页</div>' +
                        '<div class="context-menu-divider"></div>' +
                        '<div class="context-menu-item" data-action="copy-id">复制ID</div>';
                }
            } else {
                // chat 面板：会话级操作
                if (convType === 'group') {
                    menuHtml = '<div class="context-menu-item" data-action="group-manage">群聊管理</div>' +
                        '<div class="context-menu-divider"></div>' +
                        '<div class="context-menu-item" data-action="mark-read">全部已读</div>';
                } else {
                    menuHtml = '<div class="context-menu-item" data-action="mark-read">全部已读</div>';
                }
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
                } else if (action === 'send-msg') {
                    switchConversation(convType, convId, convName);
                    switchTab('chat');
                } else if (action === 'profile') {
                    openSpacePanel(convId);
                } else if (action === 'copy-id') {
                    const text = convId || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
                    } else { fallbackCopyText(text); }
                } else if (action === 'play') {
                    const m = musicData.find(m => (m.id || '') === contactItem.dataset.musicId);
                    if (m) playMusic(m);
                } else if (action === 'copy-link') {
                    const text = contactItem.dataset.musicUrl || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
                    } else { fallbackCopyText(text); }
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

        // 侧边栏非列表区域（头部/标签/空白）：隔离，不显示聊天面板菜单
        if (e.target.closest('.sidebar')) {
            e.preventDefault();
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
            // 图片消息额外增加"查看原图 / 另存为 / 收藏为表情"
            const msgType = msgDiv.dataset.msgType;
            if (msgType === 'image') {
                menuHtml += `<div class="context-menu-item" data-action="view-original">查看原图</div>`;
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
                } else if (action === 'view-original') {
                    // 查看原图：优先用 dataset.original（原图直链），回退到 rawBody 的 media_url/original_url，
                    // 最后回退当前缩略图，确保总能打开一张图。
                    const chatImg = msgDiv.querySelector('.chat-image');
                    let origUrl = (chatImg && chatImg.dataset.original) || '';
                    if (!origUrl) {
                        try {
                            const rawMsg = JSON.parse(msgDiv.dataset.rawBody || '{}');
                            origUrl = rawMsg.media_url || rawMsg.original_url || '';
                        } catch (e) {}
                    }
                    if (!origUrl && chatImg) origUrl = chatImg.src;
                    if (origUrl) openImageViewer(cachedResolveMediaUrl(origUrl));
                } else if (action === 'save-image') {
                    // 另存为：优先原图，回退当前缩略图
                    const chatImg = msgDiv.querySelector('.chat-image');
                    let dlUrl = (chatImg && chatImg.dataset.original) ? cachedResolveMediaUrl(chatImg.dataset.original) : '';
                    if (!dlUrl && chatImg && chatImg.src) dlUrl = chatImg.src;
                    if (dlUrl) downloadImage(dlUrl);
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
        } else if (tab === 'about') {
            renderSettingsAbout();
        } else if (tab === 'favorites') {
            renderSettingsFavorites();
        } else if (tab === 'theme') {
            renderSettingsTheme();
        } else if (tab === 'plugin') {
            renderSettingsPlugins();
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
                // 手动退出：关闭自动登录，下次启动停在登录页等待手动输入
                localStorage.setItem('oc_auto_login', '0');
                window.location.href = 'login.html';
            }
        });
    }

    function renderSettingsAppearance() {
        settingsContent.innerHTML = `
            <h3>通用</h3>
            <div class="settings-group">
                <div class="settings-item" id="settingsApiVersion">
                    <span class="label">接口版本</span>
                    <span class="value">
                        <select id="apiVersionSelect" style="max-width:150px;padding:4px 8px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;outline:none;cursor:pointer;">
                            <option value="v1优先">v1优先</option>
                            <option value="v2优先">v2优先（默认）</option>
                            <option value="仅v1">仅v1</option>
                            <option value="仅v2">仅v2</option>
                        </select>
                    </span>
                </div>
            </div>
            <h3 style="margin-top:20px;">侧边栏</h3>
            <div class="settings-group">
                <div class="settings-item" id="settingsPrioritySection">
                    <span class="label">重点分区</span>
                    <span class="value">
                        <label class="oc-switch">
                            <input type="checkbox" id="prioritySectionToggle">
                            <span class="oc-switch-slider"></span>
                        </label>
                    </span>
                </div>
                <div class="settings-item" id="settingsPrioEnter" style="cursor:default;">
                    <span class="label">进入延迟</span>
                    <span class="value">
                        <input type="range" id="prioEnterInput" min="0" max="31" step="1" style="width:140px;accent-color:var(--accent);">
                        <span id="prioEnterVal" style="min-width:72px;text-align:right;">31</span>
                    </span>
                </div>
                <div class="settings-item" id="settingsPrioActive" style="cursor:default;">
                    <span class="label">闲置移除</span>
                    <span class="value">
                        <input type="range" id="prioActiveInput" min="0" max="31" step="1" style="width:140px;accent-color:var(--accent);">
                        <span id="prioActiveVal" style="min-width:72px;text-align:right;">0</span>
                    </span>
                </div>
                <div style="padding:8px 14px;font-size:12px;color:var(--secondary-text);">
                    有未读的会话、以及最近打开过的群聊会进入「重点」分组（默认关闭）：进入延迟 0~31 秒（0=立即，31=不自动进入，默认 31），闲置移除 0~31 秒（0=立即，31=永不移除，默认 0）；未读会话不受滑块影响、始终立即进入；移动时带滑动动画。
                </div>
            </div>
            <h3 style="margin-top:20px;">服务器配置</h3>
            <div class="settings-group">
                <div style="font-size:12px;color:var(--secondary-text);margin-bottom:6px;">API 地址（普通内容，按列表顺序降级；<span style="color:var(--text);">★ 为首选地址，最先尝试</span>）</div>
                <div class="candidate-list" id="baseCandidateList"></div>
                <div style="display:flex;gap:6px;margin-top:6px;">
                    <input type="text" id="baseCandidateInput" placeholder="添加候选，如 http://host:8080" style="flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;outline:none;">
                    <button id="baseCandidateAdd" class="btn" style="padding:6px 12px;white-space:nowrap;">添加</button>
                </div>
                <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
                    <button class="candidate-quick" data-target="base" data-url="http://oc.mcl0.dpdns.org">+ oc.mcl0</button>
                    <button class="candidate-quick" data-target="base" data-url="http://60.205.94.101:8080">+ 60.205</button>
                    <button class="candidate-quick" data-target="base" data-url="https://oc.mcl0.dpdns.org">+ oc https</button>
                </div>
                <div style="font-size:12px;color:var(--secondary-text);margin:14px 0 6px;">媒体地址（图片/音频，按列表顺序降级；<span style="color:var(--text);">★ 为首选地址，最先尝试</span>）</div>
                <div class="candidate-list" id="mediaCandidateList"></div>
                <div style="display:flex;gap:6px;margin-top:6px;">
                    <input type="text" id="mediaCandidateInput" placeholder="添加候选，如 http://host:8080" style="flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;outline:none;">
                    <button id="mediaCandidateAdd" class="btn" style="padding:6px 12px;white-space:nowrap;">添加</button>
                </div>
                <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
                    <button class="candidate-quick" data-target="media" data-url="http://60.205.94.101:8080">+ 60.205</button>
                    <button class="candidate-quick" data-target="media" data-url="http://oc.mcl0.dpdns.org">+ oc.mcl0</button>
                    <button class="candidate-quick" data-target="media" data-url="https://oc.mcl0.dpdns.org">+ oc https</button>
                </div>
                <div style="display:flex;gap:8px;margin-top:14px;align-items:center;">
                    <button id="settingsSaveUrls" class="btn primary">保存并重载</button>
                    <button id="settingsResetUrls" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text);font-size:13px;cursor:pointer;font-family:inherit;">恢复默认</button>
                </div>
            </div>
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
        // 接口版本开关（设置 → 通用 → 接口版本）
        const apiSel = document.getElementById('apiVersionSelect');
        if (apiSel) {
            apiSel.value = getApiVersionMode();
            apiSel.addEventListener('change', () => {
                localStorage.setItem('oc_api_version', apiSel.value);
                try { v2FailedPaths.clear(); } catch (e) {} // 切换后重置 v2 端点熔断，允许重新尝试
                if (typeof showAlert === 'function') showAlert('接口版本已切换为「' + apiSel.value + '」，后续请求即时生效');
            });
        }
        // 重点分区开关（设置 → 通用 → 侧边栏 → 重点分区，默认关闭）
        const pToggle = document.getElementById('prioritySectionToggle');
        const prioSliderRows = ['settingsPrioEnter', 'settingsPrioActive'].map(id => document.getElementById(id));
        function updatePrioSliderVisibility() {
            const on = isPriorityEnabled();
            prioSliderRows.forEach(el => { if (el) el.style.display = on ? '' : 'none'; });
        }
        if (pToggle) {
            pToggle.checked = isPriorityEnabled();
            updatePrioSliderVisibility();
            pToggle.addEventListener('change', () => {
                try { localStorage.setItem(PRIORITY_LS_KEY, pToggle.checked ? '1' : '0'); } catch (e) {}
                updatePrioSliderVisibility();
                applyPriority(true);
            });
        }
        // 重点分区时长设置（滑块：进入 0~31s（0=立即，31=不自动进入）；移除 0~31s（0=立即，31=永不移除））
        function bindPrioTimeSlider(id, valId, lsKey, getter, fmt, maxSec) {
            const inp = document.getElementById(id);
            const valEl = document.getElementById(valId);
            if (!inp || !valEl) return;
            const ms = getter();
            inp.value = String(Math.min(maxSec, Math.max(0, ms === Infinity ? maxSec : Math.round(ms / 1000))));
            valEl.textContent = fmt(inp.value);
            inp.addEventListener('input', () => {
                valEl.textContent = fmt(inp.value);
                try { localStorage.setItem(lsKey, String(inp.value)); } catch (e) {}
                // 实时重排：缩短闲置窗口时过期项立即滑出
                schedulePriorityApply();
            });
        }
        bindPrioTimeSlider('prioEnterInput', 'prioEnterVal', PRIO_ENTER_LS_KEY, getPrioEnterDelay, v => v === '31' ? '不自动进入' : (v === '0' ? '立即' : v + ' 秒'), PRIO_MAX_SEC + 1);
        bindPrioTimeSlider('prioActiveInput', 'prioActiveVal', PRIO_ACTIVE_LS_KEY, getPrioActiveMs, v => v === '31' ? '永不移除' : (v === '0' ? '立即' : v + ' 秒'), PRIO_MAX_SEC + 1);
        // 服务器配置：候选列表管理 / 保存 / 恢复默认
        {
            const baseCands = BACKEND_CANDIDATES.slice();
            const mediaCands = MEDIA_CANDIDATES.slice();
            const baseList = document.getElementById('baseCandidateList');
            const mediaList = document.getElementById('mediaCandidateList');

            function renderCands(listEl, arr) {
                if (!listEl) return;
                listEl.innerHTML = '';
                if (arr.length === 0) {
                    listEl.innerHTML = '<span style="font-size:12px;color:var(--secondary-text);">（无候选，将使用默认顺序）</span>';
                    return;
                }
                arr.forEach((url, idx) => {
                    const tag = document.createElement('span');
                    tag.className = 'candidate-tag';
                    const label = document.createElement('span');
                    label.textContent = (idx === 0 ? '★ ' : '') + url;
                    label.title = (idx === 0 ? '首选地址（最先尝试，失败后降级到下一个）' : '');
                    const x = document.createElement('i');
                    x.className = 'fa-solid fa-xmark';
                    x.style.cursor = 'pointer';
                    x.style.marginLeft = '6px';
                    x.addEventListener('click', () => { arr.splice(idx, 1); renderCands(listEl, arr); });
                    tag.appendChild(label);
                    tag.appendChild(x);
                    listEl.appendChild(tag);
                });
            }
            function addCand(arr, listEl, inputEl) {
                const v = (inputEl && inputEl.value || '').trim();
                if (!v) return;
                if (!arr.includes(v)) arr.push(v);
                if (inputEl) inputEl.value = '';
                renderCands(listEl, arr);
            }
            renderCands(baseList, baseCands);
            renderCands(mediaList, mediaCands);

            document.getElementById('baseCandidateAdd')?.addEventListener('click', () => addCand(baseCands, baseList, document.getElementById('baseCandidateInput')));
            document.getElementById('mediaCandidateAdd')?.addEventListener('click', () => addCand(mediaCands, mediaList, document.getElementById('mediaCandidateInput')));
            document.getElementById('baseCandidateInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCand(baseCands, baseList, e.target); });
            document.getElementById('mediaCandidateInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCand(mediaCands, mediaList, e.target); });
            document.querySelectorAll('.candidate-quick').forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.target;
                    const url = btn.dataset.url;
                    if (target === 'base') { if (!baseCands.includes(url)) baseCands.push(url); renderCands(baseList, baseCands); }
                    else { if (!mediaCands.includes(url)) mediaCands.push(url); renderCands(mediaList, mediaCands); }
                });
            });

            document.getElementById('settingsSaveUrls')?.addEventListener('click', () => {
                const base = baseCands.join(' ');
                const media = mediaCands.join(' ');
                if (base) localStorage.setItem('oc_custom_base_url', base);
                else localStorage.removeItem('oc_custom_base_url');
                if (media) localStorage.setItem('oc_custom_media_url', media);
                else localStorage.removeItem('oc_custom_media_url');
                refreshEndpoints();
                window.location.reload();
            });
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

    async function renderCheckin(target) {
        target = target || settingsContent;
        target.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:20px;color:var(--secondary-text);">加载中...</div>';
        try {
            let wallData = {};
            try {
                const wallRes = await apiFetch('/v1/me/checkin/wall?limit=50');
                if (wallRes.status === 404) {
                    target.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:60px 20px;color:var(--secondary-text);"><i class="fa-solid fa-hammer" style="font-size:32px;margin-bottom:12px;display:block;"></i>功能建设中，敬请期待</div>';
                    return;
                }
                const wallText = await wallRes.text();
                try { wallData = JSON.parse(wallText); } catch (e) { console.warn('[checkin] wall not JSON:', wallText.slice(0, 100)); }
            } catch (e) {
                target.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:60px 20px;color:var(--secondary-text);"><i class="fa-solid fa-hammer" style="font-size:32px;margin-bottom:12px;display:block;"></i>功能建设中，敬请期待</div>';
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
            target.innerHTML = html;

            // 签到按钮
            document.getElementById('checkinDoBtn')?.addEventListener('click', async () => {
                try {
                    const res = await apiFetch('/v1/me/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    const text = await res.text();
                    let data = {};
                    try { data = JSON.parse(text); } catch (e) {}
                    if (data.error) { showAlert(data.error); return; }
                    renderCheckin(target);
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
                    renderCheckin(target);
                } catch (e) { showAlert('留言失败'); }
            });

            // 点赞
            target.querySelectorAll('.sp-c-like').forEach(btn => {
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
                        renderCheckin(target);
                    } catch (e) { console.error(e); }
                });
            });

            // 评论
            target.querySelectorAll('.sp-c-comment').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    if (!id) return;
                    openCheckinCommentsPanel(id, btn);
                });
            });
        } catch (e) {
            console.error('[checkin]', e);
            target.innerHTML = '<h3>签到墙</h3><div style="text-align:center;padding:20px;color:var(--secondary-text);">加载失败</div>';
        }
    }

    // ===== 系统通知页（入口在发现页，设计参考签到墙） =====
    // 从多个候选字段名中取第一个非空值（兼容不同版本后端字段命名）
    function noticePick(obj, names) {
        if (!obj || typeof obj !== 'object') return '';
        for (const n of names) {
            const v = obj[n];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return '';
    }

    // 从响应里找出通知数组：兼容 {notifications:[]} / {data:{...}} / {data:[]} / 直接数组 / 第一个非空数组值
    function extractNoticeList(obj) {
        if (Array.isArray(obj)) return obj;
        if (obj && typeof obj === 'object') {
            for (const k of ['notifications', 'items', 'list', 'records', 'messages', 'data']) {
                if (Array.isArray(obj[k])) return obj[k];
            }
            if (obj.data && typeof obj.data === 'object') return extractNoticeList(obj.data);
            for (const k of Object.keys(obj)) {
                if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
            }
        }
        return [];
    }

    async function renderSystemNotice(target) {
        target = target || settingsContent;
        target.innerHTML = '<h3>系统通知</h3><div style="text-align:center;padding:20px;color:var(--secondary-text);">加载中...</div>';
        let items = [];
        try {
            let data = {};
            try {
                const res = await apiFetch('/v1/notifications?limit=50');
                if (res.status === 404) {
                    target.innerHTML = '<h3>系统通知</h3><div style="text-align:center;padding:60px 20px;color:var(--secondary-text);"><i class="fa-solid fa-hammer" style="font-size:32px;margin-bottom:12px;display:block;"></i>功能建设中，敬请期待</div>';
                    return;
                }
                const text = await res.text();
                try { data = JSON.parse(text); } catch (e) { console.warn('[notice] not JSON:', text.slice(0, 100)); }
            } catch (e) {
                target.innerHTML = '<h3>系统通知</h3><div style="text-align:center;padding:60px 20px;color:var(--secondary-text);"><i class="fa-solid fa-hammer" style="font-size:32px;margin-bottom:12px;display:block;"></i>功能建设中，敬请期待</div>';
                return;
            }
            items = extractNoticeList(data);
        } catch (e) {
            console.error('[notice]', e);
            target.innerHTML = '<h3>系统通知</h3><div style="text-align:center;padding:20px;color:var(--secondary-text);">加载失败</div>';
            return;
        }

        let html = '<h3>系统通知</h3>';
        html += '<div class="notice-wall">';
        if (items.length === 0) {
            html += '<div style="text-align:center;padding:20px;color:var(--secondary-text);">暂无系统通知</div>';
        }
        items.forEach(item => {
            const title = noticePick(item, ['title', 'subject', 'name', '标题', '主题']) || '系统通知';
            const content = noticePick(item, ['content', 'body', 'text', 'message', 'desc', 'description', '内容', '正文', '摘要']);
            const rawTime = noticePick(item, ['created_at', 'ctime', 'time', 'timestamp', 'published_at', '发布时间', '时间']);
            const imageUrl = noticePick(item, ['image', 'image_url', 'cover', 'pic', '图片']);
            const timeStr = rawTime ? new Date(rawTime).toLocaleString('zh-CN') : '';
            html += '<div class="notice-card">';
            html += '<div class="notice-title">' + escapeHtml(title) + '</div>';
            if (content) html += '<div class="notice-body">' + escapeHtml(String(content)) + '</div>';
            if (imageUrl) {
                const img = cachedResolveMediaUrl(imageUrl);
                html += '<img src="' + img + '" style="max-width:100%;max-height:240px;border-radius:8px;margin-top:8px;cursor:pointer;" onclick="openImageViewer(\'' + img + '\')" onerror="this.style.display=\'none\'">';
            }
            if (timeStr) html += '<div class="notice-time">' + escapeHtml(timeStr) + '</div>';
            html += '</div>';
        });
        html += '</div>';
        target.innerHTML = html;
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
                    <span class="value">Tauri 桌面端</span>
                </div>
                <div class="settings-item">
                    <span class="label">系统环境</span>
                    <span class="value" id="aboutOsInfo">检测中…</span>
                </div>
                <div class="settings-item">
                    <span class="label">WebView</span>
                    <span class="value" id="aboutWebviewInfo">检测中…</span>
                </div>
                <div class="settings-item">
                    <span class="label">后端地址</span>
                    <span class="value">${BACKEND_ORIGIN}</span>
                </div>
                <div class="settings-item" style="cursor:pointer;" id="aboutGithubLink">
                    <span class="label">GitHub 仓库</span>
                    <span class="value" style="color:var(--accent);text-decoration:underline;">${GITHUB_URL}</span>
                </div>
                <div class="settings-item" style="cursor:pointer;" id="aboutSiteLink">
                    <span class="label">官方网站</span>
                    <span class="value" style="color:var(--accent);text-decoration:underline;">ockn.reverie.dpdns.org</span>
                </div>
                <div class="settings-item" style="cursor:pointer;" id="aboutVersionRow" title="点击检查更新">
                    <span class="label">版本号</span>
                    <span class="value" id="aboutVersionValue" style="color:var(--accent);text-decoration:underline;">获取中…</span>
                </div>
            </div>
            <div id="aboutEnvWarnings"></div>
        `;
        // 环境信息来自 Rust 侧启动自检（env_report），含未阻断启动的非致命告警
        (function loadEnvReport() {
            const osEl = document.getElementById('aboutOsInfo');
            const wvEl = document.getElementById('aboutWebviewInfo');
            const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
            if (!invoke) {
                if (osEl) osEl.textContent = '不可用';
                if (wvEl) wvEl.textContent = '不可用';
                return;
            }
            invoke('env_report').then(r => {
                if (osEl) osEl.textContent = `${r.osVersion || r.os} · ${r.arch}`;
                if (wvEl) wvEl.textContent = r.webview || '未知';
                const box = document.getElementById('aboutEnvWarnings');
                if (box && Array.isArray(r.warnings) && r.warnings.length) {
                    box.innerHTML = '<h3 style="margin-top:20px;">环境提醒</h3><div class="settings-group">'
                        + r.warnings.map(w => `
                        <div class="settings-item" style="flex-direction:column;align-items:flex-start;gap:6px;">
                            <span class="label" style="color:#e0a458;">⚠ ${escapeHtml(w.title)}</span>
                            <span style="font-size:12px;color:var(--secondary-text);white-space:pre-wrap;line-height:1.6;">${escapeHtml(w.message)}</span>
                        </div>`).join('')
                        + '</div>';
                }
            }).catch(e => {
                console.error('[about] env_report:', e);
                if (osEl) osEl.textContent = '获取失败';
                if (wvEl) wvEl.textContent = '获取失败';
            });
        })();
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
        document.getElementById('aboutSiteLink')?.addEventListener('click', () => {
            const url = 'https://ockn.reverie.dpdns.org';
            if (IS_TAURI && tauriInvoke) {
                tauriInvoke('plugin:opener|open_url', { url }).catch(() => { window.open(url, '_blank'); });
            } else {
                window.open(url, '_blank');
            }
        });
        // 版本号：读取 app_version 命令（本地写死为 v7）；点击检查更新
        const aboutInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
        const verEl = document.getElementById('aboutVersionValue');
        if (aboutInvoke) {
            aboutInvoke('app_version').then(v => {
                if (verEl) verEl.textContent = v || '未知';
            }).catch(() => { if (verEl) verEl.textContent = '未知'; });
        } else if (verEl) {
            verEl.textContent = '未知';
        }
        document.getElementById('aboutVersionRow')?.addEventListener('click', checkForUpdates);
    }

    // ===== 版本号 / 检查更新（点击版本号触发，不做自动检查）=====
    const UPDATE_API_URL = 'https://ockn.reverie.dpdns.org/api/releases';
    const UPDATE_DOWNLOAD_URL = 'https://ockn.reverie.dpdns.org/download';

    function openExternal(url) {
        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
        if (IS_TAURI && invoke) {
            invoke('plugin:opener|open_url', { url }).catch(() => { window.open(url, '_blank'); });
        } else {
            window.open(url, '_blank');
        }
    }

    // 拉取最新版本信息（https://** 已在 capabilities 白名单，走 plugin-http 无 CORS 限制）
    async function fetchReleases() {
        let res;
        if (IS_TAURI && typeof tauriHttpFetch === 'function') {
            res = await tauriHttpFetch(UPDATE_API_URL);
        } else {
            res = await fetch(UPDATE_API_URL);
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.releases) || !data.releases.length) throw new Error('接口返回异常');
        return data.releases;
    }

    // 检查更新：点击版本号 → 立即弹出弹窗并转圈加载 → 拉取数据后填充结果
    // 最新 tag 与当前版本不一致 → 有更新；当前版本在列表中 → 展示其后的全部更新内容，否则只提示最新版本
    async function checkForUpdates() {
        const dlg = createUpdateDialog('检查更新');
        dlg.setLoading('正在检查更新…');

        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
        let currentVersion = '';
        if (invoke) {
            try { currentVersion = (await invoke('app_version')) || ''; } catch (e) {}
        }

        let releases;
        try {
            releases = await fetchReleases();
        } catch (e) {
            dlg.setError('检查更新失败：' + (e && e.message ? e.message : e) + '\n请确认网络连接后重试。');
            return;
        }
        const latest = releases[0] || {};
        const latestTag = latest.tag || '';
        if (!latestTag) { dlg.setError('未获取到版本信息。'); return; }

        if (currentVersion === latestTag) {
            dlg.showResult('当前已是最新版本（' + latestTag + '）。');
            return;
        }

        // 定位当前版本在列表中的位置；>=0 表示列表中有此版本 → 展示其后的全部更新内容
        const idx = releases.findIndex(r => (r.tag || '') === currentVersion);
        const entries = idx >= 0 ? releases.slice(0, idx) : [latest];
        dlg.showResult('发现新版本 ' + latestTag + '！', entries, currentVersion, idx >= 0, () => {
            dlg.close();
            openExternal(UPDATE_DOWNLOAD_URL);
        });
    }

    // 更新弹窗：复用 .custom-modal-overlay/.custom-modal 的淡入+下滑动画；
    // 先以 loading 态弹出，数据到达后由控制器切换到结果/错误态。纯文本渲染防注入。
    function createUpdateDialog(title) {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        const box = document.createElement('div');
        box.className = 'custom-modal';
        box.style.maxWidth = '520px';
        box.style.width = 'calc(100vw - 40px)';
        box.style.padding = '18px';
        box.style.display = 'flex';
        box.style.flexDirection = 'column';
        box.style.maxHeight = '75vh';

        const head = document.createElement('div');
        head.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:12px;color:var(--text);flex-shrink:0;';
        head.textContent = title;
        const body = document.createElement('div');
        body.style.cssText = 'overflow-y:auto;flex:1;font-size:13px;line-height:1.6;color:var(--text);';
        const foot = document.createElement('div');
        foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-shrink:0;';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = '关闭';
        const goBtn = document.createElement('button');
        goBtn.className = 'btn primary';
        goBtn.textContent = '前往下载';
        goBtn.style.display = 'none';
        foot.appendChild(cancelBtn);
        foot.appendChild(goBtn);
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function close() { overlay.remove(); }
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        return {
            close,
            // 加载态：转圈 + 提示文案
            setLoading(msg) {
                head.textContent = title;
                goBtn.style.display = 'none';
                body.innerHTML = '';
                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 0;color:var(--secondary-text);';
                const spin = document.createElement('div');
                spin.style.cssText = 'width:26px;height:26px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:updateSpin 0.8s linear infinite;';
                const label = document.createElement('div');
                label.style.fontSize = '13px';
                label.textContent = msg || '正在检查更新…';
                wrap.appendChild(spin);
                wrap.appendChild(label);
                body.appendChild(wrap);
            },
            // 错误态
            setError(msg) {
                head.textContent = title;
                goBtn.style.display = 'none';
                body.innerHTML = '';
                body.style.whiteSpace = 'pre-wrap';
                const t = document.createElement('div');
                t.style.color = 'var(--danger)';
                t.textContent = msg;
                body.appendChild(t);
            },
            // 结果态：可带更新内容（纯文本，防注入）
            showResult(heading, entries, currentVersion, hasChangelog, onDownload) {
                head.textContent = heading;
                body.style.whiteSpace = 'normal';
                body.innerHTML = '';
                if (entries && entries.length) {
                    if (currentVersion && !hasChangelog) {
                        body.appendChild(infoLine('当前版本 ' + currentVersion + ' 不在版本列表中，仅提示最新版本。'));
                    }
                    entries.forEach(r => {
                        const item = document.createElement('div');
                        item.style.marginBottom = '12px';
                        const t = document.createElement('div');
                        t.style.fontWeight = '600';
                        t.style.marginBottom = '4px';
                        t.textContent = (r.name || r.tag) + '　' + (r.published_at ? String(r.published_at).slice(0, 10) : '');
                        item.appendChild(t);
                        const b = document.createElement('div');
                        b.style.cssText = 'white-space:pre-wrap;word-break:break-word;color:var(--secondary-text);';
                        b.textContent = r.body || '（无更新说明）';
                        item.appendChild(b);
                        body.appendChild(item);
                    });
                    if (onDownload) {
                        goBtn.style.display = '';
                        goBtn.onclick = () => onDownload();
                    }
                } else {
                    body.appendChild(infoLine(heading));
                }
            }
        };
    }

    function infoLine(text) {
        const el = document.createElement('div');
        el.style.cssText = 'margin-bottom:12px;color:var(--secondary-text);';
        el.textContent = text;
        return el;
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

    // ===== 主题设置页 =====
    function parseThemeMeta(css) {
        const meta = { id: '', name: '', description: '', author: '', version: '', framework: '', showDayNightToggle: '' };
        const lines = (css || '').split('\n');
        const re = /@theme\s+(\w+)\s*:\s*(.*)/;
        for (const raw of lines) {
            const s = raw.trim().replace(/^\*\s?/, '').trim();
            const m = s.match(re);
            if (m && m[1] in meta) meta[m[1]] = m[2].trim();
        }
        return meta;
    }

    function renderSettingsTheme() {
        const savedId = localStorage.getItem('themeId') || 'default';
        const bm = BUILTIN_THEME_META || {};
        const builtin = {
            id: 'default',
            name: bm.name || '默认主题',
            description: bm.description || 'OldChat For Kivotos Next 内置默认主题。',
            author: bm.author || '',
            version: bm.version || '',
            framework: bm.framework || 'v1',
            builtin: true
        };
        const all = [builtin]
            .concat(Object.values(BUILTIN_THEMES))
            .concat(Array.isArray(USER_THEME_LIST) ? USER_THEME_LIST : []);

        settingsContent.innerHTML =
            '<h3>主题</h3>' +
            '<div class="settings-group" style="margin-bottom:14px;">' +
                '<div class="settings-item" id="settingsThemeModeToggle">' +
                    '<span class="label">深色模式</span>' +
                    '<span class="value" id="themeModeValue"></span>' +
                '</div>' +
            '</div>' +
            '<div class="settings-group" style="margin-bottom:14px;">' +
                '<div class="settings-item" id="settingsConsecutiveMessages">' +
                    '<span class="label">连消息</span>' +
                    '<span class="value">' +
                        '<label class="oc-switch">' +
                            '<input type="checkbox" id="consecutiveMessagesToggle">' +
                            '<span class="oc-switch-slider"></span>' +
                        '</label>' +
                    '</span>' +
                '</div>' +
                '<div style="padding:8px 14px;font-size:12px;color:var(--secondary-text);">同一发送者、间隔 5 分钟内的连续消息合并为一组，隐藏重复头像与昵称。</div>' +
            '</div>' +
            '<div class="settings-group" style="margin-bottom:14px;">' +
                '<button id="themeUploadBtn" class="btn primary" style="width:100%;">上传主题（.css 文件）</button>' +
            '</div>' +
            '<div id="themeList">加载中...</div>' +
            '<div class="settings-group" style="margin-top:14px;">' +
                '<button id="themeResetBtn" style="display:inline-block!important;width:100%;padding:10px;border:1px solid var(--border-color);background:var(--panel-bg);color:var(--text);border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;">恢复默认主题</button>' +
            '</div>';

        const themeModeVal = document.getElementById('themeModeValue');
        if (themeModeVal) {
            const curMode = localStorage.getItem('theme') || 'light';
            themeModeVal.innerHTML = (curMode === 'dark' ? '已开启' : '已关闭') + ' <i class="fa-solid fa-chevron-right"></i>';
        }
        document.getElementById('settingsThemeModeToggle')?.addEventListener('click', () => {
            const m = (localStorage.getItem('theme') || 'light') === 'dark' ? 'light' : 'dark';
            applyTheme(m);
            const v = document.getElementById('themeModeValue');
            if (v) v.innerHTML = (m === 'dark' ? '已开启' : '已关闭') + ' <i class="fa-solid fa-chevron-right"></i>';
        });
        document.getElementById('themeUploadBtn')?.addEventListener('click', uploadTheme);
        document.getElementById('themeResetBtn')?.addEventListener('click', () => {
            applyThemeById('default');
            renderSettingsTheme();
        });

        // 连消息开关（设置 → 主题，默认开启）：合并同一发送者、5 分钟内的连续消息
        const cmToggle = document.getElementById('consecutiveMessagesToggle');
        if (cmToggle) {
            let cmOn = true;
            try { cmOn = localStorage.getItem('oc_consecutive_messages') !== '0'; } catch (e) {}
            cmToggle.checked = cmOn;
            cmToggle.addEventListener('change', () => {
                try { localStorage.setItem('oc_consecutive_messages', cmToggle.checked ? '1' : '0'); } catch (e) {}
                if (!currentConv) return;
                const ck = currentConv.key;
                // 强制全量重建：清除会话缓存与现有 DOM，使连消息分组立即生效。
                // 否则 fetchLatestMessages 会走增量路径（DOM 已有消息且服务端无新消息时直接保留旧分组，需重启才刷新）。
                delete convCache[ck];
                messagesContainer.innerHTML = '';
                lastRenderedMsg = null;
                lastRenderedTs = 0;
                delete seenMsgIds[ck];
                convOffset[ck] = 0;
                convHasMore[ck] = true;
                fetchLatestMessages(currentConv.type, currentConv.id, ck);
            });
        }

        renderThemeList(all, savedId);
    }

    function renderThemeList(all, savedId) {
        const listEl = document.getElementById('themeList');
        if (!listEl) return;
        if (!all || all.length === 0) { listEl.textContent = '（暂无主题）'; return; }
        listEl.innerHTML = '';
        all.forEach(t => {
            const active = (t.id === savedId);
            const card = document.createElement('div');
            card.className = 'settings-item';
            card.style.flexDirection = 'column';
            card.style.alignItems = 'stretch';
            card.style.gap = '6px';
            card.style.padding = '12px 14px';
            card.style.border = active ? '1px solid var(--accent)' : '1px solid var(--border-color)';
            card.style.borderRadius = '8px';
            card.style.marginBottom = '8px';
            card.style.background = active ? 'var(--surface-2)' : 'var(--panel-bg)';

            const titleRow = document.createElement('div');
            titleRow.style.display = 'flex';
            titleRow.style.justifyContent = 'space-between';
            titleRow.style.alignItems = 'center';
            const title = document.createElement('div');
            title.style.fontWeight = '600';
            title.style.color = 'var(--text)';
            title.textContent = (t.name || t.id) + (active ? ' ✓' : '');
            titleRow.appendChild(title);
            const metaLine = document.createElement('div');
            metaLine.style.fontSize = '11px';
            metaLine.style.color = 'var(--secondary-text)';
            const bits = [];
            if (t.author) bits.push('作者 ' + t.author);
            if (t.framework) bits.push('框架 ' + t.framework);
            metaLine.textContent = bits.join(' · ');
            titleRow.appendChild(metaLine);
            card.appendChild(titleRow);

            if (t.description) {
                const desc = document.createElement('div');
                desc.style.fontSize = '12px';
                desc.style.color = 'var(--secondary-text)';
                desc.style.lineHeight = '1.5';
                desc.textContent = t.description;
                card.appendChild(desc);
            }

            const btnRow = document.createElement('div');
            btnRow.style.display = 'flex';
            btnRow.style.gap = '8px';
            btnRow.style.marginTop = '4px';

            const applyBtn = document.createElement('button');
            applyBtn.className = 'btn';
            applyBtn.style.padding = '6px 14px';
            applyBtn.style.whiteSpace = 'nowrap';
            applyBtn.textContent = active ? '已应用' : '应用';
            applyBtn.disabled = active;
            applyBtn.style.opacity = active ? '0.6' : '1';
            applyBtn.addEventListener('click', () => { applyThemeById(t.id); renderSettingsTheme(); });
            btnRow.appendChild(applyBtn);

            if (!t.builtin) {
                const delBtn = document.createElement('button');
                delBtn.className = 'btn';
                delBtn.style.padding = '6px 14px';
                delBtn.style.whiteSpace = 'nowrap';
                delBtn.style.color = 'var(--danger)';
                delBtn.textContent = '删除';
                delBtn.addEventListener('click', () => deleteTheme(t.id));
                btnRow.appendChild(delBtn);
            }
            card.appendChild(btnRow);

            listEl.appendChild(card);
        });
    }

    async function uploadTheme() {
        if (!IS_TAURI) {
            showAlert('主题上传仅在桌面客户端（Tauri）中可用。');
            return;
        }
        const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
            (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (!invoke) { showAlert('当前环境不支持主题上传。'); return; }
        let meta;
        try {
            meta = await invoke('import_theme');
        } catch (e) {
            if (('' + e).indexOf('未选择') >= 0) return; // 用户取消
            showAlert('导入失败：' + e);
            return;
        }
        if (!Array.isArray(USER_THEME_LIST)) USER_THEME_LIST = [];
        const i = USER_THEME_LIST.findIndex(x => x.id === meta.id);
        if (i >= 0) USER_THEME_LIST[i] = meta; else USER_THEME_LIST.push(meta);
        if (meta.css) USER_THEMES[meta.id] = meta.css;
        showAlert('已导入主题「' + (meta.name || meta.id) + '」');
        renderSettingsTheme();
    }

    async function deleteTheme(id) {
        if (!(await showConfirm('确定删除主题「' + id + '」？此操作不可撤销。'))) return;
        const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
            (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (!invoke) return;
        try {
            await invoke('delete_user_theme', { id });
            USER_THEME_LIST = (USER_THEME_LIST || []).filter(x => x.id !== id);
            delete USER_THEMES[id];
            if ((localStorage.getItem('themeId') || 'default') === id) applyThemeById('default');
            renderSettingsTheme();
        } catch (e) {
            showAlert('删除失败：' + e);
        }
    }

    // ===== 设置 → 插件：列表（元数据 + 启用开关）/ 添加 / 删除 =====
    function renderSettingsPlugins() {
        const all = Array.isArray(USER_PLUGIN_LIST) ? USER_PLUGIN_LIST : [];

        settingsContent.innerHTML =
            '<h3>插件</h3>' +
            '<div style="font-size:12px;color:var(--secondary-text);margin-bottom:12px;line-height:1.6;">' +
                '插件是任意 JavaScript 文件，启动时自动加载已启用的插件，可调用客户端的全局接口（window.*）。' +
                '插件代码在客户端本地执行，请仅添加可信的脚本。' +
            '</div>' +
            '<div class="settings-group" style="margin-bottom:14px;">' +
                '<button id="pluginUploadBtn" class="btn primary" style="width:100%;">添加插件（.js 文件）</button>' +
            '</div>' +
            '<div id="pluginList">加载中...</div>';

        document.getElementById('pluginUploadBtn')?.addEventListener('click', uploadPlugin);

        const listEl = document.getElementById('pluginList');
        if (!all.length) { listEl.textContent = '（暂无插件）'; return; }
        listEl.innerHTML = '';

        all.forEach(p => {
            const enabled = !!PLUGIN_ENABLED[p.id];
            const card = document.createElement('div');
            card.className = 'settings-item';
            card.style.flexDirection = 'column';
            card.style.alignItems = 'stretch';
            card.style.gap = '6px';
            card.style.padding = '12px 14px';
            card.style.border = '1px solid var(--border-color)';
            card.style.borderRadius = '8px';
            card.style.marginBottom = '8px';
            card.style.background = 'var(--panel-bg)';

            // 标题行：名称 + 启用开关
            const titleRow = document.createElement('div');
            titleRow.style.display = 'flex';
            titleRow.style.justifyContent = 'space-between';
            titleRow.style.alignItems = 'center';
            const title = document.createElement('div');
            title.style.fontWeight = '600';
            title.style.color = 'var(--text)';
            title.textContent = p.name || p.id;
            titleRow.appendChild(title);
            const toggle = document.createElement('label');
            toggle.style.display = 'inline-flex';
            toggle.style.alignItems = 'center';
            toggle.style.gap = '6px';
            toggle.style.fontSize = '12px';
            toggle.style.color = 'var(--secondary-text)';
            toggle.style.cursor = 'pointer';
            toggle.style.userSelect = 'none';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = enabled;
            cb.style.cursor = 'pointer';
            cb.style.accentColor = 'var(--accent)';
            cb.addEventListener('change', () => togglePlugin(p.id, cb.checked));
            toggle.appendChild(cb);
            toggle.appendChild(document.createTextNode(enabled ? '已启用' : '已停用'));
            titleRow.appendChild(toggle);
            card.appendChild(titleRow);

            if (p.description) {
                const desc = document.createElement('div');
                desc.style.fontSize = '12px';
                desc.style.color = 'var(--secondary-text)';
                desc.style.lineHeight = '1.5';
                desc.textContent = p.description;
                card.appendChild(desc);
            }

            const metaRow = document.createElement('div');
            metaRow.style.fontSize = '11px';
            metaRow.style.color = 'var(--secondary-text)';
            const bits = [];
            if (p.author) bits.push('作者 ' + p.author);
            if (p.version) bits.push('版本 ' + p.version);
            if (p.id) bits.push('ID ' + p.id);
            metaRow.textContent = bits.join(' · ');
            card.appendChild(metaRow);

            const btnRow = document.createElement('div');
            btnRow.style.display = 'flex';
            btnRow.style.gap = '8px';
            btnRow.style.marginTop = '4px';
            const delBtn = document.createElement('button');
            delBtn.className = 'btn';
            delBtn.style.padding = '6px 14px';
            delBtn.style.whiteSpace = 'nowrap';
            delBtn.style.color = 'var(--danger)';
            delBtn.textContent = '删除插件';
            delBtn.addEventListener('click', () => deletePlugin(p.id));
            btnRow.appendChild(delBtn);
            card.appendChild(btnRow);

            listEl.appendChild(card);
        });
    }

    async function uploadPlugin() {
        if (!IS_TAURI) { showAlert('插件仅在桌面客户端（Tauri）中可用。'); return; }
        const invoke = getInvoke();
        if (!invoke) { showAlert('当前环境不支持插件。'); return; }
        let meta;
        try {
            meta = await invoke('import_plugin');
        } catch (e) {
            if (('' + e).indexOf('未选择') >= 0) return; // 用户取消
            showAlert('导入失败：' + e);
            return;
        }
        if (!Array.isArray(USER_PLUGIN_LIST)) USER_PLUGIN_LIST = [];
        const i = USER_PLUGIN_LIST.findIndex(x => x.id === meta.id);
        if (i >= 0) USER_PLUGIN_LIST[i] = meta; else USER_PLUGIN_LIST.push(meta);
        // 新插件默认启用并立即加载
        PLUGIN_ENABLED[meta.id] = true;
        savePluginStates();
        await loadPlugin(meta.id);
        showAlert('已添加插件「' + (meta.name || meta.id) + '」并启用');
        renderSettingsPlugins();
    }

    async function deletePlugin(id) {
        if (!(await showConfirm('确定删除插件「' + id + '」？此操作不可撤销。'))) return;
        const invoke = getInvoke();
        if (!invoke) return;
        try {
            await invoke('delete_user_plugin', { id });
            USER_PLUGIN_LIST = (USER_PLUGIN_LIST || []).filter(x => x.id !== id);
            delete PLUGIN_ENABLED[id];
            savePluginStates();
            renderSettingsPlugins();
        } catch (e) {
            showAlert('删除失败：' + e);
        }
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

    // 发现页侧边栏（启动器）：点击板块项进入对应区域
    // - 音乐广场：跳转到隐藏的音乐面板（从右进入）
    // - 签到墙：在发现页右侧直接渲染，不新开页面
    document.querySelector('.sidebar-panel[data-panel="discover"]')?.addEventListener('click', (e) => {
        const item = e.target.closest('.contact-item[data-discover]');
        if (!item) return;
        document.querySelectorAll('.sidebar-panel[data-panel="discover"] .contact-item').forEach(ci => ci.classList.remove('active'));
        item.classList.add('active');
        const target = item.dataset.discover;
        if (target === 'checkin') {
            const main = document.querySelector('.main-panel[data-panel="discover"] .discover-main');
            if (main) {
                main.classList.add('discover-has-content');
                renderCheckin(main);
            }
        } else if (target === 'notice') {
            const main = document.querySelector('.main-panel[data-panel="discover"] .discover-main');
            if (main) {
                main.classList.add('discover-has-content');
                renderSystemNotice(main);
            }
        } else if (target) {
            switchTab(target);
        }
    });

    // 发现页右侧容器：渲染内容时切换为可滚动布局，回到发现落地页时恢复空状态
    function resetDiscoverMain() {
        const main = document.querySelector('.main-panel[data-panel="discover"] .discover-main');
        if (!main) return;
        main.classList.remove('discover-has-content');
        main.innerHTML = '<div class="discover-empty"><i class="fa-solid fa-compass"></i><p>从左侧选择一个板块开始探索</p></div>';
    }

    // ===== 公开法庭（入口在发现页，左侧案件列表 + 右侧案件详情） =====
    const courtCaseList = document.getElementById('courtCaseList');
    const courtDetail = document.getElementById('courtDetail');
    let courtLoaded = false;
    let courtCurrentId = null;

    // 从多个候选字段名中取第一个非空值（兼容不同版本后端字段命名，含蛇形/中文）
    function courtPick(obj, names) {
        if (!obj || typeof obj !== 'object') return '';
        for (const n of names) {
            const v = obj[n];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return '';
    }

    // 从响应里找出案件数组：兼容 {cases:[]} / {data:{list:[]}} / {data:[]} / 直接数组 / {code:0,data:{...}}
    function courtExtractList(obj) {
        if (Array.isArray(obj)) return obj;
        if (obj && typeof obj === 'object') {
            for (const k of ['cases', 'items', 'list', 'records', 'results', 'data']) {
                if (Array.isArray(obj[k])) return obj[k];
            }
            if (obj.data && typeof obj.data === 'object') return courtExtractList(obj.data);
            // 退一步：返回第一个非空数组值
            for (const k of Object.keys(obj)) {
                if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
            }
        }
        return [];
    }

    function courtCaseId(c) {
        return String(courtPick(c, ['id', 'case_id', 'caseId', 'cid', 'caseID', '案件id']) || '');
    }

    function createCourtCaseItem(c) {
        const id = courtCaseId(c);
        const title = courtPick(c, ['title', 'name', 'case_title', 'subject', 'topic', '标题', '案件标题']) || '未命名案件';
        const sub = courtPick(c, ['description', 'summary', 'brief', 'content', 'intro', '简介', '摘要']) ||
            [courtPick(c, ['plaintiff', 'accuser', 'prosecutor', '原告', '公诉人']),
             courtPick(c, ['defendant', 'accused', 'respondent', '被告'])]
                .filter(Boolean).join(' 诉 ');
        const div = document.createElement('div');
        div.className = 'contact-item court-case-item';
        div.dataset.courtId = id;
        div.innerHTML = `<div class="contact-info"><div class="name">${escapeHtml(title)}</div>${sub ? `<div class="uid">${escapeHtml(String(sub).slice(0, 60))}</div>` : ''}</div>`;
        div.addEventListener('click', () => {
            if (courtCaseList) courtCaseList.querySelectorAll('.court-case-item').forEach(i => i.classList.remove('active'));
            div.classList.add('active');
            renderCourtCase(id);
        });
        return div;
    }

    async function loadCourtCases() {
        if (!courtCaseList) return;
        courtCaseList.innerHTML = '<div class="court-loading">加载中...</div>';
        try {
            const res = await apiFetch('/v1/public-court/cases');
            const data = await res.json();
            const items = courtExtractList(data);
            courtCaseList.innerHTML = '';
            if (items.length === 0) {
                // 服务端可能返回了包裹结构但无案件，或确实为空；把原始响应留底便于核对字段
                const dump = (data && typeof data === 'object')
                    ? '<details class="court-raw"><summary>原始响应（无案件）</summary><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre></details>'
                    : '';
                courtCaseList.innerHTML = '<div class="court-loading">暂无案件</div>' + dump;
            } else {
                items.forEach(c => courtCaseList.appendChild(createCourtCaseItem(c)));
            }
            courtLoaded = true;
        } catch (e) {
            console.error('[court] load cases failed:', e);
            courtCaseList.innerHTML = '<div class="court-error">加载失败，请稍后重试</div>';
        }
    }

    async function renderCourtCase(id) {
        if (!courtDetail || !id) return;
        courtCurrentId = id;
        courtDetail.innerHTML = '<div class="court-loading">加载中...</div>';
        try {
            const res = await apiFetch('/v1/public-court/cases/' + encodeURIComponent(id));
            let c = await res.json();
            // 兼容 {code:0, data:{...}} / [{...}] 包裹
            if (c && c.data && typeof c.data === 'object' && !Array.isArray(c.data)) c = c.data;
            if (Array.isArray(c)) c = c[0] || {};
            const title = courtPick(c, ['title', 'name', 'case_title', 'subject', 'topic', '标题', '案件标题']) || '未命名案件';
            const content = courtPick(c, ['content', 'description', 'body', 'detail', 'text', 'intro', '简介', '摘要', '事实', '案情']) || '';
            const status = courtPick(c, ['status', 'state', '状态', '进展']) || '';
            const createdAt = courtPick(c, ['created_at', 'createdAt', 'time', 'publish_time', 'created_time', '添加时间']);
            const plaintiff = courtPick(c, ['plaintiff', 'accuser', 'prosecutor', '原告', '公诉人']);
            const defendant = courtPick(c, ['defendant', 'accused', 'respondent', '被告']);
            const votes = courtExtractList(c.votes || c.vote_list || c.voteList || []);
            const statements = courtExtractList(c.statements || c.statement_list || []);
            const discussions = courtExtractList(c.discussions || c.discussion_list || c.comments || []);

            let html = `<div class="court-case-title">${escapeHtml(title)}</div>`;
            const meta = [];
            if (status) meta.push(`<span class="meta-item">状态：<b>${escapeHtml(status)}</b></span>`);
            if (plaintiff) meta.push(`<span class="meta-item">原告：<b>${escapeHtml(plaintiff)}</b></span>`);
            if (defendant) meta.push(`<span class="meta-item">被告：<b>${escapeHtml(defendant)}</b></span>`);
            if (createdAt) meta.push(`<span class="meta-item">时间：<b>${escapeHtml(String(createdAt))}</b></span>`);
            if (meta.length) html += `<div class="court-case-meta">${meta.join('')}</div>`;
            if (content) html += `<div class="court-case-content">${escapeHtml(content)}</div>`;

            // 投票
            html += `<div class="court-vote-bar"><span class="vote-count">现有 ${votes.length} 票</span></div>`;
            html += `<div class="court-actions">
                <button class="btn primary" id="courtVoteBtn">投票</button>
                <button class="btn" id="courtStatementBtn">发表陈词</button>
                <button class="btn" id="courtDiscussionBtn">参与讨论</button>
            </div>`;

            if (statements.length) {
                html += `<div class="court-section-title">陈词</div>`;
                statements.forEach(s => {
                    const who = courtPick(s, ['user_name', 'username', 'name', 'author', 'uid', 'ncuid', '用户', '作者']);
                    const text = courtPick(s, ['content', 'text', 'statement', 'body', '内容', '陈词']);
                    html += `<div class="court-statement">${who ? `<span class="who">${escapeHtml(who)}：</span>` : ''}${escapeHtml(text)}</div>`;
                });
            }
            if (discussions.length) {
                html += `<div class="court-section-title">讨论</div>`;
                discussions.forEach(d => {
                    const who = courtPick(d, ['user_name', 'username', 'name', 'author', 'uid', 'ncuid', '用户', '作者']);
                    const text = courtPick(d, ['content', 'text', 'message', 'body', '内容', '讨论']);
                    html += `<div class="court-discussion">${who ? `<span class="who">${escapeHtml(who)}：</span>` : ''}${escapeHtml(text)}</div>`;
                });
            }

            // 兜底：若标题/内容/原告/被告/投票/陈词/讨论 全部为空（字段名没对上），原样显示 JSON 便于核对
            const hasAny = title !== '未命名案件' || content || plaintiff || defendant || votes.length || statements.length || discussions.length;
            if (!hasAny) {
                html += `<details class="court-raw"><summary>未能识别案件字段，显示原始响应</summary><pre>${escapeHtml(JSON.stringify(c, null, 2))}</pre></details>`;
            }

            courtDetail.innerHTML = html;

            // 投票
            const voteBtn = courtDetail.querySelector('#courtVoteBtn');
            if (voteBtn) voteBtn.addEventListener('click', async () => {
                try {
                    const r = await apiFetch('/v1/public-court/cases/' + encodeURIComponent(id) + '/vote', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
                    });
                    if (r.ok) { showAlert('投票成功', '提示'); renderCourtCase(id); }
                    else showAlert('投票失败', '提示');
                } catch (e) { showAlert('投票失败：' + e.message, '提示'); }
            });
            // 发表陈词
            const stmtBtn = courtDetail.querySelector('#courtStatementBtn');
            if (stmtBtn) stmtBtn.addEventListener('click', async () => {
                const text = window.prompt('请输入陈词内容：');
                if (!text) return;
                try {
                    const r = await apiFetch('/v1/public-court/cases/' + encodeURIComponent(id) + '/statement', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text })
                    });
                    if (r.ok) { showAlert('陈词已提交', '提示'); renderCourtCase(id); }
                    else showAlert('提交失败', '提示');
                } catch (e) { showAlert('提交失败：' + e.message, '提示'); }
            });
            // 参与讨论
            const discBtn = courtDetail.querySelector('#courtDiscussionBtn');
            if (discBtn) discBtn.addEventListener('click', async () => {
                const text = window.prompt('请输入讨论内容：');
                if (!text) return;
                try {
                    const r = await apiFetch('/v1/public-court/cases/' + encodeURIComponent(id) + '/discussion', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text })
                    });
                    if (r.ok) { showAlert('讨论已发布', '提示'); renderCourtCase(id); }
                    else showAlert('发布失败', '提示');
                } catch (e) { showAlert('发布失败：' + e.message, '提示'); }
            });
        } catch (e) {
            console.error('[court] load case detail failed:', e);
            courtDetail.innerHTML = '<div class="court-error">加载失败，请稍后重试</div>';
        }
    }

    // ===== 资源广场（发现页子页：左分区列表 / 右文件列表） =====
    const plazaSectionList = document.getElementById('plazaSectionList');
    const plazaFileList = document.getElementById('plazaFileList');
    let plazaLoaded = false;
    let cipLoaded = false;
    let plazaCurrentSection = null;

    // 字节数格式化（B/KB/MB/GB/TB）
    function formatSize(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes < 1024) return bytes + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let i = -1, v = bytes;
        do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
        return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
    }

    // 加载分区列表（左侧）
    async function loadPlazaSections() {
        if (!plazaSectionList) return;
        plazaSectionList.innerHTML = '<div class="court-loading">加载中...</div>';
        try {
            const res = await apiFetch('/v1/resources/sections');
            const data = await res.json();
            let sections = [];
            if (data && Array.isArray(data.sections)) sections = data.sections;
            else if (data && data.data && Array.isArray(data.data.sections)) sections = data.data.sections;
            else if (Array.isArray(data)) sections = data;
            plazaSectionList.innerHTML = '';
            if (!sections.length) {
                plazaSectionList.innerHTML = '<div class="court-loading">暂无分区</div>';
            } else {
                sections.forEach(s => plazaSectionList.appendChild(createPlazaSectionItem(s)));
            }
            plazaLoaded = true;
        } catch (e) {
            console.error('[plaza] load sections failed:', e);
            plazaSectionList.innerHTML = '<div class="court-error">加载失败，请稍后重试</div>';
        }
    }

    function createPlazaSectionItem(s) {
        const div = document.createElement('div');
        div.className = 'contact-item plaza-section-item';
        div.dataset.sectionId = s.id || '';
        const count = (s.count != null) ? '（' + s.count + '）' : '';
        div.innerHTML = '<div class="contact-info"><div class="name">' + escapeHtml(s.name || '未命名分区') + '</div></div>' +
            '<span class="plaza-count">' + count + '</span>';
        div.addEventListener('click', () => {
            plazaSectionList.querySelectorAll('.plaza-section-item').forEach(i => i.classList.remove('active'));
            div.classList.add('active');
            loadPlazaItems(s.id);
        });
        return div;
    }

    // 加载某分区的文件列表（右侧）
    async function loadPlazaItems(sectionId) {
        if (!plazaFileList || !sectionId) return;
        plazaCurrentSection = sectionId;
        plazaFileList.innerHTML = '<div class="court-loading">加载中...</div>';
        try {
            const res = await apiFetch('/v1/resources/items?section_id=' + encodeURIComponent(sectionId) + '&limit=50&offset=0');
            const data = await res.json();
            let items = [];
            if (data && Array.isArray(data.items)) items = data.items;
            else if (data && data.data && Array.isArray(data.data.items)) items = data.data.items;
            else if (Array.isArray(data)) items = data;
            plazaFileList.innerHTML = '';
            if (!items.length) {
                plazaFileList.innerHTML = '<div class="court-detail-empty"><i class="fa-solid fa-folder-open" style="font-size:48px;color:var(--secondary-text);margin-bottom:16px;"></i><p style="color:var(--secondary-text);">该分区暂无文件</p></div>';
            } else {
                items.forEach(it => plazaFileList.appendChild(createPlazaFileItem(it)));
            }
        } catch (e) {
            console.error('[plaza] load items failed:', e);
            plazaFileList.innerHTML = '<div class="court-error">加载失败，请稍后重试</div>';
        }
    }

    function createPlazaFileItem(it) {
        const div = document.createElement('div');
        div.className = 'plaza-file-item';
        const name = it.name || '未命名文件';
        const size = formatSize(it.size_bytes);
        const uploader = it.uploader_name ? escapeHtml(it.uploader_name) : '';
        const time = it.created_at ? new Date(it.created_at * 1000).toLocaleString() : '';
        div.innerHTML = '' +
            '<div class="plaza-file-icon"><i class="fa-solid fa-file"></i></div>' +
            '<div class="plaza-file-info">' +
                '<div class="plaza-file-name">' + escapeHtml(name) + '</div>' +
                '<div class="plaza-file-meta">' + size + (uploader ? ' · ' + uploader : '') + (time ? ' · ' + time : '') + '</div>' +
            '</div>' +
            '<button class="btn plaza-file-dl file-download-btn" title="下载" data-dl-url="' + escapeHtml(it.url || '') + '" data-dl-name="' + escapeHtml(name) + '"><i class="fa-solid fa-download"></i></button>';
        return div;
    }

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

    // 初始化完成：关闭启动闪屏（覆盖 app.js 解析/初始化期间的白屏）
    hideAppSplash();

});