# Oldchat CIP（Chat Integration Package）Lua 小程序开发规范

本文档面向 AI 编程助手和开发者，用于生成可上传到 Oldchat 服务端、并自动显示在客户端“发现”页的 Lua 小程序包。

## 1. CIP 是什么

CIP 是一个 ZIP 文件，仅把扩展名改为 `.cip`。服务端不会执行上传过程中的任何程序，只读取固定文件：

```text
my_app.cip
├── manifest.json   # 必需：应用信息、版本、权限
├── main.lua        # 必需：入口脚本，UTF-8，最大 512 KiB
└── assets/         # 可选：静态资源
    ├── icon.png
    ├── banner.webp
    └── data.json
```

不要额外套一层目录。`manifest.json` 和 `main.lua` 必须位于压缩包根目录。

## 2. 安全限制

- CIP 压缩文件最大 2 MiB，解压后最大 8 MiB。
- 最多 128 个文件。
- 禁止绝对路径、`..`、反斜杠路径和符号链接式路径穿越。
- `assets/` 只允许：`.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.json`、`.txt`、`.md`。
- Lua 无 `io`、`os`、`debug`、`package`、`require`、`dofile`、`loadfile`、`luajava`。
- 不能调用 Java 反射、Shell、任意文件、APK、DEX 或系统命令。
- Android 能力必须在 manifest 声明，并且只能调用宿主开放的桥接。

## 3. manifest.json

完整示例：

```json
{
  "id": "weather_card",
  "name": "天气卡片",
  "description": "查看当前城市天气",
  "version": 1,
  "icon_url": "assets/icon.png",
  "enabled": true,
  "order": 50,
  "permissions": ["network", "storage"]
}
```

字段规则：

| 字段 | 必需 | 说明 |
|---|---:|---|
| `id` | 是 | 1～64 位，只允许小写字母、数字、`_`、`-`；发布后不要改变 |
| `name` | 是 | 发现页名称，最多 40 个字符 |
| `description` | 否 | 最多 200 个字符 |
| `version` | 是 | 正整数；脚本或资源改变时递增 |
| `icon_url` | 否 | `assets/...` 或 HTTP(S) URL；上传后本地资源转换为 `/lua-assets/<id>/...` |
| `enabled` | 是 | `true` 才会下发到客户端 |
| `order` | 否 | 数字越小越靠前 |
| `permissions` | 是 | 只允许 `network`、`network_external`、`storage`、`camera` |
| `allowed_hosts` | 否 | 可选的外网收紧白名单；最多 32 项，支持 `*` 或 `*.example.com`；省略表示允许任意公网域名 |

`sha256` 和 `script_url` 由服务端生成，禁止在包中依赖自填值。

## 4. main.lua 页面入口

脚本必须返回一个页面 table：

```lua
return ui.page({
  title = "示例",
  children = {
    ui.text({ text = "你好，Oldchat", size = 18 }),
    ui.button({
      text = "点击",
      on_click = function()
        app.toast("按钮已点击")
      end
    })
  }
})
```

Lua table 数组从 1 开始。不要返回 Java 对象，不要创建无限循环，不要在入口执行长时间计算。

## 5. 原生 UI DSL

### 5.1 页面

```lua
ui.page({ title = "标题", children = { ... } })
```

### 5.2 文本

```lua
ui.text({
  id = "status",
  text = "加载中",
  size = 15,
  color = "#6FACC9",
  center = true,
  margin = 6
})
```

### 5.3 按钮

```lua
ui.button({
  text = "刷新",
  on_click = function()
    app.set_text("status", "已刷新")
  end
})
```

### 5.4 图片

```lua
ui.image({
  id = "preview",
  url = "https://example.com/image.jpg",
  height = 180,
  margin = 6,
  on_click = function() app.toast("图片") end
})
```

资源图片可以使用完整 URL。推荐通过 `app.asset("banner.webp")` 获得包内资源地址：服务器包会返回当前服务器 `/lua-assets/<id>/...`，本地导入包会返回沙箱私有文件 URI。

```lua
ui.image({ url = app.asset("banner.webp"), height = 180 })
```

### 5.5 输入框

输入框支持读取当前值以及三类原生事件：

