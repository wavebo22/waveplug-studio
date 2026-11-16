// 性能监视: a small read-only box in the bottom-right corner of Photoshop's canvas with what the
// machine is doing — CPU, memory, GPU, video memory, Photoshop's own memory, its scratch files
// (暂存盘) and the video memory ComfyUI holds. The plugin only turns it on or off (`monitor`); the
// numbers are measured here, since UXP can read none of them.
//
// Like the hover frame (frame.rs): its own plain Win32 window on its own thread — no egui, no
// GPU, drawn with GDI once a second. Layered + transparent + no-activate + tool window, so it
// never takes the mouse, the wheel, the keyboard or the foreground: everything goes to Photoshop
// under it. It is shown only while Photoshop (or one of the helper's own windows) is in front and
// not minimised; nothing is measured while it is away.
//
// Where the numbers come from (all read-only, nothing is installed or changed):
//   CPU      GetSystemTimes, the share of non-idle time since the last sample
//   内存     GlobalMemoryStatusEx
//   GPU/显存 nvml.dll from System32 (NVIDIA's own library, shipped with the driver); the rows are
//            left out when it isn't there (AMD / Intel)
//   PS       the working set of Photoshop's process
//   暂存     the "Photoshop Temp*" files at the root of each fixed drive, and that drive's free space
//   Comfy    ComfyUI's /system_stats (torch_vram_total: what its PyTorch holds), local ComfyUI only

use serde_json::Value;

use crate::protocol::ScreenRect;

/// Photoshop's scratch files on one drive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scratch {
    pub drive: char,
    /// bytes in "Photoshop Temp*" files
    pub used: u64,
    /// bytes free on that drive
    pub free: u64,
}

/// One sample; None = not available (the row is left out).
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

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub label: &'static str,
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

