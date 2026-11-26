// The native 检查结果 window: the plugin's document check (src/ui/docCheck.ts) beside the WavePlug
// 图层 panel. The plugin does every check and fix; this draws what it sends (sections "head", "opts",
// "issues", src/core/overlay/checkPanel.ts) and reports the user's actions back:
//
// - hovering a row: {"kind":"hover","key":…} (null when the pointer leaves the list) — the plugin
//   lights the issue's layers up in red / yellow in the panel and on the canvas;
// - clicking a title: "pick" (select the layers); the button: "fix"; the two AI boxes: "opt";
//   重新检查: "recheck"; ×: "close".
// - 收起 is this window's own: only the title bar stays (win.rs makes the window that short).
use eframe::egui::{self, Color32, CornerRadius, RichText, Sense, Stroke, StrokeKind, Vec2};
use serde_json::{json, Map, Value};

use crate::panel::theme;

pub const ID: &str = "check";
/// the window both 检查结果 and AI 整理 (organize.rs) are shown in
pub const TITLE: &str = "WavePlug 检查与整理";
/// logical width; the height follows the 图层 panel (win.rs)
pub const WIDTH: f32 = 340.0;
/// the title bar: all that shows while folded
pub const HEAD_H: f32 = 34.0;
const MAX_ISSUES: usize = 300;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Issue {
    pub key: String,
    pub sev: String,
    pub cat: String,
    pub title: String,
    pub detail: String,
    pub fix: Option<String>,
    pub state: Option<String>,
    pub pick: bool,
}

#[derive(Default)]
pub struct Check {
    pub issues: Vec<Issue>,
    pub summary: String,
    pub busy: String,
    pub error: String,
    pub copy: bool,
    pub visual: bool,
    pub ai: bool,
    /// 收起: only the title bar
    pub folded: bool,
    /// the row under the pointer, last reported
    hovered: Option<String>,
    /// that row's left and right edge and its middle, physical px inside the window (the line to
    /// the canvas starts at the edge facing it: frame.rs set_leader)
    pub hover_edges: Option<(f32, f32, f32)>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

impl Check {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, sections: &Map<String, Value>) {
        if let Some(items) = sections.get("issues").and_then(Value::as_array) {
            self.issues = items
                .iter()
                .take(MAX_ISSUES)
                .filter_map(|v| {
                    let key = s(v, "key");
                    (!key.is_empty()).then(|| Issue {
                        key,
                        sev: s(v, "sev"),
                        cat: s(v, "cat"),
                        title: s(v, "title"),
                        detail: s(v, "detail"),
                        fix: v.get("fix").and_then(Value::as_str).map(str::to_owned),
                        state: v.get("state").and_then(Value::as_str).map(str::to_owned),
                        pick: b(v, "pick"),
                    })
                })
                .collect();
            if let Some(h) = &self.hovered {
                if !self.issues.iter().any(|i| &i.key == h) {
                    self.hovered = None;
                }
            }
        }
        if let Some(v) = sections.get("head") {
            self.summary = s(v, "summary");
            self.busy = s(v, "busy");
            self.error = s(v, "error");
        }
        if let Some(v) = sections.get("opts") {
            self.copy = b(v, "copy");
            self.visual = b(v, "visual");
            self.ai = b(v, "ai");
        }
    }

