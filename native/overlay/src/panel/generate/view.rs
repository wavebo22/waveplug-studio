// Draws the external generate panel from a PanelState, laid out like the plugin's generate page
// (and the user's reference screenshot): mode tabs, then one card with the prompt, favourites,
// references, count and the generate button, then 高级参数. Returns what the user did; text the
// user types and the open / closed parts are kept in the state directly.

use eframe::egui::{
    self, pos2, vec2, Align, Align2, Color32, CornerRadius, Frame, Layout, Margin, Painter, Pos2,
    Rect, Response, RichText, Sense, Shape, Stroke, StrokeKind, TextEdit, Ui,
};

use super::state::{Action, Mode, PanelState, Param, RefSource, Tone};
use crate::panel::theme::*;
use crate::panel::ExternalLayerDrag;
use data_encoding::BASE64;

/// The button says this in every mode (the plugin's own text, 融图 / 抠图 …, isn't used here).
const START: &str = "开始";
/// 高级参数 stay in the plugin panel (user 11-04); the card's code is kept for when they come back.
const SHOW_ADVANCED: bool = false;

pub fn panel(
    ui: &mut Ui,
    s: &mut PanelState,
    drag_preview: Option<&egui::TextureHandle>,
) -> Vec<Action> {
    let mut out = Vec::new();
    mode_tabs(ui, s, &mut out);
    ui.add_space(6.0);
    card(ui, |ui| main_card(ui, s, &mut out, drag_preview));
    if SHOW_ADVANCED {
        ui.add_space(6.0);
        card(ui, |ui| advanced(ui, s, &mut out));
    }
    if let Some((tone, text)) = &s.status {
        ui.add_space(4.0);
        status_line(ui, *tone, text);
    }
    out
}

fn card(ui: &mut Ui, body: impl FnOnce(&mut Ui)) {
    Frame::new()
        .fill(SURFACE)
        .stroke(Stroke::new(1.0_f32, LINE_SOFT))
        .corner_radius(CornerRadius::same(R_CARD))
        .inner_margin(Margin::same(10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            body(ui)
        });
}

/// .seg: a sunken strip of equal buttons, the chosen one filled with the accent
fn mode_tabs(ui: &mut Ui, s: &PanelState, out: &mut Vec<Action>) {
    Frame::new()
        .fill(FIELD)
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(R_CARD))
        .inner_margin(Margin::same(2))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            let w = ui.available_width() / Mode::ALL.len() as f32;
            ui.horizontal(|ui| {
                for m in Mode::ALL {
                    let (rect, resp) = ui.allocate_exact_size(vec2(w, H_M), Sense::click());
                    let on = s.mode == Some(m);
                    let p = ui.painter();
                    if on {
                        p.rect_filled(rect, CornerRadius::same(R), ACCENT);
                    } else if resp.hovered() {
                        p.rect_filled(rect, CornerRadius::same(R), HOVER);
                    }
                    let (f, c) = if on {
                        (font_bold(FS), ACCENT_INK)
                    } else {
                        (font(FS), if resp.hovered() { TEXT } else { TEXT_2 })
                    };
                    p.text(rect.center(), Align2::CENTER_CENTER, m.label(), f, c);
                    if resp.clicked() && !on {
                        out.push(Action::SetMode(m));
                    }
                }
            });
        });
}

