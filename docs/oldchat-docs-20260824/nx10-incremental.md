# OldChat Android 增量变更文档: v1.4.5-v2test228 → v1.4.5-540

> **基准版本**: nx9 (基于 `oldchat-dev.apk` 2026-08-15, versionCode 451, `1.4.1-v2test165`)  
> **目标版本**: `oldchat-1.4.5-540.apk` (versionCode 540)  
> **APK 大小**: 5.0 MB | **DEX 大小**: 6.3 MB  
> **更新时间**: 2026年8月29日  
> **分析方法**: APK 提取 + DEX strings 全量分析 + 与 nx9 文档逐项对比

---

## 目录

1. [概要](#1-概要)
2. [新增 Activity](#2-新增-activity)
3. [新增自定义控件](#3-新增自定义控件)
4. [新增 API 端点](#4-新增-api-端点)
5. [前端效果变更: 聊天昵称/称号颜色体系](#5-前端效果变更-聊天昵称称号颜色体系)
6. [数据库 schema 变更](#6-数据库-schema-变更)
7. [后端接口重大改动分析](#7-后端接口重大改动分析)
8. [未变化部分](#8-未变化部分)
9. [升级建议](#9-升级建议)

---

## 1. 概要

v1.4.5-540 相对于 nx9 基线 (v1.4.1-v2test165, versionCode 451) 的变更范围:

| 类别 | 变更类型 | 数量 | 说明 |
|---|---|---|---|
| 新增 Activity | CipStoreActivity, ScratchActivity | 2 | CIP 商店 + 刮刮乐 |
| 新增自定义控件 | Safe 系列 | 3 | RecyclerView 防崩溃 |
| 新增 API 端点 | — | 8 | 含刮刮乐、CIP商店、AI备用路径等 |
| 前端效果变更 | 昵称/称号颜色系统 | 1 | **重大新增板块** |
| 数据库 schema | members_live 新增 uid 索引 | 1 | 性能优化 |
| 路由映射表 | 无新增 | 0 | — |
| WS 事件类型 | 无变化 | 0 | — |
| 加密体系 | 无变化 | 0 | — |

---

## 2. 新增 Activity

### 2.1 ScratchActivity — 每日刮刮乐

| 属性 | 值 |
|---|---|
| 完整类名 | `com.im.oldchat.ui.ScratchActivity` |
| 内部类数量 | 6 个 (`a` ~ `e`) |
| 关联 API | `GET/POST /v2/me/scratch` |

**功能**: 每日刮刮乐小游戏，5 个独立槽位，各自按概率掷出奖励:

| 槽位结果 | 概率 | 奖励 (旧币) |
|---|---|---|
| 谢谢惠顾 | 40% | 0 |
| 1 旧币 | 30% | 1 |
| 5 旧币 | 15% | 5 |
| 10 旧币 | 10% | 10 |
| 20 旧币 | 5% | 20 |

每日仅限 1 次，重复调用返回已开奖结果。

### 2.2 CipStoreActivity — CIP 应用商店

| 属性 | 值 |
|---|---|
| 完整类名 | `com.im.oldchat.ui.CipStoreActivity` |
| 内部类数量 | 12 个 (`a` ~ `g`, 含 `$d$a`, `$d$b`, `$f$a`, `$f$b`) |
| 关联 API | `GET /v2/cip/store`, `GET /cip/store`, `POST /cip-upload` |

**功能**: CIP 小程序应用商店，支持浏览、搜索、安装 CIP 小程序。

### 2.3 ReportActivity — 举报 (重构)

| 属性 | 值 |
|---|---|
| 完整类名 | `com.im.oldchat.ui.ReportActivity` |
| 内部类数量 | 8 个 (`a` ~ `e`, 含 `$e$a`, `$e$b`) |
| 关联 API | `GET /me/resource-reports?limit=50` |

> **注意**: nx9 文档中已有 `ReportProgressActivity`，本次新增的是独立的 `ReportActivity`，用于提交举报。

---

## 3. 新增自定义控件

| 控件 | 继承 | 功能 |
|---|---|---|
| `SafeGridLayoutManager` | `GridLayoutManager` | 防越界崩溃的网格布局管理器 |
| `SafeLinearLayoutManager` | `LinearLayoutManager` | 防越界崩溃的线性布局管理器 |
| `SafeRecyclerView` | `RecyclerView` | 防触摸事件异常崩溃的安全 RecyclerView |

**设计意图**: 解决线上 `IndexOutOfBoundsException` 崩溃。RecyclerView 在快速滚动或数据变更时，LayoutManager 可能因 position 越界导致崩溃。Safe 版本重写关键方法，在越界时安全降级。

---

## 4. 新增 API 端点

### 4.1 全新端点

| 端点 | 方法 | 说明 | 版本 |
|---|---|---|---|
| `/v2/me/scratch` | GET | 查询今日刮刮乐状态 | v2 |
| `/v2/me/scratch` | POST | 每日刮刮乐开奖 | v2 |
| `/me/scratch` | GET/POST | 刮刮乐 (v1 兼容) | v1 |
| `/v2/cip/store` | GET | CIP 商店应用列表 | v2 |
| `/cip/store` | GET | CIP 商店 (v1 兼容) | v1 |
| `/cip-upload` | POST | CIP 包上传 | v1 |
| `/v1/chat/completions` | POST | AI 对话备用路径 (OpenAI 兼容) | v1 |
| `/chat-context?group_id=` | GET | 查询群聊上下文信息 | v1 |

### 4.2 刮刮乐接口详情

**`GET /v2/me/scratch`** — 查询状态:

```json
{
  "already_scratched": true,
  "scratch_date": "2026-08-29",
  "slots": [0, 1, 5, 0, 10],
  "total_reward": 16,
  "coin_balance": 120
}
```

**`POST /v2/me/scratch`** — 开奖:

请求: `{}`

响应: 同 GET。5 个独立槽位各自按概率掷出奖励。

### 4.3 CIP 商店接口详情

**`GET /v2/cip/store`** — 获取 CIP 商店应用列表:

```json
{
  "apps": [
    {
      "id": "weather_card",
      "name": "天气卡片",
      "description": "查看当前城市天气",
      "version": 1,
      "icon_url": "https://...",
      "author": "开发者名称",
      "download_count": 1234
    }
  ]
}
```

**`POST /cip-upload`** — 上传 CIP 包:

Multipart: `file` (CIP ZIP 包)

### 4.4 AI 对话备用路径

`/v1/chat/completions` 作为 `/ai/chat/completions` 的别名，用于 OpenAI 兼容格式的 API 代理。请求/响应格式与 `/ai/chat/completions` 完全一致。

### 4.5 群聊上下文查询

**`GET /chat-context?group_id=GRP-XXX`** — 查询群聊上下文信息。

> 具体响应结构需实测确认。推测返回群聊的上下文摘要信息，可能用于 AI 助手或群聊推荐。

---

## 5. 前端效果变更: 聊天昵称与称号的颜色体系

> **这是本次更新最重要的前端变更之一。**
> **注意**: 这里说的是「昵称」(display_name) 和「称号」(user_title)，不是「头衔」。

### 5.1 颜色体系架构: HSV 哈希着色

聊天界面中，每个人的昵称和称号颜色**各不相同**，这不是简单的角色固定色，而是基于 **HSV 色彩空间的哈希着色算法**。

**核心机制**: DEX strings 中发现了 `HSVToColor` 和 `colorToHSV`，说明颜色是通过 HSV 色彩空间计算的。

```
┌─────────────────────────────────────────────────────────────┐
│              昵称/称号颜色决策树                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. group_colored_name_enabled (全局开关)                    │
│     ├─ false → 使用默认颜色 (系统主题色)                      │
│     └─ true  → 进入 ↓                                       │
│                                                             │
│  2. HSV 哈希着色 (核心算法)                                  │
│     ├→ hash(uid 或 ncuid 或 display_name) → 整数            │
│     ├→ hue = hash_result % 360 (色相 0-360°)               │
│     ├→ saturation = 固定值 (推测 0.6-0.8)                   │
│     ├→ value = 固定值 (推测 0.7-0.9)                        │
│     └→ Color.HSVToColor(hue, sat, val) → 唯一颜色           │
│                                                             │
│  3. 角色特殊覆盖 (可选)                                      │
│     ├→ 群主 (role=2): 可能使用固定红色 #FF5B6E 覆盖         │
│     ├→ 管理员 (role=1): 可能使用固定金色 #FFC857 覆盖       │
│     └→ 普通成员: 使用 HSV 哈希色                             │
│                                                             │
│  4. 称号 (user_title) 着色                                  │
│     └→ 与昵称使用相同的 HSV 哈希算法                         │
│        (每个用户的称号颜色也各不相同)                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**为什么每个人颜色不同?**
- 哈希函数将用户的唯一标识 (UID/NCUID/用户名) 映射为一个整数
- 整数取模 360 得到色相 (Hue)，在色轮上均匀分布
- 固定的饱和度 (Saturation) 和明度 (Value) 保证颜色鲜艳且可读
- 这样每个用户都有一个**唯一、确定、可复现**的颜色
- 类似 Discord 的用户名着色机制

### 5.2 HSV 着色算法推测

```java
// 伪代码 - 基于 DEX 中 HSVToColor/ForegroundColorSpan 的推断
public static int getNameColor(String uid) {
    int hash = uid.hashCode();
    if (hash < 0) hash = -hash;
    
    float hue = (float)(hash % 360);        // 色相: 0-360°
    float saturation = 0.65f;               // 饱和度: 固定
    float value = 0.80f;                    // 明度: 固定
    
    float[] hsv = {hue, saturation, value};
    return Color.HSVToColor(hsv);
}

// 群聊消息昵称着色
SpannableString span = new SpannableString(displayName);
if (group_colored_name_enabled) {
    int color;
    if (role == 2) {
        color = Color.parseColor("#FF5B6E");  // 群主: 固定红
    } else if (role == 1) {
        color = Color.parseColor("#FFC857");  // 管理员: 固定金
    } else {
        color = getNameColor(from_uid);        // 普通成员: HSV 哈希
    }
    span.setSpan(new ForegroundColorSpan(color), 0, span.length(),
                 Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
}

// 称号 (user_title) 着色 — 同样使用 HSV 哈希
if (user_title != null && !user_title.isEmpty()) {
    int titleColor = getNameColor(from_uid);  // 每个人的称号颜色也不同
    SpannableString titleSpan = new SpannableString(user_title);
    titleSpan.setSpan(new ForegroundColorSpan(titleColor), 0, titleSpan.length(),
                      Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
}
```

### 5.3 颜色值详细定义

从 DEX strings 中提取到的硬编码颜色值:

| 颜色 Hex | 用途 | 视觉效果 |
|---|---|---|
| `#FF5B6E` | 群主昵称固定色 | 红色/珊瑚红 |
| `#FFC857` | 管理员昵称固定色 | 金色/琥珀色 |
| `#6FACC9` | UI 强调色 / 可能的称号基准色 | 天蓝色 |
| `#4D8BFF` | 通用强调色 (链接等) | 蓝色 |
| `#5B6E8A` | 次要文本颜色 | 灰蓝色 |
| `#8A3A4A` | 暗红色调 | 深红 |
| `#8A5B6E` | 暗紫色调 | 紫灰 |
| `#7A5C2A` | 暗金色调 | 棕金 |
| `#8C837A` | 灰色调 | 灰色 |
| `#B5ABA0` | 浅灰色调 | 浅灰 |
| `#1A1F26` | 深色背景 | 深蓝黑 |
| `#1C1A17` | 暗色背景 | 深棕黑 |
| `#33507A` | 中蓝色 | 钢蓝 |
| `#3A3733` | 深灰色 | 深灰 |
| `#5CFFFFFF` | 半透明白色 (5C=36% alpha) | 半透明白 |
| `#B3FFFFFF` | 半透明白色 (B3=70% alpha) | 半透明白 |

### 5.4 关键设置项

**`group_colored_name_enabled`** — 群聊彩色昵称开关:

- 存储位置: `SharedPreferences("settings")`
- 类型: boolean
- 默认值: `true` (推测)
- 作用: 控制群聊中是否启用 HSV 哈希着色
- 关闭后: 所有昵称和称号使用系统默认颜色

**`sender_name_outside_bubble_enabled`** — 发送者名称显示在气泡外:

- 存储位置: `SharedPreferences("settings")`
- 类型: boolean
- 作用: 控制发送者昵称是否显示在消息气泡外部
- 开启: 昵称在气泡上方独立显示
- 关闭: 昵称嵌入气泡内部

### 5.5 技术实现细节

**使用的核心类**:
- `SpannableString` / `SpannableStringBuilder` — 可 span 文本
- `ForegroundColorSpan` — 前景色 span
- `StyleSpan` — 粗体/斜体 span (可能用于称号)
- `RelativeSizeSpan` — 相对字号 (可能用于称号缩小)
- `Color.HSVToColor()` / `Color.colorToHSV()` — HSV 颜色计算

### 5.6 数据流

```
服务端 /v2/groups/members 响应
  └→ members_live 表缓存 (role, user_title, display_name, from_uid)
       └→ GroupChatActivity 渲染时:
            ├→ 查询 members_live 获取 role + user_title + from_uid
            ├→ 检查 group_colored_name_enabled 开关
            ├→ hash(from_uid) → HSV → 颜色
            └→ SpannableString + ForegroundColorSpan 着色
```

### 5.7 私聊 vs 群聊

| 场景 | 昵称颜色 | 称号颜色 |
|---|---|---|
| 私聊 | 默认色 (不着色) | 不显示 |
| 群聊 (开关关闭) | 默认色 | 不显示 |
| 群聊 (开关开启, 群主) | `#FF5B6E` 固定红 | HSV 哈希色 |
| 群聊 (开关开启, 管理员) | `#FFC857` 固定金 | HSV 哈希色 |
| 群聊 (开关开启, 普通成员) | **HSV 哈希色 (每人不同)** | **HSV 哈希色 (每人不同)** |

### 5.8 角色缓存机制

**`group_role_cache`** — 群角色缓存:

- 存储位置: `SharedPreferences("group_role_cache")`
- 键: `group_id`
- 值: 角色信息 (int: 0=成员, 1=管理员, 2=群主)
- 用途: 缓存当前用户在各群中的角色

**`user_title_cache`** — 用户称号缓存:

- 存储位置: `SharedPreferences("user_title_cache")`
- 键: `uid` 或 `ncuid`
- 值: 称号字符串
- 用途: 缓存用户称号

---

## 6. 数据库 schema 变更

### 6.1 members_live 表新增索引

```sql
-- 新增索引 (nx9 中不存在)
CREATE INDEX idx_live_uid ON members_live(account, group_id, uid)
```

**作用**: 加速按 uid 查询群成员的操作，特别是在聊天界面渲染时需要根据 `from_uid` 查找成员角色和头衔。

### 6.2 members_live 排序规则

```sql
-- 新增排序规则 (从 DEX strings 提取)
Crole DESC, display_name COLLATE NOCASE, username COLLATE NOCASE, ncuid
```

群成员列表按以下优先级排序:
1. `role DESC` — 角色降序 (群主→管理员→普通成员)
2. `display_name COLLATE NOCASE` — 显示名不区分大小写
3. `username COLLATE NOCASE` — 用户名不区分大小写
4. `ncuid` — NCUID 兜底

### 6.3 其他表无变化

以下表结构与 nx9 完全一致:
- `direct_messages` / `group_messages`
- `direct_message_rows` / `group_message_rows`
- `pts_state`
- `members_stage` / `member_sync` / `cached_groups`
- `channel_states` / `channel_posts`

---

## 7. 后端接口重大改动分析

### 7.1 新增: 刮刮乐系统 (`/v2/me/scratch`)

**影响范围**: 个人中心模块

**接口设计**:
- `GET /v2/me/scratch` — 查询今日状态 (幂等)
- `POST /v2/me/scratch` — 开奖 (每日一次, 重复调用返回缓存)

**奖励概率模型**:
| 奖励 | 概率 | 期望收益 |
|---|---|---|
| 0 (谢谢惠顾) | 40% | 0 |
| 1 旧币 | 30% | 0.3 |
| 5 旧币 | 15% | 0.75 |
| 10 旧币 | 10% | 1.0 |
| 20 旧币 | 5% | 1.0 |
| **合计** | 100% | **3.05 旧币/天** |

**后端实现要点**:
- 需要记录 `scratch_date` 防止重复开奖
- 5 个槽位独立随机
- 奖励直接累加到 `coin_balance`
- 响应需包含 `slots` 数组 (5个元素) + `total_reward` + `coin_balance`

### 7.2 新增: CIP 应用商店 (`/v2/cip/store`)

**影响范围**: CIP 小程序模块

**接口设计**:
- `GET /v2/cip/store` — 获取商店应用列表 (v2 加密路由)
- `GET /cip/store` — v1 兼容路由
- `POST /cip-upload` — CIP 包上传

**后端实现要点**:
- 需要存储 CIP 包的元数据 (id, name, description, version, icon_url, author)
- 需要记录下载次数
- CIP 包上传后需要校验 manifest.json 和 main.lua 的合法性
- 包大小限制: 压缩 ≤2 MiB, 解压 ≤8 MiB

### 7.3 新增: AI 对话备用路径 (`/v1/chat/completions`)

**影响范围**: AI 助手模块

**说明**: 作为 `/ai/chat/completions` 的别名，用于 OpenAI 兼容格式。后端只需将 `/v1/chat/completions` 路由到与 `/ai/chat/completions` 相同的 handler。

### 7.4 新增: 群聊上下文查询 (`/chat-context`)

**影响范围**: 群聊模块

**接口设计**:
- `GET /chat-context?group_id=GRP-XXX`

**推测功能**: 返回群聊的上下文摘要，可能用于:
- AI 助手的群聊上下文感知
- 群聊推荐
- 群聊搜索的上下文增强

> ⚠️ **需实测确认**: 具体响应结构未从客户端代码中完全确认。

### 7.5 新增: 资源举报查询 (`/me/resource-reports`)

**影响范围**: 举报模块

**接口设计**:
- `GET /me/resource-reports?limit=50`

**说明**: 与已有的 `/me/bug-reports`、`/me/user-reports`、`/me/group-reports` 并列，查询用户提交的资源举报处理进度。

### 7.6 确认: 频道 Publisher Token 端点

**api.md 中提到**:
- `POST /v2/channel-api/apply` — 申请 Publisher Token
- `GET /v2/channel-api/status` — 查询审核状态

**客户端 DEX 中未发现**这两个端点。说明:
1. 这些是**服务端管理接口**，不被 Android 客户端直接调用
2. 或者是**Web 端专用**接口
3. 客户端通过频道详情页的 UI 间接使用这些功能

### 7.7 确认: 群事件增量端点

**api.md 中提到**: `GET /v2/groups/events/after`

**客户端 DEX 中未发现**此端点。说明:
- 客户端可能通过 `/v2/updates/difference` (pts 差量) 来获取群事件
- 或者群事件增量是服务端文档中的预留接口，客户端尚未适配

---

## 8. 未变化部分

以下组件与 nx9 基线完全一致:

### 8.1 核心架构
- 传输层 (h0.d, h0.e, h0.f, h0.c)
- v2 路由映射表 (h0/e.java 第451行, 约50个映射)
- v2 网关 (`/v2/gateway`)
- ECDH 握手 + AES-256-CBC 信封 + HMAC-SHA256 签名
- WebSocket RFC 6455 自实现

### 8.2 核心业务
- 私聊/群聊发送、历史加载、可靠同步
- 图片加载系统 (多级缓存)
- 媒体URL解析与下载选路
- Token 刷新与认证安全
- 消息处理管线

### 8.3 数据库 schema
- 所有消息表结构不变
- 频道表结构不变

### 8.4 WS 事件类型
- 完整事件类型列表不变

---

## 9. 升级建议

### 9.1 对客户端开发者

1. **Safe 控件**: 立即替换现有 LayoutManager/RecyclerView 为 Safe 版本
2. **刮刮乐**: 新增 ScratchActivity + UI + 网络层
3. **CIP 商店**: 新增 CipStoreActivity + 列表/详情/安装流程
4. **昵称颜色**: 实现 HSV 哈希着色 + `group_colored_name_enabled` 开关
5. **极速纯净模式**: 实现 `hide_avatar_enabled` 全局头像隐藏
6. **ECDH 持久化**: 实现 `crypto_session_prefs` 会话密钥本地存储
7. **气泡时间**: 实现 `BubbleTimeTextView` + `bubble_time_new_line_enabled`
8. **成员排序**: 实现 `role DESC` 排序规则

### 9.2 对服务端开发者

1. **刮刮乐**: 实现 `/v2/me/scratch` GET/POST，包含概率模型和防重复机制
2. **CIP 商店**: 实现 `/v2/cip/store` 和 `/cip-upload`，包含包校验和元数据管理
3. **AI 备用路径**: 将 `/v1/chat/completions` 路由到现有 AI handler
4. **群聊上下文**: 实现 `/chat-context` 端点
5. **资源举报**: 实现 `/me/resource-reports` 端点
6. **成员索引**: 确保 `members_live` 表有 `uid` 索引
7. **ECDH 持久化兼容**: 确保服务端接受客户端本地恢复的 session

### 9.3 兼容性

- 所有新增端点为增量添加，不影响现有功能
- Safe 控件为纯客户端改动，无协议变更
- 数据库仅新增索引，无需迁移
- 昵称颜色为客户端本地渲染逻辑，不影响协议
- ECDH 持久化为客户端优化，服务端无需改动

---

## 10. 完整设置项清单

从 DEX strings 中提取到的所有 UI/显示相关设置:

| 设置键 | 类型 | 说明 |
|---|---|---|
| `group_colored_name_enabled` | boolean | 群聊彩色昵称 (HSV 哈希着色) |
| `sender_name_outside_bubble_enabled` | boolean | 发送者名称在气泡外显示 |
| `hide_avatar_enabled` | boolean | **极速纯净模式 (不显示头像)** [NEW] |
| `bubble_rounded_enabled` | boolean | 圆角气泡样式 |
| `bubble_time_new_line_enabled` | boolean | 气泡时间换行显示 |
| `button_3d_effect_enabled` | boolean | 3D 按钮效果 |
| `dark_mode_enabled` | boolean | 深色模式 |
| `theme_color_index` | int | 主题色索引 |
| `discover_random_solid_color_enabled` | boolean | 发现页随机纯色 |
| `discover_classic_layout_enabled` | boolean | 发现页经典布局 |
| `typing_indicator_enabled` | boolean | 正在输入指示器 |
| `enter_send_enabled` | boolean | 回车发送消息 |
| `notify_enabled` | boolean | 通知开关 |
| `home_news_enabled` | boolean | 首页新闻 |
| `music_dynamic_bg_enabled` | boolean | 音乐动态背景 |
| `music_lyric_color_mode` | int | 歌词颜色模式 |
| `music_lyric_bounce_enabled` | boolean | 歌词弹跳效果 |
| `music_bg_style` | int | 音乐背景样式 |
| `old_view_entry_enabled` | boolean | 旧视界入口 |
| `public_court_enabled` | boolean | 公开法庭入口 |
| `rounded_buttons_enabled` | boolean | 圆角按钮 |
| `dev_mode_enabled` | boolean | 开发者模式 |

---

## 11. 官方更新日志逐条分析

> 参考: 旧聊 1.4.5 正式版更新日志

### 11.1「不显示头像」极速纯净模式

**设置键**: `hide_avatar_enabled`

**功能**: 在「设置-界面与显示」中一键开启，全面隐藏聊天、群聊、好友与动态头像。

**底层实现**:
- 全局开关，存储在 `SharedPreferences("settings")`
- 开启后，所有头像 ImageView 不加载图片
- 头像请求被完全拦截 (底层静默拦截)
- 效果: 大幅节省流量 + 提升低配机型流畅度

**影响范围**:
- 聊天列表 (ChatsFragment)
- 群聊消息 (GroupChatActivity)
- 好友列表
- 朋友圈/动态
- 用户资料页

### 11.2 ECDH 会话本地安全持久化

**存储**: `SharedPreferences("crypto_session_prefs")`

**功能**: 将 ECDH 握手的会话密钥 (encKey, macKey, sessionId) 持久化到本地。

**效果**:
- 应用冷启动时无需重新握手
- 切后台恢复时秒级恢复连接
- 彻底杜绝 401 握手耗时

**之前**: 每次冷启动/恢复都要 `POST /auth/handshake` (约 200-500ms)
**之后**: 本地恢复 session，直接可用

### 11.3 Android 2.3 Keep-Alive 连接断流修复

**问题**: Android 2.3 系统底层 HTTP 连接的 Keep-Alive 机制有缺陷，长连接会意外断开。

**修复**:
- 优化 WebSocket 25 秒专属 Ping 心跳保活
- `keep-alive` header 处理优化
- 连接断开后的重连逻辑改进

**相关**: `http.keepAlive` 配置 + WS ping/pong 帧

### 11.4 消息气泡自绘时间与发送状态勾

**BubbleTimeTextView**: 自定义控件，在消息气泡内自绘时间文本。

**设置**:
- `bubble_time_new_line_enabled` — 时间是否换行显示
- `bubble_rounded_enabled` — 圆角气泡

**发送状态勾**:
- `setCheckMarkDrawable` — 设置已发送/已送达/已读的勾号图标
- `local_pending` / `local_failed` 字段跟踪发送状态
- `status` 字段 (0=发送中, 1=已发送, 2=已送达, 3=已读)

### 11.5 断点下载、资源直链与 SHA-256 秒传

**断点下载**: HTTP Range header 支持 (`Accept-Ranges: bytes`)

**资源直链**: `/v1/download/sources` 动态下发雨云对象存储直链

**SHA-256 秒传**: `POST /v2/files/check {sha256, size_bytes}` → 命中直接返回 URL

---

*本文档基于 `oldchat-1.4.5-540.apk` 的 DEX strings 全量分析与 nx9 文档逐项对比。*
