// The window that shows the external surfaces and their link to the plugin. Takes the plugin's
// commands from the server thread, hands state to the surface it names, draws the surface that
// is up and sends its actions back. Placed and put away from the server thread through win.rs
// (on Windows "away" is off screen, see win.rs). Moved only by the grip in its bottom-right
// corner. Knows nothing about any one surface: they are listed in `surfaces()`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use eframe::egui::{self, Frame, Id, Margin, Sense, Stroke, ViewportCommand};

use crate::panel::generate::GenerateSurface;
use crate::panel::shelf::{self, Shelf};
use crate::panel::check::{self, Check};
use crate::panel::organize::{self, Organize};
use crate::panel::variants::{self, VariantRail};
use crate::panel::{theme, Surface, DraggedLayer};
use crate::protocol::{Command, Event, ScreenRect};
use crate::server;

/// The window's title; win.rs finds the window by it, so keep it unique.
pub const TITLE: &str = "WavePlug 外置生成面板";
/// The completion notice's window (an egui viewport), found the same way.
pub const TOAST_TITLE: &str = "WavePlug 提示";
/// 卡死保护's dialog (hang.rs)
pub const HANG_TITLE: &str = "WavePlug · Photoshop 没有响应";
const HANG_SIZE: egui::Vec2 = egui::vec2(440.0, 236.0);
const TOAST_SIZE: egui::Vec2 = egui::vec2(300.0, 70.0);
/// The bar the generate panel folds into (and its footer while open): its height, and the gap
/// around it inside the window's border. Big enough to hit without aiming.
const BAR_HEIGHT: f32 = 26.0;
const BAR_PAD: f32 = 4.0;
/// the folded window's content: the bar and the gap around it
const COLLAPSED_BAR_HEIGHT: f32 = BAR_HEIGHT + 2.0 * BAR_PAD;
const DRAG_REVEAL_ZONE_HEIGHT: f32 = 72.0;
/// How long the panel stays open after the pointer leaves it: crossing its edge on the way to a
/// button, or slipping off for a moment, must not fold it under the cursor.
const COLLAPSE_GRACE: Duration = Duration::from_millis(500);
/// Room at the bar's right end for the corner grip (drawn over it while the panel is open).
const GRIP_ROOM: f32 = 24.0;

/// The visible height `since` a fold from `from` to `to` began, and whether it has arrived.
fn fold_height(from: f32, to: f32, since: Instant, now: Instant) -> (f32, bool) {
    let t = now.saturating_duration_since(since).as_secs_f32() / crate::anim::RESIZE_SECS;
    if t >= 1.0 {
        (to, true)
    } else {
        (crate::anim::tween(from, to, t).round(), false)
    }
}

/// Whether the panel is folded this frame. `open_until`: it was last wanted until then (the
/// grace after the pointer left). Pure, so the hover rules are tested without a window.
fn fold_now(wanted: bool, now: Instant, open_until: &mut Option<Instant>) -> bool {
    if wanted {
        *open_until = Some(now + COLLAPSE_GRACE);
        return false;
    }
    match *open_until {
        Some(t) if now < t => false,
        _ => {
            *open_until = None;
            true
        }
    }
}

fn should_expand_generate_panel(
    pointer_inside: bool,
    pointer_down: bool,
    keep_open: bool,
    dragging_over_reveal_zone: bool,
) -> bool {
    pointer_inside || pointer_down || keep_open || dragging_over_reveal_zone
}


/// Every surface the helper can show. A new one is added here (and on the plugin's side).
fn surfaces() -> Vec<Box<dyn Surface>> {
    use crate::panel::setup::{self, SetupSurface};
    vec![
        Box::new(GenerateSurface::new()),
        // the features' settings panels share the corner window with it (one up at a time: the plugin decides)
        Box::new(SetupSurface::new(setup::CHECK_ID)),
        Box::new(SetupSurface::new(setup::ORGANIZE_ID)),
        Box::new(SetupSurface::new(setup::REWRITE_ID)),
    ]
}

static INBOX: Mutex<VecDeque<Command>> = Mutex::new(VecDeque::new());
static CTX: OnceLock<egui::Context> = OnceLock::new();
/// each surface's window size in logical px, for win.rs (read on the server thread)
static SIZES: OnceLock<HashMap<&'static str, egui::Vec2>> = OnceLock::new();

/// the surface's content height, logical px (0 until it has been drawn once)
static CONTENT_H: AtomicU32 = AtomicU32::new(0);

/// The size to place surface `panel` at: its width, and the height its content needs.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn size_of(panel: &str) -> egui::Vec2 {
    let mut size = SIZES
        .get()
        .and_then(|m| m.get(panel).copied())
        .unwrap_or(egui::vec2(340.0, 560.0));
    let h = f32::from_bits(CONTENT_H.load(Ordering::SeqCst));
    if h > 0.0 {
        size.y = h;
    } else if panel == "generate" {
        // First show starts collapsed too; never flash the full-height surface before its first frame.
        size.y = COLLAPSED_BAR_HEIGHT + 2.0;
    }
    size
}

/// Server thread: show / hide right away (win.rs), queue the rest for the next frame.
fn on_command(c: Command) {
    if let Command::ManageComfy {
        path,
        base,
        close_with_photoshop,
        restart_if_needed,
        disable_browser,
        start_if_missing,
        restart,
    } = &c
    {
        crate::comfy::manage(
            path.clone(),
            base.clone(),
            *close_with_photoshop,
            *restart_if_needed,
            *disable_browser,
            *start_if_missing,
            *restart,
        );
        return;
    }
    if let Command::UpdateNow = c {
        crate::autoupdate::update_now();
        return;
    }
    if let Command::RestartHelper = c {
        // off the server thread: the restart waits for the new copy before quitting
        std::thread::spawn(|| crate::life::restart("requested by the plugin"));
        return;
    }
    // drags to other programs go straight to the drag engine (files are copied off-thread)
    match c {
        Command::ExternalDragPrepare { session_id, total_count, keys, .. } => {
            // answered at once (a few file lookups): the plugin waits for this before exporting
            let cached = crate::drag::cached_keys(&keys);
            server::send(&Event::ExternalDragCached { session_id: session_id.clone(), keys: cached });
            crate::drag::send(crate::drag::Cmd::TransferPrepare { session_id, count: total_count });
            return;
        }
        Command::ExternalDragReady { session_id, files } => {
            crate::drag::transfer_ready(session_id, files);
            return;
        }
        Command::ExternalDragCancel { session_id, .. } => {
            crate::drag::send(crate::drag::Cmd::TransferCancel { session_id });
            return;
        }
        Command::ExternalDragProgress { session_id, done, .. } => {
            crate::drag::send(crate::drag::Cmd::TransferProgress { session_id, done });
            return;
        }
        _ => {}
    }
    // the right-click menu is a native menu on its own thread (menu.rs)
    match c {
        Command::MenuOpen { menu_id, title, items } => {
            crate::menu::open(menu_id, title, items);
            return;
        }
        Command::MenuClose { menu_id } => {
            crate::menu::close(menu_id);
            return;
        }
        _ => {}
    }
    if let Command::WatchKeys { on } = c {
        crate::keys::watch(on);
        return;
    }
    if let Command::Hotkeys { on } = c {
        crate::hotkey::set(on);
        return;
    }
    if let Command::WebCatch { on, client_x, client_y, left, top, width, height, folder } = c {
        crate::webdrop::set(on.then(|| crate::webdrop::CatchRequest { client: (client_x, client_y), area: (left, top, width, height), folder }));
        return;
    }
    if let Command::AppSettings { settings } = c {
        crate::app::set_plugin_settings(settings);
        return;
    }
    if let Command::OpenApp { tab } = c {
        crate::app::open(Some(crate::app::Tab::named(&tab)));
        return;
    }
    if let Command::HangGuard { on, auto_backup, seconds, docs } = c {
        crate::hang::configure(on, auto_backup, seconds, docs);
        return;
    }
    // 性能监视 is its own window too (monitor.rs); it sits in the corner of whatever canvas view
    // the plugin last placed a surface against
    match &c {
        Command::Monitor { on, comfy, view } => {
            crate::monitor::set(*on, comfy.clone());
            if view.is_some() {
                crate::monitor::set_view(*view);
            }
            return;
        }
        Command::StatusBar { on, hints, state, message, mode, view } => {
            crate::monitor::set_bar(on.then(|| crate::monitor::Bar { hints: hints.clone(), state: state.clone(), message: message.clone(), mode: mode.clone() }));
            if view.is_some() {
                crate::monitor::set_view(*view);
            }
            return;
        }
        Command::Show { view: Some(view), .. } => crate::monitor::set_view(Some(*view)),
        // the generate panel leaves only when no document is open: no canvas to sit in
        Command::Hide { panel } if panel == "generate" => crate::monitor::set_view(None),
        _ => {}
    }
    // the canvas moved: the status bar and every window's place follow, off the UI thread
    if let Command::Canvas { view } = c {
        crate::monitor::set_view(Some(view));
        #[cfg(windows)]
        crate::win::canvas_moved(view);
        return;
    }
    // the hover frame is its own window: nothing for the UI thread to draw
    if let Command::HoverFrame { rect, clip } = c {
        crate::frame::set(rect, clip);
        return;
    }
    if let Command::HoverTint { rect, clip, width, height, alpha, color } = c {
        crate::frame::set_tint(rect.and_then(|r| crate::frame::Tint::decode(r, clip, width, height, &alpha, color.as_deref())));
        return;
    }
    if let Command::PanelAnchor = c {
        #[cfg(windows)]
        crate::win::check_anchor();
        return;
    }
    if let Command::IssueRows { left, right, rows, color } = c {
        let color = color.as_deref().and_then(crate::frame::parse_color);
        #[cfg(windows)]
        crate::frame::set_leader_rows(crate::win::leader_rows(left, right, &rows), color);
        #[cfg(not(windows))]
        let _ = (left, right, rows, color);
        return;
    }
    #[cfg(windows)]
    match &c {
        Command::Show { panel, view } if panel != variants::ID && panel != shelf::ID && assist_id(panel).is_none() => {
            crate::win::show(panel, *view, size_of(panel))
        }
        Command::Hide { panel } if panel != variants::ID && panel != shelf::ID && assist_id(panel).is_none() => crate::win::hide(panel),
        _ => {} // the variants and workbench viewports are controlled separately by Host.update
    }
    if let Ok(mut q) = INBOX.lock() {
        q.push_back(c);
    }
    if let Some(ctx) = CTX.get() {
        ctx.request_repaint();
    }
}

