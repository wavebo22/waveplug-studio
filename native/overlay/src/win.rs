// Windows glue for the external surface. The HWND is deliberately NOT owned by Photoshop:
// cross-process GWLP_HWNDPARENT made Photoshop's canvas shortcuts stop working. Instead this
// non-activating top-level window is logically attached: visible over Photoshop while its main
// window is active, parked off screen when Photoshop loses focus, is minimised, or is closed.
// The desired canvas position and user drag offset survive those foreground transitions.
//
// The keyboard stays with Photoshop: the window is "no-activate" (clicking its buttons doesn't
// take the keyboard, like an on-screen keyboard or a paint program's tool palette), so the
// canvas shortcuts — Space to pan, Alt / Ctrl + wheel, H, Z … — keep working while the panel is
// up. Only while one of its text boxes is being typed into does it take the keyboard
// (`set_typing`), handing it back as soon as that ends. 11-04: handing the keyboard back after
// the fact wasn't enough, most canvas shortcuts still went dead.
//
// "Hidden" means parked off screen, never really hidden: egui keeps its own idea of whether the
// window is visible and puts that back on its first frame, which fought a real hide / show (the
// panel came up when the selection went away). Off screen, the window just stays visible to egui.
//
// Called from the server thread too, so window calls are the asynchronous kind (a synchronous one
// would wait on the window's own thread).

use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use eframe::egui::Vec2;
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    ClientToScreen, CreateRectRgn, DeleteObject, GetMonitorInfoW, MonitorFromPoint, SetWindowRgn, MONITORINFO,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
};
use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, EnumWindows, FindWindowW, GetAncestor,
    GetClientRect, GetCursorPos, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, PostMessageW,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, WindowFromPoint, WNDPROC,
};

use crate::host::{TITLE, TOAST_TITLE};
use crate::log;
use crate::panel::variants::TITLE as VARIANTS_TITLE;
use crate::protocol::{Event, ScreenRect};
use crate::server;

const GA_ROOT: u32 = 2;
const GW_OWNER: u32 = 4;
const GWLP_HWNDPARENT: i32 = -8;
const GWLP_WNDPROC: i32 = -4;
const GWL_EXSTYLE: i32 = -20;
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_APPWINDOW: isize = 0x0004_0000;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
const WM_ACTIVATE: u32 = 0x0006;
const WM_SETFOCUS: u32 = 0x0007;
const WM_MOUSEACTIVATE: u32 = 0x0021;
const WM_KILLFOCUS: u32 = 0x0008;
const WM_CLOSE: u32 = 0x0010;
const WAIT_OBJECT_0: u32 = 0;
const MA_NOACTIVATE: LRESULT = 3;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;
const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
const HWND_TOPMOST: HWND = -1isize as HWND;
const HWND_NOTOPMOST: HWND = -2isize as HWND;
const MONITOR_DEFAULTTONEAREST: u32 = 2;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const SYNCHRONIZE: u32 = 0x0010_0000;
/// gap between the panel and the canvas corner, at 96 DPI
const MARGIN: f64 = 12.0;
/// where the window waits while "hidden"
pub const PARK: (i32, i32) = (-32000, -32000);

static SELF: AtomicIsize = AtomicIsize::new(0);
static OWNER: AtomicIsize = AtomicIsize::new(0);
static SHOWN: AtomicBool = AtomicBool::new(false);
/// Whether the native window is currently parked off screen (distinct from an active selection).
static PARKED: AtomicBool = AtomicBool::new(true);
static IS_TOPMOST: AtomicBool = AtomicBool::new(false);
/// Re-request the canvas once if we launched while Photoshop was minimised.
static VIEW_REQUESTED: AtomicBool = AtomicBool::new(false);
static CURRENT_PANEL: Mutex<Option<String>> = Mutex::new(None);
static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);
static TYPING: AtomicBool = AtomicBool::new(false);
static FOCUS_LOST: AtomicBool = AtomicBool::new(false);
static MOUSE_ACTIVATE_BLOCKS: AtomicU32 = AtomicU32::new(0);

// The second native viewport has its own HWND. Never attach it to Photoshop as a true owner.
static VARIANT_SHOWN: AtomicBool = AtomicBool::new(false);
static VARIANT_PARKED: AtomicBool = AtomicBool::new(true);
static VARIANT_OWNER: AtomicIsize = AtomicIsize::new(0);
static VARIANT_GUARD_HWND: AtomicIsize = AtomicIsize::new(0);
static VARIANT_ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);
/// The rail follows the generator's last-known position even when selection hides that panel.
static VARIANT_VIEW: Mutex<Option<ScreenRect>> = Mutex::new(None);
/// The preferred height changes only when variants or thumbnail scale change.
/// Manual dragging can make it smaller, but never larger than the content/editor cap.
static VARIANT_LAST_AUTO_HEIGHT: AtomicI32 = AtomicI32::new(0);
static VARIANT_HEIGHT_CAP: AtomicI32 = AtomicI32::new(900);
static VARIANT_LAST_ANCHOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);
static VARIANT_OWNER_RECT: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

#[derive(Clone, Copy)]
struct VariantGeometry {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}
static VARIANT_GEOMETRY: Mutex<VariantGeometry> = Mutex::new(VariantGeometry {
    x: 0,
    y: 0,
    w: 184,
    h: 500,
});

fn should_clear_typing_focus(typing: bool, foreground: &str) -> bool {
    typing && foreground != "overlay"
}

/// An unowned window must rise only when the user is working in Photoshop.
/// A focused prompt field is the one exception: it is allowed to stay in front while typing.

fn bottom_anchored_top(old_top: i32, old_height: i32, new_height: i32) -> i32 {
    old_top + old_height - new_height
}

fn needs_noactivate_style(typing: bool, extended_style: isize) -> bool {
    !typing
        && (extended_style & WS_EX_NOACTIVATE == 0
            || extended_style & WS_EX_TOOLWINDOW == 0
            || extended_style & WS_EX_APPWINDOW != 0)
}

fn should_restore_photoshop_focus(
    shown: bool,
    typing: bool,
    foreground: &str,
    owner_is_photoshop: bool,
) -> bool {
    shown && !typing && foreground == "overlay" && owner_is_photoshop
}

pub fn take_focus_lost() -> bool {
    FOCUS_LOST.swap(false, Ordering::SeqCst)
}

fn mouse_activate_result(typing: bool) -> Option<LRESULT> {
    (!typing).then_some(MA_NOACTIVATE)
}

#[cfg(test)]
mod activation_tests {
    use super::*;

    #[test]
    fn helper_windows_and_no_foreground_change_nothing() {
        assert_eq!(steady_front("helper", "photoshop"), "photoshop");
        assert_eq!(steady_front("none", "other"), "other");
        assert_eq!(steady_front("helper", ""), "photoshop");
        assert_eq!(steady_front("other", "photoshop"), "other");
        assert_eq!(steady_front("overlay", "photoshop"), "overlay");
    }

    #[test]
    fn parks_only_after_staying_away() {
        let ticks = AtomicU32::new(0);
        assert!(!idle_long_enough(&ticks));
        assert!(idle_long_enough(&ticks));
        ticks.store(0, Ordering::SeqCst);
        assert!(!idle_long_enough(&ticks));
    }

    #[test]
    fn ordinary_clicks_do_not_activate_the_overlay() {
        assert_eq!(mouse_activate_result(false), Some(MA_NOACTIVATE));
    }

    #[test]
    fn text_editing_uses_the_normal_activation_path() {
        assert_eq!(mouse_activate_result(true), None);
    }

    #[test]
    fn text_focus_is_cleared_when_another_window_becomes_foreground() {
        assert!(should_clear_typing_focus(true, "photoshop"));
        assert!(should_clear_typing_focus(true, "other"));
        assert!(!should_clear_typing_focus(true, "overlay"));
        assert!(!should_clear_typing_focus(false, "photoshop"));
    }

    #[test]
    fn unexpected_overlay_foreground_is_returned_to_photoshop() {
        assert!(should_restore_photoshop_focus(true, false, "overlay", true));
        assert!(!should_restore_photoshop_focus(
            false, false, "overlay", true
        ));
        assert!(!should_restore_photoshop_focus(true, true, "overlay", true));
        assert!(!should_restore_photoshop_focus(true, false, "other", true));
        assert!(!should_restore_photoshop_focus(
            true, false, "overlay", false
        ));
    }

    #[test]
    fn every_window_follows_one_photoshop_rule() {
        // Photoshop or a window that goes with it in front, and Photoshop not minimised
        for front in ["photoshop", "overlay", "variants", "workbench"] {
            assert!(present_now(true, front), "{front}");
        }
        assert!(!present_now(true, "other"));
        assert!(!present_now(false, "photoshop"), "minimised / closed");
        // the helper's own windows and "no foreground" are resolved by steady_front first
        assert!(!present_now(true, steady_front("helper", "other")));
        assert!(present_now(true, steady_front("helper", "photoshop")));
    }

    #[test]
    fn presence_comes_back_at_once_and_goes_after_staying_away() {
        let ticks = AtomicU32::new(0);
        assert!(next_presence(false, true, &ticks));
        assert!(next_presence(true, false, &ticks), "one tick away: a blink");
        assert!(!next_presence(true, false, &ticks), "two ticks away: gone");
        assert!(!next_presence(false, false, &ticks));
        assert!(next_presence(false, true, &ticks), "back: at once");
        assert!(next_presence(true, false, &ticks), "the count started again");
    }

    #[test]
    fn missing_noactivate_style_is_repaired_only_outside_text_editing() {
        let correct = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        assert!(!needs_noactivate_style(false, correct));
        assert!(needs_noactivate_style(false, WS_EX_APPWINDOW));
        assert!(needs_noactivate_style(false, WS_EX_TOOLWINDOW));
        assert!(!needs_noactivate_style(true, WS_EX_APPWINDOW));
    }


    #[test]
    fn editing_area_half_height_obeys_actual_dpi() {
        assert_eq!(half_editor_logical_height(1600.0, 1.0), 800.0);
        assert_eq!(half_editor_logical_height(1600.0, 2.0), 400.0);
        assert_eq!(half_editor_logical_height(2000.0, 1.5), 666.0);
    }

