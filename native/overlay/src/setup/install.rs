// Installing, updating and removing WavePlug: the Photoshop plugin (a .ccx, through Adobe's
// installer UPIA, which needs administrator rights and Photoshop closed; without UPIA, Creative
// Cloud opens the .ccx), the Illustrator panel (a CEP extension copied into the user's extensions
// folder, unsigned panels allowed with PlayerDebugMode) and this program itself.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::detect::{self, App};
use super::payload::Payload;
use super::sys;

pub const PLUGIN_ID: &str = "com.waveplug.studio";
pub const PLUGIN_NAME: &str = "WavePlug Studio";
/// the separate development plugin of before (one plugin now: plugin/loader.js runs the source
/// folder's build when it is there); the 开发者 section removes it once its data has moved
pub const OLD_DEV_ID: &str = "com.waveplug.studio.dev";
pub const OLD_DEV_NAME: &str = "WavePlug Studio Dev";
pub const AI_ID: &str = "com.waveplug.ai.wavelayer";
pub const HELPER_EXE: &str = "waveplug-overlay.exe";

/// What the user chose, kept in <data>\setup.json.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub ps_exe: String,
    pub ai_exe: String,
    /// Adobe's UnifiedPluginInstallerAgent.exe when it isn't in the usual place
    pub upia: String,
    /// latest.json of the published version (scripts/package_setup.mjs writes one)
    pub update_url: String,
    /// the studio source folder (developer): 从源码更新 / 生成安装包
    pub dev_source: String,
    /// WavePlug keeps running in the tray after Photoshop closes
    pub keep_running: bool,
}

/// settings and the setup log: inside the install folder once installed (paths.rs)
pub fn data_dir() -> PathBuf {
    crate::paths::data_root()
}

impl Config {
    pub fn load() -> Config {
        std::fs::read_to_string(data_dir().join("setup.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self) {
        let dir = data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let tmp = dir.join("setup.json.new");
        if std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("setup.json"));
        }
    }
}

fn common_files() -> PathBuf {
    PathBuf::from(std::env::var("CommonProgramFiles").unwrap_or_else(|_| "C:\\Program Files\\Common Files".into()))
}

/// Where UPIA may be: the configured one, then where Creative Cloud puts it.
pub fn upia_candidates(cfg: &Config) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !cfg.upia.trim().is_empty() {
        out.push(PathBuf::from(cfg.upia.trim()));
    }
    let rel = "Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe";
    out.push(common_files().join(rel));
    for var in ["CommonProgramW6432", "CommonProgramFiles(x86)"] {
        if let Ok(d) = std::env::var(var) {
            out.push(PathBuf::from(d).join(rel));
        }
    }
    // a UPIA unpacked by hand (no Creative Cloud), where scripts\install_ccx.cmd expects it
    for drive in b'C'..=b'Z' {
        out.push(PathBuf::from(format!("{}:\\App\\Adobe-UPIA-Extract\\UPI64-unpacked\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe", drive as char)));
    }
    out.dedup();
    out
}

pub fn find_upia(cfg: &Config) -> Option<PathBuf> {
    upia_candidates(cfg).into_iter().find(|p| p.is_file())
}

/// The installed Photoshop plugin's version and whether it's on, from Adobe's plugin list.
pub fn installed_plugin() -> Option<(String, bool)> {
    installed_uxp(PLUGIN_ID)
}

fn installed_uxp(id: &str) -> Option<(String, bool)> {
    let p = common_files().join("Adobe\\UXP\\PluginsInfo\\v1\\PS.json");
    detect::uxp_plugin(&std::fs::read_to_string(p).ok()?, id)
}

pub fn ai_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    base.join("Adobe\\CEP\\extensions").join(AI_ID)
}

