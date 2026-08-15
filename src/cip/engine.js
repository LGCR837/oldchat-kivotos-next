// src/cip/engine.js
// CIP Lua 运行时引擎：用 Fengari（纯 JS Lua 5.3 VM）在浏览器里执行 CIP 小程序。
// 依赖 window.fengari（vendor/fengari/fengari-web.js 已注入）。
// 不依赖 DOM；只产出 JS 节点树并管理 Lua 状态机与回调。
(function (window) {
  'use strict';

  var fengari = window.fengari;
  if (!fengari) throw new Error('[cip] fengari 未加载，请先引入 vendor/fengari/fengari-web.js');

  var lua = fengari.lua;
  var lauxlib = fengari.lauxlib;
  var lualib = fengari.lualib;
  var to_luastring = fengari.to_luastring;
  var to_jsstring = fengari.to_jsstring;

  var LUA_REGISTRYINDEX = lua.LUA_REGISTRYINDEX;
  var LUA_MASKCOUNT = lua.LUA_MASKCOUNT;
  var LUA_TNIL = lua.LUA_TNIL;
  var LUA_TNONE = lua.LUA_TNONE;
  var LUA_TBOOLEAN = lua.LUA_TBOOLEAN;
  var LUA_TNUMBER = lua.LUA_TNUMBER;
  var LUA_TSTRING = lua.LUA_TSTRING;
  var LUA_TTABLE = lua.LUA_TTABLE;
  var LUA_TFUNCTION = lua.LUA_TFUNCTION;
  var LUA_OK = lua.LUA_OK;

  // 所有 UI 控件的标量属性白名单（Lua 表 ↔ JS 节点树共用）
  var SCALAR_KEYS = ['text', 'id', 'url', 'title', 'placeholder', 'value',
    'height', 'width', 'margin', 'padding', 'size', 'color', 'center', 'checked',
    'spacing', 'orientation', 'background', 'gravity', 'min', 'max'];

  function luaToString(L, idx) {
    var t = lua.lua_type(L, idx);
    if (t === LUA_TSTRING) return to_jsstring(lua.lua_tolstring(L, idx));
    if (t === LUA_TNUMBER) return String(lua.lua_tonumber(L, idx));
    if (t === LUA_TBOOLEAN) return lua.lua_toboolean(L, idx) ? 'true' : 'false';
    return null;
  }

  // 读取标量属性为真正的 JS 类型：string/number/boolean；nil 返回 null
  function readScalar(L, idx, key) {
    lua.lua_getfield(L, idx, to_luastring(key));
    var v = null;
    var t = lua.lua_type(L, -1);
    if (t === LUA_TSTRING) v = to_jsstring(lua.lua_tolstring(L, -1));
    else if (t === LUA_TNUMBER) v = lua.lua_tonumber(L, -1);
    else if (t === LUA_TBOOLEAN) v = lua.lua_toboolean(L, -1);
    lua.lua_pop(L, 1);
    return v;
  }

  function CipEngine(appId, host, opts) {
    this.appId = appId;
    this.host = host || {};           // app.* 宿主实现（由 CipHost.makeHost 提供）
    this.opts = opts || {};
    this.maxInstructions = this.opts.maxInstructions || 8000000; // 指令预算（防死循环）
    this.L = null;
    this._hookCount = 0;
    this._pageRef = null;             // ui.page 写入的页面 registry ref
  }

  CipEngine.prototype.init = function () {
    var L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    this.L = L;
    this._sandbox();
    this._installUI();
    this._installApp();
    this._installHook();
    return this;
  };

  // 沙箱：剥离不安全的 os / 文件加载能力（保留 os.date/time/clock/difftime）
  CipEngine.prototype._sandbox = function () {
    var L = this.L;
    // os 库危险函数置空
    lua.lua_getglobal(L, to_luastring('os'));
    var osBad = ['execute', 'getenv', 'rename', 'remove', 'setlocale', 'tmpname', 'exit'];
    for (var i = 0; i < osBad.length; i++) {
      lua.lua_pushnil(L);
      lua.lua_setfield(L, -2, to_luastring(osBad[i]));
    }
    lua.lua_pop(L, 1);
    // _G 里的文件加载函数
    lua.lua_getglobal(L, to_luastring('_G'));
    var gBad = ['dofile', 'loadfile'];
    for (var j = 0; j < gBad.length; j++) {
      lua.lua_pushnil(L);
      lua.lua_setfield(L, -2, to_luastring(gBad[j]));
    }
    lua.lua_pop(L, 1);
  };

  // 指令预算 hook：每 count 条指令触发一次，超限即中断脚本
  CipEngine.prototype._installHook = function () {
    var L = this.L;
    var self = this;
    var hook = function (L2) {
      self._hookCount++;
      if (self._hookCount * 1000 > self.maxInstructions) {
        lauxlib.luaL_error(L2, to_luastring('CIP 脚本超出指令预算，已强制中止'));
      }
    };
    lua.lua_sethook(L, hook, LUA_MASKCOUNT, 1000);
  };

  // ---- ui.* 声明式 DSL ----
  CipEngine.prototype._installUI = function () {
    var L = this.L;
    var self = this;

    function makeNodeCtor(type) {
      return function (L2) {
        lua.lua_createtable(L2, 0, 8);              // node 在 -1
        lua.lua_pushstring(L2, to_luastring(type)); // value
        lua.lua_setfield(L2, -2, to_luastring('type'));

        if (lua.lua_gettop(L2) >= 1 && lua.lua_type(L2, 1) === LUA_TTABLE) {
          var propsIdx = 1;
          for (var k = 0; k < SCALAR_KEYS.length; k++) {
            lua.lua_getfield(L2, propsIdx, to_luastring(SCALAR_KEYS[k]));
            if (lua.lua_type(L2, -1) !== LUA_TNIL) {
              lua.lua_setfield(L2, -2, to_luastring(SCALAR_KEYS[k])); // 存入 node(-2)
            } else {
              lua.lua_pop(L2, 1);
            }
          }
          // on_click：捕获 Lua 函数为 registry ref
          lua.lua_getfield(L2, propsIdx, to_luastring('on_click'));
          if (lua.lua_type(L2, -1) === LUA_TFUNCTION) {
            var ref = lauxlib.luaL_ref(L2, LUA_REGISTRYINDEX); // 弹出函数，返回 ref
            lua.lua_pushinteger(L2, ref);
            lua.lua_setfield(L2, -2, to_luastring('on_click_ref'));
          } else {
            lua.lua_pop(L2, 1);
          }
          // children / items：直接把子表挂到 node 上
          lua.lua_getfield(L2, propsIdx, to_luastring('children'));
          if (lua.lua_type(L2, -1) === LUA_TTABLE) {
            lua.lua_setfield(L2, -2, to_luastring('children'));
          } else { lua.lua_pop(L2, 1); }
          lua.lua_getfield(L2, propsIdx, to_luastring('items'));
          if (lua.lua_type(L2, -1) === LUA_TTABLE) {
            lua.lua_setfield(L2, -2, to_luastring('items'));
          } else { lua.lua_pop(L2, 1); }
        }
        // 若是 page，登记到全局 _CIP_PAGE（即使脚本不 return 也能取到）
        if (type === 'page') {
          lua.lua_pushvalue(L2, -1);
          lua.lua_setglobal(L2, to_luastring('_CIP_PAGE'));
        }
        return 1; // node 表留在栈顶
      };
    }

    var uiFns = ['page', 'text', 'image', 'button', 'input', 'checkbox', 'list', 'spacer',
      'column', 'row', 'scroll', 'card', 'divider', 'progress'];
    lua.lua_createtable(L, 0, uiFns.length); // ui 表
    for (var n = 0; n < uiFns.length; n++) {
      lua.lua_pushcfunction(L, makeNodeCtor(uiFns[n]));
      lua.lua_setfield(L, -2, to_luastring(uiFns[n]));
    }
    lua.lua_setglobal(L, to_luastring('ui'));
  };

  // ---- app.* 宿主 API（回调式，带权限强制）----
  CipEngine.prototype._installApp = function () {
    var L = this.L;
    var self = this;
    var host = this.host;
    var perms = (this.opts && this.opts.permissions) || [];
    var allowedHosts = (this.opts && this.opts.allowedHosts) || [];

    function captureRef(L2, idx) {
      if (lua.lua_type(L2, idx) === LUA_TFUNCTION) {
        return lauxlib.luaL_ref(L2, LUA_REGISTRYINDEX);
      }
      return null;
    }
    function hasPerm(p) { return perms.indexOf(p) >= 0; }
    // 缺权限时：有回调则回调报错，否则 push nil；返回消耗的返回值数量
    function deny(cbRef, perm) {
      if (typeof cbRef === 'number') self.invokeRef(cbRef, null, '权限不足：需要 ' + perm + ' 权限');
      return 0;
    }
    function readStr(L2, key) {
      lua.lua_getfield(L2, 1, to_luastring(key));
      var s = (lua.lua_type(L2, -1) === LUA_TSTRING) ? to_jsstring(lua.lua_tolstring(L2, -1)) : null;
      lua.lua_pop(L2, 1);
      return s;
    }
    function readTbl(L2, key) {
      lua.lua_getfield(L2, 1, to_luastring(key));
      var t = (lua.lua_type(L2, -1) === LUA_TTABLE) ? self._luaTableToJs(L2, -1) : null;
      lua.lua_pop(L2, 1);
      return t;
    }

    var appFns = {
      toast: function (L2) {
        if (host.toast) host.toast(luaToString(L2, 1) || '');
        return 0;
      },
      storage_get: function (L2) {
        if (!hasPerm('storage')) { lua.lua_pushnil(L2); return 1; }
        var v = host.storage_get ? host.storage_get(luaToString(L2, 1)) : null;
        if (v == null) lua.lua_pushnil(L2);
        else lua.lua_pushstring(L2, to_luastring(String(v)));
        return 1;
      },
      storage_set: function (L2) {
        if (!hasPerm('storage')) return 0;
        if (host.storage_set) host.storage_set(luaToString(L2, 1), luaToString(L2, 2));
        return 0;
      },
      storage_remove: function (L2) {
        if (!hasPerm('storage')) return 0;
        if (host.storage_remove) host.storage_remove(luaToString(L2, 1));
        return 0;
      },
      storage_clear: function (L2) {
        if (!hasPerm('storage')) return 0;
        if (host.storage_clear) host.storage_clear();
        return 0;
      },
      storage_keys: function (L2) {
        if (!hasPerm('storage')) { lua.lua_pushnil(L2); return 1; }
        var keys = host.storage_keys ? host.storage_keys() : [];
        self.pushJsToLua(L2, keys);
        return 1;
      },
      storage_count: function (L2) {
        if (!hasPerm('storage')) { lua.lua_pushinteger(L2, 0); return 1; }
        var n = host.storage_count ? host.storage_count() : 0;
        lua.lua_pushinteger(L2, n);
        return 1;
      },
      storage_get_json: function (L2) {
        if (!hasPerm('storage')) { lua.lua_pushnil(L2); return 1; }
        var obj = host.storage_get_json ? host.storage_get_json(luaToString(L2, 1)) : null;
        self.pushJsToLua(L2, obj);
        return 1;
      },
      storage_set_json: function (L2) {
        if (!hasPerm('storage')) return 0;
        var val = (lua.lua_type(L2, 2) === LUA_TTABLE) ? self._luaTableToJs(L2, 2) : null;
        if (host.storage_set_json) host.storage_set_json(luaToString(L2, 1), val);
        return 0;
      },
      // app.json ≈ json_encode（保留向后兼容）
      json: function (L2) {
        var v;
        var t = lua.lua_type(L2, 1);
        if (t === LUA_TSTRING) v = luaToString(L2, 1);
        else if (t === LUA_TNUMBER) v = lua.lua_tonumber(L2, 1);
        else if (t === LUA_TBOOLEAN) v = lua.lua_toboolean(L2, 1);
        else if (t === LUA_TTABLE) v = self._luaTableToJs(L2, 1);
        else v = null;
        lua.lua_pushstring(L2, to_luastring(JSON.stringify(v)));
        return 1;
      },
      json_encode: function (L2) {
        var v;
        var t = lua.lua_type(L2, 1);
        if (t === LUA_TSTRING) v = luaToString(L2, 1);
        else if (t === LUA_TNUMBER) v = lua.lua_tonumber(L2, 1);
        else if (t === LUA_TBOOLEAN) v = lua.lua_toboolean(L2, 1);
        else if (t === LUA_TTABLE) v = self._luaTableToJs(L2, 1);
        else v = null;
        lua.lua_pushstring(L2, to_luastring(JSON.stringify(v)));
        return 1;
      },
      json_decode: function (L2) {
        var s = luaToString(L2, 1);
        if (s == null) { lua.lua_pushnil(L2); return 1; }
        try { self.pushJsToLua(L2, JSON.parse(s)); } catch (e) { lua.lua_pushnil(L2); }
        return 1;
      },
      url_encode: function (L2) {
        var s = luaToString(L2, 1) || '';
        lua.lua_pushstring(L2, to_luastring(encodeURIComponent(s)));
        return 1;
      },
      asset: function (L2) {
        var path = luaToString(L2, 1) || '';
        if (self.opts && self.opts.isRemote && !hasPerm('network')) { lua.lua_pushnil(L2); return 1; }
        var url = host.asset ? host.asset(path) : null;
        if (url == null) lua.lua_pushnil(L2);
        else lua.lua_pushstring(L2, to_luastring(String(url)));
        return 1;
      },
      delay: function (L2) {
        var ms = Math.floor(lua.lua_tonumber(L2, 1)) || 0;
        var ref = captureRef(L2, 2);
        if (host.delay) host.delay(ms, ref);
        return 0;
      },
      set_text: function (L2) {
        if (host.set_text) host.set_text(luaToString(L2, 1), luaToString(L2, 2));
        return 0;
      },
      set_image: function (L2) {
        if (host.set_image) host.set_image(luaToString(L2, 1), luaToString(L2, 2));
        return 0;
      },
      append_text: function (L2) {
        if (host.append_text) host.append_text(luaToString(L2, 1), luaToString(L2, 2));
        return 0;
      },
      set_hint: function (L2) {
        if (host.set_hint) host.set_hint(luaToString(L2, 1), luaToString(L2, 2));
        return 0;
      },
      focus: function (L2) {
        if (host.focus) host.focus(luaToString(L2, 1));
        return 0;
      },
      get_text: function (L2) {
        var s = host.get_text ? host.get_text(luaToString(L2, 1)) : null;
        if (s == null) lua.lua_pushnil(L2); else lua.lua_pushstring(L2, to_luastring(s));
        return 1;
      },
      get_checked: function (L2) {
        var b = host.get_checked ? host.get_checked(luaToString(L2, 1)) : false;
        lua.lua_pushboolean(L2, !!b);
        return 1;
      },
      set_checked: function (L2) {
        if (host.set_checked) host.set_checked(luaToString(L2, 1), !!lua.lua_toboolean(L2, 2));
        return 0;
      },
      set_visible: function (L2) {
        if (host.set_visible) host.set_visible(luaToString(L2, 1), !!lua.lua_toboolean(L2, 2));
        return 0;
      },
      get_visible: function (L2) {
        var b = host.get_visible ? host.get_visible(luaToString(L2, 1)) : true;
        lua.lua_pushboolean(L2, !!b);
        return 1;
      },
      set_enabled: function (L2) {
        if (host.set_enabled) host.set_enabled(luaToString(L2, 1), !!lua.lua_toboolean(L2, 2));
        return 0;
      },
      http_get: function (L2) {
        var cbRef = captureRef(L2, 2);
        if (!hasPerm('network')) return deny(cbRef, 'network');
        var path = luaToString(L2, 1);
        if (host.http_get) host.http_get(path, cbRef);
        return 0;
      },
      http_request: function (L2) {
        var url = readStr(L2, 'url');
        var cbRef = captureRef(L2, 2);
        if (!url) { if (typeof cbRef === 'number') self.invokeRef(cbRef, null, '缺少 url'); return 0; }
        var isExternal = /^https?:\/\//i.test(url);
        if (isExternal) {
          if (!hasPerm('network_external')) return deny(cbRef, 'network_external');
          // allowed_hosts 白名单（'*' 或空表示全部）
          if (allowedHosts.length && allowedHosts.indexOf('*') === -1) {
            try {
              var h = new URL(url).host;
              if (allowedHosts.indexOf(h) === -1) {
                if (typeof cbRef === 'number') self.invokeRef(cbRef, null, '目标主机不在 allowed_hosts 白名单: ' + h);
                return 0;
              }
            } catch (e) {
              if (typeof cbRef === 'number') self.invokeRef(cbRef, null, '非法 URL');
              return 0;
            }
          }
        } else {
          if (!hasPerm('network')) return deny(cbRef, 'network');
        }
        var method = (readStr(L2, 'method') || 'GET').toUpperCase();
        var headers = readTbl(L2, 'headers') || {};
        var body = readStr(L2, 'body') || '';
        var jsonBody = readTbl(L2, 'json');
        if (jsonBody && typeof jsonBody === 'object') {
          body = JSON.stringify(jsonBody);
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
        }
        var fn = window.__cipHttpRequest;
        var p = fn ? fn({ url: url, method: method, headers: headers, body: body })
                   : Promise.reject(new Error('请求能力不可用'));
        Promise.resolve(p).then(function (resp) {
          if (typeof cbRef === 'number') {
            var r = (resp && typeof resp === 'object') ? resp : { status: 0, headers: {}, body: String(resp || '') };
            self.invokeRef(cbRef, r, null);
          }
        }).catch(function (err) {
          if (typeof cbRef === 'number') self.invokeRef(cbRef, null, String((err && err.message) || err));
        });
        return 0;
      },
      camera: function (L2) {
        var cbRef = captureRef(L2, 1);
        if (!hasPerm('camera')) return deny(cbRef, 'camera');
        var inv = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
          (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (!inv) { if (typeof cbRef === 'number') self.invokeRef(cbRef, null, '桌面端不支持相机'); return 0; }
        Promise.resolve(inv('cip_pick_image', {})).then(function (uri) {
          if (typeof cbRef === 'number') self.invokeRef(cbRef, uri || null, uri ? null : '已取消选择');
        }).catch(function (err) {
          if (typeof cbRef === 'number') self.invokeRef(cbRef, null, String((err && err.message) || err));
        });
        return 0;
      },
      back: function (L2) {
        if (host.back) host.back();
        return 0;
      }
    };

    lua.lua_createtable(L, 0, Object.keys(appFns).length);
    Object.keys(appFns).forEach(function (name) {
      lua.lua_pushcfunction(L, appFns[name]);
      lua.lua_setfield(L, -2, to_luastring(name));
    });
    lua.lua_setglobal(L, to_luastring('app'));
  };

  // JS 值 → Lua 栈（供 app.* 返回 table/数组用）
  CipEngine.prototype.pushJsToLua = function (L, v) {
    if (v === null || v === undefined) { lua.lua_pushnil(L); return; }
    if (typeof v === 'string') { lua.lua_pushstring(L, to_luastring(v)); return; }
    if (typeof v === 'number') { lua.lua_pushnumber(L, v); return; }
    if (typeof v === 'boolean') { lua.lua_pushboolean(L, v); return; }
    if (Array.isArray(v)) {
      lua.lua_createtable(L, v.length, 0);
      for (var i = 0; i < v.length; i++) { this.pushJsToLua(L, v[i]); lua.lua_rawseti(L, -2, i + 1); }
      return;
    }
    if (typeof v === 'object') {
      lua.lua_createtable(L, 0, Object.keys(v).length);
      var self = this;
      Object.keys(v).forEach(function (k) { self.pushJsToLua(L, v[k]); lua.lua_setfield(L, -2, to_luastring(k)); });
      return;
    }
    lua.lua_pushnil(L);
  };

  // ---- 执行脚本，返回 JS 节点树 ----
  CipEngine.prototype.run = function (script) {
    var L = this.L;
    this._hookCount = 0;
    var status = lauxlib.luaL_dostring(L, to_luastring(script));
    if (status !== LUA_OK) {
      var err = luaToString(L, -1) || 'unknown error';
      lua.lua_pop(L, 1);
      lua.lua_settop(L, 0);
      throw new Error('[cip] Lua 执行错误: ' + err);
    }
    var page = null;
    // 优先取返回栈顶的 page 表
    if (lua.lua_gettop(L) > 0 && lua.lua_type(L, -1) === LUA_TTABLE) {
      page = this._luaTableToNode(L, -1);
    }
    lua.lua_settop(L, 0);
    // 兜底：_CIP_PAGE 全局
    if (!page) {
      lua.lua_getglobal(L, to_luastring('_CIP_PAGE'));
      if (lua.lua_type(L, -1) === LUA_TTABLE) page = this._luaTableToNode(L, -1);
      lua.lua_pop(L, 1);
      lua.lua_settop(L, 0);
    }
    return page;
  };

  // ---- Lua 节点表 → JS 节点树 ----
  CipEngine.prototype._luaTableToNode = function (L, idx) {
    if (idx < 0) idx = lua.lua_gettop(L) + idx + 1;
    lua.lua_getfield(L, idx, to_luastring('type'));
    var type = luaToString(L, -1);
    lua.lua_pop(L, 1);
    if (!type) return null;
    var node = { type: type };
    for (var k = 0; k < SCALAR_KEYS.length; k++) {
      var v = readScalar(L, idx, SCALAR_KEYS[k]);
      if (v !== null) node[SCALAR_KEYS[k]] = v;
    }
    // on_click_ref
    lua.lua_getfield(L, idx, to_luastring('on_click_ref'));
    if (lua.lua_type(L, -1) === LUA_TNUMBER) node.on_click = Math.floor(lua.lua_tonumber(L, -1));
    lua.lua_pop(L, 1);
    // children
    lua.lua_getfield(L, idx, to_luastring('children'));
    if (lua.lua_type(L, -1) === LUA_TTABLE) node.children = this._readArray(L, lua.lua_gettop(L));
    lua.lua_pop(L, 1);
    // items
    lua.lua_getfield(L, idx, to_luastring('items'));
    if (lua.lua_type(L, -1) === LUA_TTABLE) node.items = this._readStrings(L, lua.lua_gettop(L));
    lua.lua_pop(L, 1);
    return node;
  };

  // 注意：lua_next 不保证数组顺序，必须按整数索引 1..n 顺序读取
  CipEngine.prototype._readArray = function (L, idx) {
    var arr = [];
    var len = lua.lua_rawlen(L, idx);
    for (var i = 1; i <= len; i++) {
      lua.lua_rawgeti(L, idx, i);
      var child = this._luaTableToNode(L, -1);
      if (child) arr.push(child);
      lua.lua_pop(L, 1);
    }
    return arr;
  };

  CipEngine.prototype._readStrings = function (L, idx) {
    var arr = [];
    var len = lua.lua_rawlen(L, idx);
    for (var i = 1; i <= len; i++) {
      lua.lua_rawgeti(L, idx, i);
      var s = luaToString(L, -1);
      if (s != null) arr.push(s);
      lua.lua_pop(L, 1);
    }
    return arr;
  };

  // Lua table → 普通 JS 值（给 app.json 用）
  CipEngine.prototype._luaTableToJs = function (L, idx) {
    if (idx < 0) idx = lua.lua_gettop(L) + idx + 1;
    var t = lua.lua_type(L, idx);
    if (t === LUA_TSTRING) return luaToString(L, idx);
    if (t === LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (t === LUA_TBOOLEAN) return lua.lua_toboolean(L, idx);
    if (t !== LUA_TTABLE) return null;
    var len = lua.lua_rawlen(L, idx);
    var obj = {};
    var isArr = true;
    lua.lua_pushnil(L);
    while (lua.lua_next(L, idx) !== 0) {
      var key = luaToString(L, -2);
      var val = this._luaTableToJs(L, -1);
      if (/^\d+$/.test(key)) {
        obj[parseInt(key, 10) - 1] = val; // 数组部分先按 key 存
      } else {
        obj[key] = val;
        isArr = false;
      }
      lua.lua_pop(L, 1);
    }
    if (isArr && len > 0) {
      var a = [];
      for (var i = 0; i < len; i++) a.push(obj[i] !== undefined ? obj[i] : null);
      return a;
    }
    return obj;
  };

  // ---- 回调 Lua 函数（ref 来自 on_click / http_get 等）----
  CipEngine.prototype.invokeRef = function (ref) {
    if (typeof ref !== 'number') return;
    // destroy() 之后仍可能有 setTimeout / http 回调打进来，直接丢弃，别碰已废弃的 state
    if (this._dead) return;
    var L = this.L;
    var args = Array.prototype.slice.call(arguments, 1);
    lua.lua_rawgeti(L, LUA_REGISTRYINDEX, ref); // 推函数
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a == null) lua.lua_pushnil(L);
      else if (typeof a === 'number') lua.lua_pushnumber(L, a);
      else if (typeof a === 'boolean') lua.lua_pushboolean(L, a);
      else if (typeof a === 'string') lua.lua_pushstring(L, to_luastring(a));
      else if (typeof a === 'object') this.pushJsToLua(L, a);
      else lua.lua_pushstring(L, to_luastring(String(a)));
    }
    var status = lua.lua_pcall(L, args.length, 0, 0);
    if (status !== LUA_OK) {
      var err = luaToString(L, -1) || 'callback error';
      lua.lua_pop(L, 1);
      console.error('[cip] 回调执行错误:', err);
    }
    lua.lua_settop(L, 0);
  };

  CipEngine.prototype.destroy = function () {
    if (this._dead) return;
    this._dead = true; // 让残留的定时器 / http 回调空转
    try { lua.lua_settop(this.L, 0); } catch (e) {}
    try { if (typeof lua.lua_close === 'function') lua.lua_close(this.L); } catch (e) {}
    this.L = null;
  };

  window.CipEngine = CipEngine;
})(window);
