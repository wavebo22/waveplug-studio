// WaveLayer editing workbench and 发送到: copy referenced layers from any *open* PSD to any open
// PSD in a single Photoshop undo step of the target, back at their place on the canvas
// (core/layers/placementRestore.ts). Source PSDs are never mutated.
import { log } from "../app/log.ts";
import {
  DEFAULT_GROUP_NAME, parentPath, planWorkbenchCopies, uniqueGroupName, workbenchPlacementAnchor,
  type StagedLayer,
} from "../core/layers/workbench.ts";
import { type Rect, isArea, pairCopies, restoreMoves, restoreScale } from "../core/layers/placementRestore.ts";
import {
  WorkbenchPlaceError, collectWorkbenchCompatibility, type WorkbenchCompatibilityNotice,
} from "../core/layers/workbenchCompatibility.ts";
import { docById, findLayer, play, step } from "./uxpHost.ts";

declare const require: (name: string) => any;
const ps = () => require("photoshop");

/** Photoshop Layer handles are document-bound. A handle returned from a cross-document
 *  duplicateLayers() call can still point to the source document. Detect the actual new
 *  roots in the TARGET document and only ever move target-owned Layer handles. */
function layerIds(layers: any[]): Set<number> {
  const ids = new Set<number>();
  const walk = (nodes: any[]) => {
    for (const layer of nodes) {
      if (Number.isInteger(layer?.id)) ids.add(layer.id);
      if (layer?.layers?.length) walk(layer.layers);
    }
  };
  walk(layers);
  return ids;
}
function newRootLayers(layers: any[], previous: ReadonlySet<number>): any[] {
  const roots: any[] = [];
  const walk = (nodes: any[], parentNew: boolean) => {
    for (const layer of nodes) {
      const newlyCreated = !previous.has(layer.id);
      if (newlyCreated && !parentNew) roots.push(layer);
      if (layer?.layers?.length) walk(layer.layers, parentNew || newlyCreated);
    }
  };
  walk(layers, false);
  return roots;
}

/** Photoshop adjustment types (not every one is usable in CMYK). Isolate them when
 *  source/target colour modes differ to avoid partial success in a mixed duplicateLayers call.
 *  Hue/Saturation itself CAN work in CMYK, so never blanket-block cross-mode adjustments. */
const ADJUSTMENT_KINDS = new Set([
  "blackandwhite", "brightnesscontrast", "channelmixer", "clarity", "colorbalance",
  "colorlookup", "curves", "exposure", "gradientmap", "grain", "huesaturation",
  "inversion", "levels", "photofilter", "posterize", "selectivecolor",
  "threshold", "vibrance",
]);
function modeOf(doc: any): string { return String(doc?.mode ?? "未知模式").replace(/^DocumentMode\./, ""); }
function isAdjustment(layer: any): boolean {
  return ADJUSTMENT_KINDS.has(String(layer?.kind ?? "").replace(/[_\s-]/g, "").toLowerCase());
}
function copyFailure(layer: any, sourceDoc: any, target: any, original: unknown, fallback: unknown): Error {
  const src = modeOf(sourceDoc), dst = modeOf(target);
  const name = String(layer?.name ?? "#" + layer?.id);
  const mode = src === dst ? src : src + " → " + dst;
  const adjustment = isAdjustment(layer) ? "调整图层" : "图层";
  const details = [original, fallback].filter(x => x != null)
    .map(x => String((x as Error)?.message ?? x)).join("；");
  log("warn", "workbench copy not created", JSON.stringify({
    sourceDocId: sourceDoc.id, targetId: target.id, mode, id: layer?.id, name,
    kind: String(layer?.kind), details,
  }));
  return new WorkbenchPlaceError(
    "COPY_NO_OUTPUT",
    `Photoshop 的两种复制接口都没有在目标 PSD 创建${adjustment}「${name}」（${mode}）。这是已确认的失败现象；` +
      (src !== dst ? "两份文档颜色模式不同，但尚不能确定模式差异是唯一原因。" : "Photoshop 未说明为什么没有生成图层。"),
    "请先单独测试此图层；如果目标文档不支持原调整效果，可在目标 PSD 重新建立调整图层。不要在未确认前栅格化或更改源 PSD 颜色模式。",
    details || "两次 API 调用结束后，目标文档均未新增对应图层。",
  );
}

/** Four source layers per native call worked in real Photoshop. Cross-mode adjustment
 *  layers get their own call; if Photoshop silently creates zero layers, try Layer.duplicate.
 *  Retry/partition only when NO destination layers were created. Never duplicate partial copies. */
