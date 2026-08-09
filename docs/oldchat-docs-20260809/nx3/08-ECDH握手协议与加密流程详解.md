# 08 - ECDH 握手协议与加密流程详解 (v2 / dev2)

> 基于 jadx 反编译 `oldchat-dev.apk` (2026-08-09) 源码确认  
> 本文档所有内容均来自源码反编译，取代此前版本中的"推测"内容

---

## 1. 概述

OldChat v2 (dev2) 使用 **ECDH (secp256r1)** 密钥协商 + **AES-CBC** 对称加密 + **HMAC-SHA256** 消息认证，对 **所有非握手 HTTP 请求/响应体** 进行加密传输。

**加密不是可选的** — 只要设备支持 ECDH（`AbstractC0573w.u()` 返回 true），所有非 `/auth/handshake` 路径的请求体都会被加密。

---

## 2. 核心类结构

| 混淆类 | 功能 | 关键字段/方法 |
|---|---|---|
| `q0.AbstractC0573w` | 加密/解密/签名/密钥管理 | `f10345b` session_id, `f10346c` encKey, `f10347d` macKey |
| `h0.b` | 握手流程控制 + Token 刷新 | `b()` 触发握手, `f()` 执行握手, `e()` Token 刷新 |
| `h0.c` | 加密传输层 (新) | `h()` 发送请求, `k()` 便捷 POST, `n()` 判断是否加密 |
| `h0.e` | 旧传输层 (签名但不加密) | `b()` 设签名头, `i()` 发送请求 |

**重要**: `h0.c` 是**新的加密传输层**，`h0.e` 是**旧的不加密传输层**。两者并存。

---

## 3. ECDH 握手流程 (源码确认)

### 3.1 握手端点

```
POST /auth/handshake
Content-Type: application/json

请求体:
{
  "client_pub": "Base64(EC公钥, X.509编码, flag=2)"
}

成功响应 (200):
{
  "session_id": "...",
  "server_pub": "Base64(服务器EC公钥, X.509编码)"
}
```

### 3.2 握手执行 (`h0.b.f()`)

```java
// h0/b.java 第 244-264 行
public static boolean f() {
    // 1. 生成 EC 密钥对
    AbstractC0573w.a keyPair = AbstractC0573w.f();  // secp256r1 / prime256v1
    
    // 2. 发送 client_pub 到服务器
    JSONObject req = new JSONObject();
    req.put("client_pub", keyPair.b());  // Base64 编码的公钥
    e.c resp = c("POST", "/auth/handshake", req, null);  // 不带 Bearer token!
    
    // 3. 解析响应
    JSONObject respJson = new JSONObject(resp.body);
    String sessionId = respJson.optString("session_id", "");
    String serverPub = respJson.optString("server_pub", "");
    
    // 4. 计算共享密钥并派生会话密钥
    AbstractC0573w.b keys = keyPair.a(serverPub);
    
    // 5. 存储会话
    AbstractC0573w.x(sessionId, keys.encKey, keys.macKey);
    // 存储结果: f10345b = sessionId, f10346c = encKey, f10347d = macKey
    
    return true;
}
```

### 3.3 密钥派生 (`AbstractC0573w.a.a()`)

```java
// q0/AbstractC0573w.java 第 79-86 行
public b a(String serverPubB64) {
    // 1. 解码服务器公钥
    PublicKey serverPub = KeyFactory("EC").generatePublic(
        new X509EncodedKeySpec(Base64.decode(serverPubB64, 2)));
    
    // 2. ECDH 密钥协商
    KeyAgreement ecdh = KeyAgreement.getInstance("ECDH");
    ecdh.init(this.privateKey);
    ecdh.doPhase(serverPub, true);
    byte[] sharedSecret = ecdh.generateSecret();
    
    // 3. 截断/补齐到 32 字节
    byte[] truncated = v(sharedSecret, 32);
    
    // 4. 派生加密密钥: SHA256(truncatedSecret + "enc")
    byte[] encKey = SHA256(concat(truncated, "enc".getBytes("UTF-8")));
    
    // 5. 派生 MAC 密钥: SHA256(truncatedSecret + "mac")
    byte[] macKey = SHA256(concat(truncated, "mac".getBytes("UTF-8")));
    
    return new b(encKey, macKey);
}
```

