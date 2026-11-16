// 从网页拖入 (web drop catcher): a browser drag reaches the WaveLayer panel as one line of text
// (UXP hands the panel text/plain only: the link around an image, 11-16), while the drag itself
// carries the image — as a file (FileGroupDescriptorW + FileContents), PNG / DIB data, HTML with
// <img src>, a URL. Other Windows programs read all of that; UXP can't.
//
// So when such a drag enters the panel, the plugin asks for `web-catch`: this helper puts a
// practically invisible window (alpha 1/255, topmost, never activated) over the panel, anchored at
// the cursor, registered as an OLE drop target. The next mouse move makes it the drag's target;
// on the drop it reads every format, writes images into the plugin's temporary folder and answers
// `web-drop` (files by name, plus the html / text / url for what has no file). Leaving it, or no
// drag arriving within a moment, hides it again and answers `web-drop-leave`.
//
// Plain Win32 on its own thread (OleInitialize'd, an STA with its own message loop), like
// frame.rs. The parsing below is pure and tested on every platform.

use serde::Serialize;

#[cfg(windows)]
pub use imp::set;

/// What the plugin sent: where the cursor is inside the panel and where the drop area lies (CSS px
/// of the panel's viewport), and the folder to write into (the plugin's temporary folder).
#[derive(Debug, Clone, PartialEq)]
pub struct CatchRequest {
    pub client: (f64, f64),
    pub area: (f64, f64, f64, f64),
    pub folder: String,
}

/// Shows the catcher for `req`, or hides it.
#[cfg(not(windows))]
pub fn set(_req: Option<CatchRequest>) {}

/// A file written for the plugin: `file` its name in the folder, `name` the layer name.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DroppedFile {
    pub file: String,
    pub name: String,
}

/// The catcher's window on screen (left, top, right, bottom px): the drop area put so that the
/// point under the cursor in the panel (`client`, CSS px) is the cursor (`cursor`, screen px);
/// `scale` the screen px per CSS px. Always covers the cursor, even when `scale` is off.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn catch_rect(cursor: (i32, i32), scale: f64, req: &CatchRequest) -> (i32, i32, i32, i32) {
    let s = if scale.is_finite() && scale > 0.1 { scale } else { 1.0 };
    let (l, t, w, h) = req.area;
    let left = cursor.0 as f64 + (l - req.client.0) * s;
    let top = cursor.1 as f64 + (t - req.client.1) * s;
    let mut r = (left.round() as i32, top.round() as i32, (left + w.max(1.0) * s).round() as i32, (top + h.max(1.0) * s).round() as i32);
    // the cursor must be inside, whatever the numbers said
    r.0 = r.0.min(cursor.0 - 8);
    r.1 = r.1.min(cursor.1 - 8);
    r.2 = r.2.max(cursor.0 + 8);
    r.3 = r.3.max(cursor.1 + 8);
    r
}

/// The file names in a FILEGROUPDESCRIPTORW: a u32 count, then FILEDESCRIPTORW records of 592
/// bytes with cFileName (260 UTF-16 units) at offset 72.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn descriptor_names(bytes: &[u8]) -> Vec<String> {
    const SIZE: usize = 592;
    const NAME_AT: usize = 72;
    let Some(count) = bytes.get(..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for i in 0..count.min(64) {
        let at = 4 + i * SIZE + NAME_AT;
        let Some(raw) = bytes.get(at..at + 520) else { break };
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
        out.push(String::from_utf16_lossy(&units));
    }
    out
}

/// An image's extension from its first bytes; None when it isn't a picture Photoshop places.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sniff_ext(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if b.starts_with(b"GIF8") {
        Some("gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("webp")
    } else if b.starts_with(b"BM") {
        Some("bmp")
    } else if b.starts_with(&[0x49, 0x49, 0x2A, 0]) || b.starts_with(&[0x4D, 0x4D, 0, 0x2A]) {
        Some("tif")
    } else if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
        Some("avif")
    } else {
        let head = String::from_utf8_lossy(&b[..b.len().min(256)]).to_ascii_lowercase();
        (head.contains("<svg") || (head.starts_with("<?xml") && head.contains("svg"))).then_some("svg")
    }
}

