# 02 - 网络层与 API 通信机制 (v1.4.x)

> 基于 jadx 反编译分析  
> 更新时间: 2026年8月

---

## 1. HTTP 客户端架构

### 1.1 底层实现

- **HTTP库**: OkHttp
- **TLS库**: **Conscrypt** (v1.4.x新增，替代系统默认TLS实现)
- **封装类**: `g0.d` (混淆后的网络请求工具类)
- **连接管理**: `g0.j` (WebSocket/长连接管理器)
- **网络状态检测**: `o0.G`
- **服务器配置**: `o0.U` (管理 Base URL)

### 1.2 请求流程

```
UI层 (Activity/Fragment)
    ↓ 调用 g0.d 方法
请求封装层 (g0.d)
    ├── 添加 Authorization: Bearer <token>
    ├── 构造请求体 (JSON/Multipart)
    └── 通过 OkHttp 发送
        ↓
    OkHttp + Conscrypt TLS
        ├── HTTPS (Conscrypt TLS 1.0-1.3)
        └── HTTP (usesCleartextTraffic=true)
```

### 1.3 Conscrypt TLS 集成 (jadx 确认)

v1.4.x 引入完整 Conscrypt 库 (156个Java文件在 `org.conscrypt` 包)。所有 oldchat 包下的类都 `import org.conscrypt.BuildConfig`。Conscrypt 提供 TLS 1.0-1.3 支持，原生 JNI 加速 (`libconscrypt_jni.so`)。

```java
// 所有 oldchat 包类均包含此 import
import org.conscrypt.BuildConfig;
```

### 1.4 回调接口

```java
// g0.d.i — 通用回调接口
public interface i {
    void b(String response);           // 成功回调
    void c(int errorCode, String error); // 失败回调
}

// g0.d.j — 上传进度回调
public interface j {
    void a(long uploaded, long total);  // 进度回调
}

// g0.d.k — 上传数据源
public interface k {
    InputStream a() throws Exception;   // 获取输入流
    long length();                       // 获取文件大小
}
```

---

## 2. 已知 API 端点 (jadx grep 确认)

### 2.1 认证相关

| 方法 | 路径 | 用途 | 请求体 |
|---|---|---|---|
| POST | `/auth/login` | 用户登录 | identifier, password, device_id, imei, device_name, platform, app_version |
| GET | `/register` | 注册页面 (v1.4.x, 浏览器跳转) | — |

**登录响应**:
```json
{
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "user": {
        "id": "数据库ID",
        "uid": "用户UID",
        "ncuid": "用户NCUID"
    }
}
```

**注册变化 (v1.4.x)**:
- 旧版: `RegisterActivity` → POST `/auth/register`
- 新版: `LoginActivity` → `Intent(ACTION_VIEW, Uri.parse(base_url + "/register"))` → 浏览器

### 2.2 好友相关

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/friends/requests` | 获取好友请求列表 |

### 2.3 通知相关

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/notifications?limit=1` | 获取最新通知 |

### 2.4 资源相关

| 方法 | 路径 | 用途 | Content-Type |
|---|---|---|---|
| POST | `/resources/upload` | 上传资源文件 | multipart/form-data |

### 2.5 群消息相关

| 方法 | 路径 | 用途 | 版本 |
|---|---|---|---|
| GET | `/groups/messages/after?group_id=` | 获取指定时间后的群消息 | v1.4.x新增 |

### 2.6 音乐相关 (v1.4.x新增, jadx 确认)

| 方法 | 路径 | 用途 |
|---|---|---|
| GET/POST/PUT/DELETE | `/music/playlists` | 播放列表CRUD |
| POST | `/music/playlists/sync` | 播放列表同步 |
| GET | `/music/plaza/detail?item_id=` | 音乐详情 |
| GET | `/music/plaza/lyrics?item_id=` | 歌词获取 |
| GET | `/music/plaza/ranking?limit=50` | 排行榜（扩展为50条，旧版仅10条） |
| GET | `/music/plaza?limit=30&offset=` | 音乐广场分页 |
| GET | `/music/plaza?limit=50&offset=0&sort=latest` | 最新音乐 |
| GET | `/music/plaza?limit=50&offset=0&sort=latest&q=` | 音乐搜索 |

