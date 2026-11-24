import { test } from "node:test";
import assert from "node:assert/strict";
import { createScroller, type ScrollClock } from "../src/core/layers/scroll.ts";

/** a clock run by hand: `tick(ms)` runs what came due */
function fakeClock() {
  let t = 0, seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const clock: ScrollClock = {
    now: () => t,
    later: (fn, ms) => { const id = ++seq; jobs.set(id, { at: t + ms, fn }); return id; },
    cancel: h => { jobs.delete(h as number); },
  };
  const tick = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      jobs.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return { clock, tick };
}

test("scroll: many wheel notches within a frame redraw once, at the sum", () => {
  const { clock, tick } = fakeClock();
  let first = 0, draws = 0, settled = 0;
  const s = createScroller({ clock, current: () => first, clamp: r => Math.max(0, Math.min(r, 100)), apply: r => { first = r; draws++; }, settled: () => { settled++; } });
  for (let i = 0; i < 20; i++) s.by(3);
  assert.equal(draws, 0);
  assert.ok(s.scrolling());
  tick(16);
  assert.equal(draws, 1);
  assert.equal(first, 60);
  // clamped at the end of the list
  s.by(300);
  tick(16);
  assert.equal(first, 100);
  assert.equal(draws, 2);
  // settles 220 ms after the last event
  tick(150);
  assert.ok(s.scrolling());
  assert.equal(settled, 0);
  tick(100);
  assert.ok(!s.scrolling());
  assert.equal(settled, 1);
});

test("scroll: dragging the scrollbar goes to absolute rows; nothing to redraw, nothing redrawn", () => {
  const { clock, tick } = fakeClock();
  let first = 10, draws = 0;
  const s = createScroller({ clock, current: () => first, clamp: r => Math.max(0, r), apply: r => { first = r; draws++; } });
  s.to(40); s.to(42); s.to(41);
  tick(16);
  assert.equal(first, 41);
  assert.equal(draws, 1);
  s.to(41);
  tick(16);
  assert.equal(draws, 1);
  s.by(0);
  assert.equal(s.settlesIn(), 220 - 16);
});
