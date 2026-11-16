//! 外置删除区: the red rounded square with a trash can that appears beside the panel while a
//! WaveLayer layer (or mask / filter / effect) is dragged; let go over it and the plugin deletes
//! what was dragged. Pure here (placement, hit box, pixels); drag/win.rs owns its click-through
//! layered window and publishes the hit box as the `TRASH` target, so the card ("松开删除…")
//! and the release come from the same hit test as every other native target.
//!
//! Placement: where the drag began is where the panel is. With the canvas known and the cursor
//! beside it (a docked panel), the square sits just inside the canvas edge facing the panel, at
//! the height of the grabbed row: the shortest way out of the panel. Otherwise (floating panel
//! over the canvas, no canvas) it sits a little to the side of the cursor, away from the screen
//! edge. It never moves during the drag.

use super::card::{Canvas, RectF, Rgb};

/// The square's side at rest and while hovered (logical px).
pub const SIZE: f32 = 60.0;
pub const HOT: f32 = 72.0;
/// Transparent margin around the hovered square (its glow) inside the window.
pub const PAD: f32 = 8.0;
/// The hit box reaches this far past the hovered square: easy to hit, hard to miss.
pub const REACH: f32 = 10.0;
/// Gap between the square and the canvas edge.
const GAP: f32 = 18.0;
/// From the cursor to the square's centre when it can't go against the canvas edge.
const BESIDE: f32 = 96.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    Idle,
    Hot,
    /// nothing in this drag can be deleted (locked, background…): shown, never a target
    Disabled,
}

/// The window's side in physical px.
pub fn window_px(scale: f32) -> i32 {
    ((HOT + 2.0 * PAD) * scale).ceil() as i32
}

/// The square's centre on screen. `view`: the canvas (left, top, right, bottom), physical px;
/// `area`: the monitor's work area.
pub fn centre(cursor: (i32, i32), view: Option<(i32, i32, i32, i32)>, area: (i32, i32, i32, i32), scale: f32) -> (i32, i32) {
    let half = window_px(scale) / 2;
    let inset = ((GAP + HOT / 2.0 + PAD) * scale).round() as i32;
    let beside = (BESIDE * scale).round() as i32;
    let view = view.filter(|v| v.2 - v.0 > 4 * half && v.3 - v.1 > 4 * half);
    let (cx, (top, bottom)) = match view {
        Some(v) if cursor.0 >= v.2 => (v.2 - inset, (v.1, v.3)),
        Some(v) if cursor.0 <= v.0 => (v.0 + inset, (v.1, v.3)),
        _ => {
            // away from the nearer screen edge
            let left = cursor.0 - beside;
            let cx = if left - half >= area.0 { left } else { cursor.0 + beside };
            (cx, (area.1, area.3))
        }
    };
    let clamp = |v: i32, lo: i32, hi: i32| if lo > hi { (lo + hi) / 2 } else { v.clamp(lo, hi) };
    let cy = clamp(cursor.1, top + inset, bottom - inset);
    (clamp(cx, area.0 + half, area.2 - half), clamp(cy, area.1 + half, area.3 - half))
}

/// The window's top-left for that centre.
pub fn origin(centre: (i32, i32), scale: f32) -> (i32, i32) {
    let half = window_px(scale) / 2;
    (centre.0 - half, centre.1 - half)
}

/// The hit box (left, top, right, bottom; right / bottom exclusive) around that centre.
pub fn hit_rect(centre: (i32, i32), scale: f32) -> (i32, i32, i32, i32) {
    let r = ((HOT / 2.0 + REACH) * scale).round() as i32;
    (centre.0 - r, centre.1 - r, centre.0 + r, centre.1 + r)
}

const RED: Rgb = Rgb(0xc9, 0x3b, 0x30);
const RED_HOT: Rgb = Rgb(0xe8, 0x45, 0x38);
const GREY: Rgb = Rgb(0x4a, 0x4a, 0x4a);
const INK: Rgb = Rgb(0xff, 0xff, 0xff);
const INK_OFF: Rgb = Rgb(0x8f, 0x94, 0x99); // theme::TEXT_3
const SHADOW: Rgb = Rgb(0, 0, 0);

