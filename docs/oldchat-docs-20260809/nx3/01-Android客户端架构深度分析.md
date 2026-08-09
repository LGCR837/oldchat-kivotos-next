# 01 - Android 客户端架构深度分析 (v1.4.x)

> 基于 jadx 反编译分析 (183 Java源文件, 76 Activities, 12 自定义控件)  
> 更新时间: 2026年8月

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

---

## 2. Activities 完整列表 (76个, jadx 确认)

### 2.1 启动与认证模块

| Activity | 功能 | 特殊配置 | 版本 |
|---|---|---|---|
| **SplashActivity** | 启动页，检查登录状态 | LAUNCHER入口，SplashTheme | v1.3.61+ |
| **LoginActivity** | 登录界面（注册已外置到浏览器） | 支持自定义服务器地址 | — |
| ~~RegisterActivity~~ | ~~用户注册~~ | — | **v1.4.x移除** |
| **RecoverPasswordActivity** | 密码找回 | — | — |
| **ChangePasswordActivity** | 修改密码 | — | — |

#### LoginActivity 详细逻辑 (jadx 确认)
- **UI组件**: EditText(用户名/密码)、Button(登录/找回密码)、CheckBox(同意协议)
- **登录流程**:
  1. 检查用户是否勾选同意协议
  2. 构造JSON请求体 (identifier, password, device_id, imei, device_name, platform, app_version)
  3. POST `/auth/login`
  4. 解析响应: access_token, refresh_token, user.id, user.uid, user.ncuid
  5. 存储到 SharedPreferences("auth")
  6. 跳转 MainActivity
- **注册跳转** (v1.4.x): 点击注册按钮时通过浏览器跳转：
  ```java
  Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(base_url + "/register"));
  startActivity(intent);
  ```
- **自定义服务器**: 长按图标弹出对话框，输入 `http(s)://host[:port][/path]`
- **记住密码**: saved_username / saved_password 明文存储
- **封禁检测**: 403 响应码 + user_banned / device_banned 关键字

### 2.2 聊天模块

| Activity | 功能 | 特殊配置 |
|---|---|---|
| **ChatActivity** | 单人聊天 | windowSoftInputMode=adjustPan\|stateHidden |
| **GroupChatActivity** | 群聊 | windowSoftInputMode=adjustPan\|stateHidden |
| **ChatSettingsActivity** | 聊天设置 | 使用 `friend_ncuid` (v1.4.x) |
| **ChatSearchActivity** | 聊天搜索 | 使用 `&with_ncuid=` (v1.4.x) |
| **RedPacketSendActivity** | 发送红包 | 使用 `to_ncuid` (v1.4.x) |
| **RedPacketOpenActivity** | 打开红包 | — |
| **RedPacketDetailActivity** | 红包详情 | — |
| **ImagePreviewActivity** | 图片预览 | — |
| **BurnSecureViewActivity** | 阅后即焚安全查看 | — |
| **NotificationChatActivity** | 通知聊天 | — |

### 2.3 好友与群组模块

| Activity | 功能 | NCUID 使用 (v1.4.x) |
|---|---|---|
| **AddFriendActivity** | 添加好友 | — |
| **GroupCreateActivity** | 创建群组 | `member_ncuids` (JSONArray) |
| **GroupManageActivity** | 群组管理 | — |
| **GroupMembersActivity** | 群成员列表 | — |
| **GroupAnnouncementActivity** | 群公告 | — |
| **GroupInviteActivity** | 邀请入群 | `user_ncuid` |
| **GroupJoinRequestsActivity** | 入群申请 | — |

### 2.4 个人资料模块

| Activity | 功能 |
|---|---|
| **ProfileEditActivity** | 编辑个人资料 |
| **ProfileSpaceEditActivity** | 编辑个人空间 |
| **UserSpaceActivity** | 查看用户空间 (使用 `my_ncuid`, `ncuid`) |
| **QrCardActivity** | 二维码名片 |
| **QrScanActivity** | 扫描二维码 |

### 2.5 发现模块

| Activity | 功能 | 版本 |
|---|---|---|
| **MomentsActivity** | 朋友圈/动态 (使用 `my_ncuid`, `ncuid`) | — |
| **MomentComposeActivity** | 发布动态 | — |
| **MomentCommentsActivity** | 动态评论 (使用 `from_ncuid`) | — |
| **MomentNoticeActivity** | 动态通知 | — |
| **MomentGalleryActivity** | 动态图片画廊 | — |
| **EmojiPickerActivity** | 表情选择器 | — |
| **EmojiPlazaActivity** | 表情广场 | — |
| **EmojiPlazaSearchActivity** | 表情广场搜索 (搜索框+结果列表) | **v1.4.x新增** |
| **ResourceSectionsActivity** | 资源分区列表 | — |
| **ResourceSectionActivity** | 资源分区详情 | — |
| **ResourceCommentsActivity** | 资源评论 | — |
| **DailyCheckInWallActivity** | 每日签到墙 | — |
| **DailyCheckInWallCommentsActivity** | 签到墙评论 | — |