```lua
local saved = app.storage_get("draft") or ""

ui.input({
  id = "keyword",
  hint = "请输入内容",
  text = saved,
  single_line = false,
  input_type = "text", -- text/password/number/email/phone
  max_length = 2000,
  on_change = function(value)
    -- 每次文字变化触发，适合实时更新界面；频繁联网应自行避免。
    app.set_text("counter", "当前 " .. tostring(string.len(value)) .. " 字节")
  end,
  on_focus_lost = function(value)
    app.storage_set("draft", value)
    app.toast("草稿已保存")
  end,
  on_submit = function(value)
    -- single_line=true 时点击键盘完成/发送触发。
    app.storage_set("draft", value)
  end
})
```

也可以在按钮回调中主动读取用户当前输入：

```lua
local value = app.get_text("keyword")
if value then app.storage_set("draft", value) end
```

事件回调接收输入框的最新文本。旧版不带事件的 `ui.input` 保持兼容。

### 5.6 复选框

```lua
ui.checkbox({
  id = "remember",
  text = "记住输入",
  checked = app.storage_get("remember") == "true",
  on_change = function(checked)
    app.storage_set("remember", checked and "true" or "false")
  end
})
```

可通过 `app.get_checked(id)` 读取，或 `app.set_checked(id, boolean)` 修改。

### 5.7 列表/容器与间距

```lua
ui.list({
  children = {
    ui.text({ text = "第一项" }),
    ui.spacer({ height = 12 }),
    ui.text({ text = "第二项" })
  }
})
```

所有控件可用 `margin`；支持 `id` 的控件可以被受控更新 API 修改。

## 6. 宿主 app API

### Toast

```lua
app.toast("操作成功")
```

### 页面更新

```lua
local current = app.get_text("keyword") -- TextView/EditText/Button 当前文本；控件不存在返回 nil
app.set_text("status", "新文本")
app.set_image("preview", "https://example.com/new.jpg")
app.set_visible("status", false)
app.set_enabled("keyword", true)
local visible = app.get_visible("status")
app.append_text("status", "追加内容")
app.set_hint("keyword", "新的输入提示")
app.focus("keyword")
```

### 独立存储（需要 `storage`）

每个应用拥有独立键值空间，不能访问其他应用或 Oldchat 数据：

```lua
local old = app.storage_get("count") or "0"
app.storage_set("count", tostring(tonumber(old) + 1))
app.storage_remove("temporary_key")
-- app.storage_clear() 只清空当前 CIP 自己的存储
```

键和值应保持简短；不要存储令牌、密码或大文件。

### JSON 与延时任务

```lua
local data = app.json_decode('{"name":"Oldchat","items":[1,2,3]}')
if data then app.set_text("status", data.name) end

local encoded = app.json_encode({ ok = true, values = { 1, 2, 3 } })
app.delay(500, function() app.toast("500ms 后执行") end)
```

JSON 最多嵌套 12 层、单个对象或数组最多 4096 项；`delay` 最大 60 秒，不提供后台常驻能力。

### 同服务器 HTTP GET（需要 `network`）

```lua
app.http_get("/me", function(body, err)
  if body then
    app.set_text("status", "请求成功")
  else
    app.toast(err or "请求失败")
  end
end)
```

只允许以 `/` 开头的当前 Oldchat API 路径；禁止 `://` 和 `..`。请求自动使用当前登录令牌。回调参数为 `(body, err)`，成功时 `err=nil`。

### 外部 HTTP/HTTPS API（需要 `network_external`）

在 `manifest.json` 中声明外部网络权限即可访问任意公网域名：

```json
{
  "permissions": ["storage", "network_external"]
}
```

然后仍使用 `app.http_get`：

```lua
app.http_get("https://api.example.com/weather", function(body, err)
  if body then
    app.set_text("status", body)
  else
    app.toast(err or "外部 API 请求失败")
  end
end)

-- 普通 HTTP 公网地址同样支持
app.http_get("http://api.example.net/status", function(body, err)
  app.set_text("status", body or (err or "请求失败"))
end)
```

同时支持 `http://` 和 `https://`，包括显式公网端口。`allowed_hosts` 是可选的收紧策略，例如 `["api.example.com", "*.example.net"]`；也可写 `["*"]` 明确表示任意公网域名。安全限制：响应最多 512 KiB；不跟随重定向；禁止 localhost、局域网、链路本地、组播和私有 IPv6。Oldchat 登录令牌绝不会发送到外部域名。

