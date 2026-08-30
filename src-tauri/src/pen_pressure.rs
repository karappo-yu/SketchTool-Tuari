//! macOS 数位板笔压 / 橡皮擦 / 物理按键桥接。
//!
//! WebKit 不保证把数位板驱动的压感和橡皮擦状态透传给 Web PointerEvent，
//! 因此在 Rust 侧用 NSEvent 本地事件监听（无需系统辅助功能权限，
//! 只能收到本应用窗口的事件）捕获 TabletPoint 子类型的鼠标事件，
//! 以 `pen-state` 事件流推给前端：
//! - pressure：真实笔压
//! - eraser：笔上"橡皮擦"侧键按住中
//!
//! 另外监听 keyDown，把快捷键用到的物理键码以 `native-key` 事件推给前端：
//! 中文输入法等 IME 激活时，WKWebView 收到的 keydown 不可靠（key 变成
//! "Process"、code 可能为空，甚至完全不下发），而 NSEvent 在 IME 处理
//! 之前就能看到真实键码。
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

/// keyDown 桥接事件：code 为 Web KeyboardEvent.code 风格的物理键位名
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeKey {
    code: &'static str,
    repeat: bool,
    meta_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    shift_key: bool,
}

/// ANSI 布局键码 → Web code（快捷键只用得到这几个键）
fn native_key_code(key_code: u16) -> Option<&'static str> {
    Some(match key_code {
        33 => "BracketLeft",
        30 => "BracketRight",
        11 => "KeyB",
        14 => "KeyE",
        4 => "KeyH",
        5 => "KeyG",
        46 => "KeyM",
        49 => "Space",
        53 => "Escape",
        123 => "ArrowLeft",
        124 => "ArrowRight",
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub fn start_pen_pressure_monitor(handle: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventSubtype, NSEventType};
    use std::cell::Cell;
    use std::ptr::NonNull;
    use tauri::Emitter;

    let mask = NSEventMask::LeftMouseDown
        | NSEventMask::LeftMouseUp
        | NSEventMask::LeftMouseDragged
        | NSEventMask::MouseMoved
        | NSEventMask::KeyDown;

    let eraser_latched = Cell::new(false);
    let last_hover_eraser = Cell::new(false);

    let block: RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> = RcBlock::new(
        move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let event = unsafe { event.as_ref() };

            // 物理按键桥接：在 IME 处理之前读取键码（见模块注释）
            if event.r#type() == NSEventType::KeyDown {
                if let Some(code) = native_key_code(event.keyCode()) {
                    let flags = event.modifierFlags();
                    let _ = handle.emit(
                        "native-key",
                        NativeKey {
                            code,
                            repeat: event.isARepeat(),
                            meta_key: flags.contains(NSEventModifierFlags::Command),
                            ctrl_key: flags.contains(NSEventModifierFlags::Control),
                            alt_key: flags.contains(NSEventModifierFlags::Option),
                            shift_key: flags.contains(NSEventModifierFlags::Shift),
                        },
                    );
                }
                return event as *const NSEvent as *mut NSEvent;
            }

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
