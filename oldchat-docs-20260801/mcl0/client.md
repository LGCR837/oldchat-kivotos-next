# Oldchat Android 客户端开发规格

> 本文档以 `1.3.50`（versionCode 231）源码为准，目标是让另一名开发者仅凭本文档 + 服务端 `/api.md`、`/routes.md`、`/lua-cip.md` 就能复刻全部客户端功能，并保持与现有服务端、旧客户端兼容。
>
> 所有代码约束（minSdk 9、Java 7 语法、Support Library 24.2.1、不使用 vector drawable、API 11+ 调用必须隔离到 `@TargetApi` 类）在本文档结尾“兼容性铁律”中集中说明。

---

## 1. 项目概况

| 项目 | 值 |
|------|----|
| 包名 | `com.im.oldchat` |
| 应用名 | Oldchat / 旧聊 |
| minSdk | 9（Android 2.3 Gingerbread） |
| targetSdk | 33 |
| compileSdk | 33 |
| 语言 | Java 7 语法，`sourceCompatibility/targetCompatibility = 1.8`，由 D8 desugar |
| UI 框架 | Android Support Library 24.2.1（非 AndroidX） |
| 构建 | Gradle 8.11 + AGP 8.7.3，JDK 17 运行 Gradle |
| 实时通信 | 自实现 WebSocket RFC 6455 客户端 |
| 加密 | ECDH 会话密钥协商 + AES + HMAC（SpongyCastle） |
| 混淆 | Release 启用 R8 + 资源压缩，单 DEX |
| 签名 | v1 + v2，密钥由 `keystore.properties` 配置 |

### 1.1 模块结构

```
A-chat/
├── app/
│   ├── build.gradle              # 模块构建、签名、版本、依赖
│   ├── proguard-rules.pro        # R8 规则（必须保留 LuaJ）
│   ├── build_install_android.sh  # 一键构建/安装/logcat 脚本
│   └── src/main/
│       ├── AndroidManifest.xml   # 组件与权限声明
│       ├── java/com/im/oldchat/
│       │   ├── OldChatApplication.java   # 进程入口
│       │   ├── MainActivity.java         # Launcher + 主页
│       │   ├── BaseActivity.java         # Activity 公共基类
│       │   ├── api/                      # HTTP + WebSocket 通信层
│       │   ├── models/                   # 数据模型 + 内存/磁盘缓存
│       │   ├── ui/                       # Activity / Adapter / Helper
│       │   │   ├── fragments/            # 主页四 Tab
│       │   │   ├── widget/               # 自定义 View
│       │   │   └── news/                 # 极简新闻
│       │   ├── service/                  # 后台服务
│       │   ├── util/                     # 工具类
│       │   ├── lua/                      # CIP / VibeCoding
│       │   ├── bili/                     # B 站 OldView 集成
│       │   └── data/                      # 本地 Store
│       └── res/                          # 布局、drawable、values
├── server/                      # Go 后端（见 /api.md）
├── keystore.properties          # 签名密钥配置（不入库）
└── build.gradle / settings.gradle
```

### 1.2 核心依赖

```groovy
implementation 'com.android.support:appcompat-v7:24.2.1'
implementation 'com.android.support:recyclerview-v7:24.2.1'
implementation 'com.android.support:support-v4:24.2.1'
implementation 'com.google.code.gson:gson:2.8.5'
implementation 'com.google.zxing:core:3.3.3'
implementation 'com.squareup.okhttp3:okhttp:3.12.13'   // 仅用于部分上传
implementation 'com.madgag.spongycastle:prov:1.58.0.0' // ECDH/AES
implementation 'org.luaj:luaj-jse:3.0.1'              // CIP Lua 沙箱
debugImplementation 'com.android.support:multidex:1.0.3'
```

- `android.useAndroidX=false`，不迁移 AndroidX。
- `com.itsaky.androidide:logger/logsender` 必须全局排除，否则低 minSdk 下 D8 报 Java 8 bytecode 错误。

---

## 2. 启动与认证

### 2.1 进程入口

```
Manifest:
  application .OldChatApplication
  activity .MainActivity (LAUNCHER)
```

**`OldChatApplication.onCreate()` 执行顺序**（不可打乱）：

1. `MultiDex.install()`（通过 `attachBaseContext` 反射安装，兼容 API 9）。
2. `AppDpiManager.apply()`：恢复用户 DPI 设置。
3. 修复损坏的 `SharedPreferences`（读取异常时清空，避免启动崩溃）。
4. `ServerBaseUrlManager.applySavedBaseUrl()`：从 `settings` SP 恢复自定义服务器地址到 `HttpUtil.BASE_URL`。
5. 夜间模式、日志、`CrashHandler`（捕获未处理异常并跳转 `CrashActivity`，`:crash` 进程）。
6. `AppState`（API 14+ `ActivityLifecycleCallbacks` 隔离到 `AppStateApi14`）初始化前后台状态。
7. `MemoryTrimApi14`：API 14+ 注册 `ComponentCallbacks2`；不要在 `OldChatApplication` 直接重写 `onTrimMemory`。
8. `MessageService.startIfAllowed()`：启动后台服务，间接启动 WebSocket。

**`MainActivity.onCreate()`**：

1. `super.onCreate()`（BaseActivity 在 super 前应用主题，避免闪烁）。
2. 读 `auth.access_token`（兼容旧键 `token`）。
3. 无 token → `startActivity(LoginActivity)` → `finish()`。
4. 有 token → `setContentView(activity_main)`：
   - `WSManager.getInstance().start(this)`。
   - `LuaAppSyncManager.sync()`（异步，不阻塞首屏）。
   - `AvatarSyncManager.syncAll()`。
5. `setupViewPager`：四个 Fragment —— 聊天 / 好友 / 发现 / 我的。
6. `topStatusBar.setOnRetryClickListener`：网络异常时手动重连 + 刷新。

**`MainActivity.onResume()`**：幂等 `WSManager.start` + 刷新聊天列表 + 刷新好友请求红点 + 首次检查系统通知 + `UpdateManager.check`（24h 间隔）。

### 2.2 登录流程（`LoginActivity`）

1. 初始化服务器地址入口、隐私协议（必须同意才能登录）、更新检查。
2. `POST /auth/login`，字段：
   - `username` / `password`
   - `device_id` / `imei`（`DeviceInfoUtil` 反射获取，避免 lint `MissingPermission`）
   - `device_name` / `platform="android"` / `app_version`
3. 成功后保存到 `auth` SP：
   - `access_token`、`refresh_token`、`user_id`、`my_uid`
   - `saved_username`、`saved_password`（明文，用于 refresh token 失效后的密码回退）
4. **账号 UID 变化时必须清空旧账号缓存**（`MessageHistoryCache.clearAll`、好友/群组/头像等）。
5. 登录/退出/切换账号前调用 `HttpUtil.invalidateAuthOperations()`，使 `authGeneration` 自增，废弃旧刷新结果。

### 2.3 HTTP 认证与加密（`HttpUtil` / `HttpUtilSupport0` / `HttpAuthHelper`）

所有业务请求走 `HttpUtil.get/post`，**不要绕过**。

```
HttpUtil.get(path, token, callback)
  └→ AsyncTask.THREAD_POOL_EXECUTOR（通过 AsyncTaskExecutionCompat 隔离 API 11 符号）
      └→ requestWithRefresh()
           ├→ 排除列表（/auth/login、/auth/register、/auth/refresh、/auth/handshake 不触发自动刷新）
           ├→ 若需要加密且 session 未建立 → ensureSession()（ECDH 握手）
           ├→ 设置 Authorization: Bearer <token>
           │   加密请求额外设置 X-Enc, X-Session, Content-Encoding
           ├→ 执行请求
           ├→ 401 → refreshToken()
           │         ├→ POST /auth/refresh {refresh_token}
           │         ├→ refresh_token 无效 → 密码回退 POST /auth/login
           │         ├→ authGeneration + token 期望校验，防止退出后旧刷新覆盖
           │         └→ 失败累计 → 阈值后跳转 LoginActivity
           ├→ invalid_session → 清 session 重试一次
           └→ 403 + user_banned → 提示并跳转登录
```

**ECDH 握手（`HttpAuthHelper.ensureSession`）**：

1. 生成客户端临时 ECDH 密钥对。
2. `POST /auth/handshake`（明文），提交客户端公钥。
3. 用服务端公钥 + 本地私钥派生 `encKey`（AES）和 `macKey`（HMAC），保存 `sessionId`。
4. 并发握手通过锁合并，最长等待约 25 秒。
5. 加密请求：`payload = AES(encKey, body)`，`mac = HMAC-SHA256(macKey, payload)`，头携带 `X-Enc`、`X-Session`、`X-Mac`。
6. **断连时清除 session**：`WSManager` 和 `SimpleWebSocketClient` 在 `onClose/onError` 时清除密钥。

**Token 刷新单飞（single-flight）**：

- `REFRESH_LOCK` 保证同一时刻只有一个刷新请求在飞。
- `authGeneration` 全局递增；`applyAuthResponse()` 在写入前校验 generation 和预期的 access/refresh token。
- 登录/退出时 `invalidateAuthOperations()` 使 generation 自增，废弃所有在途刷新。

### 2.4 WebSocket 连接（`WSManager` / `SimpleWebSocketClient`）

**启动链**：
```
MessageService.startIfAllowed() 或 MainActivity.onResume()
  └→ WSManager.start(context)
       ├→ synchronized(connecting/connected/checkingToken) 保证幂等
       ├→ GET /me 预检 token
       │    ├→ 成功：同步未读（/direct/unread + /groups/unread），再连接
       │    └→ 失败：仍尝试连接，避免普通 HTTP 故障阻断 WS
       ├→ ensureSession()（ECDH）
       ├→ 构造 ws/wss URL + ?token=&session=
       └→ SimpleWebSocketClient.connect()
```

**`SimpleWebSocketClient`** 自实现 RFC 6455：
- HTTP Upgrade 握手（带 `Sec-WebSocket-Key`、`Sec-WebSocket-Version: 13`）。
- 帧读取线程：读取掩码帧、解掩码、处理文本帧、ping/pong、close。
- **读取线程首先解密**，再送入解析队列（避免断连清除密钥后无法解密）。
- 写入：客户端帧必须掩码。
- 不处理分片帧和二进制帧（服务端若扩展协议需同步升级）。

**消息解析调度**：
```
读取线程
  └→ 解密
  └→ offer 到 BoundedQueue(capacity=256) 的单线程 executor
       └→ 队列满时由读取线程直接执行（反压，不丢消息）
       └→ WSIncomingHandler
            ├→ 兼容性二次解密
            ├→ 解析 JSON → WSModels.DirectMessage / GroupMessage / Recall / Typing / Presence
            ├→ 修复字段（ncuid 解析、时间戳补全）
            ├→ 更新缓存（RecentChatCache / GroupRecentChatCache / 未读）
            ├→ 生成后台通知（NotificationHelper）
            └→ WSDispatchHelper → 主线程 Listener
```

**断线重连**：
- 1 秒 → 60 秒指数退避 + ±20% 抖动。
- 401/403 → 后台刷新 token → 重连。
- 每条连接有 generation；`onError/onClose` 只有第一个终止回调生效，旧连接回调被忽略。
- 重连成功后执行未读补偿，设置标志供聊天页 `onResume()` 强制刷新。

**Listener 生命周期**：
- 回调已在主线程。
- UI 必须在 `onResume/onPause` 成对 `addListener/removeListener`。
- 聊天页还会在 `onDestroy` 清除 Handler 和控制器。

---

## 3. 私聊功能

### 3.1 数据模型

