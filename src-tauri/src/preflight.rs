//! 启动期环境自检（preflight）
//!
//! 在 Tauri 运行时初始化**之前**执行，用平台原生对话框告知用户环境问题。
//!
//! 为什么不用 `tauri-plugin-dialog`：那个插件依赖 Tauri 运行时（Windows 上依赖
//! WebView2、Linux 上依赖 GTK）。而本模块要处理的恰恰是「WebView2 没装」「GTK
//! 库缺失」这类场景 —— 此时插件自己也起不来。所以只能退回到 Win32 MessageBox /
//! zenity 这类不依赖 WebView 的原生机制。
//!
//! 分级策略：
//! - `Fatal`：缺了就跑不起来（如 WebView2 缺失）。弹窗 + 引导 + 退出进程。
//! - `Warn` ：能跑但功能受损（如 Linux 缺 appindicator 导致托盘不可用）。
//!            不打断启动，写 stderr 并缓存，供前端「关于」页展示。

use std::sync::OnceLock;

// ============================================================
// 数据结构
// ============================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Severity {
    /// 缺了就跑不起来：弹窗告知后退出
    Fatal,
    /// 能跑但功能受损：不打断启动
    Warn,
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub severity: Severity,
    pub title: String,
    pub message: String,
    /// 「去解决」按钮指向的地址；None 时弹窗只有一个确定按钮
    pub action_url: Option<String>,
    pub action_label: Option<String>,
}

impl Issue {
    fn fatal(title: &str, message: String) -> Self {
        Issue {
            severity: Severity::Fatal,
            title: title.to_string(),
            message,
            action_url: None,
            action_label: None,
        }
    }

    fn warn(title: &str, message: String) -> Self {
        Issue {
            severity: Severity::Warn,
            title: title.to_string(),
            message,
            action_url: None,
            action_label: None,
        }
    }

    // Linux 侧的问题都靠文案里的命令行提示解决，用不到跳转按钮
    #[allow(dead_code)]
    fn with_action(mut self, label: &str, url: &str) -> Self {
        self.action_label = Some(label.to_string());
        self.action_url = Some(url.to_string());
        self
    }
}

#[cfg(windows)]
const WEBVIEW2_DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// 非致命告警缓存，供 `env_report` 命令读取后在前端展示
static WARNINGS: OnceLock<Vec<Issue>> = OnceLock::new();

pub fn warnings() -> &'static [Issue] {
    WARNINGS.get().map(|v| v.as_slice()).unwrap_or(&[])
}

// ============================================================
// 入口
// ============================================================

/// 启动自检主流程。发现致命问题时弹窗并 **直接退出进程**，不会返回。
pub fn check() {
    apply_compat_env();

    // 自测入口：设置环境变量 OLDCHAT_PREFLIGHT_DEMO=<项> 可在环境正常的情况下
    // 强制弹出对应提示，用于验收文案与按钮行为。可用值见 demo_dialog。
    if let Some(demo) = std::env::var_os("OLDCHAT_PREFLIGHT_DEMO") {
        demo_dialog(&demo.to_string_lossy());
        std::process::exit(0);
    }

    let issues = collect_issues();

    if let Some(fatal) = issues.iter().find(|i| i.severity == Severity::Fatal) {
        eprintln!("[preflight][FATAL] {}: {}", fatal.title, fatal.message);
        show_fatal_dialog(fatal);
        std::process::exit(1);
    }

    let warns: Vec<Issue> = issues.into_iter().collect();
    for w in &warns {
        eprintln!("[preflight][warn] {}: {}", w.title, w.message);
    }
    let _ = WARNINGS.set(warns);
}

/// 自测：不破坏真实环境的前提下预览各类提示弹窗
fn demo_dialog(key: &str) {
    let issue = match key {
        #[cfg(windows)]
        "webview2" => issue_webview2_missing(),
        #[cfg(target_os = "linux")]
        "webkit" => issue_webkit_missing(),
        #[cfg(target_os = "linux")]
        "display" => issue_no_display(),
        "runtime" => {
            report_runtime_failure("demo: 模拟 WebView 初始化失败");
            return;
        }
        other => Issue::fatal(
            "环境自检自测",
            format!(
                "未识别的演示项：{other}\n\n可用值：\n  webview2  缺少 WebView2 运行时（Windows）\n  webkit    缺少 WebKitGTK（Linux）\n  display   无图形界面（Linux）\n  runtime   运行时初始化失败（通用）"
            ),
        ),
    };
    show_fatal_dialog(&issue);
}

