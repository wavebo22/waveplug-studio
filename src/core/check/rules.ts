// 文档检查 (WavePlug 图层 panel): everything that can be decided from what Photoshop tells us —
// missing fonts, oversized / blurry / broken smart objects, delivery settings (colour mode,
// resolution, safe margin, rich black), text (tiny, maybe cut off, low contrast, near-identical
// sizes), tidiness (empty, off-canvas, invisible layers, unused AI variants) and design consistency
// (near-identical colours, 1–2 px misalignment, uneven spacing). Pure (tests/check_rules.test.ts);
// the copy and the visual checks are DeepSeek's (core/check/ai.ts).

import type { Rect } from "../image/region.ts";
import { type DocScan, type ScanLayer, shownSize, sizeText } from "../layers/slim.ts";

export type Purpose = "print" | "screen" | "mobile";
export const PURPOSE_NAMES: Record<Purpose, string> = { print: "印刷", screen: "网页 / 屏幕", mobile: "手机界面" };
export type Severity = "error" | "warn" | "info";
export type Category = "font" | "smart" | "delivery" | "text" | "hygiene" | "design" | "copy" | "visual";
export const CATEGORY_NAMES: Record<Category, string> = {
  font: "字体", smart: "智能对象", delivery: "交付", text: "文字", hygiene: "图层整洁", design: "设计一致性", copy: "文案（AI）", visual: "画面（AI）",
};

/** What a button next to an issue does (besides selecting its layers). */
export type Fix =
  | { kind: "shrinkSmart"; ids: number[] }
  | { kind: "delete"; ids: number[] }
  | { kind: "deleteVariants"; ids: number[] }
  | { kind: "updateLinked"; ids: number[] }
  | { kind: "relink"; ids: number[] }
  | { kind: "setText"; id: number; from: string; to: string };

export interface Issue {
  /** stable within one check: the list remembers what was fixed or ignored by it */
  key: string;
  category: Category;
  severity: Severity;
  title: string;
  detail: string;
  ids: number[];
  fix?: Fix;
  /** the fix's label */
  fixLabel?: string;
  /** estimated bytes the fix saves, for ordering */
  bytes?: number;
}

export interface RGB { r: number; g: number; b: number }
export interface CMYK { c: number; m: number; y: number; k: number }

export interface CheckText {
  id: number;
  name: string;
  contents: string;
  /** PostScript names of the fonts used (each style range) */
  fonts: string[];
  /** display names for the same fonts, when known */
  fontNames: string[];
  /** sizes as shown (after the layer's transform), px of the document */
  sizesPx: number[];
  /** the first style range's colour */
  rgb?: RGB;
  cmyk?: CMYK;
  /** number of style ranges (1: one font / size / colour throughout) */
  ranges: number;
  /** the rendered text on the canvas */
  bounds: Rect | null;
  /** 段落文字: its box on the canvas (px), when it could be worked out */
  box?: Rect;
  visible: boolean;
}

export interface CheckDoc {
  width: number;
  height: number;
  mode: "rgb" | "cmyk" | "gray" | "lab" | "other";
  bits: number;
  /** pixels per inch */
  ppi: number;
  scan: DocScan;
  texts: CheckText[];
  /** installed fonts' PostScript names; null when they couldn't be read (then fonts aren't checked) */
  installed: ReadonlySet<string> | null;
  /** linked smart objects whose file is missing / changed on disk */
  links: { id: number; missing: boolean; changed: boolean }[];
  /** fill and shape layers' colours */
  fills: { id: number; rgb: RGB }[];
  /** colour right around each text layer on the composite (for contrast) */
  backgrounds: ReadonlyMap<number, RGB>;
  /** smart objects' content ids (instances share one) */
  contentIds: ReadonlyMap<number, string>;
}

const MB = 1024 * 1024;
const VECTOR_FILE = /\.(ai|pdf|svg|eps)$/i;
const RASTER_FILE = /\.(png|jpe?g|tiff?|webp|bmp|gif|heic|avif)$/i;
const PLACEHOLDER = /^(lorem ipsum|文本|文字|标题|标题文字|正文|输入文字|请输入|双击编辑|text|title|placeholder|xxx+|×××+|文案)$/i;
const DEFAULT_NAME = /^(图层|layer|组|group|矩形|椭圆|形状|多边形|rectangle|ellipse|shape|polygon)\s*\d+(\s*(拷贝|copy)(\s*\d+)?)?$/i;

