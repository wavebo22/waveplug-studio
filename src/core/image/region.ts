// Geometry shared by capture and write-back. All rects are integer document pixels, right/bottom exclusive.

export interface Rect { left: number; top: number; right: number; bottom: number }

export const rectW = (r: Rect) => r.right - r.left;
export const rectH = (r: Rect) => r.bottom - r.top;

export function clampRect(r: Rect, width: number, height: number): Rect {
  const out = {
    left: Math.max(0, Math.floor(r.left)), top: Math.max(0, Math.floor(r.top)),
    right: Math.min(width, Math.ceil(r.right)), bottom: Math.min(height, Math.ceil(r.bottom)),
  };
  if (out.right <= out.left || out.bottom <= out.top) throw new Error("选区不在画布范围内");
  return out;
}

/** `r` grown by `px` pixels on every side, clamped to the canvas. */
export function expandBy(r: Rect, px: number, width: number, height: number): Rect {
  return clampRect({ left: r.left - px, top: r.top - px, right: r.right + px, bottom: r.bottom + px }, width, height);
}

/** Bounding box of non-zero values in a 1-channel buffer covering `at`, or null if empty. */
export function nonZeroBounds(data: Uint8Array, width: number, height: number, at: Rect): Rect | null {
  let l = width, t = height, r = -1, b = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[y * width + x]) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  }
  return r < 0 ? null : { left: at.left + l, top: at.top + t, right: at.left + r + 1, bottom: at.top + b + 1 };
}

/** Generation size for workflows that don't resize on their own: keep aspect, cap pixel count, snap to a multiple. */
export function fitSize(w: number, h: number, maxPixels = 1024 * 1024, multiple = 16): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  const snap = (v: number) => Math.max(multiple, Math.round((v * scale) / multiple) * multiple);
  return { width: snap(w), height: snap(h) };
}
