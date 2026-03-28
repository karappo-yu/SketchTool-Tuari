use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, params_from_iter, Connection};
use serde::Serialize;

use super::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarkEntry {
    pub duration: i64,
    pub timestamp: i64,
}

fn open_db(state: &AppState) -> Result<Connection, String> {
    Connection::open(&state.db_path).map_err(|error| error.to_string())
}

pub fn init_db(state: &AppState) -> Result<(), String> {
    let connection = open_db(state)?;
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS image_marks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                duration INTEGER NOT NULL,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_image_marks_file_path ON image_marks(file_path);
            CREATE INDEX IF NOT EXISTS idx_image_marks_file_path_timestamp ON image_marks(file_path, timestamp DESC);
            ",
        )
        .map_err(|error| error.to_string())
}

pub fn save_image_mark_to_db(state: &AppState, file_path: &str, duration: i64) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as i64;
    let connection = open_db(state)?;
    connection
        .execute(
            "INSERT INTO image_marks (file_path, duration, timestamp) VALUES (?1, ?2, ?3)",
            params![file_path, duration, timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clear_image_mark_from_db(state: &AppState, file_path: &str) -> Result<(), String> {
    let connection = open_db(state)?;
    connection
        .execute("DELETE FROM image_marks WHERE file_path = ?1", params![file_path])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_marked_paths_set(state: &AppState, file_paths: &[String]) -> Result<HashSet<String>, String> {
    if file_paths.is_empty() {
        return Ok(HashSet::new());
    }

    let placeholders = (0..file_paths.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT DISTINCT file_path FROM image_marks WHERE file_path IN ({placeholders})");
    let connection = open_db(state)?;
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(file_paths.iter()), |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    let mut marked = HashSet::new();
    for row in rows {
        marked.insert(row.map_err(|error| error.to_string())?);
    }
    Ok(marked)
}

pub fn get_latest_marks_map(state: &AppState, file_paths: &[String]) -> Result<HashMap<String, MarkEntry>, String> {
    if file_paths.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = (0..file_paths.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "
        SELECT m.file_path, m.duration, m.timestamp
        FROM image_marks m
        INNER JOIN (
            SELECT file_path, MAX(timestamp) AS latest_timestamp
            FROM image_marks
            WHERE file_path IN ({placeholders})
            GROUP BY file_path
        ) latest
        ON m.file_path = latest.file_path AND m.timestamp = latest.latest_timestamp
        "
    );

    let connection = open_db(state)?;
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(file_paths.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                MarkEntry {
                    duration: row.get::<_, i64>(1)?,
                    timestamp: row.get::<_, i64>(2)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut latest_marks = HashMap::new();
    for row in rows {
        let (path, mark) = row.map_err(|error| error.to_string())?;
        latest_marks.insert(path, mark);
    }
    Ok(latest_marks)
}