const COPY_BATCH_LIMIT = 4;
async function duplicateSafely(
  sourceDoc: any, sourceLayers: any[], target: any, sourceDocId: number,
): Promise<number[]> {
  if (!sourceLayers.length) return [];
  if (sourceLayers.length > COPY_BATCH_LIMIT) {
    const ids: number[] = [];
    for (let i = 0; i < sourceLayers.length; i += COPY_BATCH_LIMIT)
      ids.push(...await duplicateSafely(sourceDoc, sourceLayers.slice(i, i + COPY_BATCH_LIMIT), target, sourceDocId));
    return ids;
  }
  if (sourceLayers.length > 1 && modeOf(sourceDoc) !== modeOf(target)
    && sourceLayers.some(isAdjustment)) {
    const ids: number[] = [];
    let ordinary: any[] = [];
    for (const layer of sourceLayers) {
      if (isAdjustment(layer)) {
        if (ordinary.length) ids.push(...await duplicateSafely(sourceDoc, ordinary, target, sourceDocId));
        ordinary = [];
        ids.push(...await duplicateSafely(sourceDoc, [layer], target, sourceDocId));
      } else ordinary.push(layer);
    }
    if (ordinary.length) ids.push(...await duplicateSafely(sourceDoc, ordinary, target, sourceDocId));
    return ids;
  }

  const before = layerIds(target.layers);
  let returned: unknown = null;
  let batchError: unknown = null;
  try {
    returned = await sourceDoc.duplicateLayers(sourceLayers,
      sourceDocId === target.id ? undefined : target);
  } catch (error) {
    batchError = error;
  }

  let roots = newRootLayers(target.layers, before);
  if (batchError && roots.length) {
    log("warn", "workbench copy partial after throw",
      JSON.stringify({ sourceDocId, targetId: target.id, expected: sourceLayers.length,
        created: roots.map(x => x.id), error: String((batchError as Error)?.message ?? batchError) }));
    throw new WorkbenchPlaceError(
      "COPY_PARTIAL",
      `Photoshop 在复制时抛错，目标 PSD 已出现 ${roots.length}/${sourceLayers.length} 个副本，复制没有完成。`,
      "为防止重复图层，已停止自动重试并尝试撤销本次操作。请检查目标 PSD 图层树，确认没有残留副本后再重试。",
      String((batchError as Error)?.message ?? batchError),
    );
  }
  // A host can return a valid-length Layer[] even when a cross-mode adjustment was
  // silently omitted. Such a no-op needs the same fallback path as a thrown error.
  if (!roots.length && sourceLayers.length > 1) {
    log("info", "workbench copy split after no result", JSON.stringify({
      sourceDocId, targetId: target.id, size: sourceLayers.length,
      srcMode: modeOf(sourceDoc), dstMode: modeOf(target),
      reason: String((batchError as Error)?.message ?? batchError ?? "No target layers created"),
    }));
    const mid = Math.floor(sourceLayers.length / 2);
    return [
      ...await duplicateSafely(sourceDoc, sourceLayers.slice(0, mid), target, sourceDocId),
      ...await duplicateSafely(sourceDoc, sourceLayers.slice(mid), target, sourceDocId),
    ];
  }
  if (!roots.length && sourceLayers.length === 1) {
    const layer = sourceLayers[0];
    let fallbackError: unknown = null;
    try {
      if (typeof layer.duplicate !== "function") throw new Error("不提供单层复制接口");
      await layer.duplicate(sourceDocId === target.id ? undefined : target);
    } catch (error) { fallbackError = error; }
    roots = newRootLayers(target.layers, before);
    if (roots.length !== 1)
      throw copyFailure(layer, sourceDoc, target, batchError, fallbackError);
    log("info", "workbench copy single fallback", JSON.stringify({
      sourceDocId, targetId: target.id, name: String(layer?.name), kind: String(layer?.kind),
      srcMode: modeOf(sourceDoc), dstMode: modeOf(target),
    }));
  }
  if (roots.length !== sourceLayers.length) {
    const names = sourceLayers.map(x => String(x?.name ?? "#" + x?.id)).join("、");
    throw new WorkbenchPlaceError(
      "COPY_COUNT_MISMATCH",
      `来源 ${modeOf(sourceDoc)} → 目标 ${modeOf(target)}：请求复制 ${sourceLayers.length} 个图层，` +
      `目标实际新增 ${roots.length} 个（${names}）。部分图层未被成功复制；尚不能确定是否因颜色模式、位深或图层类型导致。`,
      "已停止后续移动以避免误操作。请确认目标 PSD 无残留副本后，尝试单独放入相关图层，并检查其调整图层、蒙版或特殊效果。",
      String((batchError as Error | undefined)?.message ?? ""),
    );
  }
  const rootsById = new Map<number, any>(roots.map(x => [x.id, x]));
  const returnedIds = Array.isArray(returned) ? returned.map(x => Number(x?.id)) : [];
  const areTargetIds = returnedIds.length === roots.length
    && new Set(returnedIds).size === roots.length
    && returnedIds.every(id => rootsById.has(id));
  return areTargetIds ? returnedIds : roots.map(x => x.id);
}

