# OldChat Android 客户端完整逆向工程文档

> **基于 `oldchat-dev.apk` (2026-08-14) jadx 反编译分析**  
> **APK 大小**: 4.9 MB | **DEX 大小**: 6.2 MB | **Java 源文件**: 206 个  
> **包名**: `com.im.oldchat` | **版本**: dev 分支  
> **对照资料**: nx3 逆向文档、mcl0 官方文档 (api.md / client.md / lua-cip.md / routes.md)  
> **更新时间**: 2026年8月15日（nx6 基础上新增 §22.5 每日刮刮乐系统）

---

## 目录

1. [应用基本信息](#1-应用基本信息)
2. [权限声明](#2-权限声明)
3. [架构概览](#3-架构概览)
4. [Application 与启动流程](#4-application-与启动流程)
5. [Activities 完整清单](#5-activities-完整清单)
6. [Services 完整清单](#6-services-完整清单)
7. [自定义控件](#7-自定义控件)
8. [网络层与传输机制](#8-网络层与传输机制)
9. [安全与加密体系](#9-安全与加密体系)
10. [认证系统](#10-认证系统)
11. [私聊系统](#11-私聊系统)
12. [群聊系统](#12-群聊系统)
13. [好友系统](#13-好友系统)
14. [频道系统](#14-频道系统)
15. [交互按钮系统](#15-交互按钮系统)
16. [文件系统](#16-文件系统)
17. [朋友圈/动态系统](#17-朋友圈动态系统)
18. [音乐系统](#18-音乐系统)
19. [B站集成 (OldView)](#19-b站集成-oldview)
20. [CIP 小程序系统](#20-cip-小程序系统)
21. [红包系统](#21-红包系统)
22. [签到系统](#22-签到系统)
22.5 [每日刮刮乐系统](#225-每日刮刮乐系统)
23. [用户中心](#23-用户中心)
24. [资源广场](#24-资源广场)
25. [表情广场](#25-表情广场)
26. [公开法庭](#26-公开法庭)
27. [AI 助手](#27-ai-助手)
28. [通知与反馈](#28-通知与反馈)
29. [数据存储系统](#29-数据存储系统)
30. [事件系统与 WebSocket](#30-事件系统与-websocket)
31. [错误码汇总](#31-错误码汇总)
32. [v2 网关与路由映射](#32-v2-网关与路由映射)
33. [与 nx3 文档差异对比](#33-与-nx3-文档差异对比)
34. [附录: 复刻最小流程](#34-附录-复刻最小流程)

---

## 1. 应用基本信息

| 属性 | 值 | 来源 |
|---|---|---|
| 包名 | `com.im.oldchat` | DEX strings |
| APK 文件名 | `oldchat-dev.apk` | — |
| APK 大小 | 4.9 MB | 文件系统 |
| DEX 文件 | `classes.dex` (单 DEX, 6.2 MB) | 文件系统 |
| Activities | 82 个 (含抽象基类) | jadx 枚举 |
| Services | 4 个 | jadx 枚举 |
| 自定义控件 | 13 个 | jadx 枚举 |
| Java 源文件 | 206 个 | jadx 输出 |
| 最低 SDK | 9 (Android 2.3) | 官方文档 |
| 目标 SDK | 33 (Android 13) | 官方文档 |
| 编译 SDK | 33 | 官方文档 |
| Application 类 | `com.im.oldchat.OldChatApplication` | DEX |
| 入口 Activity | `com.im.oldchat.SplashActivity` | DEX |
| 主 Activity | `com.im.oldchat.MainActivity` | DEX |
| 原生库 | **无** (移除了 Conscrypt) | APK 结构 |
| TLS 实现 | Java 标准 + SpongyCastle | DEX strings |
| 资源文件 | 9u.pem (证书) | APK assets |

### 1.1 资源文件

| 文件 | 说明 |
|---|---|
| `assets/fonts/fontawesome-webfont.ttf` | FontAwesome 图标字体 |
| `assets/fonts/inter_regular.ttf` | Inter 正文字体 |
| `assets/fonts/jetbrains_mono_regular.ttf` | JetBrains Mono 等宽字体 |
| `assets/lua_apps/welcome.lua` | 内置 Lua 小程序 |

---

## 2. 权限声明

共 **13 个权限**，与 nx3 文档一致，无变化：

| 权限 | 危险级别 | 用途 |
|---|---|---|
| `INTERNET` | 普通 | 网络通信 |
| `ACCESS_NETWORK_STATE` | 普通 | 网络状态检测 |
| `CAMERA` | 危险 | 相机功能 |
| `READ_EXTERNAL_STORAGE` | 危险 | 读取外部存储 (maxSdkVersion=32) |
| `WRITE_EXTERNAL_STORAGE` | 危险 | 写入外部存储 (maxSdkVersion=28) |
| `READ_MEDIA_IMAGES` | 危险 | 读取图片 (Android 13+) |
| `READ_MEDIA_VIDEO` | 危险 | 读取视频 (Android 13+) |
| `READ_MEDIA_AUDIO` | 危险 | 读取音频 (Android 13+) |
| `POST_NOTIFICATIONS` | 危险 | 发送通知 (Android 13+) |
| `RECORD_AUDIO` | 危险 | 录音 |
| `READ_PHONE_STATE` | 危险 | 读取手机状态 |
| `FOREGROUND_SERVICE` | 普通 | 前台服务 |
| `REQUEST_INSTALL_PACKAGES` | 危险 | 安装 APK |

---

## 3. 架构概览

```
com.im.oldchat/
├── OldChatApplication.java    — Application 入口
├── SplashActivity.java        — 启动页 (LAUNCHER)
├── MainActivity.java          — 主界面 (底部导航)
├── ui/                        — 所有 Activity (82个)
│   ├── LoginActivity.java     — 登录
│   ├── ChatActivity.java      — 单聊
│   ├── GroupChatActivity.java — 群聊
│   ├── ChannelActivity.java   — 频道详情
│   ├── ChannelComposeActivity.java — 频道发帖
│   ├── ChannelDiscoveryActivity.java — 频道发现
│   ├── FileCenterActivity.java — 文件中心
│   ├── DiscoverTileEditorActivity.java — 发现页编辑 (NEW)
│   ├── AppearancePreviewActivity.java — 外观预览 (NEW)
│   ├── WelcomeGuideActivity.java — 欢迎引导 (NEW)
│   ├── widget/                — 自定义控件 (13个)
│   │   ├── ButtonFlowLayout.java — 按钮流式布局 (NEW)
│   │   ├── DiscoverTileLayout.java — 发现页磁贴布局 (NEW)
│   │   ├── BubbleTimeTextView.java — 气泡时间文本 (NEW)
│   │   ├── MomentImageView.java — 动态图片视图 (NEW)
│   │   └── ... (9个已有控件)
│   └── ... (70+ Activities)
├── service/                   — 后台服务
│   ├── MessageService.java    — 消息服务
│   ├── ResourceUploadService.java — 资源上传
│   ├── MusicPlaybackService.java — 音乐播放
│   └── FileDownloadService.java — 文件下载
├── bili/                      — B站集成模块
│   ├── BiliApi.java           — API 封装
│   ├── BiliApiExtra.java      — 扩展 API
│   ├── BiliAuthStore.java     — 认证存储
│   ├── BiliModels.java        — 数据模型
│   ├── BiliSigner.java        — 签名基类
│   ├── BiliWbiSigner.java     — Wbi 签名
│   ├── BiliShareUtil.java     — 分享工具
│   ├── BiliQrGenerator.java   — 二维码生成
│   ├── BiliUserSpaceApi.java  — 用户空间 API
│   └── BiliWebViewMemoryGuard.java — WebView 内存保护 (NEW)
├── lua/                       — Lua 小程序模块
└── h0/                        — 网络传输层 (混淆)
    ├── c.java                 — 新加密传输层
    ├── e.java                 — 旧传输层 (签名)
    ├── f.java                 — 基础传输层
    ├── d.java                 — API 入口
    ├── b.java                 — 握手流程
    ├── a.java                 — 频道相关
    ├── j.java                 — 事件差量同步
    └── w.java                 — 未读同步
```

---

## 4. Application 与启动流程

### 4.1 OldChatApplication

```java
public class OldChatApplication extends Application {
    public static Context f2207a; // 全局 Context

    public void onCreate() {
        f2207a = getApplicationContext();
        AbstractC0590z.j(applicationContext); // 初始化
    }

    public void attachBaseContext(Context context) {
        super.attachBaseContext(context);
        AbstractC0142a.k(this); // MultiDex
    }
}
```

### 4.2 SplashActivity 启动流程

```
用户点击图标
    ↓
SplashActivity (LAUNCHER)
    ├── 检查登录状态 (auth SP 中的 token)
    ├── 检查是否首次使用 (WelcomeGuideActivity)
    ├── 未登录 → LoginActivity
    └── 已登录 → MainActivity
                    ↓
                底部 4 Tab 导航
                ├── 聊天 (Fragment)
                ├── 好友 (Fragment)
                ├── 发现 (Fragment)
                └── 我的 (Fragment)
```

---

## 5. Activities 完整清单

共 **82 个 Activity** (含抽象基类)，按模块分类：

### 5.1 启动与认证 (3个)

| Activity | 功能 | 备注 |
|---|---|---|
| `SplashActivity` | 启动页，检查登录状态 | LAUNCHER 入口 |
| `LoginActivity` | 登录界面 | 注册外置到浏览器 |
| `WelcomeGuideActivity` | 欢迎引导 | 首次使用 |

### 5.2 聊天模块 (10个)

| Activity | 功能 |
|---|---|
| `ChatActivity` | 单人聊天 |
| `GroupChatActivity` | 群聊 |
| `ChatSettingsActivity` | 聊天设置 |
| `ChatSearchActivity` | 聊天搜索 |
| `BurnSecureViewActivity` | 阅后即焚安全查看 |
| `ImagePreviewActivity` | 图片预览 |
| `NotificationChatActivity` | 通知聊天 |
| `RedPacketSendActivity` | 发送红包 |
| `RedPacketOpenActivity` | 打开红包 |
| `RedPacketDetailActivity` | 红包详情 |

### 5.3 好友与群组 (8个)

| Activity | 功能 |
|---|---|
| `AddFriendActivity` | 添加好友 |
| `GroupCreateActivity` | 创建群组 |
| `GroupManageActivity` | 群组管理 |
| `GroupMembersActivity` | 群成员列表 |
| `GroupAnnouncementActivity` | 群公告 |
| `GroupInviteActivity` | 邀请入群 |
| `GroupJoinRequestsActivity` | 入群申请 |

### 5.4 个人资料 (4个)

| Activity | 功能 |
|---|---|
| `ProfileEditActivity` | 编辑个人资料 |
| `ProfileSpaceEditActivity` | 编辑个人空间 |
| `UserSpaceActivity` | 查看用户空间 |
| `QrCardActivity` | 二维码名片 |

### 5.5 频道系统 (3个)

| Activity | 功能 |
|---|---|
| `ChannelActivity` | 频道详情页 |
| `ChannelComposeActivity` | 频道发帖 |
| `ChannelDiscoveryActivity` | 频道发现/搜索 |

### 5.6 动态/朋友圈 (5个)

| Activity | 功能 |
|---|---|
| `MomentsActivity` | 朋友圈/动态 |
| `MomentComposeActivity` | 发布动态 |
| `MomentCommentsActivity` | 动态评论 |
| `MomentNoticeActivity` | 动态通知 |
| `MomentGalleryActivity` | 动态图片画廊 |

### 5.7 表情模块 (3个)

| Activity | 功能 |
|---|---|
| `EmojiPickerActivity` | 表情选择器 |
| `EmojiPlazaActivity` | 表情广场 |
| `EmojiPlazaSearchActivity` | 表情广场搜索 |

### 5.8 音乐模块 (8个)

| Activity | 功能 |
|---|---|
| `MusicPlazaActivity` | 音乐广场 |
| `MusicManageActivity` | 音乐管理 |
| `MusicDownloadsActivity` | 音乐下载 |
| `MusicPlayerActivity` | 音乐播放器 |
| `MusicCommentsActivity` | 音乐评论 |
| `MusicCategoryActivity` | 音乐分类浏览 |
| `MusicSearchActivity` | 音乐搜索 |
| `PlaylistDetailActivity` | 播放列表详情 |

### 5.9 OldView (B站) 模块 (7个)

| Activity | 功能 |
|---|---|
| `OldViewActivity` | B站视频浏览主页 |
| `OldViewVideoDetailActivity` | 视频详情 |
| `OldViewVideoFullActivity` | 全屏播放 |
| `OldViewUpProfileActivity` | UP主主页 |
| `OldViewHistoryActivity` | 观看历史 |
| `OldViewFavoritesActivity` | 收藏列表 |
| `OldViewFavoriteDetailActivity` | 收藏详情 |

### 5.10 CIP/小程序模块 (3个)

| Activity | 功能 |
|---|---|
| `LuaMiniAppActivity` | Lua 小程序运行容器 |
| `MiniAppsActivity` | 小程序列表 |
| `CipDevelopmentModeActivity` | CIP 开发模式入口 |

### 5.11 CIP VibeCoding (2个)

| Activity | 功能 |
|---|---|
| `CipVibeCodingActivity` | CIP Vibe 编程 |
| `CipDeveloperActivity` | CIP 开发者工具 |

### 5.12 新闻模块 (2个)

| Activity | 功能 |
|---|---|
| `MinimalNewsActivity` | 极简新闻列表 |
| `MinimalNewsDetailActivity` | 新闻详情 |

### 5.13 资源模块 (3个)

| Activity | 功能 |
|---|---|
| `ResourceSectionsActivity` | 资源分区列表 |
| `ResourceSectionActivity` | 资源分区详情 |
| `ResourceCommentsActivity` | 资源评论 |

### 5.14 签到模块 (2个)

| Activity | 功能 |
|---|---|
| `DailyCheckInWallActivity` | 每日签到墙 |
| `DailyCheckInWallCommentsActivity` | 签到墙评论 |

### 5.15 设置模块 (12个)

| Activity | 功能 |
|---|---|
| `SettingsActivity` | 主设置页 |
| `NotificationSettingsActivity` | 通知设置 |
| `DiscoverSettingsActivity` | 发现页设置 |
| `DataSettingsActivity` | 数据设置 |
| `SupportSettingsActivity` | 帮助与支持 |
| `CacheSettingsActivity` | 缓存管理 |
| `UiSettingsActivity` | 界面设置 |
| `AccountManagementActivity` | 账号管理 |
| `DeviceManagementActivity` | 设备管理 |
| `FeedbackActivity` | 用户反馈 |
| `PrivacyPolicyActivity` | 隐私政策 |
| `ChangePasswordActivity` | 修改密码 |

### 5.16 其他 (7个)

| Activity | 功能 | 备注 |
|---|---|---|
| `FileCenterActivity` | 文件中心 | dev2 新增 |
| `FavoritesActivity` | 收藏 | — |
| `QrScanActivity` | 扫描二维码 | — |
| `ReportProgressActivity` | 举报进度 | — |
| `PublicCourtActivity` | 公开法庭 | — |
| `PublicCourtCaseDetailActivity` | 法庭案件详情 | — |
| `CrashActivity` | 崩溃报告 | 独立进程 :crash |
| `DiscoverTileEditorActivity` | 发现页磁贴编辑 | **NEW** |
| `AppearancePreviewActivity` | 外观预览 | **NEW** |

---

## 6. Services 完整清单

| Service | 通知ID | 通知渠道 | 说明 |
|---|---|---|---|
| `MessageService` | 42 | `oldchat_service` ("后台连接") | 消息推送，START_STICKY |
| `ResourceUploadService` | 73 | `oldchat_upload` ("资源上传") | 资源上传 |
| `MusicPlaybackService` | 5201 | `oldchat_music_playback` ("音乐播放") | 音乐播放，实现 AudioManager.OnAudioFocusChangeListener |
| `FileDownloadService` | — | — | 文件下载 |

---

## 7. 自定义控件

### 7.1 已有控件

| 控件 | 路径 | 功能 |
|---|---|---|
| `TopStatusBar` | `ui/TopStatusBar` | 顶部状态栏 |
| `NoAnimViewPager` | `ui/NoAnimViewPager` | 禁用动画的 ViewPager |
| `ZoomImageView` | `ui/ZoomImageView` | 双指缩放图片 |
| `ActionPanelAnimatedLayout` | `ui/widget/` | 动画操作面板 |
| `FontAwesomeTextView` | `ui/widget/` | FontAwesome 图标文本 |
| `RoundedImageView` | `ui/widget/` | 圆角图片 |
| `TiltFrameLayout` | `ui/widget/` | 可倾斜 FrameLayout |
| `CircleImageView` | `ui/widget/` | 圆形图片 |
| `CoverFlowView` | `ui/widget/` | 封面流 3D 效果 |
| `CoverAmbientMotionView` | `ui/widget/` | 封面氛围动效 |
| `LyricCascadeView` | `ui/widget/` | 歌词级联滚动 |
| `OldViewPlayerView` | `ui/widget/` | B站播放器 |

### 7.2 新增控件 (本次 APK)

| 控件 | 功能 |
|---|---|
| `ButtonFlowLayout` | 按钮流式布局 (交互按钮系统) |
| `DiscoverTileLayout` | 发现页磁贴布局 (可编辑) |
| `BubbleTimeTextView` | 气泡时间文本 (消息时间显示) |
| `MomentImageView` | 动态图片视图 (九宫格) |

---

## 8. 网络层与传输机制

### 8.1 传输层架构

```
h0.d (API 入口)
    ├── h0.f (基础传输层)
    │   ├── h0.e (旧传输层 - 签名但不加密)
    │   │   └── h0.b (握手流程)
    │   └── h0.c (新传输层 - 加密)
    │       └── q0.AbstractC0584w (ECDH 加密)
    └── AsyncTask 异步执行
```

### 8.2 Base URL 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `h0.e.f7206a` | `http://oc.mcl0.dpdns.org` | OC 服务根 URL |
| `h0.e.f7207b` | `http://oc.mcl0.dpdns.org/v1` | API Base URL |

### 8.3 请求方法

| 方法 | 签名 | 用途 |
|---|---|---|
| `h0.d.X` | `X(path, token, callback)` | GET 请求 |
| `h0.d.Y` | `Y(path, body, token, callback)` | POST 请求 (JSON) |
| `h0.d.b0` | `b0(path, ..., token, callback)` | Multipart 上传 |
| `h0.d.Z` | `Z(method, path, body, token, callback)` | 通用请求 |

### 8.4 回调接口

```java
// h0.d.i — v2 通用回调
public interface i {
    void a(String response);           // 成功
    void b(int errorCode, String error); // 失败
}
```

### 8.5 v2 路由映射

**源码确认** (`h0/e.java` 第451行)：客户端内部维护一个完整的 `/v1/` → `/v2/` 路径映射表：

| 旧路径 (/v1) | 新路径 (/v2) |
|---|---|
| `/groups/read` | `/v2/groups/read` |
| `/groups/burn/open` | `/v2/groups/burn/open` |
| `/groups/typing` | `/v2/groups/typing` |
| `/direct/send` | `/v2/direct/send` |
| `/direct/read` | `/v2/direct/read` |
| `/direct/burn/open` | `/v2/direct/burn/open` |
| `/chats/typing` | `/v2/chats/typing` |
| `/redpackets/send` | `/v2/redpackets/send` |
| `/redpackets/claim` | `/v2/redpackets/claim` |
| `/friends/request` | `/v2/friends/request` |
| `/friends/respond` | `/v2/friends/respond` |
| `/friends/remark` | `/v2/friends/remark` |
| `/friends/delete` | `/v2/friends/delete` |
| `/friends/requests` | `/v2/friends/requests` |
| `/friends` | `/v2/friends` |
| `/groups/create` | `/v2/groups/create` |
| `/groups/join` | `/v2/groups/join` |
| `/groups/leave` | `/v2/groups/leave` |
| `/groups/approve` | `/v2/groups/approve` |
| `/groups/invite` | `/v2/groups/invite` |
| `/groups/invitations` | `/v2/groups/invitations` |
| `/groups/invitations/respond` | `/v2/groups/invitations/respond` |
| `/groups/admin` | `/v2/groups/admin` |
| `/groups/avatar` | `/v2/groups/avatar` |
| `/groups/kick` | `/v2/groups/kick` |
| `/groups/name` | `/v2/groups/name` |
| `/groups/settings` | `/v2/groups/settings` |
| `/groups/announcement` | `/v2/groups/announcement` |
| `/groups/announcement/read` | `/v2/groups/announcement/read` |
| `/groups/dissolve` | `/v2/groups/dissolve` |
| `/groups/list` | `/v2/groups/list` |
| `/groups/members` | `/v2/groups/members` |
| `/groups/requests` | `/v2/groups/requests` |
| `/me/uid` | `/v2/me/uid` |
| `/me/profile` | `/v2/me/profile` |
| `/me/password` | `/v2/me/password` |
| `/me/delete/email/send` | `/v2/me/delete/email/send` |
| `/me/delete` | `/v2/me/delete` |
| `/me/group-invite-preference` | `/v2/me/group-invite-preference` |
| `/me/avatar` | `/v2/me/avatar` |
| `/me/cover` | `/v2/me/cover` |
| `/me/checkin` | `/v2/me/checkin` |
| `/me/presence` | `/v2/me/presence` |
| `/me/devices` | `/v2/me/devices` |
| `/me/devices/cleanup` | `/v2/me/devices/cleanup` |
| `/me/bug-reports` | `/v2/me/bug-reports` |
| `/me/user-reports` | `/v2/me/user-reports` |
| `/me/group-reports` | `/v2/me/group-reports` |
| `/moments/like` | `/v2/moments/like` |
| `/moments/unlike` | `/v2/moments/unlike` |
| `/moments/delete` | `/v2/moments/delete` |
| `/moments/comment` | `/v2/moments/comment` |
| `/moments/comment/delete` | `/v2/moments/comment/delete` |
| `/moments` | `/v2/moments` |
| `/moments/comments` | `/v2/moments/comments` |
| `/moments/user` | `/v2/moments/user` |
| `/moments/feed` | `/v2/moments/feed` |
| `/users/profile` | `/v2/users/profile` |

### 8.6 v2 网关

所有 `/v2/` 请求可通过统一网关 `/v2/gateway` 折叠发送，加密 body 明文为：

```json
{
  "m": "POST",
  "p": "/v2/direct/send",
  "q": "",
  "b": { "to_uid": "USR-XXX", "body": "hi", "msg_type": "text" }
}
```

---

## 9. 安全与加密体系

### 9.1 加密架构

```
┌─────────────────────────────────────────────┐
│            安全层架构                         │
├─────────────────────────────────────────────┤
│ 认证层: Bearer Token + Refresh Token         │
│ 加密层: SpongyCastle + ECDH 密钥协商          │
│ 传输层: OkHttp + Java 标准 TLS               │
│ 存储层: SharedPreferences (明文)             │
│ 设备层: Device ID + IMEI                     │
└─────────────────────────────────────────────┘
```

### 9.2 ECDH 握手协议

**端点**: `POST /auth/handshake` (明文，不带 Bearer Token)

**流程**:
1. 客户端生成 P-256 (secp256r1) 密钥对
2. 发送 `client_pub` (X.509 SPKI DER + Base64 NO_WRAP)
3. 服务端返回 `session_id` + `server_pub`
4. ECDH 计算共享密钥
5. 派生 `encKey` = SHA256(truncated_secret + "enc")
6. 派生 `macKey` = SHA256(truncated_secret + "mac")

**请求体**:
```json
{ "client_pub": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..." }
```

**响应体**:
```json
{ "session_id": "nav_xxxx...", "server_pub": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..." }
```

### 9.3 加密信封格式

当 `X-Enc: 1` 时，请求/响应 body 为加密信封：

```json
{ "iv": "base64", "data": "base64", "mac": "base64" }
```

- **加密**: AES-256-CBC + PKCS7Padding
- **MAC**: HMAC-SHA256(macKey, iv_bytes || ciphertext_bytes)
- **IV**: 16 字节 SecureRandom
- **Base64**: flag=2 (NO_WRAP)

### 9.4 v2 签名机制

**源码确认**: `q0/AbstractC0584w.java` 第357-366行 + `h0/e.java` 第174-194行

#### 签名公式

```java
// q0/AbstractC0584w.z() 第366行
signingString = str + '\n' + str2 + '\n' + str3 + '\n' + str4
// 其中 str=HTTP method, str2=path, str3=ts, str4=nonce
// 即: METHOD + '\n' + PATH + '\n' + TS + '\n' + NONCE
```

**⚠️ 重要**: 签名使用的是 **HTTP method**（如 "POST"、"GET"），不是 access_token！

**调用链确认** (源码逐行追踪):
1. `h0/e.j(String str, String str2, JSONObject jSONObject, String str3)` — `str`=method, `str2`=path, `str3`=token
2. `j()` 第368行: `b(httpURLConnection, str, str2)` — 传入 method 和 path
3. `h0/e.b(conn, String str, String str2)` — `str`=method, `str2`=path
4. `b()` 第186行: `AbstractC0584w.z(str, str2, ts, nonce)` — 传入 method, path, ts, nonce
5. `q0/AbstractC0584w.z(str, str2, str3, str4)` — 拼接 `str + '\n' + str2 + '\n' + str3 + '\n' + str4`

#### 签名计算步骤

1. **路径清理** (`h0/e.java` 第179-181行): `path = path.substring(0, indexOf('?'))` — 去掉 query 参数
2. **时间戳**: `String.valueOf(System.currentTimeMillis() / 1000)` — 秒级
3. **Nonce**: 16字节 SecureRandom → `Base64.encodeToString(bytes, 3)` — flag=3 即 `NO_PADDING | NO_WRAP`，产出24字符
4. **拼接**: `METHOD + '\n' + PATH + '\n' + TS + '\n' + NONCE` → UTF-8 字节
5. **HMAC**: `HMAC-SHA256(macKey, signingBytes)` — macKey 是 ECDH 派生的 32 字节 MAC 密钥
6. **编码**: `Base64.encodeToString(signature, 3)` — flag=3 即 `NO_PADDING | NO_WRAP`，产出43字符

#### X-Session 与签名的关系

**X-Session 不参与签名计算**。签名只覆盖 `METHOD + PATH + TS + NONCE`。

但 X-Session 是**必须的请求头**（服务端用它查找 macKey 来验签）。缺少 X-Session 会返回 `bad_signature`。

#### 请求头清单

| 头 | 值 | 来源 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | `h0.e.i()` |
| `X-Ts` | 秒级时间戳 | `h0.e.b()` 第186行 |
| `X-Nonce` | Base64(NO_PADDING\|NO_WRAP) | `AbstractC0584w.w()` 第324行 |
| `X-Sign` | HMAC-SHA256 → Base64(NO_PADDING\|NO_WRAP) | `AbstractC0584w.z()` 第366行 |
| `X-Session` | handshake 返回的 session_id | `h0.c` 传输层设置 |
| `X-Device-Id` | Android ID | `AbstractC0588y.b()` 第190行 |

#### 签名触发条件 (`h0/e.java` 第180行)

```java
if (str2.startsWith("/v2/") || str2.startsWith("/v1/v2/")) {
    // 才会签名
}
```

仅 `/v2/` 或 `/v1/v2/` 开头的路径才签名。`/auth/`、`/v1/` (非v2) 路径不签名。

#### 与 nx3/nx4 文档差异 ⚠️

**nx3/nx4 §9.4 写 `signingString = token + "\n" + ...` 是错误的。** 

源码确认（ jadx --show-bad-code 反编译 `h0/e.java` 第368行 + `q0/AbstractC0584w.z()` 第366行）:
- `j()` 方法中 `str` = HTTP method (第一个参数), `str2` = path (第二个参数), `str3` = token (第三个参数)
- 调用 `b(conn, str, str2)` 传入的是 method 和 path，不是 token
- `z()` 方法拼接 `str + '\n' + str2 + '\n' + str3 + '\n' + str4` = `method + '\n' + path + '\n' + ts + '\n' + nonce`

正确公式: `METHOD + '\n' + PATH + '\n' + TS + '\n' + NONCE`

此外，X-Session 必须作为独立请求头发送（服务端用它查找 macKey），缺少会返回 `bad_signature`。

### 9.5 ECDH 派生与信封 MAC 字节级定义

**源码确认**: `q0/AbstractC0584w.java` 全文

#### 密钥派生流程

```
1. ECDH P-256 协商 → shared_secret (原始字节, 通常32字节)
2. truncated = v(shared_secret, 32)  // 第311-322行
   - 若 len == 32: 直接返回
   - 若 len > 32: 取末尾32字节 (System.arraycopy(bArr, bArr.length - 32, ...))
   - 若 len < 32: 左侧补零 (System.arraycopy(bArr, 0, bArr2, 32 - bArr.length, ...))
3. encKey = SHA256(truncated + "enc".getBytes("UTF-8"))  // 第85行
   - h(truncated, "enc".getBytes("UTF-8")) → 字节拼接
   - y(result) → SHA-256
4. macKey = SHA256(truncated + "mac".getBytes("UTF-8"))  // 第85行
   - 同上
```

**关键细节**:
- `h()` 方法 (第127行): `System.arraycopy` 字节级拼接，不是字符串拼接
- `"enc"` 和 `"mac"` 是 ASCII 字符串，UTF-8 编码后各3字节
- `y()` 方法 (第352行): `MessageDigest.getInstance("SHA256")` → `update(bArr)` → `digest()`

#### 加密信封结构 (`k()` 方法, 第162-178行)

```java
// 1. 生成随机IV
byte[] iv = new byte[16];
new SecureRandom().nextBytes(iv);

// 2. AES-256-CBC 加密
Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(encKey, "AES"), new IvParameterSpec(iv));
byte[] ciphertext = cipher.doFinal(plaintext.getBytes("UTF-8"));

// 3. MAC = HMAC-SHA256(macKey, iv || ciphertext)
byte[] mac = t(macKey, h(iv, ciphertext));  // t()=HMAC, h()=字节拼接

// 4. 信封
envelope.put("iv", Base64.encodeToString(iv, 2));        // NO_WRAP
envelope.put("data", Base64.encodeToString(ciphertext, 2)); // NO_WRAP
envelope.put("mac", Base64.encodeToString(mac, 2));        // NO_WRAP
```

#### 解密信封 (`j()` 方法, 第138-160行)

```java
// 1. 解析信封
byte[] iv = Base64.decode(envelope.getString("iv"), 2);
byte[] ciphertext = Base64.decode(envelope.getString("data"), 2);
byte[] mac = Base64.decode(envelope.getString("mac"), 2);

// 2. 验证 MAC
byte[] expectedMac = t(macKey, h(iv, ciphertext));
if (!MessageDigest.isEqual(mac, expectedMac)) return null;  // 恒定时间比较

// 3. AES-CBC 解密
Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(encKey, "AES"), new IvParameterSpec(iv));
byte[] plaintext = cipher.doFinal(ciphertext);
```

#### 信封字段汇总

| 字段 | 内容 | Base64 flag | 长度 |
|---|---|---|---|
| `iv` | 16字节 SecureRandom | 2 (NO_WRAP) | 24字符 |
| `data` | AES-CBC 密文 (PKCS5Padding) | 2 (NO_WRAP) | 变长 |
| `mac` | HMAC-SHA256 输出 (32字节) | 2 (NO_WRAP) | 43-44字符 |

**MAC 输入**: `iv_bytes || ciphertext_bytes` (原始字节拼接，不是 Base64)

---

## 10. 认证系统

### 10.1 登录

**端点**: `POST /auth/login`

**请求体** (源码确认 `LoginActivity.java` 第246-254行):

| 字段 | 类型 | 必填 | 获取方式 | 说明 |
|---|---|---|---|---|
| `identifier` | String | ✅ | 用户输入 | 用户名/邮箱 |
| `password` | String | ✅ | 用户输入 | 密码 |
| `device_id` | String | ✅ | `AbstractC0588y.b(context)` | 设备唯一ID |
| `imei` | String | ✅ | `AbstractC0588y.d(context)` | IMEI号 |
| `device_name` | String | ✅ | `AbstractC0588y.c()` | 设备型号 |
| `platform` | String | ✅ | 硬编码 `"android"` | 平台标识 |
| `app_version` | String | ✅ | `AbstractC0588y.a(context)` | 应用版本号 |

**响应体** (源码确认 `LoginActivity.java` 第64-70行):

| 字段 | 类型 | 说明 |
|---|---|---|
| `access_token` | String | Bearer Token |
| `refresh_token` | String | 刷新令牌 |
| `user.id` | String | 数据库ID |
| `user.uid` | String | 用户UID |
| `user.ncuid` | String | 用户NCUID (optString) |
| `user.display_name` | String | 显示名 (optString) |
| `user.username` | String | 用户名 (optString) |

**Token 存储** (源码确认 `LoginActivity.G0()`):
```
SharedPreferences("auth")
  .putString("access_token", token)
  .putString("refresh_token", refreshToken)
  .putString("user_id", userId)
  .putString("my_uid", uid)
  .putString("my_ncuid", ncuid)
```

**额外存储**:
```
SharedPreferences("auth")
  .putString("display_name", displayName)
  .putString("my_username", username)
```

**密码保存** (明文):
```
SharedPreferences("auth")
  .putString("saved_username", username)
  .putString("saved_password", password)
```

### 10.2 注册

v1.4.x 移除了 `RegisterActivity`，改为浏览器跳转：
```java
Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(base_url + "/register"));
```

### 10.3 刷新令牌

**端点**: `POST /auth/refresh`

```json
{ "refresh_token": "..." }
```

响应: `{ "access_token": "...", "refresh_token": "..." }`

### 10.4 忘记密码

浏览器跳转：
```java
Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(base_url + "/forgot-password"));
```

### 10.5 错误处理

| HTTP状态码 | 错误信息 | 用户提示 |
|---|---|---|
| 401 | `invalid_credentials` | 用户名或密码错误 |
| 403 | `user_banned` | 已被封禁 |
| 403 | `device_banned` | 已被封禁 |
| 429 | `rate_limited` | 请求频繁，请稍后再试 |

---

## 11. 私聊系统

### 11.1 发送消息

**端点**: `POST /v2/direct/send` (通过路由映射)

**请求体** (源码确认):

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to_uid` | String | ✅ | 接收者UID |
| `to_ncuid` | String | ❌ | 接收者NCUID (非空时添加) |
| `body` | String | ✅ | 消息内容 (纯文本或v2 JSON) |
| `msg_type` | String | ✅ | 消息类型 |
| `media_url` | String | ❌ | 媒体URL (≤1024) |
| `thumb_url` | String | ❌ | 缩略图URL |
| `original_url` | String | ❌ | 原始文件URL |
| `duration_ms` | int | ❌ | 语音/视频时长 (ms, ≤60000) |
| `burn_after_seconds` | int | ❌ | 阅后即焚秒数 |

### 11.2 消息类型

| msg_type | 说明 | body 内容 | media_url |
|---|---|---|---|
| `text` | 文本消息 | 纯文本或v2 JSON | — |
| `image` | 图片消息 | — 或描述 | 图片URL |
| `voice` | 语音消息 | — | 音频URL |
| `video` | 视频消息 | — | 视频URL |
| `resource` / `file` | 文件消息 | 文件名 | 文件URL |
| `red_packet` | 红包消息 | 红包JSON | — |
| `system` | 系统消息 | 系统提示 | — |
| `recall` | 撤回消息 | "[消息已撤回]" | — |
| `interactive` | 交互按钮 | 按钮JSON | — |

### 11.2.1 media_kind 维度 (音乐分享双形态)

**源码确认**: `com/im/oldchat/ui/r.java` 第153行 + `m0/AbstractC0510x.java` 第163行

当 `msg_type = "text"` 时，v2 JSON 中的 `media_kind` 字段可标识特殊子类型:

| media_kind | 显示文本 | 说明 |
|---|---|---|
| `music` | "[音乐]" | 音乐分享卡片 (text 形态) |
| `image` | "[图片]" | 图片 |
| `voice` | "[语音]" | 语音 |
| `video` | "[视频]" | 视频 |
| `null` / 空 | 消息文本 | 普通文本 |

**音乐分享双形态**:

1. **text 形态** (推荐): `msg_type="text"`, body 为 v2 JSON 含 `media_kind:"music"`
```json
{
  "v": 2,
  "text": "",
  "media_kind": "music",
  "quote": null,
  "mentions": null
}
```
同时 `media_url` 指向音频文件, `thumb_url` 指向封面。

2. **resource 形态**: `msg_type="resource"`, `body` 为文件名, `media_url` 指向音频文件。
客户端通过 `"resource".equals(msg_type) && "music".equals(media_kind)` 判断 (源码 `r.java` 第153行)。

### 11.3 v2 消息格式

当 `msg_type === "text"` 且 `body` 以 `{` 开头时，尝试解析为 v2 JSON：

```json
{
  "v": 2,
  "text": "消息文本",
  "mentions": [
    { "ncuid": "USER_NCUID", "uid": "USER_UID", "name": "张三" }
  ],
  "quote": {
    "id": "被引用消息ID",
    "from_uid": "原发送者UID",
    "from_name": "原发送者名称",
    "type": "text",
    "text": "被引用消息内容（截取前200字符）"
  },
  "burn_after_seconds": 10
}
```

### 11.4 历史消息

**端点**: `GET /v2/direct/messages/v2?with_uid=USR-XXX&limit=30&offset=0&before_created_at=&before_id=&anchor_message_id=`

**响应**:
```json
{
  "messages": [
    {
      "id": "msg-id",
      "thread_id": "...",
      "from_uid": "USR-XXX",
      "from_ncuid": "USR-XXX",
      "body": "...",
      "msg_type": "text",
      "media_url": "",
      "thumb_url": "",
      "original_url": "",
      "duration_ms": 0,
      "burn_after_seconds": 0,
      "burn_start_at": null,
      "created_at": 1720000000,
      "sort_seq": 100
    }
  ],
  "has_more": true,
  "next_before_created_at": 1719990000,
  "next_before_id": "oldest-msg-id"
}
```

### 11.5 未读消息

**端点**: `POST /v2/unread/direct`

```json
{ "limit": 50, "offset": 0 }
```

### 11.6 标记已读

**端点**: `POST /v2/direct/read`

```json
{ "with_uid": "USR-XXX", "with_ncuid": "USR-XXX" }
```

### 11.7 消息搜索

**端点**: `GET /direct/messages/search?with_uid=USR-XXX&with_ncuid=USR-XXX&q=关键词&kind=all&limit=50&offset=0`

### 11.8 撤回消息

**端点**: `DELETE /direct/messages/{messageID}`

限制：仅能撤回自己发送的、2分钟内的消息。

### 11.9 语音转文字

**端点**: `POST /direct/messages/{messageID}/transcribe`

---

## 12. 群聊系统

### 12.1 发送群消息

**端点**: `POST /v2/groups/message/send`

```json
{
  "group_id": "GRP-XXXX",
  "body": "文本",
  "msg_type": "text",
  "media_url": "...",
  "thumb_url": "...",
  "original_url": "...",
  "duration_ms": 0,
  "burn_after_seconds": 0
}
```

### 12.2 群消息历史

**端点**: `GET /v2/groups/messages/v2?group_id=GRP-XXX&limit=30&offset=0&before_created_at=&before_id=&before_seq=&anchor_message_id=&mark_read=1`

### 12.3 群消息增量同步

**端点**: `GET /v2/groups/messages/after?group_id=GRP-XXX&after_seq=1200&limit=100`

响应按 `group_seq ASC` 返回。

### 12.4 群未读

**端点**: `POST /v2/unread/groups`

### 12.5 群已读

**端点**: `POST /v2/groups/read`

### 12.6 创建群组

**端点**: `POST /v2/groups/create`

```json
{
  "name": "群名",
  "member_uids": ["USR-XXX"],
  "member_ncuids": ["USR-XXX"]
}
```

### 12.7 群管理

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v2/groups/list` | GET | 我的群列表 |
| `/v2/groups/members?group_id=` | GET | 群成员 |
| `/v2/groups/members/lookup?group_id=&query=` | GET | 成员搜索 |
| `/v2/groups/requests` | GET | 入群申请 |
| `/v2/groups/approve` | POST | 审批入群 |
| `/v2/groups/join` | POST | 加入群 |
| `/v2/groups/leave` | POST | 退群 |
| `/v2/groups/invite` | POST | 邀请 |
| `/v2/groups/invitations` | GET | 邀请列表 |
| `/v2/groups/invitations/respond` | POST | 响应邀请 |
| `/v2/groups/admin` | POST | 设置管理员 |
| `/v2/groups/avatar` | POST | 设置群头像 |
| `/v2/groups/kick` | POST | 踢人 |
| `/v2/groups/name` | POST | 改名 |
| `/v2/groups/settings` | POST | 设置 |
| `/v2/groups/announcement` | POST | 发布公告 |
| `/v2/groups/announcement/read` | POST | 已读公告 |
| `/v2/groups/dissolve` | POST | 解散群 |
| `/v2/groups/burn/open` | POST | 阅后即焚 |
| `/v2/groups/typing` | POST | 正在输入 |
| `/groups/messages/search` | GET | 群消息搜索 |
| `/groups/messages/{messageID}` | DELETE | 删除群消息 |
| `/groups/messages/{messageID}/transcribe` | POST | 语音转文字 |

---

## 13. 好友系统

### 13.1 好友列表

**端点**: `GET /v2/friends`

响应:
```json
{
  "friends": [
    {
      "id": "...",
      "uid": "USR-XXX",
      "ncuid": "USR-XXX",
      "username": "...",
      "display_name": "...",
      "remark_name": "...",
      "user_title": "...",
      "avatar_url": "...",
      "is_online": false,
      "presence_status": "offline",
      "friend_added_at": 1720000000
    }
  ]
}
```

### 13.2 好友请求

**端点**: `POST /v2/friends/request`

```json
{ "to_uid": "USR-XXX", "to_ncuid": "USR-XXX" }
```

### 13.3 好友请求列表

**端点**: `GET /v2/friends/requests`

### 13.4 响应好友请求

**端点**: `POST /v2/friends/respond`

```json
{ "request_id": "...", "accept": true }
```

### 13.5 删除好友

**端点**: `POST /v2/friends/delete`

```json
{ "friend_uid": "USR-XXX", "friend_ncuid": "..." }
```

### 13.6 设置备注

**端点**: `POST /v2/friends/remark`

```json
{ "friend_uid": "USR-XXX", "friend_ncuid": "...", "remark_name": "张三" }
```

---

## 14. 频道系统

### 14.1 频道发现

**端点**: `GET /v2/channels/discover?q=关键词&limit=50`

**响应** (源码确认 `ChannelDiscoveryActivity.java` 第94-109行):

```json
{
  "channels": [
    {
      "id": "CHN-XXX",
      "name": "频道名称",
      "handle": "channel_handle",
      "avatar_url": "...",
      "description": "...",
      "visibility": "public",
      "subscriber_count": 1234
    }
  ]
}
```

### 14.2 订阅频道

**端点**: `POST /v2/channels/subscribe`

```json
{ "channel_id": "CHN-XXX" }
```

### 14.3 取消订阅

**端点**: `POST /v2/channels/unsubscribe`

```json
{ "channel_id": "CHN-XXX" }
```

### 14.4 频道通知设置

**端点**: `POST /v2/channels/notifications`

```json
{ "channel_id": "CHN-XXX", "notification_level": "all" }
```

`notification_level`: `"all"` (接收通知) / `"none"` (静音)

### 14.5 频道状态

**端点**: `GET /v2/channels/states`

### 14.6 频道帖子增量

**端点**: `GET /v2/channels/posts/after?channel_id=CHN-XXX&after_seq=100&limit=100`

### 14.7 频道事件增量

**端点**: `GET /v2/channels/events/after?channel_id=CHN-XXX&after_event_seq=100&limit=200`

### 14.8 发送频道帖子

**端点**: `POST /v2/channels/posts/send`

```json
{
  "channel_id": "CHN-XXX",
  "body": "帖子内容",
  "msg_type": "text",
  "media_url": "https://...",
  "reply_to_post_id": "..."  // 可选
}
```

### 14.9 频道已读

**端点**: `POST /v2/channels/read`

```json
{ "channel_id": "CHN-XXX", "read_seq": 123 }
```

### 14.10 频道表情回应

**端点**: `POST /v2/channels/reactions/toggle`

```json
{ "channel_id": "CHN-XXX", "post_id": "...", "emoji": "👍" }
```

### 14.11 频道媒体上传

**端点**: `POST /v1/channels/media/upload`

Multipart: `file` + `channel_id`

响应: `{ "url": "...", "msg_type": "...", "media_ref": "..." }`

### 14.12 频道数据模型

**channel_states 表** (源码确认 `i0/a.java` 第476行):
```sql
CREATE TABLE channel_states(
  account TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT,
  handle TEXT,
  avatar_url TEXT,
  subscriber_count INTEGER,
  post_seq INTEGER,
  event_seq INTEGER,
  synced_event_seq INTEGER DEFAULT 0,
  settings_version INTEGER,
  role TEXT,
  joined_post_seq INTEGER,
  last_read_post_seq INTEGER,
  notification_level TEXT,
  unread_count INTEGER,
  updated_at INTEGER,
  PRIMARY KEY(account, channel_id)
)
```

**channel_posts 表** (源码确认 `i0/a.java` 第477行):
```sql
CREATE TABLE channel_posts(
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  post_seq INTEGER,
  author_uid TEXT,
  author_name TEXT,
  author_avatar TEXT,
  reply_to_post_id TEXT,
  reply_author TEXT,
  reply_body TEXT,
  body TEXT,
  msg_type TEXT,
  media_url TEXT,
  thumb_url TEXT,
  view_count INTEGER,
  comment_count INTEGER,
  reactions_json TEXT DEFAULT '[]',
  created_at INTEGER,
  PRIMARY KEY(account, id)
)
```

### 14.13 频道角色

| 角色 | 说明 | 权限 |
|---|---|---|
| `owner` | 频道主 | 全部权限 |
| `admin` | 管理员 | 可发帖、管理 |
| `publisher` | 发布者 | 可发帖 |
| `subscriber` | 订阅者 | 只读 |

### 14.14 频道分享链接

格式: `https://oc.mcl0.dpdns.org/c/{handle}`

---

## 15. 交互按钮系统

### 15.1 消息格式

当 `msg_type === "interactive"` 时：

```json
{
  "msg_type": "interactive",
  "body": {
    "text": "请选择操作",
    "buttons": [
      [
        {"text": "同意", "action": "approve", "type": "primary"},
        {"text": "拒绝", "action": "reject", "type": "danger"}
      ]
    ]
  }
}
```

### 15.2 按钮样式

| type | 视觉效果 | 使用场景 |
|---|---|---|
| `primary` | 蓝色/绿色 | 确认、同意 |
| `danger` | 红色 | 拒绝、删除 |
| `default` | 灰色 | 中性操作 |

### 15.3 按钮回调

**端点**: `POST /v2/buttons/callback`

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

`btn_index` 按行优先排列，从0开始。

---

## 16. 文件系统

### 16.1 文件秒传检查

**端点**: `POST /v2/files/check`

```json
{ "sha256": "hex64", "size_bytes": 1048576 }
```

响应:
```json
{ "exists": true, "file_id": "...", "url": "...", "sha256": "..." }
```

### 16.2 文件上传

**端点**: `POST /v2/files/upload`

Multipart: `file` + `sha256` + `mime`

响应:
```json
{
  "file_id": "xxx",
  "name": "a.zip",
  "size_bytes": 123456,
  "sha256": "hex64",
  "url": "https://files.mcl0.dpdns.org/v2/files/download/xxx",
  "deduplicated": false
}
```

### 16.3 资源上传

**端点**: `POST /v2/resources/upload`

Multipart: `file` + `section_id`

### 16.4 媒体上传

**端点**: `POST /media`

Multipart: `file` + `thumb` (可选) + `X-File-Size` + `X-File-SHA256`

响应:
```json
{
  "url": "/v1/uploads/media/xxx.jpg",
  "thumb_url": "/v1/uploads/media/xxx_thumb.jpg",
  "original_url": "https://files.mcl0.dpdns.org/v2/files/download/xxx"
}
```

### 16.5 文件下载

| 端点 | 说明 |
|---|---|
| `GET/HEAD /v2/files/download/{fileID}` | 文件资产下载 |
| `GET/HEAD /v2/resources/download/{itemID}` | 资源下载 |
| `GET/HEAD /v1/uploads/*` | 静态文件 |

### 16.6 动态下载源

**端点**: `GET /download/sources`

```json
{ "sources": ["https://cn-sy1.rains3.com/oldchat", "https://files.mcl0.dpdns.org"] }
```

### 16.7 文件大小限制

| 类型 | 限制 |
|---|---|
| 图片 | 3 MB |
| 媒体 | 50 MB |
| 文件 | 500 MB (v2) / 1 GB (旧版) |

---

## 17. 朋友圈/动态系统

### 17.1 发布动态

**端点**: `POST /v2/moments`

```json
{ "body": "动态内容", "image_url": "url1,url2,url3" }
```

### 17.2 动态时间线

**端点**: `GET /v2/moments/feed?limit=&before_created_at=`

### 17.3 用户动态

**端点**: `GET /v2/moments/user?uid=USR-XXX`

### 17.4 点赞/取消

**端点**: `POST /v2/moments/like` / `POST /v2/moments/unlike`

```json
{ "moment_id": "..." }
```

### 17.5 评论

**端点**: `POST /v2/moments/comment`

```json
{ "moment_id": "...", "body": "评论内容" }
```

### 17.6 删除

**端点**: `POST /v2/moments/delete`

```json
{ "moment_id": "..." }
```

### 17.7 评论列表

**端点**: `GET /v2/moments/comments?moment_id=`

---

## 18. 音乐系统

### 18.1 音乐广场

**端点**: `GET /music/plaza?limit=30&offset=`

### 18.2 音乐搜索

**端点**: `GET /music/plaza/list?q=关键词`

### 18.3 音乐详情

**端点**: `GET /music/plaza/detail?item_id=`

### 18.4 歌词获取

**端点**: `GET /music/plaza/lyrics?item_id=`

### 18.5 排行榜

**端点**: `GET /music/plaza/ranking?limit=50`

### 18.6 我的音乐

**端点**: `GET /music/plaza/mine?limit=`

### 18.7 上传音乐

**端点**: `POST /music/plaza/upload`

Multipart: `file` (音频) + `cover`/`thumb` (封面) + `lyrics` (歌词) + `name` + `duration_ms`

### 18.8 播放列表

| 端点 | 方法 | 说明 |
|---|---|---|
| `/music/playlists` | GET | 获取播放列表 |
| `/music/playlists/sync` | POST | 同步播放列表 |

### 18.9 音乐操作

| 端点 | 说明 |
|---|---|
| `POST /music/plaza/like` | 点赞 |
| `POST /music/plaza/unlike` | 取消点赞 |
| `POST /music/plaza/comment` | 评论 |
| `GET /music/plaza/comments?item_id=` | 评论列表 |
| `POST /music/plaza/play` | 播放计数 |
| `POST /music/plaza/delete` | 删除 |
| `POST /music/plaza/mine/delete-batch` | 批量删除 |
| `POST /music/plaza/update` | 更新信息 |

### 18.10 MusicPlaybackService

**Intent Actions**:

| Action | 功能 |
|---|---|
| `PLAY_SONG` | 播放指定歌曲 |
| `CACHE_SONG` | 缓存歌曲 |
| `TOGGLE_PLAY` | 播放/暂停 |
| `PAUSE` | 暂停 |
| `STOP` | 停止 |
| `SEEK` | 跳转 |
| `SEEK_RELATIVE` | 相对跳转 |
| `TOGGLE_REPEAT_ONE` | 单曲循环 |

**缓存**:
- 目录: `{filesDir}/music_player_cache/`
- 命名: SHA1(url) + 扩展名
- 上限: 220 MB / 120 个文件
- LRU 清理

---

## 19. B站集成 (OldView)

### 19.1 B站API请求头

| 头 | 值 |
|---|---|
| User-Agent | `Mozilla/5.0 (Linux; Android 4.0.4) AppleWebKit/537.36` |
| Referer | `https://www.bilibili.com/` |
| Origin | `https://www.bilibili.com` |

### 19.2 关注状态查询

**GET** `https://api.bilibili.com/x/relation?fid={fid}`

`attribute & 2 == 2` → 已关注

### 19.3 关注/取关

**POST** `https://api.bilibili.com/x/relation/modify`

form-urlencoded: `fid`, `act` (1=关注/2=取关), `re_src=11`, `csrf`, `csrf_token`

### 19.4 B站认证存储

**SharedPreferences("bili_auth")**:

| 键 | 类型 | 说明 |
|---|---|---|
| `access_token` | String | B站访问令牌 |
| `cookies` | String | Cookie字符串 |
| `mid` | long | 用户MID |
| `expires_at` | long | 过期时间 (毫秒) |

### 19.5 BiliWebViewMemoryGuard (NEW)

新增 WebView 内存保护机制。

---

## 20. CIP 小程序系统

### 20.1 CIP 包格式

```
my_app.cip (ZIP)
├── manifest.json   — 必需
├── main.lua        — 必需 (UTF-8, ≤512 KiB)
└── assets/         — 可选资源
```

### 20.2 客户端 API

| 端点 | 说明 |
|---|---|
| `GET /discover/lua/manifest` | 远程清单 |
| `GET /discover/lua/apps/{id}` | 获取应用脚本 |
| `GET /lua-assets/{id}/{path}` | 获取资源 |

### 20.3 Lua 沙箱

可用 API: `ui.*`, `app.*`, `network.*`

禁止: `io`, `os`, `debug`, `package`, `require`, `dofile`, `loadfile`

---

## 21. 红包系统

### 21.1 发送红包

**端点**: `POST /v2/redpackets/send`

```json
{
  "title": "恭喜发财",          // ≤20字符
  "total_amount": 888,          // 分
  "total_count": 5,
  "cover_url": "",              // 可选
  "to_uid": "USR-XXX",         // 私聊
  "to_ncuid": "USR-XXX",       // 私聊
  "group_id": "GRP-XXX"        // 群
}
```

### 21.2 领取红包

**端点**: `POST /v2/redpackets/claim`

```json
{ "packet_id": "..." }
```

### 21.3 红包详情

**端点**: `GET /redpackets/{packetID}`

### 21.4 错误码

| 错误 | 说明 |
|---|---|
| `red_packet_insufficient` | 余额不足 |
| `red_packet_amount_invalid` | 金额无效 |
| `red_packet_count_invalid` | 数量无效 |
| `red_packet_amount_too_small` | 单个金额过小 |
| `red_packet_title_too_long` | 标题过长 |
| `invalid_cover_url` | 封面URL无效 |

---

## 22. 签到系统

### 22.1 每日签到

**端点**: `POST /v2/me/checkin`

响应:
```json
{
  "already_checked": false,
  "checkin_date": "2026-08-14",
  "coin_reward": 0,
  "reputation_reward": 50,
  "coin_balance": 0,
  "reputation_score": 1850
}
```

### 22.2 签到墙

| 端点 | 说明 |
|---|---|
| `GET /me/checkin/wall` | 签到墙列表 |
| `POST /me/checkin/wall` | 发布留言 |
| `POST /me/checkin/wall/like` | 点赞 |
| `POST /me/checkin/wall/unlike` | 取消点赞 |
| `POST /me/checkin/wall/comment` | 评论 |
| `GET /me/checkin/wall/comments` | 评论列表 |
| `GET /me/checkin/wall/likes` | 点赞列表 |

---

## 22.5 每日刮刮乐系统

> 逆向来源：`ScratchActivity`（`com.im.oldchat.ui`）+ 网络层 `h0/e`、`AbstractC0584w`、路由表 `h0/e.q()`。
> 入口：App「我的」Tab → 刮刮乐入口 → `ScratchActivity`（由 `n0/d.java` 拉起）。
> Token 来源：`SharedPreferences("auth").getString("access_token", "")`。

### 22.5.1 路由映射

客户端内部调用路径为 `/me/scratch`，经 v1→v2 映射表（`h0/e.java`）映射为 **`/v2/me/scratch`**：

```java
str.equals("/me/scratch") ? "/v2/me/scratch" : ...
```

传输形态与其他 `/v2` 接口一致：当握手会话存在（`AbstractC0584w.s()` 为 true）时，请求被折叠进统一网关 `POST /v2/gateway`，加密信封内明文为：

```json
{ "m": "GET",  "p": "/v2/me/scratch", "q": "", "b": null }
{ "m": "POST", "p": "/v2/me/scratch", "q": "", "b": {} }
```

### 22.5.2 查询今日刮奖状态（GET）

**端点**: `GET /v2/me/scratch`

（onCreate 时由 `ScratchActivity.z0()` 触发）

### 22.5.3 执行刮奖（POST）

**端点**: `POST /v2/me/scratch`

```json
{}
```

请求体为**空对象 `{}`，无任何参数**。（点击「刮一刮」时由 `ScratchActivity.w0()` 触发）

### 22.5.4 响应格式

GET 与 POST 响应结构相同（由 `ScratchActivity.A0()` 解析）：

```json
{
  "already_done": false,
  "total_reward": 0,
  "coin_balance": 0,
  "slots": [0, 0, 0, 0, 0]
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `already_done` | bool | 今日是否已刮过（服务端按「天」判定，`true` 时拒绝再次刮奖） |
| `total_reward` | int | 今日刮奖获得的金币总数（未刮 / 未中奖为 0） |
| `coin_balance` | int | 当前金币（旧币）余额，用于显示「金币余额：X」 |
| `slots` | int[] | 5 个刮卡格子的中奖值数组（长度固定 5） |

### 22.5.5 slots 数值 → 文案映射

由 `ScratchActivity.y0()` 还原：

| slots 值 | 显示文案 |
|---|---|
| `0` | 谢谢惠顾 |
| `1` | 1 金币 |
| `5` | 5 金币 |
| `10` | 10 金币 |
| `20` | 20 金币 |
| 其他 | `X 金币` |

5 个格子分别渲染到 5 个 TextView（`ScratchActivity.B0()`）。`total_reward` 与 `slots` 和值关系、每日重置时间边界均由服务端决定，客户端不参与计算。

### 22.5.6 业务 / UI 逻辑

- **已刮过**（`already_done=true`）：按钮变「明日再来」，副标题显示「今日获得 X 金币」或「今日未中奖」；再点按钮只弹「今天已经刮过啦，明天再来吧」，不再发请求。
- **未刮过**：按钮「刮一刮」，副标题「中奖概率很高，每天可刮一次」。
- **POST 成功**：`total_reward <= 0` → toast「可惜没有中奖，明天再来~」；`> 0` → toast「恭喜获得 X 金币！」。
- **失败**：GET 失败 toast「加载失败：<err>」；POST 失败 toast「刮奖失败：<err>」。

### 22.5.7 请求头 / 加密 / 签名

对 `/v2/me/scratch`，`h0/e.b()` 会注入以下签名头：

| 头 | 值 |
|---|---|
| `X-Ts` | 秒级时间戳 |
| `X-Nonce` | 16 字节随机 → Base64(NoPadding\|NoWrap) |
| `X-Sign` | HMAC-SHA256(macKey, `METHOD\nPATH\nTS\nNONCE`) → Base64(NoPadding\|NoWrap) |
| `X-Device-Id` | Android ID |

加密信封（`AbstractC0584w`）：请求 / 响应 body 为 `{"iv","data","mac"}`（AES-256-CBC/PKCS5 + HMAC-SHA256），头 `X-Enc: 1`、`X-Enc-Compression: gzip`、`X-Session: <session_id>`；会话存在时 token 走 `X-Auth`（加密的 `Bearer <token>`），否则 `Authorization: Bearer <token>`。经网关折叠时响应固定 HTTP 200，解密后为 `{"code":200,"body":"<实际JSON字符串>"}`，由 `h0/e.l()` 拆出 `code` 与 `body` 再交给回调。

### 22.5.8 兜底路径（无会话直连）

未握手成功时走直连 `http://oc.mcl0.dpdns.org/v2/me/scratch`（同签名 + 加密）；服务端返回 `invalid_session` 时重置握手重试（`h0/e.v()`）。正常使用中 session 建立后均走 gateway 折叠。

---

## 23. 用户中心

### 23.1 当前用户信息

**端点**: `GET /me`

### 23.2 更新资料

**端点**: `POST /v2/me/profile`

```json
{ "display_name": "...", "avatar_url": "...", "signature": "...", "cover_url": "..." }
```

### 23.3 修改UID

**端点**: `POST /v2/me/uid`

```json
{ "uid": "USR-NEWID" }
```

### 23.4 修改密码

**端点**: `POST /v2/me/password`

```json
{ "old_password": "...", "new_password": "..." }
```

### 23.5 头像/封面上传

**端点**: `POST /v2/me/avatar` / `POST /v2/me/cover`

Multipart: `file` (或 `avatar` / `cover`)

### 23.6 在线状态

**端点**: `POST /v2/me/presence`

```json
{ "status": "online" }  // online|offline|busy|away
```

### 23.7 设备管理

| 端点 | 说明 |
|---|---|
| `GET /v2/me/devices` | 设备列表 |
| `POST /v2/me/devices/cleanup` | 清理其他设备 |
| `POST /v2/me/devices/cleanup-others` | 同上 |

### 23.8 群邀请偏好

**端点**: `GET/POST /v2/me/group-invite-preference`

```json
{ "reject": true }
```

### 23.9 删除账号

**端点**: `POST /v2/me/delete/email/send` → `POST /v2/me/delete`

```json
{ "password": "...", "email_code": "..." }
```

### 23.10 查看用户资料

**端点**: `GET /v2/users/profile?uid=USR-XXX`

### 23.11 语音识别

**端点**: `POST /voice/asr`

Multipart: `file`

---

## 24. 资源广场

### 24.1 分区管理

| 端点 | 说明 |
|---|---|
| `GET /resources/sections` | 分区列表 |
| `POST /resources/sections` | 创建分区 |
| `POST /resources/sections/delete` | 删除分区 |

### 24.2 条目管理

| 端点 | 说明 |
|---|---|
| `GET /resources/items?section_id=` | 条目列表 |
| `GET /resources/search?q=` | 搜索 |
| `POST /v2/resources/upload` | 上传 |
| `POST /resources/items/delete` | 删除 |
| `POST /resources/like` / `unlike` | 点赞 |
| `POST /resources/comment` | 评论 |
| `GET /resources/comments` | 评论列表 |
| `POST /resources/comment/delete` | 删评论 |
| `POST /resources/report` | 举报 |
| `GET /me/resources/quota` | 我的配额 |

---

## 25. 表情广场

| 端点 | 说明 |
|---|---|
| `GET /emoji/plaza` | 表情列表 |
| `GET /emoji/plaza/mine` | 我的表情 |
| `POST /emoji/plaza/upload` | 上传 |
| `POST /emoji/plaza/save` | 收藏 |
| `POST /emoji/plaza/delete` | 删除 |

---

## 26. 公开法庭

| 端点 | 说明 |
|---|---|
| `GET /public-court/cases` | 案件列表 |
| `GET /public-court/cases/{caseID}` | 案件详情 |
| `GET /public-court/cases/{caseID}/votes` | 投票结果 |
| `GET /public-court/cases/{caseID}/discussions` | 讨论 |
| `POST /public-court/cases/{caseID}/vote` | 投票 |
| `POST /public-court/cases/{caseID}/statement` | 陈述 |
| `POST /public-court/cases/{caseID}/discussion` | 参与讨论 |
| `POST /public-court/cases/{caseID}/withdraw` | 撤销 |

---

## 27. AI 助手

| 端点 | 说明 |
|---|---|
| `GET /ai/quota` | AI 额度 |
| `POST /ai/chat/completions` | AI 对话 (OpenAI 格式, 流式 SSE) |
| `POST /chat/completions` | OpenAI 兼容别名 |

---

## 28. 通知与反馈

| 端点 | 说明 |
|---|---|
| `GET /notifications?limit=` | 通知列表 |
| `POST /feedback` | 反馈 |
| `POST /admins/crash-reports` | 崩溃上报 |
| `GET /me/bug-reports` | Bug 报告 |
| `GET /me/user-reports` | 用户举报 |
| `GET /me/group-reports` | 群举报 |
| `GET /me/resource-reports` | 资源举报 |

---

## 29. 数据存储系统

### 29.1 SharedPreferences 完整清单

| SP 名称 | 用途 | 键数量 |
|---|---|---|
| `auth` | 认证信息 | 8+ |
| `bili_auth` | B站认证 | 4 |
| `settings` | 应用设置 | 1+ |
| `user_name_cache` | 用户名缓存 | N |
| `user_title_cache` | 用户头衔缓存 | N |
| `emoji_store` | 表情列表 | 1 |
| `emoji_upload_cache` | 表情上传缓存 | N |
| `emoji_picker_ui` | 表情选择器UI | — |
| `music_plaza_local` | 音乐广场数据 | — |
| `recent_play` | 最近播放 | — |
| `last_category` | 最后分类 | — |
| `profile_cache` | 个人资料缓存 | N |
| `user_space_profile_cache` | 用户空间缓存 | — |
| `notification` | 通知状态 | — |
| `me_profile_json` | 个人资料JSON | 1 |
| `group_sync_watermarks` | 群同步水位 | N |
| `message_history_cache` | 消息历史缓存 | N |
| `recent_snapshot_cache` | 最近快照缓存 | — |

### 29.2 auth SP 详细键名

| 键 | 类型 | 说明 |
|---|---|---|
| `access_token` | String | Bearer Token |
| `refresh_token` | String | 刷新令牌 |
| `user_id` | String | 数据库ID |
| `my_uid` | String | 用户UID |
| `my_ncuid` | String | 用户NCUID |
| `saved_username` | String | 记住的用户名 (明文) |
| `saved_password` | String | 记住的密码 (明文) |
| `display_name` | String | 显示名 |
| `my_username` | String | 用户名 |
| `token` | String | 旧版token键名 (兼容回退) |

### 29.3 数据库表 (完整 CREATE TABLE)

#### direct_messages 表 (`i0/j.java` 第60行)

```sql
CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  peer_uid TEXT NOT NULL,
  peer_ncuid TEXT NOT NULL DEFAULT '',
  from_uid TEXT NOT NULL,
  from_ncuid TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'text',
  media_url TEXT NOT NULL DEFAULT '',
  thumb_url TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  burn_after_seconds INTEGER NOT NULL DEFAULT 0,
  burn_start_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sort_seq INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  recall_edit_type TEXT NOT NULL DEFAULT '',
  recall_edit_text TEXT NOT NULL DEFAULT '',
  sender_ncuid TEXT NOT NULL DEFAULT '',
  local_pending INTEGER NOT NULL DEFAULT 0,
  local_failed INTEGER NOT NULL DEFAULT 0,
  local_request_id TEXT NOT NULL DEFAULT '',
  local_preview_uri TEXT NOT NULL DEFAULT '',
  local_progress INTEGER NOT NULL DEFAULT -1
)
```

**游标列**: `created_at` + `id` (复合游标分页), `sort_seq` (同秒排序)

#### group_messages 表 (`i0/j.java` 第61行)

```sql
CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  from_uid TEXT NOT NULL,
  sender_ncuid TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'text',
  media_url TEXT NOT NULL DEFAULT '',
  thumb_url TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  burn_after_seconds INTEGER NOT NULL DEFAULT 0,
  burn_start_at INTEGER NOT NULL DEFAULT 0,
  burned_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sort_seq INTEGER NOT NULL DEFAULT 0,
  group_seq INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  recall_edit_type TEXT NOT NULL DEFAULT '',
  recall_edit_text TEXT NOT NULL DEFAULT '',
  local_pending INTEGER NOT NULL DEFAULT 0,
  local_failed INTEGER NOT NULL DEFAULT 0,
  local_request_id TEXT NOT NULL DEFAULT '',
  local_preview_uri TEXT NOT NULL DEFAULT '',
  local_progress INTEGER NOT NULL DEFAULT -1
)
```

**游标列**: `created_at` + `id` (复合游标), `group_seq` (增量同步)

#### direct_message_rows 表 (`i0/d.java` 第34行) — 缓存层

```sql
CREATE TABLE IF NOT EXISTS direct_message_rows (
  peer_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  PRIMARY KEY (peer_key, message_id)
)
```

#### group_message_rows 表 (`i0/d.java` 第35行) — 缓存层

```sql
CREATE TABLE IF NOT EXISTS group_message_rows (
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  PRIMARY KEY (group_id, message_id)
)
```

#### pts_state 表 (`i0/j.java` 第62行)

```sql
CREATE TABLE IF NOT EXISTS pts_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
)
```

#### members_live 表 (`k0/p.java` 第38行) — 群成员

```sql
CREATE TABLE members_live (
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  ncuid TEXT NOT NULL,
  uid TEXT,
  username TEXT,
  display_name TEXT,
  user_title TEXT,
  avatar_url TEXT,
  role INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account, group_id, ncuid)
)
```

#### members_stage 表 (`k0/p.java` 第39行) — 群成员同步暂存

```sql
CREATE TABLE members_stage (
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  ncuid TEXT NOT NULL,
  uid TEXT,
  username TEXT,
  display_name TEXT,
  user_title TEXT,
  avatar_url TEXT,
  role INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL DEFAULT 0,
  sync_id TEXT NOT NULL,
  PRIMARY KEY(account, group_id, sync_id, ncuid)
)
```

#### member_sync 表 (`k0/p.java` 第40行)

```sql
CREATE TABLE member_sync (
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  expected_total INTEGER,
  received INTEGER,
  updated_at INTEGER,
  PRIMARY KEY(account, group_id)
)
```

#### cached_groups 表 (`k0/p.java` 第41行)

```sql
CREATE TABLE cached_groups (
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  updated_at INTEGER,
  member_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account, group_id)
)
```

#### channel_states 表 (`i0/a.java` 第476行)

```sql
CREATE TABLE channel_states (
  account TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT,
  handle TEXT,
  avatar_url TEXT,
  subscriber_count INTEGER,
  post_seq INTEGER,
  event_seq INTEGER,
  synced_event_seq INTEGER DEFAULT 0,
  settings_version INTEGER,
  role TEXT,
  joined_post_seq INTEGER,
  last_read_post_seq INTEGER,
  notification_level TEXT,
  unread_count INTEGER,
  updated_at INTEGER,
  PRIMARY KEY(account, channel_id)
)
```

#### channel_posts 表 (`i0/a.java` 第477行)

```sql
CREATE TABLE channel_posts (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  post_seq INTEGER,
  author_uid TEXT,
  author_name TEXT,
  author_avatar TEXT,
  reply_to_post_id TEXT,
  reply_author TEXT,
  reply_body TEXT,
  body TEXT,
  msg_type TEXT,
  media_url TEXT,
  thumb_url TEXT,
  view_count INTEGER,
  comment_count INTEGER,
  reactions_json TEXT DEFAULT '[]',
  created_at INTEGER,
  PRIMARY KEY(account, id)
)
```

**索引**: `CREATE INDEX idx_channel_posts_seq ON channel_posts(account, channel_id, post_seq)`

---

## 30. 事件系统与 WebSocket

### 30.1 WebSocket 连接

**端点**: `GET /v1/ws?token=<access_token>&sid=<session_id>`

**加密**: WS 帧**不走 X-Enc 信封加密**。源码确认 `h0/e.java` 第412行 `!str.startsWith("/ws")` 排除 WS 路径。但客户端在接收到帧后会尝试解密 (`AbstractC0584w.i(str)`)，如果解密失败则使用原始明文。因此 WS 帧可以是**明文 JSON 或加密信封**，取决于服务端实现。

### 30.2 事件信封

WS 帧顶层结构:
```json
{
  "type": "direct_message",
  "data": { ... }
}
```

增量补差 (`/v2/updates/difference`) 信封:
```json
{
  "pts": 1234,
  "pts_count": 1,
  "type": "DIRECT_MESSAGE_NEW",
  "date": 1720000000,
  "payload": { ... }
}
```

### 30.3 增量补差

**端点**: `GET /v2/updates/difference?pts=N&limit=200`

响应:
```json
{
  "events": [...],
  "has_more": false,
  "next_pts": 200,
  "reset": false,
  "current_pts": 200
}
```

**reset 判定** (`h0/j.java` 第207行):
- `current_pts - request_pts > 10000` (差距过大)
- 请求位置之后事件已被归档清理
- `request_pts > current_pts` (本地异常)

### 30.4 WS 事件类型与 payload 结构

**源码确认**: `h0/l.java` (WS 帧解析) + `h0/i.java` (account_event 差量分发)

#### 30.4.1 WS 帧事件 (h0/l.java)

| type (WS帧) | payload 字段 | 类型 | 说明 |
|---|---|---|---|
| `direct_message` | `id`, `thread_id`, `from_uid`, `from_ncuid`, `body`, `msg_type`, `media_url`, `thumb_url`, `original_url`, `duration_ms`, `burn_after_seconds`, `burn_start_at`, `created_at`, `sort_seq` | 各类型 | 新私聊消息 |
| `direct_read` | `thread_id`, `reader_uid`, `reader_ncuid`, `read_at` | String/String/String/long | 对方已读 |
| `direct_recall` | `message_id`, `thread_id`, `from_uid` | String | 私聊撤回 |
| `group_message` | `id`, `group_id`, `from_uid`, `from_ncuid`, `body`, `msg_type`, `media_url`, `thumb_url`, `original_url`, `duration_ms`, `burn_after_seconds`, `created_at`, `sort_seq`, `group_seq` | 各类型 | 群新消息 |
| `group_recall` | `message_id`, `group_id`, `from_uid` | String | 群消息撤回 |
| `channel_update` | `channel_id` | String | 频道更新 (触发频道状态刷新) |
| `system_notification` | `id`, `title`, `body` | String | 系统通知 |
| `typing` | `chat_id`, `uid`, `ncuid`, `avatar_url`, `is_group`, `is_typing` | String/String/String/String/boolean/boolean | 正在输入 |
| `presence` | `uid`, `is_online`, `presence_status` | String/boolean/String | 在线状态 |
| `account_event` | `pts`, `pts_count`, `type`, `payload` | long/int/String/JSONObject | 账号级事件 (转发到差量系统) |

#### 30.4.2 account_event 子类型 (h0/i.java)

当 WS 帧 type=`account_event` 时，`data` 内嵌差量事件:

| 子 type (payload内) | payload 字段 | 类型 | 说明 |
|---|---|---|---|
| `DIRECT_MESSAGE_NEW` | `message` (JSONObject，结构同 direct_message) | JSONObject | 新私聊消息 |
| `DIRECT_MESSAGE_RECALL` | `message_id`, `thread_peer_uid` | String | 私聊撤回 |
| `DIRECT_READ` | `peer_uid`, `read_up_to_message_id` | String | 已读 |
| `GROUP_POINTER_UPDATE` | `group_id`, `group_seq`, `hint_type` | String/long/String | 群消息指针更新 |
| `GROUP_MEMBERSHIP_CHANGE` | `group_id` | String | 群成员变更 |

#### 30.4.3 direct_message payload 详细字段 (h0/q.java)

| 混淆字段 | JSON 字段 | 类型 | 说明 |
|---|---|---|---|
| `f7336a` | `id` | String | 消息ID |
| `f7337b` | `thread_id` | String | 会话线程ID |
| `f7338c` | `from_uid` | String | 发送者UID |
| `f7339d` | `from_ncuid` | String | 发送者NCUID |
| `f7340e` | (同 from_uid) | String | 发送者UID (副本) |
| `f7342g` | `body` | String | 消息正文 |
| `f7343h` | `msg_type` | String | 消息类型 (默认 "text") |
| `f7344i` | `media_url` | String | 媒体URL |
| `f7345j` | `thumb_url` | String | 缩略图URL |
| `f7346k` | `original_url` | String | 原始文件URL |
| `f7347l` | `duration_ms` | int | 时长 (ms) |
| `f7348m` | `burn_after_seconds` | int | 阅后即焚秒数 |
| `f7349n` | `burn_start_at` | long | 焚毁开始时间 |
| `f7350o` | `created_at` | long | 创建时间 (秒) |
| `f7351p` | `sort_seq` | long | 排序序号 |

#### 30.4.4 group_message payload 详细字段 (h0/s.java)

| 混淆字段 | JSON 字段 | 类型 | 说明 |
|---|---|---|---|
| `f7355a` | `id` | String | 消息ID |
| `f7356b` | `group_id` | String | 群组ID |
| `f7357c` | `from_uid` | String | 发送者UID |
| `f7358d` | `from_ncuid` | String | 发送者NCUID |
| `f7360f` | `body` | String | 消息正文 |
| `f7361g` | `msg_type` | String | 消息类型 |
| `f7362h` | `media_url` | String | 媒体URL |
| `f7363i` | `thumb_url` | String | 缩略图URL |
| `f7364j` | `original_url` | String | 原始文件URL |
| `f7365k` | `duration_ms` | int | 时长 (ms) |
| `f7366l` | `burn_after_seconds` | int | 阅后即焚秒数 |
| `f7367m` | `created_at` | long | 创建时间 (秒) |
| `f7368n` | `sort_seq` | long | 排序序号 |
| `f7369o` | `group_seq` | long | 群消息序号 |

#### 30.4.5 typing payload 详细字段 (h0/v.java)

| 混淆字段 | JSON 字段 | 类型 | 说明 |
|---|---|---|---|
| `f7376a` | `chat_id` | String | 聊天ID |
| `f7377b` | `uid` | String | 用户UID |
| `f7378c` | `ncuid` | String | 用户NCUID |
| `f7379d` | `avatar_url` | String | 用户头像 |
| `f7380e` | `is_group` | boolean | 是否群聊 |
| `f7381f` | `is_typing` | boolean | 是否正在输入 |

#### 30.4.6 presence payload 详细字段 (h0/u.java)

| 混淆字段 | JSON 字段 | 类型 | 说明 |
|---|---|---|---|
| `f7373a` | `uid` | String | 用户UID |
| `f7374b` | `is_online` | boolean | 是否在线 |
| `f7375c` | `presence_status` | String | 状态: online/offline/busy/away |

#### 30.4.7 direct_recall payload (h0/r.java)

| 混淆字段 | JSON 字段 | 类型 | 说明 |
|---|---|---|---|
| `f7352a` | `message_id` | String | 被撤回消息ID |
| `f7353b` | `thread_id` | String | 会话线程ID |
| `f7354c` | `from_uid` | String | 撤回者UID |

#### 30.4.8 group_recall payload (h0/t.java)

| 混淆字段 | JSON 字段 | 类型 | 说明 |
|---|---|---|---|
| `f7370a` | `message_id` | String | 被撤回消息ID |
| `f7371b` | `group_id` | String | 群组ID |
| `f7372c` | `from_uid` | String | 撤回者UID |

---

## 31. 错误码汇总

| code | HTTP | 说明 |
|---|---|---|
| `unauthorized` | 401 | 未登录/token失效 |
| `invalid_credentials` | 401 | 账号密码错误 |
| `user_banned` | 403 | 用户封禁 |
| `device_banned` | 403 | 设备封禁 |
| `unauthorized_client` | 403 | APK签名不符 |
| `invalid_session` | 400/401 | 会话无效 |
| `missing_session` | 400 | 会话缺失 |
| `bad_signature` | 401 | 签名失败 |
| `missing_signature` | 401 | 签名缺失 |
| `device_mismatch` | 403 | 设备不匹配 |
| `rate_limited` | 429 | 限流 |
| `registration_closed` | 403 | 注册名额已满 |
| `invalid_email_code` | 400 | 验证码错误 |
| `email_taken` | 409 | 邮箱已注册 |
| `username_taken` | 409 | 用户名已存在 |
| `uid_taken` | 409 | UID已存在 |
| `not_member` | 403 | 非群成员 |
| `group_not_found` | 404 | 群不存在 |
| `group_muted` | 403 | 全员禁言 |
| `resource_share_disabled` | 403 | 禁止转发资源 |
| `file_too_large` | 413 | 文件过大 |
| `image_too_large` | 413 | 图片过大 |
| `sha256_mismatch` | 400 | SHA256不匹配 |
| `video_disabled` | 403 | 视频功能关闭 |
| `bad_gateway_body` | 400 | 网关参数错误 |
| `bad_gateway_path` | 400 | 网关路径错误 |
| `bad_gateway_method` | 400 | 网关方法错误 |
| `red_packet_insufficient` | 403 | 余额不足 |
| `red_packet_amount_invalid` | 400 | 金额无效 |
| `red_packet_count_invalid` | 400 | 数量无效 |
| `red_packet_amount_too_small` | 400 | 单个金额过小 |
| `red_packet_title_too_long` | 400 | 标题过长 |
| `invalid_cover_url` | 400 | 封面URL无效 |

---

## 32. v2 网关与路由映射

### 32.1 统一网关

**端点**: `POST /v2/gateway`

所有 `/v2/` 请求可折叠到此入口。加密 body 明文：

```json
{
  "m": "POST",
  "p": "/v2/direct/send",
  "q": "",
  "b": { "to_uid": "USR-XXX", "body": "hi", "msg_type": "text" }
}
```

响应固定 HTTP 200：
```json
{ "code": 200, "body": { "id": "msg-id", "created_at": 1720000000 } }
```

### 32.2 完整 v2 端点清单

**私聊**:
- `POST /v2/direct/send`
- `POST /v2/direct/read`
- `POST /v2/direct/burn/open`
- `GET /v2/direct/messages/v2?with_uid=`
- `POST /v2/unread/direct`

**群聊**:
- `POST /v2/groups/message/send`
- `POST /v2/groups/read`
- `POST /v2/groups/burn/open`
- `GET /v2/groups/messages/v2?group_id=`
- `GET /v2/groups/messages/after?group_id=&after_seq=`
- `POST /v2/unread/groups`
- `POST /v2/groups/create`
- `POST /v2/groups/join`
- `POST /v2/groups/leave`
- `POST /v2/groups/approve`
- `POST /v2/groups/invite`
- `GET /v2/groups/invitations`
- `POST /v2/groups/invitations/respond`
- `POST /v2/groups/admin`
- `POST /v2/groups/avatar`
- `POST /v2/groups/kick`
- `POST /v2/groups/name`
- `POST /v2/groups/settings`
- `POST /v2/groups/announcement`
- `POST /v2/groups/announcement/read`
- `POST /v2/groups/dissolve`
- `GET /v2/groups/list`
- `GET /v2/groups/members`
- `GET /v2/groups/members/lookup?group_id=`
- `GET /v2/groups/requests`
- `POST /v2/groups/typing`

**好友**:
- `GET /v2/friends`
- `GET /v2/friends/requests`
- `POST /v2/friends/request`
- `POST /v2/friends/respond`
- `POST /v2/friends/remark`
- `POST /v2/friends/delete`

**用户**:
- `GET /v2/users/profile?uid=`
- `POST /v2/me/profile`
- `POST /v2/me/uid`
- `POST /v2/me/password`
- `POST /v2/me/avatar`
- `POST /v2/me/cover`
- `POST /v2/me/presence`
- `GET /v2/me/devices`
- `POST /v2/me/devices/cleanup`
- `POST /v2/me/delete/email/send`
- `POST /v2/me/delete`
- `GET/POST /v2/me/group-invite-preference`
- `POST /v2/me/checkin`
- `GET /v2/me/bug-reports`
- `GET /v2/me/user-reports`
- `GET /v2/me/group-reports`

**动态**:
- `POST /v2/moments`
- `GET /v2/moments/feed`
- `GET /v2/moments/user`
- `POST /v2/moments/like`
- `POST /v2/moments/unlike`
- `POST /v2/moments/delete`
- `POST /v2/moments/comment`
- `POST /v2/moments/comment/delete`
- `GET /v2/moments/comments`

**频道**:
- `GET /v2/channels/discover`
- `POST /v2/channels/subscribe`
- `POST /v2/channels/unsubscribe`
- `POST /v2/channels/notifications`
- `GET /v2/channels/states`
- `GET /v2/channels/posts/after`
- `GET /v2/channels/events/after`
- `POST /v2/channels/posts/send`
- `POST /v2/channels/read`
- `POST /v2/channels/reactions/toggle`

**文件**:
- `POST /v2/files/check`
- `POST /v2/files/upload`
- `POST /v2/resources/upload`
- `GET /v2/files/download/{id}`
- `GET /v2/resources/download/{id}`

**红包**:
- `POST /v2/redpackets/send`
- `POST /v2/redpackets/claim`

**聊天**:
- `POST /v2/chats/typing`

**按钮**:
- `POST /v2/buttons/callback`

**事件**:
- `GET /v2/updates/difference?pts=`

---

## 33. 与 nx3 文档差异对比

### 33.1 新增组件

| 组件 | 说明 |
|---|---|
| `DiscoverTileEditorActivity` | 发现页磁贴编辑器 |
| `AppearancePreviewActivity` | 外观预览 |
| `WelcomeGuideActivity` | 欢迎引导 |
| `ButtonFlowLayout` | 按钮流式布局控件 |
| `DiscoverTileLayout` | 发现页磁贴布局控件 |
| `BubbleTimeTextView` | 气泡时间文本控件 |
| `MomentImageView` | 动态图片视图控件 |
| `BiliWebViewMemoryGuard` | B站WebView内存保护 |
| `FileDownloadService` | 文件下载服务 |

### 33.2 传输层变化

| 特性 | nx3 (dev2) | 本次 APK |
|---|---|---|
| 传输层类 | `h0.c` + `h0.e` | 同上，结构一致 |
| v2 路由映射 | 部分映射 | **完整映射** (50+ 路由) |
| v2 网关 | 有 | 有 (`/v2/gateway`) |
| 频道相关 | `h0.a` | 同上 |

### 33.3 数据库变化

| 表 | nx3 | 本次 APK |
|---|---|---|
| `channel_states` | 推测 | **确认** (完整 schema) |
| `channel_posts` | 推测 | **确认** (含 reactions_json, reply_to_post_id 等) |

### 33.4 API 端点新增

| 端点 | 说明 |
|---|---|
| `/v2/channels/events/after` | 频道事件增量 |
| `/v2/channels/reactions/toggle` | 频道表情回应 |
| `/v2/channels/states` | 频道状态批量查询 |
| `/v2/updates/difference` | 事件差量同步 |
| `/v2/unread/direct` | 未读私聊 |
| `/v2/unread/groups` | 未读群聊 |
| `/v2/groups/messages/after` | 群消息增量 |
| `/v2/gateway` | 统一网关 |

### 33.5 字段确认

所有字段名均经反编译源码逐行验证，与 nx3 文档基本一致，主要补充：

- `ChannelDiscoveryActivity` 确认了 `visibility` 字段
- `ChannelComposeActivity` 确认了 `reply_to_post_id` 字段
- `i0/a.java` 确认了完整的数据库 schema
- `h0/e.java` 确认了完整的 v2 路由映射表

---

## 34. 附录: 复刻最小流程

### 34.1 新客户端启动

```
1. POST /auth/login → access_token / refresh_token
2. POST /auth/handshake {client_pub} → session_id / server_pub → encKey / macKey
3. GET /v1/ws?token=...&sid=... (WebSocket)
4. GET /download/sources (预热下载源)
5. GET /me → 用户信息
6. 全量: friends / groups / channels / resources
7. 断线重连: GET /v2/updates/difference?pts=本地PTS
```

### 34.2 发私聊消息 (v2 加密链路)

```
1. body = {"to_uid":"USR-XXX","body":"hi","msg_type":"text"}
2. 明文信封 = {"m":"POST","p":"/v2/direct/send","q":"","b":body}
3. AES-CBC 加密 → {"iv","data","mac"}
4. 计算 X-Sign
5. POST /v2/gateway
6. 响应 HTTP 200 {code, body:{id, created_at,...}}
```

### 34.3 上传并发送图片

```
1. 流式算 SHA-256
2. POST /media (multipart) → url / thumb_url / original_url
3. POST /v2/direct/send: msg_type=image, media_url, thumb_url, original_url
```

### 34.4 断线重连

```
1. WS onError/onClose
2. 若 400/401 → 清 session → 重新 handshake
3. 401 → refresh token → 重连
4. 重连成功 → GET /v2/updates/difference 补差
5. 指数退避 1s→60s
```

---

*本文档基于 `oldchat-dev.apk` (2026-08-14) jadx 反编译源码逐行分析，所有字段名均经源码验证。*

### 28.1 通知对象结构

**源码确认**: `h0/l.java` 第153-163行 (system_notification 事件处理)

通知通过 WS 事件 `system_notification` 推送:

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 通知ID |
| `title` | String | 通知标题 (默认 "系统通知") |
| `body` | String | 通知内容 |

通知未读计数存储在 `SharedPreferences("notification")` 中:
- `unread_count`: int (未读数)
- `last_notification_id`: String (最后通知ID)

### 28.2 AI 对话 SSE 格式

**端点**: `POST /ai/chat/completions` (OpenAI 兼容)

**请求体**:
```json
{
  "model": "deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true,
  "max_tokens": 1000
}
```

**流式响应** (SSE `text/event-stream`):
```
data: {"choices":[{"delta":{"content":"你"}}]}

data: {"choices":[{"delta":{"content":"好"}}]}

data: [DONE]
```

**非流式响应** (当 `stream=false`):
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "你好！" },
    "finish_reason": "stop"
  }]
}
```

---

## 35. 新闻模块

**源码确认**: `MinimalNewsActivity.java` + `o0/e.java`

### 35.1 架构

新闻模块使用**外部 RSS 源**，不走 OldChat 后端 API。

### 35.2 内置 RSS 源 (`o0/e.java` 第205-208行)

| ID | 名称 | URL |
|---|---|---|
| `solidot` | 科技 | `https://www.solidot.org/index.rss` |
| `sspai` | 少数派 | `https://sspai.com/feed` |
| `ruanyifeng` | 开发 | `https://www.ruanyifeng.com/blog/atom.xml` |
| `bbc_zh` | 国际 | `https://feeds.bbci.co.uk/zhongwen/simp/rss.xml` |

### 35.3 RSS 获取

- HTTP GET 直接获取 RSS XML
- User-Agent: `OldChat-RSS/1.0 Android`
- Accept: `application/rss+xml,application/atom+xml,application/xml,text/xml,*/*`
- 超时: 连接9s, 读取12s
- 自定义 RSS 源存储在 `SharedPreferences("minimal_news_rss")`

---

## 36. 发现页磁贴编辑

**源码确认**: `DiscoverTileEditorActivity.java` 第32行

### 36.1 磁贴定义

| 索引 | 名称 | 颜色 (hex) | 默认分组 |
|---|---|---|---|
| 0 | 朋友圈 | #0067B3 | 2 |
| 1 | 表情广场 | #FE7F03 | 1 |
| 2 | 资源广场 | #11D400 | 1 |
| 3 | 音乐广场 | #8847C8 | 1 |
| 4 | 极简简讯 | #0039A6 | 1 |
| 5 | 旧视界 | #5C6BC0 | 0 |
| 6 | 每日签到 | #FF8C00 | 1 |
| 7 | 举报进度 | #D15528 | 1 |
| 8 | 公开法庭 | #4A148C | 0 |
| 9 | 小程序 | #009688 | 1 |
| 10 | 发现设置 | #689F38 | 0 |

### 36.2 磁贴布局

使用 `DiscoverTileLayout` (自定义 ViewGroup)，支持拖拽排序和分组。编辑结果存储在 SharedPreferences 中。

---

## 37. 收藏夹

**源码确认**: `FavoritesActivity.java` 第70-84行

### 37.1 收藏列表

**端点**: `GET /favorites?limit=100`

**响应**:
```json
{
  "items": [
    {
      "id": "...",
      "type": "music",
      "target_id": "song_001",
      "title": "歌曲名",
      "subtitle": "歌手名",
      "media_url": "/v1/uploads/media/xxx.mp3",
      "extra": "{}",
      "created_at": 1720000000
    }
  ]
}
```

### 37.2 收藏对象字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 收藏ID |
| `type` | String | 收藏类型 (music 等) |
| `target_id` | String | 目标资源ID |
| `title` | String | 标题 |
| `subtitle` | String | 副标题 |
| `media_url` | String | 媒体URL |
| `extra` | String | 扩展JSON |
| `created_at` | long | 创建时间 |

### 37.3 收藏操作

| 端点 | 说明 |
|---|---|
| `POST /favorites/add` | 添加收藏 |
| `POST /favorites/remove` | 移除收藏 |

---

## 38. 二维码名片与扫码

### 38.1 名片二维码 (`QrCardActivity.java`)

**模式** (`qr_mode` Intent Extra):
- `"user"` — 用户名片 (默认)
- `"group"` — 群组名片

**内容**: 二维码编码为 **URL 格式**，包含用户/群组标识。

**Intent 参数**:
| 参数 | 类型 | 说明 |
|---|---|---|
| `qr_mode` | String | "user" 或 "group" |
| `qr_id` | String | 用户UID 或 群组ID |
| `qr_name` | String | 显示名 |

默认用户UID来源: `SharedPreferences("auth").getString("my_uid", "")`

### 38.2 扫码 (`QrScanActivity.java`)

扫码结果通过 `qr_result` Intent Extra 传递。扫码后根据内容类型跳转到对应功能（加好友/加群等）。

---

## 39. 外观预览

**源码确认**: `AppearancePreviewActivity.java`

`AppearancePreviewActivity` 继承自 `p.d` (主题基类)，用于预览应用外观/主题设置。功能简单，主要是展示和切换明暗主题预览。

---

## 40. 分页约定

### 40.1 复合游标分页 (created_at + id)

**适用**: 私聊/群聊历史消息

```
GET /v2/direct/messages/v2?with_uid=USR-XXX&limit=50
GET /v2/direct/messages/v2?with_uid=USR-XXX&limit=50&before_created_at=1720000000&before_id=msg-id
```

**方向**: 从新到旧 (DESC)
**游标**: `before_created_at` + `before_id` 必须同时传递
**响应**: `next_before_created_at` + `next_before_id`

### 40.2 序号增量分页 (after_seq)

**适用**: 群消息增量同步、频道帖子/事件增量

```
GET /v2/groups/messages/after?group_id=GRP-XXX&after_seq=1200&limit=100
GET /v2/channels/posts/after?channel_id=CHN-XXX&after_seq=100&limit=100
GET /v2/channels/events/after?channel_id=CHN-XXX&after_event_seq=100&limit=200
```

**方向**: 从旧到新 (ASC)
**游标**: `after_seq` / `after_event_seq`
**响应**: `next_group_seq` / `server_group_seq`

### 40.3 偏移量分页 (offset)

**适用**: 好友列表、群成员、通知、收藏等非消息类列表

```
GET /v2/groups/members?group_id=GRP-XXX&limit=50&offset=0
GET /notifications?limit=100
```

**方向**: 从头开始
**游标**: `offset` (已加载数量)
**响应**: `has_more`

### 40.4 PTS 差量分页

**适用**: 账号级事件同步

```
GET /v2/updates/difference?pts=0&limit=200
```

**方向**: 从旧到新
**游标**: `pts` (单调递增)
**响应**: `next_pts`, `current_pts`, `has_more`, `reset`

---

## 41. 限流与错误信封

### 41.1 限流规则

| 端点类别 | 限流维度 | 阈值 |
|---|---|---|
| 注册/登录/重置密码 | IP + 账号 | 令牌桶 |
| 发码 | 每邮箱 | 120s 冷却 |
| 上传/下载 | 全局并发信号量 + 每连接限速 | 环境变量控制 |
| 雨云同步 | 全局 | 5MB/s |

超限返回 HTTP 429:
```json
{ "error": "try again in 5 seconds", "code": "rate_limited" }
```

### 41.2 错误响应格式

统一格式:
```json
{
  "error": "human readable message",
  "code": "machine_readable_code"
}
```

### 41.3 关键错误响应样例

**bad_signature**:
```json
HTTP/1.1 401 Unauthorized
{ "error": "invalid signature", "code": "bad_signature" }
```

**invalid_session**:
```json
HTTP/1.1 400 Bad Request
{ "error": "session not found or expired", "code": "invalid_session" }
```

**missing_session**:
```json
HTTP/1.1 400 Bad Request
{ "error": "X-Session header required", "code": "missing_session" }
```

**sha256_mismatch**:
```json
HTTP/1.1 400 Bad Request
{ "error": "SHA-256 mismatch", "code": "sha256_mismatch" }
```

**gateway 错误**:
```json
HTTP/1.1 400 Bad Request
{ "error": "invalid gateway body", "code": "bad_gateway_body" }
```

---

## 42. v1/v2 端点版本总表

### 42.1 仅 v1 (不走 /v2/gateway)

| 端点 | 说明 |
|---|---|
| `POST /auth/login` | 登录 |
| `POST /auth/refresh` | 刷新令牌 |
| `POST /auth/handshake` | ECDH握手 |
| `POST /auth/logout` | 登出 |
| `POST /auth/register` | 注册 |
| `POST /auth/password/reset` | 重置密码 |
| `POST /auth/email/send` | 发送验证码 |
| `GET /auth/captcha` | 图形验证码 |
| `POST /media` | 媒体上传 |
| `POST /v1/channels/media/upload` | 频道媒体上传 |
| `GET /notifications` | 通知列表 |
| `POST /feedback` | 反馈 |
| `POST /admins/crash-reports` | 崩溃上报 |
| `GET /discover/lua/manifest` | Lua清单 |
| `GET /discover/lua/apps/{id}` | Lua应用 |
| `GET /music/plaza` | 音乐列表 |
| `GET /music/plaza/detail` | 音乐详情 |
| `GET /music/plaza/lyrics` | 歌词 |
| `GET /music/plaza/ranking` | 排行榜 |
| `GET /music/plaza/mine` | 我的音乐 |
| `POST /music/plaza/upload` | 上传音乐 |
| `POST /music/plaza/like` | 音乐点赞 |
| `POST /music/plaza/comment` | 音乐评论 |
| `GET /emoji/plaza` | 表情列表 |
| `POST /emoji/plaza/upload` | 上传表情 |
| `GET /resources/sections` | 资源分区 |
| `GET /resources/items` | 资源条目 |
| `POST /resources/upload` (v1) | 资源上传 |
| `GET /favorites` | 收藏列表 |
| `POST /favorites/add` | 添加收藏 |
| `POST /favorites/remove` | 移除收藏 |
| `GET /download/sources` | 下载源 |
| `GET /v1/ws` | WebSocket |
| `GET /v2/updates/difference` | 事件差量 |
| `GET /v2/unread/direct` | 未读私聊 |
| `GET /v2/unread/groups` | 未读群聊 |

### 42.2 支持 v2 路由映射 (可走 /v2/gateway)

所有通过 `h0/e.java` 第451行映射表的端点（约50个），详见 §32.2。

### 42.3 原生 v2 端点

| 端点 | 说明 |
|---|---|
| `POST /v2/files/check` | 文件秒传 |
| `POST /v2/files/upload` | 文件上传 |
| `POST /v2/resources/upload` | 资源上传 |
| `POST /v2/channels/subscribe` | 订阅频道 |
| `POST /v2/channels/unsubscribe` | 取消订阅 |
| `POST /v2/channels/notifications` | 频道通知 |
| `GET /v2/channels/discover` | 频道发现 |
| `GET /v2/channels/states` | 频道状态 |
| `GET /v2/channels/posts/after` | 频道帖子增量 |
| `GET /v2/channels/events/after` | 频道事件增量 |
| `POST /v2/channels/posts/send` | 频道发帖 |
| `POST /v2/channels/read` | 频道已读 |
| `POST /v2/channels/reactions/toggle` | 频道表情回应 |
| `POST /v2/buttons/callback` | 按钮回调 |
| `POST /v2/gateway` | 统一网关 |
| `GET /v2/groups/messages/after` | 群消息增量 |
| `GET /v2/groups/members/lookup` | 群成员搜索 |

---

## 43. 仍无法确定 / 需实测后端才能确认

以下内容无法仅从客户端反编译确认，需要实测后端：

1. **服务端会话过期时间**: 客户端只知道 `invalid_session` 错误，不知道服务端 session TTL
2. **限流精确阈值**: 知道有限流，但具体令牌桶大小/速率需实测
3. **频道帖子完整响应结构**: 客户端只解析了部分字段，服务端可能返回更多
4. **朋友圈 `comment_count` 是否缺失**: 客户端代码中未见从 feed 接口解析 `comment_count`，可能需要 N+1 请求
5. **v2 网关的 HTTP 状态码**: 客户端只看 `code` 字段，不看 HTTP 状态码，不确定服务端是否总是返回 200
6. **好友列表是否返回 `is_online` / `presence_status`**: 客户端解析了这些字段，但不确定服务端是否总是填充
7. **音乐详情响应完整结构**: 客户端解析了部分字段，服务端可能返回歌词URL等更多字段
8. **资源广场条目的 `url` 字段格式**: 是相对路径还是绝对URL，是否带 `?ref=` 参数
9. **频道 publisher token 认证流程**: 客户端代码中有相关端点但具体 token 获取方式不明
10. **OAuth 端点完整流程**: 客户端不直接使用 OAuth，但服务端有相关路由

---

*本文档基于 `oldchat-dev.apk` (2026-08-14) jadx 反编译源码逐行分析，所有字段名均经源码验证。*
*补全记录: 2026-08-14 根据 nx4-gap-fill-requests.md 工单补全 P0/P1/P2/P3 所有项目。*
*签名公式修正: 2026-08-14 确认 signingString = METHOD + PATH + TS + NONCE（非 token 开头），源码 h0/e.java 第368行 + q0/AbstractC0584w.z() 第366行。*
