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
// message, so a busy window never holds up the plugin's connection; requests that come faster
// than the window takes them (a quick sweep down the list) are folded into one: only the latest
// is applied, and one that changes nothing changes nothing.
//
// 悬停高亮: once the pointer rests on a row the plugin also sends the layer's own shape (its
// coverage, at most 256 px a side), and a second window — per-pixel alpha (UpdateLayeredWindow),
// equally click-through — tints that shape lightly in the frame's blue over the canvas. It lies on
// top of everything, so the parts of the layer other layers cover show too.

use crate::protocol::ScreenRect;

#[cfg(windows)]
pub use imp::{set, set_tint};

/// Shows the frame around `rect` (screen px) cut to `clip`; `None` hides it (and the tint).
#[cfg(not(windows))]
pub fn set(_rect: Option<ScreenRect>, _clip: Option<ScreenRect>) {}

/// Tints the hovered layer's shape; `None` takes the tint away.
#[cfg(not(windows))]
pub fn set_tint(_tint: Option<Tint>) {}

/// The hovered layer's shape: `alpha` is `width` × `height` coverage (0–255) stretched over `rect`.
#[derive(Debug, Clone, PartialEq)]
pub struct Tint {
    pub rect: ScreenRect,
    pub clip: Option<ScreenRect>,
    pub width: u32,
    pub height: u32,
    pub alpha: Vec<u8>,
}

/// the largest shape taken (a side), as the plugin reads it
const TINT_MAX: u32 = 512;

impl Tint {
    /// From the plugin's message; None when it doesn't add up (sizes, base64, an empty rect).
    pub fn decode(rect: ScreenRect, clip: Option<ScreenRect>, width: u32, height: u32, alpha: &str) -> Option<Tint> {
        if width == 0 || height == 0 || width > TINT_MAX || height > TINT_MAX || rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        let bytes = data_encoding::BASE64.decode(alpha.as_bytes()).ok()?;
        (bytes.len() == (width * height) as usize).then(|| Tint { rect, clip, width, height, alpha: bytes })
    }
}

