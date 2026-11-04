import { test } from "node:test";
import assert from "node:assert/strict";
import { onSmartTarget } from "../src/ui/smartTarget.ts";

test("WaveLayer link double-click selects exactly clicked smart layer before makeUnique", async () => {
  const events: string[] = [];
  let activeIds = [70, 71];
  const result = await onSmartTarget([17], async ids => {
    events.push("select:" + ids.join(","));
    activeIds = ids;
  }, async () => {
    events.push("makeUnique:" + activeIds.join(","));
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(events, ["select:17", "makeUnique:17"]);
});

test("Legacy smart commands preserve multi-select IDs but discard duplicates", async () => {
  let selected: number[] = [];
  await onSmartTarget([19, 18, 19], async ids => { selected = ids; }, async () => {
    assert.deepEqual(selected, [19, 18]);
  });
});

test("Selection failure never executes destructive smart-object operation", async () => {
  let performed = false;
  await assert.rejects(onSmartTarget([17], async () => {
    throw new Error("Photoshop cannot select requested layer");
  }, async () => { performed = true; }), /cannot select/);
  assert.equal(performed, false);
});
