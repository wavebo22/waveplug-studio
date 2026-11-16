// The native 编辑工作台 window: the plugin's workbench list (src/ui/workbench.ts), shown beside the
// canvas whichever document is active, so layers can be collected from one PSD and placed into
// another. The plugin is authoritative for the list, its checks and every Photoshop action; this
// draws what it sends (sections "entries" and "summary") and sends the user's actions back.
//
// - A WaveLayer drag from any document can be dropped on the whole window (drag target
//   "workbench", drag/session.rs takes it even for groups).
// - Rows can be dragged out: the host starts the drag engine (card, drops into Photoshop or other
//   programs) and tells the plugin which entries ("drag-out").
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use data_encoding::BASE64;
use eframe::egui::{
    self, Align2, Color32, ColorImage, CornerRadius, Pos2, Rect, Sense, Stroke, StrokeKind,
    TextureHandle, TextureOptions, Vec2,
};
use serde_json::{json, Map, Value};

use crate::panel::theme;

pub const ID: &str = "workbench";
pub const TITLE: &str = "WavePlug 工作台";
pub const WIDTH: f32 = 248.0;

const PAD: f32 = 8.0;
const HEAD_H: f32 = 24.0;
const BAND_H: f32 = 34.0;
const SRC_H: f32 = 20.0;
const ROW_H: f32 = 26.0;
const THUMB: f32 = 20.0;
const LIST_MAX: f32 = 320.0;
const OPT_H: f32 = 24.0;
const FOOT_H: f32 = 30.0;
const STATUS_H: f32 = 18.0;
const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entry {
    pub key: String,
    pub name: String,
    pub doc: String,
    /// why it can't be placed right now ("" when it can)
    pub state: String,
    pub usable: bool,
    pub thumb: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    /// where 置入 goes (the active document's name)
    pub target: String,
    pub busy: bool,
    pub status: String,
    pub position_selection: bool,
    pub wrap_group: bool,
    pub restore: bool,
}

/// A drag out of the window: which entries, and what the card shows.
pub struct DragOut {
    pub keys: Vec<String>,
    pub names: Vec<String>,
    pub thumb: Option<String>,
}

pub struct Shelf {
    pub entries: Vec<Entry>,
    pub summary: Summary,
    selected: HashSet<String>,
    anchor: Option<String>,
    folded: HashSet<String>,
    textures: HashMap<String, (u64, TextureHandle)>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Click / Ctrl / Shift selection over `order` (the same rules as the plugin's clickSelection).
pub fn click_select(order: &[String], selected: &HashSet<String>, anchor: Option<&str>, key: &str, ctrl: bool, shift: bool) -> (HashSet<String>, String) {
    if shift {
        if let (Some(a), Some(bi)) = (anchor.and_then(|a| order.iter().position(|k| k == a)), order.iter().position(|k| k == key)) {
            let mut out = if ctrl { selected.clone() } else { HashSet::new() };
            for k in &order[a.min(bi)..=a.max(bi)] {
                out.insert(k.clone());
            }
            return (out, order[a].clone());
        }
    }
    if ctrl {
        let mut out = selected.clone();
        if !out.remove(key) {
            out.insert(key.to_string());
        }
        return (out, key.to_string());
    }
    (HashSet::from([key.to_string()]), key.to_string())
}

/// Entries grouped by their document, in first-seen order.
fn groups(entries: &[Entry]) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        match out.iter_mut().find(|(d, _)| *d == e.doc) {
            Some((_, v)) => v.push(i),
            None => out.push((e.doc.clone(), vec![i])),
        }
    }
    out
}

