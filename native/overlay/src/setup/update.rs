// 检查更新: the update source is a GitHub repository (its newest release, with the installer
// WavePlug_Setup_<version>.exe attached) or a latest.json address. A latest.json says the newest version and where its installer
// is; the installer is downloaded (Windows' own curl.exe: https without bundling TLS; PowerShell's
// web client when curl can't get through) and started.
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
    /// the installer's SHA-256 (lowercase hex) as GitHub publishes it: a copy fetched through a
    /// download node must match it. None: no node is used (nothing to check a copy against).
    #[serde(default)]
    pub sha256: Option<String>,
}

/// Download nodes (GitHub proxies): used only when GitHub itself can't be reached, and only for a
/// file whose SHA-256 GitHub published, so a node can't slip in anything else.
/// `https://<node>/https://github.com/…`. The user can set their own list. First the two that
/// mirrors.git-zh.com uses for release downloads (both worked from mainpc while GitHub reset the
/// connection); then volunteers' nodes from github.akams.cn.
pub const DEFAULT_MIRRORS: &[&str] = &[
    "gh-proxy.com",
    "ghfast.top",
    "gh.dpik.top",
    "cdn.gh-proxy.com",
    "ghproxy.net",
    "github.tbap.top",
    "ghfile.geekertao.top",
    "ghpr.cc",
    "gh.ddlc.top",
    "gitproxy.click",
    "gh.monlor.com",
    "fastgit.cc",
];

/// The node list: the user's (one per line, or separated by spaces / commas / semicolons; # starts a
/// comment), else DEFAULT_MIRRORS.
pub fn mirror_list(user: &str) -> Vec<String> {
    let own: Vec<String> = user
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .flat_map(|l| l.split([' ', ',', ';', '\t']))
        .map(|n| n.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string())
        .filter(|n| !n.is_empty())
        .collect();
    if own.is_empty() { DEFAULT_MIRRORS.iter().map(|s| s.to_string()).collect() } else { own }
}

/// `url` fetched through `node`; None for an address a GitHub proxy doesn't serve.
pub fn mirror_url(node: &str, url: &str) -> Option<String> {
    let github = ["https://github.com/", "https://objects.githubusercontent.com/", "https://raw.githubusercontent.com/"];
    github.iter().any(|g| url.starts_with(g)).then(|| format!("https://{}/{url}", node.trim_end_matches('/')))
}

/// "sha256:ABC…" (GitHub's digest field) → "abc…"; None for anything else.
pub fn parse_digest(d: &str) -> Option<String> {
    let hex = d.trim().strip_prefix("sha256:")?.to_lowercase();
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then_some(hex)
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
    let asset = v
        .get("assets")
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .find(|a| a.get("name").and_then(|n| n.as_str()).is_some_and(|n| n.starts_with("WavePlug_Setup") && n.to_lowercase().ends_with(".exe")))
        .ok_or_else(|| format!("GitHub 上的 {tag} 没有附带 WavePlug_Setup_*.exe"))?;
    let url = asset.get("browser_download_url").and_then(|u| u.as_str()).ok_or("GitHub 的回答里没有下载地址")?.to_string();
    let sha256 = asset.get("digest").and_then(|d| d.as_str()).and_then(parse_digest);
    Ok(Latest { version, url, notes, sha256 })
}

