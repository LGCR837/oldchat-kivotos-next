# OldChat WebSocket 扩展包使用文档

> 配套核心 SDK：`oldchat-api-sdk.js`（OldChat API SDK JavaScript by LGCR837）
> 扩展包文件：`oldchat-ws-extension.js`
> 全局对象：`window.OCWebSocket`

---

## 1. 定位与职责边界

本扩展包是核心 SDK 的**官方配套长连接扩展**，只做「管道」，不碰业务：

| 职责 | 谁负责 |
|---|---|
| 建立 / 断开 / 重连 WebSocket | **扩展包** |
| 断线指数退避重连、状态机 | **扩展包** |
| 事件发布/订阅（on/off/once） | **扩展包** |
| 信封（AES-CBC + HMAC）解密还原为明文 | **扩展包**（仅密码学还原，**不解析业务字段**） |
| WS 地址拼接（`/v1/ws?token=&sid=`） | **扩展包**（默认实现，可覆盖） |
| WS ECDH 握手（`__wsSession`） | **默认复用** `window.__wsSession`（app.js 注入），可 `options.handshake` 覆盖 |
| 心跳包格式（ping/pong） | **可选**，宿主按需提供 `sendPing`，不提供则不发 |
| **业务字段解析**（聊天/输入中/系统通知等） | **宿主**（监听 `message` 事件自行 `switch(msg.type)`） |
| HTTP 会话（`__httpSession`） | **扩展包绝不碰**（WS 会话独立维护） |

设计原则：收到任何帧，先 `raw` 事件原样传出；再经默认 `decode` 还原（明文或解密后的对象）后由 `message` 事件传出。**任何业务字段的语义都由宿主决定**，扩展包零假设。

---

## 2. 与「通用 AI 设计建议」的关键修正（据本项目真实协议）

AI 给出的通用方案有多处与 OldChat 后端实际不符，本扩展包已据源码修正：

1. **WS 路径**：实际是 `/v1/ws`，**不是** `/gateway`。
2. **协议**：`ws:`（后端无 TLS）或 `wss:`（页面为 https 时自动切换），**不是硬编码 wss://**。
3. **认证参数**：除 `token`（来自 `localStorage.oc_access_token`）外还需 `sid`（WS 会话 ID，ECDH 握手产物），拼接为 `?token=...&sid=...`。
4. **`oc_request_mode` 取值**：真实为 `'WebSocket优先'`(默认) / `'仅WebSocket'` / `'仅轮询'`，仅 **`'仅轮询'`** 禁用 WS 自启；不是单一「仅轮询」值。
5. **心跳**：后端 WS 无强制 ping/pong 应用层协议，保活靠连接不断 + `onclose` 重连。故 `sendPing` 为**可选**，不强制实现。
6. **传输器**：浏览器/ Tauri 原生 `WebSocket` 即可直连，**无需** `plugin-websocket` 等额外依赖。
7. **信封帧**：后端可能下发加密信封 `{iv,data,mac}`，默认 `decode` 会尝试 AES-CBC 解密（密钥来自握手）；解密失败且确为信封时 emit `envelope_error` 并重建连接，**绝不静默丢弃**（历史事故教训）。

---

## 3. 加载顺序

```html
<script src="oldchat-api-sdk.js"></script>          <!-- 核心 SDK（提供 ocTransport / Crypto） -->
<script src="oldchat-ws-extension.js"></script>     <!-- 本扩展包 -->
<script src="app.js"></script>                       <!-- 宿主：注入 __wsSession / ocTransport -->
```

扩展包不依赖 `app.js`；但**默认握手**会优先复用 `app.js` 注入的 `window.__wsSession`（含 ECDH 密钥），因此推荐上述顺序。

---

## 4. 快速开始（浏览器）

