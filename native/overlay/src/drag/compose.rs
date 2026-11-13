//! One SVG for a drag into a vector program (Illustrator, Figma): every dragged layer where it
//! sits in the document, relative to the others. Text and shape layers go as the plugin's SVG
//! fragments (editable text, paths; effects dropped), the other layers as their PNG embedded as
//! base64 (so the target embeds them, nothing links to our cache). Pure; the caller reads the
//! PNGs and writes the file.
//!
//! Size: the document's pixels become points at its resolution (a 300 ppi layer lands in
//! Illustrator at its printed size, as a copy from Photoshop does).

use super::transfer::Rect;

pub struct Item<'a> {
    /// the layer's PNG (its size is read from the header)
    pub png: &'a [u8],
    pub rect: Option<Rect>,
    pub vector: Option<&'a str>,
    /// the plugin's order: 0 is the top of the layer list
    pub order: u32,
}

/// Width and height from a PNG's IHDR.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn num(x: f64) -> String {
    let r = (x * 1000.0).round() / 1000.0;
    if r == r.trunc() { format!("{}", r as i64) } else { format!("{r}") }
}

/// The SVG; `raster`: every layer as its image (keeps the layer effects the PNG has). None when
/// no layer has a usable PNG or position.
pub fn compose(items: &[Item], raster: bool, res: f64) -> Option<String> {
    // (item, left, top, width, height)
    let mut placed = Vec::new();
    for it in items {
        let Some((w, h)) = png_size(it.png) else { continue };
        let (l, t) = it.rect.map_or((0, 0), |r| (r.left, r.top));
        placed.push((it, l as f64, t as f64, w as f64, h as f64));
    }
    if placed.is_empty() {
        return None;
    }
    let left = placed.iter().map(|p| p.1).fold(f64::MAX, f64::min);
    let top = placed.iter().map(|p| p.2).fold(f64::MAX, f64::min);
    let right = placed.iter().map(|p| p.1 + p.3).fold(f64::MIN, f64::max);
    let bottom = placed.iter().map(|p| p.2 + p.4).fold(f64::MIN, f64::max);
    let (w, h) = (right - left, bottom - top);
    let scale = if res > 0.0 { 72.0 / res } else { 1.0 };
    let mut s = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" version=\"1.1\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\">\n",
        num(w * scale), num(h * scale), num(left), num(top), num(w), num(h)
    );
    // the bottom layer first: later elements draw on top
    placed.sort_by(|a, b| b.0.order.cmp(&a.0.order));
    for (it, l, t, pw, ph) in placed {
        match it.vector.filter(|v| !raster && !v.is_empty()) {
            Some(v) => {
                s.push_str(v);
                s.push('\n');
            }
            None => {
                s.push_str(&format!(
                    "<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" xlink:href=\"data:image/png;base64,{}\"/>\n",
                    num(l), num(t), num(pw), num(ph), base64(it.png)
                ));
            }
        }
    }
    s.push_str("</svg>\n");
    Some(s)
}

/// Reads the layers' PNGs (`path`: our session copies) and writes the SVG to `to`.
pub fn write(files: &[super::transfer::SourceFile], raster: bool, to: &std::path::Path) -> Result<(), String> {
    let pngs: Vec<Vec<u8>> = files.iter().map(|f| std::fs::read(&f.path).unwrap_or_default()).collect();
    let items: Vec<Item> = files
        .iter()
        .zip(&pngs)
        .map(|(f, png)| Item { png, rect: f.rect, vector: f.vector.as_deref(), order: f.order })
        .collect();
    let res = files.iter().find_map(|f| f.res).unwrap_or(72.0);
    let svg = compose(&items, raster, res).ok_or("没有可用的图层图像")?;
    std::fs::write(to, svg).map_err(|e| format!("写入 {} 失败：{e}", to.display()))
}

/// Whether some layer goes as editable vectors.
pub fn files_have_vectors(files: &[super::transfer::SourceFile]) -> bool {
    files.iter().any(|f| f.vector.as_deref().is_some_and(|v| !v.is_empty()))
}

/// File names in the session folder (ASCII: they reach cscript and Illustrator).
pub const EDITABLE: &str = "waveplug_layers.svg";
pub const IMAGES: &str = "waveplug_images.svg";

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn png_size_reads_the_header() {
        assert_eq!(png_size(&png(30, 20)), Some((30, 20)));
        assert_eq!(png_size(b"not a png at all, really"), None);
    }

    #[test]
    fn layers_keep_their_relative_positions_bottom_first() {
        let a = png(10, 10);
        let b = png(20, 5);
        let items = [
            Item { png: &a, rect: Some(Rect { left: 100, top: 50, right: 110, bottom: 60 }), vector: Some("<text>T</text>"), order: 0 },
            Item { png: &b, rect: Some(Rect { left: 90, top: 70, right: 110, bottom: 75 }), vector: None, order: 1 },
        ];
        let s = compose(&items, false, 144.0).unwrap();
        // union 90,50 → 110,75; at 144 ppi half size in points
        assert!(s.contains("width=\"10\" height=\"12.5\" viewBox=\"90 50 20 25\""), "{s}");
        let img = s.find("<image x=\"90\" y=\"70\" width=\"20\" height=\"5\"").unwrap();
        let text = s.find("<text>T</text>").unwrap();
        assert!(img < text, "the lower layer (order 1) comes first");
    }

    #[test]
    fn raster_puts_every_layer_as_its_image() {
        let a = png(4, 4);
        let items = [Item { png: &a, rect: None, vector: Some("<path d=\"M0 0\"/>"), order: 0 }];
        let s = compose(&items, true, 72.0).unwrap();
        assert!(!s.contains("<path"));
        assert!(s.contains("<image x=\"0\" y=\"0\" width=\"4\" height=\"4\" xlink:href=\"data:image/png;base64,"));
        assert!(compose(&[Item { png: b"x", rect: None, vector: None, order: 0 }], false, 72.0).is_none());
    }
}
