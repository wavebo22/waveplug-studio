//! Who decides what a WaveLayer drag would do at the cursor.
//!
//! The plugin only sees its own UXP panel: outside it, every position looks the same to it. This
//! helper is the one process that sees the global cursor, so it arbitrates. Rule: a native target
//! (our own panels today; other applications through OLE later, see CROSS_APP_DRAG_DROP_SPEC.md)
//! that claims the cursor wins, because it sits on top of whatever the plugin sees and it is what
//! receives the release; otherwise the plugin's verdict for its own panel stands.
//!
//! A target that reports a verdict must decide its release with the same hit test, so the card
//! never says one thing while letting go does another.

#[derive(Clone, Debug, PartialEq)]
pub struct DropVerdict {
    /// what letting go does, shown on the drag card
    pub action: String,
    /// card colour: move / copy / delete / workbench / invalid
    pub tone: String,
    /// who decided: "plugin" or the native target's id (logged)
    pub source: &'static str,
}

impl DropVerdict {
    pub fn new(action: impl Into<String>, tone: impl Into<String>, source: &'static str) -> Self {
        Self { action: action.into(), tone: tone.into(), source }
    }
}

/// The first native target that claims the cursor, else the plugin's verdict.
pub fn resolve(native: impl IntoIterator<Item = Option<DropVerdict>>, plugin: DropVerdict) -> DropVerdict {
    native.into_iter().flatten().next().unwrap_or(plugin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_verdict_stands_when_no_native_target_claims_the_cursor() {
        let plugin = DropVerdict::new("移动到「背景」上方", "move", "plugin");
        assert_eq!(resolve([None, None], plugin.clone()), plugin);
    }

    #[test]
    fn a_native_target_under_the_cursor_overrides_the_plugin() {
        let plugin = DropVerdict::new("拖到参考图槽位上", "invalid", "plugin");
        let slot = DropVerdict::new("放入参考图", "move", "generate");
        assert_eq!(resolve([None, Some(slot.clone())], plugin), slot);
    }

    #[test]
    fn the_first_claiming_target_wins() {
        let plugin = DropVerdict::new("不能放在这里", "invalid", "plugin");
        let a = DropVerdict::new("放入参考图", "move", "generate");
        let b = DropVerdict::new("复制到其他软件", "copy", "ole");
        assert_eq!(resolve([Some(a.clone()), Some(b)], plugin), a);
    }
}
