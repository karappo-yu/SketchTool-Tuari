use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use super::AppState;

fn open_db(state: &AppState) -> Result<Connection, String> {
    Connection::open(&state.db_path).map_err(|error| error.to_string())
}

pub fn init_annotations_db(state: &AppState) -> Result<(), String> {
    let connection = open_db(state)?;
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS image_annotations (
                file_path TEXT PRIMARY KEY,
                strokes TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .map_err(|error| error.to_string())
}

pub fn load_image_annotations_from_db(state: &AppState, file_path: &str) -> Result<Option<String>, String> {
    let connection = open_db(state)?;
    let result = connection
        .query_row(
            "SELECT strokes FROM image_annotations WHERE file_path = ?1",
            params![file_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

pub fn save_image_annotations_to_db(state: &AppState, file_path: &str, strokes: &str) -> Result<(), String> {
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as i64;
    let connection = open_db(state)?;
    connection
        .execute(
            "
            INSERT INTO image_annotations (file_path, strokes, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(file_path) DO UPDATE SET strokes = excluded.strokes, updated_at = excluded.updated_at
            ",
            params![file_path, strokes, updated_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clear_image_annotations_from_db(state: &AppState, file_path: &str) -> Result<(), String> {
    let connection = open_db(state)?;
    connection
        .execute("DELETE FROM image_annotations WHERE file_path = ?1", params![file_path])
        .map_err(|error| error.to_string())?;
    Ok(())
}