const w = (r: Rect) => r.right - r.left;
const hgt = (r: Rect) => r.bottom - r.top;
const area = (r: Rect | null) => r ? Math.max(0, w(r)) * Math.max(0, hgt(r)) : 0;
const fmt = (n: number, d = 0) => Number(n.toFixed(d)).toString();
const names = (ids: number[], nameOf: (id: number) => string, max = 3) =>
  ids.slice(0, max).map(id => `「${nameOf(id)}」`).join("") + (ids.length > max ? ` 等 ${ids.length} 个` : "");

/** Auto purpose: CMYK is for print; a tall document of phone width a phone screen; else a screen. */
export function guessPurpose(d: { mode: CheckDoc["mode"]; width: number; height: number }): Purpose {
  if (d.mode === "cmyk") return "print";
  if (d.height > d.width && [375, 390, 393, 414, 430, 720, 750, 828, 1080, 1125, 1170, 1179, 1242, 1284, 1290].includes(Math.round(d.width))) return "mobile";
  return "screen";
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrast(a: RGB, b: RGB): number {
  const lum = (c: RGB) => {
    const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export const hex = (c: RGB) => "#" + [c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** The median colour of a thin ring just outside `rect` (document px) on a composite scaled by
 *  `scale` (composite px per document px): what a text layer sits on. null when nothing to sample. */
export function ringColor(px: { width: number; height: number; channels: number; data: Uint8Array }, rect: Rect, scale: number): RGB | null {
  const pad = 3;
  const l = Math.floor(rect.left * scale) - pad, t = Math.floor(rect.top * scale) - pad;
  const r = Math.ceil(rect.right * scale) + pad, b = Math.ceil(rect.bottom * scale) + pad;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= px.width || y >= px.height) return;
    const i = (y * px.width + x) * px.channels;
    if (px.channels === 1) { rs.push(px.data[i]); gs.push(px.data[i]); bs.push(px.data[i]); return; }
    rs.push(px.data[i]); gs.push(px.data[i + 1]); bs.push(px.data[i + 2]);
  };
  const step = Math.max(1, Math.round(Math.max(r - l, b - t) / 200));
  for (let x = l; x <= r; x += step) for (let k = 0; k < pad; k++) { add(x, t + k); add(x, b - k); }
  for (let y = t; y <= b; y += step) for (let k = 0; k < pad; k++) { add(l + k, y); add(r - k, y); }
  if (!rs.length) return null;
  const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  return { r: med(rs), g: med(gs), b: med(bs) };
}

const dist = (a: RGB, b: RGB) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Every local check. `purpose` decides the delivery and size rules. */
export function runChecks(doc: CheckDoc, purpose: Purpose): Issue[] {
  const out: Issue[] = [];
  const layers = doc.scan.layers;
  const byId = new Map(layers.map(l => [l.id, l]));
  const nameOf = (id: number) => byId.get(id)?.name ?? doc.texts.find(t => t.id === id)?.name ?? `#${id}`;
  const bpp = doc.scan.bytesPerPixel;
  const canvas: Rect = { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const chain = (l: ScanLayer) => {
    const up: ScanLayer[] = [];
    for (let p = l.parentId == null ? undefined : byId.get(l.parentId); p && up.length < 64; p = p.parentId == null ? undefined : byId.get(p.parentId)) up.push(p);
    return up;
  };
  const shown = (l: ScanLayer) => l.visible && !chain(l).some(g => !g.visible);
  const inAi = (l: ScanLayer) => l.variationOf !== undefined || chain(l).some(g => g.variationOf !== undefined);

  // ── 字体 ──
  if (doc.installed) {
    const missing = new Map<string, { label: string; ids: number[] }>();
    for (const t of doc.texts) t.fonts.forEach((f, i) => {
      if (!f || doc.installed!.has(f)) return;
      const m = missing.get(f) ?? { label: t.fontNames[i] || f, ids: [] };
      if (!m.ids.includes(t.id)) m.ids.push(t.id);
      missing.set(f, m);
    });
    for (const [ps, m] of missing) out.push({ key: "font:" + ps, category: "font", severity: "error", ids: m.ids,
      title: `缺少字体「${m.label}」`, detail: `${names(m.ids, nameOf)}在用它，Photoshop 正用别的字体代替显示。安装这个字体，或用「文字 › 管理缺失字体」替换` });
    const used = new Set(doc.texts.flatMap(t => t.fonts));
    if (used.size > 5) out.push({ key: "font:many", category: "font", severity: "info", ids: [], title: `用了 ${used.size} 种字体`, detail: "一份设计通常 2～3 种就够；字体多了画面容易乱，交付时也容易缺字体" });
  }

  // ── 智能对象 ──
  const groupsByContent = new Map<string, ScanLayer[]>();
  for (const l of layers) if (l.smart) {
    const key = doc.contentIds.get(l.id) || "#" + l.id;
    const a = groupsByContent.get(key); if (a) a.push(l); else groupsByContent.set(key, [l]);
  }
  for (const [key, insts] of groupsByContent) {
    const s = insts[0].smart!;
    if (!s.width || !s.height) continue;
    const sizes = insts.map(l => shownSize(l.smart!.quad));
    const biggest = sizes.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    const shownPx = Math.max(1, biggest.width * biggest.height);
    const contentPx = s.width * s.height;
    const overShown = contentPx / shownPx;
    const overCanvas = Math.max(s.width, s.height) / Math.max(doc.width, doc.height);
    const bytes = contentPx * bpp;
    const ids = insts.map(l => l.id);
    const label = insts.length > 1 ? `「${insts[0].name}」等 ${insts.length} 个共用实例` : `「${insts[0].name}」`;
    const facts = `内容 ${s.width}×${s.height}，画面上最大显示约 ${fmt(biggest.width)}×${fmt(biggest.height)}（${fmt(Math.sqrt(overShown), 1)} 倍）${overCanvas >= 1 ? `，是画布长边的 ${fmt(overCanvas, 1)} 倍` : ""}，${sizeText(bytes) || "很小"}`;
    if (VECTOR_FILE.test(s.file)) continue; // vector: scaling costs nothing
    // upscaled raster: blurry
    const up = Math.sqrt(shownPx / contentPx);
    if (RASTER_FILE.test(s.file) && up > (purpose === "print" ? 1.3 : 1.6)) {
      out.push({ key: "smart:up:" + key, category: "smart", severity: purpose === "print" ? "error" : "warn", ids,
        title: `${label}被放大了 ${fmt(up, 1)} 倍，可能发糊`, detail: `内容只有 ${s.width}×${s.height}，却显示成约 ${fmt(biggest.width)}×${fmt(biggest.height)}；换一张更清晰的原图` });
      continue;
    }
    const severe = overShown >= 16 && overCanvas >= 2 && bytes >= 100 * MB;
    const suggest = !severe && overShown >= 4 && bytes >= 30 * MB;
    const hint = !severe && !suggest && overShown >= 4 && bytes >= 8 * MB;
    if (!severe && !suggest && !hint) continue;
    const saving = Math.max(0, bytes - shownPx * bpp);
    const why = s.linked ? "链接到外部文件：请把源文件本身缩小" : insts.some(l => l.smart!.filters) ? "有智能滤镜：缩小会改变滤镜效果（模糊半径等），请打开内容手动缩小并检查效果"
      : !RASTER_FILE.test(s.file) ? "内容是 PSB 或其他分层文件：双击打开内容，用「图像 › 图像大小」缩小后保存" : "";
    const canFix = !why && insts.length === 1 && !s.shared && !s.styled;
    out.push({ key: "smart:big:" + key, category: "smart", severity: severe ? "error" : suggest ? "warn" : "info", ids, bytes: saving,
      title: `${label}内容太大${saving >= MB ? `，可省${sizeText(saving)}` : ""}`,
      detail: facts + "。" + (canFix ? "可以按显示大小重做（画面不变；以后再放大会变糊）" : why || "和其他图层共用内容或带样式 / 蒙版：打开内容，用「图像 › 图像大小」缩小到显示尺寸的 2 倍左右"),
      ...(canFix ? { fix: { kind: "shrinkSmart" as const, ids }, fixLabel: "按显示大小重做" } : {}) });
  }
  for (const l of doc.links) {
    if (l.missing) out.push({ key: "smart:missing:" + l.id, category: "smart", severity: "error", ids: [l.id], title: `「${nameOf(l.id)}」链接的文件找不到了`, detail: "交付或换电脑后会无法更新内容；重新链接到文件，或嵌入", fix: { kind: "relink", ids: [l.id] }, fixLabel: "重新链接…" });
    else if (l.changed) out.push({ key: "smart:changed:" + l.id, category: "smart", severity: "warn", ids: [l.id], title: `「${nameOf(l.id)}」链接的文件改过，还没更新`, detail: "画面里还是旧内容", fix: { kind: "updateLinked", ids: [l.id] }, fixLabel: "更新内容" });
  }

  // ── 交付 ──
  const mm = (px: number) => px / doc.ppi * 25.4;
  if (purpose === "print") {
    if (doc.mode !== "cmyk") out.push({ key: "del:mode", category: "delivery", severity: "warn", ids: [], title: `印刷稿是 ${doc.mode.toUpperCase()} 模式`, detail: "交印刷厂前转成 CMYK（图像 › 模式 › CMYK 颜色），并检查颜色变化，尤其是鲜艳的蓝、绿、紫" });
    if (doc.ppi < 300) out.push({ key: "del:ppi", category: "delivery", severity: doc.ppi < 200 ? "error" : "warn", ids: [], title: `分辨率只有 ${fmt(doc.ppi)} ppi`, detail: `印刷一般要 300 ppi；按现在的像素，300 ppi 下成品约 ${fmt(doc.width / 300 * 25.4)}×${fmt(doc.height / 300 * 25.4)} mm` });
    out.push({ key: "del:bleed", category: "delivery", severity: "info", ids: [], title: `成品尺寸约 ${fmt(mm(doc.width))}×${fmt(mm(doc.height))} mm（${fmt(doc.ppi)} ppi）`, detail: "确认画布已经包含出血（通常每边 3 mm），铺底的图片和色块要铺到画布边缘" });
    const safe = 3 / 25.4 * doc.ppi * 2; // 出血 3 mm + 安全 3 mm
    const near = doc.texts.filter(t => t.visible && t.bounds && (t.bounds.left < safe || t.bounds.top < safe || doc.width - t.bounds.right < safe || doc.height - t.bounds.bottom < safe)).map(t => t.id);
    if (near.length) out.push({ key: "del:edge", category: "delivery", severity: "warn", ids: near, title: `${near.length} 个文字离画布边不到 6 mm`, detail: `${names(near, nameOf)}：裁切时可能被切到（出血 3 mm + 安全距离 3 mm）` });
    const rich = doc.texts.filter(t => t.cmyk && t.cmyk.k >= 80 && t.cmyk.c + t.cmyk.m + t.cmyk.y >= 30 && Math.max(...t.sizesPx, 0) / doc.ppi * 72 < 14).map(t => t.id);
    if (rich.length) out.push({ key: "del:richblack", category: "delivery", severity: "warn", ids: rich, title: `${rich.length} 个小字是四色黑`, detail: `${names(rich, nameOf)}：印刷套印不准时会发虚，小字改成单黑（C0 M0 Y0 K100）` });
  } else if (doc.mode === "cmyk") {
    out.push({ key: "del:mode", category: "delivery", severity: "warn", ids: [], title: "屏幕用的设计是 CMYK 模式", detail: "屏幕显示用 RGB（图像 › 模式 › RGB 颜色），CMYK 会让颜色变灰、导出也更麻烦" });
  }
  if (doc.bits > 8) out.push({ key: "del:bits", category: "delivery", severity: "info", ids: [], title: `文档是 ${doc.bits} 位`, detail: "文件比 8 位大一倍；不做精细调色的话可以改成 8 位（图像 › 模式 › 8 位/通道）" });

  // ── 文字 ──
  const minPx = purpose === "print" ? 6 / 72 * doc.ppi : purpose === "mobile" ? 12 * (doc.width / 375) : 12;
  const minLabel = purpose === "print" ? "6 pt" : purpose === "mobile" ? `12 pt（这个画布上约 ${fmt(minPx)} px）` : "12 px";
  const tiny = doc.texts.filter(t => t.visible && t.sizesPx.length && Math.min(...t.sizesPx) < minPx - 0.01).map(t => t.id);
  if (tiny.length) out.push({ key: "text:tiny", category: "text", severity: "warn", ids: tiny, title: `${tiny.length} 个文字小于 ${minLabel}`, detail: `${names(tiny, nameOf)}：${PURPOSE_NAMES[purpose]}上会看不清` });
  for (const t of doc.texts) {
    if (!t.visible || !t.box || !t.bounds || !t.contents.trim()) continue;
    const line = Math.max(...t.sizesPx, 1) * 1.2;
    // rendered text reaching the box's bottom: likely more lines that the box doesn't show
    if (hgt(t.box) > line && t.bounds.bottom >= t.box.bottom - line * 0.35 && hgt(t.bounds) >= hgt(t.box) - line * 0.6)
      out.push({ key: "text:overflow:" + t.id, category: "text", severity: "info", ids: [t.id], title: `「${t.name}」可能超出了文本框`, detail: "文字已经排满文本框，后面的字可能被截断看不到；拉大文本框确认一下" });
  }
  for (const t of doc.texts) {
    if (t.visible && PLACEHOLDER.test(t.contents.trim())) out.push({ key: "text:placeholder:" + t.id, category: "text", severity: "warn", ids: [t.id], title: `「${t.name}」还是占位文字「${t.contents.trim().slice(0, 20)}」`, detail: "换成正式文案，或删掉这个图层" });
  }
  const lowContrast: { id: number; ratio: number }[] = [];
  for (const t of doc.texts) {
    const bg = doc.backgrounds.get(t.id);
    if (!t.visible || !t.rgb || !bg || !t.contents.trim()) continue;
    const large = Math.max(...t.sizesPx, 0) >= (purpose === "print" ? 18 / 72 * doc.ppi : purpose === "mobile" ? 24 * (doc.width / 375) : 24);
    const ratio = contrast(t.rgb, bg);
    if (ratio < (large ? 3 : 4.5)) lowContrast.push({ id: t.id, ratio });
  }
  for (const c of lowContrast.sort((a, b) => a.ratio - b.ratio).slice(0, 12)) {
    const t = doc.texts.find(x => x.id === c.id)!;
    out.push({ key: "text:contrast:" + c.id, category: "text", severity: c.ratio < 2 ? "error" : "warn", ids: [c.id], title: `「${t.name}」和背景对比度只有 ${fmt(c.ratio, 1)}:1`, detail: `文字 ${hex(t.rgb!)}，背景约 ${hex(doc.backgrounds.get(c.id)!)}；正文至少 4.5:1，大字至少 3:1（WCAG），不然看不清` });
  }
  // near-identical sizes: 23.8 and 24 — almost always the same thing set twice
  const sizeUsers = new Map<number, number[]>();
  for (const t of doc.texts) for (const s of new Set(t.sizesPx.map(v => Math.round(v * 10) / 10))) { const a = sizeUsers.get(s); if (a) { if (!a.includes(t.id)) a.push(t.id); } else sizeUsers.set(s, [t.id]); }
  const sizes = [...sizeUsers.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sizes.length; i++) {
    const a = sizes[i - 1], b = sizes[i];
    if (b - a > 0 && b - a <= Math.max(0.6, a * 0.02)) out.push({ key: `text:size:${a}:${b}`, category: "design", severity: "warn", ids: [...sizeUsers.get(a)!, ...sizeUsers.get(b)!],
      title: `字号 ${fmt(a, 1)} 和 ${fmt(b, 1)} px 很接近`, detail: `${names(sizeUsers.get(a)!, nameOf, 2)}用 ${fmt(a, 1)}，${names(sizeUsers.get(b)!, nameOf, 2)}用 ${fmt(b, 1)}：多半应该是同一个字号` });
  }

  // ── 图层整洁 ──
  const empty = layers.filter(l => !inAi(l) && (l.kind === "group" ? l.children === 0 : l.kind === "pixel" && !area(l.bounds))).map(l => l.id);
  if (empty.length) out.push({ key: "hyg:empty", category: "hygiene", severity: "info", ids: empty, title: `${empty.length} 个空图层 / 空组`, detail: names(empty, nameOf), fix: { kind: "delete", ids: empty }, fixLabel: "删除" });
  const off = layers.filter(l => !inAi(l) && l.kind !== "group" && l.bounds && area(l.bounds) > 0 && !overlaps(l.bounds, canvas)).map(l => l.id);
  if (off.length) out.push({ key: "hyg:off", category: "hygiene", severity: "info", ids: off, title: `${off.length} 个图层完全在画布外`, detail: `${names(off, nameOf)}：画面里看不到，确认不需要可以删掉`, fix: { kind: "delete", ids: off }, fixLabel: "删除" });
  const clear = layers.filter(l => !inAi(l) && shown(l) && l.opacity === 0 && l.kind !== "group").map(l => l.id);
  if (clear.length) out.push({ key: "hyg:clear", category: "hygiene", severity: "info", ids: clear, title: `${clear.length} 个图层不透明度是 0`, detail: `${names(clear, nameOf)}：开着眼睛但完全看不见` });
  const hidden = layers.filter(l => !inAi(l) && !l.visible && !chain(l).some(g => !g.visible)).map(l => l.id);
  if (hidden.length >= 3) out.push({ key: "hyg:hidden", category: "hygiene", severity: "info", ids: hidden, title: `${hidden.length} 个隐藏的图层 / 组`, detail: "如果是留着的备份没关系；交付前确认不需要的可以删掉，文件会小一些" });
  const variants = layers.filter(l => l.variationOf !== undefined && !l.visible);
  if (variants.length) {
    const ids = variants.map(l => l.id);
    const bytes = variants.reduce((n, l) => n + area(l.bounds) * bpp, 0);
    out.push({ key: "hyg:variants", category: "hygiene", severity: bytes >= 50 * MB ? "warn" : "info", ids, bytes, title: `AI 组里有 ${variants.length} 个没在用的变体`, detail: `只保留正在显示的变体可以省${sizeText(bytes) || "一点空间"}`, fix: { kind: "deleteVariants", ids }, fixLabel: "只留当前变体" });
  }
  const defaults = layers.filter(l => !inAi(l) && DEFAULT_NAME.test(l.name.trim())).map(l => l.id);
  if (defaults.length >= 5) out.push({ key: "hyg:names", category: "hygiene", severity: "info", ids: defaults, title: `${defaults.length} 个图层还是默认名字`, detail: "「图层 3」「矩形 1 拷贝」这类名字交接时很难找；可以用面板上的「AI 整理」一次改好" });

  // ── 设计一致性 ──
  const colours = new Map<string, { rgb: RGB; ids: number[] }>();
  const addColour = (id: number, c: RGB) => { const k = hex(c); const e = colours.get(k); if (e) { if (!e.ids.includes(id)) e.ids.push(id); } else colours.set(k, { rgb: c, ids: [id] }); };
  for (const t of doc.texts) if (t.rgb && t.visible) addColour(t.id, t.rgb);
  for (const f of doc.fills) if (byId.get(f.id) && shown(byId.get(f.id)!)) addColour(f.id, f.rgb);
  const list = [...colours.entries()];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [ka, a] = list[i], [kb, b] = list[j];
    const d = dist(a.rgb, b.rgb);
    if (d === 0 || d > 8) continue;
    const key = [ka, kb].sort().join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    const [main, odd] = a.ids.length >= b.ids.length ? [[ka, a], [kb, b]] as const : [[kb, b], [ka, a]] as const;
    out.push({ key: "design:colour:" + key, category: "design", severity: "warn", ids: [...main[1].ids, ...odd[1].ids],
      title: `颜色 ${main[0]} 和 ${odd[0]} 几乎一样`, detail: `${names(main[1].ids, nameOf, 2)}用 ${main[0]}，${names(odd[1].ids, nameOf, 2)}用 ${odd[0]}：多半应该统一成一个颜色` });
  }
  out.push(...alignment(layers, shown, inAi, nameOf));
  out.push(...spacing(layers, shown, inAi, nameOf));

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || (b.bytes ?? 0) - (a.bytes ?? 0));
}

function overlaps(a: Rect, b: Rect) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }

