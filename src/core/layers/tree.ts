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

/** An AI result group holding only its variations: listed as one layer (变体图层) whose variations
 *  are picked from a row under it, while Photoshop keeps the group. */
export const isVariantLayer = (l: TreeLayer) => !!l.ai && l.ai.variations > 0 && l.ai.variations === l.children;
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
/** 搜索 and 类型 at the top of the panel: name contains `text`, kind is one of `kinds` (none: any). */
export interface Query { text: string; kinds: ReadonlySet<LayerKind> }

/** Kinds as the 类型 buttons group them: the background is a pixel layer, fill layers go with adjustments. */
const kindGroup = (k: LayerKind): LayerKind => k === "background" ? "pixel" : k === "fill" ? "adjustment" : k;
export const queryActive = (q?: Query) => !!q && (!!q.text.trim() || q.kinds.size > 0);
export function queryMatch(l: TreeLayer, q?: Query): boolean {
  if (!q) return true;
  const t = q.text.trim().toLowerCase();
  return (!t || l.name.toLowerCase().includes(t)) && (!q.kinds.size || q.kinds.has(kindGroup(l.kind)));
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
    let hideBelow = Infinity;
    for (const l of layers) {
      if (l.depth > hideBelow) continue;
      hideBelow = Infinity;
      rows.push({ layer: l, context: false });
      if (l.kind === "group" && collapsed.has(l.id) || isVariantLayer(l)) hideBelow = l.depth;
    }
    return rows;
  }
  const byId = new Map(layers.map(l => [l.id, l]));
  const keep = new Set<number>(), hit = new Set<number>();
  for (const l of layers) {
    // a variant layer's variations are never listed
    const p = l.parentId === null ? undefined : byId.get(l.parentId);
    if (p && isVariantLayer(p)) continue;
    if (!matches(l, f, users) || !queryMatch(l, q)) continue;
    hit.add(l.id);
    for (let p: TreeLayer | undefined = l; p && !keep.has(p.id); p = p.parentId === null ? undefined : byId.get(p.parentId)) keep.add(p.id);
  }
  return layers.filter(l => keep.has(l.id)).map(l => ({ layer: l, context: !hit.has(l.id) }));
}

/** Ids of the groups that contain `id`, innermost first. */
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
  if (frac < 0.25) return "above";
  if (frac > 0.75 && !(open && l.children)) return "below";
  return "inside";
}

/** One Photoshop move: `id` goes before / after / into layer `rel`. */
export interface MoveStep { id: number; rel: number; place: "before" | "after" | "inside" }

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

// ── right-click menu ──

/** Commands the layer panel sends to Photoshop (see LayerTree.run). */
export type LayerAction =
  | "layerStyle" | "duplicate" | "delete" | "rename" | "newLayer" | "newGroup" | "groupLayers" | "ungroup" | "merge"
  | "convertSmart" | "rasterize" | "addMask" | "addMaskHide" | "deleteMask" | "applyMask" | "toggleMask" | "targetMask"
  | "clip" | "unclip" | "copyStyle" | "pasteStyle" | "clearStyle" | "toggleEffects" | "link" | "unlink" | "lock" | "unlock" | "setLock" | "solo" | "adjustment" | "editContents" | "toggleFilter" | "setProps" | "toggleEffect" | "moveFilter" | "effectStyle" | "showVariant" | "deleteVariant" | "setColor" | "loadSelection"
  | "addVectorMask" | "deleteVectorMask" | "toggleVectorMask" | "targetVectorMask" | "toggleMaskLink" | "viewMask" | "editFilter"
  | "targetLayer" | "targetFilterMask" | "deleteFilterMask"
  | "moveEffect" | "moveEffects" | "deleteEffect" | "moveFilters" | "deleteFilter" | "deleteFilters";

/** 智能对象 tools offered in the menu (they act on the selection, like on the 工具 page) */
export type SmartAction = "makeUnique" | "selectSameSource" | "makeEditable" | "unpack";

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
    { label: "合并图层", action: "merge", enabled: n > 1 || (one && l.kind === "group") },
    "-",
    { label: "转换为智能对象", action: "convertSmart", enabled: n > 0 },
    { label: "栅格化图层", action: "rasterize", enabled: any(x => x.kind === "smartObject" || x.kind === "text" || x.kind === "shape" || x.kind === "fill") },
  ];
  if (smart) items.push(
    { label: "编辑智能对象内容", action: "editContents", enabled: one && l.kind === "smartObject", hint: "双击状态图标" },
    { label: "断开智能对象链接", action: "makeUnique", enabled: true },
    { label: "选择同源智能对象", action: "selectSameSource", enabled: true },
    { label: "转为可编辑智能对象", action: "makeEditable", enabled: true },
    { label: "解包智能对象", action: "unpack", enabled: true },
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
  // like Photoshop: a group can only be locked as a whole (its layers are then locked through it),
  // and the background is left alone
  return layers.filter(l => ids.includes(l.id) && l.kind !== "background" && (l.kind !== "group" || which === "all"))
    .map(l => ({ id: l.id, locks: withLock(l, which, on) }));
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
