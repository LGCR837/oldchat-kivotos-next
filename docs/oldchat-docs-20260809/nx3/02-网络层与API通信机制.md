# 02 - 网络层与 API 通信机制 (v1.4.x)

> 基于 jadx 反编译分析  
> 更新时间: 2026年8月  
> 本文档详细记录了每个 API 端点的完整请求/响应字段，均来自反编译源码验证。
>
> **补充文档**: [12-v2签名机制与加密信封及bad_signature排查指南.md](./12-v2签名机制与加密信封及bad_signature排查指南.md)  
> 包含 v2 签名算法完整实现、ECDH 握手流程、响应结构 Gateway 对比等未覆盖内容。

---

## 1. HTTP 客户端架构

### 1.1 底层实现

- **HTTP库**: OkHttp
- **TLS库**: **Conscrypt** (v1.4.x新增，替代系统默认TLS实现)
- **封装类**: `h0.c` (核心请求工具类)、`h0.d` (辅助请求工具类)
- **连接管理**: `g0.j` (WebSocket/长连接管理器)
- **网络状态检测**: `o0.G`
- **服务器配置**: `o0.U` (管理 Base URL)

### 1.2 请求流程

```
UI层 (Activity/Fragment)
    ↓ 调用 h0.c 方法
请求封装层 (h0.c)
    ├── 添加 Authorization: Bearer <token>
    ├── 构造请求体 (JSON/Multipart)
    └── 通过 OkHttp 发送
        ↓
    OkHttp + Conscrypt TLS
        ├── HTTPS (Conscrypt TLS 1.0-1.3)
        └── HTTP (usesCleartextTraffic=true)
```

### 1.3 请求方法签名 (jadx 源码确认)

| 方法 | 签名 | 用途 |
|---|---|---|
| `h0.c.T` | `T(String path, String token, callback)` | GET 请求 |
| `h0.c.U` | `U(String path, JSONObject body, String token, callback)` | POST 请求 (JSON) |
| `h0.c.V` | `V(String path, byte[] data, String fileName, String contentType, String token, callback)` | Multipart 文件上传 |
| `h0.d.W` | `W(String path, JSONObject body, String token, callback)` | POST 请求 (v2 系列) |

### 1.4 回调接口 (jadx 确认)

```java
// h0.c.j — 通用回调接口
public interface j {
    void a(String response);           // 成功回调
    void b(int errorCode, String error); // 失败回调
}

// h0.d.i — v2 通用回调接口
public interface i {
    void a(String response);           // 成功回调
    void b(int errorCode, String error); // 失败回调
}
```

### 1.5 Conscrypt TLS 集成 (jadx 确认)

v1.4.x 引入完整 Conscrypt 库 (156个Java文件在 `org.conscrypt` 包)。所有 oldchat 包下的类都 `import org.conscrypt.BuildConfig`。Conscrypt 提供 TLS 1.0-1.3 支持，原生 JNI 加速 (`libconscrypt_jni.so`)。

---

## 2. 已知 API 端点完整字段 (jadx 源码逐行确认)

### 2.1 认证相关

#### 2.1.1 POST `/auth/login` — 用户登录

**源码**: `LoginActivity.java` → `A0(String identifier, String password)` 方法

**请求体** (`application/json`):

| 字段 | 类型 | 必填 | 获取方式 | 说明 |
|---|---|---|---|---|
| `identifier` | String | ✅ | 用户输入 (EditText) | 用户名/手机号/邮箱 |
| `password` | String | ✅ | 用户输入 (EditText) | 密码 |
| `device_id` | String | ✅ | `AbstractC0611x.b(context)` | 设备唯一ID |
| `imei` | String | ✅ | `AbstractC0611x.d(context)` | IMEI号 |
| `device_name` | String | ✅ | `AbstractC0611x.c()` | 设备型号名称 |
| `platform` | String | ✅ | 硬编码 `"android"` | 平台标识 |
| `app_version` | String | ✅ | `AbstractC0611x.a(context)` | 应用版本号 |

**请求示例**:
```json
{
    "identifier": "user123",
    "password": "pass456",
    "device_id": "abc-123-def",
    "imei": "860000000000000",
    "device_name": "Xiaomi 14",
    "platform": "android",
    "app_version": "1.4.0"
}
```

**成功响应** (`200 OK`):
```json
{
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "user": {
        "id": "12345",
        "uid": "U_abc123",
        "ncuid": "NC_xyz789"
    }
}
```

**响应字段解析** (jadx 确认):