/// The plugin went away: put everything away and forget its revisions.
fn on_disconnect() {
    crate::app::plugin_gone();
    // Ctrl+F goes back to Photoshop: nothing would do the paste
    crate::hotkey::set(false);
    crate::frame::set(None, None);
    crate::menu::close(None);
    crate::monitor::set(false, None);
    crate::monitor::set_bar(None);
    crate::monitor::set_view(None);
    #[cfg(windows)]
    {
        crate::win::hide_all();
        crate::win::variant_hide();
        crate::win::shelf_hide();
        crate::win::check_hide();
    }
    on_command(Command::Hello);
    on_command(Command::Hide {
        panel: variants::ID.to_string(),
    });
    on_command(Command::Hide {
        panel: shelf::ID.to_string(),
    });
    on_command(Command::Hide {
        panel: check::ID.to_string(),
    });
    on_command(Command::Hide {
        panel: organize::ID.to_string(),
    });
    on_command(Command::Hide {
        panel: organize::REWRITE_ID.to_string(),
    });
}

/// The panels shown in the window beside the 图层 panel (检查结果, AI 整理, AI 改写).
fn assist_id(panel: &str) -> Option<&'static str> {
    [check::ID, organize::ID, organize::REWRITE_ID].into_iter().find(|id| *id == panel)
}

/// A copy that isn't the installed WavePlug (the one inside the Photoshop plugin) starts the
/// installed one instead, so one program with one data folder runs. Not from the source tree
/// (dist\ has ..\reports): a developer runs what they built.
fn hand_to_installed() -> bool {
    if crate::paths::running_installed() || crate::life::replacing() {
        return false;
    }
    let Ok(me) = std::env::current_exe() else { return false };
    if me.parent().and_then(|d| d.parent()).is_some_and(|p| p.join("reports").is_dir()) {
        return false;
    }
    let Some(dir) = crate::paths::registered_dir() else { return false };
    let exe = dir.join(crate::paths::APP_EXE);
    let args: Vec<String> = std::env::args().skip(1).collect();
    match std::process::Command::new(&exe).args(&args).current_dir(&dir).spawn() {
        Ok(_) => true,
        Err(_) => false,
    }
}

pub fn run() {
    if hand_to_installed() {
        return;
    }
    crate::log::init();
    let args: Vec<String> = std::env::args().collect();
    let show = args.iter().any(|a| a == "--show");
    let uninstall = args.iter().any(|a| a == "--uninstall");
    crate::life::init();
    crate::autoupdate::start();
    if show || uninstall {
        crate::app::pin();
        if uninstall { crate::app::ask_uninstall() } else { crate::app::open(None) }
    }
    let list = surfaces();
    let first = list
        .first()
        .map(|s| s.size())
        .unwrap_or(egui::vec2(340.0, 560.0));
    let _ = SIZES.set(list.iter().map(|s| (s.id(), s.size())).collect());
    let viewport = egui::ViewportBuilder::default()
        .with_title(TITLE)
        .with_inner_size(first)
        .with_decorations(false)
        .with_taskbar(false)
        .with_resizable(false)
        .with_active(false);
    // Windows: waits off screen until the plugin says show (win.rs); elsewhere it stays in view,
    // for trying the link out
    #[cfg(windows)]
    let viewport = viewport.with_position([crate::win::PARK.0 as f32, crate::win::PARK.1 as f32]);
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };
    let _ = eframe::run_native(
        TITLE,
        options,
        Box::new(move |cc| {
            theme::install(&cc.egui_ctx);
            let _ = CTX.set(cc.egui_ctx.clone());
            crate::drag::sweep_cache();
            // a second copy finds the port taken: quit
            // a restarting previous copy still holds the port for a moment
            let mut bound = server::start(on_command, on_disconnect);
            let mut tries = if crate::life::replacing() { 60 } else { 0 };
            while bound.is_err() && tries > 0 {
                std::thread::sleep(Duration::from_millis(250));
                bound = server::start(on_command, on_disconnect);
                tries -= 1;
            }
            if bound.is_err() && (show || uninstall) {
                // started from the Start menu / 应用 while it already runs: that one shows itself
                crate::server::ask_running_to_show(if uninstall { "uninstall" } else { "overview" });
            }
            if bound.is_ok() {
                crate::tray::start();
            }
            if bound.is_err() {
                crate::log::line("port in use: another helper is running; quitting");
                // a ComfyUI taken over from the previous copy must outlive this one
                if crate::life::replacing() {
                    crate::comfy::handover();
                }
                cc.egui_ctx.send_viewport_cmd(ViewportCommand::Close);
            }
            #[cfg(windows)]
            {
                crate::win::init();
                crate::win::watch();
            }
            Ok(Box::new(Host {
                surfaces: list,
                revs: HashMap::new(),
                current: None,
                shot: crate::shot::Shot::from_env("WAVEPLUG_HOST_SHOT"),
                dragging: false,
                typing: false,
                height: 0.0,
                open_h: 0.0,
                vis: 0.0,
                vis_to: 0.0,
                fold: None,
                collapsed: true,
                open_until: None,
                // WAVEPLUG_HOST_OPEN: start 固定 open (with WAVEPLUG_HOST_SHOT, a picture of the open panel)
                pinned: std::env::var_os("WAVEPLUG_HOST_OPEN").is_some(),
                toast: None,
                hang_placed: false,
                variant_rail: VariantRail::new(),
                variant_shown: false,
                variant_view: None,
                variant_placed: false,
                variant_made_size: None,
                shelf: Shelf::new(),
                shelf_shown: false,
                shelf_view: None,
                shelf_placed: false,
                shelf_drag: None,
                check: Check::new(),
                organize: Organize::new(),
                rewrite: Organize::new(),
                assist: None,
                check_placed: false,
                assist_typing: false,
                app: None,
            }))
        }),
    );
}

