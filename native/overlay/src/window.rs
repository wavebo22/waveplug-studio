// The bar itself: one top-most popup with a borderless EDIT for the prompt, a numeric EDIT for the
// count and two owner-drawn buttons (生成, ×), painted in the panel's dark colours (styles.css
// tokens). Plain Win32 so Chinese input (IME) behaves exactly as in any Windows text box.
// Sizes are written at 96 DPI and scaled to the monitor the pointer is on.
//
// Placement follows Photoshop's own contextual task bar: centred under the selection, a fixed gap
// below it. The panel sends the selection's screen rectangle (worked out from Photoshop's view:
// zoom, view centre and view bounds). If it can't, a low-level mouse hook's record of the last drag
// on Photoshop stands in (a marquee or lasso drag = the selection on screen), and failing that the
// pointer. The hook also hides the bar as soon as a new press on Photoshop starts the next selection. A selection made without a drag (全选, Ctrl+click) falls
// back to the pointer.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{addr_of_mut, null, null_mut};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, FrameRect,
    GetMonitorInfoW, MonitorFromPoint, SelectObject, SetBkColor, SetBkMode, SetTextColor, HBRUSH, HDC, HFONT,
    MONITORINFO, PAINTSTRUCT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetForegroundWindow, GetMessageW,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, LoadCursorW, MoveWindow,
    PostMessageW, RegisterClassW, SendMessageW, SetForegroundWindow, SetTimer, SetWindowPos, SetWindowTextW,
    SetWindowsHookExW, CallNextHookEx,
    ShowWindow, TranslateMessage, MSG, WNDCLASSW,
};

use crate::protocol::{clamp_count, Anchor, Command, Event};
use crate::server;

// ── Win32 numbers (written out so they don't depend on how a windows-sys version types them) ──
const WS_POPUP: u32 = 0x8000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const ES_CENTER: u32 = 0x0001;
const ES_AUTOHSCROLL: u32 = 0x0080;
const ES_NUMBER: u32 = 0x2000;
const BS_OWNERDRAW: u32 = 0x000B;
const WM_DESTROY: u32 = 0x0002;
const WM_ACTIVATE: u32 = 0x0006;
const WM_PAINT: u32 = 0x000F;
const WM_ERASEBKGND: u32 = 0x0014;
const WM_DRAWITEM: u32 = 0x002B;
const WM_SETFONT: u32 = 0x0030;
const WM_NCHITTEST: u32 = 0x0084;
const WM_KEYDOWN: u32 = 0x0100;
const WM_COMMAND: u32 = 0x0111;
const WM_TIMER: u32 = 0x0113;
const WM_CTLCOLOREDIT: u32 = 0x0133;
const WM_DPICHANGED: u32 = 0x02E0;
const WM_APP_CMD: u32 = 0x8000 + 1;
const EM_SETSEL: u32 = 0x00B1;
const EM_LIMITTEXT: u32 = 0x00C5;
const VK_RETURN: usize = 0x0D;
const VK_ESCAPE: usize = 0x1B;
const HTCLIENT: isize = 1;
const HTCAPTION: isize = 2;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;
const ODS_SELECTED: u32 = 0x0001;
const DT_CENTER: u32 = 0x0001;
const DT_VCENTER: u32 = 0x0004;
const DT_SINGLELINE: u32 = 0x0020;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const DWMWA_WINDOW_CORNER_PREFERENCE: i32 = 33;
const DWMWCP_ROUND: u32 = 2;
const MONITOR_DEFAULTTONEAREST: u32 = 2;

const ID_PROMPT: usize = 101;
const ID_COUNT: usize = 102;
const ID_GENERATE: usize = 103;
const ID_CLOSE: usize = 104;
const TIMER_WATCH: usize = 1;
const WH_MOUSE_LL: i32 = 14;
const WM_MOUSEMOVE: usize = 0x0200;
const WM_LBUTTONDOWN: usize = 0x0201;
const WM_LBUTTONUP: usize = 0x0202;
/// a drag this recent is the one that made the selection the panel reports
const DRAG_FRESH: Duration = Duration::from_millis(2500);
/// gap between the selection and the bar, as Photoshop's task bar leaves
const GAP_SELECTION: i32 = 14;

