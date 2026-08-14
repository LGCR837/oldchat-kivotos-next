# nx4.md 逆向补全工单（给逆向分析 LLM 的详细要求）

> 目标：把 `nx4.md`（2026-08-14 单文件逆向文档）从"广度齐全、深度不足"补成"可照着写客户端的权威契约"。
> 原始素材：OldChat Android `com.im.oldchat` dev APK 的反编译（已混淆）结果。
> 通用要求：每条都要**读真实反编译代码**给出证据（类名+方法名+行号），不要凭空推测；输出中文，附**可验证的最小样例**（JSON / 字段表 / 字节级步骤）。
> 反编译目录里关键文件（摘自 nx4.md）：
> - `h0/e.java` — 旧传输层（v2 签名装配，第 451 行附近有 /v1→/v2 路由映射表）
> - `h0/j.java` — 事件差量同步
> - `h0/w.java` — 未读同步
> - `h0/a.java` — 频道相关
> - `q0.AbstractC0584w` — ECDH 加密 / 信封加解密
> - `q0.AbstractC0588y` — 设备指纹（device_id / imei / device_name）
> - `i0/a.java` — 本地 Room/SQLite schema（第 476/477 行附近）
> - `MessageService.java` / `ResourceUploadService.java` / `MusicPlaybackService.java` / `FileDownloadService.java`
> - 各 `*Activity.java`（`MinimalNewsActivity`、`DiscoverTileEditorActivity`、`AppearancePreviewActivity`、`FavoritesActivity`、`QrCardActivity`、`QrScanActivity`、`OldViewFavoritesActivity`）

---

## P0（不补会卡死 / 实战会报错，最高优先）

### P0-1 · WebSocket 事件 payload 结构补全
- **问题**：nx4 §30 只给了信封 `{pts, pts_count, type, payload}` 与事件名列表（§30.4），**每个事件的 `payload` 内部字段全缺**。客户端实时收消息、好友请求、红包、朋友圈互动全靠它。
- **读**：`h0/j.java`（事件差量同步）、`h0/w.java`（未读同步）、`MessageService.java`、WS 帧解析相关类。
- **产出**：一张表，每行 = `事件名 | payload 字段 | 类型 | 必填 | 说明 | 示例 JSON`。覆盖 §30.4 全部事件，至少包括：
  `DIRECT_MESSAGE_NEW`、`GROUP_MESSAGE_NEW`、`FRIEND_REQUEST_NEW`、`FRIEND_REQUEST_ACCEPTED`、`RED_PACKET_CLAIMED`、`MOMENT_NEW`、`MOMENT_LIKE_NEW`、`MOMENT_COMMENT_NEW`、`CONTACT_UPDATE`、`GROUP_MEMBER_UPDATED`、`TYPING`、`PRESENCE`（在线状态）、`GROUP_INVITE_NEW`。
- **额外确认**：v1 WS（`/v1/ws?token=&sid=`）的帧是否**明文 JSON**？还是走了 `X-Enc` 信封加密？客户端实测为明文，请确认并写明证据。

### P0-2 · v2 签名公式校正（按文档写会 `bad_signature`）
- **问题**：nx4 §9.4 第 594 行写 `signingString = token + "\n" + path + "\n" + ts + "\n" + nonce`，且 X-Session 只当 header 不进签名。但客户端对线上握手/签名**实测可用**的公式是 `METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE` 且**必须带 X-Session**（否则返回 `bad_signature`）。文档这套写法实战必失败。
- **读**：`h0/e.java` 第 451 行附近 `v2Sign` / `v2SignMiddleware` 装配逻辑，以及 `q0.AbstractC0584w` 里 MAC/HMAC 计算处。
- **产出**：
  1. 精确给出 `signingString` 的**拼接顺序与内容**（method 还是 token 开头？path 是否含 query？ts/nonce 是原始值还是 base64？有无 `NO_PADDING|NO_WRAP` 等标志？）。
  2. X-Session 是否参与签名、还是只作 header。
  3. `X-Sign` 的 HMAC 输入与编码（与 §9.3 MAC 是否同一函数）。
  4. 给一个**端到端最小可验证样例**：取一个真实端点（如 `POST /v2/groups/messages/after`），列出 method、path、ts、nonce、X-Session、最终 X-Sign 的逐步计算过程（用固定测试密钥，输出 base64 串供对照）。

### P0-3 · ECDH 派生与信封 MAC 字节级定义
- **问题**：nx4 §9.2/§9.3 的 `truncated_secret` 未定义是"原始 32 字节共享密钥直接 `SHA256(secret||"enc"/"mac")`"还是先 hex/截断；§9.3 第 577 行 `HMAC-SHA256(macKey, iv_bytes || ciphertext_bytes)` 中 iv/ciphertext 是原始字节还是 base64、顺序如何，决定客户端能否正确验签/解密。
- **读**：`q0.AbstractC0584w`（全文，ECDH 握手 + 信封加解密）。
- **产出**：
  1. `shared_secret` → `truncated_secret` 的精确步骤（P-256 协商出的原始字节如何处理？`truncated_secret` 是 32 字节还是被截断/hex？）。
  2. `encKey = SHA256(truncated_secret + "enc")`、`macKey = SHA256(truncated_secret + "mac")` 的拼接语义（`+` 是字节拼接还是字符串？"enc"/"mac" 是 ASCII？）。
  3. 信封结构：iv 长度、ciphertext、mac 三者如何排布 / 是否 base64 各自独立 / 顺序。
  4. 原 mcl0 官方 §4.1 对齐核验：给出一组成对明文↔密文+mac 的样例（固定密钥），供客户端逐字节核对。

