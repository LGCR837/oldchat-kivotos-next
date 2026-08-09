# 07 - ECDH 握手协议与加密流程详解 (v1.3.61)

---

## 1. ECDH 协议基础

### 1.1 椭圆曲线 Diffie-Hellman (ECDH)

ECDH 是 Diffie-Hellman 密钥交换协议的椭圆曲线变体，允许两方在不安全的信道上安全地协商出一个共享秘密。

### 1.2 数学原理

```
参数: 椭圆曲线 E, 基点 G, 阶 n

用户A:                              用户B:
  私钥: a (随机数)                    私钥: b (随机数)
  公钥: A = a × G                    公钥: B = b × G

  交换公钥 A ↔ B

  共享密钥:                          共享密钥:
  S = a × B = a × (b × G)           S = b × A = b × (a × G)
    = ab × G                          = ab × G

  S(A) = S(B) = ab × G  ✓
```

### 1.3 安全性

即使攻击者截获了公钥 A 和 B，也无法计算共享密钥 S，因为求解椭圆曲线离散对数问题 (ECDLP) 在计算上是不可行的。

---

## 2. OldChat 中的 ECDH 实现

### 2.1 依赖库

- **SpongyCastle**: 提供 ECDH 实现
- 包名: `org.spongycastle.crypto.agreement`
- 关键类:
  - `ECDHBasicAgreement` — ECDH 基本协商
  - `ECKeyPairGenerator` — 椭圆曲线密钥对生成器
  - `ECDomainParameters` — 曲线参数
  - `ECPrivateKeyParameters` / `ECPublicKeyParameters` — 密钥参数

### 2.2 推测的握手流程

```
┌─────────────────────────────────────────────────────────────┐
│                    ECDH 握手流程                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 初始化阶段                                               │
│     ├── 选择椭圆曲线 (如 secp256r1/prime256v1)               │
│     └── 获取曲线参数 (ECDomainParameters)                    │
│                                                             │
│  2. 密钥对生成                                               │
│     ├── 生成随机数 a (SecureRandom)                          │
│     ├── 计算公钥 A = a × G                                  │
│     └── 保存密钥对 (a, A)                                   │
│                                                             │
│  3. 公钥交换                                                 │
│     ├── 将公钥 A 编码为字节/字符串                           │
│     ├── 通过服务器中转发送给对方                             │
│     └── 接收对方公钥 B                                      │
│                                                             │
│  4. 共享密钥计算                                             │
│     ├── 解码对方公钥 B                                      │
│     ├── 计算 S = a × B                                      │
│     └── 导出共享密钥字节 (S.getBytes())                     │
│                                                             │
│  5. 密钥派生                                                 │
│     ├── 对共享密钥进行 SHA-256 哈希                          │
│     ├── 派生加密密钥 (AES Key)                              │
│     └── 派生 MAC 密钥 (可选)                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 推测的代码结构

```java
// 密钥对生成
ECKeyPairGenerator generator = new ECKeyPairGenerator();
ECKeyGenerationParameters params = new ECKeyGenerationParameters(
    ecDomainParameters, new SecureRandom());
generator.init(params);
AsymmetricCipherKeyPair keyPair = generator.generateKeyPair();

// ECDH 协商
ECDHBasicAgreement agreement = new ECDHBasicAgreement();
agreement.init(keyPair.getPrivate());
byte[] sharedSecret = agreement.calculateAgreement(otherPublicKey).toByteArray();

// 密钥派生
byte[] encryptionKey = SHA256(sharedSecret);
```

---

## 3. 消息加密流程

### 3.1 推测的端到端加密流程

```
发送方                                    接收方
  │                                        │
  │ 1. 获取共享密钥 (ECDH)                  │
  │    S = a × B                           │ S = b × A
  │                                        │
  │ 2. 派生加密密钥                         │
  │    Key = SHA256(S)                     │ Key = SHA256(S)
  │                                        │
  │ 3. 加密消息                             │
  │    IV = Random(16)                     │
  │    Ciphertext = AES-CBC(Key, IV, Msg)  │
  │    Tag = HMAC(Key, IV || Ciphertext)   │
  │                                        │
  │ 4. 发送 (IV, Ciphertext, Tag) ────────→│
  │                                        │ 5. 验证 Tag
  │                                        │ 6. 解密消息
  │                                        │    Msg = AES-CBC-Dec(Key, IV, Ciphertext)