### 3.4 密钥派生图

```
ECDH 共享密钥 (任意长度)
  │
  ├─ v(secret, 32) ── 取末尾 32 字节 / 左侧补零到 32 字节
  │
  ├─ concat(truncated, "enc") ── SHA256 ──> encKey (32 字节, AES-256 密钥)
  │
  └─ concat(truncated, "mac") ── SHA256 ──> macKey (32 字节, HMAC-SHA256 密钥)
```

### 3.5 会话存储

```java
// q0/AbstractC0573w.java 第 339-349 行
public static void x(String sessionId, byte[] encKey, byte[] macKey) {
    synchronized (lock) {
        f10345b = sessionId;        // 供 X-Session 请求头使用
        f10346c = encKey.clone();   // AES-256 加密密钥
        f10347d = macKey.clone();   // HMAC-SHA256 签名/认证密钥
    }
}
```

### 3.6 握手触发条件 (`h0.b.b()`)

```java
// h0/b.java 第 87-135 行
public static boolean b() {
    if (!AbstractC0573w.u()) return false;  // 设备不支持 ECDH → 不握手
    if (AbstractC0573w.s()) return true;    // 已有会话 → 直接返回 true
    
    synchronized (lock) {
        if (handshakeInProgress) {
            // 等待其他线程完成握手 (最多 25 秒)
            long deadline = SystemClock.elapsedRealtime() + 25000;
            while (handshakeInProgress && !AbstractC0573w.s()) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) return false;  // 超时
                lock.wait(remaining);
            }
            return AbstractC0573w.s();
        }
        
        // 执行握手
        handshakeInProgress = true;
        try {
            boolean success = f();
            if (!success) AbstractC0573w.g();  // 失败时清除会话
            return success;
        } finally {
            handshakeInProgress = false;
            lock.notifyAll();
        }
    }
}
```

**注意**: 握手端点 `/auth/handshake` **不带 Bearer Token**（`null` 传给 `c()` 方法），这与普通 API 请求不同。

---

## 4. 请求体加密 (源码确认)

### 4.1 加密触发条件 (`h0.c.n()`)

```java
// h0/c.java 第 354-356 行
public static boolean n(String path) {
    if (path == null) return false;
    if (path.startsWith("/auth/handshake")) return false;  // 握手本身不加密
    if (!AbstractC0573w.u()) return false;  // 设备不支持 ECDH
    return true;
}
```

**所有非握手路径** 都加密，包括 `/auth/login`、`/auth/refresh`、所有 `/v2/` 端点等。

### 4.2 加密执行 (`h0/c.java` 第 88-112 行)

```java
// 在请求发送逻辑中:
boolean n2 = c.n(path);                              // 判断是否需要加密
if (n2 && !h0.b.b()) {                               // 触发握手（如果尚未完成）
    n2 = false;                                      // 握手失败则降级为不加密
}

byte[] bodyBytes = originalBody;                     // 原始 JSON 字节
if (n2) {
    String jsonStr = new String(bodyBytes, "UTF-8"); // 原始 JSON 字符串
    bodyBytes = AbstractC0573w.k(jsonStr)             // 加密 → 信封 JSON
                   .getBytes("UTF-8");               // 转为字节发送
    
    connection.setRequestProperty("X-Enc", "1");     // 标记加密
    connection.setRequestProperty("X-Enc-Compression", "gzip");  // 标记压缩（仅响应）
    
    String sessionId = AbstractC0573w.p();
    if (sessionId != null && sessionId.length() > 0) {
        connection.setRequestProperty("X-Session", sessionId);  // 会话 ID
    }
}
```