export interface WorkbenchPlacementOptions {
  /** The document receiving the copies (any open PSD); the active document when left out. */
  targetDocId?: number;
  /** "top" (default): above everything; "selection": above the target's topmost selected layer. */
  position?: "top" | "selection";
  /** Wrap the copies in one new group (default true: the workbench's 置入). 发送到 passes false. */
  wrapGroup?: boolean;
  /** Base name of that group (made unique among the target's top-level names). */
  groupName?: string;
  /** 还原画面位置 (core/layers/placementRestore.ts), default true. */
  restore?: boolean;
  /** 按长边缩放 (placementRestore rule 4): wins over scaleWithCanvas */
  scaleLongEdge?: boolean;
  scaleWithCanvas?: boolean;
  /** Without a wrapping group: a copy goes into the target group with its source parent's name path. */
  matchParents?: boolean;
  /** Leave the target as the active document (otherwise the previously active one comes back). */
  switchAfter?: boolean;
}
export interface WorkbenchPlacementResult {
  docId: number;
  /** the wrapping group, null when placed without one */
  groupId: number | null;
  groupName: string | null;
  count: number;
  nestedSkipped: number;
  /** "matched": into the target's groups with the source parents' names / the same-named artboard */
  placement: "top" | "above-selection" | "matched" | "mixed";
  anchorName?: string;
  /** copies moved back to their place on the canvas */
  restored: number;
  /** placed from snapshots (source closed or layer gone): smart objects of the pixels */
  snapshots?: number;
  /** content scale applied by scaleWithCanvas (1: none) */
  scale: number;
  /** ids of the copies (top-level of the copy) in the target */
  ids: number[];
  /** Nonblocking cautions about source/target formats, only after real copies succeeded. */
  compatibility?: WorkbenchCompatibilityNotice[];
}

const rectOf = (layer: any): Rect | null => {
  let b: any;
  try { b = layer?.boundsNoEffects ?? layer?.bounds; } catch { return null; }
  if (!b) return null;
  const r = { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) };
  return isArea(r) ? r : null;
};
const canvasOf = (doc: any): Rect | null => {
  const r = { left: 0, top: 0, right: Number(doc?.width), bottom: Number(doc?.height) };
  return isArea(r) ? r : null;
};
/** A top-level artboard's rectangle (null for anything else, or when Photoshop won't say). */
async function artboardRect(docId: number, layerId: number): Promise<Rect | null> {
  try {
    // two properties, never the whole layer descriptor (slow for smart objects)
    const [en, ab] = await play(["artboardEnabled", "artboard"].map(p => ({ _obj: "get", _target: [{ _property: p }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }] })));
    const r = { artboardEnabled: en?.artboardEnabled, artboard: ab?.artboard };
    if (!r?.artboardEnabled) return null;
    const a = r.artboard?.artboardRect;
    const out = a ? { left: Number(a.left), top: Number(a.top), right: Number(a.right), bottom: Number(a.bottom) } : null;
    return isArea(out) ? out : null;
  } catch { return null; }
}
/** Layers of a document top to bottom, with their parents. */
function walkDoc(doc: any) {
  const layers = new Map<number, any>();
  const parents = new Map<number, number | null>();
  const order: any[] = [];
  const walk = (current: any[], parent: number | null) => {
    for (const layer of current ?? []) {
      layers.set(layer.id, layer);
      parents.set(layer.id, parent);
      order.push(layer);
      if (layer.layers?.length) walk(layer.layers, layer.id);
    }
  };
  walk(doc.layers, null);
  return { layers, parents, order };
}
/** The target group reached by following `path` (names, outermost first) from the top level. */
function groupByPath(target: any, path: readonly string[]): any | null {
  let level: any[] = target.layers ?? [];
  let found: any = null;
  for (const name of path) {
    found = level.find(l => String(l?.kind).toLowerCase().includes("group") && String(l.name) === name) ?? null;
    if (!found) return null;
    level = found.layers ?? [];
  }
  return found;
}

/** The plugin data folder's workbench/ (snapshot PNGs, core/layers/workbench.ts snapName). */
export async function snapshotFolder(): Promise<any> {
  const fs = require("uxp").storage.localFileSystem;
  const data = await fs.getDataFolder();
  try { return await data.getEntry("workbench"); }
  catch { return data.createFolder("workbench"); }
}

