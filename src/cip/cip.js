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

    open: function () {
      var el = document.getElementById('cipDebugger');
      if (el) el.classList.remove('hidden');
      // 绑定「上传本地小程序」按钮（仅绑一次）
      var up = document.getElementById('cipUploadBtn');
      if (up && !up.dataset.bound) {
        up.dataset.bound = '1';
        up.addEventListener('click', function () { Controller.uploadApp(); });
      }
      this.refresh();
    },
    close: function () {
      var el = document.getElementById('cipDebugger');
      if (el) el.classList.add('hidden');
      this._teardown();
      var area = document.getElementById('cipRunArea');
      if (area) area.innerHTML = '<div class="cip-placeholder">从左侧选择一个小程序</div>';
    },
    isOpen: function () {
      var el = document.getElementById('cipDebugger');
      return !!el && !el.classList.contains('hidden');
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
      // 本地与官方清单独立加载，任一失败都不影响另一部分
      Promise.allSettled([this.loadLocal(), this.loadRemote()]).then(function (r) {
        var list = [];
        if (r[0].status === 'fulfilled') list = list.concat(r[0].value);
        if (r[1].status === 'fulfilled') list = list.concat(r[1].value);
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
            kind: 'local'
          };
        });
      });
    },
    // 官方小程序（服务端 manifest）
    loadRemote: function () {
      return getJSON(manifestUrl()).then(function (data) {
        return (data && data.apps || []).map(function (a) {
          return {
            id: a.id,
            name: a.name || a.id,
            description: a.description || '',
            version: a.version || '',
            permissions: a.permissions || [],
            kind: 'remote'
          };
        });
      });
    },
    renderList: function () {
      var listEl = document.getElementById('cipAppList');
      listEl.innerHTML = '';
      if (!this._list.length) { listEl.innerHTML = '<div class="cip-placeholder">没有可用小程序<br>点上方「上传本地小程序」试试</div>'; return; }
      var self = this;
      this._list.forEach(function (app) {
        var item = document.createElement('div');
        item.className = 'cip-app-item';
        item.dataset.id = app.id;
        item.dataset.kind = app.kind;

        var head = document.createElement('div');
        head.style.display = 'flex';
        head.style.alignItems = 'center';
        head.style.justifyContent = 'space-between';
        head.style.gap = '8px';

        var nameWrap = document.createElement('div');
        nameWrap.style.minWidth = '0';
        var name = document.createElement('div'); name.className = 'cip-app-name';
        name.textContent = app.name || app.id;
        var desc = document.createElement('div'); desc.className = 'cip-app-desc';
        desc.textContent = app.description || '';
        nameWrap.appendChild(name); nameWrap.appendChild(desc);
        head.appendChild(nameWrap);

        // 右侧：来源徽标 + （本地）删除按钮
        var right = document.createElement('div');
        right.style.display = 'flex';
        right.style.alignItems = 'center';
        right.style.gap = '6px';
        right.style.flexShrink = '0';
        var badge = document.createElement('span');
        badge.className = 'cip-badge ' + (app.kind === 'local' ? 'cip-badge-local' : 'cip-badge-remote');
        badge.textContent = app.kind === 'local' ? '本地' : '官方';
        right.appendChild(badge);
        if (app.kind === 'local') {
          var del = document.createElement('button');
          del.className = 'cip-app-del';
          del.title = '删除小程序';
          del.innerHTML = '<i class="fa-solid fa-trash"></i>';
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            self.deleteApp(app, item);
          });
          right.appendChild(del);
        }
        head.appendChild(right);
        item.appendChild(head);

        item.addEventListener('click', function () { self.selectApp(app, item); });
        listEl.appendChild(item);
      });
    },
    selectApp: function (app, itemEl) {
      var listEl = document.getElementById('cipAppList');
      Array.prototype.forEach.call(listEl.children, function (c) { c.classList.remove('active'); });
      if (itemEl) itemEl.classList.add('active');
      this.runApp(app);
    },
    runApp: function (app) {
      var self = this;
      var area = document.getElementById('cipRunArea');
      area.innerHTML = '<div class="cip-placeholder">加载「' + (app.name || app.id) + '」中…</div>';
      if (app.kind === 'local') {
        // 本地小程序：从用户目录读取入口脚本（不做 sha256 远程校验）
        cipInvoke('read_cip_app', { id: app.id }).then(function (script) {
          if (!script) { area.innerHTML = '<div class="cip-error">脚本为空</div>'; return; }
          self.execute(app, script);
        }).catch(function (err) {
          area.innerHTML = '<div class="cip-error">加载失败：' + ((err && err.message) || err) + '</div>';
        });
        return;
      }
      // 官方小程序：拉取脚本 + sha256 校验
      getJSON(appUrl(app.id)).then(function (data) {
        var script = data && data.script;
        if (!script) { area.innerHTML = '<div class="cip-error">脚本为空</div>'; return; }
        sha256Hex(script).then(function (hash) {
          var expected = (data.sha256 || '').toLowerCase();
          if (expected && hash && hash !== expected) {
            area.innerHTML = '<div class="cip-error">校验失败：sha256 不匹配（期望 ' +
              expected.slice(0, 12) + '… 实际 ' + hash.slice(0, 12) + '…）</div>';
            return;
          }
          self.execute(app, script);
        });
      }).catch(function (err) {
        area.innerHTML = '<div class="cip-error">加载失败：' + ((err && err.message) || err) + '</div>';
      });
    },
    execute: function (app, script) {
      var area = document.getElementById('cipRunArea');
      try {
        if (!window.CipEngine) { area.innerHTML = '<div class="cip-error">引擎未加载（fengari 缺失）</div>'; return; }
        if (!window.CipHost || !window.CipRender) { area.innerHTML = '<div class="cip-error">宿主/渲染模块缺失</div>'; return; }

        // 切换小程序前先销毁上一个 Lua state，避免定时器/回调打到已废弃的 state
        this._teardown();

        // host 复用 window.CipHost；engine 在构造后赋给 ctx.engine，运行时再调用
        var ctx = { appId: app.id, toast: this.toast.bind(this), engine: null };
        var engine = new window.CipEngine(app.id, window.CipHost.makeHost(ctx), {});
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
  window.__cipClose = function () { Controller.close(); };
  window.CipController = Controller;

  // ESC 关闭调试器（捕获阶段拦截，避免同时触发 app.js 的其它 ESC 逻辑）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && Controller.isOpen()) {
      e.stopPropagation();
      e.preventDefault();
      Controller.close();
    }
  }, true);
})(window);
