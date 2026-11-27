// The corner panel slot: the helper's one window at the canvas corner (native/overlay host.rs
// `surfaces()`) shows one surface at a time — the generate panel, or a feature's settings panel
// (检查 / AI 整理 / 改写 before they start). Every surface that may go there claims it with a
// priority and a wish (core/overlay/visibility.ts); this decides who is up, so no surface ever
// decides for itself and two can't fight over the window:
//   1. no document → nothing;
//   2. of the claims that are wanted for the open document, the highest priority is up;
//   3. a surface that stops being wanted goes after the hide delay (visibility.ts: Photoshop's
//      brief "no selection" blinks), unless another one is wanted — then it gives way at once;
//   4. the one up changes → the new one is shown first, then the old one hidden (no gap).
// Pure (tests/overlay_corner.test.ts); src/ui/cornerSlot.ts runs its verdicts.

import { type Shown, type Wish, NOT_SHOWN, decide } from "./visibility.ts";

export interface Claim {
  id: string;
  /** higher wins (a settings panel the user just opened over the generate panel) */
  priority: number;
  wish: Wish;
}

export interface CornerState {
  /** the surface up (or going) */
  current: string | null;
  vis: Shown;
}

export const CORNER_IDLE: CornerState = { current: null, vis: NOT_SHOWN };

/** what to do: `show` puts `id` up for `docId` (and, when `replaces` is set, hides that one after) */
export type CornerAction =
  | { do: "show"; id: string; docId: number; replaces: string | null }
  | { do: "hide"; id: string };

export interface CornerVerdict {
  state: CornerState;
  actions: CornerAction[];
  /** ask again then (a hide is waiting) */
  againInMs?: number;
}

/** The claim that should be up: the highest-priority wanted one (ties: the one up stays). */
export function cornerWinner(claims: readonly Claim[], current: string | null): Claim | null {
  let best: Claim | null = null;
  for (const c of claims) {
    if (!c.wish.wanted || c.wish.docId === null) continue;
    if (!best || c.priority > best.priority || (c.priority === best.priority && c.id === current)) best = c;
  }
  return best;
}

export function cornerStep(state: CornerState, claims: readonly Claim[], now: number, hideDelayMs: number): CornerVerdict {
  const winner = cornerWinner(claims, state.current);
  // another surface is wanted: it takes the window now (the old one gives way without a delay)
  if (winner && winner.id !== state.current) {
    const vis: Shown = { shown: true, docId: winner.wish.docId, subject: winner.wish.subject ?? "", unwantedSince: null };
    return { state: { current: winner.id, vis }, actions: [{ do: "show", id: winner.id, docId: winner.wish.docId!, replaces: state.current }] };
  }
  if (state.current === null) return { state: CORNER_IDLE, actions: [] };
  // the one up: its own wish, with the hide delay
  const mine = claims.find(c => c.id === state.current);
  const wish: Wish = mine ? mine.wish : { docId: null, wanted: false };
  const v = decide(state.vis, wish, now, hideDelayMs);
  if (v.do === "hide") return { state: CORNER_IDLE, actions: [{ do: "hide", id: state.current }] };
  const next = { current: state.current, vis: v.state };
  if (v.do === "show") return { state: next, actions: [{ do: "show", id: state.current, docId: wish.docId!, replaces: null }] };
  return { state: next, actions: [], ...(v.againInMs !== undefined ? { againInMs: v.againInMs } : {}) };
}
