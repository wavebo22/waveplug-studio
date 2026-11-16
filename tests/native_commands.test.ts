import { test } from "node:test";
import assert from "node:assert/strict";
import { isNativeCommand, nativeDeleteOutcome, NATIVE_MENU, pickMenuId } from "../src/core/layers/nativeCommands.ts";

test("pickMenuId: only a single, certain menu id", () => {
  assert.equal(pickMenuId([1203]), 1203);
  assert.equal(pickMenuId([1203, 1203]), 1203);
  assert.equal(pickMenuId([]), undefined);
  assert.equal(pickMenuId([10, 900]), undefined, "two items with the title and no anchor: never guessed");
  assert.equal(pickMenuId([10, 900], [905]), 900);
  assert.equal(pickMenuId([10, 900], [500]), undefined, "nearest is too far from the anchor");
  assert.equal(pickMenuId([95, 105], [100]), undefined, "a tie is not settled");
});

test("native command list", () => {
  assert.ok(isNativeCommand("delete"));
  assert.ok(isNativeCommand("convertSmart"));
  assert.ok(!isNativeCommand("moveMask"), "plugin-only commands stay");
  for (const spec of Object.values(NATIVE_MENU)) assert.equal(spec.titles.length, 2);
});

test("nativeDeleteOutcome", () => {
  const r = nativeDeleteOutcome([1, 2, 3], new Set([2]), new Map([[2, "背景"]]));
  assert.deepEqual(r.deleted, [1, 3]);
  assert.deepEqual(r.skipped, [{ id: 2, name: "背景", reason: "Photoshop 没有删除这个图层" }]);
});
