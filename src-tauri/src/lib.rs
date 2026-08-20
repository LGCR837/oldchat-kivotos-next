// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod preflight;

// 托盘/菜单/桌面专属对话框 API 仅桌面端存在，移动端不引入以免编译失败
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tauri_plugin_dialog::FilePath;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// 运行环境概览：供「设置 → 关于」展示，也便于用户反馈问题时提供环境信息。
// warnings 是启动自检里未阻断启动的非致命项（如 Linux 缺托盘库）。
#[tauri::command]
fn env_report() -> serde_json::Value {
    let warnings: Vec<serde_json::Value> = preflight::warnings()
        .iter()
        .map(|w| serde_json::json!({ "title": w.title, "message": w.message }))
        .collect();

    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": preflight::os_version_string(),
        "webview": tauri::webview_version().unwrap_or_else(|_| "未知".to_string()),
        "warnings": warnings,
    })
}

// 当前应用版本：本地写死为 v9，不再由 CI 动态注入。
#[tauri::command]
fn app_version() -> String {
    "v12".to_string()
}

// 切换 DevTools：前端在 Ctrl+Alt+Shift+F12 时调用
#[cfg(desktop)]
#[tauri::command]
fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

// 窗口控制：最小化 / 切换最大化 / 关闭
#[cfg(desktop)]
#[tauri::command]
fn minimize_window(window: WebviewWindow) {
    let _ = window.minimize();
}

#[cfg(desktop)]
#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) {
    if let Ok(is_max) = window.is_maximized() {
        if is_max {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    } else {
        let _ = window.maximize();
    }
}

// 关闭：拦截为隐藏到托盘（实际拦截在 on_window_event 中完成）
#[cfg(desktop)]
#[tauri::command]
fn close_window(window: WebviewWindow) {
    let _ = window.close();
}

// 查询窗口是否已最大化（前端用于切换还原图标 / 移除圆角）
#[cfg(desktop)]
#[tauri::command]
fn is_window_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

// 新消息通知：根据窗口状态决定通知方式
// - 隐藏到托盘（不可见）且 system=true：弹出系统通知
// - 最小化到任务栏且 flash=true：闪烁任务栏图标（Windows）
// - 正常显示：不通知
// flash / system 由前端按「任务栏闪动通知」「托盘状态系统通知」开关传入
#[cfg(desktop)]
#[tauri::command]
fn notify_new_message(window: WebviewWindow, app: tauri::AppHandle, title: String, body: String, flash: bool, system: bool) {
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    if !visible {
        // 隐藏到托盘：发送系统通知（受「托盘状态系统通知」开关控制）
        if system {
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title(&title)
                .body(&body)
                .show();
        }
    } else if minimized {
        // 最小化到任务栏：闪烁任务栏图标（受「任务栏闪动通知」开关控制）
        if flash {
            #[cfg(windows)]
            {
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                if let Ok(handle) = window.window_handle() {
                    if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                        flash_taskbar_windows(win32.hwnd.get());
                    }
                }
            }
        }
    }
    // 正常显示：不通知
}

// Windows：闪烁任务栏图标（直到窗口重新获得焦点）
#[cfg(windows)]
fn flash_taskbar_windows(hwnd_val: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_ALL, FLASHW_TIMERNOFG,
    };
    let fi = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: hwnd_val as *mut std::ffi::c_void,
        dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
        uCount: 5,
        dwTimeout: 0,
    };
    unsafe {
        let _ = FlashWindowEx(&fi);
    }
}

// 弹出原生保存对话框，写入二进制数据（filename 可选默认文件名；filter 可选扩展名过滤）
// 仅桌面端有阻塞式保存对话框；移动端无此能力，返回「不支持」。
fn save_with_dialog(
    app: &tauri::AppHandle,
    data: &[u8],
    filename: Option<&str>,
    filter: Option<(&str, &[&str])>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let mut builder = app.dialog().file();
        if let Some((name, exts)) = filter {
            builder = builder.add_filter(name, exts);
        }
        if let Some(name) = filename {
            builder = builder.set_file_name(name);
        }
        let file_path = builder.blocking_save_file();

        if let Some(path) = file_path {
            match path {
                FilePath::Path(p) => {
                    std::fs::write(&p, data).map_err(|e| format!("保存失败: {}", e))?;
                }
                _ => return Err("不支持的路径类型".into()),
            }
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, data, filename, filter);
        Err("移动端暂不支持保存对话框".into())
    }
}

