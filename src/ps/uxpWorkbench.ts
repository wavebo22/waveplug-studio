// WaveLayer editing workbench: copy referenced layers from any *open* PSD to the current one
// and group them in a single Photoshop undo step. Source PSDs are never mutated.
import { log } from "../app/log.ts";
import { planWorkbenchCopies, type StagedLayer } from "../core/layers/workbench.ts";
import {
  WorkbenchPlaceError, collectWorkbenchCompatibility, type WorkbenchCompatibilityNotice,
} from "../core/layers/workbenchCompatibility.ts";
import { docById, findLayer, step } from "./uxpHost.ts";

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

export interface WorkbenchPlacementResult {
  docId: number;
  groupId: number;
  groupName: string;
  count: number;
  nestedSkipped: number;
  /** Nonblocking cautions about source/target formats, only after real copies succeeded. */
  compatibility?: WorkbenchCompatibilityNotice[];
}

/** All references are checked BEFORE the first modification. If any copy/grouping fails,
 *  step() rolls back the target document instead of leaving half a workbench import. */
export async function placeWorkbenchLayers(entries: readonly StagedLayer[]): Promise<WorkbenchPlacementResult> {
  if (!entries.length) throw new Error("工作台没有暂存图层");
  const active = ps().app.activeDocument;
  if (!active) throw new WorkbenchPlaceError("NO_TARGET", "当前没有打开用于接收素材的 PSD。", "先打开并激活目标 Photoshop 文档，再点击置入。");
  const targetId = active.id;

  return step("WaveLayer 放入工作台素材", targetId, async ctx => {
    if (ps().app.activeDocument?.id !== targetId)
      throw new WorkbenchPlaceError(
        "TARGET_SWITCHED", "执行置入前，活动文档已切换到另一份 PSD。",
        "请重新选中要接收内容的目标 PSD，再点击置入。",
      );
    let target: any;
    try { target = docById(targetId); }
    catch (error) {
      throw new WorkbenchPlaceError(
        "TARGET_CLOSED", "目标 PSD 在执行前已关闭或无法访问。",
        "请重新打开目标 PSD，并再次从工作台置入。",
        String((error as Error)?.message ?? error),
      );
    }
    const sources = new Map<number, { doc: any; layers: Map<number, any>; parents: Map<number, number | null> }>();
    for (const ref of entries) {
      if (!Number.isInteger(ref.docId) || !Number.isInteger(ref.layerId) || ref.docId <= 0 || ref.layerId <= 0)
        throw new WorkbenchPlaceError("INVALID_REF", "工作台中有无效的文档或图层标识。", "移除异常暂存项，再重新从来源 PSD 拖入对应图层。");
      if (sources.has(ref.docId)) continue;
      let doc: any;
      try { doc = docById(ref.docId); }
      catch (error) {
        throw new WorkbenchPlaceError(
          "SOURCE_CLOSED",
          `来源文档「${ref.docKey}」已关闭或无法访问，暂存的「${ref.name}」只是引用，无法复制。`,
          "重新打开来源 PSD 后重试；若来源已经变化，请移除失效暂存项并重新拖入。",
          String((error as Error)?.message ?? error),
        );
      }
      const layers = new Map<number, any>();
      const parents = new Map<number, number | null>();
      function walk(current: any[], parent: number | null) {
        for (const layer of current) {
          layers.set(layer.id, layer);
          parents.set(layer.id, parent);
          if (layer.layers?.length) walk(layer.layers, layer.id);
        }
      }
      walk(doc.layers, null);
      sources.set(ref.docId, { doc, layers, parents });
    }

    // Validate each entry, including entries under staged parent groups. Don't silently ignore
    // a missing child or a closed source just because its ancestor was also staged.
    for (const ref of entries) {
      if (!sources.get(ref.docId)?.layers.has(ref.layerId))
        throw new WorkbenchPlaceError(
          "SOURCE_LAYER_MISSING",
          `来源「${ref.docKey}」中的图层「${ref.name}」(#${ref.layerId}) 已不存在或 ID 已变化。`,
          "请从工作台移除此项，并从来源 PSD 重新拖入当前图层。",
        );
    }
    const plan = planWorkbenchCopies(entries,
      (docId, id) => sources.get(docId)?.parents.get(id) ?? null);
    if (!plan.count)
      throw new WorkbenchPlaceError("EMPTY_PLAN", "工作台没有可以置入的有效图层。",
        "请重新从图层栏拖入内容，然后再次尝试。");

    const existingNames = new Set((target.layers ?? []).map((l: any) => String(l.name ?? "")));
    const baseName = "工作台素材";
    let groupName = baseName, suffix = 2;
    while (existingNames.has(groupName)) groupName = baseName + " " + suffix++;

    const compatibility: WorkbenchCompatibilityNotice[] = [];
    const copiedIds: number[] = [];
    for (const batch of plan.batches) {
      const src = sources.get(batch.docId)!;
      if (batch.docId !== targetId) {
        compatibility.push(...collectWorkbenchCompatibility(
          src.doc, target, String(batch.layers[0]?.docKey ?? src.doc.name ?? "来源 PSD"),
        ));
      }
      ctx.reportProgress?.({ commandName: `正在复制 ${batch.layers.length} 个图层…` });
      const sourceLayers = batch.layers.map(ref => src.layers.get(ref.layerId)!);
      try {
        // Bound groups of four limit host memory use; a failing batch is bisected into
        // smaller calls only when the target acquired NO new layer from that call.
        const ids = await duplicateSafely(src.doc, sourceLayers, target, batch.docId);
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
    }

    // Avoid Document.groupLayers(copied): this API can return null for a mixed or nested
    // multi-layer selection, and the old code then reported a generic grouping failure.
    // Create a genuinely empty group first, then move each *newly duplicated* layer inside.
    // We never move or modify source layers. This works with groups and mixed source PSDs.
    ps().app.activeDocument = target;
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
    const destination = ps().constants.ElementPlacement.PLACEINSIDE;
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
      try { await ownedCopy.move(ownedGroup, destination); }
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
      log("warn", "workbench place verification failed",
        JSON.stringify({ targetId, groupId: group.id, missing }));
      throw new WorkbenchPlaceError(
        "VERIFY_FAILED", `「${groupName}」实际缺少 ${missing.length} 个图层（ID：${missing.join("、")}）。`,
        "已尝试回滚本次操作。请检查目标 PSD 是否留有副本，确认无重复后再重新置入。",
      );
    }
    try { target.activeLayers = [freshGroup]; } catch { /* selection is only cosmetic */ }

    log("info", "workbench placed", JSON.stringify({
      targetId, groupId: group.id, count: copiedIds.length, nestedSkipped: plan.nestedSkipped,
      sourceDocs: plan.batches.map(b => b.docId),
    }));
    return { docId: targetId, groupId: group.id, groupName, count: copiedIds.length,
      nestedSkipped: plan.nestedSkipped, compatibility };
  });
}
