import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, buildTree } from "../src/core/layers/tree.ts";
import { selectMenu, selectSet } from "../src/core/layers/selectSets.ts";

const raw = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, ...extra });
const end = (): RawLayer => ({ id: 0, name: "</Layer group>", kind: 13, section: "end", visible: true, locked: false, mask: false });

const px = { width: 10, height: 10 };
// 标题 | AI填充 · 杯子 { v2, v1 } | 组 { 徽章, 内组(隐藏) { 文字(隐藏), 图 }, 空 } | 说明 | 草稿(隐藏) | 背景
const tree = () => buildTree([
  raw(1, "标题", 3, { color: "red", links: [40] }),
  raw(10, "AI填充 · 杯子", 7), raw(11, "v2 · 橘子汁", 1, px), raw(12, "v1 · 橘子汁", 1, { ...px, visible: false }), end(),
  raw(20, "组", 7),
  raw(21, "徽章", 5, { contentId: "a", file: "徽章.psb", color: "red" }),
  raw(22, "内组", 7, { visible: false }), raw(23, "文字", 3, { visible: false }), raw(24, "图", 1, px), end(),
  raw(25, "空", 1),
  end(),
  raw(40, "说明", 3, { color: "blue", links: [1] }),
  raw(41, "草稿", 1, { ...px, visible: false }),
  raw(50, "背景", 1, { ...px, background: true, locked: true }),
]);
const pick = (which: Parameters<typeof selectSet>[2], ...sel: number[]) => selectSet(tree(), new Set(sel), which);

test("选择 › 所有图层: everything but the background and the versions inside a 变体图层", () => {
  assert.deepEqual(pick("all"), [1, 10, 20, 21, 22, 23, 24, 25, 40, 41]);
});

test("选择 › 相似图层: the same kind; a 变体图层 is a kind of its own, not a group", () => {
  assert.deepEqual(pick("similar", 1), [1, 23, 40]);
  assert.deepEqual(pick("similar", 20), [20, 22]);
  assert.deepEqual(pick("similar", 10), [10]);
  // two kinds selected: both kinds
  assert.deepEqual(pick("similar", 1, 21), [1, 21, 23, 40]);
});

test("选择 › 相同颜色 / 链接 / 同一组内", () => {
  assert.deepEqual(pick("sameColor", 1), [1, 21]);
  assert.deepEqual(pick("sameColor", 24), []);
  assert.deepEqual(pick("linked", 40), [1, 40]);
  assert.deepEqual(pick("linked", 24), [24]);
  // 同一组内: the layers beside it, the background left out at the outermost level
  assert.deepEqual(pick("siblings", 24), [23, 24]);
  assert.deepEqual(pick("siblings", 40), [1, 10, 20, 40, 41]);
});

test("选择 › 隐藏的图层: a hidden group stands for what is in it; never a hidden version", () => {
  assert.deepEqual(pick("hidden"), [22, 41]);
});

test("选择 › 空图层: pixel layers without a pixel", () => {
  assert.deepEqual(pick("empty"), [25]);
});

test("选择 › 反向选择: whole groups where nothing in them was selected", () => {
  // 图 (in 组 › 内组) selected: its groups stay out, their other layers come in
  assert.deepEqual(pick("invert", 24), [1, 10, 21, 23, 25, 40, 41]);
  // a selected group takes its layers with it
  assert.deepEqual(pick("invert", 20, 1), [10, 40, 41]);
  // inverting twice gives the same layers back
  assert.deepEqual(selectSet(tree(), new Set(pick("invert", 20, 1)), "invert"), [1, 20]);
});

test("选择 menu: what each command would select, greyed out when it changes nothing", () => {
  const t = tree();
  const menu = (...sel: number[]) => new Map(selectMenu(t, new Set(sel)).map(c => [c.which, c]));
  const none = menu();
  assert.equal(none.get("all")!.enabled, true);
  assert.equal(none.get("hidden")!.enabled, true);
  for (const k of ["invert", "similar", "sameColor", "linked", "siblings"] as const) assert.equal(none.get(k)!.disabledReason, "请先选中图层");
  const one = menu(24);
  assert.equal(one.get("sameColor")!.disabledReason, "选中的图层没有颜色标签");
  assert.equal(one.get("linked")!.disabledReason, "选中的图层没有链接");
  assert.deepEqual(one.get("siblings")!.ids, [23, 24]);
  // 变体图层 alone: nothing similar besides itself
  assert.equal(menu(10).get("similar")!.disabledReason, "已经是当前的选择");
  assert.equal(menu(22, 41).get("hidden")!.disabledReason, "已经是当前的选择");
});