### 4.3 加密算法: `AbstractC0573w.k()` — 信封结构

```java
// q0/AbstractC0573w.java 第 162-178 行
public static String k(String plaintext) {
    // 1. 获取会话密钥
    b keys = q();  // 获取 encKey + macKey
    if (keys == null) throw new IllegalStateException("missing session keys");
    
    // 2. 生成随机 IV (16 字节)
    byte[] iv = new byte[16];
    new SecureRandom().nextBytes(iv);
    
    // 3. AES-CBC 加密
    Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
    cipher.init(Cipher.ENCRYPT_MODE, 
        new SecretKeySpec(keys.encKey, "AES"), 
        new IvParameterSpec(iv));
    byte[] ciphertext = cipher.doFinal(plaintext.getBytes("UTF-8"));
    
    // 4. 计算 MAC: HMAC-SHA256(macKey, iv || ciphertext)
    byte[] macInput = concat(iv, ciphertext);  // iv 在前，ciphertext 在后
    byte[] mac = HMAC_SHA256(keys.macKey, macInput);
    
    // 5. 构建信封 JSON
    JSONObject envelope = new JSONObject();
    envelope.put("iv", Base64.encodeToString(iv, 2));          // NO_WRAP
    envelope.put("data", Base64.encodeToString(ciphertext, 2)); // NO_WRAP
    envelope.put("mac", Base64.encodeToString(mac, 2));       // NO_WRAP
    return envelope.toString();
}
```

### 4.4 加密信封格式 (完整)

**发送前**:
```
原始请求体: {"identifier":"user","password":"pass"}

↓ 加密后 (成为新的 HTTP body):

{"iv":"aB...3Q==","data":"xY...7w==","mac":"kZ...9g=="}
```

**请求头**:
```
Content-Type: application/json
X-Enc: 1
X-Session: <session_id_from_handshake>
X-Enc-Compression: gzip     ← 仅标记，请求体本身不压缩
```

**信封字段**:

| 字段 | 内容 | Base64 flag | 长度 |
|---|---|---|---|
| `iv` | 16 字节随机数 (SecureRandom) | `2` (NO_WRAP) | 24 字符 |
| `data` | AES-CBC 密文 (PKCS5Padding) | `2` (NO_WRAP) | 变长 |
| `mac` | HMAC-SHA256 输出 (32 字节) | `2` (NO_WRAP) | 43-44 字符 |

**Base64 flag 说明**:
- `flag=2` = `Base64.NO_WRAP` — 不插入换行符
- `flag=3` = `Base64.NO_PADDING | Base64.NO_WRAP` — 无填充无换行（仅用于签名 nonce）

### 4.5 MAC 计算细节

```
MAC 输入 = iv_bytes (16) + ciphertext_bytes (变长)
          ↑ 原始字节，不是 Base64 编码后的字符串

MAC 算法 = HMAC-SHA256(macKey, mac_input)
MAC 输出 = 32 字节 → Base64(NO_WRAP) → 放入 "mac" 字段
```

**IV 和 MAC 的关系**: MAC 认证的是 `IV || Ciphertext` 的原始字节拼接，服务端收到后：
1. 拆解信封 JSON，获取 iv / data / mac
2. 用 macKey 验证 HMAC-SHA256(iv_bytes || data_bytes) == mac
3. 验证通过后，用 encKey + iv 解密 data

---

## 5. 响应体解密 (源码确认)

### 5.1 解密执行 (`h0/c.java` 第 133-134 行)

```java
// 请求发送时如果 n2=true，则响应也加密
if (n2) {
    String responseHeader = connection.getHeaderField("X-Enc-Compression");
    boolean isGzip = "gzip".equalsIgnoreCase(responseHeader);
    String decrypted = AbstractC0573w.j(responseBody, isGzip);
    if (decrypted != null) {
        responseBody = decrypted;  // 使用解密后的响应体
    }
}
```

