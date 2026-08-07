# OldChat For Kivotos - AI 接手文档 v1

> 本文档由前一位 AI 助手（DeepSeek-V4-Flash）在 2026-08-07 编写，供后续 AI 工具接手时快速理解项目背景、架构、开发历程和关键经验。

---

## 一、项目概述

### 1.1 项目定位

**OldChat For Kivotos** 是一个基于 **Tauri v2** 的跨平台桌面 IM 客户端，用于连接 OldChat 即时通讯后端服务。项目是对原版 OldChat Android 客户端（com.im.oldchat v1.3.61）的 Web/Tauri 重写版本，目标用户为 Windows 桌面用户（Windows 10/11）。

- **产品名**：OldChat For Kivotos
- **标识符**：`aoharureverie.oldchat.kivotosnextapp`
- **版本**：0.1.0
- **技术路线**：纯前端（HTML/CSS/JS）+ Tauri 原生壳（Rust）
- **运行环境**：Windows（Tauri dev + WebView2）

### 1.2 核心功能

| 模块 | 功能 |
|------|------|
| 登录注册 | 账号密码登录、GeeTest4.0 滑块验证、QQ 邮箱注册 |
| 私聊 | 实时消息收发、消息撤回、@对方、引用回复、图片/文件/语音消息 |
| 群聊 | 群成员管理、@全体成员、群公告、消息撤回 |
| 联系人 | 好友列表、群聊列表、好友申请、添加好友 |
| 音乐 | 广场/排行/我的音乐、歌词显示（TTML/LRC 格式）、音乐播放 |
| 设置 | 个人资料、通用设置、签到墙、关于页面 |
| 图片查看 | 全屏/窗口模式切换、拖拽缩放、滚轮缩放 |
| 主题 | 浅色/深色主题切换 |
| 通知 | 托盘通知、任务栏闪烁 |

### 1.3 后端服务

| 用途 | 地址 | 备注 |
|------|------|------|
| API 根地址 | `http://oc.mcl0.dpdns.org/v1` | 主后端（Go 实现） |
| 头像资源 | `http://60.205.94.101:8080/v1/uploads/avatars/` | 独立文件服务器 |
| 媒体资源 | `http://files.mcl0.dpdns.org/` | 图片/封面/音乐等静态资源 |
| WebSocket | `ws://oc.mcl0.dpdns.org/ws` | 实时消息推送 |

> ⚠️ **重要**：所有资源 URL 必须使用 `http://` 协议（不用 HTTPS），因为后端服务器没有 TLS 证书，且 Tauri 环境下 HTTP 不受限制。

> ⚠️ **CDN 节流**：`files.mcl0.dpdns.org` 是付费 CDN，腐竹（服务器管理员）明确要求第三方客户端**尽量少用**，优先留给官方客户端加速。如需优化第三方客户端体验，请联系腐竹协商。

---

## 二、项目结构

```
oldchat-kivotos-next-app/
├── src/                              # 前端源码
│   ├── index.html                    # 主页面（聊天界面）
│   ├── login.html                    # 登录/注册页面
│   ├── app.css                       # 全部样式（3032行）
│   ├── app.js                        # 全部业务逻辑（7372行）
│   ├── dumogu-scrollbar.umd.min.js   # 自定义滚动条库
│   └── assets/
│       ├── fontawesome/              # 图标字体
│       ├── default-avatar.png        # 默认头像
│       ├── oldchat_logo.png          # Logo
│       └── zyyt.woff2               # 自定义字体
├── src-tauri/                        # Tauri Rust 后端
│   ├── src/
│   │   ├── main.rs                   # 入口
│   │   └── lib.rs                    # Tauri 命令定义（~230行）
│   ├── capabilities/
│   │   └── default.json              # 权限配置（HTTP 白名单等）
│   ├── icons/                        # 各平台图标
│   ├── Cargo.toml                    # Rust 依赖配置
│   └── tauri.conf.json                # Tauri 应用配置
├── conf/
│   ├── nginx.conf                    # Nginx 反代配置（浏览器模式用）
│   └── mime.types
├── oldchat-docs-20260801/            # 原版 Android 客户端逆向文档
│   ├── mcl0/                         # 后端 API 文档
│   └── nx/                           # Android 客户端架构文档
├── config.json                       # 开发服务器配置
├── package.json                      # 前端 npm 配置
└── run.bat                           # Windows 一键启动脚本
```

