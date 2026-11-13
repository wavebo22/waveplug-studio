import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateLayerDragLifecycle, cancelLayerDragLifecycle, createLayerDragLifecycle,
  releaseLayerDragLifecycle, routeLayerDragRelease, updateLayerDragLifecycle,
} from "../src/core/layers/drag.ts";
import {
  addCalibrationSample, calibrationOffset, clampDropListY, createClientCalibration,
  plausibleAxisOffset, resolveDragRegion, syntheticOffset, type DragLayout,
} from "../src/core/layers/dragGeometry.ts";

test("拖拽生命周期：阈值前是 click，越过阈值后进入 dragging", () => {
  const state = createLayerDragLifecycle({ x: 10, y: 20, listY: 30, alt: false });
  assert.equal(activateLayerDragLifecycle(state, 13, 22), false);
  assert.equal(state.phase, "armed");
  assert.equal(activateLayerDragLifecycle(state, 16, 22), true);
  assert.equal(state.phase, "dragging");
  assert.equal(activateLayerDragLifecycle(state, 17, 23), true);
});

test("拖拽离开面板后重新进入侧边带：区域恢复为 list 并可正常释放", () => {
  const state = createLayerDragLifecycle({ x: 100, y: 40, listY: 40, alt: false });
  activateLayerDragLifecycle(state, 110, 40);
  updateLayerDragLifecycle(state, { x: -20, y: 40, listY: 40, alt: false, region: "outside" });
  assert.equal(state.region, "outside");
  updateLayerDragLifecycle(state, { x: 42, y: 40, listY: 40, alt: false, region: "list" });
  assert.equal(state.region, "list");
  const released = releaseLayerDragLifecycle(state, { x: 42, y: 40, listY: 40, alt: false, region: "list" });
  assert.equal(released?.region, "list");
});

test("拖拽释放：只提交一次，并使用最后一次释放位置和区域", () => {
  const state = createLayerDragLifecycle({ x: 10, y: 20, listY: 30, alt: false });
  activateLayerDragLifecycle(state, 20, 30);
  updateLayerDragLifecycle(state, { x: 40, y: 50, listY: 60, alt: true, region: "list" });
  const released = releaseLayerDragLifecycle(state, { x: 45, y: 55, listY: 65, alt: false, region: "list" });
  assert.deepEqual(released, { active: true, x: 45, y: 55, listY: 65, alt: false, region: "list" });
  assert.equal(state.phase, "released");
  assert.equal(releaseLayerDragLifecycle(state, { x: 50, y: 60, listY: 70, alt: false, region: "list" }), null);
});

test("取消拖拽：Escape / helper disconnect 后不能再释放提交", () => {
  const state = createLayerDragLifecycle({ x: 0, y: 0, listY: 0, alt: false });
  activateLayerDragLifecycle(state, 8, 0);
  assert.equal(cancelLayerDragLifecycle(state), true);
  assert.equal(state.phase, "cancelled");
  assert.equal(releaseLayerDragLifecycle(state, { x: 8, y: 0, listY: 0, alt: false, region: "list" }), null);
});

test("跨面板释放交给原生参考图面板，不触发普通图层排序", () => {
  assert.equal(routeLayerDragRelease({ active: true, referenceDragStarted: true, region: "outside" }), "external");
});

test("WaveLayer 内部、删除区、工具栏和工作台释放分别走内部路由", () => {
  for (const region of ["list", "delete", "tool", "panel"] as const) {
    assert.equal(routeLayerDragRelease({ active: true, referenceDragStarted: true, region }), "internal");
  }
  assert.equal(routeLayerDragRelease({ active: true, referenceDragStarted: true, region: "workbench" }), "workbench");
});

test("没有跨面板连接时，面板外释放直接取消，不使用最后一个内部目标", () => {
  assert.equal(routeLayerDragRelease({ active: true, referenceDragStarted: false, region: "outside" }), "outside");
  assert.equal(routeLayerDragRelease({ active: false, referenceDragStarted: false, region: "outside" }), "click");
});

// ── geometry (dragGeometry.ts) ──

const layout: DragLayout = {
  panel: { left: 0, top: 0, width: 300, height: 800 },
  rows: { left: 8, top: 104, width: 284, height: 400 },
  deleteRail: { left: 8, top: 104, width: 32, height: 400 },
  tools: [{ left: 200, top: 520, width: 24, height: 24 }, null],
  workbench: { left: 8, top: 560, width: 284, height: 200 },
  buffer: 50,
};

