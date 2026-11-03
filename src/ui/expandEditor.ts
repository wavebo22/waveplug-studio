// Interactive outpaint canvas, modelled on 孤海「外补画板（可视化）」: drag an edge or corner to
// extend the canvas, hold Shift for symmetric extension, drag the picture to shift it inside the
// frame, pick an aspect ratio to keep the frame at that ratio. Plain DOM (UXP has no reliable
// <canvas>), mouse events only.
//
// Smoothness: while dragging, the view's scale and anchor are frozen so the grabbed edge follows
// the cursor 1:1 (the frame is re-centred only on release), mouse moves are coalesced to one draw
// per animation frame, and a draw only touches style values that actually changed.

import type { Pads } from "../ps/host.ts";
import { h, icon, listen } from "./dom.ts";

export const RATIOS = ["自由比例", "1:1", "2:3", "3:2", "3:4", "4:3", "5:7", "9:16", "16:9", "21:9", "1:2", "2:1"];
type Edge = "l" | "r" | "t" | "b";
const ZERO: Pads = { left: 0, right: 0, top: 0, bottom: 0 };
const GRIPS = ["l", "r", "t", "b", "tl", "tr", "bl", "br"] as const;
/** hit area thickness of the edge grips, px */
const HIT = 14;

/** Fits pads to `ratio` like the node does: grow the frame to the ratio, keep each side's share. */
export function fitRatio(p: Pads, w: number, h: number, ratio: string): Pads {
  const m = /^(\d+):(\d+)$/.exec(ratio);
  if (!m) return p;
  const rw = +m[1], rh = +m[2];
  const factor = Math.max((w + p.left + p.right) / rw, (h + p.top + p.bottom) / rh);
  const W = Math.round(rw * factor), H = Math.round(rh * factor);
  const split = (total: number, a: number, b: number): [number, number] => {
    const first = a + b ? Math.round(total * a / (a + b)) : Math.floor(total / 2);
    return [first, total - first];
  };
  const [left, right] = split(Math.max(0, W - w), p.left, p.right);
  const [top, bottom] = split(Math.max(0, H - h), p.top, p.bottom);
  return { left, right, top, bottom };
}

export interface ExpandEditor {
  el: HTMLElement;
  setImage(url: string | null, width: number, height: number): void;
  setPads(p: Pads): void;
  pads(): Pads;
}

const nextFrame: (f: () => void) => void =
  typeof requestAnimationFrame === "function" ? f => { requestAnimationFrame(f); } : f => { setTimeout(f, 16); };

/** Sets inline style values, skipping ones that did not change since the last call. */
function styler(el: HTMLElement) {
  const last: Record<string, string> = {};
  return (props: Record<string, string>) => {
    for (const [k, v] of Object.entries(props)) if (last[k] !== v) { last[k] = v; (el.style as any)[k] = v; }
  };
}