struct Host {
    surfaces: Vec<Box<dyn Surface>>,
    /// the newest state revision taken in, per surface
    revs: HashMap<String, u64>,
    /// the surface that is up
    current: Option<usize>,
    /// WAVEPLUG_HOST_SHOT: a picture once a surface is up (checking the link without a screen recorder)
    shot: Option<crate::shot::Shot>,
    /// the corner grip is being dragged
    dragging: bool,
    /// a text box has the keyboard (the window took it from Photoshop for that)
    #[cfg_attr(not(windows), allow(dead_code))]
    typing: bool,
    /// the window's height (logical px): the open panel's, also while it is folded (Windows)
    height: f32,
    /// the open panel's height as last drawn (0 until it has been open once)
    open_h: f32,
    /// how much of the window shows from its bottom edge now, and where that is going
    vis: f32,
    vis_to: f32,
    /// a fold / unfold under way: (from, to, since)
    fold: Option<(f32, f32, Instant)>,
    /// collapsed while idle; expanded on hover, active input/work, or a drag entering its reveal zone
    collapsed: bool,
    /// the panel stays open until then although nothing wants it (COLLAPSE_GRACE)
    open_until: Option<Instant>,
    /// 固定: the user keeps the panel open (the button on its bar), for this run of the helper
    pinned: bool,
    toast: Option<Toast>,
    /// 卡死保护's dialog window has been put in the middle of Photoshop
    hang_placed: bool,
    variant_rail: VariantRail,
    variant_shown: bool,
    variant_view: Option<ScreenRect>,
    variant_placed: bool,
    /// the size the rail's window was made with (Windows sizes it itself afterwards)
    #[cfg_attr(not(windows), allow(dead_code))]
    variant_made_size: Option<egui::Vec2>,
    /// the 编辑工作台 window (panel/shelf.rs)
    shelf: Shelf,
    shelf_shown: bool,
    shelf_view: Option<ScreenRect>,
    shelf_placed: bool,
    /// a drag out of the workbench window is running: its entries' keys
    /// the WavePlug window, once opened
    app: Option<crate::app::AppWindow>,
    shelf_drag: Option<Vec<String>>,
    /// the 检查结果 window (panel/check.rs), beside the 图层 panel
    check: Check,
    /// the AI 整理 window (panel/organize.rs): the same window slot as 检查结果
    organize: Organize,
    /// the AI 改写 window (organize.rs with the plugin's labels): the same window slot
    rewrite: Organize,
    /// which one the window shows (check::ID / organize::ID / organize::REWRITE_ID); None: hidden
    assist: Option<&'static str>,
    check_placed: bool,
    /// AI 整理's text field has the keyboard
    assist_typing: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_panel_expands_only_for_hover_input_work_or_drag_reveal() {
        assert!(!should_expand_generate_panel(false, false, false, false));
        assert!(should_expand_generate_panel(true, false, false, false));
        assert!(should_expand_generate_panel(false, true, false, false));
        assert!(should_expand_generate_panel(false, false, true, false));
        assert!(should_expand_generate_panel(false, false, false, true));
    }

    #[test]
    fn the_panel_folds_only_after_the_pointer_has_been_away_for_the_grace() {
        let t0 = Instant::now();
        let mut until = None;
        assert!(fold_now(false, t0, &mut until), "nothing wants it: folded");
        assert!(!fold_now(true, t0, &mut until), "hovered: open at once");
        assert!(!fold_now(false, t0 + Duration::from_millis(200), &mut until), "just left: still open");
        assert!(!fold_now(true, t0 + Duration::from_millis(300), &mut until), "came back: open");
        assert!(!fold_now(false, t0 + Duration::from_millis(700), &mut until), "grace counts from the last hover");
        assert!(fold_now(false, t0 + Duration::from_millis(900), &mut until), "away long enough: folded");
        assert!(until.is_none());
    }

    #[test]
    fn a_fold_eases_to_its_height_and_ends_exactly_there() {
        let t0 = Instant::now();
        assert_eq!(fold_height(36.0, 520.0, t0, t0), (36.0, false));
        let (mid, done) = fold_height(36.0, 520.0, t0, t0 + Duration::from_millis(60));
        assert!(!done && mid > 36.0 && mid < 520.0);
        assert_eq!(fold_height(36.0, 520.0, t0, t0 + Duration::from_millis(400)), (520.0, true));
        let (down, _) = fold_height(520.0, 36.0, t0, t0 + Duration::from_millis(60));
        assert!(down < 520.0 && down > 36.0);
    }

    #[test]
    fn bar_text_is_cut_to_fit_with_an_ellipsis() {
        let ctx = egui::Context::default();
        let _ = ctx.run(egui::RawInput::default(), |ctx| {
            let font = theme::font(theme::FS_S);
            let long = "请先导入融图工作流（含融图 LoRA）。「导入工作流」里有 WavePlug 内置工作流";
            let cut = fit_text(ctx, long, &font, 80.0);
            assert!(cut.ends_with('…') && cut.chars().count() < long.chars().count());
            assert_eq!(fit_text(ctx, "就绪", &font, 80.0), "就绪");
        });
    }
}

struct Toast {
    title: String,
    text: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    view: Option<ScreenRect>,
    until: Instant,
    /// the notice's window has been put in the corner
    placed: bool,
}

/// A notice in the corner of Photoshop's window (from another thread: hang.rs).
pub fn notify(title: &str, text: &str) {
    on_command(Command::Toast { title: title.into(), text: text.into(), view: None, ms: 8000 });
}

/// Wake the UI thread (the drag engine queued an event).
pub fn wake() {
    if let Some(ctx) = CTX.get() {
        ctx.request_repaint();
    }
}

impl Host {
    /// What the drag engine decided: a drop becomes the surface's own action, the end of a
    /// reference drag is reported to the plugin (finish-layer-drag) as before.
    fn take_drag_events(&mut self) {
        for e in crate::drag::take_events() {
            match e {
                crate::drag::Event::Dropped { surface: crate::drag::session::TRASH, .. } => {
                    crate::log::line("trash drop");
                    server::send(&Event::LayerDragTrashDrop);
                }
                crate::drag::Event::Dropped { surface: shelf::ID, reference, .. } => {
                    // the plugin knows every layer it was dragging (groups too); these are a hint
                    let ids: Vec<u32> = reference.layers.iter().map(|l| l.layer_id).collect();
                    server::send(&Event::Action {
                        panel: shelf::ID.to_string(),
                        action: serde_json::json!({ "kind": "stage-drop", "docId": reference.doc_id, "layerIds": ids }),
                    });
                }
                crate::drag::Event::Ended { ending } => {
                    if let Some(keys) = self.shelf_drag.take() {
                        #[cfg(windows)]
                        let over_ps = {
                            let (x, y) = crate::win::cursor_pos();
                            crate::win::photoshop_under(x, y)
                        };
                        #[cfg(not(windows))]
                        let over_ps = false;
                        crate::log::line(format!("workbench drag out ended: {ending} over_photoshop={over_ps} entries={}", keys.len()));
                        if ending == "released" && over_ps {
                            server::send(&Event::Action { panel: shelf::ID.to_string(), action: serde_json::json!({ "kind": "drop-into-ps", "keys": keys }) });
                        }
                        server::send(&Event::Action { panel: shelf::ID.to_string(), action: serde_json::json!({ "kind": "drag-out-end", "ending": ending }) });
                    }
                }
                crate::drag::Event::Dropped { surface, target, reference } => {
                    if let Some(i) = self.index(surface) {
                        for action in self.surfaces[i].external_drop(target, &reference) {
                            server::send(&Event::Action { panel: surface.to_string(), action });
                        }
                    }
                }
                crate::drag::Event::Finished => {
                    for surface in &mut self.surfaces {
                        if surface.id() == "generate" {
                            surface.set_external_layer_drag(None);
                            server::send(&Event::Action {
                                panel: surface.id().to_string(),
                                action: serde_json::json!({ "kind": "finish-layer-drag" }),
                            });
                        }
                    }
                }
                crate::drag::Event::Hover => {} // this frame redraws the highlight
                crate::drag::Event::ExternalFinished { session_id, status, effect, target, count } => {
                    server::send(&Event::ExternalDragFinished { session_id, status, effect, target, count });
                }
                crate::drag::Event::ExternalWanted => server::send(&Event::ExternalDragWanted),
            }
        }
    }

