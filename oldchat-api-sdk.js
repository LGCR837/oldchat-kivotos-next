// =====================================================================
// oldchat-api-sdk.js - OldChat For Kivotos Next 统一 API SDK（纯前端 / 零构建）
//
// 自包含单文件：上半部分为「传输层」（原 api.js），下半部分为「业务层」（OC SDK）。
//  - 传输层：认证 fetch 包装、v1<->v2 路径降级、ECDH 握手、AES 信封、候选地址轮询、
//            resolveMediaUrl、Crypto 辅助。原 api.js 已弃用（见 api.js 顶部弃用说明）。
//  - 业务层：window.OC 命名空间，端点路径收口 + 响应字段归一化。
//
// 网络适配器（可插拔）：传输层不直接实现任何网络请求，所有 HTTP 调用统一打到
// 全局转接器 window.ocTransport(url, init) => Promise<Response>。该实现【不在本 SDK 内指定】，
// 必须由外部 JS 在加载本文件后、发起请求前注入，例如：
//
//   // 浏览器示例（原生 fetch，开箱即跑）：
//   window.ocTransport = (url, init) => fetch(url, init);
//
//   // Tauri 示例（plugin-http 直连，绕过 CORS）：
//   window.ocTransport = async (url, init) => {
//     if (typeof window.__tauriHttpFetchImpl === 'function')
//       return window.__tauriHttpFetchImpl(url, init);
//     return fetch(url, init);
//   };
//
// 若未注入，apiFetch 会明确抛出 "OC transport 未注入" 错误，强制宿主配置，避免静默失败。
// 这样本 SDK 成为纯协议层，可被任意宿主环境（浏览器 / Tauri / Node / 测试桩）接管。
//
// 加载顺序（index.html）：oldchat-api-sdk.js → app.js（app.js 负责注入 ocTransport）
// 设计约束：经典 <script>，全局 window.OC / window.apiFetch / window.ocTransport；
//           不引打包工具、不碰 DOM（传输层除外）；不在 SDK 内写具体网络实现。
// =====================================================================

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

