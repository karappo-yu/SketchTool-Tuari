use serde_json::{Map, Value};

use crate::storage::{self, AppState};

use super::common::{fail, ok, CommandResponse};

#[tauri::command]
pub fn load_setting(key: String, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    storage::load_setting_value(&state, key)
}

#[tauri::command]
pub fn load_settings(keys: Vec<String>, state: tauri::State<'_, AppState>) -> Result<Map<String, Value>, String> {
    storage::load_settings_values(&state, keys)
}

#[tauri::command]
pub fn save_setting(key: String, value: Value, state: tauri::State<'_, AppState>) -> CommandResponse {
    match storage::save_setting_value(&state, key, value) {
        Ok(_) => ok(),
        Err(error) => fail(error),
    }
}
