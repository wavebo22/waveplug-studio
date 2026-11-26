// The native AI 整理 window (helper ≥ ASSIST_HELPER_VERSION, native/overlay/src/panel/organize.rs):
// the AI 整理图层 plan in the same window slot as 检查结果, beside the WavePlug 图层 panel. Hovering a
// row lights its layers up and draws lines to them (as 检查结果 does). The same window, with its
// own title, presets and labels, shows AI 改写文字 (REWRITE_PANEL, helper ≥ REWRITE_HELPER_VERSION).
// Pure (tests/overlay_organize.test.ts).

import type { OrganizePlan } from "../assistant/organize.ts";
import type { RewriteItem } from "../assistant/rewrite.ts";

export const ORGANIZE_PANEL = "organize";
export const REWRITE_PANEL = "rewrite";

export interface OrganizePanelItem {
  key: string;
  /** a rename: the old name; a new group: "" */
  from: string;
  to: string;
  /** a new group: what goes in */
  members: string;
  on: boolean;
  pick: boolean;
  /** can't be ticked (shown as a suggestion only) */
  lock?: boolean;
  /** a small line under it */
  note?: string;
}

export interface OrganizeSections {
  /** title: the window's name (AI 整理 when absent) */
  head: { scope: string; busy: string; error: string; title?: string };
  /** hint: the field's placeholder; toggle: the checkbox's label ("" hides it); presets: buttons
   *  that fill the field and start; go: the start button's label */
  opts: { extra: string; renameOnly: boolean; hint?: string; toggle?: string; presets?: string[]; go?: string };
  /** renameTitle: the first list's heading (改名); empty: shown when there is nothing to list */
  plan: { renames: OrganizePanelItem[]; groups: OrganizePanelItem[]; dropped: string[]; renameTitle?: string; empty?: string };
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

/** AI 改写's list: old → new per layer; a mixed-style layer is a suggestion only (locked). */
export function rewritePlanSection(items: readonly RewriteItem[], off: ReadonlySet<number>, mixed: ReadonlySet<number>, empty: string): OrganizeSections["plan"] {
  const cut = (t: string, n: number) => t.length > n ? t.slice(0, n - 1) + "…" : t;
  return {
    renames: items.map(i => ({
      key: renameKey(i.id), from: cut(i.from.replace(/\n/g, " ⏎ "), 160), to: cut(i.to.replace(/\n/g, " ⏎ "), 400), members: "",
      on: !mixed.has(i.id) && !off.has(i.id), pick: true,
      ...(mixed.has(i.id) ? { lock: true, note: "混排样式（多种字体 / 字号 / 颜色）：只给建议，替换会丢掉样式，请手动修改" } : {}),
    })),
    groups: [], dropped: [], renameTitle: "改写", empty,
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
