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
  // UXP can retain a dark native fill on text-entry controls even when the stylesheet
  // background rule is changed. Set the transparent surface inline after all attributes
  // so every text/number/search field, including dynamically-created editors, inherits
  // the panel row/surface beneath it. Keep checkbox and range controls native.
  if (tag === "textarea" || (tag === "input" && !["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image", "hidden"].includes(String(attrs?.type ?? "text").toLowerCase()))) {
    (el as HTMLElement).style.backgroundColor = "transparent";
    (el as HTMLElement).style.backgroundImage = "none";
    (el as HTMLElement).style.boxShadow = "none";
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
  chevronRight: "M7 4l6 6-6 6",
  chevronUp: "M6 12l4-4 4 4",
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
  menu: "M4 6h12M4 10h12M4 14h12",
  paste: "M7 3h6v3H7zM5 5H4v12h12V5h-1M7 10h6M7 13h4",
  wbPlace: "M3 4h14v4M3 13v4h14v-4M10 2v11M7 10l3 3 3-3",
  wbExport: "M3 10v7h14v-7M10 15V3M6 7l4-4 4 4",
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
  // the 图层 panel's Photoshop-style icons are solid glyphs in PS_GLYPHS below
  // Lucide v0.456-inspired clean line icons, matched to the conversation's preview:
  // refresh-cw / download / layers / rotate-ccw; the four use a 24x24 viewBox below.
  soReplace: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
  soExport: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  soUnpack: "M12 2 2 7l10 5 10-5-10-5M2 17l10 5 10-5M2 12l10 5 10-5",
  soReset: "M3 11a9 9 0 1 1 9 9 9.75 9.75 0 0 1-6.74-2.74L3 15M3 20v-5h5",
  // Photoshop's layer-filter switch: an upright pill, knob up = on, knob down = off
  psToggleOn: "M10 2a3.5 3.5 0 0 1 3.5 3.5v9a3.5 3.5 0 0 1-7 0v-9A3.5 3.5 0 0 1 10 2z",
  psToggleOff: "M10 2a3.5 3.5 0 0 1 3.5 3.5v9a3.5 3.5 0 0 1-7 0v-9A3.5 3.5 0 0 1 10 2z",
};

/** solid parts drawn over an icon's outline (pupil, lock body …) */
const FILLS: Record<string, string> = {
  psToggleOn: "M10 4.3a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z",
  psToggleOff: "M10 11.3a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z",
};

/** The 图层 panel's Photoshop-style icons, drawn as solid glyphs the way Photoshop's own Layers panel
 *  draws them (11-04, matched against a screenshot of the real panel): 20×20, one even-odd filled path,
 *  inner shapes cut holes. All one colour — the panel's CSS keeps colour for warnings and shared groups. */
