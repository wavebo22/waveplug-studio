// 卡死保护: notices when Photoshop stops responding and offers what can still be done from outside.
//
// A hung Photoshop can't be made to save anything: the plugin runs inside it and hangs with it,
// and nothing outside can write a PSD. What is left is Photoshop's own auto-recovery files (it
// writes them every few minutes, 首选项 › 文件处理 › 自动存储恢复信息间隔, into PSAutoRecover at
// the root of the first scratch disk). Once Photoshop is killed they may be gone or overwritten,
// so this copies them somewhere safe: beside the document they belong to (matched by name), or,
// when no open document matches, into PSAutoRecover_卡死备份\<time>\ next to the recovery folder.
//
// The watcher thread asks Photoshop's main window for an answer every second (WM_NULL with
// SMTO_ABORTIFHUNG; Windows itself calls a window hung after 5 s without messages). After
// `seconds` without one it puts up a dialog (host.rs `hang_dialog`): 继续等待 / 备份恢复文件 /
// 关闭 Photoshop (备份后关闭 or 直接关闭, confirmed first). With `auto_backup` the copy starts
// as soon as the hang is noticed. If Photoshop answers again the dialog goes away by itself.
//
// The plugin only sends the switch and the open documents' names and paths (`hang-guard`), while
// Photoshop still runs; the settings stay when the plugin's connection goes, since a hung
// Photoshop can't send them again.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// An open document, as the plugin last reported it; `path` is "" for one never saved.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DocInfo {
    pub name: String,
    #[serde(default)]
    pub path: String,
}

/// What the dialog shows.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DialogView {
    /// how long Photoshop hasn't answered
    pub seconds: u64,
    /// a backup is being written
    pub busy: bool,
    /// the last backup's result
    pub backup: Option<String>,
    /// where the last backup went (for 打开备份位置)
    pub backup_dir: Option<PathBuf>,
    /// 关闭 Photoshop was clicked: asking to confirm
    pub confirm_close: bool,
    /// Photoshop is being closed
    pub closing: bool,
}

/// A button in the dialog.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Choice {
    Wait,
    Backup,
    AskClose,
    CancelClose,
    Close { backup: bool },
    OpenBackup,
}

/// The longest open document name (without extension) found in a recovery file's name, ignoring
/// case: the document that file most likely belongs to.
pub fn match_doc<'a>(file_name: &str, docs: &'a [DocInfo]) -> Option<&'a DocInfo> {
    let file = file_name.to_lowercase();
    docs.iter()
        .filter_map(|d| {
            let stem = stem(&d.name).to_lowercase();
            (stem.chars().count() >= 2 && file.contains(&stem)).then_some((stem.len(), d))
        })
        .max_by_key(|(n, _)| *n)
        .map(|(_, d)| d)
}

fn stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

fn ext(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[i..],
        _ => ".psb",
    }
}

/// Where one recovery file is copied: beside its document (`<stem>_卡死备份_<stamp><ext>`), or
/// into `<recovery folder's parent>\PSAutoRecover_卡死备份\<stamp>\` when no saved document matches.
pub fn backup_target(file: &Path, recovery_root: &Path, docs: &[DocInfo], stamp: &str) -> PathBuf {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(doc) = match_doc(&name, docs) {
        // the plugin's path is a Windows path: split it by hand, the same on every system
        if let Some(dir) = doc.path.rfind(['\\', '/']).map(|i| &doc.path[..i]).filter(|d| !d.is_empty()) {
            return PathBuf::from(dir).join(format!("{}_卡死备份_{stamp}{}", stem(&doc.name), ext(&name)));
        }
    }
    let base = recovery_root.parent().unwrap_or(recovery_root);
    base.join("PSAutoRecover_卡死备份").join(stamp).join(name)
}

/// `path`, or `path` with " (2)", " (3)" … before the extension when it is taken.
pub fn free_name(path: PathBuf, exists: impl Fn(&Path) -> bool) -> PathBuf {
    if !exists(&path) {
        return path;
    }
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (s, e) = match file.rfind('.') {
        Some(i) if i > 0 => (file[..i].to_string(), file[i..].to_string()),
        _ => (file.clone(), String::new()),
    };
    for n in 2.. {
        let p = path.with_file_name(format!("{s} ({n}){e}"));
        if !exists(&p) {
            return p;
        }
    }
    unreachable!()
}

