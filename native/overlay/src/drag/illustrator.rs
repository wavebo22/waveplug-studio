//! Drops into Illustrator through its own scripting, not OLE: Illustrator links dropped files
//! (our cache would leave it with broken links) and doesn't reliably take SVG data. So the release
//! over Illustrator cancels the system drag and this runs, on a thread of its own:
//! cscript (JScript) → COM `Illustrator.Application` → `DoJavaScript` → `groupItems.createFromFile`
//! of the combined SVG (compose.rs): embedded, text and shapes editable, centred on the drop point.
//! The result goes to the plugin as external-drag-finished with effect "embed".

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows_sys::core::GUID;
use windows_sys::Win32::System::Com::CLSIDFromProgID;

use super::compose;
use super::transfer::{self, SourceFile};
use super::{emit, Event};
use crate::log;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TIMEOUT: Duration = Duration::from_secs(15);

pub struct Job {
    pub session_id: String,
    pub items: Vec<SourceFile>,
    /// the editable SVG the transfer already wrote (when some layer has vectors)
    pub editable: Option<PathBuf>,
    /// Ctrl at the release: every layer as its image
    pub raster: bool,
    pub progids: Vec<String>,
    /// the drop point within the visible canvas (0–1)
    pub fx: f64,
    pub fy: f64,
    pub count: usize,
}

/// The COM names of `progids` that are registered (Illustrator can be scripted), in order.
pub fn available(progids: Vec<String>) -> Option<Vec<String>> {
    let ok: Vec<String> = progids
        .into_iter()
        .filter(|p| {
            let w: Vec<u16> = p.encode_utf16().chain(Some(0)).collect();
            let mut id: GUID = unsafe { std::mem::zeroed() };
            unsafe { CLSIDFromProgID(w.as_ptr(), &mut id) == 0 }
        })
        .collect();
    (!ok.is_empty()).then_some(ok)
}

pub fn run(job: Job) {
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let result = import(&job);
        let (status, answer) = match &result {
            Ok(out) if out.starts_with("ok") => ("dropped", out.clone()),
            Ok(out) => ("error", out.clone()),
            Err(e) => ("error", e.clone()),
        };
        log::line(format!(
            "illustrator import status={status} raster={} layers={} ms={} answer={answer}",
            job.raster,
            job.items.len(),
            t0.elapsed().as_millis()
        ));
        emit(Event::ExternalFinished {
            session_id: job.session_id.clone(),
            status,
            effect: "embed",
            target: "Illustrator".into(),
            count: job.count,
        });
        // embedded: Illustrator keeps nothing pointing at our files
        if let Some(root) = transfer::cache_root() {
            transfer::remove_session(&root, &job.session_id);
        }
        super::sweep_cache();
    });
}

fn import(job: &Job) -> Result<String, String> {
    let root = transfer::cache_root().ok_or("没有 LOCALAPPDATA")?;
    let dir = root.join(transfer::session_folder(&job.session_id));
    let svg = match (&job.editable, job.raster) {
        (Some(p), false) if p.is_file() => p.clone(),
        _ => {
            let to = dir.join(if job.raster { compose::IMAGES } else { compose::EDITABLE });
            compose::write(&job.items, job.raster, &to)?;
            to
        }
    };
    let jsx = transfer::illustrator_jsx(&svg.to_string_lossy(), job.fx, job.fy);
    let script = transfer::illustrator_wsh(&job.progids, &jsx);
    // UTF-16 with a BOM: cscript reads it as Unicode (the paths may have Chinese in them)
    let mut bytes = vec![0xFF, 0xFE];
    for u in script.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    let js = dir.join("import.js");
    std::fs::write(&js, bytes).map_err(|e| format!("写入脚本失败：{e}"))?;
    let mut child = Command::new("cscript.exe")
        .args(["//nologo", "//E:JScript"])
        .arg(&js)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("无法启动 cscript：{e}"))?;
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                return Err(format!("Illustrator 没有在 {} 秒内回应（可能有对话框开着）", TIMEOUT.as_secs()));
            }
            Err(e) => return Err(format!("等待 cscript 失败：{e}")),
        }
    }
    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut s) = child.stdout.take() {
        let mut b = Vec::new();
        let _ = s.read_to_end(&mut b);
        out = String::from_utf8_lossy(&b).trim().to_string();
    }
    if let Some(mut s) = child.stderr.take() {
        let mut b = Vec::new();
        let _ = s.read_to_end(&mut b);
        err = String::from_utf8_lossy(&b).trim().to_string();
    }
    if out.is_empty() && !err.is_empty() {
        return Err(format!("error: {err}"));
    }
    Ok(out)
}
