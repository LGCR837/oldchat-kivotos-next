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

// 弹出原生保存对话框，写入二进制数据
fn save_with_dialog(app: &tauri::AppHandle, data: &[u8]) -> Result<(), String> {
    let file_path = app.dialog().file()
        .add_filter("图片", &["jpg", "jpeg", "png", "gif", "webp", "bmp"])
        .blocking_save_file();

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

// 通过 URL 下载图片（HTTP / HTTPS）
#[tauri::command]
async fn save_image(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let response = reqwest::get(&url).await.map_err(|e| format!("下载失败: {}", e))?;
    let bytes = response.bytes().await.map_err(|e| format!("读取失败: {}", e))?;
    save_with_dialog(&app, &bytes)
}

// 直接保存二进制数据（blob URL 用 canvas 读出后传过来）
#[tauri::command]
async fn save_image_data(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    save_with_dialog(&app, &data)
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
        .invoke_handler(tauri::generate_handler![
            greet,
            toggle_devtools,
            minimize_window,
            toggle_maximize_window,
            close_window,
            is_window_maximized,
            notify_new_message,
            save_image,
            save_image_data,
            env_report
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
