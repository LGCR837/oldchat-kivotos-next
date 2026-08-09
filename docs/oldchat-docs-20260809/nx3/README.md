# OldChat v1.4.x 技术文档导航

> 基于 jadx 反编译分析 (oldchat(2).apk, 6.7MB, 1067 files, 183 Java源文件) + 历史版本文档交叉验证  
> 更新时间: 2026年8月

---

## 文档索引

| # | 文件 | 内容 | 关键词 |
|---|---|---|---|
| 00 | [项目总览与架构](00-项目总览与架构.md) | 应用信息、架构图、技术栈、包结构、混淆分析 | overview, architecture |
| 01 | [Android客户端架构深度分析](01-Android客户端架构深度分析.md) | 76个Activities、4个Services、Fragment、自定义控件 | activities, services, ui |
| 02 | [网络层与API通信机制](02-网络层与API通信机制.md) | OkHttp、API端点、认证、WebSocket、通知系统 | api, http, websocket |
| 03 | [消息JSON格式与接口规范](03-消息JSON格式与接口规范.md) | **消息类型、v2格式、WS推送、收发协议、阅后即焚** | **message, json, protocol** ⭐ |
| 04 | [数据模型与存储系统](04-数据模型与存储系统.md) | SharedPreferences、数据库、文件缓存、BiliModels | storage, database, cache |
| 05 | [多媒体与音乐系统](05-多媒体与音乐系统.md) | 音乐播放、资源上传、图片处理、二维码、播放列表、歌词 | music, media, upload |
| 06 | [B站集成与扩展功能](06-B站集成与扩展功能.md) | B站模块(Wbi签名)、小程序平台(CIP)、新闻、签到墙 | bili, lua, cip |
| 07 | [安全机制与加密体系](07-安全机制与加密体系.md) | Conscrypt TLS、SpongyCastle、权限分析、安全风险 | security, encryption, tls |
| 08 | [ECDH握手协议与加密流程详解](08-ECDH握手协议与加密流程详解.md) | ECDH协议、密钥协商、消息加密、密钥管理 | ecdh, handshake, e2ee |

---

## 快速导航

### 我想了解...

- **应用整体结构** → [00-项目总览与架构](00-项目总览与架构.md)
- **有哪些页面/功能** → [01-Android客户端架构深度分析](01-Android客户端架构深度分析.md)
- **API怎么调用** → [02-网络层与API通信机制](02-网络层与API通信机制.md)
- **消息长什么样** → [03-消息JSON格式与接口规范](03-消息JSON格式与接口规范.md) ⭐
- **数据存在哪里** → [04-数据模型与存储系统](04-数据模型与存储系统.md)
- **音乐/视频怎么播** → [05-多媒体与音乐系统](05-多媒体与音乐系统.md)
- **B站/小程序/签到** → [06-B站集成与扩展功能](06-B站集成与扩展功能.md)
- **加密/TLS怎么做的** → [07-安全机制与加密体系](07-安全机制与加密体系.md) + [08-ECDH详解](08-ECDH握手协议与加密流程详解.md)

### 第三方客户端开发者必读

1. [02-网络层与API通信机制](02-网络层与API通信机制.md) — 认证流程、API端点
2. **[03-消息JSON格式与接口规范](03-消息JSON格式与接口规范.md)** — 消息收发的核心
3. [06-B站集成与扩展功能](06-B站集成与扩展功能.md) — 小程序平台
4. [07-安全机制与加密体系](07-安全机制与加密体系.md) — Conscrypt TLS集成

---

## 版本对比

| 文件 | 内容 |
|---|---|
| [oldchat-diff-v1.2.34-vs-v1.3.61.md](oldchat-diff-v1.2.34-vs-v1.3.61.md) | 5月→7月版本差异（20个维度对比） |
| [oldchat-diff-v1.3.61-vs-v1.4.x.md](oldchat-diff-v1.3.61-vs-v1.4.x.md) | 7月→8月版本差异（Conscrypt TLS、音乐系统增强、B站重构） |
| [oldchat-diff-release-vs-dev.md](oldchat-diff-release-vs-dev.md) | **正式版 vs 测试版**：v2 API 全面迁移(53端点)、国密、数据库/NCUID 深度集成、群邀请重构 |
| [oldchat-diff-release-vs-dev2.md](oldchat-diff-release-vs-dev2.md) | **Release vs Dev2**：频道系统(全新)、文件系统重构+秒传、v2 签名机制、JSON 字段对比 |

---

## v1.4.x 核心变化速览 (jadx 反编译确认)

| 领域 | 变化 | 影响 |
|---|---|---|
| 🔐 **安全层** | Conscrypt TLS 库集成 (156个Java文件)，原生 JNI 加速 (libconscrypt_jni.so × 4 ABI) | TLS 1.0-1.3 全版本支持，APK 3.3→6.7MB |
| 🎵 **音乐系统** | 播放列表(PlaylistDetailActivity)、歌词(LyricCascadeView)、搜索(MusicSearchActivity)、分类(MusicCategoryActivity) | 功能大幅增强，新增3个API端点 |
| 📺 **B站模块** | 完整重构：BiliApi(7个内部类)、BiliWbiSigner(Wbi签名)、BiliAuthStore、40+数据模型 | API覆盖率大幅提升 |
| 🔍 **搜索能力** | 私聊/群消息搜索、EmojiPlazaSearchActivity、MusicSearchActivity | 用户体验提升 |
| 🆔 **NCUID迁移** | 14处→30+处使用NCUID，新增friend_ncuid/to_ncuid/member_ncuids等9个字段 | 用户标识体系重大升级，双写双读策略 |
| ❌ **RegisterActivity移除** | 旧版POST `/auth/register` → 新版浏览器跳转 `/register` | 注册流程外置 |
| 📦 **APK体积** | 3.3MB → 6.7MB (+103%) | Conscrypt 原生库导致体积翻倍 |

---

## jadx 反编译数据摘要

| 属性 | 旧版 (v1.3.61) | 新版 (v1.4.x) | 变化 |
|---|---|---|---|
| APK大小 | 3.3MB | 6.7MB | +103% |
| 文件总数 | 1052 | 1067 | +15 |
| DEX大小 | 2.9MB | 3.4MB | +17% |
| DEX字符串 | 25841 | 31144 | +20.5% |
| Java源文件 | 161 | 183 | +22 |
| 原生库 | 0 | 4 (libconscrypt_jni.so) | 新增 |
| Activities | 73 | 76 | +3 |
| 权限 | 13 | 13 | 不变 |
| R8 Map-ID | a8a22b4 | 2a5d39f | 变化 |