---

## P1（不补只能靠实测反推、易解析错）

### P1-1 · 业务端点响应体 schema 补全
- **问题**：§17（朋友圈）、§18（音乐）、§23（用户中心 `/me`、`/v2/me/*`）、§24（资源广场）、§25（表情）、§26（公开法庭）、§27（AI）、§28（通知）多数**只有端点路径表，无请求体/响应体/字段枚举**；且 `moments/user` 不返 `comment_count`（客户端只能 N+1 懒加载，应点明此限制）。
- **读**：各对应 `*Api`/`*Service` 类与 Gson/Kotlinx 序列化 model 类。
- **产出**：按端点逐个给出「**请求字段表 + 响应 JSON 样例 + 关键枚举值**」。重点：
  - 朋友圈：`feed`、`feed/user`、`comments`、`create`、`like` 的完整返回结构；明确 `comment_count` 是否缺失。
  - 音乐：`plaza`、`detail`、`lyrics`、`ranking`、`mine` 返回结构（与聊天里 `media_kind:"music"` 分享卡片如何对应）。
  - 通知：`/notifications` 的 **notification 对象字段**（§28 缺）。
  - AI：`/ai/*` 流式 SSE 的**逐行响应格式**（§27 仅列端点，无流式样例）。

### P1-2 · 核心 IM 本地表 schema 补全
- **问题**：§29.3 列了 `messages`、`conversations`、`groups`、`contacts`、`group_members`，但**无字段**（只有 `channel_states`/`channel_posts` 给了 CREATE TABLE）。客户端做本地缓存/增量续拉全靠这些表结构。
- **读**：`i0/a.java`（RoomDatabase / `@Entity` 定义，第 476/477 行附近及全文）。
- **产出**：上面 5 张表（及任何遗漏的 IM 表）的完整 **CREATE TABLE / 字段清单**（字段名 | 类型 | 索引 | 说明），并标注哪些是增量续拉用的游标列（如 `seq`、`created_at`、`id`）。

---

## P2（APK 有功能、文档整块未写）

### P2-1 · 新闻模块
- **读**：`MinimalNewsActivity.java` + 对应 API 类。
- **产出**：新闻列表/详情端点、请求与响应结构、分页方式。

### P2-2 · 发现页磁贴 / 外观预览
- **读**：`DiscoverTileEditorActivity.java`、`DiscoverTileLayout.java`、`AppearancePreviewActivity.java` + 对应 API。
- **产出**：发现页 feed 端点与磁贴结构、磁贴编辑接口、`AppearancePreview` 读取的主题/外观接口。

### P2-3 · 收藏夹
- **读**：`FavoritesActivity.java` / `OldViewFavoritesActivity.java` + 对应 API。
- **产出**：收藏增删查端点、收藏对象结构、支持收藏的媒体类型。

### P2-4 · 二维码名片 / 扫码
- **读**：`QrCardActivity.java`、`QrScanActivity.java` + 对应 API。
- **产出**：名片二维码内容格式（是 URL？含 uid/ncuid？）、扫码识别逻辑、扫码后触发的接口。

### P2-5 · 通知对象 schema（与 P1-1 通知部分合并亦可）
- 见 P1-1「通知」条，确保 notification 对象字段完整。

### P2-6 · AI 对话 SSE 格式（与 P1-1 AI 部分合并亦可）
- 见 P1-1「AI」条，确保流式响应样例完整。

---

## P3（一致性 / 收尾）

### P3-1 · 聊天内音乐分享子类补记
- **问题**：客户端靠 `media_kind:"music"`（text/resource 双形态）判别，nx4 §11.2/§18 未记。
- **读**：消息 model 的 `msg_type` 与 `media_kind` 字段定义。
- **产出**：在消息类型表补 `media_kind` 维度；给出 `text` 型（body 内封面/歌词 URL 被折行）与 `resource` 型（带 `media_url`）两种音乐分享的完整字段结构。

### P3-2 · v1/v2 混用统一标注
- **问题**：§14.11 用 `/v1/channels/media/upload`、§16.4 `/media`、§18 `/music/plaza`、§20 `/discover/lua`、§24–27 多无 v2 前缀——哪些仅 v1、哪些可经 `/v2/gateway` 折叠，未统一说明。
- **产出**：一张「端点 | 支持的版本 | 是否能走 /v2/gateway」总表，覆盖全文所有业务端点。

### P3-3 · 分页约定小结
- **问题**：`before_created_at+before_id+anchor`（§11.4）/ `after_seq`（§12.3）/ `offset`（§18.1）三种混用。
- **产出**：一节「分页约定」说明三种游标各自适用场景、字段、方向语义。

### P3-4 · 限流与错误信封
- **问题**：mcl0 官方 §24.2 限流只作用于注册/登录/发码/上传下载，nx4 未载；§31 列错误码但无错误响应样例。
- **读**：API 网关/拦截器类。
- **产出**：① 限流规则（适用端点、阈值、超限返回）。② 错误响应样例 JSON（字段名、`code`/`message`、gateway 错误如何返回、`bad_signature`/`sha256_mismatch`/`invalid_session`/`missing_session` 各自的响应形态）。

---

## 交付建议
1. 按 P0 → P1 → P2 → P3 顺序补；P0 三件套做完即可让客户端正确握手/签名/实时收消息。
2. 每条改动**直接回写 nx4.md 对应小节**（不要另起文档），并在改动处加 `（逆向补全：类名.方法，行号）` 证据标注。
3. 完成后给一份「仍无法确定 / 需实测后端才能确认」的清单，方便客户端侧做兜底处理。
