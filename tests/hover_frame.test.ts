import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64, frameKey, frameOnScreen, layerFrame, shapeAlpha } from "../src/core/overlay/hoverFrame.ts";

test("悬停高亮: a layer's coverage is its alpha; without alpha all of it", () => {
  assert.deepEqual([...shapeAlpha(new Uint8Array([1, 2, 3, 200, 4, 5, 6, 0]), 2, 1, 4)!], [200, 0]);
  assert.deepEqual([...shapeAlpha(new Uint8Array([9, 9, 9, 8, 8, 8]), 2, 1, 3)!], [255, 255]);
  assert.equal(shapeAlpha(new Uint8Array(3), 2, 1, 4), null);
  assert.equal(bytesToBase64(new Uint8Array([255, 0])), "/wA=");
  assert.equal(bytesToBase64(new Uint8Array(70000)).length, Math.ceil(70000 / 3) * 4);
});

// 11-04 实测的视图：1080×1759 文档在 100% 下居中
const view = { view: { left: 1008, top: 139, right: 3037, bottom: 2087 }, center: { x: 540.25, y: 879 }, zoom: 1 };

test("悬停边框：图层范围、画板用画板范围、空图层没有边框", () => {
  assert.deepEqual(layerFrame({ left: 10, top: 20, width: 100, height: 50 }), { left: 10, top: 20, right: 110, bottom: 70 });
  assert.deepEqual(layerFrame({ left: 0, top: 0, width: 5, height: 5, board: { left: 100, top: 0, right: 900, bottom: 600 } }), { left: 100, top: 0, right: 900, bottom: 600 });
  assert.equal(layerFrame({ left: 0, top: 0, width: 0, height: 0 }), null);
});

test("悬停边框：按画布视图换算到屏幕，并带上裁切范围", () => {
  const f = frameOnScreen({ left: 540, top: 879, right: 640, bottom: 979 }, view);
  assert.deepEqual(f, { rect: { left: 2022, top: 1113, right: 2122, bottom: 1213 }, clip: view.view });
  // 完全在视图外：不显示
  assert.equal(frameOnScreen({ left: 5000, top: 0, right: 5100, bottom: 100 }, view), null);
  // 缩得很小的图层仍至少 1 px
  const tiny = frameOnScreen({ left: 540, top: 879, right: 541, bottom: 880 }, { ...view, center: { x: 54.025, y: 87.9 }, zoom: 0.1 })!;
  assert.ok(tiny.rect.right - tiny.rect.left >= 1 && tiny.rect.bottom - tiny.rect.top >= 1);
});

test("悬停边框：相同的边框不重复发送", () => {
  const f = frameOnScreen({ left: 0, top: 0, right: 10, bottom: 10 }, view);
  assert.equal(frameKey(f), frameKey(frameOnScreen({ left: 0, top: 0, right: 10, bottom: 10 }, view)));
  assert.notEqual(frameKey(f), frameKey(null));
  assert.equal(frameKey(null), "");
});
