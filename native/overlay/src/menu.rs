// 右键菜单: the WaveLayer context menu as a native Windows popup menu at the cursor, outside the
// UXP panel (which can't draw past its own edge, so its own menu is cut off and has nowhere to put
// a submenu). The plugin sends the whole menu as a tree (src/core/layers/contextMenu.ts) and gets
// back the id of the item picked, or none; it stays the only place that knows what an item does.
//
// A real Win32 menu (CreatePopupMenu / TrackPopupMenuEx) on its own thread: submenus open to the
// side on hover, shortcuts sit at the right, the screen edge flips it — all Windows' own.
//
// It never takes the keyboard from Photoshop: the owner window is no-activate and is NOT made the
// foreground window. Windows then doesn't close the menu on a click elsewhere by itself, so a
// low-level mouse hook does (any button pressed outside the menu's windows ends it, and the click
// still reaches what was clicked). Esc is the plugin's to send (`menu-close`): the keys are in
// Photoshop.

use serde::Deserialize;

/// One row of the menu, as the plugin sends it. A row with `children` opens a submenu.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MenuNode {
    /// what the plugin gets back when the row is picked ("" for headings and separators)
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// shown at the right: a shortcut ("Ctrl+E")
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub checked: bool,
    #[serde(default)]
    pub separator: bool,
    #[serde(default)]
    pub children: Vec<MenuNode>,
}

fn yes() -> bool {
    true
}

/// Limits on what a plugin message may ask for.
const MAX_ROWS: usize = 600;
const MAX_DEPTH: usize = 4;

/// What to build, flattened: each popup is a list of rows; a row may open another popup.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub enum Row {
    Separator,
    /// a greyed line that can't be picked (the title, a heading)
    Heading(String),
    /// `command`: 1-based index into `Plan::ids`
    Item { text: String, command: u32, enabled: bool, checked: bool },
    /// `popup`: index into `Plan::popups`
    Sub { text: String, popup: usize, enabled: bool },
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// popups[0] is the menu itself
    pub popups: Vec<Vec<Row>>,
    /// the plugin's id of each command (command n is ids[n - 1])
    pub ids: Vec<String>,
}

/// A menu's text: `&` shown as itself, the shortcut after a tab (Windows puts it at the right).
fn text_of(label: &str, hint: Option<&str>) -> String {
    let label = label.replace('&', "&&").replace(['\t', '\n', '\r'], " ");
    match hint.map(str::trim).filter(|h| !h.is_empty()) {
        Some(h) => format!("{label}\t{}", h.replace('&', "&&").replace(['\t', '\n', '\r'], " ")),
        None => label,
    }
}

/// Lays the tree out as popups and numbered commands. None when it is empty or too large.
pub fn plan(title: &str, items: &[MenuNode]) -> Option<Plan> {
    fn walk(plan: &mut Plan, nodes: &[MenuNode], depth: usize, rows: &mut usize) -> Option<usize> {
        if depth > MAX_DEPTH {
            return None;
        }
        let at = plan.popups.len();
        plan.popups.push(Vec::new());
        let mut out: Vec<Row> = Vec::new();
        for n in nodes {
            *rows += 1;
            if *rows > MAX_ROWS {
                return None;
            }
            if n.separator {
                // never two in a row, never first
                if !matches!(out.last(), None | Some(Row::Separator)) {
                    out.push(Row::Separator);
                }
            } else if !n.children.is_empty() {
                let popup = walk(plan, &n.children, depth + 1, rows)?;
                out.push(Row::Sub { text: text_of(&n.label, None), popup, enabled: n.enabled });
            } else if n.id.is_empty() {
                out.push(Row::Heading(text_of(&n.label, n.hint.as_deref())));
            } else {
                plan.ids.push(n.id.clone());
                out.push(Row::Item {
                    text: text_of(&n.label, n.hint.as_deref()),
                    command: plan.ids.len() as u32,
                    enabled: n.enabled,
                    checked: n.checked,
                });
            }
        }
        if matches!(out.last(), Some(Row::Separator)) {
            out.pop();
        }
        plan.popups[at] = out;
        Some(at)
    }
    let mut p = Plan::default();
    let mut rows = 0;
    walk(&mut p, items, 1, &mut rows)?;
    if p.ids.is_empty() {
        return None;
    }
    let title = title.trim();
    if !title.is_empty() {
        p.popups[0].insert(0, Row::Separator);
        p.popups[0].insert(0, Row::Heading(text_of(title, None)));
    }
    Some(p)
}

