import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PREFS, MAX_STAGED, appendStagedLayers, clickSelection, entryStatus, groupBySource, parentPath,
  parsePrefs, parseWorkbench, rebindEntries, serializeWorkbench, stagedKey, uniqueGroupName, usable,
} from "../src/core/layers/workbench.ts";
import { sendMenu } from "../src/core/layers/contextMenu.ts";

const item = (docId: number, layerId: number, docKey = "D:/a.psd", name = "L" + layerId) =>
  ({ docId, docKey, layerId, name, kind: "pixel" });

test("工作台清单：重载后按 docKey 跟随新的文档 id；同名打开两次时不猜", () => {
  const list = [item(5, 1), item(5, 2, "D:/b.psd"), item(9, 3, "未标题-1")];
  const docs = [{ docId: 21, docKey: "D:/a.psd", name: "a.psd" }, { docId: 22, docKey: "未标题-1", name: "未标题-1" }, { docId: 23, docKey: "未标题-1", name: "未标题-1" }];
  const out = rebindEntries(list, docs);
  assert.equal(out[0].docId, 21);
  assert.equal(out[1].docId, 5); // not open
  assert.equal(out[2].docId, 9); // ambiguous
  const bound = item(21, 1);
  assert.equal(rebindEntries([bound], docs)[0], bound); // already right: the same entry
});

test("工作台状态：来源未打开、图层已删除、改名、未检查", () => {
  const docs = [{ docId: 5, docKey: "D:/a.psd", name: "a" }];
  assert.equal(entryStatus(item(6, 1), docs, { name: "L1" }), "docClosed");
  assert.equal(entryStatus(item(5, 1), docs, null), "missing");
  assert.equal(entryStatus(item(5, 1), docs, { name: "新名字" }), "renamed");
  assert.equal(entryStatus(item(5, 1), docs, { name: "L1" }), "ok");
  assert.equal(entryStatus(item(5, 1), docs, undefined), "unknown");
  assert.deepEqual(["ok", "renamed", "unknown", "missing", "docClosed"].map(s => usable(s as any)), [true, true, true, false, false]);
});

test("工作台清单：重复暂存只更新缩略图和位置，不重复；上限之外不再加入", () => {
  const a = item(5, 1);
  const out = appendStagedLayers([a], [{ ...a, thumb: "data:image/jpeg;base64,AA" }, item(5, 2)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].thumb, "data:image/jpeg;base64,AA");
  const many = Array.from({ length: MAX_STAGED + 5 }, (_, i) => item(5, i + 1));
  assert.equal(appendStagedLayers([], many).length, MAX_STAGED);
});

test("工作台持久化：往返一致；损坏或异常数据得到空清单 / 跳过无效条目", () => {
  const list = [{ ...item(5, 1), thumb: "data:image/jpeg;base64,AA", geom: { canvas: { width: 100, height: 50 }, bounds: { left: 1, top: 2, right: 3, bottom: 4 } } }, item(5, 2, "D:/b.psd")];
  assert.deepEqual(parseWorkbench(serializeWorkbench(list)), list);
  assert.deepEqual(parseWorkbench("{oops"), []);
  assert.deepEqual(parseWorkbench(null), []);
  assert.deepEqual(parseWorkbench(JSON.stringify({ entries: [{ docId: -1, layerId: 2, docKey: "x" }, { docId: 1, layerId: 2 }, 7] })), []);
  const odd = parseWorkbench(JSON.stringify({ entries: [{ ...item(1, 2), thumb: "javascript:x", geom: { canvas: { width: 0 } } }] }));
  assert.equal(odd[0].thumb, undefined);
  assert.equal(odd[0].geom, undefined);
});

test("工作台设置：默认值、旧版「置于选中图层上方」勾选迁移、非法值忽略", () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.equal(parsePrefs(null, "selected").position, "selection");
  assert.equal(parsePrefs(null, "top").position, "top");
  const p = parsePrefs(JSON.stringify({ position: "middle", wrapGroup: false, restore: "yes", groupName: "  素材  " }), "selected");
  assert.equal(p.position, "top");
  assert.equal(p.wrapGroup, false);
  assert.equal(p.restore, true);
  assert.equal(p.groupName, "素材");
});

test("工作台：单击 / Ctrl / Shift 选择和组名去重、父组路径、按来源分组", () => {
  const order = ["a", "b", "c", "d"];
  let s = clickSelection(order, new Set(), null, "b", { ctrl: false, shift: false });
  s = clickSelection(order, s.selected, s.anchor, "d", { ctrl: false, shift: true });
  assert.deepEqual([...s.selected], ["b", "c", "d"]);
  s = clickSelection(order, s.selected, s.anchor, "c", { ctrl: true, shift: false });
  assert.deepEqual([...s.selected].sort(), ["b", "d"]);
  assert.equal(uniqueGroupName(new Set(["工作台素材", "工作台素材 2"]), "工作台素材"), "工作台素材 3");
  assert.equal(uniqueGroupName(new Set(), "  "), "工作台素材");
  const parents = new Map([[3, 2], [2, 1], [1, null]]), names = new Map([[1, "画板 1"], [2, "卡片"]]);
  assert.deepEqual(parentPath(3, id => parents.get(id) ?? null, id => names.get(id) ?? ""), ["画板 1", "卡片"]);
  const groups = groupBySource([item(1, 1), item(2, 1, "D:/b.psd"), item(1, 2)]);
  assert.deepEqual(groups.map(g => [g.label, g.items.map(stagedKey)]), [["a.psd", ["1:1", "1:2"]], ["b.psd", ["2:1"]]]);
});

test("右键发送到：列出其他文档和设置；没有其他文档时给出不可用的说明", () => {
  const prefs = { restore: true, scaleWithCanvas: false, matchParents: true, position: "top" as const, switchAfter: false };
  const rows = sendMenu({ docs: [{ id: 7, name: "海报.psd" }], prefs }, 2);
  assert.equal(rows[0].id, "send:7");
  assert.ok(rows.some(r => r.id === "sendopt:restore" && r.checked));
  assert.ok(rows.some(r => r.id === "sendopt:scale" && !r.checked && r.enabled));
  const none = sendMenu({ docs: [], prefs: { ...prefs, restore: false } }, 1);
  assert.equal(none[0].enabled, false);
  assert.equal(none.find(r => r.id === "sendopt:scale")?.enabled, false);
});

test("发送设置：按长边缩放默认打开；旧的随画布缩放仍按原样", async () => {
  const { parsePrefs } = await import("../src/core/layers/workbench.ts");
  assert.equal(parsePrefs(null).scaleLongEdge, true);
  assert.equal(parsePrefs(null).scaleWithCanvas, false);
  const old = parsePrefs(JSON.stringify({ scaleWithCanvas: true }));
  assert.equal(old.scaleWithCanvas, true);
  assert.equal(old.scaleLongEdge, false);
  const both = parsePrefs(JSON.stringify({ scaleWithCanvas: true, scaleLongEdge: true }));
  assert.deepEqual([both.scaleLongEdge, both.scaleWithCanvas], [true, false]);
});