**`Message`**（`models/Message.java`）：
```java
public class Message {
    public String id;              // 服务端 ID 或 local_* 临时 ID
    public String thread_id;       // 会话线程 ID
    public String from_uid;
    public String body;            // 纯文本或 MessagePayload JSON
    public String msg_type;        // text/image/video/voice/emoji/resource/red_packet/file/forward
    public String media_url;
    public String thumb_url;
    public int duration_ms;       // 语音/视频时长
    public int burn_after_seconds;
    public long burn_start_at;
    public long created_at;       // Unix 秒
    public long sort_seq;          // SQLite rowid，同秒排序
    public int status;             // STATUS_NONE/SENT/DELIVERED/READ
    public boolean localPending;   // 发送中，不持久化
    public boolean localFailed;    // 发送失败
    public String localRequestId;  // local_* ID，用于匹配服务端确认
    public String localPreviewUri; // 本地图片预览 content:// URI
    public int localProgress;      // 上传进度 0-100，-1 无进度
    public String recall_edit_type;
    public String recall_edit_text;
    public String sender_ncuid;
}
```

**`MessagePayload`**（`util/MessagePayload.java`）：
- `v=2` JSON 格式，兼容旧版 `v=0/1` 降级为纯文本。
- 字段：`text`、`media_kind`、`voice_text`、`quote`、`mentions[]`、`forward_v2`。
- `Quote`：`id/from_uid/from_name/type/text/media_kind/thumb_url`。
- `Mention`：`uid/name`。
- `ForwardBundle`：`title` + `items[]{source_message_id, from_uid, from_name, from_avatar, type, media_kind, text}`。
- `fromBody(body)` 解析，`toJson()` 序列化；旧版自动降级 `extractFallbackText`。

### 3.2 发送流程（`DirectMessageSender` + `DirectPendingMessageHelper`）

**文本发送**：
```
1. UI 输入 → sendText(content, quoteDraft)
2. body = MessagePayloadBuilder.buildBody(text, quote, mentions, mediaKind)
3. localId = DirectPendingMessageHelper.enqueueText(listHelper, myUid, body, burnAfterSeconds)
   ├→ 创建 Message{id=local_*, localPending=true, localRequestId=local_*}
   ├→ 加入 listHelper.messageList + messageIds
   ├→ DirectMessageMerger.sortMessages()（按 created_at, id, sort_seq）
   ├→ trimOldestInMemory(MAX_ACTIVE_WINDOW_MESSAGES)
   ├→ 适配器标记 animating
   ├→ 更新 RecentChatCache
   ├→ notifyReloadWithStatus()（只刷新变化行）
   └→ scrollToBottom()
4. POST /direct/send {to_uid, body, msg_type:"text", burn_after_seconds?}
5. 成功：
   ├→ parseMessageFromResponse(response) → Message sent
   └→ DirectPendingMessageHelper.completeText(listHelper, localId, sent)
        ├→ 按 localRequestId 找到 pending
        ├→ 服务端消息 id 已存在 → 移除 pending（防重复）
        ├→ copyServerFields(pending, sent)（替换 id/created_at/sort_seq/status 等）
        ├→ localPending=false, localFailed=false, localRequestId=null
        └→ 排序 + 刷新状态行
6. 失败：failText(listHelper, localId) → localPending=false, localFailed=true
```

**媒体发送**：
```
1. 选图/拍照/录音/选文件
2. enqueueImageSpinner / enqueueImageWithProgress（创建 pending 图片气泡，localPreviewUri 指向本地 content://）
3. 压缩图片（3MB 限制）+ 生成缩略图
4. POST /media (multipart/form-data, file + thumb?)
   ├→ 返回 {url, thumb_url?}
   └→ 两个 URL 都是 /v1/uploads/media/xxx 相对路径
5. 更新 pending 的 media_url / thumb_url
6. sendPendingMedia(type, url, thumbUrl, durationMs, body, burnSeconds, pendingLocalId)
   └→ POST /direct/send {to_uid, body, msg_type, media_url, thumb_url, duration_ms, burn_after_seconds?}
7. 服务端确认 → completeText 替换 pending
```

**文件发送**（走独立 files 服务）：
```
1. ChatFileUploadHelper.pickFile() → ACTION_GET_CONTENT
2. queryDisplayName(uri) + querySize(uri) + resolveMime(uri)
3. fileSize > 1GB → 拒绝
4. ChatFileUploadHttpClient.upload(activity, uploadUrl, uri, ...)
   ├→ setChunkedStreamingMode(0)
   ├→ 边读边累计 written，超过 1GB 立即返回 413（即使 size 未知）
   └→ 返回 {url} 或 {download_path}
5. normalizeDownloadUrl(url, apiBase)
6. sendFileResource(url, fileName, fileSize, quoteDraft)
   └→ msg_type="resource", body=FileUploadUiTextUtil.buildBody(fileName, fileSize, url)
```

**发送失败处理**：
- `localFailed=true` 的消息在气泡上显示“发送失败”提示。
- 用户可长按重发（`DirectPendingMessageHelper` 重新提交）。
- **`localPending` 消息不持久化**：`MessageHistoryCache` 保存时过滤掉所有 `localPending=true` 的消息，读取时也会清理遗留 pending。进程被杀后不会留下永久“发送中”气泡。

### 3.3 历史加载与分页（`DirectChatLoadDelegate`）

**加载策略**：
1. 首次进入：缓存与网络并行；网络先返回时缓存回调因列表非空自动丢弃。
2. 优先 v2 游标分页：`/direct/messages/v2?with_uid=&limit=&offset=&before_created_at=&before_id=&anchor_message_id=`
3. v2 返回 404（旧服务端无此路由）→ `legacyHistoryRoute=true`，回退 `/direct/messages?with_uid=`
4. 游标页全是重复 → `cursorPaginationDisabled=true`，下次用 offset。
5. **合并刷新（merge not replace）**：HTTP 返回期间可能收到 WS 消息，刷新时按 ID 去重合并，不清空列表。
6. **空响应保护**：空页不清空现有消息（避免 transient empty 看起来像消息丢失）。
7. **gap 保护**：保留现有消息，不因 gap 丢弃缓存/实时数据。
8. **前插锚点**：保存 `firstVisiblePosition` + `top` offset，加载更多后恢复滚动位置。
9. **404 处理**：只有响应明确包含 `user_not_found` 才清除会话并退出；普通 404 只回退旧接口。

### 3.4 消息合并与排序（`DirectMessageMerger`）

- `sortMessages()`：按 `created_at` 升序，同秒按 `sort_seq`（SQLite rowid），再按 ID。
- `mergeRefresh(list, ids, incoming, maxWindow, append)`：
  - 按 ID 去重：incoming 中已有 ID 的跳过。
  - incoming 中 ID 在本地 `local_*` pending 的 → 替换 pending（通过 `findMatchingPendingIndex` 宽松匹配，仅文本、唯一匹配）。
  - append 模式前插；refresh 模式合并。
  - `trimOldestInMemory`：超过 `MAX_ACTIVE_WINDOW_MESSAGES` 时裁剪最早，同时清理 messageIds。

### 3.5 聊天页生命周期（`ChatActivity` / `DirectChatSupportDelegate`）

**进入聊天页**：
1. Intent: `friend_id` / `friend_uid` / `friend_name` / `friend_avatar`。
2. `onCreate`：
   - 初始化 `DirectChatListHelper`（持有 messageList / adapter / RecyclerView）。
   - `WSManager.addListener(wsListener)`。
   - 加载缓存 → 加载网络。
   - 注册 `scrollToBottom` 修正（0/80/320ms + post-layout scrollBy，`bottomScrollGeneration` 可取消）。
3. `onResume`：刷新消息、同步已读、恢复 WebSocket。
4. `onPause`：标记已读、暂停图片加载。
5. `onDestroy`：移除 WS Listener、清除 Handler、释放控制器、取消底部修正。

**底部定位修正**（`DirectChatSupportDelegate.scrollToBottom`）：
- 0ms / 80ms / 320ms 三段有界修正 + post-layout `scrollBy`。
- `bottomScrollGeneration` 在用户拖动 / 跳转未读 / 引用跳转 / 历史锚定 / 保持位置刷新时自增，取消待执行的修正。

---

## 4. 群聊功能

### 4.1 数据模型

**`GroupMessage`**（`models/GroupMessage.java`）：与 `Message` 类似，额外：
- `group_id`、`group_seq`（可靠排序）、`read_count`。
- `transient` 缓存字段：`cachedPayload`、`cachedMemberMetaVersion`、`cachedSenderName/Title/Role`、`cachedAvatarUrl` 等（不序列化）。

**`Group`**：`id/name/avatar_url/role/owner_uid/member_count` 等。

### 4.2 可靠同步（`GroupReliableSync` + `GroupSyncWatermarkStore`）

这是群聊最核心的设计：

**不变量**：
- WebSocket 负责低延迟实时推送。
- HTTP `/groups/messages/after` 按 `group_seq` 补偿，保证后台断线后最终不漏消息。
- **水位（watermark）只有在完整 HTTP 页面合并并关联到本地消息锚点后才推进**。
- **WS 不推进水位**：若 WS 中间漏包，推进后 HTTP 将永久跳过缺失消息。

**启动流程**：
```
GroupReliableSync.start(helper, token)
  ├→ reliableSyncRunning=true
  ├→ watermark = GroupSyncWatermarkStore.get(context, groupId, messageIds)
  │    └→ 若 watermark.anchorMessageId 不在活动 messageIds 中 → 失效，返回 seq=0
  ├→ watermark.seq > 0 → pullAfter(helper, token, watermark.seq)
  └→ watermark.seq == 0 → pullLegacyUntilOverlap(...)
```

**`pullAfter`**（正常补偿）：
```
GET /groups/messages/after?group_id=&after_seq=&limit=100
  ├→ server_group_seq < after_seq → 服务端数据重置
  │    ├→ GroupSyncWatermarkStore.clear()
  │    └→ pullLegacyUntilOverlap（全量交叠恢复）
  ├→ parseIncoming(response) → List<GroupMessage>（升序）
  │    └→ 注意：after 接口本身升序，普通历史解析会翻成升序，因此这里 reverse 回来
  ├→ mergePage（内存合并，不刷新 UI）
  ├→ anchor = findMessageIdForSeq(incoming, next_group_seq)
  ├→ next > afterSeq && anchor 非空 →
  │    ├→ MessageHistoryCache.saveGroupMessages()
  │    └→ GroupSyncWatermarkStore.save(next, anchor)
  ├→ has_more → pullAfter(next)（递归分页）
  └→ 否则 → finish()
```

**`pullLegacyUntilOverlap`**（旧服务端兜底）：
```
GET /groups/messages/v2?group_id=&limit=100&offset=0&mark_read=0
  &before_created_at=&before_id=  (非首页)
  ├→ originalAnchors = 最早 20 个本地消息 ID（不能拿最新页当交点）
  ├→ 解析 incoming（普通历史会翻成升序）
  ├→ 检查 overlap：incoming 中是否有 originalAnchors 中的 ID
  ├→ 记录页内最高 group_seq 和对应 ID
  ├→ mergePage
  ├→ overlap || !hasMore || empty →
  │    ├→ 保存水位
  │    └→ pullAfter(highestSeq)（切换到 after 模式继续）
  └→ 否则 → pullLegacyUntilOverlap(oldest.createdAt, oldest.id, ...)
```

**`finish`**：
- `reliableSyncRunning=false`。
- 统一 `notifyDataSetChangedNow()` + `updateRecentFromMessages` + `saveGroupMessages`。
- 若 `reliableSyncPending`（同步期间又收到新消息）→ 重新 `start()`。

**水位存储**（`GroupSyncWatermarkStore`）：
- `get(context, groupId, currentMessageIds)`：
  - 读取 `(group_seq, anchor_message_id)`。
  - 若 `anchor_message_id` 不在 `currentMessageIds` 中 → 返回 seq=0（失效）。
- `save(context, groupId, seq, anchorMessageId)`。
- `clear(context, groupId)`：清群缓存时必须同时清水位。

### 4.3 群消息发送

与私聊类似，走 `GroupMessageSender` + `GroupPendingMessageHelper`：
- `POST /groups/message/send`。
- `tryApplyServerMessage`：WS 收到自己发的消息时，按宽松匹配替换 pending（不重新播放发送动画）。
- 红包消息也支持 `group_seq`。