### 2.7 搜索相关

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/direct/messages/search?with_uid=` | 私聊消息搜索 |
| GET | `/direct/messages/search?with_ncuid=` | 私聊消息搜索 (NCUID) |
| GET | `/groups/messages/search?group_id=` | 群消息搜索 |

### 2.8 通用请求方法

| 方法 | 功能 |
|---|---|
| `g0.d.R(path, token, callback)` | GET 请求 |
| `g0.d.S(path, json, token, callback)` | POST 请求 (JSON) |
| `g0.d.U(path, dataSource, fileName, contentType, token, ...)` | Multipart 上传 |

---

## 3. 认证机制

### 3.1 Token 认证

- **存储**: `SharedPreferences("auth")`
- **键名**: `access_token`, `refresh_token`, `KEY_ACCESS_TOKEN` (v1.4.x配置化)
- **请求头**: `Authorization: Bearer <access_token>`
- **Token刷新**: 通过 `refresh_token` 获取新的 `access_token`

### 3.2 设备标识

登录时携带以下设备信息:

| 字段 | 获取方法 | 说明 |
|---|---|---|
| device_id | `AbstractC0445k.b(context)` | 设备唯一ID |
| imei | `AbstractC0445k.d(context)` | IMEI号 |
| device_name | `AbstractC0445k.c()` | 设备型号名称 |
| platform | 硬编码 "android" | 平台标识 |
| app_version | `AbstractC0445k.a(context)` | 应用版本号 |

### 3.3 服务器配置 (v1.4.x配置化)

| 配置项 | 说明 |
|---|---|
| `API_BASE_URL` | API基础URL |
| `APP_BASE_URL` | 应用基础URL |
| `PASSPORT_BASE_URL` | 认证服务URL |

- **默认地址**: 通过 `o0.U.b()` 获取
- **自定义地址**: 用户可通过长按登录页图标设置
- **地址格式**: `http(s)://host[:port][/path]`

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

**注意**: v1.4.x 引入了阿里云 OSS 作为文件存储后端，同时部分服务从 HTTPS 降级为 HTTP。

---

## 6. NCUID 迁移全面加速 (v1.4.x 重大变化, jadx 确认) ⭐

v1.4.x 是 UID → NCUID 迁移的关键版本。从 v1.3.61 的"部分支持"跃进到"全面铺开"。

### 6.1 NCUID 在源码中的使用 (jadx 确认)

**旧版 (v1.3.61) — 14处:**
```
LoginActivity: optString("ncuid"), putString("my_ncuid")
MomentsActivity: getString("my_ncuid"), putExtra("ncuid"), moments/user?ncuid=
UserSpaceActivity(v0): getString("my_ncuid"), getExtra("ncuid"), /moments/user?ncuid=, /users/profile?ncuid=
ChatActivity(J): optString("from_ncuid") — 消息解析
GroupChatActivity(d0): optString("from_ncuid") — 群消息解析
FriendListActivity(Q): optString("ncuid") — 好友列表
SettingsActivity(W): putExtra("ncuid") — 跳转
```

**新版 (v1.4.x) — 30+处 (大幅增加):**
```
LoginActivity: optString("ncuid"), putString("my_ncuid") — 不变
MomentsActivity: getString("my_ncuid"), putExtra("ncuid") — 不变
UserSpaceActivity(y0): getString("my_ncuid"), getExtra("ncuid") — 不变
ChatActivity(J): optString("from_ncuid") — 不变
GroupChatActivity(d0): optString("from_ncuid") — 不变

新增:
AbstractActivityC0197b: putExtra("to_ncuid"), putExtra("friend_ncuid") — 基类传递NCUID
ChatSearchActivity: &with_ncuid=, getExtra("friend_ncuid") — 消息搜索用NCUID
ChatSettingsActivity: putExtra("friend_ncuid"), put("friend_ncuid") — 好友设置用NCUID
GroupCreateActivity: put("member_ncuids", jsonArray) — 创建群组用NCUID数组
GroupInviteActivity: put("user_ncuid") — 邀请用NCUID
RedPacketSendActivity: getExtra("to_ncuid"), put("to_ncuid") — 红包用NCUID
MomentCommentsActivity: optString("from_ncuid") — 评论用NCUID
FriendListActivity(O): put("user_ncuid") — 好友操作用NCUID
ChatListActivity(n0): putExtra("friend_ncuid"), put("to_ncuid") — 聊天列表用NCUID
RecentChats(r0): putExtra("friend_ncuid"), put("to_ncuid") — 最近聊天用NCUID
MessageSendHelper(C0218x): put("to_ncuid") — 发送消息用NCUID
```

