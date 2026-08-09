# 03 - 消息JSON格式与接口规范 (v1.4.x)

> ⭐ **核心文档** — 消息收发的协议层，第三方客户端开发者必读  
> 基于 jadx 反编译分析  
> 更新时间: 2026年8月

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

## 2. 用户标识体系：UID → NCUID 迁移 (jadx 源码确认) ⭐

### 2.1 变更概述

v1.3.61 引入了 NCUID (New Chat UID) 体系，v1.4.x 进一步扩展了 NCUID 的使用范围，从14处增加到30+处。

### 2.2 NCUID 源码使用详情 (jadx 确认)

#### 旧版 (v1.3.61) — 14处

| Activity | 代码位置 | NCUID 操作 |
|---|---|---|
| LoginActivity | `optString("ncuid")`, `putString("my_ncuid")` | 登录后存储 |
| MomentsActivity | `getString("my_ncuid")`, `putExtra("ncuid")` | 朋友圈标识 |
| UserSpaceActivity | `getString("my_ncuid")`, `getExtra("ncuid")` | 用户空间查询 |
| ChatActivity | `optString("from_ncuid")` | 消息发送者 |
| GroupChatActivity | `optString("from_ncuid")` | 群消息发送者 |
| FriendListActivity | `optString("ncuid")` | 好友列表 |
| SettingsActivity | `putExtra("ncuid")` | 跳转传递 |

#### 新版 (v1.4.x) — 30+处 (大幅增加)

**保留不变的 (7处):**
- LoginActivity, MomentsActivity, UserSpaceActivity, ChatActivity, GroupChatActivity — 同上

**新增的 (16+处):**

| Activity/类 | NCUID 操作 | 场景 |
|---|---|---|
| AbstractActivityC0197b | `putExtra("to_ncuid")`, `putExtra("friend_ncuid")` | 基类传递NCUID |
| ChatSearchActivity | `&with_ncuid=`, `getExtra("friend_ncuid")` | 消息搜索 |
| ChatSettingsActivity | `putExtra("friend_ncuid")`, `put("friend_ncuid")` | 好友设置 |
| GroupCreateActivity | `put("member_ncuids", jsonArray)` | 创建群组 |
| GroupInviteActivity | `put("user_ncuid")` | 邀请入群 |
| RedPacketSendActivity | `getExtra("to_ncuid")`, `put("to_ncuid")` | 红包发送 |
| MomentCommentsActivity | `optString("from_ncuid")` | 动态评论 |
| FriendListActivity | `put("user_ncuid")` | 好友操作 |
| ChatListActivity | `putExtra("friend_ncuid")`, `put("to_ncuid")` | 聊天列表 |
| RecentChats | `putExtra("friend_ncuid")`, `put("to_ncuid")` | 最近聊天 |
| MessageSendHelper | `put("to_ncuid")` | 发送消息 |

### 2.3 迁移状态

| 场景 | 旧字段 | 新字段 | v1.4.x 状态 |
|---|---|---|---|
| 登录响应 | `user.uid` | `user.ncuid` | ✅ 两者都返回 |
| 用户资料查询 | `?uid=xxx` | `?ncuid=xxx` | ✅ 两者都支持 |
| 群成员列表 | `member.uids` | `member.ncuids` | ✅ 切换到ncuids |
| 私聊消息搜索 | `?with_uid=xxx` | `?with_ncuid=xxx` | ✅ **v1.4.x新增支持** |
| 群消息搜索 | `?group_id=xxx` | — | ✅ 支持 |
| 好友列表 | `friend.uid` | `friend.ncuid` | ⚠️ 仅返回 uid |
| 好友申请 | `from_uid` | `from_ncuid` | ⚠️ 仅返回 from_uid |
| 消息历史查询 | `?with_uid=xxx` | `?with_ncuid=xxx` | ⚠️ 并行支持 |
| 发送消息目标 | `to_uid` | `to_ncuid` | ⚠️ 并行支持 |
| 标记已读 | `with_uid` | `with_ncuid` | ⚠️ 并行支持 |

