// Installing, updating and removing WavePlug: the Photoshop plugin (copied into Adobe's plugin
// folder and registered in its plugin list, the way Adobe's installer does it, but without
// Creative Cloud: administrator rights and Photoshop closed), the Illustrator panel (a CEP extension copied into the user's extensions
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
pub const AI_ID: &str = "com.waveplug.ai.wavelayer";
pub const HELPER_EXE: &str = "waveplug-overlay.exe";

/// What the user chose, kept in <data>\setup.json.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub ps_exe: String,
    pub ai_exe: String,
    /// Adobe's installer (UPIA), from before the plugin was installed without it: kept so older
    /// setup.json files still read
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

// ── the Photoshop plugin, without Adobe's installer ──
// What UPIA does, done here: the plugin's files go to
//   %CommonProgramFiles%\Adobe\UXP\Plugins\External\<id>_<version>
// and Adobe's plugin list %CommonProgramFiles%\Adobe\UXP\PluginsInfo\v1\PS.json gets an entry
//   { hostMinVersion, name, path: "$systemPlugins\\External\\<id>_<version>", pluginId,
//     status: "enabled", type: "uxp", versionString }
// Photoshop reads that list when it starts. Both places are under Program Files: one Windows
// administrator prompt per install / removal. No Creative Cloud, no UPIA.

fn uxp_root() -> PathBuf {
    common_files().join("Adobe").join("UXP")
}

fn ps_list() -> PathBuf {
    uxp_root().join("PluginsInfo").join("v1").join("PS.json")
}

/// Adobe's plugin list with `id` (re)registered at `version` (any older entry of it replaced).
pub fn uxp_register(list: &str, id: &str, name: &str, version: &str, host_min: &str) -> Result<String, String> {
    let mut v = uxp_parse(list)?;
    let plugins = v["plugins"].as_array_mut().ok_or("PS.json 里的 plugins 不是列表")?;
    plugins.retain(|p| p.get("pluginId").and_then(|x| x.as_str()) != Some(id));
    plugins.push(serde_json::json!({
        "hostMinVersion": host_min,
        "name": name,
        "path": format!("$systemPlugins\\External\\{id}_{version}"),
        "pluginId": id,
        "status": "enabled",
        "type": "uxp",
        "versionString": version,
    }));
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

/// Adobe's plugin list without `id`.
pub fn uxp_unregister(list: &str, id: &str) -> Result<String, String> {
    let mut v = uxp_parse(list)?;
    if let Some(plugins) = v["plugins"].as_array_mut() {
        plugins.retain(|p| p.get("pluginId").and_then(|x| x.as_str()) != Some(id));
    }
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

/// The list's text (a missing or empty file is an empty list).
fn uxp_parse(list: &str) -> Result<serde_json::Value, String> {
    let t = list.trim_start_matches('\u{feff}').trim();
    let mut v: serde_json::Value = if t.is_empty() { serde_json::json!({}) } else { serde_json::from_str(t).map_err(|e| format!("Adobe 的插件列表 PS.json 看不懂：{e}"))? };
    if !v.is_object() {
        return Err("Adobe 的插件列表 PS.json 格式不对".into());
    }
    if !v["plugins"].is_array() {
        v["plugins"] = serde_json::json!([]);
    }
    Ok(v)
}

/// PowerShell text: a single-quoted string.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Runs `body` as administrator (PowerShell, one Windows prompt) after the common preamble; Err
/// with what went wrong.
fn elevated_ps(work: &Path, body: &str, log: Log) -> Result<(), String> {
    let script = work.join("step.ps1");
    let err = work.join("step.err");
    let _ = std::fs::remove_file(&err);
    let text = format!(
        "$ErrorActionPreference = 'Stop'\r\ntry {{\r\n$ext = Join-Path $env:CommonProgramFiles 'Adobe\\UXP\\Plugins\\External'\r\n$info = Join-Path $env:CommonProgramFiles 'Adobe\\UXP\\PluginsInfo\\v1'\r\nNew-Item -ItemType Directory -Force -Path $ext, $info | Out-Null\r\n{body}\r\n}} catch {{\r\n  Set-Content -LiteralPath {} -Value $_.Exception.Message -Encoding UTF8\r\n  exit 1\r\n}}\r\n",
        ps_quote(&err.to_string_lossy())
    );
    // a BOM: Windows PowerShell 5.1 reads the file as UTF-8 then (paths with Chinese in them)
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(&script, bytes).map_err(|e| e.to_string())?;
    log("Windows 会请求管理员权限（插件装在 Program Files 里）…".into());
    let params = format!("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"", script.display());
    let code = sys::run_elevated("powershell.exe", &params, work)?;
    if code == 0 {
        return Ok(());
    }
    let why = std::fs::read(&err).map(|b| sys::decode(&b)).unwrap_or_default();
    Err(format!("复制插件失败（{code}）：{}", why.trim().trim_start_matches('\u{feff}')))
}

fn work_dir(name: &str) -> Result<PathBuf, String> {
    let d = std::env::temp_dir().join("WavePlug").join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).map_err(|e| format!("建不了临时文件夹 {}：{e}", d.display()))?;
    Ok(d)
}

/// The plugin's files in `to`: from the payload's ps/ folder, or (an older installer) unpacked
/// from its .ccx.
fn stage_plugin(payload: &Payload, work: &Path, to: &Path) -> Result<(), String> {
    let files: Vec<_> = payload.under("ps").collect();
    if !files.is_empty() {
        for (name, data) in &files {
            let p = to.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, data).map_err(|e| format!("写不了 {}：{e}", p.display()))?;
        }
        return Ok(());
    }
    let ccx = payload.get("WavePlug.ccx").ok_or("安装包里没有 Photoshop 插件")?;
    let zip = work.join("plugin.zip");
    std::fs::write(&zip, ccx).map_err(|e| e.to_string())?;
    let cmd = format!(
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory({}, {})",
        ps_quote(&zip.to_string_lossy()),
        ps_quote(&to.to_string_lossy())
    );
    let (code, out) = sys::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &cmd])?;
    if code != 0 {
        return Err(format!("解不开插件包：{}", out.trim()));
    }
    Ok(())
}