/// The installed Illustrator panel's version, and whether it's the developer's link to the source.
pub fn installed_panel() -> Option<(String, bool)> {
    let dir = ai_dir();
    let v = detect::cep_version(&std::fs::read_to_string(dir.join("CSXS").join("manifest.xml")).ok()?)?;
    Some((v, is_link(&dir)))
}

fn is_link(p: &Path) -> bool {
    match std::fs::symlink_metadata(p) {
        Ok(m) => {
            if m.file_type().is_symlink() {
                return true;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                return m.file_attributes() & 0x400 != 0; // FILE_ATTRIBUTE_REPARSE_POINT: a junction
            }
            #[allow(unreachable_code)]
            false
        }
        Err(_) => false,
    }
}

/// Removes a folder; a link (the developer's junction to dist\ai) is unlinked, not emptied.
fn remove_folder(p: &Path) -> std::io::Result<()> {
    if !p.exists() && std::fs::symlink_metadata(p).is_err() {
        return Ok(());
    }
    if is_link(p) {
        return std::fs::remove_dir(p).or_else(|_| std::fs::remove_file(p));
    }
    std::fs::remove_dir_all(p)
}

pub type Log<'a> = &'a dyn Fn(String);

/// Writes the .ccx out of the payload: its path.
fn write_ccx(payload: &Payload, version: &str) -> Result<PathBuf, String> {
    let ccx = payload.get("WavePlug.ccx").ok_or("安装包里没有 Photoshop 插件")?;
    let dir = std::env::temp_dir().join("WavePlug");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("WavePlug_Studio_{version}.ccx"));
    std::fs::write(&path, ccx).map_err(|e| format!("写不了 {}：{e}", path.display()))?;
    Ok(path)
}

/// UPIA with `args`, as administrator, run from the user's profile folder (UPIA resolves a path
/// against the current drive and fails with -198 elsewhere): its exit code and what it printed.
fn upia(upia: &Path, args: &str, log: Log) -> Result<(i32, String), String> {
    let out = std::env::temp_dir().join("WavePlug").join(format!("upia_{}.log", std::process::id()));
    let _ = std::fs::create_dir_all(out.parent().unwrap());
    let _ = std::fs::remove_file(&out);
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    // /s: cmd takes off the outer quotes and keeps the inner ones
    let params = format!("/s /c \"cd /d \"{home}\" && \"{}\" {args} > \"{}\" 2>&1\"", upia.display(), out.display());
    log("Windows 会请求管理员权限（Adobe 的安装工具需要）…".into());
    let code = sys::run_elevated("cmd.exe", &params, Path::new(&home))?;
    let text = std::fs::read(&out).map(|b| sys::decode(&b)).unwrap_or_default();
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        log(format!("  {}", l.trim()));
    }
    Ok((code, text))
}

