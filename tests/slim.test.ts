import { test } from "node:test";
import assert from "node:assert/strict";
import { type DocScan, type ScanLayer, type ScanSmart, planSlim, sizeText, slimWarnings } from "../src/core/layers/slim.ts";

const px = (id: number, l: number, t: number, r: number, b: number, extra: Partial<ScanLayer> = {}): ScanLayer =>
  ({ id, name: "L" + id, kind: "pixel", visible: true, bounds: { left: l, top: t, right: r, bottom: b }, ...extra });
const so = (id: number, shown: number, content: number, extra: Partial<ScanSmart> = {}): ScanLayer => ({
  id, name: "S" + id, kind: "smartObject", visible: true, bounds: { left: 0, top: 0, right: shown, bottom: shown },
  smart: { file: "a.jpg", linked: false, filters: false, shared: false, styled: false, quad: [0, 0, shown, 0, shown, shown, 0, shown], width: content, height: content, ...extra },
});
const scan = (layers: ScanLayer[], extra: Partial<DocScan> = {}): DocScan => ({ width: 1000, height: 1000, bytesPerPixel: 4, bits: 8, layers, alphaChannels: [], ...extra });
const item = (s: DocScan, kind: string) => planSlim(s).find(i => i.kind === kind);

test("瘦身: hidden variations of AI groups, the shown one kept", () => {
  const s = scan([px(1, 0, 0, 100, 100, { variationOf: 9, visible: false }), px(2, 0, 0, 100, 100, { variationOf: 9 }), px(3, 0, 0, 10, 10, { variationOf: 8, visible: false })]);
  const v = item(s, "variations")!;
  assert.deepEqual(v.ids, [1, 3]);
  assert.equal(v.bytes, (100 * 100 + 10 * 10) * 4);
  assert.match(v.detail, /2 个 AI 组.*2 个变体/);
  assert.equal(item(s, "hidden"), undefined, "variations are not counted as hidden layers");
});

test("瘦身: oversized smart objects, and why some can't be shrunk", () => {
  const s = scan([so(1, 400, 2000), so(2, 1500, 2000), so(3, 100, 2000, { shared: true }), so(4, 100, 2000, { file: "设计.psb" }), so(5, 100, 2000, { linked: true })]);
  const b = item(s, "bigSmart")!;
  assert.deepEqual(b.ids, [1], "75 % shown is not oversized");
  assert.equal(b.bytes, (2000 * 2000 - 400 * 400) * 4);
  assert.equal(b.skipped.length, 3);
  assert.match(b.skipped.join(), /共用内容.*不是普通图片.*外部文件/);
});

test("瘦身: pixels off the canvas, empty and hidden layers, alpha channels; sorted by size", () => {
  const s = scan([px(1, -500, 0, 500, 1000), px(2, 0, 0, 0, 0), { id: 3, name: "组", kind: "group", visible: true, bounds: null, children: 0 }, px(4, 0, 0, 10, 10, { visible: false })], { alphaChannels: ["Alpha 1"] });
  const items = planSlim(s);
  assert.equal(item(s, "offCanvas")!.bytes, 500 * 1000 * 4);
  assert.deepEqual(item(s, "empty")!.ids, [2, 3]);
  assert.equal(item(s, "hidden")!.on, false);
  assert.equal(item(s, "channels")!.bytes, 1000 * 1000);
  assert.deepEqual(items.map(i => i.kind), ["offCanvas", "channels", "hidden", "empty"]);
});

test("瘦身: warnings and size text", () => {
  assert.equal(slimWarnings(scan([], { maxCompatibility: true, bits: 16 })).length, 2);
  assert.deepEqual(slimWarnings(scan([])), []);
  assert.equal(sizeText(12.34 * 1024 * 1024), "约 12.3 MB");
  assert.equal(sizeText(0), "");
});