fn main_card(
    ui: &mut Ui,
    s: &mut PanelState,
    out: &mut Vec<Action>,
    drag_preview: Option<&egui::TextureHandle>,
) {
    // prompt; the mode's hint sits inside the box until something is typed (the plugin keeps it
    // outside only because UXP's textarea can merge a placeholder into the text)
    let edit = TextEdit::multiline(&mut s.prompt)
        .desired_rows(4)
        .desired_width(f32::INFINITY)
        .font(font(FS))
        .text_color(TEXT)
        .hint_text(RichText::new(&s.hint).size(FS).color(TEXT_3))
        .margin(Margin::symmetric(8, 6))
        .background_color(FIELD);
    let resp = ui.add(edit);
    s.prompt_focused = resp.has_focus();
    if resp.changed() {
        out.push(Action::SetPrompt(s.prompt.clone()));
    }

    // ☆ 收藏 · 收藏夹 N ▾
    ui.horizontal(|ui| {
        let text = s.prompt.trim().to_string();
        let saved = !text.is_empty() && s.favorites.contains(&text);
        let star = if saved { "★ 已收藏" } else { "☆ 收藏" };
        let b = button(ui, star, !text.is_empty(), saved);
        if b.clicked() {
            out.push(Action::ToggleFavorite);
        }
        b.on_hover_text(if text.is_empty() {
            "先输入提示词再收藏"
        } else if saved {
            "取消收藏这条提示词"
        } else {
            "收藏这条提示词"
        });
        let label = format!("收藏夹 {}", s.favorites.len());
        if chevron_button(ui, &label, s.fav_open).clicked() {
            s.fav_open = !s.fav_open;
        }
    });
    if s.fav_open {
        favorites(ui, s, out);
    }

    // References remain mounted during an external drag, even when the workflow currently has
    // no slots, so a release can safely clear the pending drag state.
    if !s.refs.is_empty() || s.external_drag.is_some() {
        references(ui, s, out, drag_preview);
    }

    // 数量：左侧 × 重置，滚轮在输入框上方快速调整 1～4。
    ui.add_space(2.0);
    ui.allocate_ui_with_layout(
        vec2(ui.available_width(), 34.0),
        Layout::left_to_right(Align::Center),
        |ui| {
            if icon_button(ui, "×", "重置数量为 1").clicked() {
                s.count = 1;
                s.count_text = "1".into();
                out.push(Action::SetCount(1));
            }
            let count = ui.add(
                TextEdit::singleline(&mut s.count_text)
                    .desired_width(34.0)
                    .min_size(vec2(34.0, 34.0))
                    .horizontal_align(Align::Center)
                    .vertical_align(Align::Center)
                    .font(font(FS_L))
                    .text_color(TEXT)
                    .background_color(FIELD),
            );
            s.count_focused = count.has_focus();
            count
                .clone()
                .on_hover_text("本次生成数量（1～4）；鼠标滚轮可增减");
            if count.changed() {
                if let Ok(n @ 1..=4) = s.count_text.trim().parse::<u32>() {
                    if n != s.count {
                        s.count = n;
                        out.push(Action::SetCount(n));
                    }
                }
            }
            let wheel = if count.hovered() {
                ui.input(|i| i.raw_scroll_delta.y)
            } else {
                0.0
            };
            if wheel.abs() > 0.0 {
                let next = super::state::count_after_wheel(s.count, wheel);
                if next != s.count {
                    s.count = next;
                    s.count_text = next.to_string();
                    out.push(Action::SetCount(next));
                }
            }
            if count.lost_focus() {
                s.count_text = s.count.to_string();
            }
            generate_button(ui, s, out);
        },
    );

    // progress, or why it can't run
    if let Some(run) = &s.running {
        progress(ui, run.progress, &run.stage);
    } else if let Some(why) = &s.blocked {
        ui.label(RichText::new(why).size(FS).color(TEXT_2));
    }
}