export function createExpandEditor(opts: { maxPad: number; onChange(p: Pads): void }): ExpandEditor {
  let W = 1, H = 1, url: string | null = null;
  let pads: Pads = { ...ZERO };
  let ratio = "自由比例";
  /** frozen view while dragging: scale plus the screen position of the image (edges) or frame (move) */
  type View = { scale: number; ax: number; ay: number };
  let drag: null | { kind: "edge"; edges: Edge[]; x0: number; y0: number; start: Pads; view: View }
    | { kind: "move"; x0: number; y0: number; start: Pads; view: View } = null;
  let last: { x: number; y: number; shift: boolean } | null = null, queued = false;

  const clamp = (v: number) => Math.max(0, Math.min(opts.maxPad, Math.round(v)));
  const clampAll = (p: Pads): Pads => ({ left: clamp(p.left), right: clamp(p.right), top: clamp(p.top), bottom: clamp(p.bottom) });
  const normalize = (p: Pads): Pads => ratio === "自由比例" ? clampAll(p) : clampAll(fitRatio(clampAll(p), W, H, ratio));

  const stage = h("div", { class: "xp-stage" });
  const frame = h("div", { class: "xp-frame" });
  const img = h("div", { class: "xp-img" });
  const pic = h("img", { class: "xp-pic", draggable: "false" }) as HTMLImageElement; // UXP: <img> is more reliable than background-image
  img.append(pic);
  // edge grips span the whole edge (easy to grab); corners are squares; each shows a small knob
  const grips = GRIPS.map(k => {
    const el = h("div", { class: `xp-g xp-g-${k}` }, h("div", { class: "xp-knob" }));
    el.addEventListener("mousedown", e => startDrag(e as MouseEvent, k.split("") as Edge[]));
    return { k, el, set: styler(el) };
  });
  stage.append(frame, img, ...grips.map(g => g.el));
  const setFrame = styler(frame), setImg = styler(img);
  img.addEventListener("mousedown", e => {
    const m = e as MouseEvent;
    const L = layout();
    drag = { kind: "move", x0: m.clientX, y0: m.clientY, start: { ...pads }, view: { scale: L.scale, ax: L.fx, ay: L.fy } };
    stage.classList.add("dragging");
    m.preventDefault();
  });

  const fields = (["left", "right", "top", "bottom"] as const).map(side => {
    const input = h("input", { class: "num xp-num", type: "number", min: "0", max: String(opts.maxPad), step: "1" }) as HTMLInputElement;
    input.addEventListener("change", () => set({ ...pads, [side]: Number(input.value) || 0 }));
    return { side, input, shown: "" };
  });
  const arrows = { left: "←", right: "→", top: "↑", bottom: "↓" };
  const fromEl = h("span"), toEl = h("b");
  const sizeEl = h("span", { class: "xp-size" }, fromEl, h("span", { class: "xp-to" }, " → "), toEl);
  const ratioSel = h("select", { class: "field xp-ratio", title: "画布比例" }, ...RATIOS.map(r => h("option", { value: r, selected: r === ratio ? "" : undefined }, r))) as HTMLSelectElement;
  ratioSel.value = ratio; // UXP shows an empty select until a value is set explicitly
  ratioSel.addEventListener("change", () => { ratio = ratioSel.value; set(pads); });

  const el = h("div", { class: "xp" },
    h("div", { class: "xp-bar" }, ratioSel, h("span", { class: "grow" }),
      h("button", { class: "btn xp-quick", title: "四周各扩展 10%", onClick: () => set({ left: W * .1, right: W * .1, top: H * .1, bottom: H * .1 }) }, "四周 10%"),
      h("button", { class: "icon-btn sm", title: "清零", onClick: () => { ratio = "自由比例"; ratioSel.value = ratio; set({ ...ZERO }); } }, icon("close", 12))),
    stage,
    h("div", { class: "xp-fields" }, ...fields.map(f => h("div", { class: "xp-field" }, h("span", { class: "xp-arrow" }, arrows[f.side]), f.input))),
    h("div", { class: "xp-hint" }, sizeEl, h("span", { class: "muted" }, "拖动边缘扩展 · Shift 对称 · 拖动图片调整位置")));

  function layout() {
    const tw = W + pads.left + pads.right, th = H + pads.top + pads.bottom;
    let scale: number, fx: number, fy: number;
    if (drag?.kind === "edge") {
      // the image stays where it was; the grabbed edge follows the cursor
      scale = drag.view.scale;
      fx = drag.view.ax - pads.left * scale; fy = drag.view.ay - pads.top * scale;
    } else if (drag?.kind === "move") {
      scale = drag.view.scale; fx = drag.view.ax; fy = drag.view.ay;
    } else {
      const bw = stage.clientWidth || 300, bh = stage.clientHeight || 200;
      scale = Math.min((bw - 2 * HIT) / tw, (bh - 2 * HIT) / th);
      fx = (bw - tw * scale) / 2; fy = (bh - th * scale) / 2;
    }
    return { scale, fx, fy, fw: tw * scale, fh: th * scale, ix: fx + pads.left * scale, iy: fy + pads.top * scale, iw: W * scale, ih: H * scale };
  }

  function draw() {
    const L = layout();
    const px = (v: number) => `${Math.round(v)}px`;
    setFrame({ left: px(L.fx), top: px(L.fy), width: px(L.fw), height: px(L.fh) });
    setImg({ left: px(L.ix), top: px(L.iy), width: px(L.iw), height: px(L.ih) });
    const half = HIT / 2;
    for (const g of grips) {
      const x = g.k.includes("r") ? L.fx + L.fw : L.fx;
      const y = g.k.includes("b") ? L.fy + L.fh : L.fy;
      if (g.k === "l" || g.k === "r") g.set({ left: px(x - half), top: px(L.fy + half), width: px(HIT), height: px(Math.max(0, L.fh - HIT)) });
      else if (g.k === "t" || g.k === "b") g.set({ left: px(L.fx + half), top: px(y - half), width: px(Math.max(0, L.fw - HIT)), height: px(HIT) });
      else g.set({ left: px(x - half), top: px(y - half), width: px(HIT), height: px(HIT) });
    }
    for (const f of fields) {
      const v = String(pads[f.side]);
      if (f.shown !== v && document.activeElement !== f.input) { f.input.value = v; f.shown = v; }
    }
    fromEl.textContent = `${W} × ${H}`;
    toEl.textContent = `${W + pads.left + pads.right} × ${H + pads.top + pads.bottom}`;
  }

  function set(p: Pads) {
    pads = normalize(p);
    draw();
    opts.onChange({ ...pads });
  }

  function startDrag(e: MouseEvent, edges: Edge[]) {
    const L = layout();
    drag = { kind: "edge", edges, x0: e.clientX, y0: e.clientY, start: { ...pads }, view: { scale: L.scale, ax: L.ix, ay: L.iy } };
    stage.classList.add("dragging");
    e.preventDefault(); e.stopPropagation();
  }

  function applyMove() {
    queued = false;
    if (!drag || !last) return;
    const dx = (last.x - drag.x0) / drag.view.scale, dy = (last.y - drag.y0) / drag.view.scale;
    const s = drag.start, p = { ...s };
    if (drag.kind === "move") {
      // shifting the picture moves space from one side to the other; the frame size stays
      const mx = Math.max(-s.left, Math.min(s.right, dx)), my = Math.max(-s.top, Math.min(s.bottom, dy));
      p.left = s.left + mx; p.right = s.right - mx; p.top = s.top + my; p.bottom = s.bottom - my;
      pads = clampAll(p);
      draw();
      return;
    }
    for (const edge of drag.edges) {
      if (edge === "l") p.left = s.left - dx;
      if (edge === "r") p.right = s.right + dx;
      if (edge === "t") p.top = s.top - dy;
      if (edge === "b") p.bottom = s.bottom + dy;
    }
    if (last.shift) {
      if (drag.edges.includes("l")) p.right = p.left; else if (drag.edges.includes("r")) p.left = p.right;
      if (drag.edges.includes("t")) p.bottom = p.top; else if (drag.edges.includes("b")) p.top = p.bottom;
    }
    pads = normalize(p);
    draw();
  }

  listen(document, "mousemove", e => {
    if (!drag) return;
    const m = e as MouseEvent;
    last = { x: m.clientX, y: m.clientY, shift: m.shiftKey };
    if (!queued) { queued = true; nextFrame(applyMove); }
  });
  listen(document, "mouseup", () => {
    if (!drag) return;
    if (queued) applyMove(); // apply the final position before letting go
    drag = null; last = null;
    stage.classList.remove("dragging");
    set(pads); // re-fit the view and notify
  });
  listen(window, "resize", () => { if (!drag) draw(); });

  return {
    el,
    setImage(u, width, height) {
      url = u; W = Math.max(1, width); H = Math.max(1, height);
      if (ratioSel.value !== ratio) ratioSel.value = ratio; // again once the panel is shown (UXP drops values set while detached)
      if (url && pic.getAttribute("src") !== url) pic.setAttribute("src", url);
      pic.hidden = !url;
      draw();
    },
    setPads(p) { pads = { ...p }; draw(); },
    pads: () => ({ ...pads }),
  };
}
