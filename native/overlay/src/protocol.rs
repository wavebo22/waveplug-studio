// Messages between the WavePlug panel (UXP, a WebSocket client) and this helper (the server).
// Same shapes as src/core/overlay/protocol.ts in the plugin; one JSON object per text frame.

use serde::{Deserialize, Serialize};

/// Port on 127.0.0.1. Change together with OVERLAY_PORT in src/core/overlay/protocol.ts.
pub const PORT: u16 = 47821;

/// plugin → helper
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Command {
    /// The panel connected (or reconnected).
    Hello,
    /// A selection was just made: show the bar, filled with the panel's prompt. `anchor` is the
    /// selection on screen (physical px, from Photoshop's view); the bar goes centred under it.
    Show {
        prompt: String,
        count: u32,
        #[serde(default)]
        anchor: Option<Anchor>,
    },
    /// The selection is gone (or the panel is busy): hide the bar.
    Hide,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Anchor {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// helper → plugin
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Ready { version: &'static str },
    /// 生成 was pressed (or Enter in the prompt box).
    Generate { prompt: String, count: u32 },
}

pub fn parse(text: &str) -> Option<Command> {
    serde_json::from_str(text).ok()
}

pub fn encode(ev: &Event) -> String {
    serde_json::to_string(ev).unwrap_or_default()
}

/// The 1–4 variation count, as the panel's own field allows.
pub fn clamp_count(n: u32) -> u32 {
    n.clamp(1, 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        match parse(r#"{"type":"show","prompt":"红色陶瓷杯","count":2}"#) {
            Some(Command::Show { prompt, count, anchor }) => { assert_eq!(prompt, "红色陶瓷杯"); assert_eq!(count, 2); assert!(anchor.is_none()); }
            other => panic!("{other:?}"),
        }
        match parse(r#"{"type":"show","prompt":"","count":1,"anchor":{"left":10,"top":20,"right":110,"bottom":220.5}}"#) {
            Some(Command::Show { anchor: Some(a), .. }) => { assert_eq!(a.left, 10.0); assert_eq!(a.bottom, 220.5); }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"hide"}"#), Some(Command::Hide)));
        assert!(matches!(parse(r#"{"type":"hello"}"#), Some(Command::Hello)));
        assert!(parse(r#"{"type":"nope"}"#).is_none());
        assert!(parse("not json").is_none());
    }

    #[test]
    fn encodes_events() {
        assert_eq!(encode(&Event::Generate { prompt: "杯子".into(), count: 3 }), r#"{"type":"generate","prompt":"杯子","count":3}"#);
        assert_eq!(clamp_count(0), 1);
        assert_eq!(clamp_count(9), 4);
    }
}
