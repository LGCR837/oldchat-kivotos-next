# 03 - 消息JSON格式与接口规范 (v1.3.61)

> ⭐ **核心文档** — 消息收发的协议层，第三方客户端开发者必读

---

## 1. 消息类型总览

| msg_type | 说明 | body 字段内容 | media_url | thumb_url |
|---|---|---|---|---|
| `text` | 文本消息 | 纯文本 或 v2 JSON 字符串 | — | — |
| `image` | 图片消息 | — 或描述 | 图片URL | 缩略图URL |
| `voice` | 语音消息 | — 或时长 | 音频URL | — |
| `video` | 视频消息 | — | 视频URL | 缩略图URL |
| `resource` / `file` | 文件消息 | 文件名 | 文件URL | — |
| `red_packet` | 红包消息 | 红包JSON字符串 | — | — |
| `system` | 系统消息 | 系统提示文本 | — | — |
| `recall` | 撤回消息 | "[消息已撤回]" | — | — |

---

## 2. 用户标识体系：UID → NCUID 迁移

### 2.1 变更概述

v1.3.61 引入了 NCUID (New Chat UID) 体系，逐步替代旧的 UID。NCUID 格式类似 UUID（如 `a1b2c3d4-e5f6-7890-abcd-ef1234567890`），具有全局唯一性。

### 2.2 迁移状态（经实测验证）

| 场景 | 旧字段 | 新字段 | 状态 |
|---|---|---|---|
| 登录响应 | `user.uid` | `user.ncuid` | ✅ **两者都返回** |
| 用户资料查询 | `?uid=xxx` | `?ncuid=xxx` | ✅ **两者都支持** |
| 群成员列表 | `member.uid` | `member.ncuid` | ✅ **两者都返回** |
| 消息发送者 | `from_uid` | `from_ncuid` | ⚠️ **仅返回 from_uid** |
| 好友列表 | `friend.uid` | `friend.ncuid` | ⚠️ **仅返回 uid** |
| 好友申请 | `from_uid` | `from_ncuid` | ⚠️ **仅返回 from_uid** |
| 消息历史查询 | `?with_uid=xxx` | `?with_ncuid=xxx` | ❌ **with_ncuid 返回 invalid_uid** |
| 发送消息目标 | `to_uid` | `to_ncuid` | ❌ **仍需 to_uid** |
| 标记已读 | `with_uid` | `with_ncuid` | ❌ **仍需 with_uid** |
| 群邀请 | `user_uid` | `user_ncuid` | ❌ **仍需 user_uid** |
| 修改UID端点 | `PUT /v1/me/uid` | `PUT /v1/me/ncuid` | ❌ **仅 /v1/me/uid** |
| @提及 | `mentions[].uid` | `mentions[].ncuid` | ⚠️ **待验证** |
| 引用回复 | `quote.from_uid` | `quote.from_ncuid` | ⚠️ **待验证** |

### 2.3 客户端兼容策略（推荐）

**读取（响应解析）**：优先读取新字段，回退到旧字段
```javascript
function getUid(obj) {
    return obj.ncuid || obj.uid || '';
}
```

**写入（请求构造）**：目前仍使用旧字段名（后端尚未完全迁移）
```javascript
// 发送消息 — 仍用 to_uid
{ to_uid: "对方UID", body: "..." }
// 查询历史 — 仍用 with_uid
GET /v1/direct/messages/v2?with_uid=xxx&limit=100
```

### 2.4 NCUID 格式特征

