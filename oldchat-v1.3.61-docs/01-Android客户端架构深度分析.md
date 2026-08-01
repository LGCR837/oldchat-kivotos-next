# 01 - Android 客户端架构深度分析 (v1.3.61)

---

## 1. Application: OldChatApplication

### 1.1 类信息
- **完整类名**: `com.im.oldchat.OldChatApplication`
- **父类**: `android.app.Application`
- **全局静态字段**: `public static Context f2156a` — 全局ApplicationContext

### 1.2 初始化流程 (`onCreate`)

```java
public void onCreate() {
    super.onCreate();
    f2156a = getApplicationContext();    // 1. 保存全局Context
    L.c(this);                          // 2. 数据库初始化
    U.a(this);                          // 3. 服务器配置初始化 (Base URL)
    f.x(true);                          // 4. 全局调试/功能标志
    f.B(V.g(this) ? 2 : 1);           // 5. 连接模式 (WiFi=2, 其他=1)
    C0457x.a(this);                     // 6. 工具类初始化
    if (C0442h.c()) return;            // 7. 已初始化则跳过
    C0442h.b(this);                     // 8. 连接管理器初始化
    AbstractC0435c.e(this);             // 9. 后台任务调度初始化
    MessageService.g(this);             // 10. 启动消息推送服务
}
```

### 1.3 MultiDex 支持

```java
public void attachBaseContext(Context context) {
    super.attachBaseContext(context);
    // 通过反射加载 MultiDex，兼容低版本
    Class.forName("android.support.multidex.MultiDex")
         .getMethod("install", Context.class)
         .invoke(null, this);
}
```

使用反射方式加载 MultiDex，避免在高版本设备上产生不必要的依赖。

---

## 2. Activities 完整列表 (73个)

### 2.1 启动与认证模块

| Activity | 功能 | 特殊配置 |
|---|---|---|
| **SplashActivity** | 启动页，检查登录状态 | LAUNCHER入口，SplashTheme |
| **LoginActivity** | 登录界面 | 支持自定义服务器地址 |
| **RegisterActivity** | 用户注册 | — |
| **RecoverPasswordActivity** | 密码找回 | — |
| **ChangePasswordActivity** | 修改密码 | — |

#### LoginActivity 详细逻辑
- **UI组件**: EditText(用户名/密码)、Button(登录/注册/找回密码)、CheckBox(同意协议)
- **登录流程**:
  1. 检查用户是否勾选同意协议 (q0方法)
  2. 构造JSON请求体 (identifier, password, device_id, imei, device_name, platform, app_version)
  3. POST `/auth/login`
  4. 解析响应: access_token, refresh_token, user.id, user.uid
  5. 存储到 SharedPreferences("auth")
  6. 跳转 MainActivity
- **自定义服务器**: 长按图标弹出对话框，输入 `http(s)://host[:port][/path]`
- **记住密码**: saved_username / saved_password 明文存储
- **封禁检测**: 403 响应码 + user_banned / device_banned 关键字

### 2.2 聊天模块

| Activity | 功能 | 特殊配置 |
|---|---|---|
| **ChatActivity** | 单人聊天 | windowSoftInputMode=adjustPan\|stateHidden |
| **GroupChatActivity** | 群聊 | windowSoftInputMode=adjustPan\|stateHidden |
| **ChatSettingsActivity** | 聊天设置 | — |
| **ChatSearchActivity** | 聊天搜索 | — |
| **RedPacketSendActivity** | 发送红包 | — |
| **RedPacketOpenActivity** | 打开红包 | — |
| **RedPacketDetailActivity** | 红包详情 | — |
| **ImagePreviewActivity** | 图片预览 | — |
| **BurnSecureViewActivity** | 阅后即焚安全查看 | **v1.3.61新增** |
| **NotificationChatActivity** | 通知聊天 | — |

### 2.3 好友与群组模块

| Activity | 功能 |
|---|---|
| **AddFriendActivity** | 添加好友 |
| **GroupCreateActivity** | 创建群组 |
| **GroupManageActivity** | 群组管理 |
| **GroupMembersActivity** | 群成员列表 |
| **GroupAnnouncementActivity** | 群公告 (windowSoftInputMode=adjustResize\|stateHidden) |
| **GroupInviteActivity** | 邀请入群 |
| **GroupJoinRequestsActivity** | 入群申请 |

