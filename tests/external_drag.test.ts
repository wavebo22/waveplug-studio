import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginExternalExport, createExternalDragSession, endExternalDrag, externalDragCandidates, externalDragOver,
  externalDragSessionId, finishExternalExport, helperCopiedExternalFiles, helperFinishedExternalDrag,
  recordExportedFile, shouldPrepareExternalDrag,
} from "../src/core/overlay/externalDrag.ts";

const LAYERS = [
  { id: 1, name: "标题", kind: "text" },
  { id: 2, name: "组", kind: "group" },
  { id: 3, name: "瓶子", kind: "pixel" },
  { id: 4, name: "背景", kind: "background" },
];
const file = (layerId: number, order: number) => ({ layerId, name: `L${layerId}`, path: `C:\\t\\waveplug_drag_s_${order}.png`, order });

test("跨软件拖拽：sessionId 唯一且只含小写字母和数字", () => {
  const a = externalDragSessionId(1_700_000_000_000, () => 0.1);
  const b = externalDragSessionId(1_700_000_000_000, () => 0.2);
  assert.match(a, /^[a-z0-9]+$/);
  assert.notEqual(a, b);
  assert.notEqual(externalDragSessionId(), externalDragSessionId());
});

test("跨软件拖拽：候选是选中的非组图层，按列表顺序；子项拖拽没有候选", () => {
  assert.deepEqual(externalDragCandidates(LAYERS, [4, 3, 2, 1], false),
    [{ layerId: 1, name: "标题", kind: "text" }, { layerId: 3, name: "瓶子", kind: "pixel" }, { layerId: 4, name: "背景", kind: "background" }]);
  assert.deepEqual(externalDragCandidates(LAYERS, [2], false), []);
  assert.deepEqual(externalDragCandidates(LAYERS, [3], true), []);
});

test("跨软件拖拽：只在第一次离开面板时准备导出", () => {
  const base = { active: true, previousRegion: "list" as const, region: "outside" as const, started: false, candidates: 2, connected: true, sub: false };
  assert.equal(shouldPrepareExternalDrag(base), true);
  assert.equal(shouldPrepareExternalDrag({ ...base, region: "list" }), false); // 列表内重排
  assert.equal(shouldPrepareExternalDrag({ ...base, region: "panel" }), false);
  assert.equal(shouldPrepareExternalDrag({ ...base, started: true }), false);
  assert.equal(shouldPrepareExternalDrag({ ...base, previousRegion: "outside" }), false);
  assert.equal(shouldPrepareExternalDrag({ ...base, candidates: 0 }), false);
  assert.equal(shouldPrepareExternalDrag({ ...base, connected: false }), false);
  assert.equal(shouldPrepareExternalDrag({ ...base, sub: true }), false);
  assert.equal(shouldPrepareExternalDrag({ ...base, active: false }), false);
});

test("跨软件拖拽：导出完成且仍在拖拽 → ready；files-copied 删一次文件；finished 后结束不再 cancel", () => {
  const s = createExternalDragSession("s", 7, [{ layerId: 1, name: "a" }, { layerId: 3, name: "b" }]);
  assert.equal(s.phase, "idle");
  assert.equal(beginExternalExport(s), true);
  assert.equal(beginExternalExport(s), false);
  assert.equal(recordExportedFile(s, file(1, 0)), true);
  assert.equal(finishExternalExport(s, true), false); // 还差一个文件
  assert.equal(recordExportedFile(s, file(3, 1)), true);
  assert.equal(finishExternalExport(s, true), true);
  assert.equal(s.phase, "ready");
  assert.equal(helperCopiedExternalFiles(s), true);
  assert.equal(helperCopiedExternalFiles(s), false);
  assert.equal(helperFinishedExternalDrag(s), true);
  assert.equal(s.phase, "handedOff");
  assert.deepEqual(endExternalDrag(s), { sendCancel: false, removeFiles: false });
  assert.equal(externalDragOver(s), true);
  assert.equal(helperFinishedExternalDrag(s), false);
});

test("跨软件拖拽：导出途中松手 → cancel、删文件，之后导出的文件立即删除且不发 ready", () => {
  const s = createExternalDragSession("s", 7, [{ layerId: 1, name: "a" }, { layerId: 3, name: "b" }]);
  beginExternalExport(s);
  recordExportedFile(s, file(1, 0));
  assert.deepEqual(endExternalDrag(s), { sendCancel: true, removeFiles: true });
  assert.equal(s.phase, "cancelled");
  assert.equal(recordExportedFile(s, file(3, 1)), false);
  assert.equal(finishExternalExport(s, false), false);
  assert.equal(helperFinishedExternalDrag(s), false);
  assert.deepEqual(endExternalDrag(s), { sendCancel: false, removeFiles: false });
  assert.equal(externalDragOver(s), true);
});

