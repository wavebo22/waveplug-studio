// The WavePlug app window (主界面): one program for everything outside Photoshop and Illustrator.
// The helper (外置框架) is this program; the window is opened from the tray icon (tray.rs), the
// Start menu shortcut (`--show`), or a second start of the exe (it asks the running one to show).
//
// Pages:
// - 总览: what is installed and running, whether the panels are connected.
// - 安装与更新: Photoshop / Illustrator parts from WavePlug.pak (what the installer left in the
//   install folder), updates, removing WavePlug, the developer tools.
// - 功能设置: the plugin's own settings for what this program does (性能监视, 卡死保护, ComfyUI).
//   The plugin keeps them (it sends them as app-settings when it connects or one changes); a change
//   here goes back as app-settings-set and the plugin applies and saves it.
// - 帮助与日志: what each part does, the log and data folders, a diagnostic copy, clearing caches.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eframe::egui::{self, CornerRadius, Frame, Margin, RichText, Stroke};
use serde_json::{json, Map, Value};

use crate::panel::theme;
use crate::paths;
use crate::protocol::Event;
use crate::setup::detect::{self, App, Found};
use crate::setup::install::{self, Config};
use crate::setup::payload::{self, Info, Payload};
use crate::setup::sys;
use crate::setup::update::{self, Latest};

pub const TITLE: &str = "WavePlug";
const SIZE: [f32; 2] = [760.0, 680.0];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Overview = 0,
    Install = 1,
    Settings = 2,
    Help = 3,
}

impl Tab {
    fn from(n: u8) -> Tab {
        match n {
            1 => Tab::Install,
            2 => Tab::Settings,
            3 => Tab::Help,
            _ => Tab::Overview,
        }
    }
}

static OPEN: AtomicBool = AtomicBool::new(false);
static WANT_TAB: AtomicU8 = AtomicU8::new(u8::MAX);
static ASK_UNINSTALL: AtomicBool = AtomicBool::new(false);
/// the user started this program (Start menu, tray "keep running"): it stays when Photoshop closes
static PINNED: AtomicBool = AtomicBool::new(false);
static QUIT: AtomicBool = AtomicBool::new(false);
static PLUGIN_SETTINGS: Mutex<Option<Map<String, Value>>> = Mutex::new(None);

/// Opens the window (on `tab`).
pub fn open(tab: Option<Tab>) {
    OPEN.store(true, Ordering::SeqCst);
    if let Some(t) = tab {
        WANT_TAB.store(t as u8, Ordering::SeqCst);
    }
    crate::host::wake();
}

pub fn is_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

/// Windows' 应用 list asked to remove WavePlug: the window, asking.
pub fn ask_uninstall() {
    ASK_UNINSTALL.store(true, Ordering::SeqCst);
    open(Some(Tab::Install));
}

pub fn pin() {
    PINNED.store(true, Ordering::SeqCst);
}

/// Stays when Photoshop closes: started by the user, the window is open, or 保持运行 is on.
pub fn stays() -> bool {
    PINNED.load(Ordering::SeqCst) || is_open() || Config::load().keep_running
}

/// 退出 (tray menu, after removing WavePlug): the host closes.
pub fn quit() {
    QUIT.store(true, Ordering::SeqCst);
    crate::host::wake();
}

pub fn quitting() -> bool {
    QUIT.load(Ordering::SeqCst)
}

/// The plugin's settings for this program (app-settings).
pub fn set_plugin_settings(v: Map<String, Value>) {
    if let Ok(mut s) = PLUGIN_SETTINGS.lock() {
        *s = Some(v);
    }
    crate::host::wake();
}

/// Photoshop's panel went away: its settings are unknown until it is back.
pub fn plugin_gone() {
    if let Ok(mut s) = PLUGIN_SETTINGS.lock() {
        *s = None;
    }
}

/// The program's icon (window and tray): a teal rounded square with a white wave, `n` px.
pub fn icon_rgba(n: u32) -> Vec<u8> {
    let mut px = vec![0u8; (n * n * 4) as usize];
    let f = n as f32;
    let r = f * 0.22;
    for y in 0..n {
        for x in 0..n {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            // rounded square
            let dx = (r - fx).max(fx - (f - r)).max(0.0);
            let dy = (r - fy).max(fy - (f - r)).max(0.0);
            let out = (dx * dx + dy * dy).sqrt() - r;
            let a = (0.5 - out).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            // the wave: a sine band through the middle
            let t = fx / f;
            let wy = f * (0.5 + 0.16 * (t * std::f32::consts::TAU * 1.25 - 1.2).sin());
            let band = f * 0.085;
            let w = (1.0 - ((fy - wy).abs() - band).clamp(0.0, 1.0)) * if (0.16..0.84).contains(&t) { 1.0 } else { 0.0 };
            let (cr, cg, cb) = (0x3f as f32, 0xb5 as f32, 0x9f as f32);
            let i = ((y * n + x) * 4) as usize;
            px[i] = (cr + (255.0 - cr) * w) as u8;
            px[i + 1] = (cg + (255.0 - cg) * w) as u8;
            px[i + 2] = (cb + (255.0 - cb) * w) as u8;
            px[i + 3] = (a * 255.0) as u8;
        }
    }
    px
}

#[derive(Default, Clone)]
struct Status {
    plugin: Option<(String, bool)>,
    panel: Option<(String, bool)>,
    ps_running: bool,
    ai_running: bool,
    upia: Option<PathBuf>,
    comfy_up: Option<bool>,
    cache_bytes: u64,
    read: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Pick {
    Ps,
    Ai,
    Upia,
    Dev,
    Installer,
}

#[derive(Default)]
struct Shared {
    log: Vec<(String, egui::Color32)>,
    busy: Option<String>,
    status: Status,
    refreshing: bool,
    latest: Option<Latest>,
    picked: Option<(Pick, PathBuf)>,
    /// removed: quit once the log has been seen for a moment
    removed: Option<Instant>,
}

#[derive(Clone)]
struct Logger {
    shared: Arc<Mutex<Shared>>,
    ctx: egui::Context,
}

impl Logger {
    fn put(&self, text: String, color: egui::Color32) {
        use std::io::Write;
        let dir = paths::logs_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("setup.log")) {
            let _ = writeln!(f, "{text}");
        }
        let mut s = self.shared.lock().unwrap();
        s.log.push((text, color));
        let n = s.log.len();
        if n > 2000 {
            s.log.drain(..n - 2000);
        }
        drop(s);
        self.ctx.request_repaint();
    }
}

