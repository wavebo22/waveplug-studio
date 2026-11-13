import { test } from "node:test";
import assert from "node:assert/strict";
import { NOT_SHOWN, type Shown, type Wish, decide } from "../src/core/overlay/visibility.ts";

const DELAY = 400;
/** runs wishes at times, returning what was done at each */
function run(steps: [number, Wish][]): string[] {
  let state: Shown = NOT_SHOWN;
  return steps.map(([t, wish]) => { const v = decide(state, wish, t, DELAY); state = v.state; return v.do + (v.do === "hide" ? ":" + v.why : ""); });
}
const on = (docId = 1, subject?: string): Wish => ({ docId, wanted: true, subject });
const off = (docId: number | null = 1): Wish => ({ docId, wanted: false });

test("外置窗口: up at once, a blink of 'not wanted' changes nothing", () => {
  // selection → gone for 300 ms in the middle of a write-back → back
  assert.deepEqual(run([[0, on()], [100, off()], [250, off()], [400, on()], [500, on()]]), ["show", "keep", "keep", "keep", "keep"]);
});

test("外置窗口: down only after it stayed unwanted for the whole delay", () => {
  assert.deepEqual(run([[0, on()], [100, off()], [499, off()], [500, off()], [600, off()]]), ["show", "keep", "keep", "hide:not wanted", "keep"]);
  // wanted again in between starts the wait over
  assert.deepEqual(run([[0, on()], [100, off()], [300, on()], [350, off()], [700, off()], [750, off()]]), ["show", "keep", "keep", "keep", "keep", "hide:not wanted"]);
  const waiting = decide({ shown: true, docId: 1, subject: "", unwantedSince: 100 }, off(), 250, DELAY);
  assert.deepEqual([waiting.do, waiting.do === "keep" ? waiting.againInMs : null], ["keep", 250]);
});

test("外置窗口: no document hides at once; another document or subject shows again at once", () => {
  assert.deepEqual(run([[0, on()], [10, off(null)], [20, off(null)]]), ["show", "hide:no document", "keep"]);
  assert.deepEqual(run([[0, on(1)], [10, on(2)], [20, on(2)]]), ["show", "show", "keep"]);
  assert.deepEqual(run([[0, on(1, "g7")], [10, on(1, "g9")], [20, on(1, "g9")]]), ["show", "show", "keep"]);
  // never up: nothing to hide
  assert.deepEqual(run([[0, off()], [900, off()]]), ["keep", "keep"]);
});

test("外置窗口: with no delay (the variant rail) it goes the moment it isn't wanted", () => {
  let state: Shown = NOT_SHOWN;
  const at = (t: number, wish: Wish) => { const v = decide(state, wish, t, 0); state = v.state; return v.do; };
  assert.deepEqual([at(0, on(1, "g7")), at(10, off()), at(20, on(1, "g7"))], ["show", "hide", "show"]);
});
