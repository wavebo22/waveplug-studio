// The source folder's GitHub connection, for the main window's 开发者 section: whether this
// computer can reach the (private) repository, how many changes wait there, signing in once
// through the browser (Git Credential Manager keeps the login in Windows' credential store) and
// taking the changes (git pull --ff-only). Every change made on the Mac is pushed there.

use std::path::Path;

use crate::setup::sys;

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Git {
    /// not looked at yet
    #[default]
    Unknown,
    /// the folder isn't a clone of a GitHub repository (or git isn't installed)
    NoRepo(String),
    /// the repository is there but this computer has no login for it
    SignedOut,
    /// reachable: changes waiting on GitHub and the newest one's title
    Online { behind: u32, latest: String },
    /// something else went wrong (no network, …)
    Error(String),
}

/// never ask on a console nobody sees: fail instead, so the window can offer 登录 GitHub
const QUIET: [(&str, &str); 2] = [("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "never")];

fn git(dir: &Path, args: &[&str]) -> Result<(i32, String), String> {
    sys::run_in("git", args, dir, &QUIET)
}

/// What a failed fetch says: no login, or something else.
pub fn classify_fetch_error(text: &str) -> Git {
    let t = text.to_lowercase();
    let auth = ["authentication", "could not read username", "terminal prompts disabled", "403", "401", "repository not found", "logon failed"];
    if auth.iter().any(|k| t.contains(k)) {
        Git::SignedOut
    } else {
        Git::Error(text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string())
    }
}

/// Asks GitHub (git fetch, quietly) and compares with what this folder has.
pub fn check(dir: &Path) -> Git {
    if !dir.join(".git").exists() {
        return Git::NoRepo("源码文件夹不是从 GitHub 克隆的".into());
    }
    match git(dir, &["remote", "get-url", "origin"]) {
        Ok((0, _)) => {}
        Ok(_) => return Git::NoRepo("源码文件夹没有设置 GitHub 地址（origin）".into()),
        Err(e) => return Git::NoRepo(format!("{e}：安装 Git for Windows（https://git-scm.com）")),
    }
    match git(dir, &["fetch", "--quiet", "origin"]) {
        Ok((0, _)) => {}
        Ok((_, text)) => return classify_fetch_error(&text),
        Err(e) => return Git::Error(e),
    }
    let behind = git(dir, &["rev-list", "--count", "HEAD..@{u}"]).ok().and_then(|(c, t)| (c == 0).then(|| t.trim().parse().unwrap_or(0))).unwrap_or(0);
    let latest = git(dir, &["log", "-1", "--format=%s", "@{u}"]).map(|(_, t)| t.trim().to_string()).unwrap_or_default();
    Git::Online { behind, latest }
}

/// Opens the browser to sign in to GitHub (once per computer).
pub fn login(dir: &Path, log: &dyn Fn(String)) -> Result<String, String> {
    log("浏览器会打开 GitHub：登录后点 Authorize（只需要一次）…".into());
    let code = sys::run_stream("git", &["credential-manager", "github", "login", "--browser"], dir, log)?;
    match check(dir) {
        Git::Online { .. } => Ok("已登录 GitHub".into()),
        Git::SignedOut => Err(format!("还是没登录上（退出码 {code}）：在浏览器里点了 Authorize 吗？可以再点一次「登录 GitHub」")),
        other => Err(format!("登录后检查：{other:?}")),
    }
}

/// Takes the changes waiting on GitHub (fast-forward only: changes made on this computer are
/// never overwritten).
pub fn pull(dir: &Path, log: &dyn Fn(String)) -> Result<String, String> {
    let before = git(dir, &["rev-parse", "--short", "HEAD"]).map(|(_, t)| t.trim().to_string()).unwrap_or_default();
    let (code, text) = git(dir, &["pull", "--ff-only"])?;
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        log(l.to_string());
    }
    if code != 0 {
        return Err(match classify_fetch_error(&text) {
            Git::SignedOut => "没登录 GitHub：先点「登录 GitHub」".into(),
            _ => "没取到最新代码（上面是 Git 的说明）：本机改过的文件挡住了更新时，把上面的内容发给 Claude".into(),
        });
    }
    let after = git(dir, &["rev-parse", "--short", "HEAD"]).map(|(_, t)| t.trim().to_string()).unwrap_or_default();
    Ok(if before == after { "代码已经是最新".into() } else { format!("代码已更新 {before} → {after}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_errors() {
        assert_eq!(classify_fetch_error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), Git::SignedOut);
        assert_eq!(classify_fetch_error("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"), Git::SignedOut);
        assert_eq!(classify_fetch_error("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com\n"), Git::Error("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com".into()));
    }
}
