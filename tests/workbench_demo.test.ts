import { test } from "node:test";
import assert from "node:assert/strict";
import { appendStagedLayers, planWorkbenchCopies, pointInWorkbench } from "../src/core/layers/workbench.ts";
import {
  addToWorkbenchDemo, removeFromWorkbenchDemo, clearWorkbenchDemo,
  onWorkbenchDemoChange, workbenchDemoState,
} from "../src/ui/workbenchStore.ts";

const item = (docId: number, layerId: number) =>
  ({ docId, layerId, docKey: "WavePlug_TEST_" + docId + ".psd", name: "Layer " + layerId, kind: "pixel" });

test("内嵌工作台：跨 PSD 暂存图层 ID 去重，操作清单不影响来源", () => {
  const a = item(10, 5), b = item(11, 5), c = item(10, 6);
  assert.deepEqual(appendStagedLayers([a], [a, b, c, c]), [a, b, c]);
  assert.deepEqual(appendStagedLayers([a], [item(0, 1), item(1, -9)]), [a]);
  clearWorkbenchDemo();
  assert.equal(addToWorkbenchDemo([a, b, b]), 2);
  assert.equal(addToWorkbenchDemo([a, c]), 1);
  assert.deepEqual(workbenchDemoState().staged, [a, b, c]);
  removeFromWorkbenchDemo(b);
  assert.deepEqual(workbenchDemoState().staged, [a, c]);
  clearWorkbenchDemo();
  assert.deepEqual(workbenchDemoState().staged, []);
});

test("内嵌工作台：清单变化通知观察者，退订后不再通知", () => {
  clearWorkbenchDemo();
  let calls = 0;
  const dispose = onWorkbenchDemoChange(() => { calls++; });
  addToWorkbenchDemo([item(3, 4)]);
  clearWorkbenchDemo();
  assert.equal(calls, 2);
  dispose();
  addToWorkbenchDemo([item(3, 5)]);
  assert.equal(calls, 2);
  clearWorkbenchDemo();
});

test("内嵌工作台：最终松开位置决定投放，不将列表外误认为重排目标", () => {
  const b = { left: 100, right: 400, top: 300, bottom: 480 };
  assert.equal(pointInWorkbench(b, 120, 330), true);
  assert.equal(pointInWorkbench(b, 399, 479), true);
  assert.equal(pointInWorkbench(b, 400, 350), false);
  assert.equal(pointInWorkbench(b, 170, 480), false);
  assert.equal(pointInWorkbench(b, 150, 299), false);
  assert.equal(pointInWorkbench(b, NaN, 420), false);
});

test("一键放入：从多个 PSD 收集图层，每个来源合并成一个批次", () => {
  const a = item(12, 1), b = item(13, 1), c = item(12, 4), d = item(13, 9);
  const plan = planWorkbenchCopies([a, b, c, d, b], () => null);
  assert.equal(plan.count, 4);
  assert.equal(plan.nestedSkipped, 0);
  assert.deepEqual(plan.batches, [
    { docId: 12, layers: [a, c] }, { docId: 13, layers: [b, d] },
  ]);
});

test("一键放入：组与其子孙同时暂存时仅复制外层组", () => {
  const staged = [item(7, 21), item(7, 20), item(7, 22), item(7, 31), item(8, 20)];
  const parents = new Map([[21, 20], [22, 20], [31, 22], [20, 0]]);
  const parent = (docId: number, id: number) => docId === 7 ? (parents.get(id) || null) : null;
  const plan = planWorkbenchCopies(staged, parent);
  assert.equal(plan.count, 2);
  assert.equal(plan.nestedSkipped, 3);
  assert.deepEqual(plan.batches, [
    { docId: 7, layers: [item(7, 20)] }, { docId: 8, layers: [item(8, 20)] },
  ]);
  assert.deepEqual(planWorkbenchCopies([item(7, 31)], parent).batches,
    [{ docId: 7, layers: [item(7, 31)] }]);
});