```html
<script src="oldchat-api-sdk.js"></script>
<script src="oldchat-ws-extension.js"></script>
<script>
  // 1) 确保已登录（核心 SDK 的 apiFetch 会自动带 token；此处 WS 也读同一 token）
  //    localStorage.oc_access_token 必须由宿主在连接前写入。

  // 2) 实例化（默认配置即可，握手/URL/解码都用内置实现）
  const ws = new OCWebSocket({ debug: true });

  // 3) 监听事件
  ws.on('connected',    () => console.log('WS 已连接'));
  ws.on('disconnected', (p) => console.log('WS 断开', p.code, p.reason));
  ws.on('reconnecting', (p) => console.log('重连中', p.attempt, p.delay + 'ms'));
  ws.on('failed',       () => console.log('达到最大重连次数'));

  // 4) 收到推送：业务字段由你解析
  ws.on('message', (payload) => {
    const msg = payload.data;          // 已是解密/解析后的对象
    console.log('收到推送:', msg);
    // 你才知道 msg 里有什么字段，例如：
    // if (msg.type === 'chat') handleChat(msg);
  });

  // 5) 建连
  ws.connect();
</script>
```

> **Tauri 环境**：原生 `WebSocket` 可直连，无需额外配置。若你用自定义 WebSocket 实现，调 `OCWebSocket.setTransport({ create, isSupported })` 注入即可。

---

## 5. 初始化流程（推荐时序）

```
登录成功（宿主写入 localStorage.oc_access_token / oc_refresh_token）
        │
        ▼
app.js 注入 window.__wsSession（ECDH 握手实现，含 encKey/macKey/sessionId）
        │
        ▼
new OCWebSocket()  ──→  默认配置：
        │                  getUrl      = defaultGetUrl（拼 /v1/ws?token&sid）
        │                  handshake   = defaultHandshake（复用 __wsSession.ensure）
        │                  decode      = defaultDecode（信封/明文双模）
        ▼
ws.connect()
        │
        ├─ oc_request_mode === '仅轮询'  → 直接 no-op（不自启）
        │
        └─ 否则 → await handshake() 拿会话 → 构造 URL → new WebSocket(url)
                    │
                    ├─ onopen    → emit 'connected'，启动可选心跳
                    ├─ onmessage → emit 'raw'（原始）+ decode → emit 'message'（对象）
                    ├─ onclose   → 清会话 → 指数退避重连（除非主动 disconnect）
                    └─ onerror   → emit 'error'
```

---

## 6. 配置项（构造参数 `options`）

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `getUrl` | `() => string` | `defaultGetUrl` | 构造 WS URL。默认读 `BACKEND_CANDIDATES[0]` 的 host、`oc_access_token`、`__wsSession.getSessionId()`。 |
| `handshake` | `async () => {sessionId,encKey,macKey}` | `defaultHandshake` | 返回 WS 会话。默认复用 `window.__wsSession`，未注入则自行走 `/v1/auth/handshake`。 |
| `decode` | `async (rawData, session) => {kind,data}` | `defaultDecode` | 解码帧。默认尝试 AES 信封解密，否则当明文 JSON/文本。 |
| `sendPing` | `(ws) => void` | `null`（不发） | **可选**心跳发送函数。提供后启用心跳定时器。 |
| `pingInterval` | `number` | `30000` | 心跳间隔(ms)。 |
| `pingTimeout` | `number` | `10000` | 心跳响应超时(ms)，超时则主动断线触发重连。 |
| `reconnect` | `boolean` | `true` | 是否自动重连。 |
| `maxAttempts` | `number` | `Infinity` | 最大重连次数（`Infinity`=无限，对应「仅WebSocket」模式）。 |
| `baseDelay` | `number` | `1000` | 指数退避基准(ms)。 |
| `maxDelay` | `number` | `30000` | 退避上限(ms)。 |
| `onConnectionLost` | `() => void` | `null` | 达最大重连次数回调（宿主可切轮询）。 |
| `debug` | `boolean` | `false` | 控制台调试日志。 |

---

## 7. 事件表

| 事件 | 参数 | 说明 |
|---|---|---|
| `connected` | `{ url }` | 连接建立成功 |
| `disconnected` | `{ code, reason, wasClean }` | 连接断开 |
| `reconnecting` | `{ attempt, delay }` | 正在重连（delay 为本轮等待毫秒） |
| `reconnected` | — | （同 `connected`，仅在重连成功后随 `connected` 触发） |
| `failed` | `{ attempt }` | 达到最大重试次数 |
| `raw` | `{ data }` | **原始帧**（未解码，字符串/ArrayBuffer/Blob） |
| `message` | `{ kind, data, raw }` | **解码后**推送：`kind` 为 `json`/`text`/`binary`，`data` 为解析结果 |
| `envelope_error` | `{ error, raw }` | 加密信封解密失败（密钥失配等）→ 扩展包会自动重建连接 |
| `statechange` | `{ state }` | 状态机变化 |
| `error` | `{ error }` | WS 错误 / 握手失败 / 解码异常 |

