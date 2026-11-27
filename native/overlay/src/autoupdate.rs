// 更新提醒 + 一键更新. In the background this helper looks for a newer WavePlug and tells the
// Photoshop panel (Event::UpdateAvailable), which shows a line with one 「更新」 button. A click
// (Command::UpdateNow) does the whole update here, with nothing else to click: no installer window,
// no administrator prompt, Photoshop stays open.
//
// - Installed WavePlug (a release): the newest GitHub Release's installer is downloaded and checked
//   (update.rs), and what it carries is put in place directly —
//     the Photoshop plugin's code into <data>\plugin-live\ (the plugin's loader runs it instead of
//       the installed copy when it is newer and needs no other permissions: plugin/loader.js), so
//       no reinstall into Adobe's folder;
//     WavePlug.exe / WavePlug.pak in the install folder (install::install_app: the running exe is
//       renamed out of the way, life.rs restarts into the new one, ComfyUI keeps running);
//     the Illustrator panel (its open panel reloads by itself).
// - The developer's source folder (功能设置 › 开发者): new commits on GitHub; 「更新」 runs
//   scripts\update.mjs (pull, compile what changed, build): the panels and this program reload.
//
// Progress and the result go back as Event::UpdateProgress.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::protocol::Event;
use crate::setup::{detect, install, payload, sys, update};

/// what was found: shown by the panel until it is installed
#[derive(Clone, Debug, PartialEq)]
pub struct Available {
    pub version: String,
    pub notes: String,
    /// a source folder's new commits (scripts\update.mjs) rather than a release
    pub dev: bool,
    /// the release found (None for dev)
    latest: Option<update::Latest>,
}

static FOUND: Mutex<Option<Available>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);

const FIRST_CHECK: Duration = Duration::from_secs(30);
const RELEASE_EVERY: Duration = Duration::from_secs(3 * 3600);
const DEV_EVERY: Duration = Duration::from_secs(10 * 60);

/// The plugin code folder a one-click update fills (installed WavePlug only).
pub fn live_root() -> Option<PathBuf> {
    crate::paths::install_dir().map(|_| crate::paths::data_root().join("plugin-live"))
}

/// The installed WavePlug.exe (the plugin starts that one once it knows it: it is the one updates replace).
pub fn app_exe() -> Option<PathBuf> {
    crate::paths::install_dir().map(|d| d.join(crate::paths::APP_EXE)).filter(|p| p.is_file())
}

/// `C:\a\b` → `C:/a/b/` (what the plugin's loader reads with file: URLs)
pub fn url_dir(p: &Path) -> String {
    let s = p.display().to_string().replace('\\', "/");
    if s.ends_with('/') { s } else { s + "/" }
}

fn dev_dir() -> Option<PathBuf> {
    let d = PathBuf::from(install::Config::load().dev_source.trim());
    (!d.as_os_str().is_empty() && d.join(".git").exists() && d.join("scripts").join("update.mjs").is_file()).then_some(d)
}

fn installed_version() -> String {
    crate::paths::install_dir().and_then(|d| std::fs::read_to_string(d.join(crate::paths::MARKER)).ok()).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// The event that says what was found (sent again to every panel that connects).
pub fn found_event() -> Option<Event> {
    FOUND.lock().ok()?.as_ref().map(|a| Event::UpdateAvailable { version: a.version.clone(), notes: a.notes.clone(), dev: a.dev })
}

fn set_found(a: Option<Available>) {
    let changed = FOUND.lock().map(|mut f| if *f != a { *f = a; true } else { false }).unwrap_or(false);
    if changed {
        if let Some(ev) = found_event() {
            crate::server::send(&ev);
        }
    }
}

/// Starts looking (call once at startup).
pub fn start() {
    std::thread::spawn(|| {
        std::thread::sleep(FIRST_CHECK);
        loop {
            let every = if dev_dir().is_some() { DEV_EVERY } else { RELEASE_EVERY };
            if !BUSY.load(Ordering::SeqCst) {
                check();
            }
            std::thread::sleep(every);
        }
    });
}

/// One look for something newer.
fn check() {
    if let Some(dir) = dev_dir() {
        match crate::devgit::check(&dir) {
            crate::devgit::Git::Online { behind, latest } if behind > 0 => {
                crate::log::line(format!("update check: source folder is {behind} commits behind"));
                set_found(Some(Available { version: format!("{behind} 个新改动"), notes: latest, dev: true, latest: None }));
            }
            crate::devgit::Git::Online { .. } => set_found(None),
            other => crate::log::line(format!("update check (source folder): {other:?}")),
        }
        return;
    }
    let current = installed_version();
    if current.is_empty() {
        return; // not installed (a build run from elsewhere): nothing to update to
    }
    let cfg = install::Config::load();
    let source = if cfg.update_url.trim().is_empty() { update::DEFAULT_SOURCE.to_string() } else { cfg.update_url.trim().to_string() };
    match update::latest(&source) {
        Ok(l) if detect::newer(&l.version, &current) => {
            crate::log::line(format!("update check: {} is newer than {current}", l.version));
            set_found(Some(Available { version: l.version.clone(), notes: l.notes.clone(), dev: false, latest: Some(l) }));
        }
        Ok(_) => set_found(None),
        Err(e) => crate::log::line(format!("update check: {e}")),
    }
}

fn progress(text: impl Into<String>, done: bool, ok: bool) {
    let text = text.into();
    crate::log::line(format!("update: {text}"));
    crate::server::send(&Event::UpdateProgress { text, done, ok });
}

/// 「更新」: does the update found (looking first when nothing was found yet).
pub fn update_now() {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let result = (|| -> Result<String, String> {
            if FOUND.lock().map(|f| f.is_none()).unwrap_or(true) {
                progress("正在检查新版本…", false, false);
                check();
            }
            let found = FOUND.lock().ok().and_then(|f| f.clone()).ok_or("已经是最新版本")?;
            if found.dev { update_dev() } else { update_release(found.latest.ok_or("没有找到安装包")?) }
        })();
        BUSY.store(false, Ordering::SeqCst);
        match result {
            Ok(msg) => {
                set_found(None);
                progress(msg, true, true);
            }
            Err(e) => progress(format!("更新没有完成：{e}"), true, false),
        }
    });
}

