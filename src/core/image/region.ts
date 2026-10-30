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

/** Selection bounds grown by `margin` × its size on every side, clamped to the canvas. */
export function expand(r: Rect, margin: number, width: number, height: number): Rect {
  const dx = Math.round(rectW(r) * margin), dy = Math.round(rectH(r) * margin);
  return clampRect({ left: r.left - dx, top: r.top - dy, right: r.right + dx, bottom: r.bottom + dy }, width, height);
}

/**
 * Where a result covering `sent` must be placed inside a task-group PSB whose canvas is `group`.
 * Returns the target rect in PSB coordinates (may extend past the PSB canvas; PS clips it).
 */
export function placementInGroup(sent: Rect, group: Rect): Rect {
  return { left: sent.left - group.left, top: sent.top - group.top, right: sent.right - group.left, bottom: sent.bottom - group.top };
}

/** Generation size for workflows that don't resize on their own: keep aspect, cap pixel count, snap to a multiple. */
export function fitSize(w: number, h: number, maxPixels = 1024 * 1024, multiple = 16): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  const snap = (v: number) => Math.max(multiple, Math.round((v * scale) / multiple) * multiple);
  return { width: snap(w), height: snap(h) };
}
