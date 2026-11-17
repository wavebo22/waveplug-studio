// Owns only the ComfyUI process tree started by this WavePlug helper.
// A Windows Job Object gives the helper deterministic cleanup when Photoshop exits or the
// helper is terminated. Existing ComfyUI instances are detected and never taken over.
//
// When the helper restarts itself (its exe was updated, or the plugin asked), the ComfyUI it
// started is handed to the new copy instead of being killed: the job is named, its details go to
// %LOCALAPPDATA%\WavePlug\comfy_managed.json, and the new copy opens the job by name while the
// old one still holds it (a job's name goes away with its last handle). See life.rs.
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::protocol::Event;
use crate::server;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::ptr::null;
    use std::time::Instant;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, GetConsoleWindow};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        OpenJobObjectW, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, CREATE_NEW_CONSOLE, CREATE_NO_WINDOW,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow;

    const SYNCHRONIZE: u32 = 0x0010_0000;
    const JOB_OBJECT_ALL_ACCESS: u32 = 0x001F_001F;
    #[cfg(test)]
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;

    struct Managed {
        base: String,
        path: String,
        pid: u32,
        process: isize,
        job: isize,
        /// the job's kernel name, so a restarted helper can take it over
        job_name: String,
        close_with_photoshop: bool,
        hidden_terminal: bool,
    }

    static MANAGED: Mutex<Option<Managed>> = Mutex::new(None);
    /// Serialize only the probe/spawn phase; the 3-minute readiness wait runs outside this lock.
    static RECONCILE: Mutex<()> = Mutex::new(());

    fn status(state: &str, message: impl Into<String>, owned: bool) {
        server::send(&Event::ComfyStatus {
            state: state.to_string(),
            message: message.into(),
            owned,
        });
    }

    fn process_alive(handle: isize) -> bool {
        if handle == 0 {
            return false;
        }
        unsafe { WaitForSingleObject(handle as _, 0) == WAIT_TIMEOUT }
    }

    fn close_managed(item: Managed, reason: &str) {
        forget();
        // KILL_ON_JOB_CLOSE is set only when the user opted into Photoshop-linked lifetime.
        // With it cleared, closing our handle deliberately leaves ComfyUI running.
        unsafe {
            if item.job != 0 {
                CloseHandle(item.job as _);
            }
            if item.process != 0 {
                CloseHandle(item.process as _);
            }
        }
        crate::log::line(format!(
            "ComfyUI manager released pid={} close_with_photoshop={} reason={reason}",
            item.pid, item.close_with_photoshop
        ));
    }

    fn state_path() -> Option<std::path::PathBuf> {
        let dir = crate::paths::data_root();
        let _ = std::fs::create_dir_all(&dir);
        Some(dir.join("comfy_managed.json"))
    }

    /// Writes down the managed instance for a restarted helper to take over.
    fn remember(item: &Managed) {
        let Some(p) = state_path() else { return };
        let v = serde_json::json!({
            "pid": item.pid, "jobName": item.job_name, "base": item.base, "path": item.path,
            "closeWithPhotoshop": item.close_with_photoshop, "hiddenTerminal": item.hidden_terminal,
        });
        let tmp = p.with_extension("json.new");
        if std::fs::write(&tmp, v.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }

    fn forget() {
        if let Some(p) = state_path() {
            let _ = std::fs::remove_file(p);
        }
    }

    /// The managed instance is this one from now on (and is written down).
    fn put(item: Managed) {
        remember(&item);
        if let Ok(mut slot) = MANAGED.lock() {
            *slot = Some(item);
        }
    }

    /// The helper is about to restart: keep ComfyUI alive through the switch (kill-on-close off,
    /// the new copy turns it back on) and leave its details for the new copy. Handles stay open
    /// until this process exits, so the job's name is still there when the new copy opens it.
    pub fn handover() {
        let item = MANAGED.lock().ok().and_then(|mut slot| slot.take());
        let Some(item) = item else {
            forget();
            return;
        };
        if !process_alive(item.process) {
            close_managed(item, "process exited before helper restart");
            return;
        }
        let _ = set_job_lifetime(item.job, false);
        remember(&item);
        crate::log::line(format!(
            "ComfyUI pid={} handed over to the restarted helper (job {})",
            item.pid, item.job_name
        ));
        // deliberately leaked: closed when this process exits, after the new copy took the job
        std::mem::forget(item);
    }

    /// At startup: take over the ComfyUI a previous copy of the helper started, if it still runs.
    pub fn adopt() {
        let Some(p) = state_path() else { return };
        let Ok(text) = std::fs::read_to_string(&p) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            forget();
            return;
        };
        let pid = v["pid"].as_u64().unwrap_or(0) as u32;
        let job_name = v["jobName"].as_str().unwrap_or("").to_string();
        let close_with_photoshop = v["closeWithPhotoshop"].as_bool().unwrap_or(true);
        let wide: Vec<u16> = job_name.encode_utf16().chain(Some(0)).collect();
        let job = if job_name.is_empty() {
            std::ptr::null_mut()
        } else {
            unsafe { OpenJobObjectW(JOB_OBJECT_ALL_ACCESS, 0, wide.as_ptr()) }
        };
        let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
        let process = if pid == 0 { std::ptr::null_mut() } else { unsafe { OpenProcess(access, 0, pid) } };
        if job.is_null() || process.is_null() || !process_alive(process as isize) {
            unsafe {
                if !job.is_null() {
                    CloseHandle(job);
                }
                if !process.is_null() {
                    CloseHandle(process);
                }
            }
            crate::log::line(format!("ComfyUI handover not taken: pid={pid} job={job_name}"));
            forget();
            return;
        }
        let _ = set_job_lifetime(job as isize, close_with_photoshop);
        crate::log::line(format!(
            "ComfyUI pid={pid} taken over from the previous helper close_with_photoshop={close_with_photoshop}"
        ));
        put(Managed {
            base: v["base"].as_str().unwrap_or("").to_string(),
            path: v["path"].as_str().unwrap_or("").to_string(),
            pid,
            process: process as isize,
            job: job as isize,
            job_name,
            close_with_photoshop,
            hidden_terminal: v["hiddenTerminal"].as_bool().unwrap_or(close_with_photoshop),
        });
    }

    fn set_job_lifetime(job: isize, close_with_photoshop: bool) -> Result<(), String> {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = if close_with_photoshop {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        } else {
            0
        };
        let ok = unsafe {
            SetInformationJobObject(
                job as _,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            Err(format!(
                "无法更新 ComfyUI 进程生命周期（Windows 错误 {}）",
                unsafe { windows_sys::Win32::Foundation::GetLastError() }
            ))
        } else {
            Ok(())
        }
    }

    fn local_target(base: &str) -> Option<(String, u16)> {
        let rest = base.trim().strip_prefix("http://")?;
        let authority = rest.split('/').next()?.trim();
        let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
            (host.trim_matches(['[', ']']), port.parse::<u16>().ok()?)
        } else {
            (authority.trim_matches(['[', ']']), 80)
        };
        if host != "127.0.0.1" && host != "localhost" && host != "::1" {
            return None;
        }
        let host = if host == "localhost" {
            "127.0.0.1"
        } else {
            host
        };
        Some((host.to_string(), port))
    }

    fn port_open(base: &str) -> bool {
        let Some((host, port)) = local_target(base) else {
            return false;
        };
        let address = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        let Ok(mut addrs) = address.to_socket_addrs() else {
            return false;
        };
        let Some(addr) = addrs.next() else {
            return false;
        };
        TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
    }

    fn probe(base: &str) -> bool {
        let Some((host, port)) = local_target(base) else {
            return false;
        };
        let address = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        let Ok(mut addrs) = address.to_socket_addrs() else {
            return false;
        };
        let Some(addr) = addrs.next() else {
            return false;
        };
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(350)));
        let request = format!(
            "GET /system_stats HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let mut response = [0u8; 96];
        let Ok(n) = stream.read(&mut response) else {
            return false;
        };
        let line = String::from_utf8_lossy(&response[..n]);
        line.starts_with("HTTP/1.1 200") || line.starts_with("HTTP/1.0 200")
    }

    fn http_json(base: &str, path: &str) -> Option<serde_json::Value> {
        let (host, port) = local_target(base)?;
        let address = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        let mut addrs = address.to_socket_addrs().ok()?;
        let addr = addrs.next()?;
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .ok()?;
        let request =
            format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).ok()?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).ok()?;
        let split = bytes.windows(4).position(|w| w == b"\r\n\r\n")?;
        let header = String::from_utf8_lossy(&bytes[..split]);
        if !header.lines().next()?.contains(" 200 ") {
            return None;
        }
        serde_json::from_slice(&bytes[split + 4..]).ok()
    }

    /// ComfyUI's /system_stats (local addresses only), for the 性能监视 box (monitor.rs).
    pub fn system_stats(base: &str) -> Option<serde_json::Value> {
        http_json(base, "/system_stats")
    }

    fn queue_idle(base: &str) -> bool {
        let Some(queue) = http_json(base, "/queue") else {
            return false;
        };
        let Some(running) = queue.get("queue_running").and_then(|v| v.as_array()) else {
            return false;
        };
        let Some(pending) = queue.get("queue_pending").and_then(|v| v.as_array()) else {
            return false;
        };
        running.is_empty() && pending.is_empty()
    }

    /// A visible ComfyUI console can be hidden in place without restarting its Python process.
    fn hide_console(pid: u32) -> bool {
        if unsafe { AttachConsole(pid) } == 0 {
            return false;
        }
        let hwnd = unsafe { GetConsoleWindow() };
        let hidden = !hwnd.is_null();
        if hidden {
            unsafe {
                ShowWindow(hwnd, 0);
            }
        }
        unsafe {
            FreeConsole();
        }
        hidden
    }

    fn hidden_log() -> Option<std::fs::File> {
        let exe = std::env::current_exe().ok()?;
        let root = exe.parent()?.parent()?;
        let reports = root.join("reports");
        let _ = std::fs::create_dir_all(&reports);
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(reports.join("comfy_runtime.log"))
            .ok()
    }

    fn command_for(path: &str, disable_browser: bool) -> Result<Command, String> {
        // cmd.exe expands %...% even inside quoted filenames. Reject ambiguous paths rather
        // than interpreting arbitrary shell syntax from a user-supplied launcher path.
        if path
            .chars()
            .any(|c| matches!(c, '"' | '%' | '\r' | '\n' | '\0'))
        {
            return Err(
                "ComfyUI 启动路径包含 Windows 命令行不支持的特殊字符，请选择实际启动文件".into(),
            );
        }
        let ext = Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "bat" || ext == "cmd" {
            let mut cmd = Command::new("cmd.exe");
            // cmd.exe has its own /S /C quote rules; bypass Rust's CRT quoting so the
            // final command line is exactly: cmd /d /s /c ""C:\\path with spaces\\run.bat"".
            let launch_args = if disable_browser {
                " --disable-auto-launch"
            } else {
                ""
            };
            // Keep the batch file and its extra ComfyUI flag inside cmd /S /C's outer quotes.
            cmd.args(["/d", "/s", "/c"])
                .raw_arg(format!(" \"\"{}\"{}\"", path, launch_args));
            Ok(cmd)
        } else if ext == "exe" {
            let mut cmd = Command::new(path);
            if disable_browser {
                cmd.arg("--disable-auto-launch");
            }
            Ok(cmd)
        } else {
            Err("启动文件必须是 .bat、.cmd 或 .exe".into())
        }
    }

    fn spawn_managed(
        path: &str,
        close_with_photoshop: bool,
        disable_browser: bool,
    ) -> Result<Managed, String> {
        if !Path::new(path).is_file() {
            return Err(format!("找不到 ComfyUI 启动文件：{path}"));
        }
        let mut cmd = command_for(path, disable_browser)?;

        // pid + time alone repeat when two spawns land in the same millisecond (the parallel unit
        // tests did): CreateJobObjectW then OPENS the other job, whose lifetime flag the second
        // caller rewrites. The sequence number makes each name unique; an existing name is refused.
        static JOB_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let job_name = format!(
            "Local\\WavePlugComfyUI-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            JOB_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let job_wide: Vec<u16> = job_name.encode_utf16().chain(Some(0)).collect();
        let job = unsafe { CreateJobObjectW(null(), job_wide.as_ptr()) };
        if job.is_null() {
            return Err(format!(
                "无法创建 ComfyUI 进程组（Windows 错误 {}）",
                unsafe { windows_sys::Win32::Foundation::GetLastError() }
            ));
        }
        if unsafe { windows_sys::Win32::Foundation::GetLastError() }
            == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS
        {
            unsafe {
                CloseHandle(job);
            }
            return Err(format!("ComfyUI 进程组名称冲突：{job_name}"));
        }
        let job_id = job as isize;
        if let Err(e) = set_job_lifetime(job_id, close_with_photoshop) {
            unsafe {
                CloseHandle(job);
            }
            return Err(e);
        }

        let hidden = close_with_photoshop;
        cmd.creation_flags(if hidden {
            CREATE_NO_WINDOW
        } else {
            CREATE_NEW_CONSOLE
        });
        if hidden {
            cmd.stdin(Stdio::null());
            if let Some(log) = hidden_log() {
                if let Ok(err) = log.try_clone() {
                    cmd.stdout(Stdio::from(log)).stderr(Stdio::from(err));
                } else {
                    cmd.stdout(Stdio::null()).stderr(Stdio::null());
                }
            } else {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }

        let mut child: Child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                unsafe {
                    CloseHandle(job);
                }
                return Err(format!("启动 ComfyUI 失败：{e}"));
            }
        };
        let pid = child.id();
        let access =
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
        let process = unsafe { OpenProcess(access, 0, pid) };
        if process.is_null() {
            let _ = child.kill();
            unsafe {
                CloseHandle(job);
            }
            return Err(format!(
                "无法取得 ComfyUI 进程句柄（Windows 错误 {}）",
                unsafe { windows_sys::Win32::Foundation::GetLastError() }
            ));
        }
        if unsafe { AssignProcessToJobObject(job, process) } == 0 {
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            let _ = child.kill();
            unsafe {
                CloseHandle(process);
                CloseHandle(job);
            }
            return Err(format!("无法接管 ComfyUI 子进程组（Windows 错误 {error}）"));
        }
        drop(child);
        crate::log::line(format!(
            "ComfyUI started pid={pid} hidden_terminal={hidden} close_with_photoshop={close_with_photoshop} disable_browser={disable_browser} path={path}"
        ));
        Ok(Managed {
            base: String::new(),
            path: path.to_string(),
            pid,
            process: process as isize,
            job: job_id,
            job_name,
            close_with_photoshop,
            hidden_terminal: hidden,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn manage_inner(
        path: String,
        base: String,
        close_with_photoshop: bool,
        restart_if_needed: bool,
        disable_browser: bool,
        start_if_missing: bool,
        restart: bool,
    ) {
        // no launcher chosen: the ComfyUI pack unzipped into the install folder's comfyui\
        let path = crate::paths::comfy_launcher(&path);
        let reconcile = RECONCILE.lock().ok();
        // Reconcile an instance previously started by this helper before probing for external
        // instances. This is what makes reconnects and repeated ⟳ idempotent.
        let previous = MANAGED.lock().ok().and_then(|mut slot| slot.take());
        // 重启 (the settings button): stop the instance this helper started, then start as usual
        let start_if_missing = start_if_missing || restart;
        let previous = match previous {
            Some(item) if restart && process_alive(item.process) => {
                if probe(&item.base) && !queue_idle(&item.base) {
                    status("restart-required", "ComfyUI 正在生成任务，为免中断暂不重启；任务结束后再点「重启」。", true);
                    put(item);
                    return;
                }
                status("starting", "正在重启 ComfyUI……", true);
                let old = item.base.clone();
                unsafe {
                    TerminateJobObject(item.job as _, 0);
                }
                close_managed(item, "restart requested");
                let deadline = Instant::now() + Duration::from_secs(12);
                while probe(&old) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(250));
                }
                None
            }
            None if restart && probe(&base) => {
                status(
                    "external-running",
                    "这个 ComfyUI 不是 WavePlug 启动的，无法从这里重启；请在它自己的终端里关闭后点「启动」。",
                    false,
                );
                return;
            }
            other => other,
        };
        if let Some(mut item) = previous {
            if process_alive(item.process) && item.base == base {
                let needs_console_change = item.hidden_terminal != close_with_photoshop;
                if needs_console_change && !close_with_photoshop && restart_if_needed {
                    // Hidden -> visible requires a new console. Never interrupt a queued/running
                    // image job just to change a terminal preference.
                    if queue_idle(&base) {
                        let old_pid = item.pid;
                        let old_path = item.path.clone();
                        status("starting", "ComfyUI 当前空闲，正在重启以显示终端……", true);
                        unsafe {
                            TerminateJobObject(item.job as _, 0);
                        }
                        close_managed(item, "restart for visible terminal");
                        let deadline = Instant::now() + Duration::from_secs(12);
                        while probe(&base) && Instant::now() < deadline {
                            thread::sleep(Duration::from_millis(250));
                        }
                        if probe(&base) {
                            status(
                                "failed",
                                format!("旧 ComfyUI（PID {old_pid}）未能退出；请手动关闭后重试。"),
                                true,
                            );
                            return;
                        }
                        let mut next = match spawn_managed(&old_path, false, disable_browser) {
                            Ok(next) => next,
                            Err(e) => {
                                status("failed", e, false);
                                return;
                            }
                        };
                        next.base = base.clone();
                        let process = next.process;
                        let pid = next.pid;
                        put(next);
                        drop(reconcile);
                        let deadline = Instant::now() + Duration::from_secs(180);
                        while Instant::now() < deadline {
                            if probe(&base) {
                                status(
                                    "ready",
                                    "ComfyUI 已重启，终端现在可见；Photoshop 退出时会保留。",
                                    true,
                                );
                                return;
                            }
                            if !process_alive(process) {
                                status(
                                    "failed",
                                    format!("ComfyUI 新进程（PID {pid}）已退出。"),
                                    true,
                                );
                                return;
                            }
                            thread::sleep(Duration::from_secs(2));
                        }
                        status(
                            "timeout",
                            "ComfyUI 重启后等待就绪超时；终端保持可见。",
                            true,
                        );
                        return;
                    }
                    if let Err(e) = set_job_lifetime(item.job, false) {
                        status("failed", e, true);
                        put(item);
                        return;
                    }
                    item.close_with_photoshop = false;
                    status(
                        "restart-required",
                        "ComfyUI 正在生成任务，暂不重启以免中断。已切换为不随 Photoshop 关闭；任务结束后再次点击「启动」即可让终端显示。",
                        true,
                    );
                    put(item);
                    return;
                }

                let changed = item.close_with_photoshop != close_with_photoshop;
                if changed {
                    if let Err(e) = set_job_lifetime(item.job, close_with_photoshop) {
                        status("failed", e, true);
                        put(item);
                        return;
                    }
                    item.close_with_photoshop = close_with_photoshop;
                    crate::log::line(format!(
                        "ComfyUI lifetime policy changed pid={} close_with_photoshop={close_with_photoshop}",
                        item.pid
                    ));
                }

                if needs_console_change && close_with_photoshop {
                    if hide_console(item.pid) {
                        item.hidden_terminal = true;
                        status(
                            "managed-running",
                            "ComfyUI 终端已隐藏；Photoshop 退出时会一同关闭。",
                            true,
                        );
                    } else {
                        status(
                            "restart-required",
                            "ComfyUI 关闭策略已更新，但当前终端无法原地隐藏；下次启动 ComfyUI 时生效。",
                            true,
                        );
                    }
                } else {
                    let message = if close_with_photoshop {
                        format!("ComfyUI 正在运行（由 WavePlug 启动：{}），Photoshop 退出时会一同关闭。", item.path)
                    } else {
                        format!("ComfyUI 正在运行（由 WavePlug 启动：{}），Photoshop 退出时会保留，终端保持可见。", item.path)
                    };
                    status("managed-running", message, true);
                }
                put(item);
                return;
            }
            if process_alive(item.process) {
                // Do not terminate an old session just because the user changed the endpoint.
                status(
                    "managed-running",
                    format!(
                        "WavePlug 已管理另一个 ComfyUI 地址（{}）；不会重复启动第二个实例。",
                        item.base
                    ),
                    true,
                );
                put(item);
                return;
            }
            close_managed(item, "process exited");
        }

        if local_target(&base).is_none() {
            status(
                "remote",
                "当前 ComfyUI 地址不是本机地址，框架不会尝试启动远程服务。",
                false,
            );
            return;
        }
        if probe(&base) {
            status(
                "already-running",
                "检测到已有 ComfyUI 正在运行，直接连接；不会接管或关闭这个进程。",
                false,
            );
            return;
        }
        if path.trim().is_empty() {
            let hint = crate::paths::comfy_dir().map(|d| format!("，或把 WavePlug 的 ComfyUI 压缩包解压到 {}", d.display())).unwrap_or_default();
            status("not-configured", format!("ComfyUI 尚未设置启动文件。外置框架已启动，选择 ComfyUI 的 .bat / .cmd / .exe{hint} 后即可自动启动。"), false);
            return;
        }
        if !Path::new(&path).is_file() {
            status(
                "path-missing",
                format!("ComfyUI 启动文件不存在：{path}。请重新选择启动文件。"),
                false,
            );
            return;
        }
        if port_open(&base) {
            // Existing ComfyUI may have bound its port before /system_stats is ready.
            // Never start a second copy into an occupied port.
            status(
                "starting",
                "本机 ComfyUI 端口已有程序监听，正在等待其就绪；不会重复启动。",
                false,
            );
            drop(reconcile);
            let deadline = Instant::now() + Duration::from_secs(45);
            while Instant::now() < deadline {
                if probe(&base) {
                    status(
                        "already-running",
                        "检测到已有 ComfyUI 已就绪，直接连接；不会接管其进程。",
                        false,
                    );
                    return;
                }
                thread::sleep(Duration::from_secs(2));
            }
            status(
                "failed",
                "ComfyUI 端口已被占用，但服务仍未就绪。请检查已有 ComfyUI 终端或修改连接端口。",
                false,
            );
            return;
        }

        if !start_if_missing {
            status(
                "autostart-disabled",
                "已关闭 ComfyUI 随 Photoshop 自动启动。WavePlug 外置框架仍在运行；需要时点击「启动」即可手动开启 ComfyUI。",
                false,
            );
            return;
        }

        status(
            "starting",
            "正在启动 ComfyUI，首次载入模型可能需要一些时间……",
            true,
        );
        let mut item = match spawn_managed(&path, close_with_photoshop, disable_browser) {
            Ok(item) => item,
            Err(e) => {
                status("failed", e, false);
                return;
            }
        };
        item.base = base.clone();
        let process = item.process;
        let pid = item.pid;
        put(item);
        drop(reconcile);

        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if probe(&base) {
                status("ready", "ComfyUI 已启动并就绪。", true);
                return;
            }
            if !process_alive(process) {
                status("failed", format!("ComfyUI 启动进程（PID {pid}）已退出。请检查 reports/comfy_runtime.log 或启动脚本。"), true);
                return;
            }
            thread::sleep(Duration::from_secs(2));
        }
        status(
            "timeout",
            "等待 ComfyUI 就绪超过 3 分钟；进程仍在运行，可查看 reports/comfy_runtime.log。",
            true,
        );
    }

    pub fn manage(
        path: String,
        base: String,
        close_with_photoshop: bool,
        restart_if_needed: bool,
        disable_browser: bool,
        start_if_missing: bool,
        restart: bool,
    ) {
        thread::spawn(move || {
            manage_inner(
                path,
                base,
                close_with_photoshop,
                restart_if_needed,
                disable_browser,
                start_if_missing,
                restart,
            )
        });
    }

    pub fn photoshop_closed() {
        let item = MANAGED.lock().ok().and_then(|mut slot| slot.take());
        if let Some(item) = item {
            let pid = item.pid;
            let close = item.close_with_photoshop;
            close_managed(item, "Photoshop process exited");
            if close {
                crate::log::line(format!(
                    "Photoshop closed; ComfyUI process tree for pid={pid} will be terminated"
                ));
            } else {
                crate::log::line(format!(
                    "Photoshop closed; ComfyUI pid={pid} deliberately left running"
                ));
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_loopback_http_endpoints_are_launchable() {
            assert_eq!(
                local_target("http://127.0.0.1:8188"),
                Some(("127.0.0.1".into(), 8188))
            );
            assert_eq!(
                local_target("http://localhost:9000/path"),
                Some(("127.0.0.1".into(), 9000))
            );
            assert_eq!(local_target("https://127.0.0.1:8188"), None);
            assert_eq!(local_target("http://192.168.1.8:8188"), None);
        }

        #[test]
        fn occupied_loopback_port_is_detected_without_starting_another_server() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            assert!(port_open(&format!("http://127.0.0.1:{port}")));
            assert!(!port_open("http://192.168.0.1:8188"));
        }

        #[test]
        fn executable_path_rejects_shell_expansion_and_unsupported_extensions() {
            assert!(command_for("C:\\Safe path\\ComfyUI.bat", true).is_ok());
            assert!(command_for("C:\\Safe path\\ComfyUI.exe", true).is_ok());
            assert!(command_for("C:\\Untrusted%USERNAME%\\ComfyUI.bat", true).is_err());
            assert!(command_for("C:\\Safe path\\ComfyUI.ps1", true).is_err());
        }

        #[test]
        fn batch_launcher_forwards_browser_preference_with_spaced_path() {
            let dir = std::env::temp_dir().join("WavePlug Comfy Job Test");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("waveplug-flags-{}.bat", std::process::id()));
            std::fs::write(&path, "@echo off\r\necho [%*]\r\n").unwrap();

            let output = command_for(path.to_str().unwrap(), true)
                .unwrap()
                .output()
                .expect("batch with spaces can run");
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                "[--disable-auto-launch]"
            );

            let output = command_for(path.to_str().unwrap(), false)
                .unwrap()
                .output()
                .expect("batch without flag can run");
            assert!(output.status.success());
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "[]");
            let _ = std::fs::remove_file(path);
        }

        fn test_batch(seconds: u32) -> String {
            let dir = std::env::temp_dir().join("WavePlug Comfy Job Test");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!(
                "waveplug-comfy-job-{}-{seconds}.bat",
                std::process::id()
            ));
            std::fs::write(
                &path,
                format!("@echo off\r\nping -n {} 127.0.0.1 >nul\r\n", seconds + 1),
            )
            .unwrap();
            path.to_string_lossy().into_owned()
        }

        #[test]
        fn closing_managed_job_terminates_the_batch_and_its_children() {
            let path = test_batch(30);
            let item = spawn_managed(&path, true, true).expect("hidden managed process starts");
            let monitor = unsafe { OpenProcess(SYNCHRONIZE, 0, item.pid) };
            assert!(!monitor.is_null(), "can observe spawned process");
            close_managed(item, "job object unit test");
            let result = unsafe { WaitForSingleObject(monitor, 4000) };
            unsafe {
                CloseHandle(monitor);
            }
            let _ = std::fs::remove_file(path);
            assert_eq!(
                result, WAIT_OBJECT_0,
                "KILL_ON_JOB_CLOSE terminates the process tree"
            );
        }

        #[test]
        fn clearing_kill_on_close_leaves_comfyui_running() {
            let path = test_batch(4);
            let item = spawn_managed(&path, true, true).expect("hidden managed process starts");
            let monitor = unsafe { OpenProcess(SYNCHRONIZE, 0, item.pid) };
            assert!(!monitor.is_null(), "can observe spawned process");
            set_job_lifetime(item.job, false).expect("disable kill-on-close");
            close_managed(item, "keep-running unit test");
            let immediate = unsafe { WaitForSingleObject(monitor, 250) };
            let eventual = unsafe { WaitForSingleObject(monitor, 6000) };
            unsafe {
                CloseHandle(monitor);
            }
            let _ = std::fs::remove_file(path);
            assert_eq!(
                immediate, WAIT_TIMEOUT,
                "process remains after helper releases the job"
            );
            assert_eq!(
                eventual, WAIT_OBJECT_0,
                "test process eventually exits by itself"
            );
        }
    }
}

#[cfg(windows)]
pub use platform::{adopt, handover, manage, photoshop_closed, system_stats};

#[cfg(not(windows))]
pub fn manage(
    _path: String,
    _base: String,
    _close_with_photoshop: bool,
    _restart_if_needed: bool,
    _disable_browser: bool,
    _start_if_missing: bool,
    _restart: bool,
) {
    server::send(&Event::ComfyStatus {
        state: "remote".into(),
        message: "ComfyUI 自动进程管理仅在 Windows 外置框架中可用。".into(),
        owned: false,
    });
}

#[cfg(not(windows))]
pub fn photoshop_closed() {}

#[cfg(not(windows))]
pub fn handover() {}

#[cfg(not(windows))]
pub fn adopt() {}