    pub fn draw(&mut self, ctx: &egui::Context) -> Vec<Value> {
        let mut actions = Vec::new();
        let mut hover_now: Option<String> = None;
        let mut edges: Option<(f32, f32, f32)> = None;
        let ppp = ctx.pixels_per_point();
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(theme::BG).stroke(Stroke::new(1.0_f32, theme::LINE)).inner_margin(egui::Margin::symmetric(10, 0)))
            .show(ctx, |ui| {
                // ── title bar: 检查结果 · summary, 收起, × ──
                let (head, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), HEAD_H), Sense::hover());
                ui.painter().text(egui::pos2(head.left(), head.center().y), egui::Align2::LEFT_CENTER, "检查结果", theme::font_bold(theme::FS_L), theme::TEXT);
                let close = egui::Rect::from_center_size(egui::pos2(head.right() - 10.0, head.center().y), Vec2::splat(22.0));
                let fold = egui::Rect::from_center_size(egui::pos2(close.left() - 14.0, head.center().y), Vec2::splat(22.0));
                if icon_button(ui, close, "×", "关闭检查结果").clicked() {
                    actions.push(json!({ "kind": "close" }));
                }
                if icon_button(ui, fold, if self.folded { "▾" } else { "▴" }, if self.folded { "展开" } else { "暂时收起（只留标题栏）" }).clicked() {
                    self.folded = !self.folded;
                }
                let line = if !self.busy.is_empty() { self.busy.clone() } else { self.summary.clone() };
                ui.painter().text(egui::pos2(head.left() + 66.0, head.center().y), egui::Align2::LEFT_CENTER, elide(&line, 22), theme::font(theme::FS_S), theme::TEXT_2);
                if self.folded {
                    return;
                }
                ui.painter().hline(head.x_range(), head.bottom(), Stroke::new(1.0_f32, theme::LINE_SOFT));
                ui.add_space(6.0);

                // ── the two AI options and 重新检查 ──
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 10.0;
                    let mut copy = self.copy;
                    let tip_off = "先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key";
                    let r = ui.add_enabled(self.ai, egui::Checkbox::new(&mut copy, small("AI 文案")));
                    if r.on_hover_text(if self.ai { "让 DeepSeek 检查错别字、标点、前后不一致、广告法用语、翻译（只发送文字）；重新检查时生效" } else { tip_off }).changed() {
                        actions.push(json!({ "kind": "opt", "name": "copy", "on": copy }));
                    }
                    let mut visual = self.visual;
                    let r = ui.add_enabled(self.ai, egui::Checkbox::new(&mut visual, small("AI 看画面")));
                    if r.on_hover_text(if self.ai { "会把画面缩略图上传到 DeepSeek，找 AI 生成瑕疵、排版问题；保密的稿子不要勾；重新检查时生效" } else { tip_off }).changed() {
                        actions.push(json!({ "kind": "opt", "name": "visual", "on": visual }));
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.add_enabled(self.busy.is_empty(), egui::Button::new(small("重新检查"))).on_hover_text("重新读取文档再查一遍（勾了的 AI 检查也重新做）").clicked() {
                            actions.push(json!({ "kind": "recheck" }));
                        }
                    });
                });
                if !self.error.is_empty() {
                    ui.add_space(4.0);
                    ui.label(RichText::new(&self.error).font(theme::font(theme::FS_S)).color(theme::ERR));
                }
                ui.add_space(6.0);

                // ── the list, grouped by category ──
                let pointer_in = ui.rect_contains_pointer(ui.available_rect_before_wrap());
                egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(0.0, 0.0);
                    if self.issues.is_empty() {
                        ui.add_space(12.0);
                        ui.label(RichText::new(if self.busy.is_empty() { "没有发现问题" } else { "正在检查…" }).font(theme::font(theme::FS)).color(theme::TEXT_2));
                        return;
                    }
                    let mut cat = String::new();
                    for it in self.issues.clone() {
                        if it.cat != cat {
                            cat = it.cat.clone();
                            ui.add_space(8.0);
                            let n = self.issues.iter().filter(|i| i.cat == cat).count();
                            ui.label(RichText::new(format!("{cat}（{n}）")).font(theme::font_bold(theme::FS_S)).color(theme::TEXT_2));
                            ui.add_space(4.0);
                        }
                        let done = it.state.is_some();
                        let row = egui::Frame::new().inner_margin(egui::Margin::symmetric(4, 5)).corner_radius(CornerRadius::same(theme::R)).show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.horizontal_top(|ui| {
                                ui.spacing_mut().item_spacing.x = 8.0;
                                badge(ui, &it.sev, done);
                                let right = if it.fix.is_some() || it.state.is_some() { 84.0 } else { 0.0 };
                                let text_w = (ui.available_width() - right).max(80.0);
                                ui.vertical(|ui| {
                                    ui.set_width(text_w);
                                    let ink = if done { theme::TEXT_3 } else { theme::TEXT };
                                    let title = ui.add(egui::Label::new(RichText::new(&it.title).font(theme::font(theme::FS)).color(ink)).wrap().sense(if it.pick { Sense::click() } else { Sense::hover() }));
                                    if it.pick && title.on_hover_text("单击选中相关图层").clicked() {
                                        actions.push(json!({ "kind": "pick", "key": it.key }));
                                    }
                                    if !it.detail.is_empty() {
                                        ui.add(egui::Label::new(RichText::new(&it.detail).font(theme::font(theme::FS_S)).color(theme::TEXT_3)).wrap());
                                    }
                                });
                                if let Some(st) = &it.state {
                                    ui.label(RichText::new(st).font(theme::font(theme::FS_S)).color(theme::OK));
                                } else if let Some(fix) = &it.fix {
                                    if ui.add(egui::Button::new(small(fix))).on_hover_text("处理这一项（可以 Ctrl+Z 撤销）").clicked() {
                                        actions.push(json!({ "kind": "fix", "key": it.key }));
                                    }
                                }
                            });
                        });
                        let r = row.response.rect;
                        if pointer_in && ui.rect_contains_pointer(r) {
                            hover_now = Some(it.key.clone());
                            if it.pick {
                                edges = Some((r.left() * ppp, r.right() * ppp, r.center().y * ppp));
                            }
                            ui.painter().rect_stroke(r, CornerRadius::same(theme::R), Stroke::new(1.0_f32, sev_color(&it.sev)), StrokeKind::Inside);
                        }
                        ui.painter().hline(r.x_range(), r.bottom(), Stroke::new(1.0_f32, theme::LINE_SOFT));
                    }
                    ui.add_space(8.0);
                });
            });
        self.hover_edges = edges;
        if hover_now != self.hovered {
            self.hovered = hover_now.clone();
            actions.push(json!({ "kind": "hover", "key": hover_now }));
        }
        actions
    }
}

