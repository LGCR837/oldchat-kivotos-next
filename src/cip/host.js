// src/cip/host.js
// 实现 Lua 侧 app.* 宿主 API。行为通过 ctx 注入（ctx 由 CipRunner 提供）：
//   ctx.appId, ctx.toast(msg), ctx.engine.invokeRef(ref, ...args)
// 网络/后端原点/关闭由全局钩子提供：
//   window.__cipBackendOrigin, window.__cipHttpGet(url)->Promise<string>, window.__cipClose()
(function (window) {
  'use strict';

  function makeHost(ctx) {
    function storeKey(k) { return 'cip_store_' + ctx.appId + '_' + k; }

    return {
      toast: function (msg) {
        if (ctx.toast) ctx.toast(String(msg));
      },
      storage_get: function (k) {
        try { return localStorage.getItem(storeKey(k)); } catch (e) { return null; }
      },
      storage_set: function (k, v) {
        try { localStorage.setItem(storeKey(k), String(v)); } catch (e) {}
      },
      storage_remove: function (k) {
        try { localStorage.removeItem(storeKey(k)); } catch (e) {}
      },
      storage_clear: function () {
        try {
          var prefix = storeKey('');
          var toDel = [];
          for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && key.indexOf(prefix) === 0) toDel.push(key);
          }
          toDel.forEach(function (key) { localStorage.removeItem(key); });
        } catch (e) {}
      },
      storage_keys: function () {
        var prefix = storeKey('');
        var out = [];
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && key.indexOf(prefix) === 0) out.push(key.slice(prefix.length));
          }
        } catch (e) {}
        return out;
      },
      storage_count: function () {
        return (this.storage_keys() || []).length;
      },
      storage_get_json: function (k) {
        try {
          var s = localStorage.getItem(storeKey(k));
          return s == null ? null : JSON.parse(s);
        } catch (e) { return null; }
      },
      storage_set_json: function (k, v) {
        try { localStorage.setItem(storeKey(k), JSON.stringify(v)); } catch (e) {}
      },
      json: function (v) {
        try { return JSON.stringify(v); } catch (e) { return 'null'; }
      },
      delay: function (ms, cbRef) {
        var n = Number(ms) || 0;
        setTimeout(function () {
          if (typeof cbRef === 'number') ctx.engine.invokeRef(cbRef);
        }, n);
      },
      set_text: function (id, val) {
        window.CipRender.setText(ctx.appId, id, val);
      },
      set_image: function (id, uri) {
        window.CipRender.setImage(ctx.appId, id, uri);
      },
      append_text: function (id, val) {
        window.CipRender.appendText(ctx.appId, id, val);
      },
      set_hint: function (id, hint) {
        window.CipRender.setHint(ctx.appId, id, hint);
      },
      focus: function (id) {
        window.CipRender.focus(ctx.appId, id);
      },
      get_text: function (id) {
        return window.CipRender.getText(ctx.appId, id);
      },
      get_checked: function (id) {
        return window.CipRender.getChecked(ctx.appId, id);
      },
      set_checked: function (id, checked) {
        window.CipRender.setChecked(ctx.appId, id, checked);
      },
      set_visible: function (id, visible) {
        window.CipRender.setVisible(ctx.appId, id, visible);
      },
      get_visible: function (id) {
        return window.CipRender.getVisible(ctx.appId, id);
      },
      set_enabled: function (id, enabled) {
        window.CipRender.setEnabled(ctx.appId, id, enabled);
      },
      // 资源寻址：本地包走 ctx.assetResolver（由 cip.js 预载 data URI），远程包返回 /lua-assets/<id>/ 路径
      asset: function (path) {
        if (typeof ctx.assetResolver === 'function') return ctx.assetResolver(path);
        return null;
      },
      http_get: function (pathOrUrl, cbRef) {
        var url;
        if (/^https?:\/\//i.test(pathOrUrl)) {
          url = pathOrUrl;
        } else {
          var base = window.__cipBackendOrigin || '';
          url = base + '/v1' + (pathOrUrl.charAt(0) === '/' ? pathOrUrl : '/' + pathOrUrl);
        }
        var p = window.__cipHttpGet
          ? window.__cipHttpGet(url)
          : fetch(url).then(function (r) { return r.text(); });
        Promise.resolve(p).then(function (text) {
          if (typeof cbRef === 'number') {
            ctx.engine.invokeRef(cbRef, text != null ? String(text) : '', null);
          }
        }).catch(function (err) {
          if (typeof cbRef === 'number') {
            ctx.engine.invokeRef(cbRef, null, String((err && err.message) || err));
          }
        });
      },
      camera: function (cbRef) {
        // 桌面端降级：暂不支持相机，回调以错误返回（engine.camera 已改用 cip_pick_image）
        if (typeof cbRef === 'number') {
          ctx.engine.invokeRef(cbRef, null, '桌面端暂不支持相机');
        }
      },
      back: function () {
        if (typeof window.__cipClose === 'function') window.__cipClose();
      }
    };
  }

  window.CipHost = { makeHost: makeHost };
})(window);
