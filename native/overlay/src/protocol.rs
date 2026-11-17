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
        #[allow(dead_code)] // legacy single-thumbnail field from older UXP bundles
        thumb: Option<String>,
    },
    /// Cancel a pending cross-panel drop (Escape or source panel cancellation).
    LayerDragCancel,
    /// Show the independent cursor-following card for any WaveLayer drag.
    LayerDragPreviewStart {
        #[serde(default)]
        layers: Vec<DraggedLayer>,
        #[serde(rename = "totalCount", default)]
        total_count: usize,
    },
    /// Update the action label and colour without rebuilding the preview thumbnails.
    LayerDragPreviewUpdate {
        action: String,
        tone: String,
    },
    /// Hide the independent cursor-following drag card.
    LayerDragPreviewEnd,
    /// 外置删除区 for the drag under way (drag/trash.rs): `view` the canvas on screen, `enabled`
    /// whether what is dragged can be deleted, `action` what the card says over it.
    LayerDragTrash {
        #[serde(default)]
        view: Option<ScreenRect>,
        #[serde(default)]
        enabled: bool,
        #[serde(default)]
        action: String,
    },
    /// A WaveLayer row is hovered: a thin click-through frame around `rect`, cut to `clip`
    /// (Photoshop's canvas view); `rect: null` takes it away. Drawn by frame.rs.
    HoverFrame {
        #[serde(default)]
        rect: Option<ScreenRect>,
        #[serde(default)]
        clip: Option<ScreenRect>,
    },
    /// 性能监视 (monitor.rs): the small click-through box in the canvas's bottom-right corner with
    /// CPU / memory / GPU / Photoshop / ComfyUI numbers. `comfy`: ComfyUI's address for its row.
    Monitor {
        on: bool,
        #[serde(default)]
        comfy: Option<String>,
        #[serde(default)]
        view: Option<ScreenRect>,
    },
    /// 卡死保护 (hang.rs): after `seconds` without an answer from Photoshop, a dialog offers to back
    /// up its auto-recovery files (beside the matching document in `docs`), wait, or close it.
    HangGuard {
        on: bool,
        #[serde(rename = "autoBackup", default)]
        auto_backup: bool,
        #[serde(default = "hang_seconds")]
        seconds: u64,
        #[serde(default)]
        docs: Vec<crate::hang::DocInfo>,
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
    /// A WaveLayer drag left the panel: the plugin is exporting `totalCount` layers as PNG for a
    /// possible drag to another program (docs/CROSS_APP_DRAG_DROP_SPEC.md 7.3).
    ExternalDragPrepare {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "docId", default)]
        #[allow(dead_code)] // logged by the plugin; the helper only needs the files
        doc_id: u32,
        #[serde(rename = "totalCount", default)]
        total_count: usize,
        /// each layer's version key, for reusing earlier exports (answered by external-drag-cached)
        #[serde(default)]
        keys: Vec<String>,
    },
    /// The exported files (paths in the plugin's temporary folder, layer order in `order`).
    ExternalDragReady {
        #[serde(rename = "sessionId")]
        session_id: String,
        files: Vec<crate::drag::transfer::SourceFile>,
    },
    /// One more layer is exported (`done` of `total`): the card shows how far it is.
    ExternalDragProgress {
        #[serde(rename = "sessionId")]
        session_id: String,
        done: usize,
        #[serde(default)]
        #[allow(dead_code)] // the helper already knows the total from prepare
        total: usize,
    },
    /// WaveLayer's right-click menu: shown as a native menu at the cursor (menu.rs); the row
    /// picked comes back as `menu-result`.
    MenuOpen {
        #[serde(rename = "menuId")]
        menu_id: String,
        #[serde(default)]
        title: String,
        items: Vec<crate::menu::MenuNode>,
    },
    /// Take the menu away (Esc in the plugin, the document changed); no id: whatever is open.
    MenuClose {
        #[serde(rename = "menuId", default)]
        menu_id: Option<String>,
    },
    /// The plugin's settings for what this program does (性能监视, 卡死保护, ComfyUI…), sent when
    /// it connects and whenever one changes: the app window's 功能设置 shows and edits them.
    AppSettings {
        settings: Map<String, Value>,
    },
    /// The panel's settings button: open the app window on `tab` ("settings": 功能设置, where all
    /// the settings live now).
    OpenApp {
        #[serde(default)]
        tab: String,
    },
    /// 从网页拖入 (webdrop.rs): a drag without files entered the WaveLayer panel — put the catcher
    /// over the drop area (`left`/`top`/`width`/`height`, CSS px of the panel) so that the point
    /// `clientX`/`clientY` is under the cursor; images go into `folder`. `on: false` takes it away.
    WebCatch {
        on: bool,
        #[serde(rename = "clientX", default)]
        client_x: f64,
        #[serde(rename = "clientY", default)]
        client_y: f64,
        #[serde(default)]
        left: f64,
        #[serde(default)]
        top: f64,
        #[serde(default)]
        width: f64,
        #[serde(default)]
        height: f64,
        #[serde(default)]
        folder: String,
    },
    /// The drag ended in the plugin (or the export failed) before any system drag.
    ExternalDragCancel {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(default)]
        #[allow(dead_code)]
        reason: String,
    },
}