function resolveMediaUrl(url) {
    if (!url) return url;
    // 频道媒体 scheme：channel-private:<签名文件名>[?sig=...] → 频道媒体签名下载端点
    // 官方文档 14.10：GET /channel-media/{filename}（全局签名下载，签名在文件名里，无需 Bearer）。
    // 注意：保留签名串原样（含可能的 ?query），不要剥扩展名、不要换 host。
    if (typeof url === 'string' && url.startsWith('channel-private:')) {
        const rest = url.slice('channel-private:'.length);
        return 'http://oc.mcl0.dpdns.org/channel-media/' + rest;
    }
    // 已经是 /channel-media/ 形式的路径或绝对 URL：只能走 oc 主机，禁止用 MEDIA_BASE / 候选 host 拼接
    // （否则签名失效 → 404）。鉴权完全依赖 URL 自带的 ?exp=&sig=，必须原样保留查询串、不能换 host、不能加鉴权头。
    if (typeof url === 'string' && url.indexOf('/channel-media/') !== -1) {
        if (/^https?:/i.test(url)) return url;
        return 'http://oc.mcl0.dpdns.org' + (url.startsWith('/') ? '' : '/') + url;
    }
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

// ==================== 认证 fetch 包装器 ====================
// 并发去重：相同 GET 请求复用同一底层响应（克隆给各调用方），减少初始化期间冗余请求
const _inflightGet = new Map();

// ===== v1 → v2 API 路径映射（2026-08-09 文档确认）=====
// 依据：oldchat-docs-20260809/nx3/oldchat-diff-release-vs-dev2.md §9.4（60+ 条映射表）
//      + 12-v2签名机制与响应结构补充.md §5（direct/messages、direct/unread、群消息 v2）
//      + 02-网络层与API通信机制.md（channels/buttons/files/群 members-lookup）
// 说明：
//  - 私聊历史 / 群历史列表：原本 v1=/v1/{direct,groups}/messages/v2 → v2=/v2/{direct,groups}/messages/v2，
//    但服务端对这两个端点回 bad_signature（HTTP 会话 v2 签名链不通过，自愈不覆盖 bad_signature）。
//    已临时移出映射，强制走 v1（2026-08-15，待 v2 签名专项排查后恢复）。
//  - 注意：仅消息「列表/历史」端点回退 v1；发送(/v1/{direct,groups}/send)、已读、撤回等仍走 v2。
//  - 未列入的端点保持 /v1（auth/login|refresh|handshake|web/register、music/*、emoji/plaza、
//    checkin/wall、public-court、media 上传、messages/search、messages/after、direct|groups/unread、
//    groups/message/send —— 这些文档未确认 v2 路径或响应结构不兼容，保守保留 v1）
const V1_TO_V2 = {
    // 私聊
    '/v1/direct/send': '/v2/direct/send',
    '/v1/direct/read': '/v2/direct/read',
    '/v1/direct/burn/open': '/v2/direct/burn/open',
    // 私聊历史列表：v2 签名对 /v2/direct/messages/v2 服务端回 bad_signature（HTTP 会话签名链不通过），
    // 自愈仅在 invalid/missing_session 时触发，bad_signature 不重握手 → 每次带坏会话重试失败。
    // 临时回退为始终走 v1（迁移 v2 前一直工作的路径），待 v2 签名专项排查后再恢复。
    // '/v1/direct/messages/v2': '/v2/direct/messages/v2',
    // 群组
    // 群历史列表：同上，/v2/groups/messages/v2 服务端回 bad_signature。临时强制 v1（用户确认「先用 v1」）。
    // '/v1/groups/messages/v2': '/v2/groups/messages/v2',
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
    '/v1/groups/members/lookup': '/v2/groups/members/lookup',
    // 红包：保持 v1。老 OCKN 红包走 v1 正常；/v2/redpackets/* 实测领取/发送异常
    // （catch 表现为"网络错误"，无控制台报错），暂不升级 v2，待 v2 签名专项排查后再恢复。
    // '/v1/redpackets/send': '/v2/redpackets/send',
    // '/v1/redpackets/claim': '/v2/redpackets/claim',
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
    '/v1/me/delete': '/v2/me/delete',
    '/v1/me/scratch': '/v2/me/scratch',
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
    // 好友（v1 路由已弃用，迁移到 v2；好友请求/添加已实测 503，好友列表启动即加载）
    '/v1/friends': '/v2/friends',
    '/v1/friends/requests': '/v2/friends/requests',
    '/v1/friends/request': '/v2/friends/request',
    // 频道 / 文件（v2 新增端点，客户端暂未接入，先占位保证未来直接可用）
    '/v1/channels/subscribe': '/v2/channels/subscribe',
    '/v1/channels/unsubscribe': '/v2/channels/unsubscribe',
    '/v1/channels/notifications': '/v2/channels/notifications',
    '/v1/channels/discover': '/v2/channels/discover',
    '/v1/channels/posts/after': '/v2/channels/posts/after',
    '/v1/channels/posts/send': '/v2/channels/posts/send',
    '/v1/channels/reactions/toggle': '/v2/channels/reactions/toggle',
    '/v1/channels/read': '/v2/channels/read',
    '/v1/channels/states': '/v2/channels/states',
    '/v1/channels/events/after': '/v2/channels/events/after',
    '/v1/files/check': '/v2/files/check',
    '/v1/files/upload': '/v2/files/upload',
    '/v1/resources/upload': '/v2/resources/upload',
    '/v1/resources/download': '/v2/resources/download',
    // 未读 / 差量 / 网关（v2 新增端点，客户端暂未接入，先占位保证未来直接可用）
    // 注意：客户端实际调用路径是 /v1/direct/unread、/v1/groups/unread（词序与 v2 相反），
    // mapToV2 为精确匹配，键必须与调用路径一致，否则永远命中不了 v2 兜底。
    '/v1/direct/unread': '/v2/unread/direct',
    '/v1/groups/unread': '/v2/unread/groups',
    '/v1/updates/difference': '/v2/updates/difference',
    '/v1/gateway': '/v2/gateway'
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

// 文档 §4.5 签名豁免端点：大文件上传/下载不加密、不签名，仅 Bearer JWT 鉴权。
// 对这些路径强行套签名链反而可能被服务端拒绝，故 apiFetch 里直接跳过 v2 签名头。
const V2_UNSIGNED_PATHS = /^\/v2\/(files|resources)\/(upload|download)(\/|$)/;

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

// 请求模式（设置 → 通用 → 请求模式）：'WebSocket优先'(默认) / '仅WebSocket' / '仅轮询'
//  - WebSocket优先(默认)：默认走 WS；WS 连续失败达阈值后自动降级为轮询，并每 60s 重试一次 WS，
//    重试成功即自动切回 WS 并停止轮询
//  - 仅WebSocket：只用 WS（指数退避无限重连），永不启用轮询
//  - 仅轮询：完全不建 WS 连接，只用定时轮询
function getRequestMode() {
    let m = 'WebSocket优先';
    try { m = localStorage.getItem('oc_request_mode') || 'WebSocket优先'; } catch (e) {}
    if (!['WebSocket优先', '仅WebSocket', '仅轮询'].includes(m)) m = 'WebSocket优先';
    return m;
}

// 当前是否处于「轮询工作态」（仅轮询模式，或 WebSocket优先 降级后）。由下方 WS/轮询引擎维护。
// 仅影响请求 UA：轮询态用独立 UA 便于服务端区分与统计，其他模式 UA 保持不变。
let ocPollingActive = false;
function ocUserAgent() {
    return ocPollingActive ? 'OldChatForKivotosNextPollingMode' : 'OldChatForKivotosNext';
}

// v2 请求签名头（HMAC-SHA256，密钥 = ECDH 握手派生的 wsMacKey）
// 官方文档 §4.4：sign = base64url(HMAC-SHA256(macKey, signingString))
// signingString = METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE
// 且 v2SignMiddleware 强制 X-Session 有效 → 必须带上 handshake 返回的 session_id
// PATH 不含查询参数；nonce = 16 字节随机 → base64 无填充；X-Device-Id = oldchat_device_id（可选，灰度绑定）
// v2 HTTP 请求一律使用「HTTP 专用会话」(__httpSession)，绝不使用 WS 会话(__wsSession)：
// HTTP 侧 401 会清会话重新握手，若共用 WS 那套密钥会把活着的 WS 连接搞聋（详见 __httpSession 注释）。
function v2Session() {
    return window.__httpSession || null;
}

async function v2SignHeaders(path, method) {
    const cleanPath = String(path || '').split('?')[0];
    if (!/^\/v2\//.test(cleanPath)) return {};
    const sess = v2Session();
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

    // 对任意路径生成 v2 会话签名头（突破 v2SignHeaders 的 /v2/ 守卫，用于 /channel-media/ 等也需会话鉴权的端点）
    async function signV2ForAnyPath(path, method) {
        const cleanPath = String(path || '').split('?')[0];
        const sess = v2Session();
        if (!sess) return {};
        try { await sess.ensure(); } catch (e) { return {}; }
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
        const hdrs = { 'X-Session': sessionId, 'X-Ts': ts, 'X-Nonce': nonce, 'X-Sign': sign };
        const devId = localStorage.getItem('oldchat_device_id');
        if (devId) hdrs['X-Device-Id'] = devId;
        return hdrs;
    }

    // v2 请求体加密（08-ECDH 文档 §4：AES-256-CBC + HMAC-SHA256 信封）
// 信封 JSON：{iv, data, mac}，base64(NO_WRAP)；mac = HMAC-SHA256(macKey, iv字节 || data字节)
// 返回加密后的信封 JSON 字符串；密钥/会话缺失或加密失败返回 null（调用方降级明文）
async function v2EncryptBody(plainJson) {
    const sess = v2Session();
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
    const sess = v2Session();
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
    // 直连 /v2/ 路径（频道等直接以 /v2/ 调用的端点）也视为 v2，必须走签名；
    // 否则 hasV2 为 false → 当作 v1 发送（不带 X-Session）→ 服务端 401 missing session 死循环
    const hasV2 = url.startsWith('/v2/') || mapToV2(url) !== url;
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
        // v1 尝试必须把 /v2/ 直连路径反向映射回 v1。
        // 否则（如调用方直接写 /v2/resources/sections）v1 尝试会把 /v2/ 路径裸发出去、
        // 不带 X-Session/X-Sign → 服务端 v2 中间件必回 401 {"error":"missing session"}。
        const targetUrl = ver === 'v2' ? mapToV2(url) : v2ToV1(url);
        const strictV2 = (ver === 'v2' && mode === '仅v2');
        // 该端点没有 v1 版本（反向映射后仍是 /v2/）→ 跳过无意义的 v1 尝试
        if (ver === 'v1' && targetUrl.indexOf('/v2/') === 0) {
            if (isLast) break;
            continue;
        }

        // 每次尝试用独立 headers 副本，避免 v2 专属头泄漏到 v1 尝试
        const attemptOptions = Object.assign({}, options);
        attemptOptions.headers = Object.assign({}, options.headers || {});
        attemptOptions.headers['User-Agent'] = ocUserAgent();
        const token = localStorage.getItem('oc_access_token');
        if (token) attemptOptions.headers['Authorization'] = 'Bearer ' + token;

        if (ver === 'v2' && V2_UNSIGNED_PATHS.test(targetUrl.split('?')[0])) {
            // 文档 §4.5：/v2/{files,resources}/{upload,download} 不加密、不签名，仅 Bearer JWT。
            // 这里刻意不带 X-Session/X-Sign，避免服务端按签名链校验反而 401。
        } else if (ver === 'v2') {
            let signHdrs = {};
            try { signHdrs = await v2SignHeaders(targetUrl, method); } catch (e) {
                console.warn('[apiFetch] v2 签名失败：', targetUrl, e);
            }
            const _s = v2Session();
            const sessReady = !!(_s && _s.getSessionId && _s.getSessionId());
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
    // 所有版本尝试都被跳过（v2 会话未就绪且该端点无 v1 版本）→ 抛明确错误，
    // 不要返回 null，否则调用方 res.json() 会炸出难懂的 "Cannot read properties of null"
    if (!lastRes) throw new Error('无可用请求版本（v2 会话未就绪且无 v1 回退）：' + url);
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
        return await ocTransport(url, options);
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
            res = await ocTransport(base + url, options);
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
                }
                // 会话失效（服务端重启 / 会话 TTL 到期）→ 就地自愈：
                // 清 HTTP 会话 → 重新握手 → 用新会话签名重试一次；成功就当没事发生。
                // 只动 __httpSession，绝不碰 __wsSession（否则活着的 WS 会静默变聋）。
                if (bodyText && /invalid_session|missing_session/.test(bodyText) && !options._v2SessionRetried) {
                    const sess = window.__httpSession;
                    if (sess && sess.clear) {
                        sess.clear();
                        try {
                            const fresh = await signV2ForAnyPath(url, options.method || 'GET');
                            if (fresh && fresh['X-Sign']) {
                                console.log('[apiFetch] v2 会话已失效，重新握手后重试：' + url);
                                const retryOpts = Object.assign({}, options, {
                                    headers: Object.assign({}, options.headers || {}, fresh),
                                    _v2SessionRetried: true
                                });
                                const r3 = await ocTransport(base + url, retryOpts);
                                if (r3.status !== 401) return r3; // 自愈成功
                                try { if (r3.body) r3.body.cancel(); } catch (e) {}
                            }
                        } catch (e) {
                            console.warn('[apiFetch] v2 会话自愈失败:', e);
                        }
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
                            const r2 = await ocTransport(fb + v1Url, Object.assign({}, options, { headers: hdrs }));
                            // 仅 2xx 视为回退成功；4xx（含 401 token 过期）不要 short-circuit，
                            // 否则会跳过下方的 token 刷新/重登逻辑，导致 v2 端点静默报废。
                            if (r2.ok) return r2;
                        } catch (e) { /* 继续下一个候选 */ }
                    }
                }
                // 回退也失败：继续走下方刷新/登出逻辑
            }
            const refreshToken = localStorage.getItem('oc_refresh_token');
            if (refreshToken) {
                try {
                    const refreshRes = await ocTransport(BACKEND_CANDIDATES[0] + '/v1/auth/refresh', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': ocUserAgent() },
                        body: JSON.stringify({ refresh_token: refreshToken })
                    });
                    if (refreshRes.ok) {
                        const data = await refreshRes.json();
                        localStorage.setItem('oc_access_token', data.access_token);
                        localStorage.setItem('oc_refresh_token', data.refresh_token || '');
                        if (data.user) localStorage.setItem('oc_user', JSON.stringify(data.user));
                        options.headers = options.headers || {};
                        options.headers['Authorization'] = 'Bearer ' + data.access_token;
                        // token 刷新成功：恢复该端点为 v2（本次 401 时它已被误加入 v2FailedPaths 熔断）
                        v2FailedPaths.delete(url.split('?')[0]);
                        const replay = await ocTransport(base + url, options);
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


// ---- 网络转接器（外部注入，SDK 内不实现）----
// 所有 HTTP 请求（含 v2 签名、候选地址轮询、降级）最终都通过 ocTransport 发出。
// 本 SDK 只【声明】它，不【实现】它——实现由外部 JS 注入到 window.ocTransport。
//
// 外部注入示例（写在宿主环境，如 app.js 或独立 adapter 文件）：
//
//   // 浏览器：直接走原生 fetch（开箱即跑，后端需放开 CORS）
//   window.ocTransport = (url, init) => fetch(url, init);
//
//   // Tauri：优先 plugin-http 直连（无 CORS），否则回退浏览器 fetch
//   window.ocTransport = async (url, init) => {
//     if (typeof window.__tauriHttpFetchImpl === 'function')
//       return window.__tauriHttpFetchImpl(url, init);
//     return fetch(url, init);
//   };
//
//   // 测试桩：拦截全部请求返回假数据
//   window.ocTransport = async (url) => new Response(JSON.stringify({ ok: true, url }),
//     { status: 200, headers: { 'Content-Type': 'application/json' } });
//
// 若发起请求时 window.ocTransport 仍未注入，apiFetch 会抛出明确错误。
async function ocTransport(input, init) {
  const impl = (typeof window !== 'undefined' && window.ocTransport);
  if (typeof impl === 'function') return impl(input, init);
  throw new Error('[oldchat-api-sdk] OC transport 未注入：请在发起请求前设置 window.ocTransport(url, init)');
}

(function (global) {
  'use strict';

  const apiFetch = global.apiFetch;
  if (typeof apiFetch !== 'function') {
    console.error('[oldchat-api-sdk] window.apiFetch 未就绪，请确认本文件在 api.js 之后加载');
  }

  // ---- 统一错误 ----
  class OCError extends Error {
    constructor(message, code, raw) {
      super(message);
      this.name = 'OCError';
      this.code = code || null;
      this.raw = raw || null;
    }
  }

  // ---- 内部：解析 Response，兜 {error} ----
  async function _parse(r) {
    let j;
    try {
      j = await r.json();
    } catch (e) {
      throw new OCError('响应不是合法 JSON（疑似 ' + r.status + ' 非 JSON 体）', 'BAD_JSON', { status: r.status });
    }
    if (j && j.error) {
      const err = j.error;
      const msg = (typeof err === 'string') ? err : (err.message || err.msg || JSON.stringify(err));
      const code = (typeof err === 'object') ? (err.code || null) : null;
      throw new OCError(msg, code, j.error);
    }
    // 服务端约定：业务数据在 data 字段；无 data 时退回顶层（兼容部分旧接口）
    return (j && Object.prototype.hasOwnProperty.call(j, 'data')) ? j.data : j;
  }

  async function _get(path) {
    const r = await apiFetch(path);
    return _parse(r);
  }

  async function _post(path, body, opts) {
    const r = await apiFetch(path, Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }, opts || {}));
    return _parse(r);
  }

  // =====================================================================
  // 字段归一化层（依据 app.js 现有 loadXxx 的真实解析固化）
  // 保留原始宽结构，不收窄，避免调用方丢字段。
  // =====================================================================

  function pickUid(raw) {
    // 与 app.js getUid 一致：ncuid 优先，否则 uid
    return raw.ncuid || raw.uid || '';
  }

  function normalizeFriend(raw) {
    // 来自 loadContacts 好友解析（app.js:5361-5370）
    const uid = pickUid(raw);
    return {
      uid: uid,
      ncuid: raw.ncuid || '',
      displayUid: (raw.ncuid || raw.uid || '').toUpperCase(),
      name: raw.display_name || raw.username || uid,
      username: raw.username || '',
      display_name: raw.display_name || '',
      avatar: raw.avatar_url || '',
      remark_name: raw.remark_name || '',
      user_title: raw.user_title || '',
      role: raw.role || 0
    };
  }

  function normalizeGroup(raw) {
    // 来自 loadContacts 群解析（app.js:5371-5377）
    return {
      id: raw.group_id,
      name: raw.name || '',
      avatar: raw.avatar_url || '',
      member_count: raw.member_count || 0,
      role: raw.role || null
    };
  }

  function normalizeUnreadMessage(raw) {
    // 来自 loadUnreadCounts（app.js:5439-5465）：群按 group_id，私聊按 from_ncuid||from_uid
    return {
      group_id: raw.group_id || null,
      from_uid: raw.from_uid || null,
      from_ncuid: raw.from_ncuid || null,
      created_at: raw.created_at || 0
    };
  }

  // ---- OC 命名空间：业务方法层 ----
  const OC = {
    OCError,
    _get, _post,

    // ===== 认证（登录/握手由 app.js 现有逻辑负责，此处仅预留包裹位）=====
    // login / handshake 暂不下沉，保持 app.js 现有实现，避免动传输层。

    // ===== 通讯录（已验证）=====
    async getFriends() {
      const d = await _get('/v1/friends');
      return (d.friends || []).map(normalizeFriend);
    },
    async getFriendRequests() {
      const d = await _get('/v1/friends/requests');
      // 好友请求字段分散（status/avatar_url/from_name/from_username 等各调用方需求不一），
      // 保留原始全部字段 + 聚合 uid（兼容 getUid(r) 语义），不强行收窄。
      return (d.requests || []).map(r => Object.assign({}, r, {
        uid: r.from_ncuid || r.from_uid || ''
      }));
    },
    async addFriend(uidOrNcuid) {
      // 复用 app.js 的 toUidParam 语义：双写 to_uid/to_ncuid
      const body = {};
      if (String(uidOrNcuid).toUpperCase().startsWith('NC')) body.to_ncuid = uidOrNcuid;
      else body.to_uid = uidOrNcuid;
      return _post('/v1/friends/request', body);
    },
    async respondFriend(requestId, accept) {
      return _post('/v1/friends/respond', { request_id: requestId, accept: !!accept });
    },
    async getGroups() {
      const d = await _get('/v1/groups/list');
      return (d.groups || []).map(normalizeGroup);
    },
    async getGroupMembers(groupId) {
      // app.js:3822 / 9718 / 9762
      const d = await _get('/v1/groups/members?group_id=' + encodeURIComponent(groupId));
      return (d.members || []).map(normalizeFriend);
    },

    // ===== 未读（已验证 v2 兼容；api.js V1_TO_V2 已映射 /v1/*/unread -> /v2/unread/*）=====
    // 返回原始 messages 数组（app.js loadUnreadCounts 直接用 m.from_ncuid/m.group_id/m.created_at 等 raw 字段，无需归一化）
    async getUnreadDirect(limit = 200) {
      const d = await _post('/v1/direct/unread', { limit });
      return d.messages || [];
    },
    async getUnreadGroups(limit = 200) {
      const d = await _post('/v1/groups/unread', { limit });
      return d.messages || [];
    },

    // ===== 消息历史 / 发送 / 已读 / 撤回（已读码，app.js:5671/7808/8050/5757/9545/9547/10798/3546/3567/3569/8007/8009）=====
    // 重要：消息对象在 app.js 中始终是「原始宽结构」(id/from_uid/from_ncuid/body/msg_type/media_url/created_at/group_id...)
    // appendMessage / createMessageElement / sendMessage 直接用这些 raw 字段，因此本层【不归一化】，
    // 直接返回 data.messages 原数组供调用方自行 reverse/去重/渲染，避免丢字段。
    async getDirectMessages(ncuid, { limit = 30, offset = 0 } = {}) {
      const d = await _get(`/v1/direct/messages/v2?with_ncuid=${encodeURIComponent(ncuid)}&limit=${limit}&offset=${offset}`);
      return d.messages || [];
    },
    async getGroupMessages(groupId, { limit = 30, offset = 0 } = {}) {
      const d = await _get(`/v1/groups/messages/v2?group_id=${encodeURIComponent(groupId)}&limit=${limit}&offset=${offset}`);
      return d.messages || [];
    },
    async searchDirectMessages(uid, keyword) {
      const d = await _get(`/v1/direct/messages/search?with_uid=${encodeURIComponent(uid)}&keyword=${encodeURIComponent(keyword)}`);
      return d.messages || [];
    },
    async searchGroupMessages(groupId, keyword) {
      const d = await _get(`/v1/groups/messages/search?group_id=${encodeURIComponent(groupId)}&keyword=${encodeURIComponent(keyword)}`);
      return d.messages || [];
    },
    // 发送：透传 payload（app.js sendMessage 已构建完整字段），返回 data（含 message||data）
    async sendDirect(payload) {
      return _post('/v1/direct/send', payload);
    },
    async sendGroup(payload) {
      return _post('/v1/groups/message/send', payload);
    },
    // 已读：复用 app.js withUidParam 双写语义 {with_uid, with_ncuid}
    async markDirectRead(id) {
      return _post('/v1/direct/read', { with_uid: id, with_ncuid: id });
    },
    async markGroupRead(groupId) {
      return _post('/v1/groups/read', { group_id: groupId });
    },
    // 撤回：DELETE /v1/{groups|direct}/messages/{msgId}
    async recallDirectMessage(msgId) {
      const r = await apiFetch(`/v1/direct/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
      return _parse(r);
    },
    async recallGroupMessage(msgId) {
      const r = await apiFetch(`/v1/groups/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
      return _parse(r);
    },

    // ===== 动态 moments（已读码，app.js:3219/3229/3444/3528/3610/3654）=====
    // 返回 raw：调用方直接用 data.moments / comments 原始字段（from_name/avatar_url 等），不归一化。
    async getUserMoments({ ncuid, uid, limit = 50 } = {}) {
      // 优先 ncuid 路径（ncuid 不能传入 ?uid=，会 400），失败回退 uid（保持原双路径回退语义）
      if (ncuid) {
        try {
          const d = await _get(`/v1/moments/user?ncuid=${encodeURIComponent(ncuid)}&limit=${limit}`);
          if (d && !d.error) return d;
        } catch (e) {}
      }
      if (uid) {
        try {
          const d = await _get(`/v1/moments/user?uid=${encodeURIComponent(uid)}&limit=${limit}`);
          if (d && !d.error) return d;
        } catch (e) {}
      }
      return null;
    },
    async getMomentComments(momentId) {
      const d = await _get(`/v1/moments/comments?moment_id=${encodeURIComponent(momentId)}`);
      return d.comments || [];
    },
    async postMoment({ body, imageUrl = '' }) {
      return _post('/v1/moments', { body, image_url: imageUrl });
    },
    async postMomentComment({ momentId, body }) {
      return _post('/v1/moments/comment', { moment_id: momentId, body });
    },

    // ===== 红包 redpackets（已读码，app.js:9997/10052/10117/11191）=====
    // 返回 raw：调用方直接用 d.cover_url/d.title/d.packet_id 等原始字段，不归一化。
    async getRedpacket(packetId) {
      return _get(`/v1/redpackets/${encodeURIComponent(packetId)}`);
    },
    async claimRedpacket(packetId) {
      return _post('/v1/redpackets/claim', { packet_id: packetId });
    },
    async sendRedpacket(payload) {
      return _post('/v1/redpackets/send', payload);
    },

    // ===== 签到墙 checkin wall（已读码，app.js:3661/3707/12962/13023/13038）=====
    // getCheckinWall 需保留「404→功能建设中」与「非 JSON 容错」特殊逻辑，故返回 {notFound, data}
    async getCheckinWall(limit = 50) {
      const r = await apiFetch(`/v1/me/checkin/wall?limit=${limit}`);
      if (r.status === 404) return { notFound: true };
      const text = await r.text();
      let data = {};
      try { data = JSON.parse(text); } catch (e) { console.warn('[checkin] wall not JSON:', text.slice(0, 100)); }
      if (data && data.error) throw new OCError(data.error);
      return { notFound: false, data };
    },
    async doCheckin() {
      return _post('/v1/me/checkin', {});
    },
    async postCheckinWall(contentText) {
      return _post('/v1/me/checkin/wall', { content_text: contentText });
    },
    async getCheckinWallComments(postId) {
      const d = await _get(`/v1/me/checkin/wall/comments?post_id=${encodeURIComponent(postId)}`);
      return d.comments || [];
    },
    async postCheckinWallComment({ postId, body }) {
      return _post('/v1/me/checkin/wall/comment', { post_id: postId, body });
    },
    async likeCheckinWall(postId) {
      return _post('/v1/me/checkin/wall/like', { post_id: postId });
    },
    async unlikeCheckinWall(postId) {
      return _post('/v1/me/checkin/wall/unlike', { post_id: postId });
    },

    // ===== 公审庭 public-court（app.js:15198/15219/15233/15234/15327/15345/15359/15372）=====
    // 响应格式多层兼容（{case}/{data}/[] 包裹），app.js 用 courtExtractList 自行解析，
    // 故本层仅做「GET/POST 透传 + 兜 error」薄封装，返回原始 JSON，不归一化。
    async getCourtCases(status = 'all') {
      return _get('/v1/public-court/cases?status=' + encodeURIComponent(status));
    },
    async getCourtCaseDetail(id) {
      return _get('/v1/public-court/cases/' + encodeURIComponent(id));
    },
    async getCourtCaseVotes(id) {
      return _get('/v1/public-court/cases/' + encodeURIComponent(id) + '/votes');
    },
    async getCourtCaseDiscussions(id) {
      return _get('/v1/public-court/cases/' + encodeURIComponent(id) + '/discussions');
    },
    async voteCourtCase(id, { vote, reason = '', evidence = '' }) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/vote', { vote, reason, evidence });
    },
    async postCourtStatement(id, { reason, evidence = '' }) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/statement', { reason, evidence });
    },
    async postCourtDiscussion(id, { body }) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/discussion', { body });
    },
    async withdrawCourtCase(id) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/withdraw', {});
    },

    // ===== 刮刮乐 scratch（app.js:12962/13089）=====
    // GET 取当日状态：404/异常回传 null（视为功能未上线），由调用方 scratchLoad 处理
    async getMeScratch() {
      try {
        const r = await apiFetch('/v1/me/scratch', { method: 'GET' });
        if (r.status === 404) return null;
        const text = await r.text();
        let data = {};
        try { data = JSON.parse(text); } catch (e) {}
        if (data && data.error) throw new OCError(data.error);
        return data;
      } catch (e) {
        if (e instanceof OCError) throw e;
        return null; // 网络/解析异常视为未上线
      }
    },
    // POST 执行刮奖：返回 {status, data}，data 可能嵌套在 rd.body 字符串里，由调用方解
    async postMeScratch() {
      const r = await apiFetch('/v1/me/scratch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const text = await r.text();
      let rd = {};
      try { rd = JSON.parse(text); } catch (e) {}
      if (rd && typeof rd.body === 'string') { try { rd = JSON.parse(rd.body); } catch (e) {} }
      return { status: r.status, data: rd };
    },
    // 别名：早期按钮处理器 call-site 仍用 doScratch（app.js:13019）
    async doScratch() {
      return this.postMeScratch();
    },

    // ===== 表情广场 emoji（app.js:11278/11309/11355/11476/11486）=====
    // 字段各异（emoji 包含 id/name/url/type 等），调用方直接用 raw，不归一化
    async getEmojiPlaza({ limit = 50, offset = 0 } = {}) {
      const d = await _get(`/v1/emoji/plaza?limit=${limit}&offset=${offset}`);
      return d.emojis || d.items || [];
    },
    async getMyEmojis(limit = 200) {
      const d = await _get(`/v1/emoji/plaza/mine?limit=${limit}`);
      return d.emojis || d.items || [];
    },
    async saveEmoji(payload) {
      // payload: { name, url, type } 等，透传
      return _post('/v1/emoji/plaza/save', payload);
    },
    async deleteEmoji(id) {
      return _post('/v1/emoji/plaza/delete', { id });
    },
    // 分页加载（保留 has_more 等元字段）：返回原始 d，调用方自行取 items/has_more
    async getEmojiPlazaPage({ limit = 20, offset = 0 } = {}) {
      return _get(`/v1/emoji/plaza?limit=${limit}&offset=${offset}`);
    },

    // ===== 媒体上传 media（app.js:3523/4212/10330/14836）=====
    // 均为 FormData 上传（非 JSON），单独走 apiFetch 直接发，再 _parse 兜 error
    async uploadMedia(formData) {
      const r = await apiFetch('/v1/media', { method: 'POST', body: formData });
      return _parse(r);
    },
    async uploadChannelMedia(formData) {
      const r = await apiFetch('/v1/channels/media/upload', { method: 'POST', body: formData });
      return _parse(r);
    },

    // ===== 群管理（app.js:3995/4082/4100/4116/4183/4189/4212/4215/4288/4472/7685）=====
    // 均为动作类 POST/管理操作，body 各异，透传不归一化；返回原始 JSON 供调用方判断
    // 注意：后端 kick/admin/invite 的 user_uid 与 user_ncuid 独立校验，必须双写，任一缺失报 "uid or ncuid is required"
    async leaveGroup(groupId) {
      return _post('/v1/groups/leave', { group_id: groupId });
    },
    async kickGroupMember({ groupId, userUid, userNcuid }) {
      return _post('/v1/groups/kick', { group_id: groupId, user_uid: userUid, user_ncuid: userNcuid });
    },
    async setGroupAdmin({ groupId, userUid, userNcuid, admin }) {
      return _post('/v1/groups/admin', { group_id: groupId, user_uid: userUid, user_ncuid: userNcuid, admin: !!admin });
    },
    async dissolveGroup(groupId) {
      return _post('/v1/groups/dissolve', { group_id: groupId });
    },
    async updateGroupSettings(groupId, settings) {
      return _post('/v1/groups/settings', Object.assign({ group_id: groupId }, settings));
    },
    async renameGroup(groupId, name) {
      return _post('/v1/groups/name', { group_id: groupId, name });
    },
    // 群头像：上传是「先 /v1/media 拿 URL → 再 JSON 写回 avatar_url」，此处收口第二步
    async updateGroupAvatar({ groupId, avatarUrl }) {
      return _post('/v1/groups/avatar', { group_id: groupId, avatar_url: avatarUrl });
    },
    async inviteToGroup({ groupId, userUid, userNcuid }) {
      return _post('/v1/groups/invite', { group_id: groupId, user_uid: userUid, user_ncuid: userNcuid });
    },
    async joinGroup(groupId) {
      return _post('/v1/groups/join', { group_id: groupId });
    },

    // ===== 我的资料媒体 / 签到 / 刮刮乐（app.js:4436/13007/13022/13037/13394）=====
    async uploadMyAvatar(formData) {
      const r = await apiFetch('/v1/me/avatar', { method: 'POST', body: formData });
      return _parse(r);
    },
    async getMe() {
      const d = await _get('/v1/me');
      return d.user || d;
    },

    // ===== 资源广场 resources（v1 临时关闭，暂缓；对应行 15628/15674/15727/15774/15809/15888/15904/15939/15962/15984）=====
    // 服务端尚未迁移 v2，且近期因特殊原因临时关闭。app.js 保留裸 apiFetch 调用，待服务端恢复/迁移后再收口。

    // ===== 收藏 favorites（app.js:1420/13881/13908）=====
    async getFavorites(limit = 100) {
      const d = await _get('/v1/favorites?limit=' + limit);
      return d.items || (d.data && d.data.items) || [];
    },
    async addFavorite(body) {
      // body 字段复杂（type/target_id/title/subtitle/media_url/extra），透传不归一化
      return _post('/v1/favorites/add', body);
    },
    async removeFavorite(id) {
      return _post('/v1/favorites/remove', { id });
    },

    // ===== 音乐广场 music/plaza（app.js:2512/2933）=====
    // 上传为 FormData（非 JSON），单独走 apiFetch 直接发，再 _parse 兜 error
    async uploadMusicPlaza(formData) {
      const r = await apiFetch('/v1/music/plaza/upload', { method: 'POST', body: formData });
      return _parse(r);
    },
    async getMusicPlazaDetail(itemId) {
      const d = await _get('/v1/music/plaza/detail?id=' + encodeURIComponent(itemId));
      // 兼容响应嵌套：详情可能包在 item/data 字段里
      return d.item || d.data || d;
    },

    // ===== 用户资料 users/profile（app.js:3184/4306/4433/4463/4491/5942/5950/5959）=====
    // 三路径回退：ncuid → uid → (uid 当 ncuid 查，服务器可能把 ncuid 放进 from_uid)
    async getUserProfile({ ncuid, uid } = {}) {
      if (ncuid) {
        try {
          const d = await _get('/v1/users/profile?ncuid=' + encodeURIComponent(ncuid));
          if (d && !d.error) return d;
        } catch (e) {}
      }
      if (uid) {
        try {
          const d = await _get('/v1/users/profile?uid=' + encodeURIComponent(uid));
          if (d && !d.error) return d;
        } catch (e) {}
        if (!ncuid) {
          try {
            const d = await _get('/v1/users/profile?ncuid=' + encodeURIComponent(uid));
            if (d && !d.error) return d;
          } catch (e) {}
        }
      }
      return null;
    },
    async updateMyProfile(patch) {
      return _post('/v1/me/profile', patch);
    },
    async updateMyUid(uid) {
      return _post('/v1/me/uid', { uid });
    },

    // ===== 通知 notifications（app.js:13427）=====
    // 通知页是「尽力解析」容错逻辑（404 显示建设中、res.text() 再 JSON.parse），
    // 返回 {notFound, data}（同 getCheckinWall 模式），由调用方渲染。
    async getNotifications(limit = 50) {
      const r = await apiFetch('/v1/notifications?limit=' + limit);
      if (r.status === 404) return { notFound: true };
      const text = await r.text();
      let data = {};
      try { data = JSON.parse(text); } catch (e) { console.warn('[notice] not JSON:', text.slice(0, 100)); }
      if (data && data.error) throw new OCError(data.error);
      return { notFound: false, data };
    },

    // ===== 动态 moments（app.js:3219/3229/3444/3528/3610/3654，已由本文件上方实现）=====
  };

  global.OC = OC;
  if (typeof module !== 'undefined' && module.exports) module.exports = { OC, OCError };

})(typeof window !== 'undefined' ? window : globalThis);
