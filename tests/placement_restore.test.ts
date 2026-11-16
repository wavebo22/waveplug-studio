import { test } from "node:test";
import assert from "node:assert/strict";
import { pairCopies, restoreBox, restoreMoves, restoreScale, unionRect } from "../src/core/layers/placementRestore.ts";

const R = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const keep = { scaleWithCanvas: false }, scale = { scaleWithCanvas: true };

test("位置还原：同尺寸画布像素位置不变；同尺寸画板只平移画板的偏移", () => {
  assert.deepEqual(restoreBox(R(0, 0, 1000, 800), R(100, 100, 300, 200), R(0, 0, 1000, 800), keep).box, R(100, 100, 300, 200));
  assert.deepEqual(restoreBox(R(0, 0, 1000, 800), R(100, 100, 300, 200), R(2000, 50, 3000, 850), keep).box, R(2100, 150, 2300, 250));
});

test("位置还原：尺寸不同，贴左 / 贴右的保持边距（按比例换算），居中的保持中心相对位置；另一轴同尺寸不变", () => {
  const src = R(0, 0, 1000, 1000), dst = R(0, 0, 2000, 1000);
  assert.deepEqual(restoreBox(src, R(20, 30, 120, 80), dst, keep).box, R(40, 30, 140, 80));
  assert.deepEqual(restoreBox(src, R(880, 30, 980, 80), dst, keep).box, R(1860, 30, 1960, 80));
  assert.deepEqual(restoreBox(src, R(400, 30, 600, 80), dst, keep).box, R(900, 30, 1100, 80));
  // 15% boundary: 160px from the left of 1000 is not "near an edge"
  assert.deepEqual(restoreBox(src, R(160, 0, 260, 10), dst, keep).box.left, 2 * 210 - 50);
});

test("位置还原：随画布缩放按宽高比例较小者；关闭时不缩放", () => {
  assert.equal(restoreScale(R(0, 0, 1000, 1000), R(0, 0, 500, 800), scale), 0.5);
  assert.equal(restoreScale(R(0, 0, 1000, 1000), R(0, 0, 500, 800), keep), 1);
  assert.deepEqual(restoreBox(R(0, 0, 1000, 1000), R(400, 400, 600, 600), R(0, 0, 500, 500), scale),
    { box: R(200, 200, 300, 300), scale: 0.5 });
});

test("位置还原：多选当一整块移动，内部相对位置不变；没有边界的图层不动", () => {
  const src = R(0, 0, 1000, 1000), dst = R(0, 0, 2000, 1000);
  const layers = [
    { id: 1, source: R(400, 100, 500, 200) },
    { id: 2, source: R(500, 300, 600, 400) },
    { id: 3, source: null }, // adjustment layer
  ];
  // the copies landed somewhere else in the target
  const actual = new Map([[1, R(0, 0, 100, 100)], [2, R(50, 50, 150, 150)], [3, null]]);
  const moves = restoreMoves(src, dst, layers, keep, id => actual.get(id) ?? null);
  assert.deepEqual(moves, [{ id: 1, scale: 1, dx: 900, dy: 100 }, { id: 2, scale: 1, dx: 950, dy: 250 }]);
  assert.deepEqual(restoreMoves(src, dst, [{ id: 3, source: null }], keep, () => null), []);
});

test("位置还原：移动取整到整像素", () => {
  const moves = restoreMoves(R(0, 0, 999, 999), R(0, 0, 1000, 1000), [{ id: 1, source: R(450, 450, 551, 551) }], keep, () => R(0, 0, 101, 101));
  for (const m of moves) { assert.ok(Number.isInteger(m.dx)); assert.ok(Number.isInteger(m.dy)); }
});

test("位置还原：复制件按同名配对，其余按顺序；空边界不计入合并边界", () => {
  assert.deepEqual(pairCopies([{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }],
    [{ id: 12, name: "B" }, { id: 11, name: "A" }, { id: 13, name: "C 拷贝" }]), [[1, 11], [2, 12], [3, 13]]);
  assert.deepEqual(unionRect([R(0, 0, 0, 0), R(10, 10, 20, 20), null, R(5, 15, 8, 30)]), R(5, 10, 20, 30));
  assert.equal(unionRect([R(0, 0, 0, 0)]), null);
});

test("位置还原：按长边缩放，来源画面为 100%，长边方向始终还原原比例", () => {
  const long = { scaleWithCanvas: false, longEdge: true };
  // portrait → portrait: 14400 → 12472 on the long (height) edge
  assert.equal(restoreScale(R(0, 0, 5046, 14400), R(0, 0, 9213, 12472), long), 12472 / 14400);
  // portrait → landscape: target long edge (width 2000) / source long edge (height 2000)
  assert.equal(restoreScale(R(0, 0, 1000, 2000), R(0, 0, 2000, 1000), long), 1);
  // wins over 随画布缩放
  assert.equal(restoreScale(R(0, 0, 1000, 1000), R(0, 0, 500, 800), { scaleWithCanvas: true, longEdge: true }), 0.8);
  // same orientation: along the long edge the block keeps its proportion of the canvas
  const r = restoreBox(R(0, 0, 1000, 2000), R(400, 900, 600, 1100), R(0, 0, 3000, 4000), long);
  assert.equal(r.scale, 2);
  assert.deepEqual(r.box, R(1300, 1800, 1700, 2200));
  // 300×400 → 500×1000: the canvas becomes 750×1000, centred (−125..625); a corner layer stays in
  // the corner of that scaled canvas, not anchored to the target's edge
  const c = restoreBox(R(0, 0, 300, 400), R(0, 0, 30, 40), R(0, 0, 500, 1000), long);
  assert.equal(c.scale, 2.5);
  assert.deepEqual(c.box, R(-125, 0, -50, 100));
  // two layers: their offset is scaled with the canvas
  const ms = restoreMoves(R(0, 0, 300, 400), R(0, 0, 500, 1000),
    [{ id: 1, source: R(0, 0, 30, 40) }, { id: 2, source: R(270, 360, 300, 400) }], long,
    id => id === 1 ? R(0, 0, 75, 100) : R(0, 0, 75, 100));
  assert.deepEqual(ms.map(m => [m.dx, m.dy]), [[-125, 0], [550, 900]]);
});