const PS_GLYPHS: Record<string, string> = {
  psEye: "M10 4C5.5 4 2.2 7.2 1 10c1.2 2.8 4.5 6 9 6s7.8-3.2 9-6c-1.2-2.8-4.5-6-9-6zM10 5.6c-3.4 0-6 2.3-7.2 4.4 1.2 2.1 3.8 4.4 7.2 4.4s6-2.3 7.2-4.4C16 7.9 13.4 5.6 10 5.6zM10 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6z", // 显示 / 隐藏
  psLock: "M5 9h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM6.5 9V7a3.5 3.5 0 0 1 7 0v2H12V7a2 2 0 0 0-4 0v2z", // 锁定全部
  psChecker: "M3 3h14v14H3zM4.6 4.6v10.8h10.8V4.6zM4.6 4.6H10V10H4.6zM10 10h5.4v5.4H10z", // 锁定透明像素
  psBrush: "M16.8 3.2a1.1 1.1 0 0 0-1.6 0L9 9.4l1.6 1.6 6.2-6.2a1.1 1.1 0 0 0 0-1.6zM8.2 10.6c-1.8 0-3.1 1.3-3.1 3 0 1.1-.6 2-1.9 2.6 3.4 1 6.6.2 7.5-1.8.5-1.1.2-2.3-.6-3.1z", // 锁定图像像素
  psMove: "M9.2 5h1.6v4.2H15v1.6h-4.2V15H9.2v-4.2H5V9.2h4.2zM10 1.5l2.8 3.3H7.2zM10 18.5l-2.8-3.3h5.6zM1.5 10l3.3-2.8v5.6zM18.5 10l-3.3 2.8V7.2z", // 锁定位置
  psLink: "M8 6.5H5.5a3.5 3.5 0 0 0 0 7H8V12H5.5a2 2 0 0 1 0-4H8zM12 6.5h2.5a3.5 3.5 0 0 1 0 7H12V12h2.5a2 2 0 0 0 0-4H12zM6.5 9.25h7v1.5h-7z", // 链接图层（底栏，横向链条）
  psChainV: "M6.5 8V5.5a3.5 3.5 0 0 1 7 0V8H12V5.5a2 2 0 0 0-4 0V8zM6.5 12v2.5a3.5 3.5 0 0 0 7 0V12H12v2.5a2 2 0 0 1-4 0V12zM9.25 6.5h1.5v7h-1.5z", // 蒙版链接（行内，竖向链条）
  psMask: "M2.5 4h15v12h-15zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", // 图层蒙版
  psAdjust: "M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM10 4.4a5.6 5.6 0 1 0 0 11.2 5.6 5.6 0 0 0 0-11.2zM10 4.4a5.6 5.6 0 0 0 0 11.2z", // 调整图层
  psFill: "M3 3h14v14H3zM4.5 4.5v11h11v-11zM4.5 15.5L15.5 4.5v11z", // 填充图层
  psFolder: "M2 5a1 1 0 0 1 1-1h4.2l1.6 1.6H17a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM3.5 7.2v7.3h13V7.2z", // 图层组
  psFolderOpen: "M2 5a1 1 0 0 1 1-1h4.2l1.6 1.6H16a1 1 0 0 1 1 1V8h-1.5V7.1H8.2L6.6 5.5H3.5v6.9L5.3 8.6A1 1 0 0 1 6.2 8h12.2a.6.6 0 0 1 .55.85l-3.1 6.5a1 1 0 0 1-.9.65H3a1 1 0 0 1-1-1zM6.6 9.5l-2.4 5h10.9l2.4-5z", // 图层组（展开）
  psNew: "M3 3h14v14H3zM4.5 4.5v11h11v-11zM9.25 6.5h1.5v2.75h2.75v1.5h-2.75v2.75h-1.5v-2.75H6.5v-1.5h2.75z", // 新建图层
  psTrash: "M3.5 5h13v1.5h-13zM7.5 3.2h5V5h-1.5v-.3h-2V5H7.5zM5 7.5h10l-.8 8.7a1 1 0 0 1-1 .8H6.8a1 1 0 0 1-1-.8zM8 9.5h1.2v5.5H8zM10.8 9.5H12v5.5h-1.2z", // 删除
  psImage: "M3 3h14v14H3zM4.5 4.5v11h11v-11zM4.5 15.5l4-5 3 3.5 2-2.2 2 2.5v1.2zM13 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z", // 像素图层
  psText: "M4 3.5h12v3h-1.5V5h-3.75v10.5h1.75V17h-5v-1.5h1.75V5H5.5v1.5H4z", // 文字图层
  psShape: "M7 5.4h6v1.2H7zM7 13.4h6v1.2H7zM5.4 7h1.2v6H5.4zM13.4 7h1.2v6h-1.2zM3 3h4v4H3zM13 3h4v4h-4zM3 13h4v4H3zM13 13h4v4h-4z", // 形状图层
  psSmart: "M4 2h8l4 4v12H4zM5.5 3.5v13h9V7h-3.5V3.5zM9.5 10.5h5v5h-5z", // 智能对象
  psFilters: "M2.5 3.5h15l-5.75 6.75V16l-3.5-1.75v-4z", // 智能滤镜
  psClip: "M15 4v1.6H8.4a.6.6 0 0 0-.6.6v6.6h2.4L7 17l-3.2-4.2h2.4V6.2A2.2 2.2 0 0 1 8.4 4z", // 剪贴蒙版（向下箭头）
  psShared: "M7 3h10v10h-3.5v-1.5h2v-7h-7v2H7zM3 7h10v10H3zM4.5 8.5v7h7v-7z", // 共用内容
  psSingle: "M3 3h14v14H3zM4.5 4.5v11h11v-11zM7.5 7.5h5v5h-5z", // 独立内容
  psExternal: "M9 4H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h10a1.5 1.5 0 0 0 1.5-1.5V11h-1.5v4.5h-10v-10H9zM11.5 3H17v5.5h-1.5V5.6l-5.4 5.4-1.1-1.1 5.4-5.4h-2.9z", // 外部链接
  psVector: "M10 2.5l5 7.5-2.5 6.5h-5L5 10zM9.4 6v4.3a1.2 1.2 0 1 0 1.2 0V6z", // 矢量蒙版
  psUneditable: "M3 3h14v14H3zM4.5 4.5v11h11v-11zM4.5 14.4L14.4 4.5h1.1v1.1L5.6 15.5H4.5z", // 不可编辑
  psEditable: "M3 3h14v14H3zM4.5 4.5v11h11v-11zM7 13l.6-2.4 4.6-4.6 1.8 1.8-4.6 4.6z", // 可编辑
};

/** every icon name, for the component gallery (dist/preview/gallery.html) */
export const ICON_NAMES = [...Object.keys(PATHS), ...Object.keys(PS_GLYPHS)];

const SMART_LUCIDE = new Set(["soReplace", "soExport", "soUnpack", "soReset"]);

export function icon(name: keyof typeof PATHS | string, size = 14): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", SMART_LUCIDE.has(name) ? "0 0 24 24" : "0 0 20 20");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "icon");
  if (PS_GLYPHS[name]) {
    const g = document.createElementNS(ns, "path");
    g.setAttribute("d", PS_GLYPHS[name]);
    g.setAttribute("fill", "currentColor");
    g.setAttribute("fill-rule", "evenodd");
    svg.append(g);
    return svg;
  }
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PATHS[name] ?? "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", SMART_LUCIDE.has(name) ? "2" : "1.5");
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

// Listeners on document / window and repeating timers outlive the panel's own elements: they are
// registered here so the development loader's ⟳ can remove this build's before running the next.
const globals: (() => void)[] = [];

export function listen(target: Document | Window, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions) {
  target.addEventListener(type, fn, opts);
  globals.push(() => target.removeEventListener(type, fn, opts));
}

/** Runs `fn` when this build is disposed (sockets and other resources that aren't listeners or timers). */
export function onDispose(fn: () => void) {
  globals.push(fn);
}

export function every(fn: () => void, ms: number) {
  const t = setInterval(fn, ms);
  globals.push(() => clearInterval(t));
}

export function disposeGlobals() {
  for (const off of globals.splice(0)) { try { off(); } catch { /* host gone */ } }
}
