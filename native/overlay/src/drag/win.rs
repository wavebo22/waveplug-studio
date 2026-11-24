//! The drag engine's thread (Windows): one click-through layered window for the card, a
//! low-level mouse hook while a drag runs, a 30 ms watch timer. Modelled on frame.rs: plain
//! Win32, no egui, no GPU; callers only queue a command and post a message.
//!
//! - The card bitmap is built (card.rs shapes + GDI text) and handed to UpdateLayeredWindow only
//!   when what it says changes, or the cursor reaches a monitor with another DPI.
//! - Each WM_MOUSEMOVE from the hook moves the window (SetWindowPos, no redraw) and hit-tests the
//!   native targets; WM_LBUTTONUP from the hook is the release. Nothing else runs per move.
//! - The watch timer: Escape, Photoshop losing the foreground (card hidden meanwhile), and a
//!   release the hook didn't report (button found up).
//! - If the hook can't be installed, a 4 ms timer polls the cursor instead (logged).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};

use image::RgbaImage;
use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GdiFlush,
    GetDC, GetMonitorInfoW, GetTextExtentPoint32W, MonitorFromPoint, MONITORINFO, ReleaseDC, SelectObject, SetBkMode, SetTextColor,
    AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, CLEARTYPE_QUALITY,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT,
    DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FW_BOLD, FW_NORMAL, HFONT, MONITOR_DEFAULTTONEAREST,
    OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, GetClassNameW, GetWindowRect, WindowFromPoint, DefWindowProcW, DispatchMessageW, GetCursorPos, GetForegroundWindow,
    GetMessageW, GetWindowThreadProcessId, KillTimer, PostMessageW, PostThreadMessageW, RegisterClassW,
    SetTimer, SetWindowPos, SetWindowsHookExW, ShowWindow, ShowWindowAsync, WM_KEYDOWN, WM_KEYUP,
    UnhookWindowsHookEx, UpdateLayeredWindow, HHOOK, HWND_TOPMOST, MSG, MSLLHOOKSTRUCT, SWP_NOACTIVATE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, ULW_ALPHA, WH_MOUSE_LL,
    WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_NCHITTEST, WM_TIMER, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use super::card;
use super::illustrator;
use super::ole;
use super::session::{release_decision, Ending, Out, Release, Session, TRASH};
use super::targets::{self, Target, REGISTRY};
use super::transfer;
use super::trash;
use super::{emit, set_hover, Cmd, Event, ACTIVE};
use crate::log;

/// The card window's title (unique, for finding it in tools).
pub const TITLE: &str = "WavePlug 图层拖拽";
/// The 外置删除区 window's title.
pub const TRASH_TITLE: &str = "WavePlug 删除区";

const WM_APP_CMD: u32 = 0x8000 + 0x61;
const WM_APP_UP: u32 = 0x8000 + 0x62;
const WM_APP_OLE: u32 = 0x8000 + 0x63;
const WM_APP_NUDGE: u32 = 0x8000 + 0x64;
const MA_NOACTIVATE: LRESULT = 3;
const HTTRANSPARENT: LRESULT = -1;
const WATCH_TIMER: usize = 1;
const POLL_TIMER: usize = 2;
const VK_LBUTTON: i32 = 0x01;
const VK_ESCAPE: i32 = 0x1B;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12;

static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
static QUEUE: Mutex<VecDeque<Cmd>> = Mutex::new(VecDeque::new());
static START: Once = Once::new();

pub fn send(cmd: Cmd) {
    if let Ok(mut q) = QUEUE.lock() {
        q.push_back(cmd);
    }
    START.call_once(|| {
        std::thread::spawn(run);
    });
    let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
    if !h.is_null() {
        unsafe { PostMessageW(h, WM_APP_CMD, 0, 0) };
    }
    // before the window exists, `run` drains the queue once it does
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn colorref(c: card::Rgb) -> COLORREF {
    c.0 as u32 | (c.1 as u32) << 8 | (c.2 as u32) << 16
}

fn scale_at(x: i32, y: i32) -> f32 {
    let (mut dx, mut dy) = (96u32, 96u32);
    unsafe { GetDpiForMonitor(MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST), 0, &mut dx, &mut dy) };
    dx as f32 / 96.0
}

fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

fn key_down(vk: i32) -> bool {
    unsafe { GetAsyncKeyState(vk) < 0 }
}

/// What the card shows apart from the action: fixed for one drag.
struct Content {
    name: String,
    layers: usize,
    thumb: Option<RgbaImage>,
}

/// A drag to another program: the plugin's export, then our cached copies.
struct Transfer {
    id: String,
    count: usize,
    files: Option<Vec<PathBuf>>,
    /// layers the plugin has exported so far (external-drag-progress)
    done: usize,
    /// WM_APP_OLE posted: don't post again
    requested: bool,
    /// the plugin's files with `path` set to our copies (for the combined SVG)
    items: Vec<transfer::SourceFile>,
    /// the editable combined SVG, when some layer has vectors
    svg: Option<PathBuf>,
}

/// The 外置删除区's window (drag/trash.rs): click-through like the card, placed once per drag.
struct TrashWin {
    hwnd: HWND,
    /// on screen for this drag
    on: bool,
    enabled: bool,
    centre: (i32, i32),
    scale: f32,
    look: Option<trash::Look>,
}

struct Engine {
    hwnd: HWND,
    trash: TrashWin,
    /// the cursor when the drag began: where the panel (the grabbed row) is
    began_at: (i32, i32),
    transfer: Option<Transfer>,
    /// DoDragDrop is running (its modal loop dispatches our messages)
    ole_active: bool,
    /// the OLE drag ended on one of our own targets (handled here, OLE cancelled)
    ole_native: bool,
    ole_started: Instant,
    /// the plugin's End / Cancel during the OLE drag, handled once it returns
    deferred: Vec<Cmd>,
    /// the last top-level window classified: whether it is another program's, and that program's
    /// name as people call it (transfer::app_label)
    foreign_cache: (isize, bool, String),
    /// where the system drag was let go (its program's name), for the plugin's result message
    ole_target: String,
    /// Photoshop's UI thread, taken when the drag began: OLE shares its input state, even after
    /// Alt+Tab has moved the foreground to another program
    ps_thread: u32,
    /// system drags Windows itself cancelled (Alt+Tab) and that were started again
    resumes: u32,
    /// the last top-level window asked about, and Illustrator's usable COM names if it is one
    ai_cache: (isize, Option<Vec<String>>),
    /// released over Illustrator: imported by script once OLE has returned
    ai_job: Option<illustrator::Job>,
    /// Ctrl / Alt as the card last showed them
    mode: transfer::DropMode,
    session: Option<Session>,
    content: Content,
    /// what the card was last drawn with, and at which scale
    drawn: Option<(String, String, f32)>,
    hook: HHOOK,
    polling: bool,
    /// the card is allowed on screen (Photoshop has the foreground)
    shown: bool,
    last: (i32, i32),
    started: Instant,
    /// this drag already asked the plugin to export (ExternalWanted): once per drag
    export_wanted: bool,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

impl Engine {
    fn hit(&self, x: i32, y: i32) -> Option<super::targets::Target> {
        REGISTRY.lock().ok().and_then(|r| r.hit(x, y).cloned())
    }

