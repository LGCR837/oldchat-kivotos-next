# Oldchat 后端 API 标准格式

> 本文档以当前 Go 后端实现为准，用于约束新接口开发和旧接口渐进升级。
>
> 适用范围：`server/internal/http/`、Android 客户端及其他受信任客户端。

## 1. 基本约定

### 1.1 API 根路径

正式 API 使用：

```text
/v1
```

后端暂时保留以下兼容根路径：

```text
/v1/v1
```

新代码、新客户端和新文档不得继续生成 `/v1/v1` 地址。

### 1.2 数据格式

除文件上传、文件下载和 WebSocket 外，请求与响应统一使用 UTF-8 JSON：

```http
Content-Type: application/json
Accept: application/json
```

JSON 字段使用小写蛇形命名：

```text
created_at
from_uid
group_id
has_more
```

不得在同一接口中新增驼峰字段。

### 1.3 HTTP 方法

| 方法 | 用途 |
|---|---|
| `GET` | 获取资源，不创建或修改业务资源 |
| `POST` | 创建资源、执行动作、复杂条件查询 |
| `DELETE` | 删除资源 |
| `PUT/PATCH` | 新接口需要完整或部分更新时使用 |

历史代码中部分“已读”“未读同步”等动作使用 `POST`，兼容接口继续保留；新接口应保持语义明确。

## 2. 请求头

### 2.1 身份认证

需要登录的接口必须携带：

```http
Authorization: Bearer <access_token>
```

服务端从认证上下文获取内部用户 ID、UID、NCUID 等身份信息。不得信任客户端在 JSON 中提交的发送者身份。

### 2.2 压缩

普通响应可请求 HTTP gzip：

```http
Accept-Encoding: gzip
```

上传文件、媒体下载、更新包、音乐封面和 WebSocket 不使用 JSON gzip 中间件。

### 2.3 会话加密

支持会话加密的客户端发送：

```http
X-Enc: 1
X-Session: <session_id>
```

请求体是加密信封时，服务端解密后再交给业务处理器。加密响应格式由 `internal/secure` 统一生成，业务处理器不得自行加密字段。

新版客户端可协商“先压缩明文，再加密”：

```http
X-Enc-Compression: gzip
```

服务端仅在明文响应不小于 512 字节且压缩后确实更小时启用，并在响应中返回：

```http
X-Enc: 1
X-Session: <session_id>
X-Enc-Compression: gzip
```

正确处理顺序：

```text
响应：JSON → gzip（可选）→ 加密
客户端：解密 → gunzip（响应头声明时）→ JSON 解析
```

禁止对加密后的随机密文再次进行无效 gzip。

### 2.4 客户端 IP

限速和安全审计使用服务端统一的 `clientIP(r)`：

1. 受信任代理传入的 `X-Forwarded-For` 首个地址；
2. 否则使用 `RemoteAddr`。

业务处理器不得自行解析另一套 IP 规则。

## 3. 成功响应

### 3.1 原则

当前后端不强制使用统一的 `data` 外层信封。为保持旧客户端兼容，成功响应直接返回资源对象或具有明确名称的顶层字段。

单对象示例：

```json
{
  "id": "message_id",
  "group_id": "GRP-ABCD1234",
  "from_uid": "USR-ABCD1234",
  "body": "你好",
  "msg_type": "text",
  "created_at": 1785123456
}
```

列表响应不得直接返回裸数组，应使用具有业务含义的字段：

```json
{
  "messages": [],
  "has_more": false
}
```

动作成功可返回：

```json
{
  "status": "ok"
}
```

### 3.2 空列表

列表为空时必须返回空数组，不得返回 `null`：

```json
{
  "messages": [],
  "has_more": false
}
```

### 3.3 可选字段

仅确实没有值时才能省略带 `omitempty` 的字段。客户端必须能区分：

- 字段不存在：服务端或旧版本不支持；
- 空字符串：字段存在但内容为空；
- `0`：合法数值或默认值；
- `null`：明确没有时间、对象或状态。

新增响应字段必须保证旧客户端忽略后仍能正常工作。

## 4. 错误响应

所有 JSON API 错误统一使用当前后端 `writeError` 格式：

```json
{
  "error": "human readable message",
  "code": "machine_readable_code"
}
```

字段含义：

| 字段 | 用途 |
|---|---|
| `code` | 稳定、可供程序判断的错误码，不应随文案变化 |
| `error` | 面向日志或用户的简短英文描述 |

错误码使用小写蛇形：

```text
invalid_json
unauthorized
invalid_uid
not_friends
not_member
group_not_found
rate_limited
db_error
```