fn favorites(ui: &mut Ui, s: &mut PanelState, out: &mut Vec<Action>) {
    Frame::new()
        .fill(FIELD)
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(R))
        .inner_margin(Margin::same(4))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            if s.favorites.is_empty() {
                ui.label(
                    RichText::new("还没有收藏。输入提示词后点「☆ 收藏」")
                        .size(FS_S)
                        .color(TEXT_3),
                );
                return;
            }
            let current = s.prompt.trim().to_string();
            for t in s.favorites.clone() {
                ui.horizontal(|ui| {
                    let w = ui.available_width() - 24.0;
                    let (rect, resp) = ui.allocate_exact_size(vec2(w, 24.0), Sense::click());
                    let on = t == current;
                    if on || resp.hovered() {
                        ui.painter().rect_filled(
                            rect,
                            CornerRadius::same(R),
                            if on {
                                Color32::from_rgb(0x2f, 0x45, 0x41)
                            } else {
                                HOVER
                            },
                        );
                    }
                    let clipped = ui.painter().with_clip_rect(rect.shrink2(vec2(6.0, 0.0)));
                    clipped.text(
                        pos2(rect.left() + 6.0, rect.center().y),
                        Align2::LEFT_CENTER,
                        &t,
                        font(FS),
                        TEXT,
                    );
                    if resp.clicked() {
                        out.push(Action::PickFavorite(t.clone()));
                    }
                    resp.on_hover_text(&t);
                    if icon_button(ui, "×", "从收藏夹删除").clicked() {
                        out.push(Action::RemoveFavorite(t.clone()));
                    }
                });
            }
        });
}

fn reference_texture(
    ctx: &egui::Context,
    slot: u32,
    data_url: &str,
) -> Result<egui::TextureHandle, String> {
    use super::state::{
        MAX_REFERENCE_THUMB_BYTES, MAX_REFERENCE_THUMB_EDGE, MAX_REFERENCE_THUMB_URL_LEN,
    };
    if data_url.len() > MAX_REFERENCE_THUMB_URL_LEN {
        return Err(format!("缩略图 URL 过长：{} bytes", data_url.len()));
    }
    let (mime, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "缩略图缺少 data URL 分隔符".to_string())?;
    if mime != "data:image/png;base64" && mime != "data:image/jpeg;base64" {
        return Err(format!("不支持的缩略图格式：{mime}"));
    }
    let bytes = BASE64
        .decode(encoded.as_bytes())
        .map_err(|e| format!("缩略图 Base64 解码失败：{e}"))?;
    if bytes.len() > MAX_REFERENCE_THUMB_BYTES {
        return Err(format!("缩略图数据过大：{} bytes", bytes.len()));
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("缩略图图片解码失败：{e}"))?
        .to_rgba8();
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 || w > MAX_REFERENCE_THUMB_EDGE || h > MAX_REFERENCE_THUMB_EDGE {
        return Err(format!("缩略图尺寸无效：{w}×{h}"));
    }
    let color = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], image.as_raw());
    Ok(ctx.load_texture(
        format!("wp-reference-{slot}"),
        color,
        egui::TextureOptions::LINEAR,
    ))
}

pub fn drag_preview_texture(
    ctx: &egui::Context,
    data_url: &str,
) -> Result<egui::TextureHandle, String> {
    reference_texture(ctx, u32::MAX, data_url)
}

fn draw_drag_preview(
    ui: &Ui,
    drag: &ExternalLayerDrag,
    cursor: Pos2,
    texture: Option<&egui::TextureHandle>,
) {
    let clip = ui.clip_rect();
    let size = vec2(168.0, 44.0);
    let mut pos = cursor + vec2(14.0, 14.0);
    if pos.x + size.x > clip.right() {
        pos.x = cursor.x - size.x - 14.0;
    }
    if pos.y + size.y > clip.bottom() {
        pos.y = cursor.y - size.y - 14.0;
    }
    pos.x = pos
        .x
        .clamp(clip.left(), (clip.right() - size.x).max(clip.left()));
    pos.y = pos
        .y
        .clamp(clip.top(), (clip.bottom() - size.y).max(clip.top()));
    let rect = Rect::from_min_size(pos, size);
    let painter = ui.painter();
    painter.rect_filled(
        rect,
        CornerRadius::same(R),
        Color32::from_rgba_unmultiplied(38, 38, 38, 224),
    );
    painter.rect_stroke(
        rect,
        CornerRadius::same(R),
        Stroke::new(1.0_f32, ACCENT_HI),
        StrokeKind::Inside,
    );
    let image = Rect::from_min_size(rect.min + vec2(6.0, 6.0), vec2(32.0, 32.0));
    painter.rect_filled(image, CornerRadius::same(R), FIELD);
    if let Some(texture) = texture {
        painter.image(
            texture.id(),
            image.shrink(1.0),
            Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0)),
            Color32::from_white_alpha(230),
        );
    } else {
        painter.text(
            image.center(),
            Align2::CENTER_CENTER,
            "图层",
            font(FS_S),
            TEXT_2,
        );
    }
    let label = Rect::from_min_max(
        pos2(image.right() + 8.0, rect.top()),
        rect.max - vec2(6.0, 0.0),
    );
    let p = painter.with_clip_rect(label);
    let count = drag.total_count.max(drag.layers.len());
    let title = if count > drag.layers.len() {
        format!("{} / {} 个图层", drag.layers.len(), count)
    } else if count > 1 {
        format!("{} 个图层", count)
    } else {
        drag.layers.first().map(|layer| layer.name.as_str()).unwrap_or("图层").to_string()
    };
    p.text(
        pos2(label.left(), rect.top() + 14.0),
        Align2::LEFT_CENTER,
        title,
        font(FS),
        TEXT,
    );
    p.text(
        pos2(label.left(), rect.top() + 30.0),
        Align2::LEFT_CENTER,
        if count > 1 { "依次放入空槽位" } else { "拖入参考图" },
        font(FS_S),
        ACCENT_HI,
    );
}

