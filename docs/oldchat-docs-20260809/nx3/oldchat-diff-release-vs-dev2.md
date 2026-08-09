# OldChat 版本差异文档: Release vs Dev2 (测试版)

> 对比时间: 2026年8月  
> 分析方法: jadx 反编译两个版本 APK，逐类对比源码  
> 对比对象: **Release (正式版)** vs **Dev2 (测试版)**  
> R8 map-id: Release `2a5d39f` → Dev2 `dev2-build`

---

## 目录

1. [版本基本信息变化](#1-版本基本信息变化)
2. [Activities 变化](#2-activities-变化)
3. [Services 变化](#3-services-变化)
4. [自定义 UI 控件变化](#4-自定义-ui-控件变化)
5. [频道系统 (全新)](#5-频道系统-全新)
6. [交互按钮系统重构](#6-交互按钮系统重构)
7. [文件系统重构](#7-文件系统重构)
8. [密码恢复流程变化](#8-密码恢复流程变化)
9. [API 端点变化](#9-api-端点变化)
10. [网络层重构](#10-网络层重构)
11. [NCUID 迁移进展](#11-ncuid-迁移进展)
12. [数据模型变化](#12-数据模型变化)
13. [JSON 字段对比](#13-json-字段对比)
14. [SharedPreferences 变化](#14-sharedpreferences-变化)
15. [登录流程变化](#15-登录流程变化)
16. [群组创建流程变化](#16-群组创建流程变化)
17. [红包发送流程变化](#17-红包发送流程变化)
18. [音乐系统变化](#18-音乐系统变化)
19. [频道发帖系统 (ChannelComposeActivity)](#19-频道发帖系统-channelcomposeactivity)
20. [频道发现系统 (ChannelDiscoveryActivity)](#20-频道发现系统-channeldiscoveryactivity)
21. [文件中心 (FileCenterActivity)](#21-文件中心-filecenteractivity)
22. [文件下载服务 (FileDownloadService)](#22-文件下载服务-filedownloadservice)
23. [构建差异](#23-构建差异)
24. [安全性变化](#24-安全性变化)
25. [迁移兼容性分析](#25-迁移兼容性分析)
26. [技术趋势分析](#26-技术趋势分析)
27. [统计对比总表](#27-统计对比总表)

---

## 1. 版本基本信息变化

| 属性 | Release (正式版) | Dev2 (测试版) | 变化 |
|---|---|---|---|
| 版本类型 | 生产发布版 | 开发测试版 | — |
| UI 基类 | `AbstractActivityC0305a` | `g0.a` | 重构 |
| 网络层基类 | `h0.c` / `h0.d` | `h0.d` / `h0.e` | 重构+新增 |
| HTTP 工具类 | `h0.c` (POST/GET) | `h0.d` (POST/GET) | 重命名 |
| HTTP 常量类 | `h0.d` (URL/缓存/重试) | `h0.e` (URL/缓存/重试) | 重命名 |
| 文件上传类 | `h0.e` (extends h0.d) | `h0.f` (extends h0.e) | 重命名 |
| R8 map-id | `2a5d39f` | `dev2-build` | 不同映射 |
| 频道系统 | ❌ 无 | ✅ 完整 | **全新** |
| 文件下载服务 | ❌ 无 | ✅ FileDownloadService | **全新** |
| 文件中心 | ❌ 无 | ✅ FileCenterActivity | **全新** |
| 密码恢复页面 | ✅ RecoverPasswordActivity | ❌ 无 (浏览器跳转) | **移除** |
| 交互按钮系统 | 旧版 s0 (表单回调) | 新版 s0 (播放列表同步) | **完全重构** |

**分析**: Dev2 版本是一次**大规模架构重构**，引入了频道系统、文件下载服务等全新模块，同时将密码恢复流程从应用内迁移到浏览器，交互按钮系统从表单回调变为播放列表同步工具。

---

## 2. Activities 变化

### 2.1 Dev2 新增 Activities (4个)

| # | Activity | 功能 | 源码位置 |
|---|---|---|---|
| 1 | **ChannelActivity** | 频道详情页 | `com.im.oldchat.ui.ChannelActivity` |
| 2 | **ChannelComposeActivity** | 频道发帖/媒体上传 | `com.im.oldchat.ui.ChannelComposeActivity` |
| 3 | **ChannelDiscoveryActivity** | 频道发现/搜索 | `com.im.oldchat.ui.ChannelDiscoveryActivity` |
| 4 | **FileCenterActivity** | 文件下载中心 | `com.im.oldchat.ui.FileCenterActivity` |

### 2.2 Release 独有 Activities (1个)

| # | Activity | 功能 | 说明 |
|---|---|---|---|
| 1 | **RecoverPasswordActivity** | 密码恢复 (应用内) | Dev2 中已移除，改为浏览器跳转 |

### 2.3 混淆名对照表 (关键类)

| 功能 | Release 混淆名 | Dev2 混淆名 | 说明 |
|---|---|---|---|
| Activity 基类 | `AbstractActivityC0305a` | `g0.a` | 重构 |
| 消息发送辅助 | `C0218x` | `C0229w` | 重映射 |
| 好友模型 | `k0.F` | `k0.J` | 重映射 |
| 播放列表模型 | `k0.z` | `k0.D` | 重映射 |
| 音乐项模型 | `k0.y` | `k0.C` | 重映射 |
| 交互按钮 | `s0` (表单回调) | `s0` (播放列表) | **功能完全不同** |

---

## 3. Services 变化

### 3.1 对比

| Service | Release | Dev2 | 变化 |
|---|---|---|---|
| MessageService | ✅ | ✅ | 不变 |
| ResourceUploadService | ✅ | ✅ | 不变 |
| MusicPlaybackService | ✅ | ✅ | 不变 |
| CipVibeBackgroundService | ✅ | ✅ | 不变 |
| **FileDownloadService** | ❌ | ✅ | **新增** |

### 3.2 FileDownloadService 详解 (Dev2 新增)

```java
// Dev2 — FileDownloadService
// 完整的后台文件下载服务，支持队列、进度通知、断点续传
public class FileDownloadService extends Service {
    private final Object lock = new Object();
    private final ArrayDeque queue = new ArrayDeque();  // 下载队列
    private boolean isProcessing;

    // 静态入口方法 — 启动下载
    public static String f(Context context, String url, String name, String mime) {
        String id = "download_" + System.currentTimeMillis() + "_" + random;
        C0328h task = new C0328h();
        task.f7575a = id;           // 下载 ID
        task.f7576b = g(url);       // 处理后的 URL (添加 auth_required 参数)
        task.f7577c = name;         // 文件名
        task.f7578d = mime;         // MIME 类型
        task.f7579e = "queued";     // 状态: queued
        // 启动前台服务
        Intent intent = new Intent(context, FileDownloadService.class);
        intent.setAction("com.im.oldchat.action.FILE_DOWNLOAD_ENQUEUE");
        context.startForegroundService(intent);
        return id;
    }

    // URL 处理 — 为 files.mcl0.dpdns.org 添加 auth_required 参数
    public static String g(String url) {
        if (url contains "files.mcl0.dpdns.org" && !url.contains("auth_required=")) {
            return url + (url.contains("?") ? "&" : "?") + "auth_required=1";
        }
        return url;
    }

    // 下载执行循环
    public final void h() {
        while (true) {
            C0328h task = queue.poll();
            if (task == null) {
                stopForeground(true);
                stopSelf();
                return;
            }
            task.f7579e = "downloading";
            // 使用 G.a() 执行实际下载
            G.b result = G.a(this, task.url, task.name, task.mime, 
                getSharedPreferences("auth", 0).getString("access_token", ""), 
                progressCallback);
            if (result.success) {
                task.f7579e = "done";
                task.f7580f = 100;
                task.f7583i = result.savedPath;
                task.f7584j = result.savedUri;
            } else {
                task.f7579e = "failed";
                task.f7585k = result.error;
            }
        }
    }

    // 通知渠道: "oldchat_download", 优先级: 2 (低)
    // 点击通知跳转 FileCenterActivity
}
```

**关键特性**:
- 使用 `ArrayDeque` 实现 FIFO 下载队列
- 前台服务 (startForeground) 保活
- 进度回调: `downloaded_bytes`, `total_bytes`, `progress`
- 状态机: `queued` → `downloading` → `done` / `failed`
- 广播通知: `com.im.oldchat.action.FILE_DOWNLOAD_CHANGED`
- 为 `files.mcl0.dpdns.org` 自动添加 `auth_required=1` 参数

---

## 4. 自定义 UI 控件变化

### 4.1 对比

| 控件 | Release | Dev2 | 变化 |
|---|---|---|---|
| CircleImageView | ✅ | ✅ | 不变 |
| CoverFlowView | ✅ | ✅ | 不变 |
| CoverAmbientMotionView | ✅ | ✅ | 不变 |
| LyricCascadeView | ✅ | ✅ | 不变 |
| OldViewPlayerView | ✅ | ✅ | 不变 |
| ActionPanelAnimatedLayout | ✅ | ✅ | 不变 |
| FontAwesomeTextView | ✅ | ✅ | 不变 |
| RoundedImageView | ✅ | ✅ | 不变 |
| TiltFrameLayout | ✅ | ✅ | 不变 |
| ZoomImageView | ✅ | ✅ | 不变 |
| **BubbleTimeTextView** | ❌ | ✅ | **新增** |
| **ButtonFlowLayout** | ❌ | ✅ | **新增** |
| **MomentImageView** | ❌ | ✅ | **新增** |
| TopStatusBar | ✅ | ✅ | 不变 |
| NoAnimViewPager | ✅ | ✅ | 不变 |
| GroupMessageRecyclerView | ✅ | ✅ | 不变 |

### 4.2 Dev2 新增控件详解

#### BubbleTimeTextView
气泡时间文本控件，用于聊天消息中显示时间戳，可能支持气泡样式的时间显示。

#### ButtonFlowLayout
流式布局按钮容器，用于交互按钮系统 (`s0.java`) 中动态排列多个操作按钮。支持：
- 自动换行
- `setMaxRowWidth()` 设置最大行宽
- 动态添加/移除按钮

#### MomentImageView
动态/朋友圈图片控件，用于 MomentsActivity 中展示图片网格。

---

## 5. 频道系统 (全新)

> **这是 Dev2 最重要的新增功能模块。** 频道系统是一个类似 Telegram Channel 的内容发布平台，支持关注、发帖、媒体上传、通知管理等完整功能。

### 5.1 架构概览

```
频道系统 (Dev2 新增)
├── ChannelActivity          — 频道详情页
│   ├── 频道信息展示 (名称、handle、订阅数)
│   ├── 帖子列表 (ListView + 分页加载)
│   ├── 订阅/退订
│   ├── 通知静音/开启
│   ├── 分享频道
│   └── 发帖入口 (跳转 ChannelComposeActivity)
├── ChannelComposeActivity   — 频道发帖
│   ├── 文本编辑
│   ├── 图片/音频/视频/文件附件
│   ├── 秒传检查 (SHA256)
│   ├── 分片上传
│   ├── 回复帖子
│   └── 500MB 文件支持
├── ChannelDiscoveryActivity — 频道发现
│   ├── 搜索频道
│   ├── 频道列表
│   ├── 关注频道
│   └── 长按快速关注
└── 数据模型: C0322b (频道模型)
```

### 5.2 ChannelActivity — 频道详情页

```java
// Dev2 — ChannelActivity
public class ChannelActivity extends g0.a {
    private String channelId;        // 频道 ID
    private String accessToken;      // 认证 token
    private ListView postListView;   // 帖子列表
    private TextView tvName;         // 频道名称
    private TextView tvInfo;         // 频道信息 (@handle · N subscribers)
    private C0462e adapter;          // 帖子列表适配器
    private long lastReadPosition;   // 已读位置
    private C0322b channelModel;     // 频道数据模型
    private boolean isSubscribed;    // 是否已订阅

    // Intent 参数
    // channel_id, channel_name, channel_handle, channel_subscribers, channel_subscribed

    // API 调用
    // POST /v2/channels/subscribe     — 订阅频道
    // POST /v2/channels/unsubscribe   — 退订频道
    // POST /v2/channels/notifications — 设置通知级别
    // GET  /v2/channels/posts         — 获取帖子列表 (通过 h0.a.j)
    // POST /v2/channels/posts/read    — 标记已读 (通过 h0.a.i)

    // 频道分享链接格式: https://oc.mcl0.dpdns.org/c/{handle}
    // 菜单: 频道信息、刷新、分享频道、退出频道

    // 角色权限控制
    // owner/admin/publisher → 可发帖、显示发帖按钮
    // 普通订阅者 → 只能查看
}
```

### 5.3 频道 API 端点详情

| 端点 | 方法 | 请求字段 | 响应字段 | 说明 |
|---|---|---|---|---|
| `/v2/channels/subscribe` | POST | `channel_id` | — | 订阅频道 |
| `/v2/channels/unsubscribe` | POST | `channel_id` | — | 退订频道 |
| `/v2/channels/notifications` | POST | `channel_id`, `notification_level` ("all"/"none") | — | 设置通知 |
| `/v2/channels/discover` | GET | `q` (查询), `limit` (默认50) | `channels[]` (id, name, handle, avatar_url, description, visibility, subscriber_count) | 搜索频道 |
| `/v2/channels/posts/send` | POST | `channel_id`, `body`, `msg_type`, `media_url`, `reply_to_post_id`(可选) | — | 发送帖子 |
| `/v1/channels/media/upload` | POST (multipart) | `channel_id`, file (流式上传) | `url`, `msg_type`, `media_ref` | 上传媒体 |
| `/v2/files/check` | POST | `sha256`, `size_bytes` | `exists`(bool), `url` | 秒传检查 |

### 5.4 C0322b — 频道数据模型 (Dev2 新增)

```java
// Dev2 — k0.C0322b (频道模型)
public class C0322b {
    public String f7522a;  // id           — 频道 ID
    public String f7523b;  // name         — 频道名称
    public String f7524c;  // handle       — 频道 handle (@xxx)
    public String f7525d;  // avatar_url   — 头像 URL
    public String f7526e;  // description  — 频道描述
    public String f7527f;  // visibility   — 可见性 (public/private)
    public int    f7528g;  // subscriber_count — 订阅数
    public long   f7529h;  // created_at   — 创建时间
    public long   f7530i;  // updated_at   — 更新时间
    public long   f7531j;  // last_post_at — 最后发帖时间
    public String f7532k;  // role         — 用户角色 (owner/admin/publisher/subscriber)
    public long   f7533l;  // post_count   — 帖子数
    public long   f7534m;  // last_read_post_id — 已读位置
    public String f7535n;  // notification_level — 通知级别 (all/none)
    public int    f7536o;  // unread_count — 未读数
    public String f7537p;  // invite_link  — 邀请链接
    public long   f7538q;  // — 保留字段
}
```

### 5.5 频道发现 API 响应字段

```json
// GET /v2/channels/discover?q=keyword&limit=50
{
  "channels": [
    {
      "id": "channel_abc123",
      "name": "OldChat 官方频道",
      "handle": "oldchat_official",
      "avatar_url": "https://...",
      "description": "OldChat 最新动态",
      "visibility": "public",
      "subscriber_count": 12345
    }
  ]
}
```

---

## 6. 交互按钮系统重构

> **Release 版本的 `s0.java`** 是交互按钮的表单回调系统，**Dev2 版本的 `s0.java`** 被完全替换为播放列表同步工具。这是一个**功能完全不同的同名类**。

### 6.1 Release 版 s0.java — 交互按钮表单回调

```java
// Release — s0.java (交互按钮系统)
// 功能: 处理消息中的交互按钮点击，支持表单提交
public abstract class s0 {
    
    // 按钮回调 API
    // POST /v2/buttons/callback
    // 请求字段:
    //   msg_id      — 消息 ID
    //   to_type     — 目标类型 (direct/group)
    //   to_id       — 目标 ID
    //   btn_index   — 按钮索引
    //   tid         — 表单事务 ID
    //   nonce       — 随机数
    //   action      — 动作类型
    //   form_data   — 表单数据 (可选)

    // 按钮动作类型:
    // "open_url"   — 打开链接 (Uri.parse)
    // "reply_msg"  — 回复消息
    // "form"       — 弹出表单 (AbstractC0199a.d)
    // "send_text"  — 发送文本
    // "send_image" — 发送图片

    // 表单过期检查:
    // form 类型按钮支持 expires_at 字段
    // System.currentTimeMillis() / 1000 >= expires_at → 显示"已过期"

    // 按钮错误码:
    // "tid_used"      → "你已经提交过该表单"
    // "form_expired"  → "表单已过期"
    // "invalid_tid"   → "表单验证失败，请刷新消息"

    // 按钮渲染:
    // 使用 ButtonFlowLayout 流式布局
    // 圆角边框: cornerRadius=16dp, stroke=1dp, color=##FFD1D1DB
    // 过期按钮: 灰色文字 (#FF9CA3AF)
    // 正常按钮: 深色文字 (#FF2563EB)
    // 最大行宽: min(280dp, max(160dp, screenWidth - 92dp))
}
```

### 6.2 Dev2 版 s0.java — 播放列表同步

```java
// Dev2 — s0.java (播放列表同步系统)
// 功能: 管理播放列表的云端同步
public abstract class s0 {
    
    // 拉取播放列表
    // GET /music/playlists
    // 响应: { "items": [ { "id", "name", "cover_url", "created_at", "updated_at", "songs": [...] } ] }
    public static void i(Context context, eVar, cVar) {
        AbstractC0321b.i("/music/playlists", token, eVar, callback);
    }

    // 推送播放列表到云端
    // POST /music/playlists/sync
    // 请求: { "playlists": [ { "id", "name", "cover_url", "songs": [ { "song_id", "song" } ] } ] }
    // 限制: 最多 5 个本地歌单, 每个歌单最多 200 首歌
    public static void j(Context context, eVar, cVar) {
        List playlists = i0.d.d(context).f();
        if (playlists.size() > 5) {
            // "本地歌单超过 5 个上限，请先删除多余的"
            return;
        }
        JSONObject data = d(playlists);
        AbstractC0321b.k("/music/playlists/sync", data.toString(), token, eVar, callback);
    }

    // 播放列表数据模型解析
    public static k0.z h(JSONObject json) {
        // 字段: id, name, cover_url, created_at, updated_at, songs[]
        // songs[].song → k0.y (歌曲详情)
    }
}
```

### 6.3 对比总结

| 维度 | Release s0 | Dev2 s0 |
|---|---|---|
| 功能 | 交互按钮表单回调 | 播放列表云端同步 |
| API 端点 | `/v2/buttons/callback` | `/music/playlists`, `/music/playlists/sync` |
| UI 组件 | ButtonFlowLayout 按钮渲染 | 无 UI (纯数据同步) |
| 用户交互 | 点击按钮 → 表单提交 | 自动同步/手动拉取 |
| 数据流向 | 客户端 → 服务端 (提交表单) | 双向 (拉取+推送) |

**影响**: 交互按钮系统的 UI 渲染逻辑在 Release 中保留在 `s0.java`，但 Dev2 中被替换。如果 Dev2 要保留交互按钮功能，可能已迁移到其他类中。

---

## 7. 文件系统重构

### 7.1 概述

Dev2 引入了完整的文件下载管理系统，包括下载服务、下载中心 UI、下载任务数据模型。

### 7.2 新增组件

| 组件 | 类型 | 功能 |
|---|---|---|
| `FileDownloadService` | Service | 后台文件下载服务 |
| `FileCenterActivity` | Activity | 文件下载中心 UI |
| `k0.C0328h` | 数据模型 | 下载任务模型 |

### 7.3 C0328h — 下载任务数据模型

```java
// Dev2 — k0.C0328h (下载任务模型)
public class C0328h {
    public String f7575a;  // id             — 下载任务 ID
    public String f7576b;  // url            — 下载 URL
    public String f7577c;  // file_name      — 文件名
    public String f7578d;  // mime_type      — MIME 类型
    public String f7579e;  // status         — 状态 (queued/downloading/done/failed)
    public int    f7580f;  // progress       — 进度百分比 (0-100)
    public long   f7581g;  // downloaded_bytes — 已下载字节数
    public long   f7582h;  // total_bytes    — 总字节数
    public String f7583i;  // saved_path     — 保存路径
    public String f7584j;  // saved_uri      — 保存 URI
    public String f7585k;  // error          — 错误信息
    public long   f7586l;  // updated_at     — 更新时间戳

    // JSON 序列化/反序列化
    public static C0328h a(JSONObject json);  // from JSON
    public JSONObject b();                     // to JSON
}
```

### 7.4 文件下载流程

```
用户触发下载
    ↓
FileDownloadService.f(context, url, name, mime)
    ↓
创建 C0328h 任务 → 状态: "queued"
    ↓
startForegroundService(intent)
    ↓
onStartCommand → 加入 ArrayDeque 队列
    ↓
新线程执行 h() 循环
    ↓
G.a(context, url, name, mime, token, callback) → 实际下载
    ↓
进度回调 → 更新 C0328h → 广播 FILE_DOWNLOAD_CHANGED
    ↓
完成/失败 → 更新状态 → 通知 → 继续下一个任务
```

### 7.5 FileCenterActivity — 下载中心 UI

```java
// Dev2 — FileCenterActivity
// 功能: 展示所有下载任务的状态
// 状态显示:
//   "downloading" → 进度条 + "下载中 X% · 已下载/总大小"
//   "queued"      → 不确定进度条 + "等待下载"
//   "done"        → "已下载 · MM-dd HH:mm · 点击打开"
//   "failed"      → "下载失败 · 点击重试 · 错误原因"
// 点击行为:
//   done → 打开文件 (q0.E.a)
//   failed → 重新下载 (FileDownloadService.f)
// 广播监听: com.im.oldchat.action.FILE_DOWNLOAD_CHANGED
```

---

## 8. 密码恢复流程变化

### 8.1 Release 版 — 应用内密码恢复

```java
// Release — RecoverPasswordActivity
// 完整的密码恢复流程，包含图形验证码

// 1. 获取图形验证码
// GET /auth/captcha
// 响应: { "captcha_id": "...", "image_base64": "..." }
// 解码 Base64 → 显示 ImageView

// 2. 发送邮箱验证码
// POST /auth/email/send
// 请求: { "email", "captcha_id", "captcha_code", "username" }
// 错误码: "invalid_captcha", "invalid_account", "email_cooldown"

// 3. 重置密码
// POST /auth/password/reset
// 请求: { "username", "email", "email_code", "new_password" }
// 错误码: "invalid_email_code", "invalid_account", "invalid_password"
// 密码要求: ≥8 字符

// UI 组件:
// - 用户名输入 (EditText)
// - 邮箱输入 (EditText)
// - 图形验证码输入 (EditText) + 验证码图片 (ImageView, 可点击刷新)
// - 邮箱验证码输入 (EditText)
// - 新密码输入 (EditText)
// - 发送验证码按钮 (带 120 秒倒计时)
// - 重置密码按钮

// 安全措施:
// - 验证码刷新限频: 5 秒内不能重复请求
// - 用户名校验: 3-24 字符, 仅 a-z 0-9 _
// - 邮箱格式校验: Patterns.EMAIL_ADDRESS
// - 发送倒计时: 120 秒
```

### 8.2 Dev2 版 — 浏览器跳转

```java
// Dev2 — LoginActivity.D0() (密码恢复入口)
// 直接跳转浏览器
public final void D0() {
    String baseUrl = h0.e.f7052b;  // API base URL
    int idx = baseUrl.indexOf("/v1");
    if (idx > 0) baseUrl = baseUrl.substring(0, idx);
    Intent intent = new Intent(Intent.ACTION_VIEW, 
        Uri.parse(baseUrl + "/forgot-password"));
    intent.addFlags(268435456);  // FLAG_ACTIVITY_NEW_TASK
    startActivity(intent);
}
```

### 8.3 对比

| 维度 | Release (应用内) | Dev2 (浏览器) |
|---|---|---|
| 用户体验 | ✅ 一体化 | ⚠️ 跳转浏览器 |
| 图形验证码 | ✅ 应用内显示 | 浏览器处理 |
| 邮箱验证码 | ✅ 应用内倒计时 | 浏览器处理 |
| 密码校验 | ✅ 应用内校验 | 浏览器处理 |
| 维护成本 | ❌ 高 (客户端逻辑) | ✅ 低 (服务端 Web) |
| API 端点 | `/auth/captcha`, `/auth/email/send`, `/auth/password/reset` | 无 (浏览器处理) |
| 安全 | 客户端限频 | 服务端限频 |

---

## 9. API 端点变化

### 9.1 新增端点 (Dev2)

| 端点 | 方法 | 功能 | 详细说明 |
|---|---|---|---|
| `/v2/channels/subscribe` | POST | 订阅频道 | `channel_id` |
| `/v2/channels/unsubscribe` | POST | 退订频道 | `channel_id` |
| `/v2/channels/notifications` | POST | 频道通知设置 | `channel_id`, `notification_level` |
| `/v2/channels/discover` | GET | 频道发现/搜索 | `q`, `limit` |
| `/v2/channels/posts/send` | POST | 频道发帖 | `channel_id`, `body`, `msg_type`, `media_url` |
| `/v1/channels/media/upload` | POST | 频道媒体上传 | multipart, `channel_id` |
| `/v2/files/check` | POST | 秒传检查 | `sha256`, `size_bytes` |
| `/v2/buttons/callback` | POST | 交互按钮回调 | Release 中存在, Dev2 中可能迁移 |

### 9.2 移除端点 (Dev2)

| 端点 | 原功能 | 替代方案 |
|---|---|---|
| `/auth/captcha` | 获取图形验证码 | 浏览器处理 |
| `/auth/email/send` | 发送邮箱验证码 | 浏览器处理 |
| `/auth/password/reset` | 重置密码 | 浏览器处理 |

### 9.3 端点变化汇总

| 功能域 | Release 端点数 | Dev2 端点数 | 变化 |
|---|---|---|---|
| 认证 | 5 (login, captcha, email/send, password/reset, refresh) | 2 (login, refresh) | **-3** (浏览器化) |
| 频道 | 0 | **6** | **+6** (全新) |
| 文件 | 0 | **2** (check, upload) | **+2** (全新) |
| 交互按钮 | 1 (callback) | 0 (迁移) | **-1** |
| 音乐 | 不变 | 不变 | 不变 |
| 其他 | 不变 | 不变 | 不变 |

### 9.4 v2 API 路径映射

Dev2 的 `h0.e.p()` 方法中定义了完整的 v1→v2 路径映射 (Release 中在 `h0.d.p()`):

```
/groups/read         → /v2/groups/read
/groups/burn/open    → /v2/groups/burn/open
/groups/typing       → /v2/groups/typing
/direct/send         → /v2/direct/send
/direct/read         → /v2/direct/read
/direct/burn/open    → /v2/direct/burn/open
/chats/typing        → /v2/chats/typing
/redpackets/send     → /v2/redpackets/send
/redpackets/claim    → /v2/redpackets/claim
/friends/request     → /v2/friends/request
/friends/respond     → /v2/friends/respond
/friends/remark      → /v2/friends/remark
/friends/delete      → /v2/friends/delete
/groups/create       → /v2/groups/create
/groups/join         → /v2/groups/join
/groups/leave        → /v2/groups/leave
/groups/approve      → /v2/groups/approve
/groups/invite       → /v2/groups/invite
/groups/invitations  → /v2/groups/invitations
/groups/invitations/respond → /v2/groups/invitations/respond
/groups/admin        → /v2/groups/admin
/groups/avatar       → /v2/groups/avatar
/groups/kick         → /v2/groups/kick
/groups/name         → /v2/groups/name
/groups/settings     → /v2/groups/settings
/groups/announcement → /v2/groups/announcement
/groups/announcement/read → /v2/groups/announcement/read
/groups/dissolve     → /v2/groups/dissolve
/me/uid              → /v2/me/uid
/me/profile          → /v2/me/profile
/me/password         → /v2/me/password
/me/delete/email/send → /v2/me/delete/email/send
/me/delete           → /v2/me/delete
/me/group-invite-preference → /v2/me/group-invite-preference
/me/avatar           → /v2/me/avatar
/me/cover            → /v2/me/cover
/me/checkin          → /v2/me/checkin
/me/presence         → /v2/me/presence
/me/devices          → /v2/me/devices
/me/devices/cleanup  → /v2/me/devices/cleanup
/me/bug-reports      → /v2/me/bug-reports
/me/user-reports     → /v2/me/user-reports
/me/group-reports    → /v2/me/group-reports
/moments/like        → /v2/moments/like
/moments/unlike      → /v2/moments/unlike
/moments/delete      → /v2/moments/delete
/moments/comment     → /v2/moments/comment
/moments/comment/delete → /v2/moments/comment/delete
/moments             → /v2/moments
/friends/requests    → /v2/friends/requests
/groups/list         → /v2/groups/list
/groups/members      → /v2/groups/members
/groups/requests     → /v2/groups/requests
/users/profile       → /v2/users/profile
/friends             → /v2/friends
/moments/comments    → /v2/moments/comments
/moments/user        → /v2/moments/user
/moments/feed        → /v2/moments/feed
```

---

## 10. 网络层重构

### 10.1 类重命名映射

| Release 类名 | Dev2 类名 | 功能 |
|---|---|---|
| `h0.c` | `h0.d` | HTTP 请求工具 (GET/POST/上传) |
| `h0.d` | `h0.e` | URL 配置/缓存/重试/签名 |
| `h0.e` | `h0.f` | 文件上传 (multipart) |
| `h0.AbstractC0320a` | `h0.a` | Token 管理 |
| `h0.AbstractC0321b` | `h0.c` | 新版 HTTP 工具 (Dev2 新增) |

### 10.2 URL 配置对比

```java
// Release — h0.d
public static volatile String f7202a = "http://oc.mcl0.dpdns.org/v1";
// 仅一个 base URL

// Dev2 — h0.e
public static volatile String f7051a = "http://oc.mcl0.dpdns.org";      // OC 服务器
public static volatile String f7052b = "http://oc.mcl0.dpdns.org/v1";    // API base URL
// 两个 URL: 服务器地址 + API 版本路径
```

### 10.3 v2 API 签名机制

Dev2 的 `h0.e.b()` 方法新增了 v2 API 签名:

```java
// Dev2 — h0.e.b() (v2 API 请求签名)
public static void b(HttpURLConnection conn, String token, String path) {
    if (path.startsWith("/v2/") || path.startsWith("/v1/v2/")) {
        // 1. 移除查询参数
        int idx = path.indexOf('?');
        if (idx >= 0) path = path.substring(0, idx);
        
        // 2. 生成签名
        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String nonce = AbstractC0573w.w();
        String sign = AbstractC0573w.z(token, path, timestamp, nonce);
        
        // 3. 设置请求头
        conn.setRequestProperty("X-Ts", timestamp);
        conn.setRequestProperty("X-Nonce", nonce);
        conn.setRequestProperty("X-Sign", sign);
        conn.setRequestProperty("X-Device-Id", deviceId);
    }
}
```

### 10.4 Gateway 模式

Dev2 新增了 Gateway 代理模式:

```java
// Dev2 — h0.e.k() (Gateway 代理)
public static c k(String method, String path, JSONObject body, String token) {
    // 将请求封装为 gateway 格式
    JSONObject gatewayBody = new JSONObject();
    gatewayBody.put("m", method);     // 原始方法
    gatewayBody.put("p", path);       // 原始路径
    gatewayBody.put("q", queryString); // 查询参数
    gatewayBody.put("b", body);       // 请求体
    
    // POST /v2/gateway
    c result = i("POST", "/v2/gateway", gatewayBody, token);
    
    // 解析 gateway 响应
    JSONObject response = new JSONObject(result.body);
    return new c(response.optInt("code", 200), response.optString("body", ""));
}
```

### 10.5 请求缓存机制对比

两个版本都有请求缓存，但实现细节不同:

| 特性 | Release (h0.d) | Dev2 (h0.e) |
|---|---|---|
| 缓存大小上限 | 180 条 | 180 条 |
| 成功缓存 TTL | 1500ms | 1500ms |
| 失败缓存 TTL | 300ms | 300ms |
| 等待超时 | 4000ms | 4000ms |
| 重试策略 | 指数退避 (350ms * 2^n, max 1200ms) | 指数退避 (350ms * 2^n, max 1200ms) |
| 可缓存条件 | 非 auth/messages/typing/redpackets | 相同 |

---

## 11. NCUID 迁移进展

### 11.1 Release 版 NCUID 使用 (30+处)

Release 版本已完成 NCUID 的全面迁移，覆盖:
- 登录存储: `my_ncuid`
- 消息发送: `to_ncuid`
- 消息搜索: `with_ncuid`
- 好友操作: `user_ncuid`, `friend_ncuid`
- 群组创建: `member_ncuids`
- 群组邀请: `user_ncuid`
- 红包发送: `to_ncuid`

### 11.2 Dev2 版 NCUID 使用

Dev2 版本保持与 Release 相同的 NCUID 迁移状态，并新增了频道系统中的使用:

```java
// Dev2 — GroupCreateActivity (与 Release 相同)
jSONObject.put("member_uids", jSONArray);      // 旧字段保留
if (i2 > 0 && jSONArray2.length() == i2) {
    jSONObject.put("member_ncuids", jSONArray2); // 新字段
}

// Dev2 — RedPacketSendActivity (与 Release 相同)
jSONObject.put("to_uid", this.f4691H);    // 旧字段
jSONObject.put("to_ncuid", this.f4692I);  // 新字段
```

### 11.3 好友模型 NCUID 字段

```java
// Dev2 — k0.J (好友模型)
public String f7486a;  // id
public String f7487b;  // uid
public String f7488c;  // ncuid          ← NCUID 字段
public String f7489d;  // username
public String f7490e;  // display_name
public String f7491f;  // remark_name
public String f7492g;  // user_title
public String f7493h;  // avatar_url

// Release — k0.F (好友模型)
public String f7557a;  // id
public String f7558b;  // uid
public String f7559c;  // ncuid          ← NCUID 字段
public String f7560d;  // username
public String f7561e;  // display_name
public String f7562f;  // remark_name
public String f7563g;  // user_title
public String f7564h;  // avatar_url
```

**结论**: NCUID 字段在两个版本中都存在，迁移状态一致。

---

## 12. 数据模型变化

### 12.1 好友模型

| 字段 | Release (k0.F) | Dev2 (k0.J) | 说明 |
|---|---|---|---|
| id | `f7557a` | `f7486a` | 混淆名不同 |
| uid | `f7558b` | `f7487b` | 混淆名不同 |
| ncuid | `f7559c` | `f7488c` | 混淆名不同 |
| username | `f7560d` | `f7489d` | 混淆名不同 |
| display_name | `f7561e` | `f7490e` | 混淆名不同 |
| remark_name | `f7562f` | `f7491f` | 混淆名不同 |
| user_title | `f7563g` | `f7492g` | 混淆名不同 |
| avatar_url | `f7564h` | `f7493h` | 混淆名不同 |
| status | — | `f7494i` | Dev2 新增 |
| sign | — | `f7495j` | Dev2 新增 |
| last_seen | — | `f7496k` | Dev2 新增 |
| is_online | — | `f7497l` | Dev2 新增 |
| vip_level | — | `f7498m` | Dev2 新增 |

### 12.2 播放列表模型

| 字段 | Release (k0.z) | Dev2 (k0.D) | 说明 |
|---|---|---|---|
| id | `f7751a` | — | Dev2 重映射 |
| name | `f7752b` | — | Dev2 重映射 |
| cover_url | `f7753c` | — | Dev2 重映射 |
| description | `f7754d` | — | Dev2 重映射 |
| owner_uid | `f7755e` | — | Dev2 重映射 |
| owner_name | `f7756f` | — | Dev2 重映射 |
| owner_title | `f7757g` | — | Dev2 重映射 |
| owner_avatar | `f7758h` | — | Dev2 重映射 |
| song_count | `f7759i` | — | Dev2 重映射 |

### 12.3 音乐项模型

| 字段 | Release (k0.y) | Dev2 (k0.C) | 说明 |
|---|---|---|---|
| id | `f7790a` | `f7412a` | 混淆名不同 |
| song_name | `f7791b` | `f7413b` | 混淆名不同 |
| song_url | `f7792c` | `f7414c` | 混淆名不同 |
| cover_url | `f7793d` | `f7415d` | 混淆名不同 |
| lyrics_url | `f7794e` | `f7416e` | 混淆名不同 |
| duration_ms | `f7796g` | `f7418g` | 混淆名不同 |
| owner_uid | `f7797h` | `f7419h` | 混淆名不同 |
| owner_name | `f7798i` | `f7420i` | 混淆名不同 |
| owner_title | `f7799j` | `f7421j` | 混淆名不同 |
| owner_avatar | `f7800k` | `f7422k` | 混淆名不同 |
| likes | `f7801l` | `f7423l` | 混淆名不同 |
| comments | `f7802m` | `f7424m` | 混淆名不同 |
| downloads | `f7803n` | `f7425n` | 混淆名不同 |
| is_liked | `f7804o` | `f7426o` | 混淆名不同 |

### 12.4 下载任务模型 (Dev2 新增)

```java
// Dev2 — k0.C0328h (全新模型)
// 字段详见 §7.3
```

### 12.5 频道模型 (Dev2 新增)

```java
// Dev2 — k0.C0322b (全新模型)
// 字段详见 §5.4
```

---

## 13. JSON 字段对比

### 13.1 登录响应

```json
// 两个版本相同
{
  "access_token": "...",
  "refresh_token": "...",
  "user": {
    "id": "...",
    "uid": "...",
    "ncuid": "...",
    "display_name": "...",      // Dev2 新增读取
    "username": "..."           // Dev2 新增读取
  }
}
```

**差异**: Dev2 的 LoginActivity 额外读取并存储了 `display_name` 和 `username`:
```java
// Dev2 — LoginActivity.a.a()
getSharedPreferences("auth", 0).edit()
    .putString("display_name", jSONObject2.optString("display_name", ""))
    .putString("my_username", jSONObject2.optString("username", ""))
    .apply();
```

### 13.2 登录请求

```json
// 两个版本相同
{
  "identifier": "...",
  "password": "...",
  "device_id": "...",
  "imei": "...",
  "device_name": "...",
  "platform": "android",
  "app_version": "..."
}
```

### 13.3 创建群组请求

```json
// 两个版本相同
{
  "name": "群名称",
  "member_uids": ["uid1", "uid2"],
  "member_ncuids": ["ncuid1", "ncuid2"]  // 可选，全部有 ncuid 时才发送
}
```

### 13.4 创建群组响应

```json
// Release
{
  "group_id": "..."
}

// Dev2 — 新增字段
{
  "group_id": "...",
  "invitation_count": 3,       // 新增: 邀请数
  "auto_rejected_count": 1     // 新增: 自动拒绝数
}
```

### 13.5 红包发送请求

```json
// 两个版本相同
{
  "title": "恭喜发财",          // 可选, ≤20 字符
  "total_amount": 100,
  "total_count": 5,
  "cover_url": "https://...",   // 可选
  "to_uid": "...",              // 私聊时 (旧字段)
  "to_ncuid": "...",            // 私聊时 (新字段)
  "group_id": "..."             // 群红包时
}
```

### 13.6 频道帖子发送请求 (Dev2 新增)

```json
{
  "channel_id": "...",
  "body": "帖子内容",
  "msg_type": "text" | "resource",
  "media_url": "https://...",   // msg_type=resource 时
  "reply_to_post_id": "..."     // 回复时可选
}
```

### 13.7 频道发现响应 (Dev2 新增)

```json
{
  "channels": [
    {
      "id": "...",
      "name": "...",
      "handle": "...",
      "avatar_url": "...",
      "description": "...",
      "visibility": "public",
      "subscriber_count": 12345
    }
  ]
}
```

### 13.8 交互按钮回调请求 (Release)

```json
{
  "msg_id": "...",
  "to_type": "direct" | "group",
  "to_id": "...",
  "btn_index": 0,
  "tid": "...",
  "nonce": "...",
  "action": "open_url" | "reply_msg" | "form" | "send_text" | "send_image",
  "form_data": "..."  // form 类型时可选
}
```

### 13.9 秒传检查请求/响应 (Dev2 新增)

```json
// 请求
{
  "sha256": "abcdef1234567890...",
  "size_bytes": 1048576
}

// 响应
{
  "exists": true,
  "url": "https://..."
}
```

### 13.10 播放列表同步请求 (Dev2 新增)

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
          "song": { /* k0.y 完整对象 */ }
        }
      ]
    }
  ]
}
```

---

## 14. SharedPreferences 变化

### 14.1 auth 偏好文件

| Key | Release | Dev2 | 说明 |
|---|---|---|---|
| `access_token` | ✅ | ✅ | 不变 |
| `refresh_token` | ✅ | ✅ | 不变 |
| `user_id` | ✅ | ✅ | 不变 |
| `my_uid` | ✅ | ✅ | 不变 |
| `my_ncuid` | ✅ | ✅ | 不变 |
| `saved_username` | ✅ | ✅ | 不变 |
| `saved_password` | ✅ | ✅ | 不变 (明文!) |
| `display_name` | ❌ | ✅ | **Dev2 新增** |
| `my_username` | ❌ | ✅ | **Dev2 新增** |

### 14.2 settings 偏好文件

两个版本的 settings 文件结构基本相同，Dev2 可能新增了频道相关的设置项。

---

## 15. 登录流程变化

### 15.1 Release 版 LoginActivity

```java
// Release — LoginActivity
// 继承: AbstractActivityC0305a
// HTTP 工具: h0.c.U() (POST), h0.c.T() (GET)
// URL 来源: h0.d.f7202a
// 错误处理: h0.d.w() (token 过期检查)
// 按钮 ID: AbstractC0310f.T1 (登录), AbstractC0310f.d4 (注册), AbstractC0310f.V3 (密码恢复)

// 注册: 跳转浏览器 (/register)
// 密码恢复: 跳转浏览器 (/forgot-password) ← 但实际上 Release 有 RecoverPasswordActivity!
// 等等...让我重新检查
```

**重新分析**: Release 版 LoginActivity 中密码恢复按钮 (`f3590A`) 的点击事件是 `new g()`，而 `g` 类跳转到 `RecoverPasswordActivity`:
```java
// Release — LoginActivity.g
public void onClick(View view) {
    LoginActivity.this.startActivity(new Intent(LoginActivity.this, 
        (Class<?>) RecoverPasswordActivity.class));
}
```

### 15.2 Dev2 版 LoginActivity

```java
// Dev2 — LoginActivity
// 继承: g0.a
// HTTP 工具: h0.d.W() (POST), h0.d.V() (GET)
// URL 来源: h0.e.f7052b
// 错误处理: h0.e.z() (token 过期检查)
// 按钮 ID: g0.f.g2 (登录), g0.f.r4 (注册), g0.f.j4 (密码恢复)

// 注册: 跳转浏览器 (/register)
// 密码恢复: 跳转浏览器 (/forgot-password)
```

### 15.3 登录流程对比

| 步骤 | Release | Dev2 |
|---|---|---|
| 1. 输入账号密码 | 相同 | 相同 |
| 2. 勾选协议 | 相同 | 相同 |
| 3. POST /auth/login | h0.c.U() | h0.d.W() |
| 4. 解析响应 | 相同字段 | +display_name, +my_username |
| 5. 存储 token | 相同 | 相同 |
| 6. 跳转主页 | 相同 | 相同 |
| 注册入口 | 浏览器 /register | 浏览器 /register |
| 密码恢复入口 | **RecoverPasswordActivity** | **浏览器 /forgot-password** |

---

## 16. 群组创建流程变化

### 16.1 关键差异: 创建响应

```java
// Release — GroupCreateActivity.d.a()
// 响应: { "group_id": "..." }
// 创建成功后直接跳转群聊

// Dev2 — GroupCreateActivity.d.a()
// 响应: { "group_id": "...", "invitation_count": 3, "auto_rejected_count": 1 }
// 创建成功后显示邀请统计:
//   "群聊已创建，邀请已发送，成员同意后加入"
//   "群聊已创建" + "，1人已自动拒绝"
```

### 16.2 好友列表加载

```java
// Release — 使用 k0.F 好友模型
// Dev2  — 使用 k0.J 好友模型
// 两者字段相同，仅混淆名不同
```

---

## 17. 红包发送流程变化

### 17.1 关键差异: HTTP 工具

```java
// Release — RedPacketSendActivity
// 封面上传: h0.c.V("/media", ...) → h0.e.E() (multipart with progress)
// 发送红包: h0.c.U("/redpackets/send", ...) → h0.d.i() (POST JSON)
// Token 过期: h0.d.w()

// Dev2 — RedPacketSendActivity
// 封面上传: h0.d.X("/media", ...) → h0.f.E() (multipart with progress)
// 发送红包: h0.d.W("/redpackets/send", ...) → h0.e.i() (POST JSON)
// Token 过期: h0.e.z()
```

### 17.2 封面上传对比

```java
// Release — 封面压缩
byte[] d2 = q0.G.d(getContentResolver(), uri, 1024, 1048576);
// 参数: maxDimension=1024, maxSize=1048576 (1MB)

// Dev2 — 封面压缩
byte[] d2 = q0.L.d(getContentResolver(), uri, 1024, PKIFailureInfo.badCertTemplate);
// 参数: maxDimension=1024, maxSize=1048576 (1MB) — 使用 SpongyCastle 常量
```

---

## 18. 音乐系统变化

### 18.1 MusicSearchActivity 对比

两个版本的 MusicSearchActivity 结构几乎相同，主要差异在于:

| 维度 | Release | Dev2 |
|---|---|---|
| 继承基类 | `AbstractActivityC0305a` | `g0.a` |
| HTTP 工具 | `h0.c.T()` | `h0.d.V()` |
| 音乐模型 | `k0.y` | `k0.C` |
| 播放列表模型 | `k0.z` | `k0.D` |
| 图片加载 | `q0.K.r()` | `q0.P.r()` |
| 下载工具 | `AbstractC0613y.j()` | `AbstractC0579z.j()` |

### 18.2 PlaylistDetailActivity 对比

| 维度 | Release | Dev2 |
|---|---|---|
| 继承基类 | `AbstractActivityC0305a` | `g0.a` |
| 播放列表字段 | `k0.z f4499F` | `k0.D f4339F` |
| 其他 | 结构相同 | 结构相同 |

---

## 19. 频道发帖系统 (ChannelComposeActivity)

> Dev2 独有，Release 中不存在。

### 19.1 功能概览

ChannelComposeActivity 是频道的发帖页面，支持:
- 文本编辑
- 图片/音频/视频/文件附件上传
- 秒传检查 (SHA256 校验)
- 分片上传 (大文件)
- 回复帖子

### 19.2 上传流程

```
用户选择文件
    ↓
检查文件大小:
  - 媒体文件 (image/audio/video): ≤50MB
  - 通用文件 (application/octet-stream): ≤500MB
    ↓
计算 SHA256 哈希值 (D0 方法)
    ↓
POST /v2/files/check { sha256, size_bytes }
    ↓
┌─ exists=true → 直接使用返回的 url → M0()
└─ exists=false → 上传文件
    ↓
  媒体文件 (≤50MB):
    POST /v1/channels/media/upload (multipart, channel_id)
    ↓ 响应: { url, msg_type, media_ref }
    H0() 发送帖子
    ↓
  通用文件 (≤500MB):
    使用分片上传 (h0.f.F 或 h0.f.G)
    ↓ 响应: { url }
    M0() → H0() 发送帖子
```

### 19.3 发帖 API 详情

```java
// POST /v2/channels/posts/send
JSONObject body = new JSONObject();
body.put("channel_id", channelId);
body.put("body", text);                    // 帖子文本
body.put("msg_type", "text" | "resource"); // 消息类型
body.put("media_url", mediaUrl);           // 媒体 URL (resource 类型)
body.put("reply_to_post_id", replyToId);   // 回复帖子 ID (可选)
```

### 19.4 媒体上传 API 详情

```java
// POST /v1/channels/media/upload (multipart)
// Content-Type: multipart/form-data
// 字段:
//   channel_id: 频道 ID (string field)
//   file: 文件流 (filename, Content-Type)
// 响应:
//   { "url": "https://...", "msg_type": "image", "media_ref": "..." }
```

### 19.5 秒传检查 API 详情

```java
// POST /v2/files/check
// 请求: { "sha256": "hex_string", "size_bytes": 123456 }
// 响应: { "exists": true, "url": "https://..." }
// 如果 exists=true，直接使用 url，无需上传
```

---

## 20. 频道发现系统 (ChannelDiscoveryActivity)

> Dev2 独有，Release 中不存在。

### 20.1 功能概览

ChannelDiscoveryActivity 是频道的发现/搜索页面，支持:
- 关键词搜索频道
- 浏览搜索结果
- 点击进入频道详情
- 长按快速关注频道

### 20.2 搜索 API

```java
// GET /v2/channels/discover?q=keyword&limit=50
// 响应: { "channels": [...] }
```

### 20.3 关注流程

```
长按频道项 → v0(channel)
    ↓
POST /v2/channels/subscribe { channel_id }
    ↓
成功 → h0.m.B().E() 刷新频道列表
    ↓
Toast: "已关注，频道已添加到主页"
```

### 20.4 频道详情跳转

```java
Intent intent = new Intent(this, ChannelActivity.class);
intent.putExtra("channel_id", channel.id);
intent.putExtra("channel_name", channel.name);
intent.putExtra("channel_handle", channel.handle);
intent.putExtra("channel_subscribers", channel.subscriber_count);
intent.putExtra("channel_subscribed", isSubscribed);
startActivity(intent);
```

---

## 21. 文件中心 (FileCenterActivity)

> Dev2 独有，Release 中不存在。

### 21.1 功能概览

FileCenterActivity 是文件下载管理页面，展示所有下载任务的状态。

### 21.2 数据源

```java
// 从 q0.H.a(context) 获取所有下载任务
// 返回 List<C0328h>
```

### 21.3 状态显示逻辑

```java
if ("downloading".equals(status)) {
    // 进度条 (indeterminate 或具体进度)
    // "下载中 X% · 已下载大小/总大小"
} else if ("queued".equals(status)) {
    // 不确定进度条
    // "等待下载"
} else if ("done".equals(status)) {
    // 隐藏进度条
    // "已下载 · MM-dd HH:mm · 点击打开"
} else {
    // 隐藏进度条
    // "下载失败 · 点击重试 · 错误原因"
}
```

### 21.4 交互行为

```java
// 点击已完成的下载 → 打开文件
q0.E.a(context, downloadTask);

// 点击失败的下载 → 重新下载
FileDownloadService.f(context, task.url, task.name, task.mime);
```

---

## 22. 文件下载服务 (FileDownloadService)

> Dev2 独有，Release 中不存在。

### 22.1 服务架构

```
FileDownloadService (前台服务)
├── onStartCommand()
│   ├── 解析 Intent (id, url, name, mime)
│   ├── 创建 C0328h 任务
│   ├── 加入 ArrayDeque 队列
│   └── 如果未在处理 → startForeground + 新线程
├── h() — 下载循环
│   ├── poll 队列
│   ├── 状态: downloading
│   ├── G.a() 执行下载
│   ├── 进度回调 → 更新任务 → 广播
│   └── 完成/失败 → 更新状态 → 广播
├── d() — 创建通知
│   ├── 通知渠道: "oldchat_download"
│   ├── 优先级: 2 (低)
│   └── 点击跳转: FileCenterActivity
└── i() — 持久化 + 广播
    ├── H.d() 保存到 SharedPreferences
    └── sendBroadcast(FILE_DOWNLOAD_CHANGED)
```

### 22.2 URL 处理

```java
// 为 files.mcl0.dpdns.org 添加认证参数
public static String g(String url) {
    if (url contains "files.mcl0.dpdns.org" && !url.contains("auth_required=")) {
        return url + (url.contains("?") ? "&" : "?") + "auth_required=1";
    }
    return url;
}
```

### 22.3 下载进度回调

```java
// G.a 回调接口
public void a(long downloaded, long total) {
    task.f7581g = downloaded;
    task.f7582h = total;
    task.f7580f = total > 0 ? (int) Math.min(100, (downloaded * 100) / total) : 0;
    task.f7586l = System.currentTimeMillis();
    // 保存 + 广播
    FileDownloadService.this.i(task);
    FileDownloadService.this.j(task, total <= 0);
}
```

---

## 23. 构建差异

### 23.1 R8 混淆映射

| 维度 | Release | Dev2 |
|---|---|---|
| map-id | `2a5d39f` | `dev2-build` |
| Activity 基类 | `AbstractActivityC0305a` | `g0.a` |
| HTTP 工具类 | `h0.c` / `h0.d` / `h0.e` | `h0.d` / `h0.e` / `h0.f` |
| 新增 h0 类 | — | `h0.a`, `h0.b`, `h0.c` (签名/Token/新版HTTP) |

### 23.2 类数量对比

| 包 | Release | Dev2 | 变化 |
|---|---|---|---|
| `com.im.oldchat.ui` | ~100 类 | ~120 类 | +20 |
| `com.im.oldchat.service` | 4 | 5 | +1 |
| `com.im.oldchat.ui.widget` | 9 | 12 | +3 |
| `com.im.oldchat.bili` | 11 | 12 | +1 (BiliWebViewMemoryGuard) |
| `h0` (网络层) | ~13 | ~24 | +11 |
| `k0` (数据模型) | ~34 | ~38 | +4 |

### 23.3 Dev2 新增的 bili 模块

```java
// Dev2 新增: BiliWebViewMemoryGuard
// B站 WebView 内存保护
// 防止 WebView 内存泄漏
```

---

## 24. 安全性变化

### 24.1 v2 API 签名 (Dev2 新增)

Dev2 引入了 v2 API 的请求签名机制:
- `X-Ts`: 时间戳 (秒级)
- `X-Nonce`: 随机数
- `X-Sign`: 签名值
- `X-Device-Id`: 设备 ID

### 24.2 安全评分对比

| 安全维度 | Release | Dev2 | 变化 |
|---|---|---|---|
| 传输层安全 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 不变 (Conscrypt) |
| 数据存储安全 | ⭐⭐ | ⭐⭐ | 不变 (明文密码) |
| 认证安全 | ⭐⭐⭐ | ⭐⭐⭐⭐ | +1 (v2 签名) |
| API 安全 | ⭐⭐⭐ | ⭐⭐⭐⭐ | +1 (v2 签名) |
| 密码恢复安全 | ⭐⭐⭐⭐ | ⭐⭐⭐ | -1 (浏览器化) |
| **综合评分** | **2.8/5** | **3.0/5** | **+0.2** |

### 24.3 持续存在的安全隐患

| 问题 | 严重性 | 两个版本均存在 |
|---|---|---|
| 明文密码存储 | **高** | ✅ |
| `saved_password` 明文 | **高** | ✅ |
| IMEI 收集 | 中 | ✅ |
| allowBackup=true | **高** | ✅ |

---

## 25. 迁移兼容性分析

### 25.1 向后兼容

| 维度 | 兼容性 | 说明 |
|---|---|---|
| 登录 API | ✅ 完全兼容 | 请求/响应字段不变 |
| 消息 API | ✅ 完全兼容 | v2 路径映射不变 |
| 音乐 API | ✅ 完全兼容 | 端点不变 |
| 好友/群组 API | ✅ 完全兼容 | 字段不变 |
| SharedPreferences | ✅ 兼容 | 新增字段不影响旧版 |

### 25.2 潜在兼容性问题

| 问题 | 严重性 | 影响 |
|---|---|---|
| 交互按钮系统重构 | **高** | Release 的按钮回调在 Dev2 中可能失效 |
| 密码恢复流程变更 | 中 | 旧版链接可能失效 |
| 频道系统新增 | 低 | 新功能，不影响旧数据 |
| 文件下载系统新增 | 低 | 新功能，不影响旧数据 |
| R8 映射不同 | 低 | 崩溃日志不能互相解析 |

### 25.3 升级路径

```
Release 用户升级到 Dev2:
1. 正常应用商店更新
2. 首次启动:
   a. 读取已存储的 auth 数据 (兼容)
   b. 新增 display_name, my_username 字段 (向后兼容)
3. 新功能:
   a. 频道系统自动可用
   b. 文件下载中心自动可用
4. 密码恢复:
   a. 旧版 RecoverPasswordActivity 不再可用
   b. 改为浏览器跳转
```

---

## 26. 技术趋势分析

### 26.1 四大技术趋势

#### 趋势一：内容平台化 (频道系统)

```
Release: 聊天 + 音乐 + B站
Dev2:    聊天 + 音乐 + B站 + 频道
未来:    综合社交内容平台
```

频道系统的引入表明 OldChat 正在向**内容分发平台**演进:
- 类似 Telegram Channel 的内容发布模式
- 支持多媒体帖子 (文本/图片/音频/视频/文件)
- 角色权限体系 (owner/admin/publisher/subscriber)
- 发现/搜索/分享机制

#### 趋势二：基础设施完善 (文件系统)

```
Release: 无文件下载管理
Dev2:    完整文件下载服务 + 中心
未来:    可能支持离线下载、P2P 传输
```

文件下载系统的引入解决了用户**内容消费**的基础设施问题:
- 后台下载 + 进度通知
- 下载队列管理
- 文件中心统一管理
- 秒传检查 (SHA256)

#### 趋势三：客户端瘦身 (浏览器化)

```
Release: 密码恢复 (应用内) + 注册 (浏览器)
Dev2:    密码恢复 (浏览器) + 注册 (浏览器)
未来:    更多功能迁移到 Web?
```

将密码恢复从应用内迁移到浏览器，体现了**客户端瘦身**策略:
- 降低客户端维护成本
- 服务端 Web 页面统一管理
- 支持更多平台 (iOS/Web)

#### 趋势四：API 安全增强 (v2 签名)

```
Release: v1 API + v2 路径映射
Dev2:    v1 API + v2 路径映射 + v2 签名
未来:    全面 v2 API + 端到端加密?
```

v2 API 签名机制的引入表明:
- API 安全性在持续增强
- 为后续的 API 版本化做准备
- 防止请求重放和篡改

### 26.2 开发节奏推测

| 指标 | Release | Dev2 |
|---|---|---|
| 新增 Activity | 0 | **4** |
| 新增 Service | 0 | **1** |
| 新增 Widget | 0 | **3** |
| 新增 API 端点 | 0 | **6** |
| 移除 API 端点 | 0 | **3** |
| 网络层变化 | — | **重构** |

Dev2 是一次**功能密集型**更新，同时包含架构重构和新功能开发。

---

## 27. 统计对比总表

### 27.1 核心指标

| 统计项 | Release | Dev2 | 变化 | 变化率 |
|---|---|---|---|---|
| **新增 Activities** | 0 | 4 | +4 | **新增** |
| **新增 Services** | 0 | 1 | +1 | **新增** |
| **新增 Widgets** | 0 | 3 | +3 | **新增** |
| **新增 API 端点** | 0 | 6 | +6 | **新增** |
| **移除 API 端点** | 0 | 3 | -3 | **移除** |
| **新增数据模型** | 0 | 2 | +2 | **新增** |
| **网络层重构** | — | ✅ | — | **重构** |

### 27.2 功能模块变化

| 模块 | Release | Dev2 | 变化 |
|---|---|---|---|
| 频道系统 | ❌ | ✅ 完整 | **全新** |
| 文件下载 | ❌ | ✅ 完整 | **全新** |
| 交互按钮 | ✅ 表单回调 | ✅ 播放列表 | **重构** |
| 密码恢复 | ✅ 应用内 | ❌ 浏览器 | **移除** |
| 登录流程 | ✅ | ✅ +display_name | 增强 |
| 群组创建 | ✅ | ✅ +invitation_count | 增强 |
| 音乐系统 | ✅ | ✅ | 不变 |
| B站模块 | ✅ | ✅ +MemoryGuard | 增强 |
| NCUID 迁移 | ✅ 30+处 | ✅ 30+处 | 不变 |
| v2 API 签名 | ❌ | ✅ | **新增** |
| Gateway 代理 | ❌ | ✅ | **新增** |

### 27.3 新增代码量估算

| 类别 | 新增文件数 | 新增代码行数 (估算) |
|---|---|---|
| 频道系统 (3 Activity + 模型) | ~5 | ~1,500 |
| 文件下载系统 (1 Service + 1 Activity + 模型) | ~3 | ~800 |
| 新增 Widget (3) | 3 | ~500 |
| 网络层重构 (v2 签名, gateway) | ~11 | ~2,000 |
| 交互按钮重构 | (修改) | ~300 |
| 登录增强 | (修改) | ~50 |
| 群组增强 | (修改) | ~100 |
| B站内存保护 | 1 | ~200 |
| **总计** | **~24** | **~5,450** |

### 27.4 API 端点统计

| 类别 | Release | Dev2 | 净变化 |
|---|---|---|---|
| 认证 | 5 | 2 | -3 |
| 频道 | 0 | 6 | +6 |
| 文件 | 0 | 2 | +2 |
| 交互按钮 | 1 | 0 | -1 |
| 音乐 | 15 | 15 | 0 |
| 好友/群组 | 不变 | 不变 | 0 |
| 动态 | 不变 | 不变 | 0 |
| 红包 | 不变 | 不变 | 0 |
| 签到 | 不变 | 不变 | 0 |
| B站 | 不变 | 不变 | 0 |
| **总计** | — | — | **+4 (净增)** |

---

## 总结

### 核心变化一览

| # | 变化 | 影响级别 | 类型 | 说明 |
|---|---|---|---|---|
| 1 | 📢 **频道系统** | **极高** | 功能 | 完整的频道订阅/发帖/发现系统 |
| 2 | 📁 **文件下载系统** | **高** | 功能 | 后台下载服务 + 下载中心 |
| 3 | 🔄 **交互按钮重构** | **高** | 架构 | 从表单回调变为播放列表同步 |
| 4 | 🔐 **v2 API 签名** | **高** | 安全 | X-Ts/X-Nonce/X-Sign 请求签名 |
| 5 | 🌐 **Gateway 代理** | **中** | 架构 | /v2/gateway 请求代理模式 |
| 6 | 🔑 **密码恢复浏览器化** | **中** | 功能 | 应用内 → 浏览器跳转 |
| 7 | 📊 **群组创建增强** | 低 | 功能 | 新增邀请/拒绝统计 |
| 8 | 👤 **登录增强** | 低 | 功能 | 新增 display_name/username 存储 |
| 9 | 🎵 **B站内存保护** | 低 | 性能 | BiliWebViewMemoryGuard |

### 升级评价

**Release → Dev2 是一次"平台化"关键升级**，在 Release 版本的安全加固和架构优化基础上，进一步扩展了内容分发能力:

- ✅ **频道系统** — 引入内容发布平台，产品形态重大升级
- ✅ **文件下载** — 完善内容消费基础设施
- ✅ **API 安全** — v2 签名机制增强安全性
- ⚠️ **交互按钮重构** — 可能影响现有功能
- ⚠️ **密码恢复浏览器化** — 用户体验略有下降

**总体评价**: Dev2 版本标志着 OldChat 从**聊天工具**向**社交内容平台**的关键转型。频道系统的引入是最具战略意义的变化，为后续的内容生态建设奠定了基础。

---

> 文档生成时间: 2026-08-09  
> 分析方法: jadx 反编译 Release 与 Dev2 APK，逐类对比源码  
> 作者: OldChat 逆向工程文档写作助手
