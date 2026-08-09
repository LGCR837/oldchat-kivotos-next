# OldChat For Kivotos Next — 项目记忆

## 项目定位
Tauri v2 跨平台桌面 IM 客户端，连接 OldChat 后端（Android `com.im.oldchat` v1.3.61 的 Web/Tauri 重写）。主力 Windows 10/11，出 Linux 构建。
- 产品名：**OldChat For Kivotos Next**；标识符 `aoharureverie.oldchat.kivotosnextapp`，productName `OldChat For Kivotos`（待同步带 Next）
- 作者/腐竹：**Aoharu Reverie**（署名排前）；LGCR837 是旧网名 / GitHub 用户名
- 仓库：`git@github.com:LGCR837/oldchat-kivotos-next.git`（公开；Codeberg `lgcr837/oldchat-kivotos` 为已弃用前身）
- 发布：GitHub Releases，标签 v1…v6；每版 5 产物 `windows-{amd64,arm64,i386}.exe` + `linux-{amd64,arm64}`，约 12–15MB 免安装单文件
- 前身：Python+Flask 网页版，仅继承 MomoTalk 界面风格，后端逻辑完全重写
- 官网：`docs/oldchatkivotos.l2.ink/`（未纳入 git）；Cloudflare Pages 项目 `oldchatkivotos`，域名 `oldchatkivotos.l2.ink`/`pages.dev`；部署 `npx wrangler pages deploy --branch=main --commit-dirty=true`（`--branch=main` 不可省）。OldChat 官网地址 `http://oc.mcl0.dpdns.org/`
- 协作偏好：**只改被点名的项 + 事实性错误**，不要顺手重写标题/副标题/slogan 等品牌调性文案
- 无 LICENSE 文件（继承 GPL-3.0 前身 UI，建议补）

## 技术栈
前端：纯原生 HTML/CSS/JS（无框架/无构建/无 TS）。壳层：Tauri v2（Rust）。图标 Font Awesome 6.x。

## 版本号（2026-08-09 起：本地写死，不再 CI 注入）
- `src-tauri/src/lib.rs` 的 `app_version` 命令**直接返回字符串 `"v7"`**（无 DEV 分支、不读 package_info）。关于页与检查更新均用此值。
- `src-tauri/tauri.conf.json` 的 `version` 字段固定 `"7.0.0"`（Tauri 要求合法 semver；仅构建内部用，与展示的 `v7` 解耦）。
- **已彻底移除**动态注入机制：`scripts/set-version.mjs` 已删除；`.github/workflows/release.yml` 两处 `node scripts/set-version.mjs` 步骤已删；`src/app.js` 的 `checkForUpdates` 恢复为原始字符串比对（`currentVersion === latestTag` / `findIndex(r => r.tag === currentVersion)`），`normVer()` 已移除。
- 下次发版若要升版本：改这两处（`"v7"` 与 `"7.0.0"`）即可，无需改 CI。

## 关键架构约束
1. **单文件前端**：所有逻辑在 `src/app.js`（约 7.4k 行）、`src/app.css`（约 3k 行），全局函数走 `window.xxx`。有意设计，勿引打包工具。
2. **仅 Tauri 单模式**：请求固定走 `tauri-plugin-http` 直连（无 CORS）。`IS_TAURI` 仅作「Tauri API 是否可用」守卫（fetch 重写/下载/窗口按钮/通知），不要再用它区分运行模式。
3. **候选地址降级**：`BACKEND_CANDIDATES`/`MEDIA_CANDIDATES` 按优先级排序，`apiFetch`→`_fetchWithCandidates` 遇网络错误/5xx 降到下一候选；`<img>` 媒体失败捕获阶段换源（`dataset.mediaTries` 防环）。默认：普通 `oc.mcl0.dpdns.org → https 版 → 60.205.94.101:8080`；媒体 `60.205.94.101:8080 → files.mcl0.dpdns.org → oc.mcl0.dpdns.org`。用户可在「设置→服务器配置」增删（localStorage `oc_custom_base_url`/`oc_custom_media_url`，空格分隔；改后 `refreshEndpoints()`+reload）。
   - ⚠️ 候选项一律「裸 origin 不含 /v1」，拼接必须 `base + url`（url 自带 /v1）。`_parseCandidates()` 已归一化（去尾 `/`、去 `/v1`、去重）。
   - 排查口诀：见到 `Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected non-whitespace character after JSON at position N` 报错，**先怀疑响应不是 JSON**（404/502 纯文本或 HTML）。
