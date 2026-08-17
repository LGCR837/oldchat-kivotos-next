# Oldchat 服务端 API 标准与 v2 协议规范

> 本文档为 Oldchat 后端 API 的核心规范，全面定义 **/v2 加密网关协议**、**安全鉴权体系**、**数据传输格式**与**各业务模块标准接口**。
>
> 适用范围：`server/internal/http/`、Android 客户端（1.4.1+）、Web 端及第三方客户端。
> 最新修订日期：2026-08-15

---

## 1. 协议体系与根路径

### 1.1 API 根路径划分

| 根路径 | 协议状态 | 说明 |
|---|---|---|
| `/v2` | **当前主推标准** | 全链路加密会话，支持请求签名与网关折叠，具备增量游标同步（pts） |
| `/v1` | **兼容基线** | 传统 REST API，兼容老旧客户端（minSdk 9 / 无 ECDH 加密芯片设备） |
| `/v2/gateway` | **加密网关** | 新版客户端将业务请求全部折叠为单一路径，防止网络层抓包分析 API 语义 |

### 1.2 数据格式

除文件/资源分片上传（`multipart/form-data`）、静态媒体直连和 WebSocket 外，请求与响应统一使用 UTF-8 JSON：

```http
Content-Type: application/json; charset=utf-8
Accept: application/json
```

JSON 字段命名严格采用**小写蛇形（snake_case）**：
`created_at`、`from_uid`、`group_id`、`has_more`、`token_version` 等。

### 1.3 统一错误响应结构

所有 HTTP 非 2xx 响应（或网关包装错误）均返回统一的 JSON 错误结构：

```json
{
  "error": "error_code_string",
  "code": "error_code_string",
  "message": "人类可读的错误描述信息"
}
```

常见 HTTP 状态码规范：
- `200 OK` / `201 Created`：请求处理成功；
- `400 Bad Request`：参数缺失、格式错误、或签名校验失败（`invalid_signature`）；
- `401 Unauthorized`：未登录、Token 过期或 Token 版本不匹配（`unauthorized` / `token_expired`）；
- `403 Forbidden`：账号被封禁、权限不足（如非群主、被禁言、已被踢出）；
- `404 Not Found`：用户/群组/消息/资源不存在；
- `413 Payload Too Large`：上传体或文本超出服务器限制；
- `429 Too Many Requests`：触发接口速率或 IP 限流。

---

## 2. 安全、加密与签名协议（v2 Security）

### 2.1 三层中间件防护链

所有发往 `/v2` 的请求均依次穿透以下三层防护链：

```
secureMiddleware (解密密文 Body & X-Auth)
       ↓
authMiddleware (校验 JWT 签名与 token_version 活性)
       ↓
v2SignMiddleware (校验 X-Session 有效性、X-Sign 签名与防重放 Nonce)
```

### 2.2 ECDH 会话握手 (`POST /v1/auth/handshake`)

在发送任何 `/v2` 加密请求前，客户端与服务端通过 ECDH（secp256r1 曲线）协商临时会话对称密钥：

1. **客户端生成**：客户端生成临时 ECDH 密钥对 `(priv_c, pub_c)`；
2. **握手请求**：`POST /v1/auth/handshake` 发送客户端公钥与客户端随机数 `client_random`；
3. **服务端响应**：服务端生成临时密钥对 `(priv_s, pub_s)`，计算共享主密钥并推导出 `session_id` 与对称加密密钥 `aes_key`、`hmac_key`；
4. **会话有效期**：会话在内存及 Redis/SessionStore 中保持 24 小时，超时后需重新握手。

### 2.3 密文信封与传输头

在建立加密会话后，客户端通过以下 Header 发起加密请求：

```http
X-Enc: 1
X-Session: <session_id>
X-Auth: <使用 session_key 加密后的 Bearer Token>
X-Sign: <使用 hmac_key 计算的请求签名>
X-Sign-Time: <Unix 秒时间戳>
X-Sign-Nonce: <随机 16 字符防重放字串>
X-Device-Id: <设备唯一标识>
```

