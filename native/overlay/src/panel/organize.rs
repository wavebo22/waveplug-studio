// The native AI 整理 window: the plugin's AI 整理图层 plan (src/ui/aiOrganize.ts) in the same window
// slot as 检查结果, beside the WavePlug 图层 panel. The plugin asks DeepSeek, checks the plan and
// applies it; this draws what it sends (sections "head", "opts", "plan",
// src/core/overlay/organizePanel.ts) and reports back:
//
// - hovering a row: {"kind":"hover","key":…} (null when the pointer leaves the list) — its layers
//   light up in the panel and on the canvas, with lines to them (the same as 检查结果);
// - a row's box: "toggle"; 补充要求 (Enter or leaving the field): "extra" then, on Enter, "analyse";
//   只重命名: "rename-only"; 重新分析 / 应用 / ×: "analyse" / "apply" / "close".
use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke, StrokeKind, Vec2};
use serde_json::{json, Map, Value};

use crate::panel::theme;

pub const ID: &str = "organize";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    pub key: String,
    /// a rename: the old name; a new group: empty
    pub from: String,
    /// the new name / the group's name
    pub to: String,
    /// a new group: what goes in
    pub members: String,
    pub on: bool,
    pub pick: bool,
}

#[derive(Default)]
pub struct Organize {
    pub scope: String,
    pub busy: String,
    pub error: String,
    pub extra: String,
    /// the field as typed (sent when it loses the keyboard or on Enter)
    typed: Option<String>,
    pub rename_only: bool,
    pub renames: Vec<Item>,
    pub groups: Vec<Item>,
    pub dropped: Vec<String>,
    pub folded: bool,
    hovered: Option<String>,
    /// the hovered row's left / right edge and middle, physical px inside the window
    pub hover_edges: Option<(f32, f32, f32)>,
    /// the text field has the keyboard (the window must take it from Photoshop)
    pub typing: bool,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}