    fn index(&self, panel: &str) -> Option<usize> {
        self.surfaces.iter().position(|s| s.id() == panel)
    }

    fn take_commands(&mut self, ctx: &egui::Context) {
        let commands: Vec<Command> = INBOX
            .lock()
            .map(|mut q| q.drain(..).collect())
            .unwrap_or_default();
        for c in commands {
            match c {
                Command::ManageComfy { .. } => {} // handled on the server thread, never enters the UI queue
                Command::HoverFrame { .. } => {} // frame.rs, on its own thread
                Command::Canvas { .. } => {}     // win.rs relayout, on the server thread
                Command::HoverTint { .. } => {}  // frame.rs, on its own thread
                Command::PanelAnchor => {}       // win.rs, on the server thread
                Command::IssueRows { .. } => {}  // frame.rs, on its own thread
                Command::MenuOpen { .. } | Command::MenuClose { .. } => {} // menu.rs, on its own thread
                Command::RestartHelper => {}     // life.rs, on its own thread
                Command::UpdateNow => {}         // autoupdate.rs, on its own thread
                Command::Monitor { .. } => {}    // monitor.rs, on its own thread
                Command::HangGuard { .. } => {}  // hang.rs, on its own thread
                Command::WebCatch { .. } => {}   // webdrop.rs, on its own thread
                Command::WatchKeys { .. } => {}  // keys.rs, on its own thread
                Command::Hotkeys { .. } => {}    // hotkey.rs, on its own thread
                Command::StatusBar { .. } => {}  // monitor.rs, on its own thread
                Command::AppSettings { .. } | Command::OpenApp { .. } => {} // app.rs
                Command::ExternalDragPrepare { .. }
                | Command::ExternalDragReady { .. }
                | Command::ExternalDragCancel { .. }
                | Command::ExternalDragProgress { .. } => {} // the drag engine, from the server thread
                Command::Hello => {
                    self.revs.clear();
                    crate::drag::send(crate::drag::Cmd::Cancel);
                    for surface in &mut self.surfaces {
                        surface.set_external_layer_drag(None);
                    }
                }
                Command::LayerDragStart {
                    doc_id,
                    mut layers,
                    total_count,
                    layer_id,
                    name,
                    thumb: _,
                } => {
                    if layers.is_empty() {
                        if let (Some(layer_id), Some(name)) = (layer_id, name) {
                            layers.push(DraggedLayer { layer_id, name, thumb: None });
                        }
                    }
                    layers.truncate(crate::panel::generate::state::MAX_REFERENCE_SLOTS as usize);
                    if !layers.is_empty() {
                        let drag = crate::panel::ExternalLayerDrag {
                            doc_id,
                            total_count: total_count.max(layers.len()),
                            layers,
                        };
                        crate::drag::send(crate::drag::Cmd::Reference(crate::drag::Reference {
                            doc_id: drag.doc_id,
                            layers: drag.layers.clone(),
                            total_count: drag.total_count,
                        }));
                        for surface in &mut self.surfaces {
                            if surface.id() == "generate" {
                                surface.set_external_layer_drag(Some(drag.clone()));
                            }
                        }
                    }
                }
                Command::LayerDragCancel => {
                    crate::drag::send(crate::drag::Cmd::Cancel);
                    for surface in &mut self.surfaces {
                        surface.set_external_layer_drag(None);
                    }
                }
                // The card and the native drop targets live on the drag engine's thread (drag/).
                Command::LayerDragPreviewStart { mut layers, total_count } => {
                    layers.truncate(8);
                    if !layers.is_empty() {
                        crate::drag::send(crate::drag::Cmd::PreviewStart { layers, total: total_count });
                    }
                }
                Command::LayerDragTrash { view, enabled, action } => {
                    let view = view.filter(|v| v.right > v.left && v.bottom > v.top).map(|v| {
                        (v.left.round() as i32, v.top.round() as i32, v.right.round() as i32, v.bottom.round() as i32)
                    });
                    crate::drag::send(crate::drag::Cmd::Trash { view, enabled, action });
                }
                Command::LayerDragPreviewUpdate { action, tone } => {
                    crate::drag::send(crate::drag::Cmd::Verdict { action, tone });
                }
                Command::LayerDragPreviewEnd => {
                    // a drop decided by the engine carries its own payload, so the panel's drag
                    // state can go now
                    crate::drag::send(crate::drag::Cmd::End);
                    for surface in &mut self.surfaces {
                        surface.set_external_layer_drag(None);
                    }
                }
                Command::State {
                    panel,
                    rev,
                    sections,
                } => {
                    if let Some(which) = assist_id(&panel) {
                        let last = self.revs.entry(panel).or_insert(0);
                        if rev > *last {
                            *last = rev;
                            match which {
                                check::ID => self.check.apply(&sections),
                                organize::ID => self.organize.apply(&sections),
                                _ => self.rewrite.apply(&sections),
                            }
                        }
                        continue;
                    }
                    if panel == variants::ID || panel == shelf::ID {
                        let is_shelf = panel == shelf::ID;
                        let last = self.revs.entry(panel).or_insert(0);
                        if rev > *last {
                            *last = rev;
                            if is_shelf { self.shelf.apply(&sections) } else { self.variant_rail.apply(&sections) }
                        }
                        continue;
                    }
                    let Some(i) = self.index(&panel) else {
                        continue;
                    };
                    let last = self.revs.entry(panel).or_insert(0);
                    if rev <= *last {
                        continue;
                    } // out of date
                    *last = rev;
                    self.surfaces[i].apply(&sections);
                }
                Command::Show { panel, view } => {
                    if let Some(which) = assist_id(&panel) {
                        // one window for all three: the last shown is the one it shows
                        self.assist = Some(which);
                        self.check_placed = false;
                        continue;
                    }
                    if panel == shelf::ID {
                        self.shelf_shown = true;
                        self.shelf_view = view;
                        self.shelf_placed = false;
                        continue;
                    }
                    if panel == variants::ID {
                        self.variant_shown = true;
                        self.variant_view = view;
                        self.variant_placed = false;
                        continue;
                    }
                    let next = self.index(&panel);
                    if self.current != next {
                        // A hidden surface must not carry an old text-field focus into its next show.
                        ctx.memory_mut(|mem| mem.stop_text_input());
                        self.typing = false;
                    }
                    self.current = next;
                    self.collapsed = true;
                    self.open_until = None;
                    if !cfg!(windows) {
                        ctx.send_viewport_cmd(ViewportCommand::Visible(true));
                    }
                }
                Command::Toast {
                    title,
                    text,
                    view,
                    ms,
                } => {
                    self.toast = Some(Toast {
                        title,
                        text,
                        view,
                        until: Instant::now() + Duration::from_millis(ms),
                        placed: false,
                    });
                }
                Command::Hide { panel } => {
                    if let Some(which) = assist_id(&panel) {
                        if self.assist == Some(which) {
                            self.assist = None;
                            self.check_placed = false;
                            crate::frame::set_leader(None);
                            crate::frame::set_leader_rows(Vec::new(), None);
                            if self.assist_typing {
                                self.assist_typing = false;
                                #[cfg(windows)]
                                crate::win::check_set_typing(false);
                            }
                            #[cfg(windows)]
                            crate::win::check_hide();
                        }
                        continue;
                    }
                    if panel == shelf::ID {
                        self.shelf_shown = false;
                        self.shelf_placed = false;
                        crate::drag::targets::publish(shelf::ID, Vec::new());
                        #[cfg(windows)]
                        crate::win::shelf_hide();
                        continue;
                    }
                    if panel == variants::ID {
                        self.variant_shown = false;
                        self.variant_placed = false;
                        // its window goes with it; the next one is made at the size wanted then
                        self.variant_made_size = None;
                        #[cfg(windows)]
                        crate::win::variant_hide();
                        continue;
                    }
                    if self.current.is_some() && self.current == self.index(&panel) {
                        self.current = None;
                        self.collapsed = true;
                        self.open_until = None;
                        self.typing = false;
                        ctx.memory_mut(|mem| mem.stop_text_input());
                        if !cfg!(windows) {
                            ctx.send_viewport_cmd(ViewportCommand::Visible(false));
                        }
                    }
                }
            }
        }
    }
}