/// A CF_DIB / CF_DIBV5 block made a .bmp file: the 14-byte file header in front, its pixel offset
/// past the header, the colour masks and the palette.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    let u32_at = |i: usize| dib.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let u16_at = |i: usize| dib.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let size = u32_at(0)? as usize;
    if !(12..=124).contains(&size) || dib.len() <= size {
        return None;
    }
    let bits = u16_at(14)? as u32;
    let compression = u32_at(16).unwrap_or(0);
    let used = u32_at(32).unwrap_or(0);
    let palette = if used > 0 { used } else if bits <= 8 { 1 << bits } else { 0 } as usize;
    let masks = if size == 40 && (compression == 3 || compression == 6) { if compression == 6 { 16 } else { 12 } } else { 0 };
    let offset = 14 + size + masks + palette * 4;
    let total = 14 + dib.len();
    if offset > total {
        return None;
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

/// A layer name from a file name: no extension, no characters Windows refuses, at most 60.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn layer_name(file: &str) -> String {
    let base = file.rsplit(['\\', '/']).next().unwrap_or(file);
    let stem = match base.rfind('.') {
        Some(i) if i > 0 && base.len() - i <= 6 => &base[..i],
        _ => base,
    };
    let clean: String = stem.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).take(60).collect();
    if clean.trim().is_empty() { "网页图片".into() } else { clean.trim().to_string() }
}

/// The extension a file name says, lower case, when it is an image's.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn name_ext(file: &str) -> Option<String> {
    let e = file.rsplit_once('.')?.1.to_ascii_lowercase();
    let e = if e == "jpeg" { "jpg".to_string() } else if e == "tiff" { "tif".to_string() } else { e };
    ["png", "jpg", "gif", "webp", "bmp", "tif", "svg", "avif", "psd", "psb"].contains(&e.as_str()).then_some(e)
}

