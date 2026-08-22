// =====================================================================
// api.js - 【已弃用 / DEPRECATED】
//
// 本文件的全部职责（传输层：apiFetch / 候选降级 / v1<->v2 / Crypto / ECDH / V2 签名 /
// resolveMediaUrl）已于 2026-08-22 合并进 oldchat-api-sdk.js（自包含单文件）。
//
// 合并后：
//  - oldchat-api-sdk.js 同时包含「传输层」+「业务层(OC SDK)」，不再依赖本文件。
//  - Tauri 桥接由 SDK 内部的 __tauriFetchImpl 从 window.__tauriHttpFetchImpl 读取，
//    浏览器环境自动回退原生 fetch，无需本文件。
//
// 请勿再加载本文件（index.html 已移除其 <script>）。保留此空壳仅作追溯，
// 若重新引入将导致 window.apiFetch 被重复定义、与 SDK 内同名函数冲突。
//
// 如需纯 SDK 分享给他人：只需 oldchat-api-sdk.js 单文件（浏览器直接可用）。
// =====================================================================
