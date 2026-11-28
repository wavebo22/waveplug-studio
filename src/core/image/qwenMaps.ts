// AI 拆层 · 分区图: two pictures of the document made by the 局部重绘 workflow (Qwen) over the whole
// area, each with one prompt — the layout kept exactly, the background gone:
//   · 品红图: white background, every text magenta, the graphics in their own colours,
//   · 黑字图: white background, every text black, the graphics in their own colours.
// The magenta is the text map (no paper grain, panels or illustration in it), everything not white
// in either is the graphics map (one picture drops what the other keeps: the black one lost the
// steam, the magenta one a dashed line, 11-28). They replace the original's ink map in the alignment
// (core/image/textAlign.ts), when they agree with the original. Pure (tests/qwen_maps.test.ts).

import type { Pixels } from "./png.ts";
import type { Rect } from "./region.ts";
import { type InkMap, finishInk } from "./textAlign.ts";

export const QWEN_TEXT_PROMPT = "保持画面中所有元素的位置、大小、形状完全不变，不要移动、缩放、重画或删除任何东西，也不要添加新的东西。把所有背景（纸张纹理、底色、色块、桌面、阴影）全部去掉，填充为纯白色。把所有文字（标题、标语、价格数字和¥符号、正文小字、竖排文字、地址）改成纯品红色（#FF00FF），文字的笔画形状保持不变。文字以外的所有图形（插画、印章、圆点、图标、竖线、虚线）保持原来的颜色；原本是白色或很浅的图形（如烟雾、热气）改成浅灰色，让它在白底上看得见。";
export const QWEN_BLACK_PROMPT = "保持画面中所有元素的位置、大小、形状完全不变，不要移动、缩放、重画或删除任何东西，也不要添加新的东西。把所有背景（纸张纹理、底色、色块、桌面、阴影）全部去掉，填充为纯白色。把所有文字（标题、标语、正文小字、竖排文字、地址）改成纯黑色。文字以外的所有图形（插画、印章、圆点、图标、装饰线）保持原来的颜色。";

const px = (p: Pixels, i: number): [number, number, number] => {
  const o = i * p.channels;
  if (p.channels >= 3) {
    if (p.channels === 4 && p.data[o + 3] < 128) return [255, 255, 255];
    return [p.data[o], p.data[o + 1], p.data[o + 2]];
  }
  return [p.data[o], p.data[o], p.data[o]];
};

/** magenta (or a lighter, anti-aliased magenta): red and blue well above green, about as high */
export const isMagenta = (r: number, g: number, b: number) => r > 150 && b > 110 && r - g > 50 && b - g > 30 && Math.abs(r - b) < 110;
/** not the white background: coloured, or darker than near-white */
export const isForeground = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) > 30 || 0.299 * r + 0.587 * g + 0.114 * b < 232;

export function textMask(p: Pixels): Uint8Array {
  const out = new Uint8Array(p.width * p.height);
  for (let i = 0; i < out.length; i++) { const [r, g, b] = px(p, i); out[i] = isMagenta(r, g, b) ? 1 : 0; }
  return out;
}

export function foregroundMask(...pics: Pixels[]): Uint8Array {
  const out = new Uint8Array(pics[0].width * pics[0].height);
  for (const p of pics) for (let i = 0; i < out.length; i++) { if (out[i]) continue; const [r, g, b] = px(p, i); out[i] = isForeground(r, g, b) ? 1 : 0; }
  return out;
}

/** The share of `original`'s ink within `reach` pixels of `fg`: how well the map lies over the picture. */
export function agreement(original: InkMap, fg: Uint8Array, reach = 3): number {
  const w = original.width, h = original.height, W1 = w + 1;
  const sum = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += fg[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; } }
  let ink = 0, near = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!original.ink[y * w + x]) continue;
    ink++;
    const l = Math.max(0, x - reach), t = Math.max(0, y - reach), r = Math.min(w, x + reach + 1), b = Math.min(h, y + reach + 1);
    if (sum[b * W1 + r] - sum[t * W1 + r] - sum[b * W1 + l] + sum[t * W1 + l] > 0) near++;
  }
  return ink ? near / ink : 0;
}

/** below this agreement the maps are not used (they don't lie over the picture) */
export const MIN_AGREEMENT = 0.6;

/** The text and graphics ink maps from the two pictures (same size as `original`, the original's
 *  ink map); `ok` false when they don't lie over the picture. */
export function qwenInk(magenta: Pixels, black: Pixels | null, original: InkMap): { text: InkMap; objects: InkMap; agree: number; ok: boolean } {
  const w = original.width, h = original.height;
  if (magenta.width !== w || magenta.height !== h || black && (black.width !== w || black.height !== h)) throw new Error("分区图和画面大小不一致");
  const fg = foregroundMask(...(black ? [magenta, black] : [magenta]));
  const agree = agreement(original, fg);
  return { text: finishInk(w, h, textMask(magenta)), objects: finishInk(w, h, fg), agree, ok: agree >= MIN_AGREEMENT };
}

/** `pic`, a picture of `outRect` of the document, as the part `area` of it at `size` (white where it
 *  doesn't reach). Nearest-neighbour: the maps are read by colour, blended edges only blur them. */
export function fitToArea(pic: Pixels, outRect: Rect, area: Rect, size: { width: number; height: number }): Pixels {
  const ch = pic.channels, out = new Uint8Array(size.width * size.height * ch).fill(255);
  const sx = (outRect.right - outRect.left) / pic.width, sy = (outRect.bottom - outRect.top) / pic.height;
  const ax = (area.right - area.left) / size.width, ay = (area.bottom - area.top) / size.height;
  for (let y = 0; y < size.height; y++) {
    const docY = area.top + (y + 0.5) * ay, py = Math.floor((docY - outRect.top) / sy);
    if (py < 0 || py >= pic.height) continue;
    for (let x = 0; x < size.width; x++) {
      const docX = area.left + (x + 0.5) * ax, pxx = Math.floor((docX - outRect.left) / sx);
      if (pxx < 0 || pxx >= pic.width) continue;
      const o = (y * size.width + x) * ch, q = (py * pic.width + pxx) * ch;
      for (let k = 0; k < ch; k++) out[o + k] = pic.data[q + k];
    }
  }
  return { width: size.width, height: size.height, channels: ch, data: out };
}
