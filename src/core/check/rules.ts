// 文档检查 (WavePlug 图层 panel): everything that can be decided from what Photoshop tells us —
// missing fonts, oversized / blurry / broken smart objects, print settings for CMYK files
// (resolution, bleed and safe margin, rich black, tiny text), text (maybe cut off, placeholders),
// tidiness (empty, off-canvas, invisible layers, unused AI variants) and design consistency
// (near-identical colours and sizes, uneven spacing). Pure (tests/check_rules.test.ts);
// the copy and the visual checks are DeepSeek's (core/check/ai.ts).

import type { Rect } from "../image/region.ts";
import { type DocScan, type ScanLayer, shownSize, sizeText } from "../layers/slim.ts";

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

export const hex = (c: RGB) => "#" + [c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();

const dist = (a: RGB, b: RGB) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Every local check. A CMYK file is for print: then the print rules apply too. Nothing is judged
 *  by device (screen sizes, contrast): that is the designer's call. */
export function runChecks(doc: CheckDoc): Issue[] {
  const out: Issue[] = [];
  const print = doc.mode === "cmyk";
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
    if (RASTER_FILE.test(s.file) && up > (print ? 1.3 : 1.6)) {
      out.push({ key: "smart:up:" + key, category: "smart", severity: print ? "error" : "warn", ids,
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
  if (print) {
    if (doc.ppi < 300) out.push({ key: "del:ppi", category: "delivery", severity: doc.ppi < 200 ? "error" : "warn", ids: [], title: `分辨率只有 ${fmt(doc.ppi)} ppi`, detail: `印刷一般要 300 ppi；按现在的像素，300 ppi 下成品约 ${fmt(doc.width / 300 * 25.4)}×${fmt(doc.height / 300 * 25.4)} mm` });
    out.push({ key: "del:bleed", category: "delivery", severity: "info", ids: [], title: `成品尺寸约 ${fmt(mm(doc.width))}×${fmt(mm(doc.height))} mm（${fmt(doc.ppi)} ppi）`, detail: "确认画布已经包含出血（通常每边 3 mm），铺底的图片和色块要铺到画布边缘" });
    const safe = 3 / 25.4 * doc.ppi * 2; // 出血 3 mm + 安全 3 mm
    const near = doc.texts.filter(t => t.visible && t.bounds && (t.bounds.left < safe || t.bounds.top < safe || doc.width - t.bounds.right < safe || doc.height - t.bounds.bottom < safe)).map(t => t.id);
    if (near.length) out.push({ key: "del:edge", category: "delivery", severity: "warn", ids: near, title: `${near.length} 个文字离画布边不到 6 mm`, detail: `${names(near, nameOf)}：裁切时可能被切到（出血 3 mm + 安全距离 3 mm）` });
    const rich = doc.texts.filter(t => t.cmyk && t.cmyk.k >= 80 && t.cmyk.c + t.cmyk.m + t.cmyk.y >= 30 && Math.max(...t.sizesPx, 0) / doc.ppi * 72 < 14).map(t => t.id);
    if (rich.length) out.push({ key: "del:richblack", category: "delivery", severity: "warn", ids: rich, title: `${rich.length} 个小字是四色黑`, detail: `${names(rich, nameOf)}：印刷套印不准时会发虚，小字改成单黑（C0 M0 Y0 K100）` });
    const tiny = doc.texts.filter(t => t.visible && t.sizesPx.length && Math.min(...t.sizesPx) < 6 / 72 * doc.ppi - 0.01).map(t => t.id);
    if (tiny.length) out.push({ key: "del:tiny", category: "delivery", severity: "warn", ids: tiny, title: `${tiny.length} 个文字小于 6 pt`, detail: `${names(tiny, nameOf)}：印出来会看不清` });
  }
  if (doc.bits > 8) out.push({ key: "del:bits", category: "delivery", severity: "info", ids: [], title: `文档是 ${doc.bits} 位`, detail: "文件比 8 位大一倍；不做精细调色的话可以改成 8 位（图像 › 模式 › 8 位/通道）" });

  // ── 文字 ──
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
  // near-identical sizes: 23.8 and 24 — almost always the same thing set twice
  const sizeUsers = new Map<number, number[]>();
  for (const t of doc.texts) for (const s of new Set(t.sizesPx.map(v => Math.round(v * 10) / 10))) { const a = sizeUsers.get(s); if (a) { if (!a.includes(t.id)) a.push(t.id); } else sizeUsers.set(s, [t.id]); }
  const sizes = [...sizeUsers.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sizes.length; i++) {
    const a = sizes[i - 1], b = sizes[i];
    // only slips (23.8 / 24): bigger differences are usually meant
    if (b - a >= 0.05 && b - a <= 0.5) out.push({ key: `text:size:${a}:${b}`, category: "design", severity: "warn", ids: [...sizeUsers.get(a)!, ...sizeUsers.get(b)!],
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
  out.push(...spacing(layers, shown, inAi, nameOf));

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || (b.bytes ?? 0) - (a.bytes ?? 0));
}

function overlaps(a: Rect, b: Rect) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }

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
        // 1–2 px is rounding, more than 6 px is usually meant
        if (spread < 3 || spread > 6) continue;
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
