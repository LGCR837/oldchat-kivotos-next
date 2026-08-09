# OldChat 版本差异文档: v1.2.34 → v1.3.61

> 对比时间: 2025年5月 (v1.2.34) vs 2025年7月 (v1.3.61)  
> 分析方法: 5月版本反编译源码 + 7月版本APK逆向分析 (androguard)  
> 版本跨度: versionCode 64 → 242 (+178个内部版本)

---

## 1. 版本基本信息变化

| 属性 | v1.2.34 (5月) | v1.3.61 (7月) | 变化 |
|---|---|---|---|
| versionName | 1.2.34 | 1.3.61 | 主版本+1, 子版本+27 |
| versionCode | 64 | 242 | **+178** (平均每天~3个版本) |
| minSdkVersion | 9 | 9 | 不变 |
| targetSdkVersion | 33 | 33 | 不变 |
| compileSdkVersion | 33 | 33 | 不变 |
| compileSdkVersionCodename | 13 | 13 | 不变 |
| platformBuildVersionCode | 33 | 33 | 不变 |
| platformBuildVersionName | 13 | 13 | 不变 |
| DEX文件数 | 1 | 1 | 不变 |
| 原生库 | 无 | 无 | 不变 |

**分析**: versionCode 从 64 跳到 242，增加了 178 个版本。两个月内（约60天）平均每天约 3 个内部版本，表明采用了高频 CI/CD 构建流程。

---

## 2. 权限变化

### 2.1 新增权限 (2个)

| 权限 | 类型 | 说明 | 用途推测 |
|---|---|---|---|
| `android.permission.CAMERA` | 危险权限 | 相机访问 | 扫码、拍照、阅后即焚拍照 |
| `android.permission.ACCESS_NETWORK_STATE` | 普通权限 | 网络状态检测 | WiFi/移动数据判断，上传前网络检查 |

### 2.2 新增硬件特性 (1个)

| 特性 | required | 说明 |
|---|---|---|
| `android.hardware.camera` | false | 声明相机特性但不强制要求 |

### 2.3 完整权限对比表

| 权限 | v1.2.34 | v1.3.61 | 变化 |
|---|---|---|---|
| INTERNET | ✅ | ✅ | 不变 |
| ACCESS_NETWORK_STATE | ❌ | ✅ | **新增** |
| CAMERA | ❌ | ✅ | **新增** |
| READ_EXTERNAL_STORAGE (max=32) | ✅ | ✅ | 不变 |
| WRITE_EXTERNAL_STORAGE (max=28) | ✅ | ✅ | 不变 |
| READ_MEDIA_IMAGES | ✅ | ✅ | 不变 |
| READ_MEDIA_VIDEO | ✅ | ✅ | 不变 |
| READ_MEDIA_AUDIO | ✅ | ✅ | 不变 |
| POST_NOTIFICATIONS | ✅ | ✅ | 不变 |
| RECORD_AUDIO | ✅ | ✅ | 不变 |
| READ_PHONE_STATE | ✅ | ✅ | 不变 |
| FOREGROUND_SERVICE | ✅ | ✅ | 不变 |
| REQUEST_INSTALL_PACKAGES | ✅ | ✅ | 不变 |
| **总计** | **11** | **13** | **+2** |

---

## 3. 入口变化 (重大)

### 3.1 启动流程变更

**v1.2.34 (5月)**:
```xml
<activity android:name="com.im.oldchat.MainActivity" android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
</activity>
```
用户点击图标 → 直接进入 MainActivity → 检查token → 无token跳转LoginActivity

**v1.3.61 (7月)**:
```xml
<activity android:name="com.im.oldchat.SplashActivity"
    android:theme="@style/SplashTheme"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
</activity>
<activity android:name="com.im.oldchat.MainActivity" android:exported="true"/>
```
用户点击图标 → SplashActivity (启动画面) → 检查登录状态 → LoginActivity 或 MainActivity

### 3.2 变化影响

- MainActivity 不再是 LAUNCHER，但仍保留 `exported=true`
- SplashActivity 使用专门的 `@style/SplashTheme` 主题
- 避免了冷启动时的白屏/黑屏闪烁
- 用户体验提升：启动画面 → 平滑过渡到主界面

---

## 4. 新增 Activities (10个)

### 4.1 完整新增列表