    fn start(&mut self, layers: Vec<crate::panel::DraggedLayer>, total: usize) {
        if self.session.is_some() {
            let out = self.session.as_mut().map(|s| s.cancel()).unwrap_or_default();
            self.apply(out);
            self.teardown();
        }
        let thumb = layers.first().and_then(|l| l.thumb.as_deref()).and_then(|url| match card::decode_thumb(url) {
            Ok(img) => Some(img),
            Err(e) => {
                log::line(format!("drag card thumbnail: {e}"));
                None
            }
        });
        let name = if total > 1 {
            format!("{total} 个图层")
        } else {
            layers.first().map(|l| l.name.clone()).unwrap_or_else(|| "图层".into())
        };
        self.content = Content { name, layers: layers.len().max(1), thumb };
        self.drop_transfer();
        self.foreign_cache = (0, false, String::new());
        self.drawn = None;
        self.started = Instant::now();
        self.export_wanted = false;
        // shown for the whole drag, whoever has the foreground (Alt+Tab to the target is fine)
        self.shown = true;
        self.ps_thread = crate::win::photoshop_thread_in_front();
        self.resumes = 0;
        let mut s = Session::new();
        let mut out = s.begin();
        self.session = Some(s);
        ACTIVE.store(true, Ordering::SeqCst);
        unsafe {
            self.hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), GetModuleHandleW(null()), 0);
            self.polling = self.hook.is_null();
            if self.polling {
                log::line("drag hook unavailable: polling the cursor");
                SetTimer(self.hwnd, POLL_TIMER, 4, None);
            }
            SetTimer(self.hwnd, WATCH_TIMER, 30, None);
        }
        let (x, y) = cursor();
        self.last = (x, y);
        self.began_at = (x, y);
        out.extend(self.session.as_mut().map(|s| s.moved(x, y, None)).unwrap_or_default());
        self.apply(out);
    }

    fn moved(&mut self, x: i32, y: i32) {
        if self.session.is_none() || (x, y) == self.last {
            return;
        }
        let t0 = Instant::now();
        self.last = (x, y);
        let hit = self.hit(x, y);
        let out = self.session.as_mut().map(|s| s.moved(x, y, hit.as_ref())).unwrap_or_default();
        self.apply(out);
        self.check_external(x, y, hit.is_some());
        if let Some(s) = &mut self.session {
            s.stats.max_handler_us = s.stats.max_handler_us.max(t0.elapsed().as_micros());
        }
    }

    /// Over another program's window: show that the files are being prepared, or, once they are
    /// ready, start the system drag (posted: never from inside the hook).
    fn check_external(&mut self, x: i32, y: i32, over_target: bool) {
        if self.ole_active || self.session.is_none() {
            return;
        }
        // Over another program and the plugin hasn't started exporting: it only does so when its
        // panel sees the pointer leave, and a quick throw out of Photoshop gives it no such move
        // (the card then said 正在准备 for good until the drag went back into the panel). Ask once.
        if self.transfer.is_none() {
            if !self.export_wanted && !over_target && self.foreign(x, y) {
                self.export_wanted = true;
                log::line(format!("external drag: over {} with nothing prepared, asking the plugin", self.foreign_cache.2));
                emit(Event::ExternalWanted);
            }
            return;
        }
        if self.transfer.as_ref().map_or(true, |t| t.requested) {
            return;
        }
        let foreign = !over_target && self.foreign(x, y);
        let label = self.foreign_cache.2.clone();
        let t = self.transfer.as_mut().unwrap();
        let verdict = if !foreign {
            None
        } else if t.files.is_some() {
            t.requested = true;
            unsafe { PostMessageW(self.hwnd, WM_APP_OLE, 0, 0) };
            Some((format!("复制到 {label}"), "copy".to_string()))
        } else {
            Some((transfer::preparing_text(t.done, t.count), "invalid".to_string()))
        };
        let out = self.session.as_mut().map(|s| s.set_external(verdict)).unwrap_or_default();
        self.apply(out);
    }

    fn foreign(&mut self, x: i32, y: i32) -> bool {
        let root = crate::win::root_at(x, y);
        if root == self.hwnd as isize {
            // the click-through card should never be hit; if it is, no system drag can start
            static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !LOGGED.swap(true, Ordering::SeqCst) {
                log::line("drag card was hit by WindowFromPoint: external drags cannot start");
            }
            return false;
        }
        self.classify(root);
        self.foreign_cache.1
    }

    fn classify(&mut self, root: isize) {
        if root != self.foreign_cache.0 {
            let foreign = crate::win::is_foreign(root);
            let exe = crate::win::describe(root);
            // evidence for "over WeChat but it can't be dropped": every window change during a
            // drag to another program, with what the window is and who has the foreground
            if self.ole_active || self.transfer.as_ref().is_some_and(|t| t.files.is_some()) {
                log::line(format!("drag over {exe} foreign={foreign} ole={} {}", self.ole_active, crate::win::window_info(root)));
            }
            self.foreign_cache = (root, foreign, transfer::app_label(&exe));
        }
    }

    /// The program under (x, y), by name (classified with `foreign`).
    fn label_at(&mut self, x: i32, y: i32) -> String {
        let root = crate::win::root_at(x, y);
        self.classify(root);
        self.foreign_cache.2.clone()
    }

    /// The transfer's cached files go unless they were dropped somewhere.
    fn drop_transfer(&mut self) {
        if let Some(t) = self.transfer.take() {
            if let Some(root) = transfer::cache_root() {
                transfer::remove_session(&root, &t.id);
            }
        }
    }

    /// WM_APP_OLE: the files to drag, if a system drag may start now.
    fn ole_begin(&mut self) -> Option<(Vec<PathBuf>, String, u32)> {
        let (x, y) = cursor();
        let ok = self.session.is_some() && key_down(VK_LBUTTON) && self.hit(x, y).is_none() && self.foreign(x, y);
        let t = self.transfer.as_mut()?;
        if !ok || t.files.is_none() {
            t.requested = false; // try again on the next move out there
            return None;
        }
        self.ole_active = true;
        self.ole_native = false;
        self.ole_target.clear();
        self.ole_started = Instant::now();
        self.ai_job = None;
        let over = crate::win::describe(crate::win::root_at(x, y));
        let mut files = t.files.clone()?;
        // Figma imports an SVG as vectors: the combined one instead of the PNGs
        if transfer::profile(&over) == transfer::Profile::Figma {
            if let Some(svg) = t.svg.clone() {
                files = vec![svg];
            }
        }
        log::line(format!("ole drag start files={} over={over}", files.len()));
        Some((files, t.id.clone(), self.ps_thread))
    }

    /// Illustrator's usable COM names if `root` is a scriptable Illustrator (cached per window).
    fn illustrator_at(&mut self, root: isize) -> Option<Vec<String>> {
        if root != self.ai_cache.0 {
            let exe = crate::win::describe(root);
            let names = if transfer::profile(&exe) == transfer::Profile::Illustrator {
                let path = crate::win::exe_path(root as HWND).unwrap_or_default();
                let names = illustrator::available(transfer::illustrator_progids(&path));
                log::line(format!("drag over Illustrator path={path} scriptable={:?}", names));
                names
            } else {
                None
            };
            self.ai_cache = (root, names);
        }
        self.ai_cache.1.clone()
    }

    fn has_vectors(&self) -> bool {
        self.transfer.as_ref().is_some_and(|t| super::compose::files_have_vectors(&t.items))
    }

    /// QueryContinueDrag after the release: where it was let go decides.
    fn ole_release(&mut self, x: i32, y: i32) -> i32 {
        let hit = self.hit(x, y);
        let own = !self.foreign(x, y);
        let decision = release_decision(hit.as_ref(), own);
        let root = crate::win::root_at(x, y);
        self.ole_target = self.label_at(x, y);
        log::line(format!(
            "ole release at {x},{y} over={} target={} decision={decision:?} last_effect={} effect_changes={}",
            crate::win::describe(root),
            hit.as_ref().map_or("none".to_string(), |t| format!("{}:{}", t.surface, t.id)),
            OLE_LAST_EFFECT.load(Ordering::SeqCst),
            OLE_EFFECT_CHANGES.load(Ordering::SeqCst),
        ));
        // a release judged to be over Photoshop: what is actually stacked at that point
        if decision == Release::Cancel {
            log::line(format!("ole release cancelled over own/Photoshop window: {}", crate::win::stack_at(x, y)));
        }
        match decision {
            Release::Native => {
                let out = self.session.as_mut().map(|s| s.released(x, y, hit.as_ref())).unwrap_or_default();
                self.apply(out);
                self.ole_native = true;
                ole::DRAGDROP_S_CANCEL
            }
            Release::Cancel => ole::DRAGDROP_S_CANCEL,
            Release::Drop => {
                let mode = current_mode();
                match self.illustrator_at(root) {
                    // imported by script once OLE returns (ole_end): embedded, editable
                    Some(progids) if mode != transfer::DropMode::Plain => {
                        let (fx, fy) = canvas_fraction(x, y, root);
                        log::line(format!("ole release over Illustrator: script import mode={mode:?} at {fx:.3},{fy:.3}"));
                        self.ai_job = Some(illustrator::Job {
                            session_id: String::new(),
                            items: Vec::new(),
                            editable: None,
                            raster: mode == transfer::DropMode::Images,
                            progids,
                            fx,
                            fy,
                            count: 0,
                        });
                        ole::DRAGDROP_S_CANCEL
                    }
                    _ => ole::DRAGDROP_S_DROP,
                }
            }
        }
    }

    /// GiveFeedback: what the target under the cursor would do, on the card.
    fn ole_feedback(&mut self, effect: u32) {
        let (x, y) = cursor();
        let label = self.label_at(x, y);
        let accepts = effect & transfer::DROPEFFECT_COPY != 0;
        let root = crate::win::root_at(x, y);
        let mode = current_mode();
        self.mode = mode;
        let verdict = if !self.foreign(x, y) {
            ("松开取消".to_string(), "invalid")
        } else if self.illustrator_at(root).is_some() {
            let invalid = mode == transfer::DropMode::Plain && !accepts;
            (transfer::illustrator_text(mode, self.has_vectors(), accepts), if invalid { "invalid" } else { "copy" })
        } else if accepts {
            (format!("复制到 {label}"), "copy")
        } else {
            (format!("{label} 不接收"), "invalid")
        };
        let out = self.session.as_mut().map(|s| s.set_external(Some((verdict.0, verdict.1.into())))).unwrap_or_default();
        self.apply(out);
    }

    fn ole_end(&mut self, r: ole::Result, decided: bool) {
        // Windows cancels a system drag when the foreground changes (Alt+Tab). If we didn't decide
        // that and the button is still down, the drag goes on: it starts again over a target.
        if r.hr == ole::DRAGDROP_S_CANCEL && !decided && !self.ole_native && key_down(VK_LBUTTON)
            && self.session.is_some() && self.resumes < 20
        {
            self.resumes += 1;
            log::line(format!(
                "ole drag interrupted by Windows (window switch?) after {} ms: continuing, resume {}",
                self.ole_started.elapsed().as_millis(), self.resumes
            ));
            self.ole_active = false;
            if let Some(t) = self.transfer.as_mut() {
                t.requested = false;
            }
            let out = self.session.as_mut().map(|s| s.set_external(None)).unwrap_or_default();
            self.apply(out);
            for c in std::mem::take(&mut self.deferred) {
                self.command(c);
            }
            let (x, y) = cursor();
            let hit = self.hit(x, y);
            self.check_external(x, y, hit.is_some());
            return;
        }
        let job = self.ai_job.take();
        let status = if job.is_some() {
            "illustrator"
        } else if self.ole_native {
            "cancelled"
        } else {
            transfer::outcome(r.hr, r.effect)
        };
        log::line(format!(
            "ole drag status={status} hr=0x{:08x} effect={} feedback={} ms={}",
            r.hr as u32, r.effect, r.feedbacks, self.ole_started.elapsed().as_millis()
        ));
        if let Some(mut job) = job {
            // the import thread reports to the plugin and removes the session's files
            if let Some(t) = self.transfer.take() {
                job.count = t.files.as_ref().map_or(0, |f| f.len());
                job.session_id = t.id;
                job.items = t.items;
                job.editable = t.svg;
                illustrator::run(job);
            }
        } else if let Some(t) = self.transfer.take() {
            if status != "dropped" {
                if let Some(root) = transfer::cache_root() {
                    transfer::remove_session(&root, &t.id);
                }
            }
            let effect = if r.effect & transfer::DROPEFFECT_COPY != 0 { "copy" } else { "none" };
            let count = t.files.as_ref().map_or(0, |f| f.len());
            emit(Event::ExternalFinished { session_id: t.id, status, effect, target: std::mem::take(&mut self.ole_target), count });
        }
        self.ole_active = false;
        self.ole_native = false;
        // dropped files stay; the cache keeps to its budget
        super::sweep_cache();
        let out = self.session.as_mut().map(|s| s.external_ended()).unwrap_or_default();
        self.apply(out);
        self.end_if_over();
        for c in std::mem::take(&mut self.deferred) {
            self.command(c);
        }
    }

    fn released(&mut self, x: i32, y: i32) {
        if self.ole_active {
            return; // QueryContinueDrag decides this release
        }
        let hit = self.hit(x, y);
        let out = self.session.as_mut().map(|s| s.released(x, y, hit.as_ref())).unwrap_or_default();
        self.apply(out);
        self.end_if_over();
    }

    fn command(&mut self, cmd: Cmd) {
        if self.ole_active && matches!(cmd, Cmd::End | Cmd::Cancel | Cmd::PreviewStart { .. } | Cmd::TransferCancel { .. }) {
            self.deferred.push(cmd);
            return;
        }
        // Once the files are cached and the button is still down, the drag to another program is
        // ours: the plugin may lose its drag on a window switch (it never sees that release).
        let ours = self.transfer.as_ref().is_some_and(|t| t.files.is_some()) && key_down(VK_LBUTTON);
        if ours && matches!(cmd, Cmd::End | Cmd::Cancel | Cmd::TransferCancel { .. }) {
            log::line(format!("plugin ended its drag with the button down: the helper keeps the drag ({cmd:?})"));
            return;
        }
        match cmd {
            Cmd::TransferPrepare { session_id, count } => {
                if self.session.is_some() {
                    self.drop_transfer();
                    self.transfer = Some(Transfer { id: session_id, count, files: None, done: 0, requested: false, items: Vec::new(), svg: None });
                    let (x, y) = self.last;
                    self.check_external(x, y, self.hit(x, y).is_some());
                }
            }
            Cmd::TransferFiles { session_id, files, items, svg } => {
                match self.transfer.as_mut() {
                    Some(t) if t.id == session_id => {
                        t.files = Some(files);
                        t.items = items;
                        t.svg = svg;
                        let (x, y) = cursor();
                        self.check_external(x, y, self.hit(x, y).is_some());
                    }
                    // the drag that wanted them is gone
                    _ => {
                        if let Some(root) = transfer::cache_root() {
                            transfer::remove_session(&root, &session_id);
                        }
                    }
                }
            }
            Cmd::TransferProgress { session_id, done } => {
                if let Some(t) = self.transfer.as_mut().filter(|t| t.id == session_id && t.files.is_none()) {
                    t.done = done;
                    let (x, y) = cursor();
                    self.check_external(x, y, self.hit(x, y).is_some());
                }
            }
            Cmd::TransferCancel { session_id } => {
                if self.transfer.as_ref().is_some_and(|t| t.id == session_id) {
                    self.drop_transfer();
                    let out = self.session.as_mut().map(|s| s.set_external(None)).unwrap_or_default();
                    self.apply(out);
                }
            }
            Cmd::PreviewStart { layers, total } => self.start(layers, total),
            Cmd::Trash { view, enabled, action } => self.show_trash(view, enabled, action),
            Cmd::Verdict { action, tone } => {
                let out = self.session.as_mut().map(|s| s.plugin_verdict(action, tone)).unwrap_or_default();
                self.apply(out);
            }
            Cmd::Reference(r) => {
                if let Some(s) = &mut self.session {
                    s.attach_reference(r);
                }
                // the cursor may already be over a slot
                let (x, y) = cursor();
                let hit = self.hit(x, y);
                let out = self.session.as_mut().map(|s| s.moved(x, y, hit.as_ref())).unwrap_or_default();
                self.apply(out);
            }
            Cmd::End => {
                let (x, y) = cursor();
                let hit = self.hit(x, y);
                let down = key_down(VK_LBUTTON);
                let out = self.session.as_mut().map(|s| s.plugin_end(down, x, y, hit.as_ref())).unwrap_or_default();
                self.apply(out);
                self.end_if_over();
            }
            Cmd::Cancel => {
                let out = self.session.as_mut().map(|s| s.cancel()).unwrap_or_default();
                self.apply(out);
                self.end_if_over();
            }
        }
    }

    fn watch(&mut self) {
        // during a system drag OLE itself watches Escape and the release
        // Ctrl / Alt pressed or let go without a mouse move: the card says what a release does now
        if self.ole_active && current_mode() != self.mode {
            let effect = OLE_LAST_EFFECT.load(Ordering::SeqCst);
            self.ole_feedback(if effect == u32::MAX { 0 } else { effect });
        }
        if self.session.is_none() || self.ole_active {
            return;
        }
        if key_down(VK_ESCAPE) {
            let out = self.session.as_mut().map(|s| s.escape()).unwrap_or_default();
            self.apply(out);
            self.end_if_over();
            return;
        }
        if !key_down(VK_LBUTTON) {
            // the hook didn't report the release (or there is no hook): this is it
            let (x, y) = cursor();
            self.released(x, y);
            return;
        }
    }

    fn end_if_over(&mut self) {
        if self.session.as_ref().is_some_and(|s| s.ending().is_some()) {
            self.teardown();
        }
    }

    fn teardown(&mut self) {
        unsafe {
            if !self.hook.is_null() {
                UnhookWindowsHookEx(self.hook);
                self.hook = null_mut();
            }
            KillTimer(self.hwnd, WATCH_TIMER);
            KillTimer(self.hwnd, POLL_TIMER);
            ShowWindow(self.hwnd, SW_HIDE);
        }
        self.hide_trash();
        if let Some(s) = self.session.take() {
            let ending = match s.ending() {
                Some(Ending::Dropped) => "dropped",
                Some(Ending::Released) => "released",
                Some(Ending::Escape) => "escape",
                Some(Ending::Cancelled) | None => "cancelled",
            };
            log::line(format!(
                "drag session {ending} ms={} moves={} renders={} max_handler_us={} hook={}",
                self.started.elapsed().as_millis(),
                s.stats.moves,
                s.stats.renders,
                s.stats.max_handler_us,
                if self.polling { "fallback" } else { "ok" },
            ));
            emit(Event::Ended { ending });
        }
        self.drop_transfer();
        set_hover(None);
        ACTIVE.store(false, Ordering::SeqCst);
        self.polling = false;
    }

    fn apply(&mut self, out: Vec<Out>) {
        for o in out {
            match o {
                Out::Render { action, tone } => {
                    let (x, y) = self.last;
                    let scale = scale_at(x, y);
                    unsafe { self.render(&action, &tone, scale) };
                    self.drawn = Some((action, tone, scale));
                    self.place(x, y);
                }
                Out::Place { x, y } => self.place(x, y),
                Out::Hover(h) => {
                    if self.trash.on && self.trash.enabled {
                        let look = if h == Some((TRASH, 0)) { trash::Look::Hot } else { trash::Look::Idle };
                        unsafe { self.render_trash(look) };
                    }
                    set_hover(h);
                    emit(Event::Hover);
                }
                Out::Dropped { surface, target, reference } => emit(Event::Dropped { surface, target, reference }),
                Out::Hide => unsafe {
                    ShowWindow(self.hwnd, SW_HIDE);
                },
                Out::Finished => emit(Event::Finished),
            }
        }
    }

    /// Put the 外置删除区 up for this drag, next to where it began (trash::centre). Publishes its
    /// hit box as the TRASH target unless nothing dragged can be deleted.
    fn show_trash(&mut self, view: Option<(i32, i32, i32, i32)>, enabled: bool, action: String) {
        if self.trash.hwnd.is_null() || self.session.as_ref().map_or(true, |s| s.ending().is_some()) {
            return;
        }
        let at = self.began_at;
        let scale = scale_at(at.0, at.1);
        let centre = trash::centre(at, view, work_area(at.0, at.1), scale);
        self.trash.on = true;
        self.trash.enabled = enabled;
        self.trash.centre = centre;
        self.trash.scale = scale;
        self.trash.look = None;
        unsafe { self.render_trash(if enabled { trash::Look::Idle } else { trash::Look::Disabled }) };
        let (ox, oy) = trash::origin(centre, scale);
        unsafe {
            SetWindowPos(self.trash.hwnd, HWND_TOPMOST, ox, oy, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW);
        }
        let hit = trash::hit_rect(centre, scale);
        targets::publish(TRASH, if enabled { vec![Target { surface: TRASH, id: 0, rect: hit, action }] } else { Vec::new() });
        log::line(format!("trash shown at {},{} enabled={enabled} view={view:?} began={at:?}", centre.0, centre.1));
        // the cursor may already be over it
        let (x, y) = cursor();
        let hit = self.hit(x, y);
        let out = self.session.as_mut().map(|s| s.moved(x, y, hit.as_ref())).unwrap_or_default();
        self.apply(out);
    }

    fn hide_trash(&mut self) {
        if !self.trash.on {
            return;
        }
        self.trash.on = false;
        self.trash.look = None;
        targets::publish(TRASH, Vec::new());
        unsafe { ShowWindow(self.trash.hwnd, SW_HIDE) };
    }

    /// Draw the square in `look` (only when it changed); the window keeps its place.
    unsafe fn render_trash(&mut self, look: trash::Look) {
        if self.trash.look == Some(look) {
            return;
        }
        self.trash.look = Some(look);
        let canvas = trash::paint(self.trash.scale, look);
        let (ox, oy) = trash::origin(self.trash.centre, self.trash.scale);
        blit(self.trash.hwnd, &canvas, (ox, oy));
    }

    /// Centre the card on (x, y); redrawn first only if the monitor's scale changed.
    fn place(&mut self, x: i32, y: i32) {
        let Some((action, tone, drawn_scale)) = self.drawn.clone() else { return };
        let scale = scale_at(x, y);
        if (scale - drawn_scale).abs() > 0.01 {
            unsafe { self.render(&action, &tone, scale) };
            self.drawn = Some((action, tone, scale));
        }
        if !self.shown {
            return;
        }
        let (ox, oy) = card::origin((x, y), scale, work_area(x, y));
        unsafe {
            SetWindowPos(self.hwnd, HWND_TOPMOST, ox, oy, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW);
        }
    }

    /// Draws the card into a DIB and gives it to the layered window (size and pixels; the
    /// position is left to `place`).
    unsafe fn render(&mut self, action: &str, tone: &str, scale: f32) {
        let l = card::layout(scale, self.content.layers);
        let screen = GetDC(null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: l.w as i32,
            biHeight: -(l.h as i32), // top-down rows, like card::Canvas
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut core::ffi::c_void = null_mut();
        let dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        if dib.is_null() || bits.is_null() {
            log::line("drag card: CreateDIBSection failed");
            DeleteDC(mem);
            ReleaseDC(null_mut(), screen);
            return;
        }
        let old_bitmap = SelectObject(mem, dib);
        let face = wide("Microsoft YaHei UI");
        let font = |px: f32, bold: bool| -> HFONT {
            CreateFontW(
                -(px.round() as i32), 0, 0, 0,
                if bold { FW_BOLD as i32 } else { FW_NORMAL as i32 },
                0, 0, 0,
                DEFAULT_CHARSET as u32, OUT_DEFAULT_PRECIS as u32, CLIP_DEFAULT_PRECIS as u32, CLEARTYPE_QUALITY as u32, 0,
                face.as_ptr(),
            )
        };
        let title_font = font(l.title_px, true);
        let action_font = font(l.action_px, false);
        let small_font = font(l.placeholder_px, false);

        // the pill fits the action text: measure it first
        let old_font = SelectObject(mem, action_font);
        let action_w: Vec<u16> = action.encode_utf16().collect();
        let mut extent = SIZE { cx: 0, cy: 0 };
        GetTextExtentPoint32W(mem, action_w.as_ptr(), action_w.len() as i32, &mut extent);
        let (pill, text_box) = card::badge(&l, extent.cx as f32);

        let canvas = card::paint(&l, pill, tone, self.content.thumb.as_ref());
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, canvas.px.len());
        pixels.copy_from_slice(&canvas.px);

        SetBkMode(mem, TRANSPARENT as i32);
        let rect = |r: card::RectF| RECT {
            left: r.x.round() as i32,
            top: r.y.round() as i32,
            right: r.right().round() as i32,
            bottom: r.bottom().round() as i32,
        };
        let flags = DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX;
        let draw = |text: &str, f: HFONT, color: card::Rgb, r: card::RectF, align| {
            let mut w: Vec<u16> = text.encode_utf16().collect();
            let mut rc = rect(r);
            SelectObject(mem, f);
            SetTextColor(mem, colorref(color));
            DrawTextW(mem, w.as_mut_ptr(), w.len() as i32, &mut rc, flags | align);
        };
        draw(&self.content.name, title_font, card::text_color(), l.title, DT_LEFT);
        draw(action, action_font, card::tone_colors(tone).0, text_box, DT_LEFT);
        if self.content.thumb.is_none() {
            draw("图层", small_font, card::placeholder_color(), l.thumb, DT_CENTER);
        }
        GdiFlush();
        // GDI writes colour but not alpha: take the card's coverage back from the canvas, and keep
        // fully transparent pixels black so the bitmap stays validly premultiplied
        for (i, px) in pixels.chunks_exact_mut(4).enumerate() {
            let a = canvas.px[i * 4 + 3];
            px[3] = a;
            if a == 0 {
                px[0] = 0;
                px[1] = 0;
                px[2] = 0;
            }
        }

        let (ox, oy) = card::origin(self.last, scale, work_area(self.last.0, self.last.1));
        let dst = POINT { x: ox, y: oy };
        let size = SIZE { cx: l.w as i32, cy: l.h as i32 };
        let src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        if UpdateLayeredWindow(self.hwnd, screen, &dst, &size, mem, &src, 0, &blend, ULW_ALPHA) == 0 {
            log::line("drag card: UpdateLayeredWindow failed");
        }

        SelectObject(mem, old_font);
        SelectObject(mem, old_bitmap);
        DeleteObject(title_font);
        DeleteObject(action_font);
        DeleteObject(small_font);
        DeleteObject(dib);
        DeleteDC(mem);
        ReleaseDC(null_mut(), screen);
    }
}

