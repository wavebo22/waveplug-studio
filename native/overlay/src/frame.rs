// 悬停边框: a thin frame on Photoshop's canvas around the layer whose WaveLayer row is hovered
// (the plugin works out where: src/core/overlay/hoverFrame.ts).
//
// Its own plain Win32 window on its own thread — no egui, no GPU, nothing redrawn per frame. The
// window is one solid colour shaped by a window region to just the frame's edges, so there is
// nothing to paint but the background, and the region is cut to the canvas view so it never covers
// Photoshop's panels.
//
// It never takes the focus or the mouse: layered + transparent (clicks and the wheel go to the
// window under it, across processes), no-activate, a tool window (not on the taskbar or in
// Alt+Tab). Showing and hiding go through SetWindowPos / ShowWindow with SWP_NOACTIVATE /
// SW_HIDE, which don't touch the foreground window. Callers (the server thread) only post a
// message, so a busy window never holds up the plugin's connection.

use crate::protocol::ScreenRect;

#[cfg(windows)]
pub use imp::set;

/// Shows the frame around `rect` (screen px) cut to `clip`; `None` hides it.
#[cfg(not(windows))]
pub fn set(_rect: Option<ScreenRect>, _clip: Option<ScreenRect>) {}

/// Where the window goes and the frame inside it, in screen px: the frame lies just outside
/// `rect` (`t` px wide) so it never covers the layer's own edge pixels, and the window is that
/// cut to `clip`. None when nothing of it is left to show.
#[cfg_attr(not(windows), allow(dead_code))]
fn layout(rect: ScreenRect, clip: Option<ScreenRect>, t: i32) -> Option<((i32, i32, i32, i32), (i32, i32, i32, i32))> {
    let r = (rect.left.round() as i32, rect.top.round() as i32, rect.right.round() as i32, rect.bottom.round() as i32);
    if r.2 <= r.0 || r.3 <= r.1 {
        return None;
    }
    let outer = (r.0 - t, r.1 - t, r.2 + t, r.3 + t);
    let win = match clip {
        Some(c) => (
            outer.0.max(c.left.round() as i32),
            outer.1.max(c.top.round() as i32),
            outer.2.min(c.right.round() as i32),
            outer.3.min(c.bottom.round() as i32),
        ),
        None => outer,
    };
    if win.2 <= win.0 || win.3 <= win.1 {
        return None;
    }
    // a frame wholly cut away (the rect's inside fills the clip) shows nothing
    let inside = (win.0 >= r.0) && (win.1 >= r.1) && (win.2 <= r.2) && (win.3 <= r.3);
    if inside {
        return None;
    }
    Some((win, outer))
}

