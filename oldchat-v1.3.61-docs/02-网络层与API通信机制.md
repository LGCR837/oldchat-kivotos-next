# 02 - 网络层与 API 通信机制 (v1.3.61)

---

## 1. HTTP 客户端架构

### 1.1 底层实现

- **HTTP库**: OkHttp
- **封装类**: `g0.d` (混淆后的网络请求工具类)
- **连接管理**: `g0.j` (WebSocket/长连接管理器)
- **网络状态检测**: `o0.G` (v1.3.61新增 `ACCESS_NETWORK_STATE` 权限后更精确)
- **服务器配置**: `o0.U` (管理 Base URL)

### 1.2 请求流程

```
UI层 (Activity/Fragment)
    ↓ 调用 g0.d 方法
请求封装层 (g0.d)
    ├── 添加 Authorization: Bearer <token>
    ├── 构造请求体 (JSON/Multipart)
    └── 通过 OkHttp 发送
        ↓
    OkHttp
        ├── HTTP/HTTPS
        └── 明文HTTP允许 (usesCleartextTraffic=true)
```

### 1.3 回调接口

```java
// g0.d.i — 通用回调接口
public interface i {
    void b(String response);           // 成功回调
    void c(int errorCode, String error); // 失败回调
}

// g0.d.j — 上传进度回调
public interface j {
    void a(long uploaded, long total);  // 进度回调
}

// g0.d.k — 上传数据源
public interface k {
    InputStream a() throws Exception;   // 获取输入流
    long length();                       // 获取文件大小
}
```

---

## 2. 已知 API 端点

### 2.1 认证相关

| 方法 | 路径 | 用途 | 请求体 |
|---|---|---|---|
| POST | `/auth/login` | 用户登录 | identifier, password, device_id, imei, device_name, platform, app_version |

**登录响应**:
```json
{
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "user": {
        "id": "数据库ID",
        "uid": "用户UID"
    }
}
```

### 2.2 好友相关

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/friends/requests` | 获取好友请求列表 |

**响应结构**:
```json
{
    "requests": [
        {
            "status": 0,  // 0=未处理, 1=已处理
            ...
        }
    ]
}
```

### 2.3 通知相关

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/notifications?limit=1` | 获取最新通知 |

**响应结构**:
```json
{
    "notifications": [
        {
            "id": "通知ID",
            "title": "通知标题",
            "body": "通知内容",
            "important": false
        }
    ]
}
```

### 2.4 资源相关

| 方法 | 路径 | 用途 | Content-Type |
|---|---|---|---|
| POST | `/resources/upload` | 上传资源文件 | multipart/form-data |

**上传参数**: section_id, file_name, content_type (通过 g0.d.U 方法)

### 2.5 通用请求方法

| 方法 | 功能 |
|---|---|
| `g0.d.R(path, token, callback)` | GET 请求 |
| `g0.d.S(path, json, token, callback)` | POST 请求 (JSON) |
| `g0.d.U(path, dataSource, fileName, contentType, token, ...)` | Multipart 上传 |

---

## 3. 认证机制

### 3.1 Token 认证

- **存储**: `SharedPreferences("auth")`
- **键名**: `access_token`, `refresh_token`
- **请求头**: `Authorization: Bearer <access_token>`
- **Token刷新**: 通过 `refresh_token` 获取新的 `access_token` (具体端点未明确)

### 3.2 设备标识

登录时携带以下设备信息:

| 字段 | 获取方法 | 说明 |
|---|---|---|
| device_id | `AbstractC0445k.b(context)` | 设备唯一ID |
| imei | `AbstractC0445k.d(context)` | IMEI号 |
| device_name | `AbstractC0445k.c()` | 设备型号名称 |
| platform | 硬编码 "android" | 平台标识 |
| app_version | `AbstractC0445k.a(context)` | 应用版本号 |

### 3.3 服务器配置

- **默认地址**: 通过 `o0.U.b()` 获取
- **自定义地址**: 用户可通过长按登录页图标设置
- **地址格式**: `http(s)://host[:port][/path]`
- **存储**: 通过 `o0.U.f(context, url)` 保存
- **恢复默认**: `o0.U.e(context)`

---

## 4. WebSocket / 长连接

### 4.1 连接管理器

- **类**: `g0.j` (混淆后)
- **单例**: `j.u()` 获取实例
- **连接**: `j.u().z(context)` — 建立/恢复连接
- **断开**: `j.u().A()` — 断开连接

### 4.2 连接生命周期

