# Oldchat 服务端非管理员 URL 路径

来源：`internal/http/api.go` 当前实际注册路由。

说明：

- 已排除根路径 `/admins/*` 管理后台路由。
- V1 路由同时挂载在 `/v1/*` 和兼容前缀 `/v1/v1/*`。下文仅写一次 `/v1`，例如 `POST /v1/auth/login` 同时也存在 `POST /v1/v1/auth/login`。
- `{name}` 表示路径参数，`*` 表示通配静态资源路径。
- `HANDLE` 表示静态文件处理器，不限定单一 HTTP 方法。

## 1. 网站、下载与静态资源

```text
GET     /
GET     /landing
GET     /download/oldchat.apk
GET     /shop
GET     /igotbanned
POST    /igotbanned
GET     /app
GET     /coin-tool
HANDLE  /app-assets/*
GET     /report
POST    /report
POST    /shop/login
GET     /shop/logout
GET     /lua-cip.md
GET     /routes.md
GET     /api.md
GET     /client.md
GET     /oauth.md
GET     /.well-known/openid-configuration
GET     /oauth/jwks.json
GET     /oauth/authorize
POST    /oauth/authorize
GET     /oauth/authorize/resume
GET     /oauth/register
POST    /oauth/register
GET     /oauth/reset
POST    /oauth/reset
POST    /oauth/token
POST    /oauth/introspect
POST    /oauth/revoke
GET     /oauth/userinfo
HANDLE  /lua-assets/*
HANDLE  /landing-assets/*
HANDLE  /update/*
HANDLE  /uploads/*
GET     /v1/music/cover/*
```

## 2. 认证、连接与文件

```text
POST    /v1/auth/register
POST    /v1/auth/login
POST    /v1/auth/direct-create
POST    /v1/auth/password/reset
POST    /v1/auth/handshake
GET     /v1/auth/captcha
POST    /v1/auth/email/send
POST    /v1/auth/refresh
POST    /v1/auth/logout
GET     /v1/ws
GET     /v1/music/cover/*
HANDLE  /v1/uploads/*
```

## 3. 外部系统接口

```text
POST    /v1/external/groups
POST    /v1/external/friends
POST    /v1/external/direct/send
POST    /v1/external/group/send
POST    /v1/external/coin/pay
POST    /v1/external/coin/verify
```

## 4. 当前用户、AI、签到与设备

```text
GET     /v1/me
GET     /v1/ai/quota
POST    /v1/ai/chat/completions
POST    /v1/chat/completions
POST    /v1/me/checkin
GET     /v1/me/checkin/wall
POST    /v1/me/checkin/wall
POST    /v1/me/checkin/wall/like
POST    /v1/me/checkin/wall/unlike
POST    /v1/me/checkin/wall/comment
GET     /v1/me/checkin/wall/comments
GET     /v1/me/checkin/wall/likes
POST    /v1/me/presence
GET     /v1/me/devices
POST    /v1/me/devices/cleanup
POST    /v1/me/devices/cleanup-others
GET     /v1/me/bug-reports
GET     /v1/me/user-reports
GET     /v1/me/group-reports
GET     /v1/me/resource-reports
GET     /v1/reports/bug
GET     /v1/reports/user
GET     /v1/reports/group
POST    /v1/me/uid
POST    /v1/me/profile
POST    /v1/me/password
POST    /v1/me/delete
POST    /v1/me/avatar
POST    /v1/me/cover
POST    /v1/voice/asr
POST    /v1/media
```

## 5. 用户与好友

```text
GET     /v1/users/profile
GET     /v1/friends
GET     /v1/friends/requests
POST    /v1/friends/request
POST    /v1/friends/respond
POST    /v1/friends/remark
POST    /v1/friends/delete
```

## 6. 资源区

```text
POST    /v1/resources/sections
GET     /v1/resources/sections
POST    /v1/resources/sections/delete
POST    /v1/resources/upload
GET     /v1/me/resources/quota
GET     /v1/resources/items
GET     /v1/resources/search
POST    /v1/resources/items/delete
POST    /v1/resources/like
POST    /v1/resources/unlike
POST    /v1/resources/comment
GET     /v1/resources/comments
POST    /v1/resources/comment/delete
POST    /v1/resources/report
```

