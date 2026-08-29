//! macOS 数位板笔压 / 橡皮擦桥接。
//!
//! WebKit 不保证把数位板驱动的压感和橡皮擦状态透传给 Web PointerEvent，
//! 因此在 Rust 侧用 NSEvent 本地事件监听（无需系统辅助功能权限，
//! 只能收到本应用窗口的事件）捕获 TabletPoint 子类型的鼠标事件，
//! 以 `pen-state` 事件流推给前端：
//! - pressure：真实笔压
//! - eraser：笔上"橡皮擦"侧键按住中
//!
//! 侧键状态为**锁定语义**：实测 Wacom 驱动只在按下/抬起瞬间携带侧键位
//! （按下 buttonMask=0x3，拖动中 0x1，抬起 0x2），因此按下时锁定、
//! 抬笔时解除，拖动期间沿用锁定值。悬停（未落笔）按住侧键时也会提前
//! 置位，保证落笔第一笔就是橡皮。

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PenState {
    pressure: f64,
    eraser: bool,
}

#[cfg(target_os = "macos")]
pub fn start_pen_pressure_monitor(handle: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventSubtype, NSEventType};
    use std::cell::Cell;
    use std::ptr::NonNull;
    use tauri::Emitter;

    let mask = NSEventMask::LeftMouseDown
        | NSEventMask::LeftMouseUp
        | NSEventMask::LeftMouseDragged
        | NSEventMask::MouseMoved;

    let eraser_latched = Cell::new(false);
    let last_hover_eraser = Cell::new(false);

    let block: RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> = RcBlock::new(
        move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let event = unsafe { event.as_ref() };
            if event.subtype() != NSEventSubtype::TabletPoint {
                return event as *const NSEvent as *mut NSEvent;
            }

            let event_type = event.r#type();
            // buttonMask：0x1 = 笔尖，0x2 = 侧键（用户配置为橡皮擦）
            let button_bit = (event.buttonMask().bits() & 0x2) != 0;

            match event_type {
                NSEventType::LeftMouseDown => eraser_latched.set(button_bit),
                NSEventType::LeftMouseUp => eraser_latched.set(false),
                // 拖动期间驱动会丢掉侧键位，沿用按下时的锁定值
                _ => {}
            }
            let eraser = eraser_latched.get() || button_bit;

            // 悬停移动只在橡皮状态变化时推送，避免高频空事件
            if event_type == NSEventType::MouseMoved && last_hover_eraser.get() == eraser {
                return event as *const NSEvent as *mut NSEvent;
            }
            last_hover_eraser.set(eraser);

            let pressure = f64::from(event.pressure()).clamp(0.0, 1.0);
            let pressure = (pressure * 1000.0).round() / 1000.0;
            let _ = handle.emit("pen-state", PenState { pressure, eraser });

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
