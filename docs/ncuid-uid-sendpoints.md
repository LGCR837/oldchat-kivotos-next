# NCUID 发送点决断表（已对照新逆向 diff 定稿）

> 目的：OldChat For Kivotos 客户端当前**向服务器发送旧 `uid` 字段**的所有位置，
> 并依据全新逆向 diff（`docs/oldchat-docs-20260808/nx/oldchat-diff-v1.3.61-vs-v1.4.x.md` §7、§15.3）给出**最终决策**。
> 生成：2026-08-08（初稿，待问腐竹）→ 2026-08-09 **定稿（新 diff 已坐实）**
> 核心结论：**全部采用「双写」（旧 uid 字段 + 新 ncuid 字段），旧字段保底、新字段向前兼容。**
> 依据 diff §15.3 兼容策略：`v1.3.61 客户端 → v1.4.x 服务端` 下，旧/新/混合三者均工作；混合模式要求服务端支持 uid/ncuid 双模式（v1.4.x 已支持）。

---

## 一、仍发旧 `uid` 字段的出站点 → 双写决策

| # | 当前字段 | 端点 | 行号 | 新 diff 映射（§7.4/§7.6） | **决策（双写）** | 备注 |
|---|----------|------|------|---------------------------|------------------|------|
| 1 | `to_uid` | `POST /v1/direct/send`（私聊文本） | L5668 | 消息发送 → `to_ncuid` ✅已迁移 | `{ to_uid, to_ncuid }` | 内联对象，改这一处 |
| 2 | `to_uid` | `POST /v1/redpackets/send`（私聊红包） | L6139 | 红包发送 → `to_ncuid` ✅已迁移 | `{ to_uid, to_ncuid }` | group 分支走 `group_id`，不受影响 |
| 3 | `to_uid` | 私聊发媒体（图/语音/文件） | L6225 | 消息发送 → `to_ncuid` ✅已迁移 | `{ to_uid, to_ncuid }` | 内联对象 |
| 4 | `to_uid` | `POST /v1/friends/request`（加好友 ×3） | L2201/L2855/L4198 | 好友操作 → `friend_ncuid`（§7.3 L563-576 好友添加用 `friend_ncuid`） | `{ to_uid, friend_ncuid }` | 经 `toUidParam()` 助手，**只改这一处即可覆盖 3 点** |
| 5 | `with_uid` | `POST /v1/direct/read`（标记已读 ×3） | L2273/L2294/L4489 | 消息已读 → `reader_ncuid` ✅已迁移；但本端点参数名是 `with_uid`（非 `reader_uid`），平行改名应为 `with_ncuid` | `{ with_uid, with_ncuid }` | 经 `withUidParam()` 助手，**只改一处覆盖 3 点** |
| 6 | `user_uid` | `POST /v1/groups/invite`（群邀请） | L2691 | 群组邀请 → `user_ncuid` ✅已迁移 | `{ group_id, user_uid, user_ncuid }` | 字段名特殊（非 `to_uid`），内联改 |
| 7 | `data.uid` | WS `typing` 状态 | L3934 | diff **未覆盖** WS typing 的 NCUID | **保持 `data.uid` 不动** | WS payload，发自己标识；向后兼容未移除，暂维持。待腐竹确认是否需 `data.ncuid` |
| 8 | `uid` | `POST /v1/me/uid`（改自己 ID） | L2931 | diff **未覆盖**；语义拧（接口叫 `uid`，代码存进 `ncuid`） | **保持不动** | 边缘端点，问清腐竹该端点到底改哪个再动 |

### 两处需腐竹拍板的字段名歧义（不影响安全）
- **#4 加好友**：diff 显示好友*添加*用 `friend_ncuid`（L563-576），好友*删除/拉黑/备注*用 `user_ncuid`（L625）。我们发的 `to_uid` 保底一定成功；新 key 用 `friend_ncuid` 是按"添加"场景的最佳猜测。若腐竹说该端点其实认 `user_ncuid`，改一个 key 即可，旧 `to_uid` 仍生效。
- **#5 标记已读**：diff 把"消息已读"映射到 `reader_ncuid`（§7.6），但我们的参数是 `with_uid`（平行改名应为 `with_ncuid`）。两者后端大概率都收（双模式）。我们发 `with_ncuid`（与 `with_uid` 平行），若腐竹说应是 `reader_ncuid` 再补。

> **为什么双写万无一失**：旧 uid 字段在所有 v1.4.x 后端仍被接受（diff §7.5「旧版保留的 UID 字段·向后兼容」+ §15.3 双模式），所以即便新 key 名猜错，请求也靠旧字段成功。新 key 只是向前兼容 / 未来去 uid 时免改。

---

## 二、兜底 `?uid=` 查询（ncuid 主路径失败才走）

| # | 端点 | 行号 | diff 映射 | 决策 |
|---|------|------|-----------|------|
| 9 | `GET /v1/users/profile?uid=` | L1976, L3444 | 用户资料查询 → `?ncuid=`（主路径已用） | 主路径已是 `?ncuid=`，此兜底几乎不触发；可改为 `?ncuid=` 或保留 `?uid=` 作最后保底（无害） |
| 10 | `GET /v1/moments/user?uid=` | L2002 | 动态查询 → `?ncuid=`（主路径已用） | 同上 |

---

## 三、已经是 ncuid / 双写（不用改，对照用）

- 私聊历史拉取：`?with_ncuid=`（L4319, L4520）✅
- 资料/动态查询主路径：`?ncuid=`（L1966, L1992, L3436, L3453）✅
- `mentions` 字段：双写 `{ uid, ncuid }`（L5633）✅ 最稳，保持
- 消息发送者读取：`from_ncuid || from_uid` 兼容 ✅

---

## 四、未来实现 P1 功能时的 NCUID 取法（来自新 diff）

| 功能 | 端点 | 取 NCUID 字段 |
|------|------|---------------|
| 消息搜索 | `/v1/.../messages/search?with_ncuid=` | `with_ncuid`（§7.4 `with_uid→with_ncuid`，消息搜索过滤） |
| 群组创建 | 创建群组 `member_ncuids` | `member_ncuids`（§7.4，成员 NCUID 数组） |
| 群增量同步 | `/v1/groups/messages/after` | 用群 `group_id`，不涉及 uid |

---

## 五、实施清单（双写，约 10 行内）

1. `toUidParam(id)`（L1275）→ 返回 `{ to_uid: id, friend_ncuid: id }`
2. `withUidParam(id)`（L1279）→ 返回 `{ with_uid: id, with_ncuid: id }`
3. 发私聊文本 L5668、红包 L6139、媒体 L6225：内联 `{ to_uid }` → `{ to_uid, to_ncuid }`
4. 群邀请 L2691：`{ group_id, user_uid }` → `{ group_id, user_uid, user_ncuid }`
5. **不动**：WS typing（#7）、`/v1/me/uid`（#8）、兜底 `?uid=`（#9/#10 可保留）

> 注：`to_uid` 有两套发出方式（内联 + `toUidParam` 助手）。本清单 #1 改助手覆盖加好友；#3 改三处内联覆盖发消息/红包/媒体——**两处都要改**，否则发消息仍只发旧 `to_uid`。
