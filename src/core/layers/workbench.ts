// 编辑工作台 / 发送到：pure model. A staged layer is a reference to a layer of an *open* Photoshop
// document, not an image copy; staging never modifies a PSD. The list is kept across panel reloads
// by docKey (the document's file, or its title before it is saved): Photoshop hands out new
// document ids every session, layer ids are stored in the file.

import type { Rect } from "./placementRestore.ts";

/** Where the layer was on its canvas when it was staged (rules: core/layers/placementRestore.ts). */
export interface StagedGeom {
  canvas: { width: number; height: number };
  bounds: Rect | null;
}

export interface StagedLayer {
  docId: number;
  docKey: string;
  layerId: number;
  name: string;
  kind: string;
  /** small picture taken when staged (data URL) */
  thumb?: string;
  geom?: StagedGeom;
  /** a PNG of the layer kept in the plugin's data folder (its file name): placed as a smart object
   *  when the source PSD is closed or the layer is gone */
  snap?: string;
}

/** What the workbench knows about an entry right now. */
export type EntryStatus = "ok" | "renamed" | "docClosed" | "missing" | "unknown";

export interface OpenDoc { docId: number; docKey: string; name: string }

export const MAX_STAGED = 200;

/** 编辑工作台 on / off (11-13, user: hidden for now, to be reconsidered later). Off: no 工作台 button,
 *  no drop zone while dragging, no native window, no 加入工作台 in the menu. 发送到 stays. The code
 *  and the saved list stay as they are; turning it back on is this one line. */
export const WORKBENCH_ENABLED = false;

export function stagedKey(item: Pick<StagedLayer, "docId" | "layerId">): string {
  return item.docId + ":" + item.layerId;
}
const validRef = (x: Pick<StagedLayer, "docId" | "layerId">) =>
  Number.isInteger(x.docId) && Number.isInteger(x.layerId) && x.docId > 0 && x.layerId > 0;

/** Stable, duplicate-free ordering across source documents. Distinct PSDs can reuse layer IDs.
 *  A layer staged again replaces its old picture and geometry but keeps its place. */
export function appendStagedLayers(existing: readonly StagedLayer[], items: readonly StagedLayer[]): StagedLayer[] {
  const out = existing.map(x => ({ ...x }));
  const at = new Map(out.map((x, i) => [stagedKey(x), i]));
  for (const item of items) {
    if (!validRef(item)) continue;
    const key = stagedKey(item), i = at.get(key);
    if (i !== undefined) { out[i] = { ...out[i], ...item }; continue; }
    if (out.length >= MAX_STAGED) break;
    at.set(key, out.length);
    out.push({ ...item });
  }
  return out;
}

export function removeStaged(entries: readonly StagedLayer[], keys: ReadonlySet<string>): StagedLayer[] {
  return entries.filter(x => !keys.has(stagedKey(x)));
}

/** After a reload (or a document closed and opened again) the same file has a new document id:
 *  entries follow their docKey to the open document. A docKey open twice is ambiguous: kept as is. */
export function rebindEntries(entries: readonly StagedLayer[], docs: readonly OpenDoc[]): StagedLayer[] {
  const byKey = new Map<string, number | null>();
  for (const d of docs) byKey.set(d.docKey, byKey.has(d.docKey) ? null : d.docId);
  return entries.map(e => {
    if (docs.some(d => d.docId === e.docId && d.docKey === e.docKey)) return e;
    const id = byKey.get(e.docKey);
    return id ? { ...e, docId: id } : e;
  });
}

/** `probe`: the layer as Photoshop has it now (null: no such layer; undefined: not checked yet). */
export function entryStatus(entry: StagedLayer, docs: readonly OpenDoc[], probe: { name: string } | null | undefined): EntryStatus {
  if (!docs.some(d => d.docId === entry.docId && d.docKey === entry.docKey)) return "docClosed";
  if (probe === undefined) return "unknown";
  if (probe === null) return "missing";
  return probe.name === entry.name ? "ok" : "renamed";
}
export const usable = (s: EntryStatus) => s === "ok" || s === "renamed" || s === "unknown";
/** Whether 置入 can take the entry: from its source, or from its snapshot when the source is gone. */
export const canPlace = (e: StagedLayer, s: EntryStatus) => usable(s) || (!!e.snap && !!e.geom?.bounds);
/** What the list says about the entry ("" when nothing is wrong). */
export function stateText(e: StagedLayer, s: EntryStatus): string {
  if (usable(s)) return STATUS_TEXT[s];
  return STATUS_TEXT[s] + (canPlace(e, s) ? " · 用快照" : "");
}
/** The snapshot file name of a layer: stable per document and layer (staging again overwrites it). */
export function snapName(docKey: string, layerId: number): string {
  let h = 2166136261;
  for (const ch of docKey) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0; }
  return `wb_${h.toString(36)}_${layerId}.png`;
}
const SNAP_NAME = /^wb_[0-9a-z]+_\d+\.png$/;

