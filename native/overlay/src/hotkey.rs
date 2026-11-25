#![cfg_attr(not(windows), allow(dead_code))]
//! 快捷键: Ctrl+F in Photoshop is 原位粘贴 (as in Illustrator, where Ctrl+F pastes in front at the
//! same place), and Photoshop's own Ctrl+F (上次滤镜, which re-runs the last filter) never sees it.
//!
//! UXP can't take a key from Photoshop, so the helper does it: a low-level keyboard hook on its own
//! thread (a hook needs a message loop on the thread that set it). While the plugin has it on
//! (`hotkeys`, sent on every connect; off when the plugin goes away), a Ctrl+F press — no Shift,
//! Alt or Win — while a Photoshop window has the foreground is swallowed and the plugin gets
//! `paste-in-place` (once per press; held-key repeats and the key-up are swallowed too). Other
//! programs, the helper's own windows and every other key pass untouched. With the plugin gone the
//! key goes to Photoshop as before (nothing would do the paste).
//!
//! The hook must return fast (Windows drops a slow one): it only reads key states and the
//! foreground window's process, and queues the event (server::send doesn't block).

#[cfg(windows)]
use crate::protocol::Event;
#[cfg(windows)]
use crate::server;

/// What a key event is, for the hook (pure, tested).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// let it through
    Pass,
    /// swallow it and tell the plugin (the first key-down of a press)
    Fire,
    /// swallow it, nothing more (repeats while held, the key-up)
    Swallow,
}

pub const VK_F: u32 = 0x46;

/// `down`: key-down (else key-up); `ctrl` / `others`: Ctrl held, Shift / Alt / Win held;
/// `photoshop`: Photoshop has the foreground; `held`: this press already fired.
pub fn verdict(on: bool, vk: u32, down: bool, ctrl: bool, others: bool, photoshop: bool, held: bool) -> Verdict {
    if vk != VK_F {
        return Verdict::Pass;
    }
    if !down {
        return if held { Verdict::Swallow } else { Verdict::Pass };
    }
    if held {
        return Verdict::Swallow;
    }
    if on && ctrl && !others && photoshop { Verdict::Fire } else { Verdict::Pass }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ptr::null;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW,
        TranslateMessage, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static ON: AtomicBool = AtomicBool::new(false);
    static STARTED: AtomicBool = AtomicBool::new(false);
    /// the current Ctrl+F press was taken (its repeats and key-up are swallowed too)
    static HELD: AtomicBool = AtomicBool::new(false);

    fn down(vk: u16) -> bool {
        unsafe { GetAsyncKeyState(vk as i32) < 0 }
    }

    fn photoshop_in_front() -> bool {
        let ps = crate::win::photoshop_main_pid();
        if ps == 0 {
            return false;
        }
        let mut pid = 0u32;
        let front = unsafe { GetForegroundWindow() };
        if front.is_null() {
            return false;
        }
        unsafe { GetWindowThreadProcessId(front, &mut pid) };
        pid == ps
    }

    unsafe extern "system" fn hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let k = &*(l as *const KBDLLHOOKSTRUCT);
            if k.vkCode == VK_F {
                let msg = w as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                if is_down || msg == WM_KEYUP || msg == WM_SYSKEYUP {
                    let held = HELD.load(Ordering::SeqCst);
                    // the foreground is only looked up for a key-down that could fire
                    let on = ON.load(Ordering::SeqCst);
                    let ctrl = down(VK_CONTROL);
                    let others = down(VK_SHIFT) || down(VK_MENU) || down(VK_LWIN) || down(VK_RWIN);
                    let ps = is_down && !held && on && ctrl && !others && photoshop_in_front();
                    match verdict(on, k.vkCode, is_down, ctrl, others, ps, held) {
                        Verdict::Pass => {}
                        Verdict::Fire => {
                            HELD.store(true, Ordering::SeqCst);
                            server::send(&Event::PasteInPlace);
                            crate::log::line("hotkey: Ctrl+F → paste-in-place");
                            return 1;
                        }
                        Verdict::Swallow => {
                            if !is_down {
                                HELD.store(false, Ordering::SeqCst);
                            }
                            return 1;
                        }
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, w, l)
    }

    pub fn set(on: bool) {
        ON.store(on, Ordering::SeqCst);
        if !on {
            HELD.store(false, Ordering::SeqCst);
        }
        crate::log::line(format!("hotkey: {}", if on { "on" } else { "off" }));
        if !on || STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| unsafe {
            let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), GetModuleHandleW(null()), 0);
            if h.is_null() {
                crate::log::line("hotkey: keyboard hook failed");
                STARTED.store(false, Ordering::SeqCst);
                return;
            }
            crate::log::line("hotkey: keyboard hook installed");
            let mut m: MSG = std::mem::zeroed();
            while GetMessageW(&mut m, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        });
    }
}

#[cfg(windows)]
pub use imp::set;

#[cfg(not(windows))]
pub fn set(_on: bool) {
    // no keyboard hook outside Windows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_f_in_photoshop_fires_once_per_press() {
        assert_eq!(verdict(true, VK_F, true, true, false, true, false), Verdict::Fire);
        // held: repeats and the key-up are swallowed, the key-up ends the press
        assert_eq!(verdict(true, VK_F, true, true, false, true, true), Verdict::Swallow);
        assert_eq!(verdict(true, VK_F, false, true, false, true, true), Verdict::Swallow);
    }

    #[test]
    fn everything_else_passes() {
        // another key, another program, Shift / Alt / Win, no Ctrl, switched off
        assert_eq!(verdict(true, 0x47, true, true, false, true, false), Verdict::Pass);
        assert_eq!(verdict(true, VK_F, true, true, false, false, false), Verdict::Pass);
        assert_eq!(verdict(true, VK_F, true, true, true, true, false), Verdict::Pass);
        assert_eq!(verdict(true, VK_F, true, false, false, true, false), Verdict::Pass);
        assert_eq!(verdict(false, VK_F, true, true, false, true, false), Verdict::Pass);
        // a key-up of a press that wasn't taken
        assert_eq!(verdict(true, VK_F, false, true, false, true, false), Verdict::Pass);
    }
}