/// The tint window's place (left, top, right, bottom: `rect` cut to `clip`, screen px) and its
/// pixels, premultiplied BGRA top-down: `color` (r, g, b) at `strength` × the shape's coverage,
/// nearest sample. None when nothing of it is on the canvas.
#[cfg_attr(not(windows), allow(dead_code))]
fn tint_pixels(t: &Tint, color: (u8, u8, u8), strength: f32) -> Option<((i32, i32, i32, i32), Vec<u32>)> {
    let r = (t.rect.left.round() as i32, t.rect.top.round() as i32, t.rect.right.round() as i32, t.rect.bottom.round() as i32);
    let win = match t.clip {
        Some(c) => (r.0.max(c.left.round() as i32), r.1.max(c.top.round() as i32), r.2.min(c.right.round() as i32), r.3.min(c.bottom.round() as i32)),
        None => r,
    };
    let (w, h) = (win.2 - win.0, win.3 - win.1);
    if w <= 0 || h <= 0 {
        return None;
    }
    let (rw, rh) = ((r.2 - r.0).max(1) as f64, (r.3 - r.1).max(1) as f64);
    // the shape's column / row for each column / row of the window (worked out once)
    let cols: Vec<usize> = (0..w).map(|x| ((((win.0 + x - r.0) as f64 + 0.5) / rw * t.width as f64) as usize).min(t.width as usize - 1)).collect();
    let rows: Vec<usize> = (0..h).map(|y| ((((win.1 + y - r.1) as f64 + 0.5) / rh * t.height as f64) as usize).min(t.height as usize - 1)).collect();
    // premultiplied colour for each coverage value
    let k = strength.clamp(0.0, 1.0);
    let lut: Vec<u32> = (0..256u32)
        .map(|c| {
            let a = (c as f32 * k).round() as u32;
            let pm = |v: u8| (v as u32 * a + 127) / 255;
            (a << 24) | (pm(color.0) << 16) | (pm(color.1) << 8) | pm(color.2)
        })
        .collect();
    let mut px = vec![0u32; (w * h) as usize];
    for (y, &sy) in rows.iter().enumerate() {
        let src = &t.alpha[sy * t.width as usize..(sy + 1) * t.width as usize];
        let dst = &mut px[y * w as usize..(y + 1) * w as usize];
        for (d, &sx) in dst.iter_mut().zip(cols.iter()) {
            *d = lut[src[sx] as usize];
        }
    }
    Some((win, px))
}

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
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{Mutex, Once};
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateCompatibleDC, CreateDIBSection, CreateRectRgn, CreateSolidBrush, DeleteDC, DeleteObject,
        GetDC, MonitorFromPoint, ReleaseDC, SelectObject, SetWindowRgn, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW, RegisterClassW,
        SetLayeredWindowAttributes, SetWindowPos, ShowWindow, UpdateLayeredWindow, MSG, WNDCLASSW,
    };

    use super::{layout, tint_pixels, Tint};
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
    const WM_APP_TINT: u32 = 0x8000 + 0x52;
    const ULW_ALPHA: u32 = 0x0000_0002;
    const AC_SRC_OVER: u8 = 0;
    const AC_SRC_ALPHA: u8 = 1;
    const DIB_RGB_COLORS: u32 = 0;
    /// the tint: the frame's blue at this share of the shape's coverage
    const TINT_RGB: (u8, u8, u8) = (0x1E, 0x8C, 0xFF);
    const TINT_STRENGTH: f32 = 0.28;
    const MA_NOACTIVATE: LRESULT = 3;
    const HTTRANSPARENT: LRESULT = -1;
    const SW_HIDE: i32 = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const HWND_TOPMOST: HWND = -1isize as HWND;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const RGN_DIFF: i32 = 4;
    /// Photoshop-like selection blue, COLORREF 0x00BBGGRR
    const COLOR: u32 = 0x00FF_8C1E; // #1E8CFF

    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
    static HWND_TINT: AtomicIsize = AtomicIsize::new(0);
    /// the latest request; the window thread takes it, older ones are simply overwritten
    static WANTED: Mutex<Option<(ScreenRect, Option<ScreenRect>)>> = Mutex::new(None);
    static TINT: Mutex<Option<Tint>> = Mutex::new(None);
    /// a message is on its way to the window: more requests just update WANTED / TINT
    static FRAME_POSTED: AtomicBool = AtomicBool::new(false);
    static TINT_POSTED: AtomicBool = AtomicBool::new(false);
    static START: Once = Once::new();

    fn post(flag: &AtomicBool, msg: u32) {
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if h.is_null() {
            return; // before the window exists, `run` applies WANTED once it does
        }
        if !flag.swap(true, Ordering::SeqCst) {
            unsafe { PostMessageW(h, msg, 0, 0) };
        }
    }

    /// Shows the frame around `rect` (screen px) cut to `clip`; `None` hides it. A frame elsewhere
    /// takes the tint of the last layer away (the new one's shape follows).
    pub fn set(rect: Option<ScreenRect>, clip: Option<ScreenRect>) {
        let same = WANTED.lock().map(|mut w| std::mem::replace(&mut *w, rect.map(|r| (r, clip))) == rect.map(|r| (r, clip))).unwrap_or(false);
        if same {
            return;
        }
        if let Ok(mut t) = TINT.lock() {
            if t.is_some() {
                *t = None;
                post(&TINT_POSTED, WM_APP_TINT);
            }
        }
        if rect.is_none() && HWND_SELF.load(Ordering::SeqCst) == 0 {
            return; // never shown: nothing to hide, and no window to make
        }
        START.call_once(|| {
            thread::spawn(run);
        });
        post(&FRAME_POSTED, WM_APP_FRAME);
    }

    /// Tints the hovered layer's shape (None: no tint).
    pub fn set_tint(tint: Option<Tint>) {
        if let Ok(mut t) = TINT.lock() {
            if *t == tint {
                return;
            }
            *t = tint;
        }
        post(&TINT_POSTED, WM_APP_TINT);
    }

    /// Draws the tint window from TINT (or hides it).
    unsafe fn apply_tint() {
        let h = HWND_TINT.load(Ordering::SeqCst) as HWND;
        if h.is_null() {
            return;
        }
        let tint = TINT.lock().ok().and_then(|t| t.clone());
        let Some(t) = tint else {
            ShowWindow(h, SW_HIDE);
            return;
        };
        let Some((win, px)) = tint_pixels(&t, TINT_RGB, TINT_STRENGTH) else {
            ShowWindow(h, SW_HIDE);
            return;
        };
        let (w, ht) = (win.2 - win.0, win.3 - win.1);
        let screen = GetDC(null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -ht, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut std::ffi::c_void = null_mut();
        let dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        if dib.is_null() || bits.is_null() {
            log::line(format!("hover tint: no bitmap {w}x{ht}"));
            DeleteDC(mem);
            ReleaseDC(null_mut(), screen);
            return;
        }
        std::ptr::copy_nonoverlapping(px.as_ptr(), bits as *mut u32, px.len());
        drop(px);
        let old = SelectObject(mem, dib);
        let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA };
        let at = POINT { x: win.0, y: win.1 };
        let size = SIZE { cx: w, cy: ht };
        let zero = POINT { x: 0, y: 0 };
        UpdateLayeredWindow(h, screen, &at, &size, mem, &zero, 0, &blend, ULW_ALPHA);
        SelectObject(mem, old);
        DeleteObject(dib);
        DeleteDC(mem);
        ReleaseDC(null_mut(), screen);
        // under the frame, over Photoshop
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER | SWP_NOMOVE | SWP_NOSIZE);
        let f = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !f.is_null() {
            SetWindowPos(f, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOMOVE | SWP_NOSIZE);
        }
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
        FRAME_POSTED.store(false, Ordering::SeqCst);
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
            WM_APP_TINT => {
                TINT_POSTED.store(false, Ordering::SeqCst);
                apply_tint();
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
            // the tint: per-pixel alpha (UpdateLayeredWindow), click-through like the frame
            let tclass = wide("WavePlugHoverTint");
            let twc = WNDCLASSW { lpszClassName: tclass.as_ptr(), hbrBackground: std::ptr::null_mut(), ..wc };
            RegisterClassW(&twc);
            let ttitle = wide("WavePlug 悬停高亮");
            let t = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                tclass.as_ptr(),
                ttitle.as_ptr(),
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
            if t.is_null() {
                log::line("hover tint: window not created");
            } else {
                HWND_TINT.store(t as isize, Ordering::SeqCst);
            }
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
    fn tint_follows_the_shape_and_the_canvas() {
        // a 2 × 1 shape: left half covered, right half empty, over a 20 × 10 rect
        let t = Tint { rect: r(100.0, 100.0, 120.0, 110.0), clip: None, width: 2, height: 1, alpha: vec![255, 0] };
        let (win, px) = tint_pixels(&t, (0x1E, 0x8C, 0xFF), 0.5).unwrap();
        assert_eq!(win, (100, 100, 120, 110));
        assert_eq!(px.len(), 200);
        assert_eq!(px[0] >> 24, 128); // covered: half strength
        assert_eq!(px[19], 0); // empty: nothing
        // premultiplied: no channel above alpha
        assert!(((px[0] >> 16) & 255) <= 128 && (px[0] & 255) <= 128);
        // cut to the canvas
        let cut = Tint { clip: Some(r(110.0, 0.0, 500.0, 500.0)), ..t.clone() };
        let (win, px) = tint_pixels(&cut, (0, 0, 0), 1.0).unwrap();
        assert_eq!(win, (110, 100, 120, 110));
        assert!(px.iter().all(|&p| p == 0));
        assert!(tint_pixels(&Tint { clip: Some(r(500.0, 500.0, 600.0, 600.0)), ..t }, (0, 0, 0), 1.0).is_none());
    }

    #[test]
    fn tint_decode_checks_sizes() {
        assert!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 2, 1, "/wA=").is_some());
        assert!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 3, 1, "/wA=").is_none());
        assert!(Tint::decode(r(0.0, 0.0, 0.0, 10.0), None, 2, 1, "/wA=").is_none());
        assert!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 2, 1, "not base64!").is_none());
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
