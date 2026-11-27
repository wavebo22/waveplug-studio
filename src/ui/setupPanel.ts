// A feature's settings panel in the canvas-corner window (检查 / AI 整理 / 改写): the panel's button
// opens it instead of starting right away; 开始 there starts the feature with what was set, ×
// closes it. It claims the corner window (app/cornerSlot.ts) only while open and only for the
// document it was opened for, above the generate panel; opening one closes the others.

import type { Overlay } from "../app/overlay.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { type SetupAction, type SetupSections, SETUP_PRIORITY, parseSetupAction } from "../core/overlay/setupPanel.ts";

export interface SetupPanelDeps {
  overlay?: Overlay;
  id: string;
  docId(): number | null;
  form(): SetupSections["form"];
  set(key: string, value: boolean | string): void;
  /** 开始: the panel has closed; run the feature */
  start(): void;
  view(docId: number): Promise<CanvasView | null>;
}

export interface SetupPanel { open(): void; close(quiet?: boolean): void; isOpen(): boolean; sync(): void }

/** the settings panels: one open at a time */
const all = new Set<SetupPanel>();

export function createSetupPanel(d: SetupPanelDeps): SetupPanel {
  let open = false, openFor: number | null = null;
  const ov = d.overlay;
  const panel: SetupPanel = {
    open() {
      // the others close without a corner step of their own: one step then puts this one up in
      // their place (shown first, the old one hidden after), never hide-then-show
      for (const p of all) if (p !== panel) p.close(true);
      open = true; openFor = d.docId();
      ov?.queueSync();
      ov?.corner.refresh();
    },
    close(quiet = false) {
      if (!open) return;
      open = false;
      if (!quiet) ov?.corner.refresh();
    },
    isOpen: () => open,
    sync() { if (open) ov?.queueSync(); },
  };
  all.add(panel);
  if (ov) {
    ov.hub.register<SetupSections, SetupAction>({
      id: d.id,
      sections: () => ({ form: d.form() }),
      parseAction: parseSetupAction,
      onAction(a) {
        if (a.kind === "set") { d.set(a.key, a.value); ov.queueSync(); return; }
        if (a.kind === "close") { panel.close(); return; }
        if (!d.form().start) return; // it can't start now (the note says why)
        panel.close();
        d.start();
      },
      onViewRequest() { ov.corner.viewRequested(d.id); },
    });
    // wanted while open, for the document it was opened for (another one in front: it waits)
    ov.corner.claim(d.id, SETUP_PRIORITY, () => ({ docId: open ? openFor : null, wanted: open && d.docId() === openFor }), docId => d.view(docId));
  }
  return panel;
}