### 4.4 群历史加载（`GroupChatLoadDelegate`）

与私聊对称，额外：
- `mark_read=0`：新客户端由独立 `/groups/read` 推进已读，避免历史 GET 在 SQLite 上重复写锁。
- v2 404 → `legacyHistoryRoute=true` 回退 `/groups/messages`。
- ListView header 锚点处理：加载更多时用第一条真实消息而非 header 高度恢复位置。

---

## 5. 消息类型与渲染

### 5.1 支持的消息类型

| `msg_type` | 渲染 | 交互 |
|------------|------|------|
| `text` | 文本气泡 + 引用块 + @提及高亮 | 长按复制/引用/转发/撤回/多选 |
| `image` | 图片气泡（缩略图 + 加载圈） | 点击全屏预览（ZoomImageView） |
| `video` | 视频气泡（缩略图 + 播放按钮） | 点击进 OldViewVideoFullActivity |
| `voice` | 语音气泡（时长 + 播放/转文字） | 点击播放，长按转文字 |
| `emoji` | 表情图片 | 长按保存 |
| `resource` | 文件卡片（图标+名称+大小+下载按钮） | 点击下载（DownloadUtil 多线路） |
| `red_packet` | 红包卡片 | 点击拆红包 |
| `forward` | 转发聊天记录卡片 | 点击查看详情 |

### 5.2 适配器结构

私聊 `MessageAdapter` 继承链：
```
RecyclerView.Adapter
  └→ MessageAdapterSupport0   # 基础绑定、ViewHolder、状态行
      └→ MessageAdapterSupport1  # 时间、引用、提及
          └→ MessageAdapterSupport2  # 视频、文件、红包
              └→ MessageAdapter     # 公开入口
```

群聊 `GroupMessageAdapter` 类似，多了成员名/头像/角色缓存。

**渲染优化**：
- `DiffUtil`（`CombinedChatAdapter` 用于首页合并列表）。
- 稳定 ID（`getItemId` 返回消息 ID hash）。
- `ViewHolderPool` 复用。
- `markMessageAnimating`：新插入消息播放发送动画，服务端确认只更新状态不重播。
- `notifyItemChanged` / `notifyItemInserted` 精确刷新，避免 `notifyDataSetChanged` 全量。

### 5.3 图片加载（`ImageLoader`）

**多级缓存**：
1. 内存 `LruCache`（按设备内存分级：24MB / 16MB / 8MB / 1MB）。
2. 磁盘缓存（7 天 TTL，48-128MB 上限，2h 清理间隔）。
3. `ImageDiskCacheHint`：内存中标记磁盘是否已有该 key，避免主线程 IO 检查。
4. `BitmapInFlight`：同 URL 并发请求合并，避免重复下载。

**加载流程**：
```
load(view, url) / loadAvatar(view, url) / loadLarge(view, url)
  ├→ resolveUrl(url) → MediaUrlResolver.resolve()
  ├→ cacheKey = memoryCacheKey(buildCacheKey(resolved), purpose)
  ├→ 内存命中 → 直接设置 + 回调
  ├→ sameTag 校验（view.getTag == resolved），防止复用错位
  ├→ loadAsync(view, context, resolved, cacheKey, listener, maxSize, maxBytes, cacheInMemory, avatarRequestKey)
       ├→ 内存再查
       ├→ ThreadPoolManager.executeIo
       │    ├→ candidates = MediaUrlResolver.resolveCandidates(url)  ← 原始 URL，不是 resolved
       │    ├→ for candidate in candidates:
       │    │    ├→ 检查 view tag 是否仍匹配（WeakReference，避免泄漏已销毁 Activity）
       │    │    ├→ downloadBitmap(context, cacheDir, candidate, maxSize, maxBytes)
       │    │    │    ├→ 磁盘缓存命中 → decodeSampledBitmap
       │    │    │    └→ 网络：connect(4s 或 12s) → 读流 → 写磁盘临时文件 → decode
       │    │    └→ 成功 break
       │    └→ 主线程：设置图片 + 写内存缓存 + 回调 onResult(success)
       └→ 头像：enqueueAvatarTarget + deliverPendingAvatarTargets（合并同 URL 请求）
```

**关键约束**：
- **不使用 `inBitmap`**：`ImageLoaderDecodeSupport` 完全移除 `inBitmap`/`inMutable` 字段访问，避免 API 9 `NoSuchFieldError` 和图片串图。
- **`WeakReference<ImageView>`**：后台 Runnable 不强引用 View，避免泄漏已销毁 Activity。
- **`ImageLoadResultListener`**：扩展 `ImageLoadListener`，增加 `onResult(url, success)`，预览页据此显示失败/重试。
- **滚动暂停**：`setInlineLoadsPaused(true)` / `setGlobalPauseForScroll(true)` 停止网络加载，恢复后由上层重新触发。
- **4 秒快速回退**：`shouldUseFastFailoverTimeout` 对 `files.*` 和 `60.*` 域名使用 4 秒超时，避免首线路卡住时图片空白十几秒；`oc.*` 主站使用正常 12/20 秒。

---

## 6. 资源与 OSS 链路

### 6.1 媒体 URL 解析（`MediaUrlResolver`）

**候选顺序**（上传资源）：
```
1. https://files.mcl0.dpdns.org/{oss_path}     ← 阿里云 OSS（自定义域名）
2. http://60.205.94.101:8080/v1/uploads/{path} ← 旧主服务器
3. https://oc.mcl0.dpdns.org/v1/uploads/{path}  ← 当前 Cloudflare 主站
4. {HttpUtil.BASE_URL}/v1/uploads/{path}        ← 用户自定义服务器
```

**解析规则**：
- 相对路径 `/v1/uploads/media/a.jpg` → 生成全部 4 个候选。
- 绝对 URL 属于已知源站（files/60/oc/aliyuncs/data server）→ 改写为 4 个候选。
- **第三方绝对 URL**（即使路径含 `/uploads/`）→ 保留原 URL，不改写。
- `resolve(url)` 返回第一个候选；`resolveCandidates(url)` 返回全部；`resolveNextCandidate(current)` 返回下一个。

**所有媒体消费者必须遍历候选**：
- `ImageLoader`：图片加载遍历全部候选。
- `DownloadUtil` / `DownloadUtilStorageSupport`：文件下载遍历全部候选。
- `MessageVoicePlayer` / `GroupMessageVoicePlayer`：语音播放遍历。
- `MusicPlaybackService`：音乐播放和缓存遍历。
- `OldViewVideoFullActivity` / `OldViewVideoDetailSupport0`：视频播放遍历候选，错误时切换下一线路。
- `MusicPlayerActivity.loadLyrics`：歌词遍历候选。

**认证头安全**（`DownloadUtilStorageSupport.shouldAttachAuth`）：
- 只对 OldChat 可信源站（当前 BASE_URL、oc、60、data server）附加 `Authorization: Bearer`。
- **files OSS 和第三方 URL 不携带登录 token**。

### 6.2 图片预览（`ImagePreviewActivity` + `ZoomImageView`）

**`ImagePreviewActivity`**：
- `ImageLoader.loadLarge` 加载原图（`cacheInMemory=false`）。
- 加载中显示 ProgressBar；失败显示“图片加载失败，点击重试”。
- `PreviewLoadListener` 使用 `WeakReference` + token，Activity 销毁后不回调。
- `onDestroy` 自增 token 取消后续候选请求。

**`ZoomImageView`**：
- 继承 `AppCompatImageView`，`ScaleType.MATRIX`。
- `baseScale = min(viewW/drawableW, viewH/drawableH)`：大图首次完整适配屏幕（旧实现强制 1.0 会裁切）。
- 双击切换 `baseScale ↔ baseScale*2.5`。
- 双指缩放 `[baseScale, baseScale*4]`。
- 拖动边界约束：图片不超出可视区域。
- `GestureDetector` + `ScaleGestureDetector`，API 9 兼容。

### 6.3 文件上传限制

**图片**：3MB（`maxImageMediaBytes`）。
**媒体**：50MB（`maxMediaBytes`）。
**文件**：1GB（`MAX_FILE_BYTES`）。
- 已知大小 → 预检拒绝。
- 未知大小 → 流式上传边读边累计 `written`，超过 1GB 立即返回 413。

### 6.4 下载（`DownloadUtil`）

- API 29+ → `DownloadUtilMediaStoreApi29`（MediaStore.Downloads）。
- 旧系统 → 公共 Downloads 目录 + `MediaScannerConnection`。
- 临时文件 `.tmp` 原子落盘，失败删除。
- 遍历全部候选 URL，任一成功即返回。

---

## 7. 首页与未读

### 7.1 聊天列表（`ChatsFragment`）

**数据源**：`RecentChatBuilder.buildCombinedList(app, unreadNotifications)` 合并：
- `RecentChatCache`（私聊最近会话）
- `GroupRecentChatCache`（群聊最近会话）
- 系统通知

**分段**：
- News（有未读信号 + 新闻启用）
- Chats（普通会话）
- Folded（折叠的旧会话）

**刷新策略**：
- WS 消息 → `scheduleReload(220ms)` 防抖。
- `loadRecentsAsync`：单线程 executor，合并最新数据 → `RecentSnapshotStore.save` → 主线程 `ui.renderSections`。
- `loadRunning` 期间新请求 → `reloadAfterLoad=true`，当前完成后重跑。

**WS Listener**：
- `onDirectMessage` / `onGroupMessage` / `onRecall` → `scheduleReload`。
- `onPresence` → `UserPresenceCache.put` + `scheduleReload`。
- `onConnectionChanged` → 更新连接状态 + 同步未读。

### 7.2 未读同步

**进入聊天页**：
- `WSManager.start` 时 `onSuccess` 同步 `/direct/unread` + `/groups/unread`。
- `WSUnreadSyncCoordinator` 协调，`WSUnreadSyncHandler` 后台解析 JSON → 批量 `onDirectMessagesBatch`。
- 重连成功后执行未读补偿。

**已读推进**：
- 私聊：`POST /direct/read {thread_id}`。
- 群聊：`POST /groups/read {group_id}`（独立接口，不依赖历史 GET 的 `mark_read`）。
- 防抖 3 秒。

**首页红点**：
- `FriendRequestStore.getPendingCount` → 好友 Tab 红点。
- `NotificationReadStore` → 系统 notification 未读。

### 7.3 好友列表（`FriendsFragment`）

- `FriendAdapter`：好友 + 群组 + 系统通知 + 好友请求。
- `FriendCache` / `GroupCache`：内存镜像 + 后台 Gson 持久化。
- 搜索过滤、FAB 菜单（加好友/建群）。
- WS Presence → `UserPresenceCache` → 140ms 防抖刷新。
- 自动恢复：网络恢复后重试好友列表。

### 7.4 个人页（`ProfileFragment`）

- `GET /me` → 缓存到 `profile_cache` SP → 渲染头像/昵称/称号/UID/余额/信誉/在线状态。
- 在线状态切换：`POST /me/presence {presence_status}`。
- 入口：编辑资料、我的空间、收藏、设置。

---

## 8. 动态、发现与社交

### 8.1 动态（`MomentsActivity` / `MomentComposeActivity`）

- `GET /moments/v2`、`GET /moments/user`。
- `POST /moments`（发布，支持图片）。
- `POST /moments/like` / `moments/unlike`、`moments/comment`、`moments/comment/delete`、`moments/delete`。
- `MomentCache` + `MomentNoticeStore`（通知红点）。
- 图片九宫格 + `MomentGalleryActivity` 全屏浏览。

### 8.2 发现页（`DiscoverFragment`）

