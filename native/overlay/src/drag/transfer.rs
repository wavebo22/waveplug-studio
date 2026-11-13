//! Files for a drag to another program: the plugin exports each layer to a PNG in its temporary
//! folder; they are copied here into the helper's own cache (so the plugin can delete its copies
//! and nothing depends on UXP's folder), named after the layers, and offered through OLE as
//! CF_HDROP. Pure apart from the file system; the OLE side is drag/ole.rs.
//!
//! Cache: %LOCALAPPDATA%\WavePlug\TransferCache\
//! - store\<hash of key>.png: one export per layer version (the plugin's key: its load, the
//!   document, its history state, the layer). The plugin asks which keys are here before exporting
//!   (external-drag-prepare → external-drag-cached) and sends no file for those: dragging the same
//!   unchanged layer again exports nothing. Kept for a day after last use, and to BUDGET in all.
//! - <sessionId>\<layer name>.png: what one drag offers, hard links into the store (no second
//!   copy on disk). A dropped session is kept a day (the target may read the files later, e.g. a
//!   chat that sends on a click); any other ending removes it at once.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

/// One exported layer, as the plugin reports it (external-drag-ready).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub layer_id: u32,
    pub name: String,
    /// the plugin's export; empty when `key` is already in the store
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub order: u32,
    /// identifies this layer version for reuse (empty: no reuse)
    #[serde(default)]
    pub key: String,
    /// where the PNG's pixels sit in the document (px), for the combined SVG
    #[serde(default)]
    pub rect: Option<Rect>,
    /// text / shape layers: the layer as an SVG fragment (document px), for vector programs
    #[serde(default)]
    pub vector: Option<String>,
    /// the document's resolution (ppi)
    #[serde(default)]
    pub res: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Rect {
    pub left: i64,
    pub top: i64,
    pub right: i64,
    pub bottom: i64,
}

/// How a program is handed a drag (docs/CROSS_APP_DRAG_DROP_SPEC.md §16).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    /// imported through its own scripting: pixels embedded, text and shapes editable
    Illustrator,
    /// standard drop, but the combined SVG instead of PNGs when there are vectors
    Figma,
    /// standard drop of the PNGs
    Files,
}

pub fn profile(exe: &str) -> Profile {
    match exe.to_ascii_lowercase().as_str() {
        "illustrator.exe" => Profile::Illustrator,
        "figma.exe" => Profile::Figma,
        _ => Profile::Files,
    }
}

/// The keys held at the release: Ctrl = everything as images, Alt = the target's own drop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropMode {
    Smart,
    Images,
    Plain,
}

pub fn drop_mode(ctrl: bool, alt: bool) -> DropMode {
    if alt {
        DropMode::Plain
    } else if ctrl {
        DropMode::Images
    } else {
        DropMode::Smart
    }
}

/// What the card says over Illustrator, by mode (`vectors`: some layer stays editable).
pub fn illustrator_text(mode: DropMode, vectors: bool, accepts: bool) -> String {
    match mode {
        DropMode::Smart if vectors => "嵌入 Illustrator · 可编辑".into(),
        DropMode::Smart => "嵌入到 Illustrator".into(),
        DropMode::Images => "作为图片嵌入 Illustrator".into(),
        DropMode::Plain if accepts => "链接到 Illustrator".into(),
        DropMode::Plain => "Illustrator 不接收".into(),
    }
}

