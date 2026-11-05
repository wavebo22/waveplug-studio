// The helper's own lifetime across updates.
//
// The plugin starts this exe when Photoshop starts (src/main.uxp.ts launchOverlay) and it quits
// when Photoshop's process ends (win.rs watch). Updating it must not need it stopped first:
// build.cmd / scripts/build.mjs rename the running exe to waveplug-overlay.old-*.exe (Windows
// lets a running exe be renamed, not overwritten) and put the new one in its place. This copy
// notices the file at its path changed and restarts into it, handing the ComfyUI it started to the
// new copy (comfy.rs handover / adopt) so a generation in progress keeps running.
//
// A restart: create the handover event, start `<exe> --replace`, wait until the new copy says it
// took ComfyUI (at most HANDOVER_WAIT), quit. The new copy waits for the port to come free.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime};

/// this exe's path as it was started (a later rename of the running file doesn't change it)
static EXE: OnceLock<PathBuf> = OnceLock::new();

const HANDOVER_EVENT: &str = "Local\\WavePlugHelperHandover";
const HANDOVER_WAIT: Duration = Duration::from_secs(8);
/// how often the exe on disk is looked at (one metadata read)
const UPDATE_CHECK: Duration = Duration::from_secs(2);

/// Started by a previous copy that is restarting.
pub fn replacing() -> bool {
    std::env::args().any(|a| a == "--replace")
}

/// Call first thing: remembers the exe, removes renamed old copies, tells a restarting previous
/// copy the ComfyUI handover is done, and watches the exe for updates.
pub fn init() {
    let Ok(exe) = std::env::current_exe() else { return };
    let _ = EXE.set(exe.clone());
    remove_old_copies(&exe);
    if replacing() {
        crate::comfy::adopt();
        signal_handover();
    }
    let start = stamp(&exe);
    thread::spawn(move || watch_updates(exe, start));
}

/// The exe file's size and time: changes when a build puts a new one in place.
fn stamp(p: &PathBuf) -> Option<(u64, SystemTime)> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// Whether the file at the exe's path is a different build than the one running, and has stopped
/// changing (seen the same twice, so a copy still being written isn't started).
fn updated(start: Option<(u64, SystemTime)>, prev: Option<(u64, SystemTime)>, now: Option<(u64, SystemTime)>) -> bool {
    now.is_some() && now != start && now == prev
}

fn watch_updates(exe: PathBuf, start: Option<(u64, SystemTime)>) {
    let mut prev = start;
    loop {
        thread::sleep(UPDATE_CHECK);
        let now = stamp(&exe);
        if updated(start, prev, now) {
            restart("exe updated");
            return;
        }
        prev = now;
    }
}

/// waveplug-overlay.old-*.exe beside the exe: what a build renamed out of the way
fn remove_old_copies(exe: &PathBuf) {
    let Some(dir) = exe.parent() else { return };
    let Ok(list) = std::fs::read_dir(dir) else { return };
    for e in list.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("waveplug-overlay.old-") && name.ends_with(".exe") {
            // still running (another copy) → fails, removed next time
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Starts the exe on disk again and quits this copy, keeping the ComfyUI it started.
pub fn restart(reason: &str) {
    let Some(exe) = EXE.get().cloned() else { return };
    crate::log::line(format!("restarting helper: {reason}"));
    let event = handover_event();
    crate::comfy::handover();
    match std::process::Command::new(&exe).arg("--replace").spawn() {
        Ok(child) => {
            crate::log::line(format!("new helper pid={}", child.id()));
            wait_handover(event);
        }
        // nothing to restart into: carry on as before rather than leave no helper running
        Err(e) => {
            crate::log::line(format!("restart failed: {e}"));
            crate::comfy::adopt();
            return;
        }
    }
    std::process::exit(0);
}

#[cfg(windows)]
fn handover_event() -> isize {
    use windows_sys::Win32::System::Threading::CreateEventW;
    let name: Vec<u16> = HANDOVER_EVENT.encode_utf16().chain(Some(0)).collect();
    unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) as isize }
}

#[cfg(windows)]
fn wait_handover(event: isize) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    if event == 0 {
        thread::sleep(HANDOVER_WAIT);
        return;
    }
    let r = unsafe { WaitForSingleObject(event as _, HANDOVER_WAIT.as_millis() as u32) };
    crate::log::line(if r == 0 { "handover confirmed" } else { "handover not confirmed in time" });
    unsafe { CloseHandle(event as _) };
}

#[cfg(windows)]
fn signal_handover() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};
    let name: Vec<u16> = HANDOVER_EVENT.encode_utf16().chain(Some(0)).collect();
    let h = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if !h.is_null() {
        unsafe {
            SetEvent(h);
            CloseHandle(h);
        }
    }
}

#[cfg(not(windows))]
fn handover_event() -> isize {
    0
}

#[cfg(not(windows))]
fn wait_handover(_event: isize) {
    thread::sleep(Duration::from_millis(500));
}

#[cfg(not(windows))]
fn signal_handover() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_only_into_a_settled_new_build() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let t1 = SystemTime::UNIX_EPOCH + Duration::from_secs(200);
        let start = Some((10, t0));
        // unchanged
        assert!(!updated(start, start, start));
        // just replaced: wait one more look in case it is still being written
        assert!(!updated(start, start, Some((5, t1))));
        // the same new file twice
        assert!(updated(start, Some((20, t1)), Some((20, t1))));
        // gone for the moment (between rename and copy)
        assert!(!updated(start, None, None));
    }
}