pub fn stamp(y: u16, mo: u16, d: u16, h: u16, mi: u16, s: u16) -> String {
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// When to put the dialog up again after 继续等待: another minute.
pub const WAIT_MORE_SECS: u64 = 60;

#[cfg(windows)]
pub use imp::{choose, configure, dialog};

#[cfg(not(windows))]
pub fn configure(_on: bool, _auto_backup: bool, _seconds: u64, _docs: Vec<DocInfo>) {}

#[cfg(not(windows))]
pub fn dialog() -> Option<DialogView> {
    None
}

#[cfg(not(windows))]
pub fn choose(_c: Choice) {}

#[cfg(windows)]
mod imp {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Mutex, Once};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, HWND, SYSTEMTIME};
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess};
    use windows_sys::Win32::UI::WindowsAndMessaging::SendMessageTimeoutW;

    use super::{backup_target, free_name, stamp, Choice, DialogView, DocInfo, WAIT_MORE_SECS};
    use crate::log;

    const WM_NULL: u32 = 0;
    const SMTO_BLOCK: u32 = 0x0001;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    const DRIVE_FIXED: u32 = 3;
    const PROCESS_TERMINATE: u32 = 0x0001;

    static ON: AtomicBool = AtomicBool::new(false);
    static AUTO_BACKUP: AtomicBool = AtomicBool::new(true);
    static SECONDS: AtomicU64 = AtomicU64::new(20);
    static DOCS: Mutex<Vec<DocInfo>> = Mutex::new(Vec::new());
    static DIALOG: Mutex<Option<DialogView>> = Mutex::new(None);
    /// seconds of hang after which the dialog comes (again)
    static ASK_AT: AtomicU64 = AtomicU64::new(20);
    static START: Once = Once::new();

    pub fn configure(on: bool, auto_backup: bool, seconds: u64, docs: Vec<DocInfo>) {
        let seconds = seconds.clamp(5, 600);
        if ON.swap(on, Ordering::SeqCst) != on || SECONDS.swap(seconds, Ordering::SeqCst) != seconds {
            log::line(format!("hang guard: on={on} autoBackup={auto_backup} after {seconds}s"));
        }
        AUTO_BACKUP.store(auto_backup, Ordering::SeqCst);
        if let Ok(mut d) = DOCS.lock() {
            *d = docs;
        }
        if on {
            START.call_once(|| {
                thread::spawn(watch);
            });
        }
    }

    pub fn dialog() -> Option<DialogView> {
        DIALOG.lock().ok().and_then(|d| d.clone())
    }

    fn update(f: impl FnOnce(&mut DialogView)) {
        if let Ok(mut d) = DIALOG.lock() {
            if let Some(v) = d.as_mut() {
                f(v);
            }
        }
        crate::host::wake();
    }

    pub fn choose(c: Choice) {
        log::line(format!("hang dialog: {c:?}"));
        match c {
            Choice::Wait => {
                let now = dialog().map(|d| d.seconds).unwrap_or(0);
                ASK_AT.store(now + WAIT_MORE_SECS, Ordering::SeqCst);
                if let Ok(mut d) = DIALOG.lock() {
                    *d = None;
                }
                crate::host::wake();
            }
            Choice::Backup => start_backup(),
            Choice::AskClose => update(|d| d.confirm_close = true),
            Choice::CancelClose => update(|d| d.confirm_close = false),
            Choice::Close { backup } => {
                update(|d| {
                    d.closing = true;
                    d.busy = backup;
                });
                thread::spawn(move || {
                    if backup {
                        run_backup();
                    }
                    terminate_photoshop();
                });
            }
            Choice::OpenBackup => {
                if let Some(dir) = dialog().and_then(|d| d.backup_dir) {
                    let _ = std::process::Command::new("explorer.exe").arg(dir).spawn();
                }
            }
        }
    }

    /// Photoshop answers a message within a second (a busy-but-alive Photoshop does: it keeps its
    /// message loop going during long operations, and modal dialogs pump messages too).
    fn answers(h: HWND) -> bool {
        let mut result = 0usize;
        unsafe { SendMessageTimeoutW(h, WM_NULL, 0, 0, SMTO_BLOCK | SMTO_ABORTIFHUNG, 1000, &mut result) != 0 }
    }

    fn watch() {
        let mut hung_since: Option<Instant> = None;
        loop {
            thread::sleep(Duration::from_secs(1));
            let h = crate::win::photoshop_main_hwnd();
            if !ON.load(Ordering::SeqCst) || h.is_null() {
                hung_since = None;
                close_dialog(false);
                continue;
            }
            if answers(h) {
                if let Some(t) = hung_since.take() {
                    log::line(format!("hang guard: Photoshop answers again after {}s", t.elapsed().as_secs()));
                    close_dialog(true);
                }
                ASK_AT.store(SECONDS.load(Ordering::SeqCst), Ordering::SeqCst);
                continue;
            }
            let since = *hung_since.get_or_insert_with(|| {
                log::line("hang guard: Photoshop not responding");
                Instant::now()
            });
            // the 1 s wait for the answer counts too
            let secs = since.elapsed().as_secs() + 1;
            let shown = DIALOG.lock().map(|d| d.is_some()).unwrap_or(false);
            if shown {
                update(|d| d.seconds = secs);
            } else if secs >= ASK_AT.load(Ordering::SeqCst) {
                log::line(format!("hang guard: asking after {secs}s"));
                if let Ok(mut d) = DIALOG.lock() {
                    *d = Some(DialogView { seconds: secs, ..Default::default() });
                }
                crate::host::wake();
                if AUTO_BACKUP.load(Ordering::SeqCst) && dialog().is_some_and(|d| d.backup.is_none()) {
                    start_backup();
                }
            }
        }
    }

    fn close_dialog(recovered: bool) {
        let was = DIALOG.lock().map(|mut d| d.take().is_some()).unwrap_or(false);
        if was {
            crate::host::wake();
            if recovered {
                crate::host::notify("Photoshop 已恢复响应", "可以继续工作了。建议马上保存一次。");
            }
        }
    }

    fn start_backup() {
        if dialog().is_some_and(|d| d.busy) {
            return;
        }
        update(|d| d.busy = true);
        thread::spawn(run_backup);
    }

    fn now_stamp() -> String {
        let mut t: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut t) };
        stamp(t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// PSAutoRecover at the root of every fixed drive (Photoshop puts it on the first scratch
    /// disk), and the older place under %APPDATA%\Adobe\Adobe Photoshop *\AutoRecover.
    fn recovery_dirs() -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26u8 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + i) as char);
            if unsafe { GetDriveTypeW(wide(&root).as_ptr()) } != DRIVE_FIXED {
                continue;
            }
            let p = PathBuf::from(&root).join("PSAutoRecover");
            if p.is_dir() {
                out.push(p);
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            if let Ok(rd) = std::fs::read_dir(PathBuf::from(appdata).join("Adobe")) {
                for e in rd.flatten() {
                    let p = e.path().join("AutoRecover");
                    if e.file_name().to_string_lossy().starts_with("Adobe Photoshop") && p.is_dir() {
                        out.push(p);
                    }
                }
            }
        }
        out
    }

    fn files_in(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() && depth > 0 => files_in(&p, depth - 1, out),
                Ok(t) if t.is_file() => out.push(p),
                _ => {}
            }
        }
    }

    fn gb(bytes: u64) -> String {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }

    /// Copies every recovery file; the dialog shows the result.
    fn run_backup() {
        let docs = DOCS.lock().map(|d| d.clone()).unwrap_or_default();
        let st = now_stamp();
        let (mut copied, mut bytes, mut failed) = (0usize, 0u64, Vec::<String>::new());
        let mut first_dir: Option<PathBuf> = None;
        let dirs = recovery_dirs();
        for root in &dirs {
            let mut files = Vec::new();
            files_in(root, 3, &mut files);
            for f in files {
                let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
                log::line(format!("hang backup: found {} ({} bytes)", f.display(), size));
                if size == 0 {
                    continue;
                }
                let to = free_name(backup_target(&f, root, &docs, &st), |p| p.exists());
                let done = to.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::copy(&f, &to));
                match done {
                    Ok(n) => {
                        log::line(format!("hang backup: copied to {}", to.display()));
                        copied += 1;
                        bytes += n;
                        if first_dir.is_none() {
                            first_dir = to.parent().map(Path::to_path_buf);
                        }
                    }
                    Err(e) => {
                        log::line(format!("hang backup: copy to {} failed: {e}", to.display()));
                        failed.push(f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                    }
                }
            }
        }
        let text = if copied == 0 && failed.is_empty() {
            if dirs.is_empty() {
                "没有找到自动恢复文件夹（PSAutoRecover）。请确认首选项里打开了「自动存储恢复信息」。".to_string()
            } else {
                "自动恢复文件夹里没有文件：Photoshop 还没自动存储过，或者文档都已保存。".to_string()
            }
        } else {
            let mut t = format!("已备份 {copied} 个恢复文件（{}）", gb(bytes));
            if let Some(d) = &first_dir {
                t += &format!("，位置：{}", d.display());
            }
            if !failed.is_empty() {
                t += &format!("。{} 个复制失败：{}", failed.len(), failed.join("、"));
            }
            t
        };
        log::line(format!("hang backup: {text}"));
        update(|d| {
            d.busy = false;
            d.backup = Some(text);
            d.backup_dir = first_dir;
        });
    }

    fn terminate_photoshop() {
        let pid = crate::win::photoshop_main_pid();
        if pid == 0 {
            log::line("hang guard: no Photoshop to close");
            return;
        }
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                log::line(format!("hang guard: can't open Photoshop pid={pid} to close it"));
                update(|d| {
                    d.closing = false;
                    d.backup = Some("无法关闭 Photoshop（没有权限）。请用任务管理器结束它。".into());
                });
                return;
            }
            let ok = TerminateProcess(h, 1) != 0;
            CloseHandle(h);
            log::line(format!("hang guard: Photoshop pid={pid} terminated={ok}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(name: &str, path: &str) -> DocInfo {
        DocInfo { name: name.into(), path: path.into() }
    }

    #[test]
    fn recovery_file_goes_beside_its_document() {
        let docs = [doc("海报.psd", "D:\\设计\\海报.psd"), doc("未标题-1", "")];
        let root = Path::new("G:").join("PSAutoRecover");
        let to = backup_target(&root.join("User").join("海报_ABC123.psb"), &root, &docs, "20261114-160000");
        assert_eq!(to, Path::new("D:\\设计").join("海报_卡死备份_20261114-160000.psb"));
    }

    #[test]
    fn unmatched_or_unsaved_goes_next_to_the_recovery_folder() {
        let docs = [doc("海报.psd", "D:\\设计\\海报.psd"), doc("未标题-1", "")];
        let root = Path::new("G:").join("PSAutoRecover");
        let base = Path::new("G:").join("PSAutoRecover_卡死备份").join("20261114-160000");
        assert_eq!(backup_target(&root.join("x").join("other.psb"), &root, &docs, "20261114-160000"), base.join("other.psb"));
        // a document never saved has no folder of its own
        assert_eq!(backup_target(&root.join("未标题-1_1.psb"), &root, &docs, "20261114-160000"), base.join("未标题-1_1.psb"));
    }

    #[test]
    fn longest_name_wins_and_case_is_ignored() {
        let docs = [doc("a.psd", "C:\\a.psd"), doc("Poster.psd", "C:\\p\\Poster.psd"), doc("Poster_v2.psd", "C:\\p\\Poster_v2.psd")];
        assert_eq!(match_doc("poster_V2_123.psb", &docs).map(|d| d.name.as_str()), Some("Poster_v2.psd"));
        assert_eq!(match_doc("POSTER_9.psb", &docs).map(|d| d.name.as_str()), Some("Poster.psd"));
        // one-letter names match too much to mean anything
        assert_eq!(match_doc("abc.psb", &docs), None);
    }

    #[test]
    fn taken_names_get_a_number() {
        let dir = Path::new("D:").join("x");
        let taken = [dir.join("a.psb"), dir.join("a (2).psb")];
        let p = free_name(dir.join("a.psb"), |p| taken.iter().any(|t| t == p));
        assert_eq!(p, dir.join("a (3).psb"));
        assert_eq!(free_name(dir.join("b.psb"), |_| false), dir.join("b.psb"));
    }

    #[test]
    fn stamp_is_sortable() {
        assert_eq!(stamp(2026, 11, 4, 9, 5, 7), "20261104-090507");
    }
}
