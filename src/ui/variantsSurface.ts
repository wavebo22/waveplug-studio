// Native variant rail. The Photoshop generation page owns the actual layers and thumbnails.
// This module only handles selection-driven show/hide and validates actions from the helper.
import type { Overlay } from "../app/overlay.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { VARIANTS_PANEL, parseVariantsAction, type VariantsSections, type VariantsAction } from "../core/overlay/variantsPanel.ts";

interface VariantPage {
  sections(): VariantsSections | null;
  canvasView(docId: number): Promise<CanvasView | null>;
  showVariant(layerId: number, groupId: number): void;
}

export function attachVariantsSurface(overlay: Overlay, page: VariantPage) {
  const { hub } = overlay;
  let asking = 0;
  let shownKey = "";
  let lastView: import("../core/overlay/protocol.ts").ScreenRect | null = null;

  hub.register<VariantsSections, VariantsAction>({
    id: VARIANTS_PANEL,
    sections: () => page.sections() ?? { docId: -1, groupId: -1, name: "", items: [] },
    parseAction: parseVariantsAction,
    onAction: a => page.showVariant(a.layerId, a.groupId),
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

  return {
    refresh() {
      const s = page.sections();
      if (!s || !s.items.length) {
        ++asking;
        shownKey = "";
        hub.hide(VARIANTS_PANEL);
        return;
      }
      const key = s.docId + ":" + s.groupId;
      if (!hub.isShown(VARIANTS_PANEL) || shownKey !== key) {
        shownKey = key;
        void putUp(s);
      } else {
        overlay.queueSync();
      }
    },
  };
}