// ── colours: the panel's tokens (--c-bg, --c-field over it, --c-line, --c-text, --c-text-2, accent) ──
const fn rgb(r: u32, g: u32, b: u32) -> COLORREF { r | (g << 8) | (b << 16) }
const C_BG: COLORREF = rgb(0x32, 0x32, 0x32);
const C_FIELD: COLORREF = rgb(0x23, 0x23, 0x23);
const C_LINE: COLORREF = rgb(0x5b, 0x5b, 0x5b);
const C_TEXT: COLORREF = rgb(0xec, 0xec, 0xec);
const C_MUTED: COLORREF = rgb(0xb9, 0xbd, 0xc1);
const C_ACCENT: COLORREF = rgb(0x3f, 0xb5, 0x9f);
const C_ACCENT_HI: COLORREF = rgb(0x5f, 0xcb, 0xb6);
const C_ACCENT_INK: COLORREF = rgb(0x07, 0x24, 0x20);

// ── layout at 96 DPI: [ prompt 220 ] [ count 30 ] [ 生成 56 ] [ × 20 ], 8px padding, 24px tall ──
const PAD: i32 = 8;
const GAP: i32 = 6;
const H_FIELD: i32 = 24;
const W_PROMPT: i32 = 220;
const W_COUNT: i32 = 30;
const W_GENERATE: i32 = 56;
const W_CLOSE: i32 = 20;

struct State {
    hwnd: HWND,
    prompt: HWND,
    count: HWND,
    generate: HWND,
    close: HWND,
    font: HFONT,
    bold: HFONT,
    dpi: u32,
    width: i32,
    height: i32,
    visible: bool,
    /// the window that was in front when the bar appeared (Photoshop): gets the focus back
    previous: HWND,
    bg: HBRUSH,
    field: HBRUSH,
    line: HBRUSH,
    accent: HBRUSH,
    accent_hi: HBRUSH,
    /// the left button is down on Photoshop: the area the pointer has covered so far
    dragging: bool,
    drag: RECT,
    /// the last finished drag and when it ended
    dragged: RECT,
    released: Option<Instant>,
    /// where the bar is on screen while it's shown
    bar: RECT,
}

static mut STATE: State = State {
    hwnd: null_mut(), prompt: null_mut(), count: null_mut(), generate: null_mut(), close: null_mut(),
    font: null_mut(), bold: null_mut(), dpi: 0, width: 0, height: 0, visible: false, previous: null_mut(),
    bg: null_mut(), field: null_mut(), line: null_mut(), accent: null_mut(), accent_hi: null_mut(),
    dragging: false, drag: RECT { left: 0, top: 0, right: 0, bottom: 0 },
    dragged: RECT { left: 0, top: 0, right: 0, bottom: 0 }, released: None,
    bar: RECT { left: 0, top: 0, right: 0, bottom: 0 },
};

/// Only touched on the window thread.
fn st() -> &'static mut State {
    unsafe { &mut *addr_of_mut!(STATE) }
}

static MAIN: AtomicIsize = AtomicIsize::new(0);
static INBOX: Mutex<VecDeque<Command>> = Mutex::new(VecDeque::new());