/// Give `canvas` (premultiplied BGRA) to the layered window `hwnd` at `at`.
unsafe fn blit(hwnd: HWND, canvas: &card::Canvas, at: (i32, i32)) {
    let screen = GetDC(null_mut());
    let mem = CreateCompatibleDC(screen);
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: canvas.w as i32,
        biHeight: -(canvas.h as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    let mut bits: *mut core::ffi::c_void = null_mut();
    let dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
    if dib.is_null() || bits.is_null() {
        log::line("trash: CreateDIBSection failed");
        DeleteDC(mem);
        ReleaseDC(null_mut(), screen);
        return;
    }
    let old = SelectObject(mem, dib);
    std::slice::from_raw_parts_mut(bits as *mut u8, canvas.px.len()).copy_from_slice(&canvas.px);
    let dst = POINT { x: at.0, y: at.1 };
    let size = SIZE { cx: canvas.w as i32, cy: canvas.h as i32 };
    let src = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
    if UpdateLayeredWindow(hwnd, screen, &dst, &size, mem, &src, 0, &blend, ULW_ALPHA) == 0 {
        log::line("trash: UpdateLayeredWindow failed");
    }
    SelectObject(mem, old);
    DeleteObject(dib);
    DeleteDC(mem);
    ReleaseDC(null_mut(), screen);
}

fn with_engine(f: impl FnOnce(&mut Engine)) -> bool {
    ENGINE.with(|e| match e.try_borrow_mut() {
        Ok(mut slot) => {
            if let Some(engine) = slot.as_mut() {
                f(engine);
            }
            true
        }
        Err(_) => false, // re-entered while handling an earlier message
    })
}

fn engine<R>(f: impl FnOnce(&mut Engine) -> R) -> Option<R> {
    ENGINE.with(|e| e.try_borrow_mut().ok().and_then(|mut slot| slot.as_mut().map(f)))
}

// ── the system drag (OLE) and its watchdog ──
//
// 11-12 evidence: twice "ole drag start" and never an end. The button was pressed in Photoshop,
// so this thread's input state never saw it and OLE's loop never got the release: DoDragDrop
// waited forever, the card stayed on the cursor and every later drag found this thread blocked.
// So: (1) during the drag this thread shares Photoshop's input state (AttachThreadInput), which
// is what lets OLE's capture and key state see the real button; (2) the release is judged from
// the physical button, not OLE's key flags; (3) a watchdog on its own thread makes sure a stuck
// drag ends: Escape after the button has been up a while, a helper restart as the last resort.

static OLE_RUNNING: AtomicBool = AtomicBool::new(false);
/// OLE was told to drop: the target may take a while in its Drop, so the watchdog waits longer
static OLE_DROPPING: AtomicBool = AtomicBool::new(false);
/// our QueryContinueDrag ended it (release, Escape): a cancel without this came from Windows
static OLE_DECIDED: AtomicBool = AtomicBool::new(false);
static OLE_THREAD: AtomicU32 = AtomicU32::new(0);
static OLE_QUERIES: AtomicU32 = AtomicU32::new(0);
static OLE_FEEDBACKS: AtomicU32 = AtomicU32::new(0);
/// the target's last answer (GiveFeedback effect) and how often it changed: tells "never accepted"
/// from "accepted, then not where it was let go" in the release log
static OLE_LAST_EFFECT: AtomicU32 = AtomicU32::new(u32::MAX);
static OLE_EFFECT_CHANGES: AtomicU32 = AtomicU32::new(0);
static WATCHDOG: Once = Once::new();
/// the running system drag's session, for the watchdog's report to the plugin
static OLE_SESSION: Mutex<String> = Mutex::new(String::new());

/// Escape this long after the physical release, unless a drop is under way.
const STUCK_ESCAPE: Duration = Duration::from_millis(500);
/// Restart the helper this long after the release (a drop gets STUCK_DROP_RESTART).
const STUCK_RESTART: Duration = Duration::from_millis(3000);
const STUCK_DROP_RESTART: Duration = Duration::from_secs(20);

/// Runs the system drag outside any borrow of the engine: OLE's modal loop keeps dispatching
/// this thread's messages and hook calls, which borrow it briefly.
fn run_ole() {
    let Some(Some((files, session_id, ps_thread))) = engine(|e| e.ole_begin()) else { return };
    if let Ok(mut id) = OLE_SESSION.lock() {
        *id = session_id;
    }
    let me = unsafe { GetCurrentThreadId() };
    // Photoshop's thread (where the button went down), or the foreground's if it wasn't known
    let front_thread = if ps_thread != 0 {
        ps_thread
    } else {
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), null_mut()) }
    };
    let attached = front_thread != 0 && front_thread != me && unsafe { AttachThreadInput(me, front_thread, 1) } != 0;
    log::line(format!(
        "ole drag input attached={attached} front_thread={front_thread} button_down={}",
        key_down(VK_LBUTTON)
    ));
    OLE_QUERIES.store(0, Ordering::SeqCst);
    OLE_FEEDBACKS.store(0, Ordering::SeqCst);
    OLE_LAST_EFFECT.store(u32::MAX, Ordering::SeqCst);
    OLE_EFFECT_CHANGES.store(0, Ordering::SeqCst);
    // handled inside OLE's loop: a zero mouse move so a target already under the cursor hears
    // about the drag (DragEnter) without the user having to move
    let card = HWND_SELF.load(Ordering::SeqCst) as HWND;
    unsafe { PostMessageW(card, WM_APP_NUDGE, 0, 0) };
    OLE_DROPPING.store(false, Ordering::SeqCst);
    OLE_DECIDED.store(false, Ordering::SeqCst);
    OLE_THREAD.store(me, Ordering::SeqCst);
    OLE_RUNNING.store(true, Ordering::SeqCst);
    WATCHDOG.call_once(|| {
        std::thread::spawn(watchdog);
    });
    let r = ole::drag(&files, ole::Decisions { query_continue: ole_query, feedback: ole_feedback });
    OLE_RUNNING.store(false, Ordering::SeqCst);
    if attached {
        unsafe { AttachThreadInput(me, front_thread, 0) };
    }
    log::line(format!(
        "ole drag calls query_continue={} feedback={}",
        OLE_QUERIES.load(Ordering::SeqCst),
        OLE_FEEDBACKS.load(Ordering::SeqCst)
    ));
    let decided = OLE_DECIDED.load(Ordering::SeqCst);
    engine(|e| e.ole_end(r, decided));
}