impl Host {
    /// The small grip in the bottom-right corner: the only way to move the panel. Where it is let
    /// go is kept for the next time the panel comes up (win.rs).
    fn grip(&mut self, ctx: &egui::Context) {
        // A slightly larger hit target makes the corner reliable without changing the
        // three-line visual marker. Native movement is manual so WS_EX_NOACTIVATE is preserved.
        const SIZE: f32 = 20.0;
        let screen = ctx.screen_rect();
        let rect = egui::Rect::from_min_size(
            screen.max - egui::vec2(SIZE + 2.0, SIZE + 2.0),
            egui::vec2(SIZE, SIZE),
        );
        egui::Area::new(Id::new("grip"))
            .fixed_pos(rect.min)
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                let (rect, resp) = ui.allocate_exact_size(egui::vec2(SIZE, SIZE), Sense::drag());
                let color = if resp.hovered() || self.dragging {
                    theme::ACCENT_HI
                } else {
                    theme::TEXT_3
                };
                for k in [6.0, 11.0, 16.0] {
                    ui.painter().line_segment(
                        [
                            egui::pos2(rect.right() - k, rect.bottom() - 1.0),
                            egui::pos2(rect.right() - 1.0, rect.bottom() - k),
                        ],
                        Stroke::new(1.2_f32, color),
                    );
                }
                let resp = resp
                    .on_hover_cursor(egui::CursorIcon::Move)
                    .on_hover_text("拖动这里移动面板");
                if resp.drag_started() {
                    self.dragging = true;
                    #[cfg(windows)]
                    crate::win::drag_started();
                    crate::log::line("generate grip drag started");
                }
                if resp.dragged() {
                    // Use the physical screen cursor and the drag's original window position.
                    // egui's local pointer delta changes when the native window itself moves.
                    #[cfg(windows)]
                    crate::win::drag_to_cursor();
                }
            });
        if self.dragging && !ctx.input(|i| i.pointer.any_down()) {
            self.dragging = false;
            #[cfg(windows)]
            crate::win::drag_finished();
        }
    }

    /// A text box in the surface started / stopped wanting the keyboard: only then does the
    /// window take it from Photoshop (win.rs `set_typing`); otherwise Photoshop keeps it.
    #[cfg(windows)]
    fn track_typing(&mut self, ctx: &egui::Context) {
        if crate::win::take_focus_lost() {
            // Clicking back into Photoshop does not send a pointer event to this window.
            // Clear egui's stale TextEdit focus so a later click into the field can request it again.
            ctx.memory_mut(|mem| mem.stop_text_input());
            self.typing = false;
            crate::log::line("overlay text focus cleared after native focus loss");
            return;
        }
        let typing = self.current.is_some() && ctx.wants_keyboard_input();
        if typing != self.typing {
            self.typing = typing;
            crate::win::set_typing(typing);
        }
    }

    /// The window's height and how much of it shows. `open`: the open panel's content height when
    /// it was drawn this frame. On Windows the window keeps the open height and folding only
    /// changes the window region (win.rs `clip_panel`), eased over RESIZE_SECS: resizing the
    /// window every frame rebuilt its GPU surface and made the bar and the content jump. Elsewhere
    /// (the Mac, for trying things) the window just takes the new height.
    fn fit(&mut self, ctx: &egui::Context, open: Option<f32>) {
        let bar_h = COLLAPSED_BAR_HEIGHT + 2.0;
        if let Some(c) = open {
            self.open_h = (c + 2.0).round();
        }
        let open_h = if self.open_h > 0.0 { self.open_h } else { bar_h };
        let now = Instant::now();
        #[cfg(windows)]
        {
            if (open_h - self.height).abs() >= 1.0 {
                self.height = open_h;
                CONTENT_H.store(open_h.to_bits(), Ordering::SeqCst);
            }
            // every frame, not only when the height changed: a change that came while the window
            // was between two surfaces (hidden for a moment) was skipped there and never made up,
            // leaving the next surface at the last one's height. fit_height returns at once when
            // the window already has this height.
            crate::win::fit_height(open_h);
            let target = if self.collapsed { bar_h } else { open_h };
            if (target - self.vis_to).abs() >= 1.0 {
                self.fold = (self.vis > 0.0 && crate::win::panel_on_screen()).then(|| (self.vis, target, now));
                self.vis_to = target;
            }
            self.vis = match self.fold {
                Some((from, to, since)) => {
                    let (h, done) = fold_height(from, to, since, now);
                    if done {
                        self.fold = None;
                    } else {
                        ctx.request_repaint();
                    }
                    h
                }
                None => target,
            };
            crate::win::clip_panel((self.vis < self.height - 0.5).then_some(self.vis));
        }
        #[cfg(not(windows))]
        {
            let want = if self.collapsed { bar_h } else { open_h };
            self.fold = None;
            self.vis = want;
            self.vis_to = want;
            if (want - self.height).abs() >= 1.0 {
                self.height = want;
                CONTENT_H.store(want.to_bits(), Ordering::SeqCst);
                ctx.send_viewport_cmd(ViewportCommand::InnerSize(egui::vec2(ctx.screen_rect().width(), want)));
            }
        }
        let _ = (ctx, now);
    }

    /// 卡死保护 (hang.rs): Photoshop stopped answering. Its own window in the middle of Photoshop's,
    /// activatable (Photoshop can't take the keyboard now anyway); gone when Photoshop answers again.
    fn hang_dialog(&mut self, ctx: &egui::Context) {
        use crate::hang::Choice;
        let Some(d) = crate::hang::dialog() else {
            self.hang_placed = false;
            return;
        };
        let builder = egui::ViewportBuilder::default()
            .with_title(HANG_TITLE)
            .with_inner_size(HANG_SIZE)
            .with_decorations(false)
            .with_taskbar(false)
            .with_resizable(false)
            .with_always_on_top();
        #[cfg(windows)]
        let builder = builder.with_position([crate::win::PARK.0 as f32, crate::win::PARK.1 as f32]);
        let picked = ctx.show_viewport_immediate(egui::ViewportId::from_hash_of("hang"), builder, |ctx, _| {
            let mut picked: Option<Choice> = None;
            egui::CentralPanel::default()
                .frame(
                    Frame::new()
                        .fill(theme::SURFACE)
                        .stroke(Stroke::new(2.0_f32, theme::WARN))
                        .inner_margin(Margin::symmetric(16, 14)),
                )
                .show(ctx, |ui| {
                    ui.label(egui::RichText::new("Photoshop 没有响应").font(theme::font_bold(theme::FS_L)).color(theme::WARN));
                    ui.label(format!("已经 {} 秒没有响应。可能还在处理大文件，也可能已经卡死。", d.seconds));
                    ui.add_space(4.0);
                    let backup = if d.busy {
                        "正在备份自动恢复文件…".to_string()
                    } else {
                        d.backup.clone().unwrap_or_else(|| "还没有备份自动恢复文件。".into())
                    };
                    ui.label(egui::RichText::new(backup).color(theme::TEXT));
                    ui.label(
                        egui::RichText::new("自动恢复文件是 Photoshop 定时自动存储的内容（首选项 › 文件处理），只包含上次自动存储时的修改。")
                            .size(theme::FS_S)
                            .color(theme::TEXT_3),
                    );
                    ui.add_space(6.0);
                    let idle = !d.busy && !d.closing;
                    if d.closing {
                        ui.label(egui::RichText::new(if d.busy { "备份完成后关闭 Photoshop…" } else { "正在关闭 Photoshop…" }).color(theme::TEXT_2));
                    } else if d.confirm_close {
                        ui.label(egui::RichText::new("确定强制关闭 Photoshop？没有保存、也不在自动恢复文件里的修改都会丢失。").color(theme::ERR));
                        ui.horizontal(|ui| {
                            if ui.add_enabled(idle, egui::Button::new("备份后关闭")).clicked() {
                                picked = Some(Choice::Close { backup: true });
                            }
                            if ui.add_enabled(idle, egui::Button::new("直接关闭")).clicked() {
                                picked = Some(Choice::Close { backup: false });
                            }
                            if ui.button("取消").clicked() {
                                picked = Some(Choice::CancelClose);
                            }
                        });
                    } else {
                        ui.horizontal(|ui| {
                            if ui.button("继续等待").clicked() {
                                picked = Some(Choice::Wait);
                            }
                            let again = if d.backup.is_some() { "再备份一次" } else { "备份恢复文件" };
                            if ui.add_enabled(idle, egui::Button::new(again)).clicked() {
                                picked = Some(Choice::Backup);
                            }
                            if d.backup_dir.is_some() && ui.button("打开备份位置").clicked() {
                                picked = Some(Choice::OpenBackup);
                            }
                            if ui.add_enabled(idle, egui::Button::new("关闭 Photoshop…")).clicked() {
                                picked = Some(Choice::AskClose);
                            }
                        });
                    }
                });
            picked
        });
        if let Some(c) = picked {
            crate::hang::choose(c);
        }
        #[cfg(windows)]
        if !self.hang_placed {
            self.hang_placed = crate::win::place_dialog(HANG_TITLE, HANG_SIZE);
        }
        // the seconds count up and the backup's result comes from another thread
        ctx.request_repaint_after(Duration::from_millis(500));
    }

    /// The completion notice: its own small window in the canvas's bottom-right corner, yellow
    /// frame, until its time is up or it is clicked.
    fn notice(&mut self, ctx: &egui::Context) {
        let Some(t) = &mut self.toast else { return };
        let now = Instant::now();
        if now >= t.until {
            self.toast = None;
            return;
        }
        let builder = egui::ViewportBuilder::default()
            .with_title(TOAST_TITLE)
            .with_inner_size(TOAST_SIZE)
            .with_decorations(false)
            .with_taskbar(false)
            .with_resizable(false)
            .with_active(false);
        #[cfg(windows)]
        let builder = builder.with_position([crate::win::PARK.0 as f32, crate::win::PARK.1 as f32]);
        #[cfg(not(windows))]
        let builder = builder.with_always_on_top();
        let (title, text) = (t.title.clone(), t.text.clone());
        let dismissed = ctx.show_viewport_immediate(
            egui::ViewportId::from_hash_of("toast"),
            builder,
            |ctx, _| {
                let mut clicked = false;
                egui::CentralPanel::default()
                    .frame(
                        Frame::new()
                            .fill(theme::SURFACE)
                            .stroke(Stroke::new(2.0_f32, theme::WARN))
                            .inner_margin(Margin::symmetric(12, 10)),
                    )
                    .show(ctx, |ui| {
                        if ui
                            .interact(ui.max_rect(), Id::new("toast-click"), Sense::click())
                            .clicked()
                        {
                            clicked = true;
                        }
                        ui.label(
                            egui::RichText::new(&title)
                                .font(theme::font_bold(theme::FS_L))
                                .color(theme::WARN),
                        );
                        ui.label(
                            egui::RichText::new(&text)
                                .size(theme::FS)
                                .color(theme::TEXT),
                        );
                    });
                clicked
            },
        );
        if dismissed {
            self.toast = None;
            return;
        }
        if !t.placed {
            #[cfg(windows)]
            {
                t.placed = crate::win::place_toast(t.view, TOAST_SIZE);
            }
            #[cfg(not(windows))]
            {
                t.placed = true;
            }
        }
        ctx.request_repaint_after((t.until - now).min(std::time::Duration::from_millis(250)));
    }
}

