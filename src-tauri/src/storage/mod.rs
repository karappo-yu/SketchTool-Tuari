mod marks;

use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

pub use marks::{
    clear_image_mark_from_db, get_latest_marks_map, get_marked_paths_set, init_db, save_image_mark_to_db, MarkEntry,
};

const SETTINGS_FILE_NAME: &str = "settings.toml";
const SQLITE_DB_FILE_NAME: &str = "app.db";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub width: u32,
    pub height: u32,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for WindowBounds {
    fn default() -> Self {
        Self {
            width: 1000,
            height: 700,
            x: None,
            y: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    window_bounds: WindowBounds,
    default_image_folder_path: String,
    main_menu_background_path: String,
    main_menu_background_choice: String,
    preview_background_path: String,
    preview_background_choice: String,
    grid_color: String,
    grid_size: i64,
    time_format: String,
    countdown_style: Option<String>,
    countdown_display_style: Option<String>,
    is_random_playback: bool,
    is_always_on_top: bool,
    is_library_filter_marked_enabled: bool,
    is_filter_marked_enabled: bool,
    is_light_theme_enabled: bool,
    is_countdown_hidden: bool,
    startup_mode: String,
    main_menu_selected_folder_path: String,
    language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            window_bounds: WindowBounds::default(),
            default_image_folder_path: String::new(),
            main_menu_background_path: String::new(),
            main_menu_background_choice: "solidColor".to_string(),
            preview_background_path: String::new(),
            preview_background_choice: "solidColor".to_string(),
            grid_color: "#FFFFFF".to_string(),
            grid_size: 8,
            time_format: "hours:minutes:seconds".to_string(),
            countdown_style: None,
            countdown_display_style: None,
            is_random_playback: true,
            is_always_on_top: false,
            is_library_filter_marked_enabled: false,
            is_filter_marked_enabled: true,
            is_light_theme_enabled: false,
            is_countdown_hidden: false,
            startup_mode: "lastUsedPath".to_string(),
            main_menu_selected_folder_path: String::new(),
            language: "zh-CN".to_string(),
        }
    }
}

pub struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    pub(super) db_path: PathBuf,
    last_window_bounds_persist_at: Mutex<Option<Instant>>,
}

fn persist_settings(state: &AppState) -> Result<(), String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings".to_string())?
        .clone();

    if let Some(parent) = state.settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let content = toml::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(&state.settings_path, content).map_err(|error| error.to_string())
}

pub fn create_app_state(app: &AppHandle) -> Result<AppState, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;

    let settings_path = config_dir.join(SETTINGS_FILE_NAME);
    let db_path = config_dir.join(SQLITE_DB_FILE_NAME);

    let settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|error| error.to_string())?;
        toml::from_str::<Settings>(&content).map_err(|error| error.to_string())?
    } else {
        Settings::default()
    };

    let state = AppState {
        settings: Mutex::new(settings),
        settings_path,
        db_path,
        last_window_bounds_persist_at: Mutex::new(None),
    };

    init_db(&state)?;
    persist_settings(&state)?;

    Ok(state)
}

fn get_setting_value(settings: &Settings, key: &str) -> Value {
    fn to_value<T: Serialize>(value: T) -> Value {
        serde_json::to_value(value).unwrap_or(Value::Null)
    }

    match key {
        "windowBounds" => to_value(settings.window_bounds.clone()),
        "defaultImageFolderPath" => to_value(settings.default_image_folder_path.clone()),
        "mainMenuBackgroundPath" => to_value(settings.main_menu_background_path.clone()),
        "mainMenuBackgroundChoice" => to_value(settings.main_menu_background_choice.clone()),
        "previewBackgroundPath" => to_value(settings.preview_background_path.clone()),
        "previewBackgroundChoice" => to_value(settings.preview_background_choice.clone()),
        "gridColor" => to_value(settings.grid_color.clone()),
        "gridSize" => to_value(settings.grid_size),
        "timeFormat" => to_value(settings.time_format.clone()),
        "countdownStyle" => settings
            .countdown_style
            .as_ref()
            .map(|v| to_value(v.clone()))
            .unwrap_or(Value::Null),
        "countdownDisplayStyle" => settings
            .countdown_display_style
            .as_ref()
            .map(|v| to_value(v.clone()))
            .unwrap_or(Value::Null),
        "isRandomPlayback" => to_value(settings.is_random_playback),
        "isAlwaysOnTop" => to_value(settings.is_always_on_top),
        "isLibraryFilterMarkedEnabled" => to_value(settings.is_library_filter_marked_enabled),
        "isFilterMarkedEnabled" => to_value(settings.is_filter_marked_enabled),
        "isLightThemeEnabled" => to_value(settings.is_light_theme_enabled),
        "isCountdownHidden" => to_value(settings.is_countdown_hidden),
        "startupMode" => to_value(settings.startup_mode.clone()),
        "mainMenuSelectedFolderPath" => to_value(settings.main_menu_selected_folder_path.clone()),
        "language" => to_value(settings.language.clone()),
        _ => Value::Null,
    }
}

