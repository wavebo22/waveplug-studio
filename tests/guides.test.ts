import { test } from "node:test";
import assert from "node:assert/strict";
import { guideKey, treeGuides, type GuideRow } from "../src/core/layers/guides.ts";

// 标题
// 组 A
// ├ a1
// ├ 组 B
// │ ├ b1
// │ └ b2
// │   (b2 的效果行)
// └ a2
// 背景
const rows: GuideRow[] = [
  { id: 1, depth: 0, parentId: null },
  { id: 10, depth: 0, parentId: null },
  { id: 11, depth: 1, parentId: 10 },
  { id: 20, depth: 1, parentId: 10 },
  { id: 21, depth: 2, parentId: 20 },
  { id: 22, depth: 2, parentId: 20 },
  { id: 22, depth: 2, parentId: 20, sub: true },
  { id: 12, depth: 1, parentId: 10 },
  { id: 2, depth: 0, parentId: null },
];

test("guides: tees, elbows, and lines that stop after a group's last child", () => {
  assert.deepEqual(treeGuides(rows).map(guideKey), ["", "", "+", "+", "|+", "|L", "|..", "L", ""]);
});

test("guides: the selected layer's group line is lit", () => {
  const marks = treeGuides(rows, new Set([21]));
  // b1 and b2 hang on 组 B's line; 组 A's line is not lit
  assert.deepEqual(marks.map(guideKey), ["", "", "+", "+", "|+*", "|L*", "|..", "L", ""]);
  // a layer at the top level lights nothing
  assert.ok(treeGuides(rows, new Set([1])).flat().every(m => !m.hot));
});

test("guides: a collapsed group (no children shown) and the last top-level group", () => {
  const r: GuideRow[] = [
    { id: 10, depth: 0, parentId: null },
    { id: 11, depth: 1, parentId: 10 },
    { id: 20, depth: 1, parentId: 10 }, // collapsed: its children are not in the list
  ];
  assert.deepEqual(treeGuides(r).map(guideKey), ["", "+", "L"]);
});
