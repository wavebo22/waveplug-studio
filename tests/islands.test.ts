import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMask, cleanRgba, cleanSettings, findIslands } from "../src/core/layers/islands.ts";
import { subQuad } from "../src/core/layers/smart.ts";

/** w × h alpha with opaque rectangles [left, top, right, bottom] */
function alpha(w: number, h: number, rects: number[][], value = 255): Uint8Array {
  const a = new Uint8Array(w * h);
  for (const [l, t, r, b] of rects) for (let y = t; y < b; y++) for (let x = l; x < r; x++) a[y * w + x] = value;
  return a;
}

test("像素岛: separate pieces, sorted top to bottom then left to right, with their own masks", () => {
  const a = alpha(20, 10, [[12, 1, 15, 3], [1, 1, 4, 4], [5, 6, 9, 9]]);
  const isl = findIslands(a, 20, 10, 0);
  assert.equal(isl.length, 3);
  assert.deepEqual(isl.map(i => i.bounds.left), [1, 12, 5]);
  assert.deepEqual(isl.map(i => i.area), [9, 6, 12]);
  assert.equal(isl[0].mask.length, 9);
  assert.ok(isl[0].mask.every(v => v === 255));
});

test("像素岛: diagonal pixels touch; 合并距离 joins pieces across a gap", () => {
  const a = alpha(10, 10, [[0, 0, 1, 1], [1, 1, 2, 2]]);
  assert.equal(findIslands(a, 10, 10, 0).length, 1, "8-connected");
  const gap = alpha(20, 4, [[0, 0, 4, 4], [7, 0, 11, 4]]); // 3 px apart
  assert.equal(findIslands(gap, 20, 4, 0).length, 2);
  const joined = findIslands(gap, 20, 4, 0, 4);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].area, 32, "the gap itself is not part of the island");
  assert.equal(joined[0].mask[5], 0);
});

test("裁剪边缘: faint pixels and small specks are cleared, the main shape kept", () => {
  const w = 30, h = 30, a = alpha(w, h, [[5, 5, 25, 25]]);
  a[0] = 10;                    // faint noise
  a[2 * w + 28] = 255;          // a 1 px speck
  a[5 * w + 4] = 200;           // anti-aliased edge pixel touching the shape: kept
  const c = cleanMask(a, w, h, { alpha: 20, minArea: 4 })!;
  assert.equal(c.mask[0], 255);
  assert.equal(c.mask[2 * w + 28], 255);
  assert.equal(c.mask[5 * w + 4], 0);
  assert.equal(c.mask[10 * w + 10], 0);
  assert.deepEqual([c.faint, c.specks, c.cleared], [1, 1, 2]);
  assert.equal(cleanMask(alpha(w, h, [[5, 5, 25, 25]]), w, h, { alpha: 20, minArea: 4 }), null, "nothing to do");
});

test("清理强度 maps to thresholds", () => {
  assert.deepEqual(cleanSettings(0), { alpha: 4, minArea: 4 });
  assert.deepEqual(cleanSettings(1), { alpha: 80, minArea: 400 });
});

test("裁剪边缘 inside a smart object: cleared, cropped, and mapped back onto the document", () => {
  const w = 40, h = 20, data = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, a: number) => { data.set([200, 100, 50, a], (y * w + x) * 4); };
  for (let y = 5; y < 15; y++) for (let x = 10; x < 30; x++) set(x, y, 255);
  set(1, 1, 8);    // faint
  set(38, 18, 255); // speck
  const r = cleanRgba({ width: w, height: h, channels: 4, data }, { alpha: 20, minArea: 4 })!;
  assert.deepEqual(r.crop, { left: 10, top: 5, right: 30, bottom: 15 });
  assert.equal(r.pixels.width, 20);
  assert.equal(r.cleared, 2);
  assert.deepEqual([...r.pixels.data.subarray(0, 4)], [200, 100, 50, 255]);
  // content shown at 2× from (100, 100): the crop lands at (120, 110)–(160, 130)
  assert.deepEqual(subQuad([100, 100, 180, 100, 180, 140, 100, 140], w, h, r.crop), [120, 110, 160, 110, 160, 130, 120, 130]);
  assert.equal(cleanRgba({ width: 2, height: 1, channels: 3, data: new Uint8Array(6) }, { alpha: 20, minArea: 4 }), null);
});

test("抠图: only what the selection takes in whole is kept, like 局部重绘", async () => {
  const { keepInside } = await import("../src/core/layers/islands.ts");
  const w = 90, h = 30, data = new Uint8Array(w * h * 4);
  const fill = (l: number, t: number, r: number, b: number) => { for (let y = t; y < b; y++) for (let x = l; x < r; x++) data.set([200, 50, 50, 255], (y * w + x) * 4); };
  fill(5, 5, 20, 25);   // fully selected
  fill(30, 5, 50, 25);  // half selected
  fill(65, 5, 80, 25);  // not selected
  const sel = { width: w, height: h, channels: 1 as const, data: new Uint8Array(w * h) };
  for (let y = 2; y < 28; y++) for (let x = 2; x < 40; x++) sel.data[y * w + x] = 255;
  const r = keepInside({ width: w, height: h, channels: 4, data }, sel, 2);
  assert.deepEqual([r.kept, r.dropped], [1, 2]);
  assert.equal(r.pixels.data[(10 * w + 10) * 4 + 3], 255, "the whole object stays");
  assert.equal(r.pixels.data[(10 * w + 35) * 4 + 3], 0, "a half-selected one is dropped entirely, not cut");
  assert.equal(r.pixels.data[(10 * w + 70) * 4 + 3], 0);
  // drawn a little tight: still counts as taken in whole
  const tight = { width: w, height: h, channels: 1 as const, data: new Uint8Array(w * h) };
  for (let y = 6; y < 24; y++) for (let x = 6; x < 19; x++) tight.data[y * w + x] = 255;
  assert.equal(keepInside({ width: w, height: h, channels: 4, data }, tight, 3).kept, 1);
});
