import { test } from "node:test";
import assert from "node:assert/strict";
import { clampThumbPercent, legacyThumbPercent, thumbnailMetrics } from "../src/core/layers/topControls.ts";

test("缩略图百分比迁移：无/小/中/大与原尺寸行高兼容", () => {
  assert.deepEqual(["off","s","m","l"].map(k => legacyThumbPercent(k, false)), [0,63,100,150]);
  assert.equal(legacyThumbPercent(null,true), 0);
  assert.equal(legacyThumbPercent(null,false), 100);
  assert.deepEqual(thumbnailMetrics(0), { percent: 0, thumb: 0, row: 30, short: 26 });
  assert.deepEqual(thumbnailMetrics(63), { percent: 63, thumb: 24, row: 30, short: 26 });
  assert.deepEqual(thumbnailMetrics(100), { percent: 100, thumb: 38, row: 44, short: 26 });
  assert.deepEqual(thumbnailMetrics(150), { percent: 150, thumb: 54, row: 60, short: 26 });
});
test("缩略图百分比边界：安全截断，保持图标和子行尺寸", () => {
  assert.equal(clampThumbPercent(-20), 0);
  assert.equal(clampThumbPercent(300), 150);
  assert.equal(clampThumbPercent(80.6), 81);
  assert.equal(clampThumbPercent(Number.NaN), 100);
  for (let i=0;i<=150;i++) {
    const v=thumbnailMetrics(i);
    assert.ok(v.thumb <= 54 && v.thumb >= 0);
    assert.ok(v.row >= Math.max(30, v.thumb));
    assert.equal(v.short,26);
  }
});