// 下载进度上报消息（经 Tauri Channel 推到前端）
#[derive(Clone, serde::Serialize)]
struct DlProgress {
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

// 取消标志表：task_id -> Arc<AtomicBool>，前端点取消时置位，流式循环里检测
static DL_CANCEL: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> =
    OnceLock::new();
fn dl_cancel_map(
) -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    DL_CANCEL.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

// 流式下载：边下边写临时文件，按块上报进度；支持取消。完成后弹系统保存框。
async fn stream_download(
    app: &tauri::AppHandle,
    url: String,
    headers: Option<Vec<(String, String)>>,
    task_id: String,
    on_progress: tauri::ipc::Channel<DlProgress>,
    filename: Option<String>,
    filter: Option<(&str, &[&str])>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    dl_cancel_map()
        .lock()
        .map_err(|_| "内部锁异常".to_string())?
        .insert(task_id.clone(), cancel.clone());

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    let mut resp = req.send().await.map_err(|e| format!("下载失败: {}", e))?;
    let total = resp.content_length().unwrap_or(0);
    on_progress
        .send(DlProgress {
            downloaded: 0,
            total,
            done: false,
            error: None,
        })
        .ok();

    // 流式写入临时文件，避免一次性把大文件读进内存
    let tmp = std::env::temp_dir().join(format!("oc_dl_{}.part", task_id));
    let mut downloaded: u64 = 0;
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败: {}", e))?;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("读取失败: {}", e))?
        {
            if cancel.load(Ordering::SeqCst) {
                let _ = std::fs::remove_file(&tmp);
                dl_cancel_map()
                    .lock()
                    .ok()
                    .and_then(|mut m| m.remove(&task_id));
                return Err("已取消".into());
            }
            f.write_all(&chunk).map_err(|e| format!("写入失败: {}", e))?;
            downloaded += chunk.len() as u64;
            on_progress
                .send(DlProgress {
                    downloaded,
                    total,
                    done: false,
                    error: None,
                })
                .ok();
        }
    }

    let data = std::fs::read(&tmp).map_err(|e| format!("读取临时文件失败: {}", e))?;
    let _ = std::fs::remove_file(&tmp);
    dl_cancel_map()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&task_id));
    on_progress
        .send(DlProgress {
            downloaded,
            total: if total == 0 { downloaded } else { total },
            done: true,
            error: None,
        })
        .ok();

    save_with_dialog(app, &data, filename.as_deref(), filter)
}

// 通过 URL 下载图片（HTTP / HTTPS），可带请求头（媒体接口已加权鉴，需传 Authorization）
#[tauri::command]
async fn save_image(
    app: tauri::AppHandle,
    url: String,
    headers: Option<Vec<(String, String)>>,
    task_id: String,
    on_progress: tauri::ipc::Channel<DlProgress>,
) -> Result<(), String> {
    stream_download(
        &app,
        url,
        headers,
        task_id,
        on_progress,
        None,
        Some(("图片", &["jpg", "jpeg", "png", "gif", "webp", "bmp"])),
    )
    .await
}

// 通用文件下载（文件消息；可带默认文件名与鉴权头，不限制扩展名）
#[tauri::command]
async fn save_download(
    app: tauri::AppHandle,
    url: String,
    filename: Option<String>,
    headers: Option<Vec<(String, String)>>,
    task_id: String,
    on_progress: tauri::ipc::Channel<DlProgress>,
) -> Result<(), String> {
    stream_download(
        &app,
        url,
        headers,
        task_id,
        on_progress,
        filename,
        None,
    )
    .await
}