## 7. 私聊、输入状态与红包

```text
POST    /v1/direct/send
POST    /v1/chats/typing
GET     /v1/chats/{chatId}/typing
POST    /v1/redpackets/send
POST    /v1/redpackets/claim
GET     /v1/redpackets/{packetID}
GET     /v1/direct/messages/v2
GET     /v1/direct/messages/search
GET     /v1/direct/messages
POST    /v1/direct/unread
POST    /v1/direct/read
POST    /v1/direct/burn/open
POST    /v1/direct/messages/{messageID}/transcribe
DELETE  /v1/direct/messages/{messageID}
```

## 8. 群组与群消息

```text
POST    /v1/groups/create
POST    /v1/groups/join
POST    /v1/groups/approve
GET     /v1/groups/list
GET     /v1/groups/members
GET     /v1/groups/requests
POST    /v1/groups/invite
POST    /v1/groups/admin
POST    /v1/groups/avatar
POST    /v1/groups/kick
POST    /v1/groups/name
POST    /v1/groups/settings
POST    /v1/groups/announcement
POST    /v1/groups/announcement/read
POST    /v1/groups/leave
POST    /v1/groups/dissolve
POST    /v1/groups/typing
GET     /v1/groups/{groupId}/typing
POST    /v1/groups/message/send
POST    /v1/groups/unread
POST    /v1/groups/read
POST    /v1/groups/burn/open
POST    /v1/groups/messages/{messageID}/transcribe
GET     /v1/groups/messages/v2
GET     /v1/groups/messages/after
GET     /v1/groups/messages/search
GET     /v1/groups/messages
DELETE  /v1/groups/messages/{messageID}
```

## 9. 动态

```text
POST    /v1/moments
GET     /v1/moments
GET     /v1/moments/v2
GET     /v1/moments/user
POST    /v1/moments/like
POST    /v1/moments/unlike
POST    /v1/moments/delete
POST    /v1/moments/comment
POST    /v1/moments/comment/delete
GET     /v1/moments/comments
```

## 10. CIP 小程序

```text
GET     /v1/discover/lua/manifest
GET     /v1/discover/lua/apps/{id}
GET     /v1/discover/lua/assets/*
```

## 11. 表情广场

```text
GET     /v1/emoji/plaza
GET     /v1/emoji/plaza/mine
POST    /v1/emoji/plaza/upload
POST    /v1/emoji/plaza/save
POST    /v1/emoji/plaza/delete
```

## 12. 音乐广场

```text
GET     /v1/music/plaza
GET     /v1/music/plaza/mine
POST    /v1/music/plaza/upload
POST    /v1/music/plaza/update
POST    /v1/music/plaza/lyrics
POST    /v1/music/plaza/delete
POST    /v1/music/plaza/mine/delete-batch
POST    /v1/music/plaza/like
POST    /v1/music/plaza/unlike
POST    /v1/music/plaza/comment
POST    /v1/music/plaza/comment/delete
GET     /v1/music/plaza/comments
POST    /v1/music/plaza/play
GET     /v1/music/plaza/ranking
```

## 13. 收藏、举报、公开法庭、反馈与通知

```text
GET     /v1/favorites
POST    /v1/favorites/add
POST    /v1/favorites/remove
POST    /v1/reports/user
POST    /v1/reports/group
GET     /v1/public-court/cases
GET     /v1/public-court/cases/{caseID}
GET     /v1/public-court/cases/{caseID}/votes
GET     /v1/public-court/cases/{caseID}/discussions
POST    /v1/public-court/cases/{caseID}/vote
POST    /v1/public-court/cases/{caseID}/statement
POST    /v1/public-court/cases/{caseID}/discussion
POST    /v1/public-court/cases/{caseID}/withdraw
POST    /v1/feedback
GET     /v1/notifications
```

## 14. 名称含 admins、但实际由客户端提交的特殊接口

该接口不属于网页管理后台，但路径名称包含 `admins`。如果要求严格排除所有含 `/admins` 的路径，可忽略本节。

```text
POST    /v1/admins/crash-reports
```
