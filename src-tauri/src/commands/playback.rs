use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

use rand::seq::SliceRandom;
use rand::thread_rng;
use serde::Serialize;

use crate::storage::{self, AppState, MarkEntry};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPlanResponse {
    eligible_indexes: Vec<usize>,
    playback_queue: Vec<usize>,
    target_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    current_image_index: Option<usize>,
    remaining_time: Option<i64>,
    is_playing: bool,
    is_paused: bool,
    has_prev: bool,
    has_next: bool,
    marked_path: Option<String>,
    latest_mark: Option<MarkEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionResponse {
    eligible_indexes: Vec<usize>,
    playback_queue: Vec<usize>,
    snapshot: SessionSnapshot,
}

#[derive(Default)]
struct SessionEngine {
    image_paths: Vec<String>,
    queue: Vec<usize>,
    history: Vec<usize>,
    pointer: Option<usize>,
    display_time: Option<i64>,
    remaining_time: Option<i64>,
    is_playing: bool,
    is_paused: bool,
}

static SESSION_ENGINE: OnceLock<Mutex<SessionEngine>> = OnceLock::new();

fn session_engine() -> &'static Mutex<SessionEngine> {
    SESSION_ENGINE.get_or_init(|| Mutex::new(SessionEngine::default()))
}

fn current_queue_index(engine: &SessionEngine) -> Option<usize> {
    let current = engine.pointer.and_then(|pointer| engine.history.get(pointer)).copied()?;
    engine.queue.iter().position(|index| *index == current)
}

fn to_snapshot(engine: &SessionEngine, marked_path: Option<String>, latest_mark: Option<MarkEntry>) -> SessionSnapshot {
    let current = engine.pointer.and_then(|pointer| engine.history.get(pointer)).copied();
    let has_prev = engine.pointer.map(|pointer| pointer > 0).unwrap_or(false);
    let has_next = match (engine.is_playing, current_queue_index(engine)) {
        (true, Some(index)) => index + 1 < engine.queue.len(),
        _ => false,
    };

    SessionSnapshot {
        current_image_index: current,
        remaining_time: engine.remaining_time,
        is_playing: engine.is_playing,
        is_paused: engine.is_paused,
        has_prev,
        has_next,
        marked_path,
        latest_mark,
    }
}

