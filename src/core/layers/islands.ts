// 裁剪边缘 and 像素岛: connected regions of a layer's alpha. Pure, so it's tested without Photoshop.
// Photoshop only receives selections built from these masks (the pixels themselves never round-trip,
// so colours stay exact in any document mode).

import type { Pixels } from "../image/png.ts";
import type { Rect } from "../image/region.ts";

export interface Island {
  /** pixels of the island (alpha above the threshold) */
  area: number;
  /** bounds within the alpha image */
  bounds: Rect;
  /** 1-channel mask over `bounds`, 255 = belongs to the island */
  mask: Uint8Array;
}

/**
 * The islands of `alpha` (w × h): pixels above `threshold`, 8-connected. With `merge` > 0, pieces
 * at most that many pixels apart count as one island. Sorted top to bottom, then left to right.
 */
export function findIslands(alpha: Uint8Array, w: number, h: number, threshold: number, merge = 0): Island[] {
  const n = w * h, solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = alpha[i] > threshold ? 1 : 0;
  // regions are found on the grown mask (so close pieces join); islands keep only solid pixels
  const grown = merge > 0 ? dilate(solid, w, h, Math.ceil(merge / 2)) : solid;
  const label = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const islands: Island[] = [];
  for (let start = 0; start < n; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    const id = islands.length;
    let top = 0, area = 0, l = w, t = h, r = 0, b = 0;
    stack[top++] = start; label[start] = id;
    while (top) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      if (solid[i]) { area++; if (x < l) l = x; if (x >= r) r = x + 1; if (y < t) t = y; if (y >= b) b = y + 1; }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (grown[j] && label[j] < 0) { label[j] = id; stack[top++] = j; }
        }
      }
    }
    islands.push({ area, bounds: { left: l, top: t, right: r, bottom: b }, mask: new Uint8Array(0) });
  }
  for (const [id, isl] of islands.entries()) {
    if (!isl.area) continue;
    const { left, top, right, bottom } = isl.bounds, bw = right - left, mask = new Uint8Array(bw * (bottom - top));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = y * w + x;
      if (solid[i] && label[i] === id) mask[(y - top) * bw + x - left] = 255;
    }
    isl.mask = mask;
  }
  return islands.filter(i => i.area > 0).sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
}

/** Square dilation by `r` px (separable running maximum). */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) { if (src[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) { if (src[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/** 裁剪边缘 settings from one 清理强度 (0–1): alpha threshold (0–255) and smallest kept area (px). */
export function cleanSettings(strength: number): { alpha: number; minArea: number } {
  const s = Math.max(0, Math.min(1, strength));
  return { alpha: Math.round(4 + s * 76), minArea: Math.round(4 + s * s * 396) };
}

/**
 * 裁剪边缘: the pixels to clear (255) — faint pixels at or below `alpha`, and every island smaller
 * than `minArea`. Returns null when nothing would change.
 */
export function cleanMask(alpha: Uint8Array, w: number, h: number, opts: { alpha: number; minArea: number }): { mask: Uint8Array; faint: number; specks: number; cleared: number } | null {
  const n = w * h, mask = new Uint8Array(n);
  let faint = 0, specks = 0, cleared = 0;
  for (let i = 0; i < n; i++) if (alpha[i] > 0 && alpha[i] <= opts.alpha) { mask[i] = 255; faint++; }
  for (const isl of findIslands(alpha, w, h, opts.alpha)) {
    if (isl.area >= opts.minArea) continue;
    specks++;
    const { left, top, right } = isl.bounds, bw = right - left;
    for (let k = 0; k < isl.mask.length; k++) if (isl.mask[k]) mask[(top + Math.floor(k / bw)) * w + left + k % bw] = 255;
  }
  for (let i = 0; i < n; i++) if (mask[i]) cleared++;
  return cleared ? { mask, faint, specks, cleared } : null;
}

/**
 * 裁剪边缘 on an RGBA image (a smart object's content): cleared pixels become fully transparent and
 * the image is cropped to what is left. `crop` is where the result lies in the original. Null when
 * nothing would change or nothing would be left.
 */
export function cleanRgba(p: Pixels, opts: { alpha: number; minArea: number }): { pixels: Pixels; crop: Rect; cleared: number } | null {
  if (p.channels !== 4) return null;
  const { width: w, height: h } = p, n = w * h, a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = p.data[i * 4 + 3];
  const c = cleanMask(a, w, h, opts);
  if (!c) return null;
  for (let i = 0; i < n; i++) if (c.mask[i]) a[i] = 0;
  const crop = contentBounds(a, w, h);
  if (!crop) return null;
  const cw = crop.right - crop.left, ch = crop.bottom - crop.top, out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((crop.top + y) * w + crop.left) * 4;
    out.set(p.data.subarray(src, src + cw * 4), y * cw * 4);
    for (let x = 0; x < cw; x++) if (!a[(crop.top + y) * w + crop.left + x]) out.fill(0, (y * cw + x) * 4, (y * cw + x) * 4 + 4);
  }
  return { pixels: { width: cw, height: ch, channels: 4, data: out }, crop, cleared: c.cleared };
}

/** Bounds of the pixels above `threshold`, or null when there are none. */
export function contentBounds(alpha: Uint8Array, w: number, h: number, threshold = 0): Rect | null {
  let l = w, t = h, r = 0, b = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] <= threshold) continue;
    if (x < l) l = x; if (x >= r) r = x + 1; if (y < t) t = y; if (y >= b) b = y + 1;
  }
  return r > l ? { left: l, top: t, right: r, bottom: b } : null;
}