### 5.2 解密算法: `AbstractC0573w.j()`

```java
// q0/AbstractC0573w.java 第 138-160 行
public static String j(String encryptedBody, boolean isGzipCompressed) {
    try {
        // 1. 解析信封 JSON
        JSONObject envelope = new JSONObject(encryptedBody);
        if (!envelope.has("iv") || !envelope.has("data") || !envelope.has("mac")) {
            return null;  // 格式错误
        }
        
        // 2. 获取会话密钥
        b keys = q();
        if (keys == null) return null;
        
        // 3. 解码
        byte[] iv = Base64.decode(envelope.getString("iv"), 2);
        byte[] ciphertext = Base64.decode(envelope.getString("data"), 2);
        byte[] mac = Base64.decode(envelope.getString("mac"), 2);
        
        // 4. 验证 MAC: HMAC-SHA256(macKey, iv || ciphertext)
        byte[] expectedMac = HMAC_SHA256(keys.macKey, concat(iv, ciphertext));
        if (!MessageDigest.isEqual(mac, expectedMac)) {
            return null;  // MAC 不匹配 → 丢弃
        }
        
        // 5. AES-CBC 解密
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, 
            new SecretKeySpec(keys.encKey, "AES"), 
            new IvParameterSpec(iv));
        byte[] plaintext = cipher.doFinal(ciphertext);
        
        // 6. 可选：GZIP 解压
        if (isGzipCompressed) {
            plaintext = gunzip(plaintext);
        }
        
        return new String(plaintext, "UTF-8");
    } catch (Exception e) {
        return null;
    }
}
```

### 5.3 响应加密格式

**服务端响应** (对 v2 加密请求):
```
HTTP/1.1 200 OK
Content-Type: application/json
X-Enc-Compression: gzip    ← 可选，表示解密后的 body 是 gzip 压缩的

{"iv":"...","data":"...","mac":"..."}
```

**解密流程**:
```
响应体 JSON
  → 解析 envelope {iv, data, mac}
  → 验证 HMAC-SHA256(macKey, iv || data)
  → AES-CBC 解密 (encKey, iv)
  → 如果 X-Enc-Compression: gzip，则 gunzip 解密结果
  → 明文 JSON
```

---

## 6. 完整请求-响应加密流程

```
客户端                              服务端
  │                                   │
  │ 1. POST /auth/handshake           │
  │    {client_pub: "..."}            │  ← 明文，无签名，无加密
  │                                ──→│
  │    ←── {session_id, server_pub}   │
  │                                   │
  │ 2. 派生 encKey + macKey           │
  │                                   │
  │ 3. POST /auth/login (加密)        │
  │    X-Enc: 1                       │
  │    X-Session: <id>                │
  │    Body: {"iv":"...","data":"...",│
  │           "mac":"..."}            │  ← 加密请求
  │                                ──→│
  │    ←── 加密响应体                   │
  │                                   │
  │ 4. 后续所有请求 (加密)             │
  │    X-Enc: 1                       │
  │    X-Session: <id>                │
  │    X-Sign: ... (v2 路径)          │
  │    加密 Body                      │  ← 加密 + 签名
  │                                ──→│
```

---

## 7. 加密与签名关系

| 特性 | 签名 (X-Sign) | 加密 (X-Enc) |
|---|---|---|
| 实现类 | `h0.e.b()` | `h0.c` → `AbstractC0573w.k()` |
| 密钥 | macKey (HMAC-SHA256) | encKey (AES-256) + macKey (MAC) |
| 覆盖范围 | `token + path + ts + nonce` | 整个请求体 |
| 触发路径 | `/v2/` 和 `/v1/v2/` 开头 | 所有非 `/auth/handshake` 路径 |
| 依赖 | ECDH 会话就绪 | ECDH 会话就绪 |
| 是否强制 | 条件性 (握手失败则跳过) | 条件性 (握手失败则降级为明文) |

