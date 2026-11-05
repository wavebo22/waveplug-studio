import { test } from "node:test";
import assert from "node:assert/strict";
import { routeLayerDragRelease } from "../src/core/layers/drag.ts";

test("跨面板释放交给原生参考图面板，不触发普通图层排序", () => {
  assert.equal(routeLayerDragRelease({
    active: true, referenceDragStarted: true, releasedInsidePanel: false, acceptedWorkbench: false,
  }), "external");
});

test("在 WaveLayer 内部释放仍保留原有排序和工作台拖放", () => {
  assert.equal(routeLayerDragRelease({
    active: true, referenceDragStarted: true, releasedInsidePanel: true, acceptedWorkbench: false,
  }), "internal");
  assert.equal(routeLayerDragRelease({
    active: true, referenceDragStarted: true, releasedInsidePanel: true, acceptedWorkbench: true,
  }), "workbench");
});

test("没有跨面板连接时，面板外释放直接取消，不使用最后一个内部目标", () => {
  assert.equal(routeLayerDragRelease({
    active: true, referenceDragStarted: false, releasedInsidePanel: false, acceptedWorkbench: false,
  }), "outside");
  assert.equal(routeLayerDragRelease({
    active: false, referenceDragStarted: false, releasedInsidePanel: false, acceptedWorkbench: false,
  }), "click");
});