impl Shelf {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            summary: Summary::default(),
            selected: HashSet::new(),
            anchor: None,
            folded: HashSet::new(),
            textures: HashMap::new(),
        }
    }

    pub fn apply(&mut self, sections: &Map<String, Value>) {
        if let Some(items) = sections.get("entries").and_then(Value::as_array) {
            self.entries = items
                .iter()
                .take(MAX_ENTRIES)
                .filter_map(|v| {
                    let key = s(v, "key");
                    (!key.is_empty()).then(|| Entry {
                        key,
                        name: s(v, "name"),
                        doc: s(v, "doc"),
                        state: s(v, "state"),
                        usable: b(v, "usable"),
                        thumb: v.get("thumb").and_then(Value::as_str).filter(|t| t.len() < 60_000).map(str::to_owned),
                    })
                })
                .collect();
            let keys: HashSet<&String> = self.entries.iter().map(|e| &e.key).collect();
            self.selected.retain(|k| keys.contains(k));
            self.textures.retain(|k, _| keys.contains(k));
        }
        if let Some(v) = sections.get("summary") {
            self.summary = Summary {
                target: s(v, "target"),
                busy: b(v, "busy"),
                status: s(v, "status"),
                position_selection: b(v, "positionSelection"),
                wrap_group: b(v, "wrapGroup"),
                restore: b(v, "restore"),
            };
        }
    }

    /// The height the content needs (logical px); the window is fitted to it.
    pub fn content_height(&self, band: bool) -> f32 {
        let mut list = 0.0;
        for (doc, rows) in groups(&self.entries) {
            list += SRC_H;
            if !self.folded.contains(&doc) {
                list += ROW_H * rows.len() as f32;
            }
        }
        if self.entries.is_empty() {
            list = ROW_H;
        }
        (2.0 * PAD + HEAD_H + if band { BAND_H } else { 0.0 } + list.min(LIST_MAX) + 4.0 + OPT_H + FOOT_H + STATUS_H).ceil()
    }

    fn texture(&mut self, i: usize, ctx: &egui::Context) -> Option<egui::TextureId> {
        let e = self.entries.get(i)?;
        let thumb = e.thumb.as_deref()?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        thumb.hash(&mut hasher);
        let hash = hasher.finish();
        if self.textures.get(&e.key).is_none_or(|(old, _)| *old != hash) {
            let (mime, b64) = thumb.split_once(',')?;
            if mime != "data:image/png;base64" && mime != "data:image/jpeg;base64" {
                return None;
            }
            let bytes = BASE64.decode(b64.as_bytes()).ok()?;
            let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
            let (w, h) = img.dimensions();
            if w == 0 || h == 0 || w > 512 || h > 512 {
                return None;
            }
            let image = ColorImage::from_rgba_unmultiplied([w as usize, h as usize], img.as_raw());
            let tex = ctx.load_texture(format!("wp-wb-{}", e.key), image, TextureOptions::LINEAR);
            self.textures.insert(e.key.clone(), (hash, tex));
        }
        Some(self.textures.get(&e.key)?.1.id())
    }

    /// The keys 置入 / a drag takes: the selected usable entries, or all usable ones.
    fn placeable(&self) -> Vec<String> {
        let any = !self.selected.is_empty();
        self.entries.iter().filter(|e| e.usable && (!any || self.selected.contains(&e.key))).map(|e| e.key.clone()).collect()
    }

    /// `band`: a WaveLayer drag is running (show where to drop); `hot`: it is over this window.
    pub fn draw(&mut self, ctx: &egui::Context, band: bool, hot: bool) -> (Vec<Value>, Option<DragOut>) {
        let mut actions = Vec::new();
        let mut drag_out = None;
        let frame_line = if hot { Stroke::new(2.0_f32, theme::ACCENT_HI) } else { Stroke::new(1.0_f32, theme::LINE) };
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(theme::BG).stroke(frame_line).inner_margin(egui::Margin::same(PAD as i8)))
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing = Vec2::ZERO;
                let w = ui.available_width();
                let busy = self.summary.busy;

                // ── header: title · count, 清空, close ──
                let (head, _) = ui.allocate_exact_size(Vec2::new(w, HEAD_H), Sense::hover());
                let p = ui.painter();
                p.text(Pos2::new(head.left(), head.center().y), Align2::LEFT_CENTER, "编辑工作台", theme::font_bold(theme::FS), theme::TEXT);
                p.text(Pos2::new(head.left() + 66.0, head.center().y), Align2::LEFT_CENTER, format!("{} 项", self.entries.len()), theme::font(theme::FS_S), theme::TEXT_2);
                let close = Rect::from_center_size(Pos2::new(head.right() - 9.0, head.center().y), Vec2::splat(18.0));
                if text_button(ui, close, "×", true, "收起工作台（清单保留）").clicked() {
                    actions.push(json!({ "kind": "close" }));
                }
                let clear = Rect::from_min_size(Pos2::new(close.left() - 40.0, head.center().y - 9.0), Vec2::new(36.0, 18.0));
                if text_button(ui, clear, "清空", !busy && !self.entries.is_empty(), "清空清单（不删除任何图层）").clicked() {
                    actions.push(json!({ "kind": "clear" }));
                }

                // ── drop band, only while a WaveLayer drag runs ──
                if band {
                    let (r, _) = ui.allocate_exact_size(Vec2::new(w, BAND_H), Sense::hover());
                    let r = r.shrink2(Vec2::new(0.0, 2.0));
                    let p = ui.painter();
                    p.rect_filled(r, CornerRadius::same(theme::R), if hot { theme::ACCENT_WASH } else { theme::SURFACE });
                    p.rect_stroke(r, CornerRadius::same(theme::R), Stroke::new(1.0_f32, if hot { theme::ACCENT_HI } else { theme::LINE }), StrokeKind::Inside);
                    p.text(r.center(), Align2::CENTER_CENTER, if hot { "松开加入工作台" } else { "拖到这里暂存（任意文档）" }, theme::font(theme::FS), if hot { theme::TEXT } else { theme::TEXT_2 });
                }

                // ── the list ──
                let order: Vec<String> = self.entries.iter().map(|e| e.key.clone()).collect();
                let list_h = self.content_height(false) - (2.0 * PAD + HEAD_H + 4.0 + OPT_H + FOOT_H + STATUS_H);
                egui::ScrollArea::vertical().max_height(list_h.max(ROW_H)).auto_shrink([false, true]).show(ui, |ui| {
                    ui.spacing_mut().item_spacing = Vec2::ZERO;
                    let w = ui.available_width();
                    if self.entries.is_empty() {
                        let (r, _) = ui.allocate_exact_size(Vec2::new(w, ROW_H), Sense::hover());
                        ui.painter().text(r.center(), Align2::CENTER_CENTER, "把图层拖到这里暂存", theme::font(theme::FS_S), theme::TEXT_3);
                    }
                    for (doc, rows) in groups(&self.entries) {
                        let folded = self.folded.contains(&doc);
                        let (r, resp) = ui.allocate_exact_size(Vec2::new(w, SRC_H), Sense::click());
                        let open_doc = rows.iter().any(|&i| !self.entries[i].state.starts_with("来源未打开"));
                        let p = ui.painter();
                        if resp.hovered() {
                            p.rect_filled(r, CornerRadius::same(theme::R), theme::HOVER);
                        }
                        p.text(Pos2::new(r.left() + 2.0, r.center().y), Align2::LEFT_CENTER, if folded { "▸" } else { "▾" }, theme::font(theme::FS_S), theme::TEXT_2);
                        p.circle_filled(Pos2::new(r.left() + 16.0, r.center().y), 3.0, if open_doc { theme::OK } else { theme::TEXT_3 });
                        p.text(Pos2::new(r.left() + 24.0, r.center().y), Align2::LEFT_CENTER, elide(&doc, 26), theme::font(theme::FS_S), theme::TEXT_2);
                        p.text(Pos2::new(r.right() - 4.0, r.center().y), Align2::RIGHT_CENTER, rows.len().to_string(), theme::font(theme::FS_S), theme::TEXT_2);
                        if resp.clicked() {
                            if folded { self.folded.remove(&doc); } else { self.folded.insert(doc.clone()); }
                        }
                        if folded {
                            continue;
                        }
                        for i in rows {
                            let tex = self.texture(i, ui.ctx());
                            let e = self.entries[i].clone();
                            let (r, resp) = ui.allocate_exact_size(Vec2::new(w, ROW_H), Sense::click_and_drag());
                            let sel = self.selected.contains(&e.key);
                            let p = ui.painter();
                            if sel {
                                p.rect_filled(r, CornerRadius::same(theme::R), theme::ACCENT_WASH);
                            } else if resp.hovered() {
                                p.rect_filled(r, CornerRadius::same(theme::R), theme::HOVER);
                            }
                            let dim = if e.usable { Color32::WHITE } else { Color32::from_white_alpha(110) };
                            let pic = Rect::from_min_size(Pos2::new(r.left() + 14.0, r.center().y - THUMB / 2.0), Vec2::splat(THUMB));
                            p.rect_filled(pic, CornerRadius::same(2), theme::FIELD);
                            if let Some(t) = tex {
                                p.image(t, pic, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), dim);
                            }
                            p.rect_stroke(pic, CornerRadius::same(2), Stroke::new(1.0_f32, theme::LINE_SOFT), StrokeKind::Inside);
                            let x = name_x(pic);
                            p.text(Pos2::new(x, r.center().y), Align2::LEFT_CENTER, elide(&e.name, if e.state.is_empty() { 22 } else { 13 }), theme::font(theme::FS_S), if e.usable { theme::TEXT } else { theme::TEXT_3 });
                            if !e.state.is_empty() {
                                p.text(Pos2::new(r.right() - 24.0, r.center().y), Align2::RIGHT_CENTER, &e.state, theme::font(theme::FS_S), theme::WARN);
                            }
                            let rm = Rect::from_center_size(Pos2::new(r.right() - 10.0, r.center().y), Vec2::splat(18.0));
                            let removed = text_button(ui, rm, "×", !busy, "从工作台移出（不删除图层）").clicked();
                            if removed {
                                actions.push(json!({ "kind": "remove", "keys": [e.key] }));
                            } else if resp.drag_started() && e.usable && !busy {
                                let keys = if sel { self.placeable() } else { vec![e.key.clone()] };
                                let names = self.entries.iter().filter(|x| keys.contains(&x.key)).map(|x| x.name.clone()).collect();
                                drag_out = Some(DragOut { keys, names, thumb: e.thumb.clone() });
                            } else if resp.clicked() {
                                let m = ui.input(|i| i.modifiers);
                                let (next, a) = click_select(&order, &self.selected, self.anchor.as_deref(), &e.key, m.ctrl || m.command, m.shift);
                                self.selected = next;
                                self.anchor = Some(a);
                            }
                            resp.on_hover_text(if e.usable { "单击选择；拖到 Photoshop 置入，拖到其他软件复制" } else { "来源 PSD 未打开或图层已删除" });
                        }
                    }
                });
                ui.add_space(4.0);

                // ── settings: position, group, restore ──
                let (r, _) = ui.allocate_exact_size(Vec2::new(w, OPT_H), Sense::hover());
                let seg_w = 52.0;
                let top = Rect::from_min_size(Pos2::new(r.left(), r.top() + 2.0), Vec2::new(seg_w, OPT_H - 4.0));
                let selb = Rect::from_min_size(Pos2::new(top.right(), top.top()), Vec2::new(seg_w + 14.0, OPT_H - 4.0));
                if seg_button(ui, top, "置顶", !self.summary.position_selection, "放在目标文档最上方").clicked() && !busy {
                    actions.push(json!({ "kind": "pref", "name": "position", "value": "top" }));
                }
                if seg_button(ui, selb, "选中上方", self.summary.position_selection, "放在目标文档里最上方的选中图层上方").clicked() && !busy {
                    actions.push(json!({ "kind": "pref", "name": "position", "value": "selection" }));
                }
                let wrap = Rect::from_min_size(Pos2::new(selb.right() + 8.0, top.top()), Vec2::new(44.0, OPT_H - 4.0));
                if check(ui, wrap, "包组", self.summary.wrap_group, "置入的图层放进一个新图层组").clicked() && !busy {
                    actions.push(json!({ "kind": "pref", "name": "wrapGroup", "value": !self.summary.wrap_group }));
                }
                let rest = Rect::from_min_size(Pos2::new(wrap.right() + 4.0, top.top()), Vec2::new(r.right() - wrap.right() - 4.0, OPT_H - 4.0));
                if check(ui, rest, "还原位置", self.summary.restore, "按来源画布上的位置放回").clicked() && !busy {
                    actions.push(json!({ "kind": "pref", "name": "restore", "value": !self.summary.restore }));
                }

                // ── footer: target, 置入 ──
                let (r, _) = ui.allocate_exact_size(Vec2::new(w, FOOT_H), Sense::hover());
                let keys = self.placeable();
                let label = if busy { "置入中…".to_string() } else if self.selected.is_empty() { format!("全部置入 {}", keys.len()) } else { format!("置入所选 {}", keys.len()) };
                let btn = Rect::from_min_size(Pos2::new(r.right() - 96.0, r.top() + 2.0), Vec2::new(96.0, FOOT_H - 4.0));
                let p = ui.painter();
                p.text(Pos2::new(r.left(), r.center().y), Align2::LEFT_CENTER, format!("到：{}", elide(if self.summary.target.is_empty() { "当前文档" } else { &self.summary.target }, 12)), theme::font(theme::FS_S), theme::TEXT_2);
                let enabled = !busy && !keys.is_empty();
                let resp = ui.interact(btn, ui.id().with("wb-place"), if enabled { Sense::click() } else { Sense::hover() });
                let p = ui.painter();
                p.rect_filled(btn, CornerRadius::same(theme::R), if !enabled { theme::ACCENT_WASH } else if resp.hovered() { theme::ACCENT_HI } else { theme::ACCENT });
                p.text(btn.center(), Align2::CENTER_CENTER, label, theme::font_bold(theme::FS), if enabled { theme::ACCENT_INK } else { theme::DISABLED_INK });
                if resp.on_hover_text("复制到当前 PSD（一步，可撤销）").clicked() {
                    actions.push(json!({ "kind": "place", "keys": keys }));
                }
                let (r, _) = ui.allocate_exact_size(Vec2::new(w, STATUS_H), Sense::hover());
                ui.painter().text(Pos2::new(r.left(), r.center().y), Align2::LEFT_CENTER, elide(&self.summary.status, 34), theme::font(theme::FS_S), theme::TEXT_2);
            });
        (actions, drag_out)
    }
}