/// The Photoshop plugin: copied into Adobe's plugin folder and registered in its plugin list.
pub fn install_plugin(payload: &Payload, version: &str, _cfg: &Config, log: Log) -> Result<String, String> {
    if sys::is_running(App::Photoshop.exe_name()) {
        return Err("请先保存并完全关闭 Photoshop（安装插件时它不能开着）".into());
    }
    // the helper may run from the plugin folder: its exe would stay locked
    if sys::is_running(HELPER_EXE) {
        log("关闭插件文件夹里的外置框架（不关闭文件会被占用）".into());
        sys::kill(HELPER_EXE);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let work = work_dir("ps_install")?;
    let staged = work.join("plugin");
    stage_plugin(payload, &work, &staged)?;
    let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(staged.join("manifest.json")).map_err(|_| "插件包里没有 manifest.json")?)
        .map_err(|e| format!("插件的 manifest.json 看不懂：{e}"))?;
    let id = manifest["id"].as_str().unwrap_or(PLUGIN_ID).to_string();
    let name = manifest["name"].as_str().unwrap_or(PLUGIN_NAME).to_string();
    let ver = manifest["version"].as_str().unwrap_or(version).to_string();
    let host_min = manifest["host"]["minVersion"].as_str().unwrap_or("25.0.0").to_string();
    let list = uxp_register(&std::fs::read_to_string(ps_list()).unwrap_or_default(), &id, &name, &ver, &host_min)?;
    let list_file = work.join("PS.json");
    std::fs::write(&list_file, list).map_err(|e| e.to_string())?;
    log(format!("安装 Photoshop 插件 {ver}（不需要 Creative Cloud）…"));
    let body = format!(
        "Get-ChildItem -LiteralPath $ext -Directory -Filter {old} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue\r\n\
         $to = Join-Path $ext {dir}\r\n\
         if (Test-Path -LiteralPath $to) {{ Remove-Item -LiteralPath $to -Recurse -Force }}\r\n\
         Copy-Item -LiteralPath {from} -Destination $to -Recurse -Force\r\n\
         Copy-Item -LiteralPath {list} -Destination (Join-Path $info 'PS.json') -Force",
        old = ps_quote(&format!("{id}_*")),
        dir = ps_quote(&format!("{id}_{ver}")),
        from = ps_quote(&staged.to_string_lossy()),
        list = ps_quote(&list_file.to_string_lossy()),
    );
    elevated_ps(&work, &body, log)?;
    let _ = std::fs::remove_dir_all(&work);
    match installed_uxp(&id) {
        Some((v, _)) if v == ver => Ok(format!("Photoshop 插件 {ver} 已安装：打开 Photoshop，在「增效工具」里打开 WavePlug")),
        _ => Err("复制完了，Adobe 的插件列表里却没有它".into()),
    }
}