### 2.6 音乐模块

| Activity | 功能 | 版本 |
|---|---|---|
| **MusicPlazaActivity** | 音乐广场 | — |
| **MusicManageActivity** | 音乐管理 | — |
| **MusicDownloadsActivity** | 音乐下载 | — |
| **MusicPlayerActivity** | 音乐播放器 | — |
| **MusicCommentsActivity** | 音乐评论 | — |
| **MusicCategoryActivity** | 音乐分类浏览，支持分页加载 | **v1.4.x新增** |
| **MusicSearchActivity** | 音乐搜索 (搜索框+结果列表+下载管理) | **v1.4.x新增** |
| **PlaylistDetailActivity** | 播放列表详情 (列表名/歌曲数/时长，支持编辑/删除/添加) | **v1.4.x新增** |

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

### 2.8 CIP/小程序模块

| Activity | 功能 | 特殊配置 |
|---|---|---|
| **LuaMiniAppActivity** | Lua小程序运行容器 | — |
| **MiniAppsActivity** | 小程序列表 | — |
| **CipDevelopmentModeActivity** | CIP开发模式入口 | adjustPan |
| **CipVibeCodingActivity** | CIP Vibe编程 | configChanges=orientation\|screenSize\|keyboardHidden |
| **CipDeveloperActivity** | CIP开发者工具 | adjustUnspecified |

### 2.9 新闻模块

| Activity | 功能 |
|---|---|
| **MinimalNewsActivity** | 极简新闻列表 |
| **MinimalNewsDetailActivity** | 新闻详情 |

### 2.10 设置模块

| Activity | 功能 | NCUID 使用 (v1.4.x) |
|---|---|---|
| **SettingsActivity** | 主设置页 | `ncuid` 跳转 |
| **NotificationSettingsActivity** | 通知设置 | — |
| **DiscoverSettingsActivity** | 发现页设置 | — |
| **DataSettingsActivity** | 数据设置 | — |
| **SupportSettingsActivity** | 帮助与支持 | — |
| **CacheSettingsActivity** | 缓存管理 | — |
| **UiSettingsActivity** | 界面设置 | — |
| **AccountManagementActivity** | 账号管理 | — |
| **DeviceManagementActivity** | 设备管理 | — |
| **FeedbackActivity** | 用户反馈 | — |
| **PrivacyPolicyActivity** | 隐私政策 | — |
| **ReportProgressActivity** | 举报进度 | — |
| **PublicCourtActivity** | 公开法庭 | — |
| **PublicCourtCaseDetailActivity** | 法庭案件详情 | — |
| **FavoritesActivity** | 收藏 | — |
| **CrashActivity** | 崩溃报告 (独立进程 :crash, 不导出, CrashDialogTheme) | — |

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
| 返回值 | START_STICKY (值=1) |

### 3.2 ResourceUploadService — 资源上传服务

| 属性 | 值 |
|---|---|
| 类名 | com.im.oldchat.service.ResourceUploadService |
| exported | false |
| 前台服务 | 是 (通知ID: 73) |
| 通知渠道 | oldchat_upload ("资源上传", IMPORTANCE_LOW) |
| Action | com.im.oldchat.action.RESOURCE_UPLOAD_START |

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

### 3.4 CipVibeBackgroundService — CIP后台服务

| 属性 | 值 |
|---|---|
| 类名 | com.im.oldchat.lua.CipVibeBackgroundService |
| exported | false |

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

---

## 5. 自定义控件 (jadx 确认, 12个)

### 5.1 原有控件 (v1.3.61)

| 控件 | 路径 | 功能 |
|---|---|---|
| **TopStatusBar** | com.im.oldchat.ui.TopStatusBar | 顶部状态栏，支持加载动画和重试回调 |
| **NoAnimViewPager** | com.im.oldchat.ui.NoAnimViewPager | 禁用页面切换动画的ViewPager |
| **ZoomImageView** | com.im.oldchat.ui.ZoomImageView | 支持双指缩放的图片视图 |
| **ActionPanelAnimatedLayout** | com.im.oldchat.ui.widget | 带动画的操作面板布局 |
| **FontAwesomeTextView** | com.im.oldchat.ui.widget | 支持FontAwesome图标的TextView |
| **RoundedImageView** | com.im.oldchat.ui.widget | 圆角图片控件 |
| **TiltFrameLayout** | com.im.oldchat.ui.widget | 可倾斜的FrameLayout |

### 5.2 新增控件 (v1.4.x, jadx 确认)

| 控件 | 功能 | 内部类 |
|---|---|---|
| **CircleImageView** | 圆形图片裁剪显示，用于头像/封面 | — |
| **CoverFlowView** | 封面流3D翻转效果，音乐封面浏览 | 内部类 $a-$i (9个) |
| **CoverAmbientMotionView** | 封面氛围动效，背景色彩随封面变化 | — |
| **LyricCascadeView** | 歌词级联滚动显示，支持高亮当前行 | 内部类 $a-$n (14个) |
| **OldViewPlayerView** | B站视频播放器视图，专业播放体验 | — |