pub struct AppWindow {
    ctx: egui::Context,
    tab: Tab,
    cfg: Config,
    pack: Arc<Option<Payload>>,
    info: Option<Info>,
    pack_err: Option<String>,
    ps: Vec<Found>,
    ai: Vec<Found>,
    want_ps: bool,
    want_ai: bool,
    shared: Arc<Mutex<Shared>>,
    last_refresh: Option<Instant>,
    confirm_remove: bool,
    confirm_uninstall: bool,
    uninstall_ps: bool,
    uninstall_ai: bool,
    /// the comfy fields being typed (sent when they lose the keyboard)
    comfy_url: Option<String>,
    comfy_launch: Option<String>,
    /// the update source has been asked once since the window opened
    auto_checked: bool,
    confirm_publish: bool,
}

fn pack_path() -> Option<PathBuf> {
    paths::install_dir().map(|d| d.join(paths::PACK))
}

impl AppWindow {
    pub fn new(ctx: egui::Context) -> AppWindow {
        let mut cfg = Config::load();
        let (pack, pack_err) = match pack_path() {
            Some(p) => match payload::read_exe(&p) {
                Ok(p) => (p, None),
                Err(e) => (None, Some(e)),
            },
            None => (None, None),
        };
        let info = pack.as_ref().and_then(|p| p.info());
        let ps = detect::find(App::Photoshop);
        let ai = detect::find(App::Illustrator);
        if cfg.ps_exe.is_empty() {
            cfg.ps_exe = ps.first().map(|f| f.exe.display().to_string()).unwrap_or_default();
        }
        if cfg.ai_exe.is_empty() {
            cfg.ai_exe = ai.first().map(|f| f.exe.display().to_string()).unwrap_or_default();
        }
        if cfg.dev_source.is_empty() {
            if let Ok(me) = std::env::current_exe() {
                if let Some(studio) = me.ancestors().find(|p| p.join("scripts").join("update.mjs").is_file()) {
                    cfg.dev_source = studio.display().to_string();
                }
            }
            // the installed program isn't inside the source: the usual source folder on this computer
            let usual = Path::new("G:\\waveplug\\studio");
            if cfg.dev_source.is_empty() && usual.join("scripts").join("update.mjs").is_file() {
                cfg.dev_source = usual.display().to_string();
            }
        }
        let want_ps = !cfg.ps_exe.is_empty();
        let want_ai = !cfg.ai_exe.is_empty();
        AppWindow {
            ctx,
            tab: Tab::Overview,
            cfg,
            pack: Arc::new(pack),
            info,
            pack_err,
            ps,
            ai,
            want_ps,
            want_ai,
            shared: Arc::new(Mutex::new(Shared::default())),
            last_refresh: None,
            confirm_remove: false,
            confirm_uninstall: false,
            uninstall_ps: true,
            uninstall_ai: true,
            comfy_url: None,
            comfy_launch: None,
            auto_checked: false,
            confirm_publish: false,
        }
    }

    fn logger(&self) -> Logger {
        Logger { shared: self.shared.clone(), ctx: self.ctx.clone() }
    }

    fn task(&self, name: &str, job: impl FnOnce(&dyn Fn(String)) -> Result<String, String> + Send + 'static) {
        {
            let mut s = self.shared.lock().unwrap();
            if s.busy.is_some() {
                return;
            }
            s.busy = Some(name.to_string());
        }
        let log = self.logger();
        log.put(format!("── {name} ──"), theme::TEXT_3);
        std::thread::spawn(move || {
            let line = |t: String| log.put(t, theme::TEXT_2);
            match job(&line) {
                Ok(m) if !m.is_empty() => log.put(format!("完成：{m}"), theme::OK),
                Ok(_) => {}
                Err(e) => log.put(format!("失败：{e}"), theme::ERR),
            }
            let mut s = log.shared.lock().unwrap();
            s.busy = None;
            s.status.read = false;
            drop(s);
            log.ctx.request_repaint();
        });
    }

    fn refresh(&mut self) {
        let due = self.last_refresh.map_or(true, |t| t.elapsed() > Duration::from_secs(3)) || !self.shared.lock().unwrap().status.read;
        if !due {
            return;
        }
        {
            let mut s = self.shared.lock().unwrap();
            if s.refreshing {
                return;
            }
            s.refreshing = true;
        }
        self.last_refresh = Some(Instant::now());
        let shared = self.shared.clone();
        let ctx = self.ctx.clone();
        let cfg = self.cfg.clone();
        let comfy = plugin_str("comfyUrl");
        std::thread::spawn(move || {
            let st = Status {
                plugin: install::installed_plugin(),
                panel: install::installed_panel(),
                ps_running: sys::is_running(App::Photoshop.exe_name()),
                ai_running: sys::is_running(App::Illustrator.exe_name()),
                upia: install::find_upia(&cfg),
                comfy_up: comfy.as_deref().and_then(reachable),
                cache_bytes: folder_size(&paths::data_root().join("cache")),
                read: true,
            };
            let mut s = shared.lock().unwrap();
            s.status = st;
            s.refreshing = false;
            drop(s);
            ctx.request_repaint();
        });
    }

    fn pick(&self, what: Pick) {
        let shared = self.shared.clone();
        let ctx = self.ctx.clone();
        std::thread::spawn(move || {
            let (title, filter) = match what {
                Pick::Ps => ("选择 Photoshop.exe", ("Photoshop", "Photoshop.exe")),
                Pick::Ai => ("选择 Illustrator.exe", ("Illustrator", "Illustrator.exe")),
                Pick::Upia => ("选择 UnifiedPluginInstallerAgent.exe", ("Adobe 安装工具", "UnifiedPluginInstallerAgent.exe")),
                Pick::Dev => ("选择源码文件夹里的 package.json", ("package.json", "package.json")),
                Pick::Installer => ("选择新的 WavePlug 安装程序", ("WavePlug 安装程序", "*.exe")),
            };
            if let Some(p) = sys::pick_file(title, filter) {
                shared.lock().unwrap().picked = Some((what, p));
                ctx.request_repaint();
            }
        });
    }

    fn take_picked(&mut self) {
        let Some((what, p)) = self.shared.lock().unwrap().picked.take() else { return };
        let s = p.display().to_string();
        match what {
            Pick::Ps => {
                self.cfg.ps_exe = s;
                self.want_ps = true;
            }
            Pick::Ai => {
                self.cfg.ai_exe = s;
                self.want_ai = true;
            }
            Pick::Upia => self.cfg.upia = s,
            Pick::Dev => self.cfg.dev_source = p.parent().map(|d| d.display().to_string()).unwrap_or_default(),
            Pick::Installer => {
                self.start_installer(&p);
                return;
            }
        }
        self.cfg.save();
        self.last_refresh = None;
    }

