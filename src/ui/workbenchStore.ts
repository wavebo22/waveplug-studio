import { appendStagedLayers, stagedKey, type StagedLayer } from "../core/layers/workbench.ts";
import { log } from "../app/log.ts";

/** In-memory references shared by WaveLayer's inline editing workbench.
 *  Adding/removing entries NEVER changes the source Photoshop document.
 *  A future release can persist the list and check source documents before use. */
let staged: StagedLayer[] = [];
let message = "等待暂存";
const observers = new Set<() => void>();

function changed() { for (const fn of observers) try { fn(); } catch { /* disposed panel */ } }
export function onWorkbenchDemoChange(fn: () => void): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}
export function workbenchDemoState() { return { staged: [...staged], message }; }
export function addToWorkbenchDemo(items: StagedLayer[]): number {
  const old = staged.length;
  staged = appendStagedLayers(staged, items);
  const added = staged.length - old;
  message = "新增暂存 " + added + " 个图层";
  log("info", "workbench inline stage", JSON.stringify({ attempted: items.length, added }));
  changed();
  return added;
}
export function removeFromWorkbenchDemo(item: StagedLayer) {
  staged = staged.filter(x => stagedKey(x) !== stagedKey(item));
  message = "已移出暂存清单";
  changed();
}
export function clearWorkbenchDemo() { staged = []; message = "清单已清空"; changed(); }