### 相机（需要 `camera`）

```lua
app.camera(function(uri, err)
  if uri then
    app.set_image("preview", uri)
  else
    app.toast(err or "拍照失败")
  end
end)
```

宿主负责运行时权限和 MediaStore。用户拒绝权限或取消拍照都必须正常处理。

### 返回

```lua
app.back()
```

## 7. AI 生成 CIP 的推荐步骤

向 AI 提需求时同时提供本文档，并要求它严格执行：

1. 先列出页面、事件、网络和权限需求。
2. 只申请实际使用的权限；纯展示页面权限数组应为空。
3. 生成合法 `manifest.json`。
4. 生成单入口 `main.lua`，必须 `return ui.page(...)`。
5. 所有异步回调同时处理成功和失败。
6. 不使用未在本文档列出的 Lua/Android API。
7. 将根目录文件直接压缩为 ZIP，再改名 `.cip`。
8. 上传前检查包大小、路径、文件扩展名和 JSON 语法。

示例打包命令：

```bash
cd weather_card
zip -r ../weather_card.cip manifest.json main.lua assets
```

如果没有 assets：

```bash
zip ../hello.cip manifest.json main.lua
```

## 8. 客户端本地导入

客户端发现页提供“导入本地 CIP”。本地包执行与服务器包相同的大小、路径、扩展名和权限校验，并存入 `local_` 独立命名空间，服务器同步不会覆盖。不要从不可信来源导入；即使 Lua 处于沙箱，脚本仍可在声明权限后发起同服务器请求、写入自身存储或请求相机。

## 9. 管理接口

管理员先通过 `/admins/login` 登录并获得 `admin_session` Cookie。

### 上传/升级

```bash
curl -b admin.cookie \
  -F 'file=@weather_card.cip;type=application/zip' \
  http://SERVER/admins/lua/apps/upload
```

相同 `id` 会原子替换旧包；校验失败不会破坏旧版本。

### 列表

```text
GET /admins/lua/apps
```

### 启用/停用

```bash
curl -b admin.cookie -X POST \
  -d 'id=weather_card&enabled=false' \
  http://SERVER/admins/lua/apps/toggle
```

### 删除

```bash
curl -b admin.cookie -X POST \
  -d 'id=weather_card' \
  http://SERVER/admins/lua/apps/delete
```

### 客户端读取

登录用户通过以下接口自动同步：

```text
GET /v1/discover/lua/manifest
GET /v1/discover/lua/apps/{id}
GET /lua-assets/{id}/{asset-path}
```

## 10. 版本与回滚建议

- 每次发布递增 `version`。
- 上传前保留源 CIP 和变更记录。
- 客户端校验服务端 SHA-256，并保留最后可用脚本；新脚本下载或校验失败时继续使用缓存。
- 先在测试账号和测试设备验证文字、暗色模式、相机拒绝、离线状态及旧 Android，再启用生产入口。

## 11. API 速查表

### UI 控件

| 控件 | 必需属性 | 可选属性 | 事件 |
|---|---|---|---|
| `ui.page` | `children` | `title` | — |
| `ui.text` | — | `id`、`text`、`size`、`color`、`center`、`margin` | — |
| `ui.button` | `text` | `id`、`color`、`center`、`margin` | `on_click` |
| `ui.image` | — | `id`、`url`、`height`、`margin` | `on_click` |
| `ui.input` | — | `id`、`hint`、`text`、`single_line`、`input_type`、`max_length`、`margin` | `on_change(value)`、`on_focus_lost(value)`、`on_submit(value)` |
| `ui.checkbox` | `text` | `id`、`checked`、`margin` | `on_change(checked)` |
| `ui.list` | `children` | `margin` | — |
| `ui.spacer` | — | `height` | — |

`input_type` 取值：`text`（默认）、`password`、`number`、`email`、`phone`。

### 宿主 API

