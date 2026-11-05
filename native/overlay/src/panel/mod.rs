// External surfaces (外附介面) drawn with egui. A surface is plugin UI shown outside the UXP
// panels: it keeps only what it draws, the plugin sends it state in named sections and gets its
// actions back (src/core/overlay/hub.ts on the plugin side). `host.rs` owns the window, the
// connection and showing / hiding; a surface only implements `Surface`.
//
// Adding a surface: HANDOFF.md 「新增一個外附介面」. The generate panel (generate/) is the model.

pub mod generate;
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
}

#[derive(Clone, Debug)]
pub struct ExternalLayerDrag {
    pub doc_id: u32,
    pub layers: Vec<DraggedLayer>,
    pub total_count: usize,
    pub thumb: Option<String>,
}

pub trait Surface {
    /// the `panel` name in every message (the same string as the plugin's surface id)
    fn id(&self) -> &'static str;
    /// the size the window opens at, in logical pixels (scaled to the monitor by the host)
    fn size(&self) -> egui::Vec2;
    /// takes in sections of state from the plugin (only those that changed)
    fn apply(&mut self, sections: &Map<String, Value>);
    /// optional external drag source state (e.g. a WaveLayer row dragged over the native panel)
    fn set_external_layer_drag(&mut self, _drag: Option<ExternalLayerDrag>) {}
    /// whether this surface still owns a pending cross-window drag
    fn has_external_layer_drag(&self) -> bool {
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