fn small(text: &str) -> RichText {
    RichText::new(text).font(theme::font(theme::FS_S))
}

/// 错误 red, 警告 and 提示 yellow: the same colours light the layers up in the 图层 panel and on the
/// canvas (src/core/overlay/checkPanel.ts SEVERITY_COLOR)
fn sev_color(sev: &str) -> Color32 {
    if sev == "error" { theme::ERR } else { theme::WARN }
}

fn badge(ui: &mut egui::Ui, sev: &str, done: bool) {
    let label = match sev {
        "error" => "错误",
        "warn" => "警告",
        _ => "提示",
    };
    let c = if done { theme::TEXT_3 } else { sev_color(sev) };
    let (r, _) = ui.allocate_exact_size(Vec2::new(30.0, 18.0), Sense::hover());
    ui.painter().rect_stroke(r, CornerRadius::same(theme::R), Stroke::new(1.0_f32, c), StrokeKind::Inside);
    ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, label, theme::font(theme::FS_S), c);
}

pub fn icon_button(ui: &mut egui::Ui, r: egui::Rect, text: &str, tip: &str) -> egui::Response {
    let resp = ui.interact(r, ui.id().with(("check-icon", text)), Sense::click());
    if resp.hovered() {
        ui.painter().rect_filled(r, CornerRadius::same(theme::R), theme::HOVER);
    }
    ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, text, theme::font(theme::FS_L), theme::TEXT);
    resp.on_hover_text(tip)
}

/// at most `max` characters, with an ellipsis
pub fn elide(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_the_sections_it_gets() {
        let mut c = Check::new();
        let sections = json!({
            "head": { "summary": "1 个错误", "busy": "", "error": "" },
            "opts": { "copy": true, "visual": false, "ai": true },
            "issues": [{ "key": "font:x", "sev": "error", "cat": "字体", "title": "缺少字体", "detail": "d", "pick": true, "fix": "处理" }, { "key": "" }],
        });
        c.apply(sections.as_object().unwrap());
        assert_eq!(c.issues.len(), 1);
        assert_eq!(c.issues[0].fix.as_deref(), Some("处理"));
        assert!(c.copy && !c.visual && c.ai);
        assert_eq!(c.summary, "1 个错误");
        // only "head": the list stays
        c.apply(json!({ "head": { "summary": "都处理好了" } }).as_object().unwrap());
        assert_eq!(c.issues.len(), 1);
        assert_eq!(elide("一二三四五", 4), "一二三…");
    }
}