#[cfg(windows)]
mod imp {
    use std::ptr::null;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::{Mutex, Once};
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateSolidBrush, DeleteObject, MonitorFromPoint, SetWindowRgn,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW, RegisterClassW,
        SetLayeredWindowAttributes, SetWindowPos, ShowWindow, MSG, WNDCLASSW,
    };

    use super::layout;
    use crate::log;
    use crate::protocol::ScreenRect;

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const LWA_ALPHA: u32 = 0x0000_0002;
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const WM_NCHITTEST: u32 = 0x0084;
    const WM_APP_FRAME: u32 = 0x8000 + 0x51;
    const MA_NOACTIVATE: LRESULT = 3;
    const HTTRANSPARENT: LRESULT = -1;
    const SW_HIDE: i32 = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    const HWND_TOPMOST: HWND = -1isize as HWND;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const RGN_DIFF: i32 = 4;
    /// Photoshop-like selection blue, COLORREF 0x00BBGGRR
    const COLOR: u32 = 0x00FF_8C1E; // #1E8CFF

    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
    /// the latest request; the window thread takes it, older ones are simply overwritten
    static WANTED: Mutex<Option<(ScreenRect, Option<ScreenRect>)>> = Mutex::new(None);
    static START: Once = Once::new();

    /// Shows the frame around `rect` (screen px) cut to `clip`; `None` hides it.
    pub fn set(rect: Option<ScreenRect>, clip: Option<ScreenRect>) {
        if let Ok(mut w) = WANTED.lock() {
            *w = rect.map(|r| (r, clip));
        }
        if rect.is_none() && HWND_SELF.load(Ordering::SeqCst) == 0 {
            return; // never shown: nothing to hide, and no window to make
        }
        START.call_once(|| {
            thread::spawn(run);
        });
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !h.is_null() {
            unsafe { PostMessageW(h, WM_APP_FRAME, 0, 0) };
        }
        // before the window exists, `run` applies WANTED once it does
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// frame width: 1 px at 100 % display scale, 2 px at 150–249 %, …
    fn thickness_at(x: i32, y: i32) -> i32 {
        let (mut dx, mut dy) = (96u32, 96u32);
        unsafe { GetDpiForMonitor(MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST), 0, &mut dx, &mut dy) };
        ((dx as f64 / 96.0).round() as i32).max(1)
    }

    unsafe fn apply(h: HWND) {
        let wanted = WANTED.lock().ok().and_then(|w| *w);
        let Some((rect, clip)) = wanted else {
            ShowWindow(h, SW_HIDE);
            return;
        };
        let t = thickness_at(((rect.left + rect.right) / 2.0) as i32, ((rect.top + rect.bottom) / 2.0) as i32);
        let Some((win, outer)) = layout(rect, clip, t) else {
            ShowWindow(h, SW_HIDE);
            return;
        };
        // the frame's edges in window coordinates; the window's own edges cut whatever is outside it
        let (ox, oy) = (outer.0 - win.0, outer.1 - win.1);
        let (ow, oh) = (outer.2 - outer.0, outer.3 - outer.1);
        let rgn = CreateRectRgn(ox, oy, ox + ow, oy + oh);
        let hole = CreateRectRgn(ox + t, oy + t, ox + ow - t, oy + oh - t);
        CombineRgn(rgn, rgn, hole, RGN_DIFF);
        DeleteObject(hole);
        // the window owns the region from here on
        if SetWindowRgn(h, rgn, 1) == 0 {
            DeleteObject(rgn);
        }
        SetWindowPos(
            h,
            HWND_TOPMOST,
            win.0,
            win.1,
            win.2 - win.0,
            win.3 - win.1,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER,
        );
    }

    unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_APP_FRAME => {
                apply(h);
                0
            }
            WM_MOUSEACTIVATE => MA_NOACTIVATE,
            WM_NCHITTEST => HTTRANSPARENT,
            _ => DefWindowProcW(h, msg, w, l),
        }
    }

    fn run() {
        unsafe {
            let inst = GetModuleHandleW(null());
            let class = wide("WavePlugHoverFrame");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: inst,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: CreateSolidBrush(COLOR),
                lpszMenuName: null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            let title = wide("WavePlug 悬停边框");
            let h = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                inst,
                null(),
            );
            if h.is_null() {
                log::line("hover frame: window not created");
                return;
            }
            // fully opaque; layered is what makes WS_EX_TRANSPARENT pass clicks to other processes
            SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA);
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            log::line("hover frame: window ready");
            apply(h);
            let mut m: MSG = std::mem::zeroed();
            while GetMessageW(&mut m, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: f64, top: f64, right: f64, bottom: f64) -> ScreenRect {
        ScreenRect { left, top, right, bottom }
    }

    #[test]
    fn frame_sits_outside_the_layer() {
        let (win, outer) = layout(r(100.0, 100.0, 200.0, 150.0), None, 2).unwrap();
        assert_eq!(outer, (98, 98, 202, 152));
        assert_eq!(win, outer);
    }

    #[test]
    fn window_is_cut_to_the_canvas() {
        let (win, outer) = layout(r(100.0, 100.0, 200.0, 150.0), Some(r(150.0, 0.0, 1000.0, 1000.0)), 1).unwrap();
        assert_eq!(win, (150, 99, 201, 151));
        assert_eq!(outer, (99, 99, 201, 151));
    }

    #[test]
    fn nothing_to_show() {
        // outside the canvas
        assert!(layout(r(100.0, 100.0, 200.0, 150.0), Some(r(500.0, 500.0, 900.0, 900.0)), 1).is_none());
        // zoomed in so far that the layer covers the whole canvas: every edge is cut away
        assert!(layout(r(-10.0, -10.0, 2000.0, 2000.0), Some(r(0.0, 0.0, 800.0, 600.0)), 1).is_none());
        // empty
        assert!(layout(r(100.0, 100.0, 100.0, 150.0), None, 1).is_none());
    }
}
