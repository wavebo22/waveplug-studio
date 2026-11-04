/** A staged layer is a reference to an *open* Photoshop document, not an image copy.
 *  No PSD content is modified when adding it to the workbench. */
export interface StagedLayer {
  docId: number;
  docKey: string;
  layerId: number;
  name: string;
  kind: string;
}

/** Stable, duplicate-free ordering across source documents. Distinct PSDs can reuse layer IDs. */
export function appendStagedLayers(existing: readonly StagedLayer[], items: readonly StagedLayer[]): StagedLayer[] {
  const out = [...existing];
  const keys = new Set(out.map(x => x.docId + ":" + x.layerId));
  for (const item of items) {
    if (!Number.isInteger(item.docId) || !Number.isInteger(item.layerId) || item.docId <= 0 || item.layerId <= 0) continue;
    const key = item.docId + ":" + item.layerId;
    if (!keys.has(key)) {
      keys.add(key);
      out.push({ ...item });
    }
  }
  return out;
}

export function stagedKey(item: Pick<StagedLayer, "docId" | "layerId">): string {
  return item.docId + ":" + item.layerId;
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
 *  One duplicateLayers call per source PSD avoids one Photoshop call for every row. */
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

/** When optional selected-layer placement is enabled, use the topmost selected layer
 *  from Photoshop's top-to-bottom layer list. No valid selection means the caller should use top. */
export function workbenchPlacementAnchor(
  enabled: boolean,
  documentOpen: boolean,
  layersTopToBottom: readonly { id: number }[],
  selectedIds: ReadonlySet<number>,
): number | null {
  if (!enabled || !documentOpen || !selectedIds.size) return null;
  return layersTopToBottom.find(layer => selectedIds.has(layer.id))?.id ?? null;
}
