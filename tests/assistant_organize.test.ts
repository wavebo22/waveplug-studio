import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, buildTree } from "../src/core/layers/tree.ts";
import { chosenPlan, describeLayers, organizeLookIds, organizeScope, organizeUserPrompt, parseOrganizePlan, textLayerName, textRenames, unclearName } from "../src/core/assistant/organize.ts";

const L = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, width: 100, height: 40, left: 10, top: 20, ...extra });
const end = (): RawLayer => ({ id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false });

// top to bottom
const tree = buildTree([
  L(1, "图层 5", 3),
  L(2, "矩形 1", 4),
  L(3, "图层 4", 1, { clipped: true }),
  L(4, "图层 3", 1),
  L(5, "组 1", 7), L(6, "图层 2", 1), L(7, "图层 1 拷贝", 1), end(),
  L(10, "AI填充 · 橘子", 7), L(11, "v1 · 橘子", 5, { contentId: "v1" }), end(),
  L(20, "画板 1", 7, { artboard: true }), L(21, "图标", 1), end(),
  L(99, "背景", 1, { background: true }),
]);

test("AI 整理的范围：只选一个普通图层时是整个文档，不含背景和 AI 组内部", () => {
  const s = organizeScope(tree, new Set([2]));
  assert.equal(s.label, "整个文档");
  assert.deepEqual(s.ids, [1, 2, 3, 4, 5, 6, 7, 10, 20, 21]);
});

test("AI 整理的范围：选中组时是组和组内；选中多个时是它们", () => {
  assert.deepEqual(organizeScope(tree, new Set([5])), { ids: [5, 6, 7], label: "组「组 1」" });
  assert.deepEqual(organizeScope(tree, new Set([1, 2])).ids, [1, 2]);
});

test("发给模型的描述：范围外的父组标 fixed，文字内容单行", () => {
  const lines = describeLayers(tree, [6, 7], new Map([[6, "立即\r购买"]])).split("\n").map(s => JSON.parse(s));
  assert.deepEqual(lines.map(o => o.id), [5, 6, 7]);
  assert.equal(lines[0].fixed, true);
  assert.equal(lines[1].text, "立即 购买");
  assert.deepEqual(lines[1].box, [10, 20, 100, 40]);
  assert.equal(lines[1].parent, 5);
  assert.ok(organizeUserPrompt("x", { width: 1080, height: 1920, renameOnly: true, extra: "用英文\n" }).includes("只重命名"));
});

test("改名：范围外、背景、AI 组和没变的名字都不改", () => {
  const scope = organizeScope(tree, new Set([2])).ids;
  const p = parseOrganizePlan({ renames: [
    { id: 1, name: " 主标题\n" }, { id: 99, name: "底图" }, { id: 10, name: "橘子" }, { id: 11, name: "x" }, { id: 2, name: "矩形 1" }, { id: "4", name: "人物" }, { id: 404, name: "?" },
  ] }, tree, scope);
  // 1 is a text layer: named by its words, never by the model
  assert.deepEqual(p.renames, [{ id: 4, from: "图层 3", to: "人物" }]);
  assert.equal(p.dropped.length, 4);
  // its words' name is what a re-check (with the texts) keeps
  assert.deepEqual(parseOrganizePlan({ renames: [{ id: 1, name: "主标题" }] }, tree, scope, { texts: new Map([[1, "主标题\n副标题"]]) }).renames, [{ id: 1, from: "图层 5", to: "主标题" }]);
});

test("命名规范：只改看不出内容的名字，不按隐藏 / 锁定等状态起名；文字图层用文案", () => {
  for (const n of ["图层 3", "矩形 1 拷贝 2", "组 4", "Layer 1 copy", "IMG_2041.jpg", "微信图片_20240101", "未标题-1", "12", "a", "形状"]) assert.ok(unclearName(n), n);
  for (const n of ["主标题", "按钮-购买", "logo", "产品图 2"]) assert.ok(!unclearName(n), n);
  const named = buildTree([L(1, "产品主图", 1), L(2, "图层 7", 1, { visible: false }), L(3, "形状 2", 4)]);
  const p = parseOrganizePlan({ renames: [{ id: 1, name: "商品图" }, { id: 2, name: "隐藏图层" }, { id: 3, name: "按钮底" }] }, named, [1, 2, 3]);
  assert.deepEqual(p.renames.map(r => r.to), ["按钮底"]);
  assert.match(p.dropped.join(), /不按隐藏/);
  assert.equal(parseOrganizePlan({ groups: [{ name: "隐藏的图层", ids: [2, 3] }] }, named, [1, 2, 3]).groups.length, 0);
  assert.deepEqual(textRenames(tree, [1, 6], new Map([[1, "  夏日\n大促 "], [6, "图层 2"]])), [{ id: 1, from: "图层 5", to: "夏日" }]);
  assert.equal(textLayerName("x".repeat(40)).length, 30);
  // what DeepSeek is told: no hidden flag, text layers and clear names marked
  const lines = describeLayers(named, [1, 2, 3], new Map()).split("\n").map(l => JSON.parse(l));
  assert.ok(lines.every(l => !("hidden" in l)));
  assert.equal(lines[0].keepName, true);
  assert.equal(lines[1].keepName, undefined);
});

