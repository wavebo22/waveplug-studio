import { test } from "node:test";
import assert from "node:assert/strict";
import { sameMaskAt } from "../src/core/image/maskIdentity.ts";
import type { Pixels } from "../src/core/image/png.ts";
import type { Rect } from "../src/core/image/region.ts";

const box: Rect = { left: 10, top: 20, right: 13, bottom: 22 };
const mask = (v: number[]): Pixels => ({ width: 3, height: 2, channels: 1, data: new Uint8Array(v) });

test("蒙版位置和逐像素均相同才属于同一个 AI 图层", () => {
  const a = mask([0, 255, 0, 100, 255, 0]);
  assert.equal(sameMaskAt(a, box, mask([0, 255, 0, 100, 255, 0]), box), true);
  assert.equal(sameMaskAt(a, box, mask([0, 255, 0, 99, 255, 0]), box), false);
  assert.equal(sameMaskAt(a, box, a, { left: 11, top: 20, right: 14, bottom: 22 }), false);
  assert.equal(sameMaskAt(a, box, { ...a, channels: 3 }, box), false);
});
