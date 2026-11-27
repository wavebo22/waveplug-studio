// The generate page as an external surface (外置生成面板, native/overlay): registers it with the
// overlay hub, claims the canvas-corner window (app/cornerSlot.ts) while the document has a
// selection or a generation is running — in any mode, only those decide; a settings panel the
// user opened (检查 / AI 整理 / 改写) takes the window first — and hands the user's actions to the
// page's own handlers. The page (app.ts) stays the one place with the logic; this file only reads its state
// and calls into it through `GeneratePage`.

import { log } from "../app/log.ts";
import type { Overlay } from "../app/overlay.ts";
import type { Rect } from "../core/image/region.ts";
import { GENERATE_PANEL, type GenerateAction, type GenerateSections, type PanelMode, modeBeforeAction, parseGenerateAction } from "../core/overlay/generatePanel.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import type { Wish } from "../core/overlay/visibility.ts";

/** its claim on the corner window: below a settings panel the user opened (app/cornerSlot.ts) */
export const GENERATE_PRIORITY = 10;

/** What the external panel needs from the generate page. */
export interface GeneratePage {
  sections(): GenerateSections;
  /** the active document and its selection (null when none) */
  where(): { docId: number | null; sel: Rect | null };
  /** a generation is running */
  running(): boolean;
  canvasView(docId: number): Promise<CanvasView | null>;
  /** the plugin's current mode, and the one the panel shows (shownPanelMode) */
  pluginMode(): string;
  panelMode(): PanelMode;
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
  /** 「AI 优化」 / 还原 (DeepSeek) */
  optimizePrompt(): void;
  restorePrompt(): void;
  pickFavorite(text: string): void;
  removeFavorite(text: string): void;
  addRef(slot: number, source: "layer" | "file" | "clipboard"): void;
  addLayerReference(slot: number, docId: number, layerId: number, name: string): void;
  addLayerReferences(slot: number, docId: number, layers: { layerId: number; name: string }[], totalCount: number): void;
  finishLayerDrag(): void;
  removeRef(slot: number): void;
}

export function attachGenerateSurface(overlay: Overlay, page: GeneratePage) {
  const { hub, corner } = overlay;
  /** Wanted while the document has a selection, or while something runs (its progress stays in
   *  view even when the selection is dropped meanwhile). No document: never. */
  const wish = (): Wish => {
    const { docId, sel } = page.where();
    return { docId, wanted: docId !== null && (sel !== null || page.running()) };
  };
  corner.claim(GENERATE_PANEL, GENERATE_PRIORITY, wish, docId => page.canvasView(docId));

  /** a run was going in the last state sent: when it ends well, say so in the corner */
  let wasRunning = false;
  function sections(): GenerateSections {
    const s = page.sections();
    if (wasRunning && !s.run && s.status.tone !== "error" && s.status.text !== "已取消") {
      // even when the panel is away (the selection was dropped while it ran)
      hub.toast("图片生成完毕", s.status.text, hub.viewOf(GENERATE_PANEL) ?? corner.lastView());
    }
    wasRunning = !!s.run;
    return s;
  }

  hub.register<GenerateSections, GenerateAction>({
    id: GENERATE_PANEL,
    sections,
    parseAction: parseGenerateAction,
    onAction(a) {
      // what runs is what the panel showed: the plugin may have been left in 放大 / 扩图, or have
      // followed a selected AI layer of another kind since the panel's last state
      const switchTo = modeBeforeAction(page.pluginMode(), page.panelMode(), a);
      if (switchTo) {
        log("info", "overlay panel action switches the mode first", JSON.stringify({ action: a.kind, from: page.pluginMode(), to: switchTo }));
        page.setMode(switchTo);
        if (page.pluginMode() !== switchTo) {
          // setMode refuses while a run is going: never let a panel click run the wrong mode
          log("warn", "overlay panel action dropped: the mode could not be switched", a.kind, page.pluginMode());
          return;
        }
      }
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
        case "optimize-prompt": return page.optimizePrompt();
        case "restore-prompt": return page.restorePrompt();
        case "pick-favorite": return page.pickFavorite(a.text);
        case "remove-favorite": return page.removeFavorite(a.text);
        case "add-ref": return page.addRef(a.slot, a.source as "layer" | "file" | "clipboard");
        case "drop-ref": return page.addLayerReferences(a.slot, a.docId, [{ layerId: a.layerId, name: a.name }], 1);
        case "drop-refs": return page.addLayerReferences(a.slot, a.docId, a.layers, a.totalCount);
        case "finish-layer-drag": return page.finishLayerDrag();
        case "remove-ref": return page.removeRef(a.slot);
      }
    },
    onViewRequest() { corner.viewRequested(GENERATE_PANEL); },
  });

  const surface = {
    /** The page's state or Photoshop's may have changed: the corner looks again, what changed is sent. */
    refresh() {
      corner.refresh();
      overlay.queueSync();
    },
  };
  return surface;
}