/// Tauri 运行时启动失败时的兜底提示（例如 WebView2 已安装但损坏）
pub fn report_runtime_failure(detail: &str) {
    let issue = Issue::fatal(
        "OldChat 启动失败",
        format!(
            "应用窗口创建失败，通常是系统 WebView 组件损坏或被安全软件拦截。\n\n\
             可尝试：\n\
             1. 重新安装 WebView 运行时\n\
             2. 关闭杀毒软件 / 系统防护后重试\n\
             3. 以管理员身份运行\n\n\
             错误详情：\n{}",
            truncate(detail, 400)
        ),
    );
    eprintln!("[preflight][FATAL] runtime: {}", detail);
    show_fatal_dialog(&issue);
}

// ============================================================
// 检测项汇总
// ============================================================

fn collect_issues() -> Vec<Issue> {
    let mut issues = Vec::new();

    #[cfg(windows)]
    windows_checks(&mut issues);

    #[cfg(target_os = "linux")]
    linux_checks(&mut issues);

    // 致命项已存在时不必再做次要检查，避免刷屏
    if !issues.iter().any(|i| i.severity == Severity::Fatal) {
        check_data_dir_writable(&mut issues);
    }

    issues
}

/// 应用数据目录不可写 → localStorage / 缓存无法持久化
fn check_data_dir_writable(issues: &mut Vec<Issue>) {
    let dir = match app_data_dir() {
        Some(d) => d,
        None => {
            issues.push(Issue::warn(
                "无法定位用户数据目录",
                "系统未提供标准的用户数据目录，登录状态与设置可能无法保存。".to_string(),
            ));
            return;
        }
    };

    if std::fs::create_dir_all(&dir).is_err() {
        issues.push(Issue::warn(
            "用户数据目录不可写",
            format!(
                "无法创建目录 {}，登录状态、聊天缓存与设置将无法保存。\n请检查该路径的权限，或换一个有写入权限的账户运行。",
                dir.display()
            ),
        ));
        return;
    }

    let probe = dir.join(".oldchat-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
        }
        Err(e) => issues.push(Issue::warn(
            "用户数据目录不可写",
            format!(
                "目录 {} 存在但无法写入（{}）。登录状态与设置将无法保存。",
                dir.display(),
                e
            ),
        )),
    }
}

fn app_data_dir() -> Option<std::path::PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
            })
    }?;
    Some(base.join("aoharureverie.oldchat.kivotosnextapp"))
}

// ============================================================
// 兼容性环境变量
// ============================================================

/// 在 WebView 初始化前设置已知的兼容性开关。
/// 只在用户没有显式设置时才写入，避免覆盖用户的手动调优。
fn apply_compat_env() {
    #[cfg(target_os = "linux")]
    {
        // NVIDIA 专有驱动 + WebKitGTK 的 DMA-BUF 渲染路径存在长期兼容问题，
        // 典型症状是窗口全白 / 花屏。检测到 N 卡时关闭该渲染路径。
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && has_nvidia_driver() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            eprintln!("[preflight] 检测到 NVIDIA 驱动，已启用 WEBKIT_DISABLE_DMABUF_RENDERER=1 规避白屏");
        }
    }
}

#[cfg(target_os = "linux")]
fn has_nvidia_driver() -> bool {
    std::path::Path::new("/sys/module/nvidia").exists()
        || std::path::Path::new("/proc/driver/nvidia").exists()
}

// ============================================================
// Windows 检测
// ============================================================

#[cfg(windows)]
fn issue_webview2_missing() -> Issue {
    Issue::fatal(
        "缺少 Microsoft Edge WebView2 运行时",
        "OldChat For Kivotos 使用系统内置的 WebView2 组件渲染界面，但在本机未检测到它。\n\n\
         解决办法：\n\
         1. 点击下方「是」打开微软官网\n\
         2. 在页面中下载「Evergreen Bootstrapper」（常青版引导程序）\n\
         3. 运行下载的安装程序，完成后重新启动 OldChat\n\n\
         提示：安装包很小（约 2 MB），会自动联网获取所需组件。\n\
         如果本机无法联网，请在其他电脑下载「Evergreen Standalone Installer」离线安装包。"
            .to_string(),
    )
    .with_action("前往下载", WEBVIEW2_DOWNLOAD)
}