---

## 6. 混淆后的关键基类

| 混淆名 | 推测功能 | 子类 |
|---|---|---|
| `f0.a` | 基础Activity (带工具方法) | LoginActivity, MainActivity等 |
| `AbstractActivityC0197b` | NCUID传递基类Activity (v1.4.x新增) | 传递 `to_ncuid`, `friend_ncuid` |
| `AbstractActivityC0210a` | 聊天基类Activity | ChatActivity |
| `AbstractActivityC0211b` | 带菜单的Activity基类 | — |
| `AbstractActivityC0231w` | 设置类Activity基类 | — |
| `AbstractActivityC0232x` | 带列表的Activity基类 | — |
| `AbstractActivityC0233y` | 带WebView的Activity基类 | — |

---

## 7. NCUID 在各Activity中的使用 (jadx 源码确认) ⭐

### 7.1 旧版 (v1.3.61) 中的 NCUID 使用 (14处)

| Activity | 代码位置 | NCUID 操作 |
|---|---|---|
| LoginActivity | `optString("ncuid")`, `putString("my_ncuid")` | 登录后存储当前用户NCUID |
| MomentsActivity | `getString("my_ncuid")`, `putExtra("ncuid")` | 朋友圈使用NCUID标识用户 |
| UserSpaceActivity | `getString("my_ncuid")`, `getExtra("ncuid")` | 用户空间查询使用NCUID |
| ChatActivity | `optString("from_ncuid")` | 消息解析使用发送者NCUID |
| GroupChatActivity | `optString("from_ncuid")` | 群消息解析使用发送者NCUID |
| FriendListActivity | `optString("ncuid")` | 好友列表使用NCUID |
| SettingsActivity | `putExtra("ncuid")` | 跳转传递NCUID |

### 7.2 新版 (v1.4.x) 中的 NCUID 使用 (30+处, 大幅增加)

**保留不变的 (7处):**

| Activity | 代码位置 | 说明 |
|---|---|---|
| LoginActivity | `optString("ncuid")`, `putString("my_ncuid")` | 不变 |
| MomentsActivity | `getString("my_ncuid")`, `putExtra("ncuid")` | 不变 |
| UserSpaceActivity | `getString("my_ncuid")`, `getExtra("ncuid")` | 不变 |
| ChatActivity | `optString("from_ncuid")` | 不变 |
| GroupChatActivity | `optString("from_ncuid")` | 不变 |

**新增的 (16+处):**

| Activity/类 | 代码位置 | NCUID 操作 | 场景 |
|---|---|---|---|
| AbstractActivityC0197b | `putExtra("to_ncuid")`, `putExtra("friend_ncuid")` | 基类传递NCUID | Activity间跳转 |
| ChatSearchActivity | `&with_ncuid=`, `getExtra("friend_ncuid")` | 消息搜索用NCUID | 搜索 |
| ChatSettingsActivity | `putExtra("friend_ncuid")`, `put("friend_ncuid")` | 好友设置用NCUID | 设置 |
| GroupCreateActivity | `put("member_ncuids", jsonArray)` | 创建群组用NCUID数组 | 群组 |
| GroupInviteActivity | `put("user_ncuid")` | 邀请用NCUID | 群组 |
| RedPacketSendActivity | `getExtra("to_ncuid")`, `put("to_ncuid")` | 红包用NCUID | 红包 |
| MomentCommentsActivity | `optString("from_ncuid")` | 评论用NCUID | 动态 |
| FriendListActivity | `put("user_ncuid")` | 好友操作用NCUID | 好友 |
| ChatListActivity | `putExtra("friend_ncuid")`, `put("to_ncuid")` | 聊天列表用NCUID | 聊天 |
| RecentChats | `putExtra("friend_ncuid")`, `put("to_ncuid")` | 最近聊天用NCUID | 聊天 |
| MessageSendHelper | `put("to_ncuid")` | 发送消息用NCUID | 消息 |

### 7.3 NCUID 迁移策略

```
读取优先级: ncuid > uid (优先使用NCUID，回退到UID)
写入策略:  同时携带 uid + ncuid (确保新旧后端兼容)
存储策略:  新增 direct_ncuid_ 前缀，NCUID独立存储
```

---

## 8. 统计 (jadx 确认)

| 统计项 | v1.3.61 | v1.4.x | 变化 |
|---|---|---|---|
| Activities 总数 | 73 | 76 | **+3** |
| Services 总数 | 4 | 4 | 不变 |
| Providers | 1 | 1 | 不变 |
| Receivers | 0 | 0 | 不变 |
| 自定义控件 | 7 | 12 | **+5** |
| 混淆基类 | 16+ | 16+ | 不变 |
| NCUID使用位置 | 14处 | 30+处 | **+16处** |
| Java源文件 | 161 | 183 | **+22** |