    #[test]
    fn variant_rail_uses_canvas_top_left_not_generator_lower_left() {
        assert_eq!(variant_top_left(670, 150, 18), (688, 168));
        assert_eq!(variant_top_left(670, 150, 12), (682, 162));
        assert_eq!(variant_top_left(110, 95, 12), (122, 107));
    }

    #[test]
    fn resized_while_parked_keeps_the_same_screen_bottom_edge() {
        assert_eq!(bottom_anchored_top(1200, 400, 550), 1050);
        assert_eq!(bottom_anchored_top(1200, 400, 250), 1350);
        assert_eq!(bottom_anchored_top(1200, 400, 400), 1200);
    }

    #[test]
    fn drag_position_is_absolute_and_does_not_accumulate_window_motion() {
        let origin = (100, 200);
        let cursor_start = (500, 700);
        let cursor_now = (536, 681);
        assert_eq!(drag_target(origin, cursor_start, cursor_now), (136, 181));
        // Repeating the same cursor sample must not move the window again.
        assert_eq!(drag_target(origin, cursor_start, cursor_now), (136, 181));
    }

    #[test]
    fn drag_position_uses_physical_screen_coordinates_without_scaling() {
        assert_eq!(drag_target((1000, 500), (300, 400), (320, 430)), (1020, 530));
    }

    #[test]
    fn panel_edges_snap_to_canvas_within_the_magnetic_threshold() {
        assert_eq!(snap_axis(110, 200, 100, 900, 16), (100, -1));
        assert_eq!(snap_axis(690, 200, 100, 900, 16), (700, 1));
        assert_eq!(snap_axis(250, 200, 100, 900, 16), (250, 0));
        assert_eq!(snap_axis(100, 900, 100, 900, 16), (100, 0));
        assert_eq!(snap_threshold_px(1.0), 16);
        assert_eq!(snap_threshold_px(1.5), 24);
        assert_eq!(snap_threshold_px(2.0), 32);
    }

    #[test]
    fn panel_drag_snaps_independently_to_all_four_canvas_edges() {
        let bounds = RECT { left: 100, top: 200, right: 900, bottom: 800 };
        assert_eq!(
            snap_panel_target((110, 210), (0, 0), (0, 0), bounds, (200, 100), 16),
            (100, 200, -1, -1)
        );
        assert_eq!(
            snap_panel_target((710, 710), (0, 0), (0, 0), bounds, (200, 100), 16),
            (700, 700, 1, 1)
        );
        assert_eq!(
            snap_panel_target((350, 350), (0, 0), (0, 0), bounds, (200, 100), 16),
            (350, 350, 0, 0)
        );
    }


    #[test]
    fn collapsed_panel_drag_reveal_zone_tracks_the_panel_width_and_top_edge() {
        let panel = RECT { left: 100, top: 700, right: 440, bottom: 724 };
        assert!(point_in_panel_reveal_zone(POINT { x: 120, y: 650 }, panel, 72));
        assert!(point_in_panel_reveal_zone(POINT { x: 120, y: 710 }, panel, 72));
        assert!(!point_in_panel_reveal_zone(POINT { x: 90, y: 710 }, panel, 72));
        assert!(!point_in_panel_reveal_zone(POINT { x: 120, y: 627 }, panel, 72));
        assert!(!point_in_panel_reveal_zone(POINT { x: 120, y: 725 }, panel, 72));
    }
}

