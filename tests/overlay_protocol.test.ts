import { test } from "node:test";
import assert from "node:assert/strict";
import { docToScreen, parseOverlayEvent, selectionKey } from "../src/core/overlay/protocol.ts";
import { changedSections } from "../src/core/overlay/sections.ts";
import { type GenerateSections, parseGenerateAction as parsePanelAction } from "../src/core/overlay/generatePanel.ts";

const panelWanted = (docId: number | null, sel: unknown) => docId !== null && !!sel;
type PanelSections = GenerateSections;

test("外置生成面板：选区按 PS 视图换算到屏幕坐标", () => {
  // 11-04 实测：1080×1759 文档在 100% 下居中，视图 globalBounds 1008,139–3037,2087
  const view = { view: { left: 1008, top: 139, right: 3037, bottom: 2087 }, center: { x: 540.25, y: 879 }, zoom: 1 };
  assert.deepEqual(docToScreen({ left: 540, top: 879, right: 640, bottom: 979 }, view), { left: 2022, top: 1113, right: 2122, bottom: 1213 });
  // Photoshop's `center` is already zoom-scaled (docToScreen since 11-05; the 11-05 log at 200%
  // reported center ≈ 2 × the document point), so at 50% the same view centre reads half as far
  assert.deepEqual(docToScreen({ left: 340, top: 879, right: 540, bottom: 1079 }, { ...view, center: { x: 270.125, y: 439.5 }, zoom: 0.5 }), { left: 1922, top: 1113, right: 2022, bottom: 1213 });
});

test("外置生成面板：只由选区决定显示，不看模式", () => {
  const r = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(panelWanted(1, r), true);
  assert.equal(panelWanted(1, null), false);
  assert.equal(panelWanted(null, r), false);
  assert.equal(selectionKey(1, r), "1:0,0,10,10");
  assert.equal(selectionKey(null, r), "");
});

test("外附介面：只发变化的区块，重连后全部重发", () => {
  const base: PanelSections = {
    mode: "blend", prompt: "", hint: "可选", favorites: ["a"], refs: [{ slot: 1, tag: null, name: null }], count: 1,
    action: "融图", blocked: null, params: [{ kind: "toggle", key: "fullRun", label: "完整运行", value: false, tip: "" }],
    run: null, status: { tone: "info", text: "就绪" },
  };
  const sent = new Map<string, string>();
  assert.deepEqual(Object.keys(changedSections(sent, base)!).sort(), ["action", "blocked", "count", "favorites", "hint", "mode", "params", "prompt", "refs", "run", "status"]);
  assert.equal(changedSections(sent, base), null);
  assert.deepEqual(changedSections(sent, { ...base, prompt: "杯子", count: 2 }), { prompt: "杯子", count: 2 });
  const refsSent = new Map<string, string>();
  changedSections(refsSent, base);
  assert.deepEqual(changedSections(refsSent, {
    ...base,
    refs: [{ slot: 1, tag: "图2", name: "ref.png", thumb: "data:image/png;base64,AAAA" }],
  }), { refs: [{ slot: 1, tag: "图2", name: "ref.png", thumb: "data:image/png;base64,AAAA" }] });
  assert.deepEqual(changedSections(sent, { ...base, prompt: "杯子", count: 2, run: { stage: "生成中", progress: 0.5 } }), { run: { stage: "生成中", progress: 0.5 } });
  assert.equal(Object.keys(changedSections(new Map(), base)!).length, 11);
});