    /// A newer installer: started as an update of this folder; it replaces this program, which
    /// restarts into the new one by itself (life.rs).
    fn start_installer(&self, exe: &Path) {
        let log = self.logger();
        match payload::read_exe(exe) {
            Ok(Some(p)) => {
                let v = p.info().map(|i| i.version).unwrap_or_else(|| "?".into());
                let dir = paths::install_dir().map(|d| d.display().to_string()).unwrap_or_default();
                log.put(format!("启动安装程序 {}（版本 {v}）…", exe.display()), theme::TEXT_2);
                if let Err(e) = sys::launch(exe, &["--update", &dir]) {
                    log.put(format!("失败：{e}"), theme::ERR);
                }
            }
            Ok(None) => log.put(format!("失败：{} 不是 WavePlug 的安装程序", exe.display()), theme::ERR),
            Err(e) => log.put(format!("失败：{e}"), theme::ERR),
        }
    }

    fn install_parts(&self) {
        let (pack, cfg, ps, ai) = (self.pack.clone(), self.cfg.clone(), self.want_ps, self.want_ai);
        let version = self.info.as_ref().map(|i| i.version.clone()).unwrap_or_default();
        self.task("安装 / 更新插件", move |log| {
            let p = pack.as_ref().as_ref().ok_or("没有找到 WavePlug.pak（开发版没有）：用安装程序安装 WavePlug，或用开发者里的「生成安装包」")?;
            let (mut done, mut failed) = (Vec::new(), Vec::new());
            if ps {
                match install::install_plugin(p, &version, &cfg, log) {
                    Ok(m) => done.push(m),
                    Err(e) => failed.push(e),
                }
            }
            if ai {
                match install::install_panel(p, log) {
                    Ok(m) => done.push(m),
                    Err(e) => failed.push(e),
                }
            }
            if failed.is_empty() {
                Ok(done.join("\n"))
            } else {
                for m in done {
                    log(m);
                }
                Err(failed.join("\n"))
            }
        });
    }

    fn remove_parts(&self) {
        let (cfg, ps, ai) = (self.cfg.clone(), self.want_ps, self.want_ai);
        self.task("卸载插件", move |log| {
            let mut out = Vec::new();
            if ps {
                out.push(install::remove_plugin(&cfg, log)?);
            }
            if ai {
                out.push(install::remove_panel()?);
            }
            Ok(out.join("；"))
        });
    }

    fn uninstall_all(&self) {
        let (cfg, ps, ai) = (self.cfg.clone(), self.uninstall_ps, self.uninstall_ai);
        let shared = self.shared.clone();
        self.task("卸载 WavePlug", move |log| {
            install::uninstall_app(&cfg, ps, ai, log)?;
            if let Some(dir) = paths::install_dir() {
                install::remove_folder_later(&dir)?;
                log(format!("{} 会在 WavePlug 退出后删除", dir.display()));
            }
            shared.lock().unwrap().removed = Some(Instant::now());
            Ok("WavePlug 已卸载，几秒后退出".into())
        });
    }

    /// The update source: what the user typed, else the project's GitHub repository.
    fn update_source(&self) -> String {
        let s = self.cfg.update_url.trim();
        if s.is_empty() { update::DEFAULT_SOURCE.to_string() } else { s.to_string() }
    }

    /// The installed version (the payload WavePlug was installed from), "" when not installed.
    fn current_version(&self) -> String {
        self.info.as_ref().map(|i| i.version.clone()).unwrap_or_default()
    }

    /// A newer version found at the update source, if any.
    fn newer_version(&self) -> Option<Latest> {
        let current = self.current_version();
        self.shared.lock().unwrap().latest.clone().filter(|l| detect::newer(&l.version, &current))
    }

    /// Once each time the window opens: asks the update source quietly (said in the log only when
    /// there is something new).
    fn auto_check(&mut self) {
        if self.auto_checked {
            return;
        }
        self.auto_checked = true;
        let source = self.update_source();
        if source.is_empty() {
            return;
        }
        let (shared, log, current) = (self.shared.clone(), self.logger(), self.current_version());
        std::thread::spawn(move || {
            if let Ok(l) = update::latest(&source) {
                if detect::newer(&l.version, &current) {
                    log.put(format!("有新版本 {}：在「总览」或「安装与更新」里点「下载并安装」", l.version), theme::ACCENT_HI);
                }
                shared.lock().unwrap().latest = Some(l);
                log.ctx.request_repaint();
            }
        });
    }

    fn check_update(&self) {
        let url = self.update_source();
        let current = self.current_version();
        let shared = self.shared.clone();
        self.task("检查更新", move |_log| {
            if url.is_empty() {
                return Err("先填更新来源（GitHub 仓库或 latest.json 地址）".into());
            }
            let l = update::latest(&url)?;
            let newer = detect::newer(&l.version, &current);
            let msg = if newer { format!("有新版本 {}{}", l.version, if l.notes.is_empty() { String::new() } else { format!("：{}", l.notes) }) } else { format!("已经是最新版本（{current}）") };
            shared.lock().unwrap().latest = Some(l);
            Ok(msg)
        });
    }

    fn download_update(&self, l: Latest) {
        let dir = paths::install_dir().map(|d| d.display().to_string()).unwrap_or_default();
        self.task("下载更新", move |log| {
            let to = paths::cache_dir("downloads").join(format!("WavePlug_Setup_{}.exe", l.version));
            log(format!("下载 {} …", l.url));
            update::download(&l.url, &to)?;
            if payload::read_exe(&to)?.is_none() {
                return Err("下载的文件不是 WavePlug 安装程序".into());
            }
            sys::launch(&to, &["--update", &dir])?;
            Ok(format!("新版本 {} 的安装程序已启动", l.version))
        });
    }

    /// Builds the installer from the source (release.mjs) and runs it as an update of this
    /// folder: the plugin, the Illustrator panel and this program, all from the source.
    fn dev_reinstall(&self) {
        let dir = PathBuf::from(self.cfg.dev_source.trim());
        let target = paths::install_dir().map(|d| d.display().to_string()).unwrap_or_default();
        self.task("从源码重新安装", move |log| {
            let setup = dev_build_setup(&dir, log)?;
            if target.is_empty() {
                sys::launch(&setup, &[])?;
                return Ok(format!("WavePlug 还没安装：已打开 {}，选好文件夹后安装", setup.display()));
            }
            log(format!("用 {} 更新 {target}（WavePlug 会自动重启成新版本）…", setup.display()));
            sys::launch(&setup, &["--update", &target])?;
            Ok("安装程序已启动".into())
        });
    }