impl Host {
    fn variant_viewport(&mut self, ctx: &egui::Context) {
        if !self.variant_shown {
            return;
        }
        // Width follows thumbnail scale. Height follows content, clipped to 50% of the
        // Photoshop editing region; the bottom grip can only make it smaller for scrolling.
        let width = self.variant_rail.desired_width();
        let natural_height = self.variant_rail.content_height();
        #[cfg(windows)]
        let max_height = crate::win::variant_max_logical_height(self.variant_view);
        #[cfg(not(windows))]
        let max_height = 400.0;
        let height = natural_height.min(max_height).max(1.0);
        // The size the window is made with, kept as it was: a builder whose size changes makes
        // egui resize the window too, every frame, fighting win.rs (variant_apply_size), which
        // is the one place that sizes it on Windows.
        #[cfg(windows)]
        let made = *self.variant_made_size.get_or_insert(egui::vec2(width, height));
        #[cfg(not(windows))]
        let made = egui::vec2(width, height);
        let builder = egui::ViewportBuilder::default()
            .with_title(variants::TITLE)
            .with_inner_size(made)
            .with_min_inner_size(egui::vec2(64.0, 40.0))
            .with_decorations(false)
            .with_taskbar(false)
            .with_resizable(true)
            .with_active(false);
        #[cfg(windows)]
        let builder = builder.with_position([crate::win::PARK.0 as f32, crate::win::PARK.1 as f32]);
        #[cfg(not(windows))]
        let builder = builder.with_always_on_top();
        let actions = ctx.show_viewport_immediate(
            egui::ViewportId::from_hash_of("waveplug-variants"),
            builder,
            |viewport_ctx, _| self.variant_rail.draw(viewport_ctx),
        );
        // New native child viewports are materialised AFTER their first egui frame.
        #[cfg(windows)]
        {
            if !self.variant_placed || !crate::win::variant_window_exists() {
                self.variant_placed = crate::win::variant_place(self.variant_view);
                if !self.variant_placed {
                    ctx.request_repaint_after(Duration::from_millis(200));
                }
            }
            if self.variant_placed {
                // Explicit Win32 resize is required because egui's viewport builder is
                // only applied on creation. Enforce content/half-editor height on Windows.
                crate::win::variant_sync_width(self.variant_rail.desired_width());
                crate::win::variant_sync_height(self.variant_rail.content_height());
                if crate::win::variant_apply_size() {
                    ctx.request_repaint();
                }
            }
        }
        for action in actions {
            server::send(&Event::Action {
                panel: variants::ID.to_string(),
                action,
            });
        }
    }
}

