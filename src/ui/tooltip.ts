// Hover tooltips inside a panel: UXP doesn't show `title` attributes. Resting the pointer on an
// element with a title for a moment shows its text in a box below (or above) it. The box is placed
// from the element's layout position (offsetTop / offsetLeft and the scroll of its containers),
// never from mouse coordinates, which don't match the layout in UXP.

import { h, replace, setShown } from "./dom.ts";

const DELAY = 600;

/** The nearest element (from `n` up to `root`) with a tooltip; its `title` moves to `data-tip` so a
 *  browser doesn't show its own tooltip as well. */
function titled(n: Node | null, root: HTMLElement): HTMLElement | null {
  for (; n && n !== root; n = n.parentNode) {
    const el = n as HTMLElement;
    if (!el.getAttribute) continue;
    const t = el.getAttribute("title");
    if (t) { el.setAttribute("data-tip", t); el.removeAttribute("title"); }
    if (el.getAttribute("data-tip")) return el;
  }
  return null;
}

/** `el`'s top-left in `root`'s coordinates (root must be positioned), scrolled containers included. */
function placeIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0, y = 0;
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
  for (let p = el.parentNode as HTMLElement | null; p && p !== root; p = p.parentNode as HTMLElement | null) { x -= p.scrollLeft || 0; y -= p.scrollTop || 0; }
  return { x, y };
}

export function attachTooltips(root: HTMLElement) {
  const tip = h("div", { class: "tip" });
  setShown(tip, false);
  root.append(tip);
  let timer: ReturnType<typeof setTimeout> | null = null, current: HTMLElement | null = null;
  const hide = () => { if (timer) clearTimeout(timer); timer = null; setShown(tip, false); };

  function show(el: HTMLElement) {
    if (el.isConnected === false) return;
    replace(tip, ...String(el.getAttribute("data-tip")).split("\n").map(line => h("div", null, line)));
    tip.style.maxWidth = Math.max(140, root.clientWidth - 12) + "px";
    setShown(tip, true);
    const at = placeIn(el, root), w = tip.offsetWidth, hgt = tip.offsetHeight;
    const below = at.y + el.offsetHeight + 4;
    tip.style.top = (below + hgt <= root.clientHeight - 4 ? below : Math.max(4, at.y - hgt - 4)) + "px";
    tip.style.left = Math.max(4, Math.min(at.x, root.clientWidth - w - 4)) + "px";
  }

  root.addEventListener("mouseover", e => {
    const el = titled(e.target as Node, root);
    if (el === current) return;
    current = el;
    hide();
    if (el) timer = setTimeout(() => show(el), DELAY);
  });
  root.addEventListener("mouseleave", () => { current = null; hide(); });
  root.addEventListener("mousedown", () => { current = null; hide(); }, true);
  root.addEventListener("wheel", hide, true);
}
