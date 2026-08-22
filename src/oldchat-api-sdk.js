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

    // ===== 动态 moments（已读码，app.js:3219/3229/3444/3528/3610/3654）=====
    // 返回 raw：调用方直接用 data.moments / comments 原始字段（from_name/avatar_url 等），不归一化。
    async getUserMoments({ ncuid, uid, limit = 50 } = {}) {
      // 优先 ncuid 路径（ncuid 不能传入 ?uid=，会 400），失败回退 uid（保持原双路径回退语义）
      if (ncuid) {
        try {
          const d = await _get(`/v1/moments/user?ncuid=${encodeURIComponent(ncuid)}&limit=${limit}`);
          if (d && !d.error) return d;
        } catch (e) {}
      }
      if (uid) {
        try {
          const d = await _get(`/v1/moments/user?uid=${encodeURIComponent(uid)}&limit=${limit}`);
          if (d && !d.error) return d;
        } catch (e) {}
      }
      return null;
    },
    async getMomentComments(momentId) {
      const d = await _get(`/v1/moments/comments?moment_id=${encodeURIComponent(momentId)}`);
      return d.comments || [];
    },
    async postMoment({ body, imageUrl = '' }) {
      return _post('/v1/moments', { body, image_url: imageUrl });
    },
    async postMomentComment({ momentId, body }) {
      return _post('/v1/moments/comment', { moment_id: momentId, body });
    },

    // ===== 红包 redpackets（已读码，app.js:9997/10052/10117/11191）=====
    // 返回 raw：调用方直接用 d.cover_url/d.title/d.packet_id 等原始字段，不归一化。
    async getRedpacket(packetId) {
      return _get(`/v1/redpackets/${encodeURIComponent(packetId)}`);
    },
    async claimRedpacket(packetId) {
      return _post('/v1/redpackets/claim', { packet_id: packetId });
    },
    async sendRedpacket(payload) {
      return _post('/v1/redpackets/send', payload);
    },

    // ===== 签到墙 checkin wall（已读码，app.js:3661/3707/12962/13023/13038）=====
    // getCheckinWall 需保留「404→功能建设中」与「非 JSON 容错」特殊逻辑，故返回 {notFound, data}
    async getCheckinWall(limit = 50) {
      const r = await apiFetch(`/v1/me/checkin/wall?limit=${limit}`);
      if (r.status === 404) return { notFound: true };
      const text = await r.text();
      let data = {};
      try { data = JSON.parse(text); } catch (e) { console.warn('[checkin] wall not JSON:', text.slice(0, 100)); }
      if (data && data.error) throw new OCError(data.error);
      return { notFound: false, data };
    },
    async doCheckin() {
      return _post('/v1/me/checkin', {});
    },
    async postCheckinWall(contentText) {
      return _post('/v1/me/checkin/wall', { content_text: contentText });
    },
    async getCheckinWallComments(postId) {
      const d = await _get(`/v1/me/checkin/wall/comments?post_id=${encodeURIComponent(postId)}`);
      return d.comments || [];
    },
    async postCheckinWallComment({ postId, body }) {
      return _post('/v1/me/checkin/wall/comment', { post_id: postId, body });
    },
    async likeCheckinWall(postId) {
      return _post('/v1/me/checkin/wall/like', { post_id: postId });
    },
    async unlikeCheckinWall(postId) {
      return _post('/v1/me/checkin/wall/unlike', { post_id: postId });
    },

    // ===== 公审庭 public-court（app.js:15198/15219/15233/15234/15327/15345/15359/15372）=====
    // 响应格式多层兼容（{case}/{data}/[] 包裹），app.js 用 courtExtractList 自行解析，
    // 故本层仅做「GET/POST 透传 + 兜 error」薄封装，返回原始 JSON，不归一化。
    async getCourtCases(status = 'all') {
      return _get('/v1/public-court/cases?status=' + encodeURIComponent(status));
    },
    async getCourtCaseDetail(id) {
      return _get('/v1/public-court/cases/' + encodeURIComponent(id));
    },
    async getCourtCaseVotes(id) {
      return _get('/v1/public-court/cases/' + encodeURIComponent(id) + '/votes');
    },
    async getCourtCaseDiscussions(id) {
      return _get('/v1/public-court/cases/' + encodeURIComponent(id) + '/discussions');
    },
    async voteCourtCase(id, { vote, reason = '', evidence = '' }) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/vote', { vote, reason, evidence });
    },
    async postCourtStatement(id, { reason, evidence = '' }) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/statement', { reason, evidence });
    },
    async postCourtDiscussion(id, { body }) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/discussion', { body });
    },
    async withdrawCourtCase(id) {
      return _post('/v1/public-court/cases/' + encodeURIComponent(id) + '/withdraw', {});
    },

    // ===== 表情广场 emoji（app.js:11278/11309/11355/11476/11486）=====
    // 字段各异（emoji 包含 id/name/url/type 等），调用方直接用 raw，不归一化
    async getEmojiPlaza({ limit = 50, offset = 0 } = {}) {
      const d = await _get(`/v1/emoji/plaza?limit=${limit}&offset=${offset}`);
      return d.emojis || d.items || [];
    },
    async getMyEmojis(limit = 200) {
      const d = await _get(`/v1/emoji/plaza/mine?limit=${limit}`);
      return d.emojis || d.items || [];
    },
    async saveEmoji(payload) {
      // payload: { name, url, type } 等，透传
      return _post('/v1/emoji/plaza/save', payload);
    },
    async deleteEmoji(id) {
      return _post('/v1/emoji/plaza/delete', { id });
    },
    // 分页加载（保留 has_more 等元字段）：返回原始 d，调用方自行取 items/has_more
    async getEmojiPlazaPage({ limit = 20, offset = 0 } = {}) {
      return _get(`/v1/emoji/plaza?limit=${limit}&offset=${offset}`);
    },

    // ===== 媒体上传 media（app.js:3523/4212/10330/14836）=====
    // 均为 FormData 上传（非 JSON），单独走 apiFetch 直接发，再 _parse 兜 error
    async uploadMedia(formData) {
      const r = await apiFetch('/v1/media', { method: 'POST', body: formData });
      return _parse(r);
    },
    async uploadChannelMedia(formData) {
      const r = await apiFetch('/v1/channels/media/upload', { method: 'POST', body: formData });
      return _parse(r);
    },

    // ===== 群管理（app.js:3995/4082/4100/4116/4183/4189/4212/4215/4288/4472/7685）=====
    // 均为动作类 POST/管理操作，body 各异，透传不归一化；返回原始 JSON 供调用方判断
    // 注意：后端 kick/admin/invite 的 user_uid 与 user_ncuid 独立校验，必须双写，任一缺失报 "uid or ncuid is required"
    async leaveGroup(groupId) {
      return _post('/v1/groups/leave', { group_id: groupId });
    },
    async kickGroupMember({ groupId, userUid, userNcuid }) {
      return _post('/v1/groups/kick', { group_id: groupId, user_uid: userUid, user_ncuid: userNcuid });
    },
    async setGroupAdmin({ groupId, userUid, userNcuid, admin }) {
      return _post('/v1/groups/admin', { group_id: groupId, user_uid: userUid, user_ncuid: userNcuid, admin: !!admin });
    },
    async dissolveGroup(groupId) {
      return _post('/v1/groups/dissolve', { group_id: groupId });
    },
    async updateGroupSettings(groupId, settings) {
      return _post('/v1/groups/settings', Object.assign({ group_id: groupId }, settings));
    },
    async renameGroup(groupId, name) {
      return _post('/v1/groups/name', { group_id: groupId, name });
    },
    // 群头像：上传是「先 /v1/media 拿 URL → 再 JSON 写回 avatar_url」，此处收口第二步
    async updateGroupAvatar({ groupId, avatarUrl }) {
      return _post('/v1/groups/avatar', { group_id: groupId, avatar_url: avatarUrl });
    },
    async inviteToGroup({ groupId, userUid, userNcuid }) {
      return _post('/v1/groups/invite', { group_id: groupId, user_uid: userUid, user_ncuid: userNcuid });
    },
    async joinGroup(groupId) {
      return _post('/v1/groups/join', { group_id: groupId });
    },

    // ===== 我的资料媒体 / 签到 / 刮刮乐（app.js:4436/13007/13022/13037/13394）=====
    async uploadMyAvatar(formData) {
      const r = await apiFetch('/v1/me/avatar', { method: 'POST', body: formData });
      return _parse(r);
    },
    async getMe() {
      const d = await _get('/v1/me');
      return d.user || d;
    },
    // 刮刮乐 GET：404 视为功能未上线返回 null；body 字段可能为 JSON 字符串需二次解析
    async getMeScratch() {
      const r = await apiFetch('/v1/me/scratch', { method: 'GET' });
      if (r.status === 404) return null;
      const text = await r.text();
      let data = {};
      try { data = JSON.parse(text); } catch (e) { console.warn('[scratch] not JSON:', text.slice(0, 100)); }
      if (data && typeof data.body === 'string') { try { data = JSON.parse(data.body); } catch (e) {} }
      return data;
    },
    // 刮刮乐 POST：返回 {status, data}，调用方按 status/error 判断成功
    async postMeScratch() {
      const r = await apiFetch('/v1/me/scratch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const text = await r.text();
      let data = {};
      try { data = JSON.parse(text); } catch (e) {}
      if (data && typeof data.body === 'string') { try { data = JSON.parse(data.body); } catch (e) {} }
      return { status: r.status, data };
    },

    // ===== 资源广场 resources（v1 临时关闭，暂缓；对应行 15628/15674/15727/15774/15809/15888/15904/15939/15962/15984）=====
    // ===== 通知 notifications（app.js:13273）=====
    // 404→功能建设中，非 JSON 容错，返回 {notFound, data}（与签到墙同模式）
    async getNotifications(limit = 50) {
      const r = await apiFetch(`/v1/notifications?limit=${limit}`);
      if (r.status === 404) return { notFound: true };
      const text = await r.text();
      let data = {};
      try { data = JSON.parse(text); } catch (e) { console.warn('[notice] not JSON:', text.slice(0, 100)); }
      if (data && data.error) throw new OCError(data.error);
      return { notFound: false, data };
    },

    // ===== 收藏 favorites（app.js:1420/13881/13908）=====
    async getFavorites(limit = 100) {
      const d = await _get('/v1/favorites?limit=' + limit);
      return d.items || (d.data && d.data.items) || [];
    },
    async addFavorite(body) {
      // body 字段复杂（type/target_id/title/subtitle/media_url/extra），透传不归一化
      return _post('/v1/favorites/add', body);
    },
    async removeFavorite(id) {
      return _post('/v1/favorites/remove', { id });
    },

    // ===== 音乐广场 music/plaza（app.js:2512/2933）=====
    // 上传为 FormData（非 JSON），单独走 apiFetch 直接发，再 _parse 兜 error
    async uploadMusicPlaza(formData) {
      const r = await apiFetch('/v1/music/plaza/upload', { method: 'POST', body: formData });
      return _parse(r);
    },
    async getMusicPlazaDetail(itemId) {
      const d = await _get('/v1/music/plaza/detail?id=' + encodeURIComponent(itemId));
      // 兼容响应嵌套：详情可能包在 item/data 字段里
      return d.item || d.data || d;
    },

    // ===== 用户资料 users/profile（app.js:3184/4306/4433/4463/4491/5942/5950/5959）=====
    // 三路径回退：ncuid → uid → (uid 当 ncuid 查，服务器可能把 ncuid 放进 from_uid)
    async getUserProfile({ ncuid, uid } = {}) {
      if (ncuid) {
        try {
          const d = await _get('/v1/users/profile?ncuid=' + encodeURIComponent(ncuid));
          if (d && !d.error) return d;
        } catch (e) {}
      }
      if (uid) {
        try {
          const d = await _get('/v1/users/profile?uid=' + encodeURIComponent(uid));
          if (d && !d.error) return d;
        } catch (e) {}
        if (!ncuid) {
          try {
            const d = await _get('/v1/users/profile?ncuid=' + encodeURIComponent(uid));
            if (d && !d.error) return d;
          } catch (e) {}
        }
      }
      return null;
    },
    async updateMyProfile(patch) {
      return _post('/v1/me/profile', patch);
    },
    async updateMyUid(uid) {
      return _post('/v1/me/uid', { uid });
    },

    // ===== 通知 notifications（app.js:13427）=====
    // 注意：通知页是「尽力解析」容错逻辑（检查 404 显示建设中、res.text() 再 JSON.parse），
    // 不适合强制归一化，app.js 保留裸 apiFetch 调用。此处不提供 OC 方法。

    // ===== 动态 moments（app.js:3219/3229/3444/3528/3610/3654，已由本文件上方实现）=====
  };

  global.OC = OC;
  if (typeof module !== 'undefined' && module.exports) module.exports = { OC, OCError };

})(typeof window !== 'undefined' ? window : globalThis);