/// Called on the server thread: hand the command to the window thread.
fn on_command(c: Command) {
    if let Ok(mut q) = INBOX.lock() { q.push_back(c); }
    let hwnd = MAIN.load(Ordering::SeqCst) as HWND;
    if !hwnd.is_null() { unsafe { PostMessageW(hwnd, WM_APP_CMD, 0, 0); } }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn scale(v: i32) -> i32 {
    v * st().dpi as i32 / 96
}

pub fn run() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        // a second copy finds the port taken and quits
        if server::start(on_command).is_err() { return; }

        let hinst = GetModuleHandleW(null());
        let class = wide("WavePlugOverlay");
        let wc = WNDCLASSW {
            style: 0x0001 | 0x0002, // CS_VREDRAW | CS_HREDRAW
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), 32512usize as *const u16), // IDC_ARROW
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);

        let s = st();
        s.bg = CreateSolidBrush(C_BG);
        s.field = CreateSolidBrush(C_FIELD);
        s.line = CreateSolidBrush(C_LINE);
        s.accent = CreateSolidBrush(C_ACCENT);
        s.accent_hi = CreateSolidBrush(C_ACCENT_HI);

        let title = wide("WavePlug");
        s.hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, class.as_ptr(), title.as_ptr(), WS_POPUP,
            0, 0, 10, 10, null_mut(), null_mut(), hinst, null());
        let child = |cls: &str, style: u32, id: usize| -> HWND {
            let c = wide(cls);
            let empty = wide("");
            CreateWindowExW(0, c.as_ptr(), empty.as_ptr(), WS_CHILD | WS_VISIBLE | style,
                0, 0, 10, 10, st().hwnd, id as _, hinst, null())
        };
        s.prompt = child("EDIT", WS_TABSTOP | ES_AUTOHSCROLL, ID_PROMPT);
        s.count = child("EDIT", WS_TABSTOP | ES_NUMBER | ES_CENTER, ID_COUNT);
        s.generate = child("BUTTON", BS_OWNERDRAW, ID_GENERATE);
        s.close = child("BUTTON", BS_OWNERDRAW, ID_CLOSE);
        SendMessageW(s.count, EM_LIMITTEXT, 1, 0);
        let round = DWMWCP_ROUND;
        DwmSetWindowAttribute(s.hwnd, DWMWA_WINDOW_CORNER_PREFERENCE as u32, &round as *const u32 as *const c_void, 4);

        layout(96);
        MAIN.store(s.hwnd as isize, Ordering::SeqCst);
        SetTimer(s.hwnd, TIMER_WATCH, 250, None);
        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), hinst, 0);

        let mut msg: MSG = zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            // Enter submits and Esc closes from either text box (an IME composition sends
            // VK_PROCESSKEY instead, so confirming a Chinese word with Enter doesn't submit)
            if msg.message == WM_KEYDOWN && (msg.hwnd == st().prompt || msg.hwnd == st().count) {
                if msg.wParam == VK_RETURN { submit(); continue; }
                if msg.wParam == VK_ESCAPE { hide(true); continue; }
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Rebuilds the fonts and places the children for `dpi`.
fn layout(dpi: u32) {
    let s = st();
    if s.dpi == dpi && !s.font.is_null() { return; }
    s.dpi = dpi;
    unsafe {
        if !s.font.is_null() { DeleteObject(s.font as _); }
        if !s.bold.is_null() { DeleteObject(s.bold as _); }
        let face = wide("Microsoft YaHei UI");
        let px = -scale(12);
        s.font = CreateFontW(px, 0, 0, 0, 400, 0, 0, 0, 1 as _, 0 as _, 0 as _, 5 as _, 0 as _, face.as_ptr());
        s.bold = CreateFontW(px, 0, 0, 0, 700, 0, 0, 0, 1 as _, 0 as _, 0 as _, 5 as _, 0 as _, face.as_ptr());
        for h in [s.prompt, s.count, s.generate, s.close] { SendMessageW(h, WM_SETFONT, s.font as usize, 1); }
        SendMessageW(s.generate, WM_SETFONT, s.bold as usize, 1);

        let [p, c, g, x] = boxes();
        // the text boxes sit borderless inside their painted field boxes
        let line = scale(16);
        let inset = |r: RECT, side: i32| (r.left + side, r.top + (r.bottom - r.top - line) / 2, r.right - r.left - 2 * side, line);
        let (a, b, w, h) = inset(p, scale(6));
        MoveWindow(s.prompt, a, b, w, h, 1);
        let (a, b, w, h) = inset(c, scale(2));
        MoveWindow(s.count, a, b, w, h, 1);
        MoveWindow(s.generate, g.left, g.top, g.right - g.left, g.bottom - g.top, 1);
        MoveWindow(s.close, x.left, x.top, x.right - x.left, x.bottom - x.top, 1);
        s.width = x.right + scale(PAD);
        s.height = scale(PAD + H_FIELD + PAD);
    }
}

/// prompt box, count box, 生成, × — in client coordinates at the current DPI
fn boxes() -> [RECT; 4] {
    let top = scale(PAD);
    let bottom = scale(PAD + H_FIELD);
    let mut x = scale(PAD);
    let mut next = |w: i32, gap: i32| { let r = RECT { left: x, top, right: x + scale(w), bottom }; x = r.right + scale(gap); r };
    [next(W_PROMPT, GAP), next(W_COUNT, GAP), next(W_GENERATE, 4), next(W_CLOSE, 0)]
}

fn show(prompt: &str, count: u32, anchor: Option<Anchor>) {
    let s = st();
    unsafe {
        SetWindowTextW(s.prompt, wide(prompt).as_ptr());
        SetWindowTextW(s.count, wide(&clamp_count(count).to_string()).as_ptr());
        let fg = GetForegroundWindow();
        if fg != s.hwnd { s.previous = fg; }

        let mut pt: POINT = zeroed();
        GetCursorPos(&mut pt);
        let from_panel = anchor.map(|a| RECT { left: a.left.round() as i32, top: a.top.round() as i32, right: a.right.round() as i32, bottom: a.bottom.round() as i32 });
        let sel = from_panel.or_else(fresh_drag);
        let at = sel.map(|r| POINT { x: (r.left + r.right) / 2, y: r.bottom }).unwrap_or(pt);
        let mon = MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST);
        let (mut dx, mut dy) = (96u32, 96u32);
        if GetDpiForMonitor(mon, 0, &mut dx, &mut dy) == 0 { layout(dx); }
        let mut mi: MONITORINFO = zeroed();
        mi.cbSize = size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(mon, &mut mi);
        let work = mi.rcWork;

        let (w, h) = (s.width, s.height);
        let (mut x, mut y) = match sel {
            // centred under the selection; above it when there's no room below, inside it when neither
            Some(r) => {
                let gap = scale(GAP_SELECTION);
                let below = r.bottom + gap;
                let above = r.top - gap - h;
                let y = if below + h <= work.bottom { below } else if above >= work.top { above } else { r.bottom - gap - h };
                ((r.left + r.right) / 2 - w / 2, y)
            }
            // below-right of the pointer; flipped above it near the bottom
            None => {
                let y = if pt.y + scale(18) + h > work.bottom { pt.y - h - scale(10) } else { pt.y + scale(18) };
                (pt.x + scale(14), y)
            }
        };
        if x + w > work.right { x = work.right - w; }
        if x < work.left { x = work.left; }
        if y + h > work.bottom { y = work.bottom - h; }
        if y < work.top { y = work.top; }
        SetWindowPos(s.hwnd, -1isize as HWND, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW); // HWND_TOPMOST
        s.bar = RECT { left: x, top: y, right: x + w, bottom: y + h };
        s.visible = true;
    }
}