#### 加密算法细节：
- 对称加密：**AES-256-CBC**（PKCS7 Padding，前置 16 字节随机 IV）；
- 完整性校验：**HMAC-SHA256**（附加在密文末尾）；
- 可选压缩传输：若请求头包含 `X-Enc-Compression: gzip`，服务端在明文大于 512B 时采用“先 Gzip 压缩、后 AES 加密”。

---

## 3. v2 加密网关规范 (`POST /v2/gateway`)

为彻底防止抓包嗅探 API 拓扑与敏感路由，新版客户端统一将请求折叠发送至 `/v2/gateway`。

### 3.1 网关请求结构（解密后的 Body 明文）

```json
{
  "m": "POST",
  "p": "/v2/groups/message/send",
  "q": "group_id=GRP-XXXXXX",
  "b": {
    "group_id": "GRP-XXXXXX",
    "body": "Hello World",
    "msg_type": "text"
  }
}
```

- `m`：真实 HTTP Method（`GET` / `POST` / `PUT` / `DELETE`）；
- `p`：真实 /v2 业务路径；
- `q`：URL Query 查询字符串；
- `b`：POST 原始业务 JSON Body（GET 请求时为空）。

### 3.2 网关响应结构（外层 HTTP 永远返回 200，内部状态码装在 Body 内）

```json
{
  "code": 200,
  "body": {
    "id": "msg_nanoid_123",
    "group_id": "GRP-XXXXXX",
    "seq": 1042,
    "created_at": 1786556788
  }
}
```

---

## 4. v2 核心业务模块接口全览

### 4.1 认证与令牌体系

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v1/auth/handshake` | `POST` | ECDH 密钥协商握手，获取 `session_id` 与公钥 |
| `/v1/auth/register` | `POST` | 用户注册（支持极验 4.0 验证与邀请码） |
| `/v1/auth/login` | `POST` | 用户登录，返回 `access_token`、`refresh_token` 及用户信息 |
| `/v1/auth/refresh` | `POST` | 刷新 Access Token（受 token_version 约束） |
| `/v1/auth/logout` | `POST` | 退出登录，注销当前会话与设备推送标记 |
| `/v1/auth/password/reset` | `POST` | 邮箱验证码重置密码（重置后全端强制下线） |

### 4.2 消息、事件与增量同步系统

| 路径 | 方法 | 对应网关路径 | 说明 |
|---|---|---|---|
| `/v2/updates/difference` | `POST`/`GET` | `/v2/updates/difference` | **pts 增量游标同步**，拉取离线消息、会话事件与未读状态 |
| `/v2/direct/send` | `POST` | `/v2/direct/send` | 发送私聊消息（支持文字、图片、语音、红包、阅后即焚） |
| `/v2/direct/messages/v2` | `GET` | `/v2/direct/messages/v2` | 获取私聊历史消息（游标分页） |
| `/v2/direct/read` | `POST` | `/v2/direct/read` | 私聊会话已读状态上报 |
| `/v2/direct/burn/open` | `POST` | `/v2/direct/burn/open` | 触发私聊阅后即焚消息销毁倒计时 |
| `/v2/groups/message/send`| `POST` | `/v2/groups/message/send` | 发送群聊消息 |
| `/v2/groups/messages/v2` | `GET` | `/v2/groups/messages/v2` | 获取群聊历史消息 |
| `/v2/groups/messages/after` | `GET` | `/v2/groups/messages/after` | 按序号增量拉取指定 seq 之后的群消息 |
| `/v2/groups/events/after`| `GET` | `/v2/groups/events/after` | 获取群成员变动/禁言/公告等元数据事件 |
| `/v2/groups/read` | `POST` | `/v2/groups/read` | 群聊已读进度同步 |
| `/v2/groups/typing` | `POST` | `/v2/groups/typing` | 上报群内“正在输入”状态 |
| `/v2/chats/typing` | `POST` | `/v2/chats/typing` | 上报私聊“正在输入”状态 |
| `/v2/redpackets/send` | `POST` | `/v2/redpackets/send` | 发送旧币红包 |
| `/v2/redpackets/claim` | `POST` | `/v2/redpackets/claim` | 抢红包 |
| `/v2/buttons/callback` | `POST` | `/v2/buttons/callback` | 响应机器人按钮交互（带 tid 签名） |

### 4.3 好友与关系链

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v2/friends` | `GET` | 获取当前用户全量好友列表及在线状态缓存 |
| `/v2/friends/requests` | `GET` | 获取待处理的好友申请列表 |
| `/v2/friends/request` | `POST` | 发送添加好友申请 |
| `/v2/friends/respond` | `POST` | 同意或拒绝好友申请 |
| `/v2/friends/remark` | `POST` | 修改好友备注名 |
| `/v2/friends/delete` | `POST` | 删除好友关系 |

