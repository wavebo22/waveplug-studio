// 检查更新: the update source is a GitHub repository (its newest release, with the installer
// WavePlug_Setup_<version>.exe attached) or a latest.json address. A latest.json says the newest version and where its installer
// is; the installer is downloaded (Windows' own curl.exe: https without bundling TLS) and started.
// latest.json (scripts/package_setup.mjs writes it next to the installer):
//   { "version": "1.2.1", "url": "https://…/WavePlug_Setup_1.2.1.exe", "notes": "…" }
// `url` may be relative to latest.json's address.

use std::path::{Path, PathBuf};

/// Where updates come from when the user hasn't set anything: the project's public GitHub
/// repository; its newest Release carries WavePlug_Setup_<version>.exe (发布到 GitHub).
pub const DEFAULT_SOURCE: &str = "wavebo22/waveplug-studio";

use serde::Deserialize;

use super::sys;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Latest {
    pub version: String,
    pub url: String,
    #[serde(default)]
    pub notes: String,
}

pub fn parse_latest(text: &str, from: &str) -> Result<Latest, String> {
    let mut l: Latest = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("更新信息看不懂：{e}"))?;
    if l.version.trim().is_empty() || l.url.trim().is_empty() {
        return Err("更新信息里缺少 version 或 url".into());
    }
    l.url = resolve(from, l.url.trim());
    Ok(l)
}

/// `url` against the address it was found at ("WavePlug_Setup.exe" next to latest.json).
pub fn resolve(base: &str, url: &str) -> String {
    if url.contains("://") || url.starts_with("\\\\") || url.as_bytes().get(1) == Some(&b':') {
        return url.to_string();
    }
    match base.rfind(['/', '\\']) {
        Some(i) => format!("{}{}", &base[..=i], url.trim_start_matches(['/', '\\'])),
        None => url.to_string(),
    }
}

/// The GitHub repository the update source names: "owner/repo", "github.com/owner/repo" or
/// "https://github.com/owner/repo(.git)(/…)". None for anything else (a latest.json address).
pub fn github_repo(source: &str) -> Option<String> {
    let s = source.trim().trim_end_matches('/');
    let rest = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .or_else(|| s.strip_prefix("github.com/"))
        .unwrap_or(s);
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?.trim_end_matches(".git"));
    // a bare "a/b" only when nothing else in it looks like a path or an address
    if rest == s && (parts.next().is_some() || s.contains(':') || s.contains('\\') || s.ends_with(".json")) {
        return None;
    }
    let ok = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(repo)).then(|| format!("{owner}/{repo}"))
}

/// The newest release from GitHub's API answer: its tag (without "v") and the installer asset.
pub fn parse_github_release(text: &str) -> Result<Latest, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("GitHub 的回答看不懂：{e}"))?;
    let tag = v.get("tag_name").and_then(|t| t.as_str()).ok_or("GitHub 的回答里没有版本号")?;
    let version = tag.trim().trim_start_matches(['v', 'V']).to_string();
    let notes = v.get("body").and_then(|b| b.as_str()).unwrap_or("").trim().to_string();
    let url = v
        .get("assets")
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .find(|a| a.get("name").and_then(|n| n.as_str()).is_some_and(|n| n.starts_with("WavePlug_Setup") && n.to_lowercase().ends_with(".exe")))
        .and_then(|a| a.get("browser_download_url").and_then(|u| u.as_str()))
        .ok_or_else(|| format!("GitHub 上的 {tag} 没有附带 WavePlug_Setup_*.exe"))?
        .to_string();
    Ok(Latest { version, url, notes })
}

