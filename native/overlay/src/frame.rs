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
//
// 检查结果 (文档检查): the tint comes in the issue's colour (red / yellow), and a third window, as
// click-through as the others, draws a line from the hovered row of the check window to the
// nearest point of the tinted shape (set_leader: the row's edge on screen).

use crate::protocol::ScreenRect;

#[cfg(windows)]
pub use imp::{set, set_leader, set_tint};

/// The line from the check window's hovered row (`from`, screen px) to the tint; None: no line.
#[cfg(not(windows))]
pub fn set_leader(_from: Option<(i32, i32)>) {}

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
    /// the tint's colour; None: the usual blue
    pub color: Option<(u8, u8, u8)>,
}

/// "#rrggbb" as RGB
pub fn parse_color(s: &str) -> Option<(u8, u8, u8)> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

/// the largest shape taken (a side), as the plugin reads it
const TINT_MAX: u32 = 512;

impl Tint {
    /// From the plugin's message; None when it doesn't add up (sizes, base64, an empty rect).
    pub fn decode(rect: ScreenRect, clip: Option<ScreenRect>, width: u32, height: u32, alpha: &str, color: Option<&str>) -> Option<Tint> {
        if width == 0 || height == 0 || width > TINT_MAX || height > TINT_MAX || rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        let bytes = data_encoding::BASE64.decode(alpha.as_bytes()).ok()?;
        (bytes.len() == (width * height) as usize).then(|| Tint { rect, clip, width, height, alpha: bytes, color: color.and_then(parse_color) })
    }
}

/// How the hovered layer is drawn: its outline (`line` px, opaque) and, inside, a grid of thin lines
/// every `grid` px (screen px, so it doesn't swim when the canvas scrolls) over a faint fill.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    pub color: (u8, u8, u8),
    pub line: i32,
    pub grid: i32,
    /// opacity of the grid lines and of the fill between them, 0..1
    pub grid_alpha: f32,
    pub fill_alpha: f32,
}

