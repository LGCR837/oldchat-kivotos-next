# 03 - 消息JSON格式与接口规范 (v1.4.x)

> ⭐ **核心文档** — 消息收发的协议层，第三方客户端开发者必读  
> 基于 jadx 反编译分析  
> 更新时间: 2026年8月  
> 所有字段均经反编译源码逐行验证

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
| `interactive` | 交互按钮消息 (dev2) | 按钮JSON | — | — |

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

### 3.1 私聊消息完整字段 (jadx 确认)

基于 `D.java` 发送逻辑和 `AbstractC0196a.java` / `ChatSearchActivity.java` 解析逻辑:

```json
{
    "id": "消息唯一ID (string)",
    "from_uid": "发送者UID (string)",
    "from_ncuid": "发送者NCUID (string, v1.4.x优先)",
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

### 3.2 搜索结果消息字段 (jadx 确认 `ChatSearchActivity.S0()`)

```json
{
    "id": "MSG_abc123",
    "from_uid": "U_sender",
    "msg_type": "text",
    "body": "消息内容",
    "created_at": 1690000000
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 消息唯一ID |
| `from_uid` | String | 发送者UID |
| `msg_type` | String | 消息类型 (默认 `"text"`) |
| `body` | String | 消息内容 |
| `created_at` | long | 创建时间戳 (秒级) |

### 3.3 发送请求字段 (jadx 确认 `D.java`)

**私聊发送** (`/direct/send`):
```json
{
    "to_uid": "接收者UID",
    "to_ncuid": "接收者NCUID (可选)",
    "msg_type": "text",
    "body": "消息内容"
}
```

**群聊发送** (`/groups/message/send`):
```json
{
    "group_id": "群ID",
    "msg_type": "text",
    "body": "消息内容"
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

### 4.4 v2 JSON 生成 (推断)

消息体由 `m0.U.e(activity, list)` 方法生成，该方法将 UI 层的消息组件列表序列化为 v2 JSON 格式。

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

**上传流程** (jadx 确认 `MomentComposeActivity`):
1. 选择图片 (最多9张)
2. 压缩: 最大1280px，最大400KB
3. 上传到 `/media` 端点，获取URL
4. 构造消息体

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

### 5.5 媒体上传接口

```
POST /v1/media
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**请求参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| file | binary | 文件二进制数据 |
| fileName | String | 文件名 |
| contentType | String | MIME类型 |

**响应**:
```json
{
    "url": "/uploads/abc123.jpg"
}
```

---

## 6. 红包消息格式

### 6.1 红包消息体

```json
{
    "msg_type": "red_packet",
    "body": "{\"packet_id\":\"rp_abc123\",\"total_amount\":8.88,\"total_count\":5}"
}
```

### 6.2 红包发送 API

**POST** `/redpackets/send`

**请求体** (jadx 确认 `RedPacketSendActivity.z0()`):

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | String | ❌ | 祝福语 (≤20字符) |
| `total_amount` | int | ✅ | 总金额 (分) |
| `total_count` | int | ✅ | 红包个数 |
| `cover_url` | String | ❌ | 封面URL |
| `to_uid` | String | ❌ | 私聊-接收者UID |
| `to_ncuid` | String | ❌ | 私聊-接收者NCUID |
| `group_id` | String | ❌ | 群-群组ID |

### 6.3 红包错误码 (jadx 确认)

| 错误字符串 | 说明 |
|---|---|
| `red_packet_insufficient` | 余额不足 |
| `red_packet_amount_invalid` | 金额无效 |
| `red_packet_count_invalid` | 数量无效 |
| `red_packet_amount_too_small` | 单个金额过小 |
| `red_packet_title_too_long` | 标题过长 |
| `invalid_cover_url` | 封面URL无效 |

### 6.4 红包封面上传

封面图片通过 `/media` 端点上传:
- 格式: JPEG
- 大小限制: 1MB
- 返回URL后填入 `cover_url` 字段

---

## 7. 消息搜索接口

### 7.1 私聊消息搜索 (NCUID, v1.4.x)

**源码**: `ChatSearchActivity.O0()`

```
GET /v1/direct/messages/search?with_uid=<UID>&with_ncuid=<NCUID>&q=<关键词>&kind=<类型>&limit=50&offset=0
Authorization: Bearer <token>
```

**查询参数详解**:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `with_uid` | String | ✅ | 对方用户UID |
| `with_ncuid` | String | ❌ | 对方用户NCUID (v1.4.x，非空时添加) |
| `q` | String | ✅ | 搜索关键词 |
| `kind` | String | ✅ | `"all"` / `"text"` / `"media"` |
| `limit` | int | ✅ | 每页数量 (固定50) |
| `offset` | int | ✅ | 偏移量 (用于分页) |

**分页逻辑** (jadx 确认):
- 首次搜索: `offset=0`
- 加载更多: `offset += 当前已加载数量`
- 判断是否有更多: `返回数量 >= 50`
- 去重: 使用 HashSet 存储已加载的消息ID

### 7.2 群消息搜索

```
GET /v1/groups/messages/search?group_id=<GID>&q=<关键词>&kind=<类型>&limit=50&offset=0
Authorization: Bearer <token>
```

### 7.3 搜索结果解析 (jadx 确认 `ChatSearchActivity.S0()`)

```json
{
    "messages": [
        {
            "id": "MSG_abc123",
            "from_uid": "U_sender",
            "msg_type": "text",
            "body": "消息内容",
            "created_at": 1690000000
        }
    ]
}
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
        "from_uid": "发送者UID",
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
        "from_uid": "发送者UID",
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

**源码**: `D.java` → `g()` 方法

```
POST /v1/direct/send
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
    "to_uid": "接收者UID",
    "to_ncuid": "接收者NCUID (可选)",
    "body": "消息内容（纯文本或v2 JSON）",
    "msg_type": "text"
}
```

**源码关键逻辑**:
```java
JSONObject jSONObject = new JSONObject();
jSONObject.put("to_uid", str2);
if (str3 != null && str3.length() > 0) {
    jSONObject.put("to_ncuid", str3);
}
jSONObject.put("msg_type", "text");
jSONObject.put("body", m0.U.e(activity, list));
```

### 10.2 发送群聊消息

**源码**: `D.java` → `h()` 方法

```
POST /v1/groups/message/send
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
    "group_id": "群ID",
    "body": "消息内容",
    "msg_type": "text"
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

