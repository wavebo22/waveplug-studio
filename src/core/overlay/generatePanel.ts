// The external generate panel (外置生成面板, surface "generate"): the generate page's state and
// what the user can do there. Same shapes as native/overlay/src/panel/generate/.

import { MAX_REFERENCES } from "../workflow/references.ts";

export const GENERATE_PANEL = "generate";

/** The modes the external panel has tabs for. 扩图 / 放大 live only in the plugin panel. */
export const PANEL_MODES = ["inpaint", "blend", "extract", "txt2img"] as const;
export type PanelMode = typeof PANEL_MODES[number];
export const isPanelMode = (m: unknown): m is PanelMode => (PANEL_MODES as readonly unknown[]).includes(m);

/** The mode the panel shows: the plugin's own when the panel has a tab for it, else the one last
 *  used here. The panel never shows (or runs) 扩图 / 放大: after the plugin was left in one of
 *  them (used there, or followed a selected 放大 result), the panel stays on its own mode. */
export function shownPanelMode(pluginMode: string, remembered: string | undefined): PanelMode {
  return isPanelMode(pluginMode) ? pluginMode : isPanelMode(remembered) ? remembered : "inpaint";
}

/** Before the plugin acts on something done in the panel: the mode it has to switch to first,
 *  so what runs is what the panel showed (null: it is in that mode already). `generate` names
 *  the mode its tab showed when it was clicked, which wins over a state the panel hadn't got yet. */
export function modeBeforeAction(pluginMode: string, shown: PanelMode, a: GenerateAction): PanelMode | null {
  if (a.kind === "set-mode" || a.kind === "cancel" || a.kind === "finish-layer-drag") return null;
  const want = a.kind === "generate" && a.mode ? a.mode : shown;
  return pluginMode === want ? null : want;
}

export type PanelParam =
  | { kind: "number"; key: string; label: string; value: number; base: number; min: number; max: number; int: boolean }
  | { kind: "toggle"; key: string; label: string; value: boolean; tip: string }
  | { kind: "seed"; random: boolean; value: number };

export interface GenerateSections {
  /** always one of PANEL_MODES (shownPanelMode) */
  mode: PanelMode;
  prompt: string;
  /** the grey hint inside the prompt box */
  hint: string;
  favorites: string[];
  refs: { slot: number; tag: string | null; name: string | null; thumb?: string | null }[];
  count: number;
  /** the generate button's text: 生成 / 融图 / 抠图 / 生成更多变体 … */
  action: string;
  /** why it can't run now; null = it can */
  blocked: string | null;
  params: PanelParam[];
  run: { stage: string; progress: number } | null;
  status: { tone: "info" | "ok" | "error"; text: string };
  /** a line under the button about what the panel will do (the plugin is in another mode …); null: none */
  note: string | null;
}

export type GenerateAction =
  | { kind: "set-mode"; mode: string }
  | { kind: "set-prompt"; text: string }
  | { kind: "set-count"; count: number }
  | { kind: "set-number"; key: string; value: number }
  | { kind: "reset-number"; key: string }
  | { kind: "set-toggle"; key: string; value: boolean }
  | { kind: "set-seed"; random: boolean; value: number }
  | { kind: "new-seed" }
  | { kind: "toggle-favorite" }
  | { kind: "pick-favorite"; text: string }
  | { kind: "remove-favorite"; text: string }
  | { kind: "add-ref"; slot: number; source: "layer" | "file" | "clipboard" }
  | { kind: "drop-ref"; slot: number; docId: number; layerId: number; name: string }
  | { kind: "drop-refs"; slot: number; docId: number; layers: { layerId: number; name: string }[]; totalCount: number }
  | { kind: "finish-layer-drag" }
  | { kind: "remove-ref"; slot: number }
  | { kind: "generate"; mode?: PanelMode }
  | { kind: "cancel" };

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseGenerateAction(a: any): GenerateAction | null {
  switch (a?.kind) {
    case "set-mode": return str(a.mode) ? { kind: a.kind, mode: a.mode } : null;
    case "set-prompt": return str(a.text) ? { kind: a.kind, text: a.text } : null;
    case "set-count": return Number.isInteger(a.count) ? { kind: a.kind, count: Math.max(1, Math.min(4, a.count)) } : null;
    case "set-number": return str(a.key) && num(a.value) ? { kind: a.kind, key: a.key, value: a.value } : null;
    case "reset-number": return str(a.key) ? { kind: a.kind, key: a.key } : null;
    case "set-toggle": return str(a.key) && typeof a.value === "boolean" ? { kind: a.kind, key: a.key, value: a.value } : null;
    case "set-seed": return typeof a.random === "boolean" && num(a.value) ? { kind: a.kind, random: a.random, value: a.value } : null;
    case "pick-favorite": case "remove-favorite": return str(a.text) ? { kind: a.kind, text: a.text } : null;
    case "add-ref": return num(a.slot) && (a.source === "layer" || a.source === "file" || a.source === "clipboard")
      ? { kind: a.kind, slot: a.slot, source: a.source } : null;
    case "drop-ref": return Number.isInteger(a.slot) && a.slot >= 1 && Number.isInteger(a.docId) && a.docId > 0
      && Number.isInteger(a.layerId) && a.layerId > 0 && str(a.name)
      ? { kind: a.kind, slot: a.slot, docId: a.docId, layerId: a.layerId, name: a.name } : null;
    case "drop-refs": {
      if (!Number.isInteger(a.slot) || a.slot < 1 || a.slot > MAX_REFERENCES || !Number.isInteger(a.docId) || a.docId <= 0
        || !Array.isArray(a.layers) || a.layers.length < 1 || a.layers.length > MAX_REFERENCES) return null;
      const layers = a.layers.filter((layer: any) => Number.isInteger(layer?.layerId) && layer.layerId > 0 && str(layer.name));
      if (layers.length !== a.layers.length) return null;
      const totalCount = Number.isInteger(a.totalCount) && a.totalCount >= layers.length ? Math.min(a.totalCount, 10000) : layers.length;
      return { kind: a.kind, slot: a.slot, docId: a.docId, layers, totalCount };
    }
    case "finish-layer-drag": return { kind: a.kind };
    case "remove-ref": return num(a.slot) ? { kind: a.kind, slot: a.slot } : null;
    case "generate":
      if (a.mode === undefined) return { kind: a.kind };
      return isPanelMode(a.mode) ? { kind: a.kind, mode: a.mode } : null;
    case "new-seed": case "toggle-favorite": case "cancel": return { kind: a.kind };
    default: return null;
  }
}