/// The Photoshop plugin: UPIA when there is one, else the .ccx handed to Creative Cloud.
pub fn install_plugin(payload: &Payload, version: &str, cfg: &Config, log: Log) -> Result<String, String> {
    if sys::is_running(App::Photoshop.exe_name()) {
        return Err("请先保存并完全关闭 Photoshop（安装插件时它不能开着）".into());
    }
    // the helper runs from the plugin folder: its exe would stay locked
    if sys::is_running(HELPER_EXE) {
        log("关闭外置框架（它在插件文件夹里运行，不关闭文件会被占用）".into());
        sys::kill(HELPER_EXE);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let ccx = write_ccx(payload, version)?;
    match find_upia(cfg) {
        Some(u) => {
            log(format!("用 Adobe 安装工具安装 Photoshop 插件 {version}…"));
            let (code, text) = upia(&u, &format!("/install \"{}\"", ccx.display()), log)?;
            let ok = code == 0 || text.to_lowercase().contains("installation successful");
            let _ = std::fs::remove_file(&ccx);
            if ok {
                Ok(format!("Photoshop 插件 {version} 已安装：打开 Photoshop，在「增效工具」里打开 WavePlug"))
            } else {
                Err(format!("Adobe 安装工具返回 {code}（上面是它的输出）。也可以双击 {} 交给 Creative Cloud 安装", ccx.display()))
            }
        }
        None => {
            // without Creative Cloud nothing opens a .ccx: Windows only says 找不到应用程序
            if !sys::has_handler(".ccx") {
                return Err(format!(
                    "没找到 Adobe 安装工具（UPIA），这台电脑也没有能打开 .ccx 的程序（Creative Cloud 没装或没注册）。\n\
                     点 Photoshop 一栏的「指定…」选 UnifiedPluginInstallerAgent.exe 后再安装；插件包留在 {}",
                    ccx.display()
                ));
            }
            log("没找到 Adobe 安装工具（UPIA），交给 Creative Cloud 安装 .ccx".into());
            sys::open(&ccx)?;
            Ok("已打开 Creative Cloud 的插件安装：按它的提示完成。没有反应时在设置里指定 UnifiedPluginInstallerAgent.exe".into())
        }
    }
}

pub fn remove_plugin(cfg: &Config, log: Log) -> Result<String, String> {
    if sys::is_running(App::Photoshop.exe_name()) {
        return Err("请先关闭 Photoshop".into());
    }
    sys::kill(HELPER_EXE);
    let u = find_upia(cfg).ok_or("没找到 Adobe 安装工具（UPIA）：请在 Creative Cloud 的「插件」里卸载 WavePlug Studio")?;
    let (code, _) = upia(&u, &format!("/remove \"{PLUGIN_NAME}\""), log)?;
    if code == 0 { Ok("Photoshop 插件已卸载".into()) } else { Err(format!("Adobe 安装工具返回 {code}")) }
}

/// The old development plugin, when it is still installed.
pub fn old_dev_plugin() -> Option<(String, bool)> {
    installed_uxp(OLD_DEV_ID)
}

pub fn remove_old_dev_plugin(cfg: &Config, log: Log) -> Result<String, String> {
    if sys::is_running(App::Photoshop.exe_name()) {
        return Err("请先关闭 Photoshop".into());
    }
    let u = find_upia(cfg).ok_or("没找到 Adobe 安装工具（UPIA）：请在 Creative Cloud 的「插件」里卸载 WavePlug Studio Dev")?;
    let (code, _) = upia(&u, &format!("/remove \"{OLD_DEV_NAME}\""), log)?;
    if code == 0 { Ok("旧的开发版插件已卸载".into()) } else { Err(format!("Adobe 安装工具返回 {code}")) }
}

/// The Illustrator panel: copied into the user's CEP extensions folder (replacing what's there, a
/// developer link included) and unsigned panels allowed (PlayerDebugMode, this user only).
pub fn install_panel(payload: &Payload, log: Log) -> Result<String, String> {
    let dir = ai_dir();
    let files: Vec<_> = payload.under("ai").collect();
    if files.is_empty() {
        return Err("安装包里没有 Illustrator 面板".into());
    }
    remove_folder(&dir).map_err(|e| format!("删不掉旧的面板 {}：{e}", dir.display()))?;
    for (name, data) in &files {
        let p = dir.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, data).map_err(|e| format!("写不了 {}：{e}", p.display()))?;
    }
    log(format!("Illustrator 面板：{} 个文件复制到 {}", files.len(), dir.display()));
    allow_unsigned(log);
    let running = sys::is_running(App::Illustrator.exe_name());
    Ok(if running { "Illustrator 面板已安装：第一次装的话完全退出 Illustrator 再打开；已经打开着的面板会自动载入新版本".into() } else { "Illustrator 面板已安装：打开 Illustrator，在 窗口 › 扩展功能 › WaveLayer".into() })
}

