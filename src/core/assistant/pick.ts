// 一句话选图层 (the AI button beside the WavePlug 图层 panel's search box): the user describes the
// layers in a sentence (「所有按钮」「标题相关的文字」「隐藏的产品图」), DeepSeek picks them from the
// same layer description AI 整理 sends (names, kinds, boxes, text contents), the panel selects them.
// Pure (tests/assistant_pick.test.ts).

import type { TreeLayer } from "../layers/tree.ts";

/** Longer documents are cut (the answer only names ids, but the request grows with every layer). */
export const PICK_MAX_LAYERS = 800;

export const PICK_SYSTEM = `你是 Photoshop 图层查找助手。用户用一句话描述想选中的图层，你根据图层信息找出所有符合的图层。只输出 JSON。

规则：
1. 依据：name 是图层名，kind 是类型（text 文字、pixel 像素、shape 形状、smartObject 智能对象、group 组、adjustment 调整、fill 填充、artboard 画板），text 是文字内容，box 是 [左, 上, 宽, 高]（像素），parent 是所在组的 id，hidden 表示隐藏，fx 是图层样式，file 是智能对象的文件名，clip 是剪贴图层，mask 是带蒙版。你看不到图像。
2. 用户说「按钮」「图标」「标题」这类元素时，按名字、文字内容、大小和位置综合判断；一个元素是一个组时选这个组，不要再把组里的图层也列出来。
3. 用户说位置（「左上角」「底部」）时，用 box 和画布大小判断。
4. 宁可少选也不要乱选；找不到就返回空数组。

输出格式：{"ids":[数字,…],"note":"一句话说明按什么挑的"}`;

export function pickUserPrompt(lines: string, ask: string, opts: { width: number; height: number; cut: number }): string {
  return [
    `画布 ${Math.round(opts.width)}×${Math.round(opts.height)} 像素。图层从上到下（和 Photoshop 图层面板顺序相同），每行一个：`,
    lines,
    ...(opts.cut ? [`（还有 ${opts.cut} 个图层太多没有列出）`] : []),
    `用户要选中：${ask.replace(/\s+/g, " ").trim().slice(0, 300)}`,
  ].join("\n\n");
}

/** The layers the request lists: every one except the background, top to bottom, at most PICK_MAX_LAYERS. */
export function pickScope(layers: readonly TreeLayer[]): { ids: number[]; cut: number } {
  const ids = layers.filter(l => l.kind !== "background").map(l => l.id);
  return { ids: ids.slice(0, PICK_MAX_LAYERS), cut: Math.max(0, ids.length - PICK_MAX_LAYERS) };
}

/** The answer's layers that exist (in panel order, no duplicates), and its note. */
export function parsePick(value: unknown, layers: readonly TreeLayer[]): { ids: number[]; note: string } {
  const v = (value && typeof value === "object" ? value : {}) as { ids?: unknown; note?: unknown };
  const want = new Set((Array.isArray(v.ids) ? v.ids : []).map(x => typeof x === "string" && /^\d+$/.test(x.trim()) ? Number(x) : x).filter((x): x is number => typeof x === "number" && Number.isInteger(x)));
  const ids = layers.filter(l => want.has(l.id)).map(l => l.id);
  const note = typeof v.note === "string" ? v.note.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { ids, note };
}
