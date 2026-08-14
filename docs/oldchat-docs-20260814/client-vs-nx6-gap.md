# 客户端 vs nx6 差距分析（实现清单）

> 基准：nx6.md（2904 行 / 完整逆向契约，2026-08-14 dev apk 单文件）
> 对照：src/app.js / src/app.css（v9 客户端实现）
> 目的：找出"文档有、客户端未实现/实现不全"的点，作为后续实现工单。

---

## 总览

| 优先级 | 范围 | 状态 |
|---|---|---|
| P0 | 实时协议（WS 事件 / PTS 差量） | 部分缺失，P0-1 暂缓实测 |
| P1 | 频道全功能 / 群成员查询 / 资源广场 / 红包详情 / presence | 多处缺失 |
| P2 | 收藏夹 整模块 | 缺失（现有"收藏为表情"≠ 收藏夹） |
| P3 | 版本映射 / 其余小改进 | 待完善 |

---

## P0 — 实时协议（高危）

### P0-1 · WS 帧字段名 `data` vs `payload`（最高危，已暂缓实测）
- nx6 §30.2 信封：`{ pts, pts_count, type, payload }`，所有事件载荷都在 `payload` 里。
- 客户端 `handleWsMessage`（`src/app.js` ~6454）读的是 **`msg.data`**（外加一个"裸消息对象"兜底），**不读 `payload`**。
- 风险：若线上后端按文档发 `{type, payload}`，客户端 `msg.data` 为 `undefined` → 实时收消息全断。
- 处置：**暂缓**（需真机/真后端实测后端帧格式才能定）。已记入本地日记 `2026-08-14.md`。
- 一旦实测确认，需让 `handleWsMessage` 同时兼容 `payload`（优先 `payload`，回退 `data`）。

### P0-2 · WS 事件类型覆盖不全
- 客户端已处理：`direct_message` / `group_message` / `direct_recall` / `group_recall` / `direct_read` / `typing`。
- 缺失：
  - `account_event`（§30.4.2 差量包装：内部再包 `DIRECT_MESSAGE_NEW` / `GROUP_MESSAGE_NEW` / `FRIEND_REQUEST_NEW` / `RED_PACKET_CLAIMED` / `MOMENT_LIKE_NEW` 等 subtype）
  - `system_notification`（推送通知，对应 §28 通知对象）
  - `presence`（在线状态，§23.6）
  - `channel_update`（频道相关）
- 计划：在 `handleWsMessage` 增加 `account_event` 解包分支（按 `type`/`event`/`subtype` 再分发），并接 `system_notification` / `presence` 处理。

### P0-3 · 重连无 PTS 差量
- 未实现 `/v2/updates/difference`（§30.3）。当前靠 WS + 群 `group_seq` 轮询兜底，长断开窗口内的消息可能漏收。
- 计划：WS 重连成功后，用本地 `pts` 调 `/v2/updates/difference?pts=<last_pts>` 补齐断开期间的事件。

---

## P1 — 功能补全

### 频道系统（nx6 §14）
- 已有：posts / discover / subscribe / react / read / send。
- 缺失 / 待修：
  - `channel_states`（§14.5）— 频道订阅/通知状态。
  - `channels/events/after`（§14.7）— 频道事件增量拉取。
  - **频道媒体仍不行**（上一次修改后回归）—— 修复媒体上传/展示链路。
- 计划：见任务 #160。

### 群成员查询（nx6 §12）
- 缺失：`groups/members/lookup`（§12）。
- 计划：在**群聊管理页面**加入成员查询入口与结果展示（任务 #159）。

### 资源广场（nx6 §24）
- 已有：upload / items / sections。
- 缺失：`resources/download`（§24.2，加权鉴权下载）。
- 计划：见任务 #163。

### 红包详情（nx6 §21.3）
- 缺失：红包详情查看；emoji 占位改为小圆角封面（无封面保持现状）；"红包"使用具体文本；领取后查看详细 / 右键"查看详细"；可行时翻译服务器返回文本。
- 计划：见任务 #162。

### presence 在线状态（nx6 §23.6）
- 缺失：presence WS 处理 + 在线状态展示。
- 计划：与 P0-2 合并实现（任务 #165）。

---

## P2 — 整模块

### 收藏夹（nx6 §37）
- 注意：客户端现有"收藏为表情"是存自定义表情（§表情广场），**不等于** 收藏夹（§37 是收藏消息/内容，含列表/对象字段/增删操作）。
- 缺失：§37.1 收藏列表 / §37.2 收藏对象字段 / §37.3 收藏操作（新增/删除/列举）。
- 计划：见任务 #161。

---

## P3 — 其余改进
- `V1_TO_V2` 映射未覆盖 9 个 v2 端点（channels/states、channels/events/after、groups/members/lookup、me/delete、resources/download、unread/direct、unread/groups、updates/difference、gateway）。
- "仅v2"模式若触达这些会直接报错，目前无功能调用未暴露。
- 其余小改进与版本模式完善；整体校验与收尾（任务 #164）。

---

## 已实现且对齐良好的（信心基线）
auth 全套、私聊/群 CRUD+管理+公告+设置、好友全套、朋友圈全套、音乐广场/搜索/详情/歌词/排行/我的、表情广场、公开法庭、资源 sections/items/upload、红包 send/claim、按钮回调、文件 check/upload/download、用户中心大部分、通知 REST、签到+签到墙、频道基础。客户端额外有 nx6 未记的 `/v1/me/checkin/wall/comment(s)/like/unlike`。
