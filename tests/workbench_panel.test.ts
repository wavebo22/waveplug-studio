import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkbenchAction, workbenchSections } from "../src/core/overlay/workbenchPanel.ts";
import { DEFAULT_PREFS, canPlace, parseWorkbench, serializeWorkbench, snapName, stateText } from "../src/core/layers/workbench.ts";

const e = (docId: number, layerId: number, extra = {}) => ({ docId, layerId, docKey: "D:/设计/a.psd", name: "L" + layerId, kind: "pixel", ...extra });
const geom = { canvas: { width: 100, height: 100 }, bounds: { left: 1, top: 1, right: 9, bottom: 9 } };

test("原生工作台：区块里有键、文档名、状态和能否置入；快照让关闭的来源仍可置入", () => {
  const list = [e(1, 5), e(2, 6, { snap: "wb_x_6.png", geom }), e(2, 7)];
  const st = (x: { docId: number }) => x.docId === 1 ? "ok" as const : "docClosed" as const;
  const s = workbenchSections(list, st, { ...DEFAULT_PREFS, position: "selection" }, { target: "海报.psd", busy: false, status: "" });
  assert.deepEqual(s.entries.map(x => [x.key, x.doc, x.state, x.usable]), [
    ["1:5", "a.psd", "", true], ["2:6", "a.psd", "来源未打开 · 用快照", true], ["2:7", "a.psd", "来源未打开", false],
  ]);
  assert.equal(s.summary.positionSelection, true);
  assert.equal(canPlace(e(2, 7, { snap: "wb_x_7.png" }), "missing"), false); // no geometry: nowhere to put it
  assert.equal(stateText(e(1, 1), "ok"), "");
});

test("原生工作台：动作只接受合法的键和设置", () => {
  assert.deepEqual(parseWorkbenchAction({ kind: "place", keys: ["1:2", "3:4"] }), { kind: "place", keys: ["1:2", "3:4"] });
  assert.equal(parseWorkbenchAction({ kind: "place", keys: ["1:2", "x"] }), null);
  assert.equal(parseWorkbenchAction({ kind: "remove" }), null);
  assert.deepEqual(parseWorkbenchAction({ kind: "pref", name: "position", value: "selection" }), { kind: "pref", name: "position", value: "selection" });
  assert.equal(parseWorkbenchAction({ kind: "pref", name: "position", value: "middle" }), null);
  assert.equal(parseWorkbenchAction({ kind: "pref", name: "switchAfter", value: true }), null);
  assert.deepEqual(parseWorkbenchAction({ kind: "stage-drop", docId: 7, layerIds: [1, -2, "x", 3] }), { kind: "stage-drop", docId: 7, layerIds: [1, 3] });
  assert.deepEqual(parseWorkbenchAction({ kind: "drag-out-end", ending: "released" }), { kind: "drag-out-end", ending: "released" });
  assert.equal(parseWorkbenchAction({ kind: "rm -rf" }), null);
  assert.equal(parseWorkbenchAction(null), null);
});

test("快照文件名：同文档同图层稳定，不同文档不同；持久化只接受合法名字", () => {
  assert.equal(snapName("D:/a.psd", 5), snapName("D:/a.psd", 5));
  assert.notEqual(snapName("D:/a.psd", 5), snapName("D:/b.psd", 5));
  assert.match(snapName("未标题-1", 12), /^wb_[0-9a-z]+_12\.png$/);
  const back = parseWorkbench(serializeWorkbench([e(1, 2, { snap: snapName("x", 2) }), e(1, 3, { snap: "../../evil.png" })]));
  assert.equal(back[0].snap, snapName("x", 2));
  assert.equal(back[1].snap, undefined);
});
