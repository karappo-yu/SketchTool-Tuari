mod commands;
mod storage;

use serde_json::{Map, Number, Value};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

use crate::storage::AppState;

fn apply_saved_window_bounds(window: &tauri::WebviewWindow, state: &AppState) {
    let Some(bounds) = storage::current_window_bounds(state) else {
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
        let current_bounds = storage::current_window_bounds(&state).unwrap_or_else(|| {
            let mut map = Map::new();
            map.insert("width".into(), Value::Number(Number::from(1000)));
            map.insert("height".into(), Value::Number(Number::from(700)));
            map.insert("x".into(), Value::Null);
            map.insert("y".into(), Value::Null);
            Value::Object(map)
        });
        let mut bounds = current_bounds.as_object().cloned().unwrap_or_default();

        match event {
            WindowEvent::Moved(position) => {
                bounds.insert("x".into(), Value::Number(Number::from(position.x)));
                bounds.insert("y".into(), Value::Number(Number::from(position.y)));
                if let Ok(true) = storage::update_window_bounds(&state, Value::Object(bounds)) {
                    let _ = storage::persist_window_bounds_if_needed(&state, false);
                }
            }
            WindowEvent::Resized(size) => {
                bounds.insert("width".into(), Value::Number(Number::from(size.width)));
                bounds.insert("height".into(), Value::Number(Number::from(size.height)));
                if let Ok(true) = storage::update_window_bounds(&state, Value::Object(bounds)) {
                    let _ = storage::persist_window_bounds_if_needed(&state, false);
                }
            }
            WindowEvent::CloseRequested { .. } => {
                let _ = storage::persist_window_bounds_if_needed(&state, true);
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
            let state = storage::create_app_state(&app.handle())?;
            app.manage(state);

            if let Some(window) = app.get_webview_window("main") {
                let app_state = app.state::<AppState>();
                apply_saved_window_bounds(&window, &app_state);
                #[cfg(target_os = "macos")]
                let _ = commands::window::configure_macos_window_appearance(&window);
                if let Ok(Value::Bool(true)) = commands::settings::load_setting("isAlwaysOnTop".into(), app_state.clone()) {
                    let _ = window.set_always_on_top(true);
                }
                listen_for_window_bounds(&window, app.handle().clone());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::load_setting,
            commands::settings::load_settings,
            commands::settings::save_setting,
            commands::dialogs::open_file_dialog,
            commands::dialogs::open_folder_dialog,
            commands::filesystem::load_sketch_folder_data,
            commands::filesystem::get_folder_browser_items,
            commands::filesystem::get_latest_marks_for_paths,
            commands::playback::build_playback_plan,
            commands::playback::start_session,
            commands::playback::session_next,
            commands::playback::session_prev,
            commands::playback::session_toggle_pause,
            commands::playback::session_tick,
            commands::playback::end_session,
            commands::filesystem::is_directory,
            commands::filesystem::get_parent_path,
            commands::filesystem::open_file_in_finder,
            commands::filesystem::open_file_in_default_app,
            commands::marks::clear_image_marks_for_path,
            commands::marks::toggle_image_mark,
            commands::window::set_always_on_top,
            commands::window::set_traffic_light_visibility,
            commands::window::open_external_link,
            commands::window::set_decorations,
            commands::window::get_platform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