fn hide(give_back_focus: bool) {
    let s = st();
    if !s.visible { return; }
    s.visible = false;
    unsafe {
        ShowWindow(s.hwnd, 0); // SW_HIDE
        if give_back_focus && !s.previous.is_null() && IsWindow(s.previous) != 0 {
            SetForegroundWindow(s.previous);
        }
    }
}

fn text_of(h: HWND) -> String {
    unsafe {
        let n = GetWindowTextLengthW(h);
        let mut buf = vec![0u16; n as usize + 1];
        let got = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }
}

fn submit() {
    let s = st();
    let prompt = text_of(s.prompt).trim().to_string();
    let count = clamp_count(text_of(s.count).trim().parse().unwrap_or(1));
    server::send(&Event::Generate { prompt, count });
    hide(true);
}

/// The last drag on Photoshop, if it ended just now and covered more than a click.
fn fresh_drag() -> Option<RECT> {
    let s = st();
    let r = s.dragged;
    let recent = s.released.map_or(false, |t| t.elapsed() <= DRAG_FRESH);
    (recent && r.right - r.left >= 6 && r.bottom - r.top >= 6).then_some(r)
}

/// MSLLHOOKSTRUCT, laid out here like DrawItem.
#[repr(C)]
struct MouseLL {
    pt: POINT,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra: usize,
}

/// Low-level mouse hook (runs on this thread's message loop): follows each left-button drag that
/// starts on Photoshop with the exact points Windows reports. Kept short — Windows drops slow hooks.
unsafe extern "system" fn mouse_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 {
        let s = st();
        let pt = (*(lp as *const MouseLL)).pt;
        match wp {
            WM_LBUTTONDOWN => {
                let b = s.bar;
                let on_bar = s.visible && pt.x >= b.left && pt.x < b.right && pt.y >= b.top && pt.y < b.bottom;
                let fg = GetForegroundWindow();
                s.dragging = !on_bar && fg != s.hwnd && is_photoshop(fg);
                s.drag = RECT { left: pt.x, top: pt.y, right: pt.x, bottom: pt.y };
                // a press on Photoshop starts the next selection (or drops this one): out of the way
                if s.dragging && s.visible { on_command(Command::Hide); }
            }
            WM_MOUSEMOVE | WM_LBUTTONUP if s.dragging => {
                s.drag.left = s.drag.left.min(pt.x);
                s.drag.top = s.drag.top.min(pt.y);
                s.drag.right = s.drag.right.max(pt.x);
                s.drag.bottom = s.drag.bottom.max(pt.y);
                if wp == WM_LBUTTONUP {
                    s.dragging = false;
                    s.dragged = s.drag;
                    s.released = Some(Instant::now());
                }
            }
            _ => {}
        }
    }
    CallNextHookEx(null_mut(), code, wp, lp)
}

