// src/cip/render.js
// 把 engine 取出的 CIP 节点树渲染为 DOM，套用现有主题变量。
// 节点树格式（由 engine 从 Lua ui.* 返回表转换而来）：
//   { type:'page', title?, children:[node,...] }
//   { type:'text', text, size?, color?, center?, margin?, id? }
//   { type:'image', id?, url, height?, margin? }
//   { type:'button', id?, text, on_click?:<refNumber>, margin? }
//   { type:'input', id?, placeholder?, value?, margin? }
//   { type:'checkbox', id?, text, checked?, margin? }
//   { type:'list', id?, items:[...], margin? }
//   { type:'spacer', height? }
// on_click 为 engine 分配的 Lua 函数 registry ref（数字），点击时经 ctx.invokeRef(ref) 回调用。
(function (window) {
  'use strict';

  var idRegistry = {}; // key = appId + ':' + id -> DOM element

  function toPx(v) {
    if (typeof v === 'number') return v + 'px';
    if (typeof v === 'string') return v;
    return '';
  }

  function applyCommon(el, node, ctx) {
    if (node.margin != null) el.style.margin = toPx(node.margin);
    if (node.id) {
      el.dataset.cipId = node.id;
      idRegistry[ctx.appId + ':' + node.id] = el;
    }
  }

  function renderNode(node, ctx) {
    if (!node || typeof node !== 'object') return null;
    switch (node.type) {
      case 'text': {
        var el = document.createElement('div');
        el.className = 'cip-text';
        el.textContent = node.text != null ? String(node.text) : '';
        if (node.size) el.style.fontSize = toPx(node.size);
        if (node.color) el.style.color = node.color;
        if (node.center) el.style.textAlign = 'center';
        applyCommon(el, node, ctx);
        return el;
      }
      case 'image': {
        var el = document.createElement('img');
        el.className = 'cip-image';
        el.src = node.url || '';
        el.alt = '';
        el.loading = 'lazy';
        if (node.height) el.style.height = toPx(node.height);
        el.style.objectFit = 'contain';
        applyCommon(el, node, ctx);
        return el;
      }
      case 'button': {
        var el = document.createElement('button');
        el.className = 'cip-button';
        el.type = 'button';
        el.textContent = node.text != null ? String(node.text) : '按钮';
        applyCommon(el, node, ctx);
        var ref = node.on_click;
        if (typeof ref === 'number') {
          el.addEventListener('click', function () {
            try { ctx.invokeRef(ref); }
            catch (e) { console.error('[cip] button on_click error', e); }
          });
        }
        return el;
      }
      case 'input': {
        var el = document.createElement('input');
        el.className = 'cip-input';
        el.type = 'text';
        if (node.placeholder) el.placeholder = node.placeholder;
        if (node.value != null) el.value = node.value;
        applyCommon(el, node, ctx);
        return el;
      }
      case 'checkbox': {
        var wrap = document.createElement('label');
        wrap.className = 'cip-checkbox';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        if (node.checked) cb.checked = true;
        var span = document.createElement('span');
        span.textContent = node.text != null ? String(node.text) : '';
        wrap.appendChild(cb);
        wrap.appendChild(span);
        applyCommon(wrap, node, ctx);
        return wrap;
      }
      case 'list': {
        var el = document.createElement('div');
        el.className = 'cip-list';
        var items = node.items || [];
        items.forEach(function (it) {
          var row = document.createElement('div');
          row.className = 'cip-list-item';
          row.textContent = it != null ? String(it) : '';
          el.appendChild(row);
        });
        applyCommon(el, node, ctx);
        return el;
      }
      case 'spacer': {
        var el = document.createElement('div');
        el.className = 'cip-spacer';
        el.style.height = toPx(node.height || 8);
        return el;
      }
      default:
        console.warn('[cip] unknown node type', node && node.type);
        return null;
    }
  }

  function renderTree(root, ctx) {
    var container = document.createElement('div');
    container.className = 'cip-page';
    if (root && root.type === 'page') {
      if (root.title) {
        var title = document.createElement('div');
        title.className = 'cip-page-title';
        title.textContent = root.title;
        container.appendChild(title);
      }
      var children = root.children || [];
      for (var i = 0; i < children.length; i++) {
        var el = renderNode(children[i], ctx);
        if (el) container.appendChild(el);
      }
    } else if (root) {
      var single = renderNode(root, ctx);
      if (single) container.appendChild(single);
    }
    return container;
  }

  function clearRegistry(appId) {
    // 清空某 app 的 id 注册（重新运行时避免脏数据）
    Object.keys(idRegistry).forEach(function (k) {
      if (k.indexOf(appId + ':') === 0) delete idRegistry[k];
    });
  }

  function setText(appId, id, text) {
    var el = idRegistry[appId + ':' + id];
    if (el) { el.textContent = String(text); return true; }
    return false;
  }

  function setImage(appId, id, uri) {
    var el = idRegistry[appId + ':' + id];
    if (el && el.tagName === 'IMG') { el.src = uri; return true; }
    return false;
  }

  window.CipRender = {
    renderTree: renderTree,
    setText: setText,
    setImage: setImage,
    clearRegistry: clearRegistry
  };
})(window);
