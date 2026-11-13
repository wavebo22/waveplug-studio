import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, arrangeProblem, arrangeTarget, buildTree, dropPlan, layerMenu, neighbourRow, previewMoveTree } from "../src/core/layers/tree.ts";

const px = { width: 10, height: 10 };
const raw = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, ...px, ...extra });
const end = (): RawLayer => ({ id: 0, name: "</Layer group>", kind: 13, section: "end", visible: true, locked: false, mask: false });

// a | 组 { b, c, d } | e | f | 背景
const tree = () => buildTree([
  raw(1, "a", 1), raw(20, "组", 7), raw(21, "b", 1), raw(22, "c", 1), raw(23, "d", 1), end(),
  raw(3, "e", 1, { locked: true, lockPosition: true }), raw(4, "f", 3), raw(9, "背景", 1, { background: true, locked: true, lockAll: true }),
]);
const order = (ids: number[], how: Parameters<typeof arrangeTarget>[2]) => {
  const t = tree(), target = arrangeTarget(t, new Set(ids), how);
  if (!target) return null;
  const plan = dropPlan(t, ids, target.rel, target.where);
  assert.ok(plan, "the target must be a drop the panel can make");
  return previewMoveTree(t, plan!)!.map(l => l.id);
};

test("排列: 前移 / 后移一层 inside the layer's own group, the background kept last", () => {
  assert.deepEqual(order([3], "forward"), [1, 3, 20, 21, 22, 23, 4, 9]);
  assert.deepEqual(order([3], "backward"), [1, 20, 21, 22, 23, 4, 3, 9]);
  assert.deepEqual(order([22], "forward"), [1, 20, 22, 21, 23, 3, 4, 9]);
  // already first / last of its group: nothing to do (never out of the group, never under the background)
  assert.equal(arrangeTarget(tree(), new Set([21]), "forward"), null);
  assert.equal(arrangeTarget(tree(), new Set([23]), "backward"), null);
  assert.equal(arrangeTarget(tree(), new Set([4]), "backward"), null);
  assert.equal(arrangeTarget(tree(), new Set([9]), "forward"), null);
});

test("排列: 置为顶层 / 置为底层, several layers kept in their order, a group with its layers", () => {
  assert.deepEqual(order([3, 4], "front"), [3, 4, 1, 20, 21, 22, 23, 9]);
  assert.deepEqual(order([1, 20, 22], "back"), [3, 4, 1, 20, 21, 22, 23, 9]);
  assert.equal(arrangeTarget(tree(), new Set([1]), "front"), null);
  // layers of different groups have no common place
  assert.equal(arrangeTarget(tree(), new Set([1, 22]), "front"), null);
});

test("Alt+[ / ]: the row below / above the selection, stopping at the ends", () => {
  const shown = [1, 20, 3, 4, 9];
  assert.equal(neighbourRow(shown, new Set([20]), true), 1);
  assert.equal(neighbourRow(shown, new Set([20, 3]), false), 4);
  assert.equal(neighbourRow(shown, new Set([1]), true), null);
  assert.equal(neighbourRow(shown, new Set([9]), false), null);
  assert.equal(neighbourRow(shown, new Set(), false), 1);
});

test("对齐 needs two movable layers, 分布 three; locked ones and the background don't count", () => {
  const t = tree(), of = (...ids: number[]) => t.filter(l => ids.includes(l.id));
  assert.equal(arrangeProblem(of(1, 4), "align"), null);
  assert.match(arrangeProblem(of(1), "align")!, /2 个/);
  assert.match(arrangeProblem(of(1, 4), "distribute")!, /3 个/);
  assert.match(arrangeProblem(of(1, 3, 9), "align")!, /可以移动的不够/);
  assert.equal(arrangeProblem(of(1, 4, 21), "distribute"), null);
});

test("右键菜单: Photoshop's merge, rasterize-style, export and smart-object commands", () => {
  const t = tree(), menu = (...ids: number[]) => new Map(layerMenu(t.filter(l => ids.includes(l.id))).flatMap(m => m === "-" ? [] : [[m.action, m] as const]));
  // one layer: 向下合并; several or a group: 合并图层 / 合并组
  assert.equal(menu(1).get("mergeDown")!.enabled, true);
  assert.equal(menu(1).has("merge"), false);
  assert.equal(menu(1, 4).get("merge")!.label, "合并图层");
  assert.equal(menu(20).get("merge")!.label, "合并组");
  assert.equal(menu(9).get("mergeDown")!.enabled, false);
  for (const a of ["mergeVisible", "flatten", "quickExport", "copyCSS"] as const) assert.equal(menu(1).get(a)!.enabled, true);
  assert.equal(menu(1).get("rasterizeStyle")!.enabled, false);
  assert.equal(menu(1).get("copySVG")!.enabled, false);
  assert.equal(menu(4).get("copySVG")!.enabled, true);
  // smart-object commands only with a smart object in the selection
  assert.equal(menu(1).has("smartViaCopy"), false);
  const so = buildTree([raw(1, "嵌入", 5, { contentId: "a", file: "a.psb" }), raw(2, "外链", 5, { contentId: "b", file: "b.psd", linked: true })]);
  const soMenu = (...ids: number[]) => new Map(layerMenu(so.filter(l => ids.includes(l.id))).flatMap(m => m === "-" ? [] : [[m.action, m] as const]));
  assert.equal(soMenu(1).get("smartViaCopy")!.enabled, true);
  assert.equal(soMenu(1).get("convertToLinked")!.enabled, true);
  assert.equal(soMenu(1).get("relink")!.enabled, false);
  assert.equal(soMenu(2).get("embedLinked")!.enabled, true);
  assert.equal(soMenu(2).get("relink")!.enabled, true);
});
