// Saves one picture of the window and quits — for checking a layout without a screen recorder
// (the demo: WAVEPLUG_DEMO_SHOT=<file.bmp>; the host: WAVEPLUG_HOST_SHOT=<file.bmp>).

use eframe::egui::{self, ViewportCommand};

pub struct Shot {
    path: String,
    frames: u32,
    asked: bool,
}

impl Shot {
    pub fn from_env(var: &str) -> Option<Shot> {
        std::env::var(var).ok().map(|path| Shot { path, frames: 0, asked: false })
    }

    /// Call every frame; asks for the picture once `after` frames have been drawn.
    pub fn frame(&mut self, ctx: &egui::Context, after: u32) {
        self.frames += 1;
        if self.frames >= after && !self.asked {
            self.asked = true;
            ctx.send_viewport_cmd(ViewportCommand::Screenshot(Default::default()));
        }
        let image = ctx.input(|i| i.raw.events.iter().find_map(|e| match e {
            egui::Event::Screenshot { image, .. } => Some(image.clone()),
            _ => None,
        }));
        if let Some(img) = image {
            let _ = std::fs::write(&self.path, bmp(img.width(), img.height(), img.as_raw()));
            ctx.send_viewport_cmd(ViewportCommand::Close);
        }
        ctx.request_repaint();
    }
}

/// 24-bit BMP from RGBA rows (no image crate needed)
fn bmp(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    let row = (w * 3 + 3) & !3;
    let size = 54 + row * h;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"BM");
    for v in [size as u32, 0, 54, 40, w as u32, h as u32] { out.extend_from_slice(&v.to_le_bytes()); }
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    for v in [0u32, (row * h) as u32, 2835, 2835, 0, 0] { out.extend_from_slice(&v.to_le_bytes()); }
    for y in (0..h).rev() {
        let start = out.len();
        for x in 0..w {
            let i = (y * w + x) * 4;
            out.extend_from_slice(&[rgba[i + 2], rgba[i + 1], rgba[i]]);
        }
        out.resize(start + row, 0);
    }
    out
}
