// WavePlug 安装程序 (WavePlug_Setup_<version>.exe): puts the WavePlug app in a folder the user
// chooses and installs the Photoshop plugin and the Illustrator panel. Everything it installs
// travels inside it (payload.rs; packed by scripts/package_setup.mjs): WavePlug.exe (the app, which
// is the helper too), the plugin's .ccx, the panel's files.
//
// What it leaves in the folder: WavePlug.exe, WavePlug.pak (the same payload, so the app can install
// / repair the plugins later), the marker, data\ (settings, logs, caches: paths.rs). After that the
// app (its 安装与更新 page) does updates and removal; Windows' 应用 list runs `WavePlug.exe
// --uninstall`.
//
// `--update <folder>`: started by the app for an update: same folder, starts right away, reinstalls
// the parts that are installed, and closes when done (the running app restarts into the new exe).
// `--info <installer.exe>`: prints what an installer carries.

#![cfg_attr(not(test), windows_subsystem = "windows")]

#[allow(dead_code)]
#[path = "../panel/theme.rs"]
mod theme;
#[path = "../paths.rs"]
mod paths;
// shared with the app (src/setup/mod.rs): the installer uses part of each
#[allow(dead_code)]
mod detect;
#[allow(dead_code)]
mod install;
#[allow(dead_code)]
mod payload;
#[allow(dead_code)]
mod sys;
#[allow(dead_code)]
mod update;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eframe::egui::{self, CornerRadius, Frame, Margin, RichText, Stroke};

use detect::App;
use install::Config;
use payload::{Info, Payload};

const TITLE: &str = "安装 WavePlug";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--info") {
        let path = args.get(i + 1).map(PathBuf::from).unwrap_or_else(|| std::env::current_exe().unwrap_or_default());
        match payload::read_exe(&path) {
            Ok(Some(p)) => {
                println!("{:?}", p.info());
                for (n, d) in &p.files {
                    println!("{n} {}", d.len());
                }
            }
            Ok(None) => println!("没有安装内容"),
            Err(e) => println!("{e}"),
        }
        return;
    }
    let update = args.iter().position(|a| a == "--update").map(|i| args.get(i + 1).cloned().unwrap_or_default());
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title(TITLE).with_inner_size([620.0, 700.0]).with_min_inner_size([480.0, 460.0]),
        ..Default::default()
    };
    let _ = eframe::run_native(
        TITLE,
        options,
        Box::new(move |cc| {
            theme::install(&cc.egui_ctx);
            Ok(Box::new(Installer::new(cc.egui_ctx.clone(), update)))
        }),
    );
}

/// Where to install when `chosen` is picked: a WavePlug folder (marked, or named so) as it is,
/// anything else gets a WavePlug folder inside (never spread over someone's D:\Tools).
fn install_target(chosen: &Path) -> PathBuf {
    let named = chosen.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("WavePlug"));
    if chosen.join(paths::MARKER).is_file() || named {
        chosen.to_path_buf()
    } else {
        chosen.join("WavePlug")
    }
}

