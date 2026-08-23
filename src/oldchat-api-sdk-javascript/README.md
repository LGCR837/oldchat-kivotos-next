# OldChat API SDK JavaScript

**Powered by Aoharu Reverie (LGCR837)**

这是一个使用 JavaScript 实现的 OldChat API SDK

---

## 目录

1. [简介与设计哲学](#1-简介与设计哲学)
2. [环境要求](#2-环境要求)
3. [安装与引入](#3-安装与引入)
4. [初始化流程 (重点) ](#4-初始化流程重点)
5. [配置项参考](#5-配置项参考)
6. [工具函数](#6-工具函数)
7. [响应模型与归一化规则](#7-响应模型与归一化规则)
8. [错误模型](#8-错误模型)
9. [网络与版本机制](#9-网络与版本机制)
10. [完整 API 参考](#10-完整-api-参考)
11. [宿主适配示例](#11-宿主适配示例)
12. [已知限制与暂未支持](#12-已知限制与暂未支持)
13. [许可与作者](#13-许可与作者)

---

## 1. 简介与设计哲学

OldChat API SDK 是一个**纯协议层**客户端，核心设计要点：

- **零构建、零依赖**：经典 `<script>` 标签加载，不引入打包工具、不依赖任何第三方库。
- **自包含单文件**：`oldchat-api-sdk.js` 同时包含「传输层」 (认证 fetch、签名、降级) 与「业务层」 (`OC` SDK) ，可直接分享给他人使用。
- **网络实现可插拔**：SDK **不写任何实际网络请求**，所有 HTTP 调用统一打到全局转接器
  `window.ocTransport(url, init)`。该函数的实现必须**由外部注入**——浏览器用原生 `fetch`、
  Tauri 用 `plugin-http` 直连、Node 用 `http` 模块、测试用桩函数皆可。这一设计使 SDK 可被任意宿主
  环境接管，也便于做离线测试。
- **协议逻辑内聚**：`v1↔v2` 路径映射、`v2` 签名 (`X-Session`/`X-Ts`/`X-Nonce`/`X-Sign`) 、AES 信封加解密、
  候选后端降级、401 会话自愈、按端点熔断等复杂逻辑全部内置，调用方无需关心。

---

## 2. 环境要求

| 能力 | 要求 |
| --- | --- |
| 运行环境 | 浏览器 (含 Web Crypto `crypto.subtle`) 、Tauri WebView、或 Node 22+ (需 polyfill `window`/`localStorage`)  |
| 加密 | Web Crypto API (`crypto.subtle`、`crypto.getRandomValues`) ——现代浏览器与 Node 22 均原生提供 |
| 存储 | `localStorage` (用于登录态与配置；Node 环境需自行 polyfill)  |
| 网络 | 由外部注入的 `window.ocTransport` 决定 (SDK 自身不发起请求)  |

> **注意**：SDK 在加载时会立即读取 `localStorage` (解析后端候选地址) 。纯 Node 环境下若未 polyfill
> `localStorage`，模块顶层初始化会抛错。浏览器与 Tauri 环境天然具备，无需处理。

---

## 3. 安装与引入

### 3.1 直接 `<script>` 引入

将 `oldchat-api-sdk.js` 放到你的站点目录，在业务脚本**之前**加载：

```html
<!-- 1) 先加载 SDK (定义 window.OC / window.apiFetch / window.ocTransport 声明)  -->
<script src="oldchat-api-sdk.js"></script>
<!-- 2) 再加载你的宿主脚本 (负责注入 window.ocTransport 与登录态)  -->
<script src="app.js"></script>
```

加载后，全局可用对象：

| 全局对象 | 类型 | 说明 |
| --- | --- | --- |
| `window.OC` | `object` | 业务方法命名空间，本文档第 10 节全部方法均挂在它下面 |
| `window.apiFetch` | `function` | 传输层核心：带签名/降级/自愈的 `fetch` 包装 (一般不直接调用)  |
| `window.ocTransport` | **需注入** | 网络转接器声明；必须由外部赋值为真实实现 (见 4.1)  |
| `window.__httpSession` | 可选注入 | v2 握手会话对象，启用 v2 签名/加密所需 (见 4.3)  |
| `window.__tauriHttpFetchImpl` | 可选 | Tauri 专用实现，仅 Tauri 宿主需要 (见 11.2)  |

### 3.2 作为 git subtree 引入

本仓库 `oldchat-api-sdk-javascript` 通过 subtree 嵌入主工程，路径为 `src/oldchat-api-sdk-javascript/`：

```html
<script src="oldchat-api-sdk-javascript/oldchat-api-sdk.js"></script>
```

### 3.3 Node / CommonJS

源码末尾已支持 `module.exports = { OC, OCError }`，可在 Node 中以 CommonJS 引入
 (需提前 polyfill `window`、`localStorage`、`crypto` 全局) ：

```js
// Node 22 自带 webcrypto 全局 crypto；window/localStorage 需手动补齐
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { OC, OCError } = require('./oldchat-api-sdk.js');
```

---

## 4. 初始化流程 (重点) 

SDK 加载后**不会自动工作**——它依赖宿主在发起请求前完成三项准备。顺序如下。

### 4.1 注入网络转接器 `window.ocTransport` (必做) 

所有请求最终都通过 `ocTransport` 发出。若未注入，任意 API 调用都会抛：

```
[oldchat-api-sdk] OC transport 未注入：请在发起请求前设置 window.ocTransport(url, init)
```

三种典型实现：

```js
// 浏览器：原生 fetch (后端有 CORS)
window.ocTransport = (url, init) => fetch(url, init);

// Tauri：优先 plugin-http 直连 (无 CORS) ，否则回退浏览器 fetch
window.ocTransport = async (url, init) => {
  if (typeof window.__tauriHttpFetchImpl === 'function')
    return window.__tauriHttpFetchImpl(url, init);
  return fetch(url, init);
};

// 测试桩：拦截全部请求返回假数据，便于离线单测
window.ocTransport = async (url) =>
  new Response(JSON.stringify({ code: 0, data: { url } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
```

`ocTransport` 的签名与标准 `fetch` 完全一致：

```ts
ocTransport(input: string | Request, init?: RequestInit) => Promise<Response>
```

返回标准 `Response` 对象即可，SDK 内部会负责 JSON 解析、签名、降级等。

### 4.2 建立登录态 (Token) 

SDK **不提供** `login` / `handshake` 方法 (这些由宿主登录流程负责) ，但它约定从 `localStorage`
读取以下键，并在每次请求自动附加 `Authorization` 头：

| localStorage 键 | 说明 |
| --- | --- |
| `oc_access_token` | 访问令牌 (JWT) 。存在时，所有请求自动带 `Authorization: Bearer <token>` |
| `oc_refresh_token` | 刷新令牌。当请求返回 `401` 时，SDK 自动用它对 `/v1/auth/refresh` 换发新 token |
| `oc_user` | 可选。登录成功后存入的当前用户 JSON 字符串 |

**职责划分**：宿主需自行实现登录 (通常是 `POST /v1/auth/login` 拿到 token 后写入上述键) 。
SDK 接管的是「带 token 发请求」与「401 自动刷新」。刷新失败则 SDK 会清除 token 并跳转 `login.html`
 (宿主若没有 `login.html`，应自行覆盖该行为或忽略跳转) 。

```js
// 宿主登录示例 (伪代码) 
async function login(username, password) {
  const res = await window.ocTransport('http://oc.mcl0.dpdns.org/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device_id: crypto.randomUUID() })
  });
  const data = await res.json();
  localStorage.setItem('oc_access_token', data.access_token);
  localStorage.setItem('oc_refresh_token', data.refresh_token || '');
  localStorage.setItem('oc_user', JSON.stringify(data.user || {}));
}
```

### 4.3 注入 v2 会话 `window.__httpSession`

若希望走 `v2` 接口 (带 ECDH 签名与 AES 信封加密) ，宿主必须在发起 v2 请求前完成 ECDH 握手，
并把会话对象挂到 `window.__httpSession`。该对象必须实现以下方法/字段：

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `ensure()` | `() => Promise<void>` | 确保握手完成；首次调用触发 ECDH 协商，后续幂等 |
| `getMacKey()` | `() => Uint8Array(32)` | HMAC-SHA256 密钥，由握手派生 `sha256(secret ‖ "mac")` |
| `getEncKey()` | `() => Uint8Array(32)` | AES-256 密钥，由握手派生 |
| `getSessionId()` | `() => string` | 会话 ID，写入 `X-Session` 头 |
| `clear()` | `() => void` | 清空会话 (401 `invalid_session`/`missing_session` 时由 SDK 自动调用以自愈)  |

若**未注入** `__httpSession`，v2 请求会跳过签名头直接发出——服务端 v2 中间件通常会回
`401 missing session`，SDK 随后熔断该端点回退 `v1`。因此：**要稳定使用 v2，必须提供此对象**。

```js
// 宿主侧 ECDH 握手后注入 (伪代码) 
window.__httpSession = {
  _ready: false, _macKey: null, _encKey: null, _sid: null,
  async ensure() { if (this._ready) return; /* ...ECDH 握手... */ this._ready = true; },
  getMacKey() { return this._macKey; },
  getEncKey() { return this._encKey; },
  getSessionId() { return this._sid; },
  clear() { this._ready = false; this._macKey = this._encKey = this._sid = null; }
};
```

### 4.4 配置后端与媒体域名

默认后端候选 (按优先级) ：

```
http://oc.mcl0.dpdns.org
https://oc.mcl0.dpdns.org
http://60.205.94.101:8080
```

媒体域名候选 (按优先级) ：

```
http://60.205.94.101:8080
http://files.mcl0.dpdns.org
http://oc.mcl0.dpdns.org
https://oc.mcl0.dpdns.org
```

自定义方式：把空格/逗号分隔的 origin 列表写入 `localStorage` 对应键，**然后调用
`refreshEndpoints()`** (见第 6 节) 使新配置生效：

| localStorage 键 | 作用 |
| --- | --- |
| `oc_custom_base_url` | 覆盖后端 API 候选列表 |
| `oc_custom_media_url` | 覆盖媒体域名候选列表 |

```js
localStorage.setItem('oc_custom_base_url', 'http://my-mirror.example.com https://backup.example.com');
refreshEndpoints(); // 重新计算 API_BASE / WS_HOST / 候选数组
```

### 4.5 配置接口版本 / 请求模式

写入 `localStorage` 后下次请求自动生效 (无需重启) ：

| localStorage 键 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `oc_api_version` | `v2优先` \| `v1优先` \| `仅v1` \| `仅v2` | `v2优先` | 决定每个接口尝试 `v1`/`v2` 的顺序与回退策略 |
| `oc_request_mode` | `WebSocket优先` \| `仅WebSocket` \| `仅轮询` | `WebSocket优先` | 影响用户态 UA 标识 (注：SDK 本身不建 WS，由宿主负责；此开关仅改变 UA 字符串)  |

### 4.6 完整初始化示例 (浏览器) 

```html
<script src="oldchat-api-sdk.js"></script>
<script>
  // 1) 注入网络转接器 (必做) 
  window.ocTransport = (url, init) => fetch(url, init);

  // 2) 登录 (宿主实现) ，写 token
  // await login('user', 'pass');

  // 3) 可选：注入 v2 会话 (走 v2 签名必须) 
  // window.__httpSession = { ... };

  // 4) 现在可以调用业务方法
  (async () => {
    try {
      const friends = await OC.getFriends();
      console.log('好友列表：', friends);
    } catch (e) {
      if (e instanceof OC.OCError) console.error('业务错误：', e.message, e.code);
      else console.error('网络/未知错误：', e);
    }
  })();
</script>
```

---

## 5. 配置项参考

所有配置均为 `localStorage` 字符串键，修改后：候选地址类需调用 `refreshEndpoints()`；
版本/请求模式类下次请求自动读取。

| 键 | 类型/取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `oc_access_token` | JWT 字符串 | 空 | 访问令牌，自动附加到请求头 |
| `oc_refresh_token` | JWT 字符串 | 空 | 刷新令牌，401 时自动换发 |
| `oc_user` | JSON 字符串 | 空 | 当前用户缓存 |
| `oldchat_device_id` | UUID 字符串 | 空 | 设备 ID，写入 `X-Device-Id` 头 (灰度绑定)  |
| `oc_api_version` | 见 4.5 | `v2优先` | 接口版本模式 |
| `oc_request_mode` | 见 4.5 | `WebSocket优先` | 请求模式 (仅影响 UA 标识)  |
| `oc_custom_base_url` | 空格/逗号分隔 origin | 空 (用默认)  | 自定义后端候选 |
| `oc_custom_media_url` | 空格/逗号分隔 origin | 空 (用默认)  | 自定义媒体候选 |

---

## 6. 工具函数

以下为**顶层全局函数** (挂在 `window` 上，**不在** `OC` 命名空间内) ：

### `resolveMediaUrl(url)` / `cachedResolveMediaUrl(url)`

把后端返回的相对/特殊媒体路径解析为可加载的绝对 URL。

- 已是绝对 `http(s):`/`data:`/`blob:` URL → 原样返回。
- `channel-private:<file>?sig=...` 频道媒体 scheme → 映射到 `http://oc.mcl0.dpdns.org/channel-media/<file>` (签名串原样保留，**不能换 host、不能剥扩展名**) 。
- 含 `/channel-media/` 的路径 → 强制走 `oc.mcl0.dpdns.org` 主机 (签名依赖原 host) 。
- 以 `/` 开头的相对路径 → 拼接当前媒体域名 `MEDIA_BASE`。

`cachedResolveMediaUrl` 多一层 `Map` 缓存，避免重复字符串操作。UI 层渲染头像/封面时应统一走它。

```js
const avatarSrc = cachedResolveMediaUrl(user.avatar_url);
imgEl.src = avatarSrc;
```

### `refreshEndpoints()`

重新读取 `localStorage` 中的自定义候选，重算 `API_BASE`/`WS_HOST`/`MEDIA_BASE` 与候选数组。
在修改 `oc_custom_base_url` / `oc_custom_media_url` 后调用。

```js
localStorage.setItem('oc_custom_base_url', 'http://new-host.example.com');
refreshEndpoints();
```

---

## 7. 响应模型与归一化规则

SDK 内部通过 `_parse(res)` 统一处理响应，规则如下：

1. 尝试 `res.json()`；若响应体非 JSON，抛 `OCError('响应不是合法 JSON…', 'BAD_JSON')`。
2. 若 JSON 含顶层 `error` 字段，抛 `OCError` (message 取自 `error.message`/`error.msg`/`error` 字符串，`code` 取自 `error.code`) 。
3. 业务数据取 `j.data`；若响应无 `data` 字段，则退回顶层 `j` (兼容旧接口) 。

**归一化 vs 原始返回**：为不丢失字段，SDK 对「列表类」做了轻量归一化，对「消息/动态/红包」等
保持后端原始宽结构。各方法返回形态见第 10 节标注。

| 归一化方法 | 输出结构 |
| --- | --- |
| `getFriends` | `Friend[]`，字段 `uid/ncuid/displayUid/name/username/display_name/avatar/remark_name/user_title/role` |
| `getGroups` | `Group[]`，字段 `id/name/avatar/member_count/role` |
| `getGroupMembers` | `Friend[]` |
| `getFriendRequests` | 原始 `request` 对象数组，额外聚合 `uid = from_ncuid \|\| from_uid` |

其余方法 (消息、动态、红包、公审庭、签到墙、表情、媒体、群管理、收藏、音乐、通知、刮刮乐等) 
**返回后端原始结构**，由调用方按需取字段——文档中相应条目标注「返回原始结构」。

---

## 8. 错误模型

所有业务错误通过 `OC.OCError` 抛出：

```js
class OCError extends Error {
  message;  // 可读错误信息 (来自服务端 error.message / error.msg / 字符串) 
  code;     // 服务端错误码 (可能为 null) 
  raw;      // 原始 error 对象 (便于排查) 
}
```

示例：

```js
try {
  await OC.doCheckin();
} catch (e) {
  if (e instanceof OC.OCError) {
    console.error('错误码：', e.code, '信息：', e.message);
  } else {
    console.error('非业务错误 (网络/解析) ：', e);
  }
}
```

---

## 9. 网络与版本机制

理解以下机制有助于排查问题 (无需调用方干预，SDK 自动处理) ：

- **`v1↔v2` 映射**：内置 `V1_TO_V2` 映射表 (60+ 条) 。`mapToV2()` 把 `/v1/xxx` 精确替换为 `/v2/xxx`。
  默认 `v2优先` 模式先试 v2，失败自动回退 v1。
- **候选地址降级**：`/v1` `/v2` 开头的请求按 `BACKEND_CANDIDATES` 顺序尝试；网络错误 / `5xx` 自动切下一候选。
  绝对地址 (媒体直链) 不走降级。
- **401 会话自愈**：v2 端点返回 `401` 且响应体含 `invalid_session`/`missing_session` 时，SDK 会
  `clear()` HTTP 会话 → 重新握手 → 用新会话重试一次 (仅动 `__httpSession`，不影响 `__wsSession`) 。
- **v2 熔断**：某 v2 端点持续 `401` (服务端未迁 v2 / 签名问题) ，SDK 会将该端点加入 `v2FailedPaths` 集合，
  本次及后续回退 v1，**仅影响该端点**，避免「主界面 401 → 跳登录 → 又 401」死循环。
- **GET 去重**：相同 GET (含 token 维度) 在并发期复用同一底层响应 (克隆给各调用方) ，减少初始化冗余请求。
- **签名豁免**：`/v2/{files,resources}/{upload,download}` 大文件端点不加密、不签名，仅 Bearer JWT (文档 §4.5) 。

---

## 10. 完整 API 参考

> 约定：`ncuid` 为 New-Ch uid (字符串，通常以 `NC` 开头) ；`uid` 为旧 uid。
> 方法均返回 `Promise`。标注「返回原始结构」的，请直接读取后端字段。

### 10.1 通讯录

#### `OC.getFriends()`
获取好友列表。
- 参数：无
- 返回：`Friend[]` (已归一化，见第 7 节) 
- 示例：
```js
const friends = await OC.getFriends();
friends.forEach(f => console.log(f.display_name, f.avatar));
```

#### `OC.getFriendRequests()`
获取收到的好友请求。
- 参数：无
- 返回：原始 `request` 对象数组，每项额外带 `uid = from_ncuid || from_uid`
- 示例：
```js
const reqs = await OC.getFriendRequests();
```

#### `OC.addFriend(uidOrNcuid)`
发送好友请求。自动判断：以 `NC` 开头走 `to_ncuid`，否则走 `to_uid`。
- 参数：`uidOrNcuid` (`string`)
- 返回：原始响应 (`_parse` 后) 
- 示例：
```js
await OC.addFriend('NC1234567890');
await OC.addFriend('10001');
```

#### `OC.respondFriend(requestId, accept)`
响应好友请求。
- 参数：`requestId` (`string|number`)、`accept` (`boolean`)
- 返回：原始响应
- 示例：
```js
await OC.respondFriend(reqId, true);  // 同意
```

#### `OC.getGroups()`
获取群列表。
- 参数：无
- 返回：`Group[]` (已归一化) 
- 示例：
```js
const groups = await OC.getGroups();
```

#### `OC.getGroupMembers(groupId)`
获取群成员。
- 参数：`groupId` (`string|number`)
- 返回：`Friend[]` (已归一化) 
- 示例：
```js
const members = await OC.getGroupMembers(groupId);
```

### 10.2 未读

#### `OC.getUnreadDirect(limit = 200)`
获取私聊未读消息列表。
- 参数：`limit` (`number`，默认 200)
- 返回：原始 `messages` 数组 (含 `from_ncuid`/`from_uid`/`created_at` 等) 
- 示例：
```js
const unread = await OC.getUnreadDirect(100);
```

#### `OC.getUnreadGroups(limit = 200)`
获取群未读消息列表。
- 参数：`limit` (`number`，默认 200)
- 返回：原始 `messages` 数组 (含 `group_id`/`from_ncuid`/`created_at` 等) 
- 示例：
```js
const gUnread = await OC.getUnreadGroups();
```

### 10.3 消息历史 / 发送 / 已读 / 撤回

> 消息对象始终为**后端原始宽结构** (`id`/`from_uid`/`from_ncuid`/`body`/`msg_type`/`media_url`/`created_at`/`group_id` 等) ，SDK 不归一化，调用方自行 `reverse`/去重/渲染。

#### `OC.getDirectMessages(ncuid, { limit = 30, offset = 0 })`
获取私聊消息历史。
- 参数：`ncuid` (`string`)、`options.limit` (`number`)、`options.offset` (`number`)
- 返回：原始 `messages` 数组
- 示例：
```js
const msgs = await OC.getDirectMessages('NC123', { limit: 50, offset: 0 });
```

#### `OC.getGroupMessages(groupId, { limit = 30, offset = 0 })`
获取群消息历史。
- 参数：`groupId` (`string|number`)、`options.limit`、`options.offset`
- 返回：原始 `messages` 数组
- 示例：
```js
const msgs = await OC.getGroupMessages(gid, { limit: 50 });
```

#### `OC.searchDirectMessages(uid, keyword)`
搜索私聊消息。
- 参数：`uid` (`string`)、`keyword` (`string`)
- 返回：原始 `messages` 数组
- 示例：
```js
const r = await OC.searchDirectMessages(uid, '晚安');
```

#### `OC.searchGroupMessages(groupId, keyword)`
搜索群消息。
- 参数：`groupId` (`string|number`)、`keyword` (`string`)
- 返回：原始 `messages` 数组

#### `OC.sendDirect(payload)`
发送私聊消息。**payload 由调用方构建完整字段后透传**。
- 参数：`payload` (`object`)，常见字段 `to_ncuid`/`to_uid`/`body`/`msg_type`/`media_url` 等
- 返回：`_parse` 后的 data (含 `message` 或 `data`) 
- 示例：
```js
await OC.sendDirect({ to_ncuid: 'NC123', body: '你好', msg_type: 1 });
```

#### `OC.sendGroup(payload)`
发送群消息。
- 参数：`payload` (`object`)，常见字段 `group_id`/`body`/`msg_type`/`media_url`
- 返回：`_parse` 后的 data
- 示例：
```js
await OC.sendGroup({ group_id: gid, body: '大家好', msg_type: 1 });
```

#### `OC.markDirectRead(id)`
标记私聊已读。**同时双写 `with_uid` 与 `with_ncuid`** (后端独立校验) 。
- 参数：`id` (`string|number`)，对方 uid 或 ncuid
- 返回：原始响应
- 示例：
```js
await OC.markDirectRead('NC123');
```

#### `OC.markGroupRead(groupId)`
标记群已读。
- 参数：`groupId` (`string|number`)
- 返回：原始响应

#### `OC.recallDirectMessage(msgId)`
撤回私聊消息 (`DELETE`) 。
- 参数：`msgId` (`string|number`)
- 返回：`_parse` 后 data
- 示例：
```js
await OC.recallDirectMessage(msgId);
```

#### `OC.recallGroupMessage(msgId)`
撤回群消息 (`DELETE`) 。
- 参数：`msgId` (`string|number`)
- 返回：`_parse` 后 data

### 10.4 动态 Moments

> 返回原始结构，调用方直接取 `moments`/`comments` 等字段。

#### `OC.getUserMoments({ ncuid, uid, limit = 50 })`
获取某用户动态。优先 `ncuid` 路径，失败回退 `uid`。
- 参数：`ncuid?` (`string`)、`uid?` (`string`)、`limit` (`number`)
- 返回：原始对象 (含 `moments`) ，全部失败返回 `null`
- 示例：
```js
const d = await OC.getUserMoments({ ncuid: 'NC123', limit: 20 });
```

#### `OC.getMomentComments(momentId)`
获取动态评论。
- 参数：`momentId` (`string|number`)
- 返回：原始 `comments` 数组

#### `OC.postMoment({ body, imageUrl = '' })`
发布动态。
- 参数：`body` (`string`)、`imageUrl` (`string`，可选) 
- 返回：原始响应

#### `OC.postMomentComment({ momentId, body })`
评论动态。
- 参数：`momentId` (`string|number`)、`body` (`string`)
- 返回：原始响应

### 10.5 红包 Redpackets

> 返回原始结构，调用方取 `cover_url`/`title`/`packet_id` 等。

#### `OC.getRedpacket(packetId)`
查看红包详情。
- 参数：`packetId` (`string|number`)
- 返回：原始结构

#### `OC.claimRedpacket(packetId)`
领取红包。
- 参数：`packetId` (`string|number`)
- 返回：原始响应

#### `OC.sendRedpacket(payload)`
发送红包。**payload 由调用方构建后透传** (含 `to_uid`/`to_ncuid`/`title`/`count`/`amount` 等) 。
- 参数：`payload` (`object`)
- 返回：原始响应

### 10.6 签到墙 Checkin Wall

#### `OC.getCheckinWall(limit = 50)`
获取签到墙列表。**特殊容错**：`404` 视为「功能建设中」，返回 `{ notFound: true }`；非 JSON 体容错不抛错。
- 参数：`limit` (`number`)
- 返回：`{ notFound: boolean, data: object }`
- 示例：
```js
const wall = await OC.getCheckinWall();
if (wall.notFound) showBuilding();
else render(wall.data);
```

#### `OC.doCheckin()`
执行今日签到。
- 参数：无
- 返回：原始响应

#### `OC.postCheckinWall(contentText)`
发布签到墙帖子。
- 参数：`contentText` (`string`)
- 返回：原始响应

#### `OC.getCheckinWallComments(postId)`
获取签到墙帖子评论。
- 参数：`postId` (`string|number`)
- 返回：原始 `comments` 数组

#### `OC.postCheckinWallComment({ postId, body })`
评论签到墙帖子。
- 参数：`postId`、`body` (`string`)

#### `OC.likeCheckinWall(postId)`
点赞签到墙帖子。
- 参数：`postId`

#### `OC.unlikeCheckinWall(postId)`
取消点赞。
- 参数：`postId`

### 10.7 公审庭 Public Court

> 响应多层兼容，SDK 仅做 GET/POST 透传 + 兜 error，返回原始 JSON，调用方自行解析。

#### `OC.getCourtCases(status = 'all')`
获取公审庭案件列表。
- 参数：`status` (`string`，如 `all`/`pending`/`closed`)
- 返回：原始结构

#### `OC.getCourtCaseDetail(id)`
获取案件详情。
- 参数：`id` (`string|number`)

#### `OC.getCourtCaseVotes(id)`
获取案件投票。
- 参数：`id`

#### `OC.getCourtCaseDiscussions(id)`
获取案件讨论。
- 参数：`id`

#### `OC.voteCourtCase(id, { vote, reason = '', evidence = '' })`
投票。
- 参数：`id`、`vote` (`any`)、`reason` (`string`)、`evidence` (`string`)

#### `OC.postCourtStatement(id, { reason, evidence = '' })`
提交陈述。
- 参数：`id`、`reason`、`evidence`

#### `OC.postCourtDiscussion(id, { body })`
发表讨论。
- 参数：`id`、`body` (`string`)

#### `OC.withdrawCourtCase(id)`
撤回案件。
- 参数：`id`

### 10.8 刮刮乐 Scratch

#### `OC.getMeScratch()`
获取当日刮刮乐状态。**特殊容错**：`404` 或异常返回 `null` (视为功能未上线) 。
- 参数：无
- 返回：`object | null`
- 示例：
```js
const s = await OC.getMeScratch();
if (s === null) hideScratch();
```

#### `OC.postMeScratch()`
执行刮奖。
- 参数：无
- 返回：`{ status: number, data: object }` (`data` 可能嵌套在 `rd.body` 字符串中，已自动解一层) 
- 示例：
```js
const r = await OC.postMeScratch();
```

#### `OC.doScratch()`
`postMeScratch` 的别名 (兼容旧调用点) 。

### 10.9 表情广场 Emoji

> 字段各异 (含 `id`/`name`/`url`/`type`) ，返回原始结构。

#### `OC.getEmojiPlaza({ limit = 50, offset = 0 })`
获取表情广场列表。
- 参数：`limit`、`offset`
- 返回：原始 `emojis` 或 `items` 数组 (二者皆兼容) 

#### `OC.getMyEmojis(limit = 200)`
获取我的收藏表情。
- 参数：`limit`
- 返回：原始 `emojis`/`items` 数组

#### `OC.saveEmoji(payload)`
保存表情。**payload 透传** (如 `{ name, url, type }`) 。
- 参数：`payload` (`object`)

#### `OC.deleteEmoji(id)`
删除表情。
- 参数：`id` (`string|number`)

#### `OC.getEmojiPlazaPage({ limit = 20, offset = 0 })`
分页获取表情 (保留 `has_more` 等元字段) 。
- 参数：`limit`、`offset`
- 返回：原始对象 (调用方自行取 `items`/`has_more`) 

### 10.10 媒体上传 Media

> 均为 `FormData` 上传 (非 JSON) ，SDK 直接 `apiFetch` 发再 `_parse` 兜 error。

#### `OC.uploadMedia(formData)`
通用媒体上传 (头像/图片等) 。
- 参数：`formData` (`FormData`)
- 返回：`_parse` 后 data (通常含媒体 URL) 
- 示例：
```js
const fd = new FormData();
fd.append('file', fileInput.files[0]);
const r = await OC.uploadMedia(fd);
```

#### `OC.uploadChannelMedia(formData)`
频道媒体上传。
- 参数：`formData` (`FormData`)

### 10.11 群管理

> 均为动作类操作，body 透传不归一化。

#### `OC.leaveGroup(groupId)`
退群。
- 参数：`groupId`

#### `OC.kickGroupMember({ groupId, userUid, userNcuid })`
踢人。**`user_uid` 与 `user_ncuid` 必须双写**，后端独立校验，任一缺失报 `uid or ncuid is required`。
- 参数：`groupId`、`userUid`、`userNcuid`

#### `OC.setGroupAdmin({ groupId, userUid, userNcuid, admin })`
设置/取消管理员。**同样需双写 `user_uid`+`user_ncuid`**。
- 参数：`groupId`、`userUid`、`userNcuid`、`admin` (`boolean`)

#### `OC.dissolveGroup(groupId)`
解散群。
- 参数：`groupId`

#### `OC.updateGroupSettings(groupId, settings)`
更新群设置。
- 参数：`groupId`、`settings` (`object`，透传)

#### `OC.renameGroup(groupId, name)`
改群名。
- 参数：`groupId`、`name` (`string`)

#### `OC.updateGroupAvatar({ groupId, avatarUrl })`
更新群头像。**两步收口**：先 `uploadMedia` 拿 URL，再调用本方法写回 `avatar_url`。
- 参数：`groupId`、`avatarUrl` (`string`)

#### `OC.inviteToGroup({ groupId, userUid, userNcuid })`
邀请入群。**需双写 `user_uid`+`user_ncuid`**。
- 参数：`groupId`、`userUid`、`userNcuid`

#### `OC.joinGroup(groupId)`
加入群。
- 参数：`groupId`

### 10.12 我的资料

#### `OC.uploadMyAvatar(formData)`
上传我的头像。
- 参数：`formData` (`FormData`)
- 返回：`_parse` 后 data

#### `OC.getMe()`
获取当前用户信息。
- 参数：无
- 返回：`d.user || d` (归一化到 user 对象) 
- 示例：
```js
const me = await OC.getMe();
```

### 10.13 收藏 Favorites

#### `OC.getFavorites(limit = 100)`
获取收藏列表。
- 参数：`limit` (`number`)
- 返回：`items` 数组 (兼容 `data.items` 嵌套) 

#### `OC.addFavorite(body)`
添加收藏。**body 透传** (如 `type`/`target_id`/`title`/`subtitle`/`media_url`/`extra`) 。
- 参数：`body` (`object`)

#### `OC.removeFavorite(id)`
移除收藏。
- 参数：`id` (`string|number`)

### 10.14 音乐广场 Music Plaza

#### `OC.uploadMusicPlaza(formData)`
上传音乐广场作品 (`FormData`) 。
- 参数：`formData` (`FormData`)
- 返回：`_parse` 后 data

#### `OC.getMusicPlazaDetail(itemId)`
获取音乐广场作品详情。
- 参数：`itemId` (`string|number`)
- 返回：`item || data || d` (兼容多层嵌套) 

### 10.15 用户资料

#### `OC.getUserProfile({ ncuid, uid })`
获取用户资料。三路径回退：`ncuid` → `uid` →  (无 ncuid 时把 uid 当 ncuid 再查一次) 。
- 参数：`ncuid?`、`uid?`
- 返回：原始对象，全部失败返回 `null`
- 示例：
```js
const p = await OC.getUserProfile({ ncuid: 'NC123' });
```

#### `OC.updateMyProfile(patch)`
更新我的资料。
- 参数：`patch` (`object`，透传，如 `display_name`/`user_title`/`bio`) 

#### `OC.updateMyUid(uid)`
更新我的 uid。
- 参数：`uid` (`string`)

### 10.16 通知 Notifications

#### `OC.getNotifications(limit = 50)`
获取通知列表。**特殊容错**：`404` 视为「建设中」，返回 `{ notFound: true }`；非 JSON 体容错。
- 参数：`limit` (`number`)
- 返回：`{ notFound: boolean, data: object }`
- 示例：
```js
const n = await OC.getNotifications(20);
if (!n.notFound) renderNotices(n.data);
```

---

## 11. 宿主适配示例

### 11.1 纯浏览器 (原生 fetch) 

```js
window.ocTransport = (url, init) => fetch(url, init);
// 之后正常调用 OC.*；注意后端需放开 CORS。
```

### 11.2 Tauri plugin-http

```js
// 先定义 Tauri 实现
window.__tauriHttpFetchImpl = async (input, init) => { /* ...plugin:http|fetch... */ };
// 再注入转接器：Tauri 优先，否则原生 fetch
window.ocTransport = async (url, init) => {
  if (typeof window.__tauriHttpFetchImpl === 'function')
    return window.__tauriHttpFetchImpl(url, init);
  return fetch(url, init);
};
```

### 11.3 Node (需 polyfill) 

```js
global.window = global;
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
// 注入转接器 (Node 22 自带 fetch / webcrypto) 
window.ocTransport = (url, init) => fetch(url, init);
const { OC, OCError } = require('./oldchat-api-sdk.js');
```

### 11.4 测试桩 (离线单测) 

```js
window.ocTransport = async (url) =>
  new Response(JSON.stringify({ code: 0, data: { url, mock: true } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
// 此后 OC.getFriends() 等都会拿到桩数据，无需真实后端。
```

---

## 12. 已知限制与暂未支持

- **资源广场 `resources` 模块未下沉**：服务端尚未迁移 v2，且近期因特殊原因临时关闭。对应方法
   (分区列表、资源评论等) 未接入 `OC`，暂由宿主以裸 `apiFetch` 调用，待服务端恢复/迁移后补。
- **登录 / 握手未下沉**：`login` / `handshake` 由宿主负责 (见 4.2 / 4.3) 。SDK 仅消费其产物
   (token 与 `__httpSession`) 。
- **WebSocket 不在 SDK 内**：实时消息推送由宿主建立 WS (仍走 v1) ，SDK 负责 HTTP 侧协议。
- **消息历史列表暂走 v1**：`/v2/{direct,groups}/messages/v2` 服务端回 `bad_signature`，已临时移出
  v2 映射强制走 v1，待 v2 签名专项排查后恢复。
- **Node 环境需 polyfill**：`window` / `localStorage` 非 Node 原生，纯 Node 使用必须补齐 (见 11.3) 。

---

## 13. 许可与作者

- **作者**：LGCR837 (Aoharu Reverie) 
- **许可**：MIT License

> 本文档随 `oldchat-api-sdk-javascript` 仓库维护。SDK 为单文件 `oldchat-api-sdk.js`，
> 引入即用的设计目标是不要求调用方理解内部签名/降级细节——只需注入 `ocTransport` 并提供登录态。

---

## 14. 官方扩展包：WebSocket 实时推送

核心 SDK 只负责 HTTP 侧协议，**实时消息推送**由独立扩展包 `oldchat-ws-extension.js` 提供。

- 文件：`oldchat-ws-extension.js`（全局 `window.OCWebSocket`）
- 职责：**纯长连接管道**——建连 / 断线指数退避重连 / 信封解密还原 / 事件分发；绝不解析业务字段。
- 据实修正了通用 AI 方案的协议错误：`/v1/ws`（非 `/gateway`）、`ws:`/`wss:` 自适应、`token`+`sid` 双参、`oc_request_mode` 真实三档取值、心跳可选、Tauri 原生直连。
- 详细用法、配置项、事件表、宿主适配示例见 **[WS_EXTENSION.md](./WS_EXTENSION.md)**。
