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
  /** the box came from the second, zoomed-in look (applyRefine) */
  refined?: boolean;
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
  coarse: "拆分粒度：粗。只拆出 2～4 个最主要的部分（主体、大的前景物件、整片标题区），小东西归到它所在或挨着的大部分里，不单独列出。",
  medium: "拆分粒度：中。拆出 5～10 个部分：每个独立的物件、每个明显的装饰图形、每块排版上分开的文字各算一个；紧贴在一起、明显属于同一个东西的（例如瓶子和瓶盖、一行标题和它的下划线）算一个。",
  fine: "拆分粒度：细。尽量拆细，一般 10～20 个：能单独移动的东西都单独列出，包括小装饰、小图标、logo、线框、对话气泡、每块文字（不同颜色、字号、方向或中间有空白的文字分别列出）。画面里确实没那么多东西时才可以少于 10 个。",
};

export const DECOMPOSE_SYSTEM = `你是图像拆层助手。用户要把一张平面图拆成 Photoshop 里的独立图层：每个部分会被单独抠出来、补全被挡住的部分，放到自己的图层上；背景另外处理。你的任务是列出要拆出的部分和它们的位置。只输出 JSON。

附图上叠了一层品红色的细网格线，把宽和高各分成 10 格；上边和左边的数字 1～9 是网格线的位置，表示 100～900。网格线不是画面内容，只是帮你读坐标。

先按下面几类逐一清点画面，不要漏：
- 主体和物件（人物、动物、产品、家具、器物……）
- 装饰图形（对话气泡、线框、色块、贴纸、图标、logo、印章、箭头……）
- 文字（每一块排版上独立的文字）

规则：
1. 不要列背景（天空、墙面、地面、桌面、纯色或渐变底、铺满画面的纹理等）。
2. 名字用中文，是一个简短的名词短语（不超过 12 个字），说清它是什么，例如「奶牛头」「绿色办公椅」「白色键盘」。只有画面里有相似的东西时，才加位置或颜色区分，例如「左边的红色瓶子」「右边的红色瓶子」。不要写动作和描述句。
3. 文字的 kind 写 "text"，名字写成「文字“……”」，引号里是文字内容（太长就写开头几个字）；其他部分 kind 写 "object"。
4. 按从前到后的顺序排列：挡住别人的写在前面，被挡住的写在后面。
5. box 是这个部分完整外形的范围 [左, 上, 右, 下]，按附图的宽和高换算成 0～1000 的整数（0 是左边或上边，1000 是右边或下边），对照网格线读数。框要贴着这个部分的边缘：左边对齐它最左的一点，右边对齐最右的一点，上下也一样。被别的东西挡住的部分也估算进去。
6. 看不清、太小（不到画面的百分之一）的东西不要列。

输出格式：{"parts":[{"name":"名字","kind":"object","box":[左,上,右,下]}]}`;

export const REFINE_SYSTEM = `你是图像定位助手。用户会给你几张从同一张大图里裁出来的局部图，每张图说明要找的是哪个东西。请在每张局部图里找到它，给出贴边的范围。只输出 JSON。

每张局部图上叠了一层品红色的细网格线，把宽和高各分成 10 格；上边和左边的数字 1～9 是网格线的位置，表示 100～900。网格线不是画面内容。

规则：
1. box 是这个东西在这张局部图里的完整外形 [左, 上, 右, 下]，按这张局部图的宽和高换算成 0～1000 的整数，对照网格线读数。框要贴着它的边缘，不要留空白；被别的东西挡住的部分也估算进去。东西超出局部图边缘时，那一边写 0 或 1000。
2. 名字里的位置词（左边、右上角……）指的是在整张大图里的位置，不是在局部图里。
3. 局部图里找不到这个东西时，box 写 null。
4. i 是局部图的编号，每张图都要回答。

输出格式：{"boxes":[{"i":1,"box":[左,上,右,下]},{"i":2,"box":null}]}`;