#[cfg(windows)]
fn windows_checks(issues: &mut Vec<Issue>) {
    // --- 系统版本 ---
    match windows_build_number() {
        Some(build) if build < 10240 => {
            issues.push(Issue::fatal(
                "系统版本过低",
                format!(
                    "OldChat For Kivotos 需要 Windows 10 或更高版本，当前系统内部版本号为 {}。\n\n\
                     Windows 7 / 8 / 8.1 已无法安装本程序所需的 WebView2 运行时，请升级系统。",
                    build
                ),
            ));
            return;
        }
        Some(build) if build < 17763 => {
            issues.push(Issue::warn(
                "系统版本偏低",
                format!(
                    "当前 Windows 内部版本号 {}，低于建议的 17763（1809）。部分界面效果（窗口圆角、亚克力背景）可能不可用。",
                    build
                ),
            ));
        }
        _ => {}
    }

    // --- WebView2 运行时 ---
    // 固定版本部署（fixed-version runtime）由该环境变量指定目录，既不写注册表、
    // 也不响应 GetAvailableCoreWebView2BrowserVersionString。这是官方支持的部署
    // 方式，直接豁免，否则会把企业内网用户误判成「没装」。
    if let Some(dir) = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        if !dir.is_empty() {
            eprintln!("[preflight] 使用固定版本 WebView2：{}", dir.to_string_lossy());
            return;
        }
    }

    // 双保险：优先信任运行时探测（最准确），失败时回落到注册表版本号。
    let rt_version = tauri::webview_version().ok();
    let reg_version = webview2_registry_version();

    if rt_version.is_none() && reg_version.is_none() {
        issues.push(issue_webview2_missing());
        return;
    }

    // 注册表写着装了、运行时却探测不到 —— 多半是安装损坏或被安全软件隔离
    if rt_version.is_none() {
        if let Some(v) = reg_version {
            issues.push(
                Issue::fatal(
                    "WebView2 运行时异常",
                    format!(
                        "系统注册表显示已安装 WebView2（版本 {}），但程序无法加载它。\n\n\
                         常见原因与处理：\n\
                         1. 安装损坏 —— 在「设置 → 应用」中修复或重装「Microsoft Edge WebView2 Runtime」\n\
                         2. 被杀毒软件隔离 —— 检查安全软件的隔离区并恢复\n\
                         3. 组件文件被清理工具删除 —— 点击下方「前往下载」重新安装",
                        v
                    ),
                )
                .with_action("前往下载", WEBVIEW2_DOWNLOAD),
            );
        }
    }
}

