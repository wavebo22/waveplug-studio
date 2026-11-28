// 图层列表: the layer tree as the 工具 page shows it — status cells, filters, which rows are shown,
// selection clicks. Pure, so it is tested without Photoshop.

import { BLEND_PREFIX, EXPAND_PREFIX, EXTRACT_PREFIX, FILL_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX } from "../../ps/host.ts";

/** A layer as Photoshop lists them (multiGet), top to bottom; a group's end marker follows its children. */
export interface RawLayer {
  id: number;
  name: string;
  /** Photoshop's layerKind: 1 pixel, 2 adjustment, 3 text, 4 shape, 5 smart object, 7 group, 12 background, 13 group end … */
  kind: number;
  section: "start" | "end" | "content";
  visible: boolean;
  locked: boolean;
  /** every lock is on (otherwise only some, e.g. position) */
  lockAll?: boolean;
  /** single locks: 锁定位置, 锁定图像像素, 锁定透明像素 */
  lockPosition?: boolean;
  lockPixels?: boolean;
  lockTransparency?: boolean;
  /** 混合模式 (Photoshop's enum value), 不透明度 and 填充 in % */
  mode?: string;
  opacity?: number;
  fill?: number;
  /** smart objects: 智能滤镜, in Photoshop's list order, and whether they are shown at all */
  filters?: SmartFilter[];
  /** 图层样式 effects, in Photoshop's order */
  effectList?: Effect[];
  filtersOn?: boolean;
  /** linked to other layers (链接图层): their ids */
  links?: number[];
  mask: boolean;
  /** the layer mask is switched on (Shift+click on it in Photoshop turns it off) */
  maskOn?: boolean;
  /** clipped to the layer below (剪贴蒙版) */
  clipped?: boolean;
  /** has layer effects; whether they are shown */
  effects?: boolean;
  effectsOn?: boolean;
  /** Photoshop's background layer (its layerKind says pixel) */
  background?: boolean;
  /** smart objects: smartObjectMore.ID (shared by instances), whether linked, the content's file name */
  contentId?: string | null;
  linked?: boolean;
  file?: string;
  /** size of the layer's pixels (without effects); 0 × 0 when empty */
  width?: number;
  height?: number;
  /** where the layer's pixels start on the canvas */
  left?: number;
  top?: number;
  /** a 画板 (artboard), and Photoshop's 图层颜色 label (red, orange, yellowColor, grain, blue, violet, gray; none) */
  artboard?: boolean;
  color?: string;
  /** 矢量蒙版 and whether it is on; masks linked to the layer (they move with it) */
  vmask?: boolean;
  vmaskOn?: boolean;
  maskLinked?: boolean;
  vmaskLinked?: boolean;
  /** a smart object's 智能滤镜 mask */
  filterMask?: boolean;
  /** an artboard's own rectangle (document px) */
  board?: { left: number; top: number; right: number; bottom: number };
}

export interface SmartFilter { name: string; enabled: boolean }
/** One layer effect: `key` is Photoshop's (frameFX, dropShadow …), `multi` its place in a
 *  …Multi list (several strokes, shadows …) or -1 */
export interface Effect { key: string; multi: number; name: string; enabled: boolean }

export type LayerKind = "pixel" | "adjustment" | "text" | "shape" | "smartObject" | "group" | "fill" | "background" | "other";

/** Photoshop can refuse selectNoLayers (e.g. a document with only a Background layer).
 *  Keep an intentional empty selection in our panel while Photoshop's selection has not changed;
 *  resume following the host as soon as it selects a different set of layers. */
export function selectionAfterLocalClear(
  hostIds: readonly number[], heldHostIds: readonly number[] | null,
): { selected: number[]; keepClear: boolean } {
  if (heldHostIds === null) return { selected: [...hostIds], keepClear: false };
  const ordered = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(",");
  const keepClear = ordered(hostIds) === ordered(heldHostIds);
  return { selected: keepClear ? [] : [...hostIds], keepClear };
}

/** Delete the requested layers once each. A selected group already deletes its descendants, so
 *  do not try to delete selected children again. Discard ids no longer in the live document. */
export function deleteTargets(layers: readonly { id: number; parentId: number | null }[], ids: readonly number[]): number[] {
  const parents = new Map(layers.map(l => [l.id, l.parentId]));
  const selected = new Set(ids.filter(id => parents.has(id)));
  return [...selected].filter(id => {
    let parent = parents.get(id);
    const visited = new Set<number>();
    while (parent !== null && parent !== undefined && !visited.has(parent)) {
      if (selected.has(parent)) return false;
      visited.add(parent);
      parent = parents.get(parent);
    }
    return true;
  });
}

export interface DeleteSkip { id: number; name: string; reason: string }

/** Preflight for deleting layers (not masks/effects). Parent groups subsume their children.
 *  Never unlock Background or locked layers as an accidental side effect of pressing Delete. */