## 13. 阅后即焚消息

### 13.1 消息格式

在 v2 JSON 中设置 `burn_after_seconds` 字段:

```json
{
    "v": 2,
    "text": "阅后即焚消息",
    "burn_after_seconds": 10,
    "mentions": null,
    "quote": null
}
```

### 13.2 查看界面

**源码**: `BurnSecureViewActivity.java`

**Intent 参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| `extra_burn_text` | String | 消息文本 |
| `extra_burn_seconds` | int | 焚毁秒数 |
| `extra_message_type` | String | 消息类型 |
| `extra_media_url` | String | 媒体URL |
| `extra_thumb_url` | String | 缩略图URL |

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

---

## 15. 好友数据模型 (k0.F)

**源码**: `k0/F.java` + `GroupCreateActivity.java` 解析逻辑

| JSON字段 | 混淆字段名 | 类型 | 说明 |
|---|---|---|---|
| `id` | `f7557a` | String | 数据库ID |
| `uid` | `f7558b` | String | 用户UID |
| `ncuid` | `f7559c` | String | 用户NCUID (v1.4.x) |
| `username` | `f7560d` | String | 用户名 |
| `display_name` | `f7561e` | String | 显示名 |
| `remark_name` | `f7562f` | String | 备注名 |
| `user_title` | `f7563g` | String | 用户头衔 |
| `avatar_url` | `f7564h` | String | 头像URL |
| (未确认) | `f7565i` | String | 未知字段 |
| (未确认) | `f7566j` | String | 未知字段 |
| (未确认) | `f7567k` | long | 未知字段 (可能是时间戳) |
| (未确认) | `f7568l` | boolean | 未知字段 |
| (未确认) | `f7569m` | String | 未知字段 |

**好友名称解析** (jadx 确认 `AbstractC0337g.c()`):
```
优先级: remark_name > display_name > username > uid
```

---

## 16. 交互按钮消息格式 (dev2新增)

### 16.1 消息结构

当 `msg_type === "interactive"` 时，body 包含按钮定义:

```json
{
  "msg_type": "interactive",
  "body": {
    "text": "用户张三申请加入群组「技术交流群」",
    "buttons": [
      [
        {"text": "同意", "action": "approve", "type": "primary"},
        {"text": "拒绝", "action": "reject", "type": "danger"}
      ]
    ]
  }
}
```

### 16.2 字段详解

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `body.text` | String | ✅ | 消息文本内容 |
| `body.buttons` | Array<Array> | ✅ | 按钮组 (二维数组，外层为行，内层为列) |
| `body.buttons[][].text` | String | ✅ | 按钮显示文本 |
| `body.buttons[][].action` | String | ✅ | 按钮动作标识 (回调时发送) |
| `body.buttons[][].type` | String | ✅ | 按钮样式: `primary`/`danger`/`default` |

### 16.3 按钮样式

| type | 视觉效果 | 使用场景 |
|---|---|---|
| `primary` | 蓝色/绿色 | 确认、同意、提交等正向操作 |
| `danger` | 红色 | 拒绝、删除、取消等负向操作 |
| `default` | 灰色 | 查看详情、跳转等中性操作 |

### 16.4 按钮布局

按钮按二维数组组织:
- 外层数组的每个元素代表一行
- 内层数组的元素代表该行中的按钮
- 每行按钮水平排列，行与行之间垂直堆叠