入口列表：
- 动态、表情广场、音乐广场、极简新闻、OldView、签到墙、举报进度、公开法庭、发现设置、小程序、CIP 开发、VibeCoding、导入 CIP、Lua/CIP 文档。
- `syncEntryVisibility`：根据设置显示/隐藏 OldView 和公开法庭入口。
- Lua 应用：`LuaAppStore.getApps` 本地渲染 → `LuaAppSyncManager.sync` 远程更新 → 重新渲染。
- 本地导入：`ACTION_OPEN_DOCUMENT`（API 19+）或 `ACTION_GET_CONTENT` → `LocalCipImporter.importPackage`。

### 8.3 表情广场（`EmojiPlazaActivity`）

- `GET /emoji/plaza`、`POST /emoji/plaza/upload`、`POST /emoji/plaza/save`、`POST /emoji/plaza/delete`。
- `GET /emoji/plaza/mine`。

### 8.4 音乐（`MusicPlazaActivity` / `MusicPlayerActivity` / `MusicPlaybackService`）

- `GET /music/plaza`、`/music/plaza/ranking`、`/music/plaza/mine`。
- `POST /music/plaza/upload`（歌曲/封面/歌词分三类）、`/music/plaza/update`（owner 修改元数据）。
- `POST /music/plaza/play`（记录播放）、`/music/plaza/like`/`unlike`。
- `GET /music/plaza/comments`、`POST /music/plaza/comment`。
- 播放：`MusicPlaybackService`（前台服务，API 21+ AudioAttributes 隔离，API 26+ 通知隔离）。
- 歌词：`loadLyrics` 遍历全部候选 URL。
- 缓存下载：`ensureCachedMusicFile` 遍历候选。

### 8.5 OldView（B 站集成）

- `OldViewActivity`：首页/搜索/关注/收藏/历史。
- `OldViewVideoDetailActivity`：视频详情 + 内嵌播放。
- `OldViewVideoFullActivity`：全屏横屏播放。
  - 候选列表：`videoCandidates = resolveCandidates(url)`。
  - `onError` → `tryNextNetworkCandidate()` 切换下一线路。
  - 缓存播放：`downloadCandidatesToCache` 遍历候选下载到本地。
  - `destroyed` 标志：Activity 销毁后停止下载。
- `OldViewUpProfileActivity`：UP 主主页。

### 8.6 签到墙与公开法庭

- `GET /me/checkin/wall`、`POST /me/checkin`、`POST /me/checkin/wall/like`/`unlike`/`comment`。
- `GET /public-court/cases`、`GET /public-court/cases/{id}`。

### 8.7 红包

- `RedPacketSendActivity`：`POST /redpackets/send`。
- `RedPacketOpenActivity`：`POST /redpackets/claim`。
- `RedPacketDetailActivity`：`GET /redpackets/{id}`。
- 群红包也支持 `group_seq`。

---

## 9. 阅后即焚

- `burn_after_seconds > 0` 的消息在被读后启动倒计时。
- `burn_start_at`：服务端标记开始燃烧时间。
- `BurnMessageUiHelper`：UI 倒计时显示。
- `BurnSecureViewActivity`：安全查看（防截屏，API 14+）。
- 服务端定期清理过期 burn 消息（`StartDirectBurnCleanup` / `StartGroupBurnCleanup`）。
- `POST /direct/burn/open` / `/groups/burn/open`。

---

## 10. CIP 小程序与 VibeCoding

### 10.1 CIP 包格式

```
manifest.json    # 必须
main.lua          # 必须
assets/           # 可选资源
```

**`manifest.json`**：
```json
{
  "id": "unique-app-id",
  "name": "应用名",
  "description": "描述",
  "version": "1.0.0",
  "icon_url": "/v1/uploads/media/xxx.png",
  "permissions": ["camera", "network", "network_external", "storage"],
  "allowed_hosts": ["example.com"],
  "enabled": true
}
```

**限制**：
- 包 2 MiB，解压 8 MiB，128 文件。
- Lua 脚本最大 512 KiB。
- `assets/` 下仅允许文本格式。

### 10.2 Lua 沙箱（`LuaMiniAppActivity`）

**删除的危险库**：`dofile`、`loadfile`、`require`、`package`、`io`、`os`、`debug`、`luajava`。

**可用 API**：
- 基础 Lua 5.2（`string`/`table`/`math`/`coroutine`）。
- `ui.*`：原生 UI DSL（`ui.label`/`ui.button`/`ui.image`/`ui.list`/`ui.input`/`ui.checkbox`/`ui.scroll`）。
- `app.storage_get(key)` / `app.storage_set(key, value)` / `app.storage_del(key)`。
- `app.json_decode` / `app.json_encode`。
- `app.delay(ms)` / `app.set_visible(view, visible)`。
- `app.on_input(callback)` / `app.on_event(name, callback)`。
- `network.get(path)`：宿主 API（相对路径，携带登录 token）。
- `network_external.get(url)`：公网 HTTP/HTTPS（不携带 token，阻断私网）。
- `camera.take_photo()`（需 `camera` 权限）。

**存储隔离**：每个应用使用 `lua_<app-id>` SP。

### 10.3 外部 HTTP（`LuaExternalHttp`）

- 仅 `network_external` 权限允许。
- `allowed_hosts` 空 → 允许任意公网域名；`["*"]` → 显式允许全部。
- **DNS 解析必须在工作线程**（`cip-external-http` 线程），否则 Android 3.0+ 抛 `NetworkOnMainThreadException`。
- 阻断：本机、私网（`isSiteLocalAddress`）、链路本地、多播、ULA IPv6（`raw[0] & 0xfe == 0xfc`）。
- 不跟随重定向（`setInstanceFollowRedirects(false)`）。
- 响应上限 512 KiB。

### 10.4 VibeCoding（`CipVibeCodingActivity` + `CipVibeAgent` + `CipVibeTools`）

**工具白名单**：`read` / `write` / `edit` / `grep` / `run` / `test` / `run_test` / `tasklist` / `ask`。
- `run` / `test` 只校验 manifest 并编译 Lua，**不执行脚本或 Shell**。
- 无 Shell、无 Java 反射、无聊天数据、无工作区外访问。

**AI 代理**：
- OpenAI 兼容 `POST /v1/chat/completions`（服务端 `/v1/ai/chat/completions` 代理）。
- 系统提示限定工作区、工具、宿主 API 和外部网络权限。
- 无固定轮次限制，但可停止、内存有界、上下文有界。
- 前台服务 `CipVibeBackgroundService`（API 26+ 通知隔离 `CipVibeNotificationApi26`）。
- 通知停止操作 + 400ms 合并渲染 + 时序推理段。

### 10.5 CIP IDE（`CipDeveloperActivity`）

- 文件树 + 编辑器 + 预览。
- 测试/打包/导出 ZIP。
- `configChanges=keyboardHidden|orientation|screenSize` 避免旋转重建。
- **禁用全局按压反馈**：`useSquarePressFeedback()` 返回 false。

---

## 11. 后台服务

### 11.1 `MessageService`

- 启动 WebSocket、保持连接。
- `START_STICKY`。
- API 26+ 前台服务通知（`MessageService.Api26` 内部类隔离）。
- `onDestroy` 停止全局 WS。

### 11.2 `MusicPlaybackService`

- 前台服务播放音乐。
- API 21+ `AudioAttributes`（`MusicPlaybackApi21` 隔离）。
- API 26+ 通知（`MusicPlaybackNotificationApi26` 隔离）。
- 候选回退：`resolveNextCandidate` + `ensureCachedMusicFile` 遍历候选。
- API 11+ AsyncTask 通过 `MusicPlaybackAsyncApi11` 隔离。

### 11.3 `ResourceUploadService`

- 后台资源上传。

### 11.4 `CipVibeBackgroundService`

- VibeCoding AI 后台执行。
- API 26+ 通知（`CipVibeNotificationApi26`）。

---

## 12. 缓存层

### 12.1 SharedPreferences 清单

| SP 名称 | 用途 |
|---------|------|
| `auth` | access_token / refresh_token / user_id / my_uid / saved_username / saved_password |
| `settings` | server_base_url / files_server_base_url / 夜间模式 / DPI / 首页设置 |
| `message_history_cache` | direct_{uid} / group_{gid} 消息 JSON |
| `group_sync_watermarks` | (group_seq, anchor_message_id) |
| `profile_cache` | me_profile_json |
| `lua_<app-id>` | CIP 应用存储 |
| `notification` | 通知已读 |
| `oldchat_settings` | 通用设置 |
| `user_space_profile_cache` | 用户空间资料缓存 |

### 12.2 `MessageHistoryCache`

- 最多保留尾部 200 条（`MAX_MESSAGES`）。
- **`localPending` 消息不持久化**：`snapshot*WithoutPending` 过滤。
- 读取时 `removeStalePending` 清理遗留 pending（兼容旧版本缓存）。
- 异步串行保存（`SAVE_EXECUTOR` 单线程）。
- `generation` 校验：防止 `clearAll` 后旧保存任务复活。
- `pauseSave` / `resumeSave`：滚动期间暂停序列化，保留最新快照，恢复后继续。

### 12.3 `RecentChatCache` / `GroupRecentChatCache`

- 线程安全内存镜像 + 深拷贝读取。
- 后台 coalesced Gson 持久化。
- 静态 Gson 实例。

### 12.4 `FriendCache` / `GroupCache`

- 同上：内存镜像 + 后台持久化。

---

## 13. 兼容性铁律（minSdk 9）

### 13.1 API 隔离模式

**所有 API 11+ 调用必须隔离到独立 `@TargetApi` 类**，因为 Dalvik 在 API 9/10 加载类时会验证所有引用字段/方法：

| API | 隔离类 | 用途 |
|-----|--------|------|
| 10 | `VideoMetadataApi10` | `MediaMetadataRetriever` |
| 11 | `ChatInputMenuApi11` / `ChatInputMenuApi23` | `ActionMode.Callback` |
| 11 | `AsyncTaskExecutionApi11` | `AsyncTask.executeOnExecutor` / `THREAD_POOL_EXECUTOR` |
| 11 | `MusicPlaybackAsyncApi11` | 同上（音乐服务专用） |
| 14 | `AppStateApi14` | `ActivityLifecycleCallbacks` |
| 14 | `MemoryTrimApi14` | `ComponentCallbacks2` |
| 21 | `MusicPlaybackApi21` | `AudioAttributes` |
| 26 | `MusicPlaybackNotificationApi26` | 通知 Channel / Builder |
| 26 | `CipVibeNotificationApi26` | 同上 |
| 29 | `DownloadUtilMediaStoreApi29` | `MediaStore.Downloads` |
| 29 | `QrImageSaverApi29` | `MediaStore.Images` |

**统一入口**：`AsyncTaskExecutionCompat.execute(task, params)` 替代所有 `executeOnExecutor` 调用。

### 13.2 Java 7 语法

- **不使用** lambda、方法引用、`try-with-resources`、diamond（部分旧代码有，新代码避免）、`default` 方法。
- `sourceCompatibility = 1.8` + D8 desugar 是为了 AGP 8 兼容，不代表可以用 Java 8 语法。

### 13.3 资源

- **不使用 vector drawable**：Android 2.3 不支持，会 `InflateException`。
- 图标用 PNG 或系统内置 drawable。
- `AppCompatImageView` + `app:srcCompat` 用于需要兼容的矢量（仅在已确认安全时）。

### 13.4 其他

- `ViewCompat` 用于 `setAlpha` / `setTranslationX` / `animate` / `setScaleX`（API 11+）。
- `FontAwesomeTextView` 继承 `AppCompatTextView`。
- `MemoryMonitor` 通过反射读 `totalMem`。
- `DeviceInfoUtil.getImei()` 反射 `getDeviceId()` 避免 lint `MissingPermission`。
- `RecyclerViewOptimizationHelper` 不调用 `suppressLayout`（API 29+）。
- `ImageLoaderDecodeSupport` 完全移除 `inBitmap` / `inMutable`。

---

## 14. 构建、测试与发布

### 14.1 环境要求

