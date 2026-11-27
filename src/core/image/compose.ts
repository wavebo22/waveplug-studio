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

/** Area-average downscale (each output pixel is the mean of the source pixels it covers). */
export function downscale(p: Pixels, width: number, height: number): Pixels {
  const { width: sw, height: sh, channels: ch } = p;
  if (width >= sw && height >= sh) return p;
  const out = new Uint8Array(width * height * ch), acc = new Float64Array(width * ch), wsum = new Float64Array(width);
  const fx = sw / width, fy = sh / height;
  // horizontal spans of every output column: [first source x, weights…]
  const spans = Array.from({ length: width }, (_, x) => {
    const a = x * fx, b = a + fx, xs: number[] = [], ws: number[] = [];
    for (let s = Math.floor(a); s < Math.min(sw, Math.ceil(b)); s++) { xs.push(s); ws.push(Math.min(b, s + 1) - Math.max(a, s)); }
    return { xs, ws };
  });
  for (let y = 0; y < height; y++) {
    acc.fill(0); wsum.fill(0);
    const a = y * fy, b = a + fy;
    for (let sy = Math.floor(a); sy < Math.min(sh, Math.ceil(b)); sy++) {
      const wy = Math.min(b, sy + 1) - Math.max(a, sy), row = sy * sw;
      for (let x = 0; x < width; x++) {
        const { xs, ws } = spans[x];
        for (let k = 0; k < xs.length; k++) {
          const w = wy * ws[k], i = (row + xs[k]) * ch;
          for (let c = 0; c < ch; c++) acc[x * ch + c] += p.data[i + c] * w;
          wsum[x] += w;
        }
      }
    }
    for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) out[(y * width + x) * ch + c] = Math.round(acc[x * ch + c] / wsum[x]);
  }
  return { width, height, channels: ch, data: out };
}

/** Bilinear resize of any channel count. */
export function resize(p: Pixels, width: number, height: number): Pixels {
  const { width: sw, height: sh, channels: ch } = p;
  if (width === sw && height === sh) return p;
  const out = new Uint8Array(width * height * ch), fx = sw / width, fy = sh / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * fy - 0.5)), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * fx - 0.5)), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const a = (y0 * sw + x0) * ch, b = (y0 * sw + x1) * ch, c = (y1 * sw + x0) * ch, d = (y1 * sw + x1) * ch, o = (y * width + x) * ch;
      for (let k = 0; k < ch; k++) {
        const top = p.data[a + k] + (p.data[b + k] - p.data[a + k]) * tx, bottom = p.data[c + k] + (p.data[d + k] - p.data[c + k]) * tx;
        out[o + k] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return { width, height, channels: ch, data: out };
}

/** ≈ gaussian blur of `sigma` px: three passes of a box blur in each direction (integer arithmetic). */
export function blur(p: Pixels, sigma: number): Pixels {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const { width: w, height: h, channels: ch } = p;
  // two scratch buffers of its own: the input is never written to
  let src: Uint8Array = new Uint8Array(p.data), dst: Uint8Array = new Uint8Array(p.data.length);
  const pass = (len: number, count: number, step: number, lineStep: number) => {
    const win = 2 * r + 1;
    for (let line = 0; line < count; line++) for (let k = 0; k < ch; k++) {
      const base = line * lineStep + k;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[base + Math.min(len - 1, Math.max(0, i)) * step];
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = (sum + (win >> 1)) / win | 0;
        sum += src[base + Math.min(len - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step];
      }
    }
    [src, dst] = [dst, src];
  };
  for (let n = 0; n < 3; n++) { pass(w, h, ch, w * ch); pass(h, w, w * ch, ch); }
  return { width: w, height: h, channels: ch, data: src };
}

/**
 * Light and colour from `result`, fine detail from `original` (same size, RGB/RGBA → RGB):
 * blur(result) + original − blur(original). A relit result that was sampled smaller than the
 * document keeps the original's sharpness this way.
 */