| 字段 | 类型 | 说明 |
|---|---|---|
| `access_token` | String | Bearer Token，用于后续请求 Authorization 头 |
| `refresh_token` | String | Token 刷新令牌 |
| `user.id` | String | 数据库自增ID |
| `user.uid` | String | 用户唯一标识 (旧版) |
| `user.ncuid` | String | 用户NCUID (v1.3.61+，optString可选) |

**错误响应** (jadx 确认):

| HTTP状态码 | 错误信息 | 说明 |
|---|---|---|
| 401 | `invalid_credentials` | 用户名或密码错误 |
| 403 | `user_banned` / `device_banned` | 账号/设备被封禁 |
| 429 | `rate_limited` | 请求过于频繁 |

**Token 存储** (jadx 确认 `D0` 方法):
```
SharedPreferences("auth")
  .putString("access_token", token)
  .putString("refresh_token", refreshToken)
  .putString("user_id", userId)
  .putString("my_uid", uid)
  .putString("my_ncuid", ncuid)
```

#### 2.1.2 注册 (v1.4.x 变化)

**旧版**: `RegisterActivity` → POST `/auth/register`
**新版**: `LoginActivity.B0()` → 浏览器跳转

```java
// LoginActivity.B0() 源码
Intent intent = new Intent(Intent.ACTION_VIEW, 
    Uri.parse(base_url + "/register"));
```

v1.4.x 移除了原生注册页面，改为浏览器打开。

### 2.2 好友相关

#### 2.2.1 POST `/friends/request` — 发送好友请求

**源码**: `AddFriendActivity.java` → `u0(String uid, boolean closeAfter)` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to_uid` | String | ✅ | 目标用户UID |

**请求示例**:
```json
{
    "to_uid": "U_target123"
}
```

**成功响应**: 无特定响应体，HTTP 200 即成功

**错误响应**:

| HTTP状态码 | 说明 |
|---|---|
| 404 | 用户不存在 |
| 409 | 已是好友 / 已发送请求 |

#### 2.2.2 POST `/groups/join` — 加入群组

**源码**: `AddFriendActivity.java` → `t0(String groupId, boolean closeAfter)` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `group_id` | String | ✅ | 群组ID (大写) |

**成功响应**:
```json
{
    "status": "joined"
}
```

**响应字段**:

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | String | `"joined"` / `"pending"` / 其他 |

**错误响应**:

| HTTP状态码 | 说明 |
|---|---|
| 404 | 群组不存在 |

#### 2.2.3 GET `/friends` — 获取好友列表

**源码**: `GroupCreateActivity.java` → `t0()` 方法

**请求头**: `Authorization: Bearer <token>`

**成功响应**:
```json
{
    "friends": [
        {
            "id": "12345",
            "uid": "U_abc123",
            "ncuid": "NC_xyz789",
            "username": "user123",
            "display_name": "张三",
            "remark_name": "老张",
            "user_title": "VIP会员",
            "avatar_url": "https://..."
        }
    ]
}
```

**好友对象字段** (jadx 确认，k0.F 模型):

| 字段 | 混淆名 | 类型 | 说明 |
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

### 2.3 消息发送相关

#### 2.3.1 POST `/direct/send` — 发送私聊消息

**源码**: `D.java` → `g()` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to_uid` | String | ✅ | 接收者UID |
| `to_ncuid` | String | ❌ | 接收者NCUID (v1.4.x，非空时添加) |
| `msg_type` | String | ✅ | 消息类型 (固定 `"text"`) |
| `body` | String | ✅ | 消息内容 (由 `m0.U.e()` 生成) |

**请求示例**:
```json
{
    "to_uid": "U_target123",
    "to_ncuid": "NC_target456",
    "msg_type": "text",
    "body": "你好！"
}
```

**源码关键逻辑** (jadx 确认):
```java
JSONObject jSONObject = new JSONObject();
jSONObject.put("to_uid", str2);
if (str3 != null && str3.length() > 0) {
    jSONObject.put("to_ncuid", str3);  // 仅非空时添加
}
jSONObject.put("msg_type", "text");
jSONObject.put("body", m0.U.e(activity, list));
h0.c.U("/direct/send", jSONObject, str, callback);
```

#### 2.3.2 POST `/groups/message/send` — 发送群聊消息

**源码**: `D.java` → `h()` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `group_id` | String | ✅ | 群组ID |
| `msg_type` | String | ✅ | 消息类型 (固定 `"text"`) |
| `body` | String | ✅ | 消息内容 |

**请求示例**:
```json
{
    "group_id": "GRP_abc123",
    "msg_type": "text",
    "body": "大家好！"
}
```

### 2.4 群组相关

#### 2.4.1 POST `/groups/create` — 创建群组