- JDK 17（运行 Gradle）：`/usr/libexec/java_home -v 17`
- Android SDK：`compileSdk 33`，Build Tools 34.0.0+
- `local.properties`：`sdk.dir=...`
- `keystore.properties`：签名配置（不入库）

### 14.2 构建命令

```bash
# 设置 JDK 17
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$JAVA_HOME/bin:$PATH"

# Debug 构建（MultiDex）
./gradlew :app:assembleDebug

# Release 构建（R8 + 资源压缩 + 签名）
./gradlew :app:assembleRelease

# Lint
./gradlew :app:lintRelease :app:lintVitalRelease

# Clean + Release + Lint
./gradlew clean :app:assembleRelease :app:lintRelease :app:lintVitalRelease

# 一键脚本（构建 + 安装 + logcat）
BUILD_ONLY=1 VARIANT=release ./build_install_android.sh
VARIANT=debug LOGCAT=0 ./build_install_android.sh
```

### 14.3 发布前检查清单

1. **版本号**：`app/build.gradle` 同时递增 `versionCode` 和 `versionName`。
2. **`update.json`**：更新 `version_code` / `version_name` / `apk` 文件名 / `notes`。
3. **Clean Release**：`./gradlew clean :app:assembleRelease`。
4. **Lint**：`lintRelease` 0 errors，0 NewApi。
5. **DEX**：单 DEX，`minSdkVersion=9`。
6. **签名**：`apksigner verify --verbose` v1+v2 通过。
7. **DEX strings**：检查关键常量（`files.mcl0.dpdns.org`、`60.205.94.101:8080`、`oc.mcl0.dpdns.org`）存在。
8. **无敏感信息**：DEX strings 不含 AccessKey / Secret。
9. **上传**：
   - `/A-chat/update/oldchat-{version}.apk`
   - `/A-chat/update/oldchat.apk`（稳定别名）
   - `/A-chat/webapp/oldchat.apk`
   - `/A-chat/update/update.json`
10. **验证**：
    ```bash
    curl -fsS https://oc.mcl0.dpdns.org/update/update.json
    curl -fsS https://oc.mcl0.dpdns.org/update/oldchat-{version}.apk | shasum -a 256
    curl -fsS -r 0-1023 https://oc.mcl0.dpdns.org/update/oldchat-{version}.apk  # Range 支持
    ```

### 14.4 文档同步

每次较大改动后：
- 在 `change_history/` 写 Markdown 说明改了哪些文件、完成了什么。
- 更新 `app/CLIENT_DEVELOPMENT_GUIDE.md`（本文档）。
- 服务端 API 变动同步更新 `/api.md`、`/routes.md`。
- `exp.md` 记录易犯错误和优质经验。

---

## 15. 常见扩展指南

### 15.1 新增 HTTP API

```java
// 1. 走 HttpUtil，自动处理认证/加密/刷新
HttpUtil.post("/my/new/endpoint", jsonBody, token, new HttpUtil.Callback() {
    @Override public void onSuccess(String response) { /* 主线程 */ }
    @Override public void onError(int code, String error) {
        if (HttpUtil.shouldSuppressAuthToast(code, error)) return;
        Toast.makeText(context, "失败: " + code, Toast.LENGTH_SHORT).show();
    }
});
```

- 不要绕过 `HttpUtil` 自行管理认证。
- `/auth/*` 路径不会触发自动刷新。

### 15.2 新增 WebSocket 事件

1. `WSModels` 添加事件类。
2. `WSManager.Listener` 添加回调方法。
3. `WSIncomingHandler` 解析 JSON → 更新缓存 → 分发。
4. `WSDispatchHelper` 切主线程调用 Listener。
5. UI 在 `onResume/onPause` 注册/注销 Listener。

### 15.3 新增消息类型

1. `Message.msg_type` 添加常量。
2. `MessageAdapter.bindMessageTypeSection` 添加渲染分支。
3. `MessagePayload.media_kind` 添加类型（如需）。
4. 发送器添加 `sendXxx` 方法。
5. 预览/播放 Activity（如需）。

### 15.4 新增 Activity

```java
public class MyActivity extends BaseActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // super.onCreate 前主题已由 BaseActivity 应用
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_my);
        // findViewById 用 findViewByIdCompat（兼容 API 9）
    }
}
```

- 若不需要全局按压反馈：`@Override protected boolean useSquarePressFeedback() { return false; }`。
- 高版本 API 调用必须隔离到 `@TargetApi` 类。

### 15.5 新增 API 隔离类

```java
@TargetApi(21)
public class MyFeatureApi21 {
    public static void doSomething() {
        // API 21+ 调用
    }
}

// 调用方
if (Build.VERSION.SDK_INT >= 21) {
    MyFeatureApi21.doSomething();
} else {
    // 降级实现
}
```

---

## 16. 禁止做法

1. **不要持久化 `localPending` 消息**：进程被杀后无法恢复上传任务，会留下永久“发送中”。
2. **不要用 `resolve()` 后的 URL 重新推导候选**：OSS 地址不含 `/uploads/`，会丢失回退线路。
3. **不要在主线程解析 DNS**：Android 3.0+ 抛 `NetworkOnMainThreadException`。
4. **不要对第三方 URL 附加登录 token**：会泄露凭证。
5. **不要刷新时清空消息列表**：HTTP 期间可能收到 WS 消息。
6. **不要在空响应时清空列表**：transient empty 不是消息丢失。
7. **不要在 WS 中推进群水位**：漏包后 HTTP 将永久跳过缺失消息。
8. **不要使用 `inBitmap`**：API 9 `NoSuchFieldError` + 图片串图。
9. **不要使用 vector drawable**：Android 2.3 不支持。
10. **不要使用 Java 8 语法**：lambda / 方法引用 / try-with-resources / default 方法。
11. **不要在同一类中混合 API 11+ 类型**：Dalvik 验证会 `VerifyError`。
12. **不要让后台 Runnable 强引用 View**：泄漏已销毁 Activity。
13. **不要对 `/auth/login`、`/auth/register`、`/auth/refresh` 触发自动刷新**。
14. **不要在 `super.onCreate()` 后才应用主题**：会闪烁。
15. **不要在单个文件超过 300 行**：拆分 Support 类。

---

## 17. 相关文档

- 服务端 API 标准：`https://oc.mcl0.dpdns.org/api.md`
- 服务端路由清单：`https://oc.mcl0.dpdns.org/routes.md`
- Lua/CIP 开发规范：`https://oc.mcl0.dpdns.org/lua-cip.md`
- OSS 集成说明：`server/OSS_INTEGRATION.md`
- WebSocket 协议：`server/WS_PROTOCOL.md`
- 外部登录 API：`server/AUTH_LOGIN_EXTERNAL_API.md`
- AI 代理 API：`server/AI_PROXY_API.md`
- 经验记录：`exp.md`
- 变更历史：`change_history/`

## 18. API 调用方式与样例

本章给出客户端实际使用的每个 HTTP 接口的请求/响应样例，以及可直接复用的 Java 源码片段。所有样例假设 `token` 已从 `auth` SP 读取，`HttpUtil.BASE_URL` 默认为 `http://60.205.94.101:8080/v1`（可由用户在设置页修改）。

### 18.1 认证类

#### POST /auth/register

注册新用户。

```json
// Request
{
  "username": "alice",
  "password": "secret123",
  "email": "alice@example.com",
  "captcha_id": "cap_id",
  "captcha_code": "ABCD",
  "email_code": "123456",
  "device_id": "android-xxx",
  "device_name": "Pixel",
  "platform": "android",
  "app_version": "1.3.50"
}

// Response 201
{
  "access_token": "eyJ...",
  "refresh_token": "ref...",
  "user_id": "internal_id",
  "uid": "USR-ABCD1234"
}
```

#### POST /auth/login

登录。

```json
// Request
{
  "username": "alice",
  "password": "secret123",
  "device_id": "android-xxx",
  "imei": "356938035643809",
  "device_name": "Pixel",
  "platform": "android",
  "app_version": "1.3.50"
}

// Response 200
{
  "access_token": "eyJ...",
  "refresh_token": "ref...",
  "user_id": "internal_id",
  "uid": "USR-ABCD1234"
}
```

**客户端登录后必须保存**：`access_token`、`refresh_token`、`user_id`、`my_uid`、`saved_username`、`saved_password`（用于 refresh 失败后密码回退）。

#### POST /auth/handshake

ECDH 会话握手。**明文请求，不加密**。

```json
// Request
{
  "client_public_key": "BASE64_ENCODED_PUBLIC_KEY"
}

// Response 200
{
  "session_id": "sess_xxx",
  "server_public_key": "BASE64_ENCODED_SERVER_PUBLIC_KEY"
}
```

握手后客户端派生 `encKey`（AES）和 `macKey`（HMAC），后续加密请求携带 `X-Enc:1`、`X-Session:<session_id>`、`X-Enc-Compression:gzip`。

#### POST /auth/refresh

刷新 access token。

```json
// Request
{
  "refresh_token": "ref..."
}

// Response 200
{
  "access_token": "eyJ...new",
  "refresh_token": "ref...new"
}
```

refresh_token 失效时，客户端回退到 `POST /auth/login` 密码登录。`authGeneration` 防止退出后旧刷新覆盖新状态。

#### GET /auth/captcha

获取图形验证码。返回 `image/png` 二进制流，响应头包含 `X-Captcha-Id`。

```java
// 客户端
HttpURLConnection conn = (HttpURLConnection) new URL(HttpUtil.BASE_URL + "/auth/captcha").openConnection();
String captchaId = conn.getHeaderField("X-Captcha-Id");
InputStream is = conn.getInputStream();
// 解码为 Bitmap 显示
```

#### POST /auth/email/send

发送邮箱验证码。

```json
// Request
{ "email": "alice@example.com" }
// Response 200
{ "status": "ok" }
```

#### POST /auth/password/reset

密码重置。

```json
// Request
{ "email": "alice@example.com", "code": "123456", "new_password": "new123" }
// Response 200
{ "status": "ok" }
```

### 18.2 用户类

#### GET /me

获取当前用户资料。

```json
// Response 200
{
  "uid": "USR-ABCD1234",
  "username": "alice",
  "display_name": "Alice",
  "avatar_url": "/v1/uploads/media/xxx.jpg",
  "cover_url": "/v1/uploads/covers/xxx.jpg",
  "signature": "hello",
  "user_title": "开发者",
  "coin_balance": 100,
  "reputation_score": 50,
  "presence_status": "online",
  "email": "alice@example.com"
}
```

#### POST /me/avatar (multipart)

上传头像。

```java
HttpUtil.uploadMultipart("/me/avatar", fileUri, "image/jpeg", token, new HttpUtil.Callback() {
    @Override public void onSuccess(String response) {
        // Response 200: {"avatar_url":"/v1/uploads/avatars/xxx.jpg", ...}
    }
    @Override public void onError(int code, String error) { }
});
```

#### POST /me/cover (multipart)

上传个人空间封面。同上。

#### POST /me/profile

修改资料。

```json
// Request
{ "display_name": "Alice2", "signature": "new sig" }
// Response 200
{ "status": "ok" }
```

#### POST /me/presence

设置在线状态。

```json
// Request
{ "presence_status": "invisible" }
// Response 200
{ "uid": "USR-ABCD1234", "presence_status": "invisible" }
```

#### GET /me/devices

获取登录设备列表。

#### POST /me/devices/cleanup-others

清除其他设备登录。

#### POST /me/password

修改密码。

```json
// Request
{ "old_password": "old", "new_password": "new" }
// Response 200
{ "status": "ok" }
```

#### GET /users/profile?uid=USR-xxx

查看其他用户资料。

### 18.3 私聊类

#### POST /direct/send

发送私聊消息。

