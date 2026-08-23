// =====================================================================
// oldchat-ws-extension.js - OldChat WebSocket 扩展包（连接管道）
//
// 定位：本扩展包是 OldChat API SDK（oldchat-api-sdk.js）的官方配套扩展，
// 只负责「长连接管道」本身，不解析任何业务推送字段，也不实现 HTTP 协议。
//
// 唯一职责：
//   1. 管连接：建立 / 维持 / 断开 WebSocket
//   2. 管保活：可选心跳（默认关闭，由宿主按需启用）、断线指数退避重连
//   3. 管转发：收到消息后原样触发 `raw` 事件；解码后再触发 `message`
//      （解码只做「信封→明文」的密码学还原，绝不解析业务字段语义）
//
// 与 SDK 的边界（固定不变）：
//   读 window.BACKEND_CANDIDATES[0]（或 window.WS_HOST）-> 拼接 WS 地址 host
//   读 localStorage.oc_access_token -> 认证（放在 URL query 的 token 参数）
//   读 localStorage.oc_request_mode  -> '仅轮询' 时 connect() 直接 no-op（不建连）
//   读 window.__wsSession            -> WS 握手会话（由 app.js 注入，含 encKey/macKey/sid）
//   绝不碰 window.__httpSession      -> HTTP 的 ECDH 会话，WS 独立维护自己的密钥/会话
//
// ---------------------------------------------------------------------
// 与「通用 AI 设计建议」的关键偏差（本项目实际约定，已据源码修正）：
//   - WS 地址路径不是 /gateway，而是 /v1/ws；协议按页面 scheme 选 ws:/wss:
//     （后端无 TLS 时实际为 ws://），而非硬编码 wss://。
//   - 认证参数除 token 外还需要 sid（WS 会话ID），这是 ECDH 握手产物。
//     默认握手复用 window.__wsSession（app.js 已注入），也可 options.handshake 自注入。
//   - oc_request_mode 真实取值为 'WebSocket优先'(默认)/'仅WebSocket'/'仅轮询'，
//     不是建议里的「仅轮询」单一值；仅『仅轮询』才禁用 WS。
//   - 心跳：本项目实际 WS 依赖原生保活 + onclose 重连，并无强制 ping/pong 格式，
//     因此 sendPing 改为【可选】；不提供则不发心跳，不强制宿主实现。
//   - 传输器默认回退浏览器原生 WebSocket；Tauri 环境原生 WebSocket 即可直连，
//     无需 plugin-websocket 等额外依赖。
//   - 服务端可能下发 AES 信封 {iv,data,mac} 或明文 JSON 两种帧；扩展包默认
//     decode 会尝试解密信封（密钥来自握手），解密失败且确为信封则 emit
//     'envelope_error' 供宿主重建连接，绝不静默丢弃（历史事故教训）。
//
// 加载顺序（index.html）：oldchat-api-sdk.js → oldchat-ws-extension.js → app.js
// 设计约束：经典 <script>，全局 window.OCWebSocket；零构建、不引打包工具。
// =====================================================================