/** All references are checked BEFORE the first modification. If any copy/grouping fails,
 *  step() rolls back the target document instead of leaving half a workbench import. */
export async function placeWorkbenchLayers(
  entries: readonly StagedLayer[],
  options: WorkbenchPlacementOptions = {},
): Promise<WorkbenchPlacementResult> {
  if (!entries.length) throw new Error("工作台没有暂存图层");
  const wrap = options.wrapGroup !== false, restore = options.restore !== false;
  const restoreOpts = { scaleWithCanvas: !!options.scaleWithCanvas, longEdge: !!options.scaleLongEdge };
  const startActive = ps().app.activeDocument;
  const targetId = options.targetDocId ?? startActive?.id;
  if (!Number.isInteger(targetId))
    throw new WorkbenchPlaceError("NO_TARGET", "当前没有打开用于接收素材的 PSD。", "先打开目标 Photoshop 文档，再置入或发送。");

  return step(wrap ? "WaveLayer 放入工作台素材" : "WaveLayer 发送图层", targetId, async ctx => {
    let target: any;
    try { target = docById(targetId); }
    catch (error) {
      throw new WorkbenchPlaceError(
        "TARGET_CLOSED", "目标 PSD 在执行前已关闭或无法访问。",
        "请重新打开目标 PSD，再置入或发送一次。",
        String((error as Error)?.message ?? error),
      );
    }
    // Resolve the anchor (the target's topmost selected layer) before the first mutation.
    // No selection safely falls back to the top of the document.
    const targetWalk = walkDoc(target);
    let selectedIds = new Set<number>();
    try { selectedIds = new Set((target.activeLayers ?? []).map((l: any) => Number(l?.id))); } catch { /* none */ }
    const anchorId = workbenchPlacementAnchor(options.position === "selection", true, targetWalk.order, selectedIds);
    const anchorName = anchorId !== null ? String(targetWalk.layers.get(anchorId)?.name ?? "") : undefined;
    // the target's artboards (top-level layers), read once and only when a frame is needed
    const selectedRoots = new Set([...selectedIds].map(id => {
      let r = id, p = targetWalk.parents.get(r) ?? null;
      while (p !== null) { r = p; p = targetWalk.parents.get(r) ?? null; }
      return r;
    }));
    let targetBoards: { layer: any; rect: Rect }[] | null = null;
    const pickTargetBoard = async (sourceBoardName: string | null) => {
      if (!targetBoards) {
        targetBoards = [];
        for (const l of target.layers ?? []) {
          const rect = await artboardRect(targetId, l.id);
          if (rect) targetBoards.push({ layer: l, rect });
        }
      }
      const boards = targetBoards;
      const named = sourceBoardName !== null ? boards.filter(b => String(b.layer.name) === sourceBoardName) : [];
      if (named.length === 1) return { ...named[0], why: "name" };
      const selected = boards.filter(b => selectedRoots.has(b.layer.id));
      if (selected.length === 1) return { ...selected[0], why: "selection" };
      if (boards.length === 1) return { ...boards[0], why: "only" };
      if (boards.length)
        log("warn", "workbench target artboard unknown", JSON.stringify({ targetId, boards: boards.length, sourceBoardName }));
      return null;
    };

    const sources = new Map<number, { doc: any; layers: Map<number, any>; parents: Map<number, number | null> }>();
    /** entries whose source is closed / whose layer is gone, placed from their snapshot PNG */
    const fromSnap: StagedLayer[] = [];
    const hasSnap = (ref: StagedLayer) => !!ref.snap && isArea(ref.geom?.bounds) && !!ref.geom?.canvas;
    const openIds = new Set<number>();
    try { for (const d of ps().app.documents ?? []) openIds.add(d.id); } catch { /* checked one by one below */ }
    for (const ref of entries) {
      if (!Number.isInteger(ref.docId) || !Number.isInteger(ref.layerId) || ref.docId <= 0 || ref.layerId <= 0)
        throw new WorkbenchPlaceError("INVALID_REF", "工作台中有无效的文档或图层标识。", "移除异常暂存项，再重新从来源 PSD 拖入对应图层。");
      if (sources.has(ref.docId)) continue;
      if (openIds.size && !openIds.has(ref.docId) && hasSnap(ref)) continue;
      let doc: any;
      try { doc = docById(ref.docId); }
      catch (error) {
        if (hasSnap(ref)) continue;
        throw new WorkbenchPlaceError(
          "SOURCE_CLOSED",
          `来源文档「${ref.docKey}」已关闭或无法访问，暂存的「${ref.name}」只是引用，无法复制。`,
          "重新打开来源 PSD 后重试；若来源已经变化，请移除失效暂存项并重新拖入。",
          String((error as Error)?.message ?? error),
        );
      }
      const { layers, parents } = walkDoc(doc);
      sources.set(ref.docId, { doc, layers, parents });
    }

    // Validate each entry, including entries under staged parent groups. Don't silently ignore
    // a missing child or a closed source just because its ancestor was also staged.
    for (const ref of entries) {
      if (!sources.get(ref.docId)?.layers.has(ref.layerId) && hasSnap(ref)) { fromSnap.push(ref); continue; }
      if (!sources.get(ref.docId)?.layers.has(ref.layerId))
        throw new WorkbenchPlaceError(
          "SOURCE_LAYER_MISSING",
          `来源「${ref.docKey}」中的图层「${ref.name}」(#${ref.layerId}) 已不存在或 ID 已变化。`,
          "请从工作台移除此项，并从来源 PSD 重新拖入当前图层。",
        );
    }
    const snapKeys = new Set(fromSnap.map(r => r.docId + ":" + r.layerId));
    const plan = planWorkbenchCopies(entries.filter(r => !snapKeys.has(r.docId + ":" + r.layerId)),
      (docId, id) => sources.get(docId)?.parents.get(id) ?? null);
    if (!plan.count && !fromSnap.length)
      throw new WorkbenchPlaceError("EMPTY_PLAN", "工作台没有可以置入的有效图层。",
        "请重新从图层栏拖入内容，然后再次尝试。");

    const compatibility: WorkbenchCompatibilityNotice[] = [];
    const copiedIds: number[] = [];
    /** per copy: the source parent's name path, and the target artboard it belongs on */
    const copyInfo = new Map<number, { path: string[]; board: any | null }>();
    let restored = 0, scale = 1;
    for (const batch of plan.batches) {
      const src = sources.get(batch.docId)!;
      if (batch.docId !== targetId) {
        compatibility.push(...collectWorkbenchCompatibility(
          src.doc, target, String(batch.layers[0]?.docKey ?? src.doc.name ?? "来源 PSD"),
        ));
      }
      ctx.reportProgress?.({ commandName: `正在复制 ${batch.layers.length} 个图层…` });
      const sourceLayers = batch.layers.map(ref => src.layers.get(ref.layerId)!);
      // remembered BEFORE copying: where the layers are on their canvas (or artboard)
      const sourceRects = new Map<number, Rect | null>(sourceLayers.map(l => [l.id, restore ? rectOf(l) : null]));
      const rootOf = (id: number) => { let r = id, p = src.parents.get(r) ?? null; while (p !== null) { r = p; p = src.parents.get(r) ?? null; } return r; };
      const roots = new Set(sourceLayers.map(l => rootOf(l.id)));
      const sourceRoot = roots.size === 1 ? [...roots][0] : null;
      let ids: number[];
      try {
        // Bound groups of four limit host memory use; a failing batch is bisected into
        // smaller calls only when the target acquired NO new layer from that call.
        ids = await duplicateSafely(src.doc, sourceLayers, target, batch.docId);
        copiedIds.push(...ids);
        log("info", "workbench target copies", JSON.stringify({
          sourceDocId: batch.docId, targetId, count: ids.length, ids,
        }));
      } catch (error) {
        log("warn", "workbench copy batch failed", JSON.stringify({
          sourceDocId: batch.docId, targetId, count: sourceLayers.length,
          error: String((error as Error)?.message ?? error),
        }));
        throw error;
      }
      const pairs = pairCopies(
        sourceLayers.map(l => ({ id: l.id, name: String(l.name ?? "") })),
        ids.map(id => ({ id, name: String(findLayer(target.layers, id)?.name ?? "") })),
      );
      // rule 8 (11-14): the frame is the artboard (the editable page), never the whole canvas of an
      // artboard document. Source: the artboard holding the layers (or the artboard sent itself).
      // Target: the artboard of the same name, else the one holding the target's selection, else
      // its only artboard; the copies go into it (an artboard sent itself is never nested).
      let srcFrame = canvasOf(src.doc), dstFrame = canvasOf(target), board: any = null;
      let frameFrom = { src: "canvas", dst: "canvas" };
      if (restore && [...sourceRects.values()].some(isArea)) {
        const sendsBoard = sourceRoot !== null && sourceLayers.some(l => l.id === sourceRoot);
        const srcBoard = sourceRoot !== null ? await artboardRect(batch.docId, sourceRoot) : null;
        if (srcBoard) { srcFrame = srcBoard; frameFrom.src = "artboard"; }
        const name = srcBoard && sourceRoot !== null ? String(src.layers.get(sourceRoot)?.name ?? "") : null;
        const picked = await pickTargetBoard(name);
        if (picked) {
          dstFrame = picked.rect; frameFrom.dst = "artboard:" + picked.why;
          if (!sendsBoard) board = picked.layer;
        }
      }
      for (const [sid, cid] of pairs)
        copyInfo.set(cid, { path: parentPath(sid, id => src.parents.get(id) ?? null, id => String(src.layers.get(id)?.name ?? "")), board });

      if (restore && srcFrame && dstFrame) {
        const layers = pairs.map(([sid, cid]) => ({ id: cid, source: sourceRects.get(sid) ?? null }));
        if (layers.some(l => isArea(l.source))) {
          const s = restoreScale(srcFrame, dstFrame, restoreOpts);
          if (s !== 1) {
            scale = s;
            for (const l of layers) {
              const copy = findLayer(target.layers, l.id);
              if (!isArea(l.source) || !copy || typeof copy.scale !== "function") continue;
              const before = rectOf(copy);
              await copy.scale(s * 100, s * 100, ps().constants.AnchorPosition?.MIDDLECENTER);
              const after = rectOf(findLayer(target.layers, l.id));
              log("info", "workbench scaled", JSON.stringify({ id: l.id, kind: String(copy.kind), percent: s * 100, before, after }));
              if (/pixel|normal/i.test(String(copy.kind)))
                compatibility.push({ code: "SCALED_PIXELS", sourceDoc: String(copy.name), sourceValue: "100%", targetValue: Math.round(s * 100) + "%",
                  detail: `「${copy.name}」是像素图层，已按画布缩放到 ${Math.round(s * 100)}%，画质可能下降。` });
            }
          }
          const moves = restoreMoves(srcFrame, dstFrame, layers, restoreOpts, id => rectOf(findLayer(target.layers, id)));
          for (const m of moves) {
            const copy = findLayer(target.layers, m.id);
            if (!copy || typeof copy.translate !== "function") continue;
            if (m.dx || m.dy) await copy.translate(m.dx, m.dy);
            restored++;
          }
          log("info", "workbench restore", JSON.stringify({ sourceDocId: batch.docId, targetId, frameFrom, srcFrame, dstFrame, scale: s, moves }));
        }
      }
    }

    ps().app.activeDocument = target;
    // ── from snapshots: each PNG placed as a smart object, sized back to its pixels, then moved
    //    to its place on the canvas like the copies (one block per source document) ──
    let snapshots = 0;
    if (fromSnap.length) {
      ctx.reportProgress?.({ commandName: `正在用快照置入 ${fromSnap.length} 个图层…` });
      const folder = await snapshotFolder();
      const fs = require("uxp").storage.localFileSystem;
      const bySource = new Map<string, StagedLayer[]>();
      for (const r of fromSnap) { const g = bySource.get(r.docKey); if (g) g.push(r); else bySource.set(r.docKey, [r]); }
      for (const group of bySource.values()) {
        const placed: { id: number; source: Rect | null }[] = [];
        const canvas = group[0].geom!.canvas;
        const srcFrame: Rect = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
        const dstFrame = canvasOf(target);
        const s = restore && dstFrame ? restoreScale(srcFrame, dstFrame, restoreOpts) : 1;
        for (const r of group) {
          let entry: any;
          try { entry = await folder.getEntry(r.snap!); }
          catch (error) {
            throw new WorkbenchPlaceError("SNAPSHOT_MISSING", `「${r.name}」的来源 PSD 没有打开，它的快照文件也找不到了。`,
              "打开来源 PSD 后再置入，或者从工作台移除这一项。", String((error as Error)?.message ?? error));
          }
          const before = layerIds(target.layers);
          await play([{
            _obj: "placeEvent", null: { _path: fs.createSessionToken(entry), _kind: "local" },
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
          }]);
          // the new layer, found as new in the target (an error leaves the old active layer selected)
          const layer = newRootLayers(target.layers, before)[0];
          if (!layer || !Number.isInteger(layer.id))
            throw new WorkbenchPlaceError("SNAPSHOT_PLACE_FAILED", `Photoshop 没有置入「${r.name}」的快照。`,
              "打开来源 PSD 后再置入；本次操作会整体回滚。");
          try { layer.name = r.name; } catch { /* keeps the file name */ }
          // Photoshop may resize a placed file (resolution, 置入时调整图像大小): back to its pixels
          const now = rectOf(layer), want = r.geom!.bounds!;
          if (now && typeof layer.scale === "function") {
            const fx = (want.right - want.left) * s / (now.right - now.left), fy = (want.bottom - want.top) * s / (now.bottom - now.top);
            if (Math.abs(fx - 1) > 0.002 || Math.abs(fy - 1) > 0.002)
              await layer.scale(fx * 100, fy * 100, ps().constants.AnchorPosition?.MIDDLECENTER);
          }
          placed.push({ id: layer.id, source: want });
          copiedIds.push(layer.id);
          copyInfo.set(layer.id, { path: [], board: null });
          snapshots++;
        }
        if (restore && dstFrame) {
          const moves = restoreMoves(srcFrame, dstFrame, placed, restoreOpts, id => rectOf(findLayer(target.layers, id)));
          for (const m of moves) {
            const l = findLayer(target.layers, m.id);
            if (l && (m.dx || m.dy)) await l.translate(m.dx, m.dy);
            restored++;
          }
        }
        log("info", "workbench snapshots placed", JSON.stringify({ targetId, source: group[0].docKey, ids: placed.map(p => p.id), scale: s }));
      }
    }
    const constants = ps().constants.ElementPlacement;
    let groupId: number | null = null, groupName: string | null = null;
    let placement: WorkbenchPlacementResult["placement"] = anchorId === null ? "top" : "above-selection";

    if (wrap) {
      // Avoid Document.groupLayers(copied): this API can return null for a mixed or nested
      // multi-layer selection. Create a genuinely empty group first, then move each *newly
      // duplicated* layer inside. Source layers are never moved or modified.
      groupName = uniqueGroupName(new Set((target.layers ?? []).map((l: any) => String(l.name ?? ""))),
        options.groupName ?? DEFAULT_GROUP_NAME);
      ctx.reportProgress?.({ commandName: "正在建立工作台图层组…" });
      let group: any;
      try { group = await target.createLayerGroup({ name: groupName }); }
      catch (error) {
        throw new WorkbenchPlaceError(
          "GROUP_CREATE_FAILED", `已复制图层，但 Photoshop 拒绝在目标 PSD 新建「${groupName}」文件夹。`,
          "检查目标文档或选中图层是否存在编辑限制；本次操作会尝试回滚。确认无残留图层后再试。",
          String((error as Error)?.message ?? error),
        );
      }
      if (!group || !Number.isInteger(group.id))
        throw new WorkbenchPlaceError(
          "GROUP_CREATE_FAILED", `Photoshop 执行创建「${groupName}」后未返回有效的图层组对象。`,
          "请检查目标 PSD 是否出现新文件夹或残留副本，并重新加载 WaveLayer 开发版。",
        );
      groupId = group.id;
      const boards = new Set([...copyInfo.values()].map(x => x.board?.id ?? null));
      const board = boards.size === 1 ? [...copyInfo.values()][0]?.board ?? null : null;
      try {
        if (anchorId !== null) {
          const anchor = findLayer(target.layers, anchorId);
          if (!anchor)
            throw new WorkbenchPlaceError("PLACEMENT_ANCHOR_MISSING", "准备插入时，原选中图层已不存在，已取消置入。",
              "请重新选择目标图层并再次置入；本次不会改为放到其他位置。");
          await group.move(anchor, constants.PLACEBEFORE);
        } else if (board) {
          await group.move(findLayer(target.layers, board.id), constants.PLACEINSIDE);
        } else if (target.layers?.[0] && target.layers[0].id !== group.id) {
          await group.move(target.layers[0], constants.PLACEBEFORE);
        }
      } catch (error) {
        if (error instanceof WorkbenchPlaceError) throw error;
        throw new WorkbenchPlaceError(
          "PLACEMENT_FAILED", `Photoshop 未能把「${groupName}」放到${anchorName ? `「${anchorName}」上方` : "目标位置"}。`,
          "请确认目标图层没有被删除或移动，然后重试。此次置入会尝试整体回滚。",
          String((error as Error)?.message ?? error),
        );
      }
      // PLACEINSIDE inserts at the top: process bottom first to keep the staged order.
      for (const layerId of [...copiedIds].reverse()) {
        // Re-acquire BOTH handles from the target document at the time of move. Never call
        // move() on the objects returned from a source document's duplicateLayers().
        const ownedCopy = findLayer(target.layers, layerId);
        const ownedGroup = findLayer(target.layers, group.id);
        if (!ownedCopy || !ownedGroup)
          throw new WorkbenchPlaceError(
            "TARGET_LAYER_MISSING", `目标 PSD 找不到复制后的图层 #${layerId} 或新建文件夹 #${group.id}。`,
            "可能有图层在复制后被宿主重新编号或修改结构；已停止操作。请检查目标图层树有无残留副本。",
          );
        try { await ownedCopy.move(ownedGroup, constants.PLACEINSIDE); }
        catch (e) {
          log("warn", "workbench place layer failed",
            JSON.stringify({ targetId, groupId: group.id, layerId, error: String((e as Error)?.message ?? e) }));
          throw new WorkbenchPlaceError(
            "MOVE_FAILED", `图层 #${layerId} 已复制，但 Photoshop 拒绝将其移入「${groupName}」文件夹。`,
            "请检查目标文档是否允许移动该图层、是否有锁定或跨文档对象限制；已停止并尝试回滚。",
            String((e as Error)?.message ?? e),
          );
        }
      }
      // Verify real layer membership by ID, not only createLayerGroup's return object.
      const freshGroup = findLayer(target.layers, group.id);
      const missing = copiedIds.filter(id => !freshGroup?.layers || !findLayer(freshGroup.layers, id));
      if (missing.length) {
        log("warn", "workbench place verification failed", JSON.stringify({ targetId, groupId: group.id, missing }));
        throw new WorkbenchPlaceError(
          "VERIFY_FAILED", `「${groupName}」实际缺少 ${missing.length} 个图层（ID：${missing.join("、")}）。`,
          "已尝试回滚本次操作。请检查目标 PSD 是否留有副本，确认无重复后再重新置入。",
        );
      }
      try { target.activeLayers = [freshGroup]; } catch { /* selection is only cosmetic */ }
    } else {
      // 发送到: each copy to the group with its source parent's name path, else its artboard,
      // else above the selection / at the top. Copies keep their order: the first goes to the
      // destination, the next ones right below the copy before them (when the destination is the same).
      const kinds = new Set<string>();
      let previous: { id: number; dest: string } | null = null;
      for (const layerId of copiedIds) {
        const info = copyInfo.get(layerId);
        const group = options.matchParents !== false && info?.path.length ? groupByPath(target, info.path) : null;
        const dest = group ? "group:" + group.id : info?.board ? "group:" + info.board.id : anchorId !== null ? "anchor" : "top";
        kinds.add(dest.startsWith("group:") ? "group" : dest);
        const copy = findLayer(target.layers, layerId);
        if (!copy) throw new WorkbenchPlaceError("TARGET_LAYER_MISSING", `目标 PSD 找不到复制后的图层 #${layerId}。`,
          "已停止操作。请检查目标图层树有无残留副本。");
        try {
          if (previous && previous.dest === dest) await copy.move(findLayer(target.layers, previous.id), constants.PLACEAFTER);
          else if (dest.startsWith("group:")) await copy.move(findLayer(target.layers, Number(dest.slice(6))), constants.PLACEINSIDE);
          else if (dest === "anchor") {
            const anchor = findLayer(target.layers, anchorId!);
            if (!anchor) throw new WorkbenchPlaceError("PLACEMENT_ANCHOR_MISSING", "准备插入时，目标文档里选中的图层已不存在，已取消发送。",
              "请重新选择目标图层再发送。");
            await copy.move(anchor, constants.PLACEBEFORE);
          } else if (target.layers?.[0] && target.layers[0].id !== layerId) await copy.move(target.layers[0], constants.PLACEBEFORE);
        } catch (e) {
          if (e instanceof WorkbenchPlaceError) throw e;
          throw new WorkbenchPlaceError("MOVE_FAILED", `图层 #${layerId} 已复制，但 Photoshop 拒绝把它放到目标位置。`,
            "请检查目标文档的锁定状态；已停止并尝试回滚。", String((e as Error)?.message ?? e));
        }
        previous = { id: layerId, dest };
      }
      placement = kinds.size > 1 ? "mixed" : kinds.has("group") ? "matched" : kinds.has("anchor") ? "above-selection" : "top";
      try { target.activeLayers = copiedIds.map(id => findLayer(target.layers, id)).filter(Boolean); } catch { /* cosmetic */ }
    }

    if (!options.switchAfter && startActive && startActive.id !== targetId) {
      try { ps().app.activeDocument = docById(startActive.id); } catch { /* it was closed meanwhile */ }
    }
    log("info", "workbench placed", JSON.stringify({
      targetId, groupId, wrap, count: copiedIds.length, nestedSkipped: plan.nestedSkipped,
      placement, anchorId, restored, scale, sourceDocs: plan.batches.map(b => b.docId),
    }));
    return { docId: targetId, groupId, groupName, count: copiedIds.length, nestedSkipped: plan.nestedSkipped,
      placement, anchorName, restored, scale, ids: copiedIds, snapshots, compatibility };
  });
}