/// True for Photoshop's windows and this program's own (the IME candidate list is ours too).
fn keeps_bar(fg: HWND) -> bool {
    if fg.is_null() { return false; }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(fg, &mut pid); }
    pid == unsafe { GetCurrentProcessId() } || is_photoshop(fg)
}

fn is_photoshop(fg: HWND) -> bool {
    if fg.is_null() { return false; }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if proc.is_null() { return false; }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(proc, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(proc);
        ok && String::from_utf16_lossy(&buf[..len as usize]).to_lowercase().ends_with("photoshop.exe")
    }
}

unsafe fn paint(hwnd: HWND) {
    let s = st();
    let mut ps: PAINTSTRUCT = zeroed();
    let hdc = BeginPaint(hwnd, &mut ps);
    let all = RECT { left: 0, top: 0, right: s.width, bottom: s.height };
    FillRect(hdc, &all, s.bg);
    FrameRect(hdc, &all, s.line);
    let [p, c, _, _] = boxes();
    for r in [p, c] {
        FillRect(hdc, &r, s.field);
        FrameRect(hdc, &r, s.line);
    }
    EndPaint(hwnd, &ps);
}

/// DRAWITEMSTRUCT, laid out here so it doesn't depend on which windows-sys module has it.
#[repr(C)]
struct DrawItem {
    ctl_type: u32,
    ctl_id: u32,
    item_id: u32,
    item_action: u32,
    item_state: u32,
    hwnd_item: HWND,
    hdc: HDC,
    rc: RECT,
    item_data: usize,
}

unsafe fn draw_button(d: &DrawItem) {
    let s = st();
    let pressed = d.item_state & ODS_SELECTED != 0;
    let mut rc = d.rc;
    let (label, fill, ink, font) = if d.ctl_id as usize == ID_GENERATE {
        ("生成", if pressed { s.accent_hi } else { s.accent }, C_ACCENT_INK, s.bold)
    } else {
        ("×", s.bg, if pressed { C_TEXT } else { C_MUTED }, s.font)
    };
    FillRect(d.hdc, &rc, fill);
    SetBkMode(d.hdc, 1 as _); // TRANSPARENT
    SetTextColor(d.hdc, ink);
    let old = SelectObject(d.hdc, font as _);
    let text: Vec<u16> = label.encode_utf16().collect();
    DrawTextW(d.hdc, text.as_ptr() as _, text.len() as i32, &mut rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(d.hdc, old);
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_APP_CMD => {
            let cmds: Vec<Command> = INBOX.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
            for c in cmds {
                match c {
                    Command::Show { prompt, count, anchor } => show(&prompt, count, anchor),
                    Command::Hide => hide(false),
                    Command::Hello => {}
                }
            }
            0
        }
        WM_TIMER if wp == TIMER_WATCH => {
            // another program came to the front: the bar would float over it
            if st().visible && !keeps_bar(GetForegroundWindow()) { hide(false); }
            0
        }
        WM_ACTIVATE => {
            // clicked into: select the prompt so typing replaces it
            if wp & 0xFFFF != 0 { SendMessageW(st().prompt, EM_SETSEL, 0, -1); }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_COMMAND => {
            match wp & 0xFFFF {
                ID_GENERATE => submit(),
                ID_CLOSE => hide(true),
                _ => {}
            }
            0
        }
        WM_DRAWITEM => { draw_button(&*(lp as *const DrawItem)); 1 }
        WM_CTLCOLOREDIT => {
            let hdc = wp as HDC;
            SetTextColor(hdc, C_TEXT);
            SetBkColor(hdc, C_FIELD);
            st().field as LRESULT
        }
        WM_PAINT => { paint(hwnd); 0 }
        WM_ERASEBKGND => 1,
        // the bar's own background (not its boxes and buttons) drags it
        WM_NCHITTEST => {
            let hit = DefWindowProcW(hwnd, msg, wp, lp);
            if hit == HTCLIENT { HTCAPTION } else { hit }
        }
        WM_DPICHANGED => {
            layout(((wp >> 16) & 0xFFFF) as u32);
            let s = st();
            SetWindowPos(hwnd, null_mut(), 0, 0, s.width, s.height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            0
        }
        WM_DESTROY => 0,
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}
