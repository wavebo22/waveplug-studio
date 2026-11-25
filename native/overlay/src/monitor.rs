// 状态栏: one line along the bottom of Photoshop's canvas, the way Blender's status bar sits under
// its viewport. Left: the WaveLayer panel's hints — the keys and mouse buttons that work where the
// pointer is, in small key boxes (the held ones lit). Middle: the panel's state and its last
// result. Right: 性能监视, simplified to four meters with a little history graph each (CPU, 内存,
// GPU, 显存); Photoshop's own memory, its scratch disk and ComfyUI's video memory only appear,
// as a warning, when they run high. The plugin sends the hints (`status-bar`) and turns the meters
// on or off (`monitor`); the numbers are measured here, since UXP can read none of them.
//
// Like the hover frame (frame.rs): its own plain Win32 window on its own thread — no egui, no
// GPU, drawn with GDI. Layered + transparent + no-activate + tool window, so it never takes the
// mouse, the wheel, the keyboard or the foreground: everything goes to Photoshop under it. It is
// shown only while Photoshop (or one of the helper's own windows) is in front and not minimised;
// nothing is measured while it is away.
//
// Where the numbers come from (all read-only, nothing is installed or changed):
//   CPU      GetSystemTimes, the share of non-idle time since the last sample
//   内存     GlobalMemoryStatusEx
//   GPU/显存 nvml.dll from System32 (NVIDIA's own library, shipped with the driver); the meters
//            are left out when it isn't there (AMD / Intel)
//   PS       the working set of Photoshop's process
//   暂存     the "Photoshop Temp*" files at the root of each fixed drive, and that drive's free space
//   Comfy    ComfyUI's /system_stats (torch_vram_total: what its PyTorch holds), local ComfyUI only

use serde_json::Value;

use crate::protocol::{BarHint, BarMode, BarPart, ScreenRect};

/// What the plugin shows on the bar (None: no WaveLayer panel; the bar is there for the meters only).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Bar {
    pub hints: Vec<BarHint>,
    pub state: Vec<BarPart>,
    pub message: Option<BarPart>,
    /// what the panel is in the middle of: a badge before the hints
    pub mode: Option<BarMode>,
}

/// Photoshop's scratch files on one drive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scratch {
    pub drive: char,
    /// bytes in "Photoshop Temp*" files
    pub used: u64,
    /// bytes free on that drive
    pub free: u64,
}

/// One sample; None = not available (left out).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Stats {
    /// 0..1
    pub cpu: Option<f32>,
    /// (used, total) bytes
    pub ram: Option<(u64, u64)>,
    /// 0..1
    pub gpu: Option<f32>,
    /// (used, total) bytes
    pub vram: Option<(u64, u64)>,
    /// bytes
    pub photoshop: Option<u64>,
    pub scratch: Option<Scratch>,
    /// bytes
    pub comfy: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Normal,
    Warn,
    High,
}

/// A meter on the right of the bar: a label, how full (0..1, also its graph), the value shown.
#[derive(Debug, Clone, PartialEq)]
pub struct Meter {
    pub label: &'static str,
    pub frac: f32,
    pub value: String,
    pub level: Level,
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// "7.2" below 100 GB, "721" from there.
fn gb(bytes: u64) -> String {
    let v = bytes as f64 / GB;
    if v >= 99.95 {
        format!("{v:.0}")
    } else {
        format!("{v:.1}")
    }
}

fn load(frac: f32) -> Level {
    if frac >= 0.92 {
        Level::High
    } else if frac >= 0.80 {
        Level::Warn
    } else {
        Level::Normal
    }
}

fn share(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64) as f32
    }
}

/// The four meters, in this order, for what was measured.
pub fn meters(s: &Stats) -> Vec<Meter> {
    let pct = |f: f32| format!("{:.0}%", f.clamp(0.0, 1.0) * 100.0);
    let mut out = Vec::new();
    if let Some(c) = s.cpu {
        out.push(Meter { label: "CPU", frac: c.clamp(0.0, 1.0), value: pct(c), level: load(c) });
    }
    if let Some((used, total)) = s.ram {
        let f = share(used, total);
        out.push(Meter { label: "内存", frac: f, value: pct(f), level: load(f) });
    }
    if let Some(g) = s.gpu {
        out.push(Meter { label: "GPU", frac: g.clamp(0.0, 1.0), value: pct(g), level: load(g) });
    }
    if let Some((used, total)) = s.vram {
        let f = share(used, total);
        out.push(Meter { label: "显存", frac: f, value: pct(f), level: load(f) });
    }
    out
}

/// The graph value of meter `label` in sample `s` (for the history drawn behind each meter).
pub fn meter_frac(s: &Stats, label: &str) -> Option<f32> {
    match label {
        "CPU" => s.cpu,
        "内存" => s.ram.map(|(u, t)| share(u, t)),
        "GPU" => s.gpu,
        "显存" => s.vram.map(|(u, t)| share(u, t)),
        _ => None,
    }
    .map(|f| f.clamp(0.0, 1.0))
}