var OCWebSocket = (function (global) {
    'use strict';

    // -----------------------------------------------------------------
    // 一、极简事件系统（EventEmitter）
    // -----------------------------------------------------------------
    function createEmitter() {
        const map = new Map(); // event -> Set<fn>
        return {
            on(event, fn) {
                if (typeof fn !== 'function') return () => {};
                if (!map.has(event)) map.set(event, new Set());
                map.get(event).add(fn);
                return () => this.off(event, fn);
            },
            once(event, fn) {
                const off = this.on(event, (payload) => {
                    off();
                    fn(payload);
                });
                return off;
            },
            off(event, fn) {
                const set = map.get(event);
                if (set) set.delete(fn);
            },
            emit(event, payload) {
                const set = map.get(event);
                if (!set) return;
                Array.from(set).forEach((fn) => {
                    try { fn(payload); }
                    catch (e) { console.error('[OCWebSocket] listener error on "' + event + '":', e); }
                });
            },
            clear() { map.clear(); }
        };
    }

    // -----------------------------------------------------------------
    // 二、可插拔传输器（默认浏览器原生 WebSocket）
    // -----------------------------------------------------------------
    let transport = {
        create(url) {
            if (typeof WebSocket === 'undefined') {
                throw new Error('OCWebSocket: 当前环境无 WebSocket 实现，请通过 OCWebSocket.setTransport() 注入');
            }
            return new WebSocket(url);
        },
        isSupported() {
            return typeof WebSocket !== 'undefined';
        }
    };

    // -----------------------------------------------------------------
    // 三、状态常量
    // -----------------------------------------------------------------
    const STATE = {
        IDLE: 'idle',
        CONNECTING: 'connecting',
        CONNECTED: 'connected',
        RECONNECTING: 'reconnecting',
        DISCONNECTED: 'disconnected',
        FAILED: 'failed'
    };

    // 默认配置（可被构造参数覆盖）
    const DEFAULTS = {
        getUrl: null,            // 默认实现：拼接 ws://<host>/v1/ws?token=&sid=
        sendPing: null,          // 可选心跳发送函数；不提供则不发心跳
        pingInterval: 30000,     // 心跳发送间隔(ms)
        pingTimeout: 10000,      // 心跳响应超时(ms)，超时视为断线
        reconnect: true,         // 是否自动重连
        maxAttempts: Infinity,   // 最大重连次数（Infinity=无限）
        baseDelay: 1000,         // 指数退避基准(ms)
        maxDelay: 30000,         // 退避上限(ms)
        onConnectionLost: null,  // 达到最大重试次数回调（宿主可切轮询）
        debug: false,
        handshake: null,         // 返回 { sessionId, encKey, macKey }；默认复用 __wsSession
        decode: null             // 把原始帧解码为 { kind, data }；默认信封/明文双模
    };

    // -----------------------------------------------------------------
    // 四、默认实现：URL 构造 / 握手 / 解码 / WebCrypto 辅助
    // -----------------------------------------------------------------

    // host 来源（优先级）：window.WS_HOST → window.BACKEND_CANDIDATES[0] → 硬编码默认后端
    // sid  来源：window.__wsSession.getSessionId()（由 handshake 已 ensure）
    function defaultGetUrl() {
        let host = 'oc.mcl0.dpdns.org';
        try {
            if (global.WS_HOST) host = global.WS_HOST;
            else if (global.BACKEND_CANDIDATES && global.BACKEND_CANDIDATES[0]) host = global.BACKEND_CANDIDATES[0];
        } catch (e) {}
        const origin = String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const protocol = (global.location && global.location.protocol === 'https:') ? 'wss:' : 'ws:';
        let token = '';
        try { token = localStorage.getItem('oc_access_token') || ''; } catch (e) {}
        let sid = '';
        try {
            if (global.__wsSession && typeof global.__wsSession.getSessionId === 'function') {
                sid = global.__wsSession.getSessionId() || '';
            }
        } catch (e) {}
        const q = [];
        if (token) q.push('token=' + encodeURIComponent(token));
        if (sid) q.push('sid=' + encodeURIComponent(sid));
        return protocol + '//' + origin + '/v1/ws' + (q.length ? ('?' + q.join('&')) : '');
    }

    // 默认握手：优先复用宿主 __wsSession（app.js 注入的 WS ECDH 握手），
    // 否则自行走 /v1/auth/handshake（需核心 SDK 已加载以复用 ocTransport / Crypto）
    async function defaultHandshake() {
        if (global.__wsSession && typeof global.__wsSession.ensure === 'function') {
            await global.__wsSession.ensure();
            return {
                sessionId: global.__wsSession.getSessionId(),
                encKey: global.__wsSession.getEncKey(),
                macKey: global.__wsSession.getMacKey()
            };
        }
        if (!global.crypto || !global.crypto.subtle) {
            throw new Error('OCWebSocket: 无 WebCrypto，无法自行握手；请注入 window.__wsSession 或 options.handshake');
        }
        const keys = await global.crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const spki = await global.crypto.subtle.exportKey('spki', keys.publicKey);
        const clientPub = _bytesToBase64(new Uint8Array(spki));
        const base = (global.BACKEND_CANDIDATES && global.BACKEND_CANDIDATES[0]) || 'http://oc.mcl0.dpdns.org';
        const res = await (global.ocTransport || global.fetch)(base + '/v1/auth/handshake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_pub: clientPub })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const serverPub = await global.crypto.subtle.importKey(
            'spki', _base64ToBytes(data.server_pub),
            { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const secret = new Uint8Array(await global.crypto.subtle.deriveBits(
            { name: 'ECDH', public: serverPub }, keys.privateKey, 256));
        const encKey = await _sha256(_concat(secret, new TextEncoder().encode('enc')));
        const macKey = await _sha256(_concat(secret, new TextEncoder().encode('mac')));
        return { sessionId: data.session_id, encKey, macKey };
    }

    // 默认解码：信封 / 明文双模（不解析任何业务字段）
    function _looksLikeEnvelope(data) {
        if (typeof data !== 'string') return false;
        try {
            const o = JSON.parse(data);
            return o && typeof o === 'object' && 'iv' in o && 'data' in o && 'mac' in o;
        } catch (e) { return false; }
    }

    async function defaultDecode(rawData, session) {
        let text = rawData;
        if (typeof rawData !== 'string') {
            if (rawData instanceof ArrayBuffer) text = new TextDecoder().decode(rawData);
            else if (rawData && typeof rawData.text === 'function') text = await rawData.text();
            else return { kind: 'binary', data: rawData };
        }
        if (_looksLikeEnvelope(text)) {
            if (session && session.encKey && session.macKey) {
                try {
                    const o = JSON.parse(text);
                    const iv = _base64ToBytes(o.iv);
                    const ct = _base64ToBytes(o.data);
                    const mac = _base64ToBytes(o.mac);
                    const expect = await _hmacSha256(session.macKey, _concat(iv, ct));
                    if (!_constTimeEqual(expect, mac)) throw new Error('MAC 校验失败');
                    const key = await global.crypto.subtle.importKey(
                        'raw', session.encKey, { name: 'AES-CBC' }, false, ['decrypt']);
                    const plain = await global.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
                    return { kind: 'json', data: JSON.parse(new TextDecoder().decode(plain)) };
                } catch (e) {
                    return { kind: 'envelope_error', error: e, raw: text };
                }
            }
            return { kind: 'envelope_error', error: new Error('无 WS 会话密钥'), raw: text };
        }
        try { return { kind: 'json', data: JSON.parse(text) }; }
        catch (e) { return { kind: 'text', data: text }; }
    }

    // WebCrypto 辅助（仅默认 handshake/decode 路径需要）
    function _bytesToBase64(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    function _base64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function _concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
    async function _sha256(bytes) { return new Uint8Array(await global.crypto.subtle.digest('SHA-256', bytes)); }
    async function _hmacSha256(key, bytes) {
        const k = await global.crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await global.crypto.subtle.sign('HMAC', k, bytes));
    }
    function _constTimeEqual(a, b) {
        if (a.length !== b.length) return false;
        let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0;
    }

    // 请求模式判定（仅『仅轮询』禁用 WS）
    function isPollingOnly() {
        try {
            const m = localStorage.getItem('oc_request_mode');
            return m === '仅轮询';
        } catch (e) { return false; }
    }

    // -----------------------------------------------------------------
    // 五、主类 OCWebSocket
    // -----------------------------------------------------------------
    function OCWebSocket(options) {
        if (!(this instanceof OCWebSocket)) return new OCWebSocket(options);
        options = options || {};
        this._cfg = Object.assign({}, DEFAULTS, options);
        this._emitter = createEmitter();
        this._ws = null;
        this._state = STATE.IDLE;
        this._attempt = 0;
        this._reconnectTimer = null;
        this._pingTimer = null;
        this._pongTimer = null;
        this._manualClose = false;
        this._debug = this._cfg.debug;
        this._session = null; // { sessionId, encKey, macKey }，由 handshake() 填充
        if (typeof this._cfg.getUrl !== 'function') this._cfg.getUrl = defaultGetUrl;
        if (typeof this._cfg.handshake !== 'function') this._cfg.handshake = defaultHandshake;
        if (typeof this._cfg.decode !== 'function') this._cfg.decode = defaultDecode;
    }

    // ---- 日志 ----
    OCWebSocket.prototype._log = function () {
        if (this._debug) console.log('[OCWebSocket]', ...arguments);
    };

    // ---- 状态 ----
    OCWebSocket.prototype.getState = function () { return this._state; };
    OCWebSocket.prototype._setState = function (s) {
        if (this._state === s) return;
        this._state = s;
        this._emitter.emit('statechange', { state: s });
    };

    // ---- 事件订阅 ----
    OCWebSocket.prototype.on = function (event, fn) { return this._emitter.on(event, fn); };
    OCWebSocket.prototype.once = function (event, fn) { return this._emitter.once(event, fn); };
    OCWebSocket.prototype.off = function (event, fn) { return this._emitter.off(event, fn); };

    // ---- 建立连接（先握手拿会话，再建连）----
    OCWebSocket.prototype.connect = function () {
        if (isPollingOnly()) {
            this._log('oc_request_mode=仅轮询，跳过 WS 建立');
            this._setState(STATE.DISCONNECTED);
            return;
        }
        if (this._state === STATE.CONNECTING || this._state === STATE.CONNECTED) {
            this._log('已在连接/已连接，忽略重复 connect');
            return;
        }
        this._manualClose = false;
        this._open();
    };

    OCWebSocket.prototype._open = async function () {
        this._clearReconnectTimer();
        this._setState(this._attempt > 0 ? STATE.RECONNECTING : STATE.CONNECTING);
        if (this._attempt > 0) {
            this._emitter.emit('reconnecting', { attempt: this._attempt, delay: 0 });
        }
        // 握手（确保有会话密钥与 sid）
        try {
            this._session = await this._cfg.handshake();
        } catch (e) {
            this._log('handshake 失败:', e);
            this._emitter.emit('error', { error: e });
            this._scheduleReconnect();
            return;
        }
        let url;
        try {
            url = this._cfg.getUrl();
        } catch (e) {
            this._log('getUrl() 抛错:', e);
            this._emitter.emit('error', { error: e });
            this._scheduleReconnect();
            return;
        }
        if (!transport.isSupported()) {
            const err = new Error('OCWebSocket: 传输器不可用（isSupported()=false）');
            this._emitter.emit('error', { error: err });
            this._setState(STATE.FAILED);
            return;
        }
        let ws;
        try {
            ws = transport.create(url);
        } catch (e) {
            this._log('transport.create() 抛错:', e);
            this._emitter.emit('error', { error: e });
            this._scheduleReconnect();
            return;
        }
        this._ws = ws;

        ws.onopen = () => {
            this._log('connected:', url.replace(/token=[^&]+/, 'token=***'));
            this._attempt = 0;
            this._setState(STATE.CONNECTED);
            this._emitter.emit('connected', { url: url });
            this._startPing();
        };

        ws.onmessage = async (event) => {
            // 原样转发（核心事件，未解码的原始数据）
            this._emitter.emit('raw', { data: event.data });
            // 解码后转发（信封→明文还原；业务字段语义仍由宿主解析）
            try {
                const result = await this._cfg.decode(event.data, this._session);
                if (result.kind === 'envelope_error') {
                    this._log('信封解密失败，重建连接重新握手');
                    this._emitter.emit('envelope_error', { error: result.error, raw: result.raw });
                    this._rebuildAndReconnect();
                    return;
                }
                this._emitter.emit('message', { kind: result.kind, data: result.data, raw: event.data });
            } catch (e) {
                this._emitter.emit('error', { error: e });
            }
        };

        ws.onclose = (event) => {
            this._log('closed:', event.code, event.reason, 'clean=', event.wasClean);
            this._stopPing();
            this._ws = null;
            this._session = null; // 会话可能失效，下次重建
            this._setState(STATE.DISCONNECTED);
            this._emitter.emit('disconnected', {
                code: event.code, reason: event.reason, wasClean: event.wasClean
            });
            if (!this._manualClose) this._scheduleReconnect();
        };

        ws.onerror = (event) => {
            this._log('error:', event);
            this._emitter.emit('error', { error: event });
        };
    };

    // 信封解密失败：清会话 + 立即重连（重新握手）
    OCWebSocket.prototype._rebuildAndReconnect = function () {
        this._session = null;
        if (this._ws) { try { this._ws.close(); } catch (e) {} this._ws = null; }
        this._scheduleReconnect();
    };

    // ---- 主动断开（不重连）----
    OCWebSocket.prototype.disconnect = function () {
        this._manualClose = true;
        this._clearReconnectTimer();
        this._stopPing();
        if (this._ws) {
            try { this._ws.close(1000, 'client disconnect'); } catch (e) {}
            this._ws = null;
        }
        this._setState(STATE.DISCONNECTED);
    };

    // ---- 手动重连 ----
    OCWebSocket.prototype.reconnect = function () {
        this._attempt = 0;
        this._manualClose = false;
        this._open();
    };

    // ---- 发送数据（格式由宿主保证）----
    OCWebSocket.prototype.send = function (data) {
        if (!this._ws || this._ws.readyState !== 1 /* WebSocket.OPEN */) {
            this._emitter.emit('error', { error: new Error('OCWebSocket: 连接未就绪，无法发送') });
            return false;
        }
        try {
            this._ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            return true;
        } catch (e) {
            this._emitter.emit('error', { error: e });
            return false;
        }
    };

    // ---- 心跳（可选）----
    OCWebSocket.prototype._startPing = function () {
        this._stopPing();
        if (typeof this._cfg.sendPing !== 'function') return; // 未配置则不发
        this._pingTimer = setInterval(() => {
            if (!this._ws || this._ws.readyState !== 1) return;
            try { this._cfg.sendPing(this._ws); } catch (e) {
                this._log('sendPing 抛错:', e);
            }
            this._stopPongTimer();
            this._pongTimer = setTimeout(() => {
                this._log('心跳超时，判定断线');
                if (this._ws) { try { this._ws.close(4000, 'ping timeout'); } catch (e) {} }
            }, this._cfg.pingTimeout);
        }, this._cfg.pingInterval);
    };
    OCWebSocket.prototype._stopPing = function () {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
        this._stopPongTimer();
    };
    OCWebSocket.prototype._stopPongTimer = function () {
        if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
    };
    // 宿主在收到服务端 pong/心跳应答时应调用，取消超时判定
    OCWebSocket.prototype.notifyPong = function () { this._stopPongTimer(); };

    // ---- 指数退避重连 ----
    OCWebSocket.prototype._scheduleReconnect = function () {
        if (!this._cfg.reconnect || this._manualClose) return;
        if (this._attempt >= this._cfg.maxAttempts) {
            this._log('达到最大重连次数，停止');
            this._setState(STATE.FAILED);
            this._emitter.emit('failed', { attempt: this._attempt });
            if (typeof this._cfg.onConnectionLost === 'function') {
                try { this._cfg.onConnectionLost(); } catch (e) {}
            }
            return;
        }
        this._attempt++;
        const delay = Math.min(this._cfg.baseDelay * Math.pow(2, this._attempt - 1), this._cfg.maxDelay);
        this._log('第', this._attempt, '次重连，', delay, 'ms 后');
        this._emitter.emit('reconnecting', { attempt: this._attempt, delay: delay });
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._open();
        }, delay);
    };
    OCWebSocket.prototype._clearReconnectTimer = function () {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    };

    // ---- 销毁 ----
    OCWebSocket.prototype.destroy = function () {
        this.disconnect();
        this._clearReconnectTimer();
        this._emitter.clear();
    };

    // -----------------------------------------------------------------
    // 六、静态 API：传输器注入
    // -----------------------------------------------------------------
    OCWebSocket.setTransport = function (t) {
        if (t && typeof t.create === 'function') transport = t;
    };
    OCWebSocket.getTransport = function () { return transport; };
    OCWebSocket.STATE = STATE;
    OCWebSocket.version = '1.0.0';

    // 交由 IIFE 返回值统一处理导出（见文件末尾）
    return OCWebSocket;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

// 浏览器（无 module）：挂到 window；Node/SSR：module.exports。
// IIFE 返回值已赋给外部 var OCWebSocket，此处直接引用。
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OCWebSocket;
} else if (typeof window !== 'undefined') {
    window.OCWebSocket = OCWebSocket;
}