### 4.4 群组管理

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v2/groups/list` | `GET` | 获取当前加入的群组列表 |
| `/v2/groups/create` | `POST` | 创建新群聊 |
| `/v2/groups/members` | `GET` | 获取群成员列表（支持分页与搜索） |
| `/v2/groups/members/lookup`| `POST` | 批量查询群成员昵称与头像信息 |
| `/v2/groups/join` | `POST` | 申请加入群聊 |
| `/v2/groups/requests` | `GET` | 获取入群申请列表（仅群主/管理员） |
| `/v2/groups/approve` | `POST` | 审批入群申请 |
| `/v2/groups/invite` | `POST` | 邀请好友入群 |
| `/v2/groups/invitations` | `GET` | 获取我收到的入群邀请 |
| `/v2/groups/invitations/respond` | `POST` | 接受/拒绝入群邀请 |
| `/v2/groups/admin` | `POST` | 设置/取消群管理员 |
| `/v2/groups/avatar` | `POST` | 更新群头像 |
| `/v2/groups/name` | `POST` | 修改群名称 |
| `/v2/groups/settings` | `POST` | 修改群配置（禁言、加群验证方式等） |
| `/v2/groups/announcement` | `POST` | 发布群公告 |
| `/v2/groups/announcement/read` | `POST` | 标记群公告已读 |
| `/v2/groups/kick` | `POST` | 移出群成员 |
| `/v2/groups/leave` | `POST` | 主动退出群聊 |
| `/v2/groups/dissolve` | `POST` | 解散群聊（仅群主） |

### 4.5 频道广播系统 (Telegram-style Channels)

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v2/channels/discover` | `GET` | 获取公开推荐频道列表 |
| `/v2/channels/state` | `GET` | 查询单个频道双水位状态与订阅信息 |
| `/v2/channels/states` | `GET` | 批量查询多个频道的未读与最新水位 |
| `/v2/channels/subscribe` | `POST` | 订阅频道 |
| `/v2/channels/unsubscribe` | `POST` | 取消订阅频道 |
| `/v2/channels/posts/after` | `GET` | 增量拉取指定 seq 之后的频道帖子 |
| `/v2/channels/posts/send` | `POST` | 发布频道新贴（仅创建者/Token 发布者） |
| `/v2/channels/read` | `POST` | 上报频道已读序号水位 |
| `/v2/channels/notifications` | `POST` | 开启/静音频道推送通知 |
| `/v2/channels/reactions/toggle` | `POST` | 点赞/切换频道贴表情互动 (Reaction) |
| `/v2/channel-api/apply` | `POST` | 申请频道自动化发布 Publisher Token |
| `/v2/channel-api/status` | `GET` | 查询 Publisher Token 审核与激活状态 |