fn default_folder() -> PathBuf {
    if let Some(d) = paths::registered_dir() {
        return d;
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Programs").join("WavePlug")
}

#[derive(Default)]
struct Shared {
    log: Vec<(String, egui::Color32)>,
    busy: bool,
    done: Option<Result<PathBuf, String>>,
    picked: Option<PathBuf>,
    picked_app: Option<(App, PathBuf)>,
}

struct Installer {
    ctx: egui::Context,
    payload: Arc<Option<Payload>>,
    archive: Arc<Vec<u8>>,
    info: Option<Info>,
    err: Option<String>,
    folder: String,
    ps: Option<PathBuf>,
    ai: Option<PathBuf>,
    want_ps: bool,
    want_ai: bool,
    desktop: bool,
    update: bool,
    started: bool,
    shared: Arc<Mutex<Shared>>,
    closing: Option<Instant>,
}

impl Installer {
    fn new(ctx: egui::Context, update: Option<String>) -> Installer {
        let (payload, archive, err) = match read_self() {
            Ok((p, a)) => (Some(p), a, None),
            Err(e) => (None, Vec::new(), Some(e)),
        };
        let info = payload.as_ref().and_then(|p| p.info());
        let mut cfg = Config::load();
        let known = |s: &str| (!s.is_empty() && Path::new(s).is_file()).then(|| PathBuf::from(s));
        let ps = known(&cfg.ps_exe).or_else(|| detect::find(App::Photoshop).first().map(|f| f.exe.clone()));
        let ai = known(&cfg.ai_exe).or_else(|| detect::find(App::Illustrator).first().map(|f| f.exe.clone()));
        let is_update = update.is_some();
        let folder = update.filter(|u| !u.is_empty()).map(PathBuf::from).unwrap_or_else(default_folder);
        // an update reinstalls what is there; a first install what was found
        let (want_ps, want_ai) = if is_update {
            (install::installed_plugin().is_some(), install::installed_panel().is_some())
        } else {
            (ps.is_some(), ai.is_some())
        };
        if let Some(p) = &ps {
            cfg.ps_exe = p.display().to_string();
        }
        if let Some(a) = &ai {
            cfg.ai_exe = a.display().to_string();
        }
        Installer {
            ctx,
            payload: Arc::new(payload),
            archive: Arc::new(archive),
            info,
            err,
            folder: folder.display().to_string(),
            ps,
            ai,
            want_ps,
            want_ai,
            desktop: !is_update,
            update: is_update,
            started: false,
            shared: Arc::new(Mutex::new(Shared::default())),
            closing: None,
        }
    }

    fn put(shared: &Arc<Mutex<Shared>>, ctx: &egui::Context, text: String, color: egui::Color32) {
        shared.lock().unwrap().log.push((text, color));
        ctx.request_repaint();
    }

    fn install(&mut self) {
        let Some(_) = self.payload.as_ref() else { return };
        self.started = true;
        let target = install_target(Path::new(self.folder.trim()));
        let (payload, archive, shared, ctx) = (self.payload.clone(), self.archive.clone(), self.shared.clone(), self.ctx.clone());
        let (ps, ai, desktop) = (self.want_ps, self.want_ai, self.desktop);
        let version = self.info.as_ref().map(|i| i.version.clone()).unwrap_or_default();
        let mut cfg = Config::load();
        if let Some(p) = &self.ps {
            cfg.ps_exe = p.display().to_string();
        }
        if let Some(a) = &self.ai {
            cfg.ai_exe = a.display().to_string();
        }
        shared.lock().unwrap().busy = true;
        std::thread::spawn(move || {
            let log = |t: String| Installer::put(&shared, &ctx, t, theme::TEXT_2);
            let p = payload.as_ref().as_ref().expect("checked");
            let result = (|| -> Result<PathBuf, String> {
                let app = p.get("WavePlug.exe").ok_or("安装包里没有 WavePlug.exe（用新的 release.cmd 重新生成）")?;
                // WavePlug.pak: the same archive, readable like an installer's tail
                let mut pack = archive.as_ref().clone();
                pack.extend((archive.len() as u64).to_le_bytes());
                pack.extend(payload::MAGIC);
                let exe = install::install_app(&target, app, &pack, &version, desktop, &log)?;
                // settings go into the new data folder from now on
                let data = paths::data_root_in(&target);
                let _ = std::fs::create_dir_all(&data);
                if let Ok(text) = serde_json::to_string_pretty(&cfg) {
                    let _ = std::fs::write(data.join("setup.json"), text);
                }
                let mut failed = Vec::new();
                if ps {
                    match install::install_plugin(p, &version, &cfg, &log) {
                        Ok(m) => log(m),
                        Err(e) => failed.push(format!("Photoshop 插件：{e}")),
                    }
                }
                if ai {
                    match install::install_panel(p, &log) {
                        Ok(m) => log(m),
                        Err(e) => failed.push(format!("Illustrator 面板：{e}")),
                    }
                }
                if !failed.is_empty() {
                    for f in &failed {
                        Installer::put(&shared, &ctx, f.clone(), theme::ERR);
                    }
                    log("没装上的部分可以稍后在 WavePlug 的「安装与更新」里再装".into());
                }
                Ok(exe)
            })();
            match &result {
                Ok(_) => Installer::put(&shared, &ctx, "安装完成".into(), theme::OK),
                Err(e) => Installer::put(&shared, &ctx, format!("安装失败：{e}"), theme::ERR),
            }
            let mut s = shared.lock().unwrap();
            s.busy = false;
            s.done = Some(result);
            drop(s);
            ctx.request_repaint();
        });
    }
}

/// The payload of this exe, and its archive bytes (for WavePlug.pak).
fn read_self() -> Result<(Payload, Vec<u8>), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&exe).map_err(|e| e.to_string())?;
    let a = payload::split(&bytes).ok_or("这个程序里没有安装内容（开发时直接编译出来的）：用 release.cmd 生成安装包")?;
    Ok((Payload::parse(a)?, a.to_vec()))
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
    egui::Button::new(RichText::new(text.to_string()).color(theme::ACCENT_INK).font(theme::font_bold(theme::FS))).fill(theme::ACCENT).min_size(egui::vec2(96.0, theme::H_M))
}

