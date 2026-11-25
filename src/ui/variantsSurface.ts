// Native variant rail. The Photoshop generation page owns the actual layers and thumbnails.
// This module only handles selection-driven show/hide and validates actions from the helper.
import type { Overlay } from "../app/overlay.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { NOT_SHOWN, type Shown, decide } from "../core/overlay/visibility.ts";
import { VARIANTS_PANEL, parseVariantsAction, type VariantsSections, type VariantsAction } from "../core/overlay/variantsPanel.ts";

interface VariantPage {
  sections(): VariantsSections | null;
  canvasView(docId: number): Promise<CanvasView | null>;
  showVariant(layerId: number, groupId: number): void;
  deleteVariant(layerId: number, groupId: number): void;
}

export function attachVariantsSurface(overlay: Overlay, page: VariantPage) {
  const { hub } = overlay;
  let asking = 0;
  let last: VariantsSections | null = null;
  /** what is up (core/overlay/visibility.ts) */
  let vis: Shown = NOT_SHOWN;
  let again: ReturnType<typeof setTimeout> | null = null;
  /** No wait (user, 11-12): the rail belongs to the selected AI layer and goes the moment another
   *  layer, or none, is selected; the helper slides it out (native/overlay/src/anim.rs). */
  const HIDE_DELAY_MS = 0;
  let lastView: import("../core/overlay/protocol.ts").ScreenRect | null = null;

  hub.register<VariantsSections, VariantsAction>({
    id: VARIANTS_PANEL,
    // while a hide is waiting the rail keeps what it showed: an empty state would blank it first
    sections: () => {
      const s = page.sections();
      if (s && s.items.length) { last = s; return s; }
      return vis.shown && last ? last : { docId: -1, groupId: -1, name: "", items: [] };
    },
    parseAction: parseVariantsAction,
    onAction: a => a.kind === "delete-variant" ? page.deleteVariant(a.layerId, a.groupId) : page.showVariant(a.layerId, a.groupId),
    onViewRequest: () => {
      const state = page.sections();
      if (state) void putUp(state);
    },
  });

  async function putUp(state: VariantsSections) {
    const call = ++asking;
    const view = await page.canvasView(state.docId).catch(() => null);
    if (call !== asking) return;
    const actual = page.sections();
    if (!actual || actual.docId !== state.docId || actual.groupId !== state.groupId) return;
    lastView = view?.view ?? lastView;
    // The hub sends state BEFORE show, including the selected variation thumbnails.
    hub.show(VARIANTS_PANEL, view?.view ?? lastView);
  }

  const surface = {
    refresh() {
      if (again) { clearTimeout(again); again = null; }
      const s = page.sections(), wanted = !!s && s.items.length > 0;
      // without a readable AI layer the document isn't known: keep the one the rail is up for
      const v = decide(vis, { docId: wanted ? s!.docId : vis.docId ?? -1, wanted, subject: wanted ? String(s!.groupId) : "" }, Date.now(), HIDE_DELAY_MS);
      vis = v.state;
      if (v.do === "hide") {
        ++asking;
        hub.hide(VARIANTS_PANEL);
      } else if (wanted && (v.do === "show" || !hub.isShown(VARIANTS_PANEL))) {
        void putUp(s!);
      } else if (v.do === "keep" && v.againInMs !== undefined) {
        const wait = v.againInMs;
        again = setTimeout(() => { again = null; surface.refresh(); }, wait + 10);
      } else if (wanted) {
        overlay.queueSync();
      }
    },
  };
  return surface;
}