```
OldChatApplication.onCreate()
    → j.u().z(this) // 初始化连接

MessageService.onCreate()
    → j.u().z(context) // 服务启动时连接

MessageService.onStartCommand()
    → j.u().z(context) // 每次启动命令时确保连接

MessageService.onDestroy()
    → j.u().A() // 服务销毁时断开

MainActivity.onResume()
    → j.u().z(this) // 恢复时确保连接
```

### 4.3 连接模式

在 `OldChatApplication.onCreate()` 中:
```java
f.B(V.g(this) ? 2 : 1);
// V.g(context) 检测是否WiFi环境
// WiFi: 模式2, 其他: 模式1
```

推测不同模式下连接参数（心跳间隔、超时时间等）不同。

---

## 5. 网络状态检测

### 5.1 v1.3.61 改进

v1.3.61 新增了 `ACCESS_NETWORK_STATE` 权限，允许更精确地检测网络状态。

在 `ResourceUploadService` 中:
```java
if (!G.d().f()) {
    // 网络不可用，返回错误
    r(section_id, -1, "network_unavailable");
    stopSelf();
}
```

### 5.2 WiFi 检测

在 `MusicPlaybackService` 中有 WiFi 检测逻辑:
```java
public final boolean R() {
    ConnectivityManager cm = getSystemService("connectivity");
    NetworkInfo info = cm.getActiveNetworkInfo();
    if (info != null && info.isConnected()) {
        // 检查是否计量网络
        if (cm.isActiveNetworkMetered()) return false;
        int type = info.getType();
        if (type == 1 || type == 9 || type == 6) return true; // WiFi/以太网
    }
    return false;
}
```

---

## 6. 事件分发机制

### 6.1 LocalBroadcastManager

应用使用 Android 的 `LocalBroadcastManager` 进行进程内事件分发:

| 广播 Action | 发送者 | 接收者 |
|---|---|---|
| RESOURCE_UPLOAD_DONE | ResourceUploadService | 资源上传UI |
| RESOURCE_UPLOAD_ERROR | ResourceUploadService | 资源上传UI |
| RESOURCE_UPLOAD_PROGRESS | ResourceUploadService | 资源上传UI |
| music.STATE_CHANGED | MusicPlaybackService | MusicPlayerActivity |
| music.CACHE_RESULT | MusicPlaybackService | MusicDownloadsActivity |

### 6.2 广播工具

- **发送**: `q.c(context).e(intent)` — 通过 `d.q` 类的单例发送本地广播
- **接收**: 标准 `BroadcastReceiver` 注册

---

## 7. 通知系统

### 7.1 通知渠道

| 渠道ID | 名称 | 重要性 | 使用者 |
|---|---|---|---|
| oldchat_service | 后台连接 | LOW | MessageService |
| oldchat_upload | 资源上传 | LOW | ResourceUploadService |
| oldchat_music_playback | 音乐播放 | LOW | MusicPlaybackService |

### 7.2 通知构建

- **工具类**: `o0.H` — 通知渠道管理 (`H.a(manager, id, name, importance)`)
- **工具类**: `o0.J` — 通知构建器
  - `J.c(context, channel, icon, title, text, ongoing, pendingIntent)` — 简单通知
  - `J.d(context, channel, icon, title, text, ongoing, max, progress, indeterminate, ...)` — 进度通知

---

## 8. 安全相关

### 8.1 明文流量

`usesCleartextTraffic=true` 允许 HTTP 明文通信。这意味着:
- API 请求可能通过未加密的 HTTP 发送
- Token 和密码可能以明文传输
- 存在中间人攻击风险

### 8.2 证书固定

反编译代码中未发现明显的证书固定 (Certificate Pinning) 实现。OkHttp 默认信任系统证书库。

---

## 9. B站 API 通信

### 9.1 B站API封装

- **封装类**: `com.im.oldchat.bili.c`
- **HTTP方法**: `c.j(url, params, cookie)` — GET请求
- **签名**: `h0.d.b(params)` — 参数签名
- **JSON解析**: 使用自定义JSON解析器 (`c.f2209a.i(json, class)`)

### 9.2 已知B站API

| 端点 | 功能 |
|---|---|
| `https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code` | 获取QR登录码 |
| (更多端点在 bili/a-f.java 中) | 视频、评论、用户信息等 |

### 9.3 QR码登录流程

1. 请求 `auth_code` API 获取二维码
2. 展示二维码供用户扫描
3. 轮询检查扫码状态
4. 获取 cookies 完成登录
