// 动画: the motion of the external windows — sliding in when they appear, sliding out before they
// are put away, and the generate panel growing / shrinking between its bar and its full height.
//
// Motion only (window position and size through SetWindowPos), no opacity: the windows are GPU
// surfaces, and making those layered for an alpha fade is not something to try unseen.
// Short and eased out, so nothing waits on it: a window is usable from its first frame.

/// 0 → 1, fast at first and settling at the end.
pub fn ease_out(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}

/// The value `t` (0–1) of the way from `from` to `to`, eased.
pub fn tween(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * ease_out(t)
}

/// How far (0–1 of the full offset) a sliding window is from its place at `t`:
/// appearing it starts a full offset away and ends in place, disappearing the other way round.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn offset_at(t: f32, appearing: bool) -> f32 {
    if appearing { 1.0 - ease_out(t) } else { ease_out(t) }
}

/// Appearing / disappearing, in ms; and how far a window slides (physical px).
#[cfg_attr(not(windows), allow(dead_code))]
pub const SLIDE_IN_MS: u32 = 150;
#[cfg_attr(not(windows), allow(dead_code))]
pub const SLIDE_OUT_MS: u32 = 110;
#[cfg_attr(not(windows), allow(dead_code))]
pub const SLIDE_PX: i32 = 22;
/// The generate panel between collapsed and expanded, in seconds.
pub const RESIZE_SECS: f32 = 0.16;

#[cfg(windows)]
pub use imp::{slide, Place};

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::DwmFlush;
    use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos;

    use super::offset_at;

    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_ASYNCWINDOWPOS: u32 = 0x4000;

    /// Where the window belongs while it slides.
    #[derive(Clone, Copy)]
    pub enum Place {
        /// asked again at every step: the place may change meanwhile (the panel's height is fitted,
        /// Photoshop's canvas moves), and the slide must end where it then belongs
        Live(fn() -> Option<(i32, i32)>),
        Fixed((i32, i32)),
    }

    /// Slides window `hwnd` by `by` px: into its place (`appearing`) or away from it, then calls
    /// `done` (putting it away). `generation` belongs to the window: starting another slide, or
    /// bumping it, stops this one where it is — and then `done` is not called.
    pub fn slide(hwnd: isize, generation: &'static AtomicU32, place: Place, by: (i32, i32), appearing: bool, ms: u32, done: Option<fn(isize)>) {
        let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
        thread::spawn(move || {
            let start = Instant::now();
            loop {
                if generation.load(Ordering::SeqCst) != mine {
                    return;
                }
                let t = (start.elapsed().as_secs_f32() * 1000.0 / ms.max(1) as f32).min(1.0);
                let at = match place {
                    Place::Live(ask) => ask(),
                    Place::Fixed(p) => Some(p),
                };
                if let Some((x, y)) = at {
                    let k = offset_at(t, appearing);
                    unsafe {
                        SetWindowPos(
                            hwnd as HWND,
                            std::ptr::null_mut(),
                            x + (by.0 as f32 * k).round() as i32,
                            y + (by.1 as f32 * k).round() as i32,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                        );
                    }
                }
                if t >= 1.0 {
                    break;
                }
                // one step per frame the screen shows (a fixed sleep drifts against the display's
                // refresh and moves the window unevenly); a 16 ms sleep when composition is off
                if unsafe { DwmFlush() } < 0 {
                    thread::sleep(Duration::from_millis(16));
                }
            }
            if generation.load(Ordering::SeqCst) == mine {
                if let Some(done) = done {
                    done(hwnd);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eases_out_from_start_to_end() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert_eq!(ease_out(7.0), 1.0);
        // most of the way early, never past the end, always forward
        assert!(ease_out(0.5) > 0.8);
        let mut last = 0.0;
        for i in 0..=20 {
            let v = ease_out(i as f32 / 20.0);
            assert!(v >= last && v <= 1.0);
            last = v;
        }
    }

    #[test]
    fn tween_ends_exactly_on_the_target() {
        assert_eq!(tween(14.0, 320.0, 0.0), 14.0);
        assert_eq!(tween(14.0, 320.0, 1.0), 320.0);
        assert_eq!(tween(320.0, 14.0, 1.0), 14.0);
        assert!(tween(14.0, 320.0, 0.5) > 250.0);
    }

    #[test]
    fn a_window_slides_into_place_and_away_from_it() {
        assert_eq!(offset_at(0.0, true), 1.0);
        assert_eq!(offset_at(1.0, true), 0.0);
        assert_eq!(offset_at(0.0, false), 0.0);
        assert_eq!(offset_at(1.0, false), 1.0);
    }
}
