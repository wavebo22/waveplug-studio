//! Native drop targets for a WaveLayer drag: rectangles (screen pixels) that surfaces publish
//! while they are on screen, hit-tested by the drag engine on every mouse move. A surface that
//! publishes a target is the one that handles the release over it (Surface::external_drop), so
//! the card and the drop always come from the same hit test.

use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    /// the publishing surface's id ("generate")
    pub surface: &'static str,
    /// the surface's own id for it (a reference slot number)
    pub id: u32,
    /// screen pixels: left, top, right (exclusive), bottom (exclusive)
    pub rect: (i32, i32, i32, i32),
    /// what releasing over it does, shown on the drag card
    pub action: String,
}

impl Target {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        let (l, t, r, b) = self.rect;
        x >= l && x < r && y >= t && y < b
    }
}

/// Every surface's published targets; a surface replaces its whole set at once.
#[derive(Default)]
pub struct Registry {
    targets: Vec<Target>,
}

impl Registry {
    pub fn publish(&mut self, surface: &'static str, targets: Vec<Target>) {
        self.targets.retain(|t| t.surface != surface);
        self.targets.extend(targets.into_iter().map(|t| Target { surface, ..t }));
    }

    /// The topmost target under (x, y): the last published wins where two overlap.
    pub fn hit(&self, x: i32, y: i32) -> Option<&Target> {
        self.targets.iter().rev().find(|t| t.contains(x, y))
    }
}

pub static REGISTRY: Mutex<Registry> = Mutex::new(Registry { targets: Vec::new() });

/// Replace `surface`'s targets (an empty list takes them all away).
pub fn publish(surface: &'static str, targets: Vec<Target>) {
    if let Ok(mut r) = REGISTRY.lock() {
        r.publish(surface, targets);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: u32, rect: (i32, i32, i32, i32)) -> Target {
        Target { surface: "generate", id, rect, action: format!("slot {id}") }
    }

    #[test]
    fn hit_is_exclusive_on_the_right_and_bottom_edges() {
        let mut r = Registry::default();
        r.publish("generate", vec![t(1, (100, 100, 156, 156))]);
        assert_eq!(r.hit(100, 100).map(|t| t.id), Some(1));
        assert_eq!(r.hit(155, 155).map(|t| t.id), Some(1));
        assert!(r.hit(156, 120).is_none());
        assert!(r.hit(99, 120).is_none());
    }

    #[test]
    fn publishing_replaces_only_that_surfaces_targets() {
        let mut r = Registry::default();
        r.publish("generate", vec![t(1, (0, 0, 10, 10)), t(2, (20, 0, 30, 10))]);
        r.publish("other", vec![Target { surface: "other", id: 9, rect: (40, 0, 50, 10), action: String::new() }]);
        r.publish("generate", vec![t(3, (0, 0, 10, 10))]);
        assert_eq!(r.hit(5, 5).map(|t| t.id), Some(3));
        assert!(r.hit(25, 5).is_none());
        assert_eq!(r.hit(45, 5).map(|t| (t.surface, t.id)), Some(("other", 9)));
        r.publish("generate", Vec::new());
        assert!(r.hit(5, 5).is_none());
    }
}
