// WavePlug overlay: external surfaces (外附介面) — plugin UI shown outside the UXP panels, which
// UXP can't draw past. See native/overlay/README.md and HANDOFF.md.
//
// - Default: the host (host.rs) waits for the plugin on ws://127.0.0.1:47821 and shows the
//   surface it asks for — today the external generate panel (外置生成面板) — while Photoshop's
//   document has a selection.
// - `--demo`: the generate panel with made-up data and no plugin, for checking the UI.
//
// Layers: protocol.rs / server.rs / host.rs / win.rs are shared by every surface;
// panel/<surface>/ holds one surface (panel/mod.rs: the `Surface` trait it implements).

#![cfg_attr(not(test), windows_subsystem = "windows")]

mod anim;
mod app;
mod host;
mod comfy;
mod devgit;
mod drag;
mod drag_target;
mod frame;
mod hang;
mod hotkey;
mod keys;
mod layout;
mod life;
mod menu;
mod monitor;
mod log;
mod panel;
mod paths;
mod protocol;
mod setup;
mod server;
mod shot;
mod tray;
mod webdrop;
#[cfg(windows)]
mod win;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--download-update") {
        std::process::exit(download_cli(&args));
    }
    if let Some(i) = args.iter().position(|a| a == "--install-ps" || a == "--remove-ps") {
        std::process::exit(plugin_cli(&args, i));
    }
    if std::env::args().any(|a| a == "--demo") {
        panel::generate::demo::run();
        return;
    }
    host::run();
}

/// `--download-update [--nodes-only]`: downloads the newest installer from the default source the
/// way 下载并安装 does (`--nodes-only` skips GitHub to test the download nodes), checks it, keeps it
/// in the cache and installs nothing. Log in <data>\logs\setup.log; exit code 0 when it worked.
fn download_cli(args: &[String]) -> i32 {
    use setup::{install, update};
    let file = paths::logs_dir().join("setup.log");
    let _ = std::fs::create_dir_all(paths::logs_dir());
    let log = |t: String| {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(f, "{t}");
        }
    };
    log("── 下载更新（命令行测试） ──".into());
    let cfg = install::Config::load();
    let source = if cfg.update_url.trim().is_empty() { update::DEFAULT_SOURCE.to_string() } else { cfg.update_url.clone() };
    let result = update::latest(&source).and_then(|l| {
        log(format!("最新版本 {}，SHA-256 {}", l.version, l.sha256.as_deref().unwrap_or("（没有公布）")));
        let to = paths::cache_dir("downloads").join(format!("WavePlug_Setup_{}.exe", l.version));
        let from = update::download_checked(&l, &to, &update::mirror_list(&cfg.mirrors), !args.iter().any(|a| a == "--nodes-only"), &log)?;
        Ok(format!("{}（来自{from}）", to.display()))
    });
    match result {
        Ok(m) => {
            log(format!("完成：{m}"));
            0
        }
        Err(e) => {
            log(format!("失败：{e}"));
            1
        }
    }
}

/// `--install-ps [installer or WavePlug.pak]` / `--remove-ps`: the Photoshop plugin without the
/// window (scripts, testing; still one Windows administrator prompt unless already elevated).
/// What happened goes to <data>\logs\setup.log; exit code 0 when it worked.
fn plugin_cli(args: &[String], i: usize) -> i32 {
    use setup::{install, payload};
    let file = paths::logs_dir().join("setup.log");
    let _ = std::fs::create_dir_all(paths::logs_dir());
    let log = |t: String| {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(f, "{t}");
        }
    };
    let cfg = install::Config::load();
    let result = if args[i] == "--remove-ps" {
        log("── 卸载 Photoshop 插件（命令行） ──".into());
        install::remove_plugin(&cfg, &log)
    } else {
        log("── 安装 Photoshop 插件（命令行） ──".into());
        let pak = args.get(i + 1).map(std::path::PathBuf::from).or_else(|| paths::install_dir().map(|d| d.join(paths::PACK)));
        match pak.ok_or_else(|| "没有安装包：给出安装程序或 WavePlug.pak 的路径".to_string()).and_then(|p| payload::read_exe(&p).and_then(|x| x.ok_or_else(|| format!("{} 不是 WavePlug 安装包", p.display())))) {
            Ok(p) => {
                let version = p.info().map(|i| i.version).unwrap_or_default();
                install::install_plugin(&p, &version, &cfg, &log)
            }
            Err(e) => Err(e),
        }
    };
    match result {
        Ok(m) => {
            log(format!("完成：{m}"));
            0
        }
        Err(e) => {
            log(format!("失败：{e}"));
            1
        }
    }
}

