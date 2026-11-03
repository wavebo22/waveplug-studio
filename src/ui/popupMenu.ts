// Small popup menus inside a panel (UXP has no context menus for plugin content): the 图层 panel's
// right-click menu and the toolbar's fx / adjustment menus. Positioned in the host's own
// coordinates (offsetTop), never from the mouse, and kept inside the host.

import { h, isShown, listen, replace, setShown } from "./dom.ts";

/** a colour square: `color` null is "no colour" (crossed out); `on` marks the current one */
export type Swatch = { color: string | null; title: string; on?: boolean; run: () => void };
export type PopItem = { label: string; hint?: string; enabled?: boolean; run: () => void } | { swatches: Swatch[] } | "-";

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

  /** Opens below `y` (px from the host's top), or ending at `y` when `upward`; `from` toggles it. */
  function open(items: PopItem[], y: number, opts: { upward?: boolean; left?: number; from?: HTMLElement } = {}) {
    // a click on the button that just closed the menu only closes it
    if (opts.from && closedBy === opts.from && Date.now() - closedAt < 300) return;
    replace(el, ...items.map(it => {
      if (it === "-") return h("div", { class: "pm-sep" });
      if ("swatches" in it) return h("div", { class: "pm-swatches" }, ...it.swatches.map(sw => {
        const el = h("div", { class: "pm-swatch" + (sw.color ? "" : " none") + (sw.on ? " on" : ""), title: sw.title });
        if (sw.color) el.style.backgroundColor = sw.color;
        el.addEventListener("click", () => { close(); sw.run(); });
        return el;
      }));
      const row = h("div", { class: "pm-item" + (it.enabled === false ? " off" : "") }, h("span", { class: "pm-label" }, it.label), it.hint ? h("span", { class: "pm-hint" }, it.hint) : null);
      if (it.enabled !== false) row.addEventListener("click", () => { close(); it.run(); });
      return row;
    }));
    el.style.maxHeight = Math.max(80, host.clientHeight - 8) + "px";
    el.style.maxWidth = Math.max(160, host.clientWidth - (opts.left ?? 30) - 4) + "px";
    el.style.left = (opts.left ?? 30) + "px";
    setShown(el, true);
    opener = opts.from ?? null;
    const hgt = el.offsetHeight;
    let top = opts.upward ? y - hgt : y;
    top = Math.max(4, Math.min(top, host.clientHeight - hgt - 4));
    el.style.top = top + "px";
  }

  listen(document, "mousedown", e => { if (isShown(el) && !el.contains(e.target as Node)) close(); });
  listen(document, "keydown", e => { if ((e as KeyboardEvent).key === "Escape") close(); });
  return { open, close, isOpen: () => isShown(el) };
}