/// The newest version at the update source: a GitHub repository's latest release, or latest.json.
pub fn latest(source: &str) -> Result<Latest, String> {
    let source = source.trim();
    match github_repo(source) {
        Some(repo) => {
            let api = format!("https://api.github.com/repos/{repo}/releases/latest");
            let (code, out) = sys::run(
                "curl.exe",
                &["-sSL", "--max-time", "20", "-w", "\n%{http_code}", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: WavePlug-updater", &api],
            )?;
            let (body, status) = out.trim_end().rsplit_once('\n').unwrap_or(("", out.trim()));
            match status.trim() {
                "200" => parse_github_release(body),
                "404" => Err(format!("{repo} 还没有发布版本（或仓库不公开、名字不对）")),
                "403" | "429" => Err("GitHub 暂时限制了查询次数，过一会儿再试".into()),
                _ if code != 0 => Err(format!("连不上 GitHub（curl {code}）：{}", body.trim())),
                s => Err(format!("GitHub 返回 {s}")),
            }
        }
        None => parse_latest(&fetch_text(source)?, source),
    }
}

/// The release notes for `version` from CHANGELOG.md: its "## <version>" section, else the first.
pub fn changelog_notes(changelog: &str, version: &str) -> String {
    let sections: Vec<&str> = changelog.split("\n## ").skip(1).collect();
    let pick = sections.iter().find(|s| s.starts_with(version)).or(sections.first());
    match pick {
        Some(s) => s.split_once('\n').map(|(_, body)| body.trim().to_string()).unwrap_or_default(),
        None => String::new(),
    }
}

/// Reads an address: http(s) through curl.exe, else a file (a shared folder works too).
pub fn fetch_text(url: &str) -> Result<String, String> {
    if is_web(url) {
        let (code, out) = sys::run("curl.exe", &["-fsSL", "--max-time", "20", url])?;
        if code != 0 {
            return Err(format!("读不到 {url}（curl {code}）：{}", out.trim()));
        }
        Ok(out)
    } else {
        std::fs::read_to_string(url).map_err(|e| format!("读不到 {url}：{e}"))
    }
}

/// Puts the file at `url` at `to`.
pub fn download(url: &str, to: &Path) -> Result<(), String> {
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if is_web(url) {
        let target = to.to_string_lossy().to_string();
        let (code, out) = sys::run("curl.exe", &["-fL", "--max-time", "600", "-o", &target, url])?;
        if code != 0 {
            return Err(format!("下载失败（curl {code}）：{}", out.lines().last().unwrap_or("").trim()));
        }
    } else {
        std::fs::copy(url, to).map_err(|e| format!("复制 {url} 失败：{e}"))?;
    }
    Ok(())
}

fn is_web(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Where a downloaded installer goes.
pub fn download_path(version: &str) -> PathBuf {
    std::env::temp_dir().join("WavePlug").join(format!("WavePlug_Setup_{version}.exe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_json() {
        let l = parse_latest(r#"{"version":"1.2.1","url":"WavePlug_Setup_1.2.1.exe","notes":"修了画板"}"#, "https://example.com/wp/latest.json").unwrap();
        assert_eq!(l.url, "https://example.com/wp/WavePlug_Setup_1.2.1.exe");
        assert_eq!(l.notes, "修了画板");
        let shared = parse_latest(r#"{"version":"1.3.0","url":"WavePlug_Setup.exe"}"#, "\\\\nas\\share\\latest.json").unwrap();
        assert_eq!(shared.url, "\\\\nas\\share\\WavePlug_Setup.exe");
        let abs = parse_latest(r#"{"version":"1","url":"D:\\x.exe"}"#, "https://a/b.json").unwrap();
        assert_eq!(abs.url, "D:\\x.exe");
        assert!(parse_latest(r#"{"version":"","url":"x"}"#, "").is_err());
        assert!(parse_latest("<html>", "").is_err());
    }

    #[test]
    fn github_sources() {
        assert_eq!(github_repo("wave/waveplug").as_deref(), Some("wave/waveplug"));
        assert_eq!(github_repo(" https://github.com/wave/waveplug.git/ ").as_deref(), Some("wave/waveplug"));
        assert_eq!(github_repo("github.com/wave/waveplug/releases").as_deref(), Some("wave/waveplug"));
        assert_eq!(github_repo("https://example.com/wp/latest.json"), None);
        assert_eq!(github_repo("D:/share/latest.json"), None);
        assert_eq!(github_repo("\\\\nas\\share\\latest.json"), None);
        assert_eq!(github_repo(""), None);
    }

    #[test]
    fn github_release() {
        let text = r#"{"tag_name":"v1.3.1","body":"修了安装","assets":[{"name":"notes.txt","browser_download_url":"x"},{"name":"WavePlug_Setup_1.3.1.exe","browser_download_url":"https://github.com/a/b/releases/download/v1.3.1/WavePlug_Setup_1.3.1.exe"}]}"#;
        let l = parse_github_release(text).unwrap();
        assert_eq!((l.version.as_str(), l.notes.as_str()), ("1.3.1", "修了安装"));
        assert!(l.url.ends_with("WavePlug_Setup_1.3.1.exe"));
        assert!(parse_github_release(r#"{"tag_name":"v2","assets":[]}"#).is_err());
    }

    #[test]
    fn notes_from_changelog() {
        let c = "# 更新记录\n\n## 1.3.0（未发布）\n**一个插件**\n- a\n\n## 1.2.0 测试版 1\n- b\n";
        assert_eq!(changelog_notes(c, "1.2.0"), "- b");
        assert_eq!(changelog_notes(c, "9.9"), "**一个插件**\n- a");
        assert_eq!(changelog_notes("nothing", "1"), "");
    }
}