// 取消正在进行的下载（前端进度弹窗点「取消」时调用）
#[tauri::command]
fn cancel_download(task_id: String) {
    if let Ok(m) = dl_cancel_map().lock() {
        if let Some(flag) = m.get(&task_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// 直接保存二进制数据（blob URL 用 canvas 读出后传过来）
#[tauri::command]
async fn save_image_data(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    save_with_dialog(&app, &data, None, None)
}

// 导出配置：弹保存框写入 JSON 文本（桌面）
#[tauri::command]
fn save_text_file(app: tauri::AppHandle, data: String, filename: String) -> Result<(), String> {
    save_with_dialog(
        &app,
        data.as_bytes(),
        Some(filename.as_str()),
        Some(("JSON 配置", &["json"])),
    )
}

// 导入配置：弹打开框读取 JSON 文本（桌面）
#[tauri::command]
fn open_text_file(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        let picked = app
            .dialog()
            .file()
            .add_filter("JSON 配置", &["json"])
            .blocking_pick_file();
        let path = match picked {
            Some(FilePath::Path(p)) => p,
            _ => return Err("未选择文件".into()),
        };
        std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {}", e))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("移动端暂不支持".into())
    }
}

// 拉取媒体字节并返回（频道私有媒体等需 Bearer 鉴权的场景）。
// 不复用 plugin-http：该插件对跨域/重定向目标做 scope 校验，且对 files.mcl0 前置的 Cloudflare 预检无法通过；
// 这里直接用 reqwest（与 save_download/save_image 同款客户端），跟随重定向、可带鉴权头，返回原始字节交由前端转 blob。
#[derive(serde::Serialize)]
struct FetchMediaResult {
    data: Vec<u8>,
    content_type: String,
}

#[tauri::command]
async fn fetch_media(
    url: String,
    headers: Option<Vec<(String, String)>>,
) -> Result<FetchMediaResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;
    let mut req = client.get(&url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("媒体下载失败: HTTP {}", status));
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let data = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
    Ok(FetchMediaResult {
        data: data.to_vec(),
        content_type,
    })
}

// ===== 多主题系统（用户上传自定义 .css 主题）=====
// 主题文件存入「系统用户文件夹」：各平台的 App 配置目录下的 themes/ 子目录
//   Windows: %APPDATA%/<identifier>/themes
//   Linux  : $XDG_CONFIG_HOME/<identifier>/themes  (通常 ~/.config/<identifier>/themes)
// 解析纯 CSS 顶部 ` * @theme key: value` 注释作为元数据。

// 取 themes 目录（自动创建），失败返回 String 错误
fn themes_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {}", e))?;
    let dir = base.join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建主题目录失败: {}", e))?;
    Ok(dir)
}

// 解析 @theme 元数据（不依赖 regex，逐行处理）
fn parse_theme_meta(css: &str) -> serde_json::Value {
    let mut meta = serde_json::json!({
        "id": "",
        "name": "",
        "description": "",
        "author": "",
        "version": "",
        "framework": ""
    });
    for line in css.lines() {
        let s = line.trim().trim_start_matches('*').trim();
        if let Some(rest) = s.strip_prefix("@theme") {
            if let Some((k, v)) = rest.split_once(':') {
                let k = k.trim();
                let v = v.trim();
                if let Some(key) = meta.get_mut(k) {
                    *key = serde_json::Value::String(v.to_string());
                }
            }
        }
    }
    meta
}

// 把任意 id 清洗为安全的文件名片段
fn sanitize_theme_id(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.is_empty() { "theme".to_string() } else { safe }
}

// 原生文件选择框挑选 .css → 解析元数据 → 写入 themes/<id>.css → 返回元数据（含 css）
    // 仅桌面端：依赖阻塞式文件选择框（移动端无 blocking_pick_file）
    #[cfg(desktop)]
    #[tauri::command]
    fn import_theme(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("CSS 主题文件", &["css"])
        .blocking_pick_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return Err("未选择文件".into()),
    };
    let css = std::fs::read_to_string(&path).map_err(|e| format!("读取主题文件失败: {}", e))?;

    let mut meta = parse_theme_meta(&css);
    let fallback_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("theme")
        .to_string();
    let raw_id = if meta["id"].as_str().unwrap_or("").is_empty() {
        fallback_id
    } else {
        meta["id"].as_str().unwrap().to_string()
    };
    let safe = sanitize_theme_id(&raw_id);

    let dir = themes_dir(&app)?;
    std::fs::write(dir.join(format!("{}.css", safe)), &css)
        .map_err(|e| format!("写入主题失败: {}", e))?;

    meta["id"] = serde_json::Value::String(safe);
    meta["css"] = serde_json::Value::String(css);
    Ok(meta)
}

// 列出已安装的用户主题（含完整 css 供前端直接注入）
#[tauri::command]
fn list_user_themes(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Ok(dir) = themes_dir(&app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("css") {
                    if let Ok(css) = std::fs::read_to_string(&path) {
                        let mut meta = parse_theme_meta(&css);
                        let stem = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        if meta["id"].as_str().unwrap_or("").is_empty() {
                            meta["id"] = serde_json::Value::String(stem.clone());
                        }
                        meta["css"] = serde_json::Value::String(css);
                        out.push(meta);
                    }
                }
            }
        }
    }
    out
}