### 2.4 v1.4.x NCUID 字段完整列表

| 参数 | 说明 | 来源 |
|---|---|---|
| `my_ncuid` | 当前用户NCUID | v1.3.61保留 |
| `from_ncuid` | 消息发送方NCUID | v1.3.61保留 |
| `with_ncuid` | 私聊消息搜索/历史查询 | v1.4.x新增 |
| `friend_ncuid` | 好友标识 | v1.4.x新增 |
| `user_ncuid` | 用户标识 | v1.4.x新增 |
| `target_ncuid` | 目标用户标识 | v1.4.x新增 |
| `reader_ncuid` | 已读者标识 | v1.4.x新增 |
| `peer_ncuid` | 对话方标识 | v1.4.x新增 |
| `to_ncuid` | 消息接收方 | v1.4.x新增 |
| `direct_ncuid_` | 私聊NCUID前缀存储 | v1.4.x新增 |
| `member_ncuids` | 群成员NCUID列表(JSONArray) | v1.4.x新增 |

### 2.5 客户端兼容策略（推荐）

**读取（响应解析）**：优先读取新字段，回退到旧字段
```javascript
function getUid(obj) {
    return obj.ncuid || obj.uid || '';
}
```

**写入（请求构造）**：逐步迁移到 NCUID
```javascript
// v1.4.x: 搜索接口已支持 with_ncuid
GET /v1/direct/messages/search?with_ncuid=xxx&keyword=xxx
// 历史查询: 仍建议使用 with_uid 作为兼容方案
GET /v1/direct/messages/v2?with_uid=xxx&limit=100
```

**NCUID 迁移策略:**
```
读取优先级: ncuid > uid (优先使用NCUID，回退到UID)
写入策略:  同时携带 uid + ncuid (确保新旧后端兼容)
存储策略:  新增 direct_ncuid_ 前缀，NCUID独立存储
```

---

## 3. 消息对象结构 (通用字段)

