use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;

#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
#[cfg(windows)]
use windows::Win32::Foundation::POINT;

// 设置结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub screen_height_ratio: f64,
    pub padding: i32,
    pub fps_limit: i32,
    pub drag_w_ratio: f64,
    pub drag_h_ratio: f64,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub character_setting: String,  // 角色设定
    pub reply_format: String,       // 回复格式
}

// 注意：这里的默认值应与 src/settingsStore.ts 中的 DEFAULT_SETTINGS 保持一致
// 由于 characterSetting 和 replyFormat 内容较长，实际默认值以 TypeScript 端为准
// Rust 端仅在设置文件不存在时使用这些值作为初始值
impl Default for Settings {
    fn default() -> Self {
        Self {
            screen_height_ratio: 0.4,
            padding: 20,
            fps_limit: 30,
            drag_w_ratio: 0.4,
            drag_h_ratio: 0.9,
            llm_base_url: "https://api.openai.com/v1".to_string(),
            llm_api_key: String::new(),
            llm_model: "gpt-4o-mini".to_string(),
            // 以下两个字段的完整默认值在 settingsStore.ts 中定义
            // 这里使用空字符串，前端会检测并使用 TypeScript 的默认值
            character_setting: String::new(),
            reply_format: String::new(),
        }
    }
}

// 全局设置状态
struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
}

// 获取设置文件路径
fn get_settings_path(app: &tauri::AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    fs::create_dir_all(&app_dir).ok();
    app_dir.join("settings.json")
}

// 从文件加载设置
fn load_settings_from_file(path: &PathBuf) -> Settings {
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(settings) = serde_json::from_str(&content) {
                return settings;
            }
        }
    }
    Settings::default()
}

// 保存设置到文件
fn save_settings_to_file(path: &PathBuf, settings: &Settings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

// 获取设置命令
#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

// 保存设置命令
#[tauri::command]
fn save_settings(state: tauri::State<AppState>, settings: Settings) -> Result<(), String> {
    let mut current = state.settings.lock().unwrap();
    *current = settings.clone();
    save_settings_to_file(&state.settings_path, &settings)
}

// 设置窗口是否忽略鼠标事件（点击穿透）
#[tauri::command]
fn set_ignore_cursor_events(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

// 获取全局鼠标位置（屏幕坐标）
#[tauri::command]
fn get_cursor_position() -> Result<(i32, i32), String> {
    #[cfg(windows)]
    {
        let mut point = POINT::default();
        unsafe {
            GetCursorPos(&mut point).map_err(|e| e.to_string())?;
        }
        Ok((point.x, point.y))
    }
    #[cfg(not(windows))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![set_ignore_cursor_events, get_cursor_position, get_settings, save_settings])
        .setup(|app| {
            // 初始化设置
            let settings_path = get_settings_path(app.handle());
            let settings = load_settings_from_file(&settings_path);
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
            });
            
            // 创建托盘菜单
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

            // 创建托盘图标
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Spine Pet")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "settings" => {
                        // 检查设置窗口是否已存在
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            // 创建新的设置窗口
                            let _ = WebviewWindowBuilder::new(
                                app,
                                "settings",
                                WebviewUrl::App("settings.html".into()),
                            )
                            .title("设置")
                            .inner_size(450.0, 680.0)
                            .resizable(false)
                            .center()
                            .build();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