    /// Builds the installer and publishes it as a GitHub release (gh CLI, the user's own login).
    fn dev_publish(&self) {
        let dir = PathBuf::from(self.cfg.dev_source.trim());
        let repo = update::github_repo(&self.update_source());
        self.task("发布到 GitHub", move |log| {
            let repo = repo.ok_or("更新来源不是 GitHub 仓库：在「更新」里填 owner/仓库名")?;
            let setup = dev_build_setup(&dir, log)?;
            let version = source_version(&dir)?;
            let notes = update::changelog_notes(&std::fs::read_to_string(dir.join("CHANGELOG.md")).unwrap_or_default(), &version);
            let notes_file = std::env::temp_dir().join("WavePlug").join(format!("notes_{version}.md"));
            let _ = std::fs::create_dir_all(notes_file.parent().unwrap());
            std::fs::write(&notes_file, if notes.is_empty() { format!("WavePlug {version}") } else { notes }).map_err(|e| e.to_string())?;
            let tag = format!("v{version}");
            let (setup_s, notes_s) = (setup.display().to_string(), notes_file.display().to_string());
            let args = ["release", "create", tag.as_str(), setup_s.as_str(), "--repo", repo.as_str(), "--title", &format!("WavePlug {version}"), "--notes-file", notes_s.as_str()];
            log(format!("gh release create {tag} --repo {repo} …"));
            let code = sys::run_stream("gh", &args, &dir, &|l| log(l)).map_err(|e| format!("{e}：先安装 GitHub CLI（https://cli.github.com），再在命令行运行一次 gh auth login"))?;
            if code == 0 {
                Ok(format!("已发布 {tag}：装了 WavePlug 的电脑点「检查更新」就能更新"))
            } else {
                Err(format!("gh 退出码 {code}（上面是输出；同一个版本号只能发布一次，先在 CHANGELOG / manifest 里升版本）"))
            }
        });
    }

