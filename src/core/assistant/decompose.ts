// AI 拆层（规划部分）: DeepSeek (deepseek-flash) looks at a thumbnail of the picture and lists its
// separate parts — a short distinguishing name for each (it becomes the 心宝抠图 workflow's 物件名)
// and a rough box. Each part is then cut out by 心宝抠图 from a crop around its box, so the target
// fills the frame and the workflow's ~1 MP goes to that one part. Pure (tests/assistant_decompose.test.ts):
// the thumbnail size, what the model is told, checking its answer, and the crops.

import { type Rect, rectH, rectW } from "../image/region.ts";

export type DecomposeDetail = "coarse" | "medium" | "fine";
export const isDecomposeDetail = (v: string): v is DecomposeDetail => v === "coarse" || v === "medium" || v === "fine";

/** DeepSeek scales every image to about this many pixels (api-docs.deepseek.com/guides/vision): a
 *  bigger thumbnail costs upload time and shows it nothing more. */
export const DECOMPOSE_MAX_PIXELS = 1300 * 1300;
/** More parts than this and one run takes too long (each part is one 心宝抠图 run). */
export const DECOMPOSE_MAX_PARTS = 20;
/** Longest name accepted (it goes into the 心宝 prompt 「抠出【…】」). */
const MAX_NAME = 24;
/** Boxes are given on a 0–1000 scale of the thumbnail's width and height. */
export const BOX_SCALE = 1000;

export type PartKind = "object" | "text";

export interface DecomposePart {
  name: string;
  kind: PartKind;
  /** where the model says the part is, in document pixels */
  box: Rect;
  /** what is sent to 心宝抠图: the box grown by a margin, in document pixels */
  crop: Rect;
}

export interface DecomposePlan {
  /** front to back (the first one is on top) */
  parts: DecomposePart[];
  /** parts of the answer left out, and why (shown under the list) */
  dropped: string[];
}

export interface Size { width: number; height: number }

/** The thumbnail sent to DeepSeek: same aspect, at most DECOMPOSE_MAX_PIXELS, never enlarged. */
export function visionSize(width: number, height: number): Size {
  if (width * height <= DECOMPOSE_MAX_PIXELS) return { width: Math.round(width), height: Math.round(height) };
  const s = Math.sqrt(DECOMPOSE_MAX_PIXELS / (width * height));
  return { width: Math.max(1, Math.floor(width * s)), height: Math.max(1, Math.floor(height * s)) };
}

const DETAIL_GUIDE: Record<DecomposeDetail, string> = {
  coarse: "拆分粒度：粗。只拆出 2～4 个最主要的部分（主体、大的前景物件、大标题），小东西归到它所在的大部分里，不单独列出。",
  medium: "拆分粒度：中。拆出 4～8 个部分：每个独立的物件、每块独立的文字各算一个；紧贴在一起、明显属于同一个东西的（例如瓶子和瓶盖）算一个。",
  fine: "拆分粒度：细。拆出 8～15 个部分：能单独移动的东西都单独列出，包括小装饰、小图标、每块文字。",
};

export const DECOMPOSE_SYSTEM = `你是图像拆层助手。用户要把一张平面图拆成 Photoshop 里的独立图层：每个部分会被单独抠出来、补全被挡住的部分，放到自己的图层上；背景另外处理。你的任务是列出要拆出的部分。只输出 JSON。

规则：
1. 不要列背景（天空、墙面、地面、纯色或渐变底等铺满画面的东西）。
2. 名字用中文，是一个简短的名词短语（不超过 12 个字），要能在这张图里唯一指认这个部分：有相似的东西时加上位置或颜色区分，例如「左边的红色瓶子」「右边的红色瓶子」。不要写动作和描述句。
3. 文字单独成一个部分，kind 写 "text"，名字写成「标题文字“……”」这样，引号里是文字内容（太长就写开头几个字）；其他部分 kind 写 "object"。
4. 按从前到后的顺序排列：挡住别人的写在前面，被挡住的写在后面。
5. box 是这个部分完整外形的范围 [左, 上, 右, 下]，按附图的宽和高换算成 0～1000 的整数（0 是左边或上边，1000 是右边或下边）。被别的东西挡住的部分也估算进去。框要贴着物件，不要留太多空白。
6. 看不清、太小（不到画面的百分之一）的东西不要列。

输出格式：{"parts":[{"name":"名字","kind":"object","box":[左,上,右,下]}]}`;

