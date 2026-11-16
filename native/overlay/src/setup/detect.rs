// Finding Photoshop and Illustrator, and what of WavePlug is installed for them. Pure where it can
// be (tested); the scanning only reads folders.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum App {
    Photoshop,
    Illustrator,
}

impl App {
    pub fn label(self) -> &'static str {
        match self {
            App::Photoshop => "Photoshop",
            App::Illustrator => "Illustrator",
        }
    }
    /// the program's file name (for "is it running")
    pub fn exe_name(self) -> &'static str {
        match self {
            App::Photoshop => "Photoshop.exe",
            App::Illustrator => "Illustrator.exe",
        }
    }
    /// where the program is inside its install folder
    fn exe_in_folder(self) -> &'static [&'static str] {
        match self {
            App::Photoshop => &["Photoshop.exe"],
            App::Illustrator => &["Support Files", "Contents", "Windows", "Illustrator.exe"],
        }
    }
    fn folder_prefix(self) -> &'static str {
        match self {
            App::Photoshop => "Adobe Photoshop",
            App::Illustrator => "Adobe Illustrator",
        }
    }
    /// the oldest version WavePlug runs in (major version): Photoshop 2024 (plugin/manifest.json
    /// minVersion 25), Illustrator 2022 (CEP 11, ai/CSXS/manifest.xml)
    pub fn min_major(self) -> u32 {
        match self {
            App::Photoshop => 25,
            App::Illustrator => 26,
        }
    }
    /// the major version of the release named after `year` (Photoshop 2026 is 27, Illustrator 2026 is 30)
    pub fn major_of_year(self, year: u32) -> u32 {
        match self {
            App::Photoshop => year.saturating_sub(1999),
            App::Illustrator => year.saturating_sub(1996),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    /// the program itself
    pub exe: PathBuf,
    /// from the folder name ("Adobe Photoshop 2026")
    pub year: Option<u32>,
    pub major: Option<u32>,
}

impl Found {
    pub fn describe(&self, app: App) -> String {
        match (self.year, self.major) {
            (Some(y), Some(m)) => format!("{} {y}（{m}）", app.label()),
            _ => format!("{}（版本未知）", app.label()),
        }
    }
    /// false only when the version is known and too old
    pub fn supported(&self, app: App) -> bool {
        self.major.map_or(true, |m| m >= app.min_major())
    }
}

/// The first 20xx in a folder name.
pub fn year_in(name: &str) -> Option<u32> {
    let b = name.as_bytes();
    (0..b.len().saturating_sub(3)).find_map(|i| {
        let s = &name.get(i..i + 4)?;
        let ok = s.starts_with("20") && s.bytes().all(|c| c.is_ascii_digit());
        let edge = |j: Option<&u8>| j.map_or(true, |c| !c.is_ascii_digit());
        (ok && edge(if i == 0 { None } else { b.get(i - 1) }) && edge(b.get(i + 4))).then(|| s.parse().ok()).flatten()
    })
}

/// What a picked program file is: its version from the install folder's name (the nearest folder
/// above it with a year in it).
pub fn describe_exe(app: App, exe: &Path) -> Found {
    let year = exe.ancestors().skip(1).take(5).find_map(|p| p.file_name().and_then(|n| n.to_str()).and_then(year_in));
    Found { exe: exe.to_path_buf(), year, major: year.map(|y| app.major_of_year(y)) }
}

/// Install folders of `app` under `roots` (each holding "Adobe Photoshop 2026" and the like), newest first.
pub fn scan(app: App, roots: &[PathBuf]) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    for root in roots {
        let Ok(list) = std::fs::read_dir(root) else { continue };
        for e in list.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(app.folder_prefix()) {
                continue;
            }
            let mut exe = e.path();
            for part in app.exe_in_folder() {
                exe.push(part);
            }
            if exe.is_file() && !out.iter().any(|f| f.exe == exe) {
                out.push(describe_exe(app, &exe));
            }
        }
    }
    out.sort_by(|a, b| b.year.cmp(&a.year));
    out
}

/// Every copy of `app` that can be found: the usual folders (`scan`), the running program, and
/// where Windows says it is installed (App Paths in the registry; Creative Cloud writes it, also for
/// installs on other drives or in other folders). Newest first.
pub fn find(app: App) -> Vec<Found> {
    let mut out = scan(app, &default_roots());
    let mut more: Vec<PathBuf> = Vec::new();
    let stem = app.exe_name().trim_end_matches(".exe");
    let ps = format!("(Get-Process -Name '{stem}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)");
    if let Ok((0, text)) = super::sys::run("powershell", &["-NoProfile", "-NonInteractive", "-Command", &ps]) {
        more.extend(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from));
    }
    for hive in ["HKLM", "HKCU"] {
        let key = format!("{hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}", app.exe_name());
        if let Ok((0, text)) = super::sys::run("reg", &["query", &key, "/ve"]) {
            more.extend(reg_default_value(&text).map(PathBuf::from));
        }
    }
    for exe in more {
        let same = |f: &Found| f.exe.to_string_lossy().eq_ignore_ascii_case(&exe.to_string_lossy());
        if exe.is_file() && exe.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(app.exe_name())) && !out.iter().any(same) {
            out.push(describe_exe(app, &exe));
        }
    }
    out.sort_by(|a, b| b.year.cmp(&a.year));
    out
}

/// The default value in `reg query … /ve` output ("(Default)    REG_SZ    C:\…"), quotes taken off.
pub fn reg_default_value(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let i = l.find("REG_SZ").or_else(|| l.find("REG_EXPAND_SZ"))?;
        let v = l[i..].split_once(char::is_whitespace)?.1.trim().trim_matches('"').to_string();
        (!v.is_empty()).then_some(v)
    })
}