> `kind` 取值：`json`（成功 JSON.parse 或信封解密后对象）、`text`（非 JSON 明文）、`binary`（非字符串原始数据）、`envelope_error`（信封但解密失败）。

---

## 8. 实例 API

| 方法 | 说明 |
|---|---|
| `connect()` | 建立连接（自动握手 + 构造 URL）。`仅轮询` 模式 no-op。 |
| `disconnect()` | 主动断开，**不重连**。 |
| `reconnect()` | 手动重连（重置计数）。 |
| `send(data)` | 发送数据（字符串/对象自动 JSON.stringify）。连接未就绪返回 `false`。 |
| `on(event, fn)` | 注册监听，返回取消函数。 |
| `off(event, fn)` | 移除监听。 |
| `once(event, fn)` | 一次性监听。 |
| `getState()` | 返回 `'idle'\|'connecting'\|'connected'\|'reconnecting'\|'disconnected'\|'failed'`。 |
| `notifyPong()` | 收到服务端心跳应答时调用，取消超时判定（若启用了 `sendPing`）。 |
| `destroy()` | 销毁实例，清理定时器与监听。 |

**静态 API**：
| 方法 | 说明 |
|---|---|
| `OCWebSocket.setTransport({create, isSupported})` | 注入自定义传输器（默认浏览器原生 `WebSocket`）。 |
| `OCWebSocket.getTransport()` | 获取当前传输器。 |
| `OCWebSocket.STATE` | 状态常量对象。 |
| `OCWebSocket.version` | 版本号。 |

---

## 9. 宿主适配示例

### 9.1 浏览器（默认，零配置）
见第 4 节。

### 9.2 Tauri（原生 WebSocket 直连）
```js
// Tauri 原生 WebSocket 可直接用，无需 plugin-websocket
const ws = new OCWebSocket();
ws.on('message', ({ data }) => { /* 你的业务分发 */ });
ws.connect();
```

### 9.3 自定义心跳（若后端将来要求 ping/pong）
```js
const ws = new OCWebSocket({
  sendPing: (sock) => sock.send(JSON.stringify({ type: 'ping', ts: Date.now() })),
  pingInterval: 25000,
  pingTimeout: 8000,
});
ws.on('message', ({ data }) => {
  if (data.type === 'pong') ws.notifyPong();   // 取消超时判定
});
```

### 9.4 Node / 测试桩（require）
```js
const OCWebSocket = require('./oldchat-ws-extension.js');
// 注入 mock 传输器 + 假握手，做离线测试
OCWebSocket.setTransport({ create: (url) => new MockWebSocket(url), isSupported: () => true });
const ws = new OCWebSocket({
  handshake: async () => ({ sessionId: 'test', encKey: null, macKey: null }),
});
```

### 9.5 覆盖 WS URL（自定义鉴权/附加参数）
```js
const ws = new OCWebSocket({
  getUrl: () => {
    const token = localStorage.getItem('oc_access_token');
    return `ws://my-proxy.example.com/relay?token=${token}&v=2`;
  },
});
```

---

## 10. 与核心 SDK 的配置共享

扩展包读取与核心 SDK **完全一致**的 `localStorage` 键，无需重复配置：

| 键 | 用途 |
|---|---|
| `oc_access_token` | WS URL 的 `token` 参数（与 HTTP 请求同源） |
| `oc_request_mode` | `'仅轮询'` 时禁用 WS 自启 |
| `oc_custom_base_url` | 自定义后端候选地址（`defaultGetUrl` 会读取其 `[0]` 的 host） |
| `oc_access_token` / `oc_refresh_token` | 由核心 SDK 登录逻辑写入，WS 复用 |

---

## 11. 已知限制

- **不解析业务字段**：推送里有什么字段，扩展包不知道也不假设，完全由宿主 `message` 回调处理。
- **信封密钥依赖握手**：若 `window.__wsSession` 未注入且核心 SDK 未加载（无 `ocTransport`/`Crypto`），自行握手会失败并触发重连——请确保连接前完成登录与 SDK 加载。
- **心跳非强制**：默认不发心跳；若后端将来引入 ping/pong，通过 `sendPing` 启用（见 9.3）。