/// What only shows when it runs high: Photoshop holding most of the memory, the scratch drive
/// running out of room. (text, level), never Normal.
pub fn warnings(s: &Stats) -> Vec<(String, Level)> {
    let mut out = Vec::new();
    if let (Some(ps), Some((_, total))) = (s.photoshop, s.ram) {
        let f = share(ps, total);
        if f >= 0.60 {
            out.push((format!("PS 占用 {} GB", gb(ps)), if f >= 0.75 { Level::High } else { Level::Warn }));
        }
    }
    if let Some(sc) = s.scratch {
        let free = sc.free as f64 / GB;
        if free < 50.0 {
            out.push((format!("暂存盘 {}: 余 {} GB", sc.drive, gb(sc.free)), if free < 20.0 { Level::High } else { Level::Warn }));
        }
    }
    out
}

/// The full lines of the old box, still logged (and in the diagnostics) when asked.
pub fn summary(s: &Stats) -> String {
    let mut parts: Vec<String> = meters(s).iter().map(|m| format!("{} {}", m.label, m.value)).collect();
    if let Some(ps) = s.photoshop {
        parts.push(format!("PS {} GB", gb(ps)));
    }
    if let Some(c) = s.comfy {
        parts.push(format!("Comfy {} GB", gb(c)));
    }
    parts.join(" · ")
}

/// CPU in use between two GetSystemTimes samples `(idle, kernel + user)`; kernel time includes idle.
#[cfg_attr(not(windows), allow(dead_code))]
fn cpu_usage(prev: (u64, u64), now: (u64, u64)) -> Option<f32> {
    let total = now.1.checked_sub(prev.1)?;
    let idle = now.0.checked_sub(prev.0)?;
    if total == 0 {
        return None;
    }
    Some((1.0 - idle as f64 / total as f64).clamp(0.0, 1.0) as f32)
}

/// The video memory ComfyUI's PyTorch holds, from /system_stats.
#[cfg_attr(not(windows), allow(dead_code))]
fn comfy_vram(stats: &Value) -> Option<u64> {
    stats.get("devices")?.as_array()?.iter().find_map(|d| d.get("torch_vram_total")?.as_u64())
}

type Px = (i32, i32, i32, i32);

/// The canvas view when it lies inside Photoshop's window, else the window itself (no document
/// open, or a view left over from before the window moved).
#[cfg_attr(not(windows), allow(dead_code))]
fn area(view: Option<ScreenRect>, ps: Px) -> Px {
    let Some(v) = view else { return ps };
    let v = (v.left.round() as i32, v.top.round() as i32, v.right.round() as i32, v.bottom.round() as i32);
    let inside = v.0 >= ps.0 - 16 && v.1 >= ps.1 - 16 && v.2 <= ps.2 + 16 && v.3 <= ps.3 + 16;
    if inside && v.2 - v.0 > 0 && v.3 - v.1 > 0 {
        v
    } else {
        ps
    }
}

/// The bar: the whole width of `area`, `height` tall, on its bottom edge (left, top, width, height).
#[cfg_attr(not(windows), allow(dead_code))]
fn bar_rect(area: Px, height: i32) -> Px {
    let h = height.min((area.3 - area.1).max(0));
    (area.0, area.3 - h, (area.2 - area.0).max(0), h)
}

#[cfg(windows)]
pub use imp::{bar_height, set, set_bar, set_view};

/// Turns the meters on or off; `comfy` is ComfyUI's address (None: not measured).
#[cfg(not(windows))]
pub fn set(_on: bool, _comfy: Option<String>) {}

/// What the plugin shows on the bar (None: nothing; the bar stays for the meters when they are on).
#[cfg(not(windows))]
pub fn set_bar(_bar: Option<Bar>) {}

/// The canvas on screen (None: no document, the bar goes along the bottom of Photoshop's window).
#[cfg(not(windows))]
pub fn set_view(_view: Option<ScreenRect>) {}

/// The bar's height in screen px while it is up (0 when not): the completion notice sits above it.
#[cfg(not(windows))]
pub fn bar_height() -> i32 {
    0
}

