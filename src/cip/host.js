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
        // 桌面端降级：暂不支持相机，回调以错误返回
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
