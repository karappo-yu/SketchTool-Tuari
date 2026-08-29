//! macOS 数位板笔压桥接。
//!
//! WebKit 不保证把数位板驱动的压感透传给 Web PointerEvent，
//! 因此在 Rust 侧用 NSEvent 本地事件监听（无需系统辅助功能权限，
//! 只能收到本应用窗口的事件）捕获 TabletPoint 子类型的鼠标事件，
//! 读取真实笔压后以 `pen-pressure` 事件流推给前端。

#[cfg(target_os = "macos")]
pub fn start_pen_pressure_monitor(handle: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventSubtype};
    use std::ptr::NonNull;
    use tauri::Emitter;

    let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp | NSEventMask::LeftMouseDragged;

    let block: RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> = RcBlock::new(
        move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let event = unsafe { event.as_ref() };
            if event.subtype() == NSEventSubtype::TabletPoint {
                let pressure = f64::from(event.pressure()).clamp(0.0, 1.0);
                let pressure = (pressure * 1000.0).round() / 1000.0;
                let _ = handle.emit("pen-pressure", pressure);
            }
            event as *const NSEvent as *mut NSEvent
        },
    );

    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };

    // 监听器与应用同生命周期，进程退出时由系统回收
    std::mem::forget(monitor);
    std::mem::forget(block);
}

#[cfg(not(target_os = "macos"))]
pub fn start_pen_pressure_monitor(_handle: tauri::AppHandle) {}
