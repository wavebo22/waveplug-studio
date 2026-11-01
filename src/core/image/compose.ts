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
export function imageWithAlphaMask(image: Pixels, selection: Pixels): Pixels {
  sameSize(image, selection);
  if (selection.channels !== 1) throw new Error("选区必须是单通道灰度");
  const rgb = toRgb(image), n = image.width * image.height, out = new Uint8Array(n * 4);
  for (let i = 0, k = 0, q = 0; i < n; i++, k += 3, q += 4) {
    out[q] = rgb[k]; out[q + 1] = rgb[k + 1]; out[q + 2] = rgb[k + 2];
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

/**
 * Outpaint seam: a mask over the original image area that is 0 (keep the original) inside and
 * ramps to 255 over `feather` pixels at each edge that was extended, so the generated surround
 * blends into the original without covering it.
 */
export function outpaintSeam(w: number, h: number, pads: { left: number; right: number; top: number; bottom: number }, feather: number): Pixels {
  const out = new Uint8Array(w * h);
  const f = Math.max(1, Math.round(feather));
  for (let y = 0; y < h; y++) {
    const vy = Math.max(pads.top > 0 ? 1 - y / f : 0, pads.bottom > 0 ? 1 - (h - 1 - y) / f : 0);
    for (let x = 0; x < w; x++) {
      const vx = Math.max(pads.left > 0 ? 1 - x / f : 0, pads.right > 0 ? 1 - (w - 1 - x) / f : 0);
      const v = Math.max(vx, vy);
      if (v > 0) out[y * w + x] = Math.round(255 * Math.min(1, v));
    }
  }
  return { width: w, height: h, channels: 1, data: out };
}

/** RGBA → RGB composited over white (transparent layer areas would otherwise turn black in LoadImage). */
export function onWhite(p: Pixels): Pixels {
  if (p.channels !== 4) return { width: p.width, height: p.height, channels: 3, data: toRgb(p) };
  const n = p.width * p.height, out = new Uint8Array(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    const a = p.data[j + 3] / 255;
    out[k] = Math.round(p.data[j] * a + 255 * (1 - a));
    out[k + 1] = Math.round(p.data[j + 1] * a + 255 * (1 - a));
    out[k + 2] = Math.round(p.data[j + 2] * a + 255 * (1 - a));
  }
  return { width: p.width, height: p.height, channels: 3, data: out };
}

export function imageFile(image: Pixels, encoding: Encoding, selection?: Pixels): Pixels {
  switch (encoding) {
    case "rgba-alpha-mask":
      if (!selection) throw new Error("该工作流需要选区");
      return imageWithAlphaMask(image, selection);
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

/** True when an RGBA image has any pixel that is not fully opaque. */
export function hasTransparency(p: Pixels): boolean {
  if (p.channels !== 4) return false;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] !== 255) return true;
  return false;
}

/**
 * RGBA → RGB for upscaling a transparent layer: fully transparent pixels take the colour of the
 * nearest visible pixel (breadth-first), so edges don't pick up a white or black fringe.
 */
export function bleedTransparent(p: Pixels): Pixels {
  const { width: w, height: h } = p, n = w * h, out = new Uint8Array(n * 3);
  const done = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (p.data[i * 4 + 3] === 0) continue;
    out[i * 3] = p.data[i * 4]; out[i * 3 + 1] = p.data[i * 4 + 1]; out[i * 3 + 2] = p.data[i * 4 + 2];
    done[i] = 1; queue[tail++] = i;
  }
  if (!tail) return { width: w, height: h, channels: 3, data: out.fill(255) };
  while (head < tail) {
    const i = queue[head++], x = i % w;
    const visit = (j: number) => { if (!done[j]) { done[j] = 1; out[j * 3] = out[i * 3]; out[j * 3 + 1] = out[i * 3 + 1]; out[j * 3 + 2] = out[i * 3 + 2]; queue[tail++] = j; } };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  return { width: w, height: h, channels: 3, data: out };
}

/** The alpha channel of `p` resized (bilinear) to width × height. */
export function resizeAlpha(p: Pixels, width: number, height: number): Pixels {
  const { width: sw, height: sh } = p, out = new Uint8Array(width * height);
  const fx = sw / width, fy = sh / height;
  const a = (x: number, y: number) => p.data[(y * sw + x) * 4 + 3];
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * fy - 0.5)), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * fx - 0.5)), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const top = a(x0, y0) + (a(x1, y0) - a(x0, y0)) * tx, bottom = a(x0, y1) + (a(x1, y1) - a(x0, y1)) * tx;
      out[y * width + x] = Math.round(top + (bottom - top) * ty);
    }
  }
  return { width, height, channels: 1, data: out };
}

/** RGB(A) colour + a 1-channel alpha of the same size → RGBA. */
export function withAlpha(color: Pixels, alpha: Pixels): Pixels {
  const n = color.width * color.height, ch = color.channels, out = new Uint8Array(n * 4);
  if (alpha.width !== color.width || alpha.height !== color.height) throw new Error("透明通道尺寸与图像不符");
  for (let i = 0; i < n; i++) {
    out[i * 4] = color.data[i * ch]; out[i * 4 + 1] = color.data[i * ch + (ch >= 3 ? 1 : 0)]; out[i * 4 + 2] = color.data[i * ch + (ch >= 3 ? 2 : 0)];
    out[i * 4 + 3] = alpha.data[i];
  }
  return { width: color.width, height: color.height, channels: 4, data: out };
}
