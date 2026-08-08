# OldChat For Kivotos — 项目记忆

## 项目定位
Tauri v2 跨平台桌面 IM 客户端，连接 OldChat 即时通讯后端（原版是 Android 客户端 `com.im.oldchat` v1.3.61 的 Web/Tauri 重写）。主力平台 Windows 10/11，同时出 Linux 构建。
- 产品名：**OldChat For Kivotos Next**（官网已统一用此名；`tauri.conf.json` 的 productName 仍是不带 Next 的旧名，待同步）
- 标识符：`aoharureverie.oldchat.kivotosnextapp`，版本 0.1.0
- 作者/腐竹：**Aoharu Reverie**（现用网名，署名一律排在前）；LGCR837 是旧网名，仅作括号补充与 GitHub 用户名
- **仓库**：`git@github.com:LGCR837/oldchat-kivotos-next.git`（GitHub，公开。**注意：Codeberg `lgcr837/oldchat-kivotos` 是前身项目，已弃用**）
- **发布**：GitHub Releases，标签 v1…v6（v6 = 2026-08-08）。每版 5 产物：`windows-amd64/arm64/i386.exe` + `linux-amd64/arm64`，约 12–15MB 免安装单文件
- **前身项目**：Python + Flask 网页版「OldChat for Kivotos」。本项目仅继承其 MomoTalk 界面风格，后端/接口逻辑完全重写、无关联
- **官网**：`docs/oldchatkivotos.l2.ink/`（**未纳入 git**，改前先备份）。布局：`wrangler.toml` + `functions/api/*.js` + `public/{index.html,style.css,script.js}`。OldChat 官网地址填 `http://oc.mcl0.dpdns.org/`（不是已废弃的 oldchat.online）
- **官网部署**：Cloudflare Pages 项目 `oldchatkivotos`（Direct Upload，生产分支 `main`，域名 `oldchatkivotos.l2.ink` / `oldchatkivotos.pages.dev`）。账号 `gengcr666@outlook.com` 已登录 wrangler 4.x。发布命令（在 `docs/oldchatkivotos.l2.ink/` 内）：`npx wrangler pages deploy --branch=main --commit-dirty=true`，**`--branch=main` 不可省**，否则只发 Preview、自定义域不更新
- **官网 API**（Pages Functions + KV `RELEASES` / id `aa4480ecc24e44319db7720cd82c3ee6` / key `releases:latest`）：`GET /api/releases` 读缓存 JSON；`POST /api/refresh` 拉 GitHub Releases 覆盖写入，`GET /api/refresh` 返回彩蛋 `upper(sqrt(-520)) Love You`(405)。下载直链由 tag 拼出：`https://github.com/LGCR837/oldchat-kivotos-next/releases/download/<tag>/oldchat-kivotos-next-app-<tag>-{windows-amd64.exe,windows-arm64.exe,windows-i386.exe,linux-amd64,linux-arm64}`
- **CF Pages 两个硬坑**：① `compatibility_date` 不能晚于 CF 服务端当天，否则部署失败；② `wrangler.toml` 若位于 `pages_build_output_dir` 内会被当静态资源上传，输出目录必须是子目录
- **协作偏好（重要）**：改文案/UI 时**只改被点名的项 + 事实性错误**，不要顺手重写标题、副标题、slogan 等品牌调性文案——腐竹明确反馈过"没让你改这么多，反而变丑了"
- 无 LICENSE 文件，但因继承 GPL-3.0 前身 UI 代码属衍生作品，对外仍标 GPL-3.0（建议补 LICENSE）

## 技术栈
- 前端：纯原生 HTML/CSS/JS（无框架、无构建工具、无 TypeScript）
- 壳层：Tauri v2（Rust），src-tauri/src/lib.rs 注册 Rust 命令
- 图标：Font Awesome 6.x；自定义滚动条 dumogu-scrollbar
- ~~反代 Nginx~~：浏览器模式已于 2026-08-08 彻底移除，仓库不含任何 Nginx 内容