/// CF_HTML ("HTML Format", UTF-8): the part between StartHTML and EndHTML when the header says
/// where, else all of it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn cf_html(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes.split(|&b| b == 0).next().unwrap_or(bytes)).into_owned();
    let num = |key: &str| -> Option<usize> {
        let i = text.find(key)? + key.len();
        text[i..].split(['\r', '\n']).next()?.trim().parse().ok()
    };
    match (num("StartHTML:"), num("EndHTML:")) {
        (Some(s), Some(e)) if s < e && e <= bytes.len() => String::from_utf8_lossy(&bytes[s..e]).into_owned(),
        _ => text,
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Mutex, Once};
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::core::{GUID, HRESULT};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, POINTL, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, MonitorFromPoint};
    use windows_sys::Win32::System::Com::{FORMATETC, STGMEDIUM};
    use windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Ole::{OleInitialize, RegisterDragDrop, ReleaseStgMedium};
    use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
    use windows_sys::Win32::UI::Shell::DragQueryFileW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetMessageW, KillTimer, PostMessageW,
        RegisterClassW, SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow, MSG, WNDCLASSW,
    };

    use super::{catch_rect, cf_html, descriptor_names, dib_to_bmp, layer_name, name_ext, sniff_ext, CatchRequest, DroppedFile};
    use crate::log;
    use crate::protocol::Event;

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const LWA_ALPHA: u32 = 0x0000_0002;
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const WM_TIMER: u32 = 0x0113;
    const WM_APP_CATCH: u32 = 0x8000 + 0x57;
    const MA_NOACTIVATE: LRESULT = 3;
    const SW_HIDE: i32 = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const HWND_TOPMOST: HWND = -1isize as HWND;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    /// no drag came in this long after showing: the drag is gone (or never reached us)
    const ARRIVE_MS: u32 = 1500;
    /// the window never stays longer than this
    const MAX_MS: u32 = 60_000;
    const TIMER_ARRIVE: usize = 1;
    const TIMER_MAX: usize = 2;

    const S_OK: HRESULT = 0;
    const E_NOINTERFACE: HRESULT = 0x8000_4002_u32 as i32;
    const DROPEFFECT_NONE: u32 = 0;
    const DROPEFFECT_COPY: u32 = 1;
    const DROPEFFECT_MOVE: u32 = 2;
    const DROPEFFECT_LINK: u32 = 4;
    const TYMED_HGLOBAL: u32 = 1;
    const TYMED_ISTREAM: u32 = 4;
    const DVASPECT_CONTENT: u32 = 1;
    const CF_DIB: u16 = 8;
    const CF_UNICODETEXT: u16 = 13;
    const CF_HDROP: u16 = 15;
    const CF_DIBV5: u16 = 17;
    /// one image never bigger than this
    const MAX_BYTES: usize = 200 * 1024 * 1024;

    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
    static WANTED: Mutex<Option<((i32, i32, i32, i32), PathBuf)>> = Mutex::new(None);
    static FOLDER: Mutex<Option<PathBuf>> = Mutex::new(None);
    static ENTERED: AtomicBool = AtomicBool::new(false);
    static SHOWN: AtomicBool = AtomicBool::new(false);
    static START: Once = Once::new();

    pub fn set(req: Option<CatchRequest>) {
        let wanted = req.map(|r| {
            let mut p = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut p) };
            let (mut dx, mut dy) = (96u32, 96u32);
            unsafe { GetDpiForMonitor(MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST), 0, &mut dx, &mut dy) };
            let rect = catch_rect((p.x, p.y), dx as f64 / 96.0, &r);
            log::line(format!("web catch at cursor=({},{}) dpi={dx} rect={rect:?}", p.x, p.y));
            (rect, PathBuf::from(r.folder))
        });
        if wanted.is_none() && HWND_SELF.load(Ordering::SeqCst) == 0 {
            return;
        }
        if let Ok(mut w) = WANTED.lock() {
            *w = wanted;
        }
        START.call_once(|| {
            std::thread::spawn(run);
        });
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !h.is_null() {
            unsafe { PostMessageW(h, WM_APP_CATCH, 0, 0) };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    unsafe fn hide(h: HWND, why: &str, tell: bool) {
        KillTimer(h, TIMER_ARRIVE);
        KillTimer(h, TIMER_MAX);
        ShowWindow(h, SW_HIDE);
        let was = SHOWN.swap(false, Ordering::SeqCst);
        ENTERED.store(false, Ordering::SeqCst);
        if was {
            log::line(format!("web catch hidden: {why}"));
            if tell {
                crate::server::send(&Event::WebDropLeave);
            }
        }
    }

    unsafe fn apply(h: HWND) {
        let wanted = WANTED.lock().ok().and_then(|mut w| w.take());
        let Some((r, folder)) = wanted else {
            hide(h, "plugin", false);
            return;
        };
        if let Ok(mut f) = FOLDER.lock() {
            *f = Some(folder);
        }
        ENTERED.store(false, Ordering::SeqCst);
        SHOWN.store(true, Ordering::SeqCst);
        SetWindowPos(h, HWND_TOPMOST, r.0, r.1, (r.2 - r.0).max(1), (r.3 - r.1).max(1), SWP_NOACTIVATE | SWP_SHOWWINDOW);
        SetTimer(h, TIMER_ARRIVE, ARRIVE_MS, None);
        SetTimer(h, TIMER_MAX, MAX_MS, None);
    }

    unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_APP_CATCH => {
                apply(h);
                0
            }
            WM_TIMER => {
                if w == TIMER_ARRIVE {
                    KillTimer(h, TIMER_ARRIVE);
                    if !ENTERED.load(Ordering::SeqCst) {
                        hide(h, "no drag arrived", true);
                    }
                } else if w == TIMER_MAX {
                    hide(h, "too long", true);
                }
                0
            }
            WM_MOUSEACTIVATE => MA_NOACTIVATE,
            _ => DefWindowProcW(h, msg, w, l),
        }
    }

    fn run() {
        unsafe {
            OleInitialize(null());
            let class = wide("WavePlugWebCatch");
            let inst = GetModuleHandleW(null());
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: inst,
                lpszClassName: class.as_ptr(),
                hbrBackground: CreateSolidBrush(0),
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            let h = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE,
                class.as_ptr(),
                class.as_ptr(),
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
                log::line("web catch: no window");
                return;
            }
            // practically invisible, but still hit (alpha 0 would let the drag fall through)
            SetLayeredWindowAttributes(h, 0, 1, LWA_ALPHA);
            let target = Box::into_raw(Box::new(DropTarget { vtbl: &VTBL, refs: AtomicU32::new(1) }));
            let hr = RegisterDragDrop(h, target as *mut c_void);
            log::line(format!("web catch ready hr={hr:#x}"));
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            apply(h);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        }
    }

    // ── IDropTarget ──

    const fn guid(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> GUID {
        GUID { data1: d1, data2: d2, data3: d3, data4: d4 }
    }
    const COM_TAIL: [u8; 8] = [0xC0, 0, 0, 0, 0, 0, 0, 0x46];
    const IID_IUNKNOWN: GUID = guid(0, 0, 0, COM_TAIL);
    const IID_IDROPTARGET: GUID = guid(0x0000_0122, 0, 0, COM_TAIL);

    fn same(a: &GUID, b: &GUID) -> bool {
        a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
    }

    #[repr(C)]
    struct DropTargetVtbl {
        query_interface: unsafe extern "system" fn(*mut DropTarget, *const GUID, *mut *mut c_void) -> HRESULT,
        add_ref: unsafe extern "system" fn(*mut DropTarget) -> u32,
        release: unsafe extern "system" fn(*mut DropTarget) -> u32,
        drag_enter: unsafe extern "system" fn(*mut DropTarget, *mut c_void, u32, POINTL, *mut u32) -> HRESULT,
        drag_over: unsafe extern "system" fn(*mut DropTarget, u32, POINTL, *mut u32) -> HRESULT,
        drag_leave: unsafe extern "system" fn(*mut DropTarget) -> HRESULT,
        drop: unsafe extern "system" fn(*mut DropTarget, *mut c_void, u32, POINTL, *mut u32) -> HRESULT,
    }

    #[repr(C)]
    struct DropTarget {
        vtbl: *const DropTargetVtbl,
        refs: AtomicU32,
    }

    static VTBL: DropTargetVtbl = DropTargetVtbl { query_interface, add_ref, release, drag_enter, drag_over, drag_leave, drop };

    unsafe extern "system" fn query_interface(this: *mut DropTarget, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
        if out.is_null() {
            return E_NOINTERFACE;
        }
        if same(&*iid, &IID_IUNKNOWN) || same(&*iid, &IID_IDROPTARGET) {
            add_ref(this);
            *out = this as *mut c_void;
            S_OK
        } else {
            *out = null_mut();
            E_NOINTERFACE
        }
    }
    // the one target lives as long as the process: counted, never freed
    unsafe extern "system" fn add_ref(this: *mut DropTarget) -> u32 {
        (*this).refs.fetch_add(1, Ordering::SeqCst) + 1
    }
    unsafe extern "system" fn release(this: *mut DropTarget) -> u32 {
        (*this).refs.fetch_sub(1, Ordering::SeqCst).saturating_sub(1).max(1)
    }

    fn effect(allowed: u32) -> u32 {
        [DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE].into_iter().find(|e| allowed & e != 0).unwrap_or(DROPEFFECT_NONE)
    }

    unsafe extern "system" fn drag_enter(_: *mut DropTarget, _data: *mut c_void, _keys: u32, _pt: POINTL, eff: *mut u32) -> HRESULT {
        ENTERED.store(true, Ordering::SeqCst);
        if !eff.is_null() {
            *eff = effect(*eff);
        }
        S_OK
    }
    unsafe extern "system" fn drag_over(_: *mut DropTarget, _keys: u32, _pt: POINTL, eff: *mut u32) -> HRESULT {
        if !eff.is_null() {
            *eff = effect(*eff);
        }
        S_OK
    }
    unsafe extern "system" fn drag_leave(_: *mut DropTarget) -> HRESULT {
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !h.is_null() {
            hide(h, "drag left", true);
        }
        S_OK
    }
    unsafe extern "system" fn drop(_: *mut DropTarget, data: *mut c_void, _keys: u32, _pt: POINTL, eff: *mut u32) -> HRESULT {
        if !eff.is_null() {
            *eff = effect(*eff);
        }
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        let folder = FOLDER.lock().ok().and_then(|f| f.clone());
        if !h.is_null() {
            hide(h, "dropped", false);
        }
        let ev = match folder {
            Some(folder) if !data.is_null() => read(data, &folder),
            _ => Event::WebDrop { files: Vec::new(), html: String::new(), text: String::new(), url: String::new(), formats: vec!["no folder".into()] },
        };
        crate::server::send(&ev);
        S_OK
    }

    // ── reading the drop (IDataObject, called through its vtable) ──

    #[repr(C)]
    struct DataObjectVtbl {
        query_interface: usize,
        add_ref: usize,
        release: usize,
        get_data: unsafe extern "system" fn(*mut c_void, *const FORMATETC, *mut STGMEDIUM) -> HRESULT,
        get_data_here: usize,
        query_get_data: unsafe extern "system" fn(*mut c_void, *const FORMATETC) -> HRESULT,
    }

    #[repr(C)]
    struct StreamVtbl {
        query_interface: usize,
        add_ref: usize,
        release: usize,
        read: unsafe extern "system" fn(*mut c_void, *mut c_void, u32, *mut u32) -> HRESULT,
    }

    fn registered(name: &str) -> u16 {
        let w = wide(name);
        unsafe { RegisterClipboardFormatW(w.as_ptr()) as u16 }
    }

    unsafe fn has(data: *mut c_void, cf: u16) -> bool {
        let vt = *(data as *const *const DataObjectVtbl);
        let f = FORMATETC { cfFormat: cf, ptd: null_mut(), dwAspect: DVASPECT_CONTENT, lindex: -1, tymed: TYMED_HGLOBAL | TYMED_ISTREAM };
        cf != 0 && ((*vt).query_get_data)(data, &f) == S_OK
    }

    /// The bytes of format `cf` (item `index` for FileContents), from an HGLOBAL or an IStream.
    unsafe fn get(data: *mut c_void, cf: u16, index: i32) -> Option<Vec<u8>> {
        if cf == 0 {
            return None;
        }
        let vt = *(data as *const *const DataObjectVtbl);
        let f = FORMATETC { cfFormat: cf, ptd: null_mut(), dwAspect: DVASPECT_CONTENT, lindex: index, tymed: TYMED_HGLOBAL | TYMED_ISTREAM };
        let mut m: STGMEDIUM = std::mem::zeroed();
        if ((*vt).get_data)(data, &f, &mut m) != S_OK {
            return None;
        }
        let out = if m.tymed == TYMED_HGLOBAL && !m.u.hGlobal.is_null() {
            let size = GlobalSize(m.u.hGlobal).min(MAX_BYTES);
            let p = GlobalLock(m.u.hGlobal) as *const u8;
            let v = if p.is_null() { None } else { Some(std::slice::from_raw_parts(p, size).to_vec()) };
            GlobalUnlock(m.u.hGlobal);
            v
        } else if m.tymed == TYMED_ISTREAM && !m.u.pstm.is_null() {
            let s = m.u.pstm;
            let svt = *(s as *const *const StreamVtbl);
            let mut v = Vec::new();
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let mut got = 0u32;
                let hr = ((*svt).read)(s, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut got);
                if got > 0 {
                    v.extend_from_slice(&buf[..got as usize]);
                }
                if hr != S_OK || got == 0 || v.len() >= MAX_BYTES {
                    break;
                }
            }
            Some(v)
        } else {
            None
        };
        ReleaseStgMedium(&mut m);
        out
    }

    unsafe fn hdrop_paths(data: *mut c_void) -> Vec<PathBuf> {
        let vt = *(data as *const *const DataObjectVtbl);
        let f = FORMATETC { cfFormat: CF_HDROP, ptd: null_mut(), dwAspect: DVASPECT_CONTENT, lindex: -1, tymed: TYMED_HGLOBAL };
        let mut m: STGMEDIUM = std::mem::zeroed();
        if ((*vt).get_data)(data, &f, &mut m) != S_OK {
            return Vec::new();
        }
        let mut out = Vec::new();
        let hdrop = m.u.hGlobal as *mut c_void;
        let n = DragQueryFileW(hdrop as _, u32::MAX, null_mut(), 0);
        for i in 0..n.min(64) {
            let len = DragQueryFileW(hdrop as _, i, null_mut(), 0);
            let mut buf = vec![0u16; len as usize + 1];
            DragQueryFileW(hdrop as _, i, buf.as_mut_ptr(), buf.len() as u32);
            out.push(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])));
        }
        ReleaseStgMedium(&mut m);
        out
    }

    fn utf16(bytes: &[u8]) -> String {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
        String::from_utf16_lossy(&units).trim().to_string()
    }

    /// Everything the drop carries that the plugin can use: images written into `folder`, and the
    /// html / text / url for the rest.
    unsafe fn read(data: *mut c_void, folder: &std::path::Path) -> Event {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let mut files: Vec<DroppedFile> = Vec::new();
        let mut formats: Vec<String> = Vec::new();
        let put = |bytes: &[u8], ext: &str, name: String, files: &mut Vec<DroppedFile>| {
            let file = format!("waveplug_web_{stamp}_{}.{ext}", files.len());
            match std::fs::write(folder.join(&file), bytes) {
                Ok(()) => files.push(DroppedFile { file, name }),
                Err(e) => log::line(format!("web drop: not written into {}: {e}", folder.display())),
            }
        };
        // 1. real files (a file manager, some browsers)
        if has(data, CF_HDROP) {
            formats.push("CF_HDROP".into());
            for p in hdrop_paths(data) {
                let shown = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let Ok(bytes) = std::fs::read(&p) else { continue };
                if let Some(ext) = name_ext(&shown).or_else(|| sniff_ext(&bytes).map(String::from)) {
                    put(&bytes, &ext, layer_name(&shown), &mut files);
                }
            }
        }
        // 2. virtual files: what Chrome / Edge / Firefox give for a dragged image
        let group = registered("FileGroupDescriptorW");
        if files.is_empty() && has(data, group) {
            formats.push("FileGroupDescriptorW".into());
            let names = get(data, group, -1).map(|b| descriptor_names(&b)).unwrap_or_default();
            let contents = registered("FileContents");
            for (i, shown) in names.iter().enumerate() {
                let Some(bytes) = get(data, contents, i as i32) else { continue };
                if let Some(ext) = sniff_ext(&bytes).map(String::from).or_else(|| name_ext(shown)) {
                    put(&bytes, &ext, layer_name(shown), &mut files);
                }
            }
        }
        // 3. image data
        if files.is_empty() {
            let png = registered("PNG");
            if let Some(bytes) = has(data, png).then(|| get(data, png, -1)).flatten() {
                formats.push("PNG".into());
                put(&bytes, "png", "网页图片".into(), &mut files);
            } else if let Some(bmp) = [CF_DIBV5, CF_DIB].into_iter().find(|&cf| has(data, cf)).and_then(|cf| get(data, cf, -1)).and_then(|d| dib_to_bmp(&d)) {
                formats.push("DIB".into());
                put(&bmp, "bmp", "网页图片".into(), &mut files);
            }
        }
        // 4. what the plugin can still work from (an <img src> to download, words for a text layer)
        let html_cf = registered("HTML Format");
        let html = if has(data, html_cf) { formats.push("HTML".into()); get(data, html_cf, -1).map(|b| cf_html(&b)).unwrap_or_default() } else { String::new() };
        let url_cf = registered("UniformResourceLocatorW");
        let url = if has(data, url_cf) { formats.push("URL".into()); get(data, url_cf, -1).map(|b| utf16(&b)).unwrap_or_default() } else { String::new() };
        let text = if has(data, CF_UNICODETEXT) { formats.push("TEXT".into()); get(data, CF_UNICODETEXT, -1).map(|b| utf16(&b)).unwrap_or_default() } else { String::new() };
        log::line(format!("web drop formats={formats:?} files={} html={} url={} text={}", files.len(), html.len(), url.len(), text.len()));
        Event::WebDrop { files, html: html.chars().take(20_000).collect(), text: text.chars().take(4000).collect(), url, formats }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> CatchRequest {
        CatchRequest { client: (100.0, 200.0), area: (4.0, 4.0, 300.0, 500.0), folder: String::new() }
    }

    #[test]
    fn the_catcher_lies_over_the_drop_area_around_the_cursor() {
        assert_eq!(catch_rect((1000, 800), 1.0, &req()), (904, 604, 1204, 1104));
        assert_eq!(catch_rect((1000, 800), 1.5, &req()), (856, 506, 1306, 1256));
        // nonsense numbers: still covers the cursor
        let r = catch_rect((50, 60), 1.0, &CatchRequest { client: (0.0, 0.0), area: (500.0, 500.0, 0.0, 0.0), folder: String::new() });
        assert!(r.0 < 50 && r.2 > 50 && r.1 < 60 && r.3 > 60);
    }

    #[test]
    fn descriptor_gives_the_names() {
        let mut b = vec![0u8; 4 + 2 * 592];
        b[..4].copy_from_slice(&2u32.to_le_bytes());
        for (i, name) in ["猫.jpg", "dog.png"].iter().enumerate() {
            let at = 4 + i * 592 + 72;
            for (j, u) in name.encode_utf16().enumerate() {
                b[at + j * 2..at + j * 2 + 2].copy_from_slice(&u.to_le_bytes());
            }
        }
        assert_eq!(descriptor_names(&b), vec!["猫.jpg".to_string(), "dog.png".into()]);
        assert!(descriptor_names(&[1, 0]).is_empty());
        // a count larger than the data: as many as are there
        assert!(descriptor_names(&5u32.to_le_bytes()).is_empty());
    }

    #[test]
    fn images_are_known_by_their_bytes() {
        assert_eq!(sniff_ext(&[0x89, b'P', b'N', b'G', 13, 10]), Some("png"));
        assert_eq!(sniff_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_ext(b"GIF89a"), Some("gif"));
        assert_eq!(sniff_ext(b"\0\0\0\x1cftypavif"), Some("avif"));
        assert_eq!(sniff_ext(b"<?xml version='1.0'?><svg xmlns"), Some("svg"));
        assert_eq!(sniff_ext(b"<html><body>"), None);
    }

    #[test]
    fn a_dib_becomes_a_bmp_file() {
        // BITMAPINFOHEADER 40, 32 bpp, BI_BITFIELDS: 3 masks after the header
        let mut dib = vec![0u8; 40 + 12 + 16];
        dib[..4].copy_from_slice(&40u32.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[16..20].copy_from_slice(&3u32.to_le_bytes());
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32::from_le_bytes([bmp[2], bmp[3], bmp[4], bmp[5]]) as usize, 14 + dib.len());
        assert_eq!(u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]]), 14 + 40 + 12);
        // 8 bpp: a 256-colour palette
        let mut pal = vec![0u8; 40 + 1024 + 4];
        pal[..4].copy_from_slice(&40u32.to_le_bytes());
        pal[14..16].copy_from_slice(&8u16.to_le_bytes());
        assert_eq!(u32::from_le_bytes(dib_to_bmp(&pal).unwrap()[10..14].try_into().unwrap()), 14 + 40 + 1024);
        assert!(dib_to_bmp(&[1, 2, 3]).is_none());
    }

    #[test]
    fn names_and_html() {
        assert_eq!(layer_name("C:\\tmp\\猫 咪.jpeg"), "猫 咪");
        assert_eq!(layer_name("a:b?.png"), "a_b_");
        assert_eq!(layer_name(".png"), ".png");
        assert_eq!(layer_name(""), "网页图片");
        assert_eq!(name_ext("x.JPEG").as_deref(), Some("jpg"));
        assert_eq!(name_ext("x.html"), None);
        let body = "<img src=\"https://a/b.png\">";
        let head = format!("Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\n", 0, 0);
        let start = head.len();
        let doc = format!("Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\n{body}", start, start + body.len());
        assert_eq!(cf_html(doc.as_bytes()), body);
        assert_eq!(cf_html(b"<b>x</b>\0junk"), "<b>x</b>");
    }
}
