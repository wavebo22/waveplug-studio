import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, aiStrayMoves, buildTree, isAiStray, isVariantLayer } from "../src/core/layers/tree.ts";
import { FILL_PREFIX } from "../src/ps/host.ts";

const raw = (id: number, name: string, kind: number): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false });
const end = (): RawLayer => ({ id: 0, name: "</Layer group>", kind: 13, section: "end", visible: true, locked: false, mask: false });

// top to bottom: a placed image and a new layer landed inside the AI group, above its variations
const doc = () => buildTree([
  raw(1, "标题", 3),
  raw(10, FILL_PREFIX + "猫", 7),
  raw(20, "照片", 5),
  raw(21, "图层 1", 1),
  raw(11, "v1 · 猫", 1),
  raw(12, "v2 · 猫", 1),
  end(),
  raw(2, "背景", 1),
]);

test("AI 组：组里多了非变体图层就不再是 AI 图层（问题本身）", () => {
  assert.equal(isVariantLayer(doc().find(l => l.id === 10)!), false);
});

test("AI 组：新出现在组里的非变体图层依次移到组的正上方", () => {
  const seen = new Set([1, 10, 11, 12, 2]);
  assert.deepEqual(aiStrayMoves(seen, doc()), [
    { id: 20, rel: 10, place: "before" },
    { id: 21, rel: 20, place: "after" },
  ]);
});

test("AI 组：原来就在组里的、首次读到的文档、变体本身都不动", () => {
  assert.deepEqual(aiStrayMoves(new Set([1, 10, 20, 21, 11, 12, 2]), doc()), []);
  assert.deepEqual(aiStrayMoves(null, doc()), []);
  assert.deepEqual(aiStrayMoves(new Set([1, 10, 20, 21, 2]), doc()), []);
});

test("AI 组：host 在历史步骤里按名字再核对", () => {
  assert.equal(isAiStray("照片", FILL_PREFIX + "猫"), true);
  assert.equal(isAiStray("v3 · 猫", FILL_PREFIX + "猫"), false);
  assert.equal(isAiStray("照片", "普通组"), false);
});
