import { test } from "node:test";
import assert from "node:assert/strict";
import { previewPlace } from "../src/core/layers/hoverPreview.ts";

test("悬停预览：在鼠标下方居中；下面放不下就放上面；不出面板左右", () => {
  const size = { w: 100, h: 80 }, room = { w: 300, h: 400 };
  assert.deepEqual(previewPlace({ x: 150, y: 50 }, size, room), { left: 100, top: 66 });
  assert.deepEqual(previewPlace({ x: 150, y: 350 }, size, room), { left: 100, top: 254 });
  assert.deepEqual(previewPlace({ x: 10, y: 50 }, size, room), { left: 0, top: 66 });
  assert.deepEqual(previewPlace({ x: 295, y: 50 }, size, room), { left: 200, top: 66 });
  // a panel too short either way: below, pushed up to fit
  assert.deepEqual(previewPlace({ x: 150, y: 40 }, size, { w: 300, h: 100 }), { left: 100, top: 20 });
});