/// The work area (screen without the taskbar) of the monitor at (x, y): left, top, right, bottom.
fn work_area(x: i32, y: i32) -> (i32, i32, i32, i32) {
    unsafe {
        let m = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(m, &mut info) != 0 {
            let r = info.rcWork;
            return (r.left, r.top, r.right, r.bottom);
        }
    }
    (i32::MIN / 2, i32::MIN / 2, i32::MAX / 2, i32::MAX / 2)
}

/// What a release would do, by the keys held now (transfer::drop_mode).
fn current_mode() -> transfer::DropMode {
    transfer::drop_mode(key_down(VK_CONTROL), key_down(VK_MENU))
}

/// Where (x, y) is within the window under it (Illustrator's canvas), 0–1 each way; the whole
/// program window when that one is too small to be the canvas. Logged with its class for checking.
fn canvas_fraction(x: i32, y: i32, root: isize) -> (f64, f64) {
    unsafe {
        let mut h = WindowFromPoint(POINT { x, y });
        if h.is_null() {
            h = root as HWND;
        }
        let mut r: RECT = std::mem::zeroed();
        GetWindowRect(h, &mut r);
        if r.right - r.left < 200 || r.bottom - r.top < 150 {
            h = root as HWND;
            GetWindowRect(h, &mut r);
        }
        let mut class = [0u16; 128];
        let n = GetClassNameW(h, class.as_mut_ptr(), class.len() as i32).max(0) as usize;
        let (w, hh) = ((r.right - r.left).max(1) as f64, (r.bottom - r.top).max(1) as f64);
        let f = ((x - r.left) as f64 / w, (y - r.top) as f64 / hh);
        log::line(format!(
            "illustrator canvas class={} rect={},{},{},{} drop={x},{y}",
            String::from_utf16_lossy(&class[..n]), r.left, r.top, r.right, r.bottom
        ));
        f
    }
}

