# Oldchat 第三方登录 API

Oldchat 提供基于 **OAuth 2.1 Authorization Code + PKCE** 和 **OpenID Connect** 的第三方登录服务。

第三方应用不得收集、转发或保存用户的 Oldchat 密码。用户只能在 Oldchat 官方授权页面完成登录、注册、找回密码和授权确认。

## 1. 服务地址

- Issuer：`https://oc.mcl0.dpdns.org`
- Discovery：`GET https://oc.mcl0.dpdns.org/.well-known/openid-configuration`
- 授权端点：`GET https://oc.mcl0.dpdns.org/oauth/authorize`
- Token 端点：`POST https://oc.mcl0.dpdns.org/oauth/token`
- UserInfo：`GET https://oc.mcl0.dpdns.org/oauth/userinfo`
- JWKS：`GET https://oc.mcl0.dpdns.org/oauth/jwks.json`
- Token 验证：`POST https://oc.mcl0.dpdns.org/oauth/introspect`
- Token 撤销：`POST https://oc.mcl0.dpdns.org/oauth/revoke`

所有端点必须使用 HTTPS。OAuth 标准端点没有 `/v1` 或 `/v1/v1` 兼容前缀。

## 2. 申请 Client

第三方应用需向 Oldchat 管理员提交：

- 应用名称和用途；
- 开发者联系方式；
- 唯一且固定的回调地址；
- 隐私政策地址；
- 客户端类型：公开客户端或机密客户端。

审核通过后会获得 `client_id`。机密服务端应用还会获得一次性展示的 `client_secret`。

回调地址采用**完全匹配**，不支持通配符、HTTP 地址或临时动态地址。

## 3. 支持的流程和 Scope

当前只支持：

- `response_type=code`
- `grant_type=authorization_code`
- `grant_type=refresh_token`
- PKCE `code_challenge_method=S256`

支持的 Scope：

| Scope | 说明 |
|---|---|
| `openid` | 必选，启用 OpenID Connect 登录 |
| `profile` | 读取当前公开 UID、昵称和头像 |
| `offline_access` | 请求 Refresh Token；需用户明确授权 |

当前不开放好友、聊天、群组、旧币、上传和管理员权限。

## 4. 发起授权

### 4.1 生成安全参数

第三方客户端必须生成：

- `state`：至少 128 bit 随机值，用于防止 CSRF；
- `nonce`：至少 128 bit 随机值，用于防止 ID Token 重放；
- `code_verifier`：43～128 个 RFC 7636 unreserved 字符；
- `code_challenge = BASE64URL(SHA256(code_verifier))`。

### 4.2 跳转到授权页

```text
GET /oauth/authorize
  ?response_type=code
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback
  &scope=openid%20profile%20offline_access
  &state=RANDOM_STATE
  &nonce=RANDOM_NONCE
  &code_challenge=BASE64URL_SHA256_VERIFIER
  &code_challenge_method=S256
```

用户将在 Oldchat 官方页面完成登录、注册、找回密码和授权确认。第三方页面不得嵌入或仿冒 Oldchat 密码输入框。

### 4.3 授权结果

同意：

```text
https://client.example.com/callback?code=AUTHORIZATION_CODE&state=RANDOM_STATE
```

拒绝：

```text
https://client.example.com/callback?error=access_denied&state=RANDOM_STATE
```

客户端必须先使用常量时间比较确认返回的 `state` 与本地值完全一致，再兑换授权码。

## 5. Token 分发

### 5.1 兑换授权码

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64(client_id:client_secret)

 grant_type=authorization_code&
 code=AUTHORIZATION_CODE&
 redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback&
 code_verifier=ORIGINAL_CODE_VERIFIER
```

公开客户端不发送 `client_secret`，改为在表单中提交 `client_id`。公开客户端和机密客户端都必须使用 PKCE S256。

成功响应：

```json
{
  "token_type": "Bearer",
  "access_token": "opaque_access_token",
  "expires_in": 600,
  "refresh_token": "opaque_refresh_token",
  "scope": "offline_access openid profile",
  "id_token": "eyJ..."
}
```

Token 响应带有 `Cache-Control: no-store`，不得写入 URL、前端日志、分析平台或错误报告。

### 5.2 刷新 Token

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64(client_id:client_secret)

 grant_type=refresh_token&refresh_token=OLD_REFRESH_TOKEN
```

每次刷新都会返回新的 Refresh Token，旧 Token立即失效。客户端必须原子替换本地保存值。