export function planLayerDeletion(
  layers: readonly { id: number; parentId: number | null; name?: string; locked?: boolean; background?: boolean; artboard?: boolean }[],
  ids: readonly number[],
): { targets: number[]; skipped: DeleteSkip[] } {
  const byId = new Map(layers.map(l => [l.id, l]));
  const targets: number[] = [], skipped: DeleteSkip[] = [];
  const unique = [...new Set(ids.filter(Number.isInteger))];
  // Photoshop may refuse deleting a complete artboard if one of its nested groups/layers is
  // fully locked. Detect that before the expensive host delete; don't unlock user's content.
  const lockedUnder = (rootId: number) => {
    for (const child of layers) {
      if (!child.locked || child.id === rootId) continue;
      let parent = child.parentId;
      const seen = new Set<number>();
      while (parent !== null && !seen.has(parent)) {
        if (parent === rootId) return child;
        seen.add(parent);
        parent = byId.get(parent)?.parentId ?? null;
      }
    }
    return null;
  };
  for (const id of unique) {
    if (!byId.has(id)) skipped.push({ id, name: `#${id}`, reason: "图层已不存在" });
  }
  for (const id of deleteTargets(layers, unique)) {
    const l = byId.get(id)!;
    const child = l.artboard && !l.locked ? lockedUnder(id) : null;
    if (l.background) skipped.push({ id, name: l.name ?? `#${id}`, reason: "背景图层需先解锁" });
    else if (l.locked) skipped.push({ id, name: l.name ?? `#${id}`, reason: "图层已锁定" });
    else if (child) {
      skipped.push({ id, name: l.name ?? `#${id}`, reason: `画板内「${child.name ?? `#${child.id}`}」已锁定，请先解锁` });
    }
    else targets.push(id);
  }
  // A document keeps at least one layer: Photoshop refuses to delete the last top-level one (a
  // group holding everything included), so say why instead of a bare "删除当前不可用".
  const tops = layers.filter(l => l.parentId === null).map(l => l.id);
  if (tops.length && tops.every(id => targets.includes(id))) {
    const keep = tops[tops.length - 1], l = byId.get(keep)!;
    targets.splice(targets.indexOf(keep), 1);
    skipped.push({ id: keep, name: l.name ?? `#${keep}`, reason: "文档至少要保留一个图层（可以先在它外面新建一个图层）" });
  }
  return { targets, skipped };
}

/** Whether dragging this layer-panel item can offer a delete drop target.
 *  This is a UI preflight only: Photoshop still validates a drop when it executes. */
export type DeleteDragPart = "mask" | "vmask" | "filterMask" | "filter" | "filters" | "effect" | "effects" | "variant";
export function canDropToDelete(
  layers: readonly TreeLayer[], ids: readonly number[], sub?: { kind: DeleteDragPart; layerId: number; variantId?: number },
): boolean {
  const groupLocked = lockedByGroup([...layers]);
  if (!sub) {
    const info = layers.map(l => ({
      id: l.id, parentId: l.parentId, name: l.name,
      background: l.kind === "background", locked: l.lockAll, artboard: l.artboard,
    }));
    return planLayerDeletion(info, ids).targets.some(id => !groupLocked.has(id));
  }
  const l = layers.find(x => x.id === sub.layerId);
  if (!l || l.kind === "background" || l.lockAll || groupLocked.has(l.id)) return false;
  switch (sub.kind) {
    case "mask": return l.mask;
    case "vmask": return l.vmask;
    case "filterMask": return l.filterMask;
    case "filter": case "filters": return l.filters.length > 0;
    case "effect": case "effects": return l.effectList.length > 0;
    case "variant": return l.ai?.ids.includes(sub.variantId ?? -1) ?? false;
  }
}

/** A mask thumbnail can be moved/copied to a different layer, not an effect-row insert.
 *  Do not replace an existing mask silently: Photoshop normally asks before replacing one.
 *  The UXP command re-checks the live document before writing. */
export type TransferMaskKind = "mask" | "vmask" | "filterMask";
export function canDropMaskOnto(
  layers: readonly TreeLayer[], srcId: number, dstId: number, kind: TransferMaskKind,
  inherited: ReadonlySet<number> = lockedByGroup([...layers]),
): boolean {
  if (srcId === dstId) return false;
  const src = layers.find(l => l.id === srcId), dst = layers.find(l => l.id === dstId);
  if (!src || !dst || src.kind === "background" || dst.kind === "background") return false;
  if (src.lockAll || dst.lockAll || inherited.has(srcId) || inherited.has(dstId)) return false;
  if (kind === "mask") return src.mask && !dst.mask;
  if (kind === "vmask") return src.vmask && !dst.vmask && dst.kind !== "shape";
  // Filter masks are part of the smart filter stack, not regular layer masks.
  return src.kind === "smartObject" && src.filterMask && dst.kind === "smartObject"
    && dst.filters.length > 0 && !dst.filterMask;
}

/** After deleting layers, select the first surviving row below the deleted block; if there is
 *  none, use the nearest row above. A deleted group removes all of its descendants. `visibleIds`
 *  keeps the selection on a row the panel actually shows (rather than inside a closed group). */
export function nextLayerAfterDelete(
  layers: readonly { id: number; parentId: number | null }[], ids: readonly number[], visibleIds?: readonly number[],
): number | null {
  const targets = new Set(deleteTargets(layers, ids));
  if (!targets.size) return null;
  const parents = new Map(layers.map(l => [l.id, l.parentId]));
  const gone = new Set<number>();
  for (const l of layers) {
    let id: number | null | undefined = l.id;
    const seen = new Set<number>();
    while (id !== null && id !== undefined && !seen.has(id)) {
      if (targets.has(id)) { gone.add(l.id); break; }
      seen.add(id);
      id = parents.get(id);
    }
  }
  const find = (order: readonly number[]): number | null | undefined => {
    let first = order.length, last = -1;
    for (let i = 0; i < order.length; i++) if (gone.has(order[i])) { first = Math.min(first, i); last = i; }
    if (last < 0) return undefined; // deleted layers were not in this view
    for (let i = last + 1; i < order.length; i++) if (parents.has(order[i]) && !gone.has(order[i])) return order[i];
    for (let i = first - 1; i >= 0; i--) if (parents.has(order[i]) && !gone.has(order[i])) return order[i];
    return null;
  };
  const visible = visibleIds ? find(visibleIds) : undefined;
  return visible !== undefined ? visible : find(layers.map(l => l.id)) ?? null;
}

export interface TreeLayer {
  id: number;
  name: string;
  kind: LayerKind;
  depth: number;
  parentId: number | null;
  visible: boolean;
  locked: boolean;
  lockAll: boolean;
  /** 锁定位置 / 锁定图像像素 / 锁定透明像素 (each also on under lockAll) */
  lockPosition: boolean;
  lockPixels: boolean;
  lockTransparency: boolean;
  /** ids of the layers this one is linked with (链接图层) */
  links: number[];
  mask: boolean;
  maskOn: boolean;
  /** clipped to the layer below it (剪贴蒙版); `clipBase`: the layer such layers are clipped to */
  clipped: boolean;
  clipBase: boolean;
  effects: boolean;
  effectsOn: boolean;
  /** groups: number of direct children */
  children: number;
  /** size of the layer's pixels, for the thumbnail */
  width: number;
  height: number;
  left: number;
  top: number;
  /** a 画板 (artboard), and its 图层颜色 label ("none" when there is none) */
  artboard: boolean;
  color: string;
  /** 矢量蒙版 and whether it is on; the layer mask / vector mask move with the layer (the chain between) */
  vmask: boolean;
  vmaskOn: boolean;
  maskLinked: boolean;
  vmaskLinked: boolean;
  filterMask: boolean;
  /** an artboard's rectangle: the thumbnails of the layers on it show it */
  board?: { left: number; top: number; right: number; bottom: number };
  smart?: { contentId: string | null; linked: boolean; file: string };
  mode: string;
  opacity: number;
  fill: number;
  /** 智能滤镜 (Photoshop's list order; `index` 1… addresses them) and whether they are shown at all */
  filters: SmartFilter[];
  /** 图层样式 effects, in Photoshop's order */
  effectList: Effect[];
  filtersOn: boolean;
  /** AI result groups made by this panel: their variation layers (top to bottom) and the one shown */
  ai?: { label: string; variations: number; ids: number[]; shown: number | null };
}

const KINDS: Record<number, LayerKind> = { 1: "pixel", 2: "adjustment", 3: "text", 4: "shape", 5: "smartObject", 7: "group", 9: "fill", 10: "fill", 11: "fill", 12: "background" };
export const kindOf = (n: number): LayerKind => KINDS[n] ?? "other";

const AI: [string, string][] = [[FILL_PREFIX, "AI填充"], [BLEND_PREFIX, "AI融图"], [EXTRACT_PREFIX, "AI抠图"], [EXPAND_PREFIX, "AI扩图"], [GENERATE_PREFIX, "AI生成"], [UPSCALE_PREFIX, "AI放大"]];
export const aiLabel = (name: string): string | null => AI.find(([p]) => name.startsWith(p))?.[1] ?? null;
const VARIATION = /^v\d+/;

/** The tree in display order (top to bottom), each layer with its depth and parent. */
export function buildTree(raw: RawLayer[]): TreeLayer[] {
  const out: TreeLayer[] = [], stack: TreeLayer[] = [];
  /** the previous layer in each group (null: top level), for clipping bases */
  const lastChild = new Map<number | null, TreeLayer>();
  for (const r of raw) {
    if (r.section === "end" || r.kind === 13) { stack.pop(); continue; }
    const parent = stack[stack.length - 1] ?? null;
    const group = r.section === "start" || r.kind === 7;
    const l: TreeLayer = {
      id: r.id, name: r.name, kind: group ? "group" : r.background ? "background" : kindOf(r.kind), depth: stack.length, parentId: parent?.id ?? null,
      visible: r.visible, locked: r.locked, lockAll: !!r.lockAll, mode: r.mode ?? (group ? "passThrough" : "normal"), opacity: r.opacity ?? 100, fill: r.fill ?? 100, filters: r.filters ?? [], filtersOn: r.filtersOn !== false, effectList: r.effectList ?? [],
      lockPosition: !!(r.lockAll || r.lockPosition), lockPixels: !!(r.lockAll || r.lockPixels), lockTransparency: !!(r.lockAll || r.lockTransparency), links: r.links ?? [], mask: r.mask, maskOn: r.maskOn !== false, clipped: !!r.clipped, clipBase: false,
      effects: !!r.effects, effectsOn: r.effectsOn !== false, children: 0, width: r.width ?? 0, height: r.height ?? 0, left: r.left ?? 0, top: r.top ?? 0,
      artboard: group && !!r.artboard, color: r.color || "none",
      // a shape layer's vector mask is its shape: Photoshop's panel shows no mask for it
      vmask: !!r.vmask && (group || kindOf(r.kind) !== "shape"), vmaskOn: r.vmaskOn !== false, maskLinked: r.maskLinked !== false, vmaskLinked: r.vmaskLinked !== false, filterMask: !!r.filterMask, board: group && r.artboard ? r.board : undefined,
    };
    // the first unclipped layer below clipped ones (same group) is their base
    const prev = lastChild.get(l.parentId);
    if (prev?.clipped && !l.clipped) l.clipBase = true;
    lastChild.set(l.parentId, l);
    if (l.kind === "smartObject") l.smart = { contentId: r.contentId ?? null, linked: !!r.linked, file: r.file ?? "" };
    if (parent) {
      parent.children++;
      if (parent.ai && VARIATION.test(l.name)) {
        parent.ai.variations++;
        parent.ai.ids.push(l.id);
        if (l.visible && parent.ai.shown === null) parent.ai.shown = l.id;
      }
    }
    if (group) {
      const label = aiLabel(l.name);
      if (label) l.ai = { label, variations: 0, ids: [], shown: null };
    }
    out.push(l);
    if (group) stack.push(l);
  }
  return out;
}

/** How many smart objects use each content. */
export function contentUsers(layers: TreeLayer[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of layers) if (l.smart?.contentId && !l.smart.linked) m.set(l.smart.contentId, (m.get(l.smart.contentId) ?? 0) + 1);
  return m;
}

const EDITABLE = /\.(psb|psd)$/i;
const VECTOR = /\.(ai|pdf|eps|svg)$/i;

export const isShared = (l: TreeLayer, users: Map<string, number>) => !!l.smart && !l.smart.linked && !!l.smart.contentId && (users.get(l.smart.contentId) ?? 0) > 1;
/** a smart object whose content isn't an embedded PSB / PSD (an image, a vector file or a link) */
export const isUneditable = (l: TreeLayer) => !!l.smart && (l.smart.linked || !EDITABLE.test(l.smart.file));

/** A status cell: shown as `icon` (with `count` beside it), `text` names it in tooltips and tests. */
export interface Tag { text: string; cls: string; tip: string; icon: string; count?: number }

/** The status cells of a row, left to right. */
export function layerTags(l: TreeLayer, users: Map<string, number>): Tag[] {
  const tags: Tag[] = [];
  if (l.ai) tags.push({ text: l.ai.variations ? `${l.ai.label} ×${l.ai.variations}` : l.ai.label, cls: "ai", tip: `WavePlug 的 ${l.ai.label} 结果，${l.ai.variations} 个变体`, icon: "spark", count: l.ai.variations || undefined });
  const s = l.smart;
  if (s) {
    const n = s.contentId ? users.get(s.contentId) ?? 1 : 1;
    if (s.linked) tags.push({ text: "链接", cls: "link", tip: "内容链接到外部文件" + (s.file ? `：${s.file}` : ""), icon: "external" });
    else if (n > 1) tags.push({ text: `共用×${n}`, cls: "shared", tip: `和另外 ${n - 1} 个智能对象共用同一份内容，改一个全部跟着变`, icon: "copies", count: n });
    else tags.push({ text: "独立", cls: "own", tip: "内容只属于这一个图层", icon: "single" });
    if (!s.linked && EDITABLE.test(s.file)) tags.push({ text: "可编辑", cls: "edit", tip: `内容是 ${s.file}，可以在 PS 里直接编辑`, icon: "layers" });
    else if (VECTOR.test(s.file)) tags.push({ text: "矢量", cls: "content", tip: `内容是矢量文件 ${s.file}，可以用「转为可编辑」转成 PSB`, icon: "vector" });
    else if (s.file) tags.push({ text: "图片", cls: "content", tip: `内容是图片 ${s.file}，可以用「转为可编辑」转成 PSB`, icon: "image" });
  }
  if (l.filters.length) tags.push({ text: "智能滤镜", cls: "filters" + (l.filtersOn ? "" : " off"), tip: `${l.filters.length} 个智能滤镜：${l.filters.map(f => f.name).join("、")}${l.filtersOn ? "" : "（已全部隐藏）"}`, icon: "filters", count: l.filters.length });
  if (l.mask) tags.push({ text: "蒙版", cls: "mask", tip: "带图层蒙版", icon: "mask" });
  return tags;
}

export type Filter = "all" | "shared" | "uneditable" | "ai";

export function matches(l: TreeLayer, f: Filter, users: Map<string, number>): boolean {
  return f === "all" || (f === "shared" ? isShared(l, users) : f === "uneditable" ? isUneditable(l) : !!l.ai);
}

/** Layers matching each filter. */
export function filterCounts(layers: TreeLayer[], users: Map<string, number>): Record<Exclude<Filter, "all">, number> {
  let shared = 0, uneditable = 0, ai = 0;
  for (const l of layers) { if (isShared(l, users)) shared++; if (isUneditable(l)) uneditable++; if (l.ai) ai++; }
  return { shared, uneditable, ai };
}

/** A shown row; `context` rows are only there as the parent of a match. */
/** A shown row; `filter` rows sit under a smart object: index 0 is the 智能滤镜 row (all of them),
 *  1… each filter. */
export interface Row { layer: TreeLayer; context: boolean; filter?: SubRow }

/** An AI result group with variations: listed as one layer (变体图层) whose variations are picked
 *  from a row under it, while Photoshop keeps the group. Other layers that ended up in the group
 *  (strays: placed, pasted or dragged in) don't undo that: they are listed under it as its
 *  children, and WaveLayer moves new ones out (`aiStrayMoves`). */
export const isVariantLayer = (l: TreeLayer) => !!l.ai && l.ai.variations > 0;
/** `l` is one of the variations of the variant layer it is in (listed as a chip, not as a row). */
const isVariationRow = (l: TreeLayer, parent: TreeLayer | undefined) => !!parent && isVariantLayer(parent) && parent.ai!.ids.includes(l.id);
/** Compact rows are used for sub-rows and plain groups. A group with its own mask thumbnail
 *  needs the normal layer height so the mask is not clipped vertically. */
export const isCompactRow = (r: Row): boolean => !!r.filter
  || (r.layer.kind === "group" && !isVariantLayer(r.layer) && !r.layer.mask && !r.layer.vmask);
/** a row under a layer: `kind` effects (效果) or smart filters (智能滤镜), each effect / filter a chip on
 *  it, or a variant layer's variations; `index` is always 0 */
export interface SubRow {
  kind: "effects" | "filters" | "variants"; index: number; name: string; enabled: boolean; effect?: Effect;
  /** which line of chips this row is (0 first) and the chips (places in effectList / filters /
   *  ai.ids) on it */
  line?: number; chips?: number[];
}

/**
 * The rows to show. Unfiltered: everything except what is inside a collapsed group. Filtered: the
 * matches and the groups they are in (as context), whatever is collapsed.
 */
/** Advanced conditions refine (AND) the existing name, kind and quick filters. */
export type AdvancedFilter = "visible" | "hidden" | "locked" | "unlocked" | "empty" |
  "mask" | "clip" | "effects" | "smartFilters" | "artboard" | "selected";
/** 搜索 and 类型 at the top of the panel: name contains `text`, kind is one of `kinds` (none: any). */
export interface Query {
  text: string;
  kinds: ReadonlySet<LayerKind>;
  advanced?: ReadonlySet<AdvancedFilter>;
  selectedIds?: ReadonlySet<number>;
}

/** Kinds as the 类型 buttons group them: the background is a pixel layer, fill layers go with adjustments. */
const kindGroup = (k: LayerKind): LayerKind => k === "background" ? "pixel" : k === "fill" ? "adjustment" : k;
export const queryActive = (q?: Query) => !!q && (!!q.text.trim() || q.kinds.size > 0 || !!q.advanced?.size);
export function queryMatch(l: TreeLayer, q?: Query): boolean {
  if (!q) return true;
  const t = q.text.trim().toLowerCase();
  if (t && !l.name.toLowerCase().includes(t) || q.kinds.size && !q.kinds.has(kindGroup(l.kind))) return false;
  const a = q.advanced;
  if (!a?.size) return true;
  const locked = l.lockAll || l.lockPixels || l.lockPosition || l.lockTransparency;
  return (!a.has("visible") || l.visible)
    && (!a.has("hidden") || !l.visible)
    && (!a.has("locked") || locked)
    && (!a.has("unlocked") || !locked)
    && (!a.has("empty") || l.kind === "pixel" && l.width === 0 && l.height === 0)
    && (!a.has("mask") || l.mask || l.vmask || l.filterMask)
    && (!a.has("clip") || l.clipped)
    && (!a.has("effects") || l.effectList.length > 0)
    && (!a.has("smartFilters") || l.filters.length > 0)
    && (!a.has("artboard") || !!l.artboard)
    && (!a.has("selected") || !!q.selectedIds?.has(l.id));
}

export function visibleRows(layers: TreeLayer[], collapsed: ReadonlySet<number>, f: Filter, users: Map<string, number>, openSubs: ReadonlySet<number> = new Set(), q?: Query): Row[] {
  // `openSubs`: a layer's id opens its effects (or a variant layer's variations), minus its id its
  // smart filters — each a row under it, each effect / filter a chip on that row
  const withFilters = (rows: Row[]): Row[] => rows.flatMap(r => {
    const l = r.layer;
    if (isVariantLayer(l) && !r.context && openSubs.has(l.id)) return [r, { layer: l, context: false, filter: { kind: "variants", index: 0, name: "变体", enabled: true } }];
    if (r.context || (!l.filters.length && !l.effectList.length)) return [r];
    const out: Row[] = [r];
    if (l.effectList.length && openSubs.has(l.id)) out.push({ layer: l, context: false, filter: { kind: "effects", index: 0, name: "效果", enabled: l.effectsOn } });
    if (l.filters.length && openSubs.has(-l.id)) out.push({ layer: l, context: false, filter: { kind: "filters", index: 0, name: "智能滤镜", enabled: l.filtersOn } });
    return out;
  });
  return withFilters(baseRows(layers, collapsed, f, users, q));
}

function baseRows(layers: TreeLayer[], collapsed: ReadonlySet<number>, f: Filter, users: Map<string, number>, q?: Query): Row[] {
  if (f === "all" && !queryActive(q)) {
    const rows: Row[] = [];
    const byId = new Map(layers.map(l => [l.id, l]));
    let hideBelow = Infinity;
    for (const l of layers) {
      if (l.depth > hideBelow) continue;
      hideBelow = Infinity;
      // a variant layer's variations are never listed (nor anything inside one)
      if (isVariationRow(l, l.parentId === null ? undefined : byId.get(l.parentId))) { hideBelow = l.depth; continue; }
      rows.push({ layer: l, context: false });
      if (l.kind === "group" && !isVariantLayer(l) && collapsed.has(l.id)) hideBelow = l.depth;
    }
    return rows;
  }
  const byId = new Map(layers.map(l => [l.id, l]));
  const keep = new Set<number>(), hit = new Set<number>();
  for (const l of layers) {
    // a variant layer's variations are never listed
    if (isVariationRow(l, l.parentId === null ? undefined : byId.get(l.parentId))) continue;
    if (!matches(l, f, users) || !queryMatch(l, q)) continue;
    hit.add(l.id);
    for (let p: TreeLayer | undefined = l; p && !keep.has(p.id); p = p.parentId === null ? undefined : byId.get(p.parentId)) keep.add(p.id);
  }
  return layers.filter(l => keep.has(l.id)).map(l => ({ layer: l, context: !hit.has(l.id) }));
}

/** Ids of the groups that contain `id`, innermost first. */
/**
 * Photoshop's selection as the list shows it: a layer inside an AI result (one of its variations, or
 * anything deeper — what Ctrl+click on the canvas with the move tool picks) is the AI layer's row,
 * the outermost one when they nest. Order kept, no repeats.
 */
export function listedSelection(layers: TreeLayer[], ids: readonly number[]): number[] {
  const byId = new Map(layers.map(l => [l.id, l]));
  const out: number[] = [];
  for (const id of ids) {
    let row = id;
    for (let p = byId.get(id)?.parentId ?? null; p !== null; p = byId.get(p)?.parentId ?? null) {
      const g = byId.get(p);
      if (g && isVariantLayer(g)) row = g.id;
    }
    if (!out.includes(row)) out.push(row);
  }
  return out;
}

export function ancestors(layers: TreeLayer[], id: number): number[] {
  const byId = new Map(layers.map(l => [l.id, l])), out: number[] = [];
  for (let p = byId.get(id)?.parentId ?? null; p !== null; p = byId.get(p)?.parentId ?? null) out.push(p);
  return out;
}

/**
 * The selection after clicking row `id`: plain click selects only it, Ctrl/⌘ toggles it, Shift
 * selects the shown rows from the anchor to it (Ctrl+Shift adds them). The anchor moves to `id`
 * except on Shift.
 */
export function clickSelect(rowIds: number[], current: number[], anchor: number | null, id: number, mods: { ctrl: boolean; shift: boolean }): { ids: number[]; anchor: number } {
  if (mods.shift && anchor !== null && rowIds.includes(anchor)) {
    const a = rowIds.indexOf(anchor), b = rowIds.indexOf(id);
    const range = rowIds.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { ids: mods.ctrl ? [...new Set([...current, ...range])] : range, anchor };
  }
  if (mods.ctrl) return { ids: current.includes(id) ? current.filter(x => x !== id) : [...current, id], anchor: id };
  return { ids: [id], anchor: id };
}

// ── drag to reorder ──

export type Where = "above" | "below" | "inside";

/**
 * Where a drop at `frac` (0 = top, 1 = bottom) of a row lands. A group's middle drops into it; the
 * bottom edge of an open group with layers is the gap above its first layer, so also into it. An AI
 * result (a group of variants, listed as one layer) takes nothing in: above or below it.
 */
export function dropZone(l: TreeLayer, frac: number, open: boolean): Where {
  if (l.kind !== "group" || isVariantLayer(l)) return frac < 0.5 ? "above" : "below";
  // Photoshop's split: top quarter above, middle into, bottom quarter below. (A 0.55 / 0.84 split
  // once compensated for drags located from the pressed row's centre; dragGeometry is exact now.)
  if (frac < 0.25) return "above";
  if (frac > 0.75 && !(open && l.children)) return "below";
  return "inside";
}

/** One Photoshop move: `id` goes before / after / into layer `rel`. */
export interface MoveStep { id: number; rel: number; place: "before" | "after" | "inside" }

/** A layer that doesn't belong in an AI result group: the group holds only its variations (vN …).
 *  Checked again by the host inside its history step, by name, just before it moves anything. */
export const isAiStray = (name: string, parentName: string): boolean => !!aiLabel(parentName) && !VARIATION.test(name);

/** What WaveLayer remembers, per document, about strays (layers in an AI group that aren't its
 *  variations): `leave` are left where they are, `moved` were moved out once, `tries` counts moves
 *  that were attempted (a move that failed is tried again, up to `STRAY_TRIES` times). */
export interface StrayMemo { leave: Set<number>; moved: Set<number>; tries: Map<number, number> }
export const STRAY_TRIES = 2;

/**
 * Photoshop puts a layer made, placed or pasted while an AI result group (or one of its
 * variations) is selected *inside* the group, and its own Layers panel lets layers be dragged in.
 * Every stray directly in an AI group goes just above it, top to bottom as they were — whether
 * it is new or was moved in, and whether or not an earlier attempt was missed — except:
 * - on the first read of the document (`memo` undefined) the strays already there are left (an
 *   old document is not changed just by being looked at);
 * - a stray that was moved out and is back in the group (the user undid the move, or put it back)
 *   is left from then on;
 * - a stray whose move was tried `STRAY_TRIES` times is left.
 * The returned memo is the one to keep; the caller counts a try (`tries`) before it moves and
 * adds the ids to `moved` once the move went through.
 */
export function aiStrayMoves(memo: StrayMemo | undefined, layers: readonly TreeLayer[]): { steps: MoveStep[]; memo: StrayMemo } {
  const byId = new Map(layers.map(l => [l.id, l]));
  const strays = layers.filter(l => {
    const p = l.parentId === null ? undefined : byId.get(l.parentId);
    return !!p?.ai && isAiStray(l.name, p.name);
  });
  if (!memo) return { steps: [], memo: { leave: new Set(strays.map(l => l.id)), moved: new Set(), tries: new Map() } };
  const last = new Map<number, number>();
  const steps: MoveStep[] = [];
  for (const l of strays) {
    if (memo.leave.has(l.id)) continue;
    if (memo.moved.has(l.id) || (memo.tries.get(l.id) ?? 0) >= STRAY_TRIES) { memo.leave.add(l.id); continue; }
    const prev = last.get(l.parentId!);
    steps.push(prev === undefined ? { id: l.id, rel: l.parentId!, place: "before" } : { id: l.id, rel: prev, place: "after" });
    last.set(l.parentId!, l.id);
  }
  return { steps, memo };
}

/**
 * The moves that put the dragged layers (kept in their top-to-bottom order) above / below / into
 * `targetId`. A dragged layer inside a dragged group moves with its group; the background can't
 * move, nothing goes below it, and Photoshop won't move anything relative to it, so "above the
 * background" is "below the layer above it". Null when the drop isn't possible (onto itself, into
 * itself, into an AI result — another layer there would make it an ordinary group — or nowhere to go).
 */
export function dropPlan(layers: TreeLayer[], dragIds: number[], targetId: number, where: Where): MoveStep[] | null {
  const byId = new Map(layers.map(l => [l.id, l]));
  const target = byId.get(targetId);
  if (!target) return null;
  const drag = new Set(dragIds);
  const inDragged = (id: number) => ancestors(layers, id).some(a => drag.has(a));
  const ids = layers.filter(l => drag.has(l.id) && l.kind !== "background" && !inDragged(l.id)).map(l => l.id);
  if (!ids.length || drag.has(targetId) || inDragged(targetId)) return null;
  if (where === "inside" && target.kind !== "group") return null;
  if (where === "inside" ? isVariantLayer(target) : ancestors(layers, targetId).some(a => { const g = byId.get(a); return !!g && isVariantLayer(g); })) return null;
  if (target.kind === "background") {
    const above = layers.filter(l => l.parentId === target.parentId && l.id !== targetId && !drag.has(l.id)).pop();
    if (!above) return null;
    return dropPlan(layers, dragIds, above.id, "below");
  }
  const chain = (first: MoveStep): MoveStep[] => [first, ...ids.slice(1).map((id, i) => ({ id, rel: ids[i], place: "after" as const }))];
  if (where === "above") return ids.map(id => ({ id, rel: targetId, place: "before" }));
  if (where === "below") return chain({ id: ids[0], rel: targetId, place: "after" });
  // into a group: on top of its first remaining layer, or into it when it is (or will be) empty
  const first = layers.find(l => l.parentId === targetId && !drag.has(l.id));
  return first ? ids.map(id => ({ id, rel: first.id, place: "before" })) : chain({ id: ids[0], rel: targetId, place: "inside" });
}

/**
 * Project a real layer move into WaveLayer's LOCAL tree, without touching Photoshop.
 *
 * Used only as an optimistic visual preview after mouseup. The host stays authoritative:
 * on modal completion its real layer tree replaces this preview. Each move keeps an entire
 * subtree together (including hidden AI variants) and changes only the moved root's
 * parent, with descendant depths adjusted to match.
 *
 * Returns null when a plan references missing layers or would make an invalid hierarchy;
 * in that case the UI simply waits for Photoshop's authoritative tree read.
 */
export function previewMoveTree(original: readonly TreeLayer[], steps: readonly MoveStep[]): TreeLayer[] | null {
  if (!steps.length) return null;
  const out = original.map(l => ({ ...l }));
  const block = (id: number): { from: number; to: number } | null => {
    const from = out.findIndex(l => l.id === id);
    if (from < 0) return null;
    let to = from + 1;
    while (to < out.length && out[to].depth > out[from].depth) to++;
    return { from, to };
  };
  for (const step of steps) {
    const src = block(step.id), dest = block(step.rel);
    if (!src || !dest || (dest.from >= src.from && dest.from < src.to)) return null;
    const sourceRoot = out[src.from], target = out[dest.from];
    if (step.place === "inside" && (target.kind !== "group" || !!target.ai)) return null;
    const parentId = step.place === "inside" ? target.id : target.parentId;
    const targetDepth = step.place === "inside" ? target.depth + 1 : target.depth;
    const delta = targetDepth - sourceRoot.depth;
    const subtree = out.slice(src.from, src.to).map((l, i) => ({
      ...l, depth: l.depth + delta, parentId: i === 0 ? parentId : l.parentId,
    }));
    out.splice(src.from, src.to - src.from);
    const targetBlock = block(step.rel);
    if (!targetBlock) return null;
    // MoveStep uses before/after, not above/below; a group is one atomic block.
    const where = step.place === "before" ? targetBlock.from : step.place === "inside"
      ? targetBlock.from + 1 : targetBlock.to;
    out.splice(where, 0, ...subtree);
  }
  // Recompute direct child counts and clipping bases for the preview.
  const byId = new Map(out.map(l => [l.id, l]));
  for (const l of out) { l.children = 0; l.clipBase = false; }
  const previous = new Map<number | null, TreeLayer>();
  const parents: TreeLayer[] = [];
  for (const l of out) {
    if (l.depth < 0 || l.depth > parents.length ||
        (l.depth === 0 && l.parentId !== null) ||
        (l.depth > 0 && (parents[l.depth - 1]?.id !== l.parentId ||
          byId.get(l.parentId!)?.kind !== "group"))) return null;
    parents.length = l.depth;
    parents.push(l);
    if (l.parentId !== null) byId.get(l.parentId)!.children++;
    const prev = previous.get(l.parentId);
    l.clipBase = !!prev?.clipped && !l.clipped;
    previous.set(l.parentId, l);
  }
  return out;
}

/**
 * Alt-drag uses copies of the dragged top-level items, leaving the original hierarchy untouched.
 * A step that refers to an earlier dragged source will instead refer to its newly created copy
 * (the Photoshop host maintains that mapping). This keeps multi-selection order when inserting
 * below a layer or into an empty group.
 *
 * Unlike a move, a copy may be placed beside its original. Never insert INTO an AI result group,
 * or next to its hidden variant children: WaveLayer represents that whole group as one AI layer.
 */
export function copyPlan(layers: TreeLayer[], sourceIds: number[], targetId: number, where: Where): MoveStep[] | null {
  const byId = new Map(layers.map(l => [l.id, l]));
  const target = byId.get(targetId);
  if (!target) return null;
  const sources = new Set(sourceIds);
  const ids = layers.filter(l => sources.has(l.id) && !ancestors(layers, l.id).some(id => sources.has(id))).map(l => l.id);
  if (!ids.length) return null;
  const parents = ancestors(layers, targetId);
  // A locked destination group cannot accept a new child. Its contents must also not be
  // modified by inserting copies next to one of its existing children.
  if (parents.some(id => byId.get(id)?.lockAll)) return null;
  // Duplicating a group beside/inside one of its own children would unexpectedly put the
  // duplicate under its original; disallow that as for a normal move.
  if (parents.some(id => sources.has(id))) return null;
  if (where === "inside") {
    if (target.kind !== "group" || target.lockAll || isVariantLayer(target) || sources.has(targetId)) return null;
  } else if (parents.some(id => isVariantLayer(byId.get(id)!))) return null;

  const chain = (first: MoveStep): MoveStep[] => [
    first, ...ids.slice(1).map((id, i) => ({ id, rel: ids[i], place: "after" as const })),
  ];
  // Photoshop will not accept a layer BELOW the locked background. ABOVE it, place the copies
  // below the previous top-level sibling, or directly above Background when it is the only one.
  if (target.kind === "background") {
    if (where === "below") return null;
    const prev = layers.filter(l => l.parentId === target.parentId && l.id !== targetId).pop();
    return prev ? copyPlan(layers, sourceIds, prev.id, "below")
      : chain({ id: ids[0], rel: targetId, place: "before" });
  }
  if (where === "above") return ids.map(id => ({ id, rel: targetId, place: "before" }));
  if (where === "below") return chain({ id: ids[0], rel: targetId, place: "after" });

  // Copying into a group doesn't remove any original child; insert copies at the top.
  const first = layers.find(l => l.parentId === targetId);
  return first ? ids.map(id => ({ id, rel: first.id, place: "before" }))
    : chain({ id: ids[0], rel: targetId, place: "inside" });
}

// ── right-click menu ──

/** Commands the layer panel sends to Photoshop (see LayerTree.run). */
export type LayerAction =
  | "layerStyle" | "duplicate" | "delete" | "rename" | "newLayer" | "newGroup" | "groupLayers" | "ungroup" | "merge"
  | "convertSmart" | "rasterize" | "addMask" | "addMaskHide" | "deleteMask" | "applyMask" | "toggleMask" | "targetMask"
  | "clip" | "unclip" | "copyStyle" | "pasteStyle" | "clearStyle" | "toggleEffects" | "link" | "unlink" | "lock" | "unlock" | "setLock" | "solo" | "adjustment" | "editContents" | "toggleFilter" | "setProps" | "toggleEffect" | "moveFilter" | "effectStyle" | "showVariant" | "deleteVariant" | "setColor" | "loadSelection"
  | "addVectorMask" | "deleteVectorMask" | "toggleVectorMask" | "targetVectorMask" | "toggleMaskLink" | "viewMask" | "editFilter"
  | "targetLayer" | "targetFilterMask" | "deleteFilterMask"
  | "moveEffect" | "moveEffects" | "deleteEffect" | "moveFilters" | "deleteFilter" | "deleteFilters"
  | "moveMask" | "moveVectorMask" | "moveFilterMask"
  // Photoshop's own commands the panel passes on (uxpLayers.ts actionDescs / menu commands)
  | "mergeDown" | "mergeVisible" | "flatten" | "rasterizeStyle" | "smartViaCopy" | "embedLinked" | "convertToLinked" | "relink" | "linkToFile" | "updateModified" | "updateAllModified"
  | "align" | "distribute" | "artboardFromLayers" | "newLayerDialog" | "quickExport" | "copyCSS" | "copySVG"
  // 合并图 (the button at the bottom right): a new layer only, every other layer left as it is
  | "stampVisible" | "stampSelected"
  // Ctrl+F (the helper takes it from Photoshop, native/overlay/src/hotkey.rs): Photoshop's own
  // 编辑 › 选择性粘贴 › 原位粘贴, like Illustrator's Ctrl+F (pasted in front, at the same place)
  | "pasteInPlace";

/** 智能对象 tools offered in the menu (they act on the selection, like on the 工具 page) */
export type SmartAction =
  | "makeUnique" | "selectSameSource" | "makeEditable" | "unpack"
  | "resetTransform" | "replaceContents" | "exportContents"
  | "convertTogether" | "convertSeparately";
/** The smart-object shortcut rail is deliberately separate from the normal layer menu.
 * Ordinary duplicate/convert/rasterize and content open are already available elsewhere;
 * content type and shared-source operations are exposed as status chips, not duplicate icons. */
export type SmartQuickAction = "replaceContents" | "exportContents" | "unpack" | "resetTransform";
export interface SmartQuickItem {
  action: SmartQuickAction;
  label: string;
  icon: string;
  hint: string;
  enabled: boolean;
  disabledReason?: string;
}
export interface SmartStatusChip {
  label: string;
  value: string;
  /** Match WaveLayer's existing lt-tag palette: edit/content/shared/own/link. */
  tone: "edit" | "content" | "shared" | "own" | "link" | "mask";
  hint: string;
  enabled: boolean;
  disabledReason?: string;
  action?: SmartAction;
  doubleAction?: SmartAction;
}
export interface SmartQuickPanel {
  type: SmartStatusChip;
  shared: SmartStatusChip;
  actions: SmartQuickItem[];
}
/** Derive the status section and non-duplicated shortcuts solely from the already read tree.
 * No extra Photoshop queries occur when opening the right-click menu.
 * A type or source chip acts only on one smart object; batch-safe icons stay available
 * for multiple selections, and the underlying LayerTools handles any mixed selection. */
export function smartQuickMenu(sel: readonly TreeLayer[], users: ReadonlyMap<string, number>): SmartQuickPanel | null {
  const smart = sel.filter(l => l.kind === "smartObject");
  if (!smart.length) return null;
  const one = sel.length === 1 && smart.length === 1, l = smart[0], data = l.smart;
  const file = data?.file ?? "";
  const ext = (file.match(/\.([^./\\]+)$/)?.[1] ?? "").toUpperCase();
  const linked = !!data?.linked;
  const editable = !linked && (ext === "PSB" || ext === "PSD");
  const number = data?.contentId ? Math.max(1, users.get(data.contentId) ?? 1) : 1;
  const shared = number > 1 && !linked;
  const reason = "请只选中一个智能对象";
  const type: SmartStatusChip = {
    label: "类型", value: one ? (ext || "未知") : "多选",
    tone: !one ? "mask" : editable ? "edit" : linked ? "link" : "content",
    enabled: one && !editable,
    action: one && !editable ? "makeEditable" : undefined,
    disabledReason: !one ? reason : "当前已是可编辑的 PSB/PSD 智能对象",
    hint: editable ? "已是可编辑智能对象，无须转换"
      : "单击将图片、矢量或外部链接的智能对象转换为可编辑 PSB；保持位置和变换",
  };
  const source: SmartStatusChip = {
    label: "链接", value: !one ? "多选" : linked
      ? "外链" : shared ? "链接×" + number : "独立",
    tone: !one ? "mask" : linked ? "link" : shared ? "shared" : "own",
    enabled: one && shared,
    action: one && shared ? "selectSameSource" : undefined,
    doubleAction: one && shared && !l.locked ? "makeUnique" : undefined,
    disabledReason: !one ? reason : linked ? "外部链接不是嵌入内容共享；请先转为 PSB"
      : !shared ? "当前智能对象没有同源副本" : "图层已锁定，不能断开共享",
    hint: shared ? (l.locked
      ? "单击：选中所有同源智能对象；图层已锁定，不能双击断开共享"
      : "单击：选中所有共用内容的智能对象；快速双击：将当前智能对象断开共享，成为独立内容")
      : linked ? "内容链接到外部文件，无法执行嵌入内容的独立副本操作"
      : "该智能对象没有其他共用内容的副本",
  };
  const actions: SmartQuickItem[] = [
    { action: "replaceContents", label: "替换内容…", icon: "soReplace",
      hint: "替换智能对象内容文件，保留位置/变换；其他同源副本也会变化", enabled: true },
    { action: "exportContents", label: "导出内容…", icon: "soExport",
      hint: "导出选中智能对象的原始内容文件，同源内容只导出一次", enabled: true },
    { action: "unpack", label: "解包图层", icon: "soUnpack",
      hint: "将智能对象恢复为内部图层，复杂透视可能无法完整还原", enabled: true },
    { action: "resetTransform", label: "重置变换", icon: "soReset",
      hint: "恢复智能对象置入时的大小、旋转和变换", enabled: true },
  ];
  return { type, shared: source, actions };
}

export type MenuItem = { label: string; action: LayerAction | SmartAction; enabled: boolean; hint?: string } | "-";

/** The right-click menu for the selected layers, Photoshop's order and wording, items that can't apply greyed out. */
export function layerMenu(sel: TreeLayer[]): MenuItem[] {
  const n = sel.length, one = n === 1, l = sel[0];
  const any = (f: (x: TreeLayer) => boolean) => sel.some(f), all = (f: (x: TreeLayer) => boolean) => n > 0 && sel.every(f);
  const movable = any(x => x.kind !== "background");
  const smart = any(x => x.kind === "smartObject");
  const items: MenuItem[] = [
    { label: "混合选项…", action: "layerStyle", enabled: one, hint: "双击缩略图" },
    { label: "重命名图层…", action: "rename", enabled: one },
    { label: "复制图层", action: "duplicate", enabled: n > 0 },
    { label: "删除图层", action: "delete", enabled: n > 0 },
    "-",
    { label: "从图层新建组", action: "groupLayers", enabled: movable, hint: "Ctrl+G" },
    { label: "取消图层编组", action: "ungroup", enabled: any(x => x.kind === "group") },
    { label: "来自图层的画板…", action: "artboardFromLayers", enabled: movable && !any(x => x.artboard) },
    "-",
    n > 1 || (one && l.kind === "group")
      ? { label: one ? "合并组" : "合并图层", action: "merge", enabled: true, hint: "Ctrl+E" }
      : { label: "向下合并", action: "mergeDown", enabled: one && l.kind !== "background" && !l.lockAll, hint: "Ctrl+E" },
    { label: "合并可见图层", action: "mergeVisible", enabled: true, hint: "Shift+Ctrl+E" },
    { label: "拼合图像", action: "flatten", enabled: true },
    "-",
    { label: "转换为智能对象", action: "convertSmart", enabled: n > 0 },
    { label: "栅格化图层", action: "rasterize", enabled: any(x => x.kind === "smartObject" || x.kind === "text" || x.kind === "shape" || x.kind === "fill") },
    { label: "栅格化图层样式", action: "rasterizeStyle", enabled: any(x => x.effects) },
  ];
  if (smart) items.push(
    { label: "编辑智能对象内容", action: "editContents", enabled: one && l.kind === "smartObject", hint: "双击状态图标" },
    { label: "断开智能对象链接", action: "makeUnique", enabled: true },
    { label: "选择同源智能对象", action: "selectSameSource", enabled: true },
    { label: "转为可编辑智能对象", action: "makeEditable", enabled: true },
    { label: "解包智能对象", action: "unpack", enabled: true },
    { label: "通过拷贝新建智能对象", action: "smartViaCopy", enabled: one && l.kind === "smartObject", hint: "副本有自己的内容，不和原来的共用" },
    any(x => !!x.smart?.linked)
      ? { label: "嵌入链接的智能对象", action: "embedLinked", enabled: true }
      : { label: "转换为链接对象…", action: "convertToLinked", enabled: one && l.kind === "smartObject" },
    { label: "重新链接到文件…", action: "relink", enabled: one && !!l.smart?.linked },
    // 链接的文件在外面改过后：把新内容读进来（PS 图层 › 智能对象 › 更新修改的内容）
    { label: "更新修改的内容", action: "updateModified", enabled: any(x => !!x.smart?.linked) },
    // an embedded one pointed at a file that exists already (转换为链接对象 saves a new one)
    { label: "链接到已有文件…", action: "linkToFile", enabled: one && l.kind === "smartObject" && !l.smart?.linked },
  );
  items.push(
    "-",
    one && l.mask
      ? { label: l.maskOn ? "停用图层蒙版" : "启用图层蒙版", action: "toggleMask", enabled: true, hint: "Shift+单击蒙版" }
      : { label: "添加图层蒙版", action: "addMask", enabled: one && l.kind !== "background" },
    { label: "应用图层蒙版", action: "applyMask", enabled: one && l.mask },
    { label: "删除图层蒙版", action: "deleteMask", enabled: one && l.mask },
    one && l.vmask
      ? { label: l.vmaskOn ? "停用矢量蒙版" : "启用矢量蒙版", action: "toggleVectorMask", enabled: true, hint: "Shift+单击矢量蒙版" }
      : { label: "添加矢量蒙版", action: "addVectorMask", enabled: one && l.kind !== "background" && l.kind !== "shape" },
    { label: "删除矢量蒙版", action: "deleteVectorMask", enabled: one && l.vmask },
    all(x => x.clipped)
      ? { label: "释放剪贴蒙版", action: "unclip", enabled: true, hint: "Alt+Ctrl+G" }
      : { label: "创建剪贴蒙版", action: "clip", enabled: movable, hint: "Alt+Ctrl+G" },
    "-",
    { label: "拷贝图层样式", action: "copyStyle", enabled: one && l.effects },
    { label: "粘贴图层样式", action: "pasteStyle", enabled: n > 0 },
    { label: "清除图层样式", action: "clearStyle", enabled: any(x => x.effects) },
    "-",
    { label: "链接图层", action: "link", enabled: n > 1 },
    { label: "取消链接图层", action: "unlink", enabled: n > 0 },
    all(x => x.locked) ? { label: "解除锁定", action: "unlock", enabled: true } : { label: "锁定全部", action: "lock", enabled: movable },
    { label: "只显示此图层", action: "solo", enabled: one, hint: "Alt+单击眼睛" },
    "-",
    { label: "快速导出为 PNG", action: "quickExport", enabled: n > 0 },
    { label: "复制 CSS", action: "copyCSS", enabled: n > 0 },
    { label: "复制 SVG", action: "copySVG", enabled: any(x => x.kind === "shape" || x.kind === "text" || x.kind === "group") },
  );
  return items;
}

// ── shared contents and links, for marking related rows ──

/** Colours the shared smart objects are marked with, one per content (cycled). */
export const SHARED_COLORS = 8;

/** Each shared content (used by more than one smart object) and its colour index, in list order. */
export function sharedColors(layers: TreeLayer[], users: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of layers) {
    const c = l.smart?.contentId;
    if (c && !l.smart!.linked && (users.get(c) ?? 0) > 1 && !out.has(c)) out.set(c, out.size % SHARED_COLORS);
  }
  return out;
}

/** The layers linked with any selected one, the selected ones left out, in list order. */
export function linkPeers(layers: TreeLayer[], selected: ReadonlySet<number>): number[] {
  const peers = new Set<number>();
  for (const l of layers) if (selected.has(l.id)) for (const id of l.links) if (!selected.has(id)) peers.add(id);
  // Photoshop lists a layer's partners; also take layers that list a selected one
  for (const l of layers) if (!selected.has(l.id) && l.links.some(id => selected.has(id))) peers.add(l.id);
  return layers.filter(l => peers.has(l.id)).map(l => l.id);
}

// ── 可移动 / 可编辑 toggles ──

/** Photoshop's layerLocking flags */
export interface Locks { protectAll: boolean; protectPosition: boolean; protectComposite: boolean; protectTransparency: boolean }

export type LockKey = "position" | "pixels" | "transparency" | "all";

/** `l`'s locks with one of them set to `on`; three single locks together are Photoshop's 锁定全部 */
function withLock(l: TreeLayer, which: LockKey, on: boolean): Locks {
  if (which === "all") return { protectAll: on, protectPosition: false, protectComposite: false, protectTransparency: false };
  const next = { protectAll: false, protectPosition: l.lockPosition, protectComposite: l.lockPixels, protectTransparency: l.lockTransparency };
  if (which === "position") next.protectPosition = on;
  else if (which === "pixels") next.protectComposite = on;
  else next.protectTransparency = on;
  if (next.protectPosition && next.protectComposite && next.protectTransparency) return { protectAll: true, protectPosition: false, protectComposite: false, protectTransparency: false };
  return next;
}

/**
 * 锁定 / 解锁 one lock on the layers `ids`, each keeping its other locks.
 */
export function lockPlan(layers: TreeLayer[], ids: number[], which: LockKey, on: boolean): { id: number; locks: Locks }[] {
  // Groups can only be locked as a whole. A Background layer is inherently locked, so only
  // the "lock all" control may include it, and only when the requested state is unlocked.
  return layers.filter(l => ids.includes(l.id)
    && (l.kind !== "background" || (which === "all" && !on))
    && (l.kind !== "group" || which === "all"))
    .map(l => ({ id: l.id, locks: l.kind === "background"
      ? { protectAll: false, protectPosition: false, protectComposite: false, protectTransparency: false }
      : withLock(l, which, on) }));
}

/** Layers inside a fully locked group: their own locks can't be changed until the group is unlocked. */
export function lockedByGroup(layers: TreeLayer[]): Set<number> {
  const out = new Set<number>(), stack: { depth: number; locked: boolean }[] = [];
  for (const l of layers) {
    while (stack.length && stack[stack.length - 1].depth >= l.depth) stack.pop();
    if (stack.some(s => s.locked)) out.add(l.id);
    if (l.kind === "group") stack.push({ depth: l.depth, locked: l.lockAll });
  }
  return out;
}

/** The eye column always has an explicit visible/hidden mark. Lock columns follow a
 * quieter rule: show their glyph ONLY while that lock is active (directly or inherited).
 * The 18px cells themselves remain in the row so they can still be clicked to enable a lock
 * and never shift the layer name/status columns when the icon appears or disappears. */
export function rowLockIcons(
  layer: Pick<TreeLayer, "kind" | "lockAll" | "lockPosition" | "lockPixels">,
  inherited = false,
): { move: boolean; edit: boolean } {
  if (layer.kind === "background") return { move: false, edit: false };
  if (layer.kind === "group") return { move: inherited || layer.lockAll, edit: false };
  return {
    move: inherited || layer.lockPosition,
    edit: inherited || layer.lockPixels,
  };
}

/** 混合模式, Photoshop's order and names ("-" separates its groups); 穿透 only for groups. */
export const BLEND_MODES: ([string, string] | "-")[] = [
  ["passThrough", "穿透"], ["normal", "正常"], ["dissolve", "溶解"], "-",
  ["darken", "变暗"], ["multiply", "正片叠底"], ["colorBurn", "颜色加深"], ["linearBurn", "线性加深"], ["darkerColor", "深色"], "-",
  ["lighten", "变亮"], ["screen", "滤色"], ["colorDodge", "颜色减淡"], ["linearDodge", "线性减淡（添加）"], ["lighterColor", "浅色"], "-",
  ["overlay", "叠加"], ["softLight", "柔光"], ["hardLight", "强光"], ["vividLight", "亮光"], ["linearLight", "线性光"], ["pinLight", "点光"], ["hardMix", "实色混合"], "-",
  ["difference", "差值"], ["exclusion", "排除"], ["blendSubtraction", "减去"], ["blendDivide", "划分"], "-",
  ["hue", "色相"], ["saturation", "饱和度"], ["color", "颜色"], ["luminosity", "明度"],
];

/** 图层样式 effects as Photoshop lists them under a layer: key, name */
export const EFFECTS: [string, string][] = [
  ["bevelEmboss", "斜面和浮雕"], ["frameFX", "描边"], ["innerShadow", "内阴影"], ["innerGlow", "内发光"], ["chromeFX", "光泽"],
  ["solidFill", "颜色叠加"], ["gradientFill", "渐变叠加"], ["patternFill", "图案叠加"], ["outerGlow", "外发光"], ["dropShadow", "投影"],
];

/** The effects in a layerEffects descriptor, in Photoshop's order; several of one kind come as a
 *  …Multi list (then the single key is a copy of the first and is left out). Absent ones are skipped. */
export function effectsOf(fx: Record<string, any> | undefined): Effect[] {
  if (!fx) return [];
  const out: Effect[] = [];
  for (const [key, name] of EFFECTS) {
    const multi = fx[key + "Multi"];
    const items: [any, number][] = Array.isArray(multi) ? multi.map((x, i) => [x, i]) : fx[key] ? [[fx[key], -1]] : [];
    for (const [x, i] of items) if (x && x.present !== false) out.push({ key, multi: i, name, enabled: x.enabled !== false });
  }
  return out;
}

/** Puts chips of `widths` px, in order, on lines of `avail` px (`gap` between chips); a chip wider
 *  than a line gets a line of its own. Places of the chips on each line. */
export function packChips(widths: number[], avail: number, gap = 4): number[][] {
  const lines: number[][] = [];
  let line: number[] = [], used = 0;
  widths.forEach((w, i) => {
    const need = (line.length ? gap : 0) + w;
    if (line.length && used + need > avail) { lines.push(line); line = []; used = 0; }
    used += (line.length ? gap : 0) + w;
    line.push(i);
  });
  if (line.length) lines.push(line);
  return lines;
}

/**
 * What is wrong with a layer list read in one go (multiGet), or null when it looks right: every
 * group closed by its end marker, no id twice, and as many top-level layers as Photoshop says the
 * document has. A wrong list hides layers inside groups that never end.
 */
export function rawProblem(raw: RawLayer[], topLevel: number): string | null {
  let depth = 0, top = 0;
  const seen = new Set<number>();
  for (const r of raw) {
    if (r.section === "end" || r.kind === 13) { if (--depth < 0) return "组结束标记多于组"; continue; }
    if (!(r.id > 0)) return "图层没有编号";
    if (seen.has(r.id)) return `图层编号重复：${r.id}`;
    seen.add(r.id);
    if (depth === 0) top++;
    if (r.section === "start" || r.kind === 7) depth++;
  }
  if (depth !== 0) return `有 ${depth} 个组没有结束标记`;
  if (top !== topLevel) return `顶层图层 ${top} 个，Photoshop 说是 ${topLevel} 个`;
  return null;
}

// ── 对齐 / 分布 (Photoshop's 图层 › 对齐 and 分布, on the selected layers) ──

/** Photoshop's alignDistributeSelector values */
export const ALIGNS: [string, string][] = [
  ["ADSLefts", "左边"], ["ADSCentersH", "水平居中"], ["ADSRights", "右边"],
  ["ADSTops", "顶边"], ["ADSCentersV", "垂直居中"], ["ADSBottoms", "底边"],
];
export const DISTRIBUTES: [string, string][] = [
  ...ALIGNS, ["ADSDistH", "水平间距"], ["ADSDistV", "垂直间距"],
];

/** How many layers 对齐 / 分布 would move: locked ones and the background stay where they are. */
export function arrangeable(sel: readonly TreeLayer[]): number {
  return sel.filter(l => l.kind !== "background" && !l.lockAll && !l.lockPosition).length;
}
/** Why 对齐 (2 layers or more) or 分布 (3 or more) can't run on `sel`; null when it can. */
export function arrangeProblem(sel: readonly TreeLayer[], kind: "align" | "distribute"): string | null {
  const need = kind === "align" ? 2 : 3, n = arrangeable(sel);
  if (sel.length < need) return `请先选中 ${need} 个或更多图层`;
  return n < need ? "选中的图层里可以移动的不够（锁定位置的图层和背景不会动）" : null;
}

// ── 顺序 (Ctrl+[ / ], Shift+Ctrl+[ / ]) and 选择上一个 / 下一个 (Alt+[ / ]) ──

/** The row to select with Alt+] (`up`) / Alt+[ from the selection, among the rows shown; null at the end. */
export function neighbourRow(shown: readonly number[], selected: ReadonlySet<number>, up: boolean): number | null {
  const at = shown.map((id, i) => selected.has(id) ? i : -1).filter(i => i >= 0);
  if (!at.length) return shown.length ? shown[up ? shown.length - 1 : 0] : null;
  const i = up ? at[0] - 1 : at[at.length - 1] + 1;
  return i >= 0 && i < shown.length ? shown[i] : null;
}

/**
 * 图层 › 排列: where the selected layers go for 前移一层 / 后移一层 / 置为顶层 / 置为底层, as one drop of
 * the whole selection beside a layer of the same group (the background stays at the bottom).
 * null when they are already there or the selection isn't inside one group.
 */
export function arrangeTarget(layers: readonly TreeLayer[], selected: ReadonlySet<number>, how: "forward" | "backward" | "front" | "back"): { rel: number; where: "above" | "below" } | null {
  const byId = new Map(layers.map(l => [l.id, l]));
  // the outermost selected layers: a selected group takes its layers with it
  const inside = (l: TreeLayer) => { for (let p = l.parentId; p !== null; p = byId.get(p)?.parentId ?? null) if (selected.has(p)) return true; return false; };
  const moving = layers.filter(l => selected.has(l.id) && !inside(l) && l.kind !== "background");
  if (!moving.length) return null;
  const parent = moving[0].parentId;
  if (moving.some(l => l.parentId !== parent)) return null;
  const siblings = layers.filter(l => l.parentId === parent && l.kind !== "background");
  const idx = moving.map(l => siblings.indexOf(l));
  const first = idx[0], last = idx[idx.length - 1], rest = siblings.filter(l => !selected.has(l.id));
  if (!rest.length) return null;
  if (how === "front") return last === moving.length - 1 ? null : { rel: rest[0].id, where: "above" };
  if (how === "back") return first === siblings.length - moving.length ? null : { rel: rest[rest.length - 1].id, where: "below" };
  if (how === "forward") {
    const above = siblings.slice(0, first).reverse().find(l => !selected.has(l.id));
    return above ? { rel: above.id, where: "above" } : null;
  }
  const below = siblings.slice(last + 1).find(l => !selected.has(l.id));
  return below ? { rel: below.id, where: "below" } : null;
}
