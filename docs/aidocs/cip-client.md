# CIP（Lua 小程序）客户端实现 — P0 可行性验证版

对应服务端 / 打包规范见 `docs/mcl0-new-docs/lua-cip.md`。本文只讲**桌面端怎么跑起来的**、
现在到哪一步了、以及下一步要补什么。

---

## 1. 结论：可行

Android 端用的是 LuaJ；桌面端没有 JVM，也不想为了跑 Lua 引入 Rust 侧 mlua 再拉一条
IPC 链路，所以 P0 选了 **fengari**（纯 JS 实现的 Lua 5.3 VM），整个 VM 跑在 WebView 里，
宿主 API 用 JS 直接注册成 Lua 的 cfunction。

已在离线测试中跑通的能力：

- `ui.page{...}` 声明式 UI 树 → 解析成 JS 对象 → 渲染成 DOM
- `on_click` 回调（Lua function 存进 registry，点击时 `lua_pcall` 回调）
- `app.toast` / `app.storage_get` / `app.storage_set` / `app.json`
- `app.http_get(path, callback)` 异步回调（回调在 JS Promise resolve 后再进 Lua）
- 指令预算（`lua_sethook` + `LUA_MASKCOUNT`）防死循环

---

## 2. 模块划分

| 文件 | 职责 |
|---|---|
| `src/assets/vendor/fengari/fengari-web.js` | fengari 浏览器 bundle（打包产物，见第 4 节） |
| `src/cip/engine.js` | Lua state 生命周期、沙箱、`ui.*` / `app.*` 注册、Lua↔JS 值转换、registry ref 回调 |
| `src/cip/host.js` | `app.*` 的真实行为实现（toast / storage / http / camera / back），DOM 无关 |
| `src/cip/render.js` | UI 树 → DOM，`id` 注册表供 `app.set_text` / `app.set_image` 用 |
| `src/cip/cip.js` | 调试器控制器：拉清单 → 拉脚本 → sha256 校验 → 执行 → 渲染 |

加载顺序在 `src/index.html` 里固定为 fengari → engine → host → render → cip → app.js，
**fengari 必须在 engine 之前**，overlay DOM 必须在这些 script 之前（app.js 是同步绑定事件的）。

### engine.js 里几个容易踩的点

- **读数组不能用 `lua_next`**：它的遍历顺序不保证，UI 子节点会乱序。必须
  `lua_rawlen(L, idx)` 拿长度后按 `1..n` 整数索引读。
- **标量要还原真实 JS 类型**：`LUA_TSTRING → to_jsstring`、`LUA_TNUMBER → lua_tonumber`、
  `LUA_TBOOLEAN → lua_toboolean`。全部当字符串读会让 `checked = false` 变成真值。
- **回调不是 Promise/coroutine**：Lua 侧传进来的是 function 值，用 `luaL_ref(L, LUA_REGISTRYINDEX)`
  存成整数 ref，JS 侧异步完成后 `lua_rawgeti` 取回再 `lua_pcall`。
- 沙箱：置空 `os.execute/getenv/rename/remove/setlocale/tmpname/exit` 与 `_G.dofile/loadfile`，
  保留 `os.date/time/clock/difftime`。`io` 和 `package` 在打包阶段就整个摘掉了。

---

## 3. 入口与网络

- 入口：**设置 → 开发者 → Lua 小程序调试器**（`window.CipController.open()`）。
  overlay 三大金刚键：最小化/最大化走 `invoke`，关闭键只关 overlay；ESC 也能关。
- 接口：`GET /v1/discover/lua/manifest` → `{apps:[{id,name,description,version,enabled,order,permissions,sha256,script_url}]}`；
  `GET /v1/discover/lua/apps/{id}` → `{id,version,sha256,script}`，脚本是**内联**的，不用再按 `script_url` 取一次。
  （`script_url` 是相对路径 `/discover/lua/apps/xxx`，不含 `/v1`。）
