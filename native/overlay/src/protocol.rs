// Messages between the WavePlug plugin (UXP, a WebSocket client) and this helper (the server).
// Same shapes as src/core/overlay/protocol.ts; one JSON object per text frame. Every message
// names its external surface (`panel`); a surface's `sections` and `action` are its own business
// (for the generate panel: panel/generate/sync.rs ⇄ src/core/overlay/generatePanel.ts).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use crate::panel::DraggedLayer;

/// Port on 127.0.0.1. Change together with OVERLAY_PORT in src/core/overlay/protocol.ts.
pub const PORT: u16 = 47821;

/// A screen rectangle in physical pixels (Photoshop's view bounds and Windows both use these).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct ScreenRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// plugin → helper
#[cfg_attr(not(windows), allow(dead_code))] // `view` is used by win.rs
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Command {
    /// The plugin connected (or reconnected): it resends everything, revisions start over.
    Hello,
    /// Put surface `panel` up, placed against `view` (Photoshop's canvas on screen).
    Show {
        panel: String,
        #[serde(default)]
        view: Option<ScreenRect>,
    },
    Hide {
        panel: String,
    },
    /// Some of the surface's state; `rev` only grows per surface (older ones are dropped).
    State {
        panel: String,
        rev: u64,
        sections: Map<String, Value>,
    },
    /// A notice in the bottom-right corner of `view` (shared, shown even with no surface up),
    /// gone after `ms` or a click.
    Toast {
        title: String,
        text: String,
        #[serde(default)]
        view: Option<ScreenRect>,
        #[serde(default = "toast_ms")]
        ms: u64,
    },
    /// WaveLayer started dragging one or more normal layers; the UI thread tracks the cursor until release.
    LayerDragStart {
        #[serde(rename = "docId")]
        doc_id: u32,
        #[serde(default)]
        layers: Vec<DraggedLayer>,
        #[serde(rename = "totalCount", default)]
        total_count: usize,
        // Legacy fields are accepted while an older UXP bundle is still loaded.
        #[serde(rename = "layerId", default)]
        layer_id: Option<u32>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        thumb: Option<String>,
    },
    /// Cancel a pending cross-panel drop (Escape or source panel cancellation).
    LayerDragCancel,
    /// A WaveLayer row is hovered: a thin click-through frame around `rect`, cut to `clip`
    /// (Photoshop's canvas view); `rect: null` takes it away. Drawn by frame.rs.
    HoverFrame {
        #[serde(default)]
        rect: Option<ScreenRect>,
        #[serde(default)]
        clip: Option<ScreenRect>,
    },
    /// Start or reconcile the local ComfyUI process without making the WebSocket thread wait.
    ManageComfy {
        path: String,
        base: String,
        #[serde(rename = "closeWithPhotoshop", default = "default_close_comfy")]
        close_with_photoshop: bool,
        #[serde(rename = "restartIfNeeded", default)]
        restart_if_needed: bool,
        #[serde(rename = "disableBrowser", default = "default_close_comfy")]
        disable_browser: bool,
        #[serde(rename = "startIfMissing", default = "default_close_comfy")]
        start_if_missing: bool,
        /// 重启: stop the ComfyUI this helper started and start it again (never an external one)
        #[serde(default)]
        restart: bool,
    },
    /// Settings → 重启外置框架: start this exe again and quit, keeping the managed ComfyUI.
    RestartHelper,
}

fn default_close_comfy() -> bool {
    true
}

fn toast_ms() -> u64 {
    8000
}

/// helper → plugin
#[cfg_attr(not(windows), allow(dead_code))] // ViewRequest comes from win.rs
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Ready {
        version: &'static str,
    },
    /// The user did something in surface `panel`; `action` is that surface's own.
    Action {
        panel: String,
        action: Value,
    },
    /// Photoshop's window moved or changed size: the plugin sends `show` again with the new view.
    ViewRequest {
        panel: String,
    },
    /// ComfyUI startup/ownership result shown in the plugin connection settings.
    ComfyStatus {
        state: String,
        message: String,
        owned: bool,
    },
}

pub fn parse(text: &str) -> Option<Command> {
    serde_json::from_str(text).ok()
}

