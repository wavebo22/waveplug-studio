import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVariationCount } from "../src/core/workflow/variationCount.ts";

test("生图数量：输入范围 1～4，空值和无效值回退到 1", () => {
  for (let n = 1; n <= 4; n++) {
    assert.equal(normalizeVariationCount(String(n)), n);
    assert.equal(normalizeVariationCount(n), n);
  }
  assert.equal(normalizeVariationCount("0"), 1);
  assert.equal(normalizeVariationCount("-4"), 1);
  assert.equal(normalizeVariationCount("100"), 4);
  assert.equal(normalizeVariationCount("3.9"), 3);
  assert.equal(normalizeVariationCount(""), 1);
  assert.equal(normalizeVariationCount("abc"), 1);
  assert.equal(normalizeVariationCount(Number.NaN), 1);
});