### 2.4 个人资料模块

| Activity | 功能 |
|---|---|
| **ProfileEditActivity** | 编辑个人资料 |
| **ProfileSpaceEditActivity** | 编辑个人空间 |
| **UserSpaceActivity** | 查看用户空间 |
| **QrCardActivity** | 二维码名片 |
| **QrScanActivity** | 扫描二维码 |

### 2.5 发现模块

| Activity | 功能 |
|---|---|
| **MomentsActivity** | 朋友圈/动态 |
| **MomentComposeActivity** | 发布动态 |
| **MomentCommentsActivity** | 动态评论 |
| **MomentNoticeActivity** | 动态通知 |
| **MomentGalleryActivity** | 动态图片画廊 |
| **EmojiPickerActivity** | 表情选择器 |
| **EmojiPlazaActivity** | 表情广场 |
| **ResourceSectionsActivity** | 资源分区列表 |
| **ResourceSectionActivity** | 资源分区详情 |
| **ResourceCommentsActivity** | 资源评论 |
| **DailyCheckInWallActivity** | 每日签到墙 (**v1.3.61新增**) |
| **DailyCheckInWallCommentsActivity** | 签到墙评论 (**v1.3.61新增**, adjustResize) |

### 2.6 音乐模块

| Activity | 功能 |
|---|---|
| **MusicPlazaActivity** | 音乐广场 |
| **MusicManageActivity** | 音乐管理 |
| **MusicDownloadsActivity** | 音乐下载 |
| **MusicPlayerActivity** | 音乐播放器 |
| **MusicCommentsActivity** | 音乐评论 |

### 2.7 OldView (B站集成) 模块

| Activity | 功能 | 特殊配置 |
|---|---|---|
| **OldViewActivity** | B站视频浏览主页 | — |
| **OldViewVideoDetailActivity** | 视频详情 | — |
| **OldViewVideoFullActivity** | 全屏播放 | 横屏锁定, AppTheme.Fullscreen |
| **OldViewUpProfileActivity** | UP主主页 | — |
| **OldViewHistoryActivity** | 观看历史 | — |
| **OldViewFavoritesActivity** | 收藏列表 | — |
| **OldViewFavoriteDetailActivity** | 收藏详情 | — |

### 2.8 CIP/小程序模块 (v1.3.61新增)

| Activity | 功能 | 特殊配置 |
|---|---|---|
| **LuaMiniAppActivity** | Lua小程序运行容器 | — |
| **MiniAppsActivity** | 小程序列表 | — |
| **CipDevelopmentModeActivity** | CIP开发模式入口 | adjustPan |
| **CipVibeCodingActivity** | CIP Vibe编程 | configChanges=orientation\|screenSize\|keyboardHidden |
| **CipDeveloperActivity** | CIP开发者工具 | adjustUnspecified |

### 2.9 新闻模块 (v1.3.61新增)

| Activity | 功能 |
|---|---|
| **MinimalNewsActivity** | 极简新闻列表 |
| **MinimalNewsDetailActivity** | 新闻详情 |

### 2.10 设置模块

| Activity | 功能 |
|---|---|
| **SettingsActivity** | 主设置页 |
| **NotificationSettingsActivity** | 通知设置 |
| **DiscoverSettingsActivity** | 发现页设置 |
| **DataSettingsActivity** | 数据设置 |
| **SupportSettingsActivity** | 帮助与支持 |
| **CacheSettingsActivity** | 缓存管理 |
| **UiSettingsActivity** | 界面设置 |
| **AccountManagementActivity** | 账号管理 |
| **DeviceManagementActivity** | 设备管理 |
| **FeedbackActivity** | 用户反馈 |
| **PrivacyPolicyActivity** | 隐私政策 |
| **ReportProgressActivity** | 举报进度 |
| **PublicCourtActivity** | 公开法庭 |
| **PublicCourtCaseDetailActivity** | 法庭案件详情 |
| **FavoritesActivity** | 收藏 |
| **CrashActivity** | 崩溃报告 (独立进程 :crash, 不导出, CrashDialogTheme) |