fn name_x(pic: Rect) -> f32 {
    pic.right() + 6.0
}

/// At most `max` characters, with an ellipsis.
pub fn elide(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn text_button(ui: &mut egui::Ui, r: Rect, text: &str, enabled: bool, tip: &str) -> egui::Response {
    let resp = ui.interact(r, ui.id().with((text, r.min.x as i32, r.min.y as i32)), if enabled { Sense::click() } else { Sense::hover() });
    let p = ui.painter();
    if enabled && resp.hovered() {
        p.rect_filled(r, CornerRadius::same(theme::R), theme::HOVER);
    }
    p.text(r.center(), Align2::CENTER_CENTER, text, theme::font(theme::FS_S), if enabled { theme::TEXT_2 } else { theme::TEXT_3 });
    resp.on_hover_text(tip)
}

fn seg_button(ui: &mut egui::Ui, r: Rect, text: &str, on: bool, tip: &str) -> egui::Response {
    let resp = ui.interact(r, ui.id().with(("seg", text)), Sense::click());
    let p = ui.painter();
    p.rect_filled(r, CornerRadius::same(theme::R), if on { theme::ACCENT_WASH } else if resp.hovered() { theme::HOVER } else { theme::FIELD });
    p.rect_stroke(r, CornerRadius::same(theme::R), Stroke::new(1.0_f32, if on { theme::ACCENT } else { theme::LINE }), StrokeKind::Inside);
    p.text(r.center(), Align2::CENTER_CENTER, text, theme::font(theme::FS_S), if on { theme::TEXT } else { theme::TEXT_2 });
    resp.on_hover_text(tip)
}

fn check(ui: &mut egui::Ui, r: Rect, text: &str, on: bool, tip: &str) -> egui::Response {
    let resp = ui.interact(r, ui.id().with(("check", text)), Sense::click());
    let p = ui.painter();
    let bx = Rect::from_center_size(Pos2::new(r.left() + 7.0, r.center().y), Vec2::splat(12.0));
    p.rect_filled(bx, CornerRadius::same(2), if on { theme::ACCENT } else { theme::FIELD });
    p.rect_stroke(bx, CornerRadius::same(2), Stroke::new(1.0_f32, if on { theme::ACCENT } else { theme::LINE }), StrokeKind::Inside);
    p.text(Pos2::new(bx.right() + 4.0, r.center().y), Align2::LEFT_CENTER, text, theme::font(theme::FS_S), if resp.hovered() { theme::TEXT } else { theme::TEXT_2 });
    resp.on_hover_text(tip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({
            "entries": [
                { "key": "1:5", "name": "Logo", "doc": "a.psd", "state": "", "usable": true },
                { "key": "2:7", "name": "背景", "doc": "b.psd", "state": "来源未打开", "usable": false },
                { "key": "1:6", "name": "标题", "doc": "a.psd", "state": "", "usable": true },
                { "key": "", "name": "无效", "doc": "a.psd" }
            ],
            "summary": { "target": "海报.psd", "busy": false, "status": "", "positionSelection": true, "wrapGroup": true, "restore": true }
        })
    }

    #[test]
    fn sections_parse_and_entries_group_by_document() {
        let mut shelf = Shelf::new();
        shelf.apply(state().as_object().unwrap());
        assert_eq!(shelf.entries.len(), 3);
        assert_eq!(shelf.summary.target, "海报.psd");
        assert!(shelf.summary.position_selection);
        let g = groups(&shelf.entries);
        assert_eq!(g, vec![("a.psd".to_string(), vec![0, 2]), ("b.psd".to_string(), vec![1])]);
    }

    #[test]
    fn placing_takes_the_selected_usable_entries_or_all_usable_ones() {
        let mut shelf = Shelf::new();
        shelf.apply(state().as_object().unwrap());
        assert_eq!(shelf.placeable(), vec!["1:5".to_string(), "1:6".to_string()]);
        shelf.selected = HashSet::from(["1:6".to_string(), "2:7".to_string()]);
        assert_eq!(shelf.placeable(), vec!["1:6".to_string()]);
    }

    #[test]
    fn click_ctrl_and_shift_select_like_the_plugin() {
        let order: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let (sel, a) = click_select(&order, &HashSet::new(), None, "b", false, false);
        let (sel, _) = click_select(&order, &sel, Some(&a), "d", false, true);
        let mut v: Vec<_> = sel.iter().cloned().collect();
        v.sort();
        assert_eq!(v, ["b", "c", "d"]);
        let (sel, _) = click_select(&order, &sel, Some("b"), "c", true, false);
        assert!(!sel.contains("c") && sel.contains("d"));
    }

    #[test]
    fn height_follows_the_list_and_the_drop_band() {
        let mut shelf = Shelf::new();
        let empty = shelf.content_height(false);
        shelf.apply(state().as_object().unwrap());
        let three = shelf.content_height(false);
        assert_eq!(three - empty, 2.0 * SRC_H + 3.0 * ROW_H - ROW_H);
        assert_eq!(shelf.content_height(true) - three, BAND_H);
        assert_eq!(elide("一二三四五", 3), "一二…");
    }
}