/// Keep ordinary clicks in the native surface without making it the foreground window.
/// MA_NOACTIVATE (not MA_NOACTIVATEANDEAT) still delivers the click to egui controls.
unsafe extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_ACTIVATE {
        log::line(format!("WM_ACTIVATE state={}", wparam & 0xffff));
    } else if msg == WM_SETFOCUS {
        log::line("WM_SETFOCUS");
    }

    if msg == WM_KILLFOCUS && TYPING.swap(false, Ordering::SeqCst) {
        set_style(hwnd, true);
        FOCUS_LOST.store(true, Ordering::SeqCst);
        log::line("native keyboard focus lost; no-activate restored");
    }

    if msg == WM_MOUSEACTIVATE {
        if let Some(result) = mouse_activate_result(TYPING.load(Ordering::SeqCst)) {
            let n = MOUSE_ACTIVATE_BLOCKS.fetch_add(1, Ordering::SeqCst);
            if n < 12 {
                log::line(format!("mouse activate blocked {}", n + 1));
            }
            return result;
        }
    }

    let original = ORIGINAL_WNDPROC.load(Ordering::SeqCst);
    if original != 0 {
        let proc: WNDPROC = unsafe { std::mem::transmute(original) };
        unsafe { CallWindowProcW(proc, hwnd, msg, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

/// Install once after eframe has created its HWND. The guard is removed logically while a text
/// field is being edited, so the normal Windows activation path can deliver keyboard input.
fn install_mouse_activation_guard(h: HWND) {
    if ORIGINAL_WNDPROC.load(Ordering::SeqCst) != 0 {
        return;
    }
    unsafe {
        let original = GetWindowLongPtrW(h, GWLP_WNDPROC);
        if original == 0 {
            log::line("mouse activation guard: could not read original WNDPROC");
            return;
        }
        ORIGINAL_WNDPROC.store(original, Ordering::SeqCst);
        let replaced = SetWindowLongPtrW(
            h,
            GWLP_WNDPROC,
            overlay_wnd_proc as *const () as usize as isize,
        );
        if replaced == 0 {
            ORIGINAL_WNDPROC.store(0, Ordering::SeqCst);
            log::line("mouse activation guard: subclass failed");
            return;
        }
        if replaced != original {
            ORIGINAL_WNDPROC.store(replaced, Ordering::SeqCst);
        }
        log::line("mouse activation guard installed");
    }
}

struct Placed {
    panel: String,
    /// Photoshop's window when the panel was placed (moved / resized → ask for the canvas again)
    owner: RECT,
    /// The actual Photoshop canvas/view bounds in physical screen pixels.
    bounds: RECT,
    /// The desired screen-space geometry, independent of the physical parked window.
    at: (i32, i32),
    size: (i32, i32),
    /// -1 = left/top, 0 = free, 1 = right/bottom.
    snap: (i8, i8),
}
static PLACED: Mutex<Option<Placed>> = Mutex::new(None);
/// how far the user dragged the panel from its corner (kept for the session, in physical px)
static OFFSET: Mutex<(i32, i32)> = Mutex::new((0, 0));
/// The snapped canvas edges are kept separately from the free-drag offset so they remain
/// attached if Photoshop's canvas changes size or the panel is hidden and shown again.
static SNAP: Mutex<(i8, i8)> = Mutex::new((0, 0));
const SNAP_DISTANCE_LOGICAL: f64 = 16.0;

#[derive(Clone, Copy)]
struct DragOrigin {
    cursor: (i32, i32),
    window: (i32, i32),
    bounds: RECT,
    size: (i32, i32),
}
/// Absolute drag origin. Never derive movement from egui's local pointer delta after moving HWND.
static DRAG_ORIGIN: Mutex<Option<DragOrigin>> = Mutex::new(None);

fn drag_target(window: (i32, i32), start: (i32, i32), now: (i32, i32)) -> (i32, i32) {
    (
        window.0.saturating_add(now.0.saturating_sub(start.0)),
        window.1.saturating_add(now.1.saturating_sub(start.1)),
    )
}

/// Snap one panel edge to the corresponding canvas edge when it is within the DPI-scaled
/// magnetic range. Oversized panels are left free rather than snapping past the canvas.
fn snap_axis(position: i32, size: i32, min: i32, max: i32, threshold: i32) -> (i32, i8) {
    if size <= 0 || max <= min || size > max - min {
        return (position, 0);
    }
    let left_distance = position.saturating_sub(min).abs();
    let right_position = max.saturating_sub(size);
    let right_distance = position.saturating_sub(right_position).abs();
    if left_distance <= threshold && left_distance <= right_distance {
        (min, -1)
    } else if right_distance <= threshold {
        (right_position, 1)
    } else {
        (position, 0)
    }
}

fn snap_panel_target(
    window: (i32, i32),
    start: (i32, i32),
    now: (i32, i32),
    bounds: RECT,
    size: (i32, i32),
    threshold: i32,
) -> (i32, i32, i8, i8) {
    let (x, y) = drag_target(window, start, now);
    let (x, snap_x) = snap_axis(x, size.0, bounds.left, bounds.right, threshold);
    let (y, snap_y) = snap_axis(y, size.1, bounds.top, bounds.bottom, threshold);
    (x, y, snap_x, snap_y)
}

fn snap_threshold_px(dpi_scale: f64) -> i32 {
    (SNAP_DISTANCE_LOGICAL * dpi_scale.max(0.5)).round() as i32
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The host window (found by its unique title; it exists before the server starts).
fn own_window() -> HWND {
    let cached = SELF.load(Ordering::SeqCst) as HWND;
    if !cached.is_null() && unsafe { IsWindow(cached) } != 0 {
        return cached;
    }
    let h = find(TITLE);
    SELF.store(h as isize, Ordering::SeqCst);
    h
}

fn find(title: &str) -> HWND {
    let t = wide(title);
    unsafe { FindWindowW(null_mut(), t.as_ptr()) }
}

/// Tool window (not on the taskbar, not in Alt+Tab), and with `no_activate`, clicks don't take the keyboard.
fn set_style(h: HWND, no_activate: bool) {
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let ex = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
        SetWindowLongPtrW(
            h,
            GWL_EXSTYLE,
            if no_activate {
                ex | WS_EX_NOACTIVATE
            } else {
                ex & !WS_EX_NOACTIVATE
            },
        );
        // Apply the extended-style change immediately, without moving, resizing or activating.
        SetWindowPos(
            h,
            null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

/// A transient topmost state replaces the cross-process owner relationship. It keeps this
/// independent window visible above Photoshop without retaining that status in other apps.
/// Calls may originate from the watcher thread, so they must not block the UI thread.
fn set_topmost(h: HWND, yes: bool) {
    if h.is_null() || IS_TOPMOST.load(Ordering::SeqCst) == yes {
        return;
    }
    let behind = if yes { HWND_TOPMOST } else { HWND_NOTOPMOST };
    let ok = unsafe {
        SetWindowPos(
            h,
            behind,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
    } != 0;
    if ok {
        IS_TOPMOST.store(yes, Ordering::SeqCst);
        log::line(if yes {
            "temporary topmost on"
        } else {
            "temporary topmost off"
        });
    } else {
        log::line("temporary topmost update failed");
    }
}

/// Who has the keyboard, for the log: photoshop / overlay / another program.
fn who(h: HWND) -> &'static str {
    if h.is_null() {
        "none"
    } else if h == own_window() {
        "overlay"
    } else if h == find(VARIANTS_TITLE) {
        "variants"
    } else if h == find(crate::panel::shelf::TITLE) {
        "workbench"
    } else if is_photoshop(h) {
        "photoshop"
    } else if is_own_process(h) {
        "helper"
    } else {
        "other"
    }
}

/// Another window of this helper: a menu (menu.rs), the drag card, a toast, the hover frame.
/// Having one of them in front is not "the user went to another program".
fn is_own_process(h: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, &mut pid) };
    pid != 0 && pid == std::process::id()
}

/// The foreground as the show / park rules should see it: one of the helper's own windows, or
/// no foreground window at all (Windows reports none for a moment while activation moves),
/// changes nothing — whatever was in front before still counts.
fn steady_front(now: &'static str, before: &'static str) -> &'static str {
    match now {
        "helper" | "none" => if before.is_empty() { "photoshop" } else { before },
        other => other,
    }
}

/// A surface leaves the desktop only after its Photoshop has been away for this many checks in a
/// row (250 ms each): a dialog opening, a click on the taskbar's edge or a progress window
/// taking the foreground for an instant must not flash the panels off and on.
const PARK_AFTER_TICKS: u32 = 2;

// ── 跟随 Photoshop: one rule for every window that goes with Photoshop ──
// The generate panel, the variant rail, the workbench and the bottom status bar (monitor.rs) all
// ask `photoshop_present()`; `watch()` works it out once per tick. Before 11-24 each had its own
// rule (the status bar counted the helper's own windows as Photoshop, the panel didn't count the
// workbench …), so some stayed up over other programs while the rest went.

/// Photoshop is the window being worked in: its main window is up (not minimised), and the
/// foreground (`steady_front`) is Photoshop or one of the windows that go with it.
fn present_now(ps_ready: bool, front: &str) -> bool {
    ps_ready && matches!(front, "photoshop" | "overlay" | "variants" | "workbench")
}

/// The debounced answer: back at once, away only after PARK_AFTER_TICKS ticks in a row.
fn next_presence(was: bool, now: bool, away_ticks: &AtomicU32) -> bool {
    if now {
        away_ticks.store(0, Ordering::SeqCst);
        true
    } else if !was {
        false
    } else {
        !idle_long_enough(away_ticks)
    }
}

static PS_PRESENT: AtomicBool = AtomicBool::new(false);
static PS_AWAY_TICKS: AtomicU32 = AtomicU32::new(0);

/// Whether the windows that go with Photoshop should be on screen now (see above).
pub fn photoshop_present() -> bool {
    PS_PRESENT.load(Ordering::SeqCst)
}
/// Counts one more check without Photoshop in front; true once it has been long enough to park.
fn idle_long_enough(ticks: &AtomicU32) -> bool {
    // counts the ticks away; true once there have been enough
    ticks.fetch_add(1, Ordering::SeqCst) + 1 >= PARK_AFTER_TICKS
}

/// The full path of the program that owns window `h`.
pub fn exe_path(h: HWND) -> Option<String> {
    if h.is_null() {
        return None;
    }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if proc.is_null() {
            return None;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(proc, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(proc);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn is_photoshop(h: HWND) -> bool {
    exe_path(h).is_some_and(|p| p.to_lowercase().ends_with("photoshop.exe"))
}

/// The program (exe file name) owning a top-level window, for the log.
pub fn describe(root: isize) -> String {
    exe_path(root as HWND)
        .and_then(|p| p.rsplit(['\\', '/']).next().map(str::to_string))
        .unwrap_or_else(|| "?".into())
}

/// A top-level window for the drag log: its class, rectangle, extended style, and which program
/// has the foreground (to tell a Photoshop overlay window from Photoshop raising itself).
pub fn window_info(root: isize) -> String {
    let h = root as HWND;
    let mut class = [0u16; 128];
    let n = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(h, class.as_mut_ptr(), class.len() as i32) };
    let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
    let r = window_rect(h).map(|r| format!("{},{},{},{}", r.left, r.top, r.right, r.bottom)).unwrap_or_else(|| "?".into());
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    let front = describe(unsafe { GetForegroundWindow() } as isize);
    format!("class={class} rect={r} ex=0x{ex:x} front={front}")
}

/// Every visible top-level window containing (x, y), topmost first (EnumWindows walks the
/// z-order), up to 8, and both cursor readings with this thread's DPI awareness: evidence for a
/// release judged to be over Photoshop while the user saw another program there.
pub fn stack_at(x: i32, y: i32) -> String {
    struct Found { pt: POINT, list: Vec<HWND> }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> i32 {
        let f = &mut *(l as *mut Found);
        if IsWindowVisible(h) != 0 {
            if let Some(r) = window_rect(h) {
                if f.pt.x >= r.left && f.pt.x < r.right && f.pt.y >= r.top && f.pt.y < r.bottom {
                    f.list.push(h);
                }
            }
        }
        (f.list.len() < 8) as i32
    }
    let mut found = Found { pt: POINT { x, y }, list: Vec::new() };
    unsafe { EnumWindows(Some(each), &mut found as *mut Found as LPARAM) };
    let windows: Vec<String> = found
        .list
        .iter()
        .map(|&h| {
            let mut cloaked = 0u32;
            unsafe {
                windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute(
                    h,
                    windows_sys::Win32::Graphics::Dwm::DWMWA_CLOAKED as u32,
                    &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                    4,
                )
            };
            format!("[{} {} cloaked={cloaked}]", describe(h as isize), window_info(h as isize))
        })
        .collect();
    let mut logical = POINT { x: 0, y: 0 };
    let mut physical = POINT { x: 0, y: 0 };
    let awareness = unsafe {
        GetCursorPos(&mut logical);
        windows_sys::Win32::UI::WindowsAndMessaging::GetPhysicalCursorPos(&mut physical);
        windows_sys::Win32::UI::HiDpi::GetAwarenessFromDpiAwarenessContext(
            windows_sys::Win32::UI::HiDpi::GetThreadDpiAwarenessContext(),
        )
    };
    format!(
        "cursor={},{} physical={},{} dpi_awareness={awareness} stack={}",
        logical.x, logical.y, physical.x, physical.y, windows.join(" ")
    )
}

/// Photoshop's UI thread when Photoshop has the foreground (the WaveLayer drag begins there),
/// else 0. A system drag shares its input state even after Alt+Tab moved the foreground away.
pub fn photoshop_thread_in_front() -> u32 {
    let h = unsafe { GetForegroundWindow() };
    if is_photoshop(h) { unsafe { GetWindowThreadProcessId(h, null_mut()) } } else { 0 }
}

fn photoshop_window_ready(h: HWND) -> bool {
    !h.is_null()
        && unsafe { IsWindow(h) != 0 && IsWindowVisible(h) != 0 && IsIconic(h) == 0 }
        && is_photoshop(h)
}

/// Locate the Photoshop main window even if another application currently covers it.
unsafe extern "system" fn find_photoshop_callback(h: HWND, data: LPARAM) -> i32 {
    if unsafe { GetWindow(h, GW_OWNER) }.is_null()
        && (unsafe { IsWindowVisible(h) != 0 || IsIconic(h) != 0 })
    {
        if let Some(r) = window_rect(h) {
            let width = (r.right - r.left).max(0) as i64;
            let height = (r.bottom - r.top).max(0) as i64;
            if width >= 400 && height >= 300 && is_photoshop(h) {
                let best = unsafe { &mut *(data as *mut (HWND, i64)) };
                let area = width * height;
                if area > best.1 {
                    *best = (h, area);
                }
            }
        }
    }
    1
}

fn find_photoshop_main_window() -> HWND {
    let mut best: (HWND, i64) = (null_mut(), 0);
    unsafe {
        EnumWindows(Some(find_photoshop_callback), &mut best as *mut _ as LPARAM);
    }
    best.0
}

// ── for the 性能监视 box (monitor.rs): where Photoshop is, without any surface being up ──
static MONITOR_PS: AtomicIsize = AtomicIsize::new(0);

fn monitor_photoshop() -> HWND {
    let cached = MONITOR_PS.load(Ordering::SeqCst) as HWND;
    if photoshop_window_ready(cached) {
        return cached;
    }
    let h = find_photoshop_main_window();
    MONITOR_PS.store(h as isize, Ordering::SeqCst);
    h
}

/// Photoshop's main window on screen (left, top, right, bottom); None while minimised or closed.
pub fn photoshop_main_rect() -> Option<(i32, i32, i32, i32)> {
    let h = monitor_photoshop();
    if !photoshop_window_ready(h) {
        return None;
    }
    window_rect(h).map(|r| (r.left, r.top, r.right, r.bottom))
}

/// The process id of the running Photoshop, 0 when there is none.
pub fn photoshop_pid() -> u32 {
    let h = monitor_photoshop();
    let mut pid = 0u32;
    if !h.is_null() {
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
    }
    pid
}

// ── for 卡死保护 (hang.rs): Photoshop's main window whatever its state, even minimised or hung ──
static HANG_PS: AtomicIsize = AtomicIsize::new(0);

pub fn photoshop_main_hwnd() -> HWND {
    let cached = HANG_PS.load(Ordering::SeqCst) as HWND;
    if !cached.is_null() && unsafe { IsWindow(cached) } != 0 && is_photoshop(cached) {
        return cached;
    }
    let h = find_photoshop_main_window();
    HANG_PS.store(h as isize, Ordering::SeqCst);
    h
}

pub fn photoshop_main_pid() -> u32 {
    let h = photoshop_main_hwnd();
    let mut pid = 0u32;
    if !h.is_null() {
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
    }
    pid
}

/// Puts the window titled `title` (an egui viewport of `size` logical px) in the middle of
/// Photoshop's window, on top. Not owned by Photoshop: tying it to a hung window could hang it
/// too. False until the window exists.
pub fn place_dialog(title: &str, size: Vec2) -> bool {
    let t = find(title);
    if t.is_null() {
        return false;
    }
    let ps = photoshop_main_hwnd();
    let area = window_rect(ps)
        .filter(|_| unsafe { IsIconic(ps) } == 0)
        .map(|r| (r.left, r.top, r.right, r.bottom))
        .or_else(|| {
            let mut c = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut c) };
            let m = unsafe { MonitorFromPoint(c, MONITOR_DEFAULTTONEAREST) };
            let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            (unsafe { GetMonitorInfoW(m, &mut info) } != 0)
                .then(|| (info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom))
        });
    let Some(a) = area else { return true };
    let k = dpi_at(POINT { x: (a.0 + a.2) / 2, y: (a.1 + a.3) / 2 }) / 96.0;
    let (w, h) = ((size.x as f64 * k) as i32, (size.y as f64 * k) as i32);
    let (x, y) = ((a.0 + a.2 - w) / 2, (a.1 + a.3 - h) / 2);
    unsafe { SetWindowPos(t, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) };
    log::line(format!("hang dialog placed at {x},{y} {w}x{h}"));
    true
}

/// Photoshop's main window: the top-level window under the canvas, else the one in front.
fn photoshop_at(pt: POINT) -> HWND {
    unsafe {
        let under = GetAncestor(WindowFromPoint(pt), GA_ROOT);
        if is_photoshop(under) {
            return under;
        }
        let front = GetAncestor(GetForegroundWindow(), GA_ROOT);
        if is_photoshop(front) {
            return front;
        }
    }
    find_photoshop_main_window()
}

/// Never let the second egui viewport steal Photoshop's canvas shortcuts.
unsafe extern "system" fn variant_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_MOUSEACTIVATE {
        return MA_NOACTIVATE; // deliver the click without activating the window
    }
    let original = VARIANT_ORIGINAL_WNDPROC.load(Ordering::SeqCst);
    if original != 0 {
        let proc: WNDPROC = unsafe { std::mem::transmute(original) };
        unsafe { CallWindowProcW(proc, hwnd, msg, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

fn install_variant_guard(h: HWND) {
    if h.is_null() || VARIANT_GUARD_HWND.load(Ordering::SeqCst) == h as isize {
        return;
    }
    unsafe {
        let orig = GetWindowLongPtrW(h, GWLP_WNDPROC);
        if orig == 0 || orig == variant_wnd_proc as *const () as isize {
            return;
        }
        let prior = SetWindowLongPtrW(h, GWLP_WNDPROC, variant_wnd_proc as *const () as isize);
        if prior != 0 {
            VARIANT_ORIGINAL_WNDPROC.store(prior, Ordering::SeqCst);
            VARIANT_GUARD_HWND.store(h as isize, Ordering::SeqCst);
            log::line("variants mouse activation guard installed");
        } else {
            log::line("variants mouse activation guard failed");
        }
    }
}

pub fn variant_window_exists() -> bool {
    !find(VARIANTS_TITLE).is_null()
}

fn variant_park(h: HWND) {
    if let Some(from) = on_screen(h) {
        VARIANT_PARKED.store(true, Ordering::SeqCst);
        crate::anim::slide(h as isize, &VARIANT_SLIDE, crate::anim::Place::Fixed(from), (-crate::anim::SLIDE_PX, 0), false, crate::anim::SLIDE_OUT_MS, Some(|h| variant_park_now(h as HWND)));
        return;
    }
    VARIANT_SLIDE.fetch_add(1, Ordering::SeqCst);
    variant_park_now(h);
}

fn variant_park_now(h: HWND) {
    let ok = unsafe {
        SetWindowPos(
            h,
            HWND_NOTOPMOST,
            PARK.0,
            PARK.1,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
    } != 0;
    if ok {
        VARIANT_PARKED.store(true, Ordering::SeqCst);
    }
}

fn variant_restore(h: HWND) {
    let Ok(geom) = VARIANT_GEOMETRY.lock() else {
        return;
    };
    let ok = unsafe {
        SetWindowPos(
            h,
            HWND_TOPMOST,
            geom.x - crate::anim::SLIDE_PX,
            geom.y,
            geom.w,
            geom.h,
            SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
    } != 0;
    if ok {
        // in from the left edge of the canvas (anim.rs)
        crate::anim::slide(h as isize, &VARIANT_SLIDE, crate::anim::Place::Live(variant_place_now), (-crate::anim::SLIDE_PX, 0), true, crate::anim::SLIDE_IN_MS, None);
        VARIANT_PARKED.store(false, Ordering::SeqCst);
        log::line(format!(
            "variants restored at {},{} size {}x{}",
            geom.x, geom.y, geom.w, geom.h
        ));
    }
}

/// Apply a horizontal size dictated by the thumbnail slider, never by mouse edge dragging.
pub fn variant_sync_width(logical_width: f32) {
    if !VARIANT_SHOWN.load(Ordering::SeqCst) {
        return;
    }
    let hwnd = find(VARIANTS_TITLE);
    if hwnd.is_null() {
        return;
    }
    let Ok(mut geom) = VARIANT_GEOMETRY.lock() else {
        return;
    };
    let dpi = dpi_at(POINT {
        x: geom.x,
        y: geom.y,
    }) / 96.0;
    let wanted = (logical_width as f64 * dpi).round() as i32;
    let wanted = wanted.max(96);
    if geom.w != wanted {
        geom.w = wanted;
        log::line(format!("variants width set by thumbnails: {wanted}px"));
    }
    if VARIANT_PARKED.load(Ordering::SeqCst) {
        return;
    }
    let Some(r) = window_rect(hwnd) else {
        return;
    };
    if ((r.right - r.left) - wanted).abs() > 1 {
        unsafe {
            SetWindowPos(
                hwnd,
                null_mut(),
                0,
                0,
                wanted,
                r.bottom - r.top,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
            );
        }
    }
}

fn half_editor_logical_height(editor_height: f64, scale: f64) -> f32 {
    (editor_height * 0.5 / scale.max(0.25)).floor().max(1.0) as f32
}

/// The editing region is the plugin's view bounds, not the full monitor resolution.
/// Used both for egui's max-height constraint and the final Win32 size safety cap.
pub fn variant_max_logical_height(view: Option<ScreenRect>) -> f32 {
    let stored = VARIANT_VIEW.lock().ok().and_then(|v| *v);
    if let Some(v) = view
        .or(stored)
        .filter(|v| v.right > v.left && v.bottom > v.top && v.left > -30000.0 && v.top > -30000.0)
    {
        let k = dpi_at(POINT {
            x: v.left as i32,
            y: v.top as i32,
        }) / 96.0;
        return half_editor_logical_height(v.bottom - v.top, k);
    }
    let owner = VARIANT_OWNER.load(Ordering::SeqCst) as HWND;
    if let Some(r) = window_rect(owner) {
        let k = dpi_at(POINT {
            x: r.left,
            y: r.top,
        }) / 96.0;
        return half_editor_logical_height((r.bottom - r.top) as f64, k);
    }
    400.0 // until UXP reports Photoshop's actual editor bounds
}

/// Apply content-driven height. When content/thumbnail scale changes, autofit immediately.
/// A user may drag the bottom edge shorter to scroll, but not exceed content or half the editor.
pub fn variant_sync_height(logical_content_height: f32) {
    if !VARIANT_SHOWN.load(Ordering::SeqCst) {
        return;
    }
    let hwnd = find(VARIANTS_TITLE);
    if hwnd.is_null() {
        return;
    }
    let max_logical = variant_max_logical_height(None);
    let capped = logical_content_height.min(max_logical).max(1.0);
    let Ok(mut geom) = VARIANT_GEOMETRY.lock() else {
        return;
    };
    let dpi = dpi_at(POINT {
        x: geom.x,
        y: geom.y,
    }) / 96.0;
    let wanted = ((capped as f64 * dpi).floor() as i32).max(1);
    VARIANT_HEIGHT_CAP.store(wanted, Ordering::SeqCst);
    let changed = VARIANT_LAST_AUTO_HEIGHT.swap(wanted, Ordering::SeqCst) != wanted;
    if changed || geom.h > wanted {
        geom.h = wanted;
        log::line(format!(
            "variants autofit height {}px (editor half max {}px)",
            wanted,
            (max_logical as f64 * dpi).floor() as i32
        ));
    }
    if VARIANT_PARKED.load(Ordering::SeqCst) {
        return;
    }
    if let Some(r) = window_rect(hwnd) {
        let actual = r.bottom - r.top;
        if changed || actual > wanted {
            unsafe {
                SetWindowPos(
                    hwnd,
                    null_mut(),
                    0,
                    0,
                    r.right - r.left,
                    geom.h,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                );
            }
        }
    }
}

/// The rail is pinned to the canvas TOP-left (not to the generate panel's lower-left).
/// Its origin is independent of rail height and Photoshop selection, while the plugin-provided
/// canvas rectangle takes precedence over the Photoshop window bounds.
fn variant_top_left(left: i32, top: i32, margin: i32) -> (i32, i32) {
    (left + margin, top + margin)
}

fn canvas_top_left(view: Option<ScreenRect>, ps: HWND) -> Option<(i32, i32)> {
    let top_left = view
        .filter(|v| v.right > v.left && v.bottom > v.top && v.left > -30000.0 && v.top > -30000.0)
        .map(|v| (v.left.round() as i32, v.top.round() as i32))
        .or_else(|| window_rect(ps).map(|r| (r.left, r.top)))?;
    let k = dpi_at(POINT {
        x: top_left.0,
        y: top_left.1,
    }) / 96.0;
    Some(variant_top_left(
        top_left.0,
        top_left.1,
        (MARGIN * k).round() as i32,
    ))
}

fn align_variant_to_canvas_top(owner: HWND, view: Option<ScreenRect>, force: bool) {
    let Some(anchor) = canvas_top_left(view, owner) else {
        return;
    };
    let Ok(mut last) = VARIANT_LAST_ANCHOR.lock() else {
        return;
    };
    if !force && *last == Some(anchor) {
        return;
    }
    *last = Some(anchor);
    let Ok(mut geom) = VARIANT_GEOMETRY.lock() else {
        return;
    };
    geom.x = anchor.0;
    geom.y = anchor.1;
    let (x, y, w, h) = (geom.x, geom.y, geom.w, geom.h);
    drop(geom);
    if VARIANT_SHOWN.load(Ordering::SeqCst) && !VARIANT_PARKED.load(Ordering::SeqCst) {
        let hwnd = find(VARIANTS_TITLE);
        if !hwnd.is_null() {
            unsafe {
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    x,
                    y,
                    w,
                    h,
                    SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                );
            }
        }
    }
    log::line(format!("variants anchored canvas top-left at {x},{y}"));
}

/// Position against the canvas top-left; only vertical height and thumbnail slider width change.
pub fn variant_place(view: Option<ScreenRect>) -> bool {
    let hwnd = find(VARIANTS_TITLE);
    if hwnd.is_null() {
        return false;
    }
    set_style(hwnd, true);
    install_variant_guard(hwnd);
    let pt = if let Some(v) = view {
        POINT {
            x: ((v.left + v.right) * 0.5) as i32,
            y: ((v.top + v.bottom) * 0.5) as i32,
        }
    } else {
        let mut p = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut p) };
        p
    };
    let owner = photoshop_at(pt);
    VARIANT_OWNER.store(owner as isize, Ordering::SeqCst);
    if let Ok(mut stored) = VARIANT_VIEW.lock() {
        *stored = view;
    }
    if let Ok(mut bounds) = VARIANT_OWNER_RECT.lock() {
        *bounds = window_rect(owner).map(|r| (r.left, r.top, r.right, r.bottom));
    }
    align_variant_to_canvas_top(owner, view, true);
    VARIANT_LAST_AUTO_HEIGHT.store(0, Ordering::SeqCst);
    VARIANT_SHOWN.store(true, Ordering::SeqCst);
    if photoshop_window_ready(owner)
        && matches!(
            who(unsafe { GetForegroundWindow() }),
            "photoshop" | "variants" | "overlay"
        )
    {
        variant_restore(hwnd);
    } else {
        variant_park(hwnd);
    }
    true
}

pub fn variant_hide() {
    VARIANT_SHOWN.store(false, Ordering::SeqCst);
    VARIANT_LAST_AUTO_HEIGHT.store(0, Ordering::SeqCst);
    let hwnd = find(VARIANTS_TITLE);
    if !hwnd.is_null() {
        variant_park(hwnd);
    }
    VARIANT_OWNER.store(0, Ordering::SeqCst);
}

/// Sync independent variant viewport with Photoshop foreground/minimise state,
/// without changing the root generator HWND's focus or parking state.
fn watch_variant(foreground: &str, present: bool) {
    if !VARIANT_SHOWN.load(Ordering::SeqCst) {
        return;
    }
    let hwnd = find(VARIANTS_TITLE);
    if hwnd.is_null() {
        VARIANT_PARKED.store(true, Ordering::SeqCst);
        return;
    }
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    if needs_noactivate_style(false, ex) {
        set_style(hwnd, true);
    }
    install_variant_guard(hwnd);
    let owner = VARIANT_OWNER.load(Ordering::SeqCst) as HWND;
    let moved = if let Some(r) = window_rect(owner) {
        if let Ok(mut previous) = VARIANT_OWNER_RECT.lock() {
            let now = (r.left, r.top, r.right, r.bottom);
            let moved = previous.is_some_and(|old| old != now);
            *previous = Some(now);
            moved
        } else {
            false
        }
    } else {
        false
    };
    if moved {
        // Photoshop moved/resized: UXP knows the new canvas bounds; request a fresh anchor.
        server::send(&Event::ViewRequest {
            panel: "variants".to_string(),
        });
    } else {
        let view = VARIANT_VIEW.lock().ok().and_then(|v| *v);
        align_variant_to_canvas_top(owner, view, false);
    }
    let active = present && photoshop_window_ready(owner);
    if !active {
        if !VARIANT_PARKED.load(Ordering::SeqCst) {
            // Record the resized dimensions before parking; never save the -32000 location.
            if let Some(r) = window_rect(hwnd) {
                if let Ok(mut geom) = VARIANT_GEOMETRY.lock() {
                    // Preserve slider-controlled width; only the user's vertical resize is stored.
                    let cap = VARIANT_HEIGHT_CAP.load(Ordering::SeqCst).max(1);
                    geom.h = (r.bottom - r.top).clamp(80.min(cap), cap);
                }
            }
            variant_park(hwnd);
            log::line(format!("variants parked: foreground={foreground}"));
        }
        return;
    }
    if VARIANT_PARKED.load(Ordering::SeqCst) {
        variant_restore(hwnd);
    } else if let Some(r) = window_rect(hwnd) {
        if let Ok(mut geom) = VARIANT_GEOMETRY.lock() {
            // Width remains linked to the thumbnail slider; height follows the bottom edge.
            geom.h = (r.bottom - r.top).clamp(200, 900);
        }
    }
}

fn window_rect(h: HWND) -> Option<RECT> {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    (!h.is_null() && unsafe { GetWindowRect(h, &mut r) } != 0).then_some(r)
}

pub fn cursor_screen() -> Option<(i32, i32)> {
    let mut p = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}

fn point_in_panel_reveal_zone(cursor: POINT, panel: RECT, reveal_height_px: i32) -> bool {
    cursor.x >= panel.left
        && cursor.x < panel.right
        && cursor.y >= panel.top.saturating_sub(reveal_height_px.max(0))
        && cursor.y <= panel.bottom
}

/// During a WaveLayer drag, expand the collapsed bar when the cursor approaches the panel
/// from the canvas above it. The extra hit zone is scaled using the monitor under the cursor.
pub fn cursor_in_panel_reveal_zone(logical_height: f32) -> bool {
    if !SHOWN.load(Ordering::SeqCst) || PARKED.load(Ordering::SeqCst) {
        return false;
    }
    let hwnd = own_window();
    let Some(panel) = visible_rect(hwnd) else { return false };
    let Some((x, y)) = cursor_screen() else { return false };
    let scale = dpi_at(POINT { x, y }) / 96.0;
    let reveal_height = (logical_height.max(0.0) as f64 * scale).ceil() as i32;
    point_in_panel_reveal_zone(POINT { x, y }, panel, reveal_height)
}

// ── 展开 / 收起: the generate panel's window keeps its open height; folding shows only its
// bottom part through a window region (the bar). Growing / shrinking the region costs nothing,
// while resizing the window every frame made its GPU surface rebuild and the content jump.

/// physical px of the panel shown from its bottom edge; -1: all of it (no region)
static CLIP_PX: AtomicI32 = AtomicI32::new(-1);
/// the client height the region was made for
static CLIP_BOTTOM: AtomicI32 = AtomicI32::new(0);

/// The part of the panel on screen: its window, less what the region hides at the top.
fn visible_rect(h: HWND) -> Option<RECT> {
    let mut r = window_rect(h)?;
    let clip = CLIP_PX.load(Ordering::SeqCst);
    if clip >= 0 {
        r.top = r.top.max(r.bottom - clip);
    }
    Some(r)
}

/// Shows only the bottom `visible` logical px of the panel (None: all of it). Called from the
/// UI thread every frame of a fold / unfold; does nothing when the answer is the same.
pub fn clip_panel(visible: Option<f32>) {
    let me = own_window();
    if me.is_null() {
        return;
    }
    let mut c = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetClientRect(me, &mut c) } == 0 {
        return;
    }
    let Some(v) = visible else {
        if CLIP_PX.swap(-1, Ordering::SeqCst) != -1 {
            unsafe { SetWindowRgn(me, null_mut(), 1) };
        }
        return;
    };
    let k = window_rect(me).map(|r| dpi_at(POINT { x: r.left, y: r.bottom - 1 }) / 96.0).unwrap_or(1.0);
    let px = ((v as f64 * k).round() as i32).clamp(1, c.bottom.max(1));
    if px >= c.bottom {
        // all of it shows: no region (and none to keep in sync with the window's size)
        if CLIP_PX.swap(-1, Ordering::SeqCst) != -1 {
            unsafe { SetWindowRgn(me, null_mut(), 1) };
        }
        return;
    }
    // the region is in client coordinates from the top: a new window height needs a new one too
    let same_px = CLIP_PX.swap(px, Ordering::SeqCst) == px;
    if CLIP_BOTTOM.swap(c.bottom, Ordering::SeqCst) == c.bottom && same_px {
        return;
    }
    unsafe {
        let rgn = CreateRectRgn(0, c.bottom - px, c.right, c.bottom);
        // the system owns the region once it is set
        if SetWindowRgn(me, rgn, 1) == 0 {
            DeleteObject(rgn);
        }
    }
}

/// The panel's window is on the desktop (not parked, not hidden): a fold there can be seen.
pub fn panel_on_screen() -> bool {
    SHOWN.load(Ordering::SeqCst) && !PARKED.load(Ordering::SeqCst)
}

/// The host window's client origin in screen px, while it is on screen: where the drag engine's
/// targets (published in egui points × pixels_per_point) sit.
pub fn client_origin() -> Option<(i32, i32)> {
    if !SHOWN.load(Ordering::SeqCst) || PARKED.load(Ordering::SeqCst) {
        return None;
    }
    let hwnd = own_window();
    if hwnd.is_null() {
        return None;
    }
    let mut origin = POINT { x: 0, y: 0 };
    (unsafe { ClientToScreen(hwnd, &mut origin) } != 0).then_some((origin.x, origin.y))
}

/// The top-level window under (x, y) (click-through layered windows, like the drag card, are
/// skipped by WindowFromPoint), as an id for caching.
pub fn root_at(x: i32, y: i32) -> isize {
    unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) as isize }
}

/// Whether a top-level window belongs to another program: neither Photoshop nor this helper.
/// Only over such a window does a WaveLayer drag become a drag to another program (OLE).
pub fn is_foreign(root: isize) -> bool {
    let h = root as HWND;
    if h.is_null() {
        return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, &mut pid) };
    pid != 0 && pid != std::process::id() && !is_photoshop(h)
}

/// The generate panel slides down a little before it is put away, and up into place when it
/// comes back; the variant rail does the same sideways (anim.rs). One counter per window: a newer
/// move of that window stops the slide that is running.
static LINKED_SLIDE: AtomicU32 = AtomicU32::new(0);
static VARIANT_SLIDE: AtomicU32 = AtomicU32::new(0);
/// off screen: nothing to slide
fn on_screen(h: HWND) -> Option<(i32, i32)> {
    window_rect(h).filter(|r| r.left > PARK.0 + 1000 && r.top > PARK.1 + 1000).map(|r| (r.left, r.top))
}
fn linked_place() -> Option<(i32, i32)> {
    PLACED.lock().ok().and_then(|p| p.as_ref().map(|p| (p.at.0, p.at.1)))
}
fn variant_place_now() -> Option<(i32, i32)> {
    VARIANT_GEOMETRY.lock().ok().map(|g| (g.x, g.y))
}

fn park(me: HWND) {
    // on screen: slide out first, then off screen (park_now); logically it is away already
    if let Some(from) = on_screen(me) {
        PARKED.store(true, Ordering::SeqCst);
        crate::anim::slide(me as isize, &LINKED_SLIDE, crate::anim::Place::Fixed(from), (0, crate::anim::SLIDE_PX), false, crate::anim::SLIDE_OUT_MS, Some(|h| park_now(h as HWND)));
        return;
    }
    LINKED_SLIDE.fetch_add(1, Ordering::SeqCst);
    park_now(me);
}

fn park_now(me: HWND) {
    let ok = unsafe {
        SetWindowPos(
            me,
            null_mut(),
            PARK.0,
            PARK.1,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
    } != 0;
    if ok {
        PARKED.store(true, Ordering::SeqCst);
    } else {
        log::line("park: SetWindowPos failed");
    }
}

/// Return to the last logical on-screen rectangle, not the off-screen park coordinates.
fn restore_parked(me: HWND) {
    let desired = PLACED
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|p| (p.at.0, p.at.1, p.size.0, p.size.1)));
    let Some((x, y, w, h)) = desired else {
        return;
    };
    // it comes up from a little below its place (anim.rs); the slide ends on PLACED as it is then
    let ok = unsafe {
        SetWindowPos(
            me,
            HWND_TOPMOST,
            x,
            y + crate::anim::SLIDE_PX,
            w,
            h,
            SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
    } != 0;
    if ok {
        crate::anim::slide(me as isize, &LINKED_SLIDE, crate::anim::Place::Live(linked_place), (0, crate::anim::SLIDE_PX), true, crate::anim::SLIDE_IN_MS, None);
        PARKED.store(false, Ordering::SeqCst);
        IS_TOPMOST.store(true, Ordering::SeqCst);
        log::line(format!("linked surface restored at {x},{y}"));
    } else {
        log::line("linked surface restore failed");
    }
}

/// Once, at start: a no-activate tool window, parked off screen.
pub fn init() {
    let me = own_window();
    log::line(format!(
        "window {}",
        if me.is_null() { "not found" } else { "found" }
    ));
    if me.is_null() {
        return;
    }
    TYPING.store(false, Ordering::SeqCst);
    set_style(me, true);
    install_mouse_activation_guard(me);
    park(me);
}

/// A text box in the panel started / stopped being typed into: take the keyboard for it, or
/// give it back to Photoshop.
pub fn set_typing(on: bool) {
    let me = own_window();
    if me.is_null() {
        return;
    }
    TYPING.store(on, Ordering::SeqCst);
    log::line(format!("typing {on}"));
    set_style(me, !on);
    if on {
        unsafe {
            SetForegroundWindow(me);
        }
    } else {
        give_back_focus();
    }
}

/// The panel's content height changed (logical px): resize, keeping its bottom edge where it is.
pub fn fit_height(height: f32) {
    if !SHOWN.load(Ordering::SeqCst) {
        return;
    }
    // Use the desired on-screen location even when the physical HWND is parked at -32000.
    let target = {
        let Ok(mut placed) = PLACED.lock() else {
            return;
        };
        let Some(pl) = placed.as_mut() else { return };
        let k = dpi_at(POINT {
            x: pl.at.0,
            y: pl.at.1,
        }) / 96.0;
        let h = (height as f64 * k).round() as i32;
        if (pl.size.1 - h).abs() <= 1 {
            return;
        }
        pl.at.1 = if pl.snap.1 == -1 {
            pl.at.1
        } else {
            bottom_anchored_top(pl.at.1, pl.size.1, h)
        };
        pl.size.1 = h;
        (pl.at.0, pl.at.1, pl.size.0, h)
    };
    if PARKED.load(Ordering::SeqCst) {
        return; // next restore will use the updated height and original bottom edge
    }
    unsafe {
        SetWindowPos(
            own_window(),
            null_mut(),
            target.0,
            target.1,
            target.2,
            target.3,
            // from the window's own (UI) thread: done before the next frame is drawn at the new size
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn dpi_at(pt: POINT) -> f64 {
    let (mut dx, mut dy) = (96u32, 96u32);
    unsafe {
        GetDpiForMonitor(
            MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST),
            0,
            &mut dx,
            &mut dy,
        );
    }
    dx as f64
}

/// The completion notice's window (an egui viewport): owned by Photoshop, no-activate, in the
/// bottom-right corner of `view` (else of Photoshop's window). False until the window exists.
pub fn place_toast(view: Option<ScreenRect>, size: Vec2) -> bool {
    let t = find(TOAST_TITLE);
    if t.is_null() {
        return false;
    }
    set_style(t, true);
    let owner = OWNER.load(Ordering::SeqCst) as HWND;
    let area = match view {
        Some(v) => (v.left, v.top, v.right, v.bottom),
        None => match window_rect(owner) {
            Some(r) => (r.left as f64, r.top as f64, r.right as f64, r.bottom as f64),
            None => return true, // nowhere better than where egui put it
        },
    };
    let k = dpi_at(POINT {
        x: area.2 as i32 - 1,
        y: area.3 as i32 - 1,
    }) / 96.0;
    // above the status bar (monitor.rs) along the canvas' bottom edge, when it is up
    let (w, h, m) = (size.x as f64 * k, size.y as f64 * k, MARGIN * k + crate::monitor::bar_height() as f64);
    unsafe {
        if !owner.is_null() {
            SetWindowLongPtrW(t, GWLP_HWNDPARENT, owner as isize);
        }
        SetWindowPos(
            t,
            null_mut(),
            (area.2 - w - m) as i32,
            (area.3 - h - m) as i32,
            w as i32,
            h as i32,
            SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
    log::line("toast placed");
    true
}

pub fn show(panel: &str, view: Option<ScreenRect>, size: Vec2) {
    let me = own_window();
    if me.is_null() {
        return;
    }
    if let Ok(mut current) = CURRENT_PANEL.lock() {
        *current = Some(panel.to_string());
    }
    let (x, y, w, h, owner_rect, bounds, snap) = unsafe {
        let pt = match view {
            Some(v) => POINT {
                x: ((v.left + v.right) / 2.0) as i32,
                y: ((v.top + v.bottom) / 2.0) as i32,
            },
            None => {
                let mut p = POINT { x: 0, y: 0 };
                GetCursorPos(&mut p);
                p
            }
        };
        let found = photoshop_at(pt);
        // When a different app covers the canvas, reuse the last Photoshop HWND instead of
        // accidentally forgetting it. Never give this independent Rust window an HWND owner.
        let previous = OWNER.load(Ordering::SeqCst) as HWND;
        let ps = if !found.is_null() {
            found
        } else if !previous.is_null() && IsWindow(previous) != 0 && is_photoshop(previous) {
            previous
        } else {
            null_mut()
        };
        OWNER.store(ps as isize, Ordering::SeqCst);
        if !photoshop_window_ready(ps) {
            // During minimise, UXP may report a -32000 canvas rectangle. Keep the last valid
            // screen-space geometry so restoring Photoshop can recover the original position.
            SHOWN.store(true, Ordering::SeqCst);
            set_topmost(me, false);
            park(me);
            log::line("show deferred: Photoshop unavailable or minimised");
            return;
        }
        let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let (mut dx, mut dy) = (96u32, 96u32);
        GetDpiForMonitor(mon, 0, &mut dx, &mut dy);
        let k = dx as f64 / 96.0;
        // the canvas; failing that Photoshop's window; failing that the monitor
        let area = match view {
            Some(v) => (v.left, v.top, v.right, v.bottom),
            None => match window_rect(ps) {
                Some(r) => (r.left as f64, r.top as f64, r.right as f64, r.bottom as f64),
                None => {
                    let mut mi: MONITORINFO = std::mem::zeroed();
                    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                    GetMonitorInfoW(mon, &mut mi);
                    (
                        mi.rcWork.left as f64,
                        mi.rcWork.top as f64,
                        mi.rcWork.right as f64,
                        mi.rcWork.bottom as f64,
                    )
                }
            },
        };
        let m = MARGIN * k;
        let w = size.x as f64 * k;
        let h = (size.y as f64 * k).min((area.3 - area.1 - 2.0 * m).max(200.0 * k));
        let bounds = RECT {
            left: area.0.round() as i32,
            top: area.1.round() as i32,
            right: area.2.round() as i32,
            bottom: area.3.round() as i32,
        };
        // Free positions retain the existing bottom-left-relative offset. When an edge was
        // magnetically attached, recompute that edge from the latest canvas dimensions.
        let (ox, oy) = OFFSET.lock().map(|o| *o).unwrap_or((0, 0));
        let mut snap = SNAP.lock().map(|s| *s).unwrap_or((0, 0));
        if w > area.2 - area.0 { snap.0 = 0; }
        if h > area.3 - area.1 { snap.1 = 0; }
        if let Ok(mut saved) = SNAP.lock() { *saved = snap; }
        let free_x = (area.0 + m + ox as f64).clamp(area.0, (area.2 - w).max(area.0));
        let free_y = (area.3 - h - m + oy as f64).clamp(area.1, (area.3 - h).max(area.1));
        let x = match snap.0 {
            -1 => area.0,
            1 => (area.2 - w).max(area.0),
            _ => free_x,
        };
        let y = match snap.1 {
            -1 => area.1,
            1 => (area.3 - h).max(area.1),
            _ => free_y,
        };
        (x as i32, y as i32, w as i32, h as i32, window_rect(ps), bounds, snap)
    };
    // Store the desired geometry before any parking; the physical parked HWND is never the
    // source of truth for restore, resizing, or user dragging.
    if let Ok(mut p) = PLACED.lock() {
        *p = owner_rect.map(|owner| Placed {
            panel: panel.to_string(),
            owner,
            bounds,
            at: (x, y),
            size: (w, h),
            snap,
        });
    }
    VIEW_REQUESTED.store(false, Ordering::SeqCst);
    SHOWN.store(true, Ordering::SeqCst);
    // the same rule as watch(); a show arriving before its first tick looks at the foreground itself
    let ready = photoshop_window_ready(OWNER.load(Ordering::SeqCst) as HWND);
    let active = ready
        && (photoshop_present() || present_now(true, steady_front(who(unsafe { GetForegroundWindow() }), "")));
    if active {
        restore_parked(me);
    } else {
        set_topmost(me, false);
        park(me);
    }
    log::line(format!("show {panel} at {x},{y} linked_active={active}"));
}

pub fn hide(panel: &str) {
    let up = PLACED
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|pl| pl.panel == panel))
        .unwrap_or(true);
    if up {
        hide_all();
    }
}

pub fn hide_all() {
    SHOWN.store(false, Ordering::SeqCst);
    VIEW_REQUESTED.store(false, Ordering::SeqCst);
    if let Ok(mut panel) = CURRENT_PANEL.lock() {
        *panel = None;
    }
    let me = own_window();
    if me.is_null() {
        return;
    }
    log::line("hide");
    TYPING.store(false, Ordering::SeqCst);
    give_back_focus();
    set_style(me, true);
    set_topmost(me, false);
    park(me);
}

/// If the panel has the keyboard, hand it back to Photoshop.
pub fn give_back_focus() {
    let me = own_window();
    let owner = OWNER.load(Ordering::SeqCst) as HWND;
    unsafe {
        if !me.is_null() && !owner.is_null() && GetForegroundWindow() == me && IsWindow(owner) != 0
        {
            SetForegroundWindow(owner);
            log::line("keyboard back to photoshop");
        }
    }
}

/// Capture the physical cursor and window origin once when the grip drag begins.
/// Screen coordinates are stable while the HWND moves; egui's local pointer delta is not.
pub fn drag_started() {
    if !SHOWN.load(Ordering::SeqCst) || PARKED.load(Ordering::SeqCst) {
        return;
    }
    let Some(rect) = window_rect(own_window()) else {
        return;
    };
    let mut cursor = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        log::line("generate grip GetCursorPos failed at drag start");
        return;
    }
    let Some((bounds, size)) = PLACED.lock().ok().and_then(|placed| {
        placed.as_ref().map(|p| (p.bounds, p.size))
    }) else {
        return;
    };
    if let Ok(mut origin) = DRAG_ORIGIN.lock() {
        *origin = Some(DragOrigin {
            cursor: (cursor.x, cursor.y),
            window: (rect.left, rect.top),
            bounds,
            size,
        });
    }
    log::line(format!(
        "generate grip drag origin cursor={},{} window={},{}",
        cursor.x, cursor.y, rect.left, rect.top
    ));
}

/// Move to an absolute position derived from the original cursor/window pair.
/// Repeated samples are idempotent, so moving the HWND cannot feed back into the next delta.
pub fn drag_to_cursor() {
    if !SHOWN.load(Ordering::SeqCst) || PARKED.load(Ordering::SeqCst) {
        return;
    }
    let Some(origin) = DRAG_ORIGIN.lock().ok().and_then(|state| *state) else {
        return;
    };
    let mut cursor = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        return;
    }
    let threshold = snap_threshold_px(dpi_at(cursor) / 96.0);
    let (x, y, snap_x, snap_y) = snap_panel_target(
        origin.window,
        origin.cursor,
        (cursor.x, cursor.y),
        origin.bounds,
        origin.size,
        threshold,
    );
    if let Ok(mut snap) = SNAP.lock() {
        *snap = (snap_x, snap_y);
    }
    if let Ok(mut placed) = PLACED.lock() {
        if let Some(p) = placed.as_mut() {
            p.at = (x, y);
            p.snap = (snap_x, snap_y);
        }
    }
    let ok = unsafe {
        SetWindowPos(
            own_window(),
            null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    } != 0;
    if !ok {
        log::line("generate grip SetWindowPos failed");
    }
}

/// The user let go of the panel after dragging it by its corner: keep it there next time.
pub fn drag_finished() {
    let started = DRAG_ORIGIN
        .lock()
        .ok()
        .and_then(|mut origin| origin.take())
        .is_some();
    if !started || PARKED.load(Ordering::SeqCst) {
        return; // never turn (-32000, -32000) into a saved drag offset
    }
    let Some(now) = window_rect(own_window()) else {
        return;
    };
    if let (Ok(mut placed), Ok(mut offset)) = (PLACED.lock(), OFFSET.lock()) {
        if let Some(p) = placed.as_mut() {
            let k = dpi_at(POINT { x: now.left, y: now.top }) / 96.0;
            let margin = (MARGIN * k).round() as i32;
            let free_origin = (
                p.bounds.left.saturating_add(margin),
                p.bounds.bottom.saturating_sub(p.size.1).saturating_sub(margin),
            );
            offset.0 = now.left.saturating_sub(free_origin.0);
            offset.1 = now.top.saturating_sub(free_origin.1);
            p.at = (now.left, now.top);
            p.size = (now.right - now.left, now.bottom - now.top);
            p.snap = SNAP.lock().map(|s| *s).unwrap_or(p.snap);
            log::line(format!(
                "generate grip drag finished at {},{} snap={:?} offset={},{}",
                now.left, now.top, p.snap, offset.0, offset.1
            ));
        }
    }
}

/// Every 250 ms while a surface is up: if Photoshop's window moved or changed size, ask the
/// plugin for the canvas again (only it knows where the canvas is inside the window).
pub fn watch() {
    thread::spawn(|| {
        let mut front = "";
        let mut photoshop_process: isize = 0;
        let mut photoshop_pid = 0u32;
        loop {
            thread::sleep(Duration::from_millis(250));

            // Bind once to the actual Photoshop process, not the UXP panel HWND. The process
            // handle stays valid if Photoshop's main window is recreated, and signals on crash
            // or normal exit. The helper and its managed ComfyUI child then share that lifetime.
            if photoshop_process == 0 {
                let ps = find_photoshop_main_window();
                if !ps.is_null() {
                    unsafe { GetWindowThreadProcessId(ps, &mut photoshop_pid) };
                    if photoshop_pid != 0 {
                        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, photoshop_pid) };
                        if !handle.is_null() {
                            photoshop_process = handle as isize;
                            log::line(format!("lifecycle bound to Photoshop pid={photoshop_pid}"));
                        }
                    }
                }
            } else if unsafe { WaitForSingleObject(photoshop_process as _, 0) } == WAIT_OBJECT_0 {
                unsafe { CloseHandle(photoshop_process as _) };
                log::line(format!(
                    "Photoshop pid={photoshop_pid} exited; shutting down helper"
                ));
                crate::comfy::photoshop_closed();
                if crate::app::stays() {
                    // the user keeps WavePlug open (its window, the Start menu, 保持运行): wait for
                    // the next Photoshop
                    log::line("WavePlug stays running (window open / started by the user)");
                    photoshop_process = 0;
                    photoshop_pid = 0;
                    continue;
                }
                let me = own_window();
                if !me.is_null() {
                    unsafe { PostMessageW(me, WM_CLOSE, 0, 0) };
                }
                return;
            }

            // Track the actual foreground HWND, not only the window's reported typing state.
            let foreground_hwnd = unsafe { GetForegroundWindow() };
            let now_front = steady_front(who(foreground_hwnd), front);
            let mut linked_front = now_front;

            // eframe/winit may overwrite extended styles after init() returns. Re-assert
            // the non-activating palette style once its HWND has settled, and later only
            // if another framework update removes it. Do not interfere with text editing.
            let me = own_window();
            if !me.is_null() {
                let ex = unsafe { GetWindowLongPtrW(me, GWL_EXSTYLE) };
                if needs_noactivate_style(TYPING.load(Ordering::SeqCst), ex) {
                    set_style(me, true);
                    log::line(format!(
                        "noactivate/toolwindow style restored from 0x{ex:X}"
                    ));
                }
            }

            if should_clear_typing_focus(TYPING.load(Ordering::SeqCst), now_front) {
                if TYPING.swap(false, Ordering::SeqCst) {
                    let me = own_window();
                    if !me.is_null() {
                        set_style(me, true);
                    }
                    FOCUS_LOST.store(true, Ordering::SeqCst);
                    log::line(format!(
                        "typing focus lost to {now_front}; no-activate restored"
                    ));
                }
            }
            if should_restore_photoshop_focus(
                SHOWN.load(Ordering::SeqCst),
                TYPING.load(Ordering::SeqCst),
                now_front,
                is_photoshop(OWNER.load(Ordering::SeqCst) as HWND),
            ) {
                let owner = OWNER.load(Ordering::SeqCst) as HWND;
                let restored = unsafe { SetForegroundWindow(owner) } != 0;
                if restored {
                    // Avoid a one-frame disappear/reappear while returning accidental focus.
                    linked_front = "photoshop";
                }
                if now_front != front {
                    log::line(format!(
                        "unexpected overlay foreground; restore photoshop={restored}"
                    ));
                }
            }
            if now_front != front {
                log::line(format!("keyboard: {now_front}"));
                front = now_front;
            }
            // the one answer every window that goes with Photoshop follows
            let was = PS_PRESENT.load(Ordering::SeqCst);
            let present = next_presence(
                was,
                present_now(photoshop_window_ready(monitor_photoshop()), linked_front),
                &PS_AWAY_TICKS,
            );
            if present != was {
                PS_PRESENT.store(present, Ordering::SeqCst);
                log::line(format!("photoshop present {present}: foreground={now_front}"));
            }
            // Independent viewports follow Photoshop even when the generate surface is hidden.
            watch_variant(now_front, present);
            watch_shelf(now_front, present);
            if !SHOWN.load(Ordering::SeqCst) {
                continue;
            }
            let owner = OWNER.load(Ordering::SeqCst) as HWND;
            let active = present && photoshop_window_ready(owner);
            if active {
                let has_placement = PLACED.lock().ok().is_some_and(|p| p.is_some());
                if !has_placement {
                    // If the EXE started while Photoshop was minimised, no valid canvas rect
                    // exists yet. Ask UXP for one after Photoshop is restored (once only).
                    if !VIEW_REQUESTED.swap(true, Ordering::SeqCst) {
                        if let Some(panel) = CURRENT_PANEL.lock().ok().and_then(|p| p.clone()) {
                            server::send(&Event::ViewRequest { panel });
                            log::line("linked surface requesting fresh Photoshop canvas");
                        }
                    }
                    continue;
                }
                if PARKED.load(Ordering::SeqCst) {
                    restore_parked(me);
                } else {
                    set_topmost(me, true);
                }
            } else {
                // Another application, minimised Photoshop, or a closed Photoshop window removes
                // this panel from the desktop (`present` already waited out a foreground blink).
                if !PARKED.load(Ordering::SeqCst) {
                    set_topmost(me, false);
                    park(me);
                    log::line(format!("linked surface parked: foreground={now_front}"));
                } else if IS_TOPMOST.load(Ordering::SeqCst) {
                    set_topmost(me, false);
                }
                continue;
            }
            let Some(now) = window_rect(owner) else {
                continue;
            };
            let mut placed = match PLACED.lock() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if let Some(p) = placed.as_mut() {
                let was = p.owner;
                if (was.left, was.top, was.right, was.bottom)
                    != (now.left, now.top, now.right, now.bottom)
                {
                    p.owner = now; // ask once per change; the plugin's show places it again
                    server::send(&Event::ViewRequest {
                        panel: p.panel.clone(),
                    });
                }
            }
        }
    });
}

