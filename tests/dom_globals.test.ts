import { test } from "node:test";
import assert from "node:assert/strict";
import { disposeGlobals, every, listen } from "../src/ui/dom.ts";

// ⟳ in the development build: the old build's document / window listeners and timers must go
test("disposeGlobals removes this build's global listeners and timers", async () => {
  const target = new EventTarget() as unknown as Document;
  let hits = 0, ticks = 0;
  listen(target, "keydown", () => { hits++; });
  every(() => { ticks++; }, 5);
  target.dispatchEvent(new Event("keydown"));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(hits, 1);
  assert.ok(ticks >= 1);
  disposeGlobals();
  const t0 = ticks;
  target.dispatchEvent(new Event("keydown"));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(hits, 1);
  assert.equal(ticks, t0);
});
