use serde::Serialize;

use crate::storage::{self, AppState, MarkEntry};

use super::common::{fail, ok, CommandResponse};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleMarkResponse {
    marked: bool,
    latest_mark: Option<MarkEntry>,
}

#[tauri::command]
pub fn clear_image_marks_for_path(file_path: String, state: tauri::State<'_, AppState>) -> CommandResponse {
    if let Err(error) = storage::clear_image_mark_from_db(&state, &file_path) {
        return fail(error);
    }
    ok()
}

#[tauri::command]
pub fn toggle_image_mark(
    file_path: String,
    duration: i64,
    state: tauri::State<'_, AppState>,
) -> Result<ToggleMarkResponse, String> {
    let existing = storage::get_latest_marks_map(&state, std::slice::from_ref(&file_path))?;
    if existing.contains_key(&file_path) {
        storage::clear_image_mark_from_db(&state, &file_path)?;
        return Ok(ToggleMarkResponse {
            marked: false,
            latest_mark: None,
        });
    }

    storage::save_image_mark_to_db(&state, &file_path, duration)?;
    let refreshed = storage::get_latest_marks_map(&state, std::slice::from_ref(&file_path))?;
    Ok(ToggleMarkResponse {
        marked: true,
        latest_mark: refreshed.get(&file_path).cloned(),
    })
}
