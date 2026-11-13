// The generate page as an external surface (外置生成面板, native/overlay): registers it with the
// overlay hub, puts it up at the corner of Photoshop's canvas while the document has a selection
// (in any mode — only the selection decides) and hands the user's actions to the page's own
// handlers. The page (app.ts) stays the one place with the logic; this file only reads its state
// and calls into it through `GeneratePage`.

import { log } from "../app/log.ts";
import type { Overlay } from "../app/overlay.ts";
import type { Rect } from "../core/image/region.ts";
import { GENERATE_PANEL, type GenerateAction, type GenerateSections, parseGenerateAction } from "../core/overlay/generatePanel.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { NOT_SHOWN, type Shown, decide } from "../core/overlay/visibility.ts";

/** How long the panel stays after it stops being wanted (core/overlay/visibility.ts). */
const HIDE_DELAY_MS = 450;

/** What the external panel needs from the generate page. */
export interface GeneratePage {
  sections(): GenerateSections;
  /** the active document and its selection (null when none) */
  where(): { docId: number | null; sel: Rect | null };
  canvasView(docId: number): Promise<CanvasView | null>;
  setMode(mode: string): void;
  setPrompt(text: string): void;
  setCount(n: number): void;
  setNumber(key: string, value: number): void;
  resetNumber(key: string): void;
  setToggle(key: string, value: boolean): void;
  setSeed(random: boolean, value: number): void;
  newSeed(): void;
  generate(): void;
  cancel(): void;
  toggleFavorite(): void;
  pickFavorite(text: string): void;
  removeFavorite(text: string): void;
  addRef(slot: number, source: "layer" | "file" | "clipboard"): void;
  addLayerReference(slot: number, docId: number, layerId: number, name: string): void;
  addLayerReferences(slot: number, docId: number, layers: { layerId: number; name: string }[], totalCount: number): void;
  finishLayerDrag(): void;
  removeRef(slot: number): void;
}

export function attachGenerateSurface(overlay: Overlay, page: GeneratePage) {
  const { hub } = overlay;
  /** what is up (core/overlay/visibility.ts decides); `asking`: the latest request for the canvas */
  let vis: Shown = NOT_SHOWN, asking = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  /** The panel stays for as long as a document is open (user, 11-12): without a selection it is
   *  simply collapsed to its bar — the helper folds it whenever the pointer isn't on it and
   *  nothing runs (host.rs) — instead of leaving and coming back. Only "no document" takes it away. */
  const wish = () => { const { docId } = page.where(); return { docId, wanted: docId !== null }; };
  /** the canvas the panel was last put up against (kept after it goes away, for the notice) */
  let lastView: import("../core/overlay/protocol.ts").ScreenRect | null = null;

  async function putUp(docId: number) {
    const ask = ++asking, t0 = Date.now();
    const view = await page.canvasView(docId).catch(() => null);
    if (ask !== asking) return; // a newer selection change already
    const now = wish();
    if (now.docId !== docId || !now.wanted) return;
    lastView = view?.view ?? lastView;
    // how long reading the canvas from Photoshop took (to tell this apart from other stalls)
    log("info", "overlay panel show", JSON.stringify(view?.view ?? null), `${Date.now() - t0} ms`);
    hub.show(GENERATE_PANEL, view?.view ?? null);
  }

  /** a run was going in the last state sent: when it ends well, say so in the corner */
  let wasRunning = false;
  function sections(): GenerateSections {
    const s = page.sections();
    if (wasRunning && !s.run && s.status.tone !== "error" && s.status.text !== "已取消") {
      // even when the panel is away (the selection was dropped while it ran)
      hub.toast("图片生成完毕", s.status.text, hub.viewOf(GENERATE_PANEL) ?? lastView);
    }
    wasRunning = !!s.run;
    return s;
  }

  hub.register<GenerateSections, GenerateAction>({
    id: GENERATE_PANEL,
    sections,
    parseAction: parseGenerateAction,
    onAction(a) {
      switch (a.kind) {
        case "set-mode": return page.setMode(a.mode);
        case "set-prompt": return page.setPrompt(a.text);
        case "set-count": return page.setCount(a.count);
        case "set-number": return page.setNumber(a.key, a.value);
        case "reset-number": return page.resetNumber(a.key);
        case "set-toggle": return page.setToggle(a.key, a.value);
        case "set-seed": return page.setSeed(a.random, a.value);
        case "new-seed": return page.newSeed();
        case "generate": return page.generate();
        case "cancel": return page.cancel();
        case "toggle-favorite": return page.toggleFavorite();
        case "pick-favorite": return page.pickFavorite(a.text);
        case "remove-favorite": return page.removeFavorite(a.text);
        case "add-ref": return page.addRef(a.slot, a.source as "layer" | "file" | "clipboard");
        case "drop-ref": return page.addLayerReferences(a.slot, a.docId, [{ layerId: a.layerId, name: a.name }], 1);
        case "drop-refs": return page.addLayerReferences(a.slot, a.docId, a.layers, a.totalCount);
        case "finish-layer-drag": return page.finishLayerDrag();
        case "remove-ref": return page.removeRef(a.slot);
      }
    },
    onViewRequest() {
      const { docId } = page.where();
      if (docId !== null) void putUp(docId);
    },
  });

  const surface = {
    /** The page's state or Photoshop's may have changed: show / hide, and send what changed. */
    refresh() {
      if (again) { clearTimeout(again); again = null; }
      const w = wish(), v = decide(vis, w, Date.now(), HIDE_DELAY_MS);
      vis = v.state;
      if (v.do === "hide") {
        asking++;
        if (hub.isShown(GENERATE_PANEL)) log("info", "overlay panel hide", v.why);
        hub.hide(GENERATE_PANEL);
      } else if (v.do === "show" || (w.wanted && !hub.isShown(GENERATE_PANEL))) {
        void putUp(w.docId!);
      } else if (v.againInMs !== undefined) {
        // a hide is waiting: look again when it is due (Photoshop may send nothing meanwhile)
        again = setTimeout(() => { again = null; surface.refresh(); }, v.againInMs + 10);
      }
      overlay.queueSync();
    },
  };
  return surface;
}