/** 1–2 px off: two neighbouring layers whose edges or centres almost line up. */
function alignment(layers: ScanLayer[], shown: (l: ScanLayer) => boolean, inAi: (l: ScanLayer) => boolean, nameOf: (id: number) => string): Issue[] {
  const items = layers.filter(l => l.kind !== "group" && shown(l) && !inAi(l) && l.bounds && w(l.bounds) >= 8 && hgt(l.bounds) >= 8);
  const out: Issue[] = [];
  const done = new Set<string>();
  const byParent = new Map<number | null, ScanLayer[]>();
  for (const l of items) { const p = l.parentId ?? null; const a = byParent.get(p); if (a) a.push(l); else byParent.set(p, [l]); }
  for (const sibs of byParent.values()) {
    if (sibs.length > 200) continue; // too many to compare meaningfully
    for (let i = 0; i < sibs.length; i++) for (let j = i + 1; j < sibs.length; j++) {
      const a = sibs[i].bounds!, b = sibs[j].bounds!;
      // stacked (one above the other, close): left / right / centre x; side by side: top / bottom / centre y
      const vGap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
      const hGap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
      const checks: [string, number, number][] = [];
      if (vGap >= 0 && vGap <= Math.max(hgt(a), hgt(b)) * 1.5) checks.push(["左边", a.left, b.left], ["右边", a.right, b.right], ["水平居中", (a.left + a.right) / 2, (b.left + b.right) / 2]);
      if (hGap >= 0 && hGap <= Math.max(w(a), w(b)) * 1.5) checks.push(["顶边", a.top, b.top], ["底边", a.bottom, b.bottom], ["垂直居中", (a.top + a.bottom) / 2, (b.top + b.bottom) / 2]);
      const hit = checks.find(([, x, y]) => { const d = Math.abs(x - y); return d >= 1 && d <= 2; });
      // only when nothing else lines up exactly (then the near miss is likely meant)
      if (!hit || checks.some(([, x, y]) => Math.abs(x - y) < 0.5)) continue;
      const key = [sibs[i].id, sibs[j].id].sort().join("/");
      if (done.has(key)) continue;
      done.add(key);
      out.push({ key: "design:align:" + key, category: "design", severity: "info", ids: [sibs[i].id, sibs[j].id],
        title: `「${nameOf(sibs[i].id)}」和「${nameOf(sibs[j].id)}」${hit[0]}差 ${fmt(Math.abs(hit[1] - hit[2]))} px`, detail: "看起来想对齐但差了一点；用「对齐」对齐一下" });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** Same-size siblings in a row or a column whose gaps differ by a few px. */
function spacing(layers: ScanLayer[], shown: (l: ScanLayer) => boolean, inAi: (l: ScanLayer) => boolean, nameOf: (id: number) => string): Issue[] {
  const items = layers.filter(l => shown(l) && !inAi(l) && l.bounds && w(l.bounds) >= 8 && hgt(l.bounds) >= 8);
  const out: Issue[] = [];
  const byParent = new Map<number | null, ScanLayer[]>();
  for (const l of items) { const p = l.parentId ?? null; const a = byParent.get(p); if (a) a.push(l); else byParent.set(p, [l]); }
  for (const sibs of byParent.values()) {
    const used = new Set<number>();
    for (const l of sibs) {
      if (used.has(l.id)) continue;
      const b = l.bounds!;
      const same = sibs.filter(o => Math.abs(w(o.bounds!) - w(b)) <= 2 && Math.abs(hgt(o.bounds!) - hgt(b)) <= 2);
      for (const axis of ["x", "y"] as const) {
        const line = same.filter(o => axis === "x" ? Math.abs(o.bounds!.top - b.top) <= 2 : Math.abs(o.bounds!.left - b.left) <= 2)
          .sort((p, q) => axis === "x" ? p.bounds!.left - q.bounds!.left : p.bounds!.top - q.bounds!.top);
        if (line.length < 3) continue;
        const gaps = line.slice(1).map((o, i) => axis === "x" ? o.bounds!.left - line[i].bounds!.right : o.bounds!.top - line[i].bounds!.bottom);
        if (gaps.some(g => g < 0)) continue;
        const spread = Math.max(...gaps) - Math.min(...gaps);
        if (spread < 1 || spread > 4) continue;
        line.forEach(o => used.add(o.id));
        out.push({ key: "design:gap:" + line.map(o => o.id).join("-"), category: "design", severity: "info", ids: line.map(o => o.id),
          title: `${line.length} 个同样大小的元素${axis === "x" ? "横向" : "纵向"}间距不统一`, detail: `从「${nameOf(line[0].id)}」起，间距是 ${gaps.map(g => fmt(g)).join(" / ")} px；用「分布」或统一成一个数` });
        break;
      }
      if (out.length >= 10) return out;
    }
  }
  return out;
}