/// Where Adobe programs usually are: Program Files\Adobe on every drive, and the drive roots'
/// Adobe folders (people move them to D:).
pub fn default_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("ProgramFiles") {
        out.push(Path::new(&p).join("Adobe"));
    }
    for d in b'C'..=b'H' {
        let drive = format!("{}:\\", d as char);
        for sub in ["Program Files\\Adobe", "Adobe", "Program Files"] {
            let p = Path::new(&drive).join(sub);
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// The installed version of a UXP plugin and whether it is on, from Adobe's plugin list
/// (Common Files\Adobe\UXP\PluginsInfo\v1\PS.json).
pub fn uxp_plugin(plugins_json: &str, id: &str) -> Option<(String, bool)> {
    let v: serde_json::Value = serde_json::from_str(plugins_json).ok()?;
    let list = v.get("plugins")?.as_array()?;
    list.iter().find(|p| p.get("pluginId").and_then(|x| x.as_str()) == Some(id)).map(|p| {
        let ver = p.get("versionString").and_then(|x| x.as_str()).unwrap_or("?").to_string();
        let on = p.get("status").and_then(|x| x.as_str()).map_or(true, |s| s.eq_ignore_ascii_case("enabled"));
        (ver, on)
    })
}

/// ExtensionBundleVersion of a CEP manifest.
pub fn cep_version(manifest_xml: &str) -> Option<String> {
    let key = "ExtensionBundleVersion=\"";
    let i = manifest_xml.find(key)? + key.len();
    let rest = &manifest_xml[i..];
    Some(rest[..rest.find('"')?].to_string())
}

/// "1.10.0" > "1.9.2": numbers compared part by part (missing parts are 0).
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |s: &str| s.split(['.', '-', ' ']).map(|p| p.trim().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (x, y) = (parts(a), parts(b));
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
        if p != q {
            return p > q;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_default_value() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe\r\n    (默认)    REG_SZ    D:\\Art\\Adobe Photoshop 2025\\Photoshop.exe\r\n";
        assert_eq!(reg_default_value(out).as_deref(), Some("D:\\Art\\Adobe Photoshop 2025\\Photoshop.exe"));
        assert_eq!(reg_default_value("    (Default)    REG_SZ    \"C:\\a b\\Illustrator.exe\"").as_deref(), Some("C:\\a b\\Illustrator.exe"));
        assert_eq!(reg_default_value("错误: 系统找不到指定的注册表项或值。"), None);
    }

    #[test]
    fn versions_from_folder_names() {
        assert_eq!(year_in("Adobe Photoshop 2026"), Some(2026));
        assert_eq!(year_in("Adobe Illustrator 2025 (Beta)"), Some(2025));
        assert_eq!(year_in("Adobe Photoshop CC"), None);
        assert_eq!(year_in("v120260"), None);
        assert_eq!(App::Photoshop.major_of_year(2026), 27);
        assert_eq!(App::Illustrator.major_of_year(2026), 30);
        let f = describe_exe(App::Illustrator, Path::new("D:/Apps/Adobe Illustrator 2021/Support Files/Contents/Windows/Illustrator.exe"));
        assert_eq!(f.major, Some(25));
        assert!(!f.supported(App::Illustrator), "2021 has CEP 10");
        assert_eq!(f.describe(App::Illustrator), "Illustrator 2021（25）");
        let p = describe_exe(App::Photoshop, Path::new("D:/PS/Photoshop.exe"));
        assert_eq!(p.major, None);
        assert!(p.supported(App::Photoshop));
    }

    #[test]
    fn scanning_finds_installs_newest_first() {
        let root = std::env::temp_dir().join(format!("wp-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (dir, file) in [
            ("Adobe Photoshop 2025", "Photoshop.exe"),
            ("Adobe Photoshop 2026", "Photoshop.exe"),
            ("Adobe Photoshop 2024", "readme.txt"),
            ("Adobe Illustrator 2026/Support Files/Contents/Windows", "Illustrator.exe"),
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join(file), b"x").unwrap();
        }
        let ps = scan(App::Photoshop, &[root.clone(), root.join("missing")]);
        assert_eq!(ps.iter().map(|f| f.year.unwrap()).collect::<Vec<_>>(), vec![2026, 2025]);
        let ai = scan(App::Illustrator, &[root.clone()]);
        assert_eq!(ai.len(), 1);
        assert_eq!(ai[0].major, Some(30));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn installed_versions() {
        let json = r#"{"plugins":[{"pluginId":"other","versionString":"9.9.9"},{"pluginId":"com.waveplug.studio","versionString":"1.2.0","status":"enabled"}]}"#;
        assert_eq!(uxp_plugin(json, "com.waveplug.studio"), Some(("1.2.0".into(), true)));
        assert_eq!(uxp_plugin(r#"{"plugins":[{"pluginId":"com.waveplug.studio","versionString":"1.1.0","status":"disabled"}]}"#, "com.waveplug.studio"), Some(("1.1.0".into(), false)));
        assert_eq!(uxp_plugin(json, "nope"), None);
        assert_eq!(uxp_plugin("not json", "x"), None);
        assert_eq!(cep_version(r#"<ExtensionManifest Version="7.0" ExtensionBundleId="com.waveplug.ai" ExtensionBundleVersion="0.1.0">"#), Some("0.1.0".into()));
        assert_eq!(cep_version("<x/>"), None);
    }

    #[test]
    fn version_order() {
        assert!(newer("1.10.0", "1.9.2"));
        assert!(newer("1.2.1", "1.2"));
        assert!(!newer("1.2.0", "1.2"));
        assert!(!newer("1.1.9", "1.2.0"));
    }
}
