import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_KEYS, hintItems, messageLife, pushMessage, stateParts, type HintMessage } from "../src/core/layers/hints.ts";

test("hints: a row lists selection clicks; held Ctrl lights the Ctrl one only", () => {
  const items = hintItems({ mode: "idle", zone: "row", keys: { ...NO_KEYS, ctrl: true } });
  assert.equal(items[0].label, "选中");
  assert.deepEqual(items.filter(i => i.on).map(i => i.label), ["加选 / 减选"]);
  assert.ok(items.some(i => i.label === "图层样式"));
  assert.ok(hintItems({ mode: "idle", zone: "name", keys: NO_KEYS }).some(i => i.label === "重命名"));
});

test("hints: masks, thumbnails of smart objects, editing target", () => {
  const mask = hintItems({ mode: "idle", zone: "mask", keys: { ctrl: false, shift: true, alt: true } });
  assert.deepEqual(mask.filter(i => i.on).map(i => i.label), ["红色叠加"]);
  const smart = hintItems({ mode: "idle", zone: "thumb", kind: "smartObject", keys: NO_KEYS });
  assert.ok(smart.some(i => i.label === "编辑智能对象内容"));
  const row = hintItems({ mode: "idle", zone: "row", target: "mask", keys: NO_KEYS });
  assert.match(row[row.length - 1].label, /作用在图层蒙版上/);
});

test("hints: drags say what letting go does where", () => {
  const list = hintItems({ mode: "drag", drag: { region: "list", canDelete: true }, keys: { ...NO_KEYS, alt: true } });
  assert.deepEqual(list.filter(i => i.on).map(i => i.label), ["复制到这里"]);
  assert.equal(hintItems({ mode: "drag", drag: { region: "trash", canDelete: false, sub: "mask" }, keys: NO_KEYS })[0].label, "这些图层蒙版不能删除");
  assert.equal(hintItems({ mode: "drag", drag: { region: "tool", tool: "groupLayers", canDelete: true }, keys: NO_KEYS })[0].label, "从图层新建组");
  const out = hintItems({ mode: "drag", drag: { region: "outside", canDelete: true, export: { done: 1, total: 3, ready: false } }, keys: NO_KEYS });
  assert.equal(out[0].label, "正在准备 1/3 个文件…");
});

test("hints: file drops — embed at the line, Alt links", () => {
  const items = hintItems({ mode: "fileDrag", fileDrag: { count: 2, fromWeb: false }, keys: { ...NO_KEYS, alt: true } });
  assert.equal(items[0].label, "嵌入 2 个文件到插入线位置");
  assert.deepEqual(items.filter(i => i.on).map(i => i.label), ["改为链接"]);
});

test("state: filters, modes and the helper", () => {
  const parts = stateParts({ docOpen: true, selection: "已选 2 个图层", filter: { active: true, paused: false, shown: 3, total: 40, what: "文字图层" }, native: true, shortcutsOff: false, helper: false });
  assert.deepEqual(parts.map(p => p.text), ["helper 未连接", "已筛选 3/40 · 文字图层", "原版命令", "已选 2 个图层"]);
  assert.equal(parts[1].action, "clearFilters");
  assert.deepEqual(stateParts({ docOpen: false, selection: "", filter: { active: false, paused: false, shown: 0, total: 0, what: "" }, native: false, shortcutsOff: false, helper: true }), []);
});

test("messages: a busy line is replaced by its result; errors stay", () => {
  let list: HintMessage[] = [];
  list = pushMessage(list, { text: "正在删除…", kind: "busy", at: 1 });
  list = pushMessage(list, { text: "已删除 2 个图层", kind: "ok", at: 2 });
  assert.deepEqual(list.map(m => m.text), ["已删除 2 个图层"]);
  for (let i = 0; i < 15; i++) list = pushMessage(list, { text: "m" + i, kind: "info", at: 3 + i });
  assert.equal(list.length, 10);
  assert.equal(messageLife("error"), null);
  assert.equal(messageLife("ok"), 4000);
});
