//! One WaveLayer drag, as seen by the helper: what the card says, where it goes, which native
//! target the cursor is over and what the release does. Pure: the Windows engine (drag/win.rs)
//! feeds it the plugin's messages and the mouse, and carries out what it returns.
//!
//! The card text is arbitrated (drag_target::resolve): a native target under the cursor wins over
//! the plugin, which only knows its own panel. Native targets count only for a drag the plugin
//! marked as a reference drag (normal layers; LayerDragStart), as before.

use crate::drag::targets::Target;
use crate::drag_target::{resolve, DropVerdict};
use crate::panel::DraggedLayer;

/// The native workbench (panel/shelf.rs): its target accepts every WaveLayer drag, reference or not
/// (the plugin knows which layers it was dragging).
pub const WORKBENCH: &str = "workbench";
/// The 外置删除区 (drag/trash.rs): like the workbench it takes every WaveLayer drag (layers, masks,
/// filters, effects); the plugin deletes what it was dragging.
pub const TRASH: &str = "trash";

/// Targets that take a drag the plugin didn't mark as a reference drag.
fn takes_any_drag(surface: &str) -> bool {
    surface == WORKBENCH || surface == TRASH
}

/// What a release over a reference slot hands to the surface.
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    pub doc_id: u32,
    pub layers: Vec<DraggedLayer>,
    pub total_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// draw the card with this action / tone (only when they change)
    Render { action: String, tone: String },
    /// centre the card on this cursor position (screen px)
    Place { x: i32, y: i32 },
    /// the native target under the cursor changed (surfaces highlight it)
    Hover(Option<(&'static str, u32)>),
    /// released over a native target: the surface turns it into its drop action
    Dropped { surface: &'static str, target: u32, reference: Reference },
    /// take the card away
    Hide,
    /// tell the plugin the cross-window drag is over (finish-layer-drag)
    Finished,
}

/// Where a release during a system (OLE) drag goes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Release {
    /// over one of our native targets: the engine drops there and OLE is cancelled
    Native,
    /// over Photoshop or the helper: cancelled (Photoshop would place the PNG as a layer)
    Cancel,
    /// anywhere else: the target program takes the files
    Drop,
}

pub fn release_decision(hit: Option<&Target>, over_own_or_photoshop: bool) -> Release {
    if hit.is_some() {
        Release::Native
    } else if over_own_or_photoshop {
        Release::Cancel
    } else {
        Release::Drop
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ending {
    Dropped,
    Released,
    Escape,
    Cancelled,
}

#[derive(Default, Debug)]
pub struct Stats {
    pub moves: u32,
    pub renders: u32,
    pub max_handler_us: u128,
}

pub struct Session {
    plugin: DropVerdict,
    reference: Option<Reference>,
    /// the native target under the cursor: surface, id, its action text
    hover: Option<(&'static str, u32, String)>,
    /// what the drag to another program says (preparing files / target accepts / refuses)
    external: Option<DropVerdict>,
    shown: Option<(String, String)>,
    ended: Option<Ending>,
    pub stats: Stats,
}

impl Session {
    pub fn new() -> Self {
        Self {
            plugin: DropVerdict::new("移动", "move", "plugin"),
            reference: None,
            hover: None,
            external: None,
            shown: None,
            ended: None,
            stats: Stats::default(),
        }
    }

    pub fn ending(&self) -> Option<Ending> {
        self.ended
    }

    fn verdict(&self) -> DropVerdict {
        let native = self.hover.as_ref().map(|(surface, _, action)| {
            DropVerdict::new(action.clone(), if *surface == TRASH { "delete" } else { "move" }, surface)
        });
        resolve([native, self.external.clone()], self.plugin.clone())
    }

    /// Render when what the card says changed since it was last drawn.
    fn render_if_changed(&mut self, out: &mut Vec<Out>) {
        let v = self.verdict();
        let now = (v.action, v.tone);
        if self.shown.as_ref() != Some(&now) {
            self.stats.renders += 1;
            out.push(Out::Render { action: now.0.clone(), tone: now.1.clone() });
            self.shown = Some(now);
        }
    }

    /// The card's first drawing.
    pub fn begin(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        self.render_if_changed(&mut out);
        out
    }

    pub fn plugin_verdict(&mut self, action: String, tone: String) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_some() {
            return out;
        }
        self.plugin = DropVerdict::new(action, tone, "plugin");
        self.render_if_changed(&mut out);
        out
    }

    /// The drag to another program's own text on the card (None: back to the others).
    pub fn set_external(&mut self, verdict: Option<(String, String)>) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_some() {
            return out;
        }
        self.external = verdict.map(|(action, tone)| DropVerdict::new(action, tone, "external"));
        self.render_if_changed(&mut out);
        out
    }

    /// The system drag ended without a drop on our own targets: the session is over.
    pub fn external_ended(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_none() {
            self.finish(Ending::Released, &mut out);
        }
        out
    }

    pub fn attach_reference(&mut self, reference: Reference) {
        if self.ended.is_none() {
            self.reference = Some(reference);
        }
    }

    fn track(&mut self, hit: Option<&Target>, out: &mut Vec<Out>) {
        // the workbench takes any WaveLayer drag (groups too); other targets only reference drags
        let hit = hit.filter(|t| self.reference.is_some() || takes_any_drag(t.surface));
        let next = hit.map(|t| (t.surface, t.id, t.action.clone()));
        let key = |h: &Option<(&'static str, u32, String)>| h.as_ref().map(|(s, id, _)| (*s, *id));
        if key(&next) != key(&self.hover) {
            out.push(Out::Hover(key(&next)));
        }
        self.hover = next;
        self.render_if_changed(out);
    }

    /// The cursor moved to (x, y), over `hit` (the registry's topmost target there, if any).
    pub fn moved(&mut self, x: i32, y: i32, hit: Option<&Target>) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_some() {
            return out;
        }
        self.stats.moves += 1;
        out.push(Out::Place { x, y });
        self.track(hit, &mut out);
        out
    }

    /// The left button went up at (x, y): a drop when over a native target, else just the end.
    pub fn released(&mut self, x: i32, y: i32, hit: Option<&Target>) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_some() {
            return out;
        }
        let _ = (x, y);
        self.track(hit, &mut out);
        let mut ending = Ending::Released;
        if let Some((surface, target, _)) = self.hover.clone() {
            let reference = self.reference.clone().or_else(|| takes_any_drag(surface).then(|| Reference { doc_id: 0, layers: Vec::new(), total_count: 0 }));
            if let Some(reference) = reference {
                out.push(Out::Dropped { surface, target, reference });
                ending = Ending::Dropped;
            }
        }
        self.finish(ending, &mut out);
        out
    }

    pub fn escape(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_none() {
            self.finish(Ending::Escape, &mut out);
        }
        out
    }

    /// The plugin cancelled (its own Escape, a new drag, disconnect): nothing to tell it back.
    pub fn cancel(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        if self.ended.is_none() {
            self.ended = Some(Ending::Cancelled);
            if self.hover.take().is_some() {
                out.push(Out::Hover(None));
            }
            out.push(Out::Hide);
        }
        out
    }

    /// The plugin ended its drag (its pointerup usually arrives after our hook saw the release).
    /// If the button is already up this is that release; still down means it was cancelled.
    pub fn plugin_end(&mut self, button_down: bool, x: i32, y: i32, hit: Option<&Target>) -> Vec<Out> {
        if button_down { self.cancel() } else { self.released(x, y, hit) }
    }

    fn finish(&mut self, ending: Ending, out: &mut Vec<Out>) {
        self.ended = Some(ending);
        if self.hover.take().is_some() {
            out.push(Out::Hover(None));
        }
        out.push(Out::Hide);
        if self.reference.is_some() {
            out.push(Out::Finished);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(id: u32) -> Target {
        Target { surface: "generate", id, rect: (0, 0, 10, 10), action: "放入参考图".into() }
    }

    #[test]
    fn the_trash_takes_any_drag_and_its_card_says_delete() {
        let trash = Target { surface: TRASH, id: 0, rect: (0, 0, 10, 10), action: "松开删除 2 个图层".into() };
        let mut s = Session::new();
        s.begin();
        let out = s.moved(5, 5, Some(&trash));
        assert!(out.iter().any(|o| matches!(o, Out::Render { action, tone } if action == "松开删除 2 个图层" && tone == "delete")));
        let out = s.released(5, 5, Some(&trash));
        assert!(out.iter().any(|o| matches!(o, Out::Dropped { surface: TRASH, .. })));
        assert_eq!(s.ending(), Some(Ending::Dropped));
    }

    #[test]
    fn the_workbench_takes_a_drag_without_a_reference_other_targets_do_not() {
        let shelf = Target { surface: WORKBENCH, id: 0, rect: (0, 0, 10, 10), action: "加入工作台".into() };
        let mut s = Session::new();
        s.begin();
        let out = s.released(5, 5, Some(&shelf));
        assert!(out.iter().any(|o| matches!(o, Out::Dropped { surface: WORKBENCH, .. })));
        let mut s = Session::new();
        s.begin();
        let out = s.released(5, 5, Some(&slot(0)));
        assert!(!out.iter().any(|o| matches!(o, Out::Dropped { .. })));
    }

    fn reference() -> Reference {
        Reference { doc_id: 7, layers: vec![DraggedLayer { layer_id: 42, name: "产品".into(), thumb: None }], total_count: 1 }
    }

    fn renders(out: &[Out]) -> Vec<(String, String)> {
        out.iter().filter_map(|o| match o { Out::Render { action, tone } => Some((action.clone(), tone.clone())), _ => None }).collect()
    }

    #[test]
    fn card_is_drawn_once_and_then_only_when_its_text_changes() {
        let mut s = Session::new();
        assert_eq!(renders(&s.begin()).len(), 1);
        assert!(renders(&s.moved(5, 5, None)).is_empty());
        assert!(renders(&s.moved(6, 6, None)).is_empty());
        assert_eq!(renders(&s.plugin_verdict("移动到「A」上方".into(), "move".into())).len(), 1);
        assert!(renders(&s.plugin_verdict("移动到「A」上方".into(), "move".into())).is_empty());
        assert_eq!(s.stats.renders, 2);
        assert_eq!(s.stats.moves, 2);
    }

    #[test]
    fn every_move_places_the_card() {
        let mut s = Session::new();
        s.begin();
        assert_eq!(s.moved(30, 40, None)[0], Out::Place { x: 30, y: 40 });
    }

    #[test]
    fn a_reference_slot_under_the_cursor_overrides_the_plugin_text() {
        let mut s = Session::new();
        s.begin();
        s.plugin_verdict("拖到参考图槽位上".into(), "invalid".into());
        s.attach_reference(reference());
        let t = slot(1);
        let out = s.moved(5, 5, Some(&t));
        assert!(out.contains(&Out::Hover(Some(("generate", 1)))));
        assert_eq!(renders(&out), vec![("放入参考图".to_string(), "move".to_string())]);
        // leaving the slot goes back to the plugin's text
        let out = s.moved(50, 50, None);
        assert!(out.contains(&Out::Hover(None)));
        assert_eq!(renders(&out), vec![("拖到参考图槽位上".to_string(), "invalid".to_string())]);
    }

    #[test]
    fn slots_are_ignored_for_drags_that_cannot_become_references() {
        let mut s = Session::new();
        s.begin();
        s.plugin_verdict("不能放在这里".into(), "invalid".into());
        let t = slot(1);
        let out = s.moved(5, 5, Some(&t));
        assert!(!out.iter().any(|o| matches!(o, Out::Hover(_))));
        assert!(renders(&out).is_empty());
        let out = s.released(5, 5, Some(&t));
        assert!(!out.iter().any(|o| matches!(o, Out::Dropped { .. } | Out::Finished)));
        assert_eq!(s.ending(), Some(Ending::Released));
    }

    #[test]
    fn release_over_a_slot_drops_there_and_finishes() {
        let mut s = Session::new();
        s.begin();
        s.attach_reference(reference());
        let t = slot(2);
        let out = s.released(5, 5, Some(&t));
        assert!(out.contains(&Out::Dropped { surface: "generate", target: 2, reference: reference() }));
        assert!(out.contains(&Out::Hide));
        assert_eq!(out.last(), Some(&Out::Finished));
        assert_eq!(s.ending(), Some(Ending::Dropped));
        // nothing after the end
        assert!(s.moved(1, 1, None).is_empty());
        assert!(s.released(5, 5, Some(&t)).is_empty());
    }

    #[test]
    fn plugin_end_after_the_release_is_that_release_and_with_the_button_down_a_cancel() {
        let mut s = Session::new();
        s.begin();
        s.attach_reference(reference());
        let t = slot(3);
        let out = s.plugin_end(false, 5, 5, Some(&t));
        assert!(out.iter().any(|o| matches!(o, Out::Dropped { target: 3, .. })));

        let mut s = Session::new();
        s.begin();
        s.attach_reference(reference());
        let out = s.plugin_end(true, 5, 5, Some(&t));
        assert_eq!(out, vec![Out::Hide]);
        assert_eq!(s.ending(), Some(Ending::Cancelled));
    }

    #[test]
    fn external_text_sits_between_native_targets_and_the_plugin() {
        let mut s = Session::new();
        s.begin();
        s.plugin_verdict("不能放在这里".into(), "invalid".into());
        let out = s.set_external(Some(("复制到这里".into(), "copy".into())));
        assert_eq!(renders(&out), vec![("复制到这里".to_string(), "copy".to_string())]);
        s.attach_reference(reference());
        let t = slot(1);
        assert_eq!(renders(&s.moved(5, 5, Some(&t))), vec![("放入参考图".to_string(), "move".to_string())]);
        assert_eq!(renders(&s.moved(50, 50, None)), vec![("复制到这里".to_string(), "copy".to_string())]);
        assert_eq!(renders(&s.set_external(None)), vec![("不能放在这里".to_string(), "invalid".to_string())]);
    }

    #[test]
    fn release_during_a_system_drag() {
        let t = slot(1);
        assert_eq!(release_decision(Some(&t), true), Release::Native);
        assert_eq!(release_decision(None, true), Release::Cancel);
        assert_eq!(release_decision(None, false), Release::Drop);
    }

    #[test]
    fn a_finished_system_drag_ends_the_session_once() {
        let mut s = Session::new();
        s.begin();
        s.attach_reference(reference());
        assert_eq!(s.external_ended(), vec![Out::Hide, Out::Finished]);
        assert_eq!(s.ending(), Some(Ending::Released));
        assert!(s.external_ended().is_empty());
    }

    #[test]
    fn escape_ends_without_dropping() {
        let mut s = Session::new();
        s.begin();
        s.attach_reference(reference());
        let t = slot(1);
        s.moved(5, 5, Some(&t));
        let out = s.escape();
        assert_eq!(out, vec![Out::Hover(None), Out::Hide, Out::Finished]);
        assert_eq!(s.ending(), Some(Ending::Escape));
    }
}
