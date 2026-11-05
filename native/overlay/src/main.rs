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

mod host;
mod comfy;
mod frame;
mod life;
mod log;
mod panel;
mod protocol;
mod server;
mod shot;
#[cfg(windows)]
mod win;

fn main() {
    if std::env::args().any(|a| a == "--demo") {
        panel::generate::demo::run();
        return;
    }
    host::run();
}