test("校准：clientY - 面板 Y 为常数（日志里 ≈134），中位数抵抗单个异常样本", () => {
  const cal = createClientCalibration();
  addCalibrationSample(cal, 120, 416, 120, 282);
  addCalibrationSample(cal, 120, 425, 120, 291);
  addCalibrationSample(cal, 120, 478, 120, 344);
  addCalibrationSample(cal, 120, 300, 120, 0); // bogus
  assert.deepEqual(calibrationOffset(cal), { dx: 0, dy: 134 });
});

test("校准：按轴独立；没有 offsetX 时 Y 仍可用，X 默认 0", () => {
  const cal = createClientCalibration();
  assert.equal(calibrationOffset(cal), null);
  addCalibrationSample(cal, 50, 200, NaN, 66);
  assert.deepEqual(calibrationOffset(cal), { dx: 0, dy: 134 });
});

test("校准：只保留最近 limit 个样本", () => {
  const cal = createClientCalibration(3);
  for (const dy of [10, 10, 10, 50, 50, 50]) addCalibrationSample(cal, 0, dy, 0, 0);
  assert.equal(calibrationOffset(cal)?.dy, 50);
});

test("offset 可信度：越界、NaN、UXP 合成的 0/0 都拒绝", () => {
  assert.equal(plausibleAxisOffset(12, 44), true);
  assert.equal(plausibleAxisOffset(652, 44), false);
  assert.equal(plausibleAxisOffset(NaN, 44), false);
  assert.equal(syntheticOffset(0, 0), true);
  assert.equal(syntheticOffset(NaN, 0), true);
  assert.equal(syntheticOffset(3, 0), false);
});

test("区域：删除轨道 > 工具按钮 > 工作台 > 列表 > 面板 > 外部", () => {
  assert.equal(resolveDragRegion(layout, 20, 200).region, "delete");
  assert.deepEqual(resolveDragRegion(layout, 210, 530), { region: "tool", tool: 0 });
  assert.equal(resolveDragRegion(layout, 100, 600).region, "workbench");
  assert.equal(resolveDragRegion(layout, 100, 200).region, "list");
  assert.equal(resolveDragRegion(layout, 100, 780).region, "panel");
  assert.equal(resolveDragRegion(layout, -292, 618).region, "outside");
  assert.equal(resolveDragRegion(layout, 100, 900).region, "outside");
});

test("区域：列表上下 50px 缓冲带横跨整个面板宽度，但让位给更高优先级目标", () => {
  assert.equal(resolveDragRegion(layout, 2, 60).region, "list");   // above, left of the list
  assert.equal(resolveDragRegion(layout, 298, 540).region, "list"); // below, right edge
  assert.equal(resolveDragRegion(layout, 210, 530).region, "tool"); // tool inside the band wins
  assert.equal(resolveDragRegion(layout, 100, 40).region, "panel"); // past the band
});

test("落点 Y：上方缓冲 = 首个可见行上方，下方缓冲 = 最后可见行之后", () => {
  assert.equal(clampDropListY(-30, 396), 0);
  assert.equal(clampDropListY(120, 396), 120);
  assert.equal(clampDropListY(430, 396), 396);
  assert.equal(clampDropListY(NaN, 396), 0);
});

test("拖拽自动滚动：靠近上下边缘才滚，越往外越快，超出边缘到最快", async () => {
  const { edgeScrollRate } = await import("../src/core/layers/dragGeometry.ts");
  assert.equal(edgeScrollRate(200, 400), 0);
  assert.equal(edgeScrollRate(36, 400), 0);
  assert.ok(edgeScrollRate(30, 400) < 0 && edgeScrollRate(30, 400) > -10);
  assert.ok(edgeScrollRate(0, 400) < edgeScrollRate(30, 400), "deeper is faster");
  assert.equal(edgeScrollRate(-40, 400), -30);
  assert.ok(edgeScrollRate(390, 400) > 0);
  assert.equal(edgeScrollRate(450, 400), 30);
  // a short list: the zone is a third of it, the middle still doesn't scroll
  assert.equal(edgeScrollRate(30, 90), 0);
  assert.equal(edgeScrollRate(NaN, 400), 0);
});