export const STATUS_TEXT: Record<EntryStatus, string> = {
  ok: "", renamed: "已改名", docClosed: "来源未打开", missing: "图层已删除", unknown: "",
};

/** The file name shown for a docKey (a path or a title). */
export const docLabel = (key: string) => key.split(/[\\/]/).pop() || key;

/** Entries grouped by source document, in the order the documents were first staged. */
export function groupBySource(entries: readonly StagedLayer[]): { docKey: string; label: string; items: StagedLayer[] }[] {
  const groups = new Map<string, StagedLayer[]>();
  for (const e of entries) {
    const g = groups.get(e.docKey);
    if (g) g.push(e); else groups.set(e.docKey, [e]);
  }
  return [...groups].map(([docKey, items]) => ({ docKey, label: docLabel(docKey), items }));
}

/** Click / Ctrl+click / Shift+click on `key` in the list `order` (like the layer list). */
export function clickSelection(
  order: readonly string[], selected: ReadonlySet<string>, anchor: string | null, key: string,
  mods: { ctrl: boolean; shift: boolean },
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor !== null && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(key);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const out = mods.ctrl ? new Set(selected) : new Set<string>();
    for (const k of range) out.add(k);
    return { selected: out, anchor };
  }
  if (mods.ctrl) {
    const out = new Set(selected);
    if (out.has(key)) out.delete(key); else out.add(key);
    return { selected: out, anchor: key };
  }
  return { selected: new Set([key]), anchor: key };
}

// ── persistence ──
const str = (v: unknown, max = 400) => typeof v === "string" ? v.slice(0, max) : "";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : NaN;
function rect(v: any): Rect | null {
  if (!v || typeof v !== "object") return null;
  const r = { left: num(v.left), top: num(v.top), right: num(v.right), bottom: num(v.bottom) };
  return Object.values(r).every(Number.isFinite) ? r : null;
}
export function serializeWorkbench(entries: readonly StagedLayer[]): string {
  return JSON.stringify({ v: 2, entries: entries.slice(0, MAX_STAGED) });
}
/** Anything unreadable gives an empty list, never an exception. */
export function parseWorkbench(text: string | null | undefined): StagedLayer[] {
  if (!text) return [];
  let data: any;
  try { data = JSON.parse(text); } catch { return []; }
  const raw: any[] = Array.isArray(data?.entries) ? data.entries : [];
  const out: StagedLayer[] = [];
  for (const e of raw) {
    const item: StagedLayer = {
      docId: num(e?.docId), docKey: str(e?.docKey), layerId: num(e?.layerId),
      name: str(e?.name, 200), kind: str(e?.kind, 40),
    };
    if (!validRef(item) || !item.docKey) continue;
    if (typeof e.thumb === "string" && e.thumb.startsWith("data:") && e.thumb.length < 40000) item.thumb = e.thumb;
    if (typeof e.snap === "string" && SNAP_NAME.test(e.snap)) item.snap = e.snap;
    const c = e.geom?.canvas;
    if (c && num(c.width) > 0 && num(c.height) > 0)
      item.geom = { canvas: { width: c.width, height: c.height }, bounds: rect(e.geom.bounds) };
    out.push(item);
  }
  return appendStagedLayers([], out);
}