fn items(v: Option<&Value>) -> Vec<Item> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(400)
                .filter_map(|v| {
                    let key = s(v, "key");
                    (!key.is_empty()).then(|| Item { key, from: s(v, "from"), to: s(v, "to"), members: s(v, "members"), on: b(v, "on"), pick: b(v, "pick") })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Organize {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, sections: &Map<String, Value>) {
        if let Some(v) = sections.get("head") {
            self.scope = s(v, "scope");
            self.busy = s(v, "busy");
            self.error = s(v, "error");
        }
        if let Some(v) = sections.get("opts") {
            self.extra = s(v, "extra");
            self.rename_only = b(v, "renameOnly");
        }
        if let Some(v) = sections.get("plan") {
            self.renames = items(v.get("renames"));
            self.groups = items(v.get("groups"));
            self.dropped = v.get("dropped").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(40).map(str::to_owned).collect()).unwrap_or_default();
        }
    }

    pub fn draw(&mut self, ctx: &egui::Context) -> Vec<Value> {
        let mut actions = Vec::new();
        let mut hover_now: Option<String> = None;
        let mut edges: Option<(f32, f32, f32)> = None;
        let ppp = ctx.pixels_per_point();
        let mut typing = false;
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(theme::BG).stroke(Stroke::new(1.0_f32, theme::LINE)).inner_margin(egui::Margin::symmetric(10, 0)))
            .show(ctx, |ui| {
                // ── title bar: AI 整理 · scope, 收起, × ──
                let (head, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), crate::panel::check::HEAD_H), Sense::hover());
                ui.painter().text(egui::pos2(head.left(), head.center().y), egui::Align2::LEFT_CENTER, "AI 整理", theme::font_bold(theme::FS_L), theme::TEXT);
                let close = egui::Rect::from_center_size(egui::pos2(head.right() - 10.0, head.center().y), Vec2::splat(22.0));
                let fold = egui::Rect::from_center_size(egui::pos2(close.left() - 14.0, head.center().y), Vec2::splat(22.0));
                if crate::panel::check::icon_button(ui, close, "×", "关闭 AI 整理").clicked() {
                    actions.push(json!({ "kind": "close" }));
                }
                if crate::panel::check::icon_button(ui, fold, if self.folded { "▾" } else { "▴" }, if self.folded { "展开" } else { "暂时收起（只留标题栏）" }).clicked() {
                    self.folded = !self.folded;
                }
                let line = if !self.busy.is_empty() { self.busy.clone() } else { self.scope.clone() };
                ui.painter().text(egui::pos2(head.left() + 60.0, head.center().y), egui::Align2::LEFT_CENTER, crate::panel::check::elide(&line, 22), theme::font(theme::FS_S), theme::TEXT_2);
                if self.folded {
                    return;
                }
                ui.painter().hline(head.x_range(), head.bottom(), Stroke::new(1.0_f32, theme::LINE_SOFT));
                ui.add_space(6.0);

                // ── 补充要求, 只重命名 ──
                let text = self.typed.get_or_insert_with(|| self.extra.clone());
                let field = ui.add(egui::TextEdit::singleline(text).hint_text("补充要求（可选），例如：按钮统一叫「按钮-…」").desired_width(f32::INFINITY).font(theme::font(theme::FS_S)));
                typing = field.has_focus();
                let enter = field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if field.lost_focus() {
                    let t = self.typed.take().unwrap_or_default();
                    if t != self.extra {
                        self.extra = t.clone();
                        actions.push(json!({ "kind": "extra", "text": t }));
                    }
                    if enter {
                        actions.push(json!({ "kind": "analyse" }));
                    }
                }
                if !field.has_focus() && !field.lost_focus() {
                    self.typed = None; // follow the plugin's value while not typing
                }
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let mut only = self.rename_only;
                    if ui.checkbox(&mut only, RichText::new("只重命名，不归组").font(theme::font(theme::FS_S))).changed() {
                        actions.push(json!({ "kind": "rename-only", "on": only }));
                    }
                });
                if !self.error.is_empty() {
                    ui.add_space(4.0);
                    ui.label(RichText::new(&self.error).font(theme::font(theme::FS_S)).color(theme::ERR));
                }
                ui.add_space(4.0);

                // ── 重新分析 · 应用 N 项 (above the list, always in reach) ──
                let n = self.renames.iter().chain(self.groups.iter()).filter(|i| i.on).count();
                ui.horizontal(|ui| {
                    let idle = self.busy.is_empty();
                    if ui.add_enabled(idle, egui::Button::new(RichText::new("重新分析").font(theme::font(theme::FS_S)))).on_hover_text("按上面的补充要求重新让 DeepSeek 分析").clicked() {
                        actions.push(json!({ "kind": "analyse" }));
                    }
                    let label = if n > 0 { format!("应用 {n} 项") } else { "应用".to_string() };
                    let apply = egui::Button::new(RichText::new(label).font(theme::font_bold(theme::FS_S)).color(theme::ACCENT_INK)).fill(theme::ACCENT);
                    if ui.add_enabled(idle && n > 0, apply).on_hover_text("勾选的项一步执行，可以 Ctrl+Z 撤销").clicked() {
                        actions.push(json!({ "kind": "apply" }));
                    }
                });
                ui.add_space(6.0);

                // ── the plan ──
                let pointer_in = ui.rect_contains_pointer(ui.available_rect_before_wrap());
                egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(0.0, 0.0);
                    if self.renames.is_empty() && self.groups.is_empty() {
                        ui.add_space(12.0);
                        let msg = if !self.busy.is_empty() { "DeepSeek 正在分析图层…（图层多时要几十秒）" } else if self.error.is_empty() { "DeepSeek 认为这些图层不需要整理" } else { "" };
                        ui.label(RichText::new(msg).font(theme::font(theme::FS)).color(theme::TEXT_2));
                    }
                    for (title, list) in [("改名", self.renames.clone()), ("新建组", self.groups.clone())] {
                        if list.is_empty() {
                            continue;
                        }
                        ui.add_space(8.0);
                        ui.label(RichText::new(format!("{title}（{}）", list.len())).font(theme::font_bold(theme::FS_S)).color(theme::TEXT_2));
                        ui.add_space(4.0);
                        for it in list {
                            let row = egui::Frame::new().inner_margin(egui::Margin::symmetric(4, 4)).show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                ui.horizontal_top(|ui| {
                                    ui.spacing_mut().item_spacing.x = 6.0;
                                    let mut on = it.on;
                                    if ui.checkbox(&mut on, "").changed() {
                                        actions.push(json!({ "kind": "toggle", "key": it.key }));
                                    }
                                    ui.vertical(|ui| {
                                        let ink = if it.on { theme::TEXT } else { theme::TEXT_3 };
                                        if it.from.is_empty() {
                                            ui.add(egui::Label::new(RichText::new(&it.to).font(theme::font(theme::FS)).color(if it.on { theme::ACCENT_HI } else { theme::TEXT_3 })).wrap());
                                            ui.add(egui::Label::new(RichText::new(&it.members).font(theme::font(theme::FS_S)).color(theme::TEXT_3)).wrap());
                                        } else {
                                            ui.add(egui::Label::new(RichText::new(&it.from).font(theme::font(theme::FS_S)).color(theme::TEXT_3)).wrap());
                                            ui.add(egui::Label::new(RichText::new(format!("→ {}", it.to)).font(theme::font(theme::FS)).color(if it.on { theme::ACCENT_HI } else { ink })).wrap());
                                        }
                                    });
                                });
                            });
                            let r = row.response.rect;
                            if pointer_in && ui.rect_contains_pointer(r) {
                                hover_now = Some(it.key.clone());
                                if it.pick {
                                    edges = Some((r.left() * ppp, r.right() * ppp, r.center().y * ppp));
                                }
                                ui.painter().rect_stroke(r, CornerRadius::same(theme::R), Stroke::new(1.0_f32, theme::WARN), StrokeKind::Inside);
                            }
                            ui.painter().hline(r.x_range(), r.bottom(), Stroke::new(1.0_f32, theme::LINE_SOFT));
                        }
                    }
                    if !self.dropped.is_empty() {
                        ui.add_space(10.0);
                        let shown: Vec<&str> = self.dropped.iter().take(6).map(String::as_str).collect();
                        let more = if self.dropped.len() > shown.len() { format!(" 等 {} 条", self.dropped.len()) } else { String::new() };
                        ui.add(egui::Label::new(RichText::new(format!("没采用的建议（为了不改变画面）：{}{more}", shown.join("；"))).font(theme::font(theme::FS_S)).color(theme::TEXT_3)).wrap());
                    }
                    ui.add_space(8.0);
                });
            });
        self.typing = typing;
        self.hover_edges = edges;
        if hover_now != self.hovered {
            self.hovered = hover_now.clone();
            actions.push(json!({ "kind": "hover", "key": hover_now }));
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_the_plan() {
        let mut o = Organize::new();
        let sections = json!({
            "head": { "scope": "整个文档 · 12 个图层", "busy": "", "error": "" },
            "opts": { "extra": "用英文", "renameOnly": true },
            "plan": { "renames": [{ "key": "r:1", "from": "图层 1", "to": "标题", "on": true, "pick": true }, { "key": "" }],
                      "groups": [{ "key": "g:0", "to": "按钮", "members": "2 个：a、b", "on": false, "pick": true }], "dropped": ["x"] },
        });
        o.apply(sections.as_object().unwrap());
        assert_eq!(o.renames.len(), 1);
        assert_eq!(o.groups[0].to, "按钮");
        assert!(!o.groups[0].on && o.rename_only);
        assert_eq!(o.extra, "用英文");
        assert_eq!(o.dropped, vec!["x".to_string()]);
    }
}
