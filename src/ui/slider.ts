// A 0–100 slider drawn with divs: UXP's own range input has a fixed tall layout. Dragging moves it
// by the pointer's travel (mouse coordinates only ever compared with each other); a press on the
// track first jumps to that spot. `onInput` follows the drag, `onChange` fires once when let go.

import { h, listen, movesWhile } from "./dom.ts";

export function createSlider(opts: { title?: string; min?: number; max?: number; onInput: (v: number) => void; onChange: (v: number) => void }) {
  const fill = h("div", { class: "sl-fill" }), knob = h("div", { class: "sl-knob" });
  const track = h("div", { class: "sl-track" }, fill, knob);
  const el = h("div", { class: "sl", title: opts.title }, track);
  const min = opts.min ?? 0, max = opts.max ?? 100;
  let value = max, disabled = false, drag: { x0: number; v0: number } | null = null;
  const show = (v: number) => {
    value = Math.max(min, Math.min(max, Math.round(v)));
    const p = (value - min) / Math.max(1, max - min) * 100;
    fill.style.width = p + "%"; knob.style.left = p + "%";
  };

  el.addEventListener("mousedown", e => {
    const m = e as MouseEvent;
    if (disabled || m.button !== 0) return;
    e.stopPropagation();
    const w = track.clientWidth || 1;
    // offsetX is relative to what was pressed: the track and the fill both start at the track's left
    if (m.target !== knob && typeof m.offsetX === "number") {
      const x = m.target === el ? m.offsetX - track.offsetLeft : m.offsetX;
      show(min + x / w * (max - min));
      opts.onInput(value);
    }
    drag = { x0: m.clientX, v0: value };
    armMoves();
  });
  const armMoves = movesWhile(document, e => {
    if (!drag) return;
    show(drag.v0 + ((e as MouseEvent).clientX - drag.x0) / (track.clientWidth || 1) * (max - min));
    opts.onInput(value);
  }, () => !!drag);
  listen(document, "mouseup", () => { if (!drag) return; drag = null; opts.onChange(value); });

  return {
    el,
    get value() { return value; },
    set value(v: number) { if (!drag) show(v); },
    set disabled(v: boolean) { disabled = v; el.classList.toggle("off", v); },
  };
}
