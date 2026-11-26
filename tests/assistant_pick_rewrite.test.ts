import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, buildTree } from "../src/core/layers/tree.ts";
import { describeLayers } from "../src/core/assistant/organize.ts";
import { PICK_MAX_LAYERS, parsePick, pickScope, pickUserPrompt } from "../src/core/assistant/pick.ts";
import { REWRITE_MAX_CHARS, parseRewrite, rewriteScope, rewriteUserPrompt } from "../src/core/assistant/rewrite.ts";
import { parseOrganizeAction, rewritePlanSection } from "../src/core/overlay/organizePanel.ts";

const L = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, width: 100, height: 40, left: 10, top: 20, ...extra });
const end = (): RawLayer => ({ id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false });
const tree = buildTree([
  L(1, "标题", 3),
  L(5, "按钮", 7), L(6, "按钮文字", 3), L(7, "按钮底", 4), end(),
  L(8, "产品图", 5, { visible: false }),
  L(99, "背景", 1, { background: true }),
]);

test("一句话选图层：列出背景以外的全部图层，不带 fixed 标记；太多时截断并说明", () => {
  const sc = pickScope(tree);
  assert.deepEqual(sc.ids, [1, 5, 6, 7, 8]);
  assert.equal(sc.cut, 0);
  const lines = describeLayers(tree, sc.ids, new Map([[1, "夏日大促"]]), false);
  assert.ok(!lines.includes("fixed"));
  assert.match(lines, /夏日大促/);
  const p = pickUserPrompt(lines, "  所有\n按钮 ", { width: 800, height: 600, cut: 3 });
  assert.match(p, /用户要选中：所有 按钮$/);
  assert.match(p, /还有 3 个图层/);
  assert.ok(PICK_MAX_LAYERS >= 300);
});

test("一句话选图层：只收存在的图层，按面板顺序去重", () => {
  assert.deepEqual(parsePick({ ids: [7, "5", 7, 404, "x"], note: " 按名字 " }, tree), { ids: [5, 7], note: "按名字" });
  assert.deepEqual(parsePick(null, tree), { ids: [], note: "" });
});

test("AI 改写的范围：选中的文字图层和选中组里的文字；否则全部文字图层", () => {
  assert.deepEqual(rewriteScope(tree, new Set([5])), { ids: [6], label: "选中的 1 个文字图层" });
  assert.deepEqual(rewriteScope(tree, new Set([8])).ids, [1, 6]);
  assert.equal(rewriteScope(tree, new Set()).label, "全部 2 个文字图层");
});

test("AI 改写：请求按字数截断；回答只收发过的、改了的、非空的", () => {
  const texts = [{ id: 1, name: "标题", text: "夏日大促" }, { id: 6, name: "按钮文字", text: "立即购买" }, { id: 9, name: "空", text: " " }];
  const p = rewriteUserPrompt(texts, "翻译成英文");
  assert.equal(p.count, 2);
  assert.equal(p.cut, 0);
  assert.match(p.user, /^改写要求：翻译成英文/);
  const long = Array.from({ length: 400 }, (_, i) => ({ id: i + 100, name: "x", text: "很长的文字".repeat(10) }));
  const q = rewriteUserPrompt(long, "缩短");
  assert.ok(q.count < 400 && q.cut === 400 - q.count && q.user.length < REWRITE_MAX_CHARS + 200);
  const items = parseRewrite({ items: [{ id: 1, text: "Summer Sale\\nNow" }, { id: "6", text: "立即购买" }, { id: 404, text: "x" }, { id: 1, text: "again" }] }, texts);
  assert.deepEqual(items, [{ id: 1, from: "夏日大促", to: "Summer Sale\nNow" }]);
});

test("AI 改写窗口：混排样式只给建议（锁定、不勾）；动作沿用 AI 整理的", () => {
  const plan = rewritePlanSection([{ id: 1, from: "夏日\n大促", to: "Summer\nSale" }, { id: 6, from: "立即购买", to: "Buy now" }], new Set(), new Set([6]), "空");
  assert.equal(plan.renames[0].from, "夏日 ⏎ 大促");
  assert.equal(plan.renames[0].on, true);
  assert.equal(plan.renames[1].on, false);
  assert.equal(plan.renames[1].lock, true);
  assert.equal(plan.renameTitle, "改写");
  assert.deepEqual(parseOrganizeAction({ kind: "toggle", key: "r:6" }), { kind: "toggle", key: "r:6" });
});