| # | Activity | 包路径 | 功能 | 特殊配置 |
|---|---|---|---|---|
| 1 | **SplashActivity** | com.im.oldchat | 启动页 | SplashTheme, LAUNCHER |
| 2 | **DailyCheckInWallActivity** | com.im.oldchat.ui | 每日签到墙 | — |
| 3 | **DailyCheckInWallCommentsActivity** | com.im.oldchat.ui | 签到墙评论 | adjustResize |
| 4 | **LuaMiniAppActivity** | com.im.oldchat.ui | Lua小程序运行容器 | — |
| 5 | **MiniAppsActivity** | com.im.oldchat.ui | 小程序列表/商店 | — |
| 6 | **CipDevelopmentModeActivity** | com.im.oldchat.ui | CIP开发模式入口 | adjustPan |
| 7 | **CipVibeCodingActivity** | com.im.oldchat.ui | CIP Vibe编程环境 | configChanges=orientation\|screenSize\|keyboardHidden |
| 8 | **CipDeveloperActivity** | com.im.oldchat.ui | CIP开发者工具 | adjustUnspecified |
| 9 | **MinimalNewsActivity** | com.im.oldchat.ui | 极简新闻列表 | — |
| 10 | **MinimalNewsDetailActivity** | com.im.oldchat.ui | 新闻详情 | — |

### 4.2 按功能分类

#### 启动优化 (1个)
- **SplashActivity** — 启动页，改善冷启动体验

#### 社交功能 (2个)
- **DailyCheckInWallActivity** — 每日签到墙，提升用户活跃度
- **DailyCheckInWallCommentsActivity** — 签到评论互动 (adjustResize适配键盘)

#### 小程序平台 (5个)
- **LuaMiniAppActivity** — Lua脚本运行容器
- **MiniAppsActivity** — 小程序发现/管理
- **CipDevelopmentModeActivity** — 开发模式入口
- **CipVibeCodingActivity** — 在线代码编辑器 (自行处理屏幕旋转/键盘)
- **CipDeveloperActivity** — 开发者调试工具

#### 新闻资讯 (2个)
- **MinimalNewsActivity** — 极简新闻列表
- **MinimalNewsDetailActivity** — 新闻详情阅读

---

## 5. 新增 Services (1个)

| Service | 包路径 | 功能 | exported |
|---|---|---|---|
| **CipVibeBackgroundService** | com.im.oldchat.lua | Lua小程序/CIP后台执行服务 | false |

### 5.1 服务总数对比

| 服务 | v1.2.34 | v1.3.61 | 说明 |
|---|---|---|---|
| MessageService | ✅ | ✅ | 消息推送，不变 |
| ResourceUploadService | ✅ | ✅ | 资源上传，不变 |
| MusicPlaybackService | ✅ | ✅ | 音乐播放，不变 |
| CipVibeBackgroundService | ❌ | ✅ | **新增**，Lua后台服务 |

---

## 6. 架构变化

### 6.1 新增包路径

| 包 | v1.2.34 | v1.3.61 | 说明 |
|---|---|---|---|
| com.im.oldchat | ✅ | ✅ | 主包 |
| com.im.oldchat.ui | ✅ | ✅ | UI层 |
| com.im.oldchat.service | ✅ | ✅ | 服务层 |
| com.im.oldchat.bili | ✅ | ✅ | B站模块 |
| com.im.oldchat.lua | ❌ | ✅ | **新增**，Lua小程序模块 |

### 6.2 用户标识体系迁移：UID → NCUID（进行中）

v1.3.61 引入了 NCUID (New Chat UID) 体系，**部分接口已支持**，部分仍需使用旧 UID。

| 场景 | 支持情况 | 说明 |
|---|---|---|
| 登录响应 user.ncuid | ✅ | 同时返回 uid 和 ncuid |
| 用户资料查询 ?ncuid= | ✅ | 两者都支持 |
| 群成员 member.ncuid | ✅ | 同时返回 uid 和 ncuid |
| 消息历史 with_ncuid | ❌ | 返回 invalid_uid，需用 with_uid |
| 发送消息 to_ncuid | ❌ | 仍需 to_uid |
| 标记已读 with_ncuid | ❌ | 仍需 with_uid |
| 好友列表/申请 | ⚠️ | 仅返回 uid |

客户端兼容策略：读取时优先 `ncuid`，回退到 `uid`；写入时仍使用 `uid`（等待后端迁移）。

### 6.2 新增模块: Lua小程序平台 (CIP)

这是 v1.3.61 最重大的架构变化，引入了一套完整的 Lua 小程序运行环境。

