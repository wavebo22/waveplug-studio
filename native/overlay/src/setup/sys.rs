// What the installer asks of Windows: running programs (hidden, elevated, streamed), a file
// picker, opening a file with its program. Elsewhere (the Mac it's developed on) the same calls
// exist and say they can't.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Text a program printed: UTF-8, else the console's code page (GBK on Chinese Windows).
pub fn decode(bytes: &[u8]) -> String {
    // UPIA may print UTF-16
    if bytes.len() >= 4 && bytes.iter().skip(1).step_by(2).take(16).filter(|b| **b == 0).count() >= 6 {
        let w: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&w).trim_start_matches('\u{feff}').to_string();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => oem(bytes),
    }
}

#[cfg(windows)]
fn oem(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
    if bytes.is_empty() {
        return String::new();
    }
    unsafe {
        let n = MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if n <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut w = vec![0u16; n as usize];
        MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), bytes.len() as i32, w.as_mut_ptr(), n);
        String::from_utf16_lossy(&w)
    }
}
#[cfg(not(windows))]
fn oem(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Runs a program without a window: its exit code and everything it printed.
pub fn run(program: &str, args: &[&str]) -> Result<(i32, String), String> {
    let out = hidden(&mut Command::new(program)).args(args).stdin(Stdio::null()).output().map_err(|e| format!("{program} 没能运行：{e}"))?;
    let mut text = decode(&out.stdout);
    text.push_str(&decode(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
}

/// Runs a program without a window in `dir` with extra environment variables: its exit code and
/// everything it printed.
pub fn run_in(program: &str, args: &[&str], dir: &Path, env: &[(&str, &str)]) -> Result<(i32, String), String> {
    let mut cmd = Command::new(program);
    hidden(&mut cmd).args(args).current_dir(dir).stdin(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| format!("{program} 没能运行：{e}"))?;
    let mut text = decode(&out.stdout);
    text.push_str(&decode(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
}

/// Runs a program without a window in `dir`, handing each printed line to `line` as it comes.
pub fn run_stream(program: &str, args: &[&str], dir: &Path, line: &dyn Fn(String)) -> Result<i32, String> {
    let mut child = hidden(&mut Command::new(program))
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program} 没能运行：{e}"))?;
    let err = child.stderr.take().map(|e| {
        std::thread::spawn(move || BufReader::new(e).split(b'\n').flatten().map(|l| decode(&l).trim_end().to_string()).collect::<Vec<_>>())
    });
    if let Some(out) = child.stdout.take() {
        for l in BufReader::new(out).split(b'\n').flatten() {
            let s = decode(&l).trim_end().to_string();
            if !s.trim().is_empty() {
                line(s);
            }
        }
    }
    if let Some(h) = err {
        for s in h.join().unwrap_or_default() {
            if !s.trim().is_empty() {
                line(s);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(-1))
}

/// Whether a program with this file name is running.
pub fn is_running(exe_name: &str) -> bool {
    #[cfg(windows)]
    {
        let filter = format!("imagename eq {exe_name}");
        if let Ok((_, out)) = run("tasklist", &["/fi", &filter, "/nh", "/fo", "csv"]) {
            return out.to_lowercase().contains(&format!("\"{}\"", exe_name.to_lowercase()));
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = exe_name;
        false
    }
}

/// Stops every copy of a program (the overlay helper, which holds files in the plugin folder).
pub fn kill(exe_name: &str) {
    if cfg!(windows) {
        let _ = run("taskkill", &["/im", exe_name, "/f"]);
    }
}

/// Whether the WavePlug helper answers on its port.
pub fn helper_running() -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = "127.0.0.1:47821".parse().unwrap();
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(150)).is_ok()
}

/// Opens a file or folder with its program (a .ccx: Creative Cloud installs it).
pub fn open(path: &Path) -> Result<(), String> {
    let program = if cfg!(windows) { "explorer" } else { "open" };
    Command::new(program).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Starts a program on its own (the new installer after an update).
pub fn launch(exe: &Path, args: &[&str]) -> Result<(), String> {
    Command::new(exe).args(args).spawn().map(|_| ()).map_err(|e| format!("{} 没能启动：{e}", exe.display()))
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Runs `file params` as administrator (Windows asks the user) without a window and waits: the
/// exit code. Err when the user said no or it couldn't start.
#[cfg(windows)]
pub fn run_elevated(file: &str, params: &str, dir: &Path) -> Result<i32, String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    let (verb, f, p, d) = (wide("runas"), wide(file), wide(params), wide(&dir.to_string_lossy()));
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = f.as_ptr();
        info.lpParameters = p.as_ptr();
        info.lpDirectory = d.as_ptr();
        info.nShow = 0; // SW_HIDE
        if ShellExecuteExW(&mut info) == 0 {
            let e = std::io::Error::last_os_error();
            return Err(if e.raw_os_error() == Some(1223) { "没有得到管理员权限（在 Windows 的提示里点了「否」）".into() } else { format!("没能以管理员身份运行：{e}") });
        }
        if info.hProcess.is_null() {
            return Ok(0);
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0u32;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        Ok(code as i32)
    }
}
#[cfg(not(windows))]
pub fn run_elevated(_file: &str, _params: &str, _dir: &Path) -> Result<i32, String> {
    Err("只能在 Windows 上安装".into())
}

/// Windows' open-file dialog: `filter` is (description, pattern like "*.exe"). Blocks: call it off
/// the UI thread.
#[cfg(windows)]
pub fn pick_file(title: &str, filter: (&str, &str)) -> Option<PathBuf> {
    use windows_sys::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW};
    let t = wide(title);
    let f: Vec<u16> = format!("{}\0{}\0\0", filter.0, filter.1).encode_utf16().collect();
    let mut buf = vec![0u16; 1024];
    unsafe {
        let mut o: OPENFILENAMEW = std::mem::zeroed();
        o.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        o.lpstrFilter = f.as_ptr();
        o.lpstrFile = buf.as_mut_ptr();
        o.nMaxFile = buf.len() as u32;
        o.lpstrTitle = t.as_ptr();
        o.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if GetOpenFileNameW(&mut o) == 0 {
            return None;
        }
    }
    let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..n])))
}
#[cfg(not(windows))]
pub fn pick_file(_title: &str, _filter: (&str, &str)) -> Option<PathBuf> {
    None
}

/// Windows' choose-a-folder dialog (with 新建文件夹). Blocks: call it off the UI thread.
#[cfg(windows)]
pub fn pick_folder(title: &str) -> Option<PathBuf> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Shell::{SHBrowseForFolderW, SHGetPathFromIDListW, BROWSEINFOW};
    const BIF_RETURNONLYFSDIRS: u32 = 0x1;
    const BIF_NEWDIALOGSTYLE: u32 = 0x40;
    let t = wide(title);
    let mut name = vec![0u16; 260];
    unsafe {
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let mut b: BROWSEINFOW = std::mem::zeroed();
        b.pszDisplayName = name.as_mut_ptr();
        b.lpszTitle = t.as_ptr();
        b.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
        let pidl = SHBrowseForFolderW(&b);
        if pidl.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let ok = SHGetPathFromIDListW(pidl, buf.as_mut_ptr()) != 0;
        CoTaskMemFree(pidl as _);
        if !ok {
            return None;
        }
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..n])))
    }
}
#[cfg(not(windows))]
pub fn pick_folder(_title: &str) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_what_programs_print() {
        assert_eq!(decode("完成 ok".as_bytes()), "完成 ok");
        let utf16: Vec<u8> = "Installation Successful".encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(decode(&utf16), "Installation Successful");
        assert_eq!(decode(b""), "");
    }
}