### 2.1 关键文件说明

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/app.js` | 7372 | **核心业务逻辑**，所有功能都在一个 JS 文件中（单文件架构） |
| `src/app.css` | 3032 | **全部样式**，包括浅色/深色主题 |
| `src/index.html` | ~300 | 主界面 HTML 结构 |
| `src/login.html` | ~200 | 登录/注册页 HTML 结构 |
| `src-tauri/src/lib.rs` | ~230 | Rust 命令、Tauri 插件注册、窗口事件处理 |
| `src-tauri/capabilities/default.json` | ~20 | Tauri 权限白名单配置 |

---

## 三、技术栈

### 3.1 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| 原生 HTML/CSS/JS | - | 纯原生，无框架（React/Vue 都没有） |
| Font Awesome | 6.x | 图标 |
| dumogu-scrollbar | - | 自定义美化滚动条 |
| GeeTest | 4.0 | 人机验证（注册用） |

> 前端没有使用任何构建工具（Vite/Webpack），直接以静态文件方式提供给 Tauri。

### 3.2 Tauri 后端（Rust）

| 依赖 | 版本 | 用途 |
|------|------|------|
| tauri | 2.x | 核心框架 |
| tauri-plugin-opener | 2.x | 打开外部链接 |
| tauri-plugin-http | 2.x | 原生 HTTP 请求（绕过 CORS） |
| tauri-plugin-notification | 2.x | 系统通知 |
| tauri-plugin-dialog | 2.x | 文件保存对话框（另存为功能） |
| reqwest | 0.12 | Rust 端 HTTP 下载（另存为用） |
| windows-sys | 0.59 | Windows 任务栏闪烁 |

### 3.3 构建与运行

```bash
# 开发模式（增量编译）
npm run tauri dev

# 不需要 cargo clean
# 前端修改后：Ctrl+R 刷新 WebView
# Rust 代码修改后：自动重新编译（增量，很快）
# capabilities 修改后：自动重新编译
```

---

## 四、架构设计

### 4.1 运行模式检测

项目同时支持两种运行模式，通过 `_detectIsTauri()` 检测：

```javascript
const IS_TAURI = !!(window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined);
```

| 模式 | 检测方式 | HTTP 请求 |
|------|----------|-----------|
| Tauri 桌面端 | `__TAURI__` 存在 | 走 `tauri-plugin-http`（无 CORS） |
| 浏览器模式（已废弃） | `__TAURI__` 不存在 | 走 Nginx 反代（`config.json` 配置） |

> ⚠️ **注意**：浏览器模式（Nginx 反代）已废弃，但相关代码保留未动，请勿修改。

### 4.2 单文件架构

整个前端业务逻辑集中在 `src/app.js` 一个文件中（7372 行），这是有意的设计选择：
- 避免模块打包的复杂性
- Tauri 直接加载静态文件，无需构建
- 所有函数都是全局函数，通过 `window.xxx` 暴露

### 4.3 媒体 URL 处理

所有媒体资源 URL 通过 `resolveMediaUrl()` 函数统一处理，将后端返回的相对路径转换为实际可访问的绝对 URL：

```javascript
function resolveMediaUrl(url) {
    if (!url) return '';
    // http(s):|data:|blob: 协议直接返回
    if (/^(https?:|data:|blob:)/.test(url)) return url;

    const mappings = {
        '/v1/uploads/avatars/': 'http://60.205.94.101:8080/v1/uploads/avatars/',
        '/v1/uploads/covers/': 'http://files.mcl0.dpdns.org/covers/',
        '/v1/uploads/media/': 'http://files.mcl0.dpdns.org/media/',
        '/v1/uploads/emoji/': 'http://files.mcl0.dpdns.org/emoji/',
        '/v1/uploads/music/': 'http://files.mcl0.dpdns.org/music/',
        '/v1/uploads/lyrics/': 'http://files.mcl0.dpdns.org/lyrics/',
    };

    for (const [prefix, replacement] of Object.entries(mappings)) {
        if (url.startsWith(prefix)) {
            return replacement + url.substring(prefix.length);
        }
    }
    return url;
}
```

### 4.4 HTTP 请求链路（Tauri 模式）

```
前端 fetch(url)
    ↓