```json
// 示例: 2行布局
// 第一行: [同意] [拒绝]
// 第二行: [查看详情]
"buttons": [
  [
    {"text": "同意", "action": "approve", "type": "primary"},
    {"text": "拒绝", "action": "reject", "type": "danger"}
  ],
  [
    {"text": "查看详情", "action": "view_detail", "type": "default"}
  ]
]
```

### 16.5 按钮回调

用户点击按钮后，客户端发送回调:

```http
POST /v2/buttons/callback
Content-Type: application/json
Authorization: Bearer <token>

{
  "msg_id": "msg_123",
  "to_type": "group",
  "to_id": "group_456",
  "btn_index": 0,
  "tid": "txn_789",
  "nonce": "random_abc123",
  "action": "approve",
  "form_data": null
}
```

`btn_index` 计算方式: 按行优先顺序排列，从0开始。例如:
```
buttons[0][0] → index 0
buttons[0][1] → index 1
buttons[1][0] → index 2
```

### 16.6 使用场景

**审批流程**:
```json
{
  "msg_type": "interactive",
  "body": {
    "text": "用户张三申请加入群组「技术交流群」",
    "buttons": [[
      {"text": "同意", "action": "approve", "type": "primary"},
      {"text": "拒绝", "action": "reject", "type": "danger"}
    ]]
  }
}
```

**投票**:
```json
{
  "msg_type": "interactive",
  "body": {
    "text": "周末活动投票：",
    "buttons": [
      [
        {"text": "🎤 唱歌", "action": "vote_karaoke", "type": "default"},
        {"text": "🎳 保龄球", "action": "vote_bowling", "type": "default"}
      ],
      [
        {"text": "🎬 电影", "action": "vote_movie", "type": "default"},
        {"text": "🍲 聚餐", "action": "vote_dinner", "type": "default"}
      ]
    ]
  }
}
```

---

## 17. 频道数据模型 (dev2新增)

**源码**: `ChannelActivity.java` (dev2版本)

### 16.1 频道对象 (C0322b)

| JSON字段 | 混淆字段名 | 类型 | 说明 |
|---|---|---|---|
| `channel_id` / `id` | `f7522a` | String | 频道ID |
| `name` | `f7523b` | String | 频道名称 |
| `handle` | `f7524c` | String | 频道句柄 (@xxx) |
| `avatar_url` | `f7525d` | String | 频道头像URL |
| `subscribers` | `f7528g` | int | 订阅者数量 |
| `role` | `f7532k` | String | 用户角色 |
| `last_read_at` | `f7534m` | long | 最后阅读时间戳 |
| `notification_level` | `f7535n` | String | 通知级别 |

### 16.2 频道帖子对象 (C0321a)

| 混淆字段名 | 类型 | 说明 |
|---|---|---|
| `f7507c` | long | 帖子时间戳 (用于已读同步) |

### 16.3 频道角色

| 角色值 | 说明 | 权限 |
|---|---|---|
| `owner` | 频道主 | 全部权限 |
| `admin` | 管理员 | 可发帖、管理 |
| `publisher` | 发布者 | 可发帖 |
| `subscriber` | 订阅者 | 只读 |

### 16.4 频道通知级别

| 值 | 说明 |
|---|---|
| `none` | 静音 |
| `all` | 接收所有通知 |

### 16.5 频道分享链接

格式: `https://oc.mcl0.dpdns.org/c/{handle}`

---

## 18. 播放列表数据模型 (k0.z)

**源码**: `s0.java` → `h()` 解析方法

| JSON字段 | 类型 | setter方法 | 说明 |
|---|---|---|---|
| `id` | String | `l()` | 播放列表ID |
| `name` | String | `m()` | 播放列表名称 |
| `cover_url` | String | `j()` | 封面URL |
| `created_at` | long | `k()` | 创建时间 (秒级，客户端×1000) |
| `updated_at` | long | `o()` | 更新时间 (秒级，客户端×1000) |
| `songs` | JSONArray | `n()` | 歌曲列表 |

歌曲对象由 `k0.y.a(JSONObject)` 解析，每首歌包含 `song_id` (f7790a) 字段。

---

## 19. 签到墙数据模型

### 18.1 签到墙总览 (C0334d)

| 混淆字段名 | 类型 | 说明 |
|---|---|---|
| `f7599a` | int | 今日签到总数 |
| `f7600b` | boolean | 当前用户是否已签到 |
| `f7601c` | boolean | 当前用户是否已留言 |
| `f7602d` | C0333c | 当前用户的留言对象 |
| `f7603e` | List<C0333c> | 随机留言列表 |

### 18.2 留言对象 (C0333c)

| 混淆字段名 | 类型 | 说明 |
|---|---|---|
| `f7584a` | String | 留言ID (post_id) |
| `f7594k` | String | 留言者头像URL |
| `f7596m` | int | 点赞数 |
| `f7597n` | int | 评论数 |
| `f7598o` | boolean | 当前用户是否已点赞 |

**辅助方法**:
- `a()` — 获取留言文本内容
- `b()` — 获取留言图片URL
- `c()` — 判断是否有图片
