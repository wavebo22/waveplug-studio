// The corner panel slot at run time: core/overlay/corner.ts decides which surface is up in the
// helper's corner window; this keeps the claims, runs the verdicts (show needs the canvas view,
// asked for asynchronously) and asks again when a hide is due. Every surface that may go there
// (the generate panel, the 检查 / AI 整理 / 改写 settings panels) claims it here instead of calling
// hub.show / hub.hide itself.

import { log } from "./log.ts";
import type { CanvasView, ScreenRect } from "../core/overlay/protocol.ts";
import type { Wish } from "../core/overlay/visibility.ts";
import { type CornerState, CORNER_IDLE, cornerStep } from "../core/overlay/corner.ts";

type Hub = {
  show(id: string, view: ScreenRect | null): void;
  hide(id: string): void;
  isShown(id: string): boolean;
};

export interface CornerSlot {
  /** `id` may go in the corner when `wish()` wants it; `view` places it against the canvas */
  claim(id: string, priority: number, wish: () => Wish, view: (docId: number) => Promise<CanvasView | null>): void;
  /** something a wish depends on changed */
  refresh(): void;
  /** Photoshop's window moved: put the one up there again */
  viewRequested(id: string): void;
  /** the surface up now (null: none) */
  current(): string | null;
  /** the canvas the corner window was last put against */
  lastView(): ScreenRect | null;
}

/** how long a surface stays after it stops being wanted (Photoshop's brief "no selection" blinks) */
export const CORNER_HIDE_DELAY_MS = 450;

export function createCornerSlot(hub: Hub): CornerSlot {
  const claims = new Map<string, { priority: number; wish: () => Wish; view: (docId: number) => Promise<CanvasView | null> }>();
  let state: CornerState = CORNER_IDLE, asking = 0, pending: string | null = null, again: ReturnType<typeof setTimeout> | null = null;
  let last: ScreenRect | null = null;

  async function putUp(id: string, docId: number) {
    const ask = ++asking;
    pending = id;
    const t0 = Date.now();
    const view = await claims.get(id)?.view(docId).catch(() => null) ?? null;
    if (ask !== asking || state.current !== id) return; // something else happened meanwhile
    pending = null;
    last = view?.view ?? last;
    log("info", "corner show", id, JSON.stringify(view?.view ?? null), `${Date.now() - t0} ms`);
    hub.show(id, view?.view ?? null);
    // only one surface in the corner window: whatever else the hub still has up goes
    for (const other of claims.keys()) if (other !== id && hub.isShown(other)) hub.hide(other);
  }

  const slot: CornerSlot = {
    claim(id, priority, wish, view) { claims.set(id, { priority, wish, view }); },
    refresh() {
      if (again) { clearTimeout(again); again = null; }
      const list = [...claims.entries()].map(([id, c]) => ({ id, priority: c.priority, wish: c.wish() }));
      const v = cornerStep(state, list, Date.now(), CORNER_HIDE_DELAY_MS);
      state = v.state;
      for (const a of v.actions) {
        if (a.do === "hide") {
          asking++; pending = null;
          if (hub.isShown(a.id)) log("info", "corner hide", a.id);
          hub.hide(a.id);
        } else void putUp(a.id, a.docId);
      }
      // wanted but not on screen (a reconnect, a show that lost its race): put it up again
      const cur = state.current;
      if (!v.actions.length && cur && pending !== cur && !hub.isShown(cur)) {
        const w = list.find(c => c.id === cur)?.wish;
        if (w?.wanted && w.docId !== null) void putUp(cur, w.docId);
      }
      if (v.againInMs !== undefined) again = setTimeout(() => { again = null; slot.refresh(); }, v.againInMs + 10);
    },
    viewRequested(id) {
      if (state.current !== id) return;
      const w = claims.get(id)?.wish();
      if (w && w.docId !== null) void putUp(id, w.docId);
    },
    current: () => state.current,
    lastView: () => last,
  };
  return slot;
}
