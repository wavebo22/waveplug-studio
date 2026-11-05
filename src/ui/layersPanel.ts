// WavePlug 图层: the layer list as a panel of its own, which docks and groups with Photoshop's
// panels like the Layers panel does. Refreshes only while it is shown.

import type { Services } from "../app/services.ts";
import { createLayerTreeView } from "./layerTree.ts";
import { h, replace } from "./dom.ts";
import { attachTooltips } from "./tooltip.ts";

export function mountLayersPanel(root: HTMLElement, svc: Services, isShown: () => boolean) {
  const statusEl = h("div", { class: "lp-status small" });
  let clear: ReturnType<typeof setTimeout> | null = null;
  const status = (text: string, kind: "info" | "ok" | "error" | "busy" = "info") => {
    replace(statusEl, text);
    statusEl.className = "lp-status small " + kind;
    if (clear) clearTimeout(clear);
    // A large artboard delete may keep Photoshop modal for tens of seconds. Do not clear the
    // pending message after 3s while Photoshop is still working.
    clear = kind === "busy" ? null : setTimeout(() => replace(statusEl), kind === "error" ? 8000 : 3000);
  };
  const view = createLayerTreeView(svc.layers, status, svc.tools, svc.overlay, svc.host.canvasView ? id => svc.host.canvasView!(id) : undefined);
  const panel = h("div", { class: "lp" }, view.el, statusEl);
  replace(root, panel);
  attachTooltips(panel);
  svc.layers.onChange(() => { if (isShown()) void view.refresh(); });
  return { show: () => void view.refresh() };
}
