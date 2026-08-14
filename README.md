<div align="center">

![OldChat For Kivotos Next](assets/readme-banner.svg)

**桃信旧聊** —— 为《蔚蓝档案》基沃托斯的 Sensei 量身打造的第三方 OldChat 桌面客户端

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-2ea44f.svg)](https://github.com/LGCR837/oldchat-kivotos-next/releases)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%20v2-24c8db.svg)](https://v2.tauri.app)
[![Language](https://img.shields.io/badge/Language-Rust%20%26%20JavaScript-orange.svg)](https://github.com/LGCR837/oldchat-kivotos-next)

[官网](https://ockn.reverie.dpdns.org) · [下载](https://ockn.reverie.dpdns.org/download) · [GitHub Releases](https://github.com/LGCR837/oldchat-kivotos-next/releases) · [OldChat 官网](http://oc.mcl0.dpdns.org/)

</div>

---

## 关于本项目

**OldChat For Kivotos Next**（俗称「桃信旧聊」，即 OldChat 基沃托斯特供版）是一个非官方的第三方 [OldChat](http://oc.mcl0.dpdns.org/) 桌面客户端，专门为《蔚蓝档案》的基沃托斯量身定制，界面风格致敬 MomoTalk。

本项目是初代 Python + Flask 网页版客户端的全新重写：在保留 MomoTalk 界面风格的同时，底层彻底重构为 Rust + Tauri v2 原生桌面客户端，直连后端、免安装运行，并在功能与稳定性上做了大量增强。

> 「吾等所盼乃七之哀叹，吾等所忆乃杰里科的古法。」

OldChat 由 MCL0 开发，是一个面向老安卓设备的聊天软件；本项目与其官方版本没有直接联系，仅作为其第三方客户端存在。

## 目录

- [特性](#特性)
- [下载与安装](#下载与安装)
- [从源码构建](#从源码构建)
- [项目结构](#项目结构)
- [自定义主题与插件](#自定义主题与插件)
- [免责声明](#免责声明)
- [致谢](#致谢)
- [许可](#许可)

## 特性

### 聊天

- 私聊 / 群聊 / 频道，支持撤回、引用回复、@ 提醒、消息转发
- 图片、语音、视频、文件、表情、红包与音乐分享卡片
- 内置 ArtPlayer 视频播放、语音内联播放、图片查看与本地保存
- 群管理：成员列表、设置管理员、踢出成员、群头像与群资料编辑

### 发现

- 朋友圈动态、用户主页与个人主页
- 音乐广场（广场 / 排行 / 搜索 / 我的），带封面、歌词与播放器
- 表情广场、公开法庭、资源广场、小程序、签到墙

### 外观与扩展

- 明 / 暗双主题，支持导入单文件 CSS 自定义主题
- 用户插件系统：导入任意 `.js` 脚本，可单独启用或停用
- 无边框自定义标题栏、系统托盘常驻、消息桌面通知

### 网络与稳定性

- 多候选服务器地址，遇网络错误或 5xx 自动降级到下一候选（设置中可增删）
- 接口版本可切换：v2 优先 / v1 优先 / 仅 v1 / 仅 v2（v2 走 ECDH 握手 + 请求签名）
- 启动环境自检：缺少 WebView2 / WebKitGTK 或图形环境异常时给出原生弹窗提示，而非静默失败

## 下载与安装

前往 [官网下载页](https://ockn.reverie.dpdns.org/download) 或 [GitHub Releases](https://github.com/LGCR837/oldchat-kivotos-next/releases) 获取对应版本。

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Windows | x86_64 / i686 / aarch64 | 免安装单文件 `.exe` |
| Windows | x86_64 / aarch64 | NSIS 安装包 |
| Linux | x86_64 / aarch64 | 免安装单文件、AppImage、deb、rpm |
| macOS | Apple Silicon / Intel | `.dmg`（未签名） |

Windows 免安装单文件约 12–15 MB，双击即用。

### Windows 运行环境（打不开请装）

- **Windows 10 及以上**：大部分自带，不行再装 [Microsoft Edge WebView2 运行时](https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/)
- **Windows 7 / 8 / 8.1**：需手动安装 [WebView2 Runtime 109.0.1518.140](https://www.catalog.update.microsoft.com/Search.aspx?q=webview2%20runtime%20109.0.1518.140)（109 是最后支持这些系统的版本）
- **VC++ 运行库**（报错再装，一般不用）：[x64](https://aka.ms/vc14/vc_redist.x64.exe) / [x86](https://aka.ms/vc14/vc_redist.x86.exe)
- **Windows 7** 另需 SP1 与补丁 [KB4490628](https://www.catalog.update.microsoft.com/Search.aspx?q=KB4490628)（服务堆栈更新）、[KB4474419](https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419)（SHA-2 代码签名支持）

### macOS

dmg 未签名，首次打开请**右键打开**（或终端执行以下命令）：

```bash
xattr -cr "/Applications/OldChat For Kivotos.app"
```

## 从源码构建

### 环境要求

- [Node.js](https://nodejs.org/)（18+）
- [Rust](https://www.rust-lang.org/tools/install) 工具链
- Windows：Visual Studio Build Tools（含 C++ 生成工具）
- Linux：`webkit2gtk-4.1`、`libayatana-appindicator3` 等 Tauri v2 依赖

### 命令

```bash
npm install

# 开发（热调试：前端改动按 Ctrl+R 刷新即可）
npm run tauri dev

# 打包当前平台
npm run tauri build
```

开发期按 `Ctrl+Alt+Shift+F12` 打开 DevTools。修改 `src-tauri/tauri.conf.json` 或 `src-tauri/capabilities/` 后需要重启开发进程。

## 项目结构

```
src/                     前端（原生 HTML/CSS/JS，无框架、无构建步骤）
  index.html             主界面
  app.js                 全部业务逻辑
  app.css                全部样式与主题变量
  login.html             登录 / 注册
  assets/ vendor/        字体、图标、ArtPlayer 等第三方资源
src-tauri/               Tauri v2 (Rust) 壳层
  src/lib.rs             Rust 命令（窗口控制、下载、通知、主题与插件管理等）
  src/preflight.rs       启动环境自检
  capabilities/          插件权限与域名白名单
  tauri.conf.json        应用配置
docs/                    开发文档、后端 API 文档、官网源码
.github/workflows/       多平台发布流水线
```

> 前端刻意保持单文件、零构建：所有逻辑集中在 `src/app.js`，全局函数挂在 `window` 上。这是有意的设计取舍，请勿引入打包工具。

## 自定义主题与插件

两者都存放在应用配置目录（Windows 通常为 `%APPDATA%\aoharureverie.oldchat.kivotosnextapp\`），可在应用内「设置」中导入、启用、删除：

- **主题**：单个 `.css` 文件，通过覆盖 `:root` / `[data-theme-mode="dark"]` 下的语义变量改变配色，文件头可用 `@theme` 注释声明元数据
- **插件**：任意 `.js` 文件，启动时按启用状态注入执行，文件头可用 `/* @plugin name: xxx */` 声明元数据

插件运行在应用同一上下文中，请只安装你信任的脚本。

## 免责声明

本项目是**非官方**的第三方客户端，与 OldChat 官方无隶属关系，亦未获其背书。

《蔚蓝档案》（Blue Archive）及 MomoTalk 相关名称、形象与商标归 NEXON Games / Yostar 等各自权利人所有。本项目仅在界面风格上致敬，不包含也不分发任何游戏素材。

软件按「现状」提供，使用风险自负。

## 致谢

[Tauri](https://tauri.app/) · [Font Awesome](https://fontawesome.com/) · [ArtPlayer](https://artplayer.org/) · [Dumogu Scrollbar](https://github.com/dumogu/dumogu-scrollbar) · [Fengari](https://fengari.io/)

## 许可

本项目基于 [MIT License](LICENSE) 开源。

Copyright (c) 2026 **Aoharu Reverie** (LGCR837)

第三方依赖与资源各自遵循其原始许可协议。