fn references(
    ui: &mut Ui,
    s: &mut PanelState,
    out: &mut Vec<Action>,
    drag_preview: Option<&egui::TextureHandle>,
) {
    const TILE: f32 = 56.0;
    let ctx = ui.ctx().clone();
    let external_drag = s.external_drag.clone();
    #[cfg(windows)]
    let cursor = external_drag.as_ref().and_then(|_| crate::win::cursor_local(ctx.pixels_per_point()))
        .map(|(x, y)| pos2(x, y));
    #[cfg(not(windows))]
    let cursor: Option<Pos2> = None;
    #[cfg(windows)]
    let released = external_drag.is_some() && !crate::win::left_button_down();
    #[cfg(not(windows))]
    let released = false;
    #[cfg(windows)]
    let cancelled = external_drag.is_some() && crate::win::escape_down();
    #[cfg(not(windows))]
    let cancelled = false;
    let mut dropped = false;
    ui.horizontal_wrapped(|ui| {
        for r in &mut s.refs {
            let (rect, resp) = ui.allocate_exact_size(vec2(TILE, TILE), Sense::click());
            let drop_hover = external_drag.is_some() && cursor.is_some_and(|point| rect.contains(point));
            if released && drop_hover {
                if let Some(drag) = external_drag.as_ref() {
                    out.push(Action::DropRefs {
                        slot: r.slot,
                        doc_id: drag.doc_id,
                        layers: drag.layers.clone(),
                        total_count: drag.total_count,
                    });
                    dropped = true;
                }
            }
            if let Some(f) = &mut r.filled {
                if f.texture.is_none() && f.texture_error.is_none() {
                    if let Some(url) = f.thumb.as_deref() {
                        match reference_texture(&ctx, r.slot, url) {
                            Ok(texture) => f.texture = Some(texture),
                            Err(error) => {
                                crate::log::line(format!(
                                    "reference thumbnail decode failed slot={} name={} error={}",
                                    r.slot, f.name, error
                                ));
                                f.texture_error = Some(error);
                            }
                        }
                    }
                }
                let p = ui.painter();
                p.rect_filled(
                    rect,
                    CornerRadius::same(R),
                    if drop_hover { ACCENT_WASH } else { FIELD },
                );
                if let Some(texture) = &f.texture {
                    let source = texture.size_vec2();
                    let bounds = rect.shrink(2.0);
                    let scale = (bounds.width() / source.x).min(bounds.height() / source.y);
                    let fitted = Rect::from_center_size(rect.center(), source * scale);
                    p.image(
                        texture.id(),
                        fitted,
                        Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0)),
                        Color32::WHITE,
                    );
                } else {
                    p.text(
                        rect.center() - vec2(0.0, 5.0),
                        Align2::CENTER_CENTER,
                        "图像",
                        font(FS),
                        TEXT_2,
                    );
                }
                p.rect_stroke(
                    rect,
                    CornerRadius::same(R),
                    Stroke::new(
                        if drop_hover { 2.0_f32 } else { 1.0_f32 },
                        if drop_hover { ACCENT_HI } else if resp.hovered() { ACCENT } else { LINE },
                    ),
                    StrokeKind::Inside,
                );
                if drop_hover {
                    let hint = Rect::from_min_max(rect.min + vec2(2.0, 2.0), pos2(rect.right() - 2.0, rect.top() + 16.0));
                    p.rect_filled(hint, CornerRadius::same(2), ACCENT);
                    p.text(hint.center(), Align2::CENTER_CENTER, "松开放入", font(FS_S), ACCENT_INK);
                }
                let tag = Rect::from_min_max(pos2(rect.left(), rect.bottom() - 16.0), rect.max);
                p.rect_filled(
                    tag,
                    CornerRadius {
                        nw: 0,
                        ne: 0,
                        sw: R,
                        se: R,
                    },
                    Color32::from_black_alpha(150),
                );
                p.text(
                    tag.center(),
                    Align2::CENTER_CENTER,
                    &f.tag,
                    font(FS_S),
                    TEXT,
                );
                // × in the corner removes it
                let x = Rect::from_center_size(
                    pos2(rect.right() - 8.0, rect.top() + 8.0),
                    vec2(14.0, 14.0),
                );
                let over_x = resp.hover_pos().is_some_and(|pt| x.contains(pt));
                p.circle_filled(
                    x.center(),
                    7.0,
                    if over_x {
                        ERR
                    } else {
                        Color32::from_black_alpha(170)
                    },
                );
                p.text(x.center(), Align2::CENTER_CENTER, "×", font(FS_S), TEXT);
                if resp.clicked() && external_drag.is_none() {
                    if over_x {
                        out.push(Action::RemoveRef(r.slot));
                    } else {
                        s.ref_menu = Some(r.slot);
                    }
                }
                resp.on_hover_text(if drop_hover {
                    let count = external_drag.as_ref().map(|d| d.total_count.max(d.layers.len())).unwrap_or(1);
                    if count > 1 { format!("松开鼠标，将 {count} 个图层依次放入空槽位") }
                    else { format!("松开鼠标，将图层设为 {}", f.tag) }
                } else {
                    format!("{}：{}（点击更换，点 × 移除）", f.tag, f.name)
                });
            } else {
                let p = ui.painter();
                let c = if drop_hover || resp.hovered() { ACCENT_HI } else { ACCENT };
                if drop_hover || resp.hovered() {
                    p.rect_filled(
                        rect,
                        CornerRadius::same(R),
                        ACCENT_WASH,
                    );
                }
                dashed_rect(p, rect.shrink(0.5), Stroke::new(if drop_hover { 2.0_f32 } else { 1.0_f32 }, c));
                p.text(
                    rect.center() - vec2(0.0, 8.0),
                    Align2::CENTER_CENTER,
                    if drop_hover { "↓" } else { "+" },
                    font(16.0),
                    c,
                );
                p.text(
                    rect.center() + vec2(0.0, 12.0),
                    Align2::CENTER_CENTER,
                    if drop_hover { "松开放入" } else { "参考图" },
                    font(FS_S),
                    c,
                );
                if resp.clicked() && external_drag.is_none() {
                    s.ref_menu = if s.ref_menu == Some(r.slot) {
                        None
                    } else {
                        Some(r.slot)
                    };
                }
                resp.on_hover_text(if drop_hover {
                    let count = external_drag.as_ref().map(|d| d.total_count.max(d.layers.len())).unwrap_or(1);
                    if count > 1 { format!("松开鼠标，将 {count} 个图层依次放入空槽位") }
                    else { "松开鼠标，将图层放入此参考图".to_string() }
                } else {
                    "添加参考图：当前图层、图片文件或剪贴板".to_string()
                });
            }
        }
    });
    if !released && !cancelled {
        if let (Some(drag), Some(cursor)) = (external_drag.as_ref(), cursor) {
            draw_drag_preview(ui, drag, cursor, drag_preview);
        }
    }
    if cancelled {
        crate::log::line("WaveLayer layer drag cancelled with Escape");
        out.push(Action::FinishLayerDrag);
        s.external_drag = None;
    } else if released {
        if !dropped {
            crate::log::line("WaveLayer layer drag released outside a reference slot");
        }
        out.push(Action::FinishLayerDrag);
        s.external_drag = None;
    }
    // where the picture comes from (the plugin's refMenu)
    if let Some(slot) = s.ref_menu {
        ui.horizontal(|ui| {
            for src in RefSource::ALL {
                if button(ui, src.label(), true, false).clicked() {
                    out.push(Action::AddRef { slot, source: src });
                    s.ref_menu = None;
                }
            }
            if icon_button(ui, "×", "关闭").clicked() {
                s.ref_menu = None;
            }
        });
    }
}

