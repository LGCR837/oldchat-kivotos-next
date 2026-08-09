// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod preflight;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, FilePath};

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

// 当前应用版本：返回 tauri.conf.json 的 version 字段。
// CI 发布构建时（scripts/set-version.mjs）会把该字段临时注入为 Release tag（如 v6）；
// 本地开发（debug 构建）固定显示 DEV，方便区分构建来源。
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    if cfg!(debug_assertions) {
        "DEV".to_string()
    } else {
        app.package_info().version.to_string()
    }
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
// - 隐藏到托盘（不可见）：弹出系统通知
// - 最小化到任务栏：闪烁任务栏图标（Windows）
// - 正常显示：不通知
#[cfg(desktop)]
#[tauri::command]
fn notify_new_message(window: WebviewWindow, app: tauri::AppHandle, title: String, body: String) {
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    if !visible {
        // 隐藏到托盘：发送系统通知
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
    } else if minimized {
        // 最小化到任务栏：闪烁任务栏图标
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
fn save_with_dialog(
    app: &tauri::AppHandle,
    data: &[u8],
    filename: Option<&str>,
    filter: Option<(&str, &[&str])>,
) -> Result<(), String> {
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

// 通过 URL 下载图片（HTTP / HTTPS），可带请求头（媒体接口已加权鉴，需传 Authorization）
#[tauri::command]
async fn save_image(
    app: tauri::AppHandle,
    url: String,
    headers: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    let mut req = reqwest::Client::new().get(&url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    let response = req.send().await.map_err(|e| format!("下载失败: {}", e))?;
    let bytes = response.bytes().await.map_err(|e| format!("读取失败: {}", e))?;
    save_with_dialog(&app, &bytes, None, Some(("图片", &["jpg", "jpeg", "png", "gif", "webp", "bmp"])))
}

// 通用文件下载（文件消息；可带默认文件名与鉴权头，不限制扩展名）
#[tauri::command]
async fn save_download(
    app: tauri::AppHandle,
    url: String,
    filename: Option<String>,
    headers: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    let mut req = reqwest::Client::new().get(&url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    let response = req.send().await.map_err(|e| format!("下载失败: {}", e))?;
    let bytes = response.bytes().await.map_err(|e| format!("读取失败: {}", e))?;
    save_with_dialog(&app, &bytes, filename.as_deref(), None)
}

// 直接保存二进制数据（blob URL 用 canvas 读出后传过来）
#[tauri::command]
async fn save_image_data(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    save_with_dialog(&app, &data, None, None)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动自检：必须先于 Tauri 运行时初始化。
    // WebView2 / WebKitGTK 缺失时 Tauri 的对话框插件自身也无法工作，
    // 所以这一步用平台原生弹窗告知用户，发现致命问题会直接退出进程。
    #[cfg(desktop)]
    preflight::check();

    let run_result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // 单实例：防止重复启动（很多人关窗进托盘后忘了，会重复开好几个）。
        // 第二个实例启动时自动退出，并把已存在实例的主窗口调出来。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            greet,
            toggle_devtools,
            minimize_window,
            toggle_maximize_window,
            close_window,
            is_window_maximized,
            notify_new_message,
            save_image,
            save_download,
            save_image_data,
            env_report,
            app_version,
            import_theme,
            list_user_themes,
            delete_user_theme,
            import_plugin,
            list_user_plugins,
            read_plugin_source,
            delete_user_plugin
        ])
        // 拦截窗口关闭请求：改为隐藏到托盘
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
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