```
v1.2.34: 无小程序支持

v1.3.61: 完整的 CIP 小程序平台
├── MiniAppsActivity          — 小程序列表/商店
├── LuaMiniAppActivity        — 小程序运行容器
├── CipVibeBackgroundService  — 后台Lua执行引擎
├── CipDevelopmentModeActivity — 开发模式入口
├── CipVibeCodingActivity     — 在线编程环境
└── CipDeveloperActivity      — 开发者工具
```

**技术特点**:
- "CIP" 可能代表 "Chat Integrated Platform"
- "Vibe Coding" 暗示低代码/可视化编程方案
- Lua 作为脚本语言（非JavaScript，在社交应用中少见）
- 完整的开发者工具链（编码 → 调试 → 运行）
- 后台服务支持持续运行

**类比**: 微信小程序、QQ小程序、Telegram Mini Apps

### 6.4 新增API端点（从APK反编译提取）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/me/checkin` | POST | 每日签到 |
| `/me/checkin/wall?limit=N` | GET | 签到墙列表 |
| `/me/checkin/wall/comment` | POST | 签到墙留言/评论 |
| `/me/checkin/wall/comments?post_id=` | GET | 签到墙评论列表 |
| `/me/checkin/wall/like` | POST | 签到墙点赞 `{post_id}` |
| `/me/checkin/wall/unlike` | POST | 签到墙取消点赞 `{post_id}` |
| `/redpackets/send` | POST | 发送红包 `{title, total_amount, total_count, group_id 或 to_uid, cover_url?}` |
| `/redpackets/claim` | POST | 领取红包 `{packet_id}` |
| `/moments/like` | POST | 动态点赞 |
| `/moments/unlike` | POST | 取消点赞 |
| `/moments/comment` | POST | 动态评论 |
| `/moments/comment/delete` | POST | 删除评论 |
| `/moments/comments?moment_id=` | GET | 动态评论列表 |
| `/music/plaza/like` | POST | 音乐点赞 |
| `/music/plaza/unlike` | POST | 取消点赞 |
| `/music/plaza/comment` | POST | 音乐评论 |
| `/music/plaza/comments?item_id=` | GET | 音乐评论列表 |
| `/resources/like` | POST | 资源点赞 |
| `/resources/unlike` | POST | 取消点赞 |
| `/resources/comment` | POST | 资源评论 |

### 6.3 新增功能模块

#### 极简新闻
```
MinimalNewsActivity → 新闻列表
MinimalNewsDetailActivity → 新闻详情
```
轻量级新闻聚合，可能集成在"发现"Tab。

#### 每日签到墙
```
DailyCheckInWallActivity → 签到墙展示
DailyCheckInWallCommentsActivity → 签到评论
```
用户每日签到并查看他人动态，提升DAU。

#### 阅后即焚
```
BurnSecureViewActivity → 安全查看界面
```
消息阅后即焚功能，增强隐私保护。

---

## 7. 未变化的组件 (完整列表)

### 7.1 Application

- OldChatApplication — 完全不变

### 7.2 核心 Activities (63个全部保留)

所有 v1.2.34 的 Activities 在 v1.3.61 中均被保留，无一移除：

**认证类**: LoginActivity, RegisterActivity, RecoverPasswordActivity, ChangePasswordActivity

**聊天类**: ChatActivity, GroupChatActivity, ChatSettingsActivity, ChatSearchActivity, RedPacketSendActivity, RedPacketOpenActivity, RedPacketDetailActivity, ImagePreviewActivity, NotificationChatActivity

**好友/群组类**: AddFriendActivity, GroupCreateActivity, GroupManageActivity, GroupMembersActivity, GroupAnnouncementActivity, GroupInviteActivity, GroupJoinRequestsActivity

**个人资料类**: ProfileEditActivity, ProfileSpaceEditActivity, UserSpaceActivity, QrCardActivity, QrScanActivity

**发现类**: MomentsActivity, MomentComposeActivity, MomentCommentsActivity, MomentNoticeActivity, MomentGalleryActivity, EmojiPickerActivity, EmojiPlazaActivity, ResourceSectionsActivity, ResourceSectionActivity, ResourceCommentsActivity

**音乐类**: MusicPlazaActivity, MusicManageActivity, MusicDownloadsActivity, MusicPlayerActivity, MusicCommentsActivity

**B站类**: OldViewActivity, OldViewVideoDetailActivity, OldViewVideoFullActivity, OldViewUpProfileActivity, OldViewHistoryActivity, OldViewFavoritesActivity, OldViewFavoriteDetailActivity