test("归组：只收相邻的同级图层，不拆剪贴蒙版，不含画板和背景", () => {
  const scope = organizeScope(tree, new Set([2])).ids;
  // 3 is clipped to 4: [2, 3] would split the chain, [2, 3, 4] keeps it
  assert.equal(parseOrganizePlan({ groups: [{ name: "按钮", ids: [2, 3] }] }, tree, scope).groups.length, 0);
  assert.deepEqual(parseOrganizePlan({ groups: [{ name: "按钮", ids: [4, 2, 3] }] }, tree, scope).groups, [{ name: "按钮", ids: [2, 3, 4], parentId: null }]);
  // 1 and 4 are not adjacent → two runs? no: 1 alone and 4 alone are too small
  const far = parseOrganizePlan({ groups: [{ name: "散", ids: [1, 4] }] }, tree, scope);
  assert.equal(far.groups.length, 0);
  assert.ok(far.dropped[0].includes("不相邻，没建"));
  // the artboard, the background and a layer of another parent are refused
  const mixed = parseOrganizePlan({ groups: [{ name: "混", ids: [20, 99, 6, 1, 2] }] }, tree, scope);
  assert.deepEqual(mixed.groups.map(g => g.ids), [[1, 2]]);
  assert.ok(mixed.dropped.some(d => d.includes("不在同一层级")));
  // all children of a group: pointless
  assert.equal(parseOrganizePlan({ groups: [{ name: "全部", ids: [6, 7] }] }, tree, scope).groups.length, 0);
  // a layer goes into one new group only
  const twice = parseOrganizePlan({ groups: [{ name: "A", ids: [1, 2] }, { name: "B", ids: [2, 3, 4] }] }, tree, scope);
  // B keeps what is left: 3 (clipped) with its base 4
  assert.deepEqual(twice.groups.map(g => [g.name, g.ids]), [["A", [1, 2]], ["B", [3, 4]]]);
  assert.ok(twice.dropped.some(d => d.includes("已在别的新组里")));
});

test("只发送勾选的项", () => {
  const scope = organizeScope(tree, new Set([2])).ids;
  const p = parseOrganizePlan({ renames: [{ id: 2, name: "按钮底" }, { id: 4, name: "人物" }], groups: [{ name: "标题区", ids: [1, 2] }] }, tree, scope);
  assert.deepEqual(chosenPlan(p, new Set([4]), new Set()), { renames: [{ id: 2, name: "按钮底" }], groups: [{ name: "标题区", ids: [1, 2] }] });
  assert.deepEqual(chosenPlan(p, new Set(), new Set([0])).groups, []);
});

test("参考图层画面：只给范围内看不出内容的像素图层和智能对象上总览图；提示里说清编号、第几张第几格对应哪个图层", () => {
  const t2 = buildTree([L(1, "图层 1", 1), L(2, "产品主图", 1), L(3, "形状 1", 4), L(4, "IMG_2041.jpg", 5), L(5, "图层 9", 1), L(6, "标题", 3)]);
  assert.deepEqual(organizeLookIds(t2, [1, 2, 3, 4, 5, 6]), { ids: [1, 4, 5], more: 0 });
  assert.deepEqual(organizeLookIds(t2, [1, 2, 3, 4, 5, 6], 2), { ids: [1, 4], more: 1 });
  assert.deepEqual(organizeLookIds(t2, [2, 6]).ids, []);
  const cells = [{ n: 1, id: 1, sheet: 0, row: 0, col: 0 }, { n: 2, id: 4, sheet: 0, row: 0, col: 1 }];
  const u = organizeUserPrompt("{}", { width: 100, height: 100, renameOnly: false, extra: "", pictures: { overview: true, cells } });
  assert.match(u, /第 1 张附图是整个画面/);
  assert.match(u, /第 2 张附图是图层缩略图拼成的总览图/);
  assert.match(u, /编号 1 = id 1（第 2 张第 1 行第 1 格），编号 2 = id 4（第 2 张第 1 行第 2 格）/);
  // no whole picture: the sheet is the first
  assert.match(organizeUserPrompt("{}", { width: 100, height: 100, renameOnly: false, extra: "", pictures: { overview: false, cells } }), /编号 2 = id 4（第 1 张第 1 行第 2 格）/);
  assert.ok(!/附图/.test(organizeUserPrompt("{}", { width: 100, height: 100, renameOnly: false, extra: "" })));
});