/// The window's pixels (premultiplied BGRA, top row first).
pub fn paint(scale: f32, look: Look) -> Canvas {
    let n = window_px(scale) as usize;
    let mut c = Canvas::new(n, n);
    let mid = n as f32 / 2.0;
    let side = if look == Look::Hot { HOT } else { SIZE } * scale;
    let square = RectF { x: mid - side / 2.0, y: mid - side / 2.0, w: side, h: side };
    let radius = 14.0 * scale;
    // a soft shadow (hovered: a red glow) so it reads on light and dark canvases alike
    let (glow, glow_a) = if look == Look::Hot { (RED_HOT, 0.16) } else { (SHADOW, 0.10) };
    for i in (1..=3).rev() {
        let d = i as f32 * 2.0 * scale;
        let r = RectF { x: square.x - d, y: square.y - d + scale, w: square.w + 2.0 * d, h: square.h + 2.0 * d };
        c.round_rect_alpha(r, radius + d, glow, glow_a);
    }
    let (fill, alpha, ink) = match look {
        Look::Idle => (RED, 0.92, INK),
        Look::Hot => (RED_HOT, 1.0, INK),
        Look::Disabled => (GREY, 0.88, INK_OFF),
    };
    c.round_rect_alpha(square, radius, fill, alpha);
    if look == Look::Hot {
        // a thin light ring inside the edge: "this one"
        let ring = square.shrink(1.5 * scale);
        c.round_rect_alpha(ring, radius - 1.5 * scale, INK, 0.30);
        c.round_rect(ring.shrink(1.5 * scale), radius - 3.0 * scale, fill);
    }
    can(&mut c, mid, side * 0.42, look == Look::Hot, ink, fill);
    if look == Look::Disabled {
        // struck through
        let s = side * 0.30;
        for k in 0..(s * 2.0) as i32 {
            let t = k as f32 / 2.0;
            let r = RectF { x: mid - s + t * 2.0 - 1.2 * scale, y: mid - s + t * 2.0 - 1.2 * scale, w: 2.4 * scale, h: 2.4 * scale };
            c.round_rect(r, 1.2 * scale, ink);
        }
    }
    c
}

/// A trash can of height `size` centred at (mid, mid); `open`: the lid lifts.
fn can(c: &mut Canvas, mid: f32, size: f32, open: bool, ink: Rgb, back: Rgb) {
    let u = size / 10.0;
    let top = mid - size / 2.0;
    let lift = if open { 1.6 * u } else { 0.0 };
    // handle and lid
    c.round_rect(RectF { x: mid - 1.8 * u, y: top - lift, w: 3.6 * u, h: 1.6 * u }, 0.6 * u, ink);
    c.round_rect(RectF { x: mid - 4.6 * u, y: top + 1.2 * u - lift, w: 9.2 * u, h: 1.3 * u }, 0.6 * u, ink);
    // body, a little narrower at the bottom
    let body = RectF { x: mid - 3.6 * u, y: top + 3.1 * u, w: 7.2 * u, h: 6.9 * u };
    c.round_rect(body, 1.0 * u, ink);
    // three slots
    for i in -1..=1 {
        let x = mid + i as f32 * 2.2 * u - 0.45 * u;
        c.round_rect(RectF { x, y: body.y + 1.4 * u, w: 0.9 * u, h: body.h - 2.8 * u }, 0.45 * u, back);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: (i32, i32, i32, i32) = (0, 0, 1920, 1040);

    #[test]
    fn a_docked_panel_on_the_right_puts_it_inside_the_canvas_right_edge_at_the_row_height() {
        let view = Some((100, 80, 1500, 1000));
        let (x, y) = centre((1650, 400), view, AREA, 1.0);
        assert!(x < 1500 && x > 1500 - 120, "x={x}");
        assert_eq!(y, 400);
        // the hovered square plus its reach stays inside the canvas
        let hit = hit_rect((x, y), 1.0);
        assert!(hit.2 <= 1500, "{hit:?}");
    }

    #[test]
    fn a_panel_on_the_left_mirrors_it_and_the_height_is_clamped_to_the_canvas() {
        let view = Some((400, 80, 1800, 1000));
        let (x, y) = centre((200, 20), view, AREA, 1.0);
        assert!(x > 400 && x < 400 + 120, "x={x}");
        assert!(y >= 80 + 40, "y={y}");
    }

    #[test]
    fn over_the_canvas_or_without_it_it_sits_beside_the_cursor_away_from_the_screen_edge() {
        let (x, _) = centre((800, 500), Some((100, 80, 1500, 1000)), AREA, 1.0);
        assert_eq!(x, 800 - 96);
        let (x, _) = centre((60, 500), None, AREA, 1.0);
        assert_eq!(x, 60 + 96);
        let (x, y) = centre((1900, 1030), None, AREA, 2.0);
        let half = window_px(2.0) / 2;
        assert!(x + half <= 1920 && y + half <= 1040);
    }

    #[test]
    fn everything_scales_with_the_monitor() {
        assert_eq!(window_px(1.0), 88);
        assert_eq!(window_px(1.5), 132);
        let (l, t, r, b) = hit_rect((500, 500), 1.0);
        assert_eq!((r - l, b - t), (92, 92));
    }

    #[test]
    fn corners_are_transparent_and_the_square_is_opaque_red() {
        let c = paint(1.0, Look::Idle);
        assert_eq!(c.alpha(0, 0), 0);
        let mid = c.w / 2;
        // between the slots and the lid: the can's white or the red square, never see-through
        assert!(c.alpha(mid - 24, mid) > 200);
        let i = (mid * c.w + (mid - 26)) * 4;
        assert!(c.px[i + 2] > c.px[i], "red over blue");
    }

    #[test]
    fn hovered_is_bigger_than_idle() {
        let n = window_px(1.0) as usize;
        let row = |c: &Canvas| (0..n).filter(|&x| c.alpha(x, n / 2) > 128).count();
        assert!(row(&paint(1.0, Look::Hot)) > row(&paint(1.0, Look::Idle)) + 8);
    }
}