/// A mouse move of zero: the cursor stays, OLE re-checks the target under it.
fn nudge() {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 } },
    };
    unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
}

fn ole_query(escape: bool, keys: u32) -> i32 {
    if OLE_QUERIES.fetch_add(1, Ordering::SeqCst) == 0 {
        log::line(format!("ole query_continue first keys=0x{keys:x} escape={escape} button_down={}", key_down(VK_LBUTTON)));
    }
    if escape {
        OLE_DECIDED.store(true, Ordering::SeqCst);
        return ole::DRAGDROP_S_CANCEL;
    }
    // the physical button decides: OLE's flags come from this thread's input state, which may
    // never have seen the press made in Photoshop
    if key_down(VK_LBUTTON) {
        return 0; // S_OK: go on
    }
    let (x, y) = cursor();
    let decision = engine(|e| e.ole_release(x, y)).unwrap_or(ole::DRAGDROP_S_CANCEL);
    OLE_DECIDED.store(true, Ordering::SeqCst);
    if decision == ole::DRAGDROP_S_DROP {
        OLE_DROPPING.store(true, Ordering::SeqCst);
    }
    decision
}

fn ole_feedback(effect: u32) -> bool {
    if OLE_FEEDBACKS.fetch_add(1, Ordering::SeqCst) == 0 {
        log::line(format!("ole feedback first effect={effect}"));
    }
    if OLE_LAST_EFFECT.swap(effect, Ordering::SeqCst) != effect {
        OLE_EFFECT_CHANGES.fetch_add(1, Ordering::SeqCst);
    }
    engine(|e| e.ole_feedback(effect));
    // OLE's own cursors (arrow with + / ⃠): the arrow stays visible, the card sits beside it
    false
}

