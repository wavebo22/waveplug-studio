// Turns captured canvas pixels + selection mask into the files a workflow expects.
// Selection mask convention (Photoshop): 255 = fully selected = area to repaint.

import type { Encoding } from "../workflow/profile.ts";
import type { Pixels } from "./png.ts";
import { type Rect, rectH, rectW } from "./region.ts";

function toRgb(src: Pixels): Uint8Array {
  if (src.channels === 3) return src.data;
  const n = src.width * src.height, out = new Uint8Array(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += src.channels, k += 3) {
    if (src.channels === 1) { out[k] = out[k + 1] = out[k + 2] = src.data[j]; }
    else { out[k] = src.data[j]; out[k + 1] = src.data[j + 1]; out[k + 2] = src.data[j + 2]; }
  }
  return out;
}

function sameSize(a: Pixels, b: Pixels) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`画面 ${a.width}×${a.height} 与选区 ${b.width}×${b.height} 尺寸不一致`);
}

/**
 * ComfyUI LoadImage derives MASK = 1 - alpha, so the repaint area must be transparent.
 * RGB under transparent pixels is kept as-is (the encoder never premultiplies).
 */
export function imageWithAlphaMask(image: Pixels, selection: Pixels, mark = 0): Pixels {
  sameSize(image, selection);
  if (selection.channels !== 1) throw new Error("选区必须是单通道灰度");
  const rgb = toRgb(image), n = image.width * image.height, out = new Uint8Array(n * 4);
  for (let i = 0, k = 0, q = 0; i < n; i++, k += 3, q += 4) {
    // optional red tint over the selection: some edit-model workflows locate the area by colour
    const t = mark * selection.data[i] / 255;
    out[q] = Math.round(rgb[k] * (1 - t) + 255 * t);
    out[q + 1] = Math.round(rgb[k + 1] * (1 - t));
    out[q + 2] = Math.round(rgb[k + 2] * (1 - t));
    out[q + 3] = 255 - selection.data[i];
  }
  return { width: image.width, height: image.height, channels: 4, data: out };
}

export function maskFile(selection: Pixels, encoding: "mask-alpha" | "mask-gray"): Pixels {
  if (selection.channels !== 1) throw new Error("选区必须是单通道灰度");
  if (encoding === "mask-gray") return selection;
  // LoadImageMask(channel=alpha) also computes 1 - alpha
  const n = selection.width * selection.height, out = new Uint8Array(n * 4);
  for (let i = 0, q = 0; i < n; i++, q += 4) out[q + 3] = 255 - selection.data[i];
  return { width: selection.width, height: selection.height, channels: 4, data: out };
}

export function imageFile(image: Pixels, encoding: Encoding, selection?: Pixels, mark = 0): Pixels {
  switch (encoding) {
    case "rgba-alpha-mask":
      if (!selection) throw new Error("该工作流需要选区");
      return imageWithAlphaMask(image, selection, mark);
    case "rgb":
      return { width: image.width, height: image.height, channels: 3, data: toRgb(image) };
    default:
      throw new Error(`${encoding} 不是图片编码`);
  }
}

/** Full-canvas selection used when the document has none. */
export function fullSelection(width: number, height: number): Pixels {
  return { width, height, channels: 1, data: new Uint8Array(width * height).fill(255) };
}

export function isEmptySelection(sel: Pixels): boolean {
  for (let i = 0; i < sel.data.length; i++) if (sel.data[i] > 0) return false;
  return true;
}

/**
 * Photoshop returns selection / mask data only for the selection's own bounding box, not the
 * requested area. Re-places a 1-channel buffer covering `src` into a buffer covering `dst`.
 */
export function placeGray(p: Pixels, src: Rect, dst: Rect, fill = 0): Pixels {
  if (p.channels !== 1) throw new Error("只支持单通道");
  if (p.width !== rectW(src) || p.height !== rectH(src)) throw new Error(`选区数据 ${p.width}×${p.height} 与其范围 ${rectW(src)}×${rectH(src)} 不符`);
  const w = rectW(dst), h = rectH(dst), out = new Uint8Array(w * h).fill(fill);
  const x0 = Math.max(src.left, dst.left), x1 = Math.min(src.right, dst.right);
  const y0 = Math.max(src.top, dst.top), y1 = Math.min(src.bottom, dst.bottom);
  for (let y = y0; y < y1; y++) {
    const from = (y - src.top) * p.width + (x0 - src.left);
    out.set(p.data.subarray(from, from + Math.max(0, x1 - x0)), (y - dst.top) * w + (x0 - dst.left));
  }
  return { width: w, height: h, channels: 1, data: out };
}