/// COM names to try for the running Illustrator, from its install path: "Adobe Illustrator
/// 2025" is version 29 (year − 1996); the version-independent name last.
pub fn illustrator_progids(exe_path: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(i) = exe_path.find("Adobe Illustrator ") {
        let year: String = exe_path[i + 18..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(y) = year.parse::<u32>() {
            if (2010..2100).contains(&y) {
                out.push(format!("Illustrator.Application.{}", y - 1996));
            }
        }
    }
    out.push("Illustrator.Application".into());
    out
}

/// A JavaScript string literal (JSON's, plus the two line separators ES3 rejects in strings).
pub fn js_string(s: &str) -> String {
    serde_json::to_string(s)
        .unwrap_or_else(|_| "\"\"".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Illustrator's own script (ExtendScript, run by DoJavaScript): the SVG into the active
/// document as embedded, editable art, centred on the drop point (`fx`, `fy`: where in the
/// visible canvas, 0–1; outside that range the view's centre). No document: a new one, its
/// artboard fitted to the art (the SVG itself is never opened: it lives in our cache).
pub fn illustrator_jsx(svg: &str, fx: f64, fy: f64) -> String {
    format!(
        r#"(function () {{
  var f = new File({path});
  if (!f.exists) return "error: no file";
  if (app.documents.length == 0) {{
    var nd = app.documents.add(DocumentColorSpace.RGB);
    var ng = nd.groupItems.createFromFile(f);
    nd.artboards[0].artboardRect = ng.visibleBounds;
    return "ok new document";
  }}
  var d = app.activeDocument;
  var g = d.groupItems.createFromFile(f);
  var v = d.views[0].bounds;
  var fx = {fx}, fy = {fy};
  var cx = (fx >= 0 && fx <= 1) ? v[0] + fx * (v[2] - v[0]) : (v[0] + v[2]) / 2;
  var cy = (fy >= 0 && fy <= 1) ? v[1] + fy * (v[3] - v[1]) : (v[1] + v[3]) / 2;
  var up = v[1] > v[3];
  g.position = [cx - g.width / 2, up ? cy + g.height / 2 : cy - g.height / 2];
  d.selection = null;
  g.selected = true;
  return "ok placed " + Math.round(g.width) + "x" + Math.round(g.height) + " items=" + g.pageItems.length;
}})();"#,
        path = js_string(svg),
    )
}

/// The Windows Script Host side (JScript, run by cscript): finds the running Illustrator over
/// COM and runs `jsx` in it; prints its answer, or "error: …".
pub fn illustrator_wsh(progids: &[String], jsx: &str) -> String {
    let names = progids.iter().map(|p| js_string(p)).collect::<Vec<_>>().join(", ");
    format!(
        r#"var names = [{names}], ai = null, why = "";
for (var i = 0; i < names.length && !ai; i++) {{
  try {{ ai = new ActiveXObject(names[i]); }} catch (e) {{ why += names[i] + ": " + e.message + "; "; }}
}}
if (!ai) {{ WScript.Echo("error: COM " + why); WScript.Quit(1); }}
try {{ WScript.Echo(String(ai.DoJavaScript({jsx}))); }} catch (e) {{ WScript.Echo("error: " + e.message); WScript.Quit(1); }}
"#,
        jsx = js_string(jsx),
    )
}

/// How long a dropped session's files, and a store entry after its last use, stay.
pub const KEEP: Duration = Duration::from_secs(24 * 60 * 60);
/// The store's size limit: the least recently used entries go first.
pub const BUDGET: u64 = 1 << 30;
const STORE: &str = "store";

/// FNV-1a: a stable file name for a key (any characters, any length).
fn hash(key: &str) -> u64 {
    key.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

pub fn store_path(root: &Path, key: &str) -> PathBuf {
    root.join(STORE).join(format!("{:016x}.png", hash(key)))
}

fn usable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > 0)
}

/// Which of `keys` the store already holds.
pub fn cached_keys(root: &Path, keys: &[String]) -> Vec<String> {
    keys.iter().filter(|k| !k.is_empty() && usable(&store_path(root, k))).cloned().collect()
}

/// Marks a store entry as just used (the sweep removes the least recently used first).
fn touch(p: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(p) {
        let _ = f.set_modified(SystemTime::now());
    }
}

fn link_or_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::hard_link(from, to).or_else(|_| std::fs::copy(from, to).map(|_| ()))
}

/// A layer name as a Windows file name stem: no reserved characters or device names, no
/// trailing dots or spaces, not empty, not overlong.
pub fn sanitize_stem(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > 100 {
        s = s.chars().take(100).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    if s.is_empty() {
        s = "图层".into();
    }
    let upper = s.to_ascii_uppercase();
    let device = upper.split('.').next().unwrap_or("");
    let reserved = matches!(device, "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4 && (device.starts_with("COM") || device.starts_with("LPT")) && device.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.insert(0, '_');
    }
    s
}

/// `<stem>.png` for each name, numbered " (2)", " (3)"… where Windows would see the same name.
pub fn unique_png_names(names: &[String]) -> Vec<String> {
    let mut taken: Vec<String> = Vec::new();
    names
        .iter()
        .map(|n| {
            let stem = sanitize_stem(n);
            let mut candidate = format!("{stem}.png");
            let mut k = 2;
            while taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate) || t.to_lowercase() == candidate.to_lowercase()) {
                candidate = format!("{stem} ({k}).png");
                k += 1;
            }
            taken.push(candidate.clone());
            candidate
        })
        .collect()
}