impl eframe::App for Installer {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(p) = self.shared.lock().unwrap().picked.take() {
            self.folder = install_target(&p).display().to_string();
        }
        if let Some((app, p)) = self.shared.lock().unwrap().picked_app.take() {
            match app {
                App::Photoshop => { self.ps = Some(p); self.want_ps = true; }
                App::Illustrator => { self.ai = Some(p); self.want_ai = true; }
            }
        }
        if self.update && !self.started && self.payload.is_some() {
            self.install();
        }
        let (busy, done) = {
            let s = self.shared.lock().unwrap();
            (s.busy, s.done.clone())
        };
        // an update closes by itself (the running WavePlug restarts into the new exe)
        if self.update {
            if let Some(Ok(_)) = &done {
                let t = *self.closing.get_or_insert_with(Instant::now);
                if t.elapsed() > Duration::from_secs(3) {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
                ctx.request_repaint_after(Duration::from_millis(300));
            }
        }

        egui::TopBottomPanel::bottom("log").resizable(true).default_height(120.0).min_height(60.0).show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(small("记录", theme::TEXT_3));
                if busy {
                    ui.spinner();
                    ui.label(small("正在安装…", theme::WARN));
                }
            });
            egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink([false, false]).show(ui, |ui| {
                for (t, c) in self.shared.lock().unwrap().log.clone() {
                    ui.label(RichText::new(t).font(theme::font(theme::FS_S)).color(c));
                }
            });
        });

        egui::CentralPanel::default().frame(Frame::new().fill(theme::BG).inner_margin(Margin::same(16))).show(ctx, |ui| {
          egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            ui.label(RichText::new(if self.update { "更新 WavePlug" } else { "安装 WavePlug" }).font(theme::font_bold(18.0)));
            match (&self.info, &self.err) {
                (Some(i), _) => ui.label(small(format!("版本 {} · Photoshop 插件 {} · Illustrator 面板 {} · 外置框架 {}", i.version, i.version, i.ai_version, i.helper_version), theme::TEXT_2)),
                (None, Some(e)) => ui.label(small(e.clone(), theme::ERR)),
                (None, None) => ui.label(small("读不出版本", theme::WARN)),
            };
            ui.add_space(10.0);
            let editable = !busy && done.is_none() && !self.update;
            card(ui, "安装位置", |ui| {
                ui.horizontal(|ui| {
                    ui.add_enabled(editable, egui::TextEdit::singleline(&mut self.folder).desired_width(ui.available_width() - 70.0));
                    if ui.add_enabled(editable, egui::Button::new("浏览…")).clicked() {
                        let (shared, ctx) = (self.shared.clone(), self.ctx.clone());
                        std::thread::spawn(move || {
                            if let Some(p) = sys::pick_folder("选择安装 WavePlug 的文件夹") {
                                shared.lock().unwrap().picked = Some(p);
                                ctx.request_repaint();
                            }
                        });
                    }
                });
                let target = install_target(Path::new(self.folder.trim()));
                ui.label(small(format!("装到：{}", target.display()), theme::TEXT_3));
                ui.label(small("程序、设置、日志和所有缓存都放在这个文件夹里；卸载时整个删除。", theme::TEXT_3));
            });
            card(ui, "同时安装", |ui| {
                ui.add_enabled_ui(editable, |ui| {
                    for app in [App::Photoshop, App::Illustrator] {
                        let (found, want, what) = match app {
                            App::Photoshop => (self.ps.clone(), &mut self.want_ps, "Photoshop 插件"),
                            App::Illustrator => (self.ai.clone(), &mut self.want_ai, "Illustrator 面板"),
                        };
                        ui.horizontal(|ui| {
                            let text = match &found {
                                Some(p) => format!("{what}（{}）", detect::describe_exe(app, p).describe(app)),
                                None => format!("{what}（没找到 {}：点「选择…」）", app.label()),
                            };
                            ui.checkbox(want, text);
                            if ui.small_button("选择…").on_hover_text(format!("找到 {}", app.exe_name())).clicked() {
                                let (shared, ctx) = (self.shared.clone(), self.ctx.clone());
                                std::thread::spawn(move || {
                                    if let Some(p) = sys::pick_file(&format!("选择 {}", app.exe_name()), (app.label(), app.exe_name())) {
                                        shared.lock().unwrap().picked_app = Some((app, p));
                                        ctx.request_repaint();
                                    }
                                });
                            }
                        });
                        if let Some(p) = &found {
                            ui.label(small(p.display().to_string(), theme::TEXT_3));
                        }
                    }
                    ui.checkbox(&mut self.desktop, "在桌面创建快捷方式");
                });
                if self.want_ps && sys::is_running(App::Photoshop.exe_name()) && done.is_none() {
                    ui.label(small("Photoshop 正在运行：安装插件前请先关闭它（也可以稍后在 WavePlug 里装）", theme::WARN));
                }
                ui.label(small("安装 Photoshop 插件时 Windows 会请求一次管理员权限。", theme::TEXT_3));
            });
            ui.horizontal(|ui| match &done {
                None => {
                    let can = !busy && self.payload.is_some() && !self.folder.trim().is_empty();
                    if ui.add_enabled(can, primary(if self.update { "更新" } else { "安装" })).clicked() {
                        self.install();
                    }
                }
                Some(Ok(exe)) => {
                    if !self.update && ui.add(primary("打开 WavePlug")).clicked() {
                        let _ = sys::launch(exe, &["--show"]);
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    if ui.button("完成").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                }
                Some(Err(_)) => {
                    if ui.button("重试").clicked() {
                        self.shared.lock().unwrap().done = None;
                        self.started = false;
                        if !self.update {
                            return;
                        }
                    }
                    if ui.button("关闭").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                }
            });
          });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_of_its_own() {
        let tools = Path::new("D:").join("Tools");
        assert_eq!(install_target(&tools), tools.join("WavePlug"));
        assert_eq!(install_target(&tools.join("WavePlug")), tools.join("WavePlug"));
        assert_eq!(install_target(&tools.join("waveplug")), tools.join("waveplug"));
    }
}