fn update_dev() -> Result<String, String> {
    let dir = dev_dir().ok_or("没有源码文件夹")?;
    progress("正在取最新代码并构建（改了 WavePlug 程序时要编译几分钟）…", false, false);
    // Its output goes to a file, not a pipe to this program: update.mjs compiles this program
    // midway and this copy then restarts into the new exe — a pipe would close under node, whose
    // next line would kill it before the plugin is built. The new copy and the panel take over
    // (the panel counts the reconnect as the update done).
    let logs = dir.join("reports");
    let _ = std::fs::create_dir_all(&logs);
    let file = std::fs::File::create(logs.join("update.log")).map_err(|e| format!("写不了 update.log：{e}"))?;
    let mut cmd = std::process::Command::new("node");
    cmd.args(["scripts/update.mjs"]).current_dir(&dir).stdin(std::process::Stdio::null())
        .stdout(file.try_clone().map_err(|e| e.to_string())?).stderr(file);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = cmd.status().map_err(|e| format!("node 没能运行：{e}"))?;
    let tail = std::fs::read_to_string(logs.join("update.log")).unwrap_or_default();
    let last = tail.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
    if status.success() { Ok("已更新到最新代码：面板会自动载入新版本".into()) } else { Err(format!("{last}（详情在 reports\\update.log）")) }
}

fn update_release(l: update::Latest) -> Result<String, String> {
    let dir = crate::paths::install_dir().ok_or("WavePlug 没有安装")?;
    let cfg = install::Config::load();
    progress(format!("正在下载 {}…", l.version), false, false);
    let file = crate::paths::cache_dir("downloads").join(format!("WavePlug_Setup_{}.exe", l.version));
    let log = |t: String| crate::log::line(format!("update download: {t}"));
    update::download_checked(&l, &file, &update::mirror_list(&cfg.mirrors), true, &log)?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let archive = payload::split(&bytes).ok_or("下载的文件不是 WavePlug 安装包")?;
    let p = payload::Payload::parse(archive)?;
    // The installed plugin's loader must know the update folder (plugin/loader.js, wp.liveRoot):
    // an older one would keep running its own old code next to the new program. Then this once
    // the installer does it (Photoshop has to be closed for the plugin); after that, one click.
    if !loader_reads_live() {
        sys::launch(&file, &["--update", &dir.display().to_string()])?;
        return Ok(format!("这次需要完整安装一次：已打开 {} 的安装程序，按提示关闭 Photoshop 后完成；以后的更新点一下就好", l.version));
    }
    progress("正在安装…", false, false);
    let mut notes = Vec::new();
    // 1. the plugin's code, where the loader picks it up (no reinstall, no administrator prompt)
    let live = live_root().ok_or("没有安装文件夹")?;
    put_live(&p, &live, &l.version)?;
    if !same_permissions(&p) {
        notes.push("这次的插件需要新的权限：下次关闭 Photoshop 后，在 WavePlug 程序 › 安装与更新 里点「重新安装插件」".to_string());
    }
    // 2. the Illustrator panel, when it is installed
    if install::installed_panel().is_some() {
        if let Err(e) = install::install_panel(&p, &|t| crate::log::line(format!("update: {t}"))) {
            notes.push(format!("Illustrator 面板没更新：{e}"));
        }
    }
    // 3. this program, last: it restarts into the new exe (life.rs) once it is in place
    let app = p.get(crate::paths::APP_EXE).ok_or("安装包里没有 WavePlug.exe")?;
    let mut pack = archive.to_vec();
    pack.extend((archive.len() as u64).to_le_bytes());
    pack.extend(payload::MAGIC);
    let target = install::install_app(&dir, app, &pack, &l.version, false, &|t| crate::log::line(format!("update: {t}")))?;
    // running from elsewhere (the copy beside the installed plugin): switch to the installed one
    let here = std::env::current_exe().ok();
    if here.as_deref().map(|h| !same_file(h, &target)).unwrap_or(false) {
        let to = target.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            crate::life::restart_into(&to, "update installed");
        });
    }
    Ok(format!("已更新到 {}{}", l.version, if notes.is_empty() { String::new() } else { format!("（{}）", notes.join("；")) }))
}