/// 读取 WebView2 运行时在注册表中登记的版本号。
/// 官方登记位置共三处（系统级 64 位机 / 系统级 32 位机 / 用户级）。
/// 值为空或 "0.0.0.0" 视为未安装。
#[cfg(windows)]
fn webview2_registry_version() -> Option<String> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let paths = [
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{CLIENT_GUID}"),
        ),
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{CLIENT_GUID}"),
        ),
        (
            HKEY_CURRENT_USER,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{CLIENT_GUID}"),
        ),
    ];

    for (root, sub) in paths {
        if let Some(v) = reg_read_string(root, &sub, "pv") {
            if !v.is_empty() && v != "0.0.0.0" {
                return Some(v);
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    reg_read_string(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
        "CurrentBuildNumber",
    )
    .and_then(|s| s.trim().parse::<u32>().ok())
}

/// 供 `env_report` 命令展示的系统版本字符串
#[cfg(windows)]
pub fn os_version_string() -> String {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    const KEY: &str = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    let name = reg_read_string(HKEY_LOCAL_MACHINE, KEY, "ProductName")
        .unwrap_or_else(|| "Windows".to_string());
    let build = windows_build_number();
    // Win11 仍把 ProductName 写成 "Windows 10 ..."，靠内部版本号纠正
    let name = match build {
        Some(b) if b >= 22000 => name.replace("Windows 10", "Windows 11"),
        _ => name,
    };
    match build {
        Some(b) => format!("{} (build {})", name, b),
        None => name,
    }
}

#[cfg(windows)]
fn reg_read_string(root: windows_sys::Win32::System::Registry::HKEY, subkey: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};

    let sub_w = wide(subkey);
    let val_w = wide(value);
    let mut size: u32 = 0;

    unsafe {
        // 第一次调用只为拿到所需字节数
        let rc = RegGetValueW(
            root,
            sub_w.as_ptr(),
            val_w.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        );
        if rc != 0 || size == 0 {
            return None;
        }

        let mut buf = vec![0u16; size as usize / 2 + 1];
        let rc = RegGetValueW(
            root,
            sub_w.as_ptr(),
            val_w.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            &mut size,
        );
        if rc != 0 {
            return None;
        }

        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// ============================================================
// Linux 检测
// ============================================================

#[cfg(target_os = "linux")]
fn issue_no_display() -> Issue {
    Issue::fatal(
        "未检测到图形界面",
        "OldChat For Kivotos 是桌面图形程序，需要在桌面环境中运行。\n\n\
         当前环境既没有 DISPLAY（X11）也没有 WAYLAND_DISPLAY（Wayland）变量。\n\n\
         如果你是通过 SSH 连接的远程主机，请改用带 X11 转发的连接方式：\n\
             ssh -X 用户名@主机\n\
         或者直接在目标机器的桌面上启动本程序。"
            .to_string(),
    )
}

#[cfg(target_os = "linux")]
fn issue_webkit_missing() -> Issue {
    Issue::fatal(
        "缺少 WebKitGTK 运行库",
        format!(
            "OldChat For Kivotos 使用 WebKitGTK 渲染界面，但在本机未找到该运行库。\n\n\
             请在终端执行以下命令安装：\n\n    {}\n\n\
             安装完成后重新启动本程序。",
            webkit_install_cmd()
        ),
    )
}

#[cfg(target_os = "linux")]
fn linux_checks(issues: &mut Vec<Issue>) {
    // --- 图形环境 ---
    let has_x11 = std::env::var("DISPLAY").map(|v| !v.is_empty()).unwrap_or(false);
    let has_wayland = std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    if !has_x11 && !has_wayland {
        issues.push(issue_no_display());
        return;
    }

    // --- WebKitGTK ---
    // 注：多数情况下 so 缺失会在动态链接阶段就让进程无法启动（用户看到的是
    // ld.so 的英文报错）。这里的检测覆盖延迟绑定 / AppImage 等仍能进到 main 的场景。
    if tauri::webview_version().is_err()
        && !has_lib(&["libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"])
    {
        issues.push(issue_webkit_missing());
        return;
    }

    // --- 托盘图标依赖 ---
    // 本程序关闭窗口 = 隐藏到托盘，托盘不可用会导致窗口「找不回来」，
    // 所以这条警告必须把后果讲清楚。
    if !has_lib(&[
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
    ]) {
        issues.push(Issue::warn(
            "缺少托盘图标运行库",
            format!(
                "未找到 AppIndicator 库，系统托盘图标可能无法显示。\n\
                 注意：本程序点击关闭按钮是「隐藏到托盘」，托盘不可用时将无法重新唤出窗口（可用任务栏或 Alt+Tab 切回）。\n\n\
                 建议安装：{}",
                appindicator_install_cmd()
            ),
        ));
    }
}

/// 在常见库目录中查找任一候选 so 文件
#[cfg(target_os = "linux")]
fn has_lib(names: &[&str]) -> bool {
    const DIRS: &[&str] = &[
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/usr/lib64",
        "/usr/lib",
        "/usr/local/lib",
        "/lib/x86_64-linux-gnu",
        "/lib64",
    ];
    // LD_LIBRARY_PATH 优先（AppImage / 便携部署会用到）
    let extra: Vec<String> = std::env::var("LD_LIBRARY_PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    extra
        .iter()
        .map(|s| s.as_str())
        .chain(DIRS.iter().copied())
        .any(|dir| {
            names
                .iter()
                .any(|n| std::path::Path::new(dir).join(n).exists())
        })
}

/// 读取 /etc/os-release 的 ID 与 ID_LIKE，用于给出对应发行版的安装命令
#[cfg(target_os = "linux")]
fn distro_hint() -> String {
    let content = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let mut out = String::new();
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("ID=").or_else(|| line.strip_prefix("ID_LIKE=")) {
            out.push_str(&v.trim_matches('"').to_lowercase());
            out.push(' ');
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn webkit_install_cmd() -> &'static str {
    let d = distro_hint();
    if d.contains("debian") || d.contains("ubuntu") {
        "sudo apt install libwebkit2gtk-4.1-0"
    } else if d.contains("fedora") || d.contains("rhel") || d.contains("centos") {
        "sudo dnf install webkit2gtk4.1"
    } else if d.contains("arch") {
        "sudo pacman -S webkit2gtk-4.1"
    } else if d.contains("suse") {
        "sudo zypper install libwebkit2gtk-4_1-0"
    } else if d.contains("alpine") {
        "sudo apk add webkit2gtk-4.1"
    } else {
        "用你的发行版包管理器安装 webkit2gtk 4.1 运行库"
    }
}

#[cfg(target_os = "linux")]
fn appindicator_install_cmd() -> &'static str {
    let d = distro_hint();
    if d.contains("debian") || d.contains("ubuntu") {
        "sudo apt install libayatana-appindicator3-1"
    } else if d.contains("fedora") || d.contains("rhel") || d.contains("centos") {
        "sudo dnf install libappindicator-gtk3"
    } else if d.contains("arch") {
        "sudo pacman -S libayatana-appindicator"
    } else if d.contains("suse") {
        "sudo zypper install libayatana-appindicator3-1"
    } else {
        "用你的发行版包管理器安装 libayatana-appindicator3"
    }
}

#[cfg(target_os = "linux")]
pub fn os_version_string() -> String {
    let content = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
            return v.trim_matches('"').to_string();
        }
    }
    "Linux".to_string()
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn os_version_string() -> String {
    std::env::consts::OS.to_string()
}

// ============================================================
// 原生弹窗
// ============================================================

fn show_fatal_dialog(issue: &Issue) {
    #[cfg(windows)]
    {
        windows_message_box(issue);
    }

    #[cfg(target_os = "linux")]
    {
        linux_message_box(issue);
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    {
        eprintln!("\n=== {} ===\n{}\n", issue.title, issue.message);
    }
}

#[cfg(windows)]
fn windows_message_box(issue: &Issue) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL, MB_YESNO,
    };

    let has_action = issue.action_url.is_some();
    let body = if has_action {
        format!(
            "{}\n\n是否现在打开下载页面？",
            issue.message
        )
    } else {
        issue.message.clone()
    };

    let text = wide(&body);
    let caption = wide(&issue.title);
    let style = MB_ICONERROR | MB_SETFOREGROUND | MB_SYSTEMMODAL | if has_action { MB_YESNO } else { MB_OK };

    let result = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), style) };

    if has_action && result == IDYES {
        if let Some(url) = &issue.action_url {
            open_url(url);
        }
    }
}