```json
{
    "id": "消息唯一ID (string)",
    "from_ncuid": "发送者NCUID (string, v1.4.x优先)",
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

---

## 4. 文本消息 v2 格式 ⭐

当 `msg_type === "text"` 且 `body` 以 `{` 开头时，尝试解析为 v2 JSON。

### 4.1 v2 基本结构

```json
{
    "v": 2,
    "text": "消息文本内容",
    "mentions": null,
    "quote": null,
    "burn_after_seconds": 0
}
```

### 4.2 完整 v2 结构

```json
{
    "v": 2,
    "text": "你好 @张三，看看这个",
    "mentions": [
        {
            "ncuid": "USER_NCUID_123",
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

### 4.3 v2 字段详解

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | int | ✅ | 版本号，固定为 `2` |
| `text` | string | ✅ | 消息文本，支持 `\n` 换行 |
| `mentions` | array | ❌ | @提及的用户列表 |
| `mentions[].ncuid` | string | ✅ | 被@用户的NCUID (v1.4.x) |
| `mentions[].uid` | string | ⚠️ | 被@用户的UID (旧版兼容) |
| `mentions[].name` | string | ✅ | 被@用户的显示名 |
| `quote` | object | ❌ | 引用回复 |
| `quote.id` | string | ✅ | 被引用消息的ID |
| `quote.from_uid` | string | ✅ | 被引用消息的发送者UID |
| `quote.from_name` | string | ✅ | 被引用消息的发送者名称 |
| `quote.type` | string | ❌ | 被引用消息的类型 (默认 "text") |
| `quote.text` | string | ✅ | 被引用消息的文本（截取前200字符） |
| `burn_after_seconds` | int | ❌ | 阅后即焚秒数，0或不填表示普通消息 |

---

## 5. 媒体类消息格式

### 5.1 图片消息

```json
{
    "msg_type": "image",
    "body": "",
    "media_url": "/uploads/abc123.jpg",
    "thumb_url": "/uploads/abc123_thumb.jpg"
}
```

### 5.2 语音消息

```json
{
    "msg_type": "voice",
    "body": "",
    "media_url": "/uploads/voice_abc123.amr"
}
```

### 5.3 视频消息

```json
{
    "msg_type": "video",
    "body": "",
    "media_url": "/uploads/video_abc123.mp4",
    "thumb_url": "/uploads/video_abc123_thumb.jpg"
}
```

### 5.4 文件消息

```json
{
    "msg_type": "resource",
    "body": "document.pdf",
    "media_url": "/uploads/file_abc123.pdf"
}
```

---

## 6. 红包消息格式

```json
{
    "msg_type": "red_packet",
    "body": "{\"packet_id\":\"rp_abc123\",\"total_amount\":8.88,\"total_count\":5}"
}
```

### 红包 API

| 操作 | 端点 | 方法 | 请求体 |
|---|---|---|---|
| 发送红包 | `/redpackets/send` | POST | `{title, total_amount, total_count, group_id 或 to_ncuid, cover_url?}` |
| 领取红包 | `/redpackets/claim` | POST | `{packet_id}` |

**v1.4.x 变化**: 红包发送使用 `to_ncuid` 替代 `to_uid` (RedPacketSendActivity 确认)。

---

## 7. 消息搜索接口

### 7.1 私聊消息搜索 (NCUID, v1.4.x)

```
GET /v1/direct/messages/search?with_ncuid=<NCUID>&keyword=<关键词>
Authorization: Bearer <token>
```

### 7.2 群消息搜索

```
GET /v1/groups/messages/search?group_id=<GID>&keyword=<关键词>
Authorization: Bearer <token>
```

---

## 8. 群消息增量获取 (v1.4.x新增)

```
GET /v1/groups/messages/after?group_id=<GID>&after=<时间戳>
Authorization: Bearer <token>
```

获取指定时间戳之后的群消息，用于增量同步。

---

## 9. WebSocket 推送格式

所有 WS 推送都经过 ECDH 加密信封包装，解密后为以下 JSON：

### 9.1 私聊消息推送

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

### 9.2 群聊消息推送

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

### 9.3 私聊撤回推送

```json
{
    "type": "direct_recall",
    "data": {
        "message_id": "被撤回的消息ID",
        "from_ncuid": "撤回者NCUID"
    }
}
```

### 9.4 群聊撤回推送

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

### 9.5 已读回执推送

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

## 10. 消息发送接口

### 10.1 发送私聊消息 (NCUID)

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

**v1.4.x**: `MessageSendHelper(C0218x)` 使用 `put("to_ncuid")` 构造发送请求。

### 10.2 发送群聊消息

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

---

## 11. 消息历史查询接口

### 11.1 私聊历史

```
GET /v1/direct/messages/v2?with_ncuid=<NCUID>&limit=100&offset=0
Authorization: Bearer <token>
```

- 返回顺序：**DESC**（新消息在前），客户端需反转为 ASC
- 分页：`offset` 为已加载数量，`limit` 为每页大小

### 11.2 群聊历史

```
GET /v1/groups/messages/v2?group_id=<GID>&limit=100&offset=0
Authorization: Bearer <token>
```

### 11.3 撤回消息

```
DELETE /v1/direct/messages/<message_id>
DELETE /v1/groups/messages/<message_id>
Authorization: Bearer <token>
```

限制：仅能撤回自己发送的、2分钟内的消息。

---

## 12. 未读消息接口

### 12.1 私聊未读

```
POST /v1/direct/unread
Content-Type: application/json
{"limit": 200}
```

### 12.2 群聊未读

```
POST /v1/groups/unread
Content-Type: application/json
{"limit": 200}
```

### 12.3 标记已读

```
POST /v1/direct/read   {"with_ncuid": "对方NCUID"}
POST /v1/groups/read   {"group_id": "群ID"}
```

---

## 13. 媒体上传接口

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
