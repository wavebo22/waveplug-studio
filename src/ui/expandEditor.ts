// Interactive outpaint canvas, modelled on 孤海「外补画板（可视化）」: drag an edge or corner to
// extend the canvas, hold Shift for symmetric extension, drag the picture to shift it inside the
// frame, pick an aspect ratio to keep the frame at that ratio. Plain DOM (UXP has no reliable
// <canvas>), mouse events only.

import type { Pads } from "../ps/host.ts";
import { h, icon, replace } from "./dom.ts";

export const RATIOS = ["自由比例", "1:1", "2:3", "3:2", "3:4", "4:3", "5:7", "9:16", "16:9", "21:9", "1:2", "2:1"];
type Edge = "l" | "r" | "t" | "b";
const ZERO: Pads = { left: 0, right: 0, top: 0, bottom: 0 };

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

export function createExpandEditor(opts: { maxPad: number; onChange(p: Pads): void }): ExpandEditor {
  let W = 1, H = 1, url: string | null = null;
  let pads: Pads = { ...ZERO };
  let ratio = "自由比例";
  let drag: null | { kind: "edge"; edges: Edge[]; x0: number; y0: number; start: Pads; scale: number } | { kind: "move"; x0: number; y0: number; start: Pads; scale: number } = null;

  const clamp = (v: number) => Math.max(0, Math.min(opts.maxPad, Math.round(v)));
  const normalize = (p: Pads): Pads => {
    const q = { left: clamp(p.left), right: clamp(p.right), top: clamp(p.top), bottom: clamp(p.bottom) };
    return ratio === "自由比例" ? q : (() => { const r = fitRatio(q, W, H, ratio); return { left: clamp(r.left), right: clamp(r.right), top: clamp(r.top), bottom: clamp(r.bottom) }; })();
  };

  const stage = h("div", { class: "xp-stage" });
  const frame = h("div", { class: "xp-frame" });
  const img = h("div", { class: "xp-img" });
  const pic = h("img", { class: "xp-pic", draggable: "false" }) as HTMLImageElement; // UXP: <img> is more reliable than background-image
  img.append(pic);
  const handles = (["l", "r", "t", "b", "tl", "tr", "bl", "br"] as const).map(k => {
    const el = h("div", { class: `xp-h xp-h-${k}` });
    el.addEventListener("mousedown", e => startDrag(e as MouseEvent, k.split("") as Edge[]));
    return el;
  });
  stage.append(frame, img, ...handles);
  img.addEventListener("mousedown", e => {
    const m = e as MouseEvent;
    drag = { kind: "move", x0: m.clientX, y0: m.clientY, start: { ...pads }, scale: layout().scale };
    m.preventDefault();
  });

  const fields = (["left", "right", "top", "bottom"] as const).map(side => {
    const input = h("input", { class: "num xp-num", type: "number", min: "0", max: String(opts.maxPad), step: "1" }) as HTMLInputElement;
    input.addEventListener("change", () => set({ ...pads, [side]: Number(input.value) || 0 }));
    return { side, input };
  });
  const arrows = { left: "←", right: "→", top: "↑", bottom: "↓" };
  const sizeEl = h("span", { class: "xp-size" });
  const ratioSel = h("select", { class: "field xp-ratio", title: "画布比例" }, ...RATIOS.map(r => h("option", { value: r }, r))) as HTMLSelectElement;
  ratioSel.addEventListener("change", () => { ratio = ratioSel.value; set(pads); });

  const el = h("div", { class: "xp" },
    h("div", { class: "xp-bar" }, ratioSel, h("span", { class: "grow" }),
      h("button", { class: "btn xp-quick", title: "四周各扩展 10%", onClick: () => set({ left: W * .1, right: W * .1, top: H * .1, bottom: H * .1 }) }, "四周 10%"),
      h("button", { class: "icon-btn sm", title: "清零", onClick: () => { ratio = "自由比例"; ratioSel.value = ratio; set({ ...ZERO }); } }, icon("close", 12))),
    stage,
    h("div", { class: "xp-fields" }, ...fields.map(f => h("div", { class: "xp-field" }, h("span", { class: "xp-arrow" }, arrows[f.side]), f.input))),
    h("div", { class: "xp-hint" }, sizeEl, h("span", { class: "muted" }, "拖动边缘扩展 · Shift 对称 · 拖动图片调整位置")));

  function layout(fixedScale?: number) {
    const bw = stage.clientWidth || 300, bh = stage.clientHeight || 200;
    const tw = W + pads.left + pads.right, th = H + pads.top + pads.bottom;
    const scale = fixedScale ?? Math.min((bw - 24) / tw, (bh - 24) / th);
    const fw = tw * scale, fh = th * scale;
    const fx = (bw - fw) / 2, fy = (bh - fh) / 2;
    return { scale, fx, fy, fw, fh, ix: fx + pads.left * scale, iy: fy + pads.top * scale, iw: W * scale, ih: H * scale };
  }

  function draw(fixedScale?: number) {
    const L = layout(fixedScale);
    const px = (v: number) => `${Math.round(v)}px`;
    frame.setAttribute("style", `left:${px(L.fx)};top:${px(L.fy)};width:${px(L.fw)};height:${px(L.fh)}`);
    img.setAttribute("style", `left:${px(L.ix)};top:${px(L.iy)};width:${px(L.iw)};height:${px(L.ih)}`);
    if (url && pic.getAttribute("src") !== url) pic.setAttribute("src", url);
    pic.hidden = !url;
    const at: Record<string, [number, number]> = {
      l: [L.fx, L.fy + L.fh / 2], r: [L.fx + L.fw, L.fy + L.fh / 2], t: [L.fx + L.fw / 2, L.fy], b: [L.fx + L.fw / 2, L.fy + L.fh],
      tl: [L.fx, L.fy], tr: [L.fx + L.fw, L.fy], bl: [L.fx, L.fy + L.fh], br: [L.fx + L.fw, L.fy + L.fh],
    };
    handles.forEach((hd, i) => { const k = ["l", "r", "t", "b", "tl", "tr", "bl", "br"][i]; hd.setAttribute("style", `left:${px(at[k][0] - 5)};top:${px(at[k][1] - 5)}`); });
    for (const f of fields) if (document.activeElement !== f.input) f.input.value = String(pads[f.side]);
    replace(sizeEl, `${W} × ${H}`, h("span", { class: "xp-to" }, " → "), h("b", null, `${W + pads.left + pads.right} × ${H + pads.top + pads.bottom}`), "  ");
  }

  function set(p: Pads, fixedScale?: number) {
    pads = normalize(p);
    draw(fixedScale);
    opts.onChange({ ...pads });
  }

  function startDrag(e: MouseEvent, edges: Edge[]) {
    drag = { kind: "edge", edges, x0: e.clientX, y0: e.clientY, start: { ...pads }, scale: layout().scale };
    e.preventDefault(); e.stopPropagation();
  }

  document.addEventListener("mousemove", e => {
    if (!drag) return;
    const m = e as MouseEvent;
    const dx = (m.clientX - drag.x0) / drag.scale, dy = (m.clientY - drag.y0) / drag.scale;
    const s = drag.start, p = { ...s };
    if (drag.kind === "move") {
      // shifting the picture moves space from one side to the other; the frame size stays
      const mx = Math.max(-s.left, Math.min(s.right, dx)), my = Math.max(-s.top, Math.min(s.bottom, dy));
      p.left = s.left + mx; p.right = s.right - mx; p.top = s.top + my; p.bottom = s.bottom - my;
      pads = { left: clamp(p.left), right: clamp(p.right), top: clamp(p.top), bottom: clamp(p.bottom) };
      draw(drag.scale);
      return;
    }
    for (const edge of drag.edges) {
      if (edge === "l") p.left = s.left - dx;
      if (edge === "r") p.right = s.right + dx;
      if (edge === "t") p.top = s.top - dy;
      if (edge === "b") p.bottom = s.bottom + dy;
    }
    if (m.shiftKey) {
      if (drag.edges.includes("l")) p.right = p.left; else if (drag.edges.includes("r")) p.left = p.right;
      if (drag.edges.includes("t")) p.bottom = p.top; else if (drag.edges.includes("b")) p.top = p.bottom;
    }
    pads = normalize(p);
    draw(drag.scale);
  });
  document.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    set(pads); // re-fit the view and notify
  });

  window.addEventListener("resize", () => { if (!drag) draw(); });

  return {
    el,
    setImage(u, width, height) { url = u; W = Math.max(1, width); H = Math.max(1, height); draw(); },
    setPads(p) { pads = { ...p }; draw(); },
    pads: () => ({ ...pads }),
  };
}
