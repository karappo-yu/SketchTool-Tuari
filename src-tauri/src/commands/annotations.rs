use serde_json::Value;

use crate::storage::{self, AppState};

use super::common::{fail, ok, CommandResponse};

#[tauri::command]
pub fn load_image_annotations(file_path: String, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    match storage::load_image_annotations_from_db(&state, &file_path) {
        Ok(Some(strokes_json)) => serde_json::from_str::<Value>(&strokes_json)
            .map_err(|error| format!("invalid annotations payload: {error}")),
        Ok(None) => Ok(Value::Array(Vec::new())),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn save_image_annotations(file_path: String, strokes: Value, state: tauri::State<'_, AppState>) -> CommandResponse {
    let strokes_json = match serde_json::to_string(&strokes) {
        Ok(json) => json,
        Err(error) => return fail(error.to_string()),
    };
    if let Err(error) = storage::save_image_annotations_to_db(&state, &file_path, &strokes_json) {
        return fail(error);
    }
    ok()
}

#[tauri::command]
pub fn clear_image_annotations(file_path: String, state: tauri::State<'_, AppState>) -> CommandResponse {
    if let Err(error) = storage::clear_image_annotations_from_db(&state, &file_path) {
        return fail(error);
    }
    ok()
}