app.js 中重写的 window.fetch（initTauri IIFE）
    ↓
window.__TAURI_INTERNALS__.invoke('plugin:http|fetch', ...)
    ↓
Rust 端 tauri-plugin-http
    ↓
操作系统原生 HTTP 请求
    ↓
返回数据 → 前端解码
```

### 4.5 WebSocket 实时通信

- 连接地址：`ws://oc.mcl0.dpdns.org/ws`
- 自动重连：初始 5s，指数退避 5s → 10s → 20s → 30s（最大）
- 消息类型：`chat`（聊天）、`typing`（输入状态）、`recall`（撤回）等

### 4.6 用户身份缓存

```javascript
const userProfileCache = new Map();    // 缓存 4 小时
const invalidUidCache = new Set();     // 记住无效 UID
const pendingProfileFetches = new Map(); // 并发去重锁
```

- 每个用户资料最多缓存 4 小时
- 对同一用户的并发请求自动去重
- 失败最多重试 2 次（间隔 15s）
- `fetchUserProfile(uid, ncuid, forceRefresh)` 支持双参数查询

---

## 五、关键 API 与数据模型

### 5.1 用户身份标识

OldChat 有两套用户 ID 体系，**所有逻辑优先使用 NCUID**：

| 类型 | 格式 | 用途 |
|------|------|------|
| 旧 UID | 很多也是 `USR-XXX` 开头，少数为其他格式 | 旧版系统使用 |
| NCUID | 约 1/3 为 `USR-XXX`，其余大多为 `nc_xxxx`，极少数为其他格式 | **新版系统，优先使用** |

**关键约束**：
- `?uid=` 查询参数**只接受旧 UID**，传 NCUID 会返回 `invalid uid`
- `?ncuid=` 查询参数接受 NCUID 值
- POST body 中的 `to_uid`/`with_uid` 参数**同时接受两种格式**
- 私信获取消息必须用 `?with_uid=` 参数（不能用 `?with_ncuid=`）
- **所有逻辑优先使用 NCUID**，只有在后端明确要求旧 UID 格式的场景（如 `?uid=` 查询）才降级使用旧 UID

### 5.2 统一参数封装

```javascript
// 发消息时使用（优先取 ncuid，降级到 uid）
function toUidParam(obj) { return { to_uid: getFromUid(obj) }; }
// 拉消息时使用（用当前用户的旧 uid）
function withUidParam() { return { with_uid: currentUid }; }
// 查用户时使用（仅传旧 uid，后端 ?uid= 不接受 ncuid）
function profileQuery(uid) { return '?uid=' + uid; }
// 取发送者 ID：优先 ncuid，降级到 from_uid
function getFromUid(msg) { return msg.from_ncuid || msg.from_uid; }
// 比较两个 ID 是否相同（不区分大小写）
function uidEq(a, b) {
    if (!a || !b) return false;
    return a.toLowerCase() === b.toLowerCase();
}
```

### 5.3 消息 JSON 格式

服务端消息包含以下关键字段：
- `from_uid` / `from_ncuid`：发送者 ID（可能是 NCUID 格式）
- `from_name`：发送者昵称（可能是 NCUID）
- `from_avatar`：发送者头像 URL
- `group_id`：群 ID（群聊消息）
- `chat_id`：会话 ID
- `content` / `content_type`：消息内容和类型