#[cfg(windows)]
mod imp {
    use std::collections::VecDeque;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Mutex, Once};
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreatePen, CreateSolidBrush,
        DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GetTextExtentPoint32W, InvalidateRect, MonitorFromPoint,
        RoundRect, SelectObject, SetBkMode, SetTextColor, PAINTSTRUCT, HDC,
    };
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryExW};
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{GetSystemTimes, OpenProcess};
    use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW, PostMessageW,
        RegisterClassW, SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow, MSG, WNDCLASSW,
    };

    use super::{area, bar_rect, comfy_vram, cpu_usage, meter_frac, meters, summary, warnings, Bar, Level, Px, Scratch, Stats};
    use crate::log;
    use crate::protocol::ScreenRect;
    use crate::win::PsFront;

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const LWA_ALPHA: u32 = 0x0000_0002;
    const WM_PAINT: u32 = 0x000F;
    const WM_ERASEBKGND: u32 = 0x0014;
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const WM_NCHITTEST: u32 = 0x0084;
    const WM_TIMER: u32 = 0x0113;
    /// on / off, the view or the hints changed: place and draw again now
    const WM_APP_PLACE: u32 = 0x8000 + 0x61;
    /// a new sample is in STATS
    const WM_APP_STATS: u32 = 0x8000 + 0x62;
    const MA_NOACTIVATE: LRESULT = 3;
    const HTTRANSPARENT: LRESULT = -1;
    const SW_HIDE: i32 = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    const HWND_TOPMOST: HWND = -1isize as HWND;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
    const PROCESS_VM_READ: u32 = 0x0010;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const TRANSPARENT_BK: i32 = 1;
    const DT_LEFT: u32 = 0x0000;
    const DT_CENTER: u32 = 0x0001;
    const DT_RIGHT: u32 = 0x0002;
    const DT_VCENTER: u32 = 0x0004;
    const DT_SINGLELINE: u32 = 0x0020;
    const DT_NOPREFIX: u32 = 0x0800;
    const DT_END_ELLIPSIS: u32 = 0x8000;
    const SRCCOPY: u32 = 0x00CC_0020;
    const DEFAULT_CHARSET: u32 = 1;
    const CLEARTYPE_QUALITY: u32 = 5;
    const PS_SOLID: i32 = 0;

    // logical px (× the display scale); colours are COLORREF 0x00BBGGRR, the plugin's tokens
    const HEIGHT: f64 = 24.0;
    const PAD_X: f64 = 8.0;
    const GAP: f64 = 12.0;
    const KEY_H: f64 = 16.0;
    const KEY_PAD: f64 = 4.0;
    const GRAPH_W: f64 = 40.0;
    const GRAPH_H: f64 = 12.0;
    const FONT_PX: f64 = 12.0; // --fs
    const ALPHA: u8 = 240;
    const C_BG: u32 = 0x0026_2626;
    const C_TOP: u32 = 0x003C_3C3C; // the line along its top edge
    const C_KEY_BG: u32 = 0x0038_3838;
    const C_KEY_LINE: u32 = 0x0058_5858;
    const C_GRAPH_BG: u32 = 0x001C_1C1C;
    const C_LABEL: u32 = 0x0098_928D; // --c-text-3
    const C_TEXT2: u32 = 0x00C2_BDB8; // --c-text-2
    const C_TEXT: u32 = 0x00EC_ECEC; // --c-text
    const C_HI: u32 = 0x00FF_FFFF; // --c-text-hi
    const C_ACCENT: u32 = 0x009F_B53F; // --c-accent
    const C_ACCENT_HI: u32 = 0x00B6_CB5F; // --c-accent-hi
    const C_OK: u32 = 0x008F_C55F; // --c-ok
    const C_INFO: u32 = 0x00FF_B682; // --c-info
    const C_WARN: u32 = 0x004B_B0E3; // --c-warn
    const C_HIGH: u32 = 0x0069_7AEC; // --c-err
    const C_EMBED: u32 = 0x009F_B53F; // --c-accent: 嵌入
    const C_LINK: u32 = 0x00D9_864F; // --c-link: 链接
    const C_WEB: u32 = 0x003A_90E0; // 网页内容

    /// the window looks at Photoshop this often (ms); a sample is taken every SAMPLE_MS
    const TICK_MS: u32 = 250;
    const SAMPLE_MS: u64 = 1000;
    /// samples kept for the meters' graphs (one 2-px column each)
    const HISTORY: usize = 20;
    /// Photoshop must be away for this many ticks in a row before the bar goes (see win.rs PARK_AFTER_TICKS)
    const AWAY_TICKS: u32 = 2;

    /// the meters are on (性能监视)
    static ON: AtomicBool = AtomicBool::new(false);
    static VISIBLE: AtomicBool = AtomicBool::new(false);
    static AWAY: AtomicU32 = AtomicU32::new(0);
    /// display scale × 100 the bar was last laid out at (for painting)
    static SCALE: AtomicU32 = AtomicU32::new(100);
    /// its height on screen while up, 0 when not (the completion notice goes above it)
    static HEIGHT_PX: AtomicI32 = AtomicI32::new(0);
    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
    static COMFY: Mutex<Option<String>> = Mutex::new(None);
    static VIEW: Mutex<Option<ScreenRect>> = Mutex::new(None);
    static BAR: Mutex<Option<Bar>> = Mutex::new(None);
    static STATS: Mutex<Option<Stats>> = Mutex::new(None);
    static PAST: Mutex<VecDeque<Stats>> = Mutex::new(VecDeque::new());
    /// where the window is now (left, top, width, height)
    static PLACED: Mutex<Px> = Mutex::new((0, 0, 0, 0));
    static START: Once = Once::new();

    fn post(msg: u32) {
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !h.is_null() {
            unsafe { PostMessageW(h, msg, 0, 0) };
        }
    }

    fn start() {
        START.call_once(|| {
            thread::spawn(run);
            thread::spawn(sample_loop);
        });
    }

    /// Turns the meters on or off; `comfy` is ComfyUI's address (None: not measured).
    pub fn set(on: bool, comfy: Option<String>) {
        if let Ok(mut c) = COMFY.lock() {
            *c = comfy.filter(|b| !b.trim().is_empty());
        }
        let was = ON.swap(on, Ordering::SeqCst);
        if was != on {
            log::line(format!("status bar meters: {}", if on { "on" } else { "off" }));
            if !on {
                if let Ok(mut s) = STATS.lock() {
                    *s = None;
                }
            }
        }
        if !on && HWND_SELF.load(Ordering::SeqCst) == 0 {
            return; // never shown: no window to make
        }
        start();
        post(WM_APP_PLACE);
    }

    /// What the plugin shows on the bar (None: no WaveLayer panel; the bar stays for the meters).
    pub fn set_bar(bar: Option<Bar>) {
        let changed = BAR.lock().map(|mut b| std::mem::replace(&mut *b, bar.clone()) != bar).unwrap_or(false);
        if !changed {
            return;
        }
        if bar.is_none() && HWND_SELF.load(Ordering::SeqCst) == 0 {
            return;
        }
        start();
        post(WM_APP_PLACE);
    }

    /// The canvas on screen (None: no document, the bar goes along the bottom of Photoshop's window).
    pub fn set_view(view: Option<ScreenRect>) {
        let changed = VIEW.lock().map(|mut v| std::mem::replace(&mut *v, view) != view).unwrap_or(false);
        if changed {
            post(WM_APP_PLACE);
        }
    }

    pub fn bar_height() -> i32 {
        if VISIBLE.load(Ordering::SeqCst) {
            HEIGHT_PX.load(Ordering::SeqCst)
        } else {
            0
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn scale_at(x: i32, y: i32) -> f64 {
        let (mut dx, mut dy) = (96u32, 96u32);
        unsafe { GetDpiForMonitor(MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST), 0, &mut dx, &mut dy) };
        (dx as f64 / 96.0).max(1.0)
    }

    unsafe fn hide(h: HWND) {
        if VISIBLE.swap(false, Ordering::SeqCst) {
            ShowWindow(h, SW_HIDE);
            HEIGHT_PX.store(0, Ordering::SeqCst);
            log::line("status bar: hidden");
        }
    }

    /// Something to draw: the plugin's hints / state / result, or the meters.
    fn wanted() -> bool {
        ON.load(Ordering::SeqCst) || BAR.lock().map(|b| b.is_some()).unwrap_or(false)
    }

    /// Shows, moves or hides the bar for where Photoshop is now.
    unsafe fn tick(h: HWND) {
        if !wanted() {
            hide(h);
            return;
        }
        match crate::win::photoshop_front() {
            PsFront::Front => AWAY.store(0, Ordering::SeqCst),
            PsFront::Unsure => return, // activation is moving: whatever was true still is
            PsFront::Away => {
                if AWAY.fetch_add(1, Ordering::SeqCst) + 1 >= AWAY_TICKS {
                    hide(h);
                }
                return;
            }
        }
        let Some(ps) = crate::win::photoshop_main_rect() else {
            hide(h); // minimised or gone
            return;
        };
        let view = VIEW.lock().ok().and_then(|v| *v);
        let a = area(view, ps);
        let k = scale_at(a.0 + 1, a.3 - 1);
        let want = bar_rect(a, (HEIGHT * k).round() as i32);
        if want.2 <= 0 || want.3 <= 0 {
            hide(h);
            return;
        }
        let Ok(mut placed) = PLACED.lock() else { return };
        let shown = VISIBLE.load(Ordering::SeqCst) && *placed != (0, 0, 0, 0);
        if shown && *placed == want {
            return;
        }
        SCALE.store((k * 100.0) as u32, Ordering::SeqCst);
        SetWindowPos(h, HWND_TOPMOST, want.0, want.1, want.2, want.3, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
        if !shown {
            log::line(format!("status bar: shown at {},{} {}x{}", want.0, want.1, want.2, want.3));
        }
        *placed = want;
        HEIGHT_PX.store(want.3, Ordering::SeqCst);
        VISIBLE.store(true, Ordering::SeqCst);
        InvalidateRect(h, null(), 0);
    }

    unsafe fn text_w(dc: HDC, s: &str) -> i32 {
        let w: Vec<u16> = s.encode_utf16().collect();
        let mut sz = SIZE { cx: 0, cy: 0 };
        GetTextExtentPoint32W(dc, w.as_ptr(), w.len() as i32, &mut sz);
        sz.cx
    }

    unsafe fn text(dc: HDC, s: &str, color: u32, left: i32, right: i32, top: i32, bottom: i32, flags: u32) {
        let w = wide(s);
        let mut r = RECT { left, top, right, bottom };
        SetTextColor(dc, color);
        DrawTextW(dc, w.as_ptr(), -1, &mut r, flags | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
    }

    unsafe fn fill(dc: HDC, left: i32, top: i32, right: i32, bottom: i32, color: u32) {
        let b = CreateSolidBrush(color);
        let r = RECT { left, top, right, bottom };
        FillRect(dc, &r, b);
        DeleteObject(b);
    }

    fn level_color(l: Level) -> u32 {
        match l {
            Level::Normal => C_ACCENT,
            Level::Warn => C_WARN,
            Level::High => C_HIGH,
        }
    }

    fn kind_color(kind: &str) -> u32 {
        match kind {
            "ok" => C_OK,
            "error" | "warn" => if kind == "error" { C_HIGH } else { C_WARN },
            "busy" => C_TEXT,
            "filter" => C_ACCENT_HI,
            "mode" => C_INFO,
            _ => C_TEXT2,
        }
    }

    /// a mode badge's fill
    fn tone_color(tone: &str) -> u32 {
        match tone {
            "embed" => C_EMBED,
            "link" => C_LINK,
            "web" => C_WEB,
            "warn" => C_WARN,
            _ => C_INFO,
        }
    }

    unsafe fn paint(h: HWND) {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let dc = BeginPaint(h, &mut ps);
        let mut rc = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        GetClientRect(h, &mut rc);
        let (w, ht) = (rc.right - rc.left, rc.bottom - rc.top);
        if dc.is_null() || w <= 0 || ht <= 0 {
            EndPaint(h, &ps);
            return;
        }
        // drawn off screen, copied in one go: no flicker when the numbers change
        let mem = CreateCompatibleDC(dc);
        let bmp = CreateCompatibleBitmap(dc, w, ht);
        let old_bmp = SelectObject(mem, bmp);
        fill(mem, 0, 0, w, ht, C_BG);
        let k = SCALE.load(Ordering::SeqCst) as f64 / 100.0;
        let px = |v: f64| (v * k).round() as i32;
        fill(mem, 0, 0, w, px(1.0).max(1), C_TOP);

        let face = wide("Microsoft YaHei UI");
        let font = CreateFontW(-px(FONT_PX), 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, face.as_ptr());
        let old_font = SelectObject(mem, font);
        SetBkMode(mem, TRANSPARENT_BK);
        let (top, bottom) = (0, ht);
        let gap = px(GAP);

        // ── right: the meters (and what runs high), from the right edge leftwards ──
        let mut right = w - px(PAD_X);
        if ON.load(Ordering::SeqCst) {
            let now = STATS.lock().ok().and_then(|s| *s);
            let past: Vec<Stats> = PAST.lock().map(|p| p.iter().copied().collect()).unwrap_or_default();
            if let Some(s) = now {
                let value_w = text_w(mem, "100%");
                let (gw, gh) = (px(GRAPH_W), px(GRAPH_H));
                for m in meters(&s).iter().rev() {
                    let label_w = text_w(mem, m.label);
                    let x0 = right - (label_w + px(4.0) + gw + px(4.0) + value_w);
                    if x0 < w / 3 {
                        break; // never more than two thirds of the bar
                    }
                    text(mem, m.label, C_LABEL, x0, x0 + label_w, top, bottom, DT_LEFT);
                    // the graph: one column per sample, newest at the right, in the level's colour
                    let gx = x0 + label_w + px(4.0);
                    let gy = (ht - gh) / 2;
                    fill(mem, gx, gy, gx + gw, gy + gh, C_GRAPH_BG);
                    let col = (gw / HISTORY as i32).max(1);
                    for (i, p) in past.iter().rev().take(HISTORY).enumerate() {
                        let Some(f) = meter_frac(p, m.label) else { continue };
                        let x1 = gx + gw - col * i as i32;
                        let bar_h = ((gh as f32) * f).round().max(1.0) as i32;
                        let c = if i == 0 { level_color(m.level) } else { level_color(super::load(f)) };
                        fill(mem, (x1 - col).max(gx), gy + gh - bar_h, x1, gy + gh, c);
                    }
                    text(mem, &m.value, if m.level == Level::Normal { C_TEXT } else { level_color(m.level) }, gx + gw + px(4.0), right, top, bottom, DT_RIGHT);
                    right = x0 - gap;
                }
                for (t, l) in warnings(&s).iter().rev() {
                    let tw = text_w(mem, t);
                    if right - tw < w / 3 {
                        break;
                    }
                    text(mem, t, level_color(*l), right - tw, right, top, bottom, DT_LEFT);
                    right -= tw + gap;
                }
            }
        }

        // ── the last result, just left of the meters ──
        let bar = BAR.lock().ok().and_then(|b| b.clone()).unwrap_or_default();
        if let Some(m) = bar.message.as_ref().filter(|m| !m.text.is_empty()) {
            let tw = text_w(mem, &m.text).min(w * 35 / 100);
            text(mem, &m.text, kind_color(&m.kind), right - tw, right, top, bottom, DT_RIGHT | DT_END_ELLIPSIS);
            right -= tw + gap * 2;
        }

        // ── left: what the panel is in the middle of, as a filled badge, then where ──
        let mut x = px(PAD_X);
        let (kh, kp) = (px(KEY_H), px(KEY_PAD));
        let key_top = (ht - kh) / 2;
        if let Some(m) = bar.mode.as_ref().filter(|m| !m.text.is_empty()) {
            let c = tone_color(&m.tone);
            let bold = CreateFontW(-px(FONT_PX), 0, 0, 0, 700, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, face.as_ptr());
            let prev = SelectObject(mem, bold);
            let bw = text_w(mem, &m.text) + kp * 4;
            let brush = CreateSolidBrush(c);
            let pen = CreatePen(PS_SOLID, 1, c);
            let (ob, op) = (SelectObject(mem, brush), SelectObject(mem, pen));
            let (bt, bb) = (key_top - px(1.0), key_top + kh + px(1.0));
            RoundRect(mem, x, bt, x + bw, bb, px(6.0), px(6.0));
            SelectObject(mem, ob);
            SelectObject(mem, op);
            DeleteObject(brush);
            DeleteObject(pen);
            text(mem, &m.text, C_HI, x, x + bw, bt, bb, DT_CENTER);
            SelectObject(mem, prev);
            DeleteObject(bold);
            x += bw + px(6.0);
            if !m.detail.is_empty() {
                let dw = text_w(mem, &m.detail).min((right - x).max(0) / 2);
                text(mem, &m.detail, C_HI, x, x + dw, top, bottom, DT_LEFT | DT_END_ELLIPSIS);
                x += dw + gap;
            }
            // a divider before the hints
            fill(mem, x, key_top + px(2.0), x + px(1.0).max(1), key_top + kh - px(2.0), C_KEY_LINE);
            x += gap;
        }
        let line = CreatePen(PS_SOLID, px(1.0).max(1), C_KEY_LINE);
        let lit_line = CreatePen(PS_SOLID, px(1.0).max(1), C_ACCENT_HI);
        let key_bg = CreateSolidBrush(C_KEY_BG);
        let old_pen = SelectObject(mem, line);
        let old_brush = SelectObject(mem, key_bg);
        for hint in &bar.hints {
            let keys_w: i32 = hint.keys.iter().map(|k| text_w(mem, k) + kp * 2 + px(3.0)).sum();
            let need = keys_w + text_w(mem, &hint.label);
            if x + need > right {
                break;
            }
            SelectObject(mem, if hint.on { lit_line } else { line });
            for key in &hint.keys {
                let kw = text_w(mem, key) + kp * 2;
                RoundRect(mem, x, key_top, x + kw, key_top + kh, px(5.0), px(5.0));
                text(mem, key, if hint.on { C_ACCENT_HI } else { C_TEXT }, x, x + kw, key_top, key_top + kh, DT_CENTER);
                x += kw + px(3.0);
            }
            let lw = text_w(mem, &hint.label);
            text(mem, &hint.label, if hint.on { C_HI } else { C_TEXT2 }, x, x + lw, top, bottom, DT_LEFT);
            x += lw + gap;
        }
        SelectObject(mem, old_pen);
        SelectObject(mem, old_brush);
        DeleteObject(line);
        DeleteObject(lit_line);
        DeleteObject(key_bg);

        // ── the panel's state, after the hints when there is room ──
        x += gap;
        for p in &bar.state {
            let tw = text_w(mem, &p.text);
            if x + tw > right {
                break;
            }
            text(mem, &p.text, kind_color(&p.kind), x, x + tw, top, bottom, DT_LEFT);
            x += tw + gap;
        }

        BitBlt(dc, 0, 0, w, ht, mem, 0, 0, SRCCOPY);
        SelectObject(mem, old_font);
        DeleteObject(font);
        SelectObject(mem, old_bmp);
        DeleteObject(bmp);
        DeleteDC(mem);
        EndPaint(h, &ps);
    }

    unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_TIMER => {
                tick(h);
                0
            }
            WM_APP_PLACE | WM_APP_STATS => {
                tick(h);
                if VISIBLE.load(Ordering::SeqCst) {
                    InvalidateRect(h, null(), 0);
                }
                0
            }
            WM_PAINT => {
                paint(h);
                0
            }
            WM_ERASEBKGND => 1,
            WM_MOUSEACTIVATE => MA_NOACTIVATE,
            WM_NCHITTEST => HTTRANSPARENT,
            _ => DefWindowProcW(h, msg, w, l),
        }
    }

    fn run() {
        unsafe {
            let inst = GetModuleHandleW(null());
            let class = wide("WavePlugStatusBar");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: inst,
                hIcon: null_mut(),
                hCursor: null_mut(),
                hbrBackground: null_mut(),
                lpszMenuName: null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            let title = wide("WavePlug 状态栏");
            let h = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                inst,
                null(),
            );
            if h.is_null() {
                log::line("status bar: window not created");
                return;
            }
            // layered is what makes WS_EX_TRANSPARENT pass clicks to other processes
            SetLayeredWindowAttributes(h, 0, ALPHA, LWA_ALPHA);
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            SetTimer(h, 1, TICK_MS, None);
            log::line("status bar: window ready");
            tick(h);
            let mut m: MSG = std::mem::zeroed();
            while GetMessageW(&mut m, null_mut(), 0, 0) > 0 {
                DispatchMessageW(&m);
            }
        }
    }

    // ── measuring (its own thread: a slow ComfyUI answer never holds up the window) ──

    fn filetime(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }

    fn cpu_times() -> Option<(u64, u64)> {
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut idle, mut kernel, mut user) = (zero, zero, zero);
        (unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } != 0)
            .then(|| (filetime(idle), filetime(kernel) + filetime(user)))
    }

    fn ram() -> Option<(u64, u64)> {
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (unsafe { GlobalMemoryStatusEx(&mut m) } != 0 && m.ullTotalPhys > 0)
            .then(|| (m.ullTotalPhys.saturating_sub(m.ullAvailPhys), m.ullTotalPhys))
    }

    #[repr(C)]
    struct NvmlUtilization {
        gpu: u32,
        memory: u32,
    }
    #[repr(C)]
    struct NvmlMemory {
        total: u64,
        free: u64,
        used: u64,
    }
    type NvmlDevice = *mut c_void;

    /// NVIDIA's management library, loaded from System32 only; the first GPU.
    struct Nvml {
        device: NvmlDevice,
        utilization: unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> i32,
        memory: unsafe extern "C" fn(NvmlDevice, *mut NvmlMemory) -> i32,
    }

    impl Nvml {
        fn load() -> Option<Nvml> {
            unsafe {
                let name = wide("nvml.dll");
                let lib = LoadLibraryExW(name.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
                if lib.is_null() {
                    log::line("monitor: nvml.dll not found, no GPU rows");
                    return None;
                }
                let sym = |n: &[u8]| GetProcAddress(lib, n.as_ptr());
                let init: unsafe extern "C" fn() -> i32 = std::mem::transmute(sym(b"nvmlInit_v2\0")?);
                let by_index: unsafe extern "C" fn(u32, *mut NvmlDevice) -> i32 =
                    std::mem::transmute(sym(b"nvmlDeviceGetHandleByIndex_v2\0")?);
                let utilization = std::mem::transmute(sym(b"nvmlDeviceGetUtilizationRates\0")?);
                let memory = std::mem::transmute(sym(b"nvmlDeviceGetMemoryInfo\0")?);
                let code = init();
                if code != 0 {
                    log::line(format!("monitor: nvmlInit failed ({code}), no GPU rows"));
                    return None;
                }
                let mut device: NvmlDevice = null_mut();
                let code = by_index(0, &mut device);
                if code != 0 || device.is_null() {
                    log::line(format!("monitor: no NVIDIA GPU 0 ({code}), no GPU rows"));
                    return None;
                }
                log::line("monitor: nvml ready");
                Some(Nvml { device, utilization, memory })
            }
        }

        fn read(&self) -> (Option<f32>, Option<(u64, u64)>) {
            unsafe {
                let mut u = NvmlUtilization { gpu: 0, memory: 0 };
                let gpu = ((self.utilization)(self.device, &mut u) == 0).then(|| u.gpu.min(100) as f32 / 100.0);
                let mut m = NvmlMemory { total: 0, free: 0, used: 0 };
                let vram = ((self.memory)(self.device, &mut m) == 0 && m.total > 0).then(|| (m.used, m.total));
                (gpu, vram)
            }
        }
    }

    /// Photoshop's working set; `slot` keeps its process handle between samples.
    fn photoshop_memory(slot: &mut isize) -> Option<u64> {
        unsafe {
            if *slot == 0 {
                let pid = crate::win::photoshop_pid();
                if pid == 0 {
                    return None;
                }
                let mut h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
                if h.is_null() {
                    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                }
                if h.is_null() {
                    return None;
                }
                *slot = h as isize;
            }
            let mut c: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if K32GetProcessMemoryInfo(*slot as HANDLE, &mut c, c.cb) == 0 || c.WorkingSetSize == 0 {
                // Photoshop quit (a new one gets a new handle next time)
                CloseHandle(*slot as HANDLE);
                *slot = 0;
                return None;
            }
            Some(c.WorkingSetSize as u64)
        }
    }

    /// The fixed drive holding the most "Photoshop Temp*" bytes (Photoshop keeps its scratch files
    /// at the drive's root), and how much is free there.
    fn scratch() -> Option<Scratch> {
        let mask = unsafe { GetLogicalDrives() };
        let mut best: Option<Scratch> = None;
        for i in 0..26u8 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let drive = (b'A' + i) as char;
            let root = format!("{drive}:\\");
            let root_w = wide(&root);
            if unsafe { GetDriveTypeW(root_w.as_ptr()) } != DRIVE_FIXED {
                continue;
            }
            let Ok(dir) = std::fs::read_dir(&root) else { continue };
            let used: u64 = dir
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("Photoshop Temp"))
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum();
            if used == 0 || best.is_some_and(|b| b.used >= used) {
                continue;
            }
            let mut free = 0u64;
            if unsafe { GetDiskFreeSpaceExW(root_w.as_ptr(), &mut free, null_mut(), null_mut()) } == 0 {
                continue;
            }
            best = Some(Scratch { drive, used, free });
        }
        best
    }

    fn sample_loop() {
        let nvml = Nvml::load();
        // CPU is a difference between two samples: take the first now, so its meter is there from
        // the first time the bar is drawn (a meter appearing later would make the bar jump)
        let mut cpu_prev: Option<(u64, u64)> = cpu_times();
        thread::sleep(Duration::from_millis(250));
        let mut ps_handle: isize = 0;
        let (mut scratch_now, mut comfy_now) = (None, None);
        let mut n: u64 = 0;
        loop {
            // nothing is measured while the meters are off or Photoshop isn't in front
            if !ON.load(Ordering::SeqCst) || !VISIBLE.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(500));
                continue;
            }
            let mut s = Stats::default();
            let times = cpu_times();
            if let (Some(prev), Some(now)) = (cpu_prev, times) {
                s.cpu = cpu_usage(prev, now);
            }
            cpu_prev = times;
            s.ram = ram();
            if let Some(nv) = &nvml {
                (s.gpu, s.vram) = nv.read();
            }
            s.photoshop = photoshop_memory(&mut ps_handle);
            if n % 5 == 0 {
                scratch_now = scratch();
            }
            if n % 3 == 0 {
                let base = COMFY.lock().ok().and_then(|c| c.clone());
                comfy_now = base.and_then(|b| crate::comfy::system_stats(&b)).and_then(|v| comfy_vram(&v));
            }
            s.scratch = scratch_now;
            s.comfy = comfy_now;
            if n % 60 == 0 {
                log::line(format!("status bar meters: {}", summary(&s)));
            }
            n += 1;
            if let Ok(mut p) = PAST.lock() {
                p.push_back(s);
                while p.len() > HISTORY {
                    p.pop_front();
                }
            }
            if let Ok(mut cur) = STATS.lock() {
                *cur = Some(s);
            }
            // the graphs move every sample
            post(WM_APP_STATS);
            thread::sleep(Duration::from_millis(SAMPLE_MS));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: u64 = 1024 * 1024 * 1024;

    #[test]
    fn only_what_was_measured_gets_a_meter() {
        assert!(meters(&Stats::default()).is_empty());
        let m = meters(&Stats { cpu: Some(0.374), ram: Some((21 * G, 32 * G)), ..Default::default() });
        assert_eq!(m.iter().map(|m| m.label).collect::<Vec<_>>(), ["CPU", "内存"]);
        assert_eq!(m[0].value, "37%");
        assert_eq!(m[1].value, "66%");
    }

    #[test]
    fn four_meters_in_order() {
        let s = Stats {
            cpu: Some(0.05),
            ram: Some((8 * G, 32 * G)),
            gpu: Some(0.57),
            vram: Some((15 * G, 16 * G)),
            photoshop: Some(6 * G),
            scratch: Some(Scratch { drive: 'G', used: 82 * G, free: 721 * G }),
            comfy: Some(7 * G + G / 5),
        };
        let m = meters(&s);
        assert_eq!(m.iter().map(|m| format!("{} {}", m.label, m.value)).collect::<Vec<_>>(), ["CPU 5%", "内存 25%", "GPU 57%", "显存 94%"]);
        assert_eq!(m[3].level, Level::High);
        assert_eq!(meter_frac(&s, "显存"), Some(15.0 / 16.0));
        // nothing runs high apart from video memory: no warnings
        assert!(warnings(&s).is_empty());
        assert_eq!(summary(&s), "CPU 5% · 内存 25% · GPU 57% · 显存 94% · PS 6.0 GB · Comfy 7.2 GB");
    }

    #[test]
    fn levels() {
        assert_eq!(load(0.79), Level::Normal);
        assert_eq!(load(0.80), Level::Warn);
        assert_eq!(load(0.92), Level::High);
    }

    #[test]
    fn warnings_only_when_running_high() {
        let ps = |bytes| warnings(&Stats { ram: Some((30 * G, 32 * G)), photoshop: Some(bytes), ..Default::default() });
        assert!(ps(10 * G).is_empty());
        assert_eq!(ps(20 * G), [("PS 占用 20.0 GB".to_string(), Level::Warn)]);
        assert_eq!(ps(25 * G)[0].1, Level::High);
        let sc = |free| warnings(&Stats { scratch: Some(Scratch { drive: 'D', used: G, free }), ..Default::default() });
        assert!(sc(60 * G).is_empty());
        assert_eq!(sc(40 * G), [("暂存盘 D: 余 40.0 GB".to_string(), Level::Warn)]);
        assert_eq!(sc(10 * G)[0].1, Level::High);
    }

    #[test]
    fn cpu_from_two_samples() {
        // 1000 units passed, 250 of them idle
        assert_eq!(cpu_usage((100, 1000), (350, 2000)), Some(0.75));
        assert_eq!(cpu_usage((100, 1000), (100, 1000)), None); // no time passed
        assert_eq!(cpu_usage((500, 2000), (100, 1000)), None); // counters went back
    }

    #[test]
    fn comfy_vram_from_system_stats() {
        let v: Value = serde_json::from_str(
            r#"{"system":{},"devices":[{"name":"cuda:0","vram_total":17170956288,"vram_free":9000000000,"torch_vram_total":7730941132,"torch_vram_free":100}]}"#,
        )
        .unwrap();
        assert_eq!(comfy_vram(&v), Some(7730941132));
        assert_eq!(comfy_vram(&serde_json::json!({ "devices": [] })), None);
        assert_eq!(comfy_vram(&serde_json::json!({})), None);
    }

    #[test]
    fn runs_along_the_bottom_of_the_canvas() {
        assert_eq!(bar_rect((1000, 100, 3000, 2000), 36), (1000, 1964, 2000, 36));
        // a canvas lower than the bar: the bar is no taller than the canvas
        assert_eq!(bar_rect((0, 0, 100, 20), 36), (0, 0, 100, 20));
    }

    #[test]
    fn uses_the_canvas_only_when_it_is_inside_photoshop() {
        let ps = (0, 0, 2560, 1400);
        let r = |l: f64, t: f64, r: f64, b: f64| ScreenRect { left: l, top: t, right: r, bottom: b };
        assert_eq!(area(Some(r(60.0, 120.0, 2000.0, 1300.0)), ps), (60, 120, 2000, 1300));
        assert_eq!(area(None, ps), ps);
        // a view from before Photoshop moved to another screen
        assert_eq!(area(Some(r(3000.0, 120.0, 5000.0, 1300.0)), ps), ps);
    }
}
