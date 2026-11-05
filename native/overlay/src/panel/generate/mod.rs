// 外置生成面板 (surface "generate"): the plugin's generate page drawn natively. `state` is what it
// shows, `view` draws it, `demo` runs it with made-up data (--demo); this file is the surface: it
// takes the plugin's sections (src/core/overlay/generatePanel.ts GenerateSections) and turns the
// user's actions into the plugin's GenerateAction JSON.

pub mod demo;
pub mod state;
pub mod view;

use std::time::{Duration, Instant};

use eframe::egui;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{ExternalLayerDrag, Surface};
use state::{
    Action, Mode, PanelState, Param, RefSlot, Reference, Run, Tone,
    MAX_REFERENCE_THUMB_URL_LEN, MAX_REFERENCE_SLOTS,
};

/// the prompt goes to the plugin once typing pauses this long
const PROMPT_PAUSE: Duration = Duration::from_millis(300);

pub struct GenerateSurface {
    s: PanelState,
    /// the prompt typed here, waiting for a pause
    prompt_due: Option<Instant>,
    /// decoded once per dragged layer; the source sends only its cached small thumbnail
    drag_preview: Option<(String, Option<egui::TextureHandle>)>,
}

impl GenerateSurface {
    pub fn new() -> Self {
        GenerateSurface {
            s: PanelState::empty(),
            prompt_due: None,
            drag_preview: None,
        }
    }
}

impl PanelState {
    /// before the plugin's first state arrives
    pub fn empty() -> Self {
        PanelState {
            mode: None,
            prompt: String::new(),
            hint: String::new(),
            favorites: Vec::new(),
            refs: Vec::new(),
            count: 1,
            action: "生成".into(),
            blocked: Some("等待插件…".into()),
            params: Vec::new(),
            running: None,
            status: None,
            fav_open: false,
            adv_open: false,
            ref_menu: None,
            count_text: "1".into(),
            prompt_focused: false,
            count_focused: false,
            external_drag: None,
        }
    }
}

// ── the plugin's sections ──