    fn dev_run(&self, name: &str, program: &'static str, args: &'static [&'static str]) {
        let dir = PathBuf::from(self.cfg.dev_source.trim());
        self.task(name, move |log| {
            if !dir.join("package.json").is_file() {
                return Err("源码文件夹不对：选 studio 文件夹里的 package.json".into());
            }
            let code = sys::run_stream(program, args, &dir, &|l| log(l))?;
            if code == 0 { Ok(String::new()) } else { Err(format!("退出码 {code}（上面是输出）")) }
        });
    }

    /// Called every frame by the host: the window while it is open.
    pub fn show(&mut self, ctx: &egui::Context) {
        if !is_open() {
            return;
        }
        let want = WANT_TAB.swap(u8::MAX, Ordering::SeqCst);
        if want != u8::MAX {
            self.tab = Tab::from(want);
        }
        if ASK_UNINSTALL.swap(false, Ordering::SeqCst) {
            self.confirm_uninstall = true;
        }
        self.take_picked();
        self.refresh();
        self.auto_check();
        if let Some(t) = self.shared.lock().unwrap().removed {
            if t.elapsed() > Duration::from_secs(3) {
                quit();
            }
        }
        let builder = egui::ViewportBuilder::default()
            .with_title(TITLE)
            .with_inner_size(SIZE)
            .with_min_inner_size([560.0, 460.0])
            .with_icon(Arc::new(egui::IconData { rgba: icon_rgba(64), width: 64, height: 64 }));
        ctx.show_viewport_immediate(egui::ViewportId::from_hash_of("waveplug-app"), builder, |ctx, _| {
            if ctx.input(|i| i.viewport().close_requested()) {
                OPEN.store(false, Ordering::SeqCst);
                return;
            }
            ctx.request_repaint_after(Duration::from_secs(2));
            self.ui(ctx);
        });
    }

    fn ui(&mut self, ctx: &egui::Context) {
        let st = self.shared.lock().unwrap().status.clone();
        let busy = self.shared.lock().unwrap().busy.clone();

        egui::TopBottomPanel::top("tabs").frame(Frame::new().fill(theme::SURFACE).inner_margin(Margin::symmetric(14, 10))).show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("WavePlug").font(theme::font_bold(17.0)));
                ui.label(small(format!("v{}", env!("CARGO_PKG_VERSION")), theme::TEXT_3));
                ui.add_space(16.0);
                for (t, label) in [(Tab::Overview, "总览"), (Tab::Install, "安装与更新"), (Tab::Settings, "功能设置"), (Tab::Help, "帮助与日志")] {
                    let on = self.tab == t;
                    let text = RichText::new(label).font(if on { theme::font_bold(theme::FS_L) } else { theme::font(theme::FS_L) }).color(if on { theme::ACCENT_HI } else { theme::TEXT_2 });
                    if ui.add(egui::Button::new(text).frame(false)).clicked() {
                        self.tab = t;
                    }
                }
            });
        });

        egui::TopBottomPanel::bottom("log").resizable(true).default_height(130.0).min_height(60.0).show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(small("记录", theme::TEXT_3));
                if let Some(b) = &busy {
                    ui.spinner();
                    ui.label(small(format!("正在{b}…"), theme::WARN));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.small_button("清空").clicked() {
                        self.shared.lock().unwrap().log.clear();
                    }
                });
            });
            egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink([false, false]).show(ui, |ui| {
                let log = self.shared.lock().unwrap().log.clone();
                if log.is_empty() {
                    ui.label(small("安装、更新等操作的每一步会显示在这里。", theme::TEXT_3));
                }
                for (t, c) in log {
                    ui.label(RichText::new(t).font(theme::font(theme::FS_S)).color(c));
                }
            });
        });

        egui::CentralPanel::default().frame(Frame::new().fill(theme::BG).inner_margin(Margin::same(14))).show(ctx, |ui| {
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| match self.tab {
                Tab::Overview => self.overview(ui, &st),
                Tab::Install => self.install_page(ui, &st, &busy),
                Tab::Settings => self.settings_page(ui),
                Tab::Help => self.help_page(ui, &st),
            });
        });
    }

    fn overview(&mut self, ui: &mut egui::Ui, st: &Status) {
        let (ps_on, ai_on) = crate::server::connected();
        if let Some(l) = self.newer_version() {
            let busy = self.shared.lock().unwrap().busy.is_some();
            card(ui, "有新版本", |ui| {
                ui.label(small(format!("WavePlug {} 可以更新（现在 {}）{}", l.version, self.current_version(), if l.notes.is_empty() { String::new() } else { format!("\n{}", l.notes) }), theme::TEXT));
                if ui.add_enabled(!busy, primary(&format!("下载并安装 {}", l.version))).on_hover_text("Photoshop 开着时只更新程序和 Illustrator 面板，插件等关掉 Photoshop 后在「安装与更新」里装").clicked() {
                    self.download_update(l.clone());
                }
            });
        }
        card(ui, "Photoshop", |ui| {
            row(ui, "程序", if st.ps_running { ("正在运行", theme::OK) } else { ("没有运行", theme::TEXT_3) });
            row(ui, "WavePlug Studio 插件", match &st.plugin {
                Some((v, true)) => (leak(format!("已安装 {v}")), theme::OK),
                Some((v, false)) => (leak(format!("已安装 {v}，在 Creative Cloud 里被停用")), theme::WARN),
                None if st.read => ("没有安装", theme::WARN),
                None => ("正在读取…", theme::TEXT_3),
            });
            row(ui, "与本程序连接", if ps_on { ("已连接", theme::OK) } else { ("未连接（在 Photoshop 里打开 WavePlug 面板）", theme::TEXT_3) });
        });
        card(ui, "Illustrator", |ui| {
            row(ui, "程序", if st.ai_running { ("正在运行", theme::OK) } else { ("没有运行", theme::TEXT_3) });
            row(ui, "WaveLayer 面板", match &st.panel {
                Some((v, link)) => (leak(format!("已安装 {v}{}", if *link { "（开发版）" } else { "" })), theme::OK),
                None if st.read => ("没有安装", theme::TEXT_3),
                None => ("正在读取…", theme::TEXT_3),
            });
            row(ui, "与本程序连接", if ai_on { ("已连接（可以和 Photoshop 牵手）", theme::OK) } else { ("未连接", theme::TEXT_3) });
        });
        card(ui, "WavePlug 程序", |ui| {
            row(ui, "版本", (leak(format!("{}{}", env!("CARGO_PKG_VERSION"), self.info.as_ref().map(|i| format!(" · 安装包 {}", i.version)).unwrap_or_default())), theme::TEXT));
            row(ui, "安装位置", match paths::install_dir() {
                Some(d) => (leak(d.display().to_string()), theme::TEXT_2),
                None => ("没有安装（开发版或插件自带的副本）", theme::TEXT_3),
            });
            row(ui, "ComfyUI", match (plugin_str("comfyUrl"), st.comfy_up) {
                (None, _) => ("地址未知（Photoshop 面板连上后显示）", theme::TEXT_3),
                (Some(u), Some(true)) => (leak(format!("{u} · 可以连接")), theme::OK),
                (Some(u), Some(false)) => (leak(format!("{u} · 连不上")), theme::WARN),
                (Some(u), None) => (leak(u), theme::TEXT_2),
            });
        });
        ui.horizontal(|ui| {
            if ui.add(primary("安装与更新")).clicked() {
                self.tab = Tab::Install;
            }
            if ui.button("功能设置").clicked() {
                self.tab = Tab::Settings;
            }
        });
    }

    fn install_page(&mut self, ui: &mut egui::Ui, st: &Status, busy: &Option<String>) {
        match (&self.info, &self.pack_err) {
            (Some(i), _) => {
                ui.label(small(format!("可安装：Photoshop 插件 {} · Illustrator 面板 {} · 外置框架 {}{}", i.version, i.ai_version, i.helper_version, if i.built.is_empty() { String::new() } else { format!(" · {} 构建", i.built) }), theme::TEXT_2));
            }
            (None, Some(e)) => {
                ui.label(small(format!("读不出 WavePlug.pak：{e}"), theme::ERR));
            }
            (None, None) => {
                ui.label(small("开发版：没有 WavePlug.pak，插件用「开发者」里的工具更新", theme::WARN));
            }
        }
        ui.add_space(6.0);
        card(ui, "Photoshop", |ui| {
            self.app_row(ui, App::Photoshop);
            match &st.plugin {
                Some((v, on)) => ui.label(small(format!("已安装 WavePlug Studio {v}{}", if *on { "" } else { "（在 Creative Cloud 里被停用了）" }), if *on { theme::OK } else { theme::WARN })),
                None => ui.label(small(if st.read { "没有安装 WavePlug Studio" } else { "正在读取…" }, theme::TEXT_3)),
            };
            if st.ps_running {
                ui.label(small("Photoshop 正在运行：安装 / 卸载插件前要先关闭它", theme::WARN));
            }
            ui.horizontal_wrapped(|ui| {
                match &st.upia {
                    Some(p) => ui.label(small(format!("Adobe 安装工具：{}", p.display()), theme::TEXT_3)),
                    None => ui.label(small("没找到 Adobe 安装工具（UPIA）：安装时会交给 Creative Cloud", theme::TEXT_3)),
                };
                if ui.small_button("指定…").clicked() {
                    self.pick(Pick::Upia);
                }
            });
            ui.checkbox(&mut self.want_ps, "Photoshop 插件");
        });
        card(ui, "Illustrator", |ui| {
            self.app_row(ui, App::Illustrator);
            match &st.panel {
                Some((v, link)) => ui.label(small(format!("已安装 WaveLayer 面板 {v}{}", if *link { "（开发版：链接到源码）" } else { "" }), theme::OK)),
                None => ui.label(small(if st.read { "没有安装 WaveLayer 面板" } else { "正在读取…" }, theme::TEXT_3)),
            };
            ui.checkbox(&mut self.want_ai, "Illustrator 面板");
        });
        let can = busy.is_none() && self.pack.is_some() && (self.want_ps || self.want_ai);
        ui.horizontal(|ui| {
            let label = match &self.info {
                Some(i) => format!("安装 / 更新勾选的插件到 {}", i.version),
                None => "安装 / 更新勾选的插件".into(),
            };
            if ui.add_enabled(can, primary(&label)).clicked() {
                self.install_parts();
            }
            if !self.confirm_remove {
                if ui.add_enabled(busy.is_none() && (self.want_ps || self.want_ai), egui::Button::new("卸载勾选的插件…")).clicked() {
                    self.confirm_remove = true;
                }
            } else {
                ui.label(small("卸载勾选的插件？", theme::WARN));
                if ui.button("确定").clicked() {
                    self.confirm_remove = false;
                    self.remove_parts();
                }
                if ui.button("取消").clicked() {
                    self.confirm_remove = false;
                }
            }
        });
        ui.add_space(10.0);
        card(ui, "更新", |ui| {
            ui.label(small("更新来源：GitHub 仓库（owner/仓库名，或仓库网址），也可以是 latest.json 的地址。每次打开 WavePlug 自动检查一次。", theme::TEXT_3));
            let hint = if update::DEFAULT_SOURCE.is_empty() { "owner/仓库名".to_string() } else { format!("默认：{}", update::DEFAULT_SOURCE) };
            let r = ui.add(egui::TextEdit::singleline(&mut self.cfg.update_url).hint_text(hint).desired_width(f32::INFINITY));
            if r.lost_focus() {
                self.cfg.save();
            }
            ui.horizontal_wrapped(|ui| {
                if ui.add_enabled(busy.is_none(), egui::Button::new("检查更新")).clicked() {
                    self.cfg.save();
                    self.check_update();
                }
                if let Some(l) = self.newer_version() {
                    if ui.add_enabled(busy.is_none(), primary(&format!("下载并安装 {}", l.version))).clicked() {
                        self.download_update(l);
                    }
                }
                if ui.add_enabled(busy.is_none(), egui::Button::new("用安装程序更新…")).on_hover_text("别人发给你的新版 WavePlug_Setup_版本.exe").clicked() {
                    self.pick(Pick::Installer);
                }
            });
        });
        card(ui, "卸载 WavePlug", |ui| {
            if !self.confirm_uninstall {
                ui.label(small("删除整个程序：安装文件夹（含缓存和日志）、快捷方式、Windows「应用」里的登记。", theme::TEXT_3));
                if ui.add_enabled(busy.is_none() && paths::install_dir().is_some(), egui::Button::new("卸载 WavePlug…")).clicked() {
                    self.confirm_uninstall = true;
                }
            } else {
                ui.label(small("确定卸载 WavePlug？安装文件夹会被整个删除。", theme::WARN));
                ui.checkbox(&mut self.uninstall_ps, "同时卸载 Photoshop 插件（Photoshop 要先关闭）");
                ui.checkbox(&mut self.uninstall_ai, "同时卸载 Illustrator 面板");
                ui.horizontal(|ui| {
                    if ui.add_enabled(busy.is_none(), egui::Button::new(RichText::new("卸载").color(theme::ERR))).clicked() {
                        self.confirm_uninstall = false;
                        self.uninstall_all();
                    }
                    if ui.button("取消").clicked() {
                        self.confirm_uninstall = false;
                    }
                });
            }
        });
        egui::CollapsingHeader::new(RichText::new("开发者").font(theme::font_bold(theme::FS))).default_open(!self.cfg.dev_source.is_empty() && self.pack.is_none()).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(small(if self.cfg.dev_source.is_empty() { "源码文件夹：没有设置".to_string() } else { format!("源码文件夹：{}", self.cfg.dev_source) }, theme::TEXT_2));
                if ui.small_button("选择…").clicked() {
                    self.pick(Pick::Dev);
                }
            });
            let ok = busy.is_none() && !self.cfg.dev_source.is_empty();
            ui.label(small("改了代码点「从源码更新」：打开着的面板 2 秒内载入新版本。改了插件 manifest、或要把程序和插件都换成源码里的版本时点「从源码重新安装」。", theme::TEXT_3));
            ui.horizontal_wrapped(|ui| {
                if ui.add_enabled(ok, egui::Button::new("从源码更新")).on_hover_text("编译改过的程序、构建插件和 Illustrator 面板（不用再双击 update.cmd）").clicked() {
                    self.dev_run("从源码更新", "node", &["scripts/update.mjs"]);
                }
                if ui.add_enabled(ok, egui::Button::new("从源码重新安装")).on_hover_text("生成安装包，再用它更新本机的 WavePlug、Photoshop 插件和 Illustrator 面板（不用再双击 release.cmd）").clicked() {
                    self.dev_reinstall();
                }
                if ui.add_enabled(ok, egui::Button::new("生成安装包")).on_hover_text("releases\\WavePlug_Setup_版本.exe 和 latest.json").clicked() {
                    self.dev_run("生成安装包", "node", &["scripts/release.mjs"]);
                }
                if ui.add_enabled(ok, egui::Button::new("Illustrator 面板用开发版")).clicked() {
                    self.dev_run("Illustrator 面板链接到源码", "cmd", &["/c", "ai\\install_dev.cmd", "nopause"]);
                }
            });
            // publishing: the user's own GitHub login (gh), confirmed first
            let repo = update::github_repo(&self.update_source());
            let version = source_version(Path::new(self.cfg.dev_source.trim())).unwrap_or_default();
            if !self.confirm_publish {
                let tip = match &repo { Some(r) => format!("把源码里的 {version} 打成安装包，发布到 github.com/{r} 的 Releases"), None => "先在「更新」里填 GitHub 仓库（owner/仓库名）".into() };
                if ui.add_enabled(ok && repo.is_some(), egui::Button::new("发布到 GitHub…")).on_hover_text(tip).clicked() {
                    self.confirm_publish = true;
                }
            } else {
                ui.label(small(format!("确定把 {version} 发布到 github.com/{}？所有装了 WavePlug 的电脑都会收到这个更新。说明取自 CHANGELOG.md 里的 {version} 一节。", repo.clone().unwrap_or_default()), theme::WARN));
                ui.horizontal(|ui| {
                    if ui.add_enabled(ok, primary("发布")).clicked() {
                        self.confirm_publish = false;
                        self.dev_publish();
                    }
                    if ui.button("取消").clicked() {
                        self.confirm_publish = false;
                    }
                });
            }
            // one plugin now: the old separate development plugin goes once its data has moved
            if let Some((v, _)) = install::old_dev_plugin() {
                ui.label(small(format!("还装着旧的开发版插件 WavePlug Studio Dev {v}。现在只有一个插件：它发现源码文件夹就从那里加载。先用旧开发版打开一次 WavePlug（把工作流和设置交出来），再打开新插件确认都在，然后卸载旧的。"), theme::WARN));
                if ui.add_enabled(busy.is_none(), egui::Button::new("卸载旧开发版插件")).clicked() {
                    let cfg = self.cfg.clone();
                    self.task("卸载旧开发版插件", move |log| install::remove_old_dev_plugin(&cfg, log));
                }
            }
        });
    }

    fn settings_page(&mut self, ui: &mut egui::Ui) {
        let mut keep = self.cfg.keep_running;
        card(ui, "WavePlug 程序", |ui| {
            if ui.checkbox(&mut keep, "关闭 Photoshop 后继续在托盘运行").on_hover_text("不勾：Photoshop 退出时 WavePlug 一起退出（主窗口开着时除外）").changed() {
                self.cfg.keep_running = keep;
                self.cfg.save();
            }
        });
        let Some(s) = PLUGIN_SETTINGS.lock().ok().and_then(|s| s.clone()) else {
            card(ui, "插件设置", |ui| {
                ui.label(small("在 Photoshop 里打开 WavePlug 面板后，这里可以修改它的设置（性能监视、卡死保护、ComfyUI）。", theme::TEXT_3));
            });
            return;
        };
        let flag = |k: &str| s.get(k).and_then(Value::as_bool).unwrap_or(true);
        let mut changes = Map::new();
        card(ui, "外置框架", |ui| {
            toggle(ui, &mut changes, "helperAutoStart", flag("helperAutoStart"), "随 Photoshop 启动", "Photoshop 打开 WavePlug 面板时自动启动本程序");
            toggle(ui, &mut changes, "perfMonitor", flag("perfMonitor"), "在画布右下角显示性能监视", "CPU、内存、显卡、Photoshop 内存、暂存盘、ComfyUI 显存");
        });
        card(ui, "卡死保护", |ui| {
            toggle(ui, &mut changes, "hangGuard", flag("hangGuard"), "Photoshop 卡死时提示并备份恢复文件", "没有响应时弹出提示：等待、备份自动恢复文件或关闭 Photoshop");
            toggle(ui, &mut changes, "hangAutoBackup", flag("hangAutoBackup"), "发现卡死时立即备份", "不等点按钮就开始复制自动恢复文件");
        });
        card(ui, "ComfyUI", |ui| {
            let url = self.comfy_url.get_or_insert_with(|| s.get("comfyUrl").and_then(Value::as_str).unwrap_or("").to_string());
            ui.label(small("地址", theme::TEXT_3));
            if ui.add(egui::TextEdit::singleline(url).desired_width(f32::INFINITY)).lost_focus() {
                changes.insert("comfyUrl".into(), json!(url.trim()));
            }
            let launch = self.comfy_launch.get_or_insert_with(|| s.get("comfyLaunch").and_then(Value::as_str).unwrap_or("").to_string());
            ui.label(small("启动文件（.bat / .cmd / .exe）", theme::TEXT_3));
            if ui.add(egui::TextEdit::singleline(launch).desired_width(f32::INFINITY)).lost_focus() {
                changes.insert("comfyLaunch".into(), json!(launch.trim().trim_matches('"')));
            }
            toggle(ui, &mut changes, "comfyAutoStartWithPhotoshop", flag("comfyAutoStartWithPhotoshop"), "随 Photoshop 启动 ComfyUI", "");
            toggle(ui, &mut changes, "comfyCloseWithPhotoshop", flag("comfyCloseWithPhotoshop"), "Photoshop 退出时关闭 ComfyUI", "只关闭由 WavePlug 启动的那个");
            toggle(ui, &mut changes, "comfyNoBrowser", flag("comfyNoBrowser"), "启动 ComfyUI 时不打开浏览器", "");
        });
        ui.label(small("这些设置保存在 Photoshop 插件里，和插件「设置」页是同一份。", theme::TEXT_3));
        if !changes.is_empty() {
            if let Ok(mut cur) = PLUGIN_SETTINGS.lock() {
                if let Some(c) = cur.as_mut() {
                    for (k, v) in &changes {
                        c.insert(k.clone(), v.clone());
                    }
                }
            }
            if changes.contains_key("comfyUrl") {
                self.comfy_url = None;
            }
            if changes.contains_key("comfyLaunch") {
                self.comfy_launch = None;
            }
            crate::log::line(format!("app settings changed: {}", Value::Object(changes.clone())));
            crate::server::send(&Event::AppSettingsSet { changes: Value::Object(changes) });
            self.last_refresh = None;
        }
    }

    fn help_page(&mut self, ui: &mut egui::Ui, st: &Status) {
        card(ui, "WavePlug 由哪几部分组成", |ui| {
            for (name, what) in [
                ("Photoshop 插件 WavePlug Studio", "生成（连接 ComfyUI，结果作为图层组和变体写回）、工具页、WavePlug 图层面板（拖拽置入、智能对象工具、右键菜单）。"),
                ("Illustrator 面板 WaveLayer", "Illustrator 里的图层面板；和 Photoshop 牵手：发送、画板互传、关联对象更新。"),
                ("WavePlug 程序（本程序）", "外置面板、拖拽卡片、悬停边框、性能监视、卡死保护、ComfyUI 进程管理、两边面板之间的连接、从网页拖入；以及这个窗口。"),
            ] {
                ui.label(RichText::new(name).font(theme::font_bold(theme::FS)));
                ui.label(small(what, theme::TEXT_2));
                ui.add_space(4.0);
            }
        });
        card(ui, "日志与数据", |ui| {
            row(ui, "数据文件夹", (leak(paths::data_root().display().to_string()), theme::TEXT_2));
            row(ui, "缓存", (leak(format!("{:.1} MB", st.cache_bytes as f64 / 1_048_576.0)), theme::TEXT_2));
            ui.horizontal_wrapped(|ui| {
                if ui.button("打开日志文件夹").clicked() {
                    let d = paths::logs_dir();
                    let _ = std::fs::create_dir_all(&d);
                    let _ = sys::open(&d);
                }
                if ui.button("打开数据文件夹").clicked() {
                    let _ = sys::open(&paths::data_root());
                }
                if ui.button("导出诊断信息").on_hover_text("把日志和设置复制到桌面上的一个文件夹，发给开发者").clicked() {
                    let log = self.logger();
                    match export_diagnostics(&self.cfg) {
                        Ok(p) => {
                            log.put(format!("诊断信息已复制到 {}", p.display()), theme::OK);
                            let _ = sys::open(&p);
                        }
                        Err(e) => log.put(format!("导出失败：{e}"), theme::ERR),
                    }
                }
                if ui.button("清理缓存").on_hover_text("删除拖拽导出和下载的临时文件").clicked() {
                    let dir = paths::data_root().join("cache");
                    let n = folder_size(&dir);
                    let _ = std::fs::remove_dir_all(&dir);
                    self.logger().put(format!("已清理缓存 {:.1} MB", n as f64 / 1_048_576.0), theme::OK);
                    self.last_refresh = None;
                }
            });
            ui.label(small("Photoshop 插件从源码文件夹加载时，它的日志在源码的 reports\\uxp_runtime.log。", theme::TEXT_3));
        });
    }

    fn app_row(&mut self, ui: &mut egui::Ui, app: App) {
        let (found, cur) = match app {
            App::Photoshop => (self.ps.clone(), self.cfg.ps_exe.clone()),
            App::Illustrator => (self.ai.clone(), self.cfg.ai_exe.clone()),
        };
        ui.horizontal_wrapped(|ui| {
            if cur.is_empty() {
                ui.label(small(format!("没找到 {}：点「选择…」找到 {}", app.label(), app.exe_name()), theme::WARN));
            } else {
                let f = detect::describe_exe(app, Path::new(&cur));
                ui.label(small(f.describe(app), if f.supported(app) { theme::TEXT } else { theme::ERR }));
                if !f.supported(app) {
                    ui.label(small(format!("版本太旧：需要 {} 或更新", if app == App::Photoshop { "Photoshop 2024" } else { "Illustrator 2022" }), theme::ERR));
                }
            }
        });
        ui.horizontal(|ui| {
            if found.len() > 1 {
                egui::ComboBox::from_id_salt(app.label()).selected_text("找到的版本").show_ui(ui, |ui| {
                    for f in &found {
                        let s = f.exe.display().to_string();
                        if ui.selectable_label(s == cur, f.describe(app)).clicked() {
                            match app {
                                App::Photoshop => self.cfg.ps_exe = s,
                                App::Illustrator => self.cfg.ai_exe = s,
                            }
                            self.cfg.save();
                        }
                    }
                });
            }
            if ui.small_button("选择…").clicked() {
                self.pick(if app == App::Photoshop { Pick::Ps } else { Pick::Ai });
            }
        });
    }
}

