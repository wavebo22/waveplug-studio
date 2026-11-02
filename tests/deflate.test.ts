import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { codeLengths, filterRows, zlibDeflate } from "../src/core/image/deflate.ts";
import { encodePng } from "../src/core/image/png.ts";
import { decodePng } from "../src/core/image/decode.ts";

test("deflate: zlib reads back exactly what was written", () => {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) & 255;
  const cases = [
    new Uint8Array(0),
    new Uint8Array(1000).fill(7),
    Uint8Array.from({ length: 70000 }, () => rnd()),                       // incompressible, spans blocks
    Uint8Array.from({ length: 300000 }, (_, i) => (i % 1000 < 600 ? 0 : rnd() & 3)), // runs + small values
  ];
  for (const c of cases) assert.deepEqual(new Uint8Array(inflateSync(zlibDeflate(c))), c);
  assert.ok(zlibDeflate(cases[1]).length < 40, "a run collapses");
});

test("deflate: code lengths stay within the limit and form a prefix code", () => {
  const fib = [1, 1]; while (fib.length < 30) fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
  const lens = codeLengths(fib, 15);
  assert.ok(Math.max(...lens) <= 15);
  const kraft = [...lens].reduce((s, l) => s + (l ? 2 ** -l : 0), 0);
  assert.ok(kraft <= 1 + 1e-9);
  assert.deepEqual([...codeLengths([0, 5, 0], 15)], [0, 1, 0]);
});

test("PNG: filtered and compressed, decoded back exactly", () => {
  const w = 64, h = 40;
  for (const ch of [1, 3, 4] as const) {
    const data = Uint8Array.from({ length: w * h * ch }, (_, i) => ((i * 7) ^ (i >> 5)) & 255);
    const png = encodePng({ width: w, height: h, channels: ch, data });
    const back = decodePng(png);
    assert.equal(back.channels, ch);
    assert.deepEqual(back.data, data);
  }
  const flat = encodePng({ width: 1000, height: 1000, channels: 3, data: new Uint8Array(3e6).fill(200) });
  assert.ok(flat.length < 20000, "a flat 1000×1000 image is tiny");
  assert.equal(filterRows(new Uint8Array([1, 2, 3, 4]), 2, 2, 1).length, 6);
});

test("downscale averages the covered pixels", async () => {
  const { downscale } = await import("../src/core/image/compose.ts");
  const p = { width: 4, height: 2, channels: 1 as const, data: new Uint8Array([0, 100, 200, 200, 0, 100, 200, 200]) };
  assert.deepEqual([...downscale(p, 2, 1).data], [50, 200]);
  const q = downscale({ width: 3, height: 3, channels: 3, data: new Uint8Array(27).fill(90) }, 2, 2);
  assert.ok(q.data.every(v => v === 90));
  assert.equal(downscale(p, 8, 4), p, "never upscales");
});

test("融图 edge and detail helpers", async () => {
  const { featherInside, transferDetail, blur, resize } = await import("../src/core/image/compose.ts");
  const { blendFeather } = await import("../src/app/generate.ts");
  const w = 40, h = 40, sel = { width: w, height: h, channels: 1 as const, data: new Uint8Array(w * h) };
  for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) sel.data[y * w + x] = 255;
  const f = featherInside(sel, 10);
  assert.ok(f.data[20 * w + 5] < 20, "faded at the edge");
  assert.equal(f.data[20 * w + 20], 255, "full in the middle");
  assert.equal(f.data[0], 0);
  assert.equal(blendFeather(300, 2000), 18);
  assert.equal(blendFeather(5000, 5000), 96);
  // flat result light + original stripes = stripes at the result's brightness
  const orig = { width: w, height: h, channels: 3 as const, data: new Uint8Array(w * h * 3).map((_, i) => (Math.floor(i / 3) % 2) * 60 + 100) };
  const res = { width: w, height: h, channels: 3 as const, data: new Uint8Array(w * h * 3).fill(180) };
  const out = transferDetail(res, orig, 3);
  const m = (20 * w + 20) * 3;
  assert.ok(Math.abs((out.data[m] + out.data[m + 3]) / 2 - 180) <= 2, "brightness from the result");
  assert.ok(Math.abs(out.data[m] - out.data[m + 3]) >= 40, "stripes from the original");
  assert.equal(blur(res, 2).data[m], 180);
  assert.deepEqual([resize(res, 10, 10).width, resize(res, 10, 10).data[0]], [10, 180]);
});

test("blur leaves its input untouched", async () => {
  const { blur } = await import("../src/core/image/compose.ts");
  const p = { width: 4, height: 1, channels: 1 as const, data: new Uint8Array([0, 255, 0, 255]) };
  blur(p, 2);
  assert.deepEqual([...p.data], [0, 255, 0, 255]);
});

test("抠图 detail: original detail where the content is the same, the model's where it changed", async () => {
  const { transferDetailWhereSame } = await import("../src/core/image/compose.ts");
  const w = 60, h = 20, n = w * h;
  // original: fine stripes everywhere; result: smooth, same brightness on the left, completely different on the right
  const orig = new Uint8Array(n * 3), res = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = i % w, stripe = (x % 2) * 40 + 100;
    orig.fill(stripe, i * 3, i * 3 + 3);
    res.fill(x < 30 ? 120 : 230, i * 3, i * 3 + 3);
  }
  const out = transferDetailWhereSame({ width: w, height: h, channels: 3, data: res }, { width: w, height: h, channels: 3, data: orig }, 1.5);
  const at = (x: number) => out.data[(10 * w + x) * 3];
  assert.ok(Math.abs(at(10) - at(11)) >= 25, "same content: the original's stripes");
  assert.ok(Math.abs(at(50) - at(51)) <= 3 && at(50) > 200, "changed content: the model's smooth pixels");
});

test("抠图 detail: a thin stroke the model removed doesn't come back", async () => {
  const { transferDetailWhereSame } = await import("../src/core/image/compose.ts");
  const w = 40, h = 40, n = w * h;
  const orig = new Uint8Array(n * 3).fill(120), res = new Uint8Array(n * 3).fill(120);
  for (let y = 0; y < h; y++) orig.fill(255, (y * w + 20) * 3, (y * w + 21) * 3); // a 1 px bright line in the original only
  const out = transferDetailWhereSame({ width: w, height: h, channels: 3, data: res }, { width: w, height: h, channels: 3, data: orig }, 1.5);
  assert.ok(out.data[(20 * w + 20) * 3] < 130, "the line stays removed");
});
