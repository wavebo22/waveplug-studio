// The native AI 整理 window (helper ≥ ASSIST_HELPER_VERSION, native/overlay/src/panel/organize.rs):
// the AI 整理图层 plan in the same window slot as 检查结果, beside the WavePlug 图层 panel. Hovering a
// row lights its layers up and draws lines to them (as 检查结果 does). Pure
// (tests/overlay_organize.test.ts).

import type { OrganizePlan } from "../assistant/organize.ts";

export const ORGANIZE_PANEL = "organize";

export interface OrganizePanelItem {
  key: string;
  /** a rename: the old name; a new group: "" */
  from: string;
  to: string;
  /** a new group: what goes in */
  members: string;
  on: boolean;
  pick: boolean;
}

export interface OrganizeSections {
  head: { scope: string; busy: string; error: string };
  opts: { extra: string; renameOnly: boolean };
  plan: { renames: OrganizePanelItem[]; groups: OrganizePanelItem[]; dropped: string[] };
}

export type OrganizeAction =
  | { kind: "hover"; key: string | null }
  | { kind: "toggle"; key: string }
  | { kind: "extra"; text: string }
  | { kind: "rename-only"; on: boolean }
  | { kind: "analyse" }
  | { kind: "apply" }
  | { kind: "close" };

export const renameKey = (id: number) => "r:" + id;
export const groupKey = (i: number) => "g:" + i;

/** The plan as the window lists it; `nameOf`: a layer's name (its new one when it is renamed too). */
export function organizePlanSection(plan: OrganizePlan | null, offRenames: ReadonlySet<number>, offGroups: ReadonlySet<number>, nameOf: (id: number) => string): OrganizeSections["plan"] {
  if (!plan) return { renames: [], groups: [], dropped: [] };
  return {
    renames: plan.renames.map(r => ({ key: renameKey(r.id), from: r.from, to: r.to, members: "", on: !offRenames.has(r.id), pick: true })),
    groups: plan.groups.map((g, i) => ({ key: groupKey(i), from: "", to: g.name, members: `${g.ids.length} 个：${g.ids.map(nameOf).join("、")}`, on: !offGroups.has(i), pick: g.ids.length > 0 })),
    dropped: plan.dropped.slice(0, 40),
  };
}

/** The layers an item stands for (a rename: its layer; a group: what goes in). */
export function organizeItemIds(plan: OrganizePlan | null, key: string): number[] {
  if (!plan) return [];
  if (key.startsWith("r:")) { const id = Number(key.slice(2)); return plan.renames.some(r => r.id === id) ? [id] : []; }
  if (key.startsWith("g:")) return [...(plan.groups[Number(key.slice(2))]?.ids ?? [])];
  return [];
}

export function parseOrganizeAction(raw: unknown): OrganizeAction | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  const key = typeof a.key === "string" && /^[rg]:\d{1,9}$/.test(a.key) ? a.key : null;
  switch (a.kind) {
    case "hover": return a.key === null ? { kind: "hover", key: null } : key ? { kind: "hover", key } : null;
    case "toggle": return key ? { kind: "toggle", key } : null;
    case "extra": return typeof a.text === "string" ? { kind: "extra", text: a.text.slice(0, 300) } : null;
    case "rename-only": return typeof a.on === "boolean" ? { kind: "rename-only", on: a.on } : null;
    case "analyse": return { kind: "analyse" };
    case "apply": return { kind: "apply" };
    case "close": return { kind: "close" };
    default: return null;
  }
}
