// Small popup menus inside a panel (UXP has no context menus for plugin content): the 图层 panel's
// right-click menu and the toolbar's fx / adjustment menus. Positioned in the host's own
// coordinates (offsetTop), never from the mouse, and kept inside the host.

import { h, icon, isShown, listen, replace, setShown } from "./dom.ts";

/** a colour square: `color` null is "no colour" (crossed out); `on` marks the current one */
export type Swatch = { color: string | null; title: string; on?: boolean; run: () => void };
/** One icon in a context-sensitive command grid, with a hover name and an optional explanation. */
export type PopQuickItem = { label: string; icon: string; hint: string; enabled?: boolean; disabledReason?: string; run: () => void };
export type PopStatChip = {
  label: string; value: string; tone: "edit" | "content" | "shared" | "own" | "link" | "mask";
  hint: string; enabled: boolean;
  disabledReason?: string; run?: () => void; runDouble?: () => void;
};
export type PopItem =
  | { label: string; hint?: string; enabled?: boolean; run: () => void }
  | { swatches: Swatch[] }
  | { sidebar: { title: string; type: PopStatChip; shared: PopStatChip; icons: PopQuickItem[] } }
  | { heading: string }
  | "-";

/** UXP can deliver a double-click as click+click, click+dblclick, or click+click+dblclick.
 * Handle all three. Never select all shared layers before breaking this ONE object's link,
 * and never run the destructive action twice if the host sends the extra dblclick event. */
export function clickPair(single: () => void, double: () => void, delayMs = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const cancelTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const triggerDouble = () => {
    if (done) return;
    done = true;
    cancelTimer();
    double();
  };
  return {
    press() {
      if (done) return;
      if (timer !== null) triggerDouble();
      else timer = setTimeout(() => {
        timer = null;
        if (done) return;
        done = true;
        single();
      }, delayMs);
    },
    doublePress: triggerDouble,
    cancel() { cancelTimer(); done = true; },
  };
}

export function createPopup(host: HTMLElement) {
  const el = h("div", { class: "pm" });
  setShown(el, false);
  host.append(el);
  let opener: HTMLElement | null = null, closedAt = 0, closedBy: HTMLElement | null = null;

  function close() {
    cancelClick();
    if (!isShown(el)) return;
    setShown(el, false);
    closedAt = Date.now(); closedBy = opener; opener = null;
  }

  let pendingClick: { cancel(): void } | null = null;
  const cancelClick = () => { pendingClick?.cancel(); pendingClick = null; };

  /** Opens below y (px relative to host top), or ending at y when upward. A smart-object
   * menu has TWO independent columns: the left status/shortcuts rail and the original
   * text menu on the right. Other popup users retain their original vertical layout. */
  function open(items: PopItem[], y: number, opts: { upward?: boolean; left?: number; from?: HTMLElement } = {}) {
    if (opts.from && closedBy === opts.from && Date.now() - closedAt < 300) return;
    cancelClick();
    const aside = items.find((it): it is Extract<PopItem, { sidebar: object }> => it !== "-" && "sidebar" in it);

    const renderOrdinary = (it: PopItem): HTMLElement | null => {
      if (it === "-") return h("div", { class: "pm-sep" });
      if ("heading" in it) return h("div", { class: "pm-group-heading" }, it.heading);
      if ("sidebar" in it) return null;
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

    const makeSidebar = (data: NonNullable<typeof aside>["sidebar"]): HTMLElement => {
      const stat = (chip: PopStatChip, paired = false) => {
        const usable = chip.enabled && !!chip.run;
        const tip = chip.label + "：" + chip.value + "\n" + (
          usable ? chip.hint : "不可用：" + (chip.disabledReason ?? chip.hint));
        const cell = h("div", {
          class: "pm-stat lt-tag " + chip.tone + (usable ? " can" : " off"),
          title: tip, role: "button",
          tabIndex: usable ? 0 : -1, "aria-label": chip.label + " " + chip.value,
          "aria-disabled": usable ? "false" : "true",
        }, chip.value);
        if (usable) {
          if (paired && chip.runDouble) {
            const control = clickPair(
              () => { close(); chip.run?.(); },
              () => { close(); chip.runDouble?.(); },
            );
            pendingClick = control;
            // Photoshop UXP has native dblclick dispatch, which does not necessarily
            // deliver two separate click events on all builds.
            cell.addEventListener("mousedown", e => e.stopPropagation());
            cell.addEventListener("click", e => { e.stopPropagation(); control.press(); });
            cell.addEventListener("dblclick", e => {
              e.preventDefault(); e.stopPropagation();
              control.doublePress();
            });
            cell.addEventListener("keydown", e => {
              const key = (e as KeyboardEvent).key;
              if (key === "Enter") { e.preventDefault(); close(); chip.run?.(); }
              if (key === " " || key === "Spacebar") { e.preventDefault(); close(); chip.runDouble?.(); }
            });
          } else {
            cell.addEventListener("click", () => { close(); chip.run?.(); });
            cell.addEventListener("keydown", e => {
              if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
                e.preventDefault(); close(); chip.run?.();
              }
            });
          }
        }
        return cell;
      };
      const icons = data.icons.map(it => {
        const usable = it.enabled !== false;
        const title = it.label + "\n" + (usable ? it.hint : "不可用：" + (it.disabledReason ?? it.hint));
        const cell = h("div", {
          class: "pm-quick" + (usable ? "" : " off"),
          title, role: "button", tabIndex: usable ? 0 : -1,
          "aria-label": it.label, "aria-disabled": usable ? "false" : "true",
        }, icon(it.icon, 19));
        if (usable) {
          cell.addEventListener("click", () => { close(); it.run(); });
          cell.addEventListener("keydown", e => {
            if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
              e.preventDefault(); close(); it.run();
            }
          });
        }
        return cell;
      });
      return h("div", { class: "pm-sidebar" },
        h("div", { class: "pm-stat-row" }, stat(data.type), stat(data.shared, true)),
        h("div", { class: "pm-quick-grid" }, ...icons));
    };

    const main = items.filter(it => it !== aside).map(renderOrdinary).filter((x): x is HTMLElement => !!x);
    el.className = "pm" + (aside ? " pm-with-quick" : "");
    if (aside) {
      const mainList = h("div", { class: "pm-main-menu" }, ...main);
      mainList.style.maxHeight = Math.max(90, host.clientHeight - 12) + "px";
      replace(el, h("div", { class: "pm-split" }, makeSidebar(aside.sidebar), mainList));
    } else replace(el, ...main);

    const available = Math.max(120, host.clientWidth - 8);
    const width = aside ? Math.min(292, available) : 0;
    if (aside) {
      // Keep the two-column form even when WaveLayer is docked very narrowly.
      const rail = el.querySelector(".pm-sidebar") as HTMLElement | null;
      if (rail) {
        const railWidth = Math.min(44, Math.max(40, Math.round(width * 0.16)));
        rail.style.width = railWidth + "px";
        rail.style.flexBasis = railWidth + "px";
      }
    }
    el.style.width = aside ? width + "px" : "";
    el.style.maxHeight = Math.max(80, host.clientHeight - 8) + "px";
    el.style.maxWidth = available + "px";
    const wantedLeft = opts.left ?? 30;
    el.style.left = Math.max(4, Math.min(wantedLeft, host.clientWidth - (aside ? width : 170) - 4)) + "px";
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