### 6.2 新增 NCUID 字段 (9个)

| v1.3.61 旧字段 | v1.4.x 新字段 | 场景 |
|---|---|---|
| `friend_uid` | `friend_ncuid` | 好友标识 |
| `user_uid` | `user_ncuid` | 用户标识 |
| `target_uid` | `target_ncuid` | 目标用户 |
| `reader_uid` | `reader_ncuid` | 消息已读者 |
| `peer_uid` | `peer_ncuid` | 对话方 |
| `to_uid` | `to_ncuid` | 消息接收方 |
| `member_uids` | `member_ncuids` | 群成员列表(批量) |
| — | `direct_ncuid_` | 私聊NCUID前缀存储 (新增) |
| `with_uid` (查询参数) | `with_ncuid=` | API查询参数 |

v1.3.61 已有的 `my_ncuid` 和 `from_ncuid` 继续保留。

### 6.3 API 端点 NCUID 支持情况

| 端点 | v1.3.61 | v1.4.x | 说明 |
|---|---|---|---|
| 用户资料 | `?uid=` / `?ncuid=` | `?ncuid=` 为主 | ✅ 完全切换 |
| 动态查询 | `?uid=` / `?ncuid=` | `?ncuid=` / `?uid=` | 两者都支持 |
| 私聊消息 | `?with_uid=` | `?with_uid=` + `&with_ncuid=` | ⚠️ 并行支持 |
| 消息搜索 | — | `?with_ncuid=` (新增端点) | 新增 |
| 群成员 | `member_uids` | `member_ncuids` | ✅ 切换 |

### 6.4 迁移策略: 双写双读

```
读取: ncuid 优先，回退 uid
写入: 同时携带 uid + ncuid
存储: NCUID 独立前缀 direct_ncuid_
```

后端正在从自增整数 UID 迁移到全局唯一 NCUID，v1.4.x 读取已基本切换，写入仍保留兼容。

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

---

## 8. 通知系统

### 8.1 通知渠道

| 渠道ID | 名称 | 重要性 | 使用者 |
|---|---|---|---|
| oldchat_service | 后台连接 | LOW | MessageService |
| oldchat_upload | 资源上传 | LOW | ResourceUploadService |
| oldchat_music_playback | 音乐播放 | LOW | MusicPlaybackService |

---

## 9. B站 API 通信 (v1.4.x重构, jadx 确认)

### 9.1 B站API封装 (完全重构)

v1.4.x 对 B站模块进行了完整重构:

| 类 | 功能 |
|---|---|
| **BiliApi** | 完整API封装 (含7个内部类) |
| **BiliApiExtra** | 扩展API (收藏/历史/评论) |
| **BiliApiSupport0** / **BiliApiSupport1** | 辅助API |
| **BiliSigner** | 签名基类 |
| **BiliWbiSigner** | Wbi签名算法 (防风控) |
| **BiliAuthStore** | 认证信息存储 (Cookie/Token持久化) |
| **BiliShareUtil** | 分享工具 |
| **BiliQrGenerator** | 二维码生成 |
| **BiliUserSpaceApi** | 用户空间API |

### 9.2 Wbi签名算法

v1.4.x 引入了 B站的 Wbi 签名算法 (`BiliWbiSigner`)，这是 B站 新版 API 的签名机制，用于防止请求伪造。

### 9.3 QR码登录流程

1. 请求 `auth_code` API 获取二维码 (通过 `BiliQrGenerator` 生成)
2. 展示二维码供用户扫描
3. 轮询检查扫码状态
4. 获取 cookies 完成登录
5. 通过 `BiliAuthStore` 持久化认证信息
