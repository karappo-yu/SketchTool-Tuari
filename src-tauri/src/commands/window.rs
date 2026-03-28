use serde::Serialize;

use super::common::{fail, ok, CommandResponse};

#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSWindow, NSWindowButton, NSWindowCollectionBehavior, NSWindowTitleVisibility, NSWindowToolbarStyle,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlwaysOnTopResponse {
    success: bool,
    always_on_top: bool,
    message: Option<String>,
}

#[tauri::command]
pub fn set_always_on_top(always_on_top: bool, window: tauri::WebviewWindow) -> AlwaysOnTopResponse {
    match window.set_always_on_top(always_on_top) {
        Ok(_) => AlwaysOnTopResponse {
            success: true,
            always_on_top,
            message: None,
        },
        Err(error) => AlwaysOnTopResponse {
            success: false,
            always_on_top: window.is_always_on_top().unwrap_or(always_on_top),
            message: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub fn set_decorations(decorations: bool, window: tauri::WebviewWindow) -> CommandResponse {
    match window.set_decorations(decorations) {
        Ok(_) => ok(),
        Err(error) => fail(error.to_string()),
    }
}

#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[cfg(target_os = "macos")]
fn set_macos_traffic_lights(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;

    unsafe {
        let window: &NSWindow = &*ns_window.cast();

        if let Some(button) = window.standardWindowButton(NSWindowButton::CloseButton) {
            button.setHidden(!visible);
        }
        if let Some(button) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) {
            button.setHidden(!visible);
        }
        if let Some(button) = window.standardWindowButton(NSWindowButton::ZoomButton) {
            button.setHidden(!visible);
        }
    }

    Ok(())
}

pub fn configure_macos_window_appearance(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ns_window = window.ns_window().map_err(|error| error.to_string())?;

        unsafe {
            let window: &NSWindow = &*ns_window.cast();
            window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
            window.setTitlebarAppearsTransparent(true);
            window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
            window.setCollectionBehavior(
                NSWindowCollectionBehavior::FullScreenPrimary
                    | NSWindowCollectionBehavior::FullScreenAllowsTiling
                    | NSWindowCollectionBehavior::Managed,
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_traffic_light_visibility(visible: bool, window: tauri::WebviewWindow) -> CommandResponse {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = set_macos_traffic_lights(&window, visible) {
            return fail(error);
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (visible, window);

    ok()
}

#[tauri::command]
pub fn open_external_link(url: String) -> CommandResponse {
    match opener::open(url) {
        Ok(_) => ok(),
        Err(error) => fail(error.to_string()),
    }
}