test("跨软件拖拽：拖拽已结束时导出完成不发 ready；ready 后未接管就松手 → cancel", () => {
  const s = createExternalDragSession("s", 7, [{ layerId: 1, name: "a" }]);
  beginExternalExport(s);
  recordExportedFile(s, file(1, 0));
  assert.equal(finishExternalExport(s, false), false);
  assert.equal(s.phase, "exporting");

  const r = createExternalDragSession("r", 7, [{ layerId: 1, name: "a" }]);
  beginExternalExport(r);
  recordExportedFile(r, file(1, 0));
  finishExternalExport(r, true);
  assert.deepEqual(endExternalDrag(r), { sendCancel: true, removeFiles: true });
});

test("跨软件拖拽：prepare 没发出去（idle）结束时不发 cancel", () => {
  const s = createExternalDragSession("s", 7, [{ layerId: 1, name: "a" }]);
  assert.deepEqual(endExternalDrag(s), { sendCancel: false, removeFiles: true });
  assert.equal(s.phase, "cancelled");
  assert.equal(beginExternalExport(s), false);
});

test("跨软件拖拽：一次最多 20 个图层，多出来的不导出", async () => {
  const { capExternalLayers, MAX_EXTERNAL_LAYERS } = await import("../src/core/overlay/externalDrag.ts");
  const many = Array.from({ length: 23 }, (_, i) => i);
  const { layers, leftOut } = capExternalLayers(many);
  assert.equal(layers.length, MAX_EXTERNAL_LAYERS);
  assert.deepEqual(layers.slice(0, 2), [0, 1]);
  assert.equal(leftOut, 3);
  assert.deepEqual(capExternalLayers([1, 2]), { layers: [1, 2], leftOut: 0 });
});

test("跨软件拖拽：复用键随插件加载、文档、历史状态、图层变化；历史状态未知时不复用", async () => {
  const { externalDragKey } = await import("../src/core/overlay/externalDrag.ts");
  const k = externalDragKey("load1", 60, "41", 7);
  assert.equal(k, "load1:60:41:7");
  assert.notEqual(externalDragKey("load2", 60, "41", 7), k);
  assert.notEqual(externalDragKey("load1", 60, "42", 7), k);
  assert.notEqual(externalDragKey("load1", 61, "41", 7), k);
  assert.equal(externalDragKey("load1", 60, null, 7), "");
});

test("跨软件拖拽：helper 已有的图层版本不再导出，没有键的一律导出", async () => {
  const { layersToExport } = await import("../src/core/overlay/externalDrag.ts");
  const layers = [{ layerId: 1, name: "a", key: "k1" }, { layerId: 2, name: "b", key: "k2" }, { layerId: 3, name: "c", key: "" }];
  assert.deepEqual(layersToExport(layers, new Set(["k1"])).map(l => l.layerId), [2, 3]);
  assert.deepEqual(layersToExport(layers, new Set()).map(l => l.layerId), [1, 2, 3]);
});

test("跨软件拖拽：放下后状态栏告诉用户结果，取消不提示", async () => {
  const { externalDragResultText } = await import("../src/core/overlay/externalDrag.ts");
  assert.deepEqual(externalDragResultText("dropped", "微信", 2), { text: "已把 2 个图层复制到 微信", kind: "ok" });
  assert.deepEqual(externalDragResultText("dropped", "", undefined), { text: "已把 1 个图层复制到 目标程序", kind: "ok" });
  assert.deepEqual(externalDragResultText("rejected", "微信", 1), { text: "微信 没有接收这些文件", kind: "error" });
  assert.equal(externalDragResultText("error", "", 0)?.kind, "error");
  assert.equal(externalDragResultText("cancelled", "微信", 1), null);
  assert.equal(externalDragResultText("cancelled", "Photoshop", 1)?.kind, "info");
  assert.deepEqual(externalDragResultText("dropped", "Illustrator", 3, "embed"), { text: "已把 3 个图层嵌入 Illustrator（文字和形状可编辑）", kind: "ok" });
  assert.equal(externalDragResultText("error", "Illustrator", 1, "embed")?.text, "导入 Illustrator 失败；松手时按住 Alt 可改用普通拖放");
});
