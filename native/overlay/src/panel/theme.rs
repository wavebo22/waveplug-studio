// The plugin's design tokens (plugin/styles.css :root, docs/UI_DESIGN_SYSTEM.md) for egui.
// Translucent tokens are pre-mixed over --c-bg #323232, since egui fills are opaque here.

use std::sync::Arc;

use eframe::egui::{self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Stroke, Vec2};

pub const BG: Color32 = Color32::from_rgb(0x32, 0x32, 0x32); // --c-bg
pub const SURFACE: Color32 = Color32::from_rgb(0x2a, 0x2a, 0x2a); // --c-surface (rgba 0,0,0,.16)
pub const FIELD: Color32 = Color32::from_rgb(0x23, 0x23, 0x23); // --c-field (rgba 0,0,0,.30)
pub const LINE: Color32 = Color32::from_rgb(0x53, 0x53, 0x53); // --c-line (rgba 255,255,255,.16)
pub const LINE_SOFT: Color32 = Color32::from_rgb(0x40, 0x40, 0x40); // --c-line-soft (.07)
pub const HOVER: Color32 = Color32::from_rgb(0x42, 0x42, 0x42); // --c-hover (.08)
pub const TEXT: Color32 = Color32::from_rgb(0xec, 0xec, 0xec); // --c-text
pub const TEXT_2: Color32 = Color32::from_rgb(0xb9, 0xbd, 0xc1); // --c-text-2
pub const TEXT_3: Color32 = Color32::from_rgb(0x8f, 0x94, 0x99); // --c-text-3
pub const ACCENT: Color32 = Color32::from_rgb(0x3f, 0xb5, 0x9f); // --c-accent
pub const ACCENT_HI: Color32 = Color32::from_rgb(0x5f, 0xcb, 0xb6); // --c-accent-hi
pub const ACCENT_INK: Color32 = Color32::from_rgb(0x07, 0x24, 0x20); // --c-accent-ink
pub const ACCENT_WASH: Color32 = Color32::from_rgb(0x34, 0x4a, 0x46); // .generate.is-disabled (accent .22 over bg)
pub const DISABLED_INK: Color32 = Color32::from_rgb(0x8f, 0x9c, 0x99); // its text (white .45)
pub const RUN_BG: Color32 = Color32::from_rgb(0x5b, 0x3f, 0x39); // .generate.running
pub const RUN_INK: Color32 = Color32::from_rgb(0xff, 0xd6, 0xcc);
pub const WARN: Color32 = Color32::from_rgb(0xe3, 0xb0, 0x4b); // --c-warn (the completion notice)
pub const OK: Color32 = Color32::from_rgb(0x5f, 0xc5, 0x8f); // --c-ok
pub const ERR: Color32 = Color32::from_rgb(0xec, 0x7a, 0x69); // --c-err

pub const FS_S: f32 = 11.0; // --fs-s
pub const FS: f32 = 12.0; // --fs
pub const FS_L: f32 = 13.0; // --fs-l
pub const H_M: f32 = 26.0; // --h-m
pub const R: u8 = 4; // --r
pub const R_CARD: u8 = 6; // .card / .seg

/// The family drawn bold (Microsoft YaHei Bold when available).
pub fn bold() -> FontFamily {
    FontFamily::Name("bold".into())
}

pub fn font(size: f32) -> FontId {
    FontId::new(size, FontFamily::Proportional)
}

pub fn font_bold(size: f32) -> FontId {
    FontId::new(size, bold())
}

/// Chinese UI fonts from the system (nothing bundled): Microsoft YaHei UI on Windows, PingFang on a Mac.
/// Returns the path too, so a file that serves both weights is read once.
fn system_font(bold: bool) -> Option<(&'static str, &'static [u8])> {
    let candidates: &[&'static str] = if bold {
        &["C:\\Windows\\Fonts\\msyhbd.ttc", "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"]
    } else {
        &["C:\\Windows\\Fonts\\msyh.ttc", "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Light.ttc"]
    };
    // memory-mapped (only the pages of glyphs actually drawn are loaded) and leaked on purpose:
    // fonts live as long as the program, and borrowed font data isn't copied again inside egui
    candidates.iter().find_map(|p| {
        let file = std::fs::File::open(p).ok()?;
        let map = unsafe { memmap2::Mmap::map(&file) }.ok()?;
        Some((*p, &**Box::leak(Box::new(map))))
    })
}

pub fn install(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let mut bold_family = Vec::new();
    let regular = system_font(false);
    if let Some((_, bytes)) = regular {
        fonts.font_data.insert("cjk".into(), Arc::new(FontData::from_static(bytes)));
        fonts.families.entry(FontFamily::Proportional).or_default().insert(0, "cjk".into());
        fonts.families.entry(FontFamily::Monospace).or_default().push("cjk".into());
    }
    // a Mac's PingFang holds both weights: reuse it rather than reading 78 MB again
    let bold_font = match regular {
        Some((path, _)) if path.ends_with("PingFang.ttc") => None,
        _ => system_font(true),
    };
    if let Some((_, bytes)) = bold_font {
        fonts.font_data.insert("cjk-bold".into(), Arc::new(FontData::from_static(bytes)));
        bold_family.push("cjk-bold".to_string());
    }
    bold_family.extend(fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default());
    fonts.families.insert(bold(), bold_family);
    ctx.set_fonts(fonts);

    // always dark, whatever the system theme (egui keeps one style per theme)
    ctx.set_theme(egui::Theme::Dark);
    let mut v = egui::Visuals::dark();
    v.panel_fill = BG;
    v.window_fill = BG;
    v.extreme_bg_color = FIELD; // text boxes
    v.faint_bg_color = SURFACE;
    v.override_text_color = Some(TEXT);
    v.hyperlink_color = ACCENT_HI;
    v.selection.bg_fill = Color32::from_rgb(0x2f, 0x5f, 0x56);
    v.selection.stroke = Stroke::new(1.0_f32, TEXT);
    v.text_cursor.stroke = Stroke::new(1.5_f32, TEXT);
    let r = CornerRadius::same(R);
    for (w, fill, stroke) in [
        (&mut v.widgets.noninteractive, BG, LINE_SOFT),
        (&mut v.widgets.inactive, FIELD, LINE),
        (&mut v.widgets.hovered, HOVER, ACCENT),
        (&mut v.widgets.active, HOVER, ACCENT_HI),
        (&mut v.widgets.open, HOVER, ACCENT),
    ] {
        w.bg_fill = fill;
        w.weak_bg_fill = fill;
        w.bg_stroke = Stroke::new(1.0_f32, stroke);
        w.corner_radius = r;
        w.fg_stroke = Stroke::new(1.0_f32, TEXT);
        w.expansion = 0.0;
    }
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT_2);
    v.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT_2);
    ctx.set_visuals(v);

    ctx.style_mut(|s| {
        s.spacing.item_spacing = Vec2::new(6.0, 6.0);
        s.spacing.button_padding = Vec2::new(8.0, 4.0);
        s.spacing.interact_size = Vec2::new(26.0, H_M);
        s.spacing.scroll.bar_width = 6.0;
        s.text_styles.insert(egui::TextStyle::Body, font(FS));
        s.text_styles.insert(egui::TextStyle::Button, font(FS));
        s.text_styles.insert(egui::TextStyle::Small, font(FS_S));
        s.text_styles.insert(egui::TextStyle::Heading, font_bold(FS_L));
        s.text_styles.insert(egui::TextStyle::Monospace, FontId::new(FS, FontFamily::Monospace));
    });
}