#[tauri::command]
pub fn build_playback_plan(
    image_paths: Vec<String>,
    filter_marked: bool,
    is_random: bool,
    image_count: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<PlaybackPlanResponse, String> {
    let marked_set: HashSet<String> = if filter_marked {
        storage::get_marked_paths_set(&state, &image_paths)?
    } else {
        HashSet::new()
    };

    let eligible_indexes = image_paths
        .iter()
        .enumerate()
        .filter_map(|(index, path)| {
            if filter_marked && marked_set.contains(path) {
                return None;
            }
            Some(index)
        })
        .collect::<Vec<_>>();

    let mut playback_queue = eligible_indexes.clone();
    if is_random {
        playback_queue.shuffle(&mut thread_rng());
    }

    let target_count = image_count
        .map(|count| count.min(playback_queue.len()))
        .unwrap_or(playback_queue.len());
    playback_queue.truncate(target_count);

    Ok(PlaybackPlanResponse {
        eligible_indexes,
        playback_queue,
        target_count,
    })
}

#[tauri::command]
pub fn start_session(
    image_paths: Vec<String>,
    filter_marked: bool,
    is_random: bool,
    image_count: Option<usize>,
    display_time: Option<i64>,
    state: tauri::State<'_, AppState>,
) -> Result<StartSessionResponse, String> {
    let marked_set: HashSet<String> = if filter_marked {
        storage::get_marked_paths_set(&state, &image_paths)?
    } else {
        HashSet::new()
    };

    let eligible_indexes = image_paths
        .iter()
        .enumerate()
        .filter_map(|(index, path)| {
            if filter_marked && marked_set.contains(path) {
                return None;
            }
            Some(index)
        })
        .collect::<Vec<_>>();

    let mut playback_queue = eligible_indexes.clone();
    if is_random {
        playback_queue.shuffle(&mut thread_rng());
    }

    let target_count = image_count
        .map(|count| count.min(playback_queue.len()))
        .unwrap_or(playback_queue.len());
    playback_queue.truncate(target_count);

    let mut engine = session_engine()
        .lock()
        .map_err(|_| "failed to lock session engine".to_string())?;
    engine.image_paths = image_paths;
    engine.queue = playback_queue.clone();
    engine.history.clear();
    engine.pointer = None;
    engine.display_time = display_time;
    engine.remaining_time = display_time;
    engine.is_playing = !engine.queue.is_empty();
    engine.is_paused = false;

    if let Some(first) = engine.queue.first().copied() {
        engine.history.push(first);
        engine.pointer = Some(0);
    }

    Ok(StartSessionResponse {
        eligible_indexes,
        playback_queue,
        snapshot: to_snapshot(&engine, None, None),
    })
}

#[tauri::command]
pub fn session_next() -> Result<SessionSnapshot, String> {
    let mut engine = session_engine()
        .lock()
        .map_err(|_| "failed to lock session engine".to_string())?;

    if !engine.is_playing {
        return Ok(to_snapshot(&engine, None, None));
    }

    let Some(current_queue_index) = current_queue_index(&engine) else {
        engine.is_playing = false;
        engine.is_paused = true;
        engine.remaining_time = Some(0);
        return Ok(to_snapshot(&engine, None, None));
    };

    if current_queue_index + 1 >= engine.queue.len() {
        engine.is_playing = false;
        engine.is_paused = true;
        engine.remaining_time = Some(0);
        return Ok(to_snapshot(&engine, None, None));
    }

    let next_index = engine.queue[current_queue_index + 1];
    if let Some(pointer) = engine.pointer {
        if pointer + 1 < engine.history.len() {
            engine.pointer = Some(pointer + 1);
        } else {
            engine.history.push(next_index);
            engine.pointer = Some(engine.history.len() - 1);
        }
    } else {
        engine.history.push(next_index);
        engine.pointer = Some(0);
    }

    engine.remaining_time = engine.display_time;
    Ok(to_snapshot(&engine, None, None))
}

#[tauri::command]
pub fn session_prev() -> Result<SessionSnapshot, String> {
    let mut engine = session_engine()
        .lock()
        .map_err(|_| "failed to lock session engine".to_string())?;

    let Some(pointer) = engine.pointer else {
        return Ok(to_snapshot(&engine, None, None));
    };

    if pointer == 0 {
        return Ok(to_snapshot(&engine, None, None));
    }

    engine.pointer = Some(pointer - 1);
    engine.remaining_time = engine.display_time;
    Ok(to_snapshot(&engine, None, None))
}

#[tauri::command]
pub fn session_toggle_pause() -> Result<SessionSnapshot, String> {
    let mut engine = session_engine()
        .lock()
        .map_err(|_| "failed to lock session engine".to_string())?;

    if engine.is_playing {
        engine.is_paused = !engine.is_paused;
    }
    Ok(to_snapshot(&engine, None, None))
}

#[tauri::command]
pub fn session_tick(state: tauri::State<'_, AppState>) -> Result<SessionSnapshot, String> {
    let mut engine = session_engine()
        .lock()
        .map_err(|_| "failed to lock session engine".to_string())?;

    if !engine.is_playing || engine.is_paused {
        return Ok(to_snapshot(&engine, None, None));
    }

    let Some(display_time) = engine.display_time else {
        return Ok(to_snapshot(&engine, None, None));
    };

    let Some(current_index) = engine.pointer.and_then(|pointer| engine.history.get(pointer)).copied() else {
        engine.is_playing = false;
        engine.is_paused = true;
        return Ok(to_snapshot(&engine, None, None));
    };

    let remaining = engine.remaining_time.unwrap_or(display_time);
    if remaining > 1 {
        engine.remaining_time = Some(remaining - 1);
        return Ok(to_snapshot(&engine, None, None));
    }

    let mut latest_mark = None;
    let marked_path = engine.image_paths.get(current_index).cloned();
    if let Some(path) = marked_path.as_ref() {
        storage::save_image_mark_to_db(&state, path, display_time)?;
        let latest_map = storage::get_latest_marks_map(&state, std::slice::from_ref(path))?;
        latest_mark = latest_map.get(path).cloned();
    }

    let Some(queue_index) = current_queue_index(&engine) else {
        engine.is_playing = false;
        engine.is_paused = true;
        engine.remaining_time = Some(0);
        return Ok(to_snapshot(&engine, marked_path, latest_mark));
    };

    if queue_index + 1 >= engine.queue.len() {
        engine.is_playing = false;
        engine.is_paused = true;
        engine.remaining_time = Some(0);
        return Ok(to_snapshot(&engine, marked_path, latest_mark));
    }

    let next = engine.queue[queue_index + 1];
    if let Some(pointer) = engine.pointer {
        if pointer + 1 < engine.history.len() {
            engine.pointer = Some(pointer + 1);
        } else {
            engine.history.push(next);
            engine.pointer = Some(engine.history.len() - 1);
        }
    }
    engine.remaining_time = Some(display_time);
    Ok(to_snapshot(&engine, marked_path, latest_mark))
}

#[tauri::command]
pub fn end_session() -> Result<SessionSnapshot, String> {
    let mut engine = session_engine()
        .lock()
        .map_err(|_| "failed to lock session engine".to_string())?;
    *engine = SessionEngine::default();
    Ok(to_snapshot(&engine, None, None))
}
