// The external generate panel (外置生成面板, surface "generate"): the generate page's state and
// what the user can do there. Same shapes as native/overlay/src/panel/generate/.

import { MAX_REFERENCES } from "../workflow/references.ts";

export const GENERATE_PANEL = "generate";

export type PanelParam =
  | { kind: "number"; key: string; label: string; value: number; base: number; min: number; max: number; int: boolean }
  | { kind: "toggle"; key: string; label: string; value: boolean; tip: string }
  | { kind: "seed"; random: boolean; value: number };

export interface GenerateSections {
  /** inpaint / blend / extract / txt2img / outpaint / upscale */
  mode: string;
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
  | { kind: "generate" }
  | { kind: "cancel" };

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseGenerateAction(a: any): GenerateAction | null {
  switch (a?.kind) {
    case "set-mode": return str(a.mode) ? { kind: a.kind, mode: a.mode } : null;
    case "set-prompt": return str(a.text) ? { kind: a.kind, text: a.text } : null;
    case "set-count": return num(a.count) ? { kind: a.kind, count: Math.max(1, Math.min(4, Math.round(a.count))) } : null;
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
    case "new-seed": case "toggle-favorite": case "generate": case "cancel": return { kind: a.kind };
    default: return null;
  }
}
