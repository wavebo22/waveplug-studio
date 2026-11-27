// The settings panels (检查 / AI 整理 / 改写 before they start): one surface per feature in the
// canvas-corner window, the same form drawn for each (src/core/overlay/setupPanel.ts says what is
// in it: section "form" with a title, what it covers, fields, the start button, a note). The plugin
// decides when one is up (src/app/cornerSlot.ts: only after its button was clicked, only for that
// document). Actions: {"kind":"set","key","value"} for a field, "start", "close".
use eframe::egui::{self, RichText, Vec2};
use serde_json::{json, Map, Value};

use crate::panel::theme;
use crate::panel::Surface;

pub const CHECK_ID: &str = "check-setup";
pub const ORGANIZE_ID: &str = "organize-setup";
pub const REWRITE_ID: &str = "rewrite-setup";
/// a row's height (title bar, the start button's row)
const ROW_H: f32 = 28.0;

#[derive(Clone, Debug, PartialEq)]
pub enum Field {
    Toggle { key: String, label: String, tip: String, value: bool, disabled: bool },
    Choice { key: String, label: String, options: Vec<(String, String)>, value: String },
    Text { key: String, label: String, hint: String, value: String },
    Heading { label: String },
}

pub struct SetupSurface {
    id: &'static str,
    pub title: String,
    pub scope: String,
    pub fields: Vec<Field>,
    pub start: String,
    pub note: String,
    /// the text field being typed in, and what is typed (the plugin's copy doesn't overwrite it)
    editing: Option<(String, String)>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn parse_field(v: &Value) -> Option<Field> {
    let key = s(v, "key");
    let label = s(v, "label");
    Some(match v.get("kind")?.as_str()? {
        "toggle" => Field::Toggle { key, label, tip: s(v, "tip"), value: v.get("value").and_then(Value::as_bool).unwrap_or(false), disabled: v.get("disabled").and_then(Value::as_bool).unwrap_or(false) },
        "choice" => Field::Choice {
            key,
            label,
            value: s(v, "value"),
            options: v.get("options").and_then(Value::as_array).map(|a| a.iter().map(|o| (s(o, "value"), s(o, "label"))).take(20).collect()).unwrap_or_default(),
        },
        "text" => Field::Text { key, label, hint: s(v, "hint"), value: s(v, "value") },
        "heading" => Field::Heading { label },
        _ => return None,
    })
}

impl SetupSurface {
    pub fn new(id: &'static str) -> Self {
        SetupSurface { id, title: String::new(), scope: String::new(), fields: Vec::new(), start: String::new(), note: String::new(), editing: None }
    }
}

impl Surface for SetupSurface {
    fn id(&self) -> &'static str {
        self.id
    }

    fn size(&self) -> egui::Vec2 {
        egui::vec2(340.0, 420.0)
    }

    fn apply(&mut self, sections: &Map<String, Value>) {
        let Some(f) = sections.get("form") else { return };
        self.title = s(f, "title");
        self.scope = s(f, "scope");
        self.start = s(f, "start");
        self.note = s(f, "note");
        self.fields = f.get("fields").and_then(Value::as_array).map(|a| a.iter().filter_map(parse_field).take(40).collect()).unwrap_or_default();
    }

    /// never folds into a bar: it is up because the user just asked for it
    fn keep_expanded(&self) -> bool {
        true
    }