/// .generate: the wide accent button; dimmed while it can't run, 取消 while running
fn generate_button(ui: &mut Ui, s: &PanelState, out: &mut Vec<Action>) {
    let size = vec2(ui.available_width(), 34.0);
    let running = s.running.is_some();
    let enabled = running || s.blocked.is_none();
    let (rect, resp) = ui.allocate_exact_size(
        size,
        if enabled {
            Sense::click()
        } else {
            Sense::hover()
        },
    );
    let (fill, ink) = if running {
        (RUN_BG, RUN_INK)
    } else if !enabled {
        (ACCENT_WASH, DISABLED_INK)
    } else if resp.hovered() {
        (ACCENT_HI, ACCENT_INK)
    } else {
        (ACCENT, ACCENT_INK)
    };
    let p = ui.painter();
    p.rect_filled(rect, CornerRadius::same(R), fill);
    let label = if running { "取消" } else { START };
    let galley = p.layout_no_wrap(label.to_string(), font_bold(FS_L), ink);
    let icon_w = 18.0;
    let start = rect.center().x - (icon_w + galley.size().x) / 2.0;
    let icon_c = pos2(start + 6.0, rect.center().y);
    if running {
        p.rect_filled(
            Rect::from_center_size(icon_c, vec2(9.0, 9.0)),
            CornerRadius::same(1),
            ink,
        );
    } else {
        spark(p, icon_c, 6.0, ink);
    }
    p.galley(
        pos2(start + icon_w, rect.center().y - galley.size().y / 2.0),
        galley,
        ink,
    );
    if resp.clicked() {
        out.push(if running {
            Action::Cancel
        } else {
            Action::Generate
        });
    }
    if let (false, Some(why)) = (enabled, &s.blocked) {
        resp.on_hover_text(why);
    }
}

