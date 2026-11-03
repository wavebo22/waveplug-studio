// Tiny DOM helpers — UXP has no framework requirement and a plain DOM keeps the bundle small.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  // UXP renders <button> as a native Spectrum widget that ignores most CSS (and hides inline SVG),
  // so buttons are divs with button semantics.
  const el = tag === "button" ? fakeButton() : tag === "label" ? fakeLabel() : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = (tag === "button" ? "ub " : "") + String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el as HTMLElementTagNameMap[K];
}

// UXP paints <label> text in its own dim grey regardless of CSS, so check rows are divs that
// forward a click on the text to their checkbox.
function fakeLabel(): HTMLElement {
  const el = document.createElement("div");
  el.addEventListener("click", e => {
    const box = el.querySelector("input[type=checkbox]") as HTMLInputElement | null;
    if (!box || box.disabled || e.target === box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  });
  return el;
}

function fakeButton(): HTMLElement {
  const el = document.createElement("div");
  el.className = "ub";
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  let disabled = false;
  Object.defineProperty(el, "disabled", {
    get: () => disabled,
    set: (v: boolean) => { disabled = !!v; el.classList.toggle("is-disabled", disabled); el.setAttribute("aria-disabled", String(disabled)); },
  });
  // swallow clicks while disabled, before any listener added later runs
  el.addEventListener("click", e => { if (disabled) { e.stopImmediatePropagation(); e.preventDefault(); } });
  el.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") { e.preventDefault(); el.click(); } });
  return el;
}

const PATHS: Record<string, string> = {
  sliders: "M3 5h6M13 5h4M3 10h2M9 10h8M3 15h8M15 15h2M11 3v4M7 8v4M13 13v4",
  plus: "M10 4v12M4 10h12",
  chevron: "M6 8l4 4 4-4",
  close: "M5 5l10 10M15 5L5 15",
  dice: "M4 4h12v12H4zM7.5 7.5h.01M12.5 12.5h.01M12.5 7.5h.01M7.5 12.5h.01",
  spark: "M10 3v4M10 13v4M3 10h4M13 10h4M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2",
  stop: "M6 6h8v8H6z",
  image: "M3 4h14v12H3zM3 13l4-4 3 3 2-2 5 5M13 7.5h.01",
  flow: "M4 5h5v4H4zM11 11h5v4h-5zM9 7h2a1 1 0 0 1 1 1v3",
  layers: "M10 3l7 4-7 4-7-4zM3 11l7 4 7-4",
  check: "M5 10l3 3 7-7",
  warn: "M10 4l7 12H3zM10 9v3M10 14h.01",
  folder: "M3 6h5l2 2h7v8H3z",
  refresh: "M16 10a6 6 0 1 1-1.8-4.3M16 4v3h-3",
  paste: "M7 3h6v3H7zM5 5H4v12h12V5h-1M7 10h6M7 13h4",
  link: "M8.5 11.5l3-3M7.5 9.5L6 11a2.5 2.5 0 0 0 3.5 3.5L11 13M12.5 10.5L14 9a2.5 2.5 0 0 0-3.5-3.5L9 7",
  mask: "M3 4h14v12H3zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  adjust: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 3v14M10 6l3.5-2M10 10h6.5M10 14l3.5 2",
  newLayer: "M4 4h12v12H4zM10 7v6M7 10h6",
  trash: "M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10",
  clip: "M6 3v6a2 2 0 0 0 2 2h7M12 8l3 3-3 3",
  text: "M5 5V4h10v1M10 4v12M8 16h4",
  shape: "M10 3l6 7-6 7-6-7zM10 3v14",
  fill: "M4 4h12v12H4zM4 4l12 12",
  smart: "M5 3h7l3 3v11H5zM12 3v3h3M8 10h4v4H8z",
  folderOpen: "M3 6h5l2 2h6v2M3 6v10h12l3-6H6l-3 6",
  move: "M10 3v14M3 10h14M8 5l2-2 2 2M8 15l2 2 2-2M5 8l-2 2 2 2M15 8l2 2-2 2",
  brush: "M14 3l3 3-7 7-3-3zM7 10l-2 2c-1 1-.5 3-2.5 4 2.5.5 4.5 0 5.5-1l2-2",
  copies: "M7 7h9v9H7zM4 13V4h9",
  single: "M5 5h10v10H5z",
  external: "M9 5H4v11h11v-5M12 3h5v5M17 3l-7 7",
  vector: "M6 15L10 6l4 9M4 14h4v3H4zM12 14h4v3h-4zM8 3h4v3H8z",
  filters: "M8 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
  checker: "M4 4h12v12H4zM4 4h4v4H4zM12 4h4v4h-4zM8 8h4v4H8zM4 12h4v4H4zM12 12h4v4h-4z",
  lock: "M6.5 9V7a3.5 3.5 0 0 1 7 0v2M5 9h10v8H5z",
  eye: "M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10zM10 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z",
  // the 图层 panel's set, drawn in the manner of Photoshop's Layers panel (outline + solid parts, FILLS):
  // eye, lock, chain, mask (frame + dot), half circle (adjustment / fill), folder, square + plus (new),
  // page + corner (smart object), square with anchors (shape), funnel (smart filters)
  psEye: "M2 10c2-3.6 4.8-5.5 8-5.5s6 1.9 8 5.5c-2 3.6-4.8 5.5-8 5.5S4 13.6 2 10z",
  psLock: "M7 9V6.8a3 3 0 0 1 6 0V9",
  psLink: "M8.6 11.4l2.8-2.8M9.2 6.6l1.4-1.4a2.8 2.8 0 0 1 4 4l-1.4 1.4M10.8 13.4l-1.4 1.4a2.8 2.8 0 0 1-4-4l1.4-1.4",
  psMask: "M3 4h14v12H3z",
  psAdjust: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z",
  psFolder: "M2.5 5.5h5l1.5 1.5h8.5v9h-15z",
  psFolderOpen: "M2.5 15.5v-10h5l1.5 1.5h6.5v2.5M2.5 15.5h12.5l2.5-6.5H5z",
  psTrash: "M4.5 6h11M8 6V4.5h4V6M6 6l.8 10h6.4l.8-10M8.5 8.5v5M11.5 8.5v5",
  psClip: "M6 4v6.5a1.5 1.5 0 0 0 1.5 1.5H15M12.5 9.5L15 12l-2.5 2.5",
  psText: "",
  psNew: "M4 4h12v12H4zM10 7v6M7 10h6",
  psSmart: "M3.5 3.5h13v13h-13z",
  psImage: "M3 4h14v12H3zM3 13.5l4-4 3 3 2-2 5 5",
  psShape: "M5 5h10v10H5z",
  psFill: "M4 4h12v12H4z",
  psMove: "M10 2.5v15M2.5 10h15M8 4.5l2-2 2 2M8 15.5l2 2 2-2M4.5 8l-2 2 2 2M15.5 8l2 2-2 2",
  psBrush: "M15.5 3l1.5 1.5-6.5 7-2-2zM8.2 10.8c-1.6-.4-3 .6-3.2 2.4-.1 1-.6 1.9-1.6 2.3 2.3.8 4.6.3 5.6-1.4.5-.9.3-2.2-.8-3.3z",
  psFilters: "M3 4h14l-5.5 6.5V16l-3-1.5v-4z",
  psShared: "M6.5 3.5h10v10h-10zM3.5 6.5v10h10",
  psUneditable: "M3.5 3.5h13v13h-13zM4 16L16 4",
  psSingle: "M4.5 4.5h11v11h-11z",
  psExternal: "M9 4H4v12h12v-5M12 3h5v5M17 3l-7 7",
  psVector: "M10 3.5L4 16.5M10 3.5l6 13M6.5 11.5h7",
  psEditable: "M3.5 3.5h13v13h-13zM7 13l1-3 5-5 2 2-5 5z",
};

/** solid parts drawn over an icon's outline (pupil, lock body …) */
const FILLS: Record<string, string> = {
  psEye: "M10 7.3a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4z",
  psLock: "M5 9h10v8H5z",
  psMask: "M10 6.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z",
  psAdjust: "M10 3.5a6.5 6.5 0 0 0 0 13z",
  psText: "M4.5 4h11v2.4h-4.3V16H8.8V6.4H4.5z",
  psSmart: "M10 10h6.5v6.5H10z",
  psImage: "M13.5 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  psShape: "M3.3 3.3h3.4v3.4H3.3zM13.3 3.3h3.4v3.4h-3.4zM3.3 13.3h3.4v3.4H3.3zM13.3 13.3h3.4v3.4h-3.4z",
  psFill: "M4 16L16 4v12z",
  psSingle: "M7.5 7.5h5v5h-5z",
  psVector: "M8.6 2.6h2.8v2.8H8.6z",
};

export function icon(name: keyof typeof PATHS | string, size = 14): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "icon");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PATHS[name] ?? "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.5");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  if (FILLS[name]) {
    const f = document.createElementNS(ns, "path");
    f.setAttribute("d", FILLS[name]);
    f.setAttribute("fill", "currentColor");
    svg.append(f);
  }
  return svg;
}

/** Shows or hides `el` by its display style and the presence of the `hidden` attribute (added /
 *  removed, never set to "false": in UXP an element once hidden through the property may not come
 *  back, which left list rows blank). */
export function setShown(el: HTMLElement, on: boolean) {
  if (on) el.removeAttribute("hidden"); else el.setAttribute("hidden", "");
  el.style.display = on ? "" : "none";
}

export const isShown = (el: HTMLElement) => el.style.display !== "none" && !el.hasAttribute("hidden");

export function replace(el: Element, ...children: (Child | Child[])[]) {
  el.textContent = "";
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
}
