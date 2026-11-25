import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, buildTree } from "../src/core/layers/tree.ts";
import { groupSelectionLayers } from "../src/core/layers/groupSelection.ts";

const px = { width: 10, height: 10 };
const raw = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, ...px, ...extra });
const end = (): RawLayer => ({ id: 0, name: "</Layer group>", kind: 13, section: "end", visible: true, locked: false, mask: false });

// 外 | 组 { 图, 曲线(调整), 纯色(填充), 剪贴(剪贴到下方), 隐藏图, 空, 子组 { 字, 渐变(填充) }, 隐藏子组 { 藏在里面 } } | 背景
const tree = (groupVisible = true) => buildTree([
  raw(1, "外", 1),
  raw(10, "组", 7, { visible: groupVisible }),
  raw(11, "图", 1),
  raw(12, "曲线", 2),
  raw(13, "纯色", 9),
  raw(14, "剪贴", 1, { clipped: true }),
  raw(15, "隐藏图", 1, { visible: false }),
  raw(16, "空", 1, { width: 0, height: 0 }),
  raw(20, "子组", 7), raw(21, "字", 3), raw(22, "渐变", 10), end(),
  raw(30, "隐藏子组", 7, { visible: false }), raw(31, "藏在里面", 5), end(),
  raw(17, "智能", 5),
  end(),
  raw(50, "背景", 12, { locked: true }),
]);

test("组的选区只算看得见的像素图层，跳过填充、调整、剪贴、隐藏和空图层", () => {
  assert.deepEqual(groupSelectionLayers(tree(), 10), [11, 21, 17]);
});

test("子组也能单独算", () => {
  assert.deepEqual(groupSelectionLayers(tree(), 20), [21]);
});

test("点的组本身隐藏时，仍然按里面看得见的图层算", () => {
  assert.deepEqual(groupSelectionLayers(tree(false), 10), [11, 21, 17]);
});

test("只有调整和填充图层的组：没有可用的图层", () => {
  const t = buildTree([raw(10, "组", 7), raw(11, "曲线", 2), raw(12, "纯色", 9), end()]);
  assert.deepEqual(groupSelectionLayers(t, 10), []);
});