### 4.6 朋友圈 (Moments)

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v2/moments/feed` | `GET` | 获取好友朋友圈时间线（分页游标） |
| `/v2/moments/user` | `GET` | 获取指定用户的个人动态主页 |
| `/v2/moments` | `POST` | 发布新动态（支持多图、文字、可见范围） |
| `/v2/moments/delete` | `POST` | 删除动态 |
| `/v2/moments/like` | `POST` | 点赞动态 |
| `/v2/moments/unlike` | `POST` | 取消点赞 |
| `/v2/moments/comment` | `POST` | 评论动态或回复他人 |
| `/v2/moments/comment/delete` | `POST` | 删除动态评论 |
| `/v2/moments/comments` | `GET` | 分页拉取单条动态的完整评论列表 |

### 4.7 个人中心、每日互动与设备

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v2/users/profile` | `GET` | 获取用户公开主页资料与头衔 |
| `/v2/me/profile` | `POST` | 更新个人昵称、签名、个性化设置 |
| `/v2/me/avatar` | `POST` | 上传个人头像 |
| `/v2/me/cover` | `POST` | 上传个人主页背景图 |
| `/v2/me/uid` | `POST` | 自定义唯一 UID（限改规则） |
| `/v2/me/password` | `POST` | 登录态下修改密码 |
| `/v2/me/group-invite-preference` | `GET`/`POST` | 查询/设置是否允许他人直接拉群 |
| `/v2/me/checkin` | `POST` | 每日签到，领取旧币奖励 |
| `/v2/me/scratch` | `GET` | **每日刮刮乐状态查询**（是否已刮、槽位历史） |
| `/v2/me/scratch` | `POST` | **每日刮刮乐开奖**（5 槽独立随机奖励） |
| `/v2/me/presence` | `POST` | 心跳上报当前在线/离线状态 |
| `/v2/me/devices` | `GET` | 获取当前账号已登录设备列表 |
| `/v2/me/devices/cleanup` | `POST` | 踢下线除当前设备外的所有其他设备 |
| `/v2/me/bug-reports` | `GET` | 查询我提交的 Bug 反馈处理进度 |
| `/v2/me/user-reports` | `GET` | 查询我提交的用户举报处理进度 |
| `/v2/me/group-reports` | `GET` | 查询我提交的群组举报处理进度 |
| `/v2/me/delete` | `POST` | 注销账号（需邮箱验证码确认） |

### 4.8 媒体、大文件与资源广场

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v2/files/check` | `POST` | 大文件秒传检查（基于 SHA256 哈希） |
| `/v2/files/upload` | `POST` | 聊天大文件/视频分片上传 |
| `/v2/files/download/{fileID}` | `GET`/`HEAD`| 高速下载文件资产（支持 HTTP Range 断点续传） |
| `/v2/resources/upload` | `POST` | 发布资源到公共资源大厅 |
| `/v2/resources/download/{itemID}`| `GET`/`HEAD`| 下载资源大厅文件资产 |
| `/v1/music/plaza` | `GET` | 音乐广场曲库列表与排行 |
| `/v1/emoji/plaza` | `GET` | 表情广场表情包浏览与添加 |

### 4.9 举报、公开法庭与安全治理

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v1/reports/user` | `POST` | 举报违规用户（附带聊天证据截图） |
| `/v1/reports/group` | `POST` | 举报违规群聊 |
| `/v1/resources/report` | `POST` | 举报违规资源（支持关联下架） |
| `/v1/public-court/cases` | `GET` | 获取公开法庭二审案件列表 |
| `/v1/public-court/cases/{id}` | `GET` | 查看法庭案件双方陈述与证据链 |
| `/v1/public-court/cases/{id}/vote` | `POST` | 全民陪审团投票（支持/反对封禁） |
| `/v1/public-court/cases/{id}/discussion` | `POST` | 发表法庭案件法理讨论 |

---

## 5. WebSocket 实时事件规范 (`/v1/ws`)

### 5.1 鉴权与建连

```http
GET /v1/ws?token=<access_token>&device_id=<device_id>
Upgrade: websocket
Connection: Upgrade
```

### 5.2 核心下行事件（Event Payload）

```json
{
  "type": "new_message",
  "pts": 10842,
  "data": {
    "id": "c_msg_nanoid",
    "chat_type": "group",
    "group_id": "GRP-123456",
    "from_uid": "USR-888888",
    "body": "消息内容",
    "created_at": 1786556788
  }
}
```

- **心跳保活**：客户端每 25 秒发送 `{"type":"ping"}`，服务端回 `{"type":"pong"}`；
- **掉线重连**：网络断开重连后，客户端应立刻携带本地最新 `pts` 调用 `POST /v2/updates/difference` 补齐离线期间错过的全量增量消息。
