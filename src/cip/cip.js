// src/cip/cip.js
// CIP (Lua 小程序) 调试器控制器：编排 manifest 拉取 → 脚本拉取 → sha256 校验 →
// engine 执行 → render 渲染。host 实现复用 window.CipHost，渲染复用 window.CipRender。
// 入口：app.js 设置页「Lua 小程序调试器」按钮调用 window.CipController.open()。
(function (window) {
  'use strict';

  // 主后端源：运行时跟随 app.js 的 BACKEND_ORIGIN（设置页可改），拿不到时回落默认值。
  // 注意 app.js 顶层是 `let BACKEND_ORIGIN`，属于全局词法环境，同为经典脚本可直接引用。
  var FALLBACK_ORIGIN = 'http://oc.mcl0.dpdns.org';
  function origin() {
    try { if (typeof BACKEND_ORIGIN === 'string' && BACKEND_ORIGIN) return BACKEND_ORIGIN; } catch (e) {}
    return FALLBACK_ORIGIN;
  }
  function manifestUrl() { return origin() + '/v1/discover/lua/manifest'; }
  function appUrl(id) { return origin() + '/v1/discover/lua/apps/' + id; }

  function getToken() { return localStorage.getItem('oc_access_token') || ''; }
  function httpFetch(url, opts) {
    var impl = window.__tauriHttpFetchImpl;
    if (impl) return impl(url, opts);
    return fetch(url, opts);
  }
  function getJSON(url) {
    return httpFetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + getToken(), 'Accept': 'application/json' }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function sha256Hex(str) {
    if (window.crypto && window.crypto.subtle) {
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return b.toString(16).padStart(2, '0');
        }).join('');
      });
    }
    return Promise.resolve(null); // 无 subtle 时跳过校验
  }

  // 云端小程序缓存：manifest 清单缓存 4h；已下载小程序脚本永久缓存（版本不一致时由 checkRemoteUpdates 主动失效）。
  var CLOUD_CACHE_MS = 4 * 60 * 60 * 1000;
  var APP_CACHE_MS = 0; // 0 = 不过期
  function cacheKey(k) { return 'cip_cache_' + k; }
  function cacheGet(k, ttlMs) {
    try {
      var s = localStorage.getItem(cacheKey(k));
      if (!s) return null;
      var o = JSON.parse(s);
      if (!o || typeof o.ts !== 'number' || !o.data) return null;
      if (ttlMs > 0 && Date.now() - o.ts > ttlMs) return null; // 仅 ttl>0 时过期；0/未传 = 永久
      return o.data;
    } catch (e) { return null; }
  }
  function cacheSet(k, data, version) {
    try { localStorage.setItem(cacheKey(k), JSON.stringify({ ts: Date.now(), data: data, version: version || '' })); } catch (e) {}
  }
  function cacheVersion(k) {
    try {
      var s = localStorage.getItem(cacheKey(k));
      if (!s) return null;
      var o = JSON.parse(s);
      return (o && o.version) || null;
    } catch (e) { return null; }
  }
  function cacheDrop(k) { try { localStorage.removeItem(cacheKey(k)); } catch (e) {} }

  // 已订阅（已下载）的云端小程序：永久记录元数据，供侧边栏展示（不依赖 manifest 缓存）
  function getSubs() { try { return JSON.parse(localStorage.getItem('cip_subs') || '{}') || {}; } catch (e) { return {}; } }
  function saveSubs(subs) { try { localStorage.setItem('cip_subs', JSON.stringify(subs)); } catch (e) {} }
  function isSubscribed(id) { return !!getSubs()[id]; }
  function subscribeApp(app) {
    var subs = getSubs();
    subs[app.id] = {
      name: app.name || app.id,
      description: app.description || '',
      version: app.version || '',
      permissions: app.permissions || [],
      allowed_hosts: app.allowed_hosts || []
    };
    saveSubs(subs);
  }
  // 版本检测：manifest 版本与已缓存/已订阅版本不一致 → 删脚本缓存并更新订阅版本（下次运行自动重拉）
  function checkRemoteUpdates(remoteApps) {
    var subs = getSubs();
    var changed = false;
    (remoteApps || []).forEach(function (a) {
      var s = subs[a.id];
      if (s && a.version && s.version && s.version !== a.version) {
        cacheDrop('app_' + a.id);
        s.version = a.version;
        changed = true;
      }
    });
    if (changed) saveSubs(subs);
  }

  // 兼容旧缓存/边缘情况：存在脚本缓存（已下载到本地）但无订阅记录的云端小程序，自动补订阅。
  // 保证「已下载即显示在侧边栏」，即使此前版本（4h 缓存时代）下载过、没来得及订阅。
  function backfillSubsFromCache(remoteApps) {
    var subs = getSubs();
    var changed = false;
    var prefix = 'cip_cache_app_';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(prefix) !== 0) continue;
        var id = key.slice(prefix.length);
        if (!id || subs[id]) continue;
        var meta = null;
        (remoteApps || []).forEach(function (a) { if (a.id === id) meta = a; });
        subs[id] = {
          name: (meta && meta.name) || id,
          description: (meta && meta.description) || '',
          version: (meta && meta.version) || cacheVersion('app_' + id) || '',
          permissions: (meta && meta.permissions) || [],
          allowed_hosts: (meta && meta.allowed_hosts) || []
        };
        changed = true;
      }
    } catch (e) {}
    if (changed) saveSubs(subs);
  }

  // 字节可读化（用于「下载量」显示）
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // HTML 转义（发现页卡片渲染用）
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 服务端 manifest 条目 → 内部 app 对象
  function mapRemoteApp(a) {
    return {
      id: a.id,
      name: a.name || a.id,
      description: a.description || '',
      version: a.version || '',
      permissions: a.permissions || [],
      allowed_hosts: a.allowed_hosts || [],
      kind: 'remote'
    };
  }

  // 流式下载（带进度回调）。直接用 window.__tauriHttpFetchImpl（plugin:http），
  // 其返回标准 Response，body 为 ReadableStream，headers 含 content-length。
  // 边读边累计字节调用 onProgress(received, total)，最后返回完整文本。
  function fetchWithProgress(url, headers, onProgress) {
    var impl = window.__tauriHttpFetchImpl;
    var p = impl ? impl(url, { method: 'GET', headers: headers }) : fetch(url, { method: 'GET', headers: headers });
    return Promise.resolve(p).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : '')); });
      }
      var total = 0;
      try { total = parseInt((res.headers && res.headers.get ? res.headers.get('content-length') : '') || '0', 10) || 0; } catch (e) {}
      if (!res.body || !res.body.getReader) {
        return res.text().then(function (t) { var l = (t || '').length; if (onProgress) onProgress(l, l); return t; });
      }
      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          var v = r.value;
          if (v && v.byteLength) { received += v.byteLength; chunks.push(v); if (onProgress) onProgress(received, total); }
          return pump();
        });
      }
      return pump().then(function () {
        var buf = new Uint8Array(received);
        var pos = 0;
        chunks.forEach(function (c) { buf.set(c, pos); pos += c.byteLength; });
        return new TextDecoder('utf-8').decode(buf);
      });
    });
  }

  // 调 Rust 命令（与 app.js getInvoke() 同款写法）
  function cipInvoke(cmd, args) {
    var invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
      (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
    if (!invoke) return Promise.reject(new Error('当前环境不支持（需在 Tauri 中运行）'));
    return invoke(cmd, args || {});
  }

  var Controller = {
    _list: [],
    _engine: null,
    _last: null, // 最后执行的云端小程序脚本（供「重载」不重新下载直接重跑）
    _lastApp: null, // 当前运行的小程序（供运行区右键菜单使用）

    open: function () {
      // 跳转到小程序页面（发现页的独立面板）
      if (typeof window.switchTab === 'function') window.switchTab('cip');
      else this.refresh();
    },
    close: function () {
      this._teardown();
      var area = document.getElementById('cipRunArea');
      if (area) area.innerHTML = '<div class="cip-placeholder">从左侧选择一个小程序</div>';
      // 回到发现页落地页
      if (typeof window.switchTab === 'function') window.switchTab('discover');
    },
    _teardown: function () {
      if (this._engine) {
        try { this._engine.destroy(); } catch (e) {}
        this._engine = null;
      }
    },
    refresh: function () {
      var self = this;
      var listEl = document.getElementById('cipAppList');
      listEl.innerHTML = '<div class="cip-placeholder">加载清单中…</div>';
      // 本地与云端清单独立加载，任一失败都不影响另一部分
      Promise.allSettled([this.loadLocal(), this.loadRemote()]).then(function (r) {
        var list = [];
        if (r[0].status === 'fulfilled') list = list.concat(r[0].value);
        if (r[1].status === 'fulfilled') {
          list = list.concat(r[1].value);
          // 云端清单到位后做版本检测：不一致则失效缓存（下次运行自动重拉）
          checkRemoteUpdates(r[1].value);
          // 兼容旧缓存：已下载未订阅的云端小程序自动补订阅，保证侧边栏显示
          backfillSubsFromCache(r[1].value);
        }
        self._list = list;
        self.renderList();
      });
    },
    // 本地小程序（用户上传，存于用户目录）
    loadLocal: function () {
      return cipInvoke('list_cip_apps').then(function (apps) {
        return (apps || []).map(function (a) {
          return {
            id: a.id,
            name: a.name || a.id,
            description: a.description || '',
            version: a.version || '',
            permissions: a.permissions || [],
            allowed_hosts: a.allowed_hosts || [],
            kind: 'local'
          };
        });
      });
    },
    // 云端小程序（服务端 manifest），默认缓存 4h
    loadRemote: function (force) {
      if (!force) {
        var cached = cacheGet('manifest', CLOUD_CACHE_MS);
        if (cached && Array.isArray(cached.apps)) {
          return Promise.resolve(cached.apps.map(mapRemoteApp));
        }
      }
      return getJSON(manifestUrl()).then(function (data) {
        var apps = (data && data.apps) || [];
        cacheSet('manifest', { apps: apps });
        return apps.map(mapRemoteApp);
      });
    },
    renderList: function () {
      var listEl = document.getElementById('cipAppList');
      listEl.innerHTML = '';
      var self = this;
      // 顶部「发现小程序」入口：点击后右侧展示云端小程序列表（频道风格）
      var disc = document.createElement('div');
      disc.className = 'contact-item cip-discover-entry';
      disc.innerHTML = '<div class="msg-avatar"><i class="fa-solid fa-compass"></i></div>' +
        '<div class="contact-info"><div class="name">发现小程序</div><div class="uid">浏览云端小程序</div></div>';
      disc.addEventListener('click', function () {
        // 与 selectApp 一致：清除其它项高亮，选中「发现小程序」入口
        Array.prototype.forEach.call(listEl.children, function (c) { c.classList.remove('active'); });
        disc.classList.add('active');
        self.renderDiscover();
      });
      listEl.appendChild(disc);

      // 本地小程序（用户上传）
      this._list.filter(function (a) { return a.kind === 'local'; }).forEach(function (app) {
        listEl.appendChild(self._buildListItem(app));
      });

      // 已订阅云端小程序：从订阅记录恢复（永久），不依赖 manifest 缓存
      var subs = getSubs();
      Object.keys(subs).forEach(function (id) {
        var s = subs[id];
        listEl.appendChild(self._buildListItem({
          id: id,
          name: s.name,
          description: s.description,
          version: s.version,
          permissions: s.permissions,
          allowed_hosts: s.allowed_hosts,
          kind: 'remote'
        }));
      });

      if (!this._list.some(function (a) { return a.kind === 'local'; }) && !Object.keys(subs).length) {
        // 保留顶部「发现小程序」入口，仅追加空态提示
        var ph = document.createElement('div');
        ph.className = 'cip-placeholder';
        ph.innerHTML = '没有可用小程序<br>点上方「上传本地小程序」或「发现小程序」试试';
        listEl.appendChild(ph);
        return;
      }
    },
    _buildListItem: function (app) {
      var self = this;
      var item = document.createElement('div');
      item.className = 'contact-item cip-app-item';
      item.dataset.id = app.id;
      item.dataset.kind = app.kind;

      // 左侧图标：与发现页「小程序」入口一致（立方体 + 主题色圆底）
      var avatar = document.createElement('div');
      avatar.className = 'msg-avatar';
      avatar.innerHTML = '<i class="fa-solid fa-cube"></i>';

      // 中间信息：名称 + 描述，复用联系人列表 .name / .uid 样式
      var info = document.createElement('div');
      info.className = 'contact-info';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = app.name || app.id;
      var desc = document.createElement('div');
      desc.className = 'uid';
      desc.textContent = app.description || '';
      info.appendChild(name);
      info.appendChild(desc);

      // 右侧：来源徽标 + （本地）删除按钮
      var right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '6px';
      right.style.flexShrink = '0';
      var badge = document.createElement('span');
      badge.className = 'cip-badge ' + (app.kind === 'local' ? 'cip-badge-local' : 'cip-badge-remote');
      badge.textContent = app.kind === 'local' ? '本地' : '云端';
      // 已「赋予所有权限 / 退出沙箱」的云端小程序：徽标加标记，提示用户
      if (app.kind === 'remote' && isGrantedAll(app.id)) {
        badge.classList.add('cip-badge-granted');
        badge.title = '已赋予全部权限（退出沙箱运行）';
        badge.textContent = '云端·全权限';
      }
      right.appendChild(badge);

      item.appendChild(avatar);
      item.appendChild(info);
      item.appendChild(right);
      item.addEventListener('click', function () { self.selectApp(app, item); });
      return item;
    },
    // 「发现小程序」：右侧渲染云端小程序列表（风格/动画参考频道发现页）
    renderDiscover: function () {
      var self = this;
      var area = document.getElementById('cipRunArea');
      area.innerHTML = '<div class="cip-placeholder">加载小程序清单…</div>';
      // 强制刷新 manifest，保证版本检测及时
      this.loadRemote(true).then(function (apps) {
        checkRemoteUpdates(apps);
        backfillSubsFromCache(apps);
        var remote = apps.filter(function (a) { return a.kind === 'remote'; });
        if (!remote.length) {
          area.innerHTML = '<div class="cip-placeholder">云端暂时没有小程序</div>';
          return;
        }
        area.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'cip-discover';
        var head = document.createElement('div');
        head.className = 'channel-browser-head';
        head.innerHTML = '<h2>发现小程序</h2>';
        wrap.appendChild(head);
        var list = document.createElement('div');
        list.className = 'channel-list';
        remote.forEach(function (app, i) {
          var dl = cacheGet('app_' + app.id, APP_CACHE_MS);
          var card = document.createElement('div');
          card.className = 'channel-card cip-disc-card';
          card.style.animationDelay = (i * 40) + 'ms';
          var actionsHtml = dl
            ? '<span class="cip-badge cip-badge-remote">已下载</span>'
            : '<button class="btn primary cip-dl-btn"><i class="fa-solid fa-download"></i> 下载</button>';
          card.innerHTML =
            '<div class="channel-card-avatar cip-card-avatar"><i class="fa-solid fa-cube"></i></div>' +
            '<div class="channel-card-info">' +
              '<div class="name">' + esc(app.name) + '</div>' +
              '<div class="meta">v' + esc(app.version || '?') + ' · 云端</div>' +
              (app.description ? '<div class="desc">' + esc(app.description) + '</div>' : '') +
            '</div>' +
            '<div class="channel-card-actions">' + actionsHtml + '</div>';
          card.addEventListener('click', function () {
            // 下载并运行；完成后自动订阅并刷新侧边栏
            self.runApp(app, false);
          });
          list.appendChild(card);
        });
        wrap.appendChild(list);
        area.appendChild(wrap);
      }).catch(function (err) {
        area.innerHTML = '<div class="cip-error">加载失败：' + ((err && err.message) || err) + '</div>';
      });
    },
    selectApp: function (app, itemEl) {
      var listEl = document.getElementById('cipAppList');
      Array.prototype.forEach.call(listEl.children, function (c) { c.classList.remove('active'); });
      if (itemEl) itemEl.classList.add('active');
      this.runApp(app);
    },
    runApp: function (app, force) {
      var self = this;
      var area = document.getElementById('cipRunArea');
      this._lastApp = app;
      applyClarity(); // 保持运行区「文本清晰模式」状态
      if (app.kind === 'local') {
        area.innerHTML = '<div class="cip-placeholder">加载「' + (app.name || app.id) + '」中…</div>';
        // 本地小程序：读取入口脚本 + 包内资源（不做 sha256 远程校验）
        Promise.all([
          cipInvoke('read_cip_app', { id: app.id }),
          cipInvoke('read_cip_assets', { id: app.id }).catch(function () { return []; })
        ]).then(function (res) {
          var script = res[0];
          var assets = res[1] || [];
          if (!script) { area.innerHTML = '<div class="cip-error">脚本为空</div>'; return; }
          self.execute(app, script, self._buildAssetResolver(assets, app.id));
        }).catch(function (err) {
          area.innerHTML = '<div class="cip-error">加载失败：' + ((err && err.message) || err) + '</div>';
        });
        return;
      }
      // 云端小程序：优先读永久缓存，否则流式下载 + 进度 + sha256 校验；资源走 /lua-assets/<id>/<path>
      var prog = this._showLoading(area, app);
      var cached = force ? null : cacheGet('app_' + app.id, APP_CACHE_MS);
      if (cached && cached.script) {
        prog.note('已从缓存读取（永久缓存，版本更新自动重拉）');
        prog.done();
        this._executeFromData(app, cached);
        return;
      }
      prog.note('连接服务器…');
      fetchWithProgress(appUrl(app.id), {
        'Authorization': 'Bearer ' + getToken(),
        'Accept': 'application/json'
      }, function (received, total) { prog.update(received, total); })
        .then(function (text) {
          var data;
          try { data = JSON.parse(text); } catch (e) { throw new Error('响应不是合法 JSON'); }
          var script = data && data.script;
          if (!script) { area.innerHTML = '<div class="cip-error">脚本为空</div>'; return; }
          cacheSet('app_' + app.id, data, app.version);
          // 下载成功即订阅（永久），并刷新侧边栏使该小程序出现
          subscribeApp(app);
          self.renderList();
          prog.note('校验中…');
          sha256Hex(script).then(function (hash) {
            var expected = (data.sha256 || '').toLowerCase();
            if (expected && hash && hash !== expected) {
              area.innerHTML = '<div class="cip-error">校验失败：sha256 不匹配（期望 ' +
                expected.slice(0, 12) + '… 实际 ' + hash.slice(0, 12) + '…）</div>';
              return;
            }
            prog.done();
            self._executeFromData(app, data);
          });
        })
        .catch(function (err) {
          area.innerHTML = '<div class="cip-error">加载失败：' + ((err && err.message) || err) + '</div>';
        });
    },
    // 渲染右侧加载进度 UI，返回更新器
    _showLoading: function (area, app) {
      area.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.className = 'cip-loading';
      var title = document.createElement('div');
      title.className = 'cip-loading-title';
      title.textContent = '加载「' + (app.name || app.id) + '」中…';
      var barWrap = document.createElement('div');
      barWrap.className = 'cip-progress';
      var bar = document.createElement('div');
      bar.className = 'cip-progress-bar';
      barWrap.appendChild(bar);
      var meta = document.createElement('div');
      meta.className = 'cip-loading-meta';
      meta.textContent = '准备下载…';
      wrap.appendChild(title);
      wrap.appendChild(barWrap);
      wrap.appendChild(meta);
      area.appendChild(wrap);
      return {
        update: function (received, total) {
          if (total && total > 0) {
            var pct = Math.min(100, Math.round(received / total * 100));
            bar.style.width = pct + '%';
            meta.textContent = fmtBytes(received) + ' / ' + fmtBytes(total) + '（' + pct + '%）';
          } else {
            bar.style.width = '100%';
            meta.textContent = '已下载 ' + fmtBytes(received);
          }
        },
        note: function (t) { meta.textContent = t; },
        done: function () { bar.style.width = '100%'; }
      };
    },
    // 由缓存/网络拿到的 app 数据执行（构建云端资源解析器）
    _executeFromData: function (app, data) {
      var script = data && data.script;
      if (!script) { var area = document.getElementById('cipRunArea'); area.innerHTML = '<div class="cip-error">脚本为空</div>'; return; }
      var resolver = function (path) {
        var p = String(path || '').replace(/^assets\//, '');
        return origin() + '/lua-assets/' + app.id + '/' + p;
      };
      // 记一份内存副本，供「重载」不重新下载直接重跑
      this._last = { id: app.id, script: script, resolver: resolver };
      this.execute(app, script, resolver);
    },
    // 重载：不重新下载，直接重跑内存中最后执行的脚本（无则退回缓存/下载）
    reloadApp: function (app) {
      var last = this._last;
      if (last && last.id === app.id && last.script) {
        this.execute(app, last.script, last.resolver);
      } else {
        this.runApp(app, false);
      }
    },
    // 由包内资源列表构建 path -> data URI 解析器（兼容 assets/ 前缀）
    _buildAssetResolver: function (assets, id) {
      var map = {};
      (assets || []).forEach(function (a) {
        var p = a.path || '';
        if (a.data_uri) {
          map[p] = a.data_uri;
          var stripped = p.replace(/^assets\//, '');
          if (stripped && stripped !== p) map[stripped] = a.data_uri;
        }
      });
      return function (path) {
        var p = String(path || '');
        return map[p] || map[p.replace(/^assets\//, '')] || null;
      };
    },
    execute: function (app, script, resolver) {
      var area = document.getElementById('cipRunArea');
      try {
        if (!window.CipEngine) { area.innerHTML = '<div class="cip-error">引擎未加载（fengari 缺失）</div>'; return; }
        if (!window.CipHost || !window.CipRender) { area.innerHTML = '<div class="cip-error">宿主/渲染模块缺失</div>'; return; }

        // 切换小程序前先销毁上一个 Lua state，避免定时器/回调打到已废弃的 state
        this._teardown();

        // 权限 / 外网白名单 / 资源解析器透传给引擎与宿主。
        // 若已「赋予所有权限」，则退出沙箱：权限与白名单全部放行（不受清单限制）。
        var sandbox = !isGrantedAll(app.id);
        var opts = sandbox
          ? {
              permissions: app.permissions || [],
              allowedHosts: app.allowed_hosts || [],
              isRemote: app.kind === 'remote'
            }
          : {
              permissions: ['*'],
              allowedHosts: ['*'],
              isRemote: app.kind === 'remote',
              sandbox: false
            };
        var ctx = { appId: app.id, toast: this.toast.bind(this), engine: null, assetResolver: resolver || null };
        var host = window.CipHost.makeHost(ctx);
        var engine = new window.CipEngine(app.id, host, opts);
        ctx.engine = engine;
        this._engine = engine;
        engine.init();

        if (window.CipRender) window.CipRender.clearRegistry(app.id);
        var tree = engine.run(script);
        var dom = window.CipRender.renderTree(tree, {
          appId: app.id,
          invokeRef: function (ref) { engine.invokeRef(ref); },
          toast: this.toast.bind(this)
        });
        area.innerHTML = '';
        area.appendChild(dom);
      } catch (e) {
        area.innerHTML = '<div class="cip-error">' + ((e && e.message) || e) + '</div>';
      }
    },
    uploadApp: function () {
      var self = this;
      cipInvoke('import_cip_app').then(function (meta) {
        self.toast('已导入「' + (meta.name || meta.id) + '」');
        self.refresh();
      }).catch(function (err) {
        var m = (err && (err.message || err)) || '';
        // 用户取消选择（"未选择文件"/cancelled）则静默
        if (String(m).indexOf('未选择') === -1 && String(m).toLowerCase().indexOf('cancel') === -1) {
          self.toast('导入失败：' + m);
        }
      });
    },
    deleteApp: function (app, itemEl) {
      var self = this;
      if (app.kind === 'remote') {
        // 云端小程序：删除订阅记录 + 清除脚本缓存；若正在运行则停止并清空运行区
        var subs = getSubs();
        delete subs[app.id];
        saveSubs(subs);
        cacheDrop('app_' + app.id);
        if (self._lastApp && self._lastApp.id === app.id) {
          self._teardown();
          self._lastApp = null;
          var area = document.getElementById('cipRunArea');
          if (area) area.innerHTML = '<div class="cip-placeholder">从左侧选择一个小程序</div>';
        }
        self.toast('已删除「' + (app.name || app.id) + '」');
        self.renderList();
        return;
      }
      // 本地小程序：Rust 侧删除文件
      cipInvoke('delete_cip_app', { id: app.id }).then(function () {
        if (itemEl && itemEl.parentNode) itemEl.parentNode.removeChild(itemEl);
        self.toast('已删除「' + (app.name || app.id) + '」');
        self.refresh();
      }).catch(function (err) {
        self.toast('删除失败：' + ((err && err.message) || err));
      });
    },
    toast: function (msg) {
      var t = document.createElement('div');
      t.className = 'cip-toast';
      t.textContent = String(msg);
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.classList.add('show'); });
      setTimeout(function () {
        t.classList.remove('show');
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
      }, 2200);
    }
  };

  // 供 host.js / 其他模块使用的全局
  Object.defineProperty(window, '__cipBackendOrigin', { get: origin, configurable: true });
  // 约定：resolve 出「响应正文字符串」（host.js 的 http_get 直接把它回传给 Lua 回调）
  window.__cipHttpGet = function (url) {
    var headers = { 'Accept': 'application/json' };
    // 只对本后端源附带凭据，避免把 token 泄漏到小程序指定的第三方地址
    if (String(url).indexOf(origin()) === 0) headers['Authorization'] = 'Bearer ' + getToken();
    return httpFetch(url, { method: 'GET', headers: headers }).then(function (r) {
      return r.text().then(function (text) {
        if (!r.ok) throw new Error('HTTP ' + r.status + (text ? ': ' + text.slice(0, 200) : ''));
        return text;
      });
    });
  };
  // 通用 HTTP 请求（供 app.http_request 使用）：支持 method/headers/body。
  // 走 window.__tauriHttpFetchImpl（plugin:http，Rust 侧取，绕开 CORS）；相对路径自动补 origin+/v1 并带 Bearer，
  // 绝对 URL 视为外网、不带凭据（allowed_hosts 白名单已在引擎侧校验）。
  window.__cipHttpRequest = function (opts) {
    opts = opts || {};
    var url = opts.url || '';
    var method = (opts.method || 'GET').toUpperCase();
    var headers = {};
    var h = opts.headers || {};
    Object.keys(h).forEach(function (k) { headers[k] = String(h[k]); });
    var isAbs = /^https?:\/\//i.test(url);
    if (!isAbs) {
      url = origin() + '/v1' + (url.charAt(0) === '/' ? url : '/' + url);
      headers['Authorization'] = 'Bearer ' + getToken();
    }
    var init = { method: method, headers: headers };
    if (method !== 'GET' && method !== 'HEAD' && opts.body != null) init.body = opts.body;
    var impl = window.__tauriHttpFetchImpl;
    var p = impl ? impl(url, init) : fetch(url, init);
    return Promise.resolve(p).then(function (r) {
      return r.text().then(function (text) {
        var rh = {};
        try { if (r.headers && r.headers.forEach) r.headers.forEach(function (v, k) { rh[k] = v; }); } catch (e) {}
        return { status: r.status, headers: rh, body: text };
      });
    });
  };
  window.__cipClose = function () { Controller.close(); };
  window.CipController = Controller;

  // 上传按钮绑定（模块加载时绑一次，不依赖页面打开）
  (function bindCipUpload() {
    var up = document.getElementById('cipUploadBtn');
    if (up && !up.dataset.bound) {
      up.dataset.bound = '1';
      up.addEventListener('click', function () { Controller.uploadApp(); });
    }
  })();

  // 「赋予所有权限 / 退出沙箱」：永久生效（localStorage），需用户弹窗确认。
  var ALL_PERMS_PREFIX = 'cip_perms_all_';
  function isGrantedAll(id) {
    try { return localStorage.getItem(ALL_PERMS_PREFIX + id) === '1'; } catch (e) { return false; }
  }
  function setGrantedAll(id, v) {
    try { if (v) localStorage.setItem(ALL_PERMS_PREFIX + id, '1'); else localStorage.removeItem(ALL_PERMS_PREFIX + id); } catch (e) {}
  }

  // 右键菜单：复用全局 .custom-context-menu 样式（与聊天红包菜单外观一致），不再自绘丑样式
  var _ctxMenu = null;
  function _closeCtxMenu() {
    if (_ctxMenu && _ctxMenu.parentNode) _ctxMenu.parentNode.removeChild(_ctxMenu);
    _ctxMenu = null;
    document.removeEventListener('click', _onDocClickMenu, true);
    document.removeEventListener('keydown', _onEscMenu, true);
  }
  function _onDocClickMenu(e) { if (!_ctxMenu || !_ctxMenu.contains(e.target)) _closeCtxMenu(); }
  function _onEscMenu(e) { if (e.key === 'Escape') _closeCtxMenu(); }

  // items: [{ label, run, danger?, checked? }]
  function _openNativeMenu(items, x, y) {
    _closeCtxMenu();
    var menu = document.createElement('div');
    menu.className = 'custom-context-menu';
    items.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'context-menu-item' + (d.danger ? ' danger' : '');
      el.textContent = (d.checked ? '✓ ' : '') + d.label;
      el.addEventListener('click', function (e) { e.stopPropagation(); _closeCtxMenu(); d.run(); });
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    // 定位：避免溢出视口
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    if (x + mw > window.innerWidth) x = Math.max(4, window.innerWidth - mw - 4);
    if (y + mh > window.innerHeight) y = Math.max(4, window.innerHeight - mh - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    requestAnimationFrame(function () { menu.classList.add('show'); });
    _ctxMenu = menu;
    setTimeout(function () {
      document.addEventListener('click', _onDocClickMenu, true);
      document.addEventListener('keydown', _onEscMenu, true);
    }, 0);
  }

  // 列表项右键菜单：本地/云端都弹；「重新下载」仅云端有
  function _openCtxMenu(app, x, y) {
    var granted = isGrantedAll(app.id);
    var items = [];
    if (app.kind === 'remote') {
      // 重新下载：清缓存 + 强制从云端拉取（带进度）
      items.push({ label: '重新下载', run: function () { cacheDrop('app_' + app.id); Controller.runApp(app, true); } });
    }
    // 重载：不重新下载，直接重跑内存中最后执行的脚本
    items.push({ label: '重载', run: function () { Controller.reloadApp(app); } });
    if (granted) {
      items.push({ label: '取消赋予所有权限', danger: true, run: function () {
        setGrantedAll(app.id, false);
        Controller.renderList();
        Controller.toast('已取消「' + (app.name || app.id) + '」的全部权限赋予');
        Controller.runApp(app, false);
      } });
    } else {
      items.push({ label: '赋予所有权限', run: function () { _requestGrantAll(app); } });
    }
    // 删除：本地=删文件；云端=删订阅+缓存（均允许）
    items.push({ label: '删除', danger: true, run: function () { Controller.deleteApp(app, null); } });
    _openNativeMenu(items, x, y);
  }
  function _requestGrantAll(app) {
    var warn = '即将为「' + (app.name || app.id) + '」赋予全部权限并退出沙箱运行。\n\n'
      + '此后该小程序将不受清单权限限制，可访问存储、网络（含外网）、相机等全部能力，'
      + '且此设置为永久生效（直到你在此右键菜单选择「取消赋予所有权限」）。\n\n'
      + '仅在你完全信任该小程序来源时继续。确定继续吗？';
    var proceed = function () {
      setGrantedAll(app.id, true);
      Controller.renderList();
      Controller.toast('已为「' + (app.name || app.id) + '」赋予全部权限（退出沙箱）');
      Controller.runApp(app, false);
    };
    if (typeof window.showConfirm === 'function') {
      window.showConfirm(warn, '赋予所有权限（危险）').then(function (ok) { if (ok) proceed(); });
    } else if (window.confirm(warn)) {
      proceed();
    }
  }

  // ===== 文本清晰模式（强制运行区所有文本使用主题可读色，覆盖小程序硬编码深色）=====
  var CLARITY_KEY = 'cip_clarity';
  function clarityOn() { try { return localStorage.getItem(CLARITY_KEY) === '1'; } catch (e) { return false; } }
  function setClarity(on) { try { if (on) localStorage.setItem(CLARITY_KEY, '1'); else localStorage.removeItem(CLARITY_KEY); } catch (e) {} applyClarity(); }
  function applyClarity() {
    var area = document.getElementById('cipRunArea');
    if (area) area.classList.toggle('cip-clarity', clarityOn());
  }

  // 运行区右键菜单：文本清晰模式 / 重载 / [重新下载(仅云端)]
  function _openRunCtxMenu(app, x, y) {
    var on = clarityOn();
    var items = [
      { label: '文本清晰模式', checked: on, run: function () { var nv = !on; setClarity(nv); Controller.toast(nv ? '已开启文本清晰模式' : '已关闭文本清晰模式'); } },
      { label: '重载', run: function () { Controller.reloadApp(app); } }
    ];
    if (app.kind === 'remote') {
      items.push({ label: '重新下载', run: function () { cacheDrop('app_' + app.id); Controller.runApp(app, true); } });
    }
    // 删除：本地=删文件；云端=删订阅+缓存（均允许）
    items.push({ label: '删除', danger: true, run: function () { Controller.deleteApp(app, null); } });
    _openNativeMenu(items, x, y);
  }

  // 运行区右键：在运行的小程序内容上右键 → 弹菜单（文本清晰模式 / 重载 / 重新下载）
  (function bindCipRunMenu() {
    var area = document.getElementById('cipRunArea');
    if (area && !area.dataset.menuBound) {
      area.dataset.menuBound = '1';
      area.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation(); // 不与全局聊天右键菜单混用
        var app = Controller._lastApp;
        if (!app) return;
        _openRunCtxMenu(app, e.clientX, e.clientY);
      });
    }
  })();
  applyClarity();

  // 右键菜单（云端小程序）：在列表容器上做事件委托，避免每次 renderList 重复绑监听。
  // 右键云端项 → 弹出菜单（重新下载 / 重载 / 赋予所有权限）；其余区域右键仅屏蔽原生菜单。
  (function bindCipListMenu() {
    var list = document.getElementById('cipAppList');
    if (list && !list.dataset.menuBound) {
      list.dataset.menuBound = '1';
      list.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var item = e.target && e.target.closest ? e.target.closest('.cip-app-item') : null;
        if (!item) { _closeCtxMenu(); return; }
        var id = item.dataset.id;
        var app = null;
        for (var i = 0; i < Controller._list.length; i++) {
          if (Controller._list[i].id === id) { app = Controller._list[i]; break; }
        }
        if (!app) { _closeCtxMenu(); return; }
        Array.prototype.forEach.call(list.children, function (c) { c.classList.remove('active'); });
        item.classList.add('active');
        _openCtxMenu(app, e.clientX, e.clientY);
      });
    }
  })();

  // ESC：仅当处于小程序页面时生效，回到发现页落地页（捕获阶段拦截，避免同时触发 app.js 的其它 ESC 逻辑）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var main = document.querySelector('.main-panel[data-panel="cip"]');
      if (main && main.classList.contains('active')) {
        e.stopPropagation();
        e.preventDefault();
        Controller.close();
      }
    }
  }, true);
})(window);
