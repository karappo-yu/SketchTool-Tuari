use rfd::FileDialog;

use crate::storage;

#[tauri::command]
pub fn open_file_dialog() -> Option<String> {
    FileDialog::new()
        .add_filter("Images", storage::image_extensions())
        .pick_file()
        .map(|path| path.display().to_string())
}

#[tauri::command]
pub fn open_folder_dialog(current_path: Option<String>) -> Option<String> {
    let dialog = match current_path {
        Some(path) if !path.is_empty() => FileDialog::new().set_directory(path),
        _ => FileDialog::new(),
    };
    dialog.pick_folder().map(|path| path.display().to_string())
}
