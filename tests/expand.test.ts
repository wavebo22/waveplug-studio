import { test } from "node:test";
import assert from "node:assert/strict";
import { fitRatio } from "../src/ui/expandEditor.ts";

test("fitRatio grows the frame to the ratio and keeps each side's share", () => {
  const p = fitRatio({ left: 0, right: 350, top: 77, bottom: 0 }, 1920, 1200, "16:9");
  assert.deepEqual(p, { left: 0, right: 350, top: 77, bottom: 0 });
  const sq = fitRatio({ left: 0, right: 0, top: 0, bottom: 0 }, 1920, 1200, "1:1");
  assert.deepEqual(sq, { left: 0, right: 0, top: 360, bottom: 360 }); // no side chosen → split evenly
  const tall = fitRatio({ left: 100, right: 100, top: 0, bottom: 0 }, 1000, 1000, "9:16");
  assert.equal((1000 + tall.left + tall.right) / (1000 + tall.top + tall.bottom), 1200 / 2133);
  assert.deepEqual(fitRatio({ left: 5, right: 0, top: 0, bottom: 0 }, 10, 10, "自由比例"), { left: 5, right: 0, top: 0, bottom: 0 });
});
