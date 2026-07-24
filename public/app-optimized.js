/**
 * OldChat Web - Optimized Application
 * Features:
 * - URL Hash Router (shareable links)
 * - Modular architecture
 * - Virtual scrolling for large lists
 * - Optimized message rendering
 * - Request retry with exponential backoff
 * - Message search and caching
 * - Connection health monitoring
 */
(function () {
  'use strict';

  // ==================== Configuration ====================
  const CONFIG = {
    API_BASE: 'http://oldchat.teaf.cc:8080/v1',
    WS_RETRY_DELAY: [1000, 2000, 5000, 10000, 30000], // Exponential backoff
    MAX_RETRY_ATTEMPTS: 5,
    POLLING_INTERVAL_CONNECTED: 45000,
    POLLING_INTERVAL_DISCONNECTED: 15000,
    MESSAGE_CACHE_SIZE: 100,
    VIRTUAL_SCROLL_ITEM_HEIGHT: 64,
    LIST_PAGE_SIZE: 20,
    DEBOUNCE_DELAY: 120,
    TOAST_DURATION: 2200,
  };

  const LS_KEYS = {
    ACCESS_TOKEN: 'oldchat_access_token',
    REFRESH_TOKEN: 'oldchat_refresh_token',
    USER: 'oldchat_user',
    DEVICE_ID: 'oldchat_device_id',
    MESSAGE_CACHE: 'oldchat_msg_cache',
    THEME: 'oldchat_theme',
  };

  // ==================== Event Bus ====================
  class EventBus {
    constructor() {
      this.events = {};
    }
    on(event, callback) {
      if (!this.events[event]) this.events[event] = [];
      this.events[event].push(callback);
      return () => this.off(event, callback);
    }
    off(event, callback) {
      if (!this.events[event]) return;
      this.events[event] = this.events[event].filter(cb => cb !== callback);
    }
    emit(event, data) {
      if (!this.events[event]) return;
      this.events[event].forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error('Event handler error:', err);
        }
      });
    }
  }

  const events = new EventBus();

  // ==================== Router ====================
  class Router {
    constructor() {
      this.routes = {};
      this.currentRoute = null;
      this.beforeEach = null;
      window.addEventListener('hashchange', () => this.navigate());
    }
    register(path, handler) {
      this.routes[path] = handler;
      return this;
    }
    before(handler) {
      this.beforeEach = handler;
      return this;
    }
    navigate(path) {
      if (path) {
        window.location.hash = path;
        return;
      }
      const hash = window.location.hash.slice(1) || '/';
      const [route, query] = hash.split('?');
      const params = this.parseQuery(query);
      
      if (this.beforeEach) {
        const result = this.beforeEach(route, params);
        if (result === false) return;
      }
      
      const handler = this.routes[route] || this.routes['*'];
      if (handler) {
        this.currentRoute = { path: route, params };
        handler(params);
      }
    }
    parseQuery(query) {
      if (!query) return {};
      return query.split('&').reduce((acc, pair) => {
        const [key, value] = pair.split('=');
        acc[decodeURIComponent(key)] = decodeURIComponent(value || '');
        return acc;
      }, {});
    }
    buildPath(route, params = {}) {
      const query = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      return query ? `${route}?${query}` : route;
    }
  }

  const router = new Router();

  // ==================== State Manager ====================
  class Store {
    constructor(initialState = {}) {
      this.state = initialState;
      this.listeners = new Set();
    }
    get(key) {
      return key ? this.state[key] : this.state;
    }
    set(key, value) {
      const oldValue = this.state[key];
      this.state[key] = value;
      this.notify(key, value, oldValue);
    }
    update(updates) {
      Object.assign(this.state, updates);
      this.notify('update', updates);
    }
    subscribe(callback) {
      this.listeners.add(callback);
      return () => this.listeners.delete(callback);
    }
    notify(key, value, oldValue) {
      this.listeners.forEach(cb => {
        try {
          cb(key, value, oldValue);
        } catch (err) {
          console.error('Store listener error:', err);
        }
      });
    }
  }

  const store = new Store({
    accessToken: '',
    refreshToken: '',
    user: null,
    friends: [],
    groups: [],
    friendMap: {},
    groupMap: {},
    view: 'chats',
    active: null,
    messages: [],
    unread: { direct: {}, group: {} },
    ws: null,
    wsConnected: false,
    wsRetryCount: 0,
    sessionId: '',
    encKey: null,
    macKey: null,
    refreshInFlight: false,
    pollTimer: null,
    messageCache: new Map(), // LRU cache for messages
    theme: localStorage.getItem(LS_KEYS.THEME) || 'light',
  });

  // ==================== API Client ====================
  class APIClient {
    constructor() {
      this.requestQueue = [];
      this.processingQueue = false;
    }
    
    async request(path, options = {}) {
      const opts = { ...options };
      const headers = { ...opts.headers };
      const needsAuth = opts.auth !== false;
      
      if (needsAuth && store.get('accessToken')) {
        headers.Authorization = `Bearer ${store.get('accessToken')}`;
      }
      if (opts.body && !(opts.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
      }
      
      const fetchOptions = {
        method: opts.method || 'GET',
        headers,
        body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
      };
      
      let lastError;
      for (let attempt = 0; attempt <= (opts.retry || 0); attempt++) {
        try {
          const response = await fetch(CONFIG.API_BASE + path, fetchOptions);
          
          if (response.status === 401 && needsAuth && store.get('refreshToken')) {
            const refreshed = await this.refreshToken();
            if (refreshed) {
              headers.Authorization = `Bearer ${store.get('accessToken')}`;
              fetchOptions.headers = headers;
              continue;
            }
            throw { status: 401, message: 'Token expired' };
          }
          
          const text = await response.text();
          const data = text ? (() => {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          })() : null;
          
          if (!response.ok) {
            throw { status: response.status, data, message: data?.message || 'Request failed' };
          }
          
          return { ok: true, data };
        } catch (err) {
          lastError = err;
          if (attempt < opts.retry) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            await this.sleep(delay);
          }
        }
      }
      throw lastError;
    }
    
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async refreshToken() {
      if (store.get('refreshInFlight')) return false;
      store.set('refreshInFlight', true);
      
      try {
        const resp = await this.request('/v1/auth/refresh', {
          method: 'POST',
          body: { refresh_token: store.get('refreshToken') },
          auth: false,
          retry: 2,
        });
        
        if (resp?.data?.access_token) {
          store.update({
            accessToken: resp.data.access_token,
            refreshToken: resp.data.refresh_token || store.get('refreshToken'),
          });
          saveAuth();
          return true;
        }
        return false;
      } catch (err) {
        console.error('Token refresh failed:', err);
        return false;
      } finally {
        store.set('refreshInFlight', false);
      }
    }
  }

  const api = new APIClient();

  // ==================== Crypto Helper ====================
  const Crypto = {
    async sha256(data) {
      const hash = await crypto.subtle.digest('SHA-256', data);
      return new Uint8Array(hash);
    },
    
    async hmacSha256(keyBytes, data) {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, data);
      return new Uint8Array(sig);
    },
    
    base64ToBytes(str) {
      const binary = atob(str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    },
    
    bytesToBase64(bytes) {
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    },
    
    concatBytes(a, b) {
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    },
    
    timingSafeEqual(a, b) {
      if (a.length !== b.length) return false;
      let result = 0;
      for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
      }
      return result === 0;
    },
    
    pkcs7Unpad(data) {
      if (!data.length) return data;
      const pad = data[data.length - 1];
      if (pad <= 0 || pad > 16) return data;
      return data.slice(0, data.length - pad);
    },
  };

  // ==================== WebSocket Manager ====================
  class WSManager {
    constructor() {
      this.ws = null;
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      this.messageQueue = [];
    }
    
    async connect() {
      if (!store.get('accessToken')) return;
      if (this.ws?.readyState === WebSocket.CONNECTING) return;
      
      try {
        await this.ensureSession();
      } catch (err) {
        console.warn('Encryption handshake failed:', err);
        setStatus(false);
        return;
      }
      
      const wsUrl = `ws://oldchat.teaf.cc:8080/ws?token=${encodeURIComponent(store.get('accessToken'))}&sid=${encodeURIComponent(store.get('sessionId'))}`;
      
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => this.onOpen();
      this.ws.onclose = () => this.onClose();
      this.ws.onerror = (err) => this.onError(err);
      this.ws.onmessage = (event) => this.onMessage(event.data);
    }
    
    onOpen() {
      setStatus(true);
      store.set('wsRetryCount', 0);
      this.startHeartbeat();
      this.flushMessageQueue();
      events.emit('ws:connected');
    }
    
    onClose() {
      setStatus(false);
      this.stopHeartbeat();
      this.scheduleReconnect();
      events.emit('ws:disconnected');
    }
    
    onError(err) {
      console.error('WebSocket error:', err);
      setStatus(false);
      events.emit('ws:error', err);
    }
    
    async onMessage(data) {
      try {
        const payload = await this.decodePayload(data);
        if (!payload) return;
        handleWsEvent(payload);
      } catch (err) {
        console.error('Message decode error:', err);
      }
    }
    
    disconnect() {
      this.stopHeartbeat();
      clearTimeout(this.reconnectTimer);
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }
    
    scheduleReconnect() {
      const retryCount = store.get('wsRetryCount') || 0;
      if (retryCount >= CONFIG.MAX_RETRY_ATTEMPTS) {
        console.warn('Max retry attempts reached, switching to polling mode');
        return;
      }
      
      const delay = CONFIG.WS_RETRY_DELAY[Math.min(retryCount, CONFIG.WS_RETRY_DELAY.length - 1)];
      store.set('wsRetryCount', retryCount + 1);
      
      this.reconnectTimer = setTimeout(() => {
        console.log(`Reconnecting... (attempt ${retryCount + 1})`);
        this.connect();
      }, delay);
    }
    
    startHeartbeat() {
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    }
    
    stopHeartbeat() {
      clearInterval(this.heartbeatTimer);
    }
    
    flushMessageQueue() {
      while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const msg = this.messageQueue.shift();
        this.ws.send(msg);
      }
    }
    
    async ensureSession() {
      if (!crypto?.subtle) throw new Error('Crypto not supported');
      if (store.get('sessionId') && store.get('encKey') && store.get('macKey')) return;
      
      const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
      const clientPub = Crypto.bytesToBase64(new Uint8Array(spki));
      
      const resp = await api.request('/v1/auth/handshake', {
        method: 'POST',
        body: { client_pub: clientPub },
        auth: false,
      });
      
      const serverPubBytes = Crypto.base64ToBytes(resp.data.server_pub);
      const serverPub = await crypto.subtle.importKey('spki', serverPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, keys.privateKey, 256);
      const secretBytes = new Uint8Array(secret);
      
      store.update({
        sessionId: resp.data.session_id,
        encKey: await Crypto.sha256(Crypto.concatBytes(secretBytes, new TextEncoder().encode('enc'))),
        macKey: await Crypto.sha256(Crypto.concatBytes(secretBytes, new TextEncoder().encode('mac'))),
      });
    }
    
    async decryptEnvelope(payload) {
      const encKey = store.get('encKey');
      const macKey = store.get('macKey');
      if (!encKey || !macKey) return null;
      
      let env;
      try {
        env = JSON.parse(payload);
      } catch {
        return null;
      }
      if (!env.iv || !env.data || !env.mac) return null;
      
      const iv = Crypto.base64ToBytes(env.iv);
      const ciphertext = Crypto.base64ToBytes(env.data);
      const mac = Crypto.base64ToBytes(env.mac);
      
      const expected = await Crypto.hmacSha256(macKey, Crypto.concatBytes(iv, ciphertext));
      if (!Crypto.timingSafeEqual(mac, expected)) return null;
      
      const key = await crypto.subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['decrypt']);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
      const plainBytes = Crypto.pkcs7Unpad(new Uint8Array(plainBuf));
      return new TextDecoder().decode(plainBytes);
    }
    
    async decodePayload(data) {
      if (typeof data !== 'string') return null;
      try {
        const raw = JSON.parse(data);
        if (raw?.type) return raw;
      } catch {
        // continue
      }
      const decrypted = await this.decryptEnvelope(data);
      if (!decrypted) return null;
      try {
        return JSON.parse(decrypted);
      } catch {
        return null;
      }
    }
  }

  const wsManager = new WSManager();

  // ==================== Virtual Scroller ====================
  class VirtualScroller {
    constructor(container, options = {}) {
      this.container = container;
      this.itemHeight = options.itemHeight || 64;
      this.bufferSize = options.bufferSize || 5;
      this.items = [];
      this.visibleRange = { start: 0, end: 0 };
      this.scrollHandler = this.onScroll.bind(this);
      this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
    }
    
    setItems(items) {
      this.items = items;
      this.render();
    }
    
    onScroll() {
      requestAnimationFrame(() => this.render());
    }
    
    render() {
      const scrollTop = this.container.scrollTop;
      const containerHeight = this.container.clientHeight;
      
      const startIdx = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.bufferSize);
      const endIdx = Math.min(this.items.length, Math.ceil((scrollTop + containerHeight) / this.itemHeight) + this.bufferSize);
      
      if (startIdx === this.visibleRange.start && endIdx === this.visibleRange.end) return;
      
      this.visibleRange = { start: startIdx, end: endIdx };
      
      const totalHeight = this.items.length * this.itemHeight;
      const contentHeight = (endIdx - startIdx) * this.itemHeight;
      const offsetTop = startIdx * this.itemHeight;
      
      let html = `<div style="height:${totalHeight}px;position:relative;">`;
      html += `<div style="position:absolute;top:${offsetTop}px;height:${contentHeight}px;width:100%;">`;
      
      for (let i = startIdx; i < endIdx && i < this.items.length; i++) {
        html += this.items[i].html;
      }
      
      html += '</div></div>';
      this.container.innerHTML = html;
      
      // Re-attach event listeners to new elements
      const rows = this.container.querySelectorAll('[data-id]');
      rows.forEach(row => {
        row.addEventListener('click', () => {
          const id = row.dataset.id;
          const type = row.dataset.type;
          const item = this.items.find(it => it.id === id && it.type === type);
          if (item?.onClick) item.onClick(item.data);
        });
      });
    }
    
    destroy() {
      this.container.removeEventListener('scroll', this.scrollHandler);
    }
  }

  // ==================== Message Cache ====================
  class MessageCache {
    constructor(maxSize = 100) {
      this.maxSize = maxSize;
      this.cache = new Map();
    }
    
    get(key) {
      const value = this.cache.get(key);
      if (value) {
        // Move to end (LRU)
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      return value;
    }
    
    set(key, value) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      } else if (this.cache.size >= this.maxSize) {
        // Remove oldest
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }
    
    clear() {
      this.cache.clear();
    }
  }

  const msgCache = new MessageCache(CONFIG.MESSAGE_CACHE_SIZE);

  // ==================== UI Helpers ====================
  const UI = {
    debounce(fn, delay) {
      let timer = null;
      return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },
    
    throttle(fn, limit) {
      let inThrottle;
      return function (...args) {
        if (!inThrottle) {
          fn.apply(this, args);
          inThrottle = true;
          setTimeout(() => inThrottle = false, limit);
        }
      };
    },
    
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },
    
    formatTime(ts) {
      if (!ts) return '';
      const millis = ts < 1e12 ? ts * 1000 : ts;
      const date = new Date(millis);
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      
      if (isToday) return time;
      return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
    },
    
    formatSize(bytes) {
      if (bytes <= 0) return '0B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${(bytes / Math.pow(1024, i)).toFixed(1)}${units[i]}`;
    },
    
    highlightText(text, query) {
      if (!query) return this.escapeHtml(text);
      const escaped = this.escapeHtml(text);
      const regex = new RegExp(`(${this.escapeHtml(query)})`, 'gi');
      return escaped.replace(regex, '<mark>$1</mark>');
    },
  };

  // ==================== Toast Manager ====================
  const Toast = {
    el: document.getElementById('toast'),
    queue: [],
    showing: false,
    
    show(message, duration = CONFIG.TOAST_DURATION) {
      if (this.showing) {
        this.queue.push({ message, duration });
        return;
      }
      
      this.showing = true;
      this.el.textContent = message;
      this.el.classList.add('show');
      
      setTimeout(() => {
        this.el.classList.remove('show');
        setTimeout(() => {
          this.showing = false;
          if (this.queue.length > 0) {
            const next = this.queue.shift();
            this.show(next.message, next.duration);
          }
        }, 300);
      }, duration);
    },
    
    success(message) {
      this.show(`✓ ${message}`);
    },
    
    error(message) {
      this.show(`✗ ${message}`);
    },
  };

  // ==================== DOM Elements ====================
  const els = {
    app: document.getElementById('app'),
    statusPill: document.getElementById('statusPill'),
    userPill: document.getElementById('userPill'),
    btnLogout: document.getElementById('btnLogout'),
    searchInput: document.getElementById('searchInput'),
    listView: document.getElementById('listView'),
    conversationTitle: document.getElementById('conversationTitle'),
    conversationMeta: document.getElementById('conversationMeta'),
    messageList: document.getElementById('messageList'),
    messageInput: document.getElementById('messageInput'),
    composer: document.getElementById('composer'),
    emptyState: document.getElementById('emptyState'),
    loginView: document.getElementById('loginView'),
    loginForm: document.getElementById('loginForm'),
    loginIdentifier: document.getElementById('loginIdentifier'),
    loginPassword: document.getElementById('loginPassword'),
    btnBackList: document.getElementById('btnBackList'),
    toast: document.getElementById('toast'),
    tabs: document.querySelectorAll('.tab'),
  };

  // ==================== State Functions ====================
  function setStatus(online) {
    store.set('wsConnected', online);
    els.statusPill.textContent = online ? '在线' : '离线';
    els.statusPill.classList.toggle('online', online);
    startPolling();
  }

  function showLogin(show) {
    els.loginView.classList.toggle('show', show);
    if (show) {
      els.loginIdentifier.focus();
    }
  }

  function setUser(user) {
    store.set('user', user);
    const name = user?.display_name || user?.username || user?.uid || '已登录';
    els.userPill.textContent = name;
  }

  function setView(view) {
    store.set('view', view);
    els.app.dataset.view = view;
    els.tabs.forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    renderList();
  }

  function setPanel(panel) {
    els.app.dataset.panel = panel;
  }

  function saveAuth() {
    localStorage.setItem(LS_KEYS.ACCESS_TOKEN, store.get('accessToken') || '');
    localStorage.setItem(LS_KEYS.REFRESH_TOKEN, store.get('refreshToken') || '');
    localStorage.setItem(LS_KEYS.USER, store.get('user') ? JSON.stringify(store.get('user')) : '');
  }

  function loadAuth() {
    store.update({
      accessToken: localStorage.getItem(LS_KEYS.ACCESS_TOKEN) || '',
      refreshToken: localStorage.getItem(LS_KEYS.REFRESH_TOKEN) || '',
    });
    
    const rawUser = localStorage.getItem(LS_KEYS.USER);
    if (rawUser) {
      try {
        store.set('user', JSON.parse(rawUser));
      } catch {
        store.set('user', null);
      }
    }
  }

  // ==================== Data Loading ====================
  async function loadFriends() {
    try {
      const resp = await api.request('/v1/friends', { retry: 1 });
      const friends = (resp.data.friends || [])
        .map(f => ({
          uid: f.uid || f.id,
          name: f.display_name || f.username || f.uid || f.id,
          avatar: f.avatar_url || '',
          status: f.status || 'offline',
        }))
        .filter(f => f.uid);
      
      const friendMap = {};
      friends.forEach(f => friendMap[f.uid] = f);
      
      store.update({ friends, friendMap });
    } catch (err) {
      Toast.error('好友列表加载失败');
    }
  }

  async function loadGroups() {
    try {
      const resp = await api.request('/v1/groups/list', { retry: 1 });
      const groups = (resp.data.groups || [])
        .map(g => ({
          id: g.group_id || g.id,
          name: g.name || g.group_id,
          avatar: g.avatar_url || '',
          memberCount: g.member_count || 0,
        }))
        .filter(g => g.id);
      
      const groupMap = {};
      groups.forEach(g => groupMap[g.id] = g);
      
      store.update({ groups, groupMap });
    } catch (err) {
      Toast.error('群组列表加载失败');
    }
  }

  // ==================== Rendering ====================
  let listScroller = null;
  let renderListScheduled = false;

  function renderList() {
    if (!listScroller) {
      listScroller = new VirtualScroller(els.listView, {
        itemHeight: CONFIG.VIRTUAL_SCROLL_ITEM_HEIGHT,
        bufferSize: 3,
      });
    }
    
    const filter = (els.searchInput.value || '').trim().toLowerCase();
    const view = store.get('view');
    const active = store.get('active');
    const unread = store.get('unread');
    
    let items = [];
    if (view === 'groups') {
      items = store.get('groups').map(g => ({
        id: g.id,
        type: 'group',
        title: g.name,
        subtitle: `群号 ${g.id} · ${g.memberCount}人`,
        unread: unread.group[g.id] || 0,
        data: g,
      }));
    } else {
      items = store.get('friends').map(f => ({
        id: f.uid,
        type: 'direct',
        title: f.name,
        subtitle: f.status === 'online' ? '在线' : f.uid,
        unread: unread.direct[f.uid] || 0,
        data: f,
      }));
    }
    
    if (filter) {
      items = items.filter(i => 
        i.title.toLowerCase().includes(filter) || 
        i.subtitle.toLowerCase().includes(filter)
      );
    }
    
    // Sort by unread count (desc), then by name
    items.sort((a, b) => {
      if (b.unread !== a.unread) return b.unread - a.unread;
      return a.title.localeCompare(b.title);
    });
    
    const htmlItems = items.map(item => {
      const isActive = active?.type === item.type && active?.id === item.id;
      const badgeHtml = item.unread ? `<span class="badge">${item.unread > 99 ? '99+' : item.unread}</span>` : '';
      
      return {
        id: item.id,
        type: item.type,
        data: item,
        html: `
          <div class="list-item ${isActive ? 'active' : ''}" data-id="${item.id}" data-type="${item.type}">
            <div>
              <div class="item-title">${UI.highlightText(item.title, filter)}</div>
              <div class="item-subtitle">${UI.escapeHtml(item.subtitle)}</div>
            </div>
            ${badgeHtml}
          </div>
        `,
        onClick: () => openConversation(item.type, item.id),
      };
    });
    
    listScroller.setItems(htmlItems);
  }

  function scheduleRenderList() {
    if (renderListScheduled) return;
    renderListScheduled = true;
    requestAnimationFrame(() => {
      renderListScheduled = false;
      renderList();
    });
  }

  function renderConversationHeader() {
    const active = store.get('active');
    if (!active) {
      els.conversationTitle.textContent = '旧聊 Web';
      els.conversationMeta.textContent = '选择一个会话开始聊天';
      els.emptyState.style.display = 'block';
      els.composer.style.display = 'none';
      return;
    }
    
    const info = active.type === 'group' 
      ? store.get('groupMap')[active.id]
      : store.get('friendMap')[active.id];
    
    els.conversationTitle.textContent = info?.name || active.id;
    els.conversationMeta.textContent = active.type === 'group' 
      ? `群号 ${active.id}` 
      : (info?.status === 'online' ? '在线' : active.id);
    els.emptyState.style.display = 'none';
    els.composer.style.display = 'flex';
  }

  function renderMessages() {
    const messages = store.get('messages');
    const user = store.get('user');
    
    els.messageList.innerHTML = '';
    if (!messages.length) return;
    
    const fragment = document.createDocumentFragment();
    let lastDate = null;
    
    messages.forEach((msg, index) => {
      // Add date separator
      const msgDate = new Date((msg.created_at || msg.createdAt || 0) * 1000).toDateString();
      if (msgDate !== lastDate) {
        const separator = document.createElement('div');
        separator.className = 'date-separator';
        separator.textContent = UI.formatTime(msg.created_at || msg.createdAt);
        fragment.appendChild(separator);
        lastDate = msgDate;
      }
      
      const prevMsg = messages[index - 1];
      const showAvatar = !prevMsg || prevMsg.from_uid !== msg.from_uid;
      
      fragment.appendChild(createMessageNode(msg, user, showAvatar));
    });
    
    els.messageList.appendChild(fragment);
    scrollToBottom();
  }

  function createMessageNode(msg, user, showAvatar = true) {
    const isMe = msg.from_uid === user?.uid;
    const node = document.createElement('div');
    node.className = `message ${isMe ? 'me' : ''}`;
    
    if (!isMe && showAvatar) {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = (msg.from_uid || '?')[0].toUpperCase();
      node.appendChild(avatar);
    }
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    
    // Support different message types
    if (msg.msg_type === 'image' && msg.media_url) {
      const img = document.createElement('img');
      img.src = msg.media_url;
      img.className = 'message-image';
      img.onclick = () => window.open(msg.media_url, '_blank');
      bubble.appendChild(img);
    } else if (msg.msg_type === 'resource' && msg.media_url) {
      const fileLink = document.createElement('a');
      fileLink.href = msg.media_url;
      fileLink.target = '_blank';
      fileLink.rel = 'noopener';
      fileLink.className = 'message-file';
      const nameMatch = (msg.body || '').match(/^(?:资源|文件)\s*[:：]\s*(.+)$/m);
      const name = nameMatch ? nameMatch[1].trim() : (msg.media_url.split('?')[0].split('#')[0].split('/').pop() || '资源文件');
      const sizeMatch = (msg.body || '').match(/^大小\s*[:：]\s*(.+)$/m);
      const size = sizeMatch ? sizeMatch[1].trim() : '';
      fileLink.innerHTML = `📎 ${UI.escapeHtml(name)}${size ? ` (${UI.escapeHtml(size)})` : ''}`;
      bubble.appendChild(fileLink);
    } else {
      bubble.textContent = msg.body || '';
    }
    
    node.appendChild(bubble);
    
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = isMe ? '你' : (store.get('friendMap')[msg.from_uid]?.name || msg.from_uid || '未知');
    meta.textContent = `${sender} · ${UI.formatTime(msg.created_at || msg.createdAt)}`;
    node.appendChild(meta);
    
    return node;
  }

  function appendMessage(msg) {
    const user = store.get('user');
    const messages = store.get('messages');
    const prevMsg = messages[messages.length - 1];
    const showAvatar = !prevMsg || prevMsg.from_uid !== msg.from_uid;
    
    const node = createMessageNode(msg, user, showAvatar);
    els.messageList.appendChild(node);
    scrollToBottom();
  }

  function scrollToBottom() {
    els.messageList.scrollTop = els.messageList.scrollHeight;
  }

  // ==================== Conversation Management ====================
  async function openConversation(type, id) {
    store.update({ 
      active: { type, id },
      messages: [],
    });
    
    renderConversationHeader();
    setPanel('chat');
    els.messageList.innerHTML = '<div class="loading">加载中...</div>';
    
    // Update URL
    const path = router.buildPath('/chat', { type, id });
    router.navigate(path);
    
    // Clear unread
    const unread = store.get('unread');
    if (type === 'direct') {
      unread.direct[id] = 0;
      await markDirectRead(id);
    } else {
      unread.group[id] = 0;
      await markGroupRead(id);
    }
    store.set('unread', unread);
    scheduleRenderList();
    
    // Load messages
    if (type === 'direct') {
      await loadDirectMessages(id);
    } else {
      await loadGroupMessages(id);
    }
  }

  async function loadDirectMessages(uid) {
    const cacheKey = `direct:${uid}`;
    const cached = msgCache.get(cacheKey);
    
    try {
      const resp = await api.request(`/v1/direct/messages/v2?with_uid=${encodeURIComponent(uid)}&limit=50&offset=0`, { retry: 1 });
      const messages = (resp.data.messages || []).sort((a, b) => a.created_at - b.created_at);
      store.set('messages', messages);
      msgCache.set(cacheKey, messages);
      renderMessages();
    } catch (err) {
      if (cached) {
        store.set('messages', cached);
        renderMessages();
        Toast.show('使用缓存的消息');
      } else {
        els.messageList.innerHTML = '<div class="error">加载消息失败</div>';
        Toast.error('拉取私聊记录失败');
      }
    }
  }

  async function loadGroupMessages(groupId) {
    const cacheKey = `group:${groupId}`;
    const cached = msgCache.get(cacheKey);
    
    try {
      const resp = await api.request(`/v1/groups/messages/v2?group_id=${encodeURIComponent(groupId)}&limit=50&offset=0`, { retry: 1 });
      const messages = (resp.data.messages || []).sort((a, b) => a.created_at - b.created_at);
      store.set('messages', messages);
      msgCache.set(cacheKey, messages);
      renderMessages();
    } catch (err) {
      if (cached) {
        store.set('messages', cached);
        renderMessages();
        Toast.show('使用缓存的消息');
      } else {
        els.messageList.innerHTML = '<div class="error">加载消息失败</div>';
        Toast.error('拉取群聊记录失败');
      }
    }
  }

  async function sendMessage(text) {
    const active = store.get('active');
    if (!active) return;
    
    const body = text.trim();
    if (!body) return;
    
    // Optimistic update
    const optimisticMsg = {
      id: `temp-${Date.now()}`,
      from_uid: store.get('user')?.uid,
      body,
      created_at: Math.floor(Date.now() / 1000),
      pending: true,
    };
    
    const messages = store.get('messages');
    messages.push(optimisticMsg);
    store.set('messages', messages);
    appendMessage(optimisticMsg);
    
    try {
      let resp;
      if (active.type === 'direct') {
        resp = await api.request('/v1/direct/send', {
          method: 'POST',
          body: { to_uid: active.id, body, msg_type: 'text' },
          retry: 2,
        });
      } else {
        resp = await api.request('/v1/groups/message/send', {
          method: 'POST',
          body: { group_id: active.id, body, msg_type: 'text' },
          retry: 2,
        });
      }
      
      // Replace optimistic message with real one
      const msgIndex = messages.findIndex(m => m.id === optimisticMsg.id);
      if (msgIndex >= 0) {
        messages[msgIndex] = resp.data;
        store.set('messages', messages);
        renderMessages();
      }
    } catch (err) {
      // Mark as failed
      const msgIndex = messages.findIndex(m => m.id === optimisticMsg.id);
      if (msgIndex >= 0) {
        messages[msgIndex].failed = true;
        store.set('messages', messages);
        renderMessages();
      }
      Toast.error('发送失败，点击重试');
    }
  }

  async function markDirectRead(uid) {
    try {
      await api.request('/v1/direct/read', { method: 'POST', body: { with_uid: uid } });
    } catch {
      // ignore
    }
  }

  async function markGroupRead(groupId) {
    try {
      await api.request('/v1/groups/read', { method: 'POST', body: { group_id: groupId } });
    } catch {
      // ignore
    }
  }

  // ==================== Polling ====================
  async function fetchUnread() {
    if (!store.get('accessToken')) return;
    
    try {
      const [directResp, groupResp] = await Promise.all([
        api.request('/v1/direct/unread', { method: 'POST', body: { limit: 50 } }),
        api.request('/v1/groups/unread', { method: 'POST', body: { limit: 50 } }),
      ]);
      
      const directMap = {};
      (directResp.data.messages || []).forEach(msg => {
        const peer = msg.peer_uid;
        if (!peer) return;
        directMap[peer] = (directMap[peer] || 0) + 1;
      });
      
      const groupMap = {};
      (groupResp.data.messages || []).forEach(msg => {
        const groupId = msg.group_id;
        if (!groupId) return;
        groupMap[groupId] = (groupMap[groupId] || 0) + 1;
      });
      
      store.set('unread', { direct: directMap, group: groupMap });
      scheduleRenderList();
      
      // Update document title with total unread
      const totalUnread = Object.values(directMap).reduce((a, b) => a + b, 0) + 
                         Object.values(groupMap).reduce((a, b) => a + b, 0);
      document.title = totalUnread > 0 ? `(${totalUnread}) 旧聊 Web` : '旧聊 Web';
    } catch {
      // ignore polling errors
    }
  }

  function startPolling() {
    stopPolling();
    const interval = store.get('wsConnected') 
      ? CONFIG.POLLING_INTERVAL_CONNECTED 
      : CONFIG.POLLING_INTERVAL_DISCONNECTED;
    store.set('pollTimer', setInterval(fetchUnread, interval));
  }

  function stopPolling() {
    const timer = store.get('pollTimer');
    if (timer) {
      clearInterval(timer);
      store.set('pollTimer', null);
    }
  }

  // ==================== WebSocket Event Handler ====================
  function handleWsEvent(message) {
    if (!message?.type) return;
    
    if (message.type === 'direct_message') {
      handleDirectMessage(message.data);
    } else if (message.type === 'group_message') {
      handleGroupMessage(message.data);
    } else if (message.type === 'pong') {
      // Heartbeat response
    }
  }

  function handleDirectMessage(msg) {
    if (!msg?.from_uid) return;
    
    const active = store.get('active');
    if (active?.type === 'direct' && active?.id === msg.from_uid) {
      const messages = store.get('messages');
      messages.push(msg);
      store.set('messages', messages);
      appendMessage(msg);
      markDirectRead(msg.from_uid);
    } else {
      const unread = store.get('unread');
      unread.direct[msg.from_uid] = (unread.direct[msg.from_uid] || 0) + 1;
      store.set('unread', unread);
      scheduleRenderList();
      
      // Browser notification
      if (Notification.permission === 'granted') {
        new Notification('新消息', {
          body: `${store.get('friendMap')[msg.from_uid]?.name || msg.from_uid}: ${msg.body}`,
        });
      }
    }
  }

  function handleGroupMessage(msg) {
    if (!msg?.group_id) return;
    
    const active = store.get('active');
    if (active?.type === 'group' && active?.id === msg.group_id) {
      const messages = store.get('messages');
      messages.push(msg);
      store.set('messages', messages);
      appendMessage(msg);
      markGroupRead(msg.group_id);
    } else {
      const unread = store.get('unread');
      unread.group[msg.group_id] = (unread.group[msg.group_id] || 0) + 1;
      store.set('unread', unread);
      scheduleRenderList();
    }
  }

  // ==================== Authentication ====================
  async function login(identifier, password) {
    const body = {
      identifier,
      password,
      device_id: getDeviceId(),
      device_name: navigator.userAgent.slice(0, 120),
      platform: 'web',
      app_version: 'web',
    };
    
    const resp = await api.request('/v1/auth/login', { 
      method: 'POST', 
      body, 
      auth: false,
      retry: 1,
    });
    
    store.update({
      accessToken: resp.data.access_token,
      refreshToken: resp.data.refresh_token,
      user: resp.data.user,
    });
    
    saveAuth();
    setUser(resp.data.user);
  }

  async function logout() {
    store.update({
      accessToken: '',
      refreshToken: '',
      user: null,
      active: null,
      messages: [],
    });
    
    saveAuth();
    wsManager.disconnect();
    stopPolling();
    setUser(null);
    showLogin(true);
    msgCache.clear();
    router.navigate('/login');
  }

  async function boot() {
    showLogin(false);
    setUser(store.get('user'));
    setStatus(false);
    renderConversationHeader();
    
    try {
      await Promise.all([loadFriends(), loadGroups()]);
      scheduleRenderList();
      await wsManager.connect();
      startPolling();
      requestNotificationPermission();
    } catch (err) {
      Toast.show('登录已过期，请重新登录');
      await logout();
    }
  }

  function getDeviceId() {
    let id = localStorage.getItem(LS_KEYS.DEVICE_ID);
    if (id) return id;
    
    id = crypto?.randomUUID 
      ? crypto.randomUUID()
      : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    
    localStorage.setItem(LS_KEYS.DEVICE_ID, id);
    return id;
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // ==================== Router Setup ====================
  router
    .before((route, params) => {
      // Check auth for protected routes
      if (route !== '/login' && !store.get('accessToken')) {
        router.navigate('/login');
        return false;
      }
      return true;
    })
    .register('/', () => {
      if (store.get('active')) {
        const { type, id } = store.get('active');
        router.navigate(router.buildPath('/chat', { type, id }));
      } else {
        setPanel('list');
      }
    })
    .register('/chat', (params) => {
      if (params.type && params.id) {
        openConversation(params.type, params.id);
      }
    })
    .register('/login', () => {
      showLogin(true);
    })
    .register('*', () => {
      router.navigate('/');
    });

  // ==================== Event Wiring ====================
  function wireEvents() {
    // Tab switching
    els.tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        setView(btn.dataset.view);
        setPanel('list');
        router.navigate('/');
      });
    });
    
    // Search with debounce
    els.searchInput.addEventListener('input', UI.debounce(scheduleRenderList, CONFIG.DEBOUNCE_DELAY));
    
    // Logout
    els.btnLogout.addEventListener('click', logout);
    
    // Back to list
    els.btnBackList.addEventListener('click', () => {
      setPanel('list');
      router.navigate('/');
    });
    
    // Send message
    els.composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = els.messageInput.value;
      els.messageInput.value = '';
      try {
        await sendMessage(text);
      } catch {
        Toast.error('发送失败');
      }
    });
    
    // Login
    els.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = els.loginIdentifier.value.trim();
      const pw = els.loginPassword.value;
      
      if (!id || !pw) {
        Toast.show('请输入账号和密码');
        return;
      }
      
      try {
        await login(id, pw);
        await boot();
        router.navigate('/');
      } catch (err) {
        Toast.error('登录失败，请检查账号密码');
      }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + K to focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        els.searchInput.focus();
      }
      // Esc to go back to list
      if (e.key === 'Escape' && store.get('active')) {
        setPanel('list');
        router.navigate('/');
      }
    });
    
    // Visibility change - reconnect when tab becomes visible
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && store.get('accessToken')) {
        if (!store.get('wsConnected')) {
          wsManager.connect();
        }
        fetchUnread();
      }
    });
    
    // Store subscriptions
    store.subscribe((key, value) => {
      if (key === 'theme') {
        document.body.dataset.theme = value;
        localStorage.setItem(LS_KEYS.THEME, value);
      }
    });
  }

  // ==================== Initialization ====================
  function init() {
    wireEvents();
    loadAuth();
    
    // Apply saved theme
    const theme = store.get('theme');
    if (theme) {
      document.body.dataset.theme = theme;
    }
    
    // Set initial user display
    if (store.get('user')) {
      setUser(store.get('user'));
    }
    
    // Start app
    if (store.get('accessToken')) {
      boot();
    } else {
      showLogin(true);
    }
    
    // Initialize router
    router.navigate();
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