```json
// Request（文本）
{
  "to_uid": "USR-TARGET",
  "body": "{\"v\":2,\"text\":\"你好\"}",
  "msg_type": "text",
  "burn_after_seconds": 0
}

// Request（图片）
{
  "to_uid": "USR-TARGET",
  "body": "{\"v\":2,\"text\":\"\",\"media_kind\":\"image\"}",
  "msg_type": "image",
  "media_url": "/v1/uploads/media/xxx.jpg",
  "thumb_url": "/v1/uploads/media/thumb-xxx.jpg",
  "burn_after_seconds": 0
}

// Response 201
{
  "id": "msg_internal_id",
  "thread_id": "thread_xxx",
  "from_uid": "USR-ME",
  "body": "{\"v\":2,\"text\":\"你好\"}",
  "msg_type": "text",
  "created_at": 1785123456,
  "sort_seq": 12345
}
```

#### GET /direct/messages/v2?with_uid=USR-xxx&limit=50

历史消息 v2（游标分页）。

```json
// Response 200
{
  "messages": [
    {
      "id": "msg_id",
      "thread_id": "thread_xxx",
      "from_uid": "USR-xxx",
      "from_ncuid": "USR-xxx",
      "body": "你好",
      "msg_type": "text",
      "media_url": "",
      "thumb_url": "",
      "duration_ms": 0,
      "burn_after_seconds": 0,
      "burn_start_at": null,
      "created_at": 1785123456,
      "sort_seq": 12345
    }
  ],
  "effective_offset": 0,
  "has_more": true,
  "next_before_created_at": 1785123000,
  "next_before_id": "oldest_msg_id"
}
```

下一页：`&before_created_at=1785123000&before_id=oldest_msg_id`。

旧服务端无 v2 -> 404 -> 客户端回退 `/direct/messages?with_uid=&limit=&offset=`。

#### POST /direct/unread

未读消息同步。

```json
// Request
{ "limit": 100, "offset": 0 }
// Response 200
{ "messages": [], "has_more": false }
```

#### POST /direct/read

标记已读。

```json
// Request
{ "thread_id": "thread_xxx" }
// Response 200
{ "status": "ok" }
```

#### POST /direct/burn/open

打开阅后即焚消息。

#### GET /direct/messages/search?with_uid=USR-xxx&keyword=hello

搜索消息。

### 18.4 群聊类

#### POST /groups/message/send

发送群消息。

```json
// Request
{
  "group_id": "GRP-ABCD1234",
  "body": "{\"v\":2,\"text\":\"你好\"}",
  "msg_type": "text",
  "burn_after_seconds": 0
}
// Response 201
{
  "id": "msg_id",
  "group_id": "GRP-ABCD1234",
  "from_uid": "USR-ME",
  "body": "...",
  "msg_type": "text",
  "created_at": 1785123456,
  "sort_seq": 12345,
  "group_seq": 1201,
  "read_count": 0
}
```

#### GET /groups/messages/v2?group_id=GRP-xxx&limit=50&mark_read=0

群历史 v2。`mark_read=0` 表示由独立 `/groups/read` 推进已读。

#### GET /groups/messages/after?group_id=GRP-xxx&after_seq=1200&limit=100

断线增量同步。

```json
// Response 200
{
  "messages": [{ "id": "msg_id", "group_seq": 1201 }],
  "has_more": false,
  "next_group_seq": 1201,
  "server_group_seq": 1201
}
```

#### POST /groups/read

标记群已读。

```json
// Request
{ "group_id": "GRP-xxx" }
// Response 200
{ "status": "ok" }
```

#### POST /groups/unread

群未读同步。

#### GET /groups/list

群列表。

#### POST /groups/create

建群。

```json
// Request
{ "name": "群名", "avatar_url": "", "member_uids": ["USR-A", "USR-B"] }
// Response 201
{ "id": "GRP-xxx", "name": "群名" }
```

#### POST /groups/join、/groups/leave、/groups/invite、/groups/kick

群成员管理。

#### POST /groups/typing

```json
// Request
{ "group_id": "GRP-xxx", "is_typing": true }
```

### 18.5 好友类

#### GET /friends

好友列表。

#### POST /friends/request

```json
// Request
{ "to_uid": "USR-xxx", "message": "你好" }
// Response 201
{ "status": "ok" }
```

#### POST /friends/respond

```json
// Request
{ "request_id": "req_xxx", "accept": true }
```

#### POST /friends/remark

```json
// Request
{ "friend_uid": "USR-xxx", "remark": "备注名" }
```

### 18.6 媒体上传类

#### POST /media (multipart)

上传图片/视频/语音。最大 50MB，图片 3MB。

```java
// 客户端示例
HttpUtil.uploadMultipart("/media", fileUri, mimeType, token, new HttpUtil.Callback() {
    @Override public void onSuccess(String response) {
        // { "url": "/v1/uploads/media/xxx.jpg", "thumb_url": "/v1/uploads/media/thumb-xxx.jpg" }
    }
    @Override public void onError(int code, String error) { }
});
```

#### GET /v1/uploads/media/xxx.jpg

下载媒体（走 MediaUrlResolver 候选链：files -> 60 -> oc -> 自定义）。

### 18.7 动态类

#### GET /moments/v2

#### POST /moments (multipart, 含图片)

#### POST /moments/like、/moments/unlike、/moments/comment、/moments/delete

### 18.8 AI 代理类

#### GET /ai/quota

```json
// Response 200
{ "remaining": 4999900, "total": 5000000 }
```

#### POST /ai/chat/completions

OpenAI 兼容。

```json
// Request
{
  "model": "deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
// Response: SSE text/event-stream
data: {"choices":[{"delta":{"content":"你"}}]}

data: [DONE]
```

### 18.9 系统通知类

#### GET /notifications

```json
// Response 200
{
  "notifications": [
    { "id": "n1", "title": "公告", "body": "内容", "important": false, "created_at": 1785123456 }
  ]
}
```

### 18.10 CIP/Lua 类

#### GET /discover/lua/manifest

获取远程 Lua 应用清单。

#### GET /discover/lua/apps/{id}

获取单个应用脚本。

#### GET /lua-cip.md

开发文档（公开 Markdown）。

### 18.11 OSS 签名下载

#### GET /oss/{object_key}

私有 OSS 对象签名入口，返回 307 重定向到 10 分钟有效的 HTTPS 签名 URL。

```http
GET /oss/media/xxx.jpg
Authorization: Bearer <token>

HTTP/1.1 307
location: https://ocaht.oss-cn-hongkong.aliyuncs.com/media/xxx.jpg?Expires=...&Signature=...
```

---

## 19. 可复用源码片段

以下片段可直接放入新 Android 客户端使用，均已验证与 minSdk 9 / Java 7 / Support Library 24.2.1 兼容。

### 19.1 HttpUtil 核心（GET/POST/上传）

```java
package com.im.oldchat.api;

import android.os.AsyncTask;
import com.im.oldchat.util.AsyncTaskExecutionCompat;
import org.json.JSONObject;

public class HttpUtil extends HttpUtilSupport1 {
    public static final String DEFAULT_BASE_URL = "http://60.205.94.101:8080/v1";
    public static volatile String BASE_URL = DEFAULT_BASE_URL;

    public interface Callback {
        void onSuccess(String response);
        void onError(int code, String error);
    }

    /** 登录/退出前废弃旧刷新结果 */
    public static void invalidateAuthOperations() {
        HttpAuthHelper.invalidateAuthOperations();
    }

    /** GET 请求 */
    public static void get(final String path, final String token, final Callback callback) {
        AsyncTaskExecutionCompat.execute(new AsyncTask<Void, Void, Result>() {
            @Override protected Result doInBackground(Void... voids) {
                return HttpUtilSupport0.requestWithRefresh("GET", path, null, token);
            }
            @Override protected void onPostExecute(Result result) {
                dispatchResult(result, callback);
            }
        }, (Void[]) null);
    }

    /** POST 请求 */
    public static void post(final String path, final JSONObject json, final String token, final Callback callback) {
        AsyncTaskExecutionCompat.execute(new AsyncTask<Void, Void, Result>() {
            @Override protected Result doInBackground(Void... voids) {
                return HttpUtilSupport0.requestWithRefresh("POST", path, json, token);
            }
            @Override protected void onPostExecute(Result result) {
                dispatchResult(result, callback);
            }
        }, (Void[]) null);
    }

    private static void dispatchResult(Result result, Callback callback) {
        if (callback == null) return;
        int code = result == null ? -1 : result.code;
        String data = result == null ? "empty response" : result.data;
        if (code >= 200 && code < 300) callback.onSuccess(data);
        else callback.onError(code, data);
    }

    public static boolean shouldSuppressAuthToast(int code, String error) {
        return HttpUtilSupport0.shouldSuppressAuthToast(code, error);
    }

    public static void showAuthWarning() {
        HttpUtilSupport0.showAuthWarning();
    }
}
```

### 19.2 HTTP 请求执行（含加密/重试/刷新）

```java
class HttpUtilSupport0 {
    protected static Result executeRequest(String method, String path, JSONObject json, String token) throws Exception {
        URL url = new URL(BASE_URL + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);
        conn.setUseCaches("GET".equals(method));
        conn.setInstanceFollowRedirects(true);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Accept-Encoding", "gzip");

        // 会话加密
        boolean encrypt = shouldEncrypt(path);
        if (encrypt && HttpAuthHelper.ensureSession()) {
            conn.setRequestProperty("X-Enc", "1");
            conn.setRequestProperty("X-Enc-Compression", "gzip");
            String sessionId = CryptoUtil.getSessionId();
            if (sessionId != null && sessionId.length() > 0) {
                conn.setRequestProperty("X-Session", sessionId);
            }
        } else {
            encrypt = false;
        }

        // 认证头
        if (token != null && token.length() > 0) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }

        // 请求体
        if (json != null) {
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            String payload = json.toString();
            if (encrypt) payload = CryptoUtil.encrypt(payload);
            OutputStream os = conn.getOutputStream();
            os.write(payload.getBytes("UTF-8"));
            os.flush();
            os.close();
        }

        int code = conn.getResponseCode();
        String body = readResponseBody(conn, code);

        // 解密响应
        if (encrypt) {
            boolean compressed = "gzip".equalsIgnoreCase(conn.getHeaderField("X-Enc-Compression"));
            String decrypted = CryptoUtil.decryptIfNeeded(body, compressed);
            if (decrypted != null) body = decrypted;
        }
        return new Result(code, body);
    }
}
```

### 19.3 Multipart 上传

```java
public static String uploadMultipart(String path, Uri fileUri, String mimeType,
                                     String token, Context context) throws Exception {
    String boundary = "----OldChatBoundary" + System.currentTimeMillis();
    URL url = new URL(BASE_URL + path);
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    conn.setConnectTimeout(20000);
    conn.setReadTimeout(120000);
    conn.setDoOutput(true);
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
    conn.setRequestProperty("Authorization", "Bearer " + token);

    OutputStream os = conn.getOutputStream();
    os.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
    os.write(("Content-Disposition: form-data; name=\"file\"; filename=\"upload\"\r\n").getBytes("UTF-8"));
    os.write(("Content-Type: " + mimeType + "\r\n\r\n").getBytes("UTF-8"));
    InputStream is = context.getContentResolver().openInputStream(fileUri);
    byte[] buffer = new byte[8192];
    int len;
    while ((len = is.read(buffer)) != -1) os.write(buffer, 0, len);
    is.close();
    os.write(("\r\n--" + boundary + "--\r\n").getBytes("UTF-8"));
    os.flush();
    os.close();

    int code = conn.getResponseCode();
    if (code >= 200 && code < 300) return readStream(conn.getInputStream());
    throw new Exception("upload failed: " + code);
}
```

### 19.4 WebSocket 连接管理