fn progress(ui: &mut Ui, ratio: f32, stage: &str) {
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 4.0), Sense::hover());
    let p = ui.painter();
    p.rect_filled(rect, CornerRadius::same(2), FIELD);
    let done = Rect::from_min_size(
        rect.min,
        vec2(rect.width() * ratio.clamp(0.0, 1.0), rect.height()),
    );
    p.rect_filled(done, CornerRadius::same(2), ACCENT);
    ui.label(RichText::new(stage).size(FS_S).color(TEXT_2));
}

fn advanced(ui: &mut Ui, s: &mut PanelState, out: &mut Vec<Action>) {
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 22.0), Sense::click());
    let p = ui.painter();
    sliders_icon(p, pos2(rect.left() + 8.0, rect.center().y), TEXT_2);
    p.text(
        pos2(rect.left() + 24.0, rect.center().y),
        Align2::LEFT_CENTER,
        "高级参数",
        font_bold(FS_L),
        TEXT,
    );
    chevron(
        p,
        pos2(rect.right() - 8.0, rect.center().y),
        s.adv_open,
        if resp.hovered() { TEXT } else { TEXT_2 },
    );
    if resp.clicked() {
        s.adv_open = !s.adv_open;
    }
    if !s.adv_open {
        return;
    }
    ui.add_space(4.0);
    if s.params.is_empty() {
        ui.label(
            RichText::new("该工作流没有绑定可调参数。")
                .size(FS_S)
                .color(TEXT_3),
        );
        return;
    }
    for param in s.params.iter_mut() {
        match param {
            Param::Number {
                key,
                label,
                value,
                base,
                min,
                max,
                int,
            } => {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(label.as_str()).size(FS).color(TEXT));
                    if (*value - *base).abs() > 1e-9 {
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui
                                .add(
                                    egui::Label::new(
                                        RichText::new("复原").size(FS_S).color(ACCENT_HI),
                                    )
                                    .sense(Sense::click()),
                                )
                                .on_hover_text("恢复工作流中的原始值")
                                .clicked()
                            {
                                out.push(Action::ResetNumber(key.clone()));
                            }
                        });
                    }
                });
                ui.horizontal(|ui| {
                    let before = *value;
                    ui.spacing_mut().slider_width = (ui.available_width() - 70.0).max(60.0);
                    ui.visuals_mut().selection.bg_fill = ACCENT;
                    let step = if *int { 1.0 } else { 0.01 };
                    ui.add(
                        egui::Slider::new(value, *min..=*max)
                            .show_value(false)
                            .step_by(step)
                            .trailing_fill(true),
                    );
                    ui.add_sized(
                        vec2(60.0, 22.0),
                        egui::DragValue::new(value)
                            .range(*min..=*max)
                            .speed(step)
                            .max_decimals(if *int { 0 } else { 2 }),
                    );
                    if (*value - before).abs() > 1e-12 {
                        out.push(Action::SetNumber {
                            key: key.clone(),
                            value: *value,
                        });
                    }
                });
                ui.add_space(2.0);
            }
            Param::Toggle {
                key,
                label,
                value,
                tip,
            } => {
                let r = ui.checkbox(value, RichText::new(label.as_str()).size(FS).color(TEXT));
                if r.changed() {
                    out.push(Action::SetToggle {
                        key: key.clone(),
                        value: *value,
                    });
                }
                if !tip.is_empty() {
                    r.on_hover_text(tip.as_str());
                }
            }
            Param::Seed { random, value } => {
                ui.label(RichText::new("随机种子").size(FS).color(TEXT));
                ui.horizontal(|ui| {
                    let was = (*random, *value);
                    egui::ComboBox::from_id_salt("seed-mode")
                        .width(84.0)
                        .selected_text(if *random { "每次随机" } else { "固定" })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(random, true, "每次随机");
                            ui.selectable_value(random, false, "固定");
                        });
                    ui.add_enabled(!*random, egui::DragValue::new(value).speed(1.0));
                    if (*random, *value) != was {
                        out.push(Action::SetSeed {
                            random: *random,
                            value: *value,
                        });
                    }
                    if button(ui, "换一个", true, false)
                        .on_hover_text("换一个种子")
                        .clicked()
                    {
                        out.push(Action::NewSeed);
                    }
                });
            }
        }
    }
}