- 类似 UUID：`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- 全局唯一，不随用户名/昵称修改而变化
- 旧 UID 通常是短字符串（如 `USER_ABC123`），NCUID 更长
- 客户端应以**大小写不敏感**方式比较 NCUID

---

## 3. 消息对象结构 (通用字段)

所有消息对象共享以下字段（注意 UID/NCUID 兼容）：

```json
{
    "id": "消息唯一ID (string)",
    "from_ncuid": "发送者NCUID (string, 新版)",
    "from_uid": "发送者UID (string, 旧版兼容)",
    "from_name": "发送者显示名 (string)",
    "from_avatar": "发送者头像URL (string)",
    "body": "消息正文 (string, 视msg_type而定)",
    "msg_type": "消息类型 (string, 默认 'text')",
    "media_url": "媒体资源URL (string)",
    "thumb_url": "缩略图URL (string)",
    "created_at": 1690000000,
    "is_me": false,
    "group_id": "群聊ID (仅群消息, string)"
}
```

### 字段别名与 NCUID 兼容

| 语义 | 新字段 (优先) | 旧字段 (回退) |
|---|---|---|
| 发送者标识 | `from_ncuid` | `from_uid` → `sender_uid` |
| 发送者名称 | `from_name` | `sender_name` → `display_name` |
| 发送者头像 | `from_avatar` | `sender_avatar` → `avatar_url` |
| 是否自己 | `is_me` | `isSelf` → 比较标识符 |

---

## 3. 文本消息 v2 格式 ⭐

当 `msg_type === "text"` 且 `body` 以 `{` 开头时，尝试解析为 v2 JSON。

### 3.1 v2 基本结构

```json
{
    "v": 2,
    "text": "消息文本内容",
    "mentions": null,
    "quote": null,
    "burn_after_seconds": 0
}
```

### 3.2 完整 v2 结构

```json
{
    "v": 2,
    "text": "你好 @张三，看看这个",
    "mentions": [
        {
            "uid": "USER_UID_123",
            "name": "张三"
        }
    ],
    "quote": {
        "id": "被引用消息的ID",
        "from_uid": "原消息发送者UID",
        "from_name": "原消息发送者名称",
        "type": "text",
        "text": "被引用的消息内容（截取前200字符）"
    },
    "burn_after_seconds": 10
}
```

### 3.3 v2 字段详解

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | int | ✅ | 版本号，固定为 `2` |
| `text` | string | ✅ | 消息文本，支持 `\n` 换行 |
| `mentions` | array | ❌ | @提及的用户列表 |
| `mentions[].ncuid` | string | ✅ | 被@用户的NCUID |
| `mentions[].name` | string | ✅ | 被@用户的显示名 |
| `quote` | object | ❌ | 引用回复 |
| `quote.id` | string | ✅ | 被引用消息的ID |
| `quote.from_uid` | string | ✅ | 被引用消息的发送者UID |
| `quote.from_name` | string | ✅ | 被引用消息的发送者名称 |
| `quote.type` | string | ❌ | 被引用消息的类型 (默认 "text") |
| `quote.text` | string | ✅ | 被引用消息的文本（截取前200字符） |
| `burn_after_seconds` | int | ❌ | 阅后即焚秒数，0或不填表示普通消息 |

### 3.4 自动升级到 v2 的条件

客户端在以下情况会自动将纯文本包装为 v2 JSON：

1. 文本包含 `\n` 换行符
2. 文本包含 `@用户名` 提及
3. 有挂起的引用回复 (`pendingQuote`)

```javascript
// 自动升级逻辑
if (body.includes('\n') || mentions.length > 0) {
    const v2Obj = { v: 2, text: body };
    if (mentions.length > 0) v2Obj.mentions = mentions;
    body = JSON.stringify(v2Obj);
}
```

### 3.5 旧版纯文本格式

当 `body` 不以 `{` 开头，或解析 JSON 失败时，按纯文本处理：

```json
{
    "msg_type": "text",
    "body": "这是一条普通文本消息"
}
```

---

## 4. 媒体类消息格式

### 4.1 图片消息

```json
{
    "msg_type": "image",
    "body": "",
    "media_url": "/uploads/abc123.jpg",
    "thumb_url": "/uploads/abc123_thumb.jpg"
}
```

- `media_url`: 原图URL（可能需要拼接 MEDIA_BASE）
- `thumb_url`: 缩略图URL（可选）
- `body`: 通常为空，或图片描述文本

### 4.2 语音消息

```json
{
    "msg_type": "voice",
    "body": "",
    "media_url": "/uploads/voice_abc123.amr"
}
```

- `media_url`: 音频文件URL
- `body`: 通常为空

### 4.3 视频消息

```json
{
    "msg_type": "video",
    "body": "",
    "media_url": "/uploads/video_abc123.mp4",
    "thumb_url": "/uploads/video_abc123_thumb.jpg"
}
```

### 4.4 文件消息

```json
{
    "msg_type": "resource",
    "body": "document.pdf",
    "media_url": "/uploads/file_abc123.pdf"
}
```

- `msg_type` 可能为 `resource` 或 `file`
- `body` 为文件名

---

## 5. 红包消息格式

```json
{
    "msg_type": "red_packet",
    "body": "{\"packet_id\":\"rp_abc123\",\"total_amount\":8.88,\"total_count\":5}"
}
```

### 红包 body JSON 结构

```json
{
    "packet_id": "红包唯一ID",
    "total_amount": 8.88,
    "total_count": 5
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `packet_id` | string | 红包ID，用于领取 |
| `total_amount` | number | 红包总金额 |
| `total_count` | int | 红包个数 |

### 红包 API

| 操作 | 端点 | 方法 | 请求体 |
|---|---|---|---|
| 发送红包 | `/redpackets/send` | POST | `{title, total_amount, total_count, group_id 或 to_uid, cover_url?}` |
| 领取红包 | `/redpackets/claim` | POST | `{packet_id}` |

---

## 6. 系统消息与撤回消息

### 6.1 系统消息

```json
{
    "msg_type": "system",
    "body": "张三 加入了群聊"
}
```

渲染为居中的灰色分隔文本。

### 6.2 撤回消息 (历史记录中的)

```json
{
    "msg_type": "recall",
    "body": "[消息已撤回]",
    "from_uid": "撤回者UID"
}
```

渲染时显示：`"XXX 撤回了一条消息"`（自己撤回显示 `"你 撤回了一条消息"`）。

---

## 7. 阅后即焚消息

### 7.1 发送格式

在 v2 文本消息中加入 `burn_after_seconds` 字段：

```json
{
    "v": 2,
    "text": "这是一条阅后即焚消息",
    "burn_after_seconds": 10
}
```

### 7.2 客户端渲染逻辑

1. 消息带 `burn_after_seconds > 0` 时，显示遮罩层 + "🔥 点击查看阅后即焚消息"
2. 用户点击遮罩后揭示内容
3. 揭示后开始倒计时，到达秒数后自动焚毁（显示 "🔥 已焚毁"，内容半透明不可交互）

### 7.3 解析优先级

```javascript
// 从 body JSON 中解析
try {
    const parsed = JSON.parse(msg.body);
    burnSeconds = parsed.burn_after_seconds || msg.burn_after_seconds || 0;
} catch {
    burnSeconds = msg.burn_after_seconds || 0;
}
```

---

## 8. WebSocket 推送格式

所有 WS 推送都经过 ECDH 加密信封包装，解密后为以下 JSON：

### 8.1 私聊消息推送

```json
{
    "type": "direct_message",
    "data": {
        "id": "消息ID",
        "from_ncuid": "发送者NCUID",
        "body": "消息内容",
        "msg_type": "text",
        "media_url": "",
        "thumb_url": "",
        "created_at": 1690000000
    }
}
```

### 8.2 群聊消息推送

```json
{
    "type": "group_message",
    "data": {
        "id": "消息ID",
        "group_id": "群ID",
        "from_ncuid": "发送者NCUID",
        "body": "消息内容",
        "msg_type": "text",
        "media_url": "",
        "thumb_url": "",
        "created_at": 1690000000
    }
}
```

### 8.3 私聊撤回推送

```json
{
    "type": "direct_recall",
    "data": {
        "message_id": "被撤回的消息ID",
        "from_ncuid": "撤回者NCUID"
    }
}
```

### 8.4 群聊撤回推送

```json
{
    "type": "group_recall",
    "data": {
        "message_id": "被撤回的消息ID",
        "group_id": "群ID",
        "from_ncuid": "撤回者NCUID"
    }
}
```

### 8.5 已读回执推送

```json
{
    "type": "direct_read",
    "data": {
        "thread_id": "会话ID",
        "reader_ncuid": "已读者NCUID",
        "read_at": 1690000000
    }
}
```

---

## 9. 消息发送接口

### 9.1 发送私聊消息

```
POST /v1/direct/send
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
    "to_ncuid": "接收者NCUID",
    "body": "消息内容（纯文本或v2 JSON）",
    "msg_type": "text",
    "media_url": "",
    "thumb_url": ""
}
```

### 9.2 发送群聊消息

```
POST /v1/groups/message/send
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
    "group_id": "群ID",
    "body": "消息内容",
    "msg_type": "text",
    "media_url": "",
    "thumb_url": ""
}
```

### 9.3 发送图片消息

```json
{
    "to_ncuid": "接收者NCUID",
    "body": "",
    "msg_type": "image",
    "media_url": "/uploads/abc.jpg",
    "thumb_url": "/uploads/abc_thumb.jpg"
}
```

### 9.4 发送阅后即焚消息

```json
{
    "to_ncuid": "接收者NCUID",
    "body": "{\"v\":2,\"text\":\"秘密消息\",\"burn_after_seconds\":10}",
    "msg_type": "text",
    "media_url": "",
    "thumb_url": ""
}
```

### 9.5 发送引用回复

```json
{
    "to_ncuid": "接收者NCUID",
    "body": "{\"v\":2,\"text\":\"回复内容\",\"quote\":{\"id\":\"原消息ID\",\"from_ncuid\":\"原发送者NCUID\",\"from_name\":\"原发送者名\",\"type\":\"text\",\"text\":\"原消息内容\"}}",
    "msg_type": "text",
    "media_url": "",
    "thumb_url": ""
}
```

### 9.6 发送带@提及的消息

```json
{
    "group_id": "群ID",
    "body": "{\"v\":2,\"text\":\"你好 @张三\",\"mentions\":[{\"ncuid\":\"NCUID_123\",\"name\":\"张三\"}]}",
    "msg_type": "text",
    "media_url": "",
    "thumb_url": ""
}
```

### 9.7 响应格式

成功：
```json
{
    "message": {
        "id": "新消息ID",
        "from_ncuid": "发送者NCUID",
        "body": "消息内容",
        "msg_type": "text",
        "created_at": 1690000000
    }
}
```

失败：
```json
{
    "error": "错误描述"
}
```

---

## 10. 消息历史查询接口

### 10.1 私聊历史

```
GET /v1/direct/messages/v2?with_ncuid=<NCUID>&limit=100&offset=0
Authorization: Bearer <token>
```

响应：
```json
{
    "messages": [
        { "id": "...", "from_ncuid": "...", "body": "...", "msg_type": "text", "created_at": 1690000000 },
        ...
    ]
}
```

- 返回顺序：**DESC**（新消息在前），客户端需反转为 ASC
- 分页：`offset` 为已加载数量，`limit` 为每页大小

### 10.2 群聊历史

```
GET /v1/groups/messages/v2?group_id=<GID>&limit=100&offset=0
Authorization: Bearer <token>
```

响应格式同上。

### 10.3 撤回消息

```
DELETE /v1/direct/messages/<message_id>
DELETE /v1/groups/messages/<message_id>
Authorization: Bearer <token>
```

限制：仅能撤回自己发送的、2分钟内的消息。

---

## 11. 未读消息接口

### 11.1 私聊未读

```
POST /v1/direct/unread
Content-Type: application/json
{"limit": 200}
```

响应：
```json
{
    "messages": [
        {"from_ncuid": "NCUID_1", "body": "...", ...},
        {"from_ncuid": "NCUID_2", "body": "...", ...}
    ]
}
```

按 `from_ncuid` 分组统计未读数。

### 11.2 群聊未读

```
POST /v1/groups/unread
Content-Type: application/json
{"limit": 200}
```

响应：
```json
{
    "messages": [
        {"group_id": "GID_1", "body": "...", ...}
    ]
}
```

按 `group_id` 分组统计未读数。

### 11.3 标记已读

```
POST /v1/direct/read   {"with_ncuid": "对方NCUID"}
POST /v1/groups/read   {"group_id": "群ID"}
```

---

## 12. 媒体上传接口

```
POST /v1/media
Content-Type: multipart/form-data
Authorization: Bearer <token>

file: <二进制文件>
```

响应：
```json
{
    "url": "/uploads/abc123.jpg"
}
```

返回的 `url` 需要拼接 `MEDIA_BASE` 才能访问。

---

## 13. 消息解析最佳实践

### 13.1 解析 body 的推荐流程

```javascript
function parseMessageBody(msg) {
    const msgType = msg.msg_type || 'text';
    
    if (msgType === 'text') {
        let body = msg.body || '';
        
        // 尝试 v2 JSON 解析
        if (body.trim().startsWith('{')) {
            try {
                const obj = JSON.parse(body);
                if (obj.v === 2) {
                    return {
                        format: 'v2',
                        text: obj.text || '',
                        mentions: obj.mentions || [],
                        quote: obj.quote || null,
                        burn_after_seconds: obj.burn_after_seconds || 0
                    };
                }
            } catch (e) {
                // JSON 解析失败，按纯文本处理
            }
        }
        
        return { format: 'plain', text: body };
    }
    
    if (msgType === 'red_packet') {
        try {
            const pkt = JSON.parse(msg.body);
            return { format: 'red_packet', ...pkt };
        } catch {
            return { format: 'red_packet_raw', text: msg.body };
        }
    }
    
    // image, voice, video, file 等
    return {
        format: msgType,
        media_url: msg.media_url || '',
        thumb_url: msg.thumb_url || '',
        body: msg.body || ''
    };
}
```

### 13.2 媒体 URL 拼接

```javascript
function resolveMediaUrl(url) {
    if (!url) return url;
    if (/^(https?:|data:|blob:)/.test(url)) return url;  // 已是完整URL
    if (MEDIA_BASE && url.startsWith('/')) return MEDIA_BASE + url;
    return url;
}
```

---

## 14. 加密信封格式 (WebSocket)

WS 推送的消息全部经过 ECDH + AES-CBC 加密：

```json
{
    "iv": "Base64编码的16字节IV",
    "data": "Base64编码的AES-CBC密文",
    "mac": "Base64编码的HMAC-SHA256(iv+ciphertext)"
}
```

解密流程：
1. 验证 `mac` = HMAC-SHA256(macKey, iv + ciphertext)
2. AES-256-CBC 解密 ciphertext，密钥为 encKey，IV 为 iv
3. PKCS7 去填充
4. UTF-8 解码得到明文 JSON

密钥派生参见 [08-ECDH握手协议与加密流程详解](08-ECDH握手协议与加密流程详解.md)。