    fn ui(&mut self, ui: &mut egui::Ui) -> Vec<Value> {
        let mut out = Vec::new();
        // title · ×. Rows get a fixed height: a right-to-left layout takes all the height it is
        // given, and this window grows to its content — together they grew without end.
        let w = ui.available_width();
        ui.allocate_ui_with_layout(Vec2::new(w, ROW_H), egui::Layout::left_to_right(egui::Align::Center), |ui| {
            ui.label(RichText::new(&self.title).font(theme::font_bold(theme::FS_L)).color(theme::TEXT));
            ui.allocate_ui_with_layout(Vec2::new(ui.available_width(), ROW_H), egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add(egui::Button::new(RichText::new("×").font(theme::font(theme::FS_L))).frame(false)).on_hover_text("关闭（不开始）").clicked() {
                    out.push(json!({ "kind": "close" }));
                }
            });
        });
        if !self.scope.is_empty() {
            ui.add(egui::Label::new(RichText::new(&self.scope).font(theme::font(theme::FS_S)).color(theme::TEXT_2)).wrap());
        }
        ui.add_space(6.0);
        let mut typing_now: Option<(String, String)> = None;
        for f in self.fields.clone() {
            match f {
                Field::Heading { label } => {
                    ui.add_space(6.0);
                    ui.label(RichText::new(label).font(theme::font_bold(theme::FS_S)).color(theme::TEXT_2));
                    ui.add_space(2.0);
                }
                Field::Toggle { key, label, tip, value, disabled } => {
                    let mut v = value;
                    let r = ui.add_enabled(!disabled, egui::Checkbox::new(&mut v, RichText::new(label).font(theme::font(theme::FS_S))));
                    let r = if tip.is_empty() { r } else if disabled { r.on_disabled_hover_text(tip) } else { r.on_hover_text(tip) };
                    if r.changed() {
                        out.push(json!({ "kind": "set", "key": key, "value": v }));
                    }
                }
                Field::Choice { key, label, options, value } => {
                    ui.add_space(2.0);
                    ui.label(RichText::new(label).font(theme::font(theme::FS_S)).color(theme::TEXT_2));
                    ui.horizontal_wrapped(|ui| {
                        ui.spacing_mut().item_spacing = Vec2::new(6.0, 4.0);
                        for (v, l) in options {
                            let on = v == value;
                            if ui.add(egui::Button::new(RichText::new(l).font(theme::font(theme::FS_S)).color(if on { theme::ACCENT_HI } else { theme::TEXT })).selected(on)).clicked() && !on {
                                out.push(json!({ "kind": "set", "key": key, "value": v }));
                            }
                        }
                    });
                }
                Field::Text { key, label, hint, value } => {
                    ui.add_space(2.0);
                    ui.label(RichText::new(label).font(theme::font(theme::FS_S)).color(theme::TEXT_2));
                    let mut text = match &self.editing {
                        Some((k, t)) if *k == key => t.clone(),
                        _ => value.clone(),
                    };
                    let r = ui.add(egui::TextEdit::singleline(&mut text).hint_text(hint).desired_width(f32::INFINITY).font(theme::font(theme::FS_S)));
                    if r.changed() {
                        out.push(json!({ "kind": "set", "key": key, "value": text }));
                    }
                    if r.has_focus() {
                        typing_now = Some((key, text));
                    }
                }
            }
        }
        self.editing = typing_now;
        ui.add_space(8.0);
        if !self.note.is_empty() {
            ui.add(egui::Label::new(RichText::new(&self.note).font(theme::font(theme::FS_S)).color(if self.start.is_empty() { theme::WARN } else { theme::TEXT_3 })).wrap());
            ui.add_space(4.0);
        }
        ui.allocate_ui_with_layout(Vec2::new(ui.available_width(), ROW_H + 4.0), egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let label = if self.start.is_empty() { "开始" } else { self.start.as_str() };
            let b = egui::Button::new(RichText::new(label).font(theme::font_bold(theme::FS)).color(theme::ACCENT_INK)).fill(theme::ACCENT).min_size(Vec2::new(96.0, 28.0));
            if ui.add_enabled(!self.start.is_empty(), b).clicked() {
                out.push(json!({ "kind": "start" }));
            }
        });
        ui.add_space(6.0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_form() {
        let mut p = SetupSurface::new(CHECK_ID);
        let form = json!({ "form": {
            "title": "文档检查", "scope": "整个文档", "start": "开始检查", "note": "",
            "fields": [
                { "key": "scope", "kind": "choice", "label": "范围", "value": "doc", "options": [{ "value": "doc", "label": "整个文档" }, { "value": "selection", "label": "只查选中的图层" }] },
                { "key": "h", "kind": "heading", "label": "检查哪些内容" },
                { "key": "cat:font", "kind": "toggle", "label": "字体", "value": true },
                { "key": "extra", "kind": "text", "label": "补充要求", "hint": "例如", "value": "x" },
                { "key": "?", "kind": "unknown" }
            ] } });
        p.apply(form.as_object().unwrap());
        assert_eq!(p.title, "文档检查");
        assert_eq!(p.fields.len(), 4);
        assert!(matches!(&p.fields[0], Field::Choice { options, value, .. } if options.len() == 2 && value == "doc"));
        assert!(matches!(&p.fields[2], Field::Toggle { value: true, disabled: false, .. }));
        assert_eq!(p.id(), CHECK_ID);
        assert!(p.keep_expanded());
    }

    /// The content's height doesn't depend on the room it is given (the window grows to its
    /// content: a row that took all the height made it grow without end).
    #[test]
    fn content_height_does_not_follow_the_window() {
        let height_in = |screen_h: f32| {
            let mut p = SetupSurface::new(CHECK_ID);
            let form = json!({ "form": { "title": "文档检查", "scope": "整个文档", "start": "开始检查", "note": "至少勾选一项",
                "fields": [{ "key": "a", "kind": "toggle", "label": "字体", "value": true }, { "key": "t", "kind": "text", "label": "补充", "value": "" }] } });
            p.apply(form.as_object().unwrap());
            let ctx = egui::Context::default();
            theme::install(&ctx);
            let mut h = 0.0;
            for _ in 0..3 {
                let input = egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, Vec2::new(340.0, screen_h))), ..Default::default() };
                let _ = ctx.run(input, |ctx| {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        let out = egui::ScrollArea::vertical().auto_shrink([false, false]).enable_scrolling(false).show(ui, |ui| {
                            p.ui(ui);
                        });
                        h = out.content_size.y;
                    });
                });
            }
            h
        };
        let (small, big) = (height_in(400.0), height_in(3000.0));
        assert!(small > 50.0, "{small}");
        assert!((small - big).abs() < 1.0, "content {small} in a 400 px window but {big} in a 3000 px one");
    }
}