**源码**: `GroupCreateActivity.java` → `s0()` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | String | ✅ | 群名称 |
| `member_uids` | JSONArray | ✅ | 成员UID数组 |
| `member_ncuids` | JSONArray | ❌ | 成员NCUID数组 (v1.4.x，仅全部有效时添加) |

**请求示例**:
```json
{
    "name": "测试群",
    "member_uids": ["U_abc", "U_def", "U_ghi"],
    "member_ncuids": ["NC_abc", "NC_def", "NC_ghi"]
}
```

**源码关键逻辑** (jadx 确认):
```java
jSONObject.put("name", trim);
jSONObject.put("member_uids", jSONArray);
if (i2 > 0 && jSONArray2.length() == i2) {
    jSONObject.put("member_ncuids", jSONArray2);
    // 仅当所有成员都有NCUID时才添加
}
```

**成功响应**:
```json
{
    "group_id": "GRP_xyz789"
}
```

#### 2.4.2 GET `/groups/messages/after` — 增量获取群消息 (v1.4.x新增)

**查询参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| `group_id` | String | 群组ID |
| `after` | long | 时间戳，获取此时间之后的消息 |

### 2.5 动态/朋友圈相关

#### 2.5.1 POST `/moments` — 发布动态

**源码**: `MomentComposeActivity.java` → `s0(String body, String imageUrl)` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `body` | String | ❌ | 动态文本内容 (可为空字符串) |
| `image_url` | String | ❌ | 图片URL (多张用逗号分隔，可为空字符串) |

**请求示例**:
```json
{
    "body": "今天天气真好",
    "image_url": "https://example.com/img1.jpg,https://example.com/img2.jpg"
}
```

**图片上传流程** (jadx 确认):
1. 选择图片 (最多9张)
2. 压缩到 1280px / 400KB
3. 逐张上传到 `/media` 端点
4. 收集返回的URL
5. 逗号拼接后作为 `image_url` 字段

### 2.6 红包相关

#### 2.6.1 POST `/redpackets/send` — 发送红包

**源码**: `RedPacketSendActivity.java` → `z0()` 方法

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | String | ❌ | 红包祝福语 (≤20字符) |
| `total_amount` | int | ✅ | 总金额 (分) |
| `total_count` | int | ✅ | 红包个数 (群红包≥2) |
| `cover_url` | String | ❌ | 封面图片URL (通过 `/media` 上传) |
| `to_uid` | String | ❌* | 私聊红包-接收者UID |
| `to_ncuid` | String | ❌* | 私聊红包-接收者NCUID |
| `group_id` | String | ❌* | 群红包-群组ID |

> *注: `to_uid`/`to_ncuid` 和 `group_id` 二选一

**请求示例 (群红包)**:
```json
{
    "title": "恭喜发财",
    "total_amount": 888,
    "total_count": 5,
    "group_id": "GRP_xyz789"
}
```

**请求示例 (私聊红包)**:
```json
{
    "title": "生日快乐",
    "total_amount": 1000,
    "total_count": 1,
    "to_uid": "U_target123",
    "to_ncuid": "NC_target456"
}
```

**错误响应** (jadx 确认的错误码):

| 错误信息 | 说明 |
|---|---|
| `red_packet_insufficient` | 余额不足 |
| `red_packet_amount_invalid` | 金额无效 |
| `red_packet_count_invalid` | 数量无效 |
| `red_packet_amount_too_small` | 单个金额过小 |
| `red_packet_title_too_long` | 标题过长 |
| `invalid_cover_url` | 封面URL无效 |

### 2.7 签到相关

#### 2.7.1 签到墙 API

**源码**: `DailyCheckInWallActivity.java` + `AbstractC0213s` 类

签到墙功能由 `AbstractC0213s` 工具类封装，包含以下操作:

| 方法 | 说明 |
|---|---|
| `AbstractC0213s.d(token, callback)` | 加载签到墙数据 |
| `AbstractC0213s.e(token, callback)` | 执行签到 |
| `AbstractC0213s.h(token, postId, callback)` | 加载点赞列表 |
| `AbstractC0213s.j(token, postId, isLike, callback)` | 点赞/取消点赞 |
| `AbstractC0213s.k(token, imageData, callback)` | 上传签到图片 |
| `AbstractC0213s.b(token, body, imageUrl, thumbUrl, callback)` | 发布留言 |

**签到墙数据模型** (`C0334d`):

