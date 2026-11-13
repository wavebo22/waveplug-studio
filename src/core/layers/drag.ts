/** WaveLayer drag lifecycle. The UI owns Photoshop-specific targets; this module owns the
 *  single authoritative pointer/phase snapshot shared by move, pointerup and mouseup handlers. */
export type LayerDragPhase = "armed" | "dragging" | "released" | "cancelled";
export type LayerDragRegion = "list" | "delete" | "tool" | "workbench" | "panel" | "outside";
export type LayerDragReleaseRoute = "click" | "outside" | "workbench" | "internal" | "external";

export interface LayerDragLifecycle {
  phase: LayerDragPhase;
  region: LayerDragRegion;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  listY: number;
  alt: boolean;
}

export interface LayerDragPointer {
  x: number;
  y: number;
  listY: number;
  alt: boolean;
  region: LayerDragRegion;
}

export interface LayerDragReleaseSnapshot extends LayerDragPointer {
  active: boolean;
}

/** Create a drag session on mousedown. It remains armed until the movement threshold is crossed. */
export function createLayerDragLifecycle(input: {
  x: number; y: number; listY: number; alt: boolean;
}): LayerDragLifecycle {
  return {
    phase: "armed", region: "list",
    startX: input.x, startY: input.y,
    pointerX: input.x, pointerY: input.y,
    listY: input.listY, alt: input.alt,
  };
}

/** Activate once the pointer has moved far enough; repeated calls are harmless. */
export function activateLayerDragLifecycle(
  state: LayerDragLifecycle, x: number, y: number, threshold = 5,
): boolean {
  if (state.phase === "dragging") return true;
  if (state.phase !== "armed") return false;
  if (Math.abs(x - state.startX) < threshold && Math.abs(y - state.startY) < threshold) return false;
  state.phase = "dragging";
  state.pointerX = x;
  state.pointerY = y;
  return true;
}

/** Update the latest pointer snapshot while a drag is active. */
export function updateLayerDragLifecycle(state: LayerDragLifecycle, pointer: LayerDragPointer): boolean {
  if (state.phase !== "dragging") return false;
  state.pointerX = pointer.x;
  state.pointerY = pointer.y;
  state.listY = pointer.listY;
  state.alt = pointer.alt;
  state.region = pointer.region;
  return true;
}

/** Finish exactly once. A second pointerup/mouseup callback receives null and cannot double-submit. */
export function releaseLayerDragLifecycle(
  state: LayerDragLifecycle, pointer: LayerDragPointer,
): LayerDragReleaseSnapshot | null {
  if (state.phase === "released" || state.phase === "cancelled") return null;
  const active = state.phase === "dragging";
  state.pointerX = pointer.x;
  state.pointerY = pointer.y;
  state.listY = pointer.listY;
  state.alt = pointer.alt;
  state.region = pointer.region;
  state.phase = "released";
  return { active, x: state.pointerX, y: state.pointerY, listY: state.listY, alt: state.alt, region: state.region };
}

/** Escape, helper disconnect, or panel teardown. */
export function cancelLayerDragLifecycle(state: LayerDragLifecycle): boolean {
  if (state.phase === "released" || state.phase === "cancelled") return false;
  state.phase = "cancelled";
  return true;
}

/** Route by the region dragGeometry resolved for the release point. */
export function routeLayerDragRelease(input: {
  active: boolean;
  referenceDragStarted: boolean;
  region: LayerDragRegion;
}): LayerDragReleaseRoute {
  if (!input.active) return "click";
  if (input.region === "outside") return input.referenceDragStarted ? "external" : "outside";
  if (input.region === "workbench") return "workbench";
  return "internal";
}
