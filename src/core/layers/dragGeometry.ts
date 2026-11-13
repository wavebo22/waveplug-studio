/** WaveLayer drag hit-testing by geometry, not by event.target.
 *
 *  Evidence (uxp_runtime.log, 11-11): during a drag UXP keeps delivering mouse events to the pressed
 *  row (or the list itself), so the transparent hit layer was the target in only a few releases and
 *  the old code fell back to "pressed row's centre + pointer travel" — up to half a row off. The
 *  same log shows clientY - (list-local offsetY) is a constant (≈134) across a whole drag, i.e. client
 *  coordinates are stable; only their origin is unknown. So: learn that origin from events whose
 *  target offset we can measure (layout offsets, which UXP reports correctly), then place every
 *  pointer position in panel space and resolve the region from layout rectangles. */

export interface DragRect { left: number; top: number; width: number; height: number }

export const rectContains = (r: DragRect | null, x: number, y: number): boolean =>
  !!r && r.width > 0 && r.height > 0 && x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;

/** client → panel offset, estimated from the median of recent samples so one bogus event
 *  (UXP sometimes reports offsetY 0 for a re-entry) cannot move the drop point. */
export interface ClientCalibration { xs: number[]; ys: number[]; limit: number }

export function createClientCalibration(limit = 9): ClientCalibration {
  return { xs: [], ys: [], limit };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One sample: where the pointer is in client space and in panel space. Each axis is learned on its
 *  own (a NaN panel coordinate skips that axis), so a host without offsetX still calibrates Y. */
export function addCalibrationSample(cal: ClientCalibration, clientX: number, clientY: number, panelX: number, panelY: number): boolean {
  const dx = clientX - panelX, dy = clientY - panelY;
  const push = (v: number[], n: number) => { v.push(n); if (v.length > cal.limit) v.shift(); };
  if (Number.isFinite(dx)) push(cal.xs, dx);
  if (Number.isFinite(dy)) push(cal.ys, dy);
  return Number.isFinite(dx) || Number.isFinite(dy);
}

/** Null until Y has a sample; X defaults to 0 (UXP's clientX origin is the panel's left edge). */
export function calibrationOffset(cal: ClientCalibration): { dx: number; dy: number } | null {
  return cal.ys.length ? { dx: cal.xs.length ? median(cal.xs) : 0, dy: median(cal.ys) } : null;
}

/** A pointer offset along one axis of a target of known size is trustworthy only if it lands inside
 *  that box (1px slack for borders). */
export function plausibleAxisOffset(offset: number, size: number): boolean {
  return Number.isFinite(offset) && offset >= -1 && offset <= size + 1;
}

/** Exact 0/0 is what UXP reports for synthetic re-entry events (uxp_runtime.log 11-12 00:07). */
export function syntheticOffset(offsetX: number, offsetY: number): boolean {
  return offsetY === 0 && (offsetX === 0 || !Number.isFinite(offsetX));
}

export type DragHitRegion = "list" | "delete" | "tool" | "workbench" | "panel" | "outside";

export interface DragLayout {
  /** the whole WaveLayer section, origin of panel space */
  panel: DragRect;
  /** the visible rows (list-local Y = panel Y - rows.top) */
  rows: DragRect;
  deleteRail: DragRect | null;
  tools: (DragRect | null)[];
  workbench: DragRect | null;
  /** forgiving band above and below the rows that still counts as the list */
  buffer: number;
}

/** Priority: delete rail, toolbar buttons, workbench, rows (plus the buffer band, full panel width),
 *  anything else in the panel, then outside (the external reference panel's territory). */
export function resolveDragRegion(layout: DragLayout, x: number, y: number): { region: DragHitRegion; tool: number } {
  if (!rectContains(layout.panel, x, y)) return { region: "outside", tool: -1 };
  if (rectContains(layout.deleteRail, x, y)) return { region: "delete", tool: -1 };
  const tool = layout.tools.findIndex(r => rectContains(r, x, y));
  if (tool >= 0) return { region: "tool", tool };
  if (rectContains(layout.workbench, x, y)) return { region: "workbench", tool: -1 };
  const r = layout.rows;
  if (y >= r.top - layout.buffer && y < r.top + r.height + layout.buffer) return { region: "list", tool: -1 };
  return { region: "panel", tool: -1 };
}

/** The list-local Y used for the drop target: the top buffer means "above the first visible row",
 *  the bottom buffer "after the last visible row" (`visibleBottom`, list-local). */
export function clampDropListY(listY: number, visibleBottom: number): number {
  if (!Number.isFinite(listY)) return 0;
  return Math.max(0, Math.min(listY, Math.max(0, visibleBottom)));
}

/**
 * Auto-scroll while a drag is near the list's top or bottom: rows per second (negative: up), 0
 * away from the edges. The zone starts `edge` px inside each edge and the speed rises from `min`
 * there to `max` at `edge` px past the edge (the drag region keeps "list" 50 px beyond the rows,
 * so the pointer can go past the edge to scroll faster). A short list gets a thinner zone.
 */
export function edgeScrollRate(listY: number, room: number, edge = 36, min = 4, max = 30): number {
  if (!Number.isFinite(listY) || !(room > 0)) return 0;
  const e = Math.min(edge, room / 3);
  const depth = listY < e ? e - listY : listY > room - e ? listY - (room - e) : 0;
  if (depth <= 0) return 0;
  const rate = min + (max - min) * Math.min(1, depth / (2 * e));
  return listY < e ? -rate : rate;
}