/// The lines shown, top to bottom.
pub fn rows(s: &Stats) -> Vec<Row> {
    let mut out = Vec::new();
    let mut push = |label: &'static str, value: String, level: Level| out.push(Row { label, value, level });
    if let Some(c) = s.cpu {
        push("CPU", format!("{:.0}%", c.clamp(0.0, 1.0) * 100.0), load(c));
    }
    if let Some((used, total)) = s.ram {
        push("内存", format!("{} / {} GB", gb(used), gb(total)), load(share(used, total)));
    }
    if let Some(g) = s.gpu {
        push("GPU", format!("{:.0}%", g.clamp(0.0, 1.0) * 100.0), load(g));
    }
    if let Some((used, total)) = s.vram {
        push("显存", format!("{} / {} GB", gb(used), gb(total)), load(share(used, total)));
    }
    if let Some(ps) = s.photoshop {
        // Photoshop alone holding most of the machine's memory is what comes before it stalls
        let level = match s.ram {
            Some((_, total)) if share(ps, total) >= 0.75 => Level::High,
            Some((_, total)) if share(ps, total) >= 0.60 => Level::Warn,
            _ => Level::Normal,
        };
        push("PS", format!("{} GB", gb(ps)), level);
    }
    if let Some(sc) = s.scratch {
        let free = sc.free as f64 / GB;
        let level = if free < 20.0 {
            Level::High
        } else if free < 50.0 {
            Level::Warn
        } else {
            Level::Normal
        };
        push("暂存", format!("{} GB · {}: 余 {} GB", gb(sc.used), sc.drive, gb(sc.free)), level);
    }
    if let Some(c) = s.comfy {
        push("Comfy", format!("{} GB", gb(c)), Level::Normal);
    }
    out
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

fn intersects(a: Px, b: Px) -> bool {
    a.0 < b.2 && b.0 < a.2 && a.1 < b.3 && b.1 < a.3
}

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

/// Top-left of a `size` box in the bottom-right corner of `area`, `margin` in from the edges; moved
/// above `avoid` (the completion notice, which uses the same corner) when the two would overlap.
#[cfg_attr(not(windows), allow(dead_code))]
fn place(area: Px, size: (i32, i32), margin: i32, avoid: Option<Px>) -> (i32, i32) {
    let x = (area.2 - size.0 - margin).max(area.0);
    let mut y = area.3 - size.1 - margin;
    if let Some(a) = avoid {
        if intersects((x, y, x + size.0, y + size.1), a) {
            y = a.1 - size.1 - margin / 2;
        }
    }
    (x, y.max(area.1))
}

#[cfg(windows)]
pub use imp::{set, set_view};

/// Turns the box on or off; `comfy` is ComfyUI's address for its row (None: no such row).
#[cfg(not(windows))]
pub fn set(_on: bool, _comfy: Option<String>) {}

/// The canvas on screen (None: no document, the box goes to the corner of Photoshop's window).
#[cfg(not(windows))]
pub fn set_view(_view: Option<ScreenRect>) {}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Mutex, Once};
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreateRoundRectRgn,
        CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, InvalidateRect, MonitorFromPoint,
        SelectObject, SetBkMode, SetTextColor, SetWindowRgn, PAINTSTRUCT,
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

    use super::{area, comfy_vram, cpu_usage, place, rows, Level, Px, Scratch, Stats};
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
    /// on / off or the view changed: place again now
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
    const DT_RIGHT: u32 = 0x0002;
    const DT_VCENTER: u32 = 0x0004;
    const DT_SINGLELINE: u32 = 0x0020;
    const DT_NOPREFIX: u32 = 0x0800;
    const SRCCOPY: u32 = 0x00CC_0020;
    const DEFAULT_CHARSET: u32 = 1;
    const CLEARTYPE_QUALITY: u32 = 5;

    // logical px (× the display scale); colours are COLORREF 0x00BBGGRR, the plugin's tokens
    const WIDTH: f64 = 208.0;
    const ROW: f64 = 18.0;
    const PAD_X: f64 = 10.0;
    const PAD_Y: f64 = 7.0;
    const MARGIN: f64 = 12.0;
    const RADIUS: f64 = 6.0;
    const FONT_PX: f64 = 12.0; // --fs
    const ALPHA: u8 = 232;
    const C_BG: u32 = 0x002A_2A2A; // --c-surface
    const C_LABEL: u32 = 0x0099_948F; // --c-text-3
    const C_TEXT: u32 = 0x00EC_ECEC; // --c-text
    const C_WARN: u32 = 0x004B_B0E3; // --c-warn
    const C_HIGH: u32 = 0x0069_7AEC; // --c-err

    /// the window looks at Photoshop this often (ms); a sample is taken every SAMPLE_MS
    const TICK_MS: u32 = 250;
    const SAMPLE_MS: u64 = 1000;
    /// Photoshop must be away for this many ticks in a row before the box goes (see win.rs PARK_AFTER_TICKS)
    const AWAY_TICKS: u32 = 2;

    static ON: AtomicBool = AtomicBool::new(false);
    static VISIBLE: AtomicBool = AtomicBool::new(false);
    static AWAY: AtomicU32 = AtomicU32::new(0);
    /// display scale × 100 the box was last laid out at (for painting)
    static SCALE: AtomicU32 = AtomicU32::new(100);
    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
    static COMFY: Mutex<Option<String>> = Mutex::new(None);
    static VIEW: Mutex<Option<ScreenRect>> = Mutex::new(None);
    static STATS: Mutex<Option<Stats>> = Mutex::new(None);
    /// where the window is now (left, top, width, height)
    static PLACED: Mutex<Px> = Mutex::new((0, 0, 0, 0));
    static START: Once = Once::new();

    fn post(msg: u32) {
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !h.is_null() {
            unsafe { PostMessageW(h, msg, 0, 0) };
        }
    }

    /// Turns the box on or off; `comfy` is ComfyUI's address for its row (None: no such row).
    pub fn set(on: bool, comfy: Option<String>) {
        if let Ok(mut c) = COMFY.lock() {
            *c = comfy.filter(|b| !b.trim().is_empty());
        }
        let was = ON.swap(on, Ordering::SeqCst);
        if was != on {
            log::line(format!("monitor: {}", if on { "on" } else { "off" }));
        }
        if !on && HWND_SELF.load(Ordering::SeqCst) == 0 {
            return; // never shown: no window to make
        }
        START.call_once(|| {
            thread::spawn(run);
            thread::spawn(sample_loop);
        });
        post(WM_APP_PLACE);
    }

    /// The canvas on screen (None: no document, the box goes to the corner of Photoshop's window).
    pub fn set_view(view: Option<ScreenRect>) {
        let changed = VIEW.lock().map(|mut v| std::mem::replace(&mut *v, view) != view).unwrap_or(false);
        if changed {
            post(WM_APP_PLACE);
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
            log::line("monitor: hidden");
        }
    }

    /// Shows, moves or hides the box for where Photoshop is now.
    unsafe fn tick(h: HWND) {
        if !ON.load(Ordering::SeqCst) {
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
        let stats = STATS.lock().ok().and_then(|s| *s);
        let n = stats.map(|s| rows(&s).len()).unwrap_or(0);
        if n == 0 {
            // nothing measured yet; shown so the sampler starts (it waits for VISIBLE)
            VISIBLE.store(true, Ordering::SeqCst);
            return;
        }
        let view = VIEW.lock().ok().and_then(|v| *v);
        let a = area(view, ps);
        let k = scale_at(a.2 - 1, a.3 - 1);
        let size = ((WIDTH * k) as i32, ((PAD_Y * 2.0 + ROW * n as f64) * k) as i32);
        let (x, y) = place(a, size, (MARGIN * k) as i32, crate::win::toast_rect());
        let want = (x, y, size.0, size.1);
        let Ok(mut placed) = PLACED.lock() else { return };
        let shown = VISIBLE.load(Ordering::SeqCst) && *placed != (0, 0, 0, 0);
        if shown && *placed == want {
            return;
        }
        if (placed.2, placed.3) != size {
            let r = (RADIUS * k * 2.0) as i32;
            let rgn = CreateRoundRectRgn(0, 0, size.0 + 1, size.1 + 1, r, r);
            // the window owns the region from here on
            if SetWindowRgn(h, rgn, 1) == 0 {
                DeleteObject(rgn);
            }
        }
        SCALE.store((k * 100.0) as u32, Ordering::SeqCst);
        SetWindowPos(h, HWND_TOPMOST, x, y, size.0, size.1, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
        if !shown {
            log::line(format!("monitor: shown at {x},{y} {}x{} rows={n}", size.0, size.1));
        }
        *placed = want;
        VISIBLE.store(true, Ordering::SeqCst);
        InvalidateRect(h, null(), 0);
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
        let bg = CreateSolidBrush(C_BG);
        FillRect(mem, &rc, bg);
        DeleteObject(bg);

        let k = SCALE.load(Ordering::SeqCst) as f64 / 100.0;
        let face = wide("Microsoft YaHei UI");
        let font = CreateFontW(
            -((FONT_PX * k).round() as i32),
            0,
            0,
            0,
            400,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            0,
            0,
            CLEARTYPE_QUALITY,
            0,
            face.as_ptr(),
        );
        let old_font = SelectObject(mem, font);
        SetBkMode(mem, TRANSPARENT_BK);
        let list = STATS.lock().ok().and_then(|s| *s).map(|s| rows(&s)).unwrap_or_default();
        let (px, py, row) = ((PAD_X * k) as i32, (PAD_Y * k) as i32, ROW * k);
        for (i, r) in list.iter().enumerate() {
            let top = py + (row * i as f64) as i32;
            let mut line = RECT { left: px, top, right: w - px, bottom: top + row as i32 };
            let label = wide(r.label);
            SetTextColor(mem, C_LABEL);
            DrawTextW(mem, label.as_ptr(), -1, &mut line, DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
            let value = wide(&r.value);
            SetTextColor(
                mem,
                match r.level {
                    Level::Normal => C_TEXT,
                    Level::Warn => C_WARN,
                    Level::High => C_HIGH,
                },
            );
            DrawTextW(mem, value.as_ptr(), -1, &mut line, DT_SINGLELINE | DT_VCENTER | DT_RIGHT | DT_NOPREFIX);
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
            WM_TIMER | WM_APP_PLACE => {
                tick(h);
                0
            }
            WM_APP_STATS => {
                tick(h); // the number of rows may have changed
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
            let class = wide("WavePlugMonitor");
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
            let title = wide("WavePlug 性能监视");
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
                log::line("monitor: window not created");
                return;
            }
            // layered is what makes WS_EX_TRANSPARENT pass clicks to other processes
            SetLayeredWindowAttributes(h, 0, ALPHA, LWA_ALPHA);
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            SetTimer(h, 1, TICK_MS, None);
            log::line("monitor: window ready");
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
        // CPU is a difference between two samples: take the first now, so the row is there from
        // the first time the box is drawn (a row appearing later would make the box jump)
        let mut cpu_prev: Option<(u64, u64)> = cpu_times();
        thread::sleep(Duration::from_millis(250));
        let mut ps_handle: isize = 0;
        let (mut scratch_now, mut comfy_now) = (None, None);
        let mut n: u64 = 0;
        loop {
            // nothing is measured while the box is off or Photoshop isn't in front
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
            n += 1;
            let changed = STATS.lock().map(|mut cur| std::mem::replace(&mut *cur, Some(s)) != Some(s)).unwrap_or(false);
            if changed {
                post(WM_APP_STATS);
            }
            thread::sleep(Duration::from_millis(SAMPLE_MS));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: u64 = 1024 * 1024 * 1024;

    #[test]
    fn only_what_was_measured_is_listed() {
        assert!(rows(&Stats::default()).is_empty());
        let r = rows(&Stats { cpu: Some(0.374), ram: Some((20 * G, 32 * G)), ..Default::default() });
        assert_eq!(r.iter().map(|r| r.label).collect::<Vec<_>>(), ["CPU", "内存"]);
        assert_eq!(r[0].value, "37%");
        assert_eq!(r[1].value, "20.0 / 32.0 GB");
    }

    #[test]
    fn every_row_in_order() {
        let r = rows(&Stats {
            cpu: Some(0.05),
            ram: Some((8 * G, 32 * G)),
            gpu: Some(0.57),
            vram: Some((9 * G + G / 10, 16 * G)),
            photoshop: Some(6 * G),
            scratch: Some(Scratch { drive: 'G', used: 82 * G, free: 721 * G }),
            comfy: Some(7 * G + G / 5),
        });
        let text: Vec<String> = r.iter().map(|r| format!("{} {}", r.label, r.value)).collect();
        assert_eq!(
            text,
            ["CPU 5%", "内存 8.0 / 32.0 GB", "GPU 57%", "显存 9.1 / 16.0 GB", "PS 6.0 GB", "暂存 82.0 GB · G: 余 721 GB", "Comfy 7.2 GB"]
        );
        assert!(r.iter().all(|r| r.level == Level::Normal));
    }

    #[test]
    fn levels() {
        assert_eq!(load(0.79), Level::Normal);
        assert_eq!(load(0.80), Level::Warn);
        assert_eq!(load(0.92), Level::High);
        // Photoshop holding most of the memory
        let ps = |bytes| rows(&Stats { ram: Some((30 * G, 32 * G)), photoshop: Some(bytes), ..Default::default() })[1].level;
        assert_eq!(ps(10 * G), Level::Normal);
        assert_eq!(ps(20 * G), Level::Warn);
        assert_eq!(ps(25 * G), Level::High);
        // the scratch drive running out
        let sc = |free| rows(&Stats { scratch: Some(Scratch { drive: 'D', used: G, free }), ..Default::default() })[0].level;
        assert_eq!(sc(60 * G), Level::Normal);
        assert_eq!(sc(40 * G), Level::Warn);
        assert_eq!(sc(10 * G), Level::High);
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
    fn sits_in_the_bottom_right_corner() {
        assert_eq!(place((1000, 100, 3000, 2000), (200, 130), 12, None), (2788, 1858));
        // a canvas smaller than the box: stays inside its top-left
        assert_eq!(place((0, 0, 100, 50), (200, 130), 12, None), (0, 0));
    }

    #[test]
    fn moves_above_the_completion_notice() {
        let toast = (2688, 1918, 2988, 1988);
        assert_eq!(place((1000, 100, 3000, 2000), (200, 130), 12, Some(toast)), (2788, 1918 - 130 - 6));
        // a notice somewhere else changes nothing
        assert_eq!(place((1000, 100, 3000, 2000), (200, 130), 12, Some((0, 0, 300, 70))), (2788, 1858));
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
