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
  eye: "M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10zM10 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z",
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
  return svg;
}

export function replace(el: Element, ...children: (Child | Child[])[]) {
  el.textContent = "";
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
}