客户端不得依赖 `error` 文案进行分支判断，只能判断 HTTP 状态码和 `code`。

### 4.1 HTTP 状态码

| 状态码 | 使用场景 |
|---|---|
| `200 OK` | 查询、更新或动作成功 |
| `201 Created` | 新资源创建成功 |
| `204 No Content` | 无响应体的删除或动作成功 |
| `400 Bad Request` | JSON、字段、ID、游标或业务参数非法 |
| `401 Unauthorized` | Access Token 缺失、过期或无效 |
| `403 Forbidden` | 已登录但不是好友、群成员或无对应权限 |
| `404 Not Found` | 用户、群、消息或资源不存在 |
| `409 Conflict` | 状态冲突、重复创建或幂等键冲突 |
| `413 Payload Too Large` | 请求体或上传文件超限 |
| `429 Too Many Requests` | IP、用户或动作频率超限 |
| `500 Internal Server Error` | 数据库或服务端内部错误 |
| `503 Service Unavailable` | 依赖服务暂时不可用 |

数据库内部信息、SQL、文件路径、密钥和堆栈不得写入客户端错误响应。

## 5. 标识符规范

所有 ID 在 JSON 中使用字符串，不得转为 JSON 数字：

```json
{
  "id": "internal_message_id",
  "uid": "USR-ABCD1234",
  "ncuid": "USR-ABCD1234",
  "group_id": "GRP-ABCD1234"
}
```

约定：

- `id`：服务端内部稳定 ID；
- `uid`：用户对外 UID；
- `ncuid`：兼容或更新后的对外 UID；
- `group_id`：群组对外 ID；
- URL 查询参数中的 UID 和群 ID由处理器统一 `TrimSpace` 并转换为大写；
- 客户端不得把 RecyclerView 位置、数组下标或昵称当作资源 ID。

涉及 UID 兼容时，服务端应同时接受当前 UID/NCUID，并在必要响应中提供兼容字段；不得破坏旧客户端只读取 `from_uid` 的行为。

## 6. 时间格式

聊天、用户、群组和普通业务时间统一使用 Unix 秒：

```json
{
  "created_at": 1785123456,
  "read_at": 1785123490
}
```

规则：

- 字段名以 `_at` 结尾；
- 使用 UTC Unix 时间，客户端负责本地时区显示；
- 可空时间使用 `null` 或省略；
- 新接口禁止混用秒、毫秒和格式化日期字符串；
- 历史接口若已使用毫秒，必须在独立接口文档中明确标注，不能静默修改单位。

## 7. 消息字段标准

单聊和群聊消息公共字段：

```json
{
  "id": "message_id",
  "from_uid": "USR-ABCD1234",
  "from_ncuid": "USR-ABCD1234",
  "body": "消息正文或结构化消息 JSON",
  "msg_type": "text",
  "media_url": "",
  "thumb_url": "",
  "duration_ms": 0,
  "burn_after_seconds": 0,
  "burn_start_at": null,
  "created_at": 1785123456
}
```

单聊增加：

```json
{
  "thread_id": "thread_id",
  "delivered_at": null,
  "read_at": null
}
```

群聊增加：

```json
{
  "group_id": "GRP-ABCD1234",
  "read_count": 0
}
```

`msg_type` 使用稳定小写值，例如：

```text
text
image
video
voice
file
recall
```

未知类型不能导致整个列表解析失败。客户端应回退为普通文本或“不支持的消息类型”。

## 8. 列表与分页

### 8.1 默认限制

- `limit` 必须是正整数；
- 处理器必须限制最大值；
- 普通消息历史建议每页 20～50 条；
- 未读同步当前建议每页 100 条；
- 客户端不得无限制请求全部记录。

### 8.2 复合游标分页

消息历史的标准分页方式是 `(created_at, id)` 复合游标。

首次请求：

```http
GET /v1/direct/messages/v2?with_uid=USR-ABCD1234&limit=50
```

下一页请求：

```http
GET /v1/direct/messages/v2?with_uid=USR-ABCD1234&limit=50&before_created_at=1785123456&before_id=message_id
```

群聊同理：

```http
GET /v1/groups/messages/v2?group_id=GRP-ABCD1234&limit=50&before_created_at=1785123456&before_id=message_id
```

标准响应：

```json
{
  "messages": [],
  "effective_offset": 0,
  "has_more": true,
  "next_before_created_at": 1785123000,
  "next_before_id": "oldest_message_id"
}
```

服务端查询条件：

```sql
created_at < :before_created_at
OR (created_at = :before_created_at AND id < :before_id)
```

排序固定为：

```sql
ORDER BY created_at DESC, id DESC
```