/// The session id as a folder name (it comes from the plugin: keep it to safe characters).
pub fn session_folder(session_id: &str) -> String {
    let s: String = session_id.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(64).collect();
    if s.is_empty() { "session".into() } else { s }
}

pub fn cache_root() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("WavePlug").join("TransferCache"))
}

/// Puts a drag's files in `root/<session>/`, in layer order, named after the layers: new exports
/// go into the store first (when keyed), reused ones come from it, and the session folder holds
/// hard links (copies where linking fails). Every file must be there, or nothing is kept.
pub fn copy_session(root: &Path, session_id: &str, files: &[SourceFile]) -> Result<Vec<PathBuf>, String> {
    if files.is_empty() {
        return Err("没有要传输的文件".into());
    }
    let mut files = files.to_vec();
    files.sort_by_key(|f| f.order);
    for f in &files {
        if !f.path.is_empty() {
            if !usable(Path::new(&f.path)) {
                return Err(format!("找不到导出文件或文件为空：{}", f.path));
            }
        } else if f.key.is_empty() || !usable(&store_path(root, &f.key)) {
            return Err(format!("缓存里已经没有图层 {} 的导出", f.layer_id));
        }
    }
    let mut sources = Vec::with_capacity(files.len());
    for f in &files {
        let source = if f.key.is_empty() {
            PathBuf::from(&f.path)
        } else {
            let stored = store_path(root, &f.key);
            if !f.path.is_empty() {
                std::fs::create_dir_all(root.join(STORE)).map_err(|e| format!("无法创建导出缓存：{e}"))?;
                std::fs::copy(&f.path, &stored).map_err(|e| format!("复制 {} 失败：{e}", f.path))?;
            }
            touch(&stored);
            stored
        };
        sources.push(source);
    }
    let dir = root.join(session_folder(session_id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建传输缓存 {}：{e}", dir.display()))?;
    let names = unique_png_names(&files.iter().map(|f| f.name.clone()).collect::<Vec<_>>());
    let mut out = Vec::with_capacity(files.len());
    for (source, name) in sources.iter().zip(names) {
        let to = dir.join(name);
        if let Err(e) = link_or_copy(source, &to) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("准备 {} 失败：{e}", to.display()));
        }
        out.push(to);
    }
    Ok(out)
}

pub fn remove_session(root: &Path, session_id: &str) {
    let _ = std::fs::remove_dir_all(root.join(session_folder(session_id)));
}

fn age(m: &std::fs::Metadata, now: SystemTime) -> Duration {
    m.modified().ok().and_then(|t| now.duration_since(t).ok()).unwrap_or_default()
}

/// Removes session folders and store entries unused for more than `keep`, then the least
/// recently used store entries until the store fits in `budget` bytes. Returns how many went.
pub fn sweep(root: &Path, keep: Duration, budget: u64, now: SystemTime) -> usize {
    let mut removed = 0;
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.file_name().is_some_and(|n| n == STORE) || !p.is_dir() {
                continue;
            }
            if e.metadata().is_ok_and(|m| age(&m, now) > keep) && std::fs::remove_dir_all(&p).is_ok() {
                removed += 1;
            }
        }
    }
    let mut stored: Vec<(PathBuf, u64, Duration)> = std::fs::read_dir(root.join(STORE))
        .map(|rd| rd.flatten().filter_map(|e| e.metadata().ok().filter(|m| m.is_file()).map(|m| (e.path(), m.len(), age(&m, now)))).collect())
        .unwrap_or_default();
    // oldest first
    stored.sort_by(|a, b| b.2.cmp(&a.2));
    let mut total: u64 = stored.iter().map(|s| s.1).sum();
    for (p, len, a) in stored {
        if (a > keep || total > budget) && std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
            removed += 1;
        }
    }
    removed
}