fn status_line(ui: &mut Ui, tone: Tone, text: &str) {
    ui.horizontal(|ui| {
        let (rect, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
        ui.painter().circle_filled(
            rect.center(),
            4.0,
            match tone {
                Tone::Ok => OK,
                Tone::Error => ERR,
                Tone::Info => TEXT_3,
            },
        );
        ui.label(RichText::new(text).size(FS_S).color(TEXT_2));
    });
}

// ── small pieces ──

/// .btn: outlined, 26 px tall; `on` draws it in the accent colour (已收藏)
fn button(ui: &mut Ui, text: &str, enabled: bool, on: bool) -> Response {
    let color = if on { ACCENT_HI } else { TEXT };
    ui.add_enabled(
        enabled,
        egui::Button::new(RichText::new(text).size(FS).color(color))
            .min_size(vec2(0.0, H_M))
            .fill(Color32::TRANSPARENT)
            .stroke(Stroke::new(1.0_f32, if on { ACCENT } else { LINE }))
            .corner_radius(CornerRadius::same(R)),
    )
}

fn chevron_button(ui: &mut Ui, text: &str, open: bool) -> Response {
    let galley = ui
        .painter()
        .layout_no_wrap(text.to_string(), font(FS), TEXT);
    let size = vec2(galley.size().x + 32.0, H_M);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let p = ui.painter();
    if resp.hovered() {
        p.rect_filled(rect, CornerRadius::same(R), HOVER);
    }
    p.rect_stroke(
        rect,
        CornerRadius::same(R),
        Stroke::new(1.0_f32, if resp.hovered() { ACCENT } else { LINE }),
        StrokeKind::Inside,
    );
    p.galley(
        pos2(rect.left() + 10.0, rect.center().y - galley.size().y / 2.0),
        galley,
        TEXT,
    );
    chevron(p, pos2(rect.right() - 12.0, rect.center().y), open, TEXT_2);
    resp
}

fn icon_button(ui: &mut Ui, glyph: &str, tip: &str) -> Response {
    let (rect, resp) = ui.allocate_exact_size(vec2(18.0, 18.0), Sense::click());
    if resp.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(R), HOVER);
    }
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        glyph,
        font(FS),
        if resp.hovered() { TEXT } else { TEXT_2 },
    );
    resp.on_hover_text(tip)
}