export function transferDetail(result: Pixels, original: Pixels, sigma: number): Pixels {
  const rgb = (p: Pixels): Pixels => p.channels === 3 ? p : { width: p.width, height: p.height, channels: 3, data: toRgb(p) };
  const r = rgb(result), o = rgb(original);
  if (r.width !== o.width || r.height !== o.height) throw new Error("图像尺寸不一致");
  const br = blur(r, sigma).data, bo = blur(o, sigma).data, out = new Uint8Array(o.data.length);
  for (let i = 0; i < out.length; i++) { const v = br[i] + o.data[i] - bo[i]; out[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
  return { width: o.width, height: o.height, channels: 3, data: out };
}

/**
 * The selection (255 = selected) faded to 0 over `width` px inside its edge (smoothstep), so a
 * result blends into the original instead of stopping at a hard line. The canvas border is not an
 * edge. Distance is a 3-4 chamfer approximation.
 */
export function featherInside(sel: Pixels, width: number): Pixels {
  const { width: w, height: h } = sel, n = w * h, BIG = 1 << 29, d = new Int32Array(n);
  for (let i = 0; i < n; i++) d[i] = sel.data[i] > 127 ? BIG : 0;
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h ? BIG : d[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!d[i]) continue;
    const t = Math.min(1, d[i] / 3 / Math.max(1, width));
    out[i] = Math.round(sel.data[i] * t * t * (3 - 2 * t));
  }
  return { width: w, height: h, channels: 1, data: out };
}

/**
 * 抠图 detail: like transferDetail, but the original's fine detail is used only where the result
 * still shows the same thing. The light/colour difference is taken as the largest within ~2 blur
 * radii, so even a thin stroke the model removed (an occluder's edge, lettering) marks its
 * surroundings as changed; there the result keeps its own pixels. Full use below `near`, none
 * above `far`.
 */
export function transferDetailWhereSame(result: Pixels, original: Pixels, sigma: number, near = 8, far = 20): Pixels {
  const rgb = (p: Pixels): Pixels => p.channels === 3 ? p : { width: p.width, height: p.height, channels: 3, data: toRgb(p) };
  const r = rgb(result), o = rgb(original), { width: w, height: h } = o, n = w * h;
  if (r.width !== w || r.height !== h) throw new Error("图像尺寸不一致");
  const br = blur(r, sigma).data, bo = blur(o, sigma).data;
  // per-pixel difference, then its maximum over a square of radius `reach` (two separable passes)
  const diff = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    diff[i] = Math.min(255, Math.max(Math.abs(br[j] - bo[j]), Math.abs(br[j + 1] - bo[j + 1]), Math.abs(br[j + 2] - bo[j + 2])));
  }
  const reach = Math.max(2, Math.ceil(sigma * 2)), tmp = new Uint8Array(n), wide = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - reach); k <= Math.min(w - 1, x + reach); k++) if (diff[y * w + k] > m) m = diff[y * w + k];
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let k = Math.max(0, y - reach); k <= Math.min(h - 1, y + reach); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
    wide[y * w + x] = m;
  }
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = wide[i], t = d <= near ? 1 : d >= far ? 0 : (far - d) / (far - near);
    for (let k = 0; k < 3; k++) {
      const j = i * 3 + k, v = br[j] + t * (o.data[j] - bo[j]) + (1 - t) * (r.data[j] - br[j]);
      out[j] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return { width: w, height: h, channels: 3, data: out };
}

/** One gray mask covering several (each over its own rect, in document pixels): the union, over the
 *  rect bounding them all (AI 拆层 removes every cut-out from the original in one run). */
export function mergeMasks(masks: readonly { pixels: Pixels; rect: Rect }[]): { pixels: Pixels; rect: Rect } | null {
  if (!masks.length) return null;
  const rect = masks.reduce<Rect>((a, m) => ({ left: Math.min(a.left, m.rect.left), top: Math.min(a.top, m.rect.top), right: Math.max(a.right, m.rect.right), bottom: Math.max(a.bottom, m.rect.bottom) }), masks[0].rect);
  const w = rect.right - rect.left, h = rect.bottom - rect.top, out = new Uint8Array(w * h);
  for (const m of masks) {
    const mw = m.pixels.width, ox = m.rect.left - rect.left, oy = m.rect.top - rect.top;
    for (let y = 0; y < m.pixels.height; y++) {
      const row = (y + oy) * w + ox;
      for (let x = 0; x < mw; x++) { const v = m.pixels.data[y * mw + x]; if (v > out[row + x]) out[row + x] = v; }
    }
  }
  return { pixels: { width: w, height: h, channels: 1, data: out }, rect };
}
