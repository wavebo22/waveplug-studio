// A 0–100 slider drawn with divs: UXP's own range input has a fixed tall layout. Dragging moves it
// by the pointer's travel (mouse coordinates only ever compared with each other); a press on the
// track first jumps to that spot. `onInput` follows the drag, `onChange` fires once when let go.

import { h, listen } from "./dom.ts";

export function createSlider(opts: { title?: string; onInput: (v: number) => void; onChange: (v: number) => void }) {
  const fill = h("div", { class: "sl-fill" }), knob = h("div", { class: "sl-knob" });
  const track = h("div", { class: "sl-track" }, fill, knob);
  const el = h("div", { class: "sl", title: opts.title }, track);
  let value = 100, disabled = false, drag: { x0: number; v0: number } | null = null;
  const show = (v: number) => { value = Math.max(0, Math.min(100, Math.round(v))); fill.style.width = value + "%"; knob.style.left = value + "%"; };

  el.addEventListener("mousedown", e => {
    const m = e as MouseEvent;
    if (disabled || m.button !== 0) return;
    e.stopPropagation();
    const w = track.clientWidth || 1;
    // offsetX is relative to what was pressed: the track and the fill both start at the track's left
    if (m.target !== knob && typeof m.offsetX === "number") {
      const x = m.target === el ? m.offsetX - track.offsetLeft : m.offsetX;
      show(x / w * 100);
      opts.onInput(value);
    }
    drag = { x0: m.clientX, v0: value };
  });
  listen(document, "mousemove", e => {
    if (!drag) return;
    show(drag.v0 + ((e as MouseEvent).clientX - drag.x0) / (track.clientWidth || 1) * 100);
    opts.onInput(value);
  });
  listen(document, "mouseup", () => { if (!drag) return; drag = null; opts.onChange(value); });

  return {
    el,
    get value() { return value; },
    set value(v: number) { if (!drag) show(v); },
    set disabled(v: boolean) { disabled = v; el.classList.toggle("off", v); },
  };
}