test("外附介面：只接受格式正确的消息；操作由各介面自己检查", () => {
  assert.deepEqual(parseOverlayEvent('{"type":"action","panel":"generate","action":{"kind":"set-mode","mode":"extract"}}'),
    { type: "action", panel: "generate", action: { kind: "set-mode", mode: "extract" } });
  assert.deepEqual(parseOverlayEvent('{"type":"view-request","panel":"generate"}'), { type: "view-request", panel: "generate" });
  assert.deepEqual(parseOverlayEvent('{"type":"ready","version":"0.2.0"}'), { type: "ready", version: "0.2.0" });
  assert.deepEqual(parseOverlayEvent('{"type":"comfy-status","state":"not-configured","message":"ComfyUI 未设置","owned":false}'),
    { type: "comfy-status", state: "not-configured", message: "ComfyUI 未设置", owned: false });
  assert.deepEqual(parseOverlayEvent('{"type":"comfy-status","state":"ready","message":"已启动","owned":true}'),
    { type: "comfy-status", state: "ready", message: "已启动", owned: true });
  assert.deepEqual(parseOverlayEvent('{"type":"comfy-status","state":"autostart-disabled","message":"已关闭自动启动","owned":false}'),
    { type: "comfy-status", state: "autostart-disabled", message: "已关闭自动启动", owned: false });
  assert.equal(parseOverlayEvent('{"type":"comfy-status","state":"unknown","message":"x","owned":false}'), null);
  assert.equal(parseOverlayEvent('{"type":"action","action":{"kind":"generate"}}'), null); // no panel
  assert.equal(parseOverlayEvent("not json"), null);
  assert.deepEqual(parsePanelAction({ kind: "set-count", count: 9 }), { kind: "set-count", count: 4 });
  assert.deepEqual(parsePanelAction({ kind: "add-ref", slot: 1, source: "layer" }), { kind: "add-ref", slot: 1, source: "layer" });
  assert.deepEqual(parsePanelAction({ kind: "add-ref", slot: 2, source: "file" }), { kind: "add-ref", slot: 2, source: "file" });
  assert.deepEqual(parsePanelAction({ kind: "add-ref", slot: 3, source: "clipboard" }), { kind: "add-ref", slot: 3, source: "clipboard" });
  assert.deepEqual(parsePanelAction({ kind: "drop-ref", slot: 2, docId: 7, layerId: 42, name: "产品图层" }),
    { kind: "drop-ref", slot: 2, docId: 7, layerId: 42, name: "产品图层" });
  assert.deepEqual(parsePanelAction({ kind: "drop-refs", slot: 2, docId: 7, layers: [{ layerId: 42, name: "产品图层" }, { layerId: 43, name: "杯子" }], totalCount: 2 }),
    { kind: "drop-refs", slot: 2, docId: 7, layers: [{ layerId: 42, name: "产品图层" }, { layerId: 43, name: "杯子" }], totalCount: 2 });
  assert.equal(parsePanelAction({ kind: "drop-refs", slot: 8, docId: 7, layers: Array.from({ length: 8 }, (_, i) => ({ layerId: i + 1, name: `图层 ${i + 1}` })), totalCount: 8 })?.kind, "drop-refs");
  assert.equal(parsePanelAction({ kind: "drop-refs", slot: 9, docId: 7, layers: [{ layerId: 42, name: "产品图层" }], totalCount: 1 }), null);
  assert.equal(parsePanelAction({ kind: "drop-refs", slot: 1, docId: 7, layers: Array.from({ length: 9 }, (_, i) => ({ layerId: i + 1, name: `图层 ${i + 1}` })), totalCount: 9 }), null);
  assert.equal(parsePanelAction({ kind: "drop-refs", slot: 9, docId: 7, layers: [{ layerId: 42, name: "产品图层" }], totalCount: 1 }), null);
  assert.equal(parsePanelAction({ kind: "drop-refs", slot: 1, docId: 7, layers: [], totalCount: 0 }), null);
  assert.equal(parsePanelAction({ kind: "drop-ref", slot: 0, docId: 7, layerId: 42, name: "产品图层" }), null);
  assert.equal(parsePanelAction({ kind: "drop-ref", slot: 1, docId: -1, layerId: 42, name: "产品图层" }), null);
  assert.deepEqual(parsePanelAction({ kind: "finish-layer-drag" }), { kind: "finish-layer-drag" });
  assert.equal(parsePanelAction({ kind: "add-ref", slot: 1, source: "remote" }), null);
  assert.deepEqual(parsePanelAction({ kind: "remove-ref", slot: 1 }), { kind: "remove-ref", slot: 1 });
  assert.deepEqual(parsePanelAction({ kind: "set-number", key: "3.steps", value: 12 }), { kind: "set-number", key: "3.steps", value: 12 });
  assert.equal(parsePanelAction({ kind: "set-number", key: "3.steps" }), null);
  assert.equal(parsePanelAction({ kind: "set-toggle", key: "x", value: "yes" }), null);
  assert.equal(parsePanelAction({ kind: "nope" }), null);
});