---

## 六、开发历程（时间线）

### 第一阶段：基础搭建

1. **项目初始化**：基于 Tauri v2 创建空项目，手动搭建前端结构
2. **主界面搭建**：侧边栏（聊天/联系人/音乐/设置四 Tab）+ 聊天区域布局
3. **后端对接**：通过逆向 Android 客户端文档，对接 API
4. **WebView 与浏览器双模式**：实现 Tauri 原生 HTTP + 浏览器 Nginx 反代的双模式

### 第二阶段：核心功能实现

5. **登录注册**：完整实现登录流程 + GeeTest 4.0 滑块验证 + QQ 邮箱注册
6. **消息收发**：WebSocket 实时通信，支持文本/图片/引用/撤回
7. **好友系统**：好友列表、添加好友、好友申请通知
8. **群聊功能**：群成员列表、群消息、@功能
9. **音乐模块**：音乐广场/排行/我的，歌词解析（TTML + LRC 双格式）

### 第三阶段：体验优化与 Bug 修复

10. **用户资料缓存**：解决重复拉取用户资料导致的 API 洪峰问题（137,237 次请求）
11. **连续消息优化**：同一用户连续消息合并显示（无重复头像/昵称）
12. **撤回消息**：已撤回消息显示"重新编辑"链接（仅自撤回时可恢复编辑）
13. **输入状态指示**：WebSocket 实时输入状态显示，5 秒超时自动隐藏
14. **图片查看器**：全屏/窗口双模式，支持拖拽缩放、滚轮缩放、ESC 关闭
15. **下载功能**：从 Web 方式改为 Tauri 原生命令（解决 Tauri WebView2 下载限制）

---

## 七、重要经验与踩坑汇总

### 7.1 Tauri 相关

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `fetch()` 在 Tauri 中不工作 | CORS 限制，WebView2 同源策略 | 重写 `window.fetch` 走 `tauri-plugin-http` |
| `a.click()` 下载图片无反应 | Tauri WebView2 不支持原生下载 | 用 `tauri-plugin-dialog` + Rust `reqwest` 实现 |
| `blob:` URL Rust 端无法下载 | reqwest 不能访问浏览器内存中的 blob | 前端用 canvas `toBlob()` 读出数据，通过 `Vec<u8>` 传给 Rust |
| `cargo clean` 不必要 | 增量编译已足够快 | 仅在遇到奇怪缓存问题时才用 `cargo clean` |
| capabilities 修改需重启 | 必须重启 Tauri dev 才能生效 | 注意：前端刷新（Ctrl+R）不生效 |
| `blocking_save_file()` 阻塞问题 | Tauri 命令在后台线程池运行 | 用 blocking 版本在后台线程弹出对话框是安全的 |
| `FilePath::Physical` 不存在 | tauri-plugin-dialog 2.x API 变了 | 正确变体是 `FilePath::Path` |
| `#[tauri::command]` 函数未注册 | 忘记在 `generate_handler!` 中注册 | 每个新命令都必须在 generate_handler 中列出 |
| 自定义字体路径 | Tauri 加载本地文件路径不同 | 使用相对路径 + `resolveMediaUrl` 处理 |

### 7.2 前端相关

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `userProfileCache` 暂时性死区 | const 在 `await` 之后声明，在之前使用 | 将声明移到 DOMContentLoaded 回调最顶部 |
| `?with_ncuid=` 返回 invalid_uid | 后端不接受 ncuid 作为 with_uid 参数 | 改用 `?with_uid=` 传旧 UID |
| 连续消息判断失败 | 用 `===` 严格比较 uid 和 ncuid | 用 `uidEq()` 不区分大小写的比较 + `getFromUid()` 优先取 ncuid |
| 图片查看器全屏溢出 | Tauri 窗口不能超出屏幕边界 | 全屏模式创建独立 Tauri 窗口（transparent） |
| Tauri 弹窗无反应 | 原生 `window.alert/confirm` 在 Tauri 中不可用 | 实现自定义弹窗组件（CSS 动画） |
| 百度静态资源 CDN 问题 | `bdstatic.com` 被某些网络限制 | 改用 `file.mcl0.dpdns.org` 自建 CDN |