#[cfg(windows)]
fn open_url(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op = wide("open");
    let file = wide(url);
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Linux 下没有统一的原生弹窗 API，按可用性依次降级：
/// zenity → kdialog → xmessage → stderr
#[cfg(target_os = "linux")]
fn linux_message_box(issue: &Issue) {
    use std::process::Command;

    let has_action = issue.action_url.is_some();
    let action_label = issue.action_label.clone().unwrap_or_else(|| "打开帮助".to_string());

    // zenity：--question 才能带两个按钮
    if which("zenity") {
        let mut cmd = Command::new("zenity");
        if has_action {
            cmd.arg("--question")
                .arg("--ok-label")
                .arg(&action_label)
                .arg("--cancel-label")
                .arg("退出");
        } else {
            cmd.arg("--error");
        }
        cmd.arg("--title")
            .arg(&issue.title)
            .arg("--width")
            .arg("520")
            .arg("--text")
            .arg(escape_pango(&issue.message));

        if let Ok(status) = cmd.status() {
            if has_action && status.success() {
                if let Some(url) = &issue.action_url {
                    open_url(url);
                }
            }
            return;
        }
    }

    if which("kdialog") {
        let mut cmd = Command::new("kdialog");
        cmd.arg("--title").arg(&issue.title);
        if has_action {
            cmd.arg("--warningyesno").arg(&issue.message);
        } else {
            cmd.arg("--error").arg(&issue.message);
        }
        if let Ok(status) = cmd.status() {
            if has_action && status.success() {
                if let Some(url) = &issue.action_url {
                    open_url(url);
                }
            }
            return;
        }
    }

    if which("xmessage") {
        let text = format!("{}\n\n{}", issue.title, issue.message);
        if Command::new("xmessage")
            .arg("-center")
            .arg("-buttons")
            .arg("确定")
            .arg(text)
            .status()
            .is_ok()
        {
            return;
        }
    }

    // 全都没有：至少让终端里能看到完整信息
    eprintln!("\n=== {} ===\n{}\n", issue.title, issue.message);
    if let Some(url) = &issue.action_url {
        eprintln!("参考链接：{}\n", url);
    }
}

#[cfg(target_os = "linux")]
fn open_url(url: &str) {
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

#[cfg(target_os = "linux")]
fn which(bin: &str) -> bool {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|p| !p.is_empty())
        .any(|p| std::path::Path::new(p).join(bin).exists())
}

/// zenity 的 --text 默认按 Pango 标记解析，需要转义尖括号与 &
#[cfg(target_os = "linux")]
fn escape_pango(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// ============================================================
// 工具
// ============================================================

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{}…", cut)
}