fn plugin_str(key: &str) -> Option<String> {
    PLUGIN_SETTINGS.lock().ok()?.as_ref()?.get(key)?.as_str().map(str::to_string).filter(|s| !s.is_empty())
}

/// Whether something answers at `url`'s host and port (one TCP connect, 600 ms at most).
fn reachable(url: &str) -> Option<bool> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?']).next()?;
    let addr = if host.contains(':') { host.to_string() } else { format!("{host}:80") };
    let addr = addr.replace("localhost", "127.0.0.1");
    let sa: std::net::SocketAddr = std::net::ToSocketAddrs::to_socket_addrs(&addr).ok()?.next()?;
    Some(std::net::TcpStream::connect_timeout(&sa, Duration::from_millis(600)).is_ok())
}

fn folder_size(p: &Path) -> u64 {
    let Ok(list) = std::fs::read_dir(p) else { return 0 };
    list.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => folder_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// The logs and the settings, copied into a new folder on the desktop.
fn export_diagnostics(cfg: &Config) -> Result<PathBuf, String> {
    let desk = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Desktop")).filter(|d| d.is_dir()).unwrap_or_else(std::env::temp_dir);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let out = desk.join(format!("WavePlug诊断_{stamp}"));
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    if let Ok(list) = std::fs::read_dir(paths::logs_dir()) {
        for e in list.flatten() {
            let _ = std::fs::copy(e.path(), out.join(e.file_name()));
        }
    }
    let info = json!({
        "app": env!("CARGO_PKG_VERSION"),
        "installDir": paths::install_dir().map(|d| d.display().to_string()),
        "config": serde_json::to_value(cfg).unwrap_or(Value::Null),
        "pluginSettings": PLUGIN_SETTINGS.lock().ok().and_then(|s| s.clone()),
        "plugin": install::installed_plugin(),
        "panel": install::installed_panel(),
    });
    std::fs::write(out.join("info.json"), serde_json::to_string_pretty(&info).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(out)
}

/// UI text kept for the frame (row values are built per frame; the few strings this leaks per
/// frame are tiny and the window is rarely open). Avoided by returning owned strings instead:
fn leak(s: String) -> &'static str {
    // a small interner: the same text is leaked once
    static SEEN: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut seen = SEEN.lock().unwrap();
    if let Some(found) = seen.iter().find(|x| **x == s) {
        return found;
    }
    if seen.len() > 512 {
        seen.clear();
    }
    let l: &'static str = Box::leak(s.into_boxed_str());
    seen.push(l);
    l
}

fn toggle(ui: &mut egui::Ui, changes: &mut Map<String, Value>, key: &str, on: bool, label: &str, tip: &str) {
    let mut v = on;
    let r = ui.checkbox(&mut v, label);
    let r = if tip.is_empty() { r } else { r.on_hover_text(tip) };
    if r.changed() {
        changes.insert(key.into(), json!(v));
    }
}

fn row(ui: &mut egui::Ui, name: &str, (value, color): (&str, egui::Color32)) {
    ui.horizontal_wrapped(|ui| {
        ui.add_sized([150.0, 18.0], egui::Label::new(small(name, theme::TEXT_3)));
        ui.label(RichText::new(value).font(theme::font(theme::FS)).color(color));
    });
}

/// The plugin version in the source folder (plugin/manifest.json: what the installer is named after).
fn source_version(dir: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(dir.join("plugin").join("manifest.json")).map_err(|e| format!("读不到源码的 plugin\\manifest.json：{e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("version").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "manifest 里没有 version".into())
}

/// release.mjs in the source folder (build, compile, package): the installer it made.
fn dev_build_setup(dir: &Path, log: &dyn Fn(String)) -> Result<PathBuf, String> {
    if !dir.join("package.json").is_file() {
        return Err("源码文件夹不对：选 studio 文件夹里的 package.json".into());
    }
    let code = sys::run_stream("node", &["scripts/release.mjs"], dir, &|l| log(l))?;
    if code != 0 {
        return Err(format!("生成安装包失败（退出码 {code}，上面是输出）"));
    }
    let setup = dir.join("releases").join(format!("WavePlug_Setup_{}.exe", source_version(dir)?));
    if !setup.is_file() {
        return Err(format!("生成完了却没有 {}", setup.display()));
    }
    Ok(setup)
}

fn card(ui: &mut egui::Ui, title: &str, add: impl FnOnce(&mut egui::Ui)) {
    Frame::new()
        .fill(theme::SURFACE)
        .stroke(Stroke::new(1.0_f32, theme::LINE_SOFT))
        .corner_radius(CornerRadius::same(theme::R_CARD))
        .inner_margin(Margin::same(12))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new(title).font(theme::font_bold(theme::FS_L)));
            ui.add_space(2.0);
            add(ui);
        });
    ui.add_space(8.0);
}