// 删除用户主题
#[tauri::command]
fn delete_user_theme(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let safe = sanitize_theme_id(&id);
    let dir = themes_dir(&app)?;
    let path = dir.join(format!("{}.css", safe));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))?;
    }
    Ok(())
}

// ===== 插件系统（用户添加任意 .js 插件）=====
// 插件文件存入「系统用户文件夹」：<app_config_dir>/plugins/
//   Windows: %APPDATA%/<identifier>/plugins
//   Linux  : $XDG_CONFIG_HOME/<identifier>/plugins (通常 ~/.config/<identifier>/plugins)
// 元数据解析文件头 `/* @plugin key: value */` 或 `// @plugin key: value` 注释。
// 说明：sanitize_theme_id 的清洗规则（字母数字/中划线/下划线）对插件 id 同样适用，直接复用。

// 取 plugins 目录（自动创建），失败返回 String 错误
fn plugins_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {}", e))?;
    let dir = base.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {}", e))?;
    Ok(dir)
}

// 解析 @plugin 元数据（兼容块注释 * 行首与 // 行注释）
fn parse_plugin_meta(src: &str) -> serde_json::Value {
    let mut meta = serde_json::json!({
        "id": "",
        "name": "",
        "description": "",
        "author": "",
        "version": ""
    });
    for line in src.lines() {
        let s = line
            .trim()
            .trim_start_matches('*')
            .trim()
            .trim_start_matches("//")
            .trim();
        if let Some(rest) = s.strip_prefix("@plugin") {
            if let Some((k, v)) = rest.split_once(':') {
                let k = k.trim();
                let v = v.trim();
                if let Some(key) = meta.get_mut(k) {
                    *key = serde_json::Value::String(v.to_string());
                }
            }
        }
    }
    meta
}

// 原生文件选择框挑选 .js → 解析元数据 → 写入 plugins/<id>.js → 返回元数据
    // 仅桌面端：依赖阻塞式文件选择框
    #[cfg(desktop)]
    #[tauri::command]
    fn import_plugin(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JavaScript 插件", &["js"])
        .blocking_pick_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return Err("未选择文件".into()),
    };
    let src = std::fs::read_to_string(&path).map_err(|e| format!("读取插件文件失败: {}", e))?;

    let mut meta = parse_plugin_meta(&src);
    let fallback_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("plugin")
        .to_string();
    let raw_id = if meta["id"].as_str().unwrap_or("").is_empty() {
        fallback_id
    } else {
        meta["id"].as_str().unwrap().to_string()
    };
    let safe = sanitize_theme_id(&raw_id);

    let dir = plugins_dir(&app)?;
    std::fs::write(dir.join(format!("{}.js", safe)), &src)
        .map_err(|e| format!("写入插件失败: {}", e))?;

    meta["id"] = serde_json::Value::String(safe);
    Ok(meta)
}

// 列出已安装插件（含元数据，不含源码——源码由 read_plugin_source 按需读取）
#[tauri::command]
fn list_user_plugins(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Ok(dir) = plugins_dir(&app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("js") {
                    if let Ok(src) = std::fs::read_to_string(&path) {
                        let mut meta = parse_plugin_meta(&src);
                        let stem = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        if meta["id"].as_str().unwrap_or("").is_empty() {
                            meta["id"] = serde_json::Value::String(stem.clone());
                        }
                        out.push(meta);
                    }
                }
            }
        }
    }
    out
}

// 读取插件源码（启动加载 / 启用时执行用）
#[tauri::command]
fn read_plugin_source(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let safe = sanitize_theme_id(&id);
    let dir = plugins_dir(&app)?;
    let path = dir.join(format!("{}.js", safe));
    std::fs::read_to_string(&path).map_err(|e| format!("读取插件失败: {}", e))
}

// 删除插件
#[tauri::command]
fn delete_user_plugin(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let safe = sanitize_theme_id(&id);
    let dir = plugins_dir(&app)?;
    let path = dir.join(format!("{}.js", safe));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))?;
    }
    Ok(())
}

