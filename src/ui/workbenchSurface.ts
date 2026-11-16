// The native 编辑工作台 window (helper ≥ WORKBENCH_HELPER_VERSION): the same list as the in-panel
// workbench (workbench.ts, which keeps doing the checks and the placing), shown beside the canvas
// whichever document is active. Layers dragged onto it from any document are staged; rows dragged
// out of it go into Photoshop (the active document) or to other programs (layerTree exports them).
import type { Overlay } from "../app/overlay.ts";
import { log } from "../app/log.ts";
import { helperOutdated, WORKBENCH_HELPER_VERSION, type CanvasView } from "../core/overlay/protocol.ts";
import { WORKBENCH_PANEL, parseWorkbenchAction, workbenchSections, type WorkbenchAction, type WorkbenchSections } from "../core/overlay/workbenchPanel.ts";
import { stagedKey, type StagedLayer } from "../core/layers/workbench.ts";
import type { WorkbenchSection } from "./workbench.ts";
import { clearWorkbench, onWorkbenchChange, removeFromWorkbench, setWorkbenchPrefs, workbenchState } from "./workbenchStore.ts";

const OPEN_KEY = "wp.workbench.native";

export interface WorkbenchSurfaceDeps {
  section: WorkbenchSection;
  currentDoc(): number | null;
  canvasView(docId: number): Promise<CanvasView | null>;
  /** a WaveLayer drag was let go over the window */
  stageDrop(docId: number, layerIds: number[]): void;
  /** rows are being dragged out: export them for other programs */
  dragOut(entries: StagedLayer[]): void;
  dragOutEnd(ending: string): void;
}

export function attachWorkbenchSurface(overlay: Overlay, deps: WorkbenchSurfaceDeps) {
  const { hub } = overlay, { section } = deps;
  let wanted = (() => { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; } })();
  let asking = 0;

  const available = () => overlay.connected && !helperOutdated(overlay.helperVersion, WORKBENCH_HELPER_VERSION);
  const entriesOf = (keys: readonly string[]) => {
    const want = new Set(keys);
    return workbenchState().staged.filter(e => want.has(stagedKey(e)));
  };

  hub.register<WorkbenchSections, WorkbenchAction>({
    id: WORKBENCH_PANEL,
    sections: () => {
      const { staged, prefs } = workbenchState(), st = section.state();
      const cur = deps.currentDoc();
      const target = section.docs().find(d => d.docId === cur)?.name ?? "";
      return workbenchSections(staged, section.statusOf, prefs, { target, busy: st.busy, status: st.line });
    },
    parseAction: parseWorkbenchAction,
    onAction(a) {
      log("info", "workbench window action", a.kind, "keys" in a ? a.keys.length : "");
      switch (a.kind) {
        case "place": section.place(a.keys, deps.currentDoc()); break;
        case "drop-into-ps": section.place(a.keys, deps.currentDoc()); break;
        case "remove": removeFromWorkbench(new Set(a.keys)); break;
        case "clear": clearWorkbench(); break;
        case "close": setWanted(false); break;
        case "pref":
          if (a.name === "position") setWorkbenchPrefs({ position: a.value });
          else setWorkbenchPrefs({ [a.name]: a.value });
          break;
        case "stage-drop": deps.stageDrop(a.docId, a.layerIds); break;
        case "drag-out": deps.dragOut(entriesOf(a.keys).filter(e => section.statusOf(e) !== "docClosed")); break;
        case "drag-out-end": deps.dragOutEnd(a.ending); break;
      }
    },
    onViewRequest: () => { if (wanted) void putUp(); },
  });

  async function putUp() {
    const call = ++asking, doc = deps.currentDoc();
    const view = doc !== null ? await deps.canvasView(doc).catch(() => null) : null;
    if (call !== asking || !wanted || !available()) return;
    hub.show(WORKBENCH_PANEL, view?.view ?? hub.viewOf(WORKBENCH_PANEL));
  }
  function setWanted(on: boolean) {
    wanted = on;
    try { localStorage.setItem(OPEN_KEY, on ? "1" : "0"); } catch { /* this session only */ }
    if (on) { section.refreshDocs(); void putUp(); }
    else { ++asking; hub.hide(WORKBENCH_PANEL); }
  }

  const sync = () => { if (hub.isShown(WORKBENCH_PANEL)) overlay.queueSync(); };
  onWorkbenchChange(sync);
  section.onPaint(sync);
  overlay.onConnected(() => { if (wanted && available()) void putUp(); });
  section.setNative({
    available,
    shown: () => available() && hub.isShown(WORKBENCH_PANEL),
    toggle: () => setWanted(!hub.isShown(WORKBENCH_PANEL)),
  });
  if (wanted && available()) void putUp();

  return {
    /** the panel's document changed: the window follows its canvas */
    docChanged() { if (wanted && available()) void putUp(); },
    shown: () => hub.isShown(WORKBENCH_PANEL),
  };
}