/// The newest version at the update source: a GitHub repository's latest release, or latest.json.
pub fn latest(source: &str) -> Result<Latest, String> {
    let source = source.trim();
    match github_repo(source) {
        Some(repo) => {
            let api = format!("https://api.github.com/repos/{repo}/releases/latest");
            let (status, body) = http_text(&api, &["Accept: application/vnd.github+json", "User-Agent: WavePlug-updater"])?;
            match status {
                200 => parse_github_release(&body),
                404 => Err(format!("{repo} 还没有发布版本（或仓库不公开、名字不对）")),
                403 | 429 => Err("GitHub 暂时限制了查询次数，过一会儿再试".into()),
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

/// Options for every curl call. `--ssl-revoke-best-effort`: Windows' TLS checks whether the
/// certificate was revoked and, by default, fails when the revocation server can't be reached
/// (curl 35, CRYPT_E_REVOCATION_OFFLINE, seen on mainpc); best effort still checks when the server
/// answers. Retries ride out a dropped connection.
const CURL_COMMON: [&str; 9] = ["--ssl-revoke-best-effort", "--retry", "3", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "15", "-sSL"];

fn curl(args: &[&str]) -> Result<(i32, String), String> {
    let all: Vec<&str> = CURL_COMMON.iter().copied().chain(args.iter().copied()).collect();
    sys::run("curl.exe", &all)
}

/// PowerShell's own web client (.NET: no revocation check, its own proxy settings): the fallback
/// when curl can't get through. `script` gets $u (the address) and $h (headers).
fn powershell_web(url: &str, headers: &[&str], script: &str) -> Result<(i32, String), String> {
    let hs: Vec<String> = headers
        .iter()
        .filter_map(|h| h.split_once(':'))
        .map(|(k, v)| format!("'{}'='{}'", k.trim().replace('\'', "''"), v.trim().replace('\'', "''")))
        .collect();
    let cmd = format!(
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $u='{}'; $h=@{{{}}}; {script}",
        url.replace('\'', "''"),
        hs.join(";")
    );
    sys::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &cmd])
}

/// GET `url`: the HTTP status and the body (curl, then PowerShell when curl can't connect).
fn http_text(url: &str, headers: &[&str]) -> Result<(u16, String), String> {
    let mut args = vec!["--max-time", "30", "-w", "\n%{http_code}"];
    for h in headers {
        args.push("-H");
        args.push(h);
    }
    args.push(url);
    let (code, out) = curl(&args)?;
    if code == 0 {
        if let Some((body, status)) = out.trim_end().rsplit_once('\n') {
            if let Ok(s) = status.trim().parse() {
                return Ok((s, body.to_string()));
            }
        }
    }
    let curl_err = out.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
    let script = "try { $r = Invoke-WebRequest -Uri $u -Headers $h -UseBasicParsing -TimeoutSec 30; \"$($r.StatusCode)`n$($r.Content)\" } catch { $s = $_.Exception.Response.StatusCode.value__; if ($s) { \"$s`n\" } else { Write-Error $_.Exception.Message; exit 1 } }";
    let (pc, pout) = powershell_web(url, headers, script)?;
    if pc == 0 {
        let t = pout.trim_start_matches('\u{feff}');
        if let Some((status, body)) = t.split_once('\n') {
            if let Ok(s) = status.trim().parse() {
                return Ok((s, body.to_string()));
            }
        }
    }
    Err(format!("连不上 {}（curl {code}：{curl_err}；PowerShell：{}）", host_of(url), pout.trim().lines().last().unwrap_or("").trim()))
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

/// Reads an address: http(s) through curl.exe (PowerShell as the fallback), else a file (a shared
/// folder works too).
pub fn fetch_text(url: &str) -> Result<String, String> {
    if is_web(url) {
        match http_text(url, &[])? {
            (200, body) => Ok(body),
            (s, _) => Err(format!("读不到 {url}（HTTP {s}）")),
        }
    } else {
        std::fs::read_to_string(url).map_err(|e| format!("读不到 {url}：{e}"))
    }
}

/// The file's SHA-256, lowercase hex (Windows' own Get-FileHash; shasum elsewhere).
pub fn file_sha256(p: &Path) -> Result<String, String> {
    let path = p.to_string_lossy().to_string();
    let (code, out) = if cfg!(windows) {
        sys::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &format!("(Get-FileHash -Algorithm SHA256 -LiteralPath '{}').Hash", path.replace('\'', "''"))])?
    } else {
        sys::run("shasum", &["-a", "256", &path])?
    };
    let hex = out.split_whitespace().next().unwrap_or("").to_lowercase();
    if code != 0 || hex.len() != 64 {
        return Err(format!("算不出 {} 的校验值：{}", p.display(), out.trim()));
    }
    Ok(hex)
}

/// The installer of `l` at `to`: from GitHub, else through the download nodes, a node's copy kept
/// only when its SHA-256 is the one GitHub published. Returns where it came from. `direct`: try
/// GitHub first (false only for testing the nodes).
pub fn download_checked(l: &Latest, to: &Path, nodes: &[String], direct: bool, log: &dyn Fn(String)) -> Result<String, String> {
    let ok = |p: &Path| -> Result<bool, String> {
        match &l.sha256 {
            Some(want) => Ok(&file_sha256(p)? == want),
            None => Ok(true),
        }
    };
    let direct = if !direct {
        "跳过了 GitHub（测试下载节点）".to_string()
    } else {
        log(format!("下载 {} …", l.url));
        match download(&l.url, to) {
            Ok(()) if ok(to)? => return Ok("GitHub".into()),
            Ok(()) => "下载的文件和 GitHub 公布的校验值不一致".to_string(),
            Err(e) => e,
        }
    };
    let _ = std::fs::remove_file(to);
    let Some(want) = &l.sha256 else {
        return Err(direct);
    };
    log(format!("直接下载不成功（{direct}），改用下载节点（每个文件都核对 GitHub 公布的 SHA-256：{}…）", &want[..12]));
    for node in nodes {
        let Some(url) = mirror_url(node, &l.url) else { break };
        let (code, out) = curl(&["-f", "--max-time", "600", "-o", &to.to_string_lossy(), &url])?;
        if code != 0 {
            log(format!("  {node}：连不上（curl {code}）{}", out.lines().last().map(|s| format!(" {}", s.trim())).unwrap_or_default()));
            continue;
        }
        if ok(to)? {
            log(format!("  {node}：下载完成，校验值和 GitHub 一致"));
            return Ok(format!("下载节点 {node}"));
        }
        log(format!("  {node}：文件和 GitHub 公布的不一致，已丢弃"));
        let _ = std::fs::remove_file(to);
    }
    Err(format!("GitHub 和 {} 个下载节点都没能下载（{direct}）。可以在「下载节点」里换一批再试", nodes.len()))
}

/// Puts the file at `url` at `to`.
pub fn download(url: &str, to: &Path) -> Result<(), String> {
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if is_web(url) {
        let target = to.to_string_lossy().to_string();
        let (code, out) = curl(&["-f", "--max-time", "900", "-o", &target, url])?;
        if code != 0 {
            let curl_err = out.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
            let _ = std::fs::remove_file(to);
            let script = format!("Invoke-WebRequest -Uri $u -OutFile '{}' -UseBasicParsing -TimeoutSec 900", target.replace('\'', "''"));
            let (pc, pout) = powershell_web(url, &[], &script)?;
            if pc != 0 || !to.is_file() {
                return Err(format!("下载失败（curl {code}：{curl_err}；PowerShell：{}）", pout.trim().lines().last().unwrap_or("").trim()));
            }
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
    fn download_nodes() {
        assert_eq!(mirror_list("").len(), DEFAULT_MIRRORS.len());
        assert_eq!(mirror_list(" https://a.example/ \nb.example, c.example # mine\n# off.example"), vec!["a.example", "b.example", "c.example"]);
        let u = "https://github.com/a/b/releases/download/v1/WavePlug_Setup_1.exe";
        assert_eq!(mirror_url("gh.dpik.top/", u).as_deref(), Some("https://gh.dpik.top/https://github.com/a/b/releases/download/v1/WavePlug_Setup_1.exe"));
        assert_eq!(mirror_url("gh.dpik.top", "https://example.com/x.exe"), None);
        assert_eq!(parse_digest("sha256:2E8F442241AB10FB2E62DBDD25B5B4BBA02ED5B41EED928A2EAD722C9FDB9CA6").as_deref(), Some("2e8f442241ab10fb2e62dbdd25b5b4bba02ed5b41eed928a2ead722c9fdb9ca6"));
        assert_eq!(parse_digest("md5:abc"), None);
        assert_eq!(parse_digest("sha256:xyz"), None);
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
        assert_eq!(l.sha256, None);
        let with = r#"{"tag_name":"v1.3.1","assets":[{"name":"WavePlug_Setup_1.3.1.exe","browser_download_url":"https://github.com/x","digest":"sha256:2e8f442241ab10fb2e62dbdd25b5b4bba02ed5b41eed928a2ead722c9fdb9ca6"}]}"#;
        assert_eq!(parse_github_release(with).unwrap().sha256.as_deref(), Some("2e8f442241ab10fb2e62dbdd25b5b4bba02ed5b41eed928a2ead722c9fdb9ca6"));
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
