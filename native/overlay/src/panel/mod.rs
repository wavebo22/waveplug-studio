// External surfaces (外附介面) drawn with egui. A surface is plugin UI shown outside the UXP
// panels: it keeps only what it draws, the plugin sends it state in named sections and gets its
// actions back (src/core/overlay/hub.ts on the plugin side). `host.rs` owns the window, the
// connection and showing / hiding; a surface only implements `Surface`.
//
// Adding a surface: HANDOFF.md 「新增一個外附介面」. The generate panel (generate/) is the model.

pub mod check;
pub mod generate;
pub mod organize;
pub mod shelf;
pub mod theme;
pub mod variants;

use std::time::Instant;

use eframe::egui;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraggedLayer {
    pub layer_id: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExternalLayerDrag {
    pub doc_id: u32,
    pub layers: Vec<DraggedLayer>,
    pub total_count: usize,
}

/// What a surface's bar says (the strip it folds into, also its footer while open).
#[derive(Clone, Debug, PartialEq)]
pub struct BarInfo {
    /// the mode / subject, drawn after the title
    pub mode: String,
    /// what is going on, right-aligned and cut to fit
    pub text: String,
    pub tone: BarTone,
    /// a run's progress (0–1): drawn as a thin line along the bar
    pub progress: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarTone {
    Ok,
    Quiet,
    Busy,
    Warn,
    Error,
}

pub trait Surface {
    /// the `panel` name in every message (the same string as the plugin's surface id)
    fn id(&self) -> &'static str;
    /// the size the window opens at, in logical pixels (scaled to the monitor by the host)
    fn size(&self) -> egui::Vec2;
    /// takes in sections of state from the plugin (only those that changed)
    fn apply(&mut self, sections: &Map<String, Value>);
    /// a WaveLayer reference drag started (Some) or ended (None); while it runs the surface
    /// publishes its drop targets (crate::drag::targets) and highlights crate::drag::hovered()
    fn set_external_layer_drag(&mut self, _drag: Option<ExternalLayerDrag>) {}
    /// the drag engine saw the release over this surface's target `target`: the actions to send
    /// (the same hit test that drew the card decided it, drag/session.rs)
    fn external_drop(&mut self, _target: u32, _reference: &crate::drag::Reference) -> Vec<Value> {
        Vec::new()
    }
    /// what its bar says; None: the surface has no bar
    fn bar(&self) -> Option<BarInfo> {
        None
    }
    /// keep a temporarily collapsed surface expanded while it has ongoing work or local UI state
    fn keep_expanded(&self) -> bool {
        false
    }
    /// draws the surface; returns the user's actions, as the surface's JSON, to send to the plugin
    fn ui(&mut self, ui: &mut egui::Ui) -> Vec<Value>;
    /// called every frame: actions the surface held back to send now (a prompt typed a while ago)
    fn due(&mut self, _now: Instant) -> Vec<Value> {
        Vec::new()
    }
    /// when it next needs `due` called without user input, if ever
    fn next_due(&self) -> Option<Instant> {
        None
    }
}