/// The highlight window's place (left, top, right, bottom: `rect` cut to `clip`, screen px) and its
/// pixels, premultiplied BGRA top-down: the shape's outline and a grid fill inside it (`look`),
/// nearest sample of the shape. None when nothing of it is on the canvas.
#[cfg_attr(not(windows), allow(dead_code))]
fn tint_pixels(t: &Tint, look: Look) -> Option<((i32, i32, i32, i32), Vec<u32>)> {
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
    let (wu, hu) = (w as usize, h as usize);
    let mut inside = vec![false; wu * hu];
    for (y, &sy) in rows.iter().enumerate() {
        let src = &t.alpha[sy * t.width as usize..(sy + 1) * t.width as usize];
        for (x, &sx) in cols.iter().enumerate() {
            inside[y * wu + x] = src[sx] >= 96;
        }
    }
    // beyond the window: outside the shape where the window ends at the shape's own rect, the shape
    // going on where the canvas cut it (no outline along the canvas edge)
    let (cut_l, cut_t, cut_r, cut_b) = (win.0 > r.0, win.1 > r.1, win.2 < r.2, win.3 < r.3);
    let at = |x: i32, y: i32| -> bool {
        if x < 0 {
            return cut_l && inside[y.clamp(0, h - 1) as usize * wu];
        }
        if x >= w {
            return cut_r && inside[y.clamp(0, h - 1) as usize * wu + wu - 1];
        }
        if y < 0 {
            return cut_t && inside[x as usize];
        }
        if y >= h {
            return cut_b && inside[(hu - 1) * wu + x as usize];
        }
        inside[y as usize * wu + x as usize]
    };
    let pm = |a: f32| {
        let a = (a.clamp(0.0, 1.0) * 255.0).round() as u32;
        let c = |v: u8| (v as u32 * a + 127) / 255;
        (a << 24) | (c(look.color.0) << 16) | (c(look.color.1) << 8) | c(look.color.2)
    };
    let (edge, grid_px, fill_px) = (pm(1.0), pm(look.grid_alpha), pm(look.fill_alpha));
    let (d, g) = (look.line.max(1), look.grid.max(2));
    let mut px = vec![0u32; wu * hu];
    for y in 0..h {
        for x in 0..w {
            if !inside[y as usize * wu + x as usize] {
                continue;
            }
            let rim = !at(x - d, y) || !at(x + d, y) || !at(x, y - d) || !at(x, y + d);
            px[y as usize * wu + x as usize] = if rim {
                edge
            } else if (win.0 + x).rem_euclid(g) == 0 || (win.1 + y).rem_euclid(g) == 0 {
                grid_px
            } else {
                fill_px
            };
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

/// The line from `from` to the nearest point of `to` (left, top, right, bottom; screen px): where
/// its window goes and its pixels (premultiplied BGRA, top-down), `width` px wide and smoothed, a
/// dot at each end. None when `from` is inside `to` (nothing to point at).
#[cfg_attr(not(windows), allow(dead_code))]
fn leader_pixels(from: (i32, i32), to: (i32, i32, i32, i32), color: (u8, u8, u8), width: i32) -> Option<((i32, i32, i32, i32), Vec<u32>)> {
    let end = (from.0.clamp(to.0, (to.2 - 1).max(to.0)), from.1.clamp(to.1, (to.3 - 1).max(to.1)));
    if end == from {
        return None;
    }
    let half = width.max(1) as f64 / 2.0;
    let dot = half * 2.5;
    let pad = dot.ceil() as i32 + 2;
    let win = (from.0.min(end.0) - pad, from.1.min(end.1) - pad, from.0.max(end.0) + pad + 1, from.1.max(end.1) + pad + 1);
    let (w, h) = (win.2 - win.0, win.3 - win.1);
    if w <= 0 || h <= 0 || (w as i64) * (h as i64) > 40_000_000 {
        return None;
    }
    let (ax, ay, bx, by) = (from.0 as f64, from.1 as f64, end.0 as f64, end.1 as f64);
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = (dx * dx + dy * dy).max(1e-9);
    let mut px = vec![0u32; (w * h) as usize];
    for y in 0..h {
        let py = (win.1 + y) as f64 + 0.5;
        for x in 0..w {
            let pxf = (win.0 + x) as f64 + 0.5;
            let t = (((pxf - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
            let d = ((pxf - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt();
            let de = ((pxf - bx).powi(2) + (py - by).powi(2)).sqrt();
            let ds = ((pxf - ax).powi(2) + (py - ay).powi(2)).sqrt();
            let a = (half + 0.5 - d).clamp(0.0, 1.0).max((dot + 0.5 - de).clamp(0.0, 1.0)).max((half * 1.8 + 0.5 - ds).clamp(0.0, 1.0));
            if a <= 0.0 {
                continue;
            }
            let a8 = (a * 235.0).round() as u32;
            let c = |v: u8| (v as u32 * a8 + 127) / 255;
            px[(y * w + x) as usize] = (a8 << 24) | (c(color.0) << 16) | (c(color.1) << 8) | c(color.2);
        }
    }
    Some((win, px))
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

    use super::{layout, leader_pixels, tint_pixels, Look, Tint};
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
    /// the highlight: the frame's blue — a solid outline, a grid every 8 logical px, a faint fill
    const TINT_RGB: (u8, u8, u8) = (0x1E, 0x8C, 0xFF);
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
    static HWND_LEADER: AtomicIsize = AtomicIsize::new(0);
    /// where the check window's line starts (screen px)
    static LEADER: Mutex<Option<(i32, i32)>> = Mutex::new(None);
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
        START.call_once(|| {
            thread::spawn(run);
        });
        post(&TINT_POSTED, WM_APP_TINT);
    }

    /// The check window's hovered row (its edge, screen px): a line goes from it to the tint.
    pub fn set_leader(from: Option<(i32, i32)>) {
        if let Ok(mut l) = LEADER.lock() {
            if *l == from {
                return;
            }
            *l = from;
        }
        START.call_once(|| {
            thread::spawn(run);
        });
        post(&TINT_POSTED, WM_APP_TINT);
    }

    /// Puts `px` (premultiplied BGRA, top-down) on screen as layered window `h` covering `win`.
    unsafe fn blit(h: HWND, win: (i32, i32, i32, i32), px: &[u32]) -> bool {
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
            log::line(format!("layered window: no bitmap {w}x{ht}"));
            DeleteDC(mem);
            ReleaseDC(null_mut(), screen);
            return false;
        }
        std::ptr::copy_nonoverlapping(px.as_ptr(), bits as *mut u32, px.len());
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
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER | SWP_NOMOVE | SWP_NOSIZE);
        true
    }

    /// The line from the check window to the tint `to` (its window on screen), or none.
    unsafe fn apply_leader(to: Option<((i32, i32, i32, i32), (u8, u8, u8))>) {
        let h = HWND_LEADER.load(Ordering::SeqCst) as HWND;
        if h.is_null() {
            return;
        }
        let from = LEADER.lock().ok().and_then(|l| *l);
        let drawn = match (from, to) {
            (Some(f), Some((rect, color))) => {
                let k = thickness_at(f.0, f.1);
                leader_pixels(f, rect, color, 2 * k).map(|(win, px)| blit(h, win, &px)).unwrap_or(false)
            }
            _ => false,
        };
        if !drawn {
            ShowWindow(h, SW_HIDE);
        }
    }

    /// Draws the tint window from TINT (or hides it), and the check window's line to it.
    unsafe fn apply_tint() {
        let h = HWND_TINT.load(Ordering::SeqCst) as HWND;
        if h.is_null() {
            return;
        }
        let tint = TINT.lock().ok().and_then(|t| t.clone());
        let Some(t) = tint else {
            ShowWindow(h, SW_HIDE);
            apply_leader(None);
            return;
        };
        let k = thickness_at(((t.rect.left + t.rect.right) / 2.0) as i32, ((t.rect.top + t.rect.bottom) / 2.0) as i32);
        let color = t.color.unwrap_or(TINT_RGB);
        let look = Look { color, line: k, grid: 8 * k, grid_alpha: 0.5, fill_alpha: if t.color.is_some() { 0.18 } else { 0.10 } };
        let Some((win, px)) = tint_pixels(&t, look) else {
            ShowWindow(h, SW_HIDE);
            apply_leader(None);
            return;
        };
        if !blit(h, win, &px) {
            return;
        }
        drop(px);
        // the outline takes the rectangle's place (it comes back with the next row's frame)
        let f = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !f.is_null() {
            ShowWindow(f, SW_HIDE);
        }
        // only an issue's tint (coloured) gets the line from the check window
        apply_leader(t.color.map(|c| (win, c)));
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
            // the check window's line to the tint: the same kind of window
            let lclass = wide("WavePlugCheckLeader");
            let lwc = WNDCLASSW { lpszClassName: lclass.as_ptr(), hbrBackground: std::ptr::null_mut(), ..wc };
            RegisterClassW(&lwc);
            let ltitle = wide("WavePlug 检查连线");
            let l = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                lclass.as_ptr(),
                ltitle.as_ptr(),
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
            if l.is_null() {
                log::line("check leader: window not created");
            } else {
                HWND_LEADER.store(l as isize, Ordering::SeqCst);
            }
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            log::line("hover frame: window ready");
            apply(h);
            apply_tint();
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

    const LOOK: Look = Look { color: (0x1E, 0x8C, 0xFF), line: 1, grid: 4, grid_alpha: 0.5, fill_alpha: 0.1 };

    #[test]
    fn the_leader_runs_from_the_row_to_the_nearest_point_of_the_shape() {
        // from the right (the check window) to a shape on the left
        let (win, px) = leader_pixels((500, 50), (100, 40, 200, 80), (0xEC, 0x7A, 0x69), 2).unwrap();
        assert!(win.0 <= 199 && win.2 >= 500);
        let w = (win.2 - win.0) as usize;
        let at = |x: i32, y: i32| px[((y - win.1) as usize) * w + (x - win.0) as usize];
        assert!(at(350, 50) >> 24 > 200); // on the line
        assert_eq!(at(350, 55) >> 24, 0); // 5 px off it
        // from inside the shape: nothing to point at
        assert!(leader_pixels((150, 50), (100, 40, 200, 80), (0, 0, 0), 2).is_none());
    }

    #[test]
    fn outline_and_grid_inside_the_shape() {
        // a 2 × 1 shape: left half covered, right half empty, over a 20 × 10 rect
        let t = Tint { rect: r(100.0, 100.0, 120.0, 110.0), clip: None, width: 2, height: 1, alpha: vec![255, 0], color: None };
        let (win, px) = tint_pixels(&t, LOOK).unwrap();
        assert_eq!(win, (100, 100, 120, 110));
        let a = |x: usize, y: usize| px[y * 20 + x] >> 24;
        assert_eq!(a(0, 5), 255); // the shape's left edge: outline
        assert_eq!(a(9, 5), 255); // its right edge, where the empty half begins
        assert_eq!(a(15, 5), 0); // the empty half: nothing
        assert_eq!(a(3, 3), 26); // inside, between grid lines: the faint fill
        assert_eq!(a(4, 3), 128); // on a grid line (screen x 104)
        // premultiplied: no channel above alpha
        assert!(((px[0] >> 16) & 255) <= 255 && (px[23] & 255) <= a(3, 1));
    }

    #[test]
    fn no_outline_along_the_canvas_edge() {
        // a fully covered shape cut by the canvas on the left: no outline where it is cut
        let t = Tint { rect: r(100.0, 100.0, 120.0, 110.0), clip: Some(r(110.0, 0.0, 500.0, 500.0)), width: 1, height: 1, alpha: vec![255], color: None };
        let (win, px) = tint_pixels(&t, LOOK).unwrap();
        assert_eq!(win, (110, 100, 120, 110));
        assert_ne!(px[5 * 10] >> 24, 255); // the window's left edge (cut): not outline
        assert_eq!(px[5 * 10 + 9] >> 24, 255); // the shape's own right edge: outline
        assert!(tint_pixels(&Tint { clip: Some(r(500.0, 500.0, 600.0, 600.0)), ..t }, LOOK).is_none());
    }

    #[test]
    fn tint_decode_checks_sizes() {
        assert!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 2, 1, "/wA=", None).is_some());
        assert!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 3, 1, "/wA=", None).is_none());
        assert!(Tint::decode(r(0.0, 0.0, 0.0, 10.0), None, 2, 1, "/wA=", None).is_none());
        assert!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 2, 1, "not base64!", None).is_none());
        assert_eq!(Tint::decode(r(0.0, 0.0, 10.0, 10.0), None, 2, 1, "/wA=", Some("#FF4D4F")).unwrap().color, Some((0xFF, 0x4D, 0x4F)));
        assert_eq!(parse_color("red"), None);
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