#[cfg(windows)]
pub use imp::{close, open};

/// Shows the menu at the cursor; the answer goes to the plugin as `menu-result`.
#[cfg(not(windows))]
pub fn open(menu_id: String, _title: String, _items: Vec<MenuNode>) {
    crate::server::send(&crate::protocol::Event::MenuResult { menu_id, item: None });
}

/// Takes the menu away (the plugin pressed Esc, lost its document …). `None`: whatever is open.
#[cfg(not(windows))]
pub fn close(_menu_id: Option<String>) {}

#[cfg(windows)]
mod imp {
    use std::ptr::null;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{Mutex, Once};
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CallNextHookEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
        DispatchMessageW, EndMenu, GetClassNameW, GetCursorPos, GetMessageW, PostMessageW,
        RegisterClassW, SetWindowsHookExW, TrackPopupMenuEx, UnhookWindowsHookEx, WindowFromPoint,
        HMENU, MSG, MSLLHOOKSTRUCT, WNDCLASSW,
    };

    use super::{plan, MenuNode, Plan, Row};
    use crate::log;
    use crate::protocol::Event;
    use crate::server;

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const MA_NOACTIVATE: LRESULT = 3;
    const WM_APP_OPEN: u32 = 0x8000 + 0x61;
    const WM_APP_CLOSE: u32 = 0x8000 + 0x62;
    const MF_STRING: u32 = 0x0000;
    const MF_GRAYED: u32 = 0x0001;
    const MF_DISABLED: u32 = 0x0002;
    const MF_CHECKED: u32 = 0x0008;
    const MF_POPUP: u32 = 0x0010;
    const MF_SEPARATOR: u32 = 0x0800;
    const TPM_RIGHTBUTTON: u32 = 0x0002;
    const TPM_NONOTIFY: u32 = 0x0080;
    const TPM_RETURNCMD: u32 = 0x0100;
    const WH_MOUSE_LL: i32 = 14;
    const WM_LBUTTONDOWN: usize = 0x0201;
    const WM_RBUTTONDOWN: usize = 0x0204;
    const WM_MBUTTONDOWN: usize = 0x0207;
    const WM_XBUTTONDOWN: usize = 0x020B;
    const WM_NCLBUTTONDOWN: usize = 0x00A1;
    const WM_NCRBUTTONDOWN: usize = 0x00A4;

    struct Request {
        menu_id: String,
        title: String,
        items: Vec<MenuNode>,
    }

    static HWND_SELF: AtomicIsize = AtomicIsize::new(0);
    /// the menu to show next; a newer one replaces an unshown older one (which is answered "none")
    static PENDING: Mutex<Option<Request>> = Mutex::new(None);
    /// the id of the menu on screen
    static SHOWN: Mutex<Option<String>> = Mutex::new(None);
    static TRACKING: AtomicBool = AtomicBool::new(false);
    static START: Once = Once::new();

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn answer(menu_id: String, item: Option<String>) {
        server::send(&Event::MenuResult { menu_id, item });
    }

    pub fn open(menu_id: String, title: String, items: Vec<MenuNode>) {
        let replaced = PENDING.lock().ok().and_then(|mut p| p.replace(Request { menu_id, title, items }));
        if let Some(old) = replaced {
            answer(old.menu_id, None);
        }
        START.call_once(|| {
            thread::spawn(run);
        });
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if !h.is_null() {
            unsafe { PostMessageW(h, WM_APP_OPEN, 0, 0) };
        }
        // before the window exists, `run` shows PENDING once it does
    }

    pub fn close(menu_id: Option<String>) {
        // one that isn't shown yet
        let dropped = PENDING.lock().ok().and_then(|mut p| {
            if p.as_ref().is_some_and(|r| menu_id.as_ref().is_none_or(|id| *id == r.menu_id)) {
                p.take()
            } else {
                None
            }
        });
        if let Some(r) = dropped {
            answer(r.menu_id, None);
        }
        let shown = SHOWN.lock().ok().and_then(|s| s.clone());
        let ours = shown.is_some_and(|s| menu_id.as_ref().is_none_or(|id| *id == s));
        let h = HWND_SELF.load(Ordering::SeqCst) as HWND;
        if ours && !h.is_null() {
            unsafe { PostMessageW(h, WM_APP_CLOSE, 0, 0) };
        }
    }

    /// Dark menus, as Photoshop's own (uxtheme's unnamed exports 135 SetPreferredAppMode and 136
    /// FlushMenuThemes, Windows 10 1903 and later). Without them the menu is simply light.
    unsafe fn dark_menus() {
        let lib = LoadLibraryW(wide("uxtheme.dll").as_ptr());
        if lib.is_null() {
            return;
        }
        // an ordinal is passed in place of the name's pointer
        let set = GetProcAddress(lib, 135usize as *const u8);
        let flush = GetProcAddress(lib, 136usize as *const u8);
        if let (Some(set), Some(flush)) = (set, flush) {
            let set: unsafe extern "system" fn(i32) -> i32 = std::mem::transmute(set);
            let flush: unsafe extern "system" fn() = std::mem::transmute(flush);
            set(2); // ForceDark
            flush();
            log::line("menu: dark menus on");
        }
    }

    /// The Win32 menus of `plan`; the first is the one to show. Destroying it destroys the rest.
    unsafe fn build(plan: &Plan) -> Option<HMENU> {
        let menus: Vec<HMENU> = plan.popups.iter().map(|_| CreatePopupMenu()).collect();
        if menus.iter().any(|m| m.is_null()) {
            for m in menus {
                if !m.is_null() {
                    DestroyMenu(m);
                }
            }
            return None;
        }
        for (rows, &menu) in plan.popups.iter().zip(&menus) {
            for row in rows {
                match row {
                    Row::Separator => {
                        AppendMenuW(menu, MF_SEPARATOR, 0, null());
                    }
                    Row::Heading(text) => {
                        AppendMenuW(menu, MF_STRING | MF_GRAYED | MF_DISABLED, 0, wide(text).as_ptr());
                    }
                    Row::Item { text, command, enabled, checked } => {
                        let mut flags = MF_STRING;
                        if !enabled {
                            flags |= MF_GRAYED;
                        }
                        if *checked {
                            flags |= MF_CHECKED;
                        }
                        AppendMenuW(menu, flags, *command as usize, wide(text).as_ptr());
                    }
                    Row::Sub { text, popup, enabled } => {
                        let flags = MF_POPUP | if *enabled { 0 } else { MF_GRAYED };
                        AppendMenuW(menu, flags, menus[*popup] as usize, wide(text).as_ptr());
                    }
                }
            }
        }
        Some(menus[0])
    }

    /// A button pressed anywhere but on a menu ends the menu (the click still goes where it went).
    unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0
            && matches!(w, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_NCLBUTTONDOWN | WM_NCRBUTTONDOWN)
            && TRACKING.load(Ordering::SeqCst)
        {
            let info = &*(l as *const MSLLHOOKSTRUCT);
            let under = WindowFromPoint(POINT { x: info.pt.x, y: info.pt.y });
            let mut name = [0u16; 16];
            let n = GetClassNameW(under, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
            // "#32768": the window class of every menu
            if String::from_utf16_lossy(&name[..n]) != "#32768" {
                EndMenu();
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, w, l)
    }

    unsafe fn show(h: HWND) {
        if TRACKING.load(Ordering::SeqCst) {
            // one is on screen: take it away; this message comes again once it has returned
            EndMenu();
            PostMessageW(h, WM_APP_OPEN, 0, 0);
            return;
        }
        let Some(req) = PENDING.lock().ok().and_then(|mut p| p.take()) else {
            return;
        };
        let Some(plan) = plan(&req.title, &req.items) else {
            log::line(format!("menu {}: nothing to show", req.menu_id));
            answer(req.menu_id, None);
            return;
        };
        let Some(menu) = build(&plan) else {
            log::line(format!("menu {}: not created", req.menu_id));
            answer(req.menu_id, None);
            return;
        };
        let mut at = POINT { x: 0, y: 0 };
        GetCursorPos(&mut at);
        if let Ok(mut s) = SHOWN.lock() {
            *s = Some(req.menu_id.clone());
        }
        TRACKING.store(true, Ordering::SeqCst);
        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), GetModuleHandleW(null()), 0);
        // returns when a row is picked (its command) or the menu is closed (0)
        let picked = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, at.x, at.y, h, null());
        if !hook.is_null() {
            UnhookWindowsHookEx(hook);
        }
        TRACKING.store(false, Ordering::SeqCst);
        if let Ok(mut s) = SHOWN.lock() {
            *s = None;
        }
        DestroyMenu(menu);
        let item = (picked > 0).then(|| plan.ids.get(picked as usize - 1).cloned()).flatten();
        log::line(format!(
            "menu {}: {} rows at {},{} -> {}",
            req.menu_id,
            plan.popups.iter().map(Vec::len).sum::<usize>(),
            at.x,
            at.y,
            item.as_deref().unwrap_or("(closed)")
        ));
        answer(req.menu_id, item);
    }

    unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_APP_OPEN => {
                show(h);
                0
            }
            WM_APP_CLOSE => {
                if TRACKING.load(Ordering::SeqCst) {
                    EndMenu();
                }
                0
            }
            WM_MOUSEACTIVATE => MA_NOACTIVATE,
            _ => DefWindowProcW(h, msg, w, l),
        }
    }

    fn run() {
        unsafe {
            dark_menus();
            let inst = GetModuleHandleW(null());
            let class = wide("WavePlugMenuOwner");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: inst,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            let title = wide("WavePlug 菜单");
            // never shown: a menu needs a window to belong to
            let h = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                inst,
                null(),
            );
            if h.is_null() {
                log::line("menu: owner window not created");
                if let Some(r) = PENDING.lock().ok().and_then(|mut p| p.take()) {
                    answer(r.menu_id, None);
                }
                return;
            }
            HWND_SELF.store(h as isize, Ordering::SeqCst);
            log::line("menu: owner window ready");
            PostMessageW(h, WM_APP_OPEN, 0, 0);
            let mut m: MSG = std::mem::zeroed();
            while GetMessageW(&mut m, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(json: &str) -> Vec<MenuNode> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn rows_commands_and_submenus() {
        let items = nodes(
            r#"[
            {"id":"rename","label":"重命名图层…","hint":"F2"},
            {"id":"delete","label":"删除图层","enabled":false},
            {"separator":true},
            {"label":"蒙版","children":[
                {"id":"mask:add","label":"添加图层蒙版"},
                {"separator":true},
                {"id":"mask:clip","label":"创建剪贴蒙版","hint":"Alt+Ctrl+G","checked":true}
            ]}
        ]"#,
        );
        let p = plan("图层 5 · PSB", &items).unwrap();
        assert_eq!(p.ids, vec!["rename", "delete", "mask:add", "mask:clip"]);
        assert_eq!(p.popups.len(), 2);
        assert_eq!(
            p.popups[0],
            vec![
                Row::Heading("图层 5 · PSB".into()),
                Row::Separator,
                Row::Item { text: "重命名图层…\tF2".into(), command: 1, enabled: true, checked: false },
                Row::Item { text: "删除图层".into(), command: 2, enabled: false, checked: false },
                Row::Separator,
                Row::Sub { text: "蒙版".into(), popup: 1, enabled: true },
            ]
        );
        assert_eq!(
            p.popups[1][2],
            Row::Item { text: "创建剪贴蒙版\tAlt+Ctrl+G".into(), command: 4, enabled: true, checked: true }
        );
    }

    #[test]
    fn tidy_separators_and_text() {
        let items = nodes(
            r#"[{"separator":true},{"id":"a","label":"A & B\tx"},{"separator":true},{"separator":true},
                {"label":"说明"},{"separator":true}]"#,
        );
        let p = plan("", &items).unwrap();
        assert_eq!(
            p.popups[0],
            vec![
                Row::Item { text: "A && B x".into(), command: 1, enabled: true, checked: false },
                Row::Separator,
                Row::Heading("说明".into()),
            ]
        );
    }

    #[test]
    fn refuses_empty_and_oversized_menus() {
        assert!(plan("标题", &[]).is_none());
        // headings only: nothing to pick
        assert!(plan("标题", &nodes(r#"[{"label":"只有说明"}]"#)).is_none());
        // nested too deep
        let deep = r#"[{"label":"1","children":[{"label":"2","children":[{"label":"3","children":[{"label":"4","children":[{"id":"x","label":"5"}]}]}]}]}]"#;
        assert!(plan("", &nodes(deep)).is_none());
        let many: Vec<MenuNode> = (0..700)
            .map(|i| MenuNode { id: format!("i{i}"), label: "x".into(), hint: None, enabled: true, checked: false, separator: false, children: vec![] })
            .collect();
        assert!(plan("", &many).is_none());
    }
}