```

### 3.2 加密算法推测

| 组件 | 算法 | 说明 |
|---|---|---|
| 密钥协商 | ECDH (secp256r1) | 椭圆曲线参数 |
| 密钥派生 | SHA-256 | 从共享密钥派生加密密钥 |
| 对称加密 | AES-CBC 或 AES-GCM | 消息加密 |
| 消息认证 | HMAC-SHA256 | 防篡改 |
| 随机数 | SecureRandom | IV生成 |

### 3.3 SpongyCastle 在消息加密中的使用

```java
// AES-CBC 加密
AESEngine aes = new AESEngine();
CBCBlockCipher cbc = new CBCBlockCipher(aes);
PaddedBufferedBlockCipher cipher = new PaddedBufferedBlockCipher(cbc);

// 参数设置
cipher.init(true, new ParametersWithIV(
    new KeyParameter(encryptionKey), iv));

// 加密
byte[] output = new byte[cipher.getOutputSize(input.length)];
int len = cipher.processBytes(input, 0, input.length, output, 0);
len += cipher.doFinal(output, len);
```

---

## 4. 密钥管理

### 4.1 密钥生命周期

```
1. 用户注册/首次登录
   └── 生成长期密钥对 (Identity Key)

2. 每次会话
   ├── 生成临时密钥对 (Ephemeral Key)
   ├── 执行 ECDH 握手
   └── 派生会话密钥 (Session Key)

3. 消息加密
   └── 使用会话密钥加密

4. 密钥轮换
   ├── 定期更换临时密钥
   └── 重新执行 ECDH 握手
```

### 4.2 推测的密钥存储

| 密钥 | 存储位置 | 生命周期 |
|---|---|---|
| 长期私钥 | SharedPreferences (加密) | 永久 |
| 长期公钥 | 服务端 | 永久 |
| 临时私钥 | 内存 | 会话期间 |
| 会话密钥 | 内存 | 会话期间 |

### 4.3 密钥初始化

在 `OldChatApplication.onCreate()` 中:
```java
AbstractC0437d.g(this, token);  // 认证初始化，可能包含密钥加载
```

在 `MainActivity.onCreate()` 中:
```java
AbstractC0437d.g(this, token);  // 确保密钥已初始化
```

---

## 5. 安全通信层

### 5.1 双层加密

```
┌─────────────────────────────────┐
│       应用层加密 (E2EE)          │  ECDH + AES
├─────────────────────────────────┤
│       传输层加密 (TLS)           │  HTTPS
├─────────────────────────────────┤
│       传输层                     │  TCP
└─────────────────────────────────┘
```

- **应用层**: ECDH 密钥协商 + AES 消息加密 (端到端加密)
- **传输层**: TLS/HTTPS (传输加密)

### 5.2 安全性分析

| 攻击向量 | 防护 |
|---|---|
| 窃听 (Eavesdropping) | TLS + E2EE |
| 中间人 (MITM) | TLS (但 usesCleartextTraffic=true 是风险) |
| 服务端泄露 | E2EE 保护消息内容 |
| 设备丢失 | Token/密钥存储安全 |

### 5.3 局限性

1. **usesCleartextTraffic=true**: 允许降级到 HTTP
2. **无证书固定**: 可能被 MITM 攻击
3. **密钥存储**: SharedPreferences 明文存储
4. **元数据**: 通信对象、时间、频率等元数据不受 E2EE 保护

---

## 6. 加密相关混淆类映射

| 混淆名 | 推测功能 |
|---|---|
| `o0.AbstractC0437d` | 认证初始化 / 密钥加载 |
| `o0.AbstractC0435c` | 后台密钥管理 / 轮换 |
| `h0.d` | 参数签名工具 |
| `o0.f` | 全局标志 (调试/加密模式) |
| `o0.A` | URL处理 (可能包含URL加密) |

---

## 7. 与其他加密方案对比

| 方案 | OldChat ECDH | Signal Protocol | Telegram MTProto |
|---|---|---|---|
| 密钥协商 | ECDH | X3DH | DH |
| 前向保密 | 推测有限 | 双棘轮 | 有限 |
| 群组加密 | 未知 | Sender Keys | 群组密钥 |
| 密钥验证 | 未知 | 安全号码 | 指纹 |
| 开源 | 否 | 是 | 是 |

OldChat 的 ECDH 实现细节由于代码混淆难以完全确认，但从 SpongyCastle 的使用和相关类的结构来看，至少实现了基本的 ECDH 密钥协商。完整的端到端加密实现程度需要进一步的动态分析确认。
