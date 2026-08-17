# OldChat 服务端 API 完整文档

> 目标：依据本文档可以完整复刻 OldChat 的绝大部分客户端功能。
> 覆盖 **/v2 全部接口** + **/v1 独有接口（无 /v2 对应）**；/v2 已有对应实现的 /v1 旧接口（如 `/v1/direct/send` 与 `/v2/direct/send` 同 handler）不做重复解释。
> 基线版本：2026-08-09（正式版 1.4.1）

---

## 目录

1. [基础约定](#1-基础约定)
2. [安全与鉴权体系](#2-安全与鉴权体系)
3. [账号（注册/登录/令牌）](#3-账号)
4. [加密会话与 v2 网关](#4-加密会话与-v2-网关)
5. [实时通道：WebSocket](#5-实时通道websocket)
6. [事件系统（pts / difference / WS 帧）](#6-事件系统)
7. [私聊](#7-私聊)
8. [群聊](#8-群聊)
9. [好友](#9-好友)
10. [用户中心](#10-用户中心)
11. [文件上传与下载](#11-文件上传与下载)
12. [动态下载源（多线路）](#12-动态下载源)
13. [朋友圈](#13-朋友圈)
14. [频道](#14-频道)
15. [红包](#15-红包)
16. [签到 / 在线状态 / 设备](#16-签到在线状态设备)
17. [举报与公开法庭](#17-举报与公开法庭)
18. [资源广场（filewearhouse）](#18-资源广场)
19. [音乐广场](#19-音乐广场)
20. [表情广场](#20-表情广场)
21. [AI 助手](#21-ai-助手)
22. [通知 / 反馈 / 崩溃上报](#22-通知反馈崩溃上报)
23. [外部接口（publisher / bot / 数据服）](#23-外部接口)
24. [错误码与限流](#24-错误码与限流)
25. [附录：复刻所需最小流程](#25-附录复刻所需最小流程)

---

## 1. 基础约定

### 1.1 服务端

- 生产地址：`https://oc.mcl0.dpdns.org`（HTTP 直连源站 8080）
- 文件下载域：`https://files.mcl0.dpdns.org`
- 对象存储（雨云）源：`https://cn-sy1.rains3.com/oldchat`（由 `/v1/download/sources` 动态下发，可换）
- 官方 APK 签名哈希（登录自证用）：`a7dfd266933332df7de27770bfba0432a1bfeb81213579806fc2263382fed2c1`

### 1.2 请求

- 绝大多数接口 `Content-Type: application/json`，响应也是 JSON。
- 文件上传用 `multipart/form-data`。
- 所有需要登录的接口都要求 `Authorization: Bearer <access_token>`（v2 加密会话下放在 `X-Auth` 密文中）。
- 统一错误格式：

```json
{ "error": "error_code", "code": "error_code", "message": "人类可读说明" }
```

HTTP 状态码：401 未登录、403 无权限、404 不存在、413 请求体过大、429 限流。

### 1.3 主要实体 ID 格式

| 实体 | 格式示例 |
|---|---|
| 用户 UID | `USR-8位` |
| 内部用户 ID | `users.id`（nanoid，消息里不出现） |
| 群 ID | `GRP-8位` |
| 消息 ID | nanoid（`from_uid` 为发送方 UID） |
| 会话线程 ID（私聊） | 双方 UID 排序后哈希/组合 |
| 频道 ID | `CHN-8位` |
| 文件资产 ID | nanoid（`/v2/files/download/{id}`） |

### 1.4 时间

- 所有时间戳为 **Unix 秒**（`created_at`、`date` 等）。
- 分页游标：`created_at` + `id`（`next_before_created_at` / `next_before_id`）。

---

## 2. 安全与鉴权体系

### 2.1 三层防护链（/v1、/v2 路由组统一）

```
secureMiddleware → authMiddleware → （/v2 额外）v2SignMiddleware
```

1. **secureMiddleware**：若请求带 `X-Enc: 1`，解密 body（AES-256-CBC + HMAC-SHA256，会话密钥）；解密 `X-Auth`（加密的 access token）后注入 `Authorization`。大文件 multipart（`isStreamingFileRequest`）豁免整包加密，直接透传。
2. **authMiddleware**：解析 `Authorization: Bearer <token>` → 校验 JWT 签名、`iss`、`exp`、`token_version`（需等于 users 表当前版本）→ 注入 claims 到 context。
3. **v2SignMiddleware**（仅 /v2）：强制 `X-Session` 有效；`X-Sign` HMAC 签名（见 4.4）；`X-Device-Id` 设备绑定（灰度）。

### 2.2 Token 版本机制

- 每次登录 `users.token_version + 1`；access token 内嵌 `ver`。
- 服务端校验 `claims.ver == users.token_version`，不等则 401（旧 token 全部失效）。
- 改密/重置密码会把 token_version +3，强制全部设备下线。

### 2.3 加密会话（ECDH，Android 2.3 兼容）

见 [第 4 章](#4-加密会话与-v2-网关)。

---

## 3. 账号

### 3.1 `POST /v1/auth/email/send` — 发送邮箱验证码

**公开接口**。人机验证（GeeTest 4.0 或 Cloudflare Turnstile）通过后发送。

```json
{
  "email": "user@qq.com",
  "purpose": "register",              // register | reset
  "geetest_lot_number": "...",
  "geetest_captcha_output": "...",
  "geetest_pass_token": "...",
  "geetest_gen_time": "1720000000",
  "turnstile_token": "..."            // 无 geetest 时用 turnstile
}
```

限制：每邮箱 120s 冷却；验证码 10 分钟有效、一次性。

### 3.2 `POST /v1/auth/web/register` — 注册（推荐）

**公开接口**。邮箱仅支持 `qq.com / 126.com / 163.com`。

```json
{
  "email": "user@qq.com",
  "username": "my_name",              // 3-20 位小写字母/数字/下划线
  "password": "at_least_8_chars",
  "email_code": "123456",
  "device_id": "...",                 // 可选，用于设备管理/封禁
  "device_name": "Xiaomi 14",
  "platform": "android",
  "app_version": "1.4.1"
}
```

响应：

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "user": {
    "id": "...", "uid": "USR-XXXXXXXX", "ncuid": "...",
    "username": "my_name", "display_name": "my_name",
    "user_title": "", "avatar_url": "", "signature": "", "cover_url": "",
    "coin_balance": 0, "reputation_score": 100
  }
}
```

注册成功自动加入默认官方群 `defaultRegistrationGroupID`。新用户旧币余额 0（2026-08 起）。

### 3.3 `POST /v1/auth/register` — 旧版注册

同 `web/register` 字段，未强制邮箱域白名单（仍校验验证码）。兼容旧客户端，新客户端请用 web/register。

### 3.4 `POST /v1/auth/login` — 登录

**公开接口**。

```json
{
  "identifier": "user@qq.com",        // 或 username / email
  "username": "...", "email": "...",  // 兼容字段
  "password": "...",
  "device_id": "...",
  "imei": "...",
  "device_name": "Xiaomi 14",
  "platform": "android",
  "app_version": "1.4.1",
  "apk_signature": "a7dfd266..."      // 官方 APK 签名哈希；为空放行（灰度）
}
```

响应：同 3.2（`access_token` / `refresh_token` / `user`）。

限制：IP 限流 + 账号限流；设备被封返回 403 `device_banned`；官方 APK 签名不匹配返回 403 `unauthorized_client`。登录只保留最近 10 个 refresh token（不踢其他设备）。

### 3.5 `POST /v1/auth/refresh` — 刷新令牌

```json
{ "refresh_token": "..." }
```

响应：`{ "access_token": "...", "refresh_token": "..." }`（refresh 轮换）。

### 3.6 `POST /v1/auth/logout` — 登出

Bearer 鉴权。撤销当前 refresh token。

### 3.7 `POST /v1/auth/password/reset` — 重置密码

```json
{ "username": "...", "email": "...", "email_code": "123456", "new_password": "..." }
```

重置后 token_version +3，全设备下线。响应：`{ "status": "ok" }`。

### 3.8 `POST /v1/auth/direct-create` — 测试用户直建（管理员）

`/v1/auth/direct-create` 直接创建用户（无需验证码），返回 `{user, access_token, refresh_token}`。可指定 `uid`、`coin_balance`、`reputation_score`。仅测试/管理员链路使用。

### 3.9 `GET /v1/me` — 当前用户信息

Bearer 鉴权。返回 `selfUserResponse`：`{id, uid, ncuid, username, display_name, user_title, avatar_url, signature, cover_url, coin_balance, reputation_score}`。

---

## 4. 加密会话与 v2 网关

### 4.1 `POST /v1/auth/handshake` — ECDH 会话建立

**公开接口**。客户端生成 P-256 密钥对，发送公钥（X.509 PKIX DER + Base64 标准编码）：

```json
{ "client_pub": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..." }
```

服务端生成 P-256 密钥对，用 ECDH 计算共享密钥，派生会话密钥并创建内存会话：

```json
{
  "session_id": "nav_xxxx...",
  "server_pub": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."
}
```

密钥派生（服务端 `secure.DeriveSessionKeys`）：

```
encKey = SHA256(sharedSecret || "enc")
macKey = SHA256(sharedSecret || "mac")
```

> ⚠️ 会话只存服务端内存，**服务端重启后全部失效**。客户端收到 400/401 invalid_session 时必须清除本地会话重新握手（v2test93+ 已实现）。

### 4.2 加密信封格式（`X-Enc: 1` 时 body/X-Auth 使用）

```json
{ "iv": "base64", "data": "base64", "mac": "base64" }
```

- AES-256-CBC + PKCS7；`mac = HMAC-SHA256(macKey, iv || ciphertext)`，恒定时间比较。
- 响应同样加密（若请求带 `X-Enc: 1`）；`X-Enc-Compression: gzip` 时对 ≥512B 响应先 gzip 再加密。

### 4.3 `POST /v2/gateway` — v2 统一网关

**/v2 所有请求都可折叠到这一个入口**。加密 body 明文为：

```json
{
  "m": "POST",                    // 真实方法 GET/POST/PUT/DELETE
  "p": "/v2/groups/messages/v2",  // 真实路径（必须以 /v2/ 开头）
  "q": "group_id=GRP-XXXX&limit=20",
  "b": { "group_id": "GRP-XXXX", "body": "hi" }  // POST 业务参数
}
```

响应固定 HTTP 200，内部状态码包在 body：

```json
{ "code": 200, "body": { "messages": [...] } }
```

客户端只认 HTTP 200 + `code`。抓包看不到任何真实 API 语义。

### 4.4 v2 签名（`X-Sign`）

请求头：

```
X-Session: <session_id>
X-Ts: <unix 秒>
X-Nonce: <随机串 ≤128 字符>
X-Sign: <base64url(HMAC-SHA256(macKey, signingString))>
X-Device-Id: <设备 ID>（可选，绑定校验）
```

```
signingString = METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE
```

- 时间窗 ±300s；同一会话同一 nonce 300s 内防重放（服务端内存表）。
- `V2RequireSignature=false`（当前灰度）：有签名必校验，无签名放行（兼容旧客户端）。
- 大文件 multipart（上传/下载）豁免签名。

### 4.5 v2 大文件豁免路径

`/v2/files/upload`、`/v2/resources/upload`、`/v2/files/download/{id}`、`/v2/resources/download/{id}`：不加密、不签名，仅 Bearer JWT 鉴权。

---

## 5. 实时通道：WebSocket

### 5.1 `GET /v1/ws` — WebSocket 连接

**公开接口**（自认证）：

```
GET /v1/ws?token=<access_token>&sid=<session_id>
```

或 `Authorization: Bearer <token>` 头 + `?sid=...`。`sid` 必须为有效加密会话。

升级后建立 WS 连接；**所有下行事件用会话密钥加密后发送**（`client.Start()` 内做加密）。帧格式为 JSON 文本，结构见 [第 6 章](#6-事件系统)。

客户端可发送 `{"type":"channel_subscriptions_refresh"}` 刷新频道订阅（用于频道事件推送）。

### 5.2 连接注意事项（Android 2.3 已修复）

- 会话失效（服务端重启）→ 收到 400/401 → 清本地 session → 重新 handshake → 重连。
- 裸 Socket 需 IPv6 回退 IPv4；SecureRandom 复用单例防阻塞。

---

## 6. 事件系统

### 6.1 事件信封（WS 下行 & /updates/difference 通用）

```json
{
  "pts": 1234,
  "pts_count": 1,
  "type": "DIRECT_MESSAGE_NEW",
  "date": 1720000000,
  "payload": { "...": "..." }
}
```

`pts` 为单调递增的账号级事件游标，断线补差靠它。

### 6.2 `GET /v2/updates/difference?pts=N&limit=200` — 增量补差

Bearer + 会话。返回：

```json
{
  "events": [ { "pts":1, "pts_count":1, "type":"...", "date":1720000000, "payload":{} } ],
  "has_more": false,
  "next_pts": 200,
  "reset": false,
  "current_pts": 200
}
```

**reset 判定**（客户端收到 `reset:true` 应全量重建本地状态）：
1. `current_pts - request_pts > 10000`（差距过大）
2. 请求位置之后事件已被归档清理
3. `request_pts > current_pts`（本地异常）

### 6.3 事件类型（payload 均为消息对象，同对应发送响应）

| type | 触发 |
|---|---|
| `DIRECT_MESSAGE_NEW` | 收到新私聊消息 |
| `DIRECT_READ` | 对方已读私聊（payload 含 thread_id/read_at） |
| `DIRECT_MESSAGE_RECALL` | 私聊消息撤回 |
| `GROUP_MESSAGE_NEW` | 群新消息（群事件通道见 6.4） |
| `GROUP_MESSAGE_RECALL` | 群消息撤回（群事件） |
| `GROUP_READ` | 群已读 |
| `FRIEND_*` | 好友请求/响应/删除 |
| `RED_PACKET_*` | 红包事件 |
| `MOMENT_*` | 朋友圈事件 |
| `CHANNEL_*` | 频道事件（需订阅） |
| `NOTIFICATION_*` | 系统通知 |

### 6.4 `GET /v2/groups/events/after?group_id=GRP-XXX&seq=N` — 群事件补差

群内消息序号 `group_seq`（单调）。返回合并后的群事件列表（`MESSAGE_NEW`/`GROUP_MESSAGE_RECALL`/`GROUP_READ` 等），每项 `{group_seq, event_type, payload}`。

### 6.5 `GET /v2/groups/messages/after?group_id=GRP-XXX&seq=N&limit=100` — 群消息按序号拉取

返回 `{messages:[...], server_group_seq}`。

---

## 7. 私聊

### 7.1 `POST /v2/direct/send` — 发私聊消息

```json
{
  "to_uid": "USR-XXXXXXXX",
  "to_ncuid": "USR-XXXXXXXX",          // 可选
  "body": "文本内容",
  "msg_type": "text",                  // text|image|voice|video|resource
  "media_url": "/v1/uploads/media/xxx.jpg",
  "thumb_url": "/v1/uploads/media/xxx_thumb.jpg",
  "original_url": "https://files.mcl0.dpdns.org/v2/files/download/xxx",
  "duration_ms": 12000,                // voice 必填，≤60000
  "burn_after_seconds": 0              // 阅后即焚，0=关闭
}
```

规则：
- `text`：body 必填；`image/voice/video/resource`：media_url 必填（≤1024），body 空时自动占位。
- `resource` 类型的 media_url 若为资源广场 URL（`/uploads/filewearhouse/` 或 `/uploads/resources/`）→ 403 `resource_share_disabled`。
- 向**不是好友且未开放私聊**的用户发送 → 403。

响应 `directMessageResponse`：

```json
{
  "sort_seq": 100, "id": "msg-id", "thread_id": "...",
  "from_uid": "USR-XXX", "body": "...", "msg_type": "text",
  "created_at": 1720000000
}
```

服务端同时向对端推送 `DIRECT_MESSAGE_NEW`（WS）。

### 7.2 `POST /v2/direct/read` — 私聊已读

```json
{ "with_uid": "USR-XXX", "with_ncuid": "USR-XXX" }
```

### 7.3 `GET /v2/direct/messages/v2?with_uid=USR-XXX&with_ncuid=&limit=30&offset=0&before_created_at=&before_id=&anchor_message_id=` — 拉历史消息

返回：

```json
{
  "messages": [ { "id":"...", "thread_id":"...", "from_uid":"...", "body":"...", "msg_type":"text", "created_at":1720000000 } ],
  "has_more": true,
  "next_before_created_at": 1719990000,
  "next_before_id": "msg-id"
}
```

### 7.4 `POST /v2/unread/direct` — 未读私聊列表

```json
{ "limit": 50, "offset": 0 }
```

返回 `{ "messages": [ unread 消息（含 peer_uid/peer_ncuid） ], "has_more": false }`。
无加密会话的老客户端可直接明文 POST 到 `/v2/unread/direct`（已豁免签名）。

### 7.5 `POST /v2/direct/burn/open` — 打开阅后即焚消息

```json
{ "message_id": "..." }
```

（服务端记录 burn_start_at 并销毁，双方触发。）

### 7.6 /v1 独有：私聊管理

| 接口 | 说明 |
|---|---|
| `DELETE /v1/direct/messages/{messageID}` | 删除私聊消息 |
| `GET /v1/direct/messages/search?q=&with_uid=&with_ncuid=&kind=&limit=&offset=` | 私聊消息搜索 |
| `GET /v1/direct/messages?with_uid=&before_created_at=&limit=` | 旧版历史拉取（同 7.3） |
| `POST /v1/direct/messages/{messageID}/transcribe` | 语音转文字 |
| `POST /v1/direct/unread` | 旧版未读（同 7.4） |
| `POST /v1/direct/read` | 旧版已读 |
| `POST /v1/direct/burn/open` | 旧版阅后即焚 |
| `GET /v1/chats/{chatId}/typing` | 查询对方输入状态 |

---

## 8. 群聊

### 8.1 `POST /v2/groups/message/send` — 发群消息

```json
{
  "group_id": "GRP-XXXX",
  "body": "文本",
  "msg_type": "text",                  // text|image|voice|video|resource
  "media_url": "...", "thumb_url": "...", "original_url": "...",
  "duration_ms": 0,
  "burn_after_seconds": 0
}
```

校验：群存在、是成员、群全员禁言时需管理员。响应 `groupMessageResponse`（含 `group_seq`、`read_count`）。

### 8.2 `POST /v2/groups/read` — 群已读

```json
{ "group_id": "GRP-XXXX" }
```

### 8.3 `GET /v2/groups/messages/v2?group_id=GRP-XXX&limit=30&offset=0&before_created_at=&before_id=&before_seq=&anchor_message_id=&mark_read=1` — 拉群历史

响应 `groupMessagesResponse`（含 `server_group_seq`、`next_group_seq`）。

### 8.4 `POST /v2/unread/groups` — 群未读

```json
{ "limit": 50, "offset": 0 }
```

### 8.5 `POST /v2/groups/burn/open` — 群阅后即焚

```json
{ "message_id": "..." }
```

### 8.6 `POST /v2/chats/typing` — 正在输入

```json
{ "chat_type": "direct", "peer_uid": "USR-XXX" }        // 或
{ "chat_type": "group", "group_id": "GRP-XXX" }
```

服务端通过 WS 推送 `TYPING` 事件给对方/群成员。

### 8.7 `POST /v2/groups/create` — 建群

```json
{
  "name": "群名",
  "member_uids": ["USR-XXX"],
  "member_ncuids": []
}
```

响应：`{ "group_id": "GRP-XXX", "name": "...", "invitation_count": 0, "auto_rejected_count": 0 }`。

### 8.8 `POST /v2/groups/join` — 加入群

```json
{ "group_id": "GRP-XXX" }
```

需审批的群返回待审批；公开群直接加入。

### 8.9 `GET /v2/groups/list` — 我的群列表

响应 `groups` 数组，每项：`group_id`、`name`、`avatar_url`、`join_approval`、`global_mute`、`announcement`、`announcement_mode`、`announcement_updated_at`、`announcement_read_at`、`member_count`、`member_version`、`message_seq`、`role`（0 成员 / 1 管理员 / 2 群主）。

### 8.10 `GET /v2/groups/members?group_id=GRP-XXX&limit=&offset=` — 群成员

响应：`{ "members": [{uid, ncuid, username, display_name, user_title, avatar_url, role, joined_at}], "total", "offset", "limit", "has_more", "member_version" }`。

### 8.11 `GET /v2/groups/members/lookup?group_id=&query=` — 成员搜索

### 8.12 `GET /v2/groups/requests` — 入群申请列表（管理员）

### 8.13 `POST /v2/groups/approve` — 审批入群

```json
{ "request_id": "...", "accept": true }
```

（请求 ID 来自 `GET /v2/groups/requests` 列表。）

### 8.14 `POST /v2/groups/leave` — 退群

```json
{ "group_id": "GRP-XXX" }
```

### 8.15 `POST /v2/groups/invite` / `GET /v2/groups/invitations` / `POST /v2/groups/invitations/respond`

- 邀请：`{ "group_id":"GRP-XXX", "user_uid":"USR-XXX" }`
- 响应邀请：`{ "invitation_id":"...", "accept":true }`

### 8.16 `POST /v2/groups/admin` — 设置管理员

```json
{ "group_id":"GRP-XXX", "user_uid":"USR-XXX", "user_ncuid":"...", "admin": true }
```

### 8.17 群管理其他

| 接口 | 说明 |
|---|---|
| `POST /v2/groups/avatar` | 设置群头像（JSON）`{group_id, avatar_url}` |
| `POST /v2/groups/kick` | 踢人 `{group_id, user_uid, user_ncuid}` |
| `POST /v2/groups/name` | 改名 `{group_id, name}` |
| `POST /v2/groups/settings` | 设置 `{group_id, join_approval, global_mute}` |
| `POST /v2/groups/announcement` | 发布公告 `{group_id, announcement, announcement_mode}` |
| `POST /v2/groups/announcement/read` | 已读公告 |
| `POST /v2/groups/dissolve` | 解散群（群主） |

### 8.18 /v1 独有：群消息管理

| 接口 | 说明 |
|---|---|
| `DELETE /v1/groups/messages/{messageID}` | 删除群消息 |
| `GET /v1/groups/messages/search?q=&group_id=&kind=&limit=&offset=` | 群消息搜索 |
| `GET /v1/groups/messages?group_id=&before_created_at=` | 旧版拉历史 |
| `POST /v1/groups/messages/{messageID}/transcribe` | 群语音转文字 |
| `POST /v1/groups/unread` | 旧版未读 |
| `POST /v1/groups/read` / `POST /v1/groups/burn/open` | 旧版已读/焚毁 |
| `GET /v1/groups/{groupId}/typing` | 群输入状态 |

---

## 9. 好友

| 接口 | 方法/路径 | 说明 |
|---|---|---|
| `GET /v2/friends` | 我的好友列表 | `{friends:[{id,uid,ncuid,username,display_name,remark_name,user_title,avatar_url,is_online,presence_status,friend_added_at}]}` |
| `GET /v2/friends/requests` | 好友请求列表 | `{requests:[{id,status,from_uid,from_ncuid,from_username,from_display_name,from_title,avatar_url}]}` |
### 9.1 字段（实际）

```json
// POST /v2/friends/request
{ "to_uid": "USR-XXX", "to_ncuid": "USR-XXX" }   // 响应 {request_id}

// GET /v2/friends 列表项
{
  "id": "...", "uid": "USR-XXX", "ncuid": "...",
  "username": "...", "display_name": "...", "remark_name": "...",
  "user_title": "...", "avatar_url": "...",
  "is_online": false, "presence_status": "offline",
  "friend_added_at": 1720000000
}

// POST /v2/friends/delete
{ "friend_uid": "USR-XXX", "friend_ncuid": "..." }

// POST /v2/friends/remark
{ "friend_uid": "USR-XXX", "friend_ncuid": "...", "remark_name": "张三" }
```

/v1 有相同路径的旧版（handler 复用，行为一致），不再重复。

---

## 10. 用户中心

### 10.1 `POST /v2/me/profile` — 更新资料

```json
{ "display_name": "...", "avatar_url": "...", "signature": "...", "cover_url": "..." }
```

（改名/改签名各自有频率/长度限制。）

### 10.2 `POST /v2/me/uid` — 修改 UID

```json
{ "uid": "USR-NEWID" }
```

### 10.3 `POST /v2/me/password` — 改密

```json
{ "old_password": "...", "new_password": "..." }
```

### 10.4 `POST /v2/me/avatar` / `POST /v2/me/cover` — 头像/封面

multipart 字段 `file`（或 `avatar` / `cover`）。响应 `{ "url": "/v1/uploads/avatars/xxx.jpg" }`。

### 10.5 `POST /v2/me/delete/email/send` — 发删除账号验证码

```json
{ "email": "user@qq.com" }
```

响应：`{ "status": "ok", "email_hint": "u***@qq.com" }`。

### 10.6 `POST /v2/me/delete` — 删除账号

```json
{ "password": "...", "email_code": "..." }
```

### 10.7 `GET/POST /v2/me/group-invite-preference` — 群邀请偏好

GET 返回 `{ "reject": false }`；POST `{ "reject": true }`（拒绝接收群邀请）。

### 10.8 `GET /v2/users/profile?uid=USR-XXX` — 查看用户资料

返回 `userResponse`（uid/ncuid/display_name/user_title/avatar/signature/cover）。

### 10.9 /v1 独有：资料与杂项

| 接口 | 说明 |
|---|---|
| `POST /v1/me/avatar` / `POST /v1/me/cover` | 旧版头像/封面（同 10.4） |
| `POST /v1/voice/asr` | 语音识别（multipart `file`，响应 `{text}`） |
| `POST /v1/media` | 媒体上传（图片/视频/语音，见 11.2） |
| `POST /v1/files/upload` | 文件上传 v1（同 v2，500MB） |
| `GET /v1/me/resource-reports` | 我的资源举报记录 |
| `GET /v1/reports/bug` / `user` / `group` | 我提交的各类举报 |
| `POST /v1/report` | 举报提交（见 17 章） |
| `GET /v1/notifications` | 通知列表 `?limit=&before=`（before 为 Unix 毫秒），响应 `{notifications:[{id,title,body,important,created_at}]}` |

---

## 11. 文件上传与下载

### 11.1 文件资产（`file_assets` 表，SHA-256 去重）

上传链路：

```
客户端流式计算 SHA-256
  → POST /v2/files/check {sha256, size_bytes}
      ├─ 命中：{exists:true, file_id, url, sha256} → 直接发送（秒传）
      └─ 未命中：POST /v2/files/upload (multipart)
           → {file_id, name, size_bytes, sha256, url, deduplicated}
```

服务端**始终重新计算 SHA-256**（不信任客户端）；并发重复上传由 `sha256` 唯一索引去重；`X-File-Size` / `X-File-SHA256` 头加速校验。

### 11.2 `POST /v1/media` — 媒体上传（图片/视频/语音）

multipart 字段：

```
file   = 二进制（图片原图不压缩、≤10MB；视频≤200MB 且需开启；语音）
thumb  = 缩略图（图片可选）
X-File-Size / X-File-SHA256
```

响应：

```json
{
  "url": "/v1/uploads/media/xxx.jpg",
  "thumb_url": "/v1/uploads/media/xxx_thumb.jpg",
  "original_url": "https://files.mcl0.dpdns.org/v2/files/download/xxx"
}
```

- 图片原图同步写入 `file_assets`（SHA-256 去重）并返回 `original_url`（供"查看原图"）。
- 语音走 `files/` 资产，消息引用 `media_url`。
- `X-Enc` 豁免（流式 multipart）。

### 11.3 `POST /v2/files/upload` — 聊天文件上传

multipart 字段 `file`；上限 **500MiB**。响应 `fileUploadResponse`：

```json
{
  "file_id": "xxx", "name": "a.zip", "size_bytes": 123456,
  "sha256": "hex64", "url": "https://files.mcl0.dpdns.org/v2/files/download/xxx",
  "deduplicated": false
}
```

### 11.4 `POST /v2/files/check` — 秒传检查

```json
{ "sha256": "hex64", "size_bytes": 123456 }
```

响应：`{"exists":true, "file_id":"...", "size_bytes":123456, "sha256":"...", "url":"..."}` 或 `{"exists":false}`。

### 11.5 下载

| 接口 | 说明 |
|---|---|
| `GET/HEAD /v2/files/download/{fileID}` | 文件资产下载（Bearer 鉴权、Range 支持） |
| `GET/HEAD /v2/resources/download/{itemID}` | 资源广场条目下载（Bearer） |
| `GET/HEAD /v1/uploads/*` | 静态文件（媒体/头像等；files/resources 子目录需 Bearer） |
| `GET /v1/download/sources` | 动态下载源（见 12 章） |

下载响应头：`Cache-Control: private, no-store`、`Accept-Ranges: bytes`、`ETag: sha256`、`Content-Disposition: attachment`。URL 可带 `?ref=`（对象相对路径）供客户端拼对象直链。

### 11.6 资源广场上传（/v2）

`POST /v2/resources/upload`（multipart `file` + `section_id`），上限 500MiB，自动同步雨云 OSS。响应见 [18 章](#18-资源广场)。

---

## 12. 动态下载源

### 12.1 `GET /v1/download/sources` — 下载源列表

Bearer 鉴权。返回：

```json
{ "sources": ["https://cn-sy1.rains3.com/oldchat", "https://files.mcl0.dpdns.org"] }
```

- **第一个 = 对象存储直链源**（当前雨云，可换套餐/换域名，客户端无需更新）。
- 其余为 API 源。
- 配置来自服务端环境变量 `DOWNLOAD_SOURCES` 或 settings.json `download_sources`。

### 12.2 客户端选路（复刻时照做）

```
1. 启动时拉取 sources（缓存 10 分钟）
2. 下载 URL 含 ?ref=filewearhouse/xxx 时：
   候选1 = sources[0] + "/" + ref（对象直链，私有桶→403 自动换）
   候选2 = 原 URL（files 鉴权）
3. 普通上传路径 /v1/uploads/xxx：
   候选1 = sources[0] + xxx（仅 filewearhouse 生效）
   候选2 = files 域名 + xxx
   候选3 = 阿里云 OSS 旧源 + xxx
   候选4 = 主站 + xxx
4. 失败线路冷却 60s，成功线路恢复优先
```

---

## 13. 朋友圈

| 接口 | 说明 |
|---|---|
| `POST /v2/moments` | 发动态 `{body, image_url, image_urls:[...]}` |
| `GET /v2/moments/feed?limit=&before_created_at=` | 朋友圈时间线 |
| `GET /v2/moments/user?uid=USR-XXX` | 某用户动态 |
| `POST /v2/moments/like` / `unlike` | 点赞 `{moment_id}` |
| `POST /v2/moments/delete` | 删除 `{moment_id}` |
| `POST /v2/moments/comment` | 评论 `{moment_id, body}` |
| `POST /v2/moments/comment/delete` | 删评论 `{comment_id}` |
| `GET /v2/moments/comments?moment_id=` | 评论列表 |

/v1 独有：`GET /v1/moments`（旧版时间线）、`GET /v1/moments/v2`（分页新结构）。

---

## 14. 频道

### 14.1 `GET /v2/channels/discover` — 频道发现列表

返回 `[{id, name, description, subscriber_count, avatar_url, owner_uid, ...}]`。

### 14.2 `POST /v2/channels/subscribe` / `unsubscribe`

```json
{ "channel_id": "CHN-XXX" }
```

响应：`{ "ok": true, "subscribed": true, "state": {...} }`。

### 14.3 `GET /v2/channels/state?channel_id=CHN-XXX` / `GET /v2/channels/states?channel_ids=a,b,c`

返回订阅状态、水位（last_read_seq、last_event_seq）、未读数等。

### 14.4 `GET /v2/channels/posts/after?channel_id=&seq=` — 帖子增量

### 14.5 `GET /v2/channels/events/after?channel_id=&seq=` — 频道事件增量

### 14.6 `POST /v2/channels/posts/send` — 发帖

```json
{
  "channel_id": "CHN-XXX",
  "body": "文本",
  "msg_type": "text",              // text|image|voice|video|resource
  "media_url": "https://files.mcl0.dpdns.org/v2/files/download/xxx",
  "reply_to_post_id": "..."        // 可选
}
```

- `resource` 类型要求 media_url 指向有效文件资产（`/v2/files/download/{id}` 或频道媒体前缀）。
- 需要频道发言权限（订阅/频道开放）。
- 响应：`{ "ok": true, "post_id": "CP-...", "post_seq": 123, "event_seq": 456 }`。

### 14.7 `POST /v2/channels/read` — 已读

```json
{ "channel_id": "CHN-XXX", "read_seq": 123 }
```

### 14.8 `POST /v2/channels/notifications` — 频道通知设置

### 14.9 `POST /v2/channels/reactions/toggle` — 表情回应

```json
{ "channel_id": "CHN-XXX", "post_id": "...", "emoji": "👍" }
```

响应：`{ "ok": true, "reactions": {...}, "event_seq": 456 }`。

### 14.10 频道媒体（/v1 独有）

| 接口 | 说明 |
|---|---|
| `POST /v1/channels/media/upload` | 上传频道媒体（multipart `media` 或 `file` + `channel_id`，返回 `{media_ref, msg_type, size}`） |
| `GET /channel-media/{filename}` | 频道媒体签名下载（全局） |

### 14.11 /v1 独有：频道 API（publisher token）

| 接口 | 说明 |
|---|---|
| `POST /v2/channel-api/channels` | 用 publisher token 创建频道 |
| `POST /v2/channel-api/posts` | 用 publisher token 发帖 |
| `PATCH /v2/channel-api/posts` | 编辑帖子 |
| `DELETE /v2/channel-api/posts` | 删除帖子 |
| `POST /v2/channel-api/apply` | 申请频道 API（登录态） |
| `GET /v2/channel-api/status` | 申请状态 |

---

## 15. 红包

### 15.1 `POST /v2/redpackets/send` — 发红包

```json
{
  "to_uid": "USR-XXX",              // 私聊红包
  "to_ncuid": "USR-XXX",
  "group_id": "GRP-XXX",            // 群红包
  "title": "恭喜发财",
  "total_amount": 100,               // 分
  "total_count": 1,                  // 个数
  "cover_url": ""                    // 可选封面
}
```

校验余额充足；余额不足返回 403。响应含红包详情。

### 15.2 `POST /v2/redpackets/claim` — 领红包

```json
{ "packet_id": "..." }
```

响应：`{ "packet_id", "amount", "balance", "remaining_amount", "remaining_count" }`；已领过返回 `already_claimed`。

### 15.3 /v1 独有：`GET /v1/redpackets/{packetID}` — 红包详情

返回 `{ id, title, creator_uid, total_amount, total_count, remaining_amount, remaining_count, claimed_amount, claimed_count, status, created_at, my_claim_amount, can_claim, claims:[{uid, display_name, amount, created_at}], cover_url }`。

---

## 16. 签到 / 在线状态 / 设备

### 16.1 `POST /v2/me/checkin` — 每日签到

```json
{}
```

响应：

```json
{
  "already_checked": false,
  "checkin_date": "2026-08-09",
  "coin_reward": 0,                // 2026-08 起不再发币
  "reputation_reward": 50,
  "coin_balance": 0,
  "reputation_score": 1850
}
```

### 16.2 `GET /v2/me/scratch` — 查询今日刮刮乐状态

响应：

```json
{
  "already_scratched": true,
  "scratch_date": "2026-08-15",
  "slots": [0, 1, 5, 0, 10],
  "total_reward": 16,
  "coin_balance": 120
}
```

### 16.3 `POST /v2/me/scratch` — 每日刮刮乐开奖

开奖 5 个独立槽位，各自独立按概率掷出奖励（谢谢惠顾 40%、1旧币 30%、5旧币 15%、10旧币 10%、20旧币 5%）。每日仅限 1 次，重复调用返回已开奖结果。

请求：`{}`

响应：同 GET `/v2/me/scratch`。

### 16.4 `POST /v2/me/presence` — 在线状态

```json
{ "status": "online" }             // online|offline|busy|away
```

### 16.3 `GET /v2/me/devices` — 设备列表

### 16.4 `POST /v2/me/devices/cleanup` — 清理其他设备

### 16.5 /v1 独有：签到墙

| 接口 | 说明 |
|---|---|
| `GET /v1/me/checkin/wall` | 签到墙列表 |
| `POST /v1/me/checkin/wall` | 发布签到墙动态 |
| `POST /v1/me/checkin/wall/like` / `unlike` | 点赞 |
| `POST /v1/me/checkin/wall/comment` | 评论 |
| `GET /v1/me/checkin/wall/comments` / `likes` | 列表 |

---

## 17. 举报与公开法庭

### 17.1 /v1 独有：举报用户 / 举报群

```json
// POST /v1/reports/user
{ "target_uid": "USR-XXX", "target_ncuid": "...", "reason": "广告骚扰" }

// POST /v1/reports/group
{ "group_id": "GRP-XXX", "reason": "违规内容" }
```

### 17.2 /v1 独有：各类举报查询

| 接口 | 说明 |
|---|---|
| `GET /v1/me/user-reports` / `group-reports` / `bug-reports` | 我的举报 |
| `POST /v1/feedback` | 提交 Bug/反馈 `{content, device_model, android_version, app_version}` |
| `POST /v1/admins/crash-reports` | 崩溃上报（JSON `{crash_log, device_model, android_version}`） |

### 17.3 公开法庭（/v1 独有）

| 接口 | 说明 |
|---|---|
| `GET /v1/public-court/cases` | 案件列表 |
| `GET /v1/public-court/cases/{caseID}` | 案件详情 |
| `GET /v1/public-court/cases/{caseID}/votes` | 投票结果 |
| `GET /v1/public-court/cases/{caseID}/discussions` | 讨论 |
| `POST /v1/public-court/cases/{caseID}/vote` | 投票 `{vote, reason, evidence}` |
| `POST /v1/public-court/cases/{caseID}/statement` | 陈述 |
| `POST /v1/public-court/cases/{caseID}/discussion` | 参与讨论 |
| `POST /v1/public-court/cases/{caseID}/withdraw` | 撤销 |

---

## 18. 资源广场

### 18.1 分区

| 接口 | 说明 |
|---|---|
| `GET /v1/resources/sections` | 分区列表（含条目数） |
| `POST /v1/resources/sections` | 创建分区 `{name}`（每人 ≤5 个） |
| `POST /v1/resources/sections/delete` | 删除分区 `{section_id}` |

### 18.2 条目

| 接口 | 说明 |
|---|---|
| `GET /v1/resources/items?section_id=&limit=&offset=` | 条目列表（返回 liked/comment 数） |
| `GET /v1/resources/search?q=&section_id=` | 搜索 |
| `POST /v1/resources/upload` | 上传（v1，100MiB） |
| `POST /v2/resources/upload` | 上传（v2，500MiB，multipart `file`+`section_id`） |
| `POST /v1/resources/items/delete` | 删除条目 `{item_id}` |
| `POST /v1/resources/like` / `unlike` | 点赞 |
| `POST /v1/resources/comment` | 评论 |
| `GET /v1/resources/comments` | 评论列表 |
| `POST /v1/resources/comment/delete` | 删评论 |
| `POST /v1/resources/report` | 举报资源 |
| `GET /v1/me/resources/quota` | 我的配额，响应 `{limit_bytes, used_bytes, remaining_bytes}` |

条目响应（节选）：

```json
{
  "id": "...", "section_id": "...", "name": "电影.zip",
  "url": "https://files.mcl0.dpdns.org/v2/resources/download/xxx?ref=v1/uploads/filewearhouse/xxx.zip",
  "size_bytes": 123456, "uploader_uid": "USR-XXX",
  "uploader_name": "...", "uploader_title": "...", "uploader_avatar": "...",
  "created_at": 1720000000, "likes": 0, "comments": 0, "liked": false
}
```

存储：`/data/uploads/filewearhouse/`（数据盘），上传后异步同步雨云 OSS（全局限速 5MB/s、防重传）。**资源广场下载优先走雨云直链，回退 files 鉴权下载**（见 12 章）。

---

## 19. 音乐广场

### 19.1 列表/详情（/v1 独有）

| 接口 | 说明 |
|---|---|
| `GET /v1/music/plaza` | 歌曲列表（分页/排序） |
| `GET /v1/music/plaza/detail?id=` | 歌曲详情（含歌词 URL） |
| `GET /v1/music/plaza/mine` | 我上传的歌 |
| `GET /v1/music/plaza/ranking` | 排行 |
| `GET /v1/music/plaza/comments?id=` | 评论 |

### 19.2 上传/管理（/v1 独有）

| 接口 | 说明 |
|---|---|
| `POST /v1/music/plaza/upload` | 上传（multipart：`file` 音频、`cover`/`thumb` 封面、`lyrics` 歌词、`name`、`duration_ms`） |
| `POST /v1/music/plaza/update` | 更新信息 |
| `POST /v1/music/plaza/lyrics` | 上传歌词（multipart `lyrics`） |
| `POST /v1/music/plaza/delete` | 删除 |
| `POST /v1/music/plaza/mine/delete-batch` | 批量删除 |
| `POST /v1/music/plaza/like` / `unlike` | 点赞 |
| `POST /v1/music/plaza/comment` / `comment/delete` | 评论 |
| `POST /v1/music/plaza/play` | 播放计数 |
| `GET /v1/music/playlists` / `POST /v1/music/playlists/sync` | 播放列表 |
| `GET /v1/favorites` / `POST /v1/favorites/add` / `remove` | 收藏 |

歌词支持 LRC 与 TTML（自动识别、重叠行同时高亮、逐字卡拉 OK）——解析/渲染是客户端逻辑，服务端仅存文本。

---

## 20. 表情广场

| 接口 | 说明 |
|---|---|
| `GET /v1/emoji/plaza` | 表情列表 |
| `GET /v1/emoji/plaza/mine` | 我的表情 |
| `POST /v1/emoji/plaza/upload` | 上传（multipart `file` + `name`） |
| `POST /v1/emoji/plaza/save` | 收藏表情 |
| `POST /v1/emoji/plaza/delete` | 删除 |

---

## 21. AI 助手

| 接口 | 说明 |
|---|---|
| `GET /v1/ai/quota` | AI 额度 |
| `POST /v1/ai/chat/completions` | AI 对话（OpenAI 格式 `{messages:[...], max_tokens}`，流式 SSE） |
| `POST /v1/chat/completions` | OpenAI 兼容别名 |

---

## 22. 通知 / 反馈 / 崩溃上报

| 接口 | 说明 |
|---|---|
| `GET /v1/notifications` | 通知列表（系统通知） |
| `POST /v1/feedback` | 反馈/Bug 提交 `{content}` |
| `POST /v1/admins/crash-reports` | 崩溃日志上报（multipart `file` + `version`） |

---

## 23. 外部接口

### 23.1 机器人按钮（Bearer message-token，非登录 JWT）

| 接口 | 说明 |
|---|---|
| `POST /v2/buttons/send` | 机器人发送按钮消息 |
| `GET /v2/buttons/responses` | 按钮响应列表 |
| `POST /v2/buttons/callback` | 按钮点击回调（登录 JWT） |

### 23.2 频道 publisher token

见 14.11。

### 23.3 数据同步（/v1 独有，数据服对接）

| 接口 | 说明 |
|---|---|
| `POST /v1/external/groups` | 数据服群列表 |
| `POST /v1/external/friends` | 数据服好友 |
| `POST /v1/external/direct/send` | 数据服代发私聊 |
| `POST /v1/external/group/send` | 数据服代发群聊 |
| `POST /v1/external/coin/pay` | 外部扣币 |
| `POST /v1/external/coin/verify` | 外部验币 |

### 23.4 商店

| 接口 | 说明 |
|---|---|
| `POST /v1/shop/login` | 商店登录 |
| `GET /v1/shop/logout` | 商店登出 |

---

## 24. 错误码与限流

### 24.1 通用错误码

| code | 含义 |
|---|---|
| `unauthorized` | 未登录/token 失效（401） |
| `invalid_credentials` | 账号或密码错误（401） |
| `user_banned` / `device_banned` | 封禁（403） |
| `unauthorized_client` | APK 签名不符（403） |
| `invalid_session` / `missing_session` | 会话无效/缺失（400/401） |
| `bad_signature` / `missing_signature` | v2 签名失败（401） |
| `device_mismatch` | 设备不绑定（403） |
| `rate_limited` | 限流（429） |
| `registration_closed` | 注册名额已满（403） |
| `invalid_email_code` | 验证码错误/过期（400） |
| `email_taken` / `username_taken` / `uid_taken` | 唯一冲突（409） |
| `not_member` / `group_not_found` | 群相关（403/404） |
| `group_muted` | 全员禁言（403） |
| `resource_share_disabled` | 禁止转发资源广场直链（403） |
| `file_too_large` | 超 500MB（413） |
| `image_too_large` | 图片超 10MB（413） |
| `sha256_mismatch` | 客户端声明的 SHA-256 与实算不符（400） |
| `video_disabled` | 视频功能关闭（403） |
| `bad_gateway_body` / `bad_gateway_path` / `bad_gateway_method` | v2 网关参数错误（400） |

### 24.2 限流

- 注册/登录/重置密码：IP 维度 + 账号维度（令牌桶）。
- 发码：每邮箱 120s。
- 上传/下载：全局并发信号量 + 每连接限速（`MEDIA_TRANSFER_RATE_BYTES` 等环境变量控制）。
- 雨云同步：全局 5MB/s 限速器。

---

## 25. 附录：复刻所需最小流程

### 25.1 新客户端启动

```
1. POST /v1/auth/login  （或 refresh）
   → access_token / refresh_token
2. POST /v1/auth/handshake {client_pub}
   → session_id / server_pub → 派生 encKey/macKey
3. GET /v1/ws?token=...&sid=...  （WebSocket 长连接）
4. GET /v1/update/update.json     （版本检查/下载 APK）
5. GET /v1/download/sources       （预热下载源）
6. 拉取 /v1/me → 用户信息
7. 全量重建：friends/groups/资源/频道（各自 list 接口）
8. 断线重连：GET /v2/updates/difference?pts=本地PTS
```

### 25.2 发一条私聊消息（v2 加密链路）

```
1. body = {"to_uid":"USR-XXX","body":"hi","msg_type":"text"}
2. 明文信封 = {"m":"POST","p":"/v2/direct/send","q":"","b":body}
3. AES-CBC 加密 → JSON {iv,data,mac}（X-Enc:1, X-Auth=加密token）
4. 计算 X-Sign（MAC key）
5. POST /v2/gateway
6. 响应 HTTP 200 {code, body:{id, created_at,...}}
7. 对端通过 WS 收到 DIRECT_MESSAGE_NEW
```

### 25.3 上传并发送图片

```
1. 本地流式算 SHA-256
2. POST /v1/media（multipart file=原图, thumb=缩略图）→ url/thumb_url/original_url
3. POST /v2/gateway 折叠 direct/send：msg_type=image, media_url=url, thumb_url, original_url
4. 对方点开图片 → 底部"查看原图" → original_url（files 鉴权）或对象直链
```

### 25.4 上传并发送大文件（≤500MB）

```
1. 本地流式算 SHA-256
2. POST /v2/files/check {sha256,size_bytes}
   ├─ exists → 直接用返回 url 发消息（秒传）
   └─ 否则 POST /v2/files/upload multipart file（X-File-Size/X-File-SHA256）
3. 发送 resource 消息，media_url = 返回 url
```

### 25.5 下载资源广场文件

```
1. 条目 url 含 ?ref=filewearhouse/xxx
2. 候选1 = download_sources[0] + "/filewearhouse/xxx"（雨云直链）
3. 失败 → 候选2 = 原 url（files 鉴权，带 Bearer）
4. 保存到公共 Downloads，失败回退内部目录
```

### 25.6 断线重连

```
1. WS onError/onClose
2. 若错误含 400/401 → CryptoUtil.clearSession() + 重新 handshake
3. 401 → refresh token → 重连
4. 重连成功 → GET /v2/updates/difference 补差
5. 指数退避 1s→60s
```

---

*本文档依据服务端源码（`server/internal/http/api.go` 及各类 handler）整理，覆盖全部 /v2 接口与 /v1 独有接口。*