/// CF_HDROP's HGLOBAL contents: DROPFILES { pFiles = 20, pt = (0, 0), fNC = 0, fWide = 1 }, then
/// each path as UTF-16 with its NUL, then one more NUL.
pub fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&20u32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&1i32.to_le_bytes());
    for p in paths {
        for u in p.to_string_lossy().encode_utf16().chain(Some(0)) {
            out.extend_from_slice(&u.to_le_bytes());
        }
    }
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// What the user calls the program owning a window (exe file name): shown on the card and in the
/// plugin's result message. Unknown programs keep their exe name without ".exe".
pub fn app_label(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    let label = match lower.as_str() {
        "wechat.exe" | "weixin.exe" | "wechatappex.exe" => "微信",
        "qq.exe" | "qqnt.exe" => "QQ",
        "tim.exe" => "TIM",
        "dingtalk.exe" => "钉钉",
        "feishu.exe" | "lark.exe" => "飞书",
        "wxwork.exe" => "企业微信",
        "explorer.exe" => "文件夹",
        "chrome.exe" | "msedge.exe" | "firefox.exe" | "brave.exe" | "opera.exe" | "360se.exe" | "qqbrowser.exe" => "浏览器",
        "winword.exe" => "Word",
        "powerpnt.exe" => "PowerPoint",
        "excel.exe" => "Excel",
        "figma.exe" => "Figma",
        "illustrator.exe" => "Illustrator",
        "photoshop.exe" => "Photoshop",
        "" | "?" => "这里",
        _ => "",
    };
    if !label.is_empty() {
        return label.into();
    }
    exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe).to_string()
}

/// The card while files are being exported: how far along, when the plugin reported it.
pub fn preparing_text(done: usize, total: usize) -> String {
    if total > 1 && done > 0 {
        format!("正在准备 {}/{} 个文件…", done.min(total), total)
    } else {
        format!("正在准备 {} 个文件…", total.max(1))
    }
}

