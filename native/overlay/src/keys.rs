//! 按键 for the plugin: while a drag from another program (files from Explorer, a web page) is over
//! the WaveLayer panel, UXP tells the panel nothing about the keys. The plugin asks (watch-keys on,
//! renewed while the drag lasts); this thread reads Ctrl / Shift / Alt from Windows every 30 ms and
//! sends `keys` when they change. It stops on watch-keys off, or 3 s after the last renewal (a
//! plugin that went away mid-drag must not leave it running).

use crate::protocol::Event;
use crate::server;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

    /// until when to watch (None: not watching), and whether the thread is running
    static STATE: Mutex<(Option<Instant>, bool)> = Mutex::new((None, false));
    const RENEW: Duration = Duration::from_secs(3);

    fn down(vk: u16) -> bool {
        unsafe { GetAsyncKeyState(vk as i32) < 0 }
    }

    pub fn watch(on: bool) {
        let Ok(mut s) = STATE.lock() else { return };
        s.0 = on.then(|| Instant::now() + RENEW);
        if !on || s.1 {
            return;
        }
        s.1 = true;
        std::thread::spawn(|| {
            let mut last: Option<(bool, bool, bool)> = None;
            loop {
                let until = STATE.lock().map(|s| s.0).unwrap_or(None);
                if until.map_or(true, |t| Instant::now() > t) {
                    if let Ok(mut s) = STATE.lock() {
                        s.0 = None;
                        s.1 = false;
                    }
                    return;
                }
                let now = (down(VK_CONTROL), down(VK_SHIFT), down(VK_MENU));
                if last != Some(now) {
                    last = Some(now);
                    server::send(&Event::Keys { ctrl: now.0, shift: now.1, alt: now.2 });
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        });
    }
}

#[cfg(windows)]
pub use imp::watch;

#[cfg(not(windows))]
pub fn watch(_on: bool) {
    // no key state to read outside Windows: say "nothing held" once so the plugin's hints stay sane
    server::send(&Event::Keys { ctrl: false, shift: false, alt: false });
}