impl Host {
    /// The window beside the 图层 panel: 检查结果 or AI 整理 (whichever was shown last), its own
    /// viewport like the workbench; win.rs keeps it beside the panel.
    fn check_viewport(&mut self, ctx: &egui::Context) {
        let Some(which) = self.assist else { return };
        let builder = egui::ViewportBuilder::default()
            .with_title(check::TITLE)
            .with_inner_size(egui::vec2(check::WIDTH, 480.0))
            .with_decorations(false)
            .with_taskbar(false)
            .with_resizable(false)
            .with_active(false);
        #[cfg(windows)]
        let builder = builder.with_position([crate::win::PARK.0 as f32, crate::win::PARK.1 as f32]);
        #[cfg(not(windows))]
        let builder = builder.with_always_on_top();
        let actions = ctx.show_viewport_immediate(egui::ViewportId::from_hash_of("waveplug-check"), builder, |viewport_ctx, _| match which {
            check::ID => self.check.draw(viewport_ctx),
            organize::ID => self.organize.draw(viewport_ctx),
            _ => self.rewrite.draw(viewport_ctx),
        });
        let (folded, edges, typing) = match which {
            check::ID => (self.check.folded, self.check.hover_edges, false),
            organize::ID => (self.organize.folded, self.organize.hover_edges, self.organize.typing),
            _ => (self.rewrite.folded, self.rewrite.hover_edges, self.rewrite.typing),
        };
        #[cfg(windows)]
        {
            if !self.check_placed || !crate::win::check_window_exists() {
                self.check_placed = crate::win::check_place();
                if !self.check_placed {
                    ctx.request_repaint_after(Duration::from_millis(200));
                }
            }
            crate::win::check_fold(folded);
            // the lines from the hovered row to its layers on the canvas and in the panel (frame.rs)
            let from = edges.zip(crate::win::check_origin()).map(|((l, r, y), (x0, y0))| {
                ((x0 as f32 + l).round() as i32, (x0 as f32 + r).round() as i32, (y0 as f32 + y).round() as i32)
            });
            crate::frame::set_leader(from);
            // typing in AI 整理's field: the window takes the keyboard from Photoshop, then gives it back
            if typing != self.assist_typing {
                self.assist_typing = typing;
                crate::win::check_set_typing(typing);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (folded, edges, typing);
            crate::frame::set_leader(None);
        }
        for action in actions {
            server::send(&Event::Action { panel: which.to_string(), action });
        }
    }

    /// The 编辑工作台 window: its own viewport like the variant rail, a drop target for every
    /// WaveLayer drag while it is on screen, and the start of drags out of it.
    fn shelf_viewport(&mut self, ctx: &egui::Context) {
        if !self.shelf_shown {
            return;
        }
        let band = crate::drag::active() && self.shelf_drag.is_none();
        let hot = band && crate::drag::hovered() == Some((shelf::ID, 0));
        let size = egui::vec2(shelf::WIDTH, self.shelf.content_height(band));
        let builder = egui::ViewportBuilder::default()
            .with_title(shelf::TITLE)
            .with_inner_size(size)
            .with_decorations(false)
            .with_taskbar(false)
            .with_resizable(false)
            .with_active(false);
        #[cfg(windows)]
        let builder = builder.with_position([crate::win::PARK.0 as f32, crate::win::PARK.1 as f32]);
        #[cfg(not(windows))]
        let builder = builder.with_always_on_top();
        let (actions, drag_out) = ctx.show_viewport_immediate(
            egui::ViewportId::from_hash_of("waveplug-workbench"),
            builder,
            |viewport_ctx, _| self.shelf.draw(viewport_ctx, band, hot),
        );
        #[cfg(windows)]
        {
            if !self.shelf_placed || !crate::win::shelf_window_exists() {
                self.shelf_placed = crate::win::shelf_place(self.shelf_view);
                if !self.shelf_placed {
                    ctx.request_repaint_after(Duration::from_millis(200));
                }
            }
            crate::win::shelf_sync(size.x, size.y);
            let targets = if band {
                crate::win::shelf_screen_rect()
                    .map(|rect| vec![crate::drag::targets::Target { surface: shelf::ID, id: 0, rect, action: "加入工作台".into() }])
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            crate::drag::targets::publish(shelf::ID, targets);
        }
        if let Some(d) = drag_out {
            if !crate::drag::active() && !d.keys.is_empty() {
                let total = d.keys.len();
                let layers = d.names.iter().take(8).enumerate().map(|(i, name)| DraggedLayer {
                    layer_id: 0,
                    name: name.clone(),
                    thumb: if i == 0 { d.thumb.clone() } else { None },
                }).collect();
                crate::drag::send(crate::drag::Cmd::PreviewStart { layers, total });
                crate::drag::send(crate::drag::Cmd::Verdict { action: "置入当前 PSD".into(), tone: "workbench".into() });
                crate::log::line(format!("workbench drag out start entries={total}"));
                server::send(&Event::Action { panel: shelf::ID.to_string(), action: serde_json::json!({ "kind": "drag-out", "keys": d.keys }) });
                self.shelf_drag = Some(d.keys);
            }
        }
        if self.shelf_drag.is_some() || band {
            ctx.request_repaint_after(Duration::from_millis(50));
        }
        for action in actions {
            server::send(&Event::Action { panel: shelf::ID.to_string(), action });
        }
    }
}

/// `text` cut to `max` wide (points) with an ellipsis, as `font` draws it.
fn fit_text(ctx: &egui::Context, text: &str, font: &egui::FontId, max: f32) -> String {
    let width = |t: &str| ctx.fonts(|f| f.layout_no_wrap(t.to_string(), font.clone(), egui::Color32::WHITE).size().x);
    if width(text) <= max {
        return text.to_string();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while !chars.is_empty() {
        chars.pop();
        let cut: String = chars.iter().collect::<String>() + "…";
        if width(&cut) <= max {
            return cut;
        }
    }
    "…".to_string()
}

/// The generate panel's bar: ✦ 生图 · <mode> on the left; folded, what is going on on the right
/// (and a run's progress along its bottom edge); open, the 固定 button (and room for the grip).
/// Returns whether 固定 was clicked.
fn bar(ui: &mut egui::Ui, info: &crate::panel::BarInfo, collapsed: bool, pinned: bool) -> bool {
    use crate::panel::BarTone;
    use egui::{pos2, vec2, Align2, CornerRadius, Rect};
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), BAR_HEIGHT), Sense::hover());
    let hovered = resp.hovered();
    let p = ui.painter().clone();
    let fill = if collapsed && hovered { theme::HOVER } else { theme::SURFACE };
    p.rect_filled(rect, CornerRadius::same(theme::R), fill);
    p.rect_stroke(
        rect,
        CornerRadius::same(theme::R),
        Stroke::new(1.0_f32, if collapsed && hovered { theme::LINE } else { theme::LINE_SOFT }),
        egui::StrokeKind::Inside,
    );
    // ✦ 生图 · 局部重绘
    let mut x = rect.left() + 10.0;
    let cy = rect.center().y;
    spark_icon(&p, pos2(x + 5.0, cy), 5.0, theme::ACCENT_HI);
    x += 16.0;
    let title = p.layout_no_wrap("生图".into(), theme::font_bold(theme::FS), theme::TEXT);
    let tw = title.size().x;
    p.galley(pos2(x, cy - title.size().y / 2.0), title, theme::TEXT);
    x += tw + 6.0;
    p.circle_filled(pos2(x, cy), 1.5, theme::TEXT_3);
    x += 6.0;
    let mode = p.layout_no_wrap(info.mode.clone(), theme::font(theme::FS), theme::ACCENT_HI);
    let mw = mode.size().x;
    p.galley(pos2(x, cy - mode.size().y / 2.0), mode, theme::ACCENT_HI);
    x += mw + 12.0;

    let mut pin_clicked = false;
    if collapsed {
        // what is going on, right-aligned and cut to the room that is left
        let color = match info.tone {
            BarTone::Ok => theme::TEXT_3,
            BarTone::Quiet => theme::TEXT_3,
            BarTone::Busy => theme::ACCENT_HI,
            BarTone::Warn => theme::WARN,
            BarTone::Error => theme::ERR,
        };
        let dot = match info.tone {
            BarTone::Ok => Some(theme::OK),
            BarTone::Busy => Some(theme::ACCENT_HI),
            BarTone::Warn => Some(theme::WARN),
            BarTone::Error => Some(theme::ERR),
            BarTone::Quiet => None,
        };
        let right = rect.right() - 10.0;
        let room = right - x - if dot.is_some() { 10.0 } else { 0.0 };
        if room > 16.0 {
            let font = theme::font(theme::FS_S);
            let text = fit_text(ui.ctx(), &info.text, &font, room);
            let g = p.layout_no_wrap(text, font, color);
            let left = right - g.size().x;
            if let Some(c) = dot {
                p.circle_filled(pos2(left - 7.0, cy), 3.0, c);
            }
            p.galley(pos2(left, cy - g.size().y / 2.0), g, color);
        }
        if info.text.chars().count() > 0 {
            resp.clone().on_hover_text(&info.text);
        }
        if let Some(r) = info.progress {
            let line = Rect::from_min_size(
                pos2(rect.left() + 2.0, rect.bottom() - 3.0),
                vec2((rect.width() - 4.0) * r.clamp(0.0, 1.0), 2.0),
            );
            p.rect_filled(line, CornerRadius::same(1), theme::ACCENT);
            ui.ctx().request_repaint_after(Duration::from_millis(200));
        }
    } else {
        // 固定 / 已固定, left of the grip's corner
        let label = if pinned { "已固定" } else { "固定" };
        let g = p.layout_no_wrap(label.into(), theme::font(theme::FS_S), theme::TEXT);
        let w = g.size().x + 16.0;
        let btn = Rect::from_min_size(
            pos2(rect.right() - GRIP_ROOM - w, rect.top() + 3.0),
            vec2(w, BAR_HEIGHT - 6.0),
        );
        let r = ui.interact(btn, ui.id().with("pin"), Sense::click());
        let (bg, ink, line) = if pinned {
            (theme::ACCENT_WASH, theme::ACCENT_HI, theme::ACCENT)
        } else if r.hovered() {
            (theme::HOVER, theme::TEXT, theme::LINE)
        } else {
            (egui::Color32::TRANSPARENT, theme::TEXT_2, theme::LINE)
        };
        p.rect_filled(btn, CornerRadius::same(theme::R), bg);
        p.rect_stroke(btn, CornerRadius::same(theme::R), Stroke::new(1.0_f32, line), egui::StrokeKind::Inside);
        p.text(btn.center(), Align2::CENTER_CENTER, label, theme::font(theme::FS_S), ink);
        pin_clicked = r.clicked();
        r.on_hover_text(if pinned { "取消固定：鼠标移开后收起" } else { "固定展开：鼠标移开也不收起" });
    }
    pin_clicked
}