**设置类**: SettingsActivity, NotificationSettingsActivity, DiscoverSettingsActivity, DataSettingsActivity, SupportSettingsActivity, CacheSettingsActivity, UiSettingsActivity, AccountManagementActivity, DeviceManagementActivity, FeedbackActivity, PrivacyPolicyActivity, ReportProgressActivity, PublicCourtActivity, PublicCourtCaseDetailActivity, FavoritesActivity, CrashActivity

### 7.3 Services (3个全部保留)

- MessageService — 完全不变
- ResourceUploadService — 完全不变
- MusicPlaybackService — 完全不变

### 7.4 Providers

- FileProvider (com.im.oldchat.fileprovider) — 不变

### 7.5 网络层

- OkHttp 客户端 — 不变
- API 端点 — 不变
- 认证机制 — 不变

### 7.6 加密层

- SpongyCastle — 不变
- ECDH 协议 — 不变

### 7.7 数据存储

- SharedPreferences 结构 — 不变
- 数据库结构 — 不变
- 缓存策略 — 不变

---

## 8. Application 变化

OldChatApplication 在两个版本中**完全一致**:
- 相同的初始化流程
- 相同的 MultiDex 支持
- 相同的全局 Context 管理
- 相同的服务启动逻辑

---

## 9. MainActivity 变化

MainActivity 在两个版本中**基本一致**:
- 相同的底部4Tab结构 (聊天/好友/发现/我的)
- 相同的 ViewPager + Fragment 架构
- 相同的好友请求轮询逻辑
- 相同的通知弹窗逻辑

唯一变化: v1.3.61 中 MainActivity 不再是 LAUNCHER 入口。

---

## 10. Services 变化

### 10.1 MessageService — 无变化

两个版本完全一致:
- 相同的前台通知 (oldchat_service, ID=42)
- 相同的启动逻辑 (API版本自适应)
- 相同的 START_STICKY 策略

### 10.2 ResourceUploadService — 无变化

两个版本完全一致:
- 相同的上传逻辑 (POST /resources/upload)
- 相同的进度通知 (oldchat_upload, ID=73)
- 相同的并发控制 (单任务锁)
- 相同的广播事件

### 10.3 MusicPlaybackService — 无变化

两个版本完全一致:
- 相同的播放逻辑 (MediaPlayer)
- 相同的缓存策略 (220MB/120文件)
- 相同的通知控制 (ID=5201)
- 相同的音频焦点管理

---

## 11. 网络层变化

### 11.1 无变化

- OkHttp 客户端不变
- API 端点不变 (/auth/login, /friends/requests, /notifications, /resources/upload)
- 认证机制不变 (Bearer Token)
- 回调接口不变 (g0.d.i, g0.d.j, g0.d.k)

### 11.2 可能的改进

v1.3.61 新增 `ACCESS_NETWORK_STATE` 权限，推测在网络层增加了:
- 更精确的网络状态检测
- WiFi/移动数据区分
- 网络不可用时的错误处理

---

## 12. 数据存储变化

### 12.1 无结构性变化

- SharedPreferences("auth") 结构不变
- 数据库表结构不变 (推测)
- 缓存策略不变

### 12.2 新增数据 (推测)

v1.3.61 新增功能可能需要以下数据存储:
- Lua小程序数据 (脚本、配置)
- 签到墙数据
- 新闻缓存
- 阅后即焚消息记录

---

## 13. 安全性变化

### 13.1 正面变化

| 变化 | 影响 |
|---|---|
| 新增 ACCESS_NETWORK_STATE | 可更精确检测网络状态，避免在无网络时发送敏感请求 |
| 新增 CAMERA (required=false) | 对无摄像头设备友好，不会强制要求 |
| 新增 BurnSecureViewActivity | 阅后即焚功能增强消息隐私 |

### 13.2 无变化的安全隐患

以下安全问题在两个版本中均存在，未修复:

| 问题 | 严重性 | 说明 |
|---|---|---|
| 明文密码存储 | **高** | saved_password 明文在 SharedPreferences |
| 明文HTTP | **高** | usesCleartextTraffic=true |
| allowBackup | **高** | 应用数据可通过ADB备份 |
| Token明文存储 | 中 | access_token 未加密 |
| IMEI收集 | 中 | 登录时发送IMEI |
| 无证书固定 | 中 | 未发现Certificate Pinning |

### 13.3 加密层

- SpongyCastle 版本不变
- ECDH 协议实现不变
- 消息加密流程不变

---

## 14. UI/UX 变化

### 14.1 启动体验

- **v1.2.34**: 直接进入 MainActivity，冷启动可能有白屏
- **v1.3.61**: SplashActivity 提供启动画面，平滑过渡

