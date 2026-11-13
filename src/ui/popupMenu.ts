// Small popup menus inside a panel (UXP has no context menus for plugin content): the 图层 panel's
// right-click menu and the toolbar's fx / adjustment menus. Positioned in the host's own
// coordinates (offsetTop), never from the mouse, and kept inside the host.

import { h, isShown, listen, replace, setShown } from "./dom.ts";

/** a colour square: `color` null is "no colour" (crossed out); `on` marks the current one */
export type Swatch = { color: string | null; title: string; on?: boolean; run: () => void };
export type PopItem =
  | { label: string; hint?: string; enabled?: boolean; run: () => void }
  | { swatches: Swatch[] }
  | { heading: string }
  | "-";

export function createPopup(host: HTMLElement) {
  const el = h("div", { class: "pm" });
  setShown(el, false);
  host.append(el);
  let opener: HTMLElement | null = null, closedAt = 0, closedBy: HTMLElement | null = null;

  function close() {
    if (!isShown(el)) return;
    setShown(el, false);
    closedAt = Date.now(); closedBy = opener; opener = null;
  }

  /** Opens below y (px relative to host top), or ending at y when upward. */
  function open(items: PopItem[], y: number, opts: { upward?: boolean; left?: number; from?: HTMLElement } = {}) {
    if (opts.from && closedBy === opts.from && Date.now() - closedAt < 300) return;
    const renderOrdinary = (it: PopItem): HTMLElement => {
      if (it === "-") return h("div", { class: "pm-sep" });
      if ("heading" in it) return h("div", { class: "pm-group-heading" }, it.heading);
      if ("swatches" in it) return h("div", { class: "pm-swatches" }, ...it.swatches.map(sw => {
        const cell = h("div", { class: "pm-swatch" + (sw.color ? "" : " none") + (sw.on ? " on" : ""), title: sw.title });
        if (sw.color) cell.style.backgroundColor = sw.color;
        cell.addEventListener("click", () => { close(); sw.run(); });
        return cell;
      }));
      const row = h("div", { class: "pm-item" + (it.enabled === false ? " off" : "") },
        h("span", { class: "pm-label" }, it.label),
        it.hint ? h("span", { class: "pm-hint" }, it.hint) : null);
      if (it.enabled !== false) row.addEventListener("click", () => { close(); it.run(); });
      return row;
    };

    replace(el, ...items.map(renderOrdinary));
    el.style.maxHeight = Math.max(80, host.clientHeight - 8) + "px";
    el.style.maxWidth = Math.max(120, host.clientWidth - 8) + "px";
    el.style.left = Math.max(4, Math.min(opts.left ?? 30, host.clientWidth - 170 - 4)) + "px";
    setShown(el, true);
    opener = opts.from ?? null;
    const hgt = el.offsetHeight;
    const top = opts.upward ? y - hgt : y;
    el.style.top = Math.max(4, Math.min(top, host.clientHeight - hgt - 4)) + "px";
  }

  listen(document, "mousedown", e => { if (isShown(el) && !el.contains(e.target as Node)) close(); });
  listen(document, "keydown", e => { if ((e as KeyboardEvent).key === "Escape") close(); });
  return { open, close, isOpen: () => isShown(el) };
}
