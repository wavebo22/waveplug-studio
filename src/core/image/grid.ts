// A coordinate grid over a picture for a vision model to read positions against (AI 拆层): thin
// magenta lines at every tenth of the width and height, numbered 1–9 along the top and left edges.
// Pure (tests/assistant_decompose.test.ts).

import type { Pixels } from "./png.ts";

/** 3×5 digits 0–9, one row per 3 bits (most significant = left) */
const DIGITS = [
  [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 1, 1], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
];
const LINE = [255, 0, 255], LINE_ALPHA = 0.5;

/** A copy of `p` (RGB or RGBA; others are returned as they are) with the grid drawn on it. */
export function withGrid(p: Pixels): Pixels {
  const { width: w, height: h, channels: ch } = p;
  if (ch !== 3 && ch !== 4) return p;
  const data = new Uint8Array(p.data);
  const blend = (x: number, y: number, c: readonly number[], a: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * ch;
    for (let k = 0; k < 3; k++) data[o + k] = Math.round(data[o + k] * (1 - a) + c[k] * a);
    if (ch === 4) data[o + 3] = Math.max(data[o + 3], Math.round(255 * a));
  };
  const lw = Math.max(1, Math.round(Math.min(w, h) / 700));
  for (let k = 1; k < 10; k++) {
    const x0 = Math.round(w * k / 10) - (lw >> 1), y0 = Math.round(h * k / 10) - (lw >> 1);
    for (let t = 0; t < lw; t++) {
      for (let y = 0; y < h; y++) blend(x0 + t, y, LINE, LINE_ALPHA);
      for (let x = 0; x < w; x++) blend(x, y0 + t, LINE, LINE_ALPHA);
    }
  }
  // labels: a dark tile with a white digit, on each line at the top and left edges
  const s = Math.max(2, Math.round(Math.min(w, h) / 220));
  const tileW = 5 * s, tileH = 7 * s;
  const label = (cx: number, cy: number, d: number) => {
    const left = Math.round(cx - tileW / 2), top = Math.round(cy - tileH / 2);
    for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) blend(left + x, top + y, [0, 0, 0], 0.75);
    DIGITS[d].forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) if (row & (4 >> rx))
        for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) blend(left + s + rx * s + x, top + s + ry * s + y, [255, 255, 255], 1);
    });
  };
  for (let k = 1; k < 10; k++) {
    label(w * k / 10, tileH / 2 + s, k);
    label(tileW / 2 + s, h * k / 10, k);
  }
  return { width: w, height: h, channels: ch, data };
}
