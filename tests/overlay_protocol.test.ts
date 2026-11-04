import { test } from "node:test";
import assert from "node:assert/strict";
import { docToScreen, overlayStep, parseOverlayEvent, selectionKey } from "../src/core/overlay/protocol.ts";

test("浮动生成条：选区按 PS 视图换算到屏幕坐标", () => {
  // 11-04 实测：1080×1759 文档在 100% 下居中，视图 globalBounds 1008,139–3037,2087
  const view = { view: { left: 1008, top: 139, right: 3037, bottom: 2087 }, center: { x: 540.25, y: 879 }, zoom: 1 };
  assert.deepEqual(docToScreen({ left: 540, top: 879, right: 640, bottom: 979 }, view), { left: 2022, top: 1113, right: 2122, bottom: 1213 });
  // 50%：离中心的距离减半
  assert.deepEqual(docToScreen({ left: 340, top: 879, right: 540, bottom: 1079 }, { ...view, zoom: 0.5 }), { left: 1922, top: 1113, right: 2022, bottom: 1213 });
});

test("浮动生成条：新选区弹出、选区不变不动、取消选区收起、面板刚打开时不弹", () => {
  const a = selectionKey(1, { left: 0, top: 0, right: 100, bottom: 80 });
  const b = selectionKey(1, { left: 10, top: 0, right: 100, bottom: 80 });
  assert.equal(overlayStep(null, a), null);
  assert.equal(overlayStep("", a), "show");
  assert.equal(overlayStep(a, a), null);
  assert.equal(overlayStep(a, b), "show");
  assert.equal(overlayStep(b, ""), "hide");
  assert.equal(overlayStep("", ""), null);
  assert.equal(selectionKey(null, { left: 0, top: 0, right: 1, bottom: 1 }), "");
  assert.equal(selectionKey(2, null), "");
});

test("浮动生成条：只接受格式正确的消息，数量限制在 1～4", () => {
  assert.deepEqual(parseOverlayEvent('{"type":"generate","prompt":"红色陶瓷杯","count":2}'), { type: "generate", prompt: "红色陶瓷杯", count: 2 });
  assert.deepEqual(parseOverlayEvent('{"type":"generate","prompt":"x","count":9}'), { type: "generate", prompt: "x", count: 4 });
  assert.deepEqual(parseOverlayEvent('{"type":"ready","version":"0.1.0"}'), { type: "ready", version: "0.1.0" });
  assert.equal(parseOverlayEvent('{"type":"generate","count":1}'), null);
  assert.equal(parseOverlayEvent("not json"), null);
});