// ── settings (shared by the workbench's 置入 and the menu's 发送到) ──
export interface WorkbenchPrefs {
  /** "top": above everything; "selection": above the target's topmost selected layer */
  position: "top" | "selection";
  /** 置入 wraps the copies in one new group */
  wrapGroup: boolean;
  groupName: string;
  /** 还原画面位置 (placementRestore rules) */
  restore: boolean;
  /** 按长边缩放: the source canvas is 100%, the content scales by target long edge / source long edge */
  scaleLongEdge: boolean;
  scaleWithCanvas: boolean;
  /** a copy goes into the target's group with the same name path as its source parent, if any */
  matchParents: boolean;
  /** make the target document the active one afterwards */
  switchAfter: boolean;
  /** 置入后从工作台移出 */
  removeAfter: boolean;
}
export const DEFAULT_GROUP_NAME = "工作台素材";
export const DEFAULT_PREFS: WorkbenchPrefs = {
  position: "top", wrapGroup: true, groupName: DEFAULT_GROUP_NAME, restore: true,
  scaleLongEdge: true, scaleWithCanvas: false, matchParents: true, switchAfter: false, removeAfter: false,
};
/** `legacyPosition`: the 11-04 checkbox's value ("selected" / "top"), used once. */
export function parsePrefs(text: string | null | undefined, legacyPosition?: string | null): WorkbenchPrefs {
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const out: WorkbenchPrefs = { ...DEFAULT_PREFS };
  if (!data && legacyPosition === "selected") out.position = "selection";
  if (!data || typeof data !== "object") return out;
  if (data.position === "top" || data.position === "selection") out.position = data.position;
  for (const k of ["wrapGroup", "restore", "scaleLongEdge", "scaleWithCanvas", "matchParents", "switchAfter", "removeAfter"] as const)
    if (typeof data[k] === "boolean") out[k] = data[k];
  // the two scalings exclude each other: an old "随画布缩放" on keeps working as it was
  if (out.scaleWithCanvas && typeof data.scaleLongEdge !== "boolean") out.scaleLongEdge = false;
  if (out.scaleLongEdge) out.scaleWithCanvas = false;
  const name = str(data.groupName, 80).trim();
  if (name) out.groupName = name;
  return out;
}

/** `base`, or `base 2`, `base 3` … — the first not among `existing`. */
export function uniqueGroupName(existing: ReadonlySet<string>, base: string): string {
  const b = base.trim() || DEFAULT_GROUP_NAME;
  let name = b, n = 2;
  while (existing.has(name)) name = b + " " + n++;
  return name;
}

/** The name path of a layer's parent groups, outermost first (rule 7 of the send rules). */
export function parentPath(layerId: number, parentOf: (id: number) => number | null, nameOf: (id: number) => string): string[] {
  const path: string[] = [];
  const seen = new Set<number>([layerId]);
  let p = parentOf(layerId);
  while (p !== null && !seen.has(p)) { seen.add(p); path.unshift(nameOf(p)); p = parentOf(p); }
  return path;
}

/** Drop hit-testing uses final mouseup coordinates, not the last mousemove's possibly stale row. */
export function pointInWorkbench(
  b: { left: number; right: number; top: number; bottom: number }, x: number, y: number,
): boolean {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= b.left && x < b.right && y >= b.top && y < b.bottom;
}

export interface WorkbenchSourceBatch { docId: number; layers: StagedLayer[] }

/** Plan copies without duplicating children already included in staged parent groups.
 *  One batch per source PSD avoids one Photoshop call for every row. */
export function planWorkbenchCopies(
  items: readonly StagedLayer[],
  parentOf: (docId: number, layerId: number) => number | null,
): { batches: WorkbenchSourceBatch[]; count: number; nestedSkipped: number } {
  const unique = appendStagedLayers([], items);
  const chosen = new Set(unique.map(stagedKey));
  let nestedSkipped = 0;
  const batches: WorkbenchSourceBatch[] = [];
  const byDoc = new Map<number, WorkbenchSourceBatch>();
  for (const item of unique) {
    const seen = new Set<number>([item.layerId]);
    let ancestor = parentOf(item.docId, item.layerId);
    let nested = false;
    while (ancestor !== null && !seen.has(ancestor)) {
      if (chosen.has(item.docId + ":" + ancestor)) { nested = true; break; }
      seen.add(ancestor);
      ancestor = parentOf(item.docId, ancestor);
    }
    if (nested) { nestedSkipped++; continue; }
    let batch = byDoc.get(item.docId);
    if (!batch) { batch = { docId: item.docId, layers: [] }; byDoc.set(item.docId, batch); batches.push(batch); }
    batch.layers.push(item);
  }
  return { batches, count: batches.reduce((sum, batch) => sum + batch.layers.length, 0), nestedSkipped };
}

/** The topmost selected layer from Photoshop's top-to-bottom layer list when placement above the
 *  selection is enabled. No valid selection means the caller should use top. */
export function workbenchPlacementAnchor(
  enabled: boolean,
  documentOpen: boolean,
  layersTopToBottom: readonly { id: number }[],
  selectedIds: ReadonlySet<number>,
): number | null {
  if (!enabled || !documentOpen || !selectedIds.size) return null;
  return layersTopToBottom.find(layer => selectedIds.has(layer.id))?.id ?? null;
}
