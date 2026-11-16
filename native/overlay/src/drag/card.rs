//! The drag card's pixels: layout and shapes rasterised here (premultiplied BGRA, testable
//! anywhere); the two lines of text are drawn on top by GDI in drag/win.rs, which only needs
//! the rectangles from `Layout` / `badge`. Drawn once per change of what the card says, never
//! per mouse move: moving it is just moving its window.
//!
//! The look is the earlier egui card's: one rounded surface with a single border, a short
//! accent rail, a 40×40 contain-fitted thumbnail, the title, and an action pill; several layers
//! show static offset sheets behind it.

use image::RgbaImage;

use crate::panel::theme;

/// The card's size in logical pixels (scaled by the monitor's DPI under the cursor).
pub const WIDTH: f32 = 232.0;
pub const HEIGHT: f32 = 68.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb(pub u8, pub u8, pub u8);

fn rgb(c: eframe::egui::Color32) -> Rgb {
    Rgb(c.r(), c.g(), c.b())
}

/// accent (rail, dot, action text) and the pill's fill for a tone
pub fn tone_colors(tone: &str) -> (Rgb, Rgb) {
    match tone {
        "delete" => (rgb(theme::ERR), Rgb(0x4a, 0x2e, 0x2d)),
        "copy" => (rgb(theme::WARN), Rgb(0x49, 0x3d, 0x29)),
        "workbench" => (Rgb(0x6c, 0xa9, 0xe8), Rgb(0x2b, 0x3e, 0x50)),
        "invalid" => (rgb(theme::TEXT_2), Rgb(0x3b, 0x3d, 0x40)),
        _ => (rgb(theme::ACCENT_HI), Rgb(0x2c, 0x47, 0x42)),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn text_color() -> Rgb {
    rgb(theme::TEXT)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn placeholder_color() -> Rgb {
    rgb(theme::TEXT_2)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RectF {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl RectF {
    pub fn shrink(self, d: f32) -> RectF {
        RectF { x: self.x + d, y: self.y + d, w: (self.w - 2.0 * d).max(0.0), h: (self.h - 2.0 * d).max(0.0) }
    }
    pub fn right(self) -> f32 {
        self.x + self.w
    }
    pub fn bottom(self) -> f32 {
        self.y + self.h
    }
}

/// Everything positioned, in physical pixels of the card's own bitmap.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub scale: f32,
    pub w: usize,
    pub h: usize,
    pub card: RectF,
    pub backs: Vec<RectF>,
    pub rail: RectF,
    pub thumb: RectF,
    /// the title's line
    pub title: RectF,
    /// the widest the action pill may get
    pub text_width: f32,
    pub title_px: f32,
    pub action_px: f32,
    pub placeholder_px: f32,
}

/// The size of the bitmap at `scale` (1.0 = 96 dpi).
pub fn size(scale: f32) -> (usize, usize) {
    ((WIDTH * scale).round().max(1.0) as usize, (HEIGHT * scale).round().max(1.0) as usize)
}

pub fn layout(scale: f32, layers: usize) -> Layout {
    let s = scale.max(0.5);
    let (w, h) = size(s);
    let card = RectF { x: 4.0 * s, y: 4.0 * s, w: w as f32 - 8.0 * s, h: h as f32 - 8.0 * s };
    let backs = (1..layers.min(5)).rev()
        .map(|i| RectF { x: card.x + i as f32 * 1.3 * s, y: card.y + i as f32 * 1.0 * s, ..card })
        .collect();
    let rail = RectF { x: card.x + 1.0 * s, y: card.y + 11.0 * s, w: 2.0 * s, h: (card.h - 22.0 * s).max(8.0 * s) };
    let thumb = RectF { x: card.x + 11.0 * s, y: card.y + card.h / 2.0 - 20.0 * s, w: 40.0 * s, h: 40.0 * s };
    let text_left = thumb.right() + 10.0 * s;
    let text_width = (card.right() - text_left - 11.0 * s).max(24.0 * s);
    Layout {
        scale: s,
        w,
        h,
        card,
        backs,
        rail,
        thumb,
        title: RectF { x: text_left, y: card.y + 9.0 * s, w: text_width, h: 18.0 * s },
        text_width,
        title_px: 13.0 * s,
        action_px: 10.5 * s,
        placeholder_px: theme::FS_S * s,
    }
}

/// The action pill for an action text `text_w` px wide: (pill, where its text goes).
pub fn badge(l: &Layout, text_w: f32) -> (RectF, RectF) {
    let s = l.scale;
    let w = (text_w + 23.0 * s).min(l.text_width);
    let pill = RectF { x: l.title.x, y: l.card.bottom() - 25.0 * s, w, h: 17.0 * s };
    let text = RectF { x: pill.x + 16.0 * s, y: pill.y, w: (pill.w - 22.0 * s).max(0.0), h: pill.h };
    (pill, text)
}

/// Premultiplied BGRA, top row first (what a top-down DIB section expects).
pub struct Canvas {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

impl Canvas {
    pub fn new(w: usize, h: usize) -> Self {
        Self { w, h, px: vec![0; w * h * 4] }
    }

    #[cfg(test)]
    pub fn alpha(&self, x: usize, y: usize) -> u8 {
        self.px[(y * self.w + x) * 4 + 3]
    }

    /// `color` at coverage `a` (0..1) over what is there.
    fn blend(&mut self, x: usize, y: usize, c: Rgb, a: f32) {
        if a <= 0.0 {
            return;
        }
        let i = (y * self.w + x) * 4;
        let keep = 1.0 - a.min(1.0);
        let src = [c.2, c.1, c.0]; // B G R
        for k in 0..3 {
            self.px[i + k] = (src[k] as f32 * a + self.px[i + k] as f32 * keep).round() as u8;
        }
        self.px[i + 3] = (255.0 * a + self.px[i + 3] as f32 * keep).round() as u8;
    }

    /// A rounded rectangle, antialiased by its signed distance at each pixel centre.
    pub fn round_rect(&mut self, r: RectF, radius: f32, c: Rgb) {
        self.round_rect_alpha(r, radius, c, 1.0);
    }

    /// `round_rect` at `alpha` (0..1) opacity.
    pub fn round_rect_alpha(&mut self, r: RectF, radius: f32, c: Rgb, alpha: f32) {
        if r.w <= 0.0 || r.h <= 0.0 || alpha <= 0.0 {
            return;
        }
        let radius = radius.min(r.w / 2.0).min(r.h / 2.0).max(0.0);
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        let (hx, hy) = (r.w / 2.0 - radius, r.h / 2.0 - radius);
        let x0 = r.x.floor().max(0.0) as usize;
        let y0 = r.y.floor().max(0.0) as usize;
        let x1 = (r.right().ceil() as usize).min(self.w);
        let y1 = (r.bottom().ceil() as usize).min(self.h);
        for y in y0..y1 {
            for x in x0..x1 {
                let qx = (x as f32 + 0.5 - cx).abs() - hx;
                let qy = (y as f32 + 0.5 - cy).abs() - hy;
                let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
                let d = outside + qx.max(qy).min(0.0) - radius;
                self.blend(x, y, c, (0.5 - d).clamp(0.0, 1.0) * alpha.min(1.0));
            }
        }
    }

    /// A filled rounded rectangle with a `width`-px border inside its edge.
    pub fn bordered(&mut self, r: RectF, radius: f32, width: f32, fill: Rgb, line: Rgb) {
        self.round_rect(r, radius, line);
        self.round_rect(r.shrink(width), (radius - width).max(0.0), fill);
    }

    /// `img` (straight alpha) scaled to fit inside `bounds`, centred.
    pub fn image_contain(&mut self, img: &RgbaImage, bounds: RectF) {
        let fit = contain(bounds, img.width() as f32, img.height() as f32);
        let (w, h) = (fit.w.round().max(1.0) as u32, fit.h.round().max(1.0) as u32);
        let scaled = image::imageops::resize(img, w, h, image::imageops::FilterType::Triangle);
        let (ox, oy) = (fit.x.round() as i64, fit.y.round() as i64);
        for (sx, sy, p) in scaled.enumerate_pixels() {
            let (x, y) = (ox + sx as i64, oy + sy as i64);
            if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
                continue;
            }
            self.blend(x as usize, y as usize, Rgb(p[0], p[1], p[2]), p[3] as f32 / 255.0);
        }
    }
}

/// The largest rectangle with the source's aspect ratio inside `bounds`, centred.
pub fn contain(bounds: RectF, sw: f32, sh: f32) -> RectF {
    if sw <= 0.0 || sh <= 0.0 {
        return bounds;
    }
    let k = (bounds.w / sw).min(bounds.h / sh);
    let (w, h) = (sw * k, sh * k);
    RectF { x: bounds.x + (bounds.w - w) / 2.0, y: bounds.y + (bounds.h - h) / 2.0, w, h }
}

/// The card's shapes for `tone`, with the pill `pill` and the first layer's thumbnail.
pub fn paint(l: &Layout, pill: RectF, tone: &str, thumb: Option<&RgbaImage>) -> Canvas {
    let s = l.scale;
    let mut c = Canvas::new(l.w, l.h);
    let line = rgb(theme::LINE);
    for back in &l.backs {
        c.bordered(*back, 7.0 * s, s, Rgb(0x25, 0x27, 0x29), line);
    }
    c.bordered(l.card, 7.0 * s, s, rgb(theme::SURFACE), line);
    let (accent, pill_fill) = tone_colors(tone);
    c.round_rect(l.rail, s, accent);
    c.bordered(l.thumb, 5.0 * s, s, rgb(theme::FIELD), rgb(theme::LINE_SOFT));
    if let Some(img) = thumb {
        c.image_contain(img, l.thumb.shrink(1.0 * s));
    }
    c.round_rect(pill, 8.0 * s, pill_fill);
    let dot = 2.4 * s;
    c.round_rect(RectF { x: pill.x + 8.0 * s - dot, y: pill.y + pill.h / 2.0 - dot, w: 2.0 * dot, h: 2.0 * dot }, dot, accent);
    c
}

/// A layer thumbnail from the plugin's data URL, decoded small (at most 96 px a side): the
/// source's size never decides the card's geometry or memory.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn decode_thumb(data_url: &str) -> Result<RgbaImage, String> {
    use crate::panel::generate::state::{MAX_REFERENCE_THUMB_BYTES, MAX_REFERENCE_THUMB_URL_LEN};
    const PREVIEW_EDGE: u32 = 96;
    const MAX_SOURCE_EDGE: u32 = 2048;
    if data_url.len() > MAX_REFERENCE_THUMB_URL_LEN {
        return Err(format!("拖拽缩略图 URL 过长：{} bytes", data_url.len()));
    }
    let (mime, encoded) = data_url.split_once(',').ok_or_else(|| "拖拽缩略图缺少 data URL 分隔符".to_string())?;
    if mime != "data:image/png;base64" && mime != "data:image/jpeg;base64" {
        return Err(format!("不支持的拖拽缩略图格式：{mime}"));
    }
    let bytes = data_encoding::BASE64.decode(encoded.as_bytes()).map_err(|e| format!("拖拽缩略图 Base64 解码失败：{e}"))?;
    if bytes.len() > MAX_REFERENCE_THUMB_BYTES {
        return Err(format!("拖拽缩略图数据过大：{} bytes", bytes.len()));
    }
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("拖拽缩略图解码失败：{e}"))?;
    let (w, h) = (decoded.width(), decoded.height());
    if w == 0 || h == 0 || w > MAX_SOURCE_EDGE || h > MAX_SOURCE_EDGE {
        return Err(format!("拖拽缩略图尺寸无效：{w}×{h}（上限 {MAX_SOURCE_EDGE}px）"));
    }
    Ok(decoded.thumbnail(PREVIEW_EDGE, PREVIEW_EDGE).to_rgba8())
}

/// Gap between the arrow's tip and the card, right and down (clears the arrow itself), at 1×.
const BESIDE: (f32, f32) = (18.0, 22.0);
/// Gap on the side it flips to (left / above the tip: no arrow there), at 1×.
const FLIPPED: f32 = 8.0;

/// Where the card's top-left goes, at `scale`: below and to the right of the arrow, so the
/// arrow and what is under it (the drop point) stay visible. Near the right or bottom edge of
/// `area` (the monitor's work area: left, top, right, bottom) it goes to the left / above.
pub fn origin(cursor: (i32, i32), scale: f32, area: (i32, i32, i32, i32)) -> (i32, i32) {
    let (w, h) = size(scale);
    let (w, h) = (w as i32, h as i32);
    let (dx, dy) = ((BESIDE.0 * scale).round() as i32, (BESIDE.1 * scale).round() as i32);
    let flip = (FLIPPED * scale).round() as i32;
    let mut x = cursor.0 + dx;
    if x + w > area.2 {
        x = cursor.0 - flip - w;
    }
    let mut y = cursor.1 + dy;
    if y + h > area.3 {
        y = cursor.1 - flip - h;
    }
    (x.max(area.0), y.max(area.1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_follows_the_monitor_scale() {
        assert_eq!(size(1.0), (232, 68));
        assert_eq!(size(1.5), (348, 102));
        assert_eq!(size(2.0), (464, 136));
    }

    #[test]
    fn card_sits_beside_the_arrow_and_flips_at_the_edges() {
        let screen = (0, 0, 1920, 1040);
        assert_eq!(origin((500, 400), 1.0, screen), (518, 422));
        assert_eq!(origin((500, 400), 2.0, screen), (536, 444));
        // right edge: to the left of the tip; bottom edge: above it
        assert_eq!(origin((1800, 400), 1.0, screen), (1800 - 8 - 232, 422));
        assert_eq!(origin((500, 1000), 1.0, screen), (518, 1000 - 8 - 68));
        // a second monitor to the left
        assert_eq!(origin((-100, 400), 1.0, (-1920, 0, 0, 1040)), (-100 - 8 - 232, 422));
    }

    #[test]
    fn corners_outside_the_card_stay_transparent_and_its_inside_is_opaque() {
        for scale in [1.0_f32, 1.5, 2.0] {
            let l = layout(scale, 1);
            let (pill, _) = badge(&l, 40.0 * scale);
            let c = paint(&l, pill, "move", None);
            assert_eq!(c.alpha(0, 0), 0, "outside the inset");
            assert_eq!(c.alpha(l.card.x as usize, l.card.y as usize), 0, "rounded corner at {scale}");
            let (mx, my) = ((l.card.x + l.card.w / 2.0) as usize, (l.card.y + l.card.h / 2.0) as usize);
            assert_eq!(c.alpha(mx, my), 255);
        }
    }

    #[test]
    fn several_layers_show_sheets_behind_the_card() {
        assert!(layout(1.0, 1).backs.is_empty());
        assert_eq!(layout(1.0, 3).backs.len(), 2);
        assert_eq!(layout(1.0, 9).backs.len(), 4);
        // the sheet edge shows past the card's right edge
        let l = layout(1.0, 3);
        let c = paint(&l, badge(&l, 30.0).0, "move", None);
        assert!(c.alpha(l.card.right() as usize + 1, (l.card.y + 30.0) as usize) > 0);
    }

    #[test]
    fn pill_fits_the_text_but_never_the_whole_line() {
        let l = layout(1.0, 1);
        let (pill, text) = badge(&l, 40.0);
        assert_eq!(pill.w, 63.0);
        assert_eq!(text.x, pill.x + 16.0);
        let (pill, _) = badge(&l, 1000.0);
        assert_eq!(pill.w, l.text_width);
    }

    #[test]
    fn thumbnails_are_contained_without_stretching() {
        let b = RectF { x: 0.0, y: 0.0, w: 42.0, h: 42.0 };
        assert_eq!(contain(b, 96.0, 48.0), RectF { x: 0.0, y: 10.5, w: 42.0, h: 21.0 });
        assert_eq!(contain(b, 48.0, 96.0), RectF { x: 10.5, y: 0.0, w: 21.0, h: 42.0 });
    }

    #[test]
    fn thumbnail_pixels_land_inside_the_thumb_box() {
        let l = layout(1.0, 1);
        let img = RgbaImage::from_pixel(10, 20, image::Rgba([255, 0, 0, 255]));
        let c = paint(&l, badge(&l, 30.0).0, "move", Some(&img));
        let (cx, cy) = ((l.thumb.x + l.thumb.w / 2.0) as usize, (l.thumb.y + l.thumb.h / 2.0) as usize);
        let i = (cy * c.w + cx) * 4;
        assert_eq!(&c.px[i..i + 4], &[0, 0, 255, 255]); // BGRA red
    }
}