| 字段 | 混淆名 | 类型 | 说明 |
|---|---|---|---|
| 签到总数 | `f7599a` | int | 今日签到人数 |
| 已签到 | `f7600b` | boolean | 当前用户是否已签到 |
| 已留言 | `f7601c` | boolean | 当前用户是否已留言 |
| 今日留言 | `f7602d` | C0333c | 当前用户的留言对象 |
| 随机留言列表 | `f7603e` | List<C0333c> | 可浏览的随机留言 |

**留言对象模型** (`C0333c`):

| 字段 | 混淆名 | 类型 | 说明 |
|---|---|---|---|
| post_id | `f7584a` | String | 留言ID |
| 头像URL | `f7594k` | String | 留言者头像 |
| 点赞数 | `f7596m` | int | 点赞数量 |
| 评论数 | `f7597n` | int | 评论数量 |
| 已点赞 | `f7598o` | boolean | 当前用户是否已点赞 |

### 2.8 消息搜索

#### 2.8.1 私聊消息搜索

**源码**: `ChatSearchActivity.java` → `O0()` 方法

**GET** `/direct/messages/search`

**查询参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| `with_uid` | String | 对方用户UID |
| `with_ncuid` | String | 对方用户NCUID (v1.4.x，非空时添加) |
| `q` | String | 搜索关键词 |
| `kind` | String | 搜索类型: `"all"` / `"text"` / `"media"` |
| `limit` | int | 每页数量 (固定50) |
| `offset` | int | 偏移量 |

**URL 构造** (jadx 确认):
```java
sb.append("/direct/messages/search?with_uid=");
sb.append(encode(this.f2754M));
if (str2 != null && str2.length() > 0) {
    sb.append("&with_ncuid=");
    sb.append(encode(this.f2755N));
}
sb.append("&q=");
sb.append(encode(str));
sb.append("&kind=");
sb.append(this.f2766Y);
sb.append("&limit=50&offset=");
sb.append(i2);
```

**成功响应**:
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

**搜索结果字段** (jadx 确认 `S0` 方法):

| 字段 | 类型 | 说明 |
|---|---|---|
| `messages` | JSONArray | 消息数组 |
| `messages[].id` | String | 消息ID |
| `messages[].from_uid` | String | 发送者UID |
| `messages[].msg_type` | String | 消息类型 (默认 `"text"`) |
| `messages[].body` | String | 消息内容 |
| `messages[].created_at` | long | 创建时间戳 |

#### 2.8.2 群消息搜索

**GET** `/groups/messages/search`

**查询参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| `group_id` | String | 群组ID |
| `q` | String | 搜索关键词 |
| `kind` | String | 搜索类型 |
| `limit` | int | 每页数量 |
| `offset` | int | 偏移量 |

### 2.9 频道相关 (v1.4.x/dev2新增)

**源码**: `ChannelActivity.java` (dev2版本)

#### 2.9.1 POST `/v2/channels/subscribe` — 订阅频道

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel_id` | String | ✅ | 频道ID |

#### 2.9.2 POST `/v2/channels/unsubscribe` — 取消订阅频道

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel_id` | String | ✅ | 频道ID |