fn default_close_comfy() -> bool {
    true
}

fn hang_seconds() -> u64 {
    20
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
    /// Which of prepare's `keys` the helper already has exported: the plugin skips those.
    ExternalDragCached {
        #[serde(rename = "sessionId")]
        session_id: String,
        keys: Vec<String>,
    },
    /// The exported files are in the helper's cache: the plugin may delete its copies.
    ExternalDragFilesCopied {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// The drag to another program ended: dropped / cancelled / rejected / error; effect copy / none.
    /// `target` is the program it was let go over by name ("微信", "文件夹"…), `count` the files.
    ExternalDragFinished {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: &'static str,
        effect: &'static str,
        target: String,
        count: usize,
    },
    /// The WaveLayer drag was let go over the 外置删除区: the plugin deletes what it was dragging.
    LayerDragTrashDrop,
    /// 功能设置 changed in the app window: the plugin applies and saves `changes` (its settings keys).
    AppSettingsSet {
        changes: Value,
    },
    /// 导出诊断信息 in the app window: the plugin writes its own report into `folder`.
    PluginReport {
        folder: String,
    },
    /// 从网页拖入: the drag left the catcher (or never reached it): the plugin hides its overlay.
    WebDropLeave,
    /// 从网页拖入: let go over the catcher. `files` written into the plugin's folder; `html`,
    /// `text`, `url` what else it carried; `formats` what it offered (logged).
    WebDrop {
        files: Vec<crate::webdrop::DroppedFile>,
        html: String,
        text: String,
        url: String,
        formats: Vec<String>,
    },
    /// The row picked in the menu `menu_id` (its id), or none when it was closed.
    MenuResult {
        #[serde(rename = "menuId")]
        menu_id: String,
        item: Option<String>,
    },
}

pub fn parse(text: &str) -> Option<Command> {
    serde_json::from_str(text).ok()
}

pub fn encode(ev: &Event) -> String {
    serde_json::to_string(ev).unwrap_or_default()
}

#[cfg(test)]
mod external_drag_tests {
    use super::*;

    #[test]
    fn parses_the_external_drag_commands() {
        assert!(matches!(
            parse(r#"{"type":"external-drag-prepare","sessionId":"d1","docId":7,"totalCount":2}"#),
            Some(Command::ExternalDragPrepare { session_id, total_count: 2, .. }) if session_id == "d1"
        ));
        match parse(r#"{"type":"external-drag-ready","sessionId":"d1","files":[{"layerId":42,"name":"标题","path":"C:/t/a.png","order":0}]}"#) {
            Some(Command::ExternalDragReady { session_id, files }) => {
                assert_eq!(session_id, "d1");
                assert_eq!(files[0].layer_id, 42);
                assert_eq!(files[0].path, "C:/t/a.png");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse(r#"{"type":"external-drag-progress","sessionId":"d1","done":2,"total":5}"#),
            Some(Command::ExternalDragProgress { done: 2, .. })
        ));
        assert!(matches!(
            parse(r#"{"type":"external-drag-cancel","sessionId":"d1","reason":"internal-drop"}"#),
            Some(Command::ExternalDragCancel { .. })
        ));
    }

    #[test]
    fn encodes_the_external_drag_events() {
        assert_eq!(
            encode(&Event::ExternalDragFilesCopied { session_id: "d1".into() }),
            r#"{"type":"external-drag-files-copied","sessionId":"d1"}"#
        );
        assert_eq!(
            encode(&Event::ExternalDragCached { session_id: "d1".into(), keys: vec!["k1".into()] }),
            r#"{"type":"external-drag-cached","sessionId":"d1","keys":["k1"]}"#
        );
        assert_eq!(
            encode(&Event::ExternalDragFinished { session_id: "d1".into(), status: "dropped", effect: "copy", target: "微信".into(), count: 2 }),
            r#"{"type":"external-drag-finished","sessionId":"d1","status":"dropped","effect":"copy","target":"微信","count":2}"#
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_the_hang_guard() {
        match parse(r#"{"type":"hang-guard","on":true,"autoBackup":true,"seconds":30,"docs":[{"name":"a.psd","path":"D:\\a.psd"},{"name":"未标题-1"}]}"#) {
            Some(Command::HangGuard { on: true, auto_backup: true, seconds: 30, docs }) => {
                assert_eq!(docs.len(), 2);
                assert_eq!(docs[0].path, "D:\\a.psd");
                assert_eq!(docs[1].path, "");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"hang-guard","on":false}"#), Some(Command::HangGuard { on: false, seconds: 20, .. })));
    }

    #[test]
    fn parses_the_monitor_switch() {
        match parse(r#"{"type":"monitor","on":true,"comfy":"http://127.0.0.1:8188"}"#) {
            Some(Command::Monitor { on: true, comfy: Some(c), view: None }) => assert_eq!(c, "http://127.0.0.1:8188"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"monitor","on":false}"#), Some(Command::Monitor { on: false, comfy: None, view: None })));
    }

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
        match parse(r#"{"type":"layer-drag-preview-start","layers":[{"layerId":42,"name":"产品","thumb":"data:image/png;base64,AAAA"}],"totalCount":1}"#) {
            Some(Command::LayerDragPreviewStart { layers, total_count: 1 }) => {
                assert_eq!(layers[0].layer_id, 42);
                assert_eq!(layers[0].thumb.as_deref(), Some("data:image/png;base64,AAAA"));
            }
            other => panic!("{other:?}"),
        }
        // Older UXP bundles may still include the now-ignored anchor fields.
        assert!(matches!(
            parse(r#"{"type":"layer-drag-preview-start","layers":[],"totalCount":0,"anchorX":0.1,"anchorY":0.9}"#),
            Some(Command::LayerDragPreviewStart { total_count: 0, .. })
        ));
        assert!(matches!(
            parse(r#"{"type":"layer-drag-preview-update","action":"删除","tone":"delete"}"#),
            Some(Command::LayerDragPreviewUpdate { tone, .. }) if tone == "delete"
        ));
        match parse(r#"{"type":"layer-drag-trash","view":{"left":0,"top":0,"right":800,"bottom":600},"enabled":true,"action":"松开删除 2 个图层"}"#) {
            Some(Command::LayerDragTrash { view: Some(v), enabled: true, action }) => {
                assert_eq!(v.right, 800.0);
                assert_eq!(action, "松开删除 2 个图层");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"layer-drag-trash","view":null}"#), Some(Command::LayerDragTrash { view: None, enabled: false, .. })));
        assert_eq!(serde_json::to_string(&Event::LayerDragTrashDrop).unwrap(), r#"{"type":"layer-drag-trash-drop"}"#);
        assert_eq!(serde_json::to_string(&Event::WebDropLeave).unwrap(), r#"{"type":"web-drop-leave"}"#);
        let drop = Event::WebDrop { files: vec![crate::webdrop::DroppedFile { file: "w.png".into(), name: "猫".into() }], html: String::new(), text: "t".into(), url: String::new(), formats: vec!["PNG".into()] };
        assert_eq!(serde_json::to_string(&drop).unwrap(), r#"{"type":"web-drop","files":[{"file":"w.png","name":"猫"}],"html":"","text":"t","url":"","formats":["PNG"]}"#);
        match parse(r#"{"type":"web-catch","on":true,"clientX":10,"clientY":20.5,"left":4,"top":4,"width":300,"height":500,"folder":"C:\\T"}"#) {
            Some(Command::WebCatch { on: true, client_x, client_y, width, folder, .. }) => {
                assert_eq!((client_x, client_y, width), (10.0, 20.5, 300.0));
                assert_eq!(folder, "C:\\T");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"web-catch","on":false}"#), Some(Command::WebCatch { on: false, .. })));
        assert!(matches!(
            parse(r#"{"type":"layer-drag-preview-end"}"#),
            Some(Command::LayerDragPreviewEnd)
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