// ── 编辑工作台 window (panel/shelf.rs): pinned to the canvas top-right, sized by its content ──
// Simpler than the variant rail on purpose: no slide, no user resize; it parks off screen while
// Photoshop (or one of our windows) isn't in front, like the others.
static SHELF_SHOWN: AtomicBool = AtomicBool::new(false);
static SHELF_PARKED: AtomicBool = AtomicBool::new(true);
static SHELF_VIEW: Mutex<Option<ScreenRect>> = Mutex::new(None);
static SHELF_OWNER: AtomicIsize = AtomicIsize::new(0);
/// logical size the content asks for
static SHELF_SIZE: Mutex<(f32, f32)> = Mutex::new((crate::panel::shelf::WIDTH, 200.0));
static SHELF_GUARD_HWND: AtomicIsize = AtomicIsize::new(0);
static SHELF_ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn shelf_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_MOUSEACTIVATE {
        return MA_NOACTIVATE; // the click goes in, the keyboard stays with Photoshop
    }
    let original = SHELF_ORIGINAL_WNDPROC.load(Ordering::SeqCst);
    if original != 0 {
        let proc: WNDPROC = unsafe { std::mem::transmute(original) };
        unsafe { CallWindowProcW(proc, hwnd, msg, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

fn install_shelf_guard(h: HWND) {
    if h.is_null() || SHELF_GUARD_HWND.load(Ordering::SeqCst) == h as isize {
        return;
    }
    unsafe {
        let orig = GetWindowLongPtrW(h, GWLP_WNDPROC);
        if orig == 0 || orig == shelf_wnd_proc as *const () as isize {
            return;
        }
        let prior = SetWindowLongPtrW(h, GWLP_WNDPROC, shelf_wnd_proc as *const () as isize);
        if prior != 0 {
            SHELF_ORIGINAL_WNDPROC.store(prior, Ordering::SeqCst);
            SHELF_GUARD_HWND.store(h as isize, Ordering::SeqCst);
        }
    }
}

fn shelf_hwnd() -> HWND {
    find(crate::panel::shelf::TITLE)
}

pub fn shelf_window_exists() -> bool {
    !shelf_hwnd().is_null()
}

/// Screen rectangle (physical px) for the workbench at the canvas top-right.
fn shelf_rect_for(view: Option<ScreenRect>, owner: HWND) -> Option<(i32, i32, i32, i32)> {
    let (right, top) = view
        .filter(|v| v.right > v.left && v.bottom > v.top && v.left > -30000.0 && v.top > -30000.0)
        .map(|v| (v.right.round() as i32, v.top.round() as i32))
        .or_else(|| window_rect(owner).map(|r| (r.right, r.top)))?;
    let k = dpi_at(POINT { x: right - 1, y: top }) / 96.0;
    let (lw, lh) = SHELF_SIZE.lock().map(|s| *s).unwrap_or((crate::panel::shelf::WIDTH, 200.0));
    let (w, h) = ((lw as f64 * k).round() as i32, (lh as f64 * k).round() as i32);
    let m = (MARGIN * k).round() as i32;
    Some((right - m - w, top + m, w.max(80), h.max(60)))
}

fn shelf_put(h: HWND) {
    let view = SHELF_VIEW.lock().ok().and_then(|v| *v);
    let owner = SHELF_OWNER.load(Ordering::SeqCst) as HWND;
    let Some((x, y, w, ht)) = shelf_rect_for(view, owner) else { return };
    let ok = unsafe { SetWindowPos(h, HWND_TOPMOST, x, y, w, ht, SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) } != 0;
    if ok && SHELF_PARKED.swap(false, Ordering::SeqCst) {
        log::line(format!("workbench shown at {x},{y} size {w}x{ht}"));
    }
}

fn shelf_park(h: HWND) {
    let ok = unsafe { SetWindowPos(h, HWND_NOTOPMOST, PARK.0, PARK.1, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) } != 0;
    if ok {
        SHELF_PARKED.store(true, Ordering::SeqCst);
    }
}

/// The plugin showed the workbench against `view` (the canvas). False until egui made the window.
pub fn shelf_place(view: Option<ScreenRect>) -> bool {
    let h = shelf_hwnd();
    if h.is_null() {
        return false;
    }
    set_style(h, true);
    install_shelf_guard(h);
    let pt = view.map(|v| POINT { x: ((v.left + v.right) * 0.5) as i32, y: ((v.top + v.bottom) * 0.5) as i32 }).unwrap_or_else(|| {
        let mut p = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut p) };
        p
    });
    SHELF_OWNER.store(photoshop_at(pt) as isize, Ordering::SeqCst);
    if let Ok(mut v) = SHELF_VIEW.lock() {
        *v = view.or(*v);
    }
    SHELF_SHOWN.store(true, Ordering::SeqCst);
    SHELF_PARKED.store(true, Ordering::SeqCst);
    shelf_put(h);
    true
}

/// The content asks for another size (logical px): follow it, keeping the top-right corner.
pub fn shelf_sync(width: f32, height: f32) {
    let changed = SHELF_SIZE.lock().map(|mut s| {
        let new = (width, height.min(640.0));
        let c = (s.0 - new.0).abs() > 0.5 || (s.1 - new.1).abs() > 0.5;
        *s = new;
        c
    }).unwrap_or(false);
    if changed && SHELF_SHOWN.load(Ordering::SeqCst) && !SHELF_PARKED.load(Ordering::SeqCst) {
        let h = shelf_hwnd();
        if !h.is_null() {
            shelf_put(h);
        }
    }
}

pub fn shelf_hide() {
    SHELF_SHOWN.store(false, Ordering::SeqCst);
    let h = shelf_hwnd();
    if !h.is_null() {
        shelf_park(h);
    }
}

/// Where the workbench is on screen now (a drop target), None while hidden or parked.
pub fn shelf_screen_rect() -> Option<(i32, i32, i32, i32)> {
    if !SHELF_SHOWN.load(Ordering::SeqCst) || SHELF_PARKED.load(Ordering::SeqCst) {
        return None;
    }
    window_rect(shelf_hwnd()).map(|r| (r.left, r.top, r.right, r.bottom))
}

/// Whether the cursor's top-level window at (x, y) is Photoshop (a drag out of the workbench lands there).
pub fn photoshop_under(x: i32, y: i32) -> bool {
    is_photoshop(root_at(x, y) as HWND)
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

/// Follow Photoshop: on screen while it (or one of our windows) is in front, parked otherwise.
fn watch_shelf(foreground: &str, present: bool) {
    if !SHELF_SHOWN.load(Ordering::SeqCst) {
        return;
    }
    let h = shelf_hwnd();
    if h.is_null() {
        SHELF_PARKED.store(true, Ordering::SeqCst);
        return;
    }
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    if needs_noactivate_style(false, ex) {
        set_style(h, true);
    }
    install_shelf_guard(h);
    let owner = SHELF_OWNER.load(Ordering::SeqCst) as HWND;
    let active = present && photoshop_window_ready(owner);
    if !active {
        if !SHELF_PARKED.load(Ordering::SeqCst) {
            shelf_park(h);
            log::line(format!("workbench parked: foreground={foreground}"));
        }
        return;
    }
    if SHELF_PARKED.load(Ordering::SeqCst) {
        shelf_put(h);
    }
}
