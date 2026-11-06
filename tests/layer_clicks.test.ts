import { test } from "node:test";
import assert from "node:assert/strict";
import { isDuplicateLayerDoubleAction, isLayerDoubleClick, type LayerClickPoint } from "../src/core/layers/clicks.ts";
import { matchesInlineRenameRow } from "../src/core/layers/rename.ts";

const click = (overrides: Partial<LayerClickPoint> = {}): LayerClickPoint => ({
  id: 7, zone: "name", at: 1000, x: 120, y: 80, ...overrides,
});

test("same layer name clicked twice within 400ms and 4px is a double-click", () => {
  assert.equal(isLayerDoubleClick(click(), click({ at: 1400, x: 124, y: 84 })), true);
});

test("a second click after 400ms is not treated as a double-click", () => {
  assert.equal(isLayerDoubleClick(click(), click({ at: 1401 })), false);
});

test("pointer travel over 4px is rejected", () => {
  assert.equal(isLayerDoubleClick(click(), click({ at: 1200, x: 125 })), false);
  assert.equal(isLayerDoubleClick(click(), click({ at: 1200, y: 85 })), false);
});

test("different layers or different row zones do not form a double-click", () => {
  assert.equal(isLayerDoubleClick(click(), click({ id: 8, at: 1100 })), false);
  assert.equal(isLayerDoubleClick(click(), click({ zone: "thumb", at: 1100 })), false);
});

test("out-of-order timestamps are rejected", () => {
  assert.equal(isLayerDoubleClick(click(), click({ at: 999 })), false);
});

test("inline editor stays only on the same base layer row", () => {
  assert.equal(matchesInlineRenameRow(7, 7, false), true);
  assert.equal(matchesInlineRenameRow(7, 8, false), false);
  assert.equal(matchesInlineRenameRow(7, 7, true), false);
  assert.equal(matchesInlineRenameRow(null, 7, false), false);
});

test("name double-clicks are never swallowed by native-event deduplication", () => {
  const previous = { id: 7, zone: "name", at: 1000 };
  assert.equal(isDuplicateLayerDoubleAction(previous, { id: 7, zone: "name", at: 1050 }), false);
});

test("native duplicate events are suppressed only for the same non-name target", () => {
  const previous = { id: 7, zone: "thumb", at: 1000 };
  assert.equal(isDuplicateLayerDoubleAction(previous, { id: 7, zone: "thumb", at: 1050 }), true);
  assert.equal(isDuplicateLayerDoubleAction(previous, { id: 8, zone: "thumb", at: 1050 }), false);
  assert.equal(isDuplicateLayerDoubleAction(previous, { id: 7, zone: "status", at: 1050 }), false);
});
