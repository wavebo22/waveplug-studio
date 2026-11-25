// 面板输入开销: the time the panels' own mouse-move / mouseover handlers took, summed; the stall
// probe (ps/uxpHost.ts) logs and resets it. 11-25: a 1000 Hz mouse sent ~320 moves a second into
// the panel and its handlers kept timers and Photoshop commands from running for seconds at a time.

export const inputCost = { ms: 0, calls: 0 };

/** wraps an input handler so its time counts */
export function costed<E>(fn: (e: E) => void): (e: E) => void {
  return e => {
    const t0 = Date.now();
    try { fn(e); } finally { inputCost.ms += Date.now() - t0; inputCost.calls++; }
  };
}
