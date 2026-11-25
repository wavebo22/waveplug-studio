import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, STRAY_TRIES, aiStrayMoves, buildTree, contentUsers, isAiStray, isVariantLayer, visibleRows } from "../src/core/layers/tree.ts";
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

const first = () => aiStrayMoves(undefined, buildTree([raw(1, "标题", 3), raw(10, FILL_PREFIX + "猫", 7), raw(11, "v1 · 猫", 1), raw(12, "v2 · 猫", 1), end(), raw(2, "背景", 1)])).memo;

test("AI 组：组里多了非变体图层仍是 AI 图层，外来图层列在它下面，变体不列", () => {
  const t = doc();
  assert.equal(isVariantLayer(t.find(l => l.id === 10)!), true);
  const rows = visibleRows(t, new Set(), "all", contentUsers(t)).map(r => r.layer.id);
  assert.deepEqual(rows, [1, 10, 20, 21, 2]);
  // 筛选时也一样：外来图层能搜到，变体搜不到
  const q = { text: "猫", kinds: new Set<never>() };
  assert.deepEqual(visibleRows(t, new Set(), "all", contentUsers(t), new Set(), q).filter(r => !r.context).map(r => r.layer.id), [10]);
});

test("AI 组：组里的外来图层依次移到组的正上方", () => {
  assert.deepEqual(aiStrayMoves(first(), doc()).steps, [
    { id: 20, rel: 10, place: "before" },
    { id: 21, rel: 20, place: "after" },
  ]);
});

test("AI 组：从别处拖进组里的旧图层也移出（不只是新建的）", () => {
  const memo = first();
  // 1 (标题) 原来就在文档里，被拖进了 AI 组
  const t = buildTree([raw(10, FILL_PREFIX + "猫", 7), raw(1, "标题", 3), raw(11, "v1 · 猫", 1), end(), raw(2, "背景", 1)]);
  assert.deepEqual(aiStrayMoves(memo, t).steps, [{ id: 1, rel: 10, place: "before" }]);
});

test("AI 组：首次读到的文档里原有的外来图层不动", () => {
  const { steps, memo } = aiStrayMoves(undefined, doc());
  assert.deepEqual(steps, []);
  assert.deepEqual(aiStrayMoves(memo, doc()).steps, []);
});

test("AI 组：移出失败会再试，试满次数后不再动", () => {
  const memo = first();
  for (let i = 0; i < STRAY_TRIES; i++) {
    const r = aiStrayMoves(memo, doc());
    assert.equal(r.steps.length, 2);
    for (const s of r.steps) memo.tries.set(s.id, (memo.tries.get(s.id) ?? 0) + 1);
  }
  assert.deepEqual(aiStrayMoves(memo, doc()).steps, []);
});

test("AI 组：移出后被撤销（又回到组里）就不再和用户抢", () => {
  const memo = first();
  for (const s of aiStrayMoves(memo, doc()).steps) { memo.tries.set(s.id, 1); memo.moved.add(s.id); }
  assert.deepEqual(aiStrayMoves(memo, doc()).steps, []);
  assert.ok(memo.leave.has(20) && memo.leave.has(21));
});

test("AI 组：host 在历史步骤里按名字再核对", () => {
  assert.equal(isAiStray("照片", FILL_PREFIX + "猫"), true);
  assert.equal(isAiStray("v3 · 猫", FILL_PREFIX + "猫"), false);
  assert.equal(isAiStray("照片", "普通组"), false);
});
