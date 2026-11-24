// 图层列表的滚动 (layerTree.ts): wheel notches and scrollbar drags only say which row should be
// first; the rows are redrawn at most once a frame, however fast the events come (a quick wheel
// sent dozens a second, each redrawing every row in view). While a scroll is going on and for
// `settleMs` after the last event the list is "scrolling": the panel holds back what would ask
// Photoshop for something (thumbnails, the hover frame and its shape) until it settles.

export interface ScrollClock {
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface ScrollerOptions {
  clock: ScrollClock;
  /** the first row shown now */
  current(): number;
  /** keeps a first row inside the list */
  clamp(row: number): number;
  /** shows the list from `row` (redraws) */
  apply(row: number): void;
  /** the scroll has settled (nothing for settleMs) */
  settled?(): void;
  frameMs?: number;
  settleMs?: number;
}

export interface Scroller {
  /** scrolls by `n` rows (negative: up), from where the scroll is heading */
  by(n: number): void;
  /** scrolls so that `row` is first */
  to(row: number): void;
  /** a scroll is going on, or ended less than settleMs ago */
  scrolling(): boolean;
  /** ms until the scroll counts as settled (0: settled) */
  settlesIn(): number;
}

export function createScroller(o: ScrollerOptions): Scroller {
  const frameMs = o.frameMs ?? 16, settleMs = o.settleMs ?? 220;
  let target: number | null = null, frame: unknown = null, settle: unknown = null, until = 0;
  const flush = () => {
    frame = null;
    const t = target;
    target = null;
    if (t !== null && t !== o.current()) o.apply(t);
  };
  const to = (row: number) => {
    target = o.clamp(Math.round(row));
    until = o.clock.now() + settleMs;
    if (frame === null) frame = o.clock.later(flush, frameMs);
    if (settle !== null) o.clock.cancel(settle);
    settle = o.clock.later(() => { settle = null; o.settled?.(); }, settleMs);
  };
  return {
    by: n => { if (n) to((target ?? o.current()) + n); },
    to,
    scrolling: () => o.clock.now() < until,
    settlesIn: () => Math.max(0, until - o.clock.now()),
  };
}