/// ▾ when closed, ▴ when open (the plugin turns its chevron the same way)
fn chevron(p: &Painter, c: Pos2, open: bool, color: Color32) {
    let (w, h) = (4.0, 2.5);
    let pts = if open {
        vec![
            pos2(c.x - w, c.y + h),
            pos2(c.x, c.y - h),
            pos2(c.x + w, c.y + h),
        ]
    } else {
        vec![
            pos2(c.x - w, c.y - h),
            pos2(c.x, c.y + h),
            pos2(c.x + w, c.y - h),
        ]
    };
    p.add(Shape::line(pts, Stroke::new(1.5_f32, color)));
}

/// the generate button's sparkle (dom.ts `spark`)
fn spark(p: &Painter, c: Pos2, r: f32, color: Color32) {
    let s = Stroke::new(1.5_f32, color);
    for (dx, dy) in [(0.0, 1.0), (1.0, 0.0), (0.7, 0.7), (0.7, -0.7)] {
        p.line_segment(
            [
                pos2(c.x - dx * r, c.y - dy * r),
                pos2(c.x - dx * r * 0.35, c.y - dy * r * 0.35),
            ],
            s,
        );
        p.line_segment(
            [
                pos2(c.x + dx * r * 0.35, c.y + dy * r * 0.35),
                pos2(c.x + dx * r, c.y + dy * r),
            ],
            s,
        );
    }
}

/// 高级参数's icon (dom.ts `sliders`): three tracks with knobs
fn sliders_icon(p: &Painter, c: Pos2, color: Color32) {
    let s = Stroke::new(1.3_f32, color);
    for (i, knob) in [(-4.0f32, 2.0f32), (0.0, -2.5), (4.0, 1.0)] {
        p.line_segment([pos2(c.x - 6.0, c.y + i), pos2(c.x + 6.0, c.y + i)], s);
        p.line_segment(
            [
                pos2(c.x + knob, c.y + i - 2.0),
                pos2(c.x + knob, c.y + i + 2.0),
            ],
            Stroke::new(2.0_f32, color),
        );
    }
}

/// the empty reference slot's dashed outline (.ref.add)
fn dashed_rect(p: &Painter, r: Rect, stroke: Stroke) {
    let corners = [
        r.left_top(),
        r.right_top(),
        r.right_bottom(),
        r.left_bottom(),
        r.left_top(),
    ];
    p.extend(Shape::dashed_line(&corners, stroke, 4.0, 3.0));
}