| API | 权限 | 参数 | 说明 |
|---|---|---|---|
| `app.toast(msg)` | — | `msg: string` | 短暂提示 |
| `app.back()` | — | — | 关闭小程序 |
| `app.asset(path)` | — | `path: string` | 返回包内资源 URL |
| `app.get_text(id)` | — | `id: string` | 返回控件当前文本，不存在返回 nil |
| `app.set_text(id, text)` | — | `id, text: string` | 设置控件文本 |
| `app.append_text(id, text)` | — | `id, text: string` | 追加文本 |
| `app.set_hint(id, hint)` | — | `id, hint: string` | 设置输入框提示 |
| `app.focus(id)` | — | `id: string` | 聚焦控件 |
| `app.get_checked(id)` | — | `id: string` | 返回复选框布尔值 |
| `app.set_checked(id, checked)` | — | `id: string, checked: bool` | 设置复选框 |
| `app.set_image(id, url)` | — | `id, url: string` | 设置图片 |
| `app.set_visible(id, visible)` | — | `id: string, visible: bool` | 显示/隐藏 |
| `app.get_visible(id)` | — | `id: string` | 返回是否可见 |
| `app.set_enabled(id, enabled)` | — | `id: string, enabled: bool` | 启用/禁用 |
| `app.storage_get(key)` | `storage` | `key: string` | 读取存储，返回 string 或 nil |
| `app.storage_set(key, value)` | `storage` | `key, value: string` | 写入存储 |
| `app.storage_remove(key)` | `storage` | `key: string` | 删除一个键 |
| `app.storage_clear()` | `storage` | — | 清空当前应用存储 |
| `app.json_decode(text)` | — | `text: string` | JSON 转为 Lua table，失败返回 nil |
| `app.json_encode(value)` | — | `value: table/string/number/bool` | Lua 值转为 JSON 字符串 |
| `app.delay(ms, fn)` | — | `ms: number, fn: function` | 延时执行，最大 60 秒 |
| `app.http_get(path, cb)` | `network` | 路径以 `/` 开头 | 请求 Oldchat API |
| `app.http_get(url, cb)` | `network_external` | `http://` 或 `https://` | 请求任意公网 API；`allowed_hosts` 可选 |
| `app.camera(cb)` | `camera` | `cb(uri, err)` | 拍照并返回 URI |

回调统一为 `function(body_or_result, err)`；成功时 `err=nil`，失败时第一个参数为 `nil`。

## 12. 完整示例：带自动保存的笔记应用

`manifest.json`：

```json
{
  "id": "quick_note",
  "name": "速记",
  "description": "输入框自动保存的笔记应用",
  "version": 1,
  "enabled": true,
  "order": 60,
  "permissions": ["storage"]
}
```

`main.lua`：

```lua
local saved = app.storage_get("note") or ""
local savedTime = app.storage_get("note_time") or ""

return ui.page({
  title = "速记",
  children = {
    ui.text({
      id = "status",
      text = savedTime ~= "" and ("上次保存：" .. savedTime) or "开始输入",
      size = 13,
      color = "#888888",
      margin = 8
    }),
    ui.input({
      id = "editor",
      hint = "在此输入笔记…",
      text = saved,
      max_length = 5000,
      on_focus_lost = function(value)
        app.storage_set("note", value)
        app.storage_set("note_time", os.date("%H:%M"))
        app.set_text("status", "已保存 " .. os.date("%H:%M"))
      end,
      on_submit = function(value)
        app.storage_set("note", value)
        app.toast("已保存")
      end
    }),
    ui.spacer({ height = 8 }),
    ui.button({
      text = "保存",
      on_click = function()
        local value = app.get_text("editor")
        if value then
          app.storage_set("note", value)
          app.storage_set("note_time", os.date("%H:%M"))
          app.set_text("status", "已保存 " .. os.date("%H:%M"))
          app.toast("保存成功")
        else
          app.toast("读取输入失败")
        end
      end
    }),
    ui.spacer({ height = 8 }),
    ui.button({
      text = "清空",
      on_click = function()
        app.storage_remove("note")
        app.storage_remove("note_time")
        app.set_text("editor", "")
        app.set_text("status", "已清空")
        app.toast("已清空")
      end
    })
  }
})
```

这个示例展示了：

- 用 `app.storage_get` 读取上次保存的草稿并设为输入框初始值。
- 用 `on_focus_lost` 在用户离开输入框时自动保存。
- 用 `app.get_text(id)` 在按钮回调中主动读取输入框当前内容。
- 用 `app.storage_remove` 清除指定键。
- 不需要任何网络权限，纯本地存储即可实现完整的自动保存功能。
