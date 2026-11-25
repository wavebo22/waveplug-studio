// WavePlug's second native window: a narrow, vertically scrolling AI-variation rail.
// The plugin remains authoritative for image data and Photoshop actions.
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use data_encoding::BASE64;
use eframe::egui::{
    self, Align2, Color32, ColorImage, CornerRadius, FontId, Id, Pos2, Rect, ResizeDirection,
    Sense, Stroke, StrokeKind, TextureHandle, TextureOptions, Vec2, ViewportCommand,
};
use serde_json::{json, Map, Value};

use crate::panel::theme;

pub const ID: &str = "variants";
pub const TITLE: &str = "WavePlug 变体";

const THUMB_BORDER: f32 = 2.0;
const LABEL_HEIGHT: f32 = 19.0;
const CARD_GAP: f32 = 3.0;
const PANEL_PADDING_Y: f32 = 6.0;
const SLIDER_HEIGHT: f32 = 13.0;
const SLIDER_LIST_GAP: f32 = 3.0;
const RESIZE_GRIP_RESERVE: f32 = 10.0;
/// the 删除 button in a hovered thumbnail's corner
const DELETE_ICON: f32 = 18.0;

/// A small dark rounded button with a bin (like the WaveLayer panel's 垃圾桶), red while the
/// pointer is on it.
fn paint_delete_icon(p: &egui::Painter, r: Rect, hot: bool) {
    p.rect_filled(r, CornerRadius::same(4), if hot { theme::ERR } else { Color32::from_black_alpha(190) });
    p.rect_stroke(r, CornerRadius::same(4), Stroke::new(1.0_f32, Color32::from_white_alpha(if hot { 0 } else { 50 })), StrokeKind::Inside);
    let c = r.center();
    let ink = if hot { Color32::WHITE } else { theme::TEXT };
    let s = Stroke::new(1.2_f32, ink);
    // lid with its handle, then the can with two ribs
    p.line_segment([Pos2::new(c.x - 4.5, c.y - 3.0), Pos2::new(c.x + 4.5, c.y - 3.0)], s);
    p.line_segment([Pos2::new(c.x - 1.5, c.y - 4.8), Pos2::new(c.x + 1.5, c.y - 4.8)], s);
    p.line_segment([Pos2::new(c.x - 3.3, c.y - 1.5), Pos2::new(c.x - 2.6, c.y + 4.5)], s);
    p.line_segment([Pos2::new(c.x + 3.3, c.y - 1.5), Pos2::new(c.x + 2.6, c.y + 4.5)], s);
    p.line_segment([Pos2::new(c.x - 2.6, c.y + 4.5), Pos2::new(c.x + 2.6, c.y + 4.5)], s);
    p.line_segment([Pos2::new(c.x - 0.9, c.y - 0.5), Pos2::new(c.x - 0.9, c.y + 3.0)], Stroke::new(1.0_f32, ink));
    p.line_segment([Pos2::new(c.x + 0.9, c.y - 0.5), Pos2::new(c.x + 0.9, c.y + 3.0)], Stroke::new(1.0_f32, ink));
}

fn paint_compact_thumb_slider(ui: &mut egui::Ui, size: &mut f32) {
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(ui.available_width(), SLIDER_HEIGHT),
        Sense::click_and_drag(),
    );
    let x0 = rect.left() + 6.0;
    let x1 = (rect.right() - 6.0).max(x0 + 1.0);
    if response.clicked() || response.dragged() {
        if let Some(pos) = response.interact_pointer_pos() {
            let fraction = ((pos.x - x0) / (x1 - x0)).clamp(0.0, 1.0);
            *size = (64.0 + 136.0 * fraction).round();
        }
    }
    let progress = ((*size - 64.0) / 136.0).clamp(0.0, 1.0);
    let thumb_x = x0 + (x1 - x0) * progress;
    let y = rect.center().y;
    let painter = ui.painter();
    // Keep the always-visible track at 1px and the knob at 5px. No heavy default egui
    // slider handle or value label; hover is still discoverable through a tooltip.
    painter.line_segment(
        [Pos2::new(x0, y), Pos2::new(x1, y)],
        Stroke::new(1.0_f32, Color32::from_gray(77)),
    );
    painter.line_segment(
        [Pos2::new(x0, y), Pos2::new(thumb_x, y)],
        Stroke::new(1.2_f32, Color32::from_gray(118)),
    );
    painter.circle_filled(
        Pos2::new(thumb_x, y),
        if response.hovered() || response.dragged() {
            3.2
        } else {
            2.4
        },
        if response.hovered() || response.dragged() {
            Color32::from_gray(184)
        } else {
            Color32::from_gray(139)
        },
    );
    let _ = response; // no tooltip window over the rail (user 11-24)
}