#### 2.9.3 POST `/v2/channels/notifications` — 设置频道通知级别

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel_id` | String | ✅ | 频道ID |
| `notification_level` | String | ✅ | `"none"` (静音) / `"all"` (开启) |

**频道数据模型** (`C0322b`，jadx 确认):

| 字段 | 混淆名 | 类型 | 说明 |
|---|---|---|---|
| channel_id | `f7522a` | String | 频道ID |
| name | `f7523b` | String | 频道名称 |
| handle | `f7524c` | String | 频道句柄 (@xxx) |
| avatar_url | `f7525d` | String | 频道头像 |
| subscriber_count | `f7528g` | int | 订阅者数量 |
| role | `f7532k` | String | 用户角色: `owner`/`admin`/`publisher`/`subscriber` |
| last_read_at | `f7534m` | long | 最后阅读时间戳 |
| notification_level | `f7535n` | String | 通知级别: `none`/`all` |

### 2.10 音乐播放列表同步

#### 2.10.1 POST `/music/playlists/sync` — 同步播放列表

**源码**: `s0.java` → `j()` 方法

**请求体**:

```json
{
    "playlists": [
        {
            "id": "playlist_001",
            "name": "我的最爱",
            "cover_url": "https://...",
            "songs": [
                {
                    "song_id": "song_001",
                    "song": { ... }
                }
            ]
        }
    ]
}
```

**播放列表字段** (jadx 确认 `d()` 方法):

| 字段 | 类型 | 说明 |
|---|---|---|
| `playlists` | JSONArray | 播放列表数组 |
| `playlists[].id` | String | 播放列表ID |
| `playlists[].name` | String | 播放列表名称 |
| `playlists[].cover_url` | String | 封面URL |
| `playlists[].songs` | JSONArray | 歌曲数组 (上限200首) |
| `playlists[].songs[].song_id` | String | 歌曲ID |
| `playlists[].songs[].song` | Object | 歌曲详情对象 |

**限制**: 本地歌单上限5个，每歌单上限200首

#### 2.10.2 GET `/music/playlists` — 获取播放列表

**成功响应**:
```json
{
    "items": [
        {
            "id": "playlist_001",
            "name": "我的最爱",
            "cover_url": "https://...",
            "created_at": 1690000000,
            "updated_at": 1690000000,
            "songs": [
                {
                    "song": { ... }
                }
            ]
        }
    ]
}
```

**响应解析** (jadx 确认 `h()` 方法):

| 字段 | 类型 | 说明 |
|---|---|---|
| `items` | JSONArray | 播放列表数组 |
| `items[].id` | String | 播放列表ID |
| `items[].name` | String | 名称 |
| `items[].cover_url` | String | 封面URL |
| `items[].created_at` | long | 创建时间 (秒级时间戳，客户端×1000) |
| `items[].updated_at` | long | 更新时间 (秒级时间戳，客户端×1000) |
| `items[].songs` | JSONArray | 歌曲数组 |
| `items[].songs[].song` | Object | 歌曲对象 (由 `k0.y.a()` 解析) |

### 2.11 交互按钮系统 (dev2新增)

**源码**: `InteractiveMessageRenderer.java` 等 (dev2版本)

#### 2.11.1 POST `/v2/buttons/callback` — 按钮点击回调

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `msg_id` | String | ✅ | 消息ID (被点击的消息) |
| `to_type` | String | ✅ | 目标类型: `"direct"` (私聊) / `"group"` (群聊) |
| `to_id` | String | ✅ | 目标ID (用户ID或群组ID) |
| `btn_index` | int | ✅ | 按钮索引 (从0开始，行优先排列) |
| `tid` | String | ✅ | 事务ID (UUID，用于追踪请求) |
| `nonce` | String | ✅ | 随机数 (防重放攻击) |
| `action` | String | ✅ | 按钮动作标识 |
| `form_data` | String | ❌ | 表单数据 (可选，用于带表单的按钮) |

**请求示例**:
```json
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

**成功响应**:
```json
{
  "status": "ok",
  "message": "操作已提交"
}
```

**错误响应**:
```json
{
  "status": "error",
  "code": 400,
  "message": "按钮已被点击"
}
```

**交互按钮消息格式**:
```json
{
  "msg_type": "interactive",
  "body": {
    "text": "请选择操作",
    "buttons": [
      [
        {"text": "同意", "action": "approve", "type": "primary"},
        {"text": "拒绝", "action": "reject", "type": "danger"}
      ],
      [
        {"text": "查看详情", "action": "view_detail", "type": "default"}
      ]
    ]
  }
}
```

**按钮样式**:

| type | 说明 | 使用场景 |
|---|---|---|
| `primary` | 主要按钮 (蓝色/绿色) | 确认、同意、提交 |
| `danger` | 危险按钮 (红色) | 拒绝、删除、取消 |
| `default` | 默认按钮 (灰色) | 查看详情、跳转 |

---

### 2.12 文件上传系统 (dev2重构)

