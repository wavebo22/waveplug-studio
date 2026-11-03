// 图层列表 thumbnails: cached per layer id, fetched only for the rows in view. A layer that changes
// is marked stale and keeps showing its old picture until the new one arrives (no flicker).

export class ThumbCache {
  private urls = new Map<number, string | null>();
  private stale = new Set<number>();
  private versions = new Map<number, number>();

  /** the picture, null when the layer has none (empty, or Photoshop can't read it), undefined when not fetched */
  get(id: number): string | null | undefined { return this.urls.get(id); }
  /** changes whenever the picture does (for row redraw checks) */
  version(id: number): number { return this.versions.get(id) ?? 0; }

  put(id: number, url: string | null) {
    this.stale.delete(id);
    if (this.urls.get(id) === url && this.urls.has(id)) return;
    this.urls.set(id, url);
    this.versions.set(id, this.version(id) + 1);
  }

  invalidate(ids: Iterable<number> | "all") {
    for (const id of ids === "all" ? this.urls.keys() : ids) if (this.urls.has(id)) this.stale.add(id);
  }

  clear() { this.urls.clear(); this.stale.clear(); }

  /** Up to `n` of `visible` to fetch: never fetched first, then stale ones. */
  next(visible: number[], n: number): number[] {
    const missing = visible.filter(id => !this.urls.has(id));
    return missing.length >= n ? missing.slice(0, n) : [...missing, ...visible.filter(id => this.stale.has(id))].slice(0, n);
  }
}

export interface Bounds { left: number; top: number; right: number; bottom: number }

/**
 * A square thumbnail (`shaped`: the area's own shape), at most `size` px: the area (`canvas`) fitted and centred in it, the read pixels
 * where they sit in the area, everything transparent a checkerboard (a mask's outside white).
 * `px` is what Photoshop read for the canvas area, at any scale, covering `at` (canvas px). Whatever
 * Photoshop returns — a part of the canvas, a 30000 px line, a sliver under 1 px — the picture is
 * always this small frame: UXP stopped painting the list at a thumbnail thousands of px long.
 * Out: flat RGB for Photoshop's JPEG encoder; null when the data doesn't match its size.
 */
export function frameThumb(canvas: { width: number; height: number; left?: number; top?: number }, size: number, px: { width: number; height: number; channels: number; data: Uint8Array }, at: Bounds, mask = false, shaped = false): { width: number; height: number; data: Uint8Array } | null {
  const { width: sw, height: sh, channels: ch, data } = px;
  if (!(canvas.width >= 1 && canvas.height >= 1 && sw >= 1 && sh >= 1 && ch >= 1 && ch <= 4) || data.length < sw * sh * ch) return null;
  if (![at.left, at.top, at.right, at.bottom].every(Number.isFinite) || at.right <= at.left || at.bottom <= at.top) return null;
  const k = Math.min(1, size / Math.max(canvas.width, canvas.height));
  const S = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) * k));
  const W = shaped ? Math.max(1, Math.round(canvas.width * k)) : S, H = shaped ? Math.max(1, Math.round(canvas.height * k)) : S;
  // where the read pixels land in the picture; at least one px each way so a hairline still shows
  const padX = (W - canvas.width * k) / 2, padY = (H - canvas.height * k) / 2;
  const ox = (canvas.left ?? 0) - padX / k, oy = (canvas.top ?? 0) - padY / k;
  let x0 = (at.left - ox) * k, x1 = (at.right - ox) * k, y0 = (at.top - oy) * k, y1 = (at.bottom - oy) * k;
  if (x1 - x0 < 1) { const c = (x0 + x1) / 2; x0 = c - .5; x1 = c + .5; }
  if (y1 - y0 < 1) { const c = (y0 + y1) / 2; y0 = c - .5; y1 = c + .5; }
  // nothing drawn outside the area itself (the square's margins stay checkerboard)
  const ax0 = padX, ay0 = padY, ax1 = W - padX, ay1 = H - padY;
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = (y * W + x) * 3, bg = mask ? 255 : ((x >> 2) + (y >> 2)) & 1 ? 204 : 255;
    const fx = x + .5, fy = y + .5;
    if (fx < x0 || fx >= x1 || fy < y0 || fy >= y1 || fx < ax0 || fx >= ax1 || fy < ay0 || fy >= ay1) { out[d] = out[d + 1] = out[d + 2] = bg; continue; }
    const sx = Math.min(sw - 1, Math.floor((fx - x0) / (x1 - x0) * sw)), sy = Math.min(sh - 1, Math.floor((fy - y0) / (y1 - y0) * sh));
    const s = (sy * sw + sx) * ch;
    // gray, gray + alpha, RGB, RGBA
    const rgb = ch >= 3 ? [data[s], data[s + 1], data[s + 2]] : [data[s], data[s], data[s]];
    const a = ch === 4 ? data[s + 3] / 255 : ch === 2 ? data[s + 1] / 255 : 1;
    for (let c = 0; c < 3; c++) out[d + c] = Math.round(rgb[c] * a + bg * (1 - a));
  }
  return { width: W, height: H, data: out };
}

/**
 * What a layer's thumbnail shows: the layer's own bounds (its content fills the picture, as before),
 * widened on the short side to at most `maxRatio` : 1, so a thin line is read as a band at most 4 × as
 * long as high — scaled to the thumbnail's size, never a picture thousands of px long or 0 px high.
 * Frame it with frameThumb({ width, height, left, top } of this area).
 */
export function thumbArea(b: Bounds, maxRatio = 4): Bounds | null {
  const w = b.right - b.left, h = b.bottom - b.top;
  if (!(w > 0 && h > 0) || ![b.left, b.top, b.right, b.bottom].every(Number.isFinite)) return null;
  if (w > h * maxRatio) { const add = (w / maxRatio - h) / 2; return { left: b.left, right: b.right, top: b.top - add, bottom: b.bottom + add }; }
  if (h > w * maxRatio) { const add = (h / maxRatio - w) / 2; return { left: b.left - add, right: b.right + add, top: b.top, bottom: b.bottom }; }
  return { ...b };
}
