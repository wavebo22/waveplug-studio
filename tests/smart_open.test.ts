import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPsbBeforeEditing, openSmartContents } from "../src/core/layers/smartOpen.ts";

test("PNG detection is case-insensitive and ignores surrounding whitespace", () => {
  assert.equal(needsPsbBeforeEditing(" PRODUCT.PNG "), true);
  assert.equal(needsPsbBeforeEditing("C:\\assets\\product.png"), true);
  assert.equal(needsPsbBeforeEditing("产品.png"), true);
  for (const name of ["a.psb", "a.psd", "a.jpg", "a.png.psb", "a.png.backup", "", undefined, null])
    assert.equal(needsPsbBeforeEditing(name), false);
});

test("PNG double-click converts first and opens ONLY the new PSB layer ID", async () => {
  const calls: string[] = [];
  const result = await openSmartContents(21, "product.PNG", {
    convertPng: async () => { calls.push("convert"); return { done: 1, skipped: [] }; },
    convertedLayerId: () => { calls.push("newId"); return 83; },
    open: async id => { calls.push("open:" + id); },
  });
  assert.deepEqual(calls, ["convert", "newId", "open:83"]);
  assert.deepEqual(result, { layerId: 83, converted: true });
});

test("PSB and other types open directly, without creating a second smart object", async () => {
  for (const file of ["layer.psb", "layer.psd", "vector.ai", "photo.jpg", ""]) {
    const calls: string[] = [];
    const result = await openSmartContents(21, file, {
      convertPng: async () => { calls.push("convert"); throw new Error("unexpected"); },
      convertedLayerId: () => { calls.push("newId"); return 83; },
      open: async id => { calls.push("open:" + id); },
    });
    assert.deepEqual(calls, ["open:21"]);
    assert.deepEqual(result, { layerId: 21, converted: false });
  }
});

test("conversion failure or skipped PNG never opens original PNG contents", async () => {
  for (const converted of [{ done: 0, skipped: [] }, { done: 0, skipped: ["无法转换"] }, { done: 1, skipped: ["忽略"] }]) {
    let opened = false;
    await assert.rejects(openSmartContents(21, "product.png", {
      convertPng: async () => converted,
      convertedLayerId: () => 83,
      open: async () => { opened = true; },
    }), /PNG 转为可编辑 PSB 失败/);
    assert.equal(opened, false);
  }
});

test("converted layer ID must change; stale/deleted selection is not opened", async () => {
  for (const id of [null, 0, 21]) {
    let opened = false;
    await assert.rejects(openSmartContents(21, "product.png", {
      convertPng: async () => ({ done: 1, skipped: [] }),
      convertedLayerId: () => id,
      open: async () => { opened = true; },
    }), /无法确认新的 PSB 图层/);
    assert.equal(opened, false);
  }
});