#### 2.12.1 POST `/v2/files/check` — 文件秒传检查 (dev2新增)

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sha256` | String | ✅ | 文件SHA256哈希 |
| `size_bytes` | long | ✅ | 文件大小 (字节) |

**请求示例**:
```json
{
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size_bytes": 1048576
}
```

**响应 (文件已存在)**:
```json
{
  "exists": true,
  "url": "/uploads/media/e3b0c442.jpg"
}
```

**响应 (文件不存在)**:
```json
{
  "exists": false,
  "url": null
}
```

**秒传流程**:
```
1. 客户端计算文件SHA256
2. POST /v2/files/check {sha256, size_bytes}
3. 如果 exists=true → 直接使用 url，跳过上传
4. 如果 exists=false → 执行正常上传流程
```

---

#### 2.12.2 POST `/v2/files/upload` — 文件上传v2 (dev2新增)

替代旧的 `/files/upload`、`/v1/files/upload`。

**Content-Type**: `multipart/form-data`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | binary | ✅ | 文件二进制数据 |
| `sha256` | String | ❌ | 文件SHA256哈希 |
| `mime` | String | ❌ | MIME类型 |

**成功响应**:
```json
{
  "url": "/uploads/media/photo_123.jpg",
  "filename": "photo.jpg",
  "size": 102400,
  "mime": "image/jpeg",
  "original_url": "/uploads/media/photo_123.jpg",
  "file_upload_base_url": "https://cdn.oldchat.com/uploads"
}
```

**响应字段**:

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | String | 文件URL |
| `filename` | String | 文件名 |
| `size` | long | 文件大小 (字节) |
| `mime` | String | MIME类型 |
| `original_url` | String | 原始URL |
| `file_upload_base_url` | String | 上传基础URL |

---

#### 2.12.3 POST `/v2/resources/upload` — 资源上传v2 (dev2新增)

替代旧的 `/resources/upload`。

**Content-Type**: `multipart/form-data`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | binary | ✅ | 文件二进制数据 |
| `type` | String | ✅ | 资源类型 (如 `"avatar"`) |
| `sha256` | String | ❌ | 文件SHA256哈希 |

**成功响应**: 同 `/v2/files/upload`

---

#### 2.12.4 旧版端点 (正式版保留，测试版移除)

| 端点 | 功能 | 替代 |
|---|---|---|
| `POST /files/upload` | 通用文件上传 | `/v2/files/upload` |
| `POST /v1/files/upload` | v1文件上传 | `/v2/files/upload` |
| `POST /resources/upload` | 资源上传 | `/v2/resources/upload` |
| `GET /v1/files/download?name=` | 文件下载 | FileCenterActivity |

---

### 2.13 群组系统 (dev2新增)

#### 2.13.1 GET `/v2/groups/members/lookup?group_id=` — 群成员查找 (dev2新增)

**查询参数**:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `group_id` | String | ✅ | 群组ID |
| `keyword` | String | ❌ | 搜索关键词 (用户名) |

**请求示例**:
```http
GET /v2/groups/members/lookup?group_id=group_123&keyword=john
Authorization: Bearer <token>
```

**成功响应**:
```json
{
  "members": [
    {
      "id": "user_001",
      "username": "john_doe",
      "avatar_url": "/avatars/user_001.png"
    }
  ],
  "member_version": 42
}
```

**响应字段**:

| 字段 | 类型 | 说明 |
|---|---|---|
| `members` | Array | 成员列表 |
| `members[].id` | String | 成员ID |
| `members[].username` | String | 成员用户名 |
| `members[].avatar_url` | String | 成员头像URL |
| `member_version` | int | 成员列表版本号 |

---

#### 2.13.2 GET `/v2/groups/messages/v2?group_id=` — 群消息v2 (dev2迁移)

从旧版 `/groups/messages/v2?group_id=` 迁移到 v2 命名空间。

**查询参数**:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `group_id` | String | ✅ | 群组ID |
| `before` | String | ❌ | 分页: 此消息ID之前的消息 |
| `limit` | int | ❌ | 每页数量 (默认50) |

**成功响应**:
```json
{
  "messages": [
    {
      "id": "msg_789",
      "content": "Hello",
      "sender_id": "user_001",
      "timestamp": 1690000000,
      "msg_type": "text"
    }
  ],
  "has_more": true
}
```

---

### 2.14 账号管理 (dev2新增)

#### 2.14.1 POST `/me/delete/email/send` — 删除账号邮件验证 (dev2新增)

**请求头**: `Authorization: Bearer <token>`

**请求体**: 无

**成功响应**:
```json
{
  "status": "ok",
  "message": "验证邮件已发送",
  "email_hint": "u***@example.com"
}
```

**响应字段**:

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | String | 状态 |
| `message` | String | 提示消息 |
| `email_hint` | String | 邮箱提示 (脱敏显示) |

---

#### 2.14.2 密码恢复流程变化 (dev2)

**正式版**: 应用内完成
- `POST /auth/captcha` — 获取验证码
- `POST /auth/email/send` — 发送验证邮件
- `POST /auth/password/reset` — 重置密码
- `RecoverPasswordActivity` — 完整的密码恢复界面

**测试版**: 浏览器跳转
- `LoginActivity` 中点击"忘记密码"时跳转浏览器:
```java
String url = BuildConfig.BASE_URL + "/forgot-password";
Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
startActivity(intent);
```
- 移除 `RecoverPasswordActivity`
- 移除 `/auth/captcha`、`/auth/email/send`、`/auth/password/reset` 端点

---

### 2.15 音乐系统 (dev2变化)

#### 2.15.1 GET `/music/plaza/list?q=` — 音乐搜索 (dev2简化)

**正式版**: `/music/plaza?sort=latest&q=` (带sort参数)
**测试版**: `/music/plaza/list?q=` (简化为q参数)

**查询参数**:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `q` | String | ✅ | 搜索关键词 |

**请求示例**:
```http
GET /music/plaza/list?q=周杰伦
Authorization: Bearer <token>
```

**成功响应**:
```json
{
  "songs": [
    {
      "id": "song_001",
      "title": "晴天",
      "artist": "周杰伦",
      "album": "叶惠美",
      "duration": 269,
      "cover_url": "/covers/song_001.jpg"
    }
  ]
}
```

---

### 2.16 通知相关

#### 2.16.1 GET `/notifications?limit=1` — 获取最新通知

**源码**: `MainActivity.java`

---

### 2.17 媒体上传

#### 2.17.1 POST `/media` — 上传媒体文件

**源码**: `MomentComposeActivity.java` → `x0()` 方法; `RedPacketSendActivity.java`

**请求参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| file | binary | 文件二进制数据 |
| fileName | String | 文件名 (如 `"moment.jpg"`) |
| contentType | String | MIME类型 (如 `"image/jpeg"`) |

**成功响应**:
```json
{
  "url": "/uploads/abc123.jpg"
}
```

**使用场景**:
- 动态图片上传 (最多9张，压缩到1280px/400KB)
- 红包封面上传 (限1MB)
- 频道媒体上传 (dev2: 使用 `/v1/channels/media/upload`)

---

## 3. 认证机制

### 3.1 Token 认证

- **存储**: `SharedPreferences("auth")`
- **键名**: `access_token`, `refresh_token`, `my_uid`, `my_ncuid`
- **请求头**: `Authorization: Bearer <access_token>`
- **Token刷新**: 通过 `refresh_token` 获取新的 `access_token`
- **兼容**: 旧版键名 `token` 仍可回退读取

### 3.2 设备标识

登录时携带以下设备信息:

| 字段 | 获取方法 | 说明 |
|---|---|---|
| device_id | `AbstractC0611x.b(context)` | 设备唯一ID |
| imei | `AbstractC0611x.d(context)` | IMEI号 |
| device_name | `AbstractC0611x.c()` | 设备型号名称 |
| platform | 硬编码 `"android"` | 平台标识 |
| app_version | `AbstractC0611x.a(context)` | 应用版本号 |

### 3.3 服务器配置 (v1.4.x配置化)

| 配置项 | 说明 |
|---|---|
| `API_BASE_URL` | API基础URL |
| `APP_BASE_URL` | 应用基础URL |
| `PASSPORT_BASE_URL` | 认证服务URL |

- **默认地址**: 通过 `o0.U.b()` 获取
- **自定义地址**: 用户可通过长按登录页图标设置
- **地址格式**: `http(s)://host[:port][/path]`
- **存储**: `SharedPreferences("settings").getString("files_server_base_url")`

