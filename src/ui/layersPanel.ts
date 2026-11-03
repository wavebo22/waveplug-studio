// WavePlug 图层: the layer list as a panel of its own, which docks and groups with Photoshop's
// panels like the Layers panel does. Refreshes only while it is shown.

import type { Services } from "../app/services.ts";
import { createLayerTreeView } from "./layerTree.ts";
import { h, replace } from "./dom.ts";
import { attachTooltips } from "./tooltip.ts";

export function mountLayersPanel(root: HTMLElement, svc: Services, isShown: () => boolean) {
  const statusEl = h("div", { class: "lp-status small" });
  let clear: ReturnType<typeof setTimeout> | null = null;
  const status = (text: string, kind: "info" | "ok" | "error" = "info") => {
    replace(statusEl, text);
    statusEl.className = "lp-status small " + kind;
    if (clear) clearTimeout(clear);
    clear = setTimeout(() => replace(statusEl), kind === "error" ? 8000 : 3000);
  };
  const view = createLayerTreeView(svc.layers, status, svc.tools);
  const panel = h("div", { class: "lp" }, view.el, statusEl);
  replace(root, panel);
  attachTooltips(panel);
  svc.layers.onChange(() => { if (isShown()) void view.refresh(); });
  return { show: () => void view.refresh() };
}