### 7.3 API 与数据

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `files.mcl0.dpdns.org` 无 CORS 头 | 自建 CDN 未配置 | Tauri 环境下用 plugin-http 绕过，浏览器环境下需配置 |
| **CDN 节流要求** | 腐竹要求第三方客户端少用 `files.mcl0.dpdns.org` | 优先用 `60.205.94.101:8080`（头像），媒体资源酌情使用 |
| 用户资料拉取风暴 | `createMessageElement` 每条消息触发 2 次 profile 拉取 | 并发去重锁 + 缓存 4 小时 + 限频重试 |
| 音乐封面 403 | `60.205.94.101` 的文件服务器配置问题 | 使用 `resolveMediaUrl` 转换 URL |
| ncuid 与 uid 混用 | 后端两套 ID 体系并存 | `fetchUserProfile` 双参数查询（**优先 ncuid 路径**） |
| `from_ncuid` 为空 | 服务端有时不返回 ncuid | `getFromUid()` 降级用 `from_uid` |

### 7.4 UI/UX 经验

| 偏好 | 说明 |
|------|------|
| 圆角 | 小圆角（4px/8px），Windows 11 风格 |
| 主题 | 浅色模式白卡片 + 浅灰背景，深色模式深蓝 `#16213e` |
| 滚动条 | 不显示原生滚动条，使用自定义美化滚动条 |
| 弹窗 | 自定义弹窗替代原生 `alert/confirm`，支持键盘快捷键 |
| 撤回 | 撤回消息显示"重新编辑"链接（仅自撤回可恢复） |
| 连续消息 | 同一发送者的消息合并显示，无重复头像/昵称 |
| 输入指示 | 对方输入时显示小头像 + 三个动画点，5s 超时 |
| 拖拽排序 | 鼠标按下延迟 300ms 确认点击/拖拽意图 |

---

## 八、Tauri Capabilities 配置

`src-tauri/capabilities/default.json` 定义了所有权限：

```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "notification:default",
    "dialog:default",
    {
      "identifier": "http:default",
      "allow": [
        { "url": "http://oc.mcl0.dpdns.org/**" },
        { "url": "http://60.205.94.101:8080/**" },
        { "url": "http://60.205.94.101/**" },
        { "url": "http://files.mcl0.dpdns.org/**" },
        { "url": "https://**" }
      ]
    }
  ]
}
```

**添加新域名规则**：如果新增了资源服务器，必须在这里加入白名单，否则 `plugin-http` 会拒绝请求。

---

## 九、Rust 命令列表

`src-tauri/src/lib.rs` 中注册的命令：

| 命令 | 功能 | 备注 |
|------|------|------|
| `greet` | 测试命令 | - |
| `toggle_devtools` | 切换 DevTools | Ctrl+Alt+Shift+F12 |
| `minimize_window` | 最小化窗口 | - |
| `toggle_maximize_window` | 切换最大化 | - |
| `close_window` | 关闭窗口（实际隐藏到托盘） | - |
| `is_window_maximized` | 查询是否最大化 | 前端用于切换还原图标 |
| `notify_new_message` | 新消息通知 | 托盘通知/任务栏闪烁 |
| `save_image` | 通过 URL 下载图片 + 保存对话框 | HTTP URL 专用 |
| `save_image_data` | 直接保存二进制数据 | blob URL 转数据后使用 |

---

## 十、运行与调试

### 10.1 启动开发环境

```bash
# 前置条件：已安装 Node.js、Rust、Visual Studio Build Tools
npm run tauri dev
```

### 10.2 调试技巧

