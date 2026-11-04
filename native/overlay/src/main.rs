// WavePlug overlay: a small native window that pops up next to the pointer after a selection is
// made in Photoshop — prompt box, count and 生成 — outside the UXP panel's bounds (UXP can't draw
// there). The panel decides when to show / hide it and runs the generation itself; this program
// only collects the prompt. See native/overlay/README.md.
//
// Behaviour:
// - shown without taking focus, so Photoshop keeps the keyboard until the prompt box is clicked;
// - Enter or 生成 sends the prompt to the panel, hides the bar and gives the focus back to Photoshop;
// - Esc or × hides it; it also hides when another program comes to the front or the panel disconnects;
// - drag the bar by its empty edges to move it.

#![cfg_attr(not(test), windows_subsystem = "windows")]

mod protocol;
mod server;

#[cfg(windows)]
mod window;

#[cfg(windows)]
fn main() {
    window::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("waveplug-overlay only runs on Windows");
}