---

## 3. Services 详细分析 (4个)

### 3.1 MessageService — 消息推送服务

| 属性 | 值 |
|---|---|
| 类名 | com.im.oldchat.service.MessageService |
| exported | false |
| 前台服务 | 是 (通知ID: 42) |
| 通知渠道 | oldchat_service ("后台连接", IMPORTANCE_LOW) |
| 通知文案 | "旧聊已连接" / "正在后台接收消息" |
| 通知图标 | stat_notify_chat (系统图标) |
| 返回值 | START_STICKY (值=1) |

**启动逻辑**:
- `g(Context)` — 主入口，根据API版本选择启动方式
  - Android 12+ (API 31): 先尝试直接连接，失败则 fallback
  - Android 8+ (API 26): `startForegroundService()`
  - 以下: `startService()`
- `f(Context)` — 实际启动方法
- `h(Context)` — 停止服务

**前台通知**:
- 创建通知渠道 `oldchat_service` (Android 8+)
- 使用 `stat_notify_chat` 系统图标
- 点击通知跳转 MainActivity (FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP)

### 3.2 ResourceUploadService — 资源上传服务

| 属性 | 值 |
|---|---|
| 类名 | com.im.oldchat.service.ResourceUploadService |
| exported | false |
| 前台服务 | 是 (通知ID: 73) |
| 通知渠道 | oldchat_upload ("资源上传", IMPORTANCE_LOW) |
| Action | com.im.oldchat.action.RESOURCE_UPLOAD_START |

**上传参数**:
- section_id — 资源分区ID
- uri — 文件URI
- file_name — 文件名
- content_type — MIME类型
- total_bytes — 文件大小

**状态广播** (通过 LocalBroadcastManager):
- `RESOURCE_UPLOAD_DONE` — 上传完成 (section_id, file_name, response)
- `RESOURCE_UPLOAD_ERROR` — 上传失败 (section_id, error_code, error_message)
- `RESOURCE_UPLOAD_PROGRESS` — 进度更新 (section_id, file_name, uploaded_bytes, total_bytes, progress, indeterminate, speed_bps)

**并发控制**: 使用静态锁对象 `f2312g` 和状态对象 `f2313h`，同一时间只允许一个上传任务。第二个任务会收到 `upload_busy` 错误。

**速度计算**: 每500ms计算一次上传速度 (bytes/sec)。

### 3.3 MusicPlaybackService — 音乐播放服务

| 属性 | 值 |
|---|---|
| 类名 | com.im.oldchat.service.MusicPlaybackService |
| exported | false |
| 前台服务 | 是 (通知ID: 5201) |
| 通知渠道 | oldchat_music_playback ("音乐播放", IMPORTANCE_LOW) |
| 实现接口 | AudioManager.OnAudioFocusChangeListener |

**Intent Actions**:

| Action | 功能 |
|---|---|
| PLAY_SONG | 播放指定歌曲 |
| CACHE_SONG | 缓存歌曲到本地 |
| TOGGLE_PLAY | 播放/暂停切换 |
| PAUSE | 暂停播放 |
| STOP | 停止播放并移除通知 |
| SEEK | 跳转到指定位置 (position_ms) |
| SEEK_RELATIVE | 相对跳转 (seek_delta_ms) |
| TOGGLE_REPEAT_ONE | 单曲循环开关 |
| UPDATE_ITEM_META | 更新歌曲元数据 |
| REQUEST_STATE | 请求当前播放状态 |

**通知栏控制**: 播放/暂停、单曲循环、关闭 三个按钮。

**广播事件**:
- `com.im.oldchat.action.music.STATE_CHANGED` — 状态变化
- `com.im.oldchat.action.music.CACHE_RESULT` — 缓存结果

**缓存管理**:
- 目录: `{filesDir}/music_player_cache/`
- 命名: SHA1(url) + 扩展名
- 上限: 220MB / 120个文件
- 后台清理线程: `music-cache-trim-svc`

### 3.4 CipVibeBackgroundService — CIP后台服务 (v1.3.61新增)

| 属性 | 值 |
|---|---|
| 类名 | com.im.oldchat.lua.CipVibeBackgroundService |
| exported | false |