/** The user message that goes with the thumbnail. */
export function decomposeRequest(detail: DecomposeDetail, thumb: Size, hint = ""): string {
  const parts = [
    `附图是要拆层的画面（${thumb.width}×${thumb.height} 像素，叠了读坐标用的网格线）。`,
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
  /** each box grows by this share of its longer side (at least 0.8% of the picture's), so 心宝抠图
   *  gets a little room around the part (default 0.08; 0: the model's box as it is) */
  pad?: number;
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

/** `box` grown by `pad` of its longer side (at least 0.8% of the picture's longer side), inside the picture. */
export function padBox(box: Rect, size: Size, pad = 0.08): Rect {
  if (pad <= 0) return box;
  const m = Math.round(Math.max(Math.max(rectW(box), rectH(box)) * pad, Math.max(size.width, size.height) * 0.008));
  return {
    left: Math.max(0, box.left - m), top: Math.max(0, box.top - m),
    right: Math.min(size.width, box.right + m), bottom: Math.min(size.height, box.bottom + m),
  };
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
    const padded = padBox(box, size, crop.pad);
    parts.push({ name, kind, box: padded, crop: cropFor(padded, size, crop) });
  }
  return { parts, dropped };
}

// ── 细化: a second look, each part in a zoomed-in crop of the full-resolution picture ──

/** Crops per refine request (the request body is limited to 48 MiB; PNG crops are ~1–2 MB each). */
export const REFINE_BATCH = 6;
/** A refine crop is read at most this many pixels. */
export const REFINE_MAX_PIXELS = 900 * 900;

/** What the second look sees for one part: its first box with plenty of room around it (the first
 *  box may be off), at least a fifth of the picture's short side. */
export function refineRegion(box: Rect, size: Size): Rect {
  const long = Math.max(rectW(box), rectH(box), 1);
  const m = Math.max(long * 0.5, Math.max(size.width, size.height) * 0.06);
  return cropFor(box, size, { margin: m / long, minSide: Math.round(Math.min(size.width, size.height) * 0.2) });
}

/** The text of the refine request for these parts' crops (numbered from 1 in this request). */
export function refineRequest(names: readonly string[]): string {
  return [`下面 ${names.length} 张是从同一张大图里裁出来的局部图，按顺序编号：`,
    ...names.map((n, i) => `第 ${i + 1} 张：找「${n}」`)].join("\n");
}

/** The parts with their boxes from the refine answers (one per batch of REFINE_BATCH parts, null
 *  where the request failed); a part whose crop got no usable box keeps its first box. `regions`
 *  are refineRegion's, in the parts' order. Crops are worked out again from the new boxes. */
export function applyRefine(parts: readonly DecomposePart[], regions: readonly Rect[], answers: readonly unknown[], size: Size, crop: CropOptions = {}): { parts: DecomposePart[]; notes: string[] } {
  const notes: string[] = [];
  const out = parts.map((p, j) => {
    const answer = answers[Math.floor(j / REFINE_BATCH)];
    const list = answer && typeof answer === "object" ? (answer as { boxes?: unknown }).boxes : null;
    const want = j % REFINE_BATCH + 1;
    const item = Array.isArray(list) ? list.find(x => x && typeof x === "object" && Number((x as { i?: unknown }).i) === want) as { box?: unknown } | undefined : undefined;
    const r = regions[j];
    const b = item && item.box != null && r ? boxOf(item.box, { width: rectW(r), height: rectH(r) }) : null;
    if (!b || typeof b === "string") {
      notes.push(`「${p.name}」${answer == null ? "细化请求失败" : item?.box === null ? "细化时没找到" : "细化没有给出范围"}，用第一次的框`);
      return { ...p, refined: false };
    }
    const raw = { left: r.left + b.left, top: r.top + b.top, right: r.left + b.right, bottom: r.top + b.bottom };
    // not touching the first box at all: the second look found something else
    if (raw.right <= p.box.left || raw.left >= p.box.right || raw.bottom <= p.box.top || raw.top >= p.box.bottom) {
      notes.push(`「${p.name}」细化的结果和第一次差得太远，用第一次的框`);
      return { ...p, refined: false };
    }
    const box = padBox(raw, size, crop.pad);
    return { ...p, box, crop: cropFor(box, size, crop), refined: true };
  });
  return { parts: out, notes };
}
