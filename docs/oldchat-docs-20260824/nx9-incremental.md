# OldChat Android 增量变更文档: v1.4.5-v2test228

> **基准版本**: nx8 (基于 `oldchat-dev.apk` 2026-08-15, versionCode 451, `1.4.1-v2test165`)
> **目标版本**: `1.4.5-v2test228`
> **更新时间**: 2026年8月24日
> **分析方法**: jadx 反编译对比 + DEX strings 提取 + 源码结构分析

---

## 目录

1. [概要](#1-概要)
2. [新增 Activity: CipStoreActivity](#2-新增-activity-cipstoreactivity)
3. [新增安全控件: Safe 系列](#3-新增安全控件-safe-系列)
4. [新增 API 端点](#4-新增-api-端点)
5. [未变化部分](#5-未变化部分)
6. [升级建议](#6-升级建议)

---

## 1. 概要

v1.4.5-v2test228 相对于 nx8 基线 (v1.4.1-v2test165) 的变更范围:

| 类别 | 变更类型 | 数量 |
|---|---|---|
| 新增 Activity | CipStoreActivity | 1 |
| 新增自定义控件 | Safe 系列 | 3 |
| 新增 API 端点 | — | 4 |
| 数据库 schema | 无变化 | 0 |
| API 路由映射表 | 无新增映射 | 0 |
| WS 事件类型 | 无变化 | 0 |

---

## 2. 新增 Activity: CipStoreActivity

### 2.1 基本信息

| 属性 | 值 |
|---|---|
| 完整类名 | `com.im.oldchat.ui.CipStoreActivity` |
| 内部类数量 | 12 个 |
| 关联 API | `/v2/cip/store` 和 `/cip/store` |
| 推测功能 | CIP 小程序应用商店 |

### 2.2 内部类结构

| 内部类 | 说明 |
|---|---|
| `a` | 辅助类 |
| `b` | 辅助类 |
| `c` | 辅助类 |
| `d` | 主逻辑类 |
| `d$a` | d 的子类/回调 |
| `d$b` | d 的子类/回调 |
| `e` | 辅助类 |
| `f` | 辅助类 |
| `f$a` | f 的子类/回调 |
| `f$b` | f 的子类/回调 |
| `g` | 辅助类 |

> 12 个内部类说明这是一个功能完整的页面，包含列表展示、详情查看、安装/管理等完整交互流程。

### 2.3 推测功能

基于类名 `CipStoreActivity` 和关联 API `/v2/cip/store`:

- **浏览 CIP 应用商店**: 展示可用的 CIP 小程序列表
- **安装/卸载 CIP 应用**: 管理本地已安装的小程序
- **应用详情查看**: 查看应用描述、权限、版本等信息
- **搜索/分类**: 可能支持按分类浏览或关键词搜索

### 2.4 关联 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v2/cip/store` | GET | 获取 CIP 商店应用列表 (v2 路由) |
| `/cip/store` | GET | 获取 CIP 商店应用列表 (v1 兼容) |

---

## 3. 新增安全控件: Safe 系列

### 3.1 SafeGridLayoutManager

| 属性 | 值 |
|---|---|
| 类名 | `SafeGridLayoutManager` |
| 继承 | `GridLayoutManager` |
| 功能 | 安全版 GridLayoutManager, 防止越界 crash |

**防护场景**: RecyclerView 在快速滚动或数据变更时, `GridLayoutManager` 可能因 position 越界导致 `IndexOutOfBoundsException`。`SafeGridLayoutManager` 重写关键方法, 在越界时安全降级而非崩溃。

### 3.2 SafeLinearLayoutManager

| 属性 | 值 |
|---|---|
| 类名 | `SafeLinearLayoutManager` |
| 继承 | `LinearLayoutManager` |
| 功能 | 安全版 LinearLayoutManager |

**防护场景**: 同上, 针对线性布局的越界保护。

### 3.3 SafeRecyclerView

| 属性 | 值 |
|---|---|
| 类名 | `SafeRecyclerView` |
| 继承 | `RecyclerView` |
| 功能 | 安全版 RecyclerView |

**防护场景**: 可能重写 `onTouchEvent`、`onInterceptTouchEvent` 等方法, 防止触摸事件处理中的异常导致崩溃。

### 3.4 设计意图

这三个 Safe 控件的出现说明开发团队在解决线上 crash 问题:
- `IndexOutOfBoundsException` 是 RecyclerView 最常见的崩溃之一
- 通过自定义 LayoutManager 和 RecyclerView 子类, 在框架层面兜底
- 这是一种防御性编程模式, 不影响正常功能, 只在异常情况下降级

---

## 4. 新增 API 端点

### 4.1 CIP 商店接口

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v2/cip/store` | GET | CIP 商店应用列表 (v2 加密路由) |
| `/cip/store` | GET | CIP 商店应用列表 (v1 兼容路由) |

### 4.2 群聊上下文查询

| 端点 | 方法 | 说明 |
|---|---|---|
| `/chat-context?group_id=` | GET | 查询群聊上下文信息 |

### 4.3 AI 对话备用路径

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/chat/completions` | POST | AI 对话备用路径 |

> 与已有 `/ai/chat/completions` 并存, 可能用于 OpenAI 兼容格式的 API 代理。

### 4.4 CIP 包上传

| 端点 | 方法 | 说明 |
|---|---|---|
| `/cip-upload` | POST | CIP 包上传 |

---

## 5. 未变化部分

以下组件与 nx8 基线完全一致, 无任何变化:

### 5.1 数据库 schema

所有数据库表结构不变:
- `direct_messages` / `group_messages`
- `direct_message_rows` / `group_message_rows`
- `pts_state`
- `members_live` / `members_stage` / `member_sync` / `cached_groups`
- `channel_states` / `channel_posts`

### 5.2 API 路由映射表

`h0/e.java` 第451行的 v1→v2 路由映射表无新增映射。约50个已有映射保持不变。

### 5.3 WS 事件类型

WebSocket 事件类型完整列表不变:
- `direct_message` / `direct_read` / `direct_recall`
- `group_message` / `group_recall`
- `channel_update` / `system_notification`
- `typing` / `presence` / `account_event`

### 5.4 加密体系

ECDH 握手、AES-256-CBC 信封、HMAC-SHA256 签名机制不变。

### 5.5 核心消息流程

私聊/群聊发送、历史加载、可靠同步、图片加载等核心流程不变。

---

## 6. 升级建议

### 6.1 对客户端开发者

1. **CipStoreActivity**: 需要在 `AndroidManifest.xml` 中注册新 Activity, 并在发现页添加入口
2. **Safe 控件**: 替换现有 `GridLayoutManager`/`LinearLayoutManager`/`RecyclerView` 为 Safe 版本, 可立即降低线上 crash 率
3. **新 API**: `/v2/cip/store` 和 `/cip-upload` 需要对应的客户端 UI 和网络层支持

### 6.2 对服务端开发者

1. **CIP 商店**: 需要实现 `/v2/cip/store` 和 `/cip-upload` 端点
2. **群聊上下文**: 需要实现 `/chat-context` 端点
3. **AI 备用路径**: `/v1/chat/completions` 作为 `/ai/chat/completions` 的别名

### 6.3 兼容性

- 所有新增端点为增量添加, 不影响现有功能
- Safe 控件为纯客户端改动, 无协议变更
- 数据库 schema 无变化, 无需迁移

---

*本文档基于 `oldchat-dev.apk` (2026-08-15) 与 v1.4.5-v2test228 的 jadx 反编译对比分析。*
