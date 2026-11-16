// The workbench list and its settings, shared by the WaveLayer panel's workbench section and the
// right-click 发送到 menu. Kept in localStorage (per machine), so it survives ⟳ and restarting
// Photoshop; entries follow their document by docKey (core/layers/workbench.ts rebindEntries).
// Adding / removing entries NEVER changes a Photoshop document.
import {
  DEFAULT_PREFS, appendStagedLayers, parsePrefs, parseWorkbench, removeStaged, serializeWorkbench,
  type StagedLayer, type WorkbenchPrefs,
} from "../core/layers/workbench.ts";
import { log } from "../app/log.ts";

const LIST_KEY = "wp.workbench.v2";
const PREFS_KEY = "wp.workbench.prefs";
/** the 11-04 single checkbox (置于选中图层上方), read once into the new settings */
const LEGACY_POSITION_KEY = "wp.workbench.defaultPosition";

function load(key: string): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); }
  catch (e) { log("warn", "workbench save", key, e); }
}

let staged: StagedLayer[] = parseWorkbench(load(LIST_KEY));
let prefs: WorkbenchPrefs = parsePrefs(load(PREFS_KEY), load(LEGACY_POSITION_KEY));
const observers = new Set<() => void>();

function changed(persist = true) {
  if (persist) save(LIST_KEY, serializeWorkbench(staged));
  for (const fn of observers) try { fn(); } catch { /* disposed panel */ }
}
export function onWorkbenchChange(fn: () => void): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}
export function workbenchState(): { staged: StagedLayer[]; prefs: WorkbenchPrefs } {
  return { staged: [...staged], prefs: { ...prefs } };
}
/** Returns how many entries are new (a layer staged again only refreshes its picture). */
export function addToWorkbench(items: readonly StagedLayer[]): number {
  const old = staged.length;
  staged = appendStagedLayers(staged, items);
  const added = staged.length - old;
  log("info", "workbench stage", JSON.stringify({ attempted: items.length, added, total: staged.length }));
  changed();
  return added;
}
export function removeFromWorkbench(keys: ReadonlySet<string>) {
  const next = removeStaged(staged, keys);
  if (next.length === staged.length) return;
  staged = next;
  changed();
}
export function clearWorkbench() { staged = []; changed(); }
/** Rebinding to new document ids, updated names: same entries, new values. */
export function updateWorkbench(fn: (entries: StagedLayer[]) => StagedLayer[]) {
  const next = fn([...staged]);
  if (JSON.stringify(next) === JSON.stringify(staged)) return;
  staged = next;
  changed();
}
export function setWorkbenchPrefs(patch: Partial<WorkbenchPrefs>) {
  prefs = { ...prefs, ...patch };
  save(PREFS_KEY, JSON.stringify(prefs));
  changed(false);
}
export function resetWorkbenchForTests() { staged = []; prefs = { ...DEFAULT_PREFS }; changed(false); }
