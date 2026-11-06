export interface LayerClickPoint {
  id: number;
  zone: string | null;
  at: number;
  x: number;
  y: number;
}

export interface LayerDoubleAction {
  id: number;
  zone: string;
  at: number;
}

/** Native dblclick events can duplicate custom detection on icons, but not on layer names. */
export function isDuplicateLayerDoubleAction(
  previous: LayerDoubleAction | null,
  current: LayerDoubleAction,
  dedupeMs = 180,
): boolean {
  if (!previous || current.zone === "name") return false;
  const elapsed = current.at - previous.at;
  return previous.id === current.id && previous.zone === current.zone
    && elapsed >= 0 && elapsed < dedupeMs;
}

/** A deliberate double-click: same target, short interval, and almost no pointer travel. */
export function isLayerDoubleClick(
  previous: LayerClickPoint | null,
  current: LayerClickPoint,
  maxDelayMs = 400,
  maxDistancePx = 4,
): boolean {
  if (!previous || previous.id !== current.id || previous.zone === null || previous.zone !== current.zone) return false;
  const elapsed = current.at - previous.at;
  return elapsed >= 0 && elapsed <= maxDelayMs
    && Math.abs(current.x - previous.x) <= maxDistancePx
    && Math.abs(current.y - previous.y) <= maxDistancePx;
}