/** The user message that goes with the thumbnail. */
export function decomposeRequest(detail: DecomposeDetail, thumb: Size, hint = ""): string {
  const parts = [
    `附图是要拆层的画面（${thumb.width}×${thumb.height} 像素）。`,
    DETAIL_GUIDE[detail],
  ];
  const h = hint.replace(/\s+/g, " ").trim().slice(0, 300);
  if (h) parts.push(`用户的补充要求：${h}`);
  return parts.join("\n");
}

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

/** A 0–1000 box from the answer as document pixels, or why it can't be used. */
function boxOf(v: unknown, size: Size): Rect | string {
  if (!Array.isArray(v) || v.length !== 4) return "没有给出范围";
  const n = v.map(num);
  if (n.some(x => x === null)) return "范围不是数字";
  let [x1, y1, x2, y2] = n as number[];
  if ([x1, y1, x2, y2].some(x => x < -10 || x > BOX_SCALE + 10)) return "范围超出画面";
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  const cl = (x: number) => Math.max(0, Math.min(BOX_SCALE, x));
  const r = {
    left: Math.floor(cl(x1) / BOX_SCALE * size.width), top: Math.floor(cl(y1) / BOX_SCALE * size.height),
    right: Math.ceil(cl(x2) / BOX_SCALE * size.width), bottom: Math.ceil(cl(y2) / BOX_SCALE * size.height),
  };
  if (rectW(r) < 2 || rectH(r) < 2) return "范围太小";
  return r;
}

export interface CropOptions {
  /** margin on each side, as a share of the box's longer side (default 0.25) */
  margin?: number;
  /** a crop is at least this many pixels wide and high, so a small part keeps some context (default 384) */
  minSide?: number;
}

/** The region sent to 心宝抠图 for one part: its box grown by a margin and to a minimum size, kept
 *  inside the picture (shifted rather than cut where it can). */
export function cropFor(box: Rect, size: Size, opts: CropOptions = {}): Rect {
  const m = Math.round(Math.max(rectW(box), rectH(box)) * (opts.margin ?? 0.25));
  const minSide = opts.minSide ?? 384;
  const span = (lo: number, hi: number, limit: number): [number, number] => {
    let a = lo - m, b = hi + m;
    const want = Math.min(limit, Math.max(b - a, minSide));
    const grow = want - (b - a);
    if (grow > 0) { a -= Math.floor(grow / 2); b += Math.ceil(grow / 2); }
    if (a < 0) { b -= a; a = 0; }
    if (b > limit) { a -= b - limit; b = limit; }
    return [Math.max(0, a), Math.min(limit, b)];
  };
  const [left, right] = span(box.left, box.right, size.width);
  const [top, bottom] = span(box.top, box.bottom, size.height);
  return { left, top, right, bottom };
}

/** Checks DeepSeek's answer: parts with a usable name and box, in its order (front to back), names
 *  made unique, at most DECOMPOSE_MAX_PARTS. `size` is the document's (the boxes are scaled to it). */
export function parseDecomposeAnswer(value: unknown, size: Size, crop: CropOptions = {}): DecomposePlan {
  const list = value && typeof value === "object" ? (value as { parts?: unknown }).parts : null;
  if (!Array.isArray(list)) return { parts: [], dropped: ["DeepSeek 没有列出任何部分"] };
  const parts: DecomposePart[] = [];
  const dropped: string[] = [];
  const used = new Map<string, number>();
  const area = size.width * size.height;
  for (const item of list) {
    const o = item && typeof item === "object" ? item as { name?: unknown; kind?: unknown; box?: unknown } : {};
    let name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
    if (!name) { dropped.push("有一项没有名字"); continue; }
    if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);
    const box = boxOf(o.box, size);
    if (typeof box === "string") { dropped.push(`「${name}」${box}`); continue; }
    if (rectW(box) * rectH(box) < area * 0.001) { dropped.push(`「${name}」太小`); continue; }
    if (rectW(box) >= size.width * 0.95 && rectH(box) >= size.height * 0.95) { dropped.push(`「${name}」铺满了整个画面，像是背景`); continue; }
    if (parts.length >= DECOMPOSE_MAX_PARTS) { dropped.push(`「${name}」超过 ${DECOMPOSE_MAX_PARTS} 个`); continue; }
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}（${n}）`;
    const kind: PartKind = o.kind === "text" ? "text" : "object";
    parts.push({ name, kind, box, crop: cropFor(box, size, crop) });
  }
  return { parts, dropped };
}
