import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVariationCount, stepVariationCountByWheel } from "../src/core/workflow/variationCount.ts";

test("生图数量：支持 1～4 个变体，只接受整数，越界值安全回退或截断", () => {
  for (let n = 1; n <= 4; n++) {
    assert.equal(normalizeVariationCount(String(n)), n);
    assert.equal(normalizeVariationCount(n), n);
  }
  assert.equal(normalizeVariationCount("0"), 1);
  assert.equal(normalizeVariationCount("-4"), 1);
  assert.equal(normalizeVariationCount("100"), 4);
  assert.equal(normalizeVariationCount("2.0"), 2);
  assert.equal(normalizeVariationCount("3.9"), 1);
  assert.equal(normalizeVariationCount(""), 1);
  assert.equal(normalizeVariationCount("abc"), 1);
  assert.equal(normalizeVariationCount(Number.NaN), 1);
});

test("数量输入框滚轮每格增减一个变体，并限制在 1～4", () => {
  assert.equal(stepVariationCountByWheel(2, -100), 3);
  assert.equal(stepVariationCountByWheel(4, -100), 4);
  assert.equal(stepVariationCountByWheel(2, 100), 1);
  assert.equal(stepVariationCountByWheel(1, 100), 1);
  assert.equal(stepVariationCountByWheel(2, 0), 2);
  assert.equal(stepVariationCountByWheel(2, Number.NaN), 2);
});
