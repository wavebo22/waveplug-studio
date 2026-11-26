#![cfg_attr(not(windows), allow(dead_code))]
// 外置窗口的吸附布局: the one standard for where every external window sits on Photoshop's
// canvas, so none of them covers another. Pure (tested here); win.rs feeds it the canvas and the
// sizes and moves the windows to what it says, on every watch tick (250 ms) and whenever a
// window is shown or changes size — not only when the plugin happens to send something.
//
// The canvas is shared out like this (all inside the canvas view, `margin` from its edges):
//
//   ┌ 变体栏 (variants) ─────────────────────────────── 编辑工作台 (shelf) ┐
//   │ top-left, grows down                              top-right, grows down│
//   │                                                                        │
//   │ 生图面板 (generate)                                      完成提示 (toast)│
//   │ bottom-left (or where the user dragged / snapped it)      bottom-right │
//   └ 底部提示栏 (status bar): the whole width, on the bottom edge ──────────┘
//
// Rules, in order:
//  1. the status bar owns the bottom strip: everything else lives in `work`, the canvas above it;
//  2. the generate panel is placed first (it is where the user works) and never moves for others;
//  3. a window above it in the same column (the variant rail, the workbench) is shortened to end
//     `gap` above it (the rail scrolls; the workbench clips its list);
//  4. the toast goes bottom-right, or just above the generate panel when that is there.
// A new external window gets a corner or edge here and follows the same rules.
//
// One window lives outside the canvas: the 检查结果 window (check_rect) goes against the left edge
// of the WavePlug 图层 panel, top-aligned with it and as tall as it (or just its title bar when
// folded); on the panel's right instead when the screen has no room on the left.

/// left, top, right, bottom in physical screen px
pub type R = (i32, i32, i32, i32);

/// The generate panel: its size and where the user put it (win.rs OFFSET / SNAP).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Panel {
    pub size: (i32, i32),
    /// from its home corner (bottom-left of `work`, `margin` in), physical px
    pub offset: (i32, i32),
    /// an edge it was dragged against: -1 left / top, 1 right / bottom, 0 free
    pub snap: (i8, i8),
}

/// The canvas minus the status bar's strip along its bottom.
pub fn work_area(canvas: R, bar_h: i32) -> R {
    let bottom = (canvas.3 - bar_h.max(0)).max(canvas.1 + 1);
    (canvas.0, canvas.1, canvas.2, bottom)
}

/// Where the generate panel goes (left, top, width, height): its corner plus the user's offset,
/// or against the edge it was snapped to; always inside `work`, never taller than it.
pub fn generate_rect(work: R, margin: i32, p: Panel) -> (i32, i32, i32, i32) {
    let (w, h) = (p.size.0.max(1), p.size.1.max(1).min((work.3 - work.1).max(1)));
    let max_x = (work.2 - w).max(work.0);
    let max_y = (work.3 - h).max(work.1);
    let x = match p.snap.0 {
        -1 => work.0,
        1 => max_x,
        _ => (work.0 + margin + p.offset.0).clamp(work.0, max_x),
    };
    let y = match p.snap.1 {
        -1 => work.1,
        1 => max_y,
        _ => (work.3 - h - margin + p.offset.1).clamp(work.1, max_y),
    };
    (x, y, w, h)
}

