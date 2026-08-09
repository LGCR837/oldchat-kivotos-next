# 12 - v2 签名机制、加密信封与 bad_signature 排查指南 (dev2)

> 基于 jadx 反编译 `oldchat-dev.apk` (2026-08-09) 源码确认  
> 版本: v2

---

## 目录

- [1. 完整请求头样本（抓包级）](#1-完整请求头样本抓包级)
- [2. 登录是否走加密 + session 绑定](#2-登录是否走加密--session-绑定)
- [3. 握手 client_pub 编码格式](#3-握手-client_pub-编码格式)
- [4. 签名里的 token 确切值](#4-签名里的-token-确切值)
- [5. X-Device-Id 是否参与验签](#5-x-device-id-是否参与验签)
- [6. bad_signature 常见原因清单](#6-bad_signature-常见原因清单)
- [7. v2 请求签名机制](#7-v2-请求签名机制)
- [8. v2 加密请求体信封格式](#8-v2-加密请求体信封格式)
- [9. 客户端实现速查](#9-客户端实现速查)

---

## 1. 完整请求头样本（抓包级）

以下所有请求头均来自源码反编译确认，**非抓包但可视为抓包级精度**。

### 1.1 握手请求 (明文)

```
POST /auth/handshake
Host: oc.mcl0.dpdns.org
Content-Type: application/json
Content-Length: <varies>

{"client_pub":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."}
```

**特点**:
- 无 `Authorization` 头（token = null）
- 无 `X-Enc` / `X-Session` / `X-Sign` 等加密/签名头
- 无 `X-Device-Id`
- 使用 `h0.b.c()` 直接创建 HttpURLConnection，**不走 `h0.e.i()`**

### 1.2 登录请求 (明文, 旧传输层)

```
POST /auth/login
Host: oc.mcl0.dpdns.org/v1
Content-Type: application/json
Content-Length: <varies>

{"identifier":"username","password":"secret","device_id":"abc123...","imei":"...","device_name":"...","platform":"android","app_version":"1.4.x"}
```

**请求头**:
| 头 | 值 | 来源 |
|---|---|---|
| `Content-Type` | `application/json` | `h0.e.i()` 固定设置 |
| `Authorization` | **无** (token=null) | `h0.e.i()` 中 `str3 == null` 不设置 |

**特点**:
- 走 **`h0.e.i()`**（旧传输层），**不走 `h0.c`**（加密传输层）
- 路径 `/auth/login` **不以 `/v2/` 开头** → `h0.e.b()` 不执行 → **无签名头**
- **无 `X-Enc` / `X-Session` / `X-Sign` / `X-Ts` / `X-Nonce` / `X-Device-Id`**
- 请求体是**明文 JSON**，未加密

### 1.3 v2 请求 (签名 + 可选加密)

**走 `h0.e` 旧传输层的 v2 请求** (调用 `h0.e.u()` → `h0.e.j()` → `h0.e.i()`):

```
POST /v2/groups/read
Host: oc.mcl0.dpdns.org/v1
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
X-Ts: 1690000000
X-Nonce: aB3xYz9KzQwNtG7pLmR2sA==
X-Sign: fH7xYm3KwZpL5nR8tV2bG4cJ6dM9sA1eC3fH5iK
X-Device-Id: abc123def456

{"key":"value"}
```

**请求头**:
| 头 | 值格式 | 来源 |
|---|---|---|
| `Content-Type` | `application/json` | `h0.e.i()` |
| `Authorization` | `Bearer <access_token>` | `h0.e.i()`, token 参数 |
| `X-Ts` | 秒级时间戳字符串 | `h0.e.b()` |
| `X-Nonce` | 16字节随机 → Base64(NO_PADDING\|NO_WRAP) | `AbstractC0573w.w()` |
| `X-Sign` | HMAC-SHA256 → Base64(NO_PADDING\|NO_WRAP) | `AbstractC0573w.z()` |
| `X-Device-Id` | Android ID | `AbstractC0577y.b()` |

**注意**: 此路径下 **没有 `X-Session` 头**。`h0.e.i()` 不设置 X-Session。

**走 `h0.c` 加密传输层的请求** (调用 `h0.c.h()` → `h0.c.a` Runnable):

```
POST /v2/groups/read
Host: oc.mcl0.dpdns.org
Content-Type: application/json
X-Burn-Secure: 1
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
X-Enc: 1
X-Session: session_id_from_handshake
X-Enc-Compression: gzip

{"iv":"aB...3Q==","data":"xY...7w==","mac":"kZ...9g=="}
```

**请求头**:
| 头 | 值格式 | 来源 |
|---|---|---|
| `Content-Type` | `application/json` | `h0.c.a` runnable |
| `X-Burn-Secure` | `1` | `h0.c.a` 固定设置 |
| `Authorization` | `Bearer <access_token>` | `h0.c.a` |
| `X-Enc` | `1` | `h0.c.a` (加密标记) |
| `X-Session` | handshake 返回的 session_id | `AbstractC0573w.p()` |
| `X-Enc-Compression` | `gzip` | `h0.c.a` 固定设置 |

**注意**:
- `h0.c` 路径 **没有 `X-Sign`**（签名在 `h0.e.b()` 中，`h0.c` 不调用 `h0.e.b()`）
- 请求体是 `{"iv","data","mac"}` 信封格式 (AES-CBC 加密)
- base URL 是 `f7051a` (无 `/v1` 后缀)，不是 `f7052b`

---

## 2. 登录是否走加密 + Session 绑定

### 2.1 登录请求路径 (源码确认)

```
LoginActivity.C0()
  → h0.d.W("/auth/login", JSONObject, null, callback)    // token = null
    → h0.d.c AsyncTask
      → h0.e.u("POST", "/auth/login", body, null)         // token = null
        → h0.e.j("POST", "/auth/login", body, null)
          → h0.e.i("POST", "/auth/login", body, null)     // 旧传输层
            → 创建 HttpURLConnection
            → 设置 Content-Type: application/json
            → token 为 null → 不设置 Authorization 头
            → 路径 "/auth/login" 不以 /v2/ 开头 → 不调用 e.b()
            → 发送明文 JSON body
            → 读取响应
```

**结论**: 登录请求走 **`h0.e.i()`（旧传输层）**，**不走 `h0.c`（加密传输层）**。

### 2.2 登录请求的关键特征

| 属性 | 值 |
|---|---|
| 是否加密 body | **否** (明文 JSON) |
| 是否带 X-Session | **否** |
| 是否带 X-Sign | **否** (路径不是 /v2/) |
| 是否带 X-Device-Id | **否** |
| 是否带 Authorization | **否** (token=null) |
| 使用的传输层 | `h0.e.i()` (旧) |

### 2.3 Session 绑定机制分析

**客户端代码中不存在** token ↔ session 的显式绑定逻辑。登录和握手是两个完全独立的流程：

```
握手流程 (独立):
  POST /auth/handshake {client_pub}
  → 存储 session_id, encKey, macKey (内存)

登录流程 (独立):
  POST /auth/login {identifier, password, device_id, ...}
  → 存储 access_token, refresh_token (SharedPreferences)
```

**但是**，以下情况可能导致服务器端存在隐式绑定：

1. **服务器端实现**: 服务器可能通过 `device_id` 或 IP 将 token 和 session 关联。但这是服务器端行为，客户端代码中无法确认。

2. **`h0.e.u()` 中的 invalid_session 处理**: 当 v2 请求返回 400/401 且 body 包含 `"invalid_session"` 时，客户端会调用 `AbstractC0573w.g()` 清除会话并重试。这说明 `h0.e.u()` 路径的请求**确实会携带 session 信息被服务器验证**。

3. **`h0.c` 路径的 X-Session**: `h0.c` 加密传输层会在请求中设置 `X-Session` 头。如果服务器按 `X-Session` 查找 macKey，那么 `h0.e` 路径（不设 X-Session）的服务器行为取决于服务器实现。

**最可能的服务器行为**:
- 服务器使用 `X-Session` 头查找 macKey 用于验签
- 如果请求不带 `X-Session`，服务器可能尝试按 `token` 查找，或返回 bad_signature
- 这意味着 **`h0.e` 路径的 v2 请求（有 X-Sign 但无 X-Session）可能被服务器拒绝**

**但 Android 客户端确实能正常工作**，这说明要么：
- 服务器不强制要求 X-Session（在无 X-Session 时用 token 查找 macKey）
- 或者服务器通过其他方式（如 device_id）建立了关联

---

## 3. 握手 client_pub 编码格式

### 3.1 源码确认

```java
// AbstractC0573w.f() 第 108-117 行
public static a f() {
    KeyPairGenerator gen = n();  // EC, secp256r1 / prime256v1
    gen.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair keyPair = gen.generateKeyPair();
    return new a(
        keyPair.getPrivate(),
        Base64.encodeToString(keyPair.getPublic().getEncoded(), 2)  // flag=2 = NO_WRAP
    );
}
```

### 3.2 编码格式

Java 的 `ECPublicKey.getEncoded()` 返回 **X.509 / SPKI (SubjectPublicKeyInfo)** 格式，按照 ANSI X9.62 标准：

```
SEQUENCE {                          ← 整个 SPKI 结构
  SEQUENCE {                        ← AlgorithmIdentifier
    OID "1.2.840.10045.2.1"         ← ecPublicKey (EC 公钥算法)
    OID "1.2.840.10045.3.1.7"       ← secp256r1 (prime256v1) 曲线
  }
  BIT STRING {                      ← 公钥点
    0x04 || X_coordinate (32) || Y_coordinate (32)
  }                                 ← 65 字节未压缩点格式
}
```

**总长度**: 对于 secp256r1，SPKI 编码约为 **91 字节**（DER 编码）。

**Base64 编码后**: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...`（约 122 字符）

### 3.3 请用户确认

您应当在代码中这样生成 client_pub：

```java
// 正确做法 (Java 标准)
KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
gen.initialize(new ECGenParameterSpec("secp256r1"));
KeyPair kp = gen.generateKeyPair();
byte[] spki = kp.getPublic().getEncoded();  // 91 bytes SPKI
String clientPub = Base64.encodeToString(spki, Base64.NO_WRAP);
```

您的 Node.js 实现应该：
```javascript
const crypto = require('crypto');
const { publicKey: { export: exportPub } } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'der' }  // SPKI, DER
});
// exportPub 是 Buffer，Base64 编码后发送
```

**不是** 65 字节的未压缩点（`0x04 || X || Y`），也不是 PEM 格式。

### 3.4 服务端公钥解码 (确认)

```java
// AbstractC0573w.a.a() 第 80 行
PublicKey serverPub = KeyFactory("EC").generatePublic(
    new X509EncodedKeySpec(Base64.decode(serverPubB64, 2)));
```

服务端返回的 `server_pub` 也是 **X.509 SPKI 格式**，用 `X509EncodedKeySpec` 解码。这确认了双方使用相同的编码格式。

---

## 4. 签名里的 token 确切值

### 4.1 源码确认

```java
// h0.e.b() 第 167-193 行
public static void b(HttpURLConnection conn, String str, String str2) {
    // str = token, str2 = path
    if (str2 != null) {
        if (str2.startsWith("/v2/") || str2.startsWith("/v1/v2/")) {
            // ... 移除查询参数 ...
            if (AbstractC0573w.s()) {
                String z2 = AbstractC0573w.z(str, str2, ts, nonce);
                // str = token, 直接传给 z()
```

`str` 参数是 `h0.e.i()` 的 `str3` 参数直接传入。在 `h0.e.u()` 中：

```java
// h0.e.u() 第 585-632 行
public static c u(String method, String path, JSONObject body, String str3) {
    // str3 = token
    c j2 = j(method, path, body, str3);
    // str3 原样传递给 j()
```

而 `h0.e.j()` 将 `str3` 原样传递给 `h0.e.i()`。

### 4.2 确认结果

**签名使用的 token = `access_token` 原文**（不带 "Bearer " 前缀）。

| 场景 | 签名 token 值 | 说明 |
|---|---|---|
| 登录请求 (`/auth/login`) | **不签名** | 路径不是 /v2/ |
| v2 请求 | `access_token` 原文 | 与 `Authorization: Bearer <token>` 中的 token 相同 |
| 刷新 token 后的重试 | 新 `access_token` | `h0.b.g()` 返回新 token |

### 4.3 在 Node.js 中的验证

```javascript
const token = 'eyJhbGciOiJIUzI1NiIs...';  // 从存储中读取，不含 "Bearer "
const path = '/v2/groups/read';            // 不含查询参数
const ts = '1690000000';                   // 秒级时间戳字符串
const nonce = 'aB3xYz9KzQwNtG7pLmR2sA';   // 16字节随机 → Base64 无填充

const data = `${token}\n${path}\n${ts}\n${nonce}`;
const sig = crypto.createHmac('sha256', macKey).update(data).digest('base64')
  .replace(/=+$/, '');  // NO_PADDING
```

---

## 5. X-Device-Id 是否参与验签

### 5.1 源码确认

```java
// h0.e.b() 第 167-193 行
public static void b(HttpURLConnection conn, String token, String path) {
    ...
    String valueOf = String.valueOf(System.currentTimeMillis() / 1000);
    String w2 = AbstractC0573w.w();
    String z2 = AbstractC0573w.z(token, path, valueOf, w2);  // ← 签名：只有 token + path + ts + nonce
    if (z2 != null) {
        conn.setRequestProperty("X-Ts", valueOf);
        conn.setRequestProperty("X-Nonce", w2);
        conn.setRequestProperty("X-Sign", z2);
        
        // X-Device-Id 是单独设置的，不在签名计算中
        String deviceId = AbstractC0577y.b(context);
        if (deviceId != null && deviceId.length() > 0) {
            conn.setRequestProperty("X-Device-Id", deviceId);
        }
    }
}
```

### 5.2 确认结果

**X-Device-Id 不参与签名计算**。签名只覆盖 `token + path + ts + nonce`。

`X-Device-Id` 和 `X-Sign` 是两个独立的请求头，`X-Device-Id` 用于服务器端设备识别/风控，但不影响签名验证。

---

## 6. bad_signature 常见原因清单

按可能性从高到低排列：

### 6.1 macKey 不一致 (最高可能性)

**现象**: 客户端和服务器派生的 macKey 不同，导致同一输入产生不同签名。

**排查**:
- 确认 client_pub 编码为 **SPKI (X.509 DER)**，不是裸 65 字节点
- 确认 ECDH 曲线为 **secp256r1** (prime256v1)
- 确认密钥派生公式正确:
  ```
  truncated = v(sharedSecret, 32)  // 取末尾 32 字节 或 左侧补零
  macKey = SHA256(truncated + "mac")  // "mac" 字符串的 UTF-8 字节
  encKey = SHA256(truncated + "enc")  // "enc" 字符串的 UTF-8 字节
  ```
- 确认 `v()` 函数的截断规则: 如果 sharedSecret > 32 字节，取**末尾** 32 字节；如果 < 32 字节，**左侧补零**

### 6.2 签名拼接格式错误

**现象**: 拼接字符串与 Android 端不一致。

**确认**:
```javascript
// 正确: 使用 \n (0x0A) 作为分隔符
const data = token + '\n' + path + '\n' + timestamp + '\n' + nonce;

// 错误: 使用空字符串或其他分隔符
// const data = token + path + timestamp + nonce;  // ❌
```

### 6.3 Token 值错误

**现象**: 签名使用的 token 与服务器端查找 macKey 时使用的 token 不一致。

**确认**:
- 签名 token = `access_token` 原文（不带 `Bearer ` 前缀）
- 与 `Authorization: Bearer <token>` 中的 token 相同
- 如果 token 在登录后刷新过，确保使用最新的 token

### 6.4 路径值错误

**现象**: 签名用的路径与服务器端计算时使用的路径不一致。

**确认**:
- 路径必须**不含查询参数**（`?` 及之后内容被截断）
- 必须以 `/v2/` 或 `/v1/v2/` 开头
- 路径大小写敏感

### 6.5 时间戳精度问题

**现象**: 客户端和服务器的系统时间不同步。

**确认**:
- 时间戳为**秒级**（`System.currentTimeMillis() / 1000`），不是毫秒级
- 服务器端可能允许一定的时间窗口（如 ±5 秒），超出则视为 bad_signature

### 6.6 Nonce 格式错误

**现象**: Nonce 的 Base64 编码格式与 Android 端不一致。

**确认**:
- Nonce = 16 字节 SecureRandom → **Base64(NO_PADDING | NO_WRAP)**
- Android 的 `flag=3` = `Base64.NO_PADDING | Base64.NO_WRAP`
- 在 Node.js 中: `Buffer.from(randomBytes(16)).toString('base64').replace(/=+$/, '')`

### 6.7 Session 未正确建立 (握手失败)

**现象**: 握手未完成，macKey 不存在。

**确认**:
- 先调用 `POST /auth/handshake` 获取 session_id 和 server_pub
- 计算 ECDH 共享密钥并派生 encKey + macKey
- 调用 `AbstractC0573w.s()` 确认会话已就绪

### 6.8 服务器端 session 过期

**现象**: 之前的 session 已过期，服务器清除了 macKey。

**重试**:
- 重新执行握手，获取新的 session_id 和 macKey
- Android 客户端在收到 invalid_session 时会自动重试

---

## 7. v2 请求签名机制

### 7.1 签名算法总览

| 属性 | 值 |
|---|---|
| **算法** | **HMAC-SHA256** |
| **密钥** | ECDH 握手协商的 MAC 密钥 (`f10347d`) |
| **拼接格式** | `token + '\n' + path + '\n' + timestamp + '\n' + nonce` |
| **输出编码** | Base64 (NO_PADDING \| NO_WRAP，即 `flag=3`) |
| **触发条件** | 路径以 `/v2/` 或 `/v1/v2/` 开头，且 ECDH 会话密钥存在 |

### 7.2 签名方法 (`AbstractC0573w.z()`)

```java
public static String z(String token, String path, String timestamp, String nonce) {
    synchronized (lock) {
        byte[] macKey = f10347d;
        if (macKey == null) return null;
        String data = token + '\n' + path + '\n' + timestamp + '\n' + nonce;
        byte[] signature = t(macKey, data.getBytes("UTF-8"));
        return Base64.encodeToString(signature, 3);  // NO_PADDING | NO_WRAP
    }
}
```

### 7.3 Nonce 生成 (`AbstractC0573w.w()`)

```java
public static String w() {
    byte[] bArr = new byte[16];
    new SecureRandom().nextBytes(bArr);
    return Base64.encodeToString(bArr, 3);  // NO_PADDING | NO_WRAP
}
```

### 7.4 签名请求头

| 请求头 | 值格式 | 示例 |
|---|---|---|
| `X-Ts` | 秒级时间戳字符串 | `"1690000000"` |
| `X-Nonce` | 16B SecureRandom → Base64 无填充 (24 字符) | `"aB3xYz9KzQwNtG7pLmR2sA"` |
| `X-Sign` | HMAC-SHA256 → Base64 无填充 (43 字符) | `"fH7xYm3KwZpL5nR8tV2bG4cJ6dM9sA1eC3fH5iK"` |
| `X-Device-Id` | Android ID (不参与签名) | `"abc123def456"` |

---

## 8. v2 加密请求体信封格式

详见 [08-ECDH握手协议与加密流程详解.md](./08-ECDH握手协议与加密流程详解.md) 第 4 节。

### 8.1 简要说明

| 属性 | 值 |
|---|---|
| 加密算法 | **AES-256-CBC / PKCS5Padding** |
| 密钥 | `encKey = SHA256(truncated_shared_secret + "enc")` |
| MAC 算法 | `HMAC-SHA256(macKey, iv_bytes \|\| ciphertext_bytes)` |
| 信封格式 | `{"iv":"base64(iv)","data":"base64(ciphertext)","mac":"base64(mac)"}` |
| 触发条件 | 所有非 `/auth/handshake` 路径 (走 `h0.c` 时) |
| 请求头 | `X-Enc: 1`, `X-Session: <session_id>`, `X-Enc-Compression: gzip` |

### 8.2 重要提示

**加密和签名是独立的两个机制**:
- `h0.e` 旧传输层: **有签名 (X-Sign)，无加密 (X-Enc)**
- `h0.c` 新传输层: **有加密 (X-Enc)，无签名 (X-Sign)**

Dev2 中两个传输层并存，具体使用哪个取决于调用方代码。

---

## 9. 客户端实现速查

### Python 完整实现

```python
import os
import json
import time
import hmac
import hashlib
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


# ============================================================
# 步骤 1: ECDH 握手
# ============================================================

def handshake():
    """执行 ECDH 握手，返回 session_id, enc_key, mac_key"""
    # 1. 生成 EC 密钥对 (secp256r1)
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()
    
    # 2. 编码 client_pub 为 SPKI DER → Base64
    client_pub_b64 = base64.b64encode(
        public_key.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode()  # NO_WRAP (Android Base64.NO_WRAP = 无换行)
    
    # 3. POST /auth/handshake
    resp = http_post("/auth/handshake", {"client_pub": client_pub_b64})
    session_id = resp["session_id"]
    server_pub_b64 = resp["server_pub"]
    
    # 4. 解码服务器公钥 (SPKI DER)
    server_pub_bytes = base64.b64decode(server_pub_b64)
    server_public_key = serialization.load_der_public_key(server_pub_bytes)
    
    # 5. ECDH 共享密钥
    shared_secret = private_key.exchange(ec.ECDH(), server_public_key)
    
    # 6. 截断/补齐到 32 字节
    truncated = pad_truncate(shared_secret, 32)
    
    # 7. 派生密钥
    enc_key = hashlib.sha256(truncated + b"enc").digest()
    mac_key = hashlib.sha256(truncated + b"mac").digest()
    
    return session_id, enc_key, mac_key


def pad_truncate(data: bytes, length: int) -> bytes:
    """v() 函数: 取末尾 length 字节 或 左侧补零"""
    if len(data) == length:
        return data
    result = bytearray(length)
    if len(data) > length:
        # 取末尾 length 字节
        result[:] = data[-length:]
    else:
        # 左侧补零
        result[length - len(data):] = data
    return bytes(result)


# ============================================================
# 步骤 2: v2 签名
# ============================================================

def generate_v2_sign(mac_key: bytes, token: str, path: str) -> tuple:
    """
    生成 v2 签名请求头
    返回: (X-Ts, X-Nonce, X-Sign)
    """
    # 1. 移除查询参数
    if '?' in path:
        path = path[:path.index('?')]
    
    # 2. 生成时间戳和 nonce
    timestamp = str(int(time.time()))
    nonce = base64.b64encode(os.urandom(16)).rstrip(b'=').decode()
    
    # 3. 拼接数据: token + \n + path + \n + ts + \n + nonce
    data = f"{token}\n{path}\n{timestamp}\n{nonce}"
    
    # 4. HMAC-SHA256
    sig = hmac.new(mac_key, data.encode('utf-8'), hashlib.sha256).digest()
    
    # 5. Base64 无填充
    sign = base64.b64encode(sig).rstrip(b'=').decode()
    
    return timestamp, nonce, sign


# ============================================================
# 步骤 3: 请求体加密 (可选)
# ============================================================

def encrypt_request_body(plaintext: str, enc_key: bytes, mac_key: bytes) -> str:
    """
    AES-256-CBC 加密 + HMAC-SHA256 认证
    返回: 信封 JSON 字符串
    """
    iv = os.urandom(16)
    
    # AES-CBC 加密 (PKCS7 填充)
    cipher = Cipher(algorithms.AES(enc_key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    pad_len = 16 - (len(plaintext) % 16)
    padded = plaintext + chr(pad_len) * pad_len
    ciphertext = encryptor.update(padded.encode('utf-8')) + encryptor.finalize()
    
    # HMAC-SHA256 (iv || ciphertext)
    mac = hmac.new(mac_key, iv + ciphertext, hashlib.sha256).digest()
    
    # 信封 JSON
    envelope = {
        "iv": base64.b64encode(iv).decode(),
        "data": base64.b64encode(ciphertext).decode(),
        "mac": base64.b64encode(mac).decode()
    }
    return json.dumps(envelope, separators=(',', ':'))


# ============================================================
# 步骤 4: 完整请求示例
# ============================================================

def make_v2_request(method: str, path: str, body: dict,
                    token: str, mac_key: bytes, device_id: str):
    """
    发送带签名的 v2 请求 (走 h0.e 旧传输层风格)
    """
    import requests
    
    ts, nonce, sign = generate_v2_sign(mac_key, token, path)
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "X-Ts": ts,
        "X-Nonce": nonce,
        "X-Sign": sign,
        "X-Device-Id": device_id,
    }
    
    url = f"http://oc.mcl0.dpdns.org/v1{path}"
    resp = requests.request(method, url, json=body, headers=headers)
    return resp
```

---

## 附录: 关键源码位置

| 功能 | 类 | 文件路径 |
|---|---|---|
| 签名生成 | `AbstractC0573w.z()` | `q0/AbstractC0573w.java:357` |
| Nonce 生成 | `AbstractC0573w.w()` | `q0/AbstractC0573w.java:324` |
| 签名设置 | `h0.e.b()` | `h0/e.java:167` |
| 握手执行 | `h0.b.f()` | `h0/b.java:244` |
| 握手触发 | `h0.b.b()` | `h0/b.java:87` |
| 密钥派生 | `AbstractC0573w.a.a()` | `q0/AbstractC0573w.java:79` |
| 加密信封 | `AbstractC0573w.k()` | `q0/AbstractC0573w.java:162` |
| 解密信封 | `AbstractC0573w.j()` | `q0/AbstractC0573w.java:138` |
| 加密传输层 | `h0.c` | `h0/c.java` |
| 旧传输层 | `h0.e` | `h0/e.java` |
| API 入口 | `h0.d` | `h0/d.java` |
| 登录 Activity | `LoginActivity` | `com/im/oldchat/ui/LoginActivity.java` |