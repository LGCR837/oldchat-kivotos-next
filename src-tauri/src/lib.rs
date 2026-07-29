// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::{Manager, WebviewWindow};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![greet, toggle_devtools])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