/// PlayerDebugMode=1 for the CEP versions Illustrator 2022–2026 use (current user only).
fn allow_unsigned(log: Log) {
    if !cfg!(windows) {
        return;
    }
    for v in 11..=13 {
        let key = format!("HKCU\\Software\\Adobe\\CSXS.{v}");
        if let Err(e) = sys::run("reg", &["add", &key, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]) {
            log(format!("  写注册表 {key} 失败：{e}"));
        }
    }
}

pub fn remove_panel() -> Result<String, String> {
    let dir = ai_dir();
    remove_folder(&dir).map_err(|e| format!("删不掉 {}：{e}", dir.display()))?;
    Ok("Illustrator 面板已卸载（重启 Illustrator 后消失）".into())
}

/// The WavePlug app into `dir` (the folder the user chose): WavePlug.exe, what it installs from
/// (WavePlug.pak), the marker, its data folder; remembered in the registry, listed under Windows'
/// 应用 (uninstall runs `WavePlug.exe --uninstall`), with Start menu (and desktop) shortcuts.
/// A WavePlug.exe that is running is renamed aside first (it notices and restarts into the new one).
pub fn install_app(dir: &Path, exe: &[u8], pack: &[u8], version: &str, desktop: bool, log: Log) -> Result<PathBuf, String> {
    use crate::paths::{self, APP_EXE, MARKER, PACK};
    std::fs::create_dir_all(paths::data_root_in(dir)).map_err(|e| format!("建不了 {}：{e}", dir.display()))?;
    let target = dir.join(APP_EXE);
    if target.exists() {
        let old = dir.join(format!("WavePlug.old-{}.exe", std::process::id()));
        std::fs::rename(&target, &old).map_err(|e| format!("替换不了正在使用的 {}：{e}", target.display()))?;
    }
    write_new(&target, exe)?;
    write_new(&dir.join(PACK), pack)?;
    std::fs::write(dir.join(MARKER), version).map_err(|e| e.to_string())?;
    log(format!("WavePlug {version} 已放到 {}", dir.display()));
    let size_kb = ((exe.len() + pack.len()) / 1024) as u32;
    let exe_s = target.display().to_string();
    paths::reg_set(paths::REG_KEY, &[("InstallDir", dir.display().to_string()), ("Version", version.to_string())])?;
    paths::reg_set(paths::UNINSTALL_KEY, &[
        ("DisplayName", "WavePlug".into()),
        ("DisplayVersion", version.into()),
        ("Publisher", "WavePlug".into()),
        ("InstallLocation", dir.display().to_string()),
        ("DisplayIcon", exe_s.clone()),
        ("UninstallString", format!("\"{exe_s}\" --uninstall")),
        ("NoModify", "dword:1".into()),
        ("NoRepair", "dword:1".into()),
        ("EstimatedSize", format!("dword:{size_kb}")),
    ])?;
    log("已登记到 Windows「应用」列表（可以从那里卸载）".into());
    shortcuts(&target, desktop, log);
    remove_self_shortcut();
    Ok(target)
}

/// Writes `bytes` beside `to` first, then moves it into place (never a half-written file).
fn write_new(to: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = to.with_extension("new");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写不了 {}：{e}", to.display()))?;
    let _ = std::fs::remove_file(to);
    std::fs::rename(&tmp, to).map_err(|e| format!("放不进 {}：{e}", to.display()))
}

fn shortcuts(target: &Path, desktop: bool, log: Log) {
    if !cfg!(windows) {
        return;
    }
    let t = target.display().to_string().replace('\'', "''");
    let mut places = vec!["Programs"];
    if desktop {
        places.push("Desktop");
    }
    for place in places {
        let script = format!(
            "$p = Join-Path ([Environment]::GetFolderPath('{place}')) 'WavePlug.lnk'; $s = (New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath = '{t}'; $s.Arguments = '--show'; $s.WorkingDirectory = (Split-Path '{t}'); $s.IconLocation = '{t},0'; $s.Save()"
        );
        match sys::run("powershell", &["-NoProfile", "-NonInteractive", "-Command", &script]) {
            Ok((0, _)) => log(format!("{}里加了「WavePlug」", if place == "Desktop" { "桌面" } else { "开始菜单" })),
            Ok((_, out)) | Err(out) => log(format!("快捷方式没建成：{}", out.trim())),
        }
    }
}