/// Takes plugin `id` out of Adobe's plugin list and deletes its folders.
fn remove_uxp(id: &str, log: Log) -> Result<(), String> {
    if sys::is_running(App::Photoshop.exe_name()) {
        return Err("请先关闭 Photoshop".into());
    }
    let work = work_dir("ps_remove")?;
    let list = uxp_unregister(&std::fs::read_to_string(ps_list()).unwrap_or_default(), id)?;
    let list_file = work.join("PS.json");
    std::fs::write(&list_file, list).map_err(|e| e.to_string())?;
    let body = format!(
        "Get-ChildItem -LiteralPath $ext -Directory -Filter {old} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue\r\n\
         Copy-Item -LiteralPath {list} -Destination (Join-Path $info 'PS.json') -Force",
        old = ps_quote(&format!("{id}_*")),
        list = ps_quote(&list_file.to_string_lossy()),
    );
    elevated_ps(&work, &body, log)?;
    let _ = std::fs::remove_dir_all(&work);
    Ok(())
}

pub fn remove_plugin(_cfg: &Config, log: Log) -> Result<String, String> {
    sys::kill(HELPER_EXE);
    remove_uxp(PLUGIN_ID, log)?;
    Ok("Photoshop 插件已卸载".into())
}

/// The old development plugin, when it is still installed.
pub fn old_dev_plugin() -> Option<(String, bool)> {
    installed_uxp(OLD_DEV_ID)
}

pub fn remove_old_dev_plugin(_cfg: &Config, log: Log) -> Result<String, String> {
    remove_uxp(OLD_DEV_ID, log)?;
    Ok("旧的开发版插件已卸载".into())
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
    // the place kept for the ComfyUI pack (paths::COMFY_DIR); a note says what goes there
    let comfy = dir.join(paths::COMFY_DIR);
    let _ = std::fs::create_dir_all(&comfy);
    let note = comfy.join("把 ComfyUI 压缩包解压到这里.txt");
    if !note.exists() {
        let _ = std::fs::write(&note, "把 WavePlug 的 ComfyUI 压缩包解压到这个文件夹（解压后里面有 run_waveplug.bat）。\r\nWavePlug 会自动用它启动 ComfyUI，不用在插件里选启动文件。\r\n在插件里另外选了启动文件时，以你选的为准。\r\n");
    }
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
    fn plugin_list_registers_like_adobes_installer() {
        // what UPIA wrote on mainpc
        let before = r#"{"plugins":[{"hostMinVersion":"25.0.0","name":"WavePlug Studio Dev","path":"$systemPlugins\\External\\com.waveplug.studio.dev_1.4.1","pluginId":"com.waveplug.studio.dev","status":"enabled","type":"uxp","versionString":"1.4.1"}]}"#;
        let after: serde_json::Value = serde_json::from_str(&uxp_register(before, "com.waveplug.studio", "WavePlug Studio", "1.3.0", "25.0.0").unwrap()).unwrap();
        let list = after["plugins"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1]["path"], "$systemPlugins\\External\\com.waveplug.studio_1.3.0");
        assert_eq!(list[1]["status"], "enabled");
        assert_eq!(detect::uxp_plugin(&after.to_string(), "com.waveplug.studio"), Some(("1.3.0".into(), true)));
        // a newer version replaces the entry; the other plugin stays
        let again = uxp_register(&after.to_string(), "com.waveplug.studio", "WavePlug Studio", "1.3.1", "25.0.0").unwrap();
        assert_eq!(detect::uxp_plugin(&again, "com.waveplug.studio"), Some(("1.3.1".into(), true)));
        assert!(detect::uxp_plugin(&again, "com.waveplug.studio.dev").is_some());
        // removing takes only that one out
        let removed = uxp_unregister(&again, "com.waveplug.studio.dev").unwrap();
        assert!(detect::uxp_plugin(&removed, "com.waveplug.studio.dev").is_none());
        assert!(detect::uxp_plugin(&removed, "com.waveplug.studio").is_some());
        // no list yet (no plugin ever installed), a BOM, garbage
        assert!(detect::uxp_plugin(&uxp_register("", "a", "A", "1", "25").unwrap(), "a").is_some());
        assert!(uxp_unregister("\u{feff}{\"plugins\":[]}", "a").is_ok());
        assert!(uxp_register("<html>", "a", "A", "1", "25").is_err());
    }

    #[test]
    fn powershell_quoting() {
        assert_eq!(ps_quote("C:\\Users\\O'Neil\\x"), "'C:\\Users\\O''Neil\\x'");
    }

    #[test]
    fn config_survives_unknown_and_missing_fields() {
        let c: Config = serde_json::from_str(r#"{"ps_exe":"D:\\PS\\Photoshop.exe","later":1}"#).unwrap();
        assert_eq!(c.ps_exe, "D:\\PS\\Photoshop.exe");
        assert_eq!(c.update_url, "");
    }
}