**两者是独立的机制**，但都依赖 ECDH 会话密钥。一个请求可以同时携带签名和加密。

---

## 8. 客户端实现速查

### Python 实现

```python
import os
import json
import hmac
import hashlib
import base64
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

def encrypt_request_body(plaintext: str, enc_key: bytes, mac_key: bytes) -> str:
    """
    加密请求体
    enc_key: 32 字节 AES-256 密钥
    mac_key: 32 字节 HMAC-SHA256 密钥
    """
    # 1. 随机 IV
    iv = os.urandom(16)
    
    # 2. AES-CBC 加密
    cipher = Cipher(algorithms.AES(enc_key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    
    # PKCS7 填充 (AES 块大小 = 16)
    pad_len = 16 - (len(plaintext) % 16)
    padded = plaintext + chr(pad_len) * pad_len
    
    ciphertext = encryptor.update(padded.encode('utf-8')) + encryptor.finalize()
    
    # 3. HMAC-SHA256 (iv || ciphertext)
    mac_input = iv + ciphertext
    mac = hmac.new(mac_key, mac_input, hashlib.sha256).digest()
    
    # 4. 构建信封
    envelope = {
        "iv": base64.b64encode(iv).decode(),
        "data": base64.b64encode(ciphertext).decode(),
        "mac": base64.b64encode(mac).decode()
    }
    return json.dumps(envelope, separators=(',', ':'))


def decrypt_response_body(encrypted_body: str, enc_key: bytes, mac_key: bytes,
                          is_gzip: bool = False) -> str:
    """
    解密响应体
    """
    envelope = json.loads(encrypted_body)
    iv = base64.b64decode(envelope["iv"])
    ciphertext = base64.b64decode(envelope["data"])
    mac = base64.b64decode(envelope["mac"])
    
    # 验证 MAC
    expected_mac = hmac.new(mac_key, iv + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expected_mac):
        raise ValueError("MAC mismatch")
    
    # AES-CBC 解密
    cipher = Cipher(algorithms.AES(enc_key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    
    # 移除 PKCS7 填充
    pad_len = padded[-1]
    plaintext = padded[:-pad_len]
    
    if is_gzip:
        import gzip
        plaintext = gzip.decompress(plaintext)
    
    return plaintext.decode('utf-8')


def generate_v2_sign(mac_key: bytes, token: str, path: str,
                     timestamp: str, nonce: str) -> str:
    """生成 v2 签名"""
    data = f"{token}\n{path}\n{timestamp}\n{nonce}"
    sig = hmac.new(mac_key, data.encode('utf-8'), hashlib.sha256).digest()
    return base64.b64encode(sig).rstrip(b'=').decode()


def generate_nonce() -> str:
    """生成 nonce (16 字节随机 → Base64 无填充)"""
    return base64.b64encode(os.urandom(16)).rstrip(b'=').decode()
```

---

## 9. 安全性分析

### 9.1 加密强度

| 组件 | 算法 | 强度 |
|---|---|---|
| 密钥协商 | ECDH secp256r1 | 128 位安全级别 |
| 对称加密 | AES-256-CBC | 256 位密钥 |
| 消息认证 | HMAC-SHA256 | 256 位密钥 |
| 随机数 | SecureRandom | 密码学安全 |

### 9.2 MAC-then-Encrypt vs Encrypt-then-MAC

客户端实现是 **Encrypt-then-MAC** (`iv || ciphertext` 作为 MAC 输入)，这是正确的安全做法，可以防止 padding oracle 攻击。

### 9.3 已知局限

1. **IV 随机性**: 依赖 SecureRandom，Android 4.4 以下版本有已知的 SecureRandom 漏洞
2. **会话密钥持久化**: 会话密钥仅存储在内存中，应用重启后需要重新握手
3. **无前向保密**: ECDH 私钥在握手期间不变，如果私钥泄露，所有历史会话可解密
4. **握手端点无认证**: `/auth/handshake` 不带 Bearer Token，任何人均可触发握手