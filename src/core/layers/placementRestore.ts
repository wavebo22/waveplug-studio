// 发送 / 置入时的位置还原：图层从一份 PSD 复制到另一份后，尽量回到「画面上的同一个位置」。
// Works on pixel rectangles only (Photoshop's boundsNoEffects); the host reads the real bounds of
// the copies in the target and translates / scales them by what this file works out, so the result
// doesn't depend on where Photoshop happens to drop a cross-document duplicate.
//
// Rules (docs/WORKBENCH_DRAG_DEMO.md, 11-13):
// 1. Same frame size: the same pixel position.
// 2. Different sizes, per axis: content near an edge (the nearer margin < EDGE_RATIO of that axis)
//    keeps its distance to that edge (scaled by the axis ratio); anything else keeps the relative
//    position of its centre.
// 3. Several layers move as one block: their arrangement inside the block is kept.
// 4. Size: unchanged by default; longEdge (发送 default, 11-14) scales by the ratio of the two long
//    edges — the source canvas is 100%: the whole source canvas is scaled to the target's long
//    edge and centred in the target, and the layers keep their place in it (rule 2 not used; the
//    short side may overflow the target); scaleWithCanvas scales by min(width ratio, height ratio).
// 5. Moves are whole pixels.
// 6. Layers without bounds (adjustments, empty layers) don't move; nothing is clipped to the canvas.

export interface Rect { left: number; top: number; right: number; bottom: number }

export const EDGE_RATIO = 0.15;

export interface RestoreOptions {
  /** scale the content by min(width ratio, height ratio) of the two frames */
  scaleWithCanvas: boolean;
  /** scale the content by target long edge / source long edge (wins over scaleWithCanvas) */
  longEdge?: boolean;
}

/** A usable rectangle: finite, with a positive area. */
export function isArea(r: Rect | null | undefined): r is Rect {
  return !!r && [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
}

/** The bounding box of the rectangles that have an area; null when none has. */
export function unionRect(rects: readonly (Rect | null | undefined)[]): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) {
    if (!isArea(r)) continue;
    out = out ? {
      left: Math.min(out.left, r.left), top: Math.min(out.top, r.top),
      right: Math.max(out.right, r.right), bottom: Math.max(out.bottom, r.bottom),
    } : { ...r };
  }
  return out;
}

/** The scale applied to the content going from `src` to `dst` frames. */
export function restoreScale(src: Rect, dst: Rect, opts: RestoreOptions): number {
  if ((!opts.scaleWithCanvas && !opts.longEdge) || !isArea(src) || !isArea(dst)) return 1;
  const sw = src.right - src.left, sh = src.bottom - src.top, dw = dst.right - dst.left, dh = dst.bottom - dst.top;
  if (opts.longEdge) { const l = Math.max(dw, dh) / Math.max(sw, sh); return Number.isFinite(l) && l > 0 ? l : 1; }
  const s = Math.min((dst.right - dst.left) / (src.right - src.left), (dst.bottom - dst.top) / (src.bottom - src.top));
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** One axis of rule 2: the new [start, end) of a span of the source frame [f0, f1) in [g0, g1). */
function axis(f0: number, f1: number, b0: number, b1: number, g0: number, g1: number, s: number): [number, number] {
  const fw = f1 - f0, gw = g1 - g0, ratio = gw / fw, size = (b1 - b0) * s;
  if (fw === gw && s === 1) return [b0 - f0 + g0, b1 - f0 + g0]; // rule 1: exact
  const before = b0 - f0, after = f1 - b1, edge = EDGE_RATIO * fw;
  if (before <= after && before < edge) { const start = g0 + before * ratio; return [start, start + size]; }
  if (after < before && after < edge) { const end = g1 - after * ratio; return [end - size, end]; }
  const centre = g0 + ((b0 + b1) / 2 - f0) * ratio;
  return [centre - size / 2, centre + size / 2];
}

/** Where the block `box` (in source frame `src`) belongs in the target frame `dst`. */
export function restoreBox(src: Rect, box: Rect, dst: Rect, opts: RestoreOptions): { box: Rect; scale: number } {
  const scale = restoreScale(src, dst, opts);
  if (opts.longEdge && isArea(src) && isArea(dst)) {
    // rule 4b: the whole source canvas is scaled to the target's long edge and centred in the
    // target; every layer keeps its place inside that scaled canvas (no edge anchoring)
    const sx = (src.left + src.right) / 2, sy = (src.top + src.bottom) / 2;
    const tx = (dst.left + dst.right) / 2, ty = (dst.top + dst.bottom) / 2;
    return {
      box: {
        left: tx + (box.left - sx) * scale, right: tx + (box.right - sx) * scale,
        top: ty + (box.top - sy) * scale, bottom: ty + (box.bottom - sy) * scale,
      },
      scale,
    };
  }
  const [left, right] = axis(src.left, src.right, box.left, box.right, dst.left, dst.right, scale);
  const [top, bottom] = axis(src.top, src.bottom, box.top, box.bottom, dst.top, dst.bottom, scale);
  return { box: { left, top, right, bottom }, scale };
}

export interface RestoreLayer {
  /** the copy's id in the target */
  id: number;
  /** the source layer's bounds (source document pixels); null: no bounds, never moved */
  source: Rect | null;
}
export interface RestoreMove { id: number; scale: number; dx: number; dy: number }

/** Rule 3 for each copy: its centre goes where the block maps it. `actual(id)` gives the copy's
 *  current bounds in the target, read AFTER the host scaled it by restoreScale() about its own
 *  centre. Layers without bounds (source or copy) get no move. */
export function restoreMoves(
  src: Rect, dst: Rect, layers: readonly RestoreLayer[], opts: RestoreOptions,
  actual: (id: number) => Rect | null,
): RestoreMove[] {
  const block = unionRect(layers.map(l => l.source));
  if (!block || !isArea(src) || !isArea(dst)) return [];
  const { box, scale } = restoreBox(src, block, dst, opts);
  const bc = { x: (block.left + block.right) / 2, y: (block.top + block.bottom) / 2 };
  const nc = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const out: RestoreMove[] = [];
  for (const l of layers) {
    if (!isArea(l.source)) continue;
    const now = actual(l.id);
    if (!isArea(now)) continue;
    const want = {
      x: nc.x + ((l.source.left + l.source.right) / 2 - bc.x) * scale,
      y: nc.y + ((l.source.top + l.source.bottom) / 2 - bc.y) * scale,
    };
    const dx = Math.round(want.x - (now.left + now.right) / 2), dy = Math.round(want.y - (now.top + now.bottom) / 2);
    out.push({ id: l.id, scale, dx, dy });
  }
  return out;
}

/** Pairs each source layer with its copy: the same name first (Photoshop keeps names across
 *  documents), then the remaining copies in order. Returns [sourceId, copyId] pairs. */
export function pairCopies(
  sources: readonly { id: number; name: string }[], copies: readonly { id: number; name: string }[],
): [number, number][] {
  const free = [...copies];
  const pairs: [number, number][] = [];
  const pending: { id: number; name: string }[] = [];
  for (const s of sources) {
    const i = free.findIndex(c => c.name === s.name);
    if (i >= 0) pairs.push([s.id, free.splice(i, 1)[0].id]);
    else pending.push(s);
  }
  for (const s of pending) { const c = free.shift(); if (c) pairs.push([s.id, c.id]); }
  return pairs;
}