必须同时传递 `before_created_at` 和 `before_id`；仅有其中一个应视为没有有效游标或返回参数错误。

### 8.3 `has_more`

服务端使用 `limit + 1` 查询：

1. 实际查询一条额外记录；
2. 如果多于 `limit`，设置 `has_more: true`；
3. 返回前裁剪为 `limit` 条；
4. 客户端以 `has_more` 为准，不再通过“本页数量等于 limit”长期猜测。

这可避免列表结尾多发一次必然为空的请求。

### 8.4 群聊断线增量同步

新客户端使用每群单调递增的 `group_seq` 做可靠补偿；WebSocket 只负责低延迟，HTTP 水位负责最终不丢消息。

```http
GET /v1/groups/messages/after?group_id=GRP-ABCD1234&after_seq=1200&limit=100
Authorization: Bearer <access_token>
```

响应按 `group_seq ASC` 返回：

```json
{
  "messages": [{"id":"...","group_seq":1201}],
  "has_more": false,
  "next_group_seq": 1201,
  "server_group_seq": 1201
}
```

客户端只有在整页解析、按消息 ID 合并并保存后才能推进水位。WebSocket 消息不得单独推进完整同步水位。若 `server_group_seq` 小于本地水位，说明数据库恢复或序号世代变化，客户端必须清除水位并从历史交点重建。

兼容要求：现有 `/groups/messages`、`/groups/messages/v2`、OFFSET 和 `(created_at,id)` 游标继续保留；旧客户端忽略新增的 `group_seq` 字段即可。新客户端遇到增量接口 404/405 时，使用 v2 复合游标向前分页，直到与本地消息 ID 相交。

### 8.4 OFFSET 兼容

旧客户端仍可发送：

```text
offset=0
```

兼容规则：

1. 有完整复合游标且没有消息锚点时，优先使用游标；
2. 有 `anchor_message_id` 时执行消息跳转逻辑；
3. 否则回退到 `offset`；
4. 新客户端正常历史翻页不得继续依赖深层 OFFSET。

`effective_offset` 仅用于旧客户端和锚点跳转兼容，不是新分页状态的唯一来源。

### 8.5 未读同步分页

请求：

```json
{
  "limit": 100,
  "offset": 0
}
```

响应：

```json
{
  "messages": [],
  "has_more": false
}
```

服务端必须实际应用 `offset`。客户端仅在 `has_more` 为 `true` 且本页有数据时请求下一页，并按消息 `id` 去重。

## 9. 请求校验

处理器按以下顺序执行：

1. 校验请求方法和 `Content-Type`；
2. 获取认证上下文；
3. 解析 JSON 或查询参数；
4. `TrimSpace`、大小写规范化；
5. 校验 UID、群 ID、URL、正文长度和枚举；
6. 执行限速；
7. 创建带超时的数据库上下文；
8. 校验资源存在与权限；
9. 执行业务与数据库操作；
10. 返回响应；
11. 执行非关键广播或后台工作。

普通数据库操作建议使用：

```go
ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
defer cancel()
```

广播、清理或响应后的异步任务不得继续使用已经取消的请求 Context，应创建独立且有超时的 Context。

## 10. 限速标准

限速键必须包含动作类别，避免两个无关接口互相消耗额度：

```text
friend_request:<ip>
moment_create:<ip>
```