/// Its own thread: ends a system drag that doesn't end by itself. Only atomics, posted messages
/// and async window calls here, so a blocked engine thread can't block it too.
fn watchdog() {
    let mut up_since: Option<Instant> = None;
    let mut escaped = false;
    let mut restarted = false;
    loop {
        std::thread::sleep(Duration::from_millis(100));
        if !OLE_RUNNING.load(Ordering::SeqCst) {
            up_since = None;
            escaped = false;
            continue;
        }
        if key_down(VK_LBUTTON) {
            up_since = None;
            continue;
        }
        let since = *up_since.get_or_insert_with(Instant::now);
        let dropping = OLE_DROPPING.load(Ordering::SeqCst);
        let tid = OLE_THREAD.load(Ordering::SeqCst);
        if !escaped && !dropping && since.elapsed() >= STUCK_ESCAPE {
            escaped = true;
            log::line(format!(
                "ole watchdog: button up {} ms, drag still running (query_continue={}): posting Escape",
                since.elapsed().as_millis(),
                OLE_QUERIES.load(Ordering::SeqCst)
            ));
            unsafe {
                PostThreadMessageW(tid, WM_KEYDOWN, VK_ESCAPE as WPARAM, 0x0001_0001);
                PostThreadMessageW(tid, WM_KEYUP, VK_ESCAPE as WPARAM, 0xC001_0001u32 as LPARAM);
            }
        }
        let limit = if dropping { STUCK_DROP_RESTART } else { STUCK_RESTART };
        if !restarted && since.elapsed() >= limit {
            restarted = true;
            log::line(format!("ole watchdog: drag stuck {} ms after the release: restarting the helper", since.elapsed().as_millis()));
            let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
            unsafe { ShowWindowAsync(h, SW_HIDE) };
            // the plugin's WaveLayer drag ends too (it may never have had its mouseup)
            let session_id = OLE_SESSION.lock().map(|s| s.clone()).unwrap_or_default();
            emit(Event::ExternalFinished { session_id, status: "error", effect: "none", target: String::new(), count: 0 });
            std::thread::spawn(|| crate::life::restart("ole drag stuck"));
        }
    }
}