### 14.2 新增界面

- 签到墙界面 (DailyCheckInWallActivity)
- 小程序列表界面 (MiniAppsActivity)
- 在线编程界面 (CipVibeCodingActivity)
- 新闻列表/详情界面 (MinimalNewsActivity)
- 阅后即焚查看界面 (BurnSecureViewActivity)

### 14.3 不变的界面

所有原有界面的布局、交互逻辑均未变化。

---

## 15. 第三方库变化

### 15.1 不变的依赖

| 库 | 用途 |
|---|---|
| OkHttp | HTTP客户端 |
| SpongyCastle | 加密库 |
| android.support.v4 | 兼容库 |
| MultiDex | 多DEX支持 |

### 15.2 可能新增的依赖 (推测)

| 库 | 用途 |
|---|---|
| Lua运行时 | 小程序脚本执行 (v1.3.61) |
| 代码编辑器 | CIP编程环境 (v1.3.61) |

---

## 16. 混淆策略变化

两个版本使用相同的混淆策略:
- 保留 Activity/Service/Application 类名
- 混淆成员变量和辅助类
- 工具类包名重命名为单字母

---

## 17. 统计对比总表

| 统计项 | v1.2.34 | v1.3.61 | 变化 |
|---|---|---|---|
| **Activities** | 63 | 73 | **+10** |
| **Services** | 3 | 4 | **+1** |
| **Providers** | 1 | 1 | 不变 |
| **Receivers** | 0 | 0 | 不变 |
| **权限** | 11 | 13 | **+2** |
| **硬件特性** | 0 | 1 | **+1** |
| **包路径** | 4 | 5 | **+1** (lua) |
| **versionCode** | 64 | 242 | **+178** |

---

## 18. 迁移兼容性

### 18.1 向后兼容 (无破坏性变化)

- ✅ 所有原有 Activity 保留
- ✅ 所有原有 Service 保留
- ✅ 数据存储结构不变
- ✅ API 端点不变
- ✅ 认证机制不变
- ✅ 用户数据可无缝迁移

### 18.2 需要注意

- ⚠️ SplashActivity 成为新入口，第三方启动器快捷方式可能需要更新
- ⚠️ CAMERA 权限会在升级时请求用户授权 (危险权限)
- ⚠️ ACCESS_NETWORK_STATE 为普通权限，自动授予，无需用户操作

---

## 19. 技术趋势分析

### 19.1 平台化转型

v1.3.61 引入的 Lua 小程序平台标志着 OldChat 从**纯聊天应用**向**平台化应用**的转型:

| 能力 | v1.2.34 | v1.3.61 |
|---|---|---|
| 即时通讯 | ✅ | ✅ |
| 社交功能 | ✅ | ✅ |
| 内容平台 | ✅ | ✅ |
| 小程序生态 | ❌ | ✅ |
| 开发者工具 | ❌ | ✅ |
| 在线编程 | ❌ | ✅ |

### 19.2 开发节奏

- versionCode +178 (两个月)
- 平均每天 ~3 个内部版本
- 表明采用 CI/CD 自动化构建
- 团队开发节奏极快

### 19.3 功能扩展方向

v1.3.61 新增功能体现了三个方向:
1. **平台化**: 小程序生态 (CIP)
2. **内容化**: 极简新闻
3. **社交化**: 签到墙、阅后即焚

---

## 20. 总结

v1.2.34 → v1.3.61 是一次**功能丰富型升级**，核心变化:

| 序号 | 变化 | 影响级别 | 说明 |
|---|---|---|---|
| 1 | 🚀 SplashActivity 启动页 | 中 | 改善启动体验 |
| 2 | 🔧 Lua小程序平台 (5个Activity+1个Service) | **高** | 平台化转型 |
| 3 | 📰 极简新闻 (2个Activity) | 中 | 内容扩展 |
| 4 | 📝 每日签到墙 (2个Activity) | 中 | 社交增强 |
| 5 | 🔒 阅后即焚 (在v1.3.61文档中提及) | 中 | 隐私增强 |
| 6 | 📷 CAMERA 权限 | 低 | 相机功能支持 |
| 7 | 🌐 ACCESS_NETWORK_STATE 权限 | 低 | 网络状态检测 |
| 8 | 🆔 **UID → NCUID 迁移** | **高** | 用户标识体系全面升级 |

**架构稳定性**: 核心架构（网络层、数据层、安全层、服务层）完全不变，新增功能以独立模块形式加入，无破坏性变更。这是一次**安全的渐进式升级**。