pub fn encode(ev: &Event) -> String {
    serde_json::to_string(ev).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        match parse(
            r#"{"type":"show","panel":"generate","view":{"left":1008,"top":139,"right":3037,"bottom":2087}}"#,
        ) {
            Some(Command::Show {
                panel,
                view: Some(v),
            }) => {
                assert_eq!(panel, "generate");
                assert_eq!(v.right, 3037.0);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse(r#"{"type":"show","panel":"generate","view":null}"#),
            Some(Command::Show { view: None, .. })
        ));
        match parse(
            r#"{"type":"state","panel":"generate","rev":3,"sections":{"prompt":"杯子","count":2}}"#,
        ) {
            Some(Command::State {
                panel,
                rev,
                sections,
            }) => {
                assert_eq!(panel, "generate");
                assert_eq!(rev, 3);
                assert_eq!(sections["count"], 2);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse(r#"{"type":"hide","panel":"generate"}"#),
            Some(Command::Hide { .. })
        ));
        assert!(matches!(parse(r#"{"type":"hello"}"#), Some(Command::Hello)));
        assert!(matches!(
            parse(r#"{"type":"layer-drag-start","docId":7,"layerId":42,"name":"产品"}"#),
            Some(Command::LayerDragStart { doc_id: 7, layer_id: Some(42), name: Some(name), thumb: None, .. }) if name == "产品"
        ));
        assert!(matches!(
            parse(r#"{"type":"layer-drag-start","docId":7,"layerId":42,"name":"产品","thumb":"data:image/jpeg;base64,AAAA"}"#),
            Some(Command::LayerDragStart { doc_id: 7, layer_id: Some(42), name: Some(name), thumb: Some(thumb), .. })
                if name == "产品" && thumb == "data:image/jpeg;base64,AAAA"
        ));
        match parse(r#"{"type":"layer-drag-start","docId":7,"layers":[{"layerId":42,"name":"产品"},{"layerId":43,"name":"杯子"}],"totalCount":2,"thumb":"data:image/png;base64,AAAA"}"#) {
            Some(Command::LayerDragStart { doc_id: 7, layers, total_count: 2, layer_id: None, name: None, thumb: Some(thumb) }) => {
                assert_eq!(layers.len(), 2);
                assert_eq!(layers[0].layer_id, 42);
                assert_eq!(layers[1].name, "杯子");
                assert_eq!(thumb, "data:image/png;base64,AAAA");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse(r#"{"type":"layer-drag-cancel"}"#),
            Some(Command::LayerDragCancel)
        ));
        match parse(
            r#"{"type":"hover-frame","rect":{"left":10,"top":20,"right":110,"bottom":70},"clip":{"left":0,"top":0,"right":500,"bottom":400}}"#,
        ) {
            Some(Command::HoverFrame { rect: Some(r), clip: Some(c) }) => {
                assert_eq!(r.left, 10.0);
                assert_eq!(c.right, 500.0);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"restart-helper"}"#), Some(Command::RestartHelper)));
        assert!(matches!(
            parse(r#"{"type":"manage-comfy","path":"","base":"http://127.0.0.1:8188","restart":true}"#),
            Some(Command::ManageComfy { restart: true, .. })
        ));
        assert!(matches!(
            parse(r#"{"type":"hover-frame","rect":null}"#),
            Some(Command::HoverFrame { rect: None, clip: None })
        ));
        match parse(
            r#"{"type":"manage-comfy","path":"J:\\ComfyUI\\run.bat","base":"http://127.0.0.1:8188","closeWithPhotoshop":false,"restartIfNeeded":true}"#,
        ) {
            Some(Command::ManageComfy {
                path,
                base,
                close_with_photoshop,
                restart_if_needed,
                disable_browser,
                start_if_missing,
                restart,
            }) => {
                assert!(disable_browser);
                assert!(start_if_missing);
                assert!(!restart, "restart defaults to off");
                assert_eq!(path, "J:\\ComfyUI\\run.bat");
                assert_eq!(base, "http://127.0.0.1:8188");
                assert!(!close_with_photoshop);
                assert!(restart_if_needed);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse(r#"{"type":"manage-comfy","path":"","base":"http://127.0.0.1:8188"}"#),
            Some(Command::ManageComfy {
                close_with_photoshop: true,
                disable_browser: true,
                start_if_missing: true,
                ..
            })
        ));
        assert!(matches!(
            parse(
                r#"{"type":"manage-comfy","path":"C:\\foo.bat","base":"http://127.0.0.1:8188","disableBrowser":false,"startIfMissing":false}"#
            ),
            Some(Command::ManageComfy {
                disable_browser: false,
                start_if_missing: false,
                ..
            })
        ));
        match parse(
            r#"{"type":"toast","title":"图片生成完毕","text":"已加入 v3","view":null,"ms":6000}"#,
        ) {
            Some(Command::Toast {
                title,
                ms,
                view: None,
                ..
            }) => {
                assert_eq!(title, "图片生成完毕");
                assert_eq!(ms, 6000);
            }
            other => panic!("{other:?}"),
        }
        assert!(parse(r#"{"type":"show"}"#).is_none());
        assert!(parse("not json").is_none());
    }

    #[test]
    fn encodes_events() {
        let action = serde_json::json!({ "kind": "set-mode", "mode": "extract" });
        assert_eq!(
            encode(&Event::Action {
                panel: "generate".into(),
                action
            }),
            r#"{"type":"action","panel":"generate","action":{"kind":"set-mode","mode":"extract"}}"#
        );
        assert_eq!(
            encode(&Event::ViewRequest {
                panel: "generate".into()
            }),
            r#"{"type":"view-request","panel":"generate"}"#
        );
        assert_eq!(
            encode(&Event::Ready { version: "0.2.0" }),
            r#"{"type":"ready","version":"0.2.0"}"#
        );
        assert_eq!(
            encode(&Event::ComfyStatus {
                state: "ready".into(),
                message: "ComfyUI 已启动".into(),
                owned: true
            }),
            r#"{"type":"comfy-status","state":"ready","message":"ComfyUI 已启动","owned":true}"#
        );
    }
}