- 请求一律走 `window.__tauriHttpFetchImpl`（Rust 侧 plugin-http，无 CORS）；用 `window.fetch` 会被 CORS 拦。
- 后端源不写死，运行时读 app.js 的 `BACKEND_ORIGIN`，跟随设置页的候选配置走。
- `window.__cipHttpGet(url)` 约定 **resolve 出正文字符串**（不是 Response）。只有目标是本后端源时才附
  `Authorization`，避免把 token 漏给小程序指定的第三方地址。

---

## 4. 重新打包 fengari

```bash
node scripts/build-fengari.mjs
```

fengari 的 npm 包没有浏览器 bundle，而且它靠 `typeof process` 区分 Node / 浏览器分支。
browserify 会自动注入 process polyfill，于是 bundle 会**错误地走进 Node 分支**，加载时
`require('fs')` 直接炸（典型报错 `Cannot read properties of undefined (reading 'O_CREAT')`）。

脚本做的两件事：

1. 把 `node_modules/fengari/src/*.js` 里所有 `typeof process === "undefined"` 钉成 `true`、
   `typeof process !== "undefined"` 钉成 `false`；
2. 从 `linit.js` / `lualib.js` 里摘掉 `io`（依赖 fs）和 `package`（依赖 child_process，且能任意加载模块）。

然后才是普通的 `browserify cip-entry.js --standalone fengari`。产物末尾有冒烟检查，
残留 `require('fs')` 会直接报错。构建目录 `.fengari-build/` 已 gitignore，**产物必须提交**。

> 试过但走不通的路：给 fs / child_process 打 shim（fengari 在模块顶层就取 `fs.constants`，
> shim 得几乎复刻一份）；`browser` 字段映射；`--no-builtins`；esbuild（二进制下载失败）。
> 直接改源码钉死分支是最干净的。

---

## 5. 现状与缺口

已完成（P0 + 本轮增强，对照 nx8 权威规范）：
- 引擎 / 宿主 / 渲染 / 调试器入口 / sha256 校验 / 打包链路。
- **UI 控件 14/14 全覆盖**（`page/text/image/button/input/checkbox/list/spacer/column/row/scroll/card/divider/progress`）。
- **权限系统强制**：`manifest.permissions` 实际限制 `app.*` API（storage / network / network_external / camera），缺权限回调报错或返回 nil；`network_external` 走 `allowed_hosts` 白名单校验（`*` 或空=全部）。
- **`app.*` API 对齐 nx8**：`http_get`(同服) / `http_request`(通用 method/headers/json/body，走 plugin:http 绕 CORS) / `asset`(本地 data URI / 远程 `/lua-assets/<id>/`) / `json_encode`·`json_decode` / `url_encode` / storage 系列(`get/set/remove/clear/keys/count/get_json/set_json`) / 控件操作(`get_text/append_text/set_hint/focus/get_checked/set_checked/set_visible/get_visible/set_enabled`)。
- **`.cip` 本地包资源**：Rust `read_cip_assets` 把包内资源转 data URI，JS 端 `app.asset()` 解析（兼容 `assets/` 前缀）。
- **`app.camera` 桌面替代**：Rust `cip_pick_image` 弹文件框选图，返回 data URI。
- 指令预算 hook / 沙箱（`os`/`dofile`/`loadfile` 已剥离）沿用。

还没做（本轮未选 / 待验证）：
- **发现页集成**：仍只有设置页「Lua 小程序调试器」入口，未接进「发现 → 小程序」列表（用户本轮未选）。
- **远程包资源离线验证**：服务端 `/lua-assets/<id>/<path>` 路由仅在线小程序可用，本地无法离线验证资源路由。
- **Rust 改动待构建验证**：`read_cip_assets`/`cip_pick_image` 已加但本沙箱无法 `tauri dev` 编译，需在用户机 `npm run tauri dev` 验证。

备选方案：Rust 侧用 mlua 跑 Lua，安全边界更硬（真正的内存/指令限制、可控 FFI），
但要新增一整套 IPC 协议来传 UI 树和回调。P0 没走这条路，规模化时可以重新评估。
