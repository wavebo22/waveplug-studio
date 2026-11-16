//! The WaveLayer drag engine: the card that follows the cursor and the native drop targets
//! (reference slots), run on one thread of their own (drag/win.rs), outside egui.
//!
//! Why its own thread: the card used to be an egui viewport redrawn every frame from a polled
//! cursor, and the slots polled the cursor and the button in their own frames. Its position was
//! tied to whole-frame GPU redraws (20 fps with vsync and three viewports, 900 fps without) and
//! hover / release were decided in three places. Here the card is drawn once per change of what
//! it says and only moved on each mouse event; hover and release come from one hit test
//! (targets.rs) in one state machine (session.rs). Later OLE drags to other programs
//! (docs/CROSS_APP_DRAG_DROP_SPEC.md) belong on this thread too.
//!
//! The host forwards the plugin's layer-drag-* commands here and drains `take_events` each frame.

pub mod card;
pub mod compose;
#[cfg(windows)]
mod illustrator;
#[cfg(windows)]
mod ole;
pub mod session;
pub mod targets;
pub mod transfer;
pub mod trash;
#[cfg(windows)]
mod win;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::panel::DraggedLayer;
pub use session::Reference;

/// What the engine tells the host.
#[derive(Debug)]
pub enum Event {
    /// released over `surface`'s target `target`
    Dropped { surface: &'static str, target: u32, reference: Reference },
    /// a reference drag ended here (release, Escape): the plugin is told finish-layer-drag
    Finished,
    /// the hovered native target changed: redraw the surfaces
    Hover,
    /// any drag session ended here: dropped / released / escape / cancelled (the workbench's own
    /// drags out of its window wait for this)
    Ended { ending: &'static str },
    /// a drag to another program (OLE) ended: dropped / cancelled / rejected / error
    /// `target`: the program it was let go over, by name; `count`: files offered
    ExternalFinished { session_id: String, status: &'static str, effect: &'static str, target: String, count: usize },
}

static ACTIVE: AtomicBool = AtomicBool::new(false);
static HOVER: Mutex<Option<(&'static str, u32)>> = Mutex::new(None);
static EVENTS: Mutex<VecDeque<Event>> = Mutex::new(VecDeque::new());

/// A WaveLayer drag is under way (the card is up).
pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// The native target under the cursor, for the surface to highlight.
pub fn hovered() -> Option<(&'static str, u32)> {
    HOVER.lock().ok().and_then(|h| *h)
}

pub fn take_events() -> Vec<Event> {
    EVENTS.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn emit(e: Event) {
    if let Ok(mut q) = EVENTS.lock() {
        q.push_back(e);
    }
    crate::host::wake();
}

#[cfg_attr(not(windows), allow(dead_code))]
fn set_hover(h: Option<(&'static str, u32)>) {
    if let Ok(mut slot) = HOVER.lock() {
        *slot = h;
    }
}

/// Commands from the host (the plugin's messages), carried out on the engine thread.
#[derive(Debug)]
pub enum Cmd {
    PreviewStart { layers: Vec<DraggedLayer>, total: usize },
    Verdict { action: String, tone: String },
    Reference(Reference),
    End,
    Cancel,
    /// the plugin is exporting `count` layers for a drag to another program
    TransferPrepare { session_id: String, count: usize },
    /// …and they are now in our cache, in layer order
    /// `items`: the plugin's files with `path` set to our copies (for the combined SVG);
    /// `svg`: the editable combined SVG, written when some layer has vectors
    TransferFiles { session_id: String, files: Vec<PathBuf>, items: Vec<transfer::SourceFile>, svg: Option<PathBuf> },
    TransferCancel { session_id: String },
    /// the plugin has exported `done` of the layers so far (for the card)
    TransferProgress { session_id: String, done: usize },
    /// 外置删除区 for this drag (drag/trash.rs): `view` the canvas on screen (left, top, right,
    /// bottom px), `enabled` whether anything dragged can be deleted, `action` the card's text
    /// over it. Gone with the drag.
    Trash { view: Option<(i32, i32, i32, i32)>, enabled: bool, action: String },
}

/// Which of the plugin's layer keys are already exported in the store (external-drag-cached).
pub fn cached_keys(keys: &[String]) -> Vec<String> {
    transfer::cache_root().map(|root| transfer::cached_keys(&root, keys)).unwrap_or_default()
}

/// The plugin's exported files are ready: copy them into the cache on a worker thread (never the
/// engine's or the server's), tell the plugin it may delete its copies, then hand them over.
pub fn transfer_ready(session_id: String, files: Vec<transfer::SourceFile>) {
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        let Some(root) = transfer::cache_root() else {
            crate::log::line("external transfer: no LOCALAPPDATA");
            send(Cmd::TransferCancel { session_id });
            return;
        };
        match transfer::copy_session(&root, &session_id, &files) {
            Ok(paths) => {
                crate::server::send(&crate::protocol::Event::ExternalDragFilesCopied { session_id: session_id.clone() });
                let mut items = files;
                items.sort_by_key(|f| f.order);
                for (f, p) in items.iter_mut().zip(&paths) {
                    f.path = p.to_string_lossy().into_owned();
                }
                // vector programs get one SVG of all the layers (text, shapes editable)
                let mut svg = None;
                if compose::files_have_vectors(&items) {
                    let to = root.join(transfer::session_folder(&session_id)).join(compose::EDITABLE);
                    match compose::write(&items, false, &to) {
                        Ok(()) => svg = Some(to),
                        Err(e) => crate::log::line(format!("external transfer svg: {e}")),
                    }
                }
                crate::log::line(format!(
                    "external transfer ready files={} vectors={} svg={} ms={}",
                    paths.len(),
                    items.iter().filter(|f| f.vector.is_some()).count(),
                    svg.is_some(),
                    t0.elapsed().as_millis()
                ));
                send(Cmd::TransferFiles { session_id, files: paths, items, svg });
            }
            Err(e) => {
                crate::log::line(format!("external transfer failed: {e}"));
                send(Cmd::TransferCancel { session_id });
            }
        }
    });
}

/// At startup and after each system drag: old sessions and store entries go, and the store keeps
/// to transfer::BUDGET.
pub fn sweep_cache() {
    // not two at once (a drag can end while the startup sweep still runs)
    static SWEEPING: AtomicBool = AtomicBool::new(false);
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        if let Some(root) = transfer::cache_root() {
            let n = transfer::sweep(&root, transfer::KEEP, transfer::BUDGET, std::time::SystemTime::now());
            if n > 0 {
                crate::log::line(format!("external transfer cache: removed {n} old entries"));
            }
        }
        SWEEPING.store(false, Ordering::SeqCst);
    });
}

#[cfg(windows)]
pub fn send(cmd: Cmd) {
    win::send(cmd);
}

/// Without Windows there is no card or hook; only the shared state is kept consistent.
#[cfg(not(windows))]
pub fn send(cmd: Cmd) {
    match cmd {
        Cmd::PreviewStart { .. } => ACTIVE.store(true, Ordering::SeqCst),
        Cmd::End | Cmd::Cancel => ACTIVE.store(false, Ordering::SeqCst),
        Cmd::Reference(_) | Cmd::Verdict { .. } | Cmd::TransferPrepare { .. } | Cmd::TransferFiles { .. } | Cmd::TransferCancel { .. } | Cmd::TransferProgress { .. } | Cmd::Trash { .. } => {}
    }
}