/// Whether the installed Photoshop plugin's loader runs the code a one-click update puts in place.
fn loader_reads_live() -> bool {
    install::installed_plugin_dir()
        .and_then(|d| std::fs::read_to_string(d.join("loader.js")).ok())
        .is_some_and(|js| js.contains("wp.liveRoot"))
}

fn same_file(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.display().to_string().to_lowercase().replace('/', "\\");
    n(a) == n(b)
}

/// The payload's plugin files into `live`, all at once: written beside it, then swapped in. The
/// build-stamp.txt the open panel watches is written last.
fn put_live(p: &payload::Payload, live: &Path, version: &str) -> Result<(), String> {
    let files: Vec<_> = p.under("ps").collect();
    if !files.iter().any(|(n, _)| *n == "index.js") {
        return Err("安装包里没有 Photoshop 插件".into());
    }
    let staged = live.with_extension("new");
    let _ = std::fs::remove_dir_all(&staged);
    for (name, data) in &files {
        let to = staged.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&to, data).map_err(|e| format!("写不了 {}：{e}", to.display()))?;
    }
    std::fs::write(staged.join("build-stamp.txt"), format!("{version} {}", std::process::id())).map_err(|e| e.to_string())?;
    let old = live.with_extension("old");
    let _ = std::fs::remove_dir_all(&old);
    if live.exists() {
        std::fs::rename(live, &old).map_err(|e| format!("换不了 {}：{e}", live.display()))?;
    }
    std::fs::rename(&staged, live).map_err(|e| format!("放不进 {}：{e}", live.display()))?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Whether the new plugin asks for nothing the installed one doesn't have (its manifest without the
/// version): the loader only runs the new code then.
fn same_permissions(p: &payload::Payload) -> bool {
    let new = p.get("ps/manifest.json").and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok());
    let old = installed_manifest();
    match (new, old) {
        (Some(n), Some(o)) => strip_version(n) == strip_version(o),
        _ => true,
    }
}

pub fn strip_version(mut v: serde_json::Value) -> serde_json::Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("version");
    }
    v
}

fn installed_manifest() -> Option<serde_json::Value> {
    let dir = install::installed_plugin_dir()?;
    serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_permissions() {
        assert_eq!(url_dir(Path::new("C:\\WavePlug\\data\\plugin-live")), "C:/WavePlug/data/plugin-live/");
        let a = serde_json::json!({ "id": "x", "version": "1.0.0", "requiredPermissions": { "network": 1 } });
        let b = serde_json::json!({ "id": "x", "version": "1.1.0", "requiredPermissions": { "network": 1 } });
        let c = serde_json::json!({ "id": "x", "version": "1.1.0", "requiredPermissions": { "network": 2 } });
        assert_eq!(strip_version(a.clone()), strip_version(b));
        assert_ne!(strip_version(a), strip_version(c));
    }

    #[test]
    fn live_files_are_swapped_in_whole() {
        let root = std::env::temp_dir().join(format!("wp-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let live = root.join("plugin-live");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("stale.js"), "old").unwrap();
        let p = payload::Payload::parse(&payload::encode(&[("ps/index.js", b"js"), ("ps/icons/a.png", b"png"), ("WavePlug.exe", b"exe")])).unwrap();
        put_live(&p, &live, "1.2.3").unwrap();
        assert_eq!(std::fs::read_to_string(live.join("index.js")).unwrap(), "js");
        assert!(live.join("icons").join("a.png").is_file());
        assert!(!live.join("stale.js").exists());
        assert!(std::fs::read_to_string(live.join("build-stamp.txt")).unwrap().starts_with("1.2.3"));
        assert!(!live.with_extension("new").exists() && !live.with_extension("old").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