---

## 4. WebSocket / 长连接

### 4.1 连接管理器

- **类**: `g0.j` (混淆后)
- **单例**: `j.u()` 获取实例
- **连接**: `j.u().z(context)` — 建立/恢复连接
- **断开**: `j.u().A()` — 断开连接

### 4.2 连接生命周期

```
OldChatApplication.onCreate()
    → j.u().z(this) // 初始化连接

MessageService.onCreate()
    → j.u().z(context) // 服务启动时连接

MessageService.onStartCommand()
    → j.u().z(context) // 每次启动命令时确保连接

MessageService.onDestroy()
    → j.u().A() // 服务销毁时断开

MainActivity.onResume()
    → j.u().z(this) // 恢复时确保连接
```

### 4.3 连接模式

在 `OldChatApplication.onCreate()` 中:
```java
f.B(V.g(this) ? 2 : 1);
// V.g(context) 检测是否WiFi环境
// WiFi: 模式2, 其他: 模式1
```

---

## 5. 文件服务器URL变化 (jadx 确认)

| 类型 | 旧URL (v1.3.61) | 新URL (v1.4.x) |
|---|---|---|
| 文件服务 | `https://files.mcl0.dpdns.org/` | `http://oc.mcl0.dpdns.org` |
| OC服务 | `https://oc.mcl0.dpdns.org` | `http://oc.mcl0.dpdns.org/v1` |
| OSS存储 | — | `https://ocf.oss-cn-shanghai.aliyuncs.com/` |
| OSS存储(HTTP) | — | `http://ocf.oss-cn-shanghai.aliyuncs.com/` |

**频道分享链接格式**: `https://oc.mcl0.dpdns.org/c/{handle}`

---

## 6. B站 API 通信 (v1.4.x重构, jadx 确认)

### 6.1 B站API请求基础

