use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

use rfd::FileDialog;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowCollectionBehavior, NSWindowTitleVisibility, NSWindowToolbarStyle};

const SETTINGS_FILE_NAME: &str = "settings.json";
#[derive(Default)]
struct Store {
    data: Map<String, Value>,
}

struct AppState {
    store: Mutex<Store>,
    settings_path: PathBuf,
    last_window_bounds_persist_at: Mutex<Option<Instant>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResponse {
    success: bool,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlwaysOnTopResponse {
    success: bool,
    always_on_top: bool,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderItem {
    name: String,
    path: String,
    original_path: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
}

impl FolderItem {
    fn directory(name: String, path: String) -> Self {
        Self {
            name,
            path,
            original_path: None,
            item_type: "directory".into(),
        }
    }

    fn file(name: String, path: String) -> Self {
        Self {
            name,
            path: path.clone(),
            original_path: Some(path),
            item_type: "file".into(),
        }
    }
}

fn default_settings() -> Map<String, Value> {
    let mut defaults = Map::new();
    defaults.insert(
        "windowBounds".into(),
        json!({
            "width": 1000,
            "height": 700,
            "x": Value::Null,
            "y": Value::Null
        }),
    );
    defaults.insert("defaultImageFolderPath".into(), json!(""));
    defaults.insert("mainMenuBackgroundPath".into(), json!(""));
    defaults.insert("mainMenuBackgroundChoice".into(), json!("solidColor"));
    defaults.insert("previewBackgroundPath".into(), json!(""));
    defaults.insert("previewBackgroundChoice".into(), json!("solidColor"));
    defaults.insert("gridColor".into(), json!("#FFFFFF"));
    defaults.insert("gridSize".into(), json!(8));
    defaults.insert("timeFormat".into(), json!("hours:minutes:seconds"));
    defaults.insert("isRandomPlayback".into(), json!(true));
    defaults.insert("isAlwaysOnTop".into(), json!(false));
    defaults.insert("isLibraryFilterMarkedEnabled".into(), json!(false));
    defaults.insert("isFilterMarkedEnabled".into(), json!(true));
    defaults.insert("isLightThemeEnabled".into(), json!(false));
    defaults.insert("isCountdownHidden".into(), json!(false));
    defaults.insert("imageMarks".into(), json!({}));
    defaults.insert("startupMode".into(), json!("lastUsedPath"));
    defaults.insert("mainMenuSelectedFolderPath".into(), json!(""));
    defaults.insert("language".into(), json!("zh-CN"));
    defaults
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    match path.parent() {
        Some(parent) => fs::create_dir_all(parent).map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

fn load_store(path: &Path) -> Result<Store, String> {
    let mut data = default_settings();
    if path.exists() {
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let loaded = serde_json::from_str::<Map<String, Value>>(&content).map_err(|error| error.to_string())?;
        data.extend(loaded);
    }
    Ok(Store { data })
}

fn persist_store(state: &AppState) -> Result<(), String> {
    let store = state.store.lock().map_err(|_| "failed to lock settings store".to_string())?;
    ensure_parent_dir(&state.settings_path)?;
    let content = serde_json::to_string_pretty(&store.data).map_err(|error| error.to_string())?;
    fs::write(&state.settings_path, content).map_err(|error| error.to_string())
}

fn with_store<T>(state: &AppState, f: impl FnOnce(&mut Map<String, Value>) -> Result<T, String>) -> Result<T, String> {
    let mut store = state.store.lock().map_err(|_| "failed to lock settings store".to_string())?;
    f(&mut store.data)
}

fn ok() -> CommandResponse {
    CommandResponse {
        success: true,
        message: None,
    }
}

fn fail(message: impl Into<String>) -> CommandResponse {
    CommandResponse {
        success: false,
        message: Some(message.into()),
    }
}

fn open_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(path)
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let parent = path.parent().unwrap_or(path);
        opener::open(parent).map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

fn image_extensions() -> &'static [&'static str] {
    &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg"]
}

fn update_window_bounds(state: &AppState, bounds: Value) -> Result<bool, String> {
    with_store(state, |data| {
        if data.get("windowBounds") == Some(&bounds) {
            return Ok(false);
        }

        data.insert("windowBounds".into(), bounds);
        Ok(true)
    })
}

fn persist_window_bounds_if_needed(state: &AppState, force: bool) -> Result<(), String> {
    let mut last_persist = state
        .last_window_bounds_persist_at
        .lock()
        .map_err(|_| "failed to lock window bounds persist state".to_string())?;
    let now = Instant::now();
    let should_persist = force
        || last_persist
            .map(|instant| now.duration_since(instant) >= Duration::from_millis(300))
            .unwrap_or(true);

    if should_persist {
        persist_store(state)?;
        *last_persist = Some(now);
    }

    Ok(())
}

fn current_window_bounds(state: &AppState) -> Option<Value> {
    let store = state.store.lock().ok()?;
    store.data.get("windowBounds").cloned()
}

fn save_image_mark_to_store(state: &AppState, file_path: &str, duration: i64) -> Result<(), String> {
    with_store(state, |data| {
        let marks = data
            .entry("imageMarks")
            .or_insert_with(|| Value::Object(Map::new()));
        let marks_object = marks
            .as_object_mut()
            .ok_or_else(|| "imageMarks store is corrupted".to_string())?;
        let entry = marks_object
            .entry(file_path.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let array = entry
            .as_array_mut()
            .ok_or_else(|| "mark entry is corrupted".to_string())?;
        array.push(json!({
            "duration": duration,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis() as i64
        }));
        Ok(())
    })?;
    persist_store(state)
}

fn clear_image_mark_from_store(state: &AppState, file_path: &str) -> Result<(), String> {
    with_store(state, |data| {
        let marks = data
            .entry("imageMarks")
            .or_insert_with(|| Value::Object(Map::new()));
        let marks_object = marks
            .as_object_mut()
            .ok_or_else(|| "imageMarks store is corrupted".to_string())?;
        marks_object.remove(file_path);
        Ok(())
    })?;
    persist_store(state)
}

fn get_image_marks_from_store(state: &AppState) -> Result<Value, String> {
    let store = state.store.lock().map_err(|_| "failed to lock settings store".to_string())?;
    Ok(store
        .data
        .get("imageMarks")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new())))
}

#[tauri::command]
fn load_setting(key: String, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.lock().map_err(|_| "failed to lock settings store".to_string())?;
    Ok(store.data.get(&key).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
fn load_settings(keys: Vec<String>, state: tauri::State<'_, AppState>) -> Result<Map<String, Value>, String> {
    let store = state.store.lock().map_err(|_| "failed to lock settings store".to_string())?;
    let mut values = Map::new();

    for key in keys {
        values.insert(key.clone(), store.data.get(&key).cloned().unwrap_or(Value::Null));
    }

    Ok(values)
}

#[tauri::command]
fn save_setting(key: String, value: Value, state: tauri::State<'_, AppState>) -> CommandResponse {
    let result = with_store(&state, |data| {
        if data.get(&key) == Some(&value) {
            return Ok(false);
        }
        data.insert(key, value);
        Ok(true)
    })
    .and_then(|did_change| {
        if did_change {
            persist_store(&state)?;
        }
        Ok(())
    });

    match result {
        Ok(_) => ok(),
        Err(error) => fail(error),
    }
}

#[tauri::command]
fn open_file_dialog() -> Option<String> {
    FileDialog::new()
        .add_filter("Images", image_extensions())
        .pick_file()
        .map(|path| path.display().to_string())
}

#[tauri::command]
fn open_folder_dialog(current_path: Option<String>) -> Option<String> {
    let dialog = match current_path {
        Some(path) if !path.is_empty() => FileDialog::new().set_directory(path),
        _ => FileDialog::new(),
    };
    dialog.pick_folder().map(|path| path.display().to_string())
}

#[tauri::command]
fn read_folder_images(folder_path: String) -> Vec<FolderItem> {
    let mut items = Vec::new();
    let Ok(directory) = fs::read_dir(&folder_path) else {
        return items;
    };

    for entry in directory {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if file_type.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            items.push(FolderItem::directory(name, path.display().to_string()));
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_lowercase();

        if image_extensions().contains(&extension.as_str()) {
            items.push(FolderItem::file(name, path.display().to_string()));
        }
    }

    items
}

#[tauri::command]
fn open_file_in_finder(file_path: String) -> CommandResponse {
    match open_in_file_manager(Path::new(&file_path)) {
        Ok(_) => ok(),
        Err(error) => fail(error),
    }
}

#[tauri::command]
fn open_file_in_default_app(file_path: String) -> CommandResponse {
    match opener::open(file_path) {
        Ok(_) => ok(),
        Err(error) => fail(error.to_string()),
    }
}

#[tauri::command]
fn save_image_mark(file_path: String, duration: i64, state: tauri::State<'_, AppState>) -> CommandResponse {
    if let Err(error) = save_image_mark_to_store(&state, &file_path, duration) {
        return fail(error);
    }
    ok()
}

#[tauri::command]
fn get_image_marks(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    get_image_marks_from_store(&state)
}

#[tauri::command]
fn clear_image_marks_for_path(file_path: String, state: tauri::State<'_, AppState>) -> CommandResponse {
    if let Err(error) = clear_image_mark_from_store(&state, &file_path) {
        return fail(error);
    }
    ok()
}

#[tauri::command]
fn set_always_on_top(always_on_top: bool, window: tauri::WebviewWindow) -> AlwaysOnTopResponse {
    match window.set_always_on_top(always_on_top) {
        Ok(_) => AlwaysOnTopResponse {
            success: true,
            always_on_top,
            message: None,
        },
        Err(error) => AlwaysOnTopResponse {
            success: false,
            always_on_top: window.is_always_on_top().unwrap_or(always_on_top),
            message: Some(error.to_string()),
        },
    }
}

#[cfg(target_os = "macos")]
fn set_macos_traffic_lights(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;

    unsafe {
        let window: &NSWindow = &*ns_window.cast();

        if let Some(button) = window.standardWindowButton(NSWindowButton::CloseButton) {
            button.setHidden(!visible);
        }
        if let Some(button) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) {
            button.setHidden(!visible);
        }
        if let Some(button) = window.standardWindowButton(NSWindowButton::ZoomButton) {
            button.setHidden(!visible);
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_window_appearance(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;

    unsafe {
        let window: &NSWindow = &*ns_window.cast();
        window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
        window.setTitlebarAppearsTransparent(true);
        window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::FullScreenPrimary
                | NSWindowCollectionBehavior::FullScreenAllowsTiling
                | NSWindowCollectionBehavior::Managed,
        );
    }

    Ok(())
}

#[tauri::command]
fn set_traffic_light_visibility(visible: bool, window: tauri::WebviewWindow) -> CommandResponse {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = set_macos_traffic_lights(&window, visible) {
            return fail(error);
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (visible, window);

    ok()
}

#[tauri::command]
fn open_external_link(url: String) -> CommandResponse {
    match opener::open(url) {
        Ok(_) => ok(),
        Err(error) => fail(error.to_string()),
    }
}

fn create_app_state(app: &AppHandle) -> Result<AppState, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let settings_path = config_dir.join(SETTINGS_FILE_NAME);
    let store = load_store(&settings_path)?;

    Ok(AppState {
        store: Mutex::new(store),
        settings_path,
        last_window_bounds_persist_at: Mutex::new(None),
    })
}

fn apply_saved_window_bounds(window: &tauri::WebviewWindow, state: &AppState) {
    let Some(bounds) = current_window_bounds(state) else {
        return;
    };

    let width = bounds.get("width").and_then(Value::as_f64).unwrap_or(1000.0) as u32;
    let height = bounds.get("height").and_then(Value::as_f64).unwrap_or(700.0) as u32;
    let _ = window.set_size(PhysicalSize::new(width, height));

    let x = bounds.get("x").and_then(Value::as_f64);
    let y = bounds.get("y").and_then(Value::as_f64);
    if let (Some(x), Some(y)) = (x, y) {
        let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
}

fn listen_for_window_bounds(window: &tauri::WebviewWindow, app_handle: AppHandle) {
    let window_label = window.label().to_string();
    let _ = window.on_window_event(move |event| {
        let state = app_handle.state::<AppState>();
        let current_bounds = current_window_bounds(&state).unwrap_or_else(|| {
            json!({
                "width": 1000,
                "height": 700,
                "x": Value::Null,
                "y": Value::Null
            })
        });
        let mut bounds = current_bounds.as_object().cloned().unwrap_or_default();

        match event {
            WindowEvent::Moved(position) => {
                bounds.insert("x".into(), json!(position.x));
                bounds.insert("y".into(), json!(position.y));
                if let Ok(true) = update_window_bounds(&state, Value::Object(bounds)) {
                    let _ = persist_window_bounds_if_needed(&state, false);
                }
            }
            WindowEvent::Resized(size) => {
                bounds.insert("width".into(), json!(size.width));
                bounds.insert("height".into(), json!(size.height));
                if let Ok(true) = update_window_bounds(&state, Value::Object(bounds)) {
                    let _ = persist_window_bounds_if_needed(&state, false);
                }
            }
            WindowEvent::CloseRequested { .. } => {
                let _ = persist_window_bounds_if_needed(&state, true);
                let _ = app_handle.emit(&format!("{window_label}:closing"), ());
            }
            _ => {}
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = create_app_state(&app.handle())?;
            app.manage(state);

            if let Some(window) = app.get_webview_window("main") {
                let app_state = app.state::<AppState>();
                apply_saved_window_bounds(&window, &app_state);
                #[cfg(target_os = "macos")]
                let _ = configure_macos_window_appearance(&window);
                if let Ok(Value::Bool(true)) = load_setting("isAlwaysOnTop".into(), app_state.clone()) {
                    let _ = window.set_always_on_top(true);
                }
                listen_for_window_bounds(&window, app.handle().clone());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_setting,
            load_settings,
            save_setting,
            open_file_dialog,
            open_folder_dialog,
            read_folder_images,
            open_file_in_finder,
            open_file_in_default_app,
            save_image_mark,
            get_image_marks,
            clear_image_marks_for_path,
            set_always_on_top,
            set_traffic_light_visibility,
            open_external_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