// ===== CIP 本地小程序（用户上传 .cip / .zip）=====
// 本地小程序存入「系统用户文件夹」：<app_config_dir>/cip/<id>/
//   Windows: %APPDATA%/<identifier>/cip
//   Linux  : $XDG_CONFIG_HOME/<identifier>/cip
// 包格式：.cip / .zip 都是 zip 容器，根目录需含 main.lua（或任一 .lua 作为入口）；
//         若文件本身不是合法 zip，则当作裸 Lua 源码直接作为 main.lua。
// 每个小程序目录内含 meta.json（id/name/version/permissions/entry/kind=local）。

// 取 cip 根目录（自动创建）
fn cip_base(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {}", e))?;
    let dir = base.join("cip");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建小程序目录失败: {}", e))?;
    Ok(dir)
}

// 生成不冲突的 id（基于文件名清洗；已存在则追加 _2/_3…）
fn make_cip_id(app: &tauri::AppHandle, stem: &str) -> Result<String, String> {
    let base = cip_base(app)?;
    let safe = sanitize_theme_id(stem);
    let mut candidate = safe.clone();
    let mut n = 2;
    while base.join(&candidate).exists() {
        candidate = format!("{}_{}", safe, n);
        n += 1;
    }
    Ok(candidate)
}

// 防 zip-slip：把压缩项名安全拼到目标目录
fn safe_join(dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let cleaned: String = name.replace('\\', "/");
    let mut out = dir.to_path_buf();
    for seg in cleaned.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            out.pop();
            continue;
        }
        out.push(seg);
    }
    Some(out)
}

// 解压 zip 字节到目录
fn extract_zip(bytes: &[u8], dir: &std::path::Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("不是有效的压缩包: {}", e))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩项失败: {}", e))?;
        let name = file.name().to_string();
        let outpath = match safe_join(dir, &name) {
            Some(p) => p,
            None => continue,
        };
        if file.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| format!("创建目录失败: {}", e))?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
        let mut out =
            std::fs::File::create(&outpath).map_err(|e| format!("写入文件失败: {}", e))?;
        std::io::copy(&mut file, &mut out).map_err(|e| format!("解压失败: {}", e))?;
    }
    Ok(())
}

// 在解压目录里定位入口 lua（优先 main.lua，否则首个 .lua）
fn find_entry_lua(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let main = dir.join("main.lua");
    if main.exists() {
        return Some(main);
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("lua") {
                found.push(p);
            }
        }
        found.sort();
        if let Some(f) = found.into_iter().next() {
            return Some(f);
        }
    }
    None
}

// 构建 meta.json（优先读包内 meta.json/manifest.json/cip.json，否则派生）
fn build_cip_meta(
    dir: &std::path::Path,
    id: &str,
    stem: &str,
    entry_rel: &str,
) -> serde_json::Value {
    for name in ["meta.json", "manifest.json", "cip.json"] {
        let p = dir.join(name);
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                let mut meta = v;
                meta["id"] = serde_json::json!(id);
                if meta["entry"].is_null() {
                    meta["entry"] = serde_json::json!(entry_rel);
                }
                if meta["name"].is_null()
                    || meta["name"].as_str().unwrap_or("").is_empty()
                {
                    meta["name"] = serde_json::json!(stem);
                }
                meta["kind"] = serde_json::json!("local");
                return meta;
            }
        }
    }
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    serde_json::json!({
        "id": id,
        "name": stem,
        "description": "",
        "version": "1.0.0",
        "permissions": [],
        "entry": entry_rel,
        "kind": "local",
        "created_at": created
    })
}

// 原生文件选择框挑选 .cip/.zip → 解包 → 写入 cip/<id>/ → 返回 meta
    // 仅桌面端：依赖阻塞式文件选择框
    #[cfg(desktop)]
    #[tauri::command]
    fn import_cip_app(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("CIP 小程序", &["cip", "zip"])
        .blocking_pick_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return Err("未选择文件".into()),
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("app")
        .to_string();

    let id = make_cip_id(&app, &stem)?;
    let dir = cip_base(&app)?.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建小程序目录失败: {}", e))?;

    // 先尝试作为 zip 解包；失败则当作裸 Lua 源码
    let is_zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).is_ok();
    let entry_rel: String;
    if is_zip {
        extract_zip(&bytes, &dir)?;
        let entry =
            find_entry_lua(&dir).ok_or_else(|| "压缩包内未找到 main.lua 或任何 .lua 入口".to_string())?;
        entry_rel = entry
            .strip_prefix(&dir)
            .unwrap_or(&entry)
            .to_string_lossy()
            .replace('\\', "/");
    } else {
        std::fs::write(dir.join("main.lua"), &bytes).map_err(|e| format!("写入脚本失败: {}", e))?;
        entry_rel = "main.lua".to_string();
    }

    let meta = build_cip_meta(&dir, &id, &stem, &entry_rel);
    std::fs::write(
        dir.join("meta.json"),
        serde_json::to_string_pretty(&meta).unwrap_or_default(),
    )
    .map_err(|e| format!("写入元数据失败: {}", e))?;
    Ok(meta)
}