4. **NCUID 优先**：`?uid=` 只收旧 uid；`?ncuid=` 收 ncuid；POST body 的 to_uid/with_uid 两种都收。优先 ncuid。
5. **媒体 URL 走 `resolveMediaUrl()`**：头像(60.205.94.101:8080)、封面/媒体/emoji/音乐(files.mcl0.dpdns.org)。所有 URL 用 http:// 不用 https（后端无 TLS）。媒体候选顺序 60 优先（files 音乐加载慢）。**文件/图片下载接口已加权鉴**（需 Authorization 头）：下载走 Rust `save_download`/`save_image`（带 headers）或 `downloadFile()`（带 token fetch），不再 `_blank` 直开。
6. **新增资源域名**必须在 `src-tauri/capabilities/default.json` 的 http:default.allow 白名单添加，否则 plugin-http 拒绝。
7. **启动自检 `src-tauri/src/preflight.rs`**：在 `tauri::Builder` 之前跑，检测 WebView2/WebKitGTK/图形环境/托盘/数据目录。**绝不能用 tauri-plugin-dialog 报错**（它自己依赖 WebView2/GTK）；必须用 Win32 `MessageBoxW` 与 Linux zenity 降级链。保留两误报豁免：`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 非空豁免；Linux so 检测尽力而为。自测 `OLDCHAT_PREFLIGHT_DEMO=webview2|webkit|display|runtime`。
8. **多主题系统**：深浅轴用 `data-theme-mode`（light/dark）；CSS `:root,[data-theme-mode="light"]` 与 `[data-theme-mode="dark"]` 声明变量。默认主题 = `src/app.css` 自身（顶部 `@theme` 元数据）。用户主题 = 单文件 .css，存 `<app_config_dir>/themes/<id>.css`，Rust 命令 `import_theme`/`list_user_themes`/`delete_user_theme` 管理。改颜色优先加语义变量、勿硬编码。
9. **v2 API 迁移**：`mapToV2()` 按 `V1_TO_V2` 映射表换 /v2/；v2 需签名头 `X-Ts/X-Nonce/X-Sign/X-Device-Id`（HMAC-SHA256，密钥=ECDH 握手派生的 wsMacKey）。当前 `v2Enabled = false`（macKey 派生未对齐，待解决）。auth/*、music/*、emoji/plaza、checkin/wall、public-court、media 上传、direct|groups/unread、groups/message/send、messages/search、messages/after、WS 仍走 /v1。

## 后端地址
API 根 `http://oc.mcl0.dpdns.org/v1`；头像 `http://60.205.94.101:8080/v1/uploads/avatars/`；媒体 `http://files.mcl0.dpdns.org/`；WebSocket `ws://oc.mcl0.dpdns.org/ws`（重连 5s→10s→20s→30s）。

## 构建与运行
- 开发：`npm run tauri dev`（Rust 增量；前端 Ctrl+R；capabilities/tauri.conf 改需重启）。DevTools：Ctrl+Alt+Shift+F12
- 纯浏览器调试不再支持，一律 `npm run tauri dev`
- Rust 命令：greet, toggle_devtools, minimize_window, toggle_maximize_window, close_window(隐藏托盘), is_window_maximized, notify_new_message, save_image, save_download, save_image_data, env_report, **app_version(固定返回 "v7")**, import_theme/list_user_themes/delete_user_theme, import_plugin/list_user_plugins/read_plugin_source/delete_user_plugin

## 插件系统
用户插件 = 任意 .js，存 `<app_config_dir>/plugins/<id>.js`。启用状态 localStorage `oc_plugin_states`（新导入默认启用）。启动 `refreshUserPlugins()` 对启用者 `loadPlugin(id)`：`read_plugin_source` 取源码 → `(0,eval)(src)` 间接 eval 全局执行，try/catch 隔离。禁用需 `location.reload()` 生效。元数据文件头 `/* @plugin name: xxx */`（支持 description/author/version/id）。

## 已知限制 / 待办
单文件维护难、无类型系统/单测/打包优化、仅 Windows 测试、无自动更新。改进方向：拆模块、加 TS/ESLint/Vite、加测试、自动更新、多语言。启动前需 Node.js + Rust + VS Build Tools。

## 参考文档
- docs/aidocs/dev1.md — AI 接手文档 v1（前任编写，最全）
- docs/oldchat-docs-20260809/{mcl0,nx1,nx2,nx3}/ — 后端 API / Android 逆向架构文档
- docs/mcl0-new-docs/api202608100558.md — **官方完整 v2 服务端 API 文档（2026-08-10 发布，最权威）**：含基础约定/鉴权/ECDH 握手/v2 签名/WS/各业务接口表与返回示例、限流(24.2)。要点：朋友圈 `GET /v2/moments/comments?moment_id=` 仍**仅单条**、无批量评论接口、`moments/user` 未给 `comment_count` 字段 → 评论数 N+1 只能靠客户端懒加载规避，无服务端批量解；限流仅对 注册/登录/发码/上传下载 生效（媒体全局限速），对普通读接口无明确配额。v2 接口多需签名链（macKey，待解决，见约束9）。