为 Lua 小程序和 CIP Vibe 编程提供后台执行环境。与 LuaMiniAppActivity 和 CipVibeCodingActivity 配合使用。

---

## 4. MainActivity 详细分析

### 4.1 底部导航结构

```java
// Tab 配置
s0(0, R.drawable.xxx, "聊天");  // Tab 0
s0(1, R.drawable.xxx, "好友");  // Tab 1, 带红点指示器
s0(2, R.drawable.xxx, "发现");  // Tab 2
s0(3, R.drawable.xxx, "我的");  // Tab 3

// Fragment 对应
iVar.v(new m0.b(), "聊天");    // 聊天列表Fragment
iVar.v(new m0.e(), "好友");    // 好友列表Fragment
iVar.v(new m0.c(), "发现");    // 发现页面Fragment
iVar.v(new k(),    "我的");    // 我的页面Fragment
```

### 4.2 启动时序

1. `onCreate`:
   - 检查 `auth` SP 中的 token，无则跳转 LoginActivity
   - 设置布局，初始化 TopStatusBar
   - 初始化 ViewPager + 4个Fragment
   - 创建底部Tab (t0方法)
   - 调用 `AbstractC0437d.g(this, token)` 进行认证初始化

2. `onResume`:
   - 刷新聊天列表 (`p0`)
   - 检查好友请求 (`q0`)
   - 更新UI设置 (`AbstractC0438d0.g`)
   - 首次加载通知 (`o0`)

### 4.3 好友请求红点

- 轮询 API: `GET /friends/requests`
- 解析 `requests` 数组，统计 `status == 0` 的数量
- 红点显示在"好友"Tab上 (view.setVisibility)
- 缓存到 `i0.b` 避免重复请求

### 4.4 系统通知弹窗

- 轮询 API: `GET /notifications?limit=1`
- 解析第一条通知的 id, title, body, important 字段
- `important=true` 的通知显示"不再提醒"复选框
- 已读状态通过 `i0.f` 管理

---

## 5. 自定义控件

| 控件 | 路径 | 功能 |
|---|---|---|
| **TopStatusBar** | com.im.oldchat.ui.TopStatusBar | 顶部状态栏，支持加载动画和重试回调 |
| **NoAnimViewPager** | com.im.oldchat.ui.NoAnimViewPager | 禁用页面切换动画的ViewPager |
| **ZoomImageView** | com.im.oldchat.ui.ZoomImageView | 支持双指缩放的图片视图 |
| **ActionPanelAnimatedLayout** | com.im.oldchat.ui.widget | 带动画的操作面板布局 |
| **FontAwesomeTextView** | com.im.oldchat.ui.widget | 支持FontAwesome图标的TextView |
| **RoundedImageView** | com.im.oldchat.ui.widget | 圆角图片控件 |
| **TiltFrameLayout** | com.im.oldchat.ui.widget | 可倾斜的FrameLayout |

---

## 6. 混淆后的关键基类

| 混淆名 | 推测功能 | 子类 |
|---|---|---|
| `f0.a` | 基础Activity (带工具方法) | LoginActivity, MainActivity等 |
| `AbstractActivityC0210a` | 聊天基类Activity | ChatActivity |
| `AbstractActivityC0211b` | 带菜单的Activity基类 | — |
| `AbstractActivityC0231w` | 设置类Activity基类 | — |
| `AbstractActivityC0232x` | 带列表的Activity基类 | — |
| `AbstractActivityC0233y` | 带WebView的Activity基类 | — |
| `AbstractC0213d` | — | — |
| `AbstractC0215f` | — | — |
| `AbstractC0217h` | — | — |
| `AbstractC0219j` | — | — |
| `AbstractC0220k` | — | — |
| `AbstractC0221l` | — | — |
| `AbstractC0222m` | — | — |
| `AbstractC0227s` | — | — |
| `AbstractC0228t` | — | — |
| `AbstractC0230v` | — | — |

---

## 7. 统计

| 统计项 | 数量 |
|---|---|
| Activities 总数 | 73 |
| Services 总数 | 4 |
| Providers | 1 (FileProvider) |
| Receivers | 0 |
| 自定义控件 | 7 |
| 混淆基类 | 16+ |