/// ✦ (the same star as the 开始 button)
fn spark_icon(p: &egui::Painter, c: egui::Pos2, r: f32, color: egui::Color32) {
    let s = Stroke::new(1.5_f32, color);
    for (dx, dy) in [(0.0f32, 1.0f32), (1.0, 0.0), (0.7, 0.7), (0.7, -0.7)] {
        p.line_segment([egui::pos2(c.x - dx * r, c.y - dy * r), egui::pos2(c.x - dx * r * 0.35, c.y - dy * r * 0.35)], s);
        p.line_segment([egui::pos2(c.x + dx * r * 0.35, c.y + dy * r * 0.35), egui::pos2(c.x + dx * r, c.y + dy * r)], s);
    }
}

impl eframe::App for Host {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.take_commands(ctx);
        self.take_drag_events();
        // egui's hover, and on Windows the real cursor over the window too: a window that never
        // takes the foreground can miss the first move into it, and the bar must open on that
        #[cfg(windows)]
        let pointer_inside = ctx.input(|i| i.pointer.hover_pos().is_some())
            || crate::win::cursor_in_panel_reveal_zone(0.0);
        #[cfg(not(windows))]
        let pointer_inside = ctx.input(|i| i.pointer.hover_pos().is_some());
        let pointer_down = ctx.input(|i| i.pointer.any_down());
        let keep_open = self.typing
            || self.dragging
            || self.pinned
            || self.current.map(|i| self.surfaces[i].keep_expanded()).unwrap_or(false);
        // Any WaveLayer drag (groups and effects too) opens the bar when it nears the panel.
        let external_drag = crate::drag::active();
        #[cfg(windows)]
        let dragging_over_reveal_zone = external_drag
            && crate::win::cursor_in_panel_reveal_zone(DRAG_REVEAL_ZONE_HEIGHT);
        #[cfg(not(windows))]
        let dragging_over_reveal_zone = external_drag && pointer_inside;
        let wanted = self.current.is_some()
            && should_expand_generate_panel(pointer_inside, pointer_down, keep_open, dragging_over_reveal_zone);
        let now = Instant::now();
        self.collapsed = self.current.is_none() || fold_now(wanted, now, &mut self.open_until);
        if !self.collapsed && !wanted {
            // the grace is running: look again when it is over (nothing else may come)
            if let Some(t) = self.open_until {
                ctx.request_repaint_after(t.saturating_duration_since(now) + Duration::from_millis(10));
            }
        } else if !self.collapsed && pointer_inside {
            // keep watching the cursor (the Windows check above has no event of its own)
            ctx.request_repaint_after(Duration::from_millis(120));
        }
        if self.collapsed {
            // a collapsed or hidden panel has no slots on screen to drop on
            crate::drag::targets::publish("generate", Vec::new());
        }
        if external_drag {
            // the reveal zone is checked here, so look again while the drag lasts
            ctx.request_repaint_after(Duration::from_millis(50));
        }

        let mut sent: Vec<(&'static str, serde_json::Value)> = Vec::new();
        let mut content: Option<f32> = None;
        // the open panel is drawn while it is open and while it folds / unfolds (the region
        // uncovers or covers it from the top); only once folded is it the bar alone
        // (decided before the fold of this frame starts: the frame a fold begins still shows the
        // open panel, so the bar layout never flashes into the full window)
        let collapsed = self.collapsed && self.vis <= COLLAPSED_BAR_HEIGHT + 2.5;
        let mut pin_clicked = false;
        egui::CentralPanel::default()
            .frame(
                Frame::new()
                    .fill(theme::BG)
                    .inner_margin(Margin::same(1)),
            )
            .show(ctx, |ui| {
                let Some(i) = self.current else {
                    ui.label(egui::RichText::new("等待插件…").color(theme::TEXT_3));
                    return;
                };
                let surface = &mut self.surfaces[i];
                let id = surface.id();
                let pinned = self.pinned;
                // The panel sizes itself to its content. Keep ScrollArea only for its
                // content-size measurement: no scrollbars and no parent wheel handling, so
                // the count field can consume the wheel without moving the whole surface.
                let out = egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .enable_scrolling(false)
                    .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden)
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        if collapsed {
                            // the window may still have the open height (Windows): the bar at its
                            // bottom, where the region shows it
                            let gap = ui.ctx().screen_rect().height() - 2.0 - COLLAPSED_BAR_HEIGHT;
                            if gap > 0.0 {
                                ui.add_space(gap);
                            }
                        }
                        if !collapsed {
                            Frame::new()
                                .inner_margin(Margin { left: 8, right: 8, top: 8, bottom: 2 })
                                .show(ui, |ui| {
                                    ui.spacing_mut().item_spacing.y = 4.0;
                                    for a in surface.ui(ui) {
                                        sent.push((id, a));
                                    }
                                });
                        }
                        // the bar: all there is while folded, the footer while open — the same
                        // strip in the same place, so the pointer that opened it is still on it
                        if let Some(info) = surface.bar() {
                            Frame::new()
                                .inner_margin(Margin::same(BAR_PAD as i8))
                                .show(ui, |ui| {
                                    pin_clicked = bar(ui, &info, collapsed, pinned);
                                });
                        }
                    });
                if !collapsed {
                    content = Some(out.content_size.y);
                }
            });
        // the border, around the part that shows
        if self.current.is_some() {
            let screen = ctx.screen_rect();
            let top = (screen.bottom() - self.vis.max(1.0)).max(screen.top());
            let shown = egui::Rect::from_min_max(egui::pos2(screen.left(), top), screen.max);
            ctx.layer_painter(egui::LayerId::new(egui::Order::Foreground, Id::new("panel-border")))
                .rect_stroke(shown, egui::CornerRadius::ZERO, Stroke::new(1.0_f32, theme::LINE), egui::StrokeKind::Inside);
        }
        if pin_clicked {
            self.pinned = !self.pinned;
            if self.pinned {
                self.open_until = None;
            }
            crate::log::line(format!("generate panel pinned {}", self.pinned));
        }
        if self.current.is_some() {
            self.fit(ctx, content);
        }
        if !self.collapsed {
            self.grip(ctx);
        }
        #[cfg(windows)]
        self.track_typing(ctx);
        self.variant_viewport(ctx);
        self.shelf_viewport(ctx);
        self.check_viewport(ctx);
        self.notice(ctx);
        self.hang_dialog(ctx);
        // the WavePlug window (app.rs), made the first time it opens (it looks for Photoshop /
        // Illustrator on the disks)
        if crate::app::is_open() {
            self.app.get_or_insert_with(|| crate::app::AppWindow::new(ctx.clone())).show(ctx);
        }
        if crate::app::quitting() {
            crate::log::line("quit (tray / removed)");
            crate::tray::remove();
            ctx.send_viewport_cmd(ViewportCommand::Close);
        }
        // actions a surface held back (the prompt, once typing pauses)
        let now = Instant::now();
        for s in self.surfaces.iter_mut() {
            let id = s.id();
            for a in s.due(now) {
                sent.push((id, a));
            }
            if let Some(t) = s.next_due() {
                ctx.request_repaint_after(t.saturating_duration_since(now));
            }
        }
        for (panel, action) in sent {
            server::send(&Event::Action {
                panel: panel.to_string(),
                action,
            });
        }
        if self.current.is_some() {
            if let Some(shot) = &mut self.shot {
                shot.frame(ctx, 8);
            }
        }
    }
}