/// Read only the 24-byte PNG header. Full pixel decoding remains lazy for visible rows.
fn png_dimensions(uri: &str) -> Option<Vec2> {
    let b64 = uri.strip_prefix("data:image/png;base64,")?;
    let header = BASE64.decode(b64.get(..32)?.as_bytes()).ok()?;
    if header.len() != 24 || &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(header[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(header[20..24].try_into().ok()?);
    (w > 0 && h > 0 && w <= 1024 && h <= 1024).then_some(Vec2::new(w as f32, h as f32))
}

fn preview_size(raw: Option<Vec2>, max_edge: f32) -> Vec2 {
    let raw = raw.unwrap_or(Vec2::splat(max_edge));
    let scale = (max_edge / raw.x).min(max_edge / raw.y).min(2.0);
    raw * scale
}

#[derive(Clone, Debug, Default)]
struct Item {
    layer_id: i64,
    number: u32,
    shown: bool,
    thumb: Option<String>,
    preview_dimensions: Option<Vec2>,
}

pub struct VariantRail {
    name: String,
    group_id: i64,
    items: Vec<Item>,
    thumb_px: f32,
    textures: HashMap<i64, (u64, TextureHandle)>,
}

impl VariantRail {
    pub fn new() -> Self {
        Self {
            name: String::new(),
            group_id: 0,
            items: Vec::new(),
            thumb_px: 112.0,
            textures: HashMap::new(),
        }
    }

    /// Fixed panel width follows only the thumbnail slider; the user resizes height below.
    pub fn desired_width(&self) -> f32 {
        (self.thumb_px + 30.0).max(96.0)
    }

    /// All visible content height before clipping by half the Photoshop editing area.
    /// Preserve each image's aspect ratio; the bottom grip remains available to scroll
    /// through variants when a user manually makes the panel shorter.
    pub fn content_height(&self) -> f32 {
        let rows = self
            .items
            .iter()
            .map(|item| {
                preview_size(item.preview_dimensions, self.thumb_px).y
                    + LABEL_HEIGHT
                    + 2.0 * THUMB_BORDER
                    + 2.0
            })
            .sum::<f32>();
        let gaps = CARD_GAP * self.items.len().saturating_sub(1) as f32;
        (2.0 * PANEL_PADDING_Y
            + SLIDER_HEIGHT
            + SLIDER_LIST_GAP
            + rows
            + gaps
            + RESIZE_GRIP_RESERVE)
            .ceil()
    }

    pub fn apply(&mut self, sections: &Map<String, Value>) {
        if let Some(name) = sections.get("name").and_then(Value::as_str) {
            self.name = name.to_string();
        }
        if let Some(id) = sections.get("groupId").and_then(Value::as_i64) {
            if self.group_id != id {
                self.textures.clear();
            }
            self.group_id = id;
        }
        if let Some(items) = sections.get("items").and_then(Value::as_array) {
            self.items = items
                .iter()
                .take(120)
                .filter_map(|raw| {
                    let id = raw.get("layerId")?.as_i64()?;
                    if id <= 0 {
                        return None;
                    }
                    let thumb = raw
                        .get("thumb")
                        .and_then(Value::as_str)
                        .filter(|s| s.len() < 700_000)
                        .map(str::to_owned);
                    let preview_dimensions = thumb.as_deref().and_then(png_dimensions);
                    Some(Item {
                        layer_id: id,
                        number: raw
                            .get("number")
                            .and_then(Value::as_u64)
                            .unwrap_or(1)
                            .min(999) as u32,
                        shown: raw.get("visible").and_then(Value::as_bool).unwrap_or(false),
                        thumb,
                        preview_dimensions,
                    })
                })
                .collect();
            self.textures
                .retain(|id, _| self.items.iter().any(|item| item.layer_id == *id));
        }
    }

    fn texture_for(&mut self, i: usize, ctx: &egui::Context) -> Option<(egui::TextureId, Vec2)> {
        let item = self.items.get(i)?;
        let thumb = item.thumb.as_deref()?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        thumb.hash(&mut hasher);
        let hash = hasher.finish();
        if self
            .textures
            .get(&item.layer_id)
            .is_none_or(|(old, _)| *old != hash)
        {
            let bytes = thumb.split_once(',').and_then(|(mime, b64)| {
                (mime == "data:image/png;base64" || mime == "data:image/jpeg;base64")
                    .then(|| BASE64.decode(b64.as_bytes()).ok())
                    .flatten()
            })?;
            let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
            let (w, h) = img.dimensions();
            if w == 0 || h == 0 || w > 1024 || h > 1024 {
                return None;
            }
            let image = ColorImage::from_rgba_unmultiplied([w as usize, h as usize], img.as_raw());
            let tex = ctx.load_texture(
                format!("wp-v-{}", item.layer_id),
                image,
                TextureOptions::LINEAR,
            );
            self.textures.insert(item.layer_id, (hash, tex));
        }
        let handle = &self.textures.get(&item.layer_id)?.1;
        Some((handle.id(), handle.size_vec2()))
    }

    pub fn draw(&mut self, ctx: &egui::Context) -> Vec<Value> {
        let mut actions = Vec::new();
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(theme::BG)
                    .stroke(Stroke::new(1.0_f32, theme::LINE))
                    .inner_margin(egui::Margin::symmetric(6, 6)),
            )
            .show(ctx, |ui| {
                // Keep the header to a single discreet hairline slider. Selection and group
                // context are already known to Photoshop; no big title, count or px label.
                ui.spacing_mut().item_spacing.y = 0.0;
                paint_compact_thumb_slider(ui, &mut self.thumb_px);
                ui.add_space(SLIDER_LIST_GAP);

                // Layout each row from its real image aspect ratio. In particular, landscape
                // previews should not sit inside square-height cards with huge empty bands.
                ui.spacing_mut().item_spacing.y = CARD_GAP;
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .max_height((ui.available_height() - RESIZE_GRIP_RESERVE).max(1.0))
                    .show(ui, |ui| {
                        let available = ui.available_width().max(1.0);
                        let max_edge = self
                            .thumb_px
                            .min((available - 2.0 * THUMB_BORDER - 2.0).max(20.0));
                        for i in 0..self.items.len() {
                            let item = &self.items[i];
                            let (id, number, chosen) = (item.layer_id, item.number, item.shown);
                            let size = preview_size(item.preview_dimensions, max_edge);
                            let row_height = size.y + LABEL_HEIGHT + 2.0 * THUMB_BORDER + 2.0;
                            let (row, response) = ui.allocate_exact_size(
                                Vec2::new(available, row_height),
                                Sense::click(),
                            );

                            // Keep image decoding lazy: an offscreen row allocates cheap layout
                            // space but never uploads a texture to the GPU.
                            if ui.is_rect_visible(row) {
                                let texture = self.texture_for(i, ctx);
                                let picture = Rect::from_min_size(
                                    Pos2::new(
                                        row.center().x - size.x * 0.5,
                                        row.top() + THUMB_BORDER + 1.0,
                                    ),
                                    size,
                                );
                                // The outline follows the thumbnail itself, not the full-width
                                // row or an artificial square thumbnail container.
                                let outline = picture.expand(THUMB_BORDER);
                                let painter = ui.painter();
                                let bg = if chosen {
                                    theme::ACCENT_WASH
                                } else if response.hovered() {
                                    theme::HOVER
                                } else {
                                    theme::SURFACE
                                };
                                painter.rect_filled(outline, CornerRadius::same(3), bg);
                                painter.rect_stroke(
                                    outline,
                                    CornerRadius::same(3),
                                    Stroke::new(
                                        if chosen { 1.5_f32 } else { 1.0_f32 },
                                        if chosen {
                                            theme::ACCENT_HI
                                        } else {
                                            theme::LINE_SOFT
                                        },
                                    ),
                                    StrokeKind::Inside,
                                );
                                if let Some((tex_id, _)) = texture {
                                    painter.image(
                                        tex_id,
                                        picture,
                                        Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                                        Color32::WHITE,
                                    );
                                } else {
                                    painter.text(
                                        picture.center(),
                                        Align2::CENTER_CENTER,
                                        "预览加载中",
                                        FontId::proportional(11.0),
                                        theme::TEXT_3,
                                    );
                                }
                                painter.text(
                                    Pos2::new(
                                        row.center().x,
                                        picture.bottom() + LABEL_HEIGHT * 0.5,
                                    ),
                                    Align2::CENTER_CENTER,
                                    format!("v{}{}", number, if chosen { "  ·  当前" } else { "" }),
                                    FontId::proportional(11.0),
                                    if chosen {
                                        theme::ACCENT_HI
                                    } else {
                                        theme::TEXT_2
                                    },
                                );
                            }
                            // 删除: a small × in the picture's top-right corner while the pointer
                            // is on the row (never for the last one left: the AI layer needs one)
                            let mut deleted = false;
                            if self.items.len() > 1 && ui.is_rect_visible(row) {
                                let picture_right = row.center().x + size.x * 0.5;
                                let top = row.top() + THUMB_BORDER + 1.0;
                                let icon = Rect::from_min_size(
                                    Pos2::new(picture_right - DELETE_ICON - 3.0, top + 3.0),
                                    Vec2::splat(DELETE_ICON),
                                );
                                // added after the row, so it is on top of it for the pointer
                                let hit = ui.interact(icon, Id::new(("variant-delete", id)), Sense::click());
                                if response.hovered() || hit.hovered() {
                                    paint_delete_icon(ui.painter(), icon, hit.hovered());
                                }
                                if hit.clicked() {
                                    deleted = true;
                                    actions.push(json!({
                                        "kind": "delete-variant",
                                        "layerId": id,
                                        "groupId": self.group_id
                                    }));
                                }
                                let _ = hit;
                            }
                            if response.clicked() && !chosen && !deleted {
                                actions.push(json!({
                                    "kind": "show-variant",
                                    "layerId": id,
                                    "groupId": self.group_id
                                }));
                            }
                            // no tooltip (user 11-24): the label under the picture says enough
                            let _ = response;
                        }
                    });
            });
        draw_resize_edges(ctx);
        actions
    }
}

/// The bottom edge is the ONLY user-resizable edge. Width comes from the thumbnail slider,
/// and the upper-left corner stays fixed while the user adjusts height.
fn draw_resize_edges(ctx: &egui::Context) {
    let screen = ctx.screen_rect();
    let height = 9.0;
    egui::Area::new(Id::new("variants-height-handle"))
        .order(egui::Order::Foreground)
        .fixed_pos(Pos2::new(0.0, screen.height() - height))
        .show(ctx, |ui| {
            let response =
                ui.allocate_response(Vec2::new(screen.width(), height), Sense::click_and_drag());
            if response.is_pointer_button_down_on() && ctx.input(|i| i.pointer.any_pressed()) {
                ctx.send_viewport_cmd(ViewportCommand::BeginResize(ResizeDirection::South));
            }
            let r = response.rect;
            ui.painter().line_segment(
                [
                    Pos2::new(r.center().x - 12.0, r.center().y),
                    Pos2::new(r.center().x + 12.0, r.center().y),
                ],
                Stroke::new(
                    1.0_f32,
                    if response.hovered() {
                        theme::TEXT_2
                    } else {
                        theme::TEXT_3
                    },
                ),
            );
            let _ = response;
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sections_parse_and_retain_group_order() {
        let mut rail = VariantRail::new();
        let state = json!({"groupId":12,"name":"AI生成","items":[
            {"layerId":40,"number":1,"visible":false},
            {"layerId":41,"number":2,"visible":true}
        ]});
        rail.apply(state.as_object().unwrap());
        assert_eq!(rail.group_id, 12);
        assert_eq!(rail.items.len(), 2);
        assert_eq!(rail.items[1].layer_id, 41);
        assert!(rail.items[1].shown);
    }

    #[test]
    fn content_fit_height_shrinks_with_variant_count_and_aspect_ratio() {
        let mut rail = VariantRail::new();
        assert_eq!(rail.content_height(), 38.0);
        rail.items.push(Item {
            preview_dimensions: Some(Vec2::new(256.0, 256.0)),
            ..Item::default()
        });
        let one_square = rail.content_height();
        assert_eq!(one_square, 175.0);
        rail.items[0].preview_dimensions = Some(Vec2::new(256.0, 128.0));
        assert_eq!(rail.content_height(), 119.0);
        rail.items.push(Item {
            preview_dimensions: Some(Vec2::new(256.0, 128.0)),
            ..Item::default()
        });
        assert_eq!(rail.content_height(), 203.0);
    }

    #[test]
    fn width_is_derived_from_thumbnail_size_not_window_edge() {
        let mut rail = VariantRail::new();
        assert_eq!(rail.desired_width(), 142.0);
        rail.thumb_px = 64.0;
        assert_eq!(rail.desired_width(), 96.0);
        rail.thumb_px = 200.0;
        assert_eq!(rail.desired_width(), 230.0);
    }

    #[test]
    fn png_metadata_preserves_landscape_and_portrait_aspect_ratios() {
        let png_header = |w: u32, h: u32| {
            let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
            bytes.extend_from_slice(&w.to_be_bytes());
            bytes.extend_from_slice(&h.to_be_bytes());
            format!("data:image/png;base64,{}", BASE64.encode(&bytes))
        };
        assert_eq!(
            png_dimensions(&png_header(256, 128)),
            Some(Vec2::new(256.0, 128.0))
        );
        assert_eq!(
            png_dimensions(&png_header(64, 128)),
            Some(Vec2::new(64.0, 128.0))
        );
        assert_eq!(png_dimensions("data:image/png;base64,invalid"), None);
    }

    #[test]
    fn landscape_preview_height_matches_image_instead_of_square_card() {
        assert_eq!(
            preview_size(Some(Vec2::new(256.0, 128.0)), 112.0),
            Vec2::new(112.0, 56.0),
        );
        assert_eq!(
            preview_size(Some(Vec2::new(64.0, 128.0)), 112.0),
            Vec2::new(56.0, 112.0),
        );
        assert_eq!(preview_size(None, 112.0), Vec2::splat(112.0));
    }
}