fn small(text: impl Into<String>, color: egui::Color32) -> RichText {
    RichText::new(text.into()).font(theme::font(theme::FS_S)).color(color)
}

fn primary(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text.to_string()).color(theme::ACCENT_INK).font(theme::font_bold(theme::FS))).fill(theme::ACCENT).min_size(egui::vec2(0.0, theme::H_M))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_icon_is_a_rounded_square_with_a_wave() {
        let n = 32;
        let px = icon_rgba(n);
        assert_eq!(px.len(), (n * n * 4) as usize);
        // corners are transparent, the middle is opaque
        assert_eq!(px[3], 0);
        let mid = ((n / 2 * n + 4) * 4 + 3) as usize;
        assert_eq!(px[mid], 255);
        // some white (the wave) and some teal
        assert!(px.chunks(4).any(|p| p[0] > 240 && p[3] == 255));
        assert!(px.chunks(4).any(|p| p[0] == 0x3f && p[3] == 255));
    }

    #[test]
    fn comfy_address_is_checked_by_host_and_port() {
        assert_eq!(reachable("http://127.0.0.1:1/"), Some(false));
        assert_eq!(reachable(""), None);
    }

    #[test]
    fn leak_interns() {
        let a = leak("同一段".into());
        let b = leak("同一段".into());
        assert!(std::ptr::eq(a, b));
    }
}