```java
public class WSManager {
    private static WSManager instance;
    private SimpleWebSocketClient client;
    private final List<Listener> listeners = new ArrayList<Listener>();
    private final ExecutorService parseExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean connected;
    private volatile int generation = 0;

    public interface Listener {
        void onDirectMessage(WSModels.DirectMessage message);
        void onGroupMessage(WSModels.GroupMessage message);
        void onDirectRecall(WSModels.DirectRecall recall);
        void onGroupRecall(WSModels.GroupRecall recall);
        void onTyping(WSModels.TypingEvent event);
        void onPresence(WSModels.PresenceEvent event);
        void onConnectionChanged(boolean connected);
    }

    public synchronized void start(Context context) {
        if (connected || connecting) return;
        connecting = true;
        final int gen = ++generation;
        HttpUtil.get("/me", token, new HttpUtil.Callback() {
            @Override public void onSuccess(String response) {
                syncUnread();
                connectWebSocket(gen);
            }
            @Override public void onError(int code, String error) {
                connectWebSocket(gen); // HTTP 失败仍尝试连接
            }
        });
    }

    private void connectWebSocket(final int gen) {
        String wsUrl = buildWsUrl(); // ws://host:port/v1/ws?token=&session=
        client = new SimpleWebSocketClient(wsUrl);
        client.setListener(new SimpleWebSocketClient.Listener() {
            @Override public void onMessage(final String raw) {
                // 读取线程先解密，再送入单线程队列保持顺序
                parseExecutor.execute(new Runnable() {
                    public void run() {
                        String decrypted = CryptoUtil.decryptIfNeeded(raw, false);
                        WSIncomingHandler.handle(decrypted, WSManager.this);
                    }
                });
            }
            @Override public void onClose() {
                if (gen != generation) return; // 旧连接忽略
                connected = false;
                CryptoUtil.clearSession();
                notifyConnectionChanged(false);
                scheduleReconnect();
            }
            @Override public void onError(Exception e) {
                if (gen != generation) return;
                connected = false;
                CryptoUtil.clearSession();
                scheduleReconnect();
            }
        });
        client.connect();
    }

    private void scheduleReconnect() {
        // 1s -> 60s 指数退避 + ±20% 抖动
        long delay = Math.min(60000, 1000L * (1L << reconnectAttempts));
        delay = (long)(delay * (0.8 + Math.random() * 0.4));
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            public void run() { start(context); }
        }, delay);
    }

    public void addListener(Listener l) { synchronized(listeners) { listeners.add(l); } }
    public void removeListener(Listener l) { synchronized(listeners) { listeners.remove(l); } }
}
```

### 19.5 消息发送完整流程

```java
public void sendText(String content, MessagePayload.Quote quoteDraft) {
    String body = MessagePayloadBuilder.buildBody(content, quoteDraft, null, null);
    final String localId = DirectPendingMessageHelper.enqueueText(
            listHelper, myUid, body, burnAfterSeconds);
    input.setText("");
    if (quoteClearListener != null) quoteClearListener.onClearQuote();

    try {
        JSONObject json = new JSONObject();
        json.put("to_uid", friendUid);
        json.put("body", body);
        json.put("msg_type", "text");
        if (burnAfterSeconds > 0) json.put("burn_after_seconds", burnAfterSeconds);

        HttpUtil.post("/direct/send", json, token, new HttpUtil.Callback() {
            @Override public void onSuccess(String response) {
                Message sent = listHelper.parseMessageFromResponse(response);
                if (sent != null) {
                    DirectPendingMessageHelper.completeText(listHelper, localId, sent);
                } else {
                    listHelper.scheduleFallbackRefresh();
                }
            }
            @Override public void onError(int code, String error) {
                DirectPendingMessageHelper.failText(listHelper, localId);
                if (code == 401) { HttpUtil.showAuthWarning(); return; }
                if (HttpUtil.shouldSuppressAuthToast(code, error)) return;
                Toast.makeText(context, "发送失败: " + code, Toast.LENGTH_SHORT).show();
            }
        });
    } catch (Exception e) {
        DirectPendingMessageHelper.failText(listHelper, localId);
    }
}
```

### 19.6 历史加载与合并

```java
void loadMessagesInternal(final Helper helper, final String token, boolean append) {
    StringBuilder path = new StringBuilder(helper.legacyHistoryRoute
            ? "/direct/messages?with_uid=" : "/direct/messages/v2?with_uid=");
    path.append(helper.friendUID).append("&limit=50&offset=").append(helper.currentOffset);
    if (!helper.legacyHistoryRoute && append) {
        Message oldest = findOldestCursorMessage(helper.messageList);
        if (oldest != null) {
            path.append("&before_created_at=").append(oldest.created_at);
            path.append("&before_id=").append(urlEncode(oldest.id));
        }
    }

    HttpUtil.get(path.toString(), token, new HttpUtil.Callback() {
        @Override public void onSuccess(String response) {
            AsyncTaskExecutionCompat.execute(new AsyncTask<Void, Void, LoadResult>() {
                @Override protected LoadResult doInBackground(Void... voids) {
                    return DirectMessageParser.parseLoadResult(response, helper.currentOffset);
                }
                @Override protected void onPostExecute(LoadResult result) {
                    mergeRefresh(helper.messageList, helper.messageIds, result.incoming, 200, append);
                    sortMessages(helper.messageList);
                    helper.adapter.notifyDataSetChanged();
                    MessageHistoryCache.saveDirectMessages(helper.context, helper.friendUID, helper.messageList);
                }
            }, (Void[]) null);
        }
        @Override public void onError(int code, String error) {
            if (code == 404 && !helper.legacyHistoryRoute) {
                helper.legacyHistoryRoute = true;
                helper.cursorPaginationDisabled = true;
                loadMessagesInternal(helper, token, append);
                return;
            }
            if (helper.messageList.isEmpty()) helper.loadFromCacheAsync();
        }
    });
}
```

### 19.7 群可靠同步核心

```java
static void pullAfter(final Helper helper, final String token, final long afterSeq) {
    String path = "/groups/messages/after?group_id=" + encode(helper.groupId)
            + "&after_seq=" + afterSeq + "&limit=100";
    HttpUtil.get(path, token, new HttpUtil.Callback() {
        @Override public void onSuccess(String response) {
            try {
                JSONObject root = new JSONObject(response);
                long serverSeq = root.optLong("server_group_seq", -1L);
                if (serverSeq >= 0L && serverSeq < afterSeq) {
                    GroupSyncWatermarkStore.clear(helper.context, helper.groupId);
                    pullLegacyUntilOverlap(helper, token, oldestAnchors(helper.messageList), 0L, "", 0L, "", true);
                    return;
                }
                List<GroupMessage> incoming = GroupMessageSyncHelper.parseIncoming(response);
                Collections.reverse(incoming);
                long next = root.optLong("next_group_seq", afterSeq);
                boolean hasMore = root.optBoolean("has_more", false);
                if (!incoming.isEmpty()) mergePage(helper, incoming);
                String anchor = findMessageIdForSeq(incoming, next);
                if (next > afterSeq && anchor.length() > 0) {
                    MessageHistoryCache.saveGroupMessages(helper.context, helper.groupId, helper.messageList);
                    GroupSyncWatermarkStore.save(helper.context, helper.groupId, next, anchor);
                }
                if (hasMore && next > afterSeq) pullAfter(helper, token, next);
                else finish(helper, token);
            } catch (Exception e) { finish(helper, token); }
        }
        @Override public void onError(int code, String error) {
            if (code == 404 || code == 405) {
                GroupSyncWatermarkStore.clear(helper.context, helper.groupId);
                pullLegacyUntilOverlap(helper, token, oldestAnchors(helper.messageList), 0L, "", 0L, "", true);
            } else {
                finish(helper, token);
            }
        }
    });
}
```

### 19.8 MediaUrlResolver 候选生成

```java
public class MediaUrlResolver {
    private static final String OSS_ORIGIN = "https://files.mcl0.dpdns.org";
    private static final String MAIN_ORIGIN_60 = "http://60.205.94.101:8080";
    private static final String CURRENT_MAIN_ORIGIN = "https://oc.mcl0.dpdns.org";

    public static String[] resolveCandidates(String url) {
        String raw = url == null ? "" : url.trim();
        if (raw.length() == 0) return new String[0];
        if (raw.startsWith("http://") || raw.startsWith("https://")) {
            return resolveAbsoluteCandidates(raw);
        }
        if (raw.startsWith("/") && isUploadPath(raw)) {
            return buildUploadCandidates(raw);
        }
        return new String[]{resolveMainOrigin() + raw};
    }

    private static String[] buildUploadCandidates(String path) {
        String ossPath = extractUploadPath(path);    // /media/xxx.jpg
        String appPath = toAppUploadPath(path);       // /v1/uploads/media/xxx.jpg
        return dedupe(new String[]{
            OSS_ORIGIN + ossPath,
            MAIN_ORIGIN_60 + appPath,
            CURRENT_MAIN_ORIGIN + appPath,
            resolveMainOrigin() + appPath
        });
    }

    private static String resolveMainOrigin() {
        String base = HttpUtil.BASE_URL;
        int idx = base.indexOf("/v1");
        return idx > 0 ? base.substring(0, idx) : base;
    }
}
```

### 19.9 图片加载多候选遍历

```java
private static void loadAsync(final ImageView view, final Context context,
        final String url, final String cacheKey, final ImageLoadListener listener,
        final int maxSize, final int maxBytes, final boolean cacheInMemory) {
    final WeakReference<ImageView> viewRef = new WeakReference<ImageView>(view);
    ThreadPoolManager.getInstance().executeIo(new Runnable() {
        public void run() {
            String[] candidates = MediaUrlResolver.resolveCandidates(url);
            Bitmap loaded = null;
            for (int i = 0; i < candidates.length; i++) {
                String candidate = candidates[i];
                if (candidate == null || candidate.length() == 0) continue;
                ImageView targetView = viewRef.get();
                if (targetView == null || !url.equals(targetView.getTag())) break;
                loaded = ImageLoaderBitmapSupport.downloadBitmap(context, CACHE_DIR, candidate, maxSize, maxBytes);
                if (loaded != null) break;
            }
            final Bitmap bitmap = loaded;
            MAIN_HANDLER.post(new Runnable() {
                public void run() {
                    ImageView targetView = viewRef.get();
                    if (bitmap != null && targetView != null && url.equals(targetView.getTag())) {
                        targetView.setImageBitmap(bitmap);
                    }
                    if (listener != null) {
                        listener.onComplete(url);
                        if (listener instanceof ImageLoadResultListener) {
                            ((ImageLoadResultListener) listener).onResult(url, bitmap != null);
                        }
                    }
                }
            });
        }
    });
}
```

### 19.10 文件下载多候选遍历（带认证头安全）

```java
static DownloadAttempt downloadToFileWithFallback(String url, File outFile, String token) {
    String[] candidates = MediaUrlResolver.resolveCandidates(url);
    String lastError = DEFAULT_ERROR_MESSAGE;
    for (int i = 0; i < candidates.length; i++) {
        String one = candidates[i];
        if (one == null || one.length() == 0) continue;
        DownloadAttempt result = downloadToFile(one, outFile, token);
        if (result.success) return result;
        if (result.message != null && result.message.length() > 0) lastError = result.message;
    }
    return fail(lastError);
}

static HttpURLConnection openConnection(String url, String token) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setConnectTimeout(10000);
    conn.setReadTimeout(20000);
    conn.setRequestMethod("GET");
    conn.setInstanceFollowRedirects(true);
    if (token != null && token.length() > 0 && shouldAttachAuth(url)) {
        conn.setRequestProperty("Authorization", "Bearer " + token);
    }
    conn.connect();
    return conn;
}

private static boolean shouldAttachAuth(String rawUrl) {
    try {
        URL target = new URL(rawUrl);
        if (sameEndpoint(target, new URL(HttpUtil.BASE_URL))) return true;
        String host = target.getHost().toLowerCase(Locale.US);
        int port = target.getPort() >= 0 ? target.getPort() : target.getDefaultPort();
        return ("oc.mcl0.dpdns.org".equals(host) && port == 443)
                || ("60.205.94.101".equals(host) && port == 8080)
                || ("154.8.227.219".equals(host) && port == 9090);
    } catch (Exception e) {
        return false;
    }
}
```

### 19.11 AsyncTask API 11 隔离