#[derive(Deserialize)]
struct RefIn {
    slot: u32,
    tag: Option<String>,
    name: Option<String>,
    #[serde(default)]
    thumb: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ParamIn {
    Number {
        key: String,
        label: String,
        value: f64,
        base: f64,
        min: f64,
        max: f64,
        int: bool,
    },
    Toggle {
        key: String,
        label: String,
        value: bool,
        #[serde(default)]
        tip: String,
    },
    Seed {
        random: bool,
        value: f64,
    },
}

#[derive(Deserialize)]
struct RunIn {
    stage: String,
    progress: f32,
}

#[derive(Deserialize)]
struct StatusIn {
    tone: String,
    text: String,
}

fn get<T: for<'de> Deserialize<'de>>(sections: &Map<String, Value>, name: &str) -> Option<T> {
    sections
        .get(name)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

impl Surface for GenerateSurface {
    fn id(&self) -> &'static str {
        "generate"
    }

    fn size(&self) -> egui::Vec2 {
        egui::vec2(340.0, 560.0)
    }

    fn set_external_layer_drag(&mut self, drag: Option<ExternalLayerDrag>) {
        if drag.is_none() {
            self.drag_preview = None;
        }
        self.s.external_drag = drag;
    }

    fn has_external_layer_drag(&self) -> bool {
        self.s.external_drag.is_some()
    }

    fn apply(&mut self, sections: &Map<String, Value>) {
        let s = &mut self.s;
        if let Some(m) = get::<String>(sections, "mode") {
            s.mode = Mode::from_key(&m);
        }
        // what is being typed here wins over the plugin's (older) copy
        if let Some(p) = get::<String>(sections, "prompt") {
            if !s.prompt_focused && self.prompt_due.is_none() {
                s.prompt = p;
            }
        }
        if let Some(h) = get(sections, "hint") {
            s.hint = h;
        }
        if let Some(f) = get(sections, "favorites") {
            s.favorites = f;
        }
        if let Some(refs) = get::<Vec<RefIn>>(sections, "refs") {
            let previous = std::mem::take(&mut s.refs);
            s.refs = refs
                .into_iter()
                .filter(|r| (1..=MAX_REFERENCE_SLOTS).contains(&r.slot))
                .map(|r| {
                    let raw_thumb = r.thumb;
                    let thumb = raw_thumb.as_ref().filter(|url| {
                        (url.starts_with("data:image/png;base64,")
                            || url.starts_with("data:image/jpeg;base64,"))
                            && url.len() <= MAX_REFERENCE_THUMB_URL_LEN
                    }).cloned();
                    let invalid_thumb = raw_thumb.is_some() && thumb.is_none();
                    if invalid_thumb {
                        let url = raw_thumb.as_deref().unwrap_or_default();
                        crate::log::line(format!(
                            "reference thumbnail rejected slot={} name={} url_bytes={} mime={}",
                            r.slot,
                            r.name.as_deref().unwrap_or(""),
                            url.len(),
                            url.split(',').next().unwrap_or("unknown")
                        ));
                    }
                    let cached = previous
                        .iter()
                        .find(|old| old.slot == r.slot)
                        .and_then(|old| old.filled.as_ref())
                        .filter(|old| old.thumb == thumb);
                    let (texture, cached_error) = cached
                        .map(|old| (old.texture.clone(), old.texture_error.clone()))
                        .unwrap_or((None, None));
                    let texture_error = if invalid_thumb {
                        Some("缩略图格式或大小不受支持".to_string())
                    } else {
                        cached_error
                    };
                    RefSlot {
                        slot: r.slot,
                        filled: r.name.map(|name| Reference {
                            tag: r.tag.unwrap_or_default(),
                            name,
                            thumb,
                            texture,
                            texture_error,
                        }),
                    }
                })
                .collect();
        }
        if let Some(n) = get::<u32>(sections, "count") {
            s.count = n;
            if !s.count_focused {
                s.count_text = n.to_string();
            }
        }
        if let Some(a) = get(sections, "action") {
            s.action = a;
        }
        if sections.contains_key("blocked") {
            s.blocked = get(sections, "blocked");
        }
        if let Some(params) = get::<Vec<ParamIn>>(sections, "params") {
            s.params = params
                .into_iter()
                .map(|p| match p {
                    ParamIn::Number {
                        key,
                        label,
                        value,
                        base,
                        min,
                        max,
                        int,
                    } => Param::Number {
                        key,
                        label,
                        value,
                        base,
                        min,
                        max,
                        int,
                    },
                    ParamIn::Toggle {
                        key,
                        label,
                        value,
                        tip,
                    } => Param::Toggle {
                        key,
                        label,
                        value,
                        tip,
                    },
                    ParamIn::Seed { random, value } => Param::Seed {
                        random,
                        value: value.max(0.0) as u64,
                    },
                })
                .collect();
        }
        if sections.contains_key("run") {
            s.running = get::<RunIn>(sections, "run").map(|r| Run {
                stage: r.stage,
                progress: r.progress,
            });
        }
        if let Some(st) = get::<StatusIn>(sections, "status") {
            let tone = match st.tone.as_str() {
                "ok" => Tone::Ok,
                "error" => Tone::Error,
                _ => Tone::Info,
            };
            s.status = Some((tone, st.text));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui) -> Vec<Value> {
        let mut out = Vec::new();
        let thumb_url = self
            .s
            .external_drag
            .as_ref()
            .and_then(|drag| drag.thumb.as_deref());
        if self.drag_preview.as_ref().map(|(url, _)| url.as_str()) != thumb_url {
            self.drag_preview = thumb_url.map(|url| {
                let texture = match view::drag_preview_texture(ui.ctx(), &url) {
                    Ok(texture) => Some(texture),
                    Err(error) => {
                        crate::log::line(format!("layer drag thumbnail decode failed: {error}"));
                        None
                    }
                };
                (url.to_string(), texture)
            });
        }
        let drag_preview = self
            .drag_preview
            .as_ref()
            .and_then(|(_, texture)| texture.as_ref());
        for a in view::panel(ui, &mut self.s, drag_preview) {
            match a {
                // held until typing pauses (due)
                Action::SetPrompt(_) => self.prompt_due = Some(Instant::now() + PROMPT_PAUSE),
                other => {
                    // anything else sends the pending prompt first, so it arrives in order
                    if self.prompt_due.take().is_some() {
                        out.push(json!({ "kind": "set-prompt", "text": self.s.prompt }));
                    }
                    out.push(action_json(&other));
                }
            }
        }
        if self.s.external_drag.is_none() {
            self.drag_preview = None;
        }
        out
    }

    fn due(&mut self, now: Instant) -> Vec<Value> {
        match self.prompt_due {
            Some(t) if now >= t => {
                self.prompt_due = None;
                vec![json!({ "kind": "set-prompt", "text": self.s.prompt })]
            }
            _ => Vec::new(),
        }
    }

    fn next_due(&self) -> Option<Instant> {
        let drag_due = self.s.external_drag.as_ref().map(|_| Instant::now() + Duration::from_millis(16));
        match (self.prompt_due, drag_due) {
            (Some(prompt), Some(drag)) => Some(prompt.min(drag)),
            (Some(prompt), None) => Some(prompt),
            (None, Some(drag)) => Some(drag),
            (None, None) => None,
        }
    }
}

/// An action as the plugin's GenerateAction (src/core/overlay/generatePanel.ts).
fn action_json(a: &Action) -> Value {
    match a {
        Action::SetMode(m) => json!({ "kind": "set-mode", "mode": m.key() }),
        Action::SetPrompt(t) => json!({ "kind": "set-prompt", "text": t }),
        Action::ToggleFavorite => json!({ "kind": "toggle-favorite" }),
        Action::PickFavorite(t) => json!({ "kind": "pick-favorite", "text": t }),
        Action::RemoveFavorite(t) => json!({ "kind": "remove-favorite", "text": t }),
        Action::AddRef { slot, source } => {
            json!({ "kind": "add-ref", "slot": slot, "source": format!("{source:?}").to_lowercase() })
        }
        Action::RemoveRef(slot) => json!({ "kind": "remove-ref", "slot": slot }),
        Action::DropRefs { slot, doc_id, layers, total_count } => json!({
            "kind": "drop-refs",
            "slot": slot,
            "docId": doc_id,
            "layers": layers,
            "totalCount": total_count,
        }),
        Action::FinishLayerDrag => json!({ "kind": "finish-layer-drag" }),
        Action::SetCount(n) => json!({ "kind": "set-count", "count": n }),
        Action::SetNumber { key, value } => {
            json!({ "kind": "set-number", "key": key, "value": value })
        }
        Action::ResetNumber(key) => json!({ "kind": "reset-number", "key": key }),
        Action::SetToggle { key, value } => {
            json!({ "kind": "set-toggle", "key": key, "value": value })
        }
        Action::SetSeed { random, value } => {
            json!({ "kind": "set-seed", "random": random, "value": value })
        }
        Action::NewSeed => json!({ "kind": "new-seed" }),
        Action::Generate => json!({ "kind": "generate" }),
        Action::Cancel => json!({ "kind": "cancel" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_sections() {
        let mut g = GenerateSurface::new();
        let sections: Map<String, Value> = serde_json::from_str(r#"{
            "mode":"blend","prompt":"杯子","hint":"可选","favorites":["a"],"count":2,"action":"融图","blocked":null,
            "refs":[{"slot":1,"tag":"图2","name":"x.png","thumb":"data:image/png;base64,AAAA"},{"slot":2,"tag":null,"name":null},{"slot":8,"tag":"图9","name":"eight.png"},{"slot":9,"tag":"图10","name":"ignored"}],
            "params":[{"kind":"number","key":"3.steps","label":"步数","value":8,"base":8,"min":1,"max":50,"int":true},
                      {"kind":"seed","random":true,"value":42},{"kind":"toggle","key":"fullRun","label":"完整","value":false,"tip":""}],
            "run":{"stage":"生成中","progress":0.5},"status":{"tone":"ok","text":"就绪"}}"#).unwrap();
        g.apply(&sections);
        assert_eq!(g.s.refs.len(), 3, "native reference slots must be capped at eight");
        assert_eq!(g.s.mode, Some(Mode::Blend));
        assert_eq!(g.s.prompt, "杯子");
        assert_eq!(g.s.count_text, "2");
        assert_eq!(g.s.blocked, None);
        assert_eq!(g.s.refs.len(), 3);
        assert_eq!(g.s.refs[2].slot, 8);
        assert!(g.s.refs[0].filled.is_some() && g.s.refs[1].filled.is_none());
        assert_eq!(
            g.s.refs[0].filled.as_ref().and_then(|r| r.thumb.as_deref()),
            Some("data:image/png;base64,AAAA")
        );
        assert_eq!(g.s.params.len(), 3);
        assert!(g.s.running.is_some());
        // a later section that only says `blocked` leaves the rest alone
        g.apply(&serde_json::from_str(r#"{"blocked":"请先建立选区","run":null}"#).unwrap());
        assert_eq!(g.s.blocked.as_deref(), Some("请先建立选区"));
        assert!(g.s.running.is_none());
        assert_eq!(g.s.prompt, "杯子");
        // a mode without a tab here
        g.apply(&serde_json::from_str(r#"{"mode":"upscale"}"#).unwrap());
        assert_eq!(g.s.mode, None);
    }

    #[test]
    fn reference_thumbnails_are_rejected_with_a_diagnostic_instead_of_silently_disappearing() {
        let mut g = GenerateSurface::new();
        let sections: Map<String, Value> = serde_json::from_str(r#"{
            "refs":[{"slot":1,"tag":"图2","name":"ref.png","thumb":"data:image/webp;base64,AAAA"}]
        }"#).unwrap();
        g.apply(&sections);
        let r = g.s.refs[0].filled.as_ref().unwrap();
        assert!(r.thumb.is_none());
        assert!(r.texture_error.as_deref().unwrap().contains("不受支持"));
    }

    #[test]
    fn reference_thumbnail_limit_accepts_uxp_sized_png_urls() {
        let mut g = GenerateSurface::new();
        let url = format!("data:image/png;base64,{}", "A".repeat(MAX_REFERENCE_THUMB_URL_LEN - 22));
        let sections = serde_json::json!({"refs":[{"slot":1,"tag":"图2","name":"ref.png","thumb":url}]});
        g.apply(sections.as_object().unwrap());
        let r = g.s.refs[0].filled.as_ref().unwrap();
        assert!(r.thumb.is_some());
        assert!(r.texture_error.is_none());
    }

    #[test]
    fn actions_match_the_plugin() {
        assert_eq!(
            action_json(&Action::SetMode(Mode::Txt2img)),
            json!({ "kind": "set-mode", "mode": "txt2img" })
        );
        assert_eq!(
            action_json(&Action::SetSeed {
                random: false,
                value: 7
            }),
            json!({ "kind": "set-seed", "random": false, "value": 7 })
        );
        assert_eq!(
            action_json(&Action::AddRef {
                slot: 1,
                source: state::RefSource::Clipboard
            }),
            json!({ "kind": "add-ref", "slot": 1, "source": "clipboard" })
        );
    }

    #[test]
    fn drop_refs_action_matches_the_plugin_protocol() {
        assert_eq!(
            action_json(&Action::DropRefs {
                slot: 2,
                doc_id: 7,
                layers: vec![
                    super::super::DraggedLayer { layer_id: 42, name: "产品图层".into() },
                    super::super::DraggedLayer { layer_id: 43, name: "杯子".into() },
                ],
                total_count: 2,
            }),
            json!({ "kind": "drop-refs", "slot": 2, "docId": 7, "layers": [
                { "layerId": 42, "name": "产品图层" }, { "layerId": 43, "name": "杯子" }
            ], "totalCount": 2 })
        );
    }

    #[test]
    fn finish_layer_drag_action_matches_the_plugin_protocol() {
        assert_eq!(action_json(&Action::FinishLayerDrag), json!({ "kind": "finish-layer-drag" }));
    }

    #[test]
    fn external_layer_drag_requests_repaint_until_released() {
        let mut g = GenerateSurface::new();
        assert!(g.next_due().is_none());
        g.set_external_layer_drag(Some(ExternalLayerDrag {
            doc_id: 7,
            layers: vec![super::super::DraggedLayer { layer_id: 42, name: "产品".into() }],
            total_count: 1,
            thumb: None,
        }));
        assert!(g.has_external_layer_drag());
        assert!(g.next_due().is_some());
        g.set_external_layer_drag(None);
        assert!(!g.has_external_layer_drag());
        assert!(g.next_due().is_none());
    }

    #[test]
    fn prompt_waits_for_a_pause() {
        let mut g = GenerateSurface::new();
        g.prompt_due = Some(Instant::now());
        g.s.prompt = "夕阳".into();
        assert_eq!(
            g.due(Instant::now() + Duration::from_millis(1)),
            vec![json!({ "kind": "set-prompt", "text": "夕阳" })]
        );
        assert!(g.due(Instant::now()).is_empty());
    }
}