// 列出已安装的本地小程序
#[tauri::command]
fn list_cip_apps(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Ok(base) = cip_base(&app) {
        if let Ok(entries) = std::fs::read_dir(base) {
            for e in entries.flatten() {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                let meta_path = p.join("meta.json");
                if let Ok(s) = std::fs::read_to_string(&meta_path) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

// 读取本地小程序入口脚本（按 meta.entry，缺省 main.lua）
#[tauri::command]
fn read_cip_app(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let safe = sanitize_theme_id(&id);
    let dir = cip_base(&app)?.join(safe);
    let mut entry = "main.lua".to_string();
    let meta_path = dir.join("meta.json");
    if let Ok(s) = std::fs::read_to_string(&meta_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(e) = v["entry"].as_str() {
                entry = e.to_string();
            }
        }
    }
    let script_path = dir.join(&entry);
    std::fs::read_to_string(&script_path).map_err(|e| format!("读取脚本失败: {}", e))
}

// 删除本地小程序
#[tauri::command]
fn delete_cip_app(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let safe = sanitize_theme_id(&id);
    let dir = cip_base(&app)?.join(safe);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {}", e))?;
    }
    Ok(())
}

// 最小 base64 编码（避免引入额外 crate）
fn b64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as usize;
        let b1 = if i + 1 < input.len() { input[i + 1] as usize } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] as usize } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[(n >> 18) & 63] as char);
        out.push(CHARS[(n >> 12) & 63] as char);
        out.push(if i + 1 < input.len() { CHARS[(n >> 6) & 63] as char } else { '=' });
        out.push(if i + 2 < input.len() { CHARS[n & 63] as char } else { '=' });
        i += 3;
    }
    out
}

fn mime_of(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "css" => "text/css",
        "js" => "application/javascript",
        "html" => "text/html",
        _ => "application/octet-stream",
    }
}

// 读取本地小程序包内资源（不含 .lua 脚本），返回 [{path, data_uri}]
fn collect_assets(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<serde_json::Value>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_assets(root, &p, out);
                continue;
            }
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "lua" {
                continue; // 只打包资源，不打包脚本
            }
            if let Ok(bytes) = std::fs::read(&p) {
                let rel = p
                    .strip_prefix(root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                let uri = format!("data:{};base64,{}", mime_of(&p), b64_encode(&bytes));
                out.push(serde_json::json!({ "path": rel, "data_uri": uri }));
            }
        }
    }
}

#[tauri::command]
fn read_cip_assets(app: tauri::AppHandle, id: String) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let safe = sanitize_theme_id(&id);
    let dir = match cip_base(&app) {
        Ok(d) => d.join(safe),
        Err(_) => return out,
    };
    collect_assets(&dir, &dir, &mut out);
    out
}

