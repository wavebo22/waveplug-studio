import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendStagedLayers, planWorkbenchCopies, pointInWorkbench, workbenchPlacementAnchor } from "../src/core/layers/workbench.ts";
import {
  addToWorkbench, removeFromWorkbench, clearWorkbench,
  onWorkbenchChange, workbenchState,
} from "../src/ui/workbenchStore.ts";
import { stagedKey } from "../src/core/layers/workbench.ts";

const item = (docId: number, layerId: number) =>
  ({ docId, layerId, docKey: "WavePlug_TEST_" + docId + ".psd", name: "Layer " + layerId, kind: "pixel" });

test("内嵌工作台：跨 PSD 暂存图层 ID 去重，操作清单不影响来源", () => {
  const a = item(10, 5), b = item(11, 5), c = item(10, 6);
  assert.deepEqual(appendStagedLayers([a], [a, b, c, c]), [a, b, c]);
  assert.deepEqual(appendStagedLayers([a], [item(0, 1), item(1, -9)]), [a]);
  clearWorkbench();
  assert.equal(addToWorkbench([a, b, b]), 2);
  assert.equal(addToWorkbench([a, c]), 1);
  assert.deepEqual(workbenchState().staged, [a, b, c]);
  removeFromWorkbench(new Set([stagedKey(b)]));
  assert.deepEqual(workbenchState().staged, [a, c]);
  clearWorkbench();
  assert.deepEqual(workbenchState().staged, []);
});

test("内嵌工作台：清单变化通知观察者，退订后不再通知", () => {
  clearWorkbench();
  let calls = 0;
  const dispose = onWorkbenchChange(() => { calls++; });
  addToWorkbench([item(3, 4)]);
  clearWorkbench();
  assert.equal(calls, 2);
  dispose();
  addToWorkbench([item(3, 5)]);
  assert.equal(calls, 2);
  clearWorkbench();
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

test("工作台默认位置：开启时使用最上方选中图层；关闭、无选中或文档未就绪时置顶", () => {
  const layersTopToBottom = [{ id: 30 }, { id: 20 }, { id: 10 }];
  assert.equal(workbenchPlacementAnchor(true, true, layersTopToBottom, new Set([10, 30])), 30);
  assert.equal(workbenchPlacementAnchor(true, true, layersTopToBottom, new Set([20])), 20);
  assert.equal(workbenchPlacementAnchor(false, true, layersTopToBottom, new Set([20])), null);
  assert.equal(workbenchPlacementAnchor(true, true, layersTopToBottom, new Set()), null);
  assert.equal(workbenchPlacementAnchor(true, false, layersTopToBottom, new Set([20])), null);
  assert.equal(workbenchPlacementAnchor(true, true, layersTopToBottom, new Set([999])), null);
});

test("工作台设置：置入把目标文档和设置传给置入逻辑；发送到不包组", () => {
  const ui = readFileSync(new URL("../src/ui/workbench.ts", import.meta.url), "utf8");
  const tree = readFileSync(new URL("../src/ui/layerTree.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/ps/uxpWorkbench.ts", import.meta.url), "utf8");
  assert.match(ui, /tree\.placeStaged\(ok, \{\s*targetDocId, position: p\.position, wrapGroup: p\.wrapGroup/);
  assert.match(tree, /targetDocId: target, wrapGroup: false/);
  assert.match(host, /group\.move\(anchor, constants\.PLACEBEFORE\)/);
  assert.match(host, /return step\(/);
});
