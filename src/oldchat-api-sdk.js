// =====================================================================
// oldchat-api-sdk.js - OldChat For Kivotos Next 业务 SDK 层（纯前端 / 零构建）
// 独立于 api.js：在 index.html 中于 api.js 之后加载，通过 window.apiFetch 通信。
// 职责：端点路径收口 + 响应字段归一化。api.js（传输层）可整文件替换，互不影响。
//
// 设计约束（来自项目约定）：
//  - 经典 <script>，全局 window.OC；不引打包工具、不碰 DOM。
//  - 归一化采用「严格 + 已知别名兜底」：仅保留服务端实际存在过的字段别名
//    （如 ncuid||uid），未知字段不兜底、打印 warn，避免掩盖服务端缺字段的 bug。
//  - 统一兜 {error} 载荷：apiFetch 返回 Response，本层负责 .json() 并抛出 OCError。
//
// 迁移状态：本文件为「骨架 + 已验证块」。尚未迁移的端点由 app.js 直接裸调
// apiFetch，后续按业务块逐步收口到此处（见任务清单 #26 / #25）。
// 每个待迁移方法均标注对应 app.js 调用行号，便于核对真实字段解析。
// =====================================================================

(function (global) {
  'use strict';

  const apiFetch = global.apiFetch;
  if (typeof apiFetch !== 'function') {
    console.error('[oldchat-api-sdk] window.apiFetch 未就绪，请确认本文件在 api.js 之后加载');
  }

  // ---- 统一错误 ----
  class OCError extends Error {
    constructor(message, code, raw) {
      super(message);
      this.name = 'OCError';
      this.code = code || null;
      this.raw = raw || null;
    }
  }

  // ---- 内部：解析 Response，兜 {error} ----
  async function _parse(r) {
    let j;
    try {
      j = await r.json();
    } catch (e) {
      throw new OCError('响应不是合法 JSON（疑似 ' + r.status + ' 非 JSON 体）', 'BAD_JSON', { status: r.status });
    }
    if (j && j.error) {
      const err = j.error;
      const msg = (typeof err === 'string') ? err : (err.message || err.msg || JSON.stringify(err));
      const code = (typeof err === 'object') ? (err.code || null) : null;
      throw new OCError(msg, code, j.error);
    }
    // 服务端约定：业务数据在 data 字段；无 data 时退回顶层（兼容部分旧接口）
    return (j && Object.prototype.hasOwnProperty.call(j, 'data')) ? j.data : j;
  }

  async function _get(path) {
    const r = await apiFetch(path);
    return _parse(r);
  }

  async function _post(path, body, opts) {
    const r = await apiFetch(path, Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }, opts || {}));
    return _parse(r);
  }

  // =====================================================================
  // 字段归一化层（依据 app.js 现有 loadXxx 的真实解析固化）
  // 保留原始宽结构，不收窄，避免调用方丢字段。
  // =====================================================================

  function pickUid(raw) {
    // 与 app.js getUid 一致：ncuid 优先，否则 uid
    return raw.ncuid || raw.uid || '';
  }

  function normalizeFriend(raw) {
    // 来自 loadContacts 好友解析（app.js:5361-5370）
    const uid = pickUid(raw);
    return {
      uid: uid,
      ncuid: raw.ncuid || '',
      displayUid: (raw.ncuid || raw.uid || '').toUpperCase(),
      name: raw.display_name || raw.username || uid,
      username: raw.username || '',
      display_name: raw.display_name || '',
      avatar: raw.avatar_url || '',
      remark_name: raw.remark_name || '',
      user_title: raw.user_title || '',
      role: raw.role || 0
    };
  }

  function normalizeGroup(raw) {
    // 来自 loadContacts 群解析（app.js:5371-5377）
    return {
      id: raw.group_id,
      name: raw.name || '',
      avatar: raw.avatar_url || '',
      member_count: raw.member_count || 0,
      role: raw.role || null
    };
  }

  function normalizeUnreadMessage(raw) {
    // 来自 loadUnreadCounts（app.js:5439-5465）：群按 group_id，私聊按 from_ncuid||from_uid
    return {
      group_id: raw.group_id || null,
      from_uid: raw.from_uid || null,
      from_ncuid: raw.from_ncuid || null,
      created_at: raw.created_at || 0
    };
  }

  // ---- OC 命名空间：业务方法层 ----
  const OC = {
    OCError,
    _get, _post,

    // ===== 认证（登录/握手由 app.js 现有逻辑负责，此处仅预留包裹位）=====
    // login / handshake 暂不下沉，保持 app.js 现有实现，避免动传输层。

    // ===== 通讯录（已验证）=====
    async getFriends() {
      const d = await _get('/v1/friends');
      return (d.friends || []).map(normalizeFriend);
    },
    async getFriendRequests() {
      const d = await _get('/v1/friends/requests');
      // 好友请求字段分散（status/avatar_url/from_name/from_username 等各调用方需求不一），
      // 保留原始全部字段 + 聚合 uid（兼容 getUid(r) 语义），不强行收窄。
      return (d.requests || []).map(r => Object.assign({}, r, {
        uid: r.from_ncuid || r.from_uid || ''
      }));
    },
    async addFriend(uidOrNcuid) {
      // 复用 app.js 的 toUidParam 语义：双写 to_uid/to_ncuid
      const body = {};
      if (String(uidOrNcuid).toUpperCase().startsWith('NC')) body.to_ncuid = uidOrNcuid;
      else body.to_uid = uidOrNcuid;
      return _post('/v1/friends/request', body);
    },
    async respondFriend(requestId, accept) {
      return _post('/v1/friends/respond', { request_id: requestId, accept: !!accept });
    },
    async getGroups() {
      const d = await _get('/v1/groups/list');
      return (d.groups || []).map(normalizeGroup);
    },
    async getGroupMembers(groupId) {
      // app.js:3822 / 9718 / 9762
      const d = await _get('/v1/groups/members?group_id=' + encodeURIComponent(groupId));
      return (d.members || []).map(normalizeFriend);
    },

    // ===== 未读（已验证 v2 兼容；api.js V1_TO_V2 已映射 /v1/*/unread -> /v2/unread/*）=====
    // 返回原始 messages 数组（app.js loadUnreadCounts 直接用 m.from_ncuid/m.group_id/m.created_at 等 raw 字段，无需归一化）
    async getUnreadDirect(limit = 200) {
      const d = await _post('/v1/direct/unread', { limit });
      return d.messages || [];
    },
    async getUnreadGroups(limit = 200) {
      const d = await _post('/v1/groups/unread', { limit });
      return d.messages || [];
    },

    // ===== 消息历史 / 发送 / 已读 / 撤回（已读码，app.js:5671/7808/8050/5757/9545/9547/10798/3546/3567/3569/8007/8009）=====
    // 重要：消息对象在 app.js 中始终是「原始宽结构」(id/from_uid/from_ncuid/body/msg_type/media_url/created_at/group_id...)
    // appendMessage / createMessageElement / sendMessage 直接用这些 raw 字段，因此本层【不归一化】，
    // 直接返回 data.messages 原数组供调用方自行 reverse/去重/渲染，避免丢字段。
    async getDirectMessages(ncuid, { limit = 30, offset = 0 } = {}) {
      const d = await _get(`/v1/direct/messages/v2?with_ncuid=${encodeURIComponent(ncuid)}&limit=${limit}&offset=${offset}`);
      return d.messages || [];
    },
    async getGroupMessages(groupId, { limit = 30, offset = 0 } = {}) {
      const d = await _get(`/v1/groups/messages/v2?group_id=${encodeURIComponent(groupId)}&limit=${limit}&offset=${offset}`);
      return d.messages || [];
    },
    async searchDirectMessages(uid, keyword) {
      const d = await _get(`/v1/direct/messages/search?with_uid=${encodeURIComponent(uid)}&keyword=${encodeURIComponent(keyword)}`);
      return d.messages || [];
    },
    async searchGroupMessages(groupId, keyword) {
      const d = await _get(`/v1/groups/messages/search?group_id=${encodeURIComponent(groupId)}&keyword=${encodeURIComponent(keyword)}`);
      return d.messages || [];
    },
    // 发送：透传 payload（app.js sendMessage 已构建完整字段），返回 data（含 message||data）
    async sendDirect(payload) {
      return _post('/v1/direct/send', payload);
    },
    async sendGroup(payload) {
      return _post('/v1/groups/message/send', payload);
    },
    // 已读：复用 app.js withUidParam 双写语义 {with_uid, with_ncuid}
    async markDirectRead(id) {
      return _post('/v1/direct/read', { with_uid: id, with_ncuid: id });
    },
    async markGroupRead(groupId) {
      return _post('/v1/groups/read', { group_id: groupId });
    },
    // 撤回：DELETE /v1/{groups|direct}/messages/{msgId}
    async recallDirectMessage(msgId) {
      const r = await apiFetch(`/v1/direct/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
      return _parse(r);
    },
    async recallGroupMessage(msgId) {
      const r = await apiFetch(`/v1/groups/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
      return _parse(r);
    },

    // ===== 动态 moments（TODO: 对应行 3219/3229/3444/3528/3610/3654）=====
    // ===== 红包 redpackets（TODO: 对应行 10114/10169/10234/11312）=====
    // ===== 签到墙 checkin wall（TODO: 对应行 13122/13183/13198/13253/13316/13394/3727/3773）=====
    // ===== 公审庭 public-court（TODO: 对应行 15418/15439/15453/15454/15547/15565/15579/15592）=====
    // ===== 表情广场 emoji（TODO: 对应行 11448/11479/11525/11646/11656）=====
    // ===== 媒体上传 media（TODO: 对应行 3523/4212/10330/14836）=====
    // ===== 资源广场 resources（v1 临时关闭，暂缓；对应行 15628/15674/15727/15774/15809/15888/15904/15939/15962/15984）=====
    // ===== 通知 notifications（TODO: 对应行 13548）=====
    // ===== 收藏 favorites（TODO: 对应行 1420/13989/14016）=====
    // ===== 用户资料 users/profile（TODO: 对应行 3193/4364/6059/6067/6076）=====
    // ===== 音乐广场 music/plaza（TODO: 对应行 2512/2933）=====
  };

  global.OC = OC;
  if (typeof module !== 'undefined' && module.exports) module.exports = { OC, OCError };

})(typeof window !== 'undefined' ? window : globalThis);