// 桌面端相机替代：弹文件框选图片，返回 data URI（取消则返回 null）
    // 仅桌面端：依赖阻塞式文件选择框
    #[cfg(desktop)]
    #[tauri::command]
    fn cip_pick_image(app: tauri::AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
        .blocking_pick_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return None,
    };
    let bytes = std::fs::read(&path).ok()?;
    let mime = mime_of(&path);
    Some(format!("data:{};base64,{}", mime, b64_encode(&bytes)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动自检：必须先于 Tauri 运行时初始化。
    // WebView2 / WebKitGTK 缺失时 Tauri 的对话框插件自身也无法工作，
    // 所以这一步用平台原生弹窗告知用户，发现致命问题会直接退出进程。
    #[cfg(desktop)]
    preflight::check();

    // 基础插件：跨平台（opener/http/notification/dialog 在 Android 上均受支持）
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    // 禁用浏览器级默认快捷键（Ctrl+P/F/G/J、Ctrl+Shift+I、F3、F7）：仅桌面端。
    // 跨平台走 flags + 自定义 shortcuts（Linux/macOS WebKit 层拦截）；
    // Windows 额外关闭 WebView2 的 browser_accelerator_keys，彻底掐掉 JS 拦不住的
    // 浏览器级组合键（Ctrl+P / Ctrl+Shift+I 等）。
    // 注意：browser_accelerator_keys(false) 会连同 F5 / Ctrl+R / Ctrl+Shift+R 刷新一起禁掉
    //（这些键 JS preventDefault 拦不住，只能这样兜底），刷新功能由前端 app.js keydown
    // 自行接管（location.reload()，登录态存 localStorage 可自动恢复），勿在 JS 里删掉那部分。
    #[cfg(desktop)]
    let builder = builder.plugin({
        let p = tauri_plugin_prevent_default::Builder::new()
            .with_flags(
                tauri_plugin_prevent_default::Flags::PRINT
                    | tauri_plugin_prevent_default::Flags::FIND
                    | tauri_plugin_prevent_default::Flags::DOWNLOADS
                    | tauri_plugin_prevent_default::Flags::DEV_TOOLS,
            )
            .shortcut(tauri_plugin_prevent_default::KeyboardShortcut::new("F3"))
            .shortcut(tauri_plugin_prevent_default::KeyboardShortcut::new("F7"))
            .shortcut(tauri_plugin_prevent_default::KeyboardShortcut::with_modifiers(
                "G",
                &[tauri_plugin_prevent_default::ModifierKey::CtrlKey],
            ));
        #[cfg(windows)]
        let p = p.platform(
            tauri_plugin_prevent_default::PlatformOptions::new().browser_accelerator_keys(false),
        );
        p.build()
    });

    // 单实例：仅桌面端（移动端无此概念，且该插件 API 为桌面专属）
    // 启动参数 -n / --new：强制启动一个新的窗口实例（跳过单实例注册，允许多开）
    #[cfg(desktop)]
    let force_new_window = std::env::args().any(|a| a == "-n" || a == "--new");
    #[cfg(desktop)]
    let builder = if force_new_window {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };

    // 拦截窗口关闭请求改为隐藏到托盘：仅桌面端
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
        }
    });

    // 命令注册：桌面端包含全部；移动端仅保留跨平台命令（桌面专属命令不参与编译）。
    // 注意：generate_handler! 返回不透明类型，不能直接赋给 let，必须就地调用 .invoke_handler()。
    let builder = {
        #[cfg(desktop)]
        {
            builder.invoke_handler(tauri::generate_handler![
                greet, toggle_devtools, minimize_window, toggle_maximize_window, close_window,
                is_window_maximized, notify_new_message, save_image, save_download, cancel_download,
                save_image_data, fetch_media, env_report, app_version, import_theme, list_user_themes,
                delete_user_theme, import_plugin, list_user_plugins, read_plugin_source, delete_user_plugin,
                import_cip_app, list_cip_apps, read_cip_app, delete_cip_app, read_cip_assets, cip_pick_image,
                save_text_file, open_text_file
            ])
        }
        #[cfg(not(desktop))]
        {
            builder.invoke_handler(tauri::generate_handler![
                greet, save_image, save_download, cancel_download, save_image_data, fetch_media,
                env_report, app_version, list_user_themes, delete_user_theme, list_user_plugins,
                read_plugin_source, delete_user_plugin, list_cip_apps, read_cip_app, delete_cip_app,
                read_cip_assets
            ])
        }
    };

    let run_result = builder
        .setup(|app| {
            // 托盘与菜单：仅桌面端
            #[cfg(desktop)]
            {
                // 托盘菜单：显示窗口 / 退出
                let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                TrayIconBuilder::with_id("main-tray")
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("OldChat For Kivotos")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        // 单击托盘图标显示窗口
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    // 自检放行后运行时仍然失败：多半是 WebView 组件损坏或被安全软件拦截。
    // release 构建带 windows_subsystem="windows"（无控制台），直接 panic 用户
    // 只会看到程序「闪一下就没了」，所以这里用原生弹窗兜底说明原因。
    if let Err(e) = run_result {
        #[cfg(desktop)]
        preflight::report_runtime_failure(&e.to_string());
        #[cfg(not(desktop))]
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