## 关键架构约束（务必遵守）
1. **单文件前端架构**：所有业务逻辑在 `src/app.js`（约 7372 行），`src/app.css`（约 3032 行）。全局函数，通过 window.xxx 暴露。有意设计，勿擅自引入打包工具。
2. **仅 Tauri 单模式**（2026-08-08 起）：请求固定走 `tauri-plugin-http` 直连后端（无 CORS）。`WS_HOST = BACKEND_HOST`、`MEDIA_BASE = MEDIA_ORIGIN`，无同源反代分支。`IS_TAURI` 仅作「Tauri API 是否可用」守卫（fetch 重写 / downloadImage / 窗口按钮 / 通知），**不要再用它区分运行模式**。
8. **候选地址降级架构**（2026-08-09 起）：`BACKEND_CANDIDATES` / `MEDIA_CANDIDATES` 按优先级排序，`apiFetch` → `_fetchWithCandidates` 遇网络错误 / 5xx 自动降到下一个候选；`<img>` 媒体失败在捕获阶段换源（`dataset.mediaTries` 防环）。默认：普通内容 `oc.mcl0.dpdns.org → https 版 → 60.205.94.101:8080`；媒体 `60.205.94.101:8080 → oc.mcl0.dpdns.org → https 版`。用户可在「设置 → 服务器配置」增删候选（localStorage `oc_custom_base_url` / `oc_custom_media_url`，空格分隔；改后 `refreshEndpoints()` + reload）。
   - ⚠️ **候选项一律是「裸 origin，不含 `/v1`」**，拼接必须 `base + url`（url 自带 `/v1`）。曾因写成 `base + url.slice(3)` 把 `/v1` 吃掉，导致全部接口 404、纯文本 `404 page not found` 让 `res.json()` 抛出极难懂的 `Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected non-whitespace character after JSON at position 4`。`_parseCandidates()` 已做归一化（去尾 `/`、去 `/v1`、去重）。`API_BASE` 已无调用方，仅保留兼容。
   - 排查口诀：见到上述 ReadableStream/JSON position N 报错，**先怀疑响应压根不是 JSON**（404/502 纯文本或 HTML），不要去查 Tauri sentinel 流协议或 `res.clone()`。
3. **NCUID 优先**：OldChat 有 uid/ncuid 两套 ID。`?uid=` 只接受旧 uid；`?ncuid=` 接受 ncuid；POST body 的 to_uid/with_uid 同时接受两种。所有逻辑优先用 ncuid，仅在 `?uid=` 场景降级。
4. **媒体 URL 统一走 `resolveMediaUrl()`**：映射头像(60.205.94.101:8080)、封面/媒体/emoji/音乐(files.mcl0.dpdns.org) 等。所有 URL 用 http:// 不用 https（后端无 TLS）。
5. **CDN 节流**：`files.mcl0.dpdns.org` 是付费 CDN，腐竹要求第三方客户端尽量少用，优先用 60.205.94.101:8080（头像）。
6. **新增资源域名**必须在 `src-tauri/capabilities/default.json` 的 http:default.allow 白名单中添加，否则 plugin-http 拒绝。
7. **启动自检 `src-tauri/src/preflight.rs`**（2026-08-08 起）：在 `tauri::Builder` **之前**跑，检测 WebView2/WebKitGTK/图形环境/托盘依赖/数据目录。**绝不能改用 tauri-plugin-dialog 报错**——它自己就依赖 WebView2/GTK；必须用 Win32 `MessageBoxW` 与 Linux 的 zenity 降级链。两处误报陷阱务必保留：`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 非空要豁免（企业固定版本部署）；Linux so 检测只是尽力而为（缺库通常在动态链接期就挂了）。自测：`OLDCHAT_PREFLIGHT_DEMO=webview2|webkit|display|runtime`。

## 后端地址
- API 根：`http://oc.mcl0.dpdns.org/v1`（Go 实现）
- 头像：`http://60.205.94.101:8080/v1/uploads/avatars/`
- 媒体/封面/音乐：`http://files.mcl0.dpdns.org/`
- WebSocket：`ws://oc.mcl0.dpdns.org/ws`（自动重连 5s→10s→20s→30s）

## 构建与运行
- 开发：`npm run tauri dev`（Rust 增量编译；前端 Ctrl+R 刷新；capabilities/tauri.conf 修改需重启）
- DevTools：Ctrl+Alt+Shift+F12
- 纯浏览器调试**不再支持**（强依赖 plugin-http 与 Rust 命令），一律用 `npm run tauri dev`
- Rust 命令：greet, toggle_devtools, minimize_window, toggle_maximize_window, close_window(隐藏到托盘), is_window_maximized, notify_new_message, save_image, save_image_data, env_report(系统/WebView版本+自检告警)

## 已知限制 / 待办
- 单文件维护难、无类型系统、无单元测试、无打包优化、仅 Windows 测试、无自动更新
- 改进方向：拆 app.js 模块、加 TS/ESLint、引入 Vite、加测试、自动更新、多语言
- 启动前需 Node.js + Rust + VS Build Tools

## 参考文档
- docs/aidocs/dev1.md — AI 接手文档 v1（前任 DeepSeek-V4-Flash 编写，最全）
- docs/oldchat-docs-20260801/mcl0/ — 后端 API 文档（api.md 规范、client.md、oauth.md、routes.md、lua-cip.md）
- docs/oldchat-docs-20260801/nx/ — Android 客户端逆向架构文档（00 总览 ~ 08 加密）
