// Where WavePlug keeps its files. Installed (WavePlug_Setup.exe put it in a folder the user chose):
// everything lives inside that folder — `data\` for settings and logs, `data\cache\` for caches —
// so removing the folder removes it all. The folder is marked by MARKER next to WavePlug.exe and
// remembered in HKCU\Software\WavePlug (InstallDir) for the copy inside the Photoshop plugin.
// Not installed (a developer build, the copy in the plugin folder with nothing installed):
// %LOCALAPPDATA%\WavePlug as before.
//
// Shared by both programs (the setup bin includes this file with #[path]).

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// the file that marks an installed WavePlug folder
pub const MARKER: &str = "WavePlug.installed";
/// the program's name in the installed folder
pub const APP_EXE: &str = "WavePlug.exe";
/// what it installs from (the installer's payload, kept for installing / repairing later)
pub const PACK: &str = "WavePlug.pak";
pub const REG_KEY: &str = "Software\\WavePlug";
pub const UNINSTALL_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WavePlug";

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// This exe runs from the installed folder.
pub fn running_installed() -> bool {
    exe_dir().is_some_and(|d| d.join(MARKER).is_file())
}

/// The installed folder: this exe's when it is one, else the one the registry names (if it still
/// is one).
pub fn install_dir() -> Option<PathBuf> {
    if let Some(d) = exe_dir().filter(|d| d.join(MARKER).is_file()) {
        return Some(d);
    }
    registered_dir()
}

pub fn registered_dir() -> Option<PathBuf> {
    let d = PathBuf::from(reg_get(REG_KEY, "InstallDir")?);
    d.join(MARKER).is_file().then_some(d)
}

/// Settings and logs.
pub fn data_root() -> PathBuf {
    match install_dir() {
        Some(d) => d.join("data"),
        None => {
            let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            base.join("WavePlug")
        }
    }
}

/// Caches (dragged layers, downloads): `data\cache\<name>`.
pub fn cache_dir(name: &str) -> PathBuf {
    data_root().join("cache").join(name)
}

pub fn logs_dir() -> PathBuf {
    data_root().join("logs")
}

/// The folder kept for a ComfyUI pack inside the install folder: unzip WavePlug's ComfyUI pack
/// here (with or without its top folder) and it is used without choosing a launcher.
pub const COMFY_DIR: &str = "comfyui";
/// the pack's launcher (F:\ComfyUI_WavePlug\run_waveplug.bat when it was built)
pub const COMFY_LAUNCHER: &str = "run_waveplug.bat";

pub fn comfy_dir() -> Option<PathBuf> {
    install_dir().map(|d| d.join(COMFY_DIR))
}

/// The pack's launcher in `dir`: right inside it, or one folder down (a zip with a top folder).
pub fn find_comfy_launcher(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join(COMFY_LAUNCHER);
    if direct.is_file() {
        return Some(direct);
    }
    let mut subs: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    subs.sort();
    subs.into_iter().map(|p| p.join(COMFY_LAUNCHER)).find(|p| p.is_file())
}

/// The ComfyUI to start: the launcher the user chose, else the pack in the install folder.
pub fn comfy_launcher(chosen: &str) -> String {
    if !chosen.trim().is_empty() {
        return chosen.to_string();
    }
    comfy_dir().and_then(|d| find_comfy_launcher(&d)).map(|p| p.display().to_string()).unwrap_or_default()
}

/// The data folder for an install folder (the installer, before anything runs from there).
pub fn data_root_in(install: &Path) -> PathBuf {
    install.join("data")
}

// ── the current user's registry (HKCU) ──

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
pub fn reg_get(key: &str, name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let (k, n) = (wide(key), wide(name));
    let mut len: u32 = 0;
    unsafe {
        if RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), n.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut len) != 0 || len < 2 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        if RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), n.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as _, &mut len) != 0 {
            return None;
        }
        let end = buf.iter().position(|&u| u == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

#[cfg(not(windows))]
pub fn reg_get(_key: &str, _name: &str) -> Option<String> {
    None
}

/// Sets string values (REG_SZ) or numbers (REG_DWORD, given as "dword:N") under HKCU\`key`.
#[cfg(windows)]
pub fn reg_set(key: &str, values: &[(&str, String)]) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, REG_SZ};
    let k = wide(key);
    for (name, value) in values {
        let n = wide(name);
        let r = unsafe {
            if let Some(num) = value.strip_prefix("dword:").and_then(|v| v.parse::<u32>().ok()) {
                RegSetKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), n.as_ptr(), REG_DWORD, &num as *const u32 as _, 4)
            } else {
                let v = wide(value);
                RegSetKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), n.as_ptr(), REG_SZ, v.as_ptr() as _, (v.len() * 2) as u32)
            }
        };
        if r != 0 {
            return Err(format!("写注册表 {key}\\{name} 失败（{r}）"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn reg_set(_key: &str, _values: &[(&str, String)]) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn reg_delete_tree(key: &str) {
    use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
    let k = wide(key);
    unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, k.as_ptr()) };
}

#[cfg(not(windows))]
pub fn reg_delete_tree(_key: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comfy_pack_is_found_with_or_without_its_top_folder() {
        let root = std::env::temp_dir().join(format!("wp-comfy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ComfyUI_WavePlug")).unwrap();
        assert_eq!(find_comfy_launcher(&root), None);
        std::fs::write(root.join("ComfyUI_WavePlug").join(COMFY_LAUNCHER), "").unwrap();
        assert_eq!(find_comfy_launcher(&root), Some(root.join("ComfyUI_WavePlug").join(COMFY_LAUNCHER)));
        std::fs::write(root.join(COMFY_LAUNCHER), "").unwrap();
        assert_eq!(find_comfy_launcher(&root), Some(root.join(COMFY_LAUNCHER)));
        // a launcher the user chose wins
        assert_eq!(comfy_launcher("D:\\X\\run.bat"), "D:\\X\\run.bat");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn data_lives_inside_an_install_folder() {
        assert_eq!(data_root_in(Path::new("D:\\Tools\\WavePlug")), PathBuf::from("D:\\Tools\\WavePlug").join("data"));
        // not installed while testing: the per-user folder
        assert!(!running_installed());
        assert!(cache_dir("x").ends_with(Path::new("cache").join("x")));
    }
}