/// Low-level mouse hook: called on this thread (it pumps messages) before the input reaches any
/// window. Only moves the card and hit-tests; the event always continues to its window.
unsafe extern "system" fn hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(l as *const MSLLHOOKSTRUCT);
        let (x, y) = (info.pt.x, info.pt.y);
        match w as u32 {
            WM_MOUSEMOVE => {
                with_engine(|e| e.moved(x, y));
            }
            WM_LBUTTONUP => {
                if !with_engine(|e| e.released(x, y)) {
                    let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
                    PostMessageW(h, WM_APP_UP, x as u32 as WPARAM, y as u32 as LPARAM);
                }
            }
            _ => {}
        }
    }
    CallNextHookEx(null_mut(), code, w, l)
}

unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_APP_CMD => {
            let cmds: Vec<Cmd> = QUEUE.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
            for c in cmds {
                with_engine(|e| e.command(c));
            }
            0
        }
        WM_APP_OLE => {
            run_ole();
            0
        }
        WM_APP_NUDGE => {
            if OLE_RUNNING.load(Ordering::SeqCst) {
                let (x, y) = cursor();
                if engine(|e| e.foreign(x, y)).unwrap_or(false) {
                    nudge();
                    log::line(format!("ole nudge over={}", crate::win::describe(crate::win::root_at(x, y))));
                }
            }
            0
        }
        WM_APP_UP => {
            let (x, y) = (w as u32 as i32, l as u32 as i32);
            with_engine(|e| e.released(x, y));
            0
        }
        WM_TIMER => {
            if w == WATCH_TIMER {
                with_engine(|e| e.watch());
            } else if w == POLL_TIMER {
                let (x, y) = cursor();
                with_engine(|e| e.moved(x, y));
            }
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
        let class = wide("WavePlugDragCard");
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
        let title = wide(TITLE);
        let h = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            crate::win::PARK.0,
            crate::win::PARK.1,
            1,
            1,
            null_mut(),
            null_mut(),
            inst,
            null(),
        );
        if h.is_null() {
            log::line("drag card: window not created");
            return;
        }
        let trash_title = wide(TRASH_TITLE);
        let trash_hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class.as_ptr(),
            trash_title.as_ptr(),
            WS_POPUP,
            crate::win::PARK.0,
            crate::win::PARK.1,
            1,
            1,
            null_mut(),
            null_mut(),
            inst,
            null(),
        );
        if trash_hwnd.is_null() {
            log::line("trash: window not created");
        }
        ENGINE.with(|e| {
            *e.borrow_mut() = Some(Engine {
                hwnd: h,
                trash: TrashWin { hwnd: trash_hwnd, on: false, enabled: false, centre: (0, 0), scale: 1.0, look: None },
                began_at: (0, 0),
                transfer: None,
                ole_active: false,
                ole_native: false,
                ole_started: Instant::now(),
                deferred: Vec::new(),
                foreign_cache: (0, false, String::new()),
                ole_target: String::new(),
                ps_thread: 0,
                resumes: 0,
                ai_cache: (0, None),
                ai_job: None,
                mode: transfer::DropMode::Smart,
                session: None,
                content: Content { name: String::new(), layers: 1, thumb: None },
                drawn: None,
                hook: null_mut(),
                polling: false,
                shown: false,
                last: (0, 0),
                started: Instant::now(),
                export_wanted: false,
            })
        });
        HWND_SELF.store(h as isize, Ordering::SeqCst);
        // this thread is the STA that runs DoDragDrop (drag/ole.rs)
        let hr = ole::init();
        log::line(format!("drag card: window ready ole_init=0x{:08x}", hr as u32));
        // commands queued before the window existed
        PostMessageW(h, WM_APP_CMD, 0, 0);
        let mut m: MSG = std::mem::zeroed();
        while GetMessageW(&mut m, null_mut(), 0, 0) > 0 {
            DispatchMessageW(&m);
        }
    }
}
