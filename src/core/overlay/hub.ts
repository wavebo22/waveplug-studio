// The plugin's side of the external surfaces: each surface registers what it shows and what it
// does with the user's actions; the hub keeps one revision counter and one "last sent" record per
// surface, sends only changed sections, routes actions back, and after a (re)connect resends
// everything — so a helper restarted mid-session catches up on its own.
// No UXP or DOM here (tested in tests/overlay_hub.test.ts); src/app/overlay.ts gives it a socket.

import type { OverlayCommand, OverlayEvent, ScreenRect } from "./protocol.ts";
import { changedSections } from "./sections.ts";

export interface Surface<S extends object, A> {
  /** the `panel` name in every message */
  id: string;
  /** what the surface shows right now */
  sections(): S;
  /** the surface's own check of an action from the helper; null drops it */
  parseAction(raw: unknown): A | null;
  onAction(action: A): void;
  /** Photoshop's window moved: the surface works out its view again and calls hub.show */
  onViewRequest?(): void;
}

interface Entry {
  surface: Surface<object, unknown>;
  sent: Map<string, string>;
  rev: number;
  shown: boolean;
  view: ScreenRect | null;
}

export function createHub(send: (m: OverlayCommand) => void) {
  const entries = new Map<string, Entry>();

  function flush(e: Entry) {
    const sections = changedSections(e.sent, e.surface.sections());
    if (sections) send({ type: "state", panel: e.surface.id, rev: ++e.rev, sections: sections as Record<string, unknown> });
  }

  return {
    register<S extends object, A>(surface: Surface<S, A>) {
      entries.set(surface.id, { surface: surface as unknown as Surface<object, unknown>, sent: new Map(), rev: 0, shown: false, view: null });
    },
    /** Sends what changed in `id` (or in every surface). Cheap when nothing did. */
    sync(id?: string) {
      for (const e of entries.values()) if (!id || e.surface.id === id) flush(e);
    },
    show(id: string, view: ScreenRect | null) {
      const e = entries.get(id);
      if (!e) return;
      flush(e); // state first, so the surface never appears with stale content
      e.shown = true;
      e.view = view;
      send({ type: "show", panel: id, view });
    },
    hide(id: string) {
      const e = entries.get(id);
      if (!e || !e.shown) return;
      e.shown = false;
      send({ type: "hide", panel: id });
    },
    isShown: (id: string) => entries.get(id)?.shown ?? false,
    /** the view surface `id` was last placed against (for a notice in the same corner) */
    viewOf: (id: string) => entries.get(id)?.view ?? null,
    /** A notice in the bottom-right corner of `view`, for `ms` (or until clicked). */
    toast(title: string, text: string, view: ScreenRect | null, ms = 8000) {
      send({ type: "toast", title, text, view, ms });
    },
    /** A helper (re)connected: it knows nothing, so send every surface whole, and re-show. */
    connected() {
      send({ type: "hello" });
      for (const e of entries.values()) {
        e.sent.clear();
        flush(e);
        if (e.shown) send({ type: "show", panel: e.surface.id, view: e.view });
      }
    },
    receive(ev: OverlayEvent) {
      if (!("panel" in ev)) return;
      const e = entries.get(ev.panel);
      if (!e) return;
      if (ev.type === "view-request") { if (e.shown) e.surface.onViewRequest?.(); return; }
      const action = e.surface.parseAction(ev.action);
      if (action !== null) e.surface.onAction(action);
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