重复使用已经轮换的 Refresh Token会被视为泄漏，对应授权可能被整体撤销。

## 6. ID Token 验证

ID Token 使用 Ed25519 / `EdDSA` 签名。验证方应通过 Discovery 获取 `jwks_uri`，并按 JWT Header 中的 `kid` 选择公钥。

必须验证：

1. `alg` 必须是 `EdDSA`；
2. 签名有效；
3. `iss` 精确等于 `https://oc.mcl0.dpdns.org`；
4. `aud` 包含自己的 `client_id`；
5. `exp` 尚未过期；
6. `iat` 在合理时间范围；
7. `nonce` 与发起授权时保存的值完全一致。

主要 Claims：

| Claim | 说明 |
|---|---|
| `sub` | 稳定、不可变的 Oldchat NCUID；第三方必须以它作为用户主键 |
| `uid` | 当前公开 UID，用户可能修改，禁止作为数据库主键 |
| `name` | 当前公开昵称 |
| `picture` | 当前头像地址 |
| `auth_time` | 用户完成认证的时间 |

ID Token 只用于确认用户身份，不能作为调用 UserInfo 或资源 API 的 Access Token。

## 7. Token 验证服务

机密客户端可以调用 introspection：

```http
POST /oauth/introspect
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64(client_id:client_secret)

 token=ACCESS_TOKEN
```

有效 Token：

```json
{
  "active": true,
  "client_id": "example-client",
  "sub": "nc_xxxxxxxxxxxxxxxxxxxxxxxx",
  "scope": "openid profile",
  "token_type": "Bearer",
  "exp": 1785312000
}
```

无效、过期或撤销的 Token统一返回：

```json
{"active": false}
```

Introspection 仅验证签发给当前 client 的 Access Token，不能用于探测其他应用的 Token。

## 8. UserInfo

```http
GET /oauth/userinfo
Authorization: Bearer ACCESS_TOKEN
```

```json
{
  "sub": "nc_xxxxxxxxxxxxxxxxxxxxxxxx",
  "uid": "CURRENT-UID",
  "name": "用户昵称",
  "picture": "https://..."
}
```

只有获得 `profile` Scope 时才返回公开资料字段。

## 9. 撤销 Token

```http
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64(client_id:client_secret)

 token=TOKEN_TO_REVOKE
```

无论 Token 是否存在，撤销端点都返回 HTTP 200，避免泄露 Token 状态。

用户修改或找回密码时，旧版 Oldchat 会话和第三方授权会一并撤销。

## 10. 错误响应

```json
{
  "error": "invalid_grant",
  "error_description": "invalid or expired code"
}
```

常见错误：

| error | 说明 |
|---|---|
| `invalid_request` | 参数缺失或格式错误 |
| `invalid_client` | Client 认证失败或已停用 |
| `invalid_scope` | Scope 不在 Client 白名单内 |
| `access_denied` | 用户拒绝授权或安全校验失败 |
| `invalid_grant` | 授权码、PKCE 或 Refresh Token无效 |
| `unsupported_grant_type` | 不支持的授权类型 |
| `invalid_token` | Access Token无效、过期或已撤销 |
| `temporarily_unavailable` | 授权服务暂不可用 |

## 11. 安全要求

- 必须使用系统浏览器或安全的外部浏览器跳转，不得使用 WebView 收集密码；
- 必须验证 `state`、`nonce`、issuer、audience 和签名；
- 不得关闭 TLS 验证或接受自签名证书；
- 不得把 `client_secret` 放进 APK、桌面程序、SPA 或公开仓库；
- Access Token只保存在服务端会话或平台安全存储；
- Refresh Token必须加密保存并实施原子轮换；
- 日志、崩溃报告和监控系统必须对 Token、授权码及密码脱敏；
- 用户身份只能使用 `sub`（NCUID），不能使用可修改的 `uid`。

## 12. cURL 快速检查

```bash
# 发现文档
curl https://oc.mcl0.dpdns.org/.well-known/openid-configuration

# JWKS
curl https://oc.mcl0.dpdns.org/oauth/jwks.json

# 验证 Access Token
curl -u 'CLIENT_ID:CLIENT_SECRET' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'token=ACCESS_TOKEN' \
  https://oc.mcl0.dpdns.org/oauth/introspect
```

接入前请先在测试环境完整验证授权拒绝、错误 PKCE、授权码重复兑换、Token 过期、Refresh Token轮换和撤销流程。