/// A PNG as CF_DIBV5: BITMAPV5HEADER (32-bit, BI_BITFIELDS, BGRA masks, sRGB) and the pixels
/// bottom-up as BGRA with straight alpha, which Office and most image-taking programs read.
pub fn png_to_dibv5(png: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png).map_err(|e| format!("PNG 解码失败：{e}"))?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("空图像".into());
    }
    let size = (w as usize) * (h as usize) * 4;
    let mut out = Vec::with_capacity(124 + size);
    let u32le = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_le_bytes());
    u32le(&mut out, 124); // bV5Size
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32).to_le_bytes()); // positive: bottom-up rows
    out.extend_from_slice(&1u16.to_le_bytes()); // planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    u32le(&mut out, 3); // BI_BITFIELDS
    u32le(&mut out, size as u32);
    u32le(&mut out, 2835); // 72 dpi in pixels per metre
    u32le(&mut out, 2835);
    u32le(&mut out, 0); // colours used
    u32le(&mut out, 0); // important
    u32le(&mut out, 0x00FF_0000); // red mask
    u32le(&mut out, 0x0000_FF00); // green
    u32le(&mut out, 0x0000_00FF); // blue
    u32le(&mut out, 0xFF00_0000); // alpha
    u32le(&mut out, 0x7352_4742); // LCS_sRGB
    out.extend_from_slice(&[0u8; 36]); // endpoints
    u32le(&mut out, 0); // gamma red, green, blue
    u32le(&mut out, 0);
    u32le(&mut out, 0);
    u32le(&mut out, 4); // LCS_GM_IMAGES
    u32le(&mut out, 0); // profile data
    u32le(&mut out, 0); // profile size
    u32le(&mut out, 0); // reserved
    for row in (0..h).rev() {
        for x in 0..w {
            let p = img.get_pixel(x, row);
            out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    Ok(out)
}

pub const DRAGDROP_S_DROP: i32 = 0x0004_0100;
pub const DRAGDROP_S_CANCEL: i32 = 0x0004_0101;
pub const DROPEFFECT_COPY: u32 = 1;

/// What a finished DoDragDrop means for the plugin (external-drag-finished `status`).
pub fn outcome(hr: i32, effect: u32) -> &'static str {
    match hr {
        DRAGDROP_S_DROP if effect & DROPEFFECT_COPY != 0 => "dropped",
        DRAGDROP_S_DROP => "rejected",
        DRAGDROP_S_CANCEL => "cancelled",
        _ => "error",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn profiles_modes_and_card_text() {
        use super::*;
        assert_eq!(profile("Illustrator.exe"), Profile::Illustrator);
        assert_eq!(profile("Figma.exe"), Profile::Figma);
        assert_eq!(profile("WeChat.exe"), Profile::Files);
        assert_eq!(drop_mode(false, false), DropMode::Smart);
        assert_eq!(drop_mode(true, false), DropMode::Images);
        assert_eq!(drop_mode(true, true), DropMode::Plain);
        assert_eq!(illustrator_text(DropMode::Smart, true, false), "嵌入 Illustrator · 可编辑");
        assert_eq!(illustrator_text(DropMode::Plain, false, false), "Illustrator 不接收");
    }

    #[test]
    fn illustrator_progids_from_the_install_path() {
        use super::*;
        let p = r"C:\Program Files\Adobe\Adobe Illustrator 2025\Support Files\Contents\Windows\Illustrator.exe";
        assert_eq!(illustrator_progids(p), vec!["Illustrator.Application.29".to_string(), "Illustrator.Application".to_string()]);
        assert_eq!(illustrator_progids(r"D:\AI\Illustrator.exe"), vec!["Illustrator.Application".to_string()]);
    }

    #[test]
    fn scripts_quote_paths_and_code() {
        use super::*;
        assert_eq!(js_string("C:\\a\"b\u{2028}"), r#""C:\\a\"b\u2028""#);
        let jsx = illustrator_jsx(r"C:\缓存\合成.svg", 0.25, 0.5);
        assert!(jsx.contains(r#"new File("C:\\缓存\\合成.svg")"#), "{jsx}");
        assert!(jsx.contains("var fx = 0.25, fy = 0.5;"));
        let wsh = illustrator_wsh(&["Illustrator.Application".into()], &jsx);
        assert!(wsh.starts_with(r#"var names = ["Illustrator.Application"]"#));
        assert!(wsh.contains(r#"ai.DoJavaScript("(function () {\n"#), "{wsh}");
    }

    use super::*;

    #[test]
    fn names_lose_reserved_characters_and_device_names() {
        assert_eq!(sanitize_stem("产品/主图: v2?"), "产品_主图_ v2_");
        assert_eq!(sanitize_stem("  标题.  "), "标题");
        assert_eq!(sanitize_stem(""), "图层");
        assert_eq!(sanitize_stem("CON"), "_CON");
        assert_eq!(sanitize_stem("com3.txt"), "_com3.txt");
        assert_eq!(sanitize_stem("COMET"), "COMET");
        assert_eq!(sanitize_stem(&"长".repeat(150)).chars().count(), 100);
    }

    #[test]
    fn duplicate_names_are_numbered_case_insensitively() {
        let names = ["图层 1", "图层 1", "Logo", "logo", "图层 1"].map(String::from);
        assert_eq!(unique_png_names(&names), vec!["图层 1.png", "图层 1 (2).png", "Logo.png", "logo (2).png", "图层 1 (3).png"]);
    }

    #[test]
    fn session_folder_keeps_only_safe_characters() {
        assert_eq!(session_folder("drag-1731-ab_9"), "drag-1731-ab_9");
        assert_eq!(session_folder("..\\..\\x"), "x");
        assert_eq!(session_folder("//"), "session");
    }

    #[test]
    fn hdrop_has_a_wide_header_and_double_nul_end() {
        let b = hdrop_bytes(&[PathBuf::from("C:\\a\\图.png"), PathBuf::from("C:\\b.png")]);
        assert_eq!(&b[0..4], &20u32.to_le_bytes());
        assert_eq!(&b[16..20], &1i32.to_le_bytes());
        let text: Vec<u16> = b[20..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let s = String::from_utf16(&text).unwrap();
        assert_eq!(s, "C:\\a\\图.png\0C:\\b.png\0\0");
    }

    #[test]
    fn programs_are_named_as_people_call_them() {
        assert_eq!(app_label("WeChat.exe"), "微信");
        assert_eq!(app_label("Weixin.exe"), "微信");
        assert_eq!(app_label("explorer.exe"), "文件夹");
        assert_eq!(app_label("msedge.exe"), "浏览器");
        assert_eq!(app_label("WINWORD.EXE"), "Word");
        assert_eq!(app_label("Blender.exe"), "Blender");
        assert_eq!(app_label("?"), "这里");
    }

    #[test]
    fn preparing_text_shows_progress_for_several_files() {
        assert_eq!(preparing_text(0, 1), "正在准备 1 个文件…");
        assert_eq!(preparing_text(0, 5), "正在准备 5 个文件…");
        assert_eq!(preparing_text(2, 5), "正在准备 2/5 个文件…");
        assert_eq!(preparing_text(9, 5), "正在准备 5/5 个文件…");
    }

    #[test]
    fn dibv5_has_a_v5_header_and_bottom_up_bgra_rows() {
        let mut img = image::RgbaImage::new(2, 2);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 128])); // top-left red, half transparent
        img.put_pixel(0, 1, image::Rgba([0, 0, 255, 255])); // bottom-left blue
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let dib = png_to_dibv5(&png).unwrap();
        assert_eq!(dib.len(), 124 + 2 * 2 * 4);
        assert_eq!(&dib[0..4], &124u32.to_le_bytes());
        assert_eq!(&dib[8..12], &2i32.to_le_bytes()); // positive height
        assert_eq!(&dib[16..20], &3u32.to_le_bytes()); // BI_BITFIELDS
        assert_eq!(&dib[52..56], &0xFF00_0000u32.to_le_bytes()); // alpha mask
        // the first row stored is the bottom one: blue first
        assert_eq!(&dib[124..128], &[255, 0, 0, 255]);
        // then the top row: red with its alpha kept as is
        assert_eq!(&dib[132..136], &[0, 0, 255, 128]);
        assert!(png_to_dibv5(b"not a png").is_err());
    }

    #[test]
    fn outcome_reads_both_the_result_and_the_effect() {
        assert_eq!(outcome(DRAGDROP_S_DROP, DROPEFFECT_COPY), "dropped");
        assert_eq!(outcome(DRAGDROP_S_DROP, 0), "rejected");
        assert_eq!(outcome(DRAGDROP_S_CANCEL, 0), "cancelled");
        assert_eq!(outcome(-2147467259, 0), "error");
    }

    #[test]
    fn copies_in_layer_order_and_refuses_missing_sources() {
        let root = std::env::temp_dir().join(format!("wp-transfer-test-{}", std::process::id()));
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let a = src.join("a.png");
        let b = src.join("b.png");
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&b, b"B").unwrap();
        let files = vec![
            SourceFile { layer_id: 2, name: "下".into(), path: b.to_string_lossy().into(), order: 1, key: String::new(), ..Default::default() },
            SourceFile { layer_id: 1, name: "上".into(), path: a.to_string_lossy().into(), order: 0, key: String::new(), ..Default::default() },
        ];
        let cache = root.join("cache");
        let out = copy_session(&cache, "s1", &files).unwrap();
        assert_eq!(out.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>(), vec!["上.png", "下.png"]);
        assert_eq!(std::fs::read(&out[0]).unwrap(), b"A");

        let missing = vec![SourceFile { layer_id: 3, name: "x".into(), path: src.join("none.png").to_string_lossy().into(), order: 0, key: String::new(), ..Default::default() }];
        assert!(copy_session(&cache, "s2", &missing).is_err());
        assert!(!cache.join("s2").exists());

        remove_session(&cache, "s1");
        assert!(!cache.join("s1").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_keyed_export_is_stored_once_and_reused_without_a_file() {
        let root = std::env::temp_dir().join(format!("wp-store-test-{}", std::process::id()));
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let a = src.join("a.png");
        std::fs::write(&a, b"PNG").unwrap();
        let cache = root.join("cache");
        let key = "load1:60:h42:7".to_string();
        assert!(cached_keys(&cache, &[key.clone()]).is_empty());
        let first = vec![SourceFile { layer_id: 7, name: "标题".into(), path: a.to_string_lossy().into(), order: 0, key: key.clone(), ..Default::default() }];
        copy_session(&cache, "s1", &first).unwrap();
        assert_eq!(cached_keys(&cache, &[key.clone(), "other".into()]), vec![key.clone()]);
        // the plugin's file is gone; the next drag sends only the key
        std::fs::remove_file(&a).unwrap();
        let again = vec![SourceFile { layer_id: 7, name: "标题".into(), path: String::new(), order: 0, key: key.clone(), ..Default::default() }];
        let out = copy_session(&cache, "s2", &again).unwrap();
        assert_eq!(std::fs::read(&out[0]).unwrap(), b"PNG");
        // an unknown key without a file fails
        let unknown = vec![SourceFile { layer_id: 8, name: "x".into(), path: String::new(), order: 0, key: "nope".into(), ..Default::default() }];
        assert!(copy_session(&cache, "s3", &unknown).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sweep_removes_old_sessions_and_keeps_the_store_in_budget() {
        let root = std::env::temp_dir().join(format!("wp-sweep-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("fresh")).unwrap();
        std::fs::create_dir_all(root.join(STORE)).unwrap();
        for k in ["a", "b", "c"] {
            std::fs::write(store_path(&root, k), vec![0u8; 100]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let now = SystemTime::now();
        assert_eq!(sweep(&root, KEEP, BUDGET, now), 0);
        // over budget: the oldest ("a") goes first
        assert_eq!(sweep(&root, KEEP, 250, now), 1);
        assert!(!store_path(&root, "a").exists());
        assert!(store_path(&root, "c").exists());
        // a day later everything goes
        assert_eq!(sweep(&root, KEEP, BUDGET, now + KEEP + Duration::from_secs(60)), 3);
        assert!(!root.join("fresh").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