| 场景 | 操作 |
|------|------|
| 修改前端代码 | 按 `Ctrl+R` 刷新 WebView |
| 修改 Rust 代码 | 保存后自动增量编译（几秒） |
| 修改 capabilities | 保存后自动重新编译（几秒） |
| 修改 tauri.conf.json | 保存后自动重新编译 |
| 打开 DevTools | `Ctrl+Alt+Shift+F12` |
| 查看前端 console | DevTools Console 面板 |
| 查看 Rust 日志 | 终端输出 |

### 10.3 浏览器模式（已废弃）

> ⚠️ **注意**：浏览器模式（Nginx 反代）已废弃，以下内容仅作参考，相关代码保留未动。

如果想用浏览器调试前端（不用 Tauri）：

```bash
# 启动一个简单的 HTTP 服务器
npx http-server src/ -p 8080
# 然后需要 Nginx 反代后端（参考 conf/nginx.conf）
```

注意：浏览器模式下 WebSocket 需要 Nginx 配置反代，且无 `plugin-http` 功能。

---

## 十一、已知限制与待办

### 11.1 已知限制

- **单文件架构**：所有前端逻辑在一个 JS 文件中（7372 行），维护困难
- **无类型系统**：纯 JS，无 TypeScript 类型检查
- **无单元测试**：无自动化测试
- **无打包优化**：直接用静态文件，未压缩
- **仅支持 Windows**：虽然 Tauri 跨平台，但目前仅在 Windows 上测试
- **无自动更新**：未实现 Tauri updater

### 11.2 可能的改进方向

- 拆分 `app.js` 为多个模块（ES Module 或 IIFE 分文件）
- 添加 TypeScript 类型检查
- 添加 ESLint 代码规范
- 引入 Vite 做构建优化
- 添加单元测试（Vitest/Jest）
- 实现自动更新
- 添加多语言支持

### 11.3 性能注意

- `userProfileCache` 是全局单例，任何页面都可以读写
- `pendingProfileFetches` 防止同用户并发拉取
- `cachedResolveMediaUrl` 缓存 URL 转换结果
- 音乐列表缓存（`musicListCache`）防止重复拉取
- 联系人列表缓存（`contactListCache`）带过期时间

---

## 十二、关键代码位置索引

| 功能 | 文件 | 位置 |
|------|------|------|
| Tauri 检测 | `src/app.js` | L4-L9 |
| fetch 重写（plugin-http） | `src/app.js` | L12-L100 |
| API 请求封装 | `src/app.js` | `apiFetch()` L989 |
| 用户资料缓存 | `src/app.js` | L1190 附近 |
| `resolveMediaUrl` | `src/app.js` | L250 |
| 消息渲染 | `src/app.js` | `createMessageElement()` |
| WebSocket 连接 | `src/app.js` | `connectWebSocket()` |
| 图片查看器 | `src/app.js` | `openImageViewer()` L688 |
| 图片下载 | `src/app.js` | `downloadImage()` L576 |
| Rust 命令 | `src-tauri/src/lib.rs` | 全文件 |
| 权限配置 | `src-tauri/capabilities/default.json` | 全文件 |
| 主题变量 | `src/app.css` | `:root` 选择器 |
| 深色主题 | `src/app.css` | `[data-theme="dark"]` 选择器 |

---

## 附录 A：用户配置

用户信息存储在 `localStorage` 中：

```json
{
  "oc_user": {
    "uid": "...",
    "ncuid": "...",
    "token": "...",
    "refresh_token": "...",
    "nickname": "...",
    "avatar": "...",
    "user_title": "..."
  }
}
```

## 附录 B：字体与图标

- 图标：Font Awesome 6.x（Solid/Regular/Brands 三套）
- 自定义字体：`zyyt.woff2`
- 滚动条：`dumogu-scrollbar.umd.min.js`（第三方）

---

*文档版本：v1*  
*最后更新：2026-08-07*  
*适用项目：oldchat-kivotos-next-app v0.1.0*