fn overlaps_x(a: (i32, i32), b: (i32, i32)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

/// The tallest a window starting at `top`, spanning `x` (left, right), may be: down to `gap`
/// above the generate panel when that is under it in the same column, else down to the work
/// area's bottom less `margin`. At least `min` (when there is no room, they overlap rather than
/// the window vanishing).
pub fn height_limit(work: R, margin: i32, gap: i32, top: i32, x: (i32, i32), generate: Option<R>, min: i32) -> i32 {
    let mut bottom = work.3 - margin;
    if let Some(g) = generate {
        if overlaps_x(x, (g.0, g.2)) && g.1 > top {
            bottom = bottom.min(g.1 - gap);
        }
    }
    (bottom - top).max(min)
}

/// The completion toast (left, top, width, height): bottom-right of `work`; above the generate
/// panel instead when it would land on it.
pub fn toast_rect(work: R, margin: i32, gap: i32, size: (i32, i32), generate: Option<R>) -> (i32, i32, i32, i32) {
    let (w, h) = size;
    let x = (work.2 - margin - w).max(work.0);
    let mut y = work.3 - margin - h;
    if let Some(g) = generate {
        if overlaps_x((x, x + w), (g.0, g.2)) && y < g.3 && y + h > g.1 {
            y = g.1 - gap - h;
        }
    }
    (x, y.max(work.1), w, h)
}

/// The 检查结果 window (left, top, width, height): `gap` left of `panel` (the 图层 panel on screen),
/// its top aligned with the panel's, `height` tall (the panel's height unless folded) but inside
/// `screen` (the monitor's work area); right of the panel when there is no room on the left.
pub fn check_rect(panel: R, screen: R, width: i32, height: i32, gap: i32) -> (i32, i32, i32, i32) {
    let x = if panel.0 - gap - width >= screen.0 { panel.0 - gap - width } else { (panel.2 + gap).min(screen.2 - width).max(screen.0) };
    let h = height.min(screen.3 - screen.1).max(1);
    let y = panel.1.clamp(screen.1, (screen.3 - h).max(screen.1));
    (x, y, width, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANVAS: R = (1000, 100, 3000, 2100);

    #[test]
    fn the_check_window_sits_left_of_the_layer_panel() {
        let screen = (0, 0, 3840, 2100);
        // the panel docked on the right: the window just left of it, as tall as it
        assert_eq!(check_rect((3400, 200, 3840, 1400), screen, 340, 1200, 8), (3400 - 8 - 340, 200, 340, 1200));
        // folded: only the title bar, same corner
        assert_eq!(check_rect((3400, 200, 3840, 1400), screen, 340, 34, 8).3, 34);
        // the panel at the screen's left edge: the window goes to its right
        assert_eq!(check_rect((0, 200, 300, 1400), screen, 340, 1200, 8).0, 308);
        // never below the screen's bottom
        let (_, y, _, h) = check_rect((3400, 1800, 3840, 2100), screen, 340, 1200, 8);
        assert!(y + h <= 2100);
    }

    #[test]
    fn the_status_bar_strip_is_taken_off_the_bottom() {
        assert_eq!(work_area(CANVAS, 36), (1000, 100, 3000, 2064));
        assert_eq!(work_area(CANVAS, 0), CANVAS);
    }

    #[test]
    fn the_generate_panel_sits_above_the_status_bar_and_stays_inside() {
        let work = work_area(CANVAS, 36);
        let p = Panel { size: (340, 600), offset: (0, 0), snap: (0, 0) };
        assert_eq!(generate_rect(work, 12, p), (1012, 2064 - 600 - 12, 340, 600));
        // dragged past the bottom: clamped above the bar, not over it
        let p = Panel { offset: (0, 500), ..p };
        assert_eq!(generate_rect(work, 12, p).1 + 600, 2064);
        // snapped to the right / bottom edges of the work area
        let p = Panel { snap: (1, 1), ..p };
        assert_eq!(generate_rect(work, 12, p), (3000 - 340, 2064 - 600, 340, 600));
        // never taller than the canvas above the bar
        let p = Panel { size: (340, 5000), offset: (0, 0), snap: (0, 0) };
        assert_eq!(generate_rect(work, 12, p).3, 2064 - 100);
    }

    #[test]
    fn a_window_above_the_generate_panel_stops_short_of_it() {
        let work = work_area(CANVAS, 36);
        let gen = Some((1012, 1452, 1352, 2052));
        // the variant rail, top-left, same column: ends `gap` above the panel
        assert_eq!(height_limit(work, 12, 8, 112, (1012, 1154), gen, 60), 1452 - 8 - 112);
        // the workbench, top-right, another column: down to the bottom margin
        assert_eq!(height_limit(work, 12, 8, 112, (2700, 2988), gen, 60), 2064 - 12 - 112);
        // no room at all: the minimum (they overlap rather than the rail vanishing)
        let low = Some((1012, 130, 1352, 730));
        assert_eq!(height_limit(work, 12, 8, 112, (1012, 1154), low, 60), 60);
    }

    #[test]
    fn the_toast_goes_bottom_right_or_above_the_generate_panel() {
        let work = work_area(CANVAS, 36);
        assert_eq!(toast_rect(work, 12, 8, (300, 70), None), (2688, 1982, 300, 70));
        // the panel dragged to the bottom-right corner: the toast goes above it
        let gen = Some((2660, 1452, 3000, 2064));
        assert_eq!(toast_rect(work, 12, 8, (300, 70), gen), (2688, 1452 - 8 - 70, 300, 70));
        // the panel on the left: the toast keeps its corner
        let gen = Some((1012, 1452, 1352, 2052));
        assert_eq!(toast_rect(work, 12, 8, (300, 70), gen).1, 1982);
    }
}
