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
use crate::panel::variants::{self, VariantRail};
use crate::panel::{theme, Surface};
use crate::protocol::{Command, Event, ScreenRect};
use crate::server;

/// The window's title; win.rs finds the window by it, so keep it unique.
pub const TITLE: &str = "WavePlug 外置生成面板";
/// The completion notice's window (an egui viewport), found the same way.
pub const TOAST_TITLE: &str = "WavePlug 提示";
const TOAST_SIZE: egui::Vec2 = egui::vec2(300.0, 70.0);

/// Every surface the helper can show. A new one is added here (and on the plugin's side).
fn surfaces() -> Vec<Box<dyn Surface>> {
    vec![Box::new(GenerateSurface::new())]
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
    } = &c
    {
        crate::comfy::manage(
            path.clone(),
            base.clone(),
            *close_with_photoshop,
            *restart_if_needed,
            *disable_browser,
            *start_if_missing,
        );
        return;
    }
    // the hover frame is its own window: nothing for the UI thread to draw
    if let Command::HoverFrame { rect, clip } = c {
        crate::frame::set(rect, clip);
        return;
    }
    #[cfg(windows)]
    match &c {
        Command::Show { panel, view } if panel != variants::ID => {
            crate::win::show(panel, *view, size_of(panel))
        }
        Command::Hide { panel } if panel != variants::ID => crate::win::hide(panel),
        _ => {} // a variants viewport is controlled separately by Host.update
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
    crate::frame::set(None, None);
    #[cfg(windows)]
    {
        crate::win::hide_all();
        crate::win::variant_hide();
    }
    on_command(Command::Hello);
    on_command(Command::Hide {
        panel: variants::ID.to_string(),
    });
}

pub fn run() {
    crate::log::init();
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
            // a second copy finds the port taken: quit
            if server::start(on_command, on_disconnect).is_err() {
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
                toast: None,
                variant_rail: VariantRail::new(),
                variant_shown: false,
                variant_view: None,
                variant_placed: false,
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
    /// the window height last fitted to the content
    height: f32,
    toast: Option<Toast>,
    variant_rail: VariantRail,
    variant_shown: bool,
    variant_view: Option<ScreenRect>,
    variant_placed: bool,
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

impl Host {
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
                Command::Hello => {
                    self.revs.clear();
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
                    thumb,
                } => {
                    if layers.is_empty() {
                        if let (Some(layer_id), Some(name)) = (layer_id, name) {
                            layers.push(crate::panel::DraggedLayer { layer_id, name });
                        }
                    }
                    layers.truncate(crate::panel::generate::state::MAX_REFERENCE_SLOTS as usize);
                    if !layers.is_empty() {
                        let drag = crate::panel::ExternalLayerDrag {
                            doc_id,
                            total_count: total_count.max(layers.len()),
                            layers,
                            thumb,
                        };
                        for surface in &mut self.surfaces {
                            if surface.id() == "generate" {
                                surface.set_external_layer_drag(Some(drag.clone()));
                            }
                        }
                    }
                }
                Command::LayerDragCancel => {
                    for surface in &mut self.surfaces {
                        surface.set_external_layer_drag(None);
                    }
                }
                Command::State {
                    panel,
                    rev,
                    sections,
                } => {
                    if panel == variants::ID {
                        let last = self.revs.entry(panel).or_insert(0);
                        if rev > *last {
                            *last = rev;
                            self.variant_rail.apply(&sections);
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
                    if panel == variants::ID {
                        self.variant_shown = false;
                        self.variant_placed = false;
                        #[cfg(windows)]
                        crate::win::variant_hide();
                        continue;
                    }
                    if self.current.is_some() && self.current == self.index(&panel) {
                        self.current = None;
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

    /// The window follows the surface's content height (no empty space under it); on Windows its
    /// bottom edge stays put (win.rs `fit_height`).
    fn fit(&mut self, ctx: &egui::Context, content: f32) {
        // 8 px margin above and below, 1 px border
        let want = (content + 18.0).round();
        if (want - self.height).abs() < 1.0 {
            return;
        }
        self.height = want;
        CONTENT_H.store(want.to_bits(), Ordering::SeqCst);
        #[cfg(windows)]
        crate::win::fit_height(want);
        #[cfg(not(windows))]
        ctx.send_viewport_cmd(ViewportCommand::InnerSize(egui::vec2(
            ctx.screen_rect().width(),
            want,
        )));
        let _ = ctx;
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
        let builder = egui::ViewportBuilder::default()
            .with_title(variants::TITLE)
            .with_inner_size(egui::vec2(width, height))
            .with_min_inner_size(egui::vec2(width, height.min(80.0)))
            .with_max_inner_size(egui::vec2(width, height))
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

impl eframe::App for Host {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.take_commands(ctx);
        #[cfg(windows)]
        if self.current.is_none() && (!crate::win::left_button_down() || crate::win::escape_down())
        {
            // If Photoshop selection hid the native panel mid-drag, never leave a stale target.
            let mut finished = Vec::new();
            for surface in &mut self.surfaces {
                if surface.has_external_layer_drag() {
                    surface.set_external_layer_drag(None);
                    finished.push(surface.id());
                }
            }
            for panel in finished {
                server::send(&Event::Action {
                    panel: panel.to_string(),
                    action: serde_json::json!({ "kind": "finish-layer-drag" }),
                });
            }
        }
        let mut sent: Vec<(&'static str, serde_json::Value)> = Vec::new();
        let mut content: Option<f32> = None;
        egui::CentralPanel::default()
            .frame(
                Frame::new()
                    .fill(theme::BG)
                    .stroke(Stroke::new(1.0_f32, theme::LINE))
                    .inner_margin(Margin::same(8)),
            )
            .show(ctx, |ui| {
                let Some(i) = self.current else {
                    ui.label(egui::RichText::new("等待插件…").color(theme::TEXT_3));
                    return;
                };
                let surface = &mut self.surfaces[i];
                let id = surface.id();
                // The panel sizes itself to its content. Keep ScrollArea only for its
                // content-size measurement: no scrollbars and no parent wheel handling, so
                // the count field can consume the wheel without moving the whole surface.
                let out = egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .enable_scrolling(false)
                    .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden)
                    .show(ui, |ui| {
                        for a in surface.ui(ui) {
                            sent.push((id, a));
                        }
                    });
                content = Some(out.content_size.y);
            });
        if let Some(h) = content {
            self.fit(ctx, h);
        }
        self.grip(ctx);
        #[cfg(windows)]
        self.track_typing(ctx);
        self.variant_viewport(ctx);
        self.notice(ctx);
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