超限统一返回：

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
```

```json
{
  "error": "try again in 5 seconds",
  "code": "rate_limited"
}
```

当前加好友和发布动态分别按 IP 每 5 秒最多一次，突发容量为 1。

## 11. 文件上传与媒体地址

- 上传使用 `multipart/form-data`；
- 大文件优先使用流式上传，不得先完整复制到多个内存缓冲区；
- 图片消息应同时返回原图 `media_url` 和缩略图 `thumb_url`；
- URL 字段为空时使用空字符串或省略，不得返回字符串 `"null"`；
- 下载接口支持缓存头和 Range 时，不得再套 JSON 响应；
- 客户端异步加载图片必须按完整资源身份校验目标 View，不能用列表位置作为缓存键。

## 12. WebSocket 标准

连接路径：

```http
GET /v1/ws
Authorization: Bearer <access_token>
```

服务端事件统一使用信封：

```json
{
  "type": "group_message",
  "data": {}
}
```

要求：

- `type` 是稳定的小写蛇形事件名；
- `data` 是事件对象，不返回 JSON 字符串套 JSON；
- 同一业务对象中的字段应与 HTTP 响应保持一致；
- 服务端只向目标用户广播单聊消息；
- 群消息广播跳过发送者，发送者以 HTTP 创建响应确认消息，避免重复事件；
- 在线状态仅在用户连接数 `0→1` 时广播上线，在 `1→0` 时广播离线；
- typing 重复 `true` 只续期，不重复广播；
- 客户端必须按消息 `id` 去重；
- WebSocket 断线后通过未读同步补齐，不能假设实时帧永不丢失。

示例：

```json
{
  "type": "direct_message",
  "data": {
    "id": "message_id",
    "thread_id": "thread_id",
    "from_uid": "USR-ABCD1234",
    "body": "你好",
    "msg_type": "text",
    "created_at": 1785123456
  }
}
```

## 13. 幂等、去重与重试

### 13.1 客户端

- GET 可在网络错误、408、429、5xx 时有限次数重试；
- POST 默认不得自动重试，除非接口有客户端请求 ID 或明确幂等；
- 消息发送应携带稳定请求标识并根据服务端消息 ID 合并本地 pending 消息；
- HTTP 响应、WebSocket 和未读同步可能到达同一条消息，统一按 `id` 去重；
- 同一列表请求在进行中时应合并或取消旧请求。

### 13.2 服务端

- 创建接口应优先支持客户端幂等键；
- 同一幂等键和同一用户重复提交时返回原结果；
- 不得仅依赖时间戳去重；
- 广播失败不能回滚已经成功提交并响应的消息；
- 后台重试必须有上限、退避和超时。

## 14. 性能标准

服务端：

- 列表 SQL 必须有与筛选及排序一致的索引；
- 禁止列表循环内逐条查询用户资料；应 JOIN 或批量查询；
- 深层消息分页使用复合游标；
- 响应已经写出后，广播使用独立短超时 Context；
- JSON 列表使用预分配容量；
- 不对加密密文执行二次 gzip；
- GET 历史接口不得新增不必要的写操作。

客户端：

- JSON 解析、缓存反序列化和大列表合并在后台线程执行；
- RecyclerView 使用消息稳定 ID；
- 历史前插使用范围通知并恢复当前消息像素锚点；
- 无数据变化时不得 `notifyDataSetChanged()`；
- 同一聊天的缓存保存任务只保留最新快照；
- 图片请求完成前必须校验 View 当前 URL tag。

## 15. 向后兼容

所有协议升级遵循：

1. 新增字段优先，避免修改旧字段含义；
2. 旧客户端忽略新字段后仍能工作；
3. 新客户端在新字段缺失时回退到旧逻辑；
4. 复合游标与 OFFSET 同时保留一段兼容期；
5. `uid`/`ncuid` 同时兼容；
6. 不静默修改时间单位、状态码或 `msg_type`；
7. 删除字段、路由或旧行为前必须完成版本覆盖评估。

## 16. Go 处理器模板

```go
func (a *API) handleExample(w http.ResponseWriter, r *http.Request) {
    claims, ok := claimsFromContext(r.Context())
    if !ok {
        writeError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
        return
    }

    var req exampleRequest
    if err := decodeJSON(w, r, &req); err != nil {
        writeError(w, http.StatusBadRequest, "invalid_json", "invalid json")
        return
    }

    value := strings.TrimSpace(req.Value)
    if value == "" {
        writeError(w, http.StatusBadRequest, "invalid_value", "invalid value")
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
    defer cancel()

    result, err := a.store.Create(ctx, claims.Subject, value)
    if err != nil {
        if err == data.ErrNotFound {
            writeError(w, http.StatusNotFound, "not_found", "not found")
            return
        }
        writeError(w, http.StatusInternalServerError, "db_error", "internal error")
        return
    }

    writeJSON(w, http.StatusCreated, result)
}
```

## 17. 开发检查清单

新增或修改接口前确认：

- [ ] 路径使用 `/v1`，字段使用小写蛇形；
- [ ] 成功响应不是裸数组；
- [ ] 空列表返回 `[]`；
- [ ] 错误通过 `writeError` 返回 `error + code`；
- [ ] 客户端只依赖稳定 `code`，不匹配错误文案；
- [ ] 所有外部 ID 已去空格、规范大小写并校验；
- [ ] 权限检查发生在数据返回或修改之前；
- [ ] 数据库 Context 有合理超时；
- [ ] 列表没有 N+1 查询；
- [ ] 深分页使用 `(created_at, id)` 游标；
- [ ] 响应包含明确 `has_more`；
- [ ] 新字段不会破坏旧客户端；
- [ ] WebSocket 与 HTTP 的同类对象字段一致；
- [ ] 消息可按服务端 `id` 去重；
- [ ] 加密压缩顺序是“先压缩、后加密”；
- [ ] 日志不包含 Token、密码、密钥、完整私密消息或加密会话材料；
- [ ] 已运行 `gofmt`、`go test ./...` 和对应客户端构建。
