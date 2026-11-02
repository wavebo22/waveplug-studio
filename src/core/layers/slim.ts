// 文档瘦身: from a scan of the document, what can be removed and roughly how much it weighs.
// Pure, so it's tested without Photoshop. Sizes are uncompressed estimates (PSD compresses), only
// meant to rank the items.

import type { Rect } from "../image/region.ts";
import type { Quad } from "./smart.ts";

export interface ScanSmart {
  /** content file name, e.g. "背景.jpg" */
  file: string;
  linked: boolean;
  /** has smart filters */
  filters: boolean;
  /** other layers share this content */
  shared: boolean;
  /** layer style or layer mask (would end up inside a re-made smart object) */
  styled: boolean;
  quad: Quad;
  /** content size in its own pixels */
  width: number;
  height: number;
}

export interface ScanLayer {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  /** null for an empty layer */
  bounds: Rect | null;
  /** id of the AI group (AI填充 / 扩图 / 生成 / 放大) this layer is a variation of */
  variationOf?: number;
  /** groups: number of child layers */
  children?: number;
  smart?: ScanSmart;
}

export interface DocScan {
  width: number;
  height: number;
  /** bytes per pixel of a layer (colour channels + transparency, × bit depth) */
  bytesPerPixel: number;
  bits: number;
  layers: ScanLayer[];
  /** extra alpha channels (saved selections) */
  alphaChannels: string[];
  /** Photoshop's 「最大兼容 PSD」 preference, when it could be read */
  maxCompatibility?: boolean;
}

export type SlimKind = "variations" | "bigSmart" | "offCanvas" | "empty" | "hidden" | "channels";

export interface SlimItem {
  kind: SlimKind;
  label: string;
  /** what exactly, e.g. "3 个 AI 组 · 7 个变体" */
  detail: string;
  /** estimated bytes saved */
  bytes: number;
  /** layer ids to act on (empty for document-wide actions) */
  ids: number[];
  /** ticked by default */
  on: boolean;
  /** layers of this kind left alone, with the reason */
  skipped: string[];
}

/** A smart object is "oversized" when shown at less than this fraction of its content's size. */
export const SHRINK_BELOW = 0.5;
/** Raster content that can be re-made at its displayed size without losing anything visible. */
const RASTER_FILE = /\.(png|jpe?g|tiff?|webp|bmp|gif|heic|avif)$/i;

const area = (r: Rect | null) => r ? Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top) : 0;
const len = (x: number, y: number) => Math.hypot(x, y);

/** Shown size of a smart object (its quad's top and left edges). */
export function shownSize(q: Quad): { width: number; height: number } {
  return { width: len(q[2] - q[0], q[3] - q[1]), height: len(q[6] - q[0], q[7] - q[1]) };
}

export function planSlim(scan: DocScan): SlimItem[] {
  const bpp = scan.bytesPerPixel, items: SlimItem[] = [];
  const canvas: Rect = { left: 0, top: 0, right: scan.width, bottom: scan.height };
  const inAi = (l: ScanLayer) => l.variationOf !== undefined;

  // AI groups: hidden variations
  const hiddenVariations = scan.layers.filter(l => inAi(l) && !l.visible);
  if (hiddenVariations.length) {
    const groups = new Set(hiddenVariations.map(l => l.variationOf)).size;
    items.push({ kind: "variations", label: "清理 AI 变体", detail: `${groups} 个 AI 组里没在用的 ${hiddenVariations.length} 个变体，只保留正在显示的那个`,
      bytes: hiddenVariations.reduce((n, l) => n + area(l.bounds) * bpp, 0), ids: hiddenVariations.map(l => l.id), on: true, skipped: [] });
  }

  // oversized smart objects
  const big: ScanLayer[] = [], skipBig: string[] = [];
  let bigBytes = 0;
  for (const l of scan.layers.filter(x => x.smart)) {
    const s = l.smart!, shown = shownSize(s.quad);
    if (!s.width || shown.width / s.width >= SHRINK_BELOW) continue;
    const pct = `显示 ${Math.round(shown.width / s.width * 100)}%`;
    const why = s.linked ? "链接到外部文件" : s.shared ? "和其他图层共用内容" : s.filters ? "有智能滤镜" : s.styled ? "有图层样式或蒙版"
      : !RASTER_FILE.test(s.file) ? "内容不是普通图片（如 PSB、矢量）" : "";
    if (why) { skipBig.push(`${l.name}（${pct}）：${why}`); continue; }
    big.push(l);
    bigBytes += (s.width * s.height - shown.width * shown.height) * bpp;
  }
  if (big.length || skipBig.length) {
    items.push({ kind: "bigSmart", label: "缩小超大智能对象", detail: big.length
      ? `${big.length} 个智能对象的内容比显示大一倍以上，按显示大小重做（画面不变，之后再放大会变糊）`
      : "有超大的智能对象，但都不能自动缩小", bytes: Math.max(0, bigBytes), ids: big.map(l => l.id), on: big.length > 0, skipped: skipBig });
  }

  // pixels outside the canvas (pixel layers only; smart objects keep theirs)
  let off = 0;
  for (const l of scan.layers) if (l.kind === "pixel" && l.bounds) off += area(l.bounds) - area(intersect(l.bounds, canvas));
  if (off > 0) items.push({ kind: "offCanvas", label: "删除画布外的像素", detail: "移动或扩图后留在画布外、看不见的像素", bytes: off * bpp, ids: [], on: true, skipped: [] });

  // empty layers and groups
  const empty = scan.layers.filter(l => !inAi(l) && (l.kind === "group" ? l.children === 0 : (l.kind === "pixel" && !area(l.bounds))));
  if (empty.length) items.push({ kind: "empty", label: "删除空图层和空组", detail: `${empty.length} 个`, bytes: 0, ids: empty.map(l => l.id), on: true, skipped: [] });

  // hidden layers (off by default: often kept on purpose)
  const hidden = scan.layers.filter(l => !inAi(l) && !l.visible && l.kind !== "group" && area(l.bounds) > 0);
  if (hidden.length) items.push({ kind: "hidden", label: "删除隐藏图层", detail: `${hidden.length} 个（可能是你留着的备份，默认不勾）`,
    bytes: hidden.reduce((n, l) => n + area(l.bounds) * bpp, 0), ids: hidden.map(l => l.id), on: false, skipped: [] });

  if (scan.alphaChannels.length) items.push({ kind: "channels", label: "删除 Alpha 通道", detail: `${scan.alphaChannels.length} 个存储的选区：${scan.alphaChannels.slice(0, 3).join("、")}${scan.alphaChannels.length > 3 ? "…" : ""}`,
    bytes: scan.alphaChannels.length * scan.width * scan.height * scan.bits / 8, ids: [], on: false, skipped: [] });

  return items.sort((a, b) => b.bytes - a.bytes);
}

/** Things the tool can't change, worth knowing. */
export function slimWarnings(scan: DocScan): string[] {
  const w: string[] = [];
  if (scan.maxCompatibility) w.push("PS 首选项「文件处理 → 最大兼容 PSD 和 PSB 文件」是开着的，会让文件大将近一倍；不需要给旧软件打开的话可以改成「询问」或「从不」");
  if (scan.bits > 8) w.push(`文档是 ${scan.bits} 位，比 8 位大一倍；不需要的话可以「图像 → 模式 → 8 位/通道」`);
  return w;
}

function intersect(a: Rect, b: Rect): Rect {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

/** "约 12.3 MB" */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return bytes > 0 ? "< 1 MB" : "";
  return `约 ${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}