/// Everything WavePlug put outside its folder: the Photoshop plugin and the Illustrator panel
/// (when asked), shortcuts, the registry. The folder itself goes after this program quits
/// (`remove_folder_later`).
pub fn uninstall_app(cfg: &Config, plugin: bool, panel: bool, log: Log) -> Result<(), String> {
    if plugin {
        log(remove_plugin(cfg, log)?);
    }
    if panel {
        log(remove_panel()?);
    }
    if cfg!(windows) {
        let _ = sys::run("powershell", &["-NoProfile", "-NonInteractive", "-Command", "foreach ($f in 'Programs','Desktop') { Remove-Item (Join-Path ([Environment]::GetFolderPath($f)) 'WavePlug.lnk') -ErrorAction SilentlyContinue }"]);
    }
    remove_self_shortcut();
    crate::paths::reg_delete_tree(crate::paths::UNINSTALL_KEY);
    crate::paths::reg_delete_tree(crate::paths::REG_KEY);
    log("快捷方式和登记已删除".into());
    Ok(())
}

/// Deletes `dir` a few seconds after this program has quit (a running exe can't delete itself).
pub fn remove_folder_later(dir: &Path) -> Result<(), String> {
    if !dir.join(crate::paths::MARKER).is_file() {
        return Err(format!("{} 不是 WavePlug 的安装文件夹，不删除", dir.display()));
    }
    let cmd = format!("ping -n 4 127.0.0.1 >nul & rmdir /s /q \"{}\"", dir.display());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").raw_arg(format!("/c {cmd}")).creation_flags(0x0800_0000).current_dir(std::env::temp_dir()).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = cmd;
    Ok(())
}

/// The Start menu entry of the earlier separate setup program (WavePlug 设置), if it is there.
pub fn remove_self_shortcut() {
    if cfg!(windows) {
        let _ = sys::run("powershell", &["-NoProfile", "-NonInteractive", "-Command", "Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'WavePlug 设置.lnk') -ErrorAction SilentlyContinue"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_files_land_in_place_and_replace_the_old_ones() {
        let root = std::env::temp_dir().join(format!("wp-panel-{}", std::process::id()));
        let dir = root.join(AI_ID);
        std::fs::create_dir_all(dir.join("old")).unwrap();
        std::fs::write(dir.join("old").join("stale.js"), b"x").unwrap();
        remove_folder(&dir).unwrap();
        assert!(!dir.exists());
        // removing what isn't there is fine
        remove_folder(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn upia_is_looked_for_where_configured_first() {
        let cfg = Config { upia: " D:\\UPIA\\UnifiedPluginInstallerAgent.exe ".into(), ..Default::default() };
        let c = upia_candidates(&cfg);
        assert_eq!(c[0], PathBuf::from("D:\\UPIA\\UnifiedPluginInstallerAgent.exe"));
        assert!(c[1].to_string_lossy().ends_with("UnifiedPluginInstallerAgent.exe"));
        // Creative Cloud's place first, then a hand-unpacked one on any drive
        let d = upia_candidates(&Config::default());
        assert!(d[0].to_string_lossy().contains("RemoteComponents"));
        assert!(d.iter().any(|p| p.to_string_lossy().starts_with("D:\\App\\Adobe-UPIA-Extract")));
    }

    #[test]
    fn config_survives_unknown_and_missing_fields() {
        let c: Config = serde_json::from_str(r#"{"ps_exe":"D:\\PS\\Photoshop.exe","later":1}"#).unwrap();
        assert_eq!(c.ps_exe, "D:\\PS\\Photoshop.exe");
        assert_eq!(c.update_url, "");
    }
}
