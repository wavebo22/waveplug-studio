// The tray icon (右下角): WavePlug is running. Click / double-click opens the window (app.rs);
// right-click: 打开 WavePlug / 功能设置 / 退出. A hidden message-only window on its own thread
// receives the icon's messages, like frame.rs keeps its own window. Explorer restarting (the
// taskbar comes back) is answered by adding the icon again.

#[cfg(windows)]
pub use imp::start;

#[cfg(not(windows))]
pub fn start() {}

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
    use std::sync::Once;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreateIcon, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DispatchMessageW, GetCursorPos,
        GetMessageW, RegisterClassW, RegisterWindowMessageW, SetForegroundWindow, TrackPopupMenu, HICON, MF_SEPARATOR, MF_STRING,
        MSG, TPM_RETURNCMD, TPM_RIGHTBUTTON, WNDCLASSW,
    };

    use crate::app::{self, Tab};

    const WM_APP_TRAY: u32 = 0x8000 + 0x61;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_LBUTTONDBLCLK: u32 = 0x0203;
    const WM_RBUTTONUP: u32 = 0x0205;
    const WM_DESTROY: u32 = 0x0002;
    const CMD_OPEN: usize = 1;
    const CMD_SETTINGS: usize = 2;
    const CMD_QUIT: usize = 3;

    static START: Once = Once::new();
    static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
    static ICON: AtomicIsize = AtomicIsize::new(0);
    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);

    pub fn start() {
        START.call_once(|| {
            std::thread::spawn(run);
        });
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// The icon from app::icon_rgba (BGRA colour, a 1-bit mask of zeros: alpha does the shape).
    unsafe fn make_icon() -> HICON {
        let n = 32u32;
        let rgba = app::icon_rgba(n);
        let mut bgra = rgba.clone();
        for p in bgra.chunks_mut(4) {
            p.swap(0, 2);
        }
        let mask = vec![0u8; (n * n / 8) as usize];
        CreateIcon(GetModuleHandleW(null()), n as i32, n as i32, 1, 32, mask.as_ptr(), bgra.as_ptr())
    }

    unsafe fn data(h: HWND) -> NOTIFYICONDATAW {
        let mut d: NOTIFYICONDATAW = std::mem::zeroed();
        d.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        d.hWnd = h;
        d.uID = 1;
        d
    }

    unsafe fn add(h: HWND, icon: HICON) {
        let mut d = data(h);
        d.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        d.uCallbackMessage = WM_APP_TRAY;
        d.hIcon = icon;
        let tip = wide(&format!("WavePlug {}", env!("CARGO_PKG_VERSION")));
        for (i, u) in tip.iter().take(d.szTip.len() - 1).enumerate() {
            d.szTip[i] = *u;
        }
        Shell_NotifyIconW(NIM_ADD, &d);
    }

    unsafe fn menu(h: HWND) {
        let m = CreatePopupMenu();
        AppendMenuW(m, MF_STRING, CMD_OPEN, wide("打开 WavePlug").as_ptr());
        AppendMenuW(m, MF_STRING, CMD_SETTINGS, wide("功能设置").as_ptr());
        AppendMenuW(m, MF_SEPARATOR, 0, null());
        AppendMenuW(m, MF_STRING, CMD_QUIT, wide("退出").as_ptr());
        let mut p = POINT { x: 0, y: 0 };
        GetCursorPos(&mut p);
        // without this the menu doesn't go away when clicking elsewhere
        SetForegroundWindow(h);
        let picked = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, p.x, p.y, 0, h, null()) as usize;
        DestroyMenu(m);
        match picked {
            CMD_OPEN => app::open(Some(Tab::Overview)),
            CMD_SETTINGS => app::open(Some(Tab::Settings)),
            CMD_QUIT => app::quit(),
            _ => {}
        }
    }

    unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if msg == WM_APP_TRAY {
            match l as u32 & 0xFFFF {
                WM_LBUTTONUP | WM_LBUTTONDBLCLK => app::open(None),
                WM_RBUTTONUP => menu(h),
                _ => {}
            }
            return 0;
        }
        let tc = TASKBAR_CREATED.load(Ordering::SeqCst);
        if tc != 0 && msg == tc {
            add(h, ICON.load(Ordering::SeqCst) as HICON);
            return 0;
        }
        if msg == WM_DESTROY {
            Shell_NotifyIconW(NIM_DELETE, &data(h));
        }
        DefWindowProcW(h, msg, w, l)
    }

    fn run() {
        unsafe {
            let class = wide("WavePlugTray");
            let inst = GetModuleHandleW(null());
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
            RegisterClassW(&wc);
            TASKBAR_CREATED.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Ordering::SeqCst);
            // a message-only window doesn't get TaskbarCreated (a broadcast): a hidden top-level one does
            let h = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, null_mut(), null_mut(), inst, null());
            if h.is_null() {
                crate::log::line("tray: no window");
                return;
            }
            let icon = make_icon();
            ICON.store(icon as isize, Ordering::SeqCst);
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            add(h, icon);
            crate::log::line("tray icon added");
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        }
    }

    /// Takes the icon away (quitting): Windows would leave a dead icon until the mouse passes it.
    pub fn remove() {
        let h = HWND_SELF.swap(0, Ordering::SeqCst) as HWND;
        if !h.is_null() {
            unsafe { Shell_NotifyIconW(NIM_DELETE, &data(h)) };
        }
    }
}

/// Called when quitting.
#[cfg(windows)]
pub fn remove() {
    imp::remove();
}
#[cfg(not(windows))]
pub fn remove() {}