fn apply_setting_value(settings: &mut Settings, key: &str, value: Value) -> Result<bool, String> {
    match key {
        "windowBounds" => {
            let next: WindowBounds = serde_json::from_value(value).map_err(|error| error.to_string())?;
            if settings.window_bounds.width == next.width
                && settings.window_bounds.height == next.height
                && settings.window_bounds.x == next.x
                && settings.window_bounds.y == next.y
            {
                return Ok(false);
            }
            settings.window_bounds = next;
            Ok(true)
        }
        "defaultImageFolderPath" => set_string(&mut settings.default_image_folder_path, value),
        "mainMenuBackgroundPath" => set_string(&mut settings.main_menu_background_path, value),
        "mainMenuBackgroundChoice" => set_string(&mut settings.main_menu_background_choice, value),
        "previewBackgroundPath" => set_string(&mut settings.preview_background_path, value),
        "previewBackgroundChoice" => set_string(&mut settings.preview_background_choice, value),
        "gridColor" => set_string(&mut settings.grid_color, value),
        "gridSize" => set_i64(&mut settings.grid_size, value),
        "timeFormat" => set_string(&mut settings.time_format, value),
        "countdownStyle" => set_optional_string(&mut settings.countdown_style, value),
        "countdownDisplayStyle" => set_optional_string(&mut settings.countdown_display_style, value),
        "isRandomPlayback" => set_bool(&mut settings.is_random_playback, value),
        "isAlwaysOnTop" => set_bool(&mut settings.is_always_on_top, value),
        "isLibraryFilterMarkedEnabled" => set_bool(&mut settings.is_library_filter_marked_enabled, value),
        "isFilterMarkedEnabled" => set_bool(&mut settings.is_filter_marked_enabled, value),
        "isLightThemeEnabled" => set_bool(&mut settings.is_light_theme_enabled, value),
        "isCountdownHidden" => set_bool(&mut settings.is_countdown_hidden, value),
        "startupMode" => set_string(&mut settings.startup_mode, value),
        "mainMenuSelectedFolderPath" => set_string(&mut settings.main_menu_selected_folder_path, value),
        "language" => set_string(&mut settings.language, value),
        _ => Ok(false),
    }
}

fn set_string(target: &mut String, value: Value) -> Result<bool, String> {
    let next = value.as_str().ok_or_else(|| "expected string".to_string())?.to_string();
    if *target == next {
        return Ok(false);
    }
    *target = next;
    Ok(true)
}

fn set_optional_string(target: &mut Option<String>, value: Value) -> Result<bool, String> {
    let next = if value.is_null() {
        None
    } else {
        Some(value.as_str().ok_or_else(|| "expected string or null".to_string())?.to_string())
    };

    if *target == next {
        return Ok(false);
    }

    *target = next;
    Ok(true)
}

fn set_i64(target: &mut i64, value: Value) -> Result<bool, String> {
    let next = value.as_i64().ok_or_else(|| "expected integer".to_string())?;
    if *target == next {
        return Ok(false);
    }
    *target = next;
    Ok(true)
}

fn set_bool(target: &mut bool, value: Value) -> Result<bool, String> {
    let next = value.as_bool().ok_or_else(|| "expected bool".to_string())?;
    if *target == next {
        return Ok(false);
    }
    *target = next;
    Ok(true)
}

pub fn load_setting_value(state: &AppState, key: String) -> Result<Value, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings".to_string())?;
    Ok(get_setting_value(&settings, &key))
}

pub fn load_settings_values(state: &AppState, keys: Vec<String>) -> Result<Map<String, Value>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings".to_string())?;

    let mut values = Map::new();
    for key in keys {
        values.insert(key.clone(), get_setting_value(&settings, &key));
    }

    Ok(values)
}

pub fn save_setting_value(state: &AppState, key: String, value: Value) -> Result<(), String> {
    let did_change = {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "failed to lock settings".to_string())?;
        apply_setting_value(&mut settings, &key, value)?
    };

    if did_change {
        persist_settings(state)?;
    }

    Ok(())
}

pub fn update_window_bounds(state: &AppState, bounds: Value) -> Result<bool, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings".to_string())?;
    apply_setting_value(&mut settings, "windowBounds", bounds)
}

pub fn persist_window_bounds_if_needed(state: &AppState, force: bool) -> Result<(), String> {
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
        persist_settings(state)?;
        *last_persist = Some(now);
    }

    Ok(())
}

pub fn current_window_bounds(state: &AppState) -> Option<Value> {
    let settings = state.settings.lock().ok()?;
    serde_json::to_value(settings.window_bounds.clone()).ok()
}

pub fn image_extensions() -> &'static [&'static str] {
    &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg"]
}
