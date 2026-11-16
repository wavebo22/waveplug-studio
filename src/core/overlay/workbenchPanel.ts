// The native 编辑工作台 window (native/overlay/src/panel/shelf.rs): the sections the plugin sends
// and the actions it takes back. Pure (tests/workbench_panel.test.ts).
import {
  canPlace, docLabel, stagedKey, stateText, type EntryStatus, type StagedLayer, type WorkbenchPrefs,
} from "../layers/workbench.ts";

export const WORKBENCH_PANEL = "workbench";

export interface WorkbenchPanelEntry { key: string; name: string; doc: string; state: string; usable: boolean; thumb?: string }
export interface WorkbenchSections {
  entries: WorkbenchPanelEntry[];
  summary: { target: string; busy: boolean; status: string; positionSelection: boolean; wrapGroup: boolean; restore: boolean };
}

export function workbenchSections(
  entries: readonly StagedLayer[], statusOf: (e: StagedLayer) => EntryStatus, prefs: WorkbenchPrefs,
  extra: { target: string; busy: boolean; status: string },
): WorkbenchSections {
  return {
    entries: entries.map(e => {
      const st = statusOf(e);
      return { key: stagedKey(e), name: e.name, doc: docLabel(e.docKey), state: stateText(e, st), usable: canPlace(e, st), ...(e.thumb ? { thumb: e.thumb } : {}) };
    }),
    summary: { ...extra, positionSelection: prefs.position === "selection", wrapGroup: prefs.wrapGroup, restore: prefs.restore },
  };
}

export type WorkbenchAction =
  | { kind: "place"; keys: string[] }
  | { kind: "remove"; keys: string[] }
  | { kind: "clear" }
  | { kind: "close" }
  | { kind: "pref"; name: "position"; value: "top" | "selection" }
  | { kind: "pref"; name: "wrapGroup" | "restore"; value: boolean }
  /** a WaveLayer drag was let go over the window; the ids are a hint (the plugin knows its drag) */
  | { kind: "stage-drop"; docId: number; layerIds: number[] }
  /** rows dragged out of the window: export them for other programs */
  | { kind: "drag-out"; keys: string[] }
  /** …and let go over Photoshop: place them into the active document */
  | { kind: "drop-into-ps"; keys: string[] }
  | { kind: "drag-out-end"; ending: string };

const keyList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(k => typeof k === "string" && /^\d+:\d+$/.test(k)) ? (v as string[]).slice(0, 200) : null;

export function parseWorkbenchAction(raw: unknown): WorkbenchAction | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  switch (a.kind) {
    case "place": case "remove": case "drag-out": case "drop-into-ps": {
      const keys = keyList(a.keys);
      return keys ? { kind: a.kind, keys } : null;
    }
    case "clear": case "close": return { kind: a.kind };
    case "pref":
      if (a.name === "position" && (a.value === "top" || a.value === "selection")) return { kind: "pref", name: "position", value: a.value };
      if ((a.name === "wrapGroup" || a.name === "restore") && typeof a.value === "boolean") return { kind: "pref", name: a.name, value: a.value };
      return null;
    case "stage-drop": {
      const ids = Array.isArray(a.layerIds) ? a.layerIds.filter((x): x is number => Number.isInteger(x) && (x as number) > 0) : [];
      return { kind: "stage-drop", docId: Number.isInteger(a.docId) ? Number(a.docId) : 0, layerIds: ids };
    }
    case "drag-out-end": return { kind: "drag-out-end", ending: typeof a.ending === "string" ? a.ending.slice(0, 20) : "" };
    default: return null;
  }
}
