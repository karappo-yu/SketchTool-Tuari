use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    process::Command,
};

use serde::Serialize;

use crate::storage::{self, AppState, MarkEntry};

use super::common::{fail, ok, CommandResponse};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderItem {
    name: String,
    path: String,
    original_path: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
}

impl FolderItem {
    pub fn file(name: String, path: String) -> Self {
        Self {
            name,
            path: path.clone(),
            original_path: Some(path),
            item_type: "file".into(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderBrowserItem {
    name: String,
    path: String,
    original_path: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
    latest_mark: Option<MarkEntry>,
    is_completed: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderBrowserItemsResponse {
    pub items: Vec<FolderBrowserItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchFolderDataResponse {
    pub files: Vec<FolderItem>,
    pub latest_marks: HashMap<String, MarkEntry>,
    pub eligible_indexes: Vec<usize>,
}

fn is_supported_image(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_lowercase();
    storage::image_extensions().contains(&extension.as_str())
}

fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

fn natural_compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();

    loop {
        match (left.peek(), right.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(lc), Some(rc)) => {
                let left_is_digit = lc.is_ascii_digit();
                let right_is_digit = rc.is_ascii_digit();

                if left_is_digit && right_is_digit {
                    let mut l_num = String::new();
                    let mut r_num = String::new();

                    while let Some(ch) = left.peek().copied() {
                        if !ch.is_ascii_digit() {
                            break;
                        }
                        l_num.push(ch);
                        left.next();
                    }
                    while let Some(ch) = right.peek().copied() {
                        if !ch.is_ascii_digit() {
                            break;
                        }
                        r_num.push(ch);
                        right.next();
                    }

                    let l_trimmed = l_num.trim_start_matches('0');
                    let r_trimmed = r_num.trim_start_matches('0');
                    let l_norm = if l_trimmed.is_empty() { "0" } else { l_trimmed };
                    let r_norm = if r_trimmed.is_empty() { "0" } else { r_trimmed };
                    let cmp_len = l_norm.len().cmp(&r_norm.len());
                    if cmp_len != std::cmp::Ordering::Equal {
                        return cmp_len;
                    }
                    let cmp_num = l_norm.cmp(r_norm);
                    if cmp_num != std::cmp::Ordering::Equal {
                        return cmp_num;
                    }

                    let cmp_raw_len = l_num.len().cmp(&r_num.len());
                    if cmp_raw_len != std::cmp::Ordering::Equal {
                        return cmp_raw_len;
                    }
                    continue;
                }

                let mut l_text = String::new();
                let mut r_text = String::new();
                while let Some(ch) = left.peek().copied() {
                    if ch.is_ascii_digit() {
                        break;
                    }
                    l_text.push(ch);
                    left.next();
                }
                while let Some(ch) = right.peek().copied() {
                    if ch.is_ascii_digit() {
                        break;
                    }
                    r_text.push(ch);
                    right.next();
                }

                let l_lower = l_text.to_lowercase();
                let r_lower = r_text.to_lowercase();
                let cmp = l_lower.cmp(&r_lower);
                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
            }
        }
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

#[tauri::command]
pub fn load_sketch_folder_data(
    folder_path: String,
    filter_marked: bool,
    state: tauri::State<'_, AppState>,
) -> Result<SketchFolderDataResponse, String> {
    let directory = fs::read_dir(&folder_path).map_err(|error| error.to_string())?;
    let mut files: Vec<(String, String)> = Vec::new();

    for entry in directory {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_file() {
            continue;
        }

        let path = entry.path();
        if !is_supported_image(&path) {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        files.push((name, path.display().to_string()));
    }

    files.sort_by(|a, b| natural_compare_names(&a.0, &b.0));
    let file_paths = files.iter().map(|(_, path)| path.clone()).collect::<Vec<_>>();
    let latest_marks = storage::get_latest_marks_map(&state, &file_paths)?;

    let marked_set = if filter_marked {
        storage::get_marked_paths_set(&state, &file_paths)?
    } else {
        HashSet::new()
    };
    let eligible_indexes = files
        .iter()
        .enumerate()
        .filter_map(|(index, (_, path))| {
            if filter_marked && marked_set.contains(path) {
                return None;
            }
            Some(index)
        })
        .collect::<Vec<_>>();

    let files = files
        .into_iter()
        .map(|(name, path)| FolderItem::file(name, path))
        .collect::<Vec<_>>();

    Ok(SketchFolderDataResponse {
        files,
        latest_marks,
        eligible_indexes,
    })
}

#[tauri::command]
pub fn get_folder_browser_items(
    folder_path: String,
    filter_marked: bool,
    state: tauri::State<'_, AppState>,
) -> Result<FolderBrowserItemsResponse, String> {
    let directory = fs::read_dir(&folder_path).map_err(|error| error.to_string())?;

    let mut directories: Vec<(String, String)> = Vec::new();
    let mut files: Vec<(String, String)> = Vec::new();

    for entry in directory {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if file_type.is_dir() {
            if !name.starts_with('.') {
                directories.push((name, path.display().to_string()));
            }
            continue;
        }

        if file_type.is_file() && is_supported_image(&path) {
            files.push((name, path.display().to_string()));
        }
    }

    let file_paths = files.iter().map(|(_, path)| path.clone()).collect::<Vec<_>>();
    let marked_set = storage::get_marked_paths_set(&state, &file_paths)?;
    let filtered_files = if filter_marked {
        files
            .into_iter()
            .filter(|(_, path)| !marked_set.contains(path))
            .collect::<Vec<_>>()
    } else {
        files
    };

    let filtered_file_paths = filtered_files
        .iter()
        .map(|(_, path)| path.clone())
        .collect::<Vec<_>>();
    let latest_marks = storage::get_latest_marks_map(&state, &filtered_file_paths)?;

    let mut directory_items = Vec::new();
    for (name, path) in directories {
        let mut direct_images = Vec::new();
        if let Ok(entries) = fs::read_dir(&path) {
            for child in entries.flatten() {
                if let Ok(child_type) = child.file_type() {
                    if child_type.is_file() && is_supported_image(&child.path()) {
                        direct_images.push(child.path().display().to_string());
                    }
                }
            }
        }

        let completed = if direct_images.is_empty() {
            false
        } else {
            let direct_marked = storage::get_marked_paths_set(&state, &direct_images)?;
            direct_images.iter().all(|file_path| direct_marked.contains(file_path))
        };

        directory_items.push(FolderBrowserItem {
            name,
            path,
            original_path: None,
            item_type: "directory".into(),
            latest_mark: None,
            is_completed: Some(completed),
        });
    }

    let mut file_items = filtered_files
        .into_iter()
        .map(|(name, path)| FolderBrowserItem {
            name,
            path: path.clone(),
            original_path: Some(path.clone()),
            item_type: "file".into(),
            latest_mark: latest_marks.get(&path).cloned(),
            is_completed: None,
        })
        .collect::<Vec<_>>();

    directory_items.sort_by(|a, b| compare_names(&a.name, &b.name));
    file_items.sort_by(|a, b| compare_names(&a.name, &b.name));

    let mut items = Vec::with_capacity(directory_items.len() + file_items.len());
    items.extend(directory_items);
    items.extend(file_items);

    Ok(FolderBrowserItemsResponse { items })
}

#[tauri::command]
pub fn get_latest_marks_for_paths(
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, MarkEntry>, String> {
    storage::get_latest_marks_map(&state, &file_paths)
}

#[tauri::command]
pub fn is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn get_parent_path(path: String) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let normalized = path.trim_end_matches(['/', '\\']);
    let path_obj = Path::new(normalized);
    let parent = path_obj.parent()?;
    let parent_str = parent.to_string_lossy().to_string();
    if parent_str.is_empty() {
        return None;
    }
    Some(parent_str)
}

#[tauri::command]
pub fn open_file_in_finder(file_path: String) -> CommandResponse {
    match open_in_file_manager(Path::new(&file_path)) {
        Ok(_) => ok(),
        Err(error) => fail(error),
    }
}

#[tauri::command]
pub fn open_file_in_default_app(file_path: String) -> CommandResponse {
    match opener::open(file_path) {
        Ok(_) => ok(),
        Err(error) => fail(error.to_string()),
    }
}
