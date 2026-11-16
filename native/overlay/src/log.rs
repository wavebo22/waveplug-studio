// The helper's own log, next to the plugin's: reports/overlay_runtime.log when the exe runs from
// dist/ (dist/../reports), else in WavePlug's logs folder (paths.rs: inside the install folder). For evidence when something misbehaves in
// Photoshop (who has the keyboard, when the panel was placed). Kept under 1 MB.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: Mutex<Option<File>> = Mutex::new(None);

fn path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let reports = dir.parent().map(|p| p.join("reports")).filter(|p| p.is_dir());
    let dir = reports.unwrap_or_else(crate::paths::logs_dir);
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("overlay_runtime.log"))
}

pub fn init() {
    let Some(p) = path() else { return };
    let fresh = std::fs::metadata(&p).map(|m| m.len() > 1_000_000).unwrap_or(false);
    let file = if fresh { File::create(&p) } else { OpenOptions::new().create(true).append(true).open(&p) };
    if let (Ok(f), Ok(mut slot)) = (file, FILE.lock()) { *slot = Some(f); }
    line(format!("start {}", env!("CARGO_PKG_VERSION")));
}

pub fn line(msg: impl AsRef<str>) {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut slot) = FILE.lock() {
        if let Some(f) = slot.as_mut() { let _ = writeln!(f, "{ms} {}", msg.as_ref()); }
    }
}
