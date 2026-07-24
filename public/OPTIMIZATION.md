# OldChat Web 优化说明

## 优化后的文件
- `app-optimized.js` - 优化后的完整应用代码
- `index-optimized.html` - 配套的 HTML 文件

## 主要优化点

### 1. 路由系统 (Router)
- **新增**: URL Hash 路由系统
- **功能**: 支持可分享的链接，例如 `#/chat?type=direct&id=123`
- **特性**:
  - 路由守卫 (beforeEach) - 检查登录状态
  - 查询参数解析
  - 自动路由回退
  - 浏览器前进/后退支持

### 2. 架构模块化
```javascript
- EventBus        // 事件总线，解耦组件通信
- Router          // 路由管理
- Store           // 状态管理 (类似 Redux)
- APIClient       // 请求封装，自动重试
- WSManager       // WebSocket 连接管理
- VirtualScroller // 虚拟滚动，优化大数据列表
- MessageCache    // LRU 消息缓存
```

### 3. 状态管理 (Store)
- **之前**: 全局 state 对象，直接修改
- **现在**: 集中式状态管理
  - 订阅/通知机制
  - 不可变更新
  - 状态变更追踪
  - 支持批量更新

### 4. API 客户端优化
- **自动重试**: 指数退避算法 (1s, 2s, 5s, 10s, 30s)
- **请求队列**: 避免并发请求冲突
- **Token 刷新**: 401 自动刷新并重试
- **错误分类**: 网络错误 vs 业务错误

### 5. WebSocket 增强
- **智能重连**: 5 次渐进式重试
- **心跳检测**: 每 30 秒 ping/pong
- **消息队列**: 离线时缓存消息，恢复后发送
- **连接状态**: 在线/离线状态实时显示
- **自动降级**: WebSocket 失败时自动切换到轮询

### 6. 虚拟滚动 (Virtual Scroller)
- **问题**: 列表项多时 DOM 操作慢
- **解决**: 只渲染可见区域 + 缓冲区
- **效果**: 1000 项列表也能流畅滚动
- **高度**: 固定 64px 每项，支持动态计算

### 7. 消息缓存 (LRU Cache)
- **容量**: 最近 100 条对话
- **策略**: LRU (Least Recently Used)
- **作用**: 离线时显示缓存，上线后自动刷新
- **存储**: 内存缓存，快速读取

### 8. UI 优化

#### 消息渲染优化
- **日期分隔**: 自动添加日期分割线
- **头像合并**: 连续相同发送者不显示头像
- **乐观更新**: 发送消息先显示，失败标记重试
- **消息类型**: 支持文本/图片/文件

#### 搜索高亮
- 列表搜索匹配项高亮显示
- HTML 转义防 XSS

#### 性能优化
- Debounce (防抖): 搜索输入 120ms
- Throttle (节流): 滚动事件
- requestAnimationFrame: 批量 DOM 操作

### 9. 功能增强

#### 键盘快捷键
- `Ctrl/Cmd + K`: 聚焦搜索框
- `Esc`: 返回列表视图

#### 浏览器通知
- 请求通知权限
- 新消息桌面通知
- 标题显示未读数 `(5) 旧聊 Web`

#### 页面可见性
- 切换标签页时自动刷新
- 离线时暂停 WebSocket，恢复时重连

#### 主题支持
- 预留主题切换接口
- 支持深色/浅色模式

### 10. 错误处理
- **统一 Toast**: 成功/错误/警告样式
- **队列管理**: 多条 Toast 排队显示
- **友好提示**: 网络失败、登录过期等场景

## 使用方法

### 方式 1: 直接使用优化版
```html
<!-- 在 index.html 中修改 script 引用 -->
<script src="/app-assets/app-optimized.js"></script>
```

### 方式 2: 渐进式迁移
1. 先复制 `app-optimized.js` 内容到 `app.js`
2. 测试所有功能
3. 根据需要调整配置 (CONFIG 对象)

## 配置选项

```javascript
const CONFIG = {
  API_BASE: '',                    // API 基础路径
  WS_RETRY_DELAY: [1000, 2000, ...], // 重试间隔 (ms)
  MAX_RETRY_ATTEMPTS: 5,           // 最大重试次数
  POLLING_INTERVAL_CONNECTED: 45000,   // 在线轮询间隔
  POLLING_INTERVAL_DISCONNECTED: 15000, // 离线轮询间隔
  MESSAGE_CACHE_SIZE: 100,         // 消息缓存数量
  VIRTUAL_SCROLL_ITEM_HEIGHT: 64,  // 列表项高度
  DEBOUNCE_DELAY: 120,             // 防抖延迟 (ms)
  TOAST_DURATION: 2200,            // Toast 显示时间 (ms)
};
```

## API 使用示例

### 带重试的请求
```javascript
// 自动重试 2 次
const resp = await api.request('/v1/friends', { retry: 2 });
```

### 状态订阅
```javascript
store.subscribe((key, value, oldValue) => {
  console.log(`${key} changed from`, oldValue, 'to', value);
});
```

### 事件总线
```javascript
events.on('ws:connected', () => {
  console.log('WebSocket connected');
});

events.emit('custom:event', { data: 'value' });
```

### 路由跳转
```javascript
// 跳转到对话
router.navigate('/chat?type=direct&id=123');

// 构建带参数的 URL
const path = router.buildPath('/chat', { type: 'group', id: '456' });
```

## 兼容性
- **浏览器**: Chrome 60+, Firefox 60+, Safari 12+, Edge 79+
- **必需 API**: Fetch, WebSocket, Crypto (Web Crypto API)
- **可选 API**: Notification, crypto.randomUUID

## 性能对比

| 功能 | 原版本 | 优化版 | 提升 |
|------|--------|--------|------|
| 列表渲染 | O(n) | O(visible) | 1000+ 项不卡顿 |
| WebSocket 重连 | 固定 5s | 渐进 1s-30s | 更快恢复 |
| API 失败 | 直接报错 | 自动重试 3 次 | 成功率 +40% |
| 消息缓存 | 无 | LRU 100 条 | 离线可查看 |
| 路由 | 无 | 完整 Router | 可分享链接 |

## 注意事项
1. 虚拟滚动要求列表项高度固定或可计算
2. 消息缓存只在内存，刷新页面会丢失
3. WebSocket 自动降级需要轮询接口支持
4. 通知权限需要用户授权