```java
public final class AsyncTaskExecutionCompat {
    public static <P, Pr, R> void execute(AsyncTask<P, Pr, R> task, P... params) {
        if (task == null) return;
        if (Build.VERSION.SDK_INT >= 11) {
            AsyncTaskExecutionApi11.execute(task, params);
        } else {
            task.execute(params);
        }
    }
}

@TargetApi(11)
final class AsyncTaskExecutionApi11 {
    static <P, Pr, R> void execute(AsyncTask<P, Pr, R> task, P... params) {
        task.executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, params);
    }
}
```

### 19.12 消息缓存（不持久化 pending）

```java
public class MessageHistoryCache {
    private static final int MAX_MESSAGES = 200;

    public static void saveDirectMessages(Context context, String uid, List<Message> messages) {
        List<Message> stable = new ArrayList<Message>();
        for (Message m : messages) {
            if (m != null && !m.localPending) stable.add(m);
        }
        int start = stable.size() > MAX_MESSAGES ? stable.size() - MAX_MESSAGES : 0;
        List<Message> snapshot = new ArrayList<Message>(stable.subList(start, stable.size()));
        enqueueLatestSnapshot(context.getApplicationContext(), "direct_" + uid, snapshot);
    }

    public static List<Message> getDirectMessages(Context context, String uid) {
        List<Message> cached = read(context, "direct_" + uid, MESSAGE_TYPE);
        for (int i = cached.size() - 1; i >= 0; i--) {
            if (cached.get(i) != null && cached.get(i).localPending) cached.remove(i);
        }
        return cached;
    }
}
```

### 19.13 BaseActivity 公共基类

```java
public abstract class BaseActivity extends AppCompatActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        applyTheme();
        applyDpi();
        super.onCreate(savedInstanceState);
    }

    @Override
    public void setContentView(int layoutResID) {
        super.setContentView(layoutResID);
        enhanceContentView(getWindow().getDecorView());
    }

    protected boolean useSquarePressFeedback() { return true; }

    protected <T extends View> T findViewByIdCompat(int id) {
        @SuppressWarnings("unchecked")
        T view = (T) findViewById(id);
        return view;
    }
}
```

### 19.14 ZoomImageView（图片预览缩放）

```java
public class ZoomImageView extends AppCompatImageView {
    private static final float MAX_SCALE_MULTIPLIER = 4.0f;
    private final Matrix matrix = new Matrix();
    private float baseScale = 1.0f;
    private ScaleGestureDetector scaleDetector;
    private GestureDetector gestureDetector;

    private void init(Context context) {
        setScaleType(ScaleType.MATRIX);
        scaleDetector = new ScaleGestureDetector(context, new ScaleListener());
        gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent e) { return true; }
            @Override public boolean onDoubleTap(MotionEvent e) {
                float current = getScale();
                if (current > baseScale * 1.45f) {
                    centerImage();
                } else {
                    float target = Math.min(baseScale * 2.5f, baseScale * MAX_SCALE_MULTIPLIER);
                    matrix.postScale(target / current, target / current, e.getX(), e.getY());
                    constrainTranslation();
                    setImageMatrix(matrix);
                }
                return true;
            }
        });
    }

    private void centerImage() {
        Drawable d = getDrawable();
        if (d == null || getWidth() <= 0) return;
        baseScale = Math.min((float)getWidth()/d.getIntrinsicWidth(),
                            (float)getHeight()/d.getIntrinsicHeight());
        if (baseScale <= 0) baseScale = 1.0f;
        matrix.reset();
        matrix.postScale(baseScale, baseScale);
        matrix.postTranslate((getWidth() - d.getIntrinsicWidth()*baseScale)/2f,
                             (getHeight() - d.getIntrinsicHeight()*baseScale)/2f);
        setImageMatrix(matrix);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        gestureDetector.onTouchEvent(event);
        scaleDetector.onTouchEvent(event);
        return true;
    }
}
```

### 19.15 视频播放多线路回退

```java
private String[] videoCandidates;
private int videoCandidateIndex;

vvPlayer.setOnErrorListener(new MediaPlayer.OnErrorListener() {
    @Override public boolean onError(MediaPlayer mp, int what, int extra) {
        if (tryNextNetworkCandidate()) return true;
        if (!triedLocal && videoUrl != null && videoUrl.startsWith("http")) {
            triedLocal = true;
            tryCachePlayback();
            return true;
        }
        openSystemPlayer();
        return true;
    }
});

private boolean tryNextNetworkCandidate() {
    while (++videoCandidateIndex < videoCandidates.length) {
        String next = videoCandidates[videoCandidateIndex];
        if (next != null && next.length() > 0 && !next.equals(videoUrl)) {
            videoUrl = next;
            playUri(Uri.parse(videoUrl), "切换备用线路...");
            return true;
        }
    }
    return false;
}
```

### 19.16 底部定位修正（可取消）

```java
private int bottomScrollGeneration = 0;

void scrollToBottom() {
    final int gen = bottomScrollGeneration;
    postScrollBy(gen, 0);
    postScrollBy(gen, 80);
    postScrollBy(gen, 320);
}

private void postScrollBy(final int gen, long delayMs) {
    recyclerView.postDelayed(new Runnable() {
        public void run() {
            if (gen != bottomScrollGeneration) return;
            if (adapter == null || adapter.getItemCount() == 0) return;
            int last = adapter.getItemCount() - 1;
            LinearLayoutManager lm = (LinearLayoutManager) recyclerView.getLayoutManager();
            if (lm.findLastCompletelyVisibleItemPosition() < last - 3) return;
            lm.scrollToPositionWithOffset(last, 0);
        }
    }, delayMs);
}

void cancelBottomScroll() {
    bottomScrollGeneration++;
}
```

### 19.17 CIP Lua 沙箱初始化

```java
private LuaTable createSandbox() {
    LuaTable env = new LuaTable();
    // 基础库: string, table, math, coroutine
    // 删除: package, io, os, debug, luajava
    // 删除: dofile, loadfile, require

    LuaTable ui = new LuaTable();
    ui.set("label", new LabelFunction());
    ui.set("button", new ButtonFunction());
    ui.set("image", new ImageFunction());
    ui.set("input", new InputFunction());
    ui.set("list", new ListFunction());
    env.set("ui", ui);

    LuaTable app = new LuaTable();
    app.set("storage_get", new StorageGetFunction());
    app.set("storage_set", new StorageSetFunction());
    app.set("storage_del", new StorageDelFunction());
    app.set("json_decode", new JsonDecodeFunction());
    app.set("json_encode", new JsonEncodeFunction());
    app.set("delay", new DelayFunction());
    app.set("on_input", new OnInputFunction());
    env.set("app", app);

    LuaTable network = new LuaTable();
    network.set("get", new NetworkGetFunction()); // 宿主 API，携带 token
    if (app.hasPermission("network_external")) {
        network.set("external_get", new NetworkExternalGetFunction());
    }
    env.set("network", network);

    return env;
}
```

### 19.18 文件上传大小限制

```java
private static final long MAX_FILE_BYTES = 1024L * 1024L * 1024L; // 1GB

static UploadResult upload(Activity activity, String uploadUrl, Uri uri,
        String fileName, String mimeType, long fileSize, ProgressListener listener) {
    if (fileSize > MAX_FILE_BYTES) {
        return new UploadResult(413, "file_too_large");
    }
    long written = 0;
    while ((len = is.read(buffer)) != -1) {
        if (written > MAX_FILE_BYTES - len) {
            return new UploadResult(413, "file_too_large");
        }
        os.write(buffer, 0, len);
        written += len;
        if (fileSize > 0 && listener != null) {
            int percent = (int)((written * 100) / fileSize);
            listener.onProgress(percent);
        }
    }
}
```

### 19.19 服务器地址管理

```java
public class ServerBaseUrlManager {
    public static String normalizeBaseUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.indexOf("://") < 0) value = "http://" + value;
        URI uri = new URI(value);
        String scheme = uri.getScheme().toLowerCase(Locale.US);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        String path = uri.getRawPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/v1";
        return scheme + "://" + uri.getRawAuthority() + path;
    }

    public static void applySavedBaseUrl(Context context) {
        String saved = prefs(context).getString("server_base_url", null);
        String normalized = normalizeBaseUrl(saved);
        HttpUtil.BASE_URL = normalized != null ? normalized : HttpUtil.DEFAULT_BASE_URL;
    }
}
```

### 19.20 消息 Payload 构建

```java
public class MessagePayloadBuilder {
    public static String buildBody(String text, MessagePayload.Quote quote,
                                   List<MessagePayload.Mention> mentions, String mediaKind) {
        MessagePayload payload = new MessagePayload();
        payload.text = text == null ? "" : text;
        payload.quote = quote;
        payload.mentions = mentions;
        payload.mediaKind = mediaKind;
        return payload.toJson();
    }
}

// 使用
String body = MessagePayloadBuilder.buildBody("你好", quoteDraft, mentions, null);
// body = {"v":2,"text":"你好"}
```

### 19.21 登录后 Token 保存

```java
private void saveLoginResult(Context context, JSONObject obj, String username, String password) {
    SharedPreferences prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE);
    String oldUid = prefs.getString("my_uid", "");
    String newUid = obj.optString("uid", "");

    SharedPreferences.Editor editor = prefs.edit();
    editor.putString("access_token", obj.optString("access_token", ""));
    editor.putString("refresh_token", obj.optString("refresh_token", ""));
    editor.putString("user_id", obj.optString("user_id", ""));
    editor.putString("my_uid", newUid);
    // 密码回退：refresh token 失效时用密码重新登录
    editor.putString("saved_username", username);
    editor.putString("saved_password", password);
    editor.apply();

    // 账号切换时清空旧缓存
    if (!oldUid.isEmpty() && !oldUid.equals(newUid)) {
        MessageHistoryCache.clearAll(context);
        FriendCache.clear(context);
        GroupCache.clear(context);
    }

    HttpUtil.invalidateAuthOperations();
}
```

### 19.22 WS 事件解析

```java
// WSIncomingHandler 核心解析
static void handle(String raw, WSManager manager) {
    try {
        JSONObject env = new JSONObject(raw);
        String type = env.optString("type", "");
        JSONObject data = env.optJSONObject("data");
        if (data == null) return;

        if ("direct_message".equals(type)) {
            WSModels.DirectMessage msg = parseDirectMessage(data);
            RecentChatCache.updateDirect(manager.getAppContext(), msg);
            manager.notifyDirectMessage(msg);
            NotificationHelper.notifyDirectMessage(manager.getAppContext(), msg);
        } else if ("group_message".equals(type)) {
            WSModels.GroupMessage msg = parseGroupMessage(data);
            GroupRecentChatCache.updateGroup(manager.getAppContext(), msg);
            manager.notifyGroupMessage(msg);
        } else if ("direct_recall".equals(type)) {
            WSModels.DirectRecall recall = new WSModels.DirectRecall();
            recall.messageId = data.optString("message_id", "");
            recall.threadId = data.optString("thread_id", "");
            recall.fromUid = data.optString("from_uid", "");
            manager.notifyDirectRecall(recall);
        } else if ("typing".equals(type)) {
            WSModels.TypingEvent event = new WSModels.TypingEvent();
            event.chatId = data.optString("chat_id", "");
            event.uid = data.optString("uid", "");
            event.isGroup = data.optBoolean("is_group", false);
            event.isTyping = data.optBoolean("is_typing", false);
            manager.notifyTyping(event);
        } else if ("presence".equals(type)) {
            WSModels.PresenceEvent event = new WSModels.PresenceEvent();
            event.uid = data.optString("uid", "");
            event.isOnline = data.optBoolean("is_online", false);
            event.presenceStatus = data.optString("presence_status", "online");
            manager.notifyPresence(event);
        }
    } catch (Exception e) {
        // 未知事件类型不能导致整个队列阻塞
    }
}
```

---

*最后更新：1.3.50 / versionCode 231*
