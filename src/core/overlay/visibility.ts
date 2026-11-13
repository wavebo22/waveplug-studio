// When an external surface is up. One rule for every surface, so they can't disagree:
// - it goes up at once when it is wanted (or wanted for another document / subject);
// - it comes down only after it has been unwanted for `hideDelayMs` without a break. Photoshop
//   reports "no selection" / "no AI layer" for a moment in the middle of the plugin's own commands
//   (writing a result back, restoring a selection, re-reading a group), and following every such
//   blink made the windows flash off and on;
// - without a document it comes down at once.
// Pure (tests/overlay_visibility.test.ts); the surface gives it the clock and runs its verdicts.

export interface Wish {
  /** the document it belongs to; null: none is open */
  docId: number | null;
  /** it should be up now */
  wanted: boolean;
  /** what it shows (a group's id …): another subject is put up again at once */
  subject?: string;
}

export interface Shown {
  shown: boolean;
  docId: number | null;
  subject: string;
  /** when it stopped being wanted (ms), null while it is wanted */
  unwantedSince: number | null;
}

export const NOT_SHOWN: Shown = { shown: false, docId: null, subject: "", unwantedSince: null };

export type Verdict =
  | { do: "show"; state: Shown }
  | { do: "hide"; state: Shown; why: "no document" | "not wanted" }
  /** nothing to do now; `againInMs`: ask again then (a hide is waiting) */
  | { do: "keep"; state: Shown; againInMs?: number };

export function decide(state: Shown, wish: Wish, now: number, hideDelayMs: number): Verdict {
  const subject = wish.subject ?? "";
  if (wish.docId === null) {
    return state.shown ? { do: "hide", state: NOT_SHOWN, why: "no document" } : { do: "keep", state: NOT_SHOWN };
  }
  if (wish.wanted) {
    const same = state.shown && state.docId === wish.docId && state.subject === subject;
    const next: Shown = { shown: true, docId: wish.docId, subject, unwantedSince: null };
    return same ? { do: "keep", state: next } : { do: "show", state: next };
  }
  if (!state.shown) return { do: "keep", state: NOT_SHOWN };
  const since = state.unwantedSince ?? now, waited = now - since;
  if (waited >= hideDelayMs) return { do: "hide", state: NOT_SHOWN, why: "not wanted" };
  return { do: "keep", state: { ...state, unwantedSince: since }, againInMs: hideDelayMs - waited };
}
