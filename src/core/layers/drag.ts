export type LayerDragReleaseRoute = "click" | "outside" | "workbench" | "internal" | "external";

/** Keep cross-window drops out of WaveLayer's ordinary reorder/copy path. */
export function routeLayerDragRelease(input: {
  active: boolean;
  referenceDragStarted: boolean;
  releasedInsidePanel: boolean;
  acceptedWorkbench: boolean;
}): LayerDragReleaseRoute {
  if (!input.active) return "click";
  if (!input.releasedInsidePanel) return input.referenceDragStarted ? "external" : "outside";
  if (input.acceptedWorkbench) return "workbench";
  return "internal";
}