**源码**: `o0.java` → `q()` 方法 (HTTP请求底层)

**请求头** (jadx 确认):

| 头部 | 值 |
|---|---|
| User-Agent | `Mozilla/5.0 (Linux; Android 4.0.4) AppleWebKit/537.36` |
| Referer | `https://www.bilibili.com/` |
| Origin | `https://www.bilibili.com` |
| Accept | `application/json, text/plain, */*` |
| Cookie | (从 BiliAuthStore 获取) |
| Content-Type (POST) | `application/x-www-form-urlencoded; charset=UTF-8` |

**超时**: 连接15秒，读取15秒

### 6.2 关注状态查询

**源码**: `o0.java` → `a` 内部类

**GET** `https://api.bilibili.com/x/relation?fid={fid}`

**查询参数**:

| 参数 | 类型 | 说明 |
|---|---|---|
| `fid` | long | 目标UP主ID |
| `access_key` | String | 访问密钥 (可选) |

**成功响应**:
```json
{
    "code": 0,
    "data": {
        "attribute": 2
    }
}
```

**关注状态判断** (jadx 确认 `k()` 方法):
- `attribute & 2 == 2` → 已关注
- `attribute == 6` → 已关注 (互关)

### 6.3 关注/取关操作

**源码**: `o0.java` → `b` 内部类

**POST** `https://api.bilibili.com/x/relation/modify`

**请求体** (form-urlencoded):

| 参数 | 类型 | 说明 |
|---|---|---|
| `fid` | long | 目标UP主ID |
| `act` | int | 1=关注, 2=取关 |
| `re_src` | int | 固定 11 |
| `access_key` | String | 访问密钥 (可选) |
| `csrf` | String | CSRF Token (从Cookie中 `bili_jct` 提取) |
| `csrf_token` | String | 同 csrf |

### 6.4 CSRF Token 提取

**源码**: `o0.java` → `j()` 方法

从 Cookie 字符串中提取 `bili_jct=` 的值作为 CSRF Token。

### 6.5 B站认证存储 (BiliAuthStore)

**SharedPreferences名称**: `bili_auth`

| 键名 | 类型 | 说明 |
|---|---|---|
| `access_token` | String | B站访问令牌 |
| `cookies` | String | B站Cookie字符串 |
| `mid` | long | 用户MID |
| `expires_at` | long | 过期时间戳 (毫秒) |

---

## 7. 事件分发机制

### 7.1 LocalBroadcastManager

应用使用 Android 的 `LocalBroadcastManager` 进行进程内事件分发:

| 广播 Action | 发送者 | 接收者 |
|---|---|---|
| RESOURCE_UPLOAD_DONE | ResourceUploadService | 资源上传UI |
| RESOURCE_UPLOAD_ERROR | ResourceUploadService | 资源上传UI |
| RESOURCE_UPLOAD_PROGRESS | ResourceUploadService | 资源上传UI |
| music.STATE_CHANGED | MusicPlaybackService | MusicPlayerActivity |
| music.CACHE_RESULT | MusicPlaybackService | MusicDownloadsActivity |
| com.im.oldchat.CHANNEL_POSTS_UPDATED | 频道服务 | ChannelActivity |

---

## 8. 通知系统

### 8.1 通知渠道

| 渠道ID | 名称 | 重要性 | 使用者 |
|---|---|---|---|
| oldchat_service | 后台连接 | LOW | MessageService |
| oldchat_upload | 资源上传 | LOW | ResourceUploadService |
| oldchat_music_playback | 音乐播放 | LOW | MusicPlaybackService |

---

## 9. 错误处理机制 (jadx 确认)

### 9.1 通用错误处理

**源码**: `h0.d.w(int code, String error)` — 通用错误拦截器

该方法在所有回调中被调用，处理以下通用错误:
- Token过期 → 跳转登录页
- 网络不可用 → 提示用户

### 9.2 红包特定错误 (RedPacketSendActivity 确认)

| 错误字符串 | 用户提示 |
|---|---|
| `red_packet_insufficient` | 余额不足 |
| `red_packet_amount_invalid` | 金额无效 |
| `red_packet_count_invalid` | 数量无效 |
| `red_packet_amount_too_small` | 单个金额过小 |
| `red_packet_title_too_long` | 标题过长 (限20字) |
| `invalid_cover_url` | 封面地址无效 |

### 9.3 好友请求特定错误 (AddFriendActivity 确认)

| HTTP状态码 | 说明 |
|---|---|
| 404 | 用户不存在 |
| 409 | 已是好友 / 已发送请求 (通过 `m0.Y.c(str)` 进一步判断) |
