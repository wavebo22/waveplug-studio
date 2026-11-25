// WavePlug 图层 panel in Photoshop: the whole layer list (with each layer's status) is read with one
// multiGet, so documents with thousands of layers stay quick; the tree is built in core/layers/tree.ts.

import { log } from "../app/log.ts";
import { type Bounds, frameThumb, thumbArea } from "../core/layers/thumbs.ts";
import { shapeAlpha } from "../core/overlay/hoverFrame.ts";
import { openSmartContents } from "../core/layers/smartOpen.ts";
import type { ToolResult } from "../core/layers/smart.ts";
import { type LayerAction, type MoveStep, type RawLayer, buildTree, ALIGNS, DISTRIBUTES, nextLayerAfterDelete, planLayerDeletion, effectsOf, EFFECTS, rawProblem } from "../core/layers/tree.ts";
import { addEffect, effectItem, hasEffects, removeEffect } from "../core/layers/effects.ts";
import { type LayerDeleteResult, type LayerTree, type MoveOptions, type RunOptions, type TargetPart, ADJUSTMENTS } from "./host.ts";
import { docById, findLayer, modal, onModalDone, play, step } from "./uxpHost.ts";
import { act, selectLayers, UxpTools } from "./uxpTools.ts";
import { type MaskKind, maskTransferDescriptors } from "./maskTransfer.ts";
import { type StagedLayer, snapName } from "../core/layers/workbench.ts";
import { encodePng } from "../core/image/png.ts";
import { placeWorkbenchLayers, snapshotFolder } from "./uxpWorkbench.ts";
import { readLayerImage } from "./uxpHost.ts";
import { isNativeCommand, nativeDeleteOutcome, NATIVE_ACTIONS, NATIVE_COMMANDS_KEY, NATIVE_MENU, pickMenuId } from "../core/layers/nativeCommands.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const docRef = (id: number) => ({ _ref: "document", _id: id });
/** UI commands must never mutate an earlier PSD after the user switches tabs mid-operation. */
const requireActiveDoc = (docId: number) => {
  if (ps().app.activeDocument?.id !== docId) throw new Error("当前文档已切换，已取消操作以防误删其他 PSD");
};
/** Photoshop's Background layer cannot be unlocked with applyLocking; convert it to a normal layer. */
async function unlockBackgroundLayer(docId: number, id: number): Promise<number> {
  requireActiveDoc(docId);
  const doc = docById(docId), layer = findLayer(doc.layers, id);
  if (!layer?.isBackgroundLayer) return id;
  await selectLayers([id]);
  requireActiveDoc(docId);
  await act({
    _obj: "set",
    // `background` is a property reference on the layer class, not an ordinal layer value.
    // This is the same Action Manager target used by Photoshop's native Layer From Background.
    _target: [{ _ref: "layer", _property: "background" }],
    to: {
      _obj: "layer", name: String(layer.name ?? "Layer 0"),
      opacity: { _unit: "percentUnit", _value: 100 },
      mode: { _enum: "blendMode", _value: "normal" },
    },
  });
  requireActiveDoc(docId);
  const updated = docById(docId), active = updated.activeLayers?.[0];
  const bottom = updated.layers?.[updated.layers.length - 1];
  const converted = active && !active.isBackgroundLayer ? active : bottom;
  if (!converted || converted.isBackgroundLayer) throw new Error("Photoshop 未将背景图层转换为普通图层");
  log("info", "background layer unlocked", JSON.stringify({ docId, oldId: id, newId: converted.id }));
  return Number(converted.id);
}
const PROPS = ["layerID", "name", "layerKind", "layerSection", "visible", "hasUserMask", "layerLocking", "smartObject", "smartObjectMore", "boundsNoEffects", "background", "group", "userMaskEnabled", "layerEffects", "layerFXVisible", "linkedLayerIDs", "mode", "opacity", "fillOpacity", "artboardEnabled", "color", "hasVectorMask", "vectorMaskEnabled", "userMaskLinked", "vectorMaskLinked", "hasFilterMask", "artboard"];
/** opacity / fillOpacity as % (Photoshop gives 0–255, or a percent unit) */
const percent = (v: any): number | undefined => v === undefined || v === null ? undefined
  : typeof v === "object" ? Math.round(Number(v._value)) : Math.round(Number(v) / 255 * 100);
/** Runs `fn`, waiting while Photoshop is busy with another modal command (the selection a click just
 *  made, thumbnails being read): a double-click or a menu pick then still goes through. */
async function whenFree<T>(fn: () => Promise<T>, tries = 20): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      // Photoshop busy with another command (a modal one, or one holding the document's history)
      if (i >= tries || !/modal|already suspended/i.test(String((e as Error)?.message ?? e))) throw e;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

/** modal commands that change no layers (reading thumbnails, selecting) */
const THUMBS = "WavePlug 图层缩略图", SELECT = "WavePlug 选择图层";
const num = (v: any) => Number(typeof v === "object" && v ? v._value : v) || 0;

const isLocked = (k: any) => !!k && !!(k.protectAll || k.protectComposite || k.protectPosition || k.protectTransparency || k.protectArtboardAutonest);

let filterKeysLogged = false;
/** the first thumbnails' read bounds are logged (how Photoshop reports them) */
let thumbsLogged = 0;
/** Photoshop numbers smart filters the other way round from the list it reports (see run "toggleFilter") */
let filtersReversed = false;
/** the numbering that moved a smart filter last time (see run "moveFilter") */
let filterMove = { f: 0, dt: 1 };
/** 智能滤镜 of a smart object (smartObject.filterFX), and whether they are shown at all. */
function smartFilters(so: any): { filters?: { name: string; enabled: boolean }[]; filtersOn?: boolean } {
  const list = so?.filterFX;
  if (!Array.isArray(list) || !list.length) return {};
  if (!filterKeysLogged) {
    // which keys Photoshop uses (checked against what the list shows)
    filterKeysLogged = true;
    log("info", "smart filter keys", JSON.stringify(Object.keys(so)), JSON.stringify(Object.keys(list[0] ?? {})), JSON.stringify({ name: list[0]?.name, enabled: list[0]?.enabled, filterFXVisible: so.filterFXVisible, filterEnabled: so.filterEnabled }));
  }
  return {
    filters: list.map((f: any) => ({ name: String(f?.name ?? f?.filter?._obj ?? "滤镜").replace(/\.\.\.$|…$/, ""), enabled: f?.enabled !== false })),
    // Photoshop reports no "all filters shown" switch: the 智能滤镜 row stands for "any filter shown"
    filtersOn: list.some((f: any) => f?.enabled !== false),
  };
}

/** an artboard's rectangle, when Photoshop gave a sensible one */
function boardRect(a: any): RawLayer["board"] {
  if (!a) return undefined;
  const b = { left: num(a.left), top: num(a.top), right: num(a.right), bottom: num(a.bottom) };
  return b.right > b.left && b.bottom > b.top ? b : undefined;
}

/** One multiGet record (or a full layer descriptor) as a RawLayer. */
function rawOf(r: any): RawLayer {
  const sec = String(r.layerSection?._value ?? r.layerSection ?? "");
  const so = r.smartObject, more = r.smartObjectMore, b = r.boundsNoEffects, background = !!r.background;
  return {
    id: Number(r.layerID), name: String(r.name ?? ""), kind: Number(r.layerKind ?? 0),
    section: /End/.test(sec) ? "end" : /Start/.test(sec) ? "start" : "content",
    visible: r.visible !== false, locked: isLocked(r.layerLocking) || background, lockAll: !!r.layerLocking?.protectAll || background, mask: !!r.hasUserMask,
    lockPosition: !!r.layerLocking?.protectPosition, lockPixels: !!r.layerLocking?.protectComposite, lockTransparency: !!r.layerLocking?.protectTransparency,
    ...smartFilters(so),
    effectList: effectsOf(r.layerEffects),
    mode: r.mode?._value ?? (typeof r.mode === "string" ? r.mode : undefined), opacity: percent(r.opacity), fill: percent(r.fillOpacity),
    links: Array.isArray(r.linkedLayerIDs) ? r.linkedLayerIDs.map((x: any) => Number(typeof x === "object" && x ? x._id ?? x.layerID : x)).filter((x: number) => Number.isFinite(x)) : [], background,
    maskOn: r.userMaskEnabled !== false, clipped: !!r.group, effects: !!r.layerEffects, effectsOn: r.layerFXVisible !== false,
    contentId: more?.ID ? String(more.ID) : null, linked: !!so?.linked || !!so?.link,
    file: so?.fileReference ? String(so.fileReference) : undefined,
    width: b ? Math.max(0, num(b.right) - num(b.left)) : 0, height: b ? Math.max(0, num(b.bottom) - num(b.top)) : 0,
    left: b ? num(b.left) : 0, top: b ? num(b.top) : 0,
    artboard: !!r.artboardEnabled, color: String(r.color?._value ?? r.color ?? "none"),
    vmask: !!r.hasVectorMask, vmaskOn: r.vectorMaskEnabled !== false, maskLinked: r.userMaskLinked !== false, vmaskLinked: r.vectorMaskLinked !== false, filterMask: !!r.hasFilterMask,
    board: boardRect(r.artboard?.artboardRect),
  };
}

/** Every layer, top to bottom, group ends included. */
/** Every layer, top to bottom, group ends included. The fast multiGet result is checked (groups
 *  closed, top-level count as the DOM says); a list that doesn't add up is read again from the other
 *  first index, then layer by layer — a wrong list would hide layers in groups that never end. */
async function readRaw(docId: number, hasBackground: boolean): Promise<RawLayer[]> {
  const d = ps().app.documents.find((x: any) => x.id === docId);
  const topLevel = Number(d?.layers?.length ?? -1);
  const firsts = hasBackground ? [0, 1] : [1, 0];
  for (const first of firsts) {
    try {
      const [r] = await play([{
        _obj: "multiGet", _target: { _ref: [docRef(docId)] },
        extendedReference: [PROPS, { _obj: "layer", index: first, count: -1 }],
        options: { failOnMissingProperty: false, failOnMissingElement: false },
      }]);
      const list: any[] | undefined = r?.list;
      if (!Array.isArray(list) || !list.every(x => x && x.layerID !== undefined)) { log("warn", "layer tree multiGet", first, JSON.stringify(r).slice(0, 300)); continue; }
      const raw = list.map(rawOf).reverse();
      const problem = topLevel < 0 ? null : rawProblem(raw, topLevel);
      if (!problem) return raw;
      if (!badListLogged.has(docId)) {
        badListLogged.add(docId);
        log("warn", "layer tree multiGet list", first, problem, JSON.stringify(list.slice().reverse().slice(0, 80).map((x: any) => [x.layerID, x.name, x.layerKind, x.layerSection?._value ?? x.layerSection])));
      }
    } catch (e) { log("warn", "layer tree multiGet", first, e); }
  }
  return readRawDom(docId);
}
/** documents whose multiGet list didn't add up (logged once each) */
const badListLogged = new Set<number>();

/** Fallback without multiGet: the DOM for the tree, one batched get for the status. */
async function readRawDom(docId: number): Promise<RawLayer[]> {
  const d = ps().app.documents.find((x: any) => x.id === docId);
  if (!d) return [];
  const ids: number[] = [], out: RawLayer[] = [];
  const walk = (ls: any[]) => {
    for (const l of ls) {
      const group = String(l.kind) === "group";
      ids.push(l.id);
      const background = !!l.isBackgroundLayer;
      out.push({ id: l.id, name: String(l.name), kind: 0, section: group ? "start" : "content", visible: !!l.visible,
        locked: !!l.allLocked || background, lockAll: !!l.allLocked || background, background, mask: false });
      if (group) { walk(l.layers ?? []); out.push({ id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false }); }
    }
  };
  walk(d.layers);
  const res = await play(ids.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }, docRef(docId)] })));
  const byId = new Map(res.filter((r: any) => r?.layerID !== undefined).map((r: any) => [Number(r.layerID), rawOf(r)]));
  return out.map(l => { const r = byId.get(l.id); return r && l.section !== "end" ? { ...r, section: l.section } : l; });
}

/** Photoshop sometimes treats PLACEAFTER on a group as entering its last child.
 * Resolve the requested outside-group drop to a safe sibling anchor instead. */
interface LayerSlot { parentId: number | null; siblings: any[]; index: number }
function layerSlot(nodes: any, id: number, parentId: number | null = null): LayerSlot | null {
  if (!nodes) return null;
  const siblings: any[] = Array.from(nodes);
  for (let index = 0; index < siblings.length; index++) {
    const layer = siblings[index];
    if (layer.id === id) return { parentId, siblings, index };
    if (layer.layers?.length) {
      const child = layerSlot(layer.layers, id, layer.id);
      if (child) return child;
    }
  }
  return null;
}
const isGroupLayer = (layer: any) => layer?.layers != null
  && (String(layer.kind) === "group" || String(layer.kind) === "LayerKind.group" || typeof layer.layers.length === "number");

interface LayerAnchor { layer: any; place: "before" | "after" | "inside"; bottom: boolean }
/** Below a group: BEFORE next sibling, or BEFORE group + sendToBack if last. */
// PLACEAFTER is never used, below a plain layer either: user test 11-06, dropping a group on the
// lower half of a row (after it) always failed — Photoshop put the group at the top of the parent —
// while the upper half of the next row (before that one) always worked.
function safeLayerAnchor(doc: any, relative: any, place: "before" | "after" | "inside"): LayerAnchor {
  if (place !== "after") return { layer: relative, place, bottom: false };
  const at = layerSlot(doc.layers, relative.id);
  if (!at) {
    if (isGroupLayer(relative)) throw new Error("找不到目标组的同级位置，已取消放置");
    return { layer: relative, place, bottom: false };
  }
  const next = at.siblings[at.index + 1];
  return next ? { layer: next, place: "before", bottom: false }
    : { layer: relative, place: "before", bottom: true };
}
/** Validate the real Photoshop parent and relative order, not just the nominal move API result. */
function verifyLayerPlacement(doc: any, itemId: number, relativeId: number, place: "before" | "after" | "inside"): void {
  const item = layerSlot(doc.layers, itemId), relative = layerSlot(doc.layers, relativeId);
  if (!item || !relative) throw new Error("Photoshop 没有在目标位置找到图层，放置未完成");
  const parentOk = place === "inside" ? item.parentId === relativeId : item.parentId === relative.parentId;
  const orderOk = place === "inside" || item.index === relative.index + (place === "after" ? 1 : -1);
  if (!parentOk || !orderOk) {
    log("warn", "layer placement mismatch", JSON.stringify({
      itemId, relativeId, place, actualParent: item.parentId,
      desiredParent: place === "inside" ? relativeId : relative.parentId,
      itemIndex: item.index, relativeIndex: relative.index,
    }));
    throw new Error("Photoshop 将图层放到了错误位置（可能进入 AI 图层组），操作已取消");
  }
}

/** Count AM's hidden layerSectionEnd markers as well as visible descendants.
 * Photoshop itemIndex is bottom-up: a group occupies [start, children..., end]. */
function groupContentSlots(layer: any): number {
  if (!layer?.layers) return 0;
  let count = 0;
  for (const child of Array.from(layer.layers) as any[]) {
    count++; // the child
    if (child.layers) count += groupContentSlots(child) + 1; // its sectionEnd
  }
  return count;
}
async function photoshopLayerIndex(docId: number, id: number): Promise<number | null> {
  try {
    const [result] = await play([{
      _obj: "get",
      _target: [{ _property: "itemIndex" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }],
      _options: { dialogOptions: "silent" },
    }]);
    const n = Number(result?.itemIndex?._value ?? result?.itemIndex);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch (e) {
    log("info", "layer AM index unavailable", id, e);
    return null;
  }
}
function placedAsRequested(doc: any, id: number, rel: number, place: "before" | "after" | "inside"): boolean {
  const a = layerSlot(doc.layers, id), b = layerSlot(doc.layers, rel);
  return !!a && !!b
    && (place === "inside" ? a.parentId === rel : a.parentId === b.parentId)
    && (place === "inside" || a.index === b.index + (place === "after" ? 1 : -1));
}
/** Photoshop's UXP DOM sometimes moves a layer INTO the next group when asked to put
 * it BETWEEN two groups (real log: desired parent 157, actual parent 150).
 *
 * Instead of refusing the drag, use Photoshop's native AM move-to-index to insert at
 * the section boundary. Group end markers, a background layer and the moving layer's
 * own index cause off-by-one differences, so probe a small range of boundary indices
 * and verify the actual Photoshop tree after EACH attempt. All attempts occur inside
 * one suspended history state, so Ctrl+Z still undoes the one drag operation.
 */
// The same adjacent groups retain their AM section-boundary offset across drags.
const learnedGroupBoundary = new Map<string, number>();
async function moveAtIndex(itemId: number, index: number): Promise<boolean> {
  if (!Number.isInteger(index) || index < 0) return false;
  try {
    const [r] = await play([{
      _obj: "move", _target: [{ _ref: "layer", _id: itemId }],
      to: { _ref: "layer", _index: index }, adjustment: false,
      _options: { dialogOptions: "silent" },
    }]);
    return r?._obj !== "error";
  } catch { return false; }
}
async function repairLayerPlacement(doc: any, itemId: number, relativeId: number, place: "before" | "after" | "inside"): Promise<boolean> {
  if (placedAsRequested(doc, itemId, relativeId, place)) return true;
  if (place === "inside") return false;
  const started = Date.now();
  const rel = findLayer(doc.layers, relativeId), slot = layerSlot(doc.layers, relativeId);
  if (!rel || !slot) return false;
  // Beside a plain layer the DOM placement is unambiguous: try it before AM index probing.
  // A duplicated group can land above the target (real log: copy of D_Group after G_Hidden at
  // itemIndex 0), and the index probes (±4) can't reach it: a group spans its children's slots too.
  const item = findLayer(doc.layers, itemId);
  if (item && !isGroupLayer(rel) && typeof item.move === "function") {
    const P = ps().constants.ElementPlacement;
    // "after" as "before the next plain sibling" (PLACEAFTER misplaces groups, see safeLayerAnchor)
    const after = place === "after" ? slot.siblings[slot.index + 1] : null;
    const viaNext = !!after && after.id !== itemId && !isGroupLayer(after);
    try { await (viaNext ? item.move(after, P.PLACEBEFORE) : item.move(rel, place === "after" ? P.PLACEAFTER : P.PLACEBEFORE)); }
    catch (e) { log("info", "layer placement DOM retry", itemId, e); }
    if (placedAsRequested(doc, itemId, relativeId, place)) {
      log("info", "layer placement recovered by DOM move", JSON.stringify({ itemId, relativeId, place, ms: Date.now() - started }));
      return true;
    }
    // Real log (11-06 08:14): group 6 directly above G_Hidden, move(G_Hidden, PLACEAFTER) returned
    // without moving it. The same order comes from moving the plain layer to the group's other
    // side instead, never relative to the group itself (that can enter it): to the front / back
    // of their parent, or beside the plain sibling past the group.
    const at = layerSlot(doc.layers, itemId), relAt = layerSlot(doc.layers, relativeId);
    if (at && relAt && at.parentId === relAt.parentId && at.index === relAt.index + (place === "after" ? -1 : 1)) {
      const beyond = at.siblings[at.index + (place === "after" ? -1 : 1)];
      try {
        if (!beyond) await (place === "after" ? rel.bringToFront?.() : rel.sendToBack?.());
        else if (!isGroupLayer(beyond)) await rel.move(beyond, place === "after" ? P.PLACEAFTER : P.PLACEBEFORE);
      } catch (e) { log("info", "layer placement swap retry", itemId, relativeId, e); }
      if (placedAsRequested(doc, itemId, relativeId, place)) {
        log("info", "layer placement recovered by moving the target", JSON.stringify({ itemId, relativeId, place, ms: Date.now() - started }));
        return true;
      }
    }
  }
  const next = slot.siblings[slot.index + 1], prev = slot.siblings[slot.index - 1];
  let quickAttempts = 0;
  const probed = new Set<number>();
  // Symmetric recovery for the gap immediately above a folder. Photoshop's group start/end
  // markers can make PLACEBEFORE land on the wrong side when two folders are adjacent.
  if (place === "before" && prev && isGroupLayer(rel) && isGroupLayer(prev)) {
    const gap = doc.id + ":before:" + prev.id + ":" + rel.id;
    const base = await photoshopLayerIndex(doc.id, rel.id);
    if (base !== null) {
      const pref = learnedGroupBoundary.get(gap) ?? 1;
      for (const offset of [pref, 1, -1, 0, 2, -2]) {
        const current = await photoshopLayerIndex(doc.id, rel.id);
        const index = (current ?? base) + offset;
        if (probed.has(index)) continue;
        probed.add(index); quickAttempts++;
        if (await moveAtIndex(itemId, index) && placedAsRequested(doc, itemId, relativeId, place)) {
          learnedGroupBoundary.set(gap, offset);
          if (learnedGroupBoundary.size > 96) learnedGroupBoundary.delete(learnedGroupBoundary.keys().next().value!);
          log("info", "layer group-boundary recovered", JSON.stringify({
            itemId, relativeId, place, index, attempts: quickAttempts, ms: Date.now() - started, fast: true,
          }));
          return true;
        }
      }
    }
  }
  // Observed real Photoshop: when an AI group is immediately above another group,
  // five AM moves were needed each time. The successful index was NEXT.itemIndex-1.
  // Try that index FIRST and remember another offset if Photoshop needs one.
  if (place === "after" && next && isGroupLayer(rel) && isGroupLayer(next)) {
    const gap = doc.id + ":" + relativeId + ":" + next.id;
    const idx = await photoshopLayerIndex(doc.id, next.id);
    if (idx !== null) {
      const pref = learnedGroupBoundary.get(gap) ?? -1;
      for (const offset of [pref, -1, 1, 0, 2, -2]) {
        const index = idx + offset;
        if (probed.has(index)) continue;
        probed.add(index); quickAttempts++;
        if (await moveAtIndex(itemId, index) && placedAsRequested(doc, itemId, relativeId, place)) {
          learnedGroupBoundary.set(gap, offset);
          if (learnedGroupBoundary.size > 96) learnedGroupBoundary.delete(learnedGroupBoundary.keys().next().value!);
          log("info", "layer group-boundary recovered", JSON.stringify({
            itemId, relativeId, place, index, attempts: quickAttempts, ms: Date.now() - started, fast: true,
          }));
          return true;
        }
      }
    }
  }
  const refs: any[] = place === "after" ? [next, rel, prev] : [rel, prev, next];
  // Keep Photoshop batchPlay calls sequential; concurrent native reads inside one
  // executeAsModal can race with the preceding layer move on some PS builds.
  const positions: (number | null)[] = [];
  for (const x of refs) positions.push(x ? await photoshopLayerIndex(doc.id, x.id) : null);
  const candidates: number[] = [];
  const add = (n: number | null) => {
    if (n === null || !Number.isInteger(n)) return;
    // Prefer the real boundary, then compensate for the AM insertion convention,
    // existing background layer and change in the moving source's index.
    for (const dx of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const i = n + dx;
      if (i >= 0 && !probed.has(i) && !candidates.includes(i)) candidates.push(i);
    }
  };
  if (place === "after" && next && positions[0] !== null) add(positions[0] + 1);
  const relIndex = place === "after" ? positions[1] : positions[0];
  if (place === "after" && isGroupLayer(rel) && relIndex !== null)
    add(relIndex - groupContentSlots(rel) - 1);
  if (place === "before") add(positions[0] === null ? null : positions[0] + 1);
  for (const n of positions) add(n);
  // Last sibling, no next anchor: the group end marker is the real gap. Also
  // consider the parent's own end marker for deeply nested, empty groups.
  if (slot.parentId !== null) {
    const parent = findLayer(doc.layers, slot.parentId);
    const pidx = parent ? await photoshopLayerIndex(doc.id, parent.id) : null;
    if (pidx !== null && parent)
      add(pidx - groupContentSlots(parent) - 1);
  }
  let attempts = quickAttempts, failures = 0;
  for (const index of candidates) {
    if (placedAsRequested(doc, itemId, relativeId, place)) return true;
    attempts++;
    if (await moveAtIndex(itemId, index) && placedAsRequested(doc, itemId, relativeId, place)) {
      log("info", "layer group-boundary recovered", JSON.stringify({
        itemId, relativeId, place, index, attempts, ms: Date.now() - started, fast: false,
      }));
      return true;
    }
    failures++;
  }
  log("warn", "layer group-boundary recovery exhausted", JSON.stringify({
    itemId, relativeId, place, candidates: candidates.length + quickAttempts, attempts, failures, ms: Date.now() - started,
    actual: layerSlot(doc.layers, itemId)?.parentId,
    expected: layerSlot(doc.layers, relativeId)?.parentId,
  }));
  return placedAsRequested(doc, itemId, relativeId, place);
}

/** The document across sessions: its file, or its title before it is saved. */
function docKeyOf(d: any): string {
  let key = "";
  try { key = String(d.path || d.title || d.name || ""); } catch { /* unsaved: title only */ }
  return key || "doc" + d.id;
}

export class UxpLayerTree implements LayerTree {
  async placeStaged(entries: StagedLayer[], options?: import("./uxpWorkbench.ts").WorkbenchPlacementOptions) {
    return whenFree(() => placeWorkbenchLayers(entries, options));
  }
  async openDocs() {
    const out: { docId: number; docKey: string; name: string }[] = [];
    try { for (const d of ps().app.documents ?? []) out.push({ docId: d.id, docKey: docKeyOf(d), name: String(d.title ?? d.name ?? "") }); }
    catch (e) { log("warn", "workbench open docs", e); }
    return out;
  }
  async snapshotStaged(docId: number, docKey: string, layerId: number) {
    return whenFree(async () => {
      const { pixels } = await readLayerImage(docId, layerId);
      if (!pixels.width || !pixels.height) return null;
      const name = snapName(docKey, layerId);
      const folder = await snapshotFolder();
      const file = await folder.createFile(name, { overwrite: true });
      await file.write(encodePng(pixels), { format: require("uxp").storage.formats.binary });
      log("info", "workbench snapshot", JSON.stringify({ docId, layerId, name, w: pixels.width, h: pixels.height }));
      return name;
    });
  }
  async dropSnapshots(names: string[]) {
    const folder = await snapshotFolder();
    for (const n of names) {
      try { const f = await folder.getEntry(n); await f.delete(); } catch { /* already gone */ }
    }
  }
  async probeStaged(refs: { docId: number; layerId: number }[]) {
    const docs = new Map<number, any>();
    try { for (const d of ps().app.documents ?? []) docs.set(d.id, d); } catch { /* host busy: all unknown */ }
    return refs.map(r => {
      const d = docs.get(r.docId);
      if (!d) return null;
      try { const l = findLayer(d.layers ?? [], r.layerId); return l ? { name: String(l.name ?? "") } : null; }
      catch { return null; }
    });
  }
  async read() {
    const d = ps().app.activeDocument;
    if (!d) {
      // Right after open / new, activeDocument can still be null while the document exists:
      // a transient state, not "no document" (the panel then retries instead of going blank).
      let open = 0;
      try { open = Number(ps().app.documents?.length ?? 0); } catch { /* host busy */ }
      if (open > 0) throw new Error("activeDocument not ready (" + open + " open)");
      return null;
    }
    const t0 = Date.now();
    const [bg, target] = await play([
      { _obj: "get", _target: [{ _property: "hasBackgroundLayer" }, docRef(d.id)] },
      { _obj: "get", _target: [{ _property: "targetLayersIDs" }, docRef(d.id)] },
    ]);
    const t1 = Date.now();
    const raw = await readRaw(d.id, !!bg?.hasBackgroundLayer);
    const t2 = Date.now();
    const layers = buildTree(raw);
    // (a one-off whole-layer `get` of a smart object used to be logged here: it took ~20 s and
    // stalled Photoshop. Never `get` a whole layer descriptor on a path that runs by itself.)
    let selected: number[] = (target?.targetLayersIDs ?? []).map((x: any) => Number(x._id));
    if (!target?.targetLayersIDs) selected = (d.activeLayers ?? []).map((l: any) => l.id);
    const ms = Date.now() - t0;
    // where a slow read waited: the first query (Photoshop still busy redrawing after the last
    // command), the layer list, or building the tree here (11-24: 1–4 s reads were all waiting)
    if (ms > 300) log("info", "layer tree read", layers.length, "layers", ms, "ms", JSON.stringify({ first: t1 - t0, list: t2 - t1, build: Date.now() - t2 }));
    return { docId: d.id, docKey: docKeyOf(d), layers, selected, width: Math.round(d.width), height: Math.round(d.height) };
  }

  async pickColor(hex: string) {
    const n = parseInt(hex.replace("#", ""), 16) || 0;
    const r = await modal("WavePlug 自定义颜色", async () => {
      const [res] = await play([{ _obj: "showColorPicker", context: "", color: { _obj: "RGBColor", red: n >> 16, grain: (n >> 8) & 255, blue: n & 255 } }]);
      return res;
    }, { interactive: true });
    // `color` comes back in the picker's own model (HSB …); RGBFloatColor is the same colour as RGB 0–255
    const c = r?.RGBFloatColor?._obj === "RGBColor" ? r.RGBFloatColor : r?.color;
    if (!pickerLogged) { pickerLogged = true; log("info", "color picker", JSON.stringify(r ?? null).slice(0, 300)); }
    if (r?._obj === "error" || r?.value === false || !c || c._obj !== "RGBColor") return null;
    const v = (x: unknown) => Math.max(0, Math.min(255, Math.round(Number(x) || 0)));
    return "#" + [c.red, c.grain ?? c.green, c.blue].map(x => v(x).toString(16).padStart(2, "0")).join("");
  }

  async select(_docId: number, ids: number[]) {
    requireActiveDoc(_docId);
    if (ids.length) {
      const t0 = Date.now();
      await modal(SELECT, async () => { requireActiveDoc(_docId); await selectLayers(ids); });
      const ms = Date.now() - t0;
      if (ms > 200) log("info", "layer select slow", JSON.stringify({ ids: ids.slice(0, 4), n: ids.length, ms }));
      return;
    }
    const doc = docById(_docId);
    if (doc.layers.length === 1 && doc.layers[0]?.isBackgroundLayer) {
      // Photoshop never accepts selectNoLayers when the only layer is Background.
      // The UI will preserve its local empty selection; do not invoke a failing host command.
      log("info", "layer deselect skipped", "only background", _docId);
      return;
    }
    // Photoshop disables Select > Deselect Layers in some document states (notably a lone
    // Background layer). act() uses dontDisplay, which *still shows a native error dialog* when
    // the action is unavailable. Use silent instead, and let the panel keep an empty local
    // selection when Photoshop cannot represent an unselected layer state.
    try {
      await modal(SELECT, async () => {
        requireActiveDoc(_docId);
        const [result] = await play([{
          _obj: "selectNoLayers",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          _options: { dialogOptions: "silent" },
        }]);
        if (result?._obj === "error") {
          log("info", "layer deselect unavailable", _docId, result?.result, String(result?.message ?? ""));
        }
      });
    } catch (e) {
      // Deselecting is a UI convenience: never interrupt the user with a Photoshop error dialog.
      log("info", "layer deselect unavailable", _docId, e);
    }
  }

  async setVisible(_docId: number, ids: number[], visible: boolean) {
    await modal("WavePlug 显示/隐藏图层", async () => {
      for (const id of ids) await act({ _obj: visible ? "show" : "hide", null: [{ _ref: "layer", _id: id }] });
    });
  }

  async move(docId: number, steps: MoveStep[], opts?: MoveOptions): Promise<ToolResult> {
    const doc = docById(docId), P = ps().constants.ElementPlacement;
    const place = { before: P.PLACEBEFORE, after: P.PLACEAFTER, inside: P.PLACEINSIDE };
    const skipped: string[] = [];
    let done = await step(opts?.history ?? "WavePlug 移动图层", docId, async () => {
      let n = 0;
      for (const s of steps) {
        const l = findLayer(doc.layers, s.id), rel = findLayer(doc.layers, s.rel);
        if (!l || !rel) { skipped.push("#" + s.id + "：图层已不存在"); continue; }
        if (opts?.onlyIf && !opts.onlyIf(String(l.name ?? ""), String(l.parent?.name ?? ""))) { skipped.push(String(l.name) + "：已不需要移动"); continue; }
        try {
          const anchor = safeLayerAnchor(doc, rel, s.place);
          // Target already directly below a group? No movement required.
          if (l.id !== anchor.layer.id) {
            let nativeError: unknown = null;
            try { await l.move(anchor.layer, place[anchor.place]); }
            catch (e) { nativeError = e; }
            if (anchor.bottom && !nativeError && typeof l.sendToBack === "function") {
              try { await l.sendToBack(); }
              catch (e) { nativeError = e; }
            }
            // A move targeting a group boundary can fail without modifying layers.
            // Try the exact AM stack index before treating that as a failed drag.
            if (nativeError && s.place === "inside") throw nativeError;
            if (nativeError && !isGroupLayer(anchor.layer) && !isGroupLayer(rel)) throw nativeError;
          }
          if (!await repairLayerPlacement(doc, l.id, rel.id, s.place))
            verifyLayerPlacement(doc, l.id, rel.id, s.place);
          n++;
        } catch (e) {
          // A placement error is not a successfully skipped move: reject the history step,
          // instead of silently leaving the original layer nested in the AI result group.
          if (/放到了错误位置|组外置底/.test(String((e as Error)?.message ?? e))) throw e;
          skipped.push(String(l.name) + "：" + ((e as Error)?.message ?? e));
          log("warn", "layer move", l.name, e);
        }
      }
      return n;
    });
    // A DOM move can report success while Photoshop is still committing the suspended history
    // state. Verify again against a fresh document tree AFTER resumeHistory; never treat the
    // in-modal snapshot alone as proof that the layer reached its destination.
    if (steps.length === 1 && done > 0) {
      const s = steps[0];
      let committedDoc = docById(docId);
      if (!placedAsRequested(committedDoc, s.id, s.rel, s.place)) {
        const movedName = String(findLayer(committedDoc.layers, s.id)?.name ?? ("#" + s.id));
        log("warn", "layer placement post-commit mismatch", JSON.stringify({
          docId, itemId: s.id, relativeId: s.rel, place: s.place,
          actualParent: layerSlot(committedDoc.layers, s.id)?.parentId,
          expectedParent: s.place === "inside" ? s.rel : layerSlot(committedDoc.layers, s.rel)?.parentId,
        }));
        try {
          await step("WavePlug 修复图层放置", docId, async () => {
            const fresh = docById(docId);
            if (!await repairLayerPlacement(fresh, s.id, s.rel, s.place))
              verifyLayerPlacement(fresh, s.id, s.rel, s.place);
          });
        } catch (e) {
          log("warn", "layer placement post-commit repair failed", s.id, s.rel, s.place, e);
        }
        committedDoc = docById(docId);
        if (!placedAsRequested(committedDoc, s.id, s.rel, s.place)) {
          done = Math.max(0, done - 1);
          skipped.push(movedName + "：Photoshop 提交后未到达目标位置，已停止报告为成功");
          const actual = layerSlot(committedDoc.layers, s.id), relative = layerSlot(committedDoc.layers, s.rel);
          log("warn", "layer placement post-commit verification failed", JSON.stringify({
            itemId: s.id, relativeId: s.rel, place: s.place,
            actualParent: actual?.parentId, actualIndex: actual?.index,
            expectedParent: s.place === "inside" ? s.rel : relative?.parentId,
            relativeIndex: relative?.index,
          }));
        } else {
          log("info", "layer placement recovered after history commit", JSON.stringify({
            itemId: s.id, relativeId: s.rel, place: s.place,
          }));
        }
      } else {
        log("info", "layer placement committed", JSON.stringify({ itemId: s.id, relativeId: s.rel, place: s.place }));
      }
    }
    return { done, skipped };
  }

  /** Photoshop Layer.duplicate(relativeLayer, placement) preserves complete layer groups,
   *  including masks, smart-object shared references and all AI variation children.
   *  MoveStep.rel may refer to an earlier source: resolve it to the new clone, not the original.
   */
  async copy(docId: number, steps: MoveStep[]): Promise<{ done: number; skipped: string[]; ids: number[] }> {
    requireActiveDoc(docId);
    return whenFree(() => step("WavePlug 复制图层", docId, async () => {
      requireActiveDoc(docId);
      const doc = docById(docId), P = ps().constants.ElementPlacement;
      const place = { before: P.PLACEBEFORE, after: P.PLACEAFTER, inside: P.PLACEINSIDE };
      const cloneOf = new Map<number, any>(), ids: number[] = [], skipped: string[] = [];
      for (const s of steps) {
        const source = findLayer(doc.layers, s.id);
        const rel = cloneOf.get(s.rel) ?? findLayer(doc.layers, s.rel);
        if (!source || !rel) {
          skipped.push("#" + s.id + "：来源或目标图层已不存在");
          continue;
        }
        let clone: any = null;
        try {
          const anchor = safeLayerAnchor(doc, rel, s.place);
          // Duplicating beside itself is valid, but never use PLACEAFTER on an AI group.
          if (source.id === anchor.layer.id) {
            if (s.place === "inside") throw new Error("不能把图层组复制进自身");
            clone = await source.duplicate();
            if (anchor.place === "after") await clone.move(source, P.PLACEAFTER);
          } else {
            try { clone = await source.duplicate(anchor.layer, place[anchor.place]); }
            catch (error) {
              if (s.place === "inside" || (!isGroupLayer(anchor.layer) && !isGroupLayer(rel))) throw error;
              // Photoshop can refuse a group-relative duplicate. Make the copy beside
              // its original, then place it using the exact native AM layer index.
              log("info", "layer duplicate relative failed, retry by AM index", String((error as Error)?.message ?? error));
              clone = await source.duplicate();
            }
          }
          if (!clone || !Number.isFinite(clone.id)) throw new Error("Photoshop 未返回新图层 ID");
          if (anchor.bottom && typeof clone.sendToBack === "function") {
            try { await clone.sendToBack(); }
            catch (e) { log("info", "copy sendToBack unavailable; index recovery", e); }
          }
          if (!await repairLayerPlacement(doc, clone.id, rel.id, s.place))
            verifyLayerPlacement(doc, clone.id, rel.id, s.place);
          cloneOf.set(s.id, clone);
          ids.push(clone.id);
        } catch (e) {
          // A clone exists but sits in the wrong place. Deleting it is not enough: the AM index
          // probing can scatter a group clone's children (real log: four stray root layers left
          // after clone.delete). Reject the history step so Photoshop rolls back every change.
          if (clone) {
            log("warn", "layer drag copy rollback", JSON.stringify(s), clone.id, e);
            throw new Error(String(source.name) + "：" + ((e as Error)?.message ?? e) + "（已撤销本次复制，文档未改变）");
          }
          skipped.push(String(source.name) + "：" + ((e as Error)?.message ?? e));
          log("warn", "layer drag copy", JSON.stringify(s), e);
        }
      }
      if (ids.length) {
        // Select new clones rather than their sources. WaveLayer sees group IDs for AI layers.
        try { await selectLayers(ids); }
        catch (e) {
          skipped.push("复制成功，但自动选中副本失败：" + ((e as Error)?.message ?? e));
          log("warn", "layer drag copy select", ids.join(","), e);
        }
      }
      log("info", "layer drag copy finished", JSON.stringify({ docId, count: ids.length, ids, skipped }));
      return { done: ids.length, skipped, ids };
    }));
  }

  /** 悬停高亮: the layer's own pixels, scaled down to `size`, as coverage; read like a thumbnail
   *  (the same quiet modal, no history) and only when the pointer rests on a row. */
  async shape(docId: number, layerId: number, size: number) {
    const imaging = ps().imaging;
    return modal(THUMBS, async () => {
      const opts: Record<string, unknown> = { documentID: docId, layerID: layerId, componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" };
      const doc = docById(docId), l = findLayer(doc.layers, layerId);
      const b = l?.boundsNoEffects ?? l?.bounds;
      const w = Number(b?.right) - Number(b?.left), h = Number(b?.bottom) - Number(b?.top);
      if (!(w > 0 && h > 0)) return null;
      if (Math.max(w, h) > size) opts.targetSize = w >= h ? { width: size } : { height: size };
      const r = await imaging.getPixels(opts);
      try {
        const d = r?.imageData, sb = r?.sourceBounds;
        if (!d || !sb) return null;
        const k = Number.isFinite(Number(r.level)) ? 2 ** Number(r.level) : 1;
        let bounds = { left: Number(sb.left) * k, top: Number(sb.top) * k, right: Number(sb.right) * k, bottom: Number(sb.bottom) * k };
        if (![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
        // sourceBounds come in the scaled-down copy's whole pixels: times 2^level they can be off by
        // up to that many document px (a 5648 px layer read at 256 px: tens of px, the tint shifted
        // from the layer). The layer's own bounds are exact: used when they are the same area.
        const exact = { left: Number(b?.left), top: Number(b?.top), right: Number(b?.right), bottom: Number(b?.bottom) };
        const near = (a: number, c: number) => Number.isFinite(c) && Math.abs(a - c) <= k + 1;
        if (near(bounds.left, exact.left) && near(bounds.top, exact.top) && near(bounds.right, exact.right) && near(bounds.bottom, exact.bottom)) bounds = exact;
        const alpha = shapeAlpha(new Uint8Array(await d.getData({ chunky: true })), d.width, d.height, d.components);
        return alpha ? { bounds, width: d.width, height: d.height, alpha } : null;
      } finally { r?.imageData?.dispose?.(); }
    });
  }

  async thumbnails(docId: number, layers: { id: number; mask?: boolean | "vector"; bounds?: Bounds }[], canvas: { width: number; height: number }, size: number): Promise<(string | null | undefined)[]> {
    const imaging = ps().imaging;
    // A layer or mask is read over `bounds` (the panel gives its artboard, or the canvas: the picture
    // has the document's proportions, as in Photoshop), widened to at most 4 : 1 (core thumbArea),
    // always scaled down to `size`, and drawn into a picture of that area's shape: a thin or huge
    // area can't make an odd picture (UXP stopped painting the list at one thousands of px long).
    const whole = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
    return modal(THUMBS, async () => {
      const out: (string | null | undefined)[] = [];
      for (const l of layers) {
        const area = (l.bounds ? thumbArea(l.bounds) : null) ?? whole;
        const aw = area.right - area.left, ah = area.bottom - area.top;
        const read = { left: Math.floor(area.left), top: Math.floor(area.top), right: Math.ceil(area.right), bottom: Math.ceil(area.bottom) };
        const opts: Record<string, unknown> = l.mask
          ? { documentID: docId, layerID: l.id, kind: l.mask === "vector" ? "vector" : "user", sourceBounds: read }
          : { documentID: docId, layerID: l.id, sourceBounds: read, componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" };
        if (Math.max(aw, ah) > size) opts.targetSize = aw >= ah ? { width: size } : { height: size };
        try {
          const r = await (l.mask ? imaging.getLayerMask(opts) : imaging.getPixels(opts));
          try {
            const d = r?.imageData, sb = r?.sourceBounds;
            // nothing to read (an empty layer or mask): no picture, not a failure
            if (!d) { out.push(null); log("info", "layer thumbnail empty", l.id); continue; }
            let at = sb && [sb.left, sb.top, sb.right, sb.bottom].every((v: unknown) => Number.isFinite(Number(v)))
              ? { left: Number(sb.left), top: Number(sb.top), right: Number(sb.right), bottom: Number(sb.bottom) } : read;
            // with targetSize, Photoshop reads a scaled-down copy (pyramid `level`: 1/2, 1/4 …) and gives
            // sourceBounds — the layer's own pixels, trimmed — in that copy: back to document px
            const k = Number.isFinite(Number(r.level)) ? 2 ** Number(r.level) : 1;
            if (k !== 1) at = { left: at.left * k, top: at.top * k, right: at.right * k, bottom: at.bottom * k };
            if (thumbsLogged < 6) { thumbsLogged++; log("info", "layer thumbnail bounds", l.id, JSON.stringify({ read, target: opts.targetSize, sb, level: r.level, px: [d.width, d.height, d.components] })); }
            const px = frameThumb({ width: aw, height: ah, left: area.left, top: area.top }, size, { width: d.width, height: d.height, channels: d.components, data: new Uint8Array(await d.getData({ chunky: true })) }, at, !!l.mask, true);
            if (!px) { out.push(null); log("info", "layer thumbnail skipped", l.id, d.width, d.height, d.components, JSON.stringify(at)); continue; }
            const flat = await imaging.createImageDataFromBuffer(px.data, { width: px.width, height: px.height, components: 3, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", chunky: true });
            try {
              const b64 = await imaging.encodeImageData({ imageData: flat, base64: true });
              out.push(typeof b64 === "string" && b64 ? "data:image/jpeg;base64," + b64 : null);
            } finally { flat.dispose(); }
          } finally { r?.imageData?.dispose?.(); }
        } catch (e) {
          // a layer or document that is gone has no picture; anything else (-32005 "不能使用移动工具",
          // "无法更新智能对象文件" … while Photoshop is busy) is worth another try later
          const gone = /Unknown (layer|document)/i.test(String((e as Error)?.message ?? e));
          out.push(gone ? null : undefined); log("info", "layer thumbnail", l.id, e);
        }
      }
      return out;
    });
  }

  async run(docId: number, action: LayerAction, ids: number[], arg?: string, opts: RunOptions = {}) {
    requireActiveDoc(docId);
    const label = ACTION_NAMES[action] ?? action;
    // 原版命令（测试）: Photoshop's own command on the selected rows (falls back to the plugin's way
    // when the menu item can't be found for certain)
    if (nativeCommandsOn() && isNativeCommand(action)) {
      const r = await runNative(docId, action, ids, label);
      if (r !== FALLBACK) return r;
    }
    if (action === "delete") {
      // Explicit layer IDs (never active pixels/masks). All successful deletions form one undo step.
      const artboardIds = new Set(opts.artboardIds ?? []);
      return whenFree(() => step(artboardIds.size ? "WavePlug 删除画板" : "WavePlug " + label, docId, async (ctx): Promise<LayerDeleteResult> => {
        requireActiveDoc(docId);
        const doc = docById(docId);
        const live: { id: number; parentId: number | null; name: string; locked: boolean; background: boolean; artboard: boolean }[] = [];
        const collect = (ls: any[], parentId: number | null, dest: typeof live) => {
          for (const l of ls) {
            dest.push({ id: l.id, parentId, name: String(l.name ?? ("#" + l.id)),
              locked: !!l.allLocked, background: !!l.isBackgroundLayer, artboard: artboardIds.has(l.id) });
            if (l.layers?.length) collect(l.layers, l.id, dest);
          }
        };
        collect(doc.layers, null, live);
        const { targets, skipped } = planLayerDeletion(live, ids);
        const names = new Map(live.map(l => [l.id, l.name]));
        const attempted: number[] = [];
        log("info", "layer delete targets", JSON.stringify({ docId, requested: ids, targets, skipped, artboardIds: [...artboardIds] }));
        for (const id of targets) {
          if (!findLayer(doc.layers, id)) {
            skipped.push({ id, name: names.get(id) ?? ("#" + id), reason: "删除前图层已不存在" });
            continue;
          }
          const started = Date.now();
          try {
            if (artboardIds.has(id)) {
              // Photoshop may spend tens of seconds recalculating a large artboard. Show its native
              // cancellable progress UI rather than letting the operation look like a frozen panel.
              ctx.reportProgress?.({ commandName: `正在删除画板「${names.get(id) ?? id}」…` });
              log("info", "layer artboard delete begin", JSON.stringify({ docId, id, name: names.get(id) }));
            }
            const [response] = await play([{
              _obj: "delete", _target: [{ _ref: "layer", _id: id }, docRef(docId)],
              _options: { dialogOptions: "silent" },
            }]);
            if (ctx.isCancelled) throw new Error("用户已取消删除操作");
            if (response?._obj === "error") throw new Error(response.message || "Photoshop 拒绝删除此图层");
            attempted.push(id);
            if (artboardIds.has(id))
              log("info", "layer artboard delete completed", JSON.stringify({ docId, id, elapsedMs: Date.now() - started }));
          } catch (e) {
            const reason = String((e as Error)?.message ?? e);
            if (artboardIds.has(id))
              log("warn", "layer artboard delete failed", JSON.stringify({ docId, id, elapsedMs: Date.now() - started }), e);
            // User cancellation and modal/history interruption must roll back the transaction.
            if (/cancel|取消|modal|already suspended/i.test(reason)) throw e;
            skipped.push({ id, name: names.get(id) ?? ("#" + id), reason });
            log("warn", "layer delete failed", JSON.stringify({ docId, id, name: names.get(id), completed: attempted }), e);
          }
        }
        // Re-read live IDs. A resolved batchPlay action is not enough to claim removal.
        const after: typeof live = [];
        collect(doc.layers, null, after);
        const surviving = new Set(after.map(l => l.id));
        const deleted = attempted.filter(id => !surviving.has(id));
        for (const id of attempted) if (surviving.has(id)) {
          skipped.push({ id, name: names.get(id) ?? ("#" + id), reason: "Photoshop 仍保留该图层" });
          log("warn", "layer delete not removed", JSON.stringify({ docId, id, name: names.get(id) }));
        }
        // A skipped/failed target changes which row is next. Select only from confirmed deletions.
        const preferred = !skipped.length && opts.afterDeleteSelect !== undefined ? opts.afterDeleteSelect : null;
        const next = deleted.length ? (preferred !== null && findLayer(doc.layers, preferred)
          ? preferred : nextLayerAfterDelete(live, deleted)) : null;
        if (next !== null && findLayer(doc.layers, next)) {
          try {
            await selectLayers([next]);
          } catch (e) { log("warn", "layer delete next select", next, e); }
        }
        let actual: number[] = (doc.activeLayers ?? []).map((l: any) => l.id);
        try {
          const [r] = await play([{ _obj: "get", _target: [{ _property: "targetLayersIDs" }, docRef(docId)] }]);
          if (Array.isArray(r?.targetLayersIDs) && r.targetLayersIDs.length)
            actual = r.targetLayersIDs.map((x: any) => Number(x._id));
        } catch (e) { log("info", "layer delete selection read", docId, e); }
        const selected = actual.find(id => surviving.has(id)) ?? null;
        const outcome: LayerDeleteResult = { kind: "delete", deleted, skipped, selected };
        log("info", "layer delete result", JSON.stringify({ docId, ...outcome, attempted, proposed: opts.afterDeleteSelect }));
        return outcome;
      }), 40);
    }
    if (action === "moveMask" || action === "moveVectorMask" || action === "moveFilterMask") {
      const kind: MaskKind = action === "moveMask" ? "mask" : action === "moveVectorMask" ? "vmask" : "filterMask";
      const { toLayer, copy } = JSON.parse(arg ?? "{}");
      const srcId = ids[0], dstId = Number(toLayer);
      if (!Number.isInteger(srcId) || !Number.isInteger(dstId) || srcId === dstId)
        throw new Error("请选择另一个有效图层作为蒙版目标");
      const property = kind === "mask" ? "hasUserMask" : kind === "vmask" ? "hasVectorMask" : "hasFilterMask";
      const exists = async (id: number): Promise<boolean> => {
        const [r] = await play([{ _obj: "get",
          _target: [{ _property: property }, { _ref: "layer", _id: id }, docRef(docId)] }]);
        if (r?._obj === "error") throw new Error(r.message || "无法读取蒙版状态");
        return r?.[property] === true;
      };
      return whenFree(() => step("WavePlug " + (copy ? "复制" : "移动") + (kind === "mask" ? "图层蒙版" : kind === "vmask" ? "矢量蒙版" : "智能滤镜蒙版"), docId, async () => {
        requireActiveDoc(docId);
        const doc = docById(docId);
        const src = findLayer(doc.layers, srcId), dst = findLayer(doc.layers, dstId);
        if (!src || !dst) throw new Error("源图层或目标图层已不存在");
        const locked = (l: any) => {
          for (let node = l; node; node = node.parent) if (node.allLocked) return true;
          return false;
        };
        if (src.isBackgroundLayer || dst.isBackgroundLayer || locked(src) || locked(dst))
          throw new Error("背景图层或锁定图层不能转移蒙版");
        if (kind === "vmask" && /shape/i.test(String(dst.kind)))
          throw new Error("目标形状图层已有自己的矢量形状，不能替换");
        if (kind === "filterMask") {
          const [info] = await play([{ _obj: "get",
            _target: [{ _property: "smartObject" }, { _ref: "layer", _id: dstId }, docRef(docId)] }]);
          if (!Array.isArray(info?.smartObject?.filterFX) || !info.smartObject.filterFX.length)
            throw new Error("智能滤镜蒙版只能放到有智能滤镜的智能对象上");
        }
        if (!await exists(srcId)) throw new Error("源蒙版已经不存在");
        if (await exists(dstId)) throw new Error("目标已有同类蒙版，请先移除目标蒙版");
        // Duplicate first; remove the source only after Photoshop confirms the destination.
        // Both commands share a history state, so a failed move rolls back instead of losing a mask.
        const commands = maskTransferDescriptors(kind, docId, srcId, dstId);
        await act(commands.copy);
        if (!await exists(dstId)) throw new Error("Photoshop 未在目标图层建立蒙版");
        if (!copy) {
          await act(commands.removeSource);
          if (await exists(srcId)) throw new Error("目标已收到蒙版，但源蒙版未删除；操作已撤销");
        } else if (!await exists(srcId)) throw new Error("复制后源蒙版意外丢失；操作已撤销");
        log("info", "layer mask transferred", JSON.stringify({ docId, kind, srcId, dstId, copy: !!copy }));
      }), 40);
    }
    // these act on the layer by id, leaving the selection alone
    const prepare = async () => {
      if (!ids.length || action === "solo" || action === "setLock" || action === "loadSelection") return;
      // a layer deleted since the list was read can't be selected: leave it out
      requireActiveDoc(docId);
      const doc = docById(docId), there = ids.filter(id => findLayer(doc.layers, id));
      if (!there.length) throw new Error("图层已不存在");
      await selectLayers(there);
    };
    if (action === "toggleEffects") {
      // Photoshop's FX eye is NOT a layer property setter. It dispatches show/hide
      // with an ActionList named "target", containing a class reference to layerEffects
      // chained to the specific layer (Adobe's recorded JSX form).
      const wanted = arg === "on";
      const readFxState = async (id: number) => {
        const ref = [{ _ref: "layer", _id: id }, docRef(docId)];
        const [fx] = await play([{ _obj: "get", _target: [{ _property: "layerEffects" }, ...ref] }]);
        const [visible] = await play([{ _obj: "get", _target: [{ _property: "layerFXVisible" }, ...ref] }]);
        if (fx?._obj === "error") throw new Error(fx.message || "读取图层样式失败");
        if (visible?._obj === "error") throw new Error(visible.message || "读取图层样式显示状态失败");
        return { hasEffects: !!fx?.layerEffects, visible: visible?.layerFXVisible !== false };
      };
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        await prepare();
        const before = await Promise.all(ids.map(readFxState));
        const targets = ids.filter((_, i) => before[i].hasEffects && before[i].visible !== wanted);
        if (!targets.length) {
          log("info", "layer effects visibility unchanged", JSON.stringify({ ids, wanted, before }));
          return;
        }
        const descriptor = {
          _obj: wanted ? "show" : "hide",
          target: targets.map(id => ({
            _ref: [
              { _ref: "layerEffects" },
              { _ref: "layer", _id: id },
              docRef(docId),
            ],
          })),
        };
        const [result] = await play([descriptor]);
        if (result?._obj === "error") throw new Error(result.message || "Photoshop 无法切换图层样式");
        const after = await Promise.all(targets.map(readFxState));
        log("info", "layer effects visibility", JSON.stringify({ ids: targets, wanted, before, after, result }));
        if (after.some(state => !state.hasEffects || state.visible !== wanted)) {
          throw new Error("Photoshop 未能切换图层样式显示状态");
        }
      }));
      return;
    }
    if (action === "toggleFilter") {
      // index 0: the 智能滤镜 row (hide all if any is shown, else show all); 1…: one filter, by its
      // place in the list we read. Photoshop numbers filters in its own order, so every switch is
      // checked against the list read again afterwards and, if it hit another filter, undone and
      // done the other way round (which way is remembered).
      const { index } = JSON.parse(arg ?? "{}");
      const id = ids[0];
      const states = async (): Promise<boolean[]> => {
        const [r] = await play([{ _obj: "get", _target: [{ _property: "smartObject" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] }]);
        return (r?.smartObject?.filterFX ?? []).map((f: any) => f?.enabled !== false);
      };
      const sw = (i: number, on: boolean) => act({ _obj: on ? "show" : "hide", _target: [{ _ref: "filterFX", _index: i }, target] });
      /** switches the filter at list place `pos` (0-based) to `on` */
      const setOne = async (pos: number, on: boolean) => {
        const before = await states(), n = before.length;
        if (before[pos] === on) return;
        for (const reversed of [filtersReversed, !filtersReversed]) {
          const i = reversed ? n - pos : pos + 1;
          await sw(i, on);
          const after = await states();
          if (after[pos] === on) {
            if (reversed !== filtersReversed) { filtersReversed = reversed; log("info", "smart filter order", reversed ? "reversed" : "as listed"); }
            return;
          }
          // another filter was hit: put it back
          if (after.some((v, k) => v !== before[k])) await sw(i, !on);
          if (n < 2) break;
        }
        throw new Error("Photoshop 没有切换这个智能滤镜");
      };
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        await prepare();
        if (index) { await setOne(index - 1, !(await states())[index - 1]); return; }
        const now = await states(), on = !now.some(Boolean);
        for (let pos = 0; pos < now.length; pos++) if (now[pos] !== on) await setOne(pos, on);
      }));
      return;
    }
    // a double-click on an effect opens 图层样式 on that effect's page through its own menu command
    // (图层 › 图层样式 › 描边… ); without one found, on the dialog's first page
    let page: string | null = null;
    if (action === "effectStyle") { page = JSON.parse(arg ?? "{}").key ?? null; action = "layerStyle"; }
    if (action === "layerStyle") {
      // the 图层样式 dialog, as a double-click in the Layers panel opens it
      // 图层样式 opens as "set the layer's effects" with its dialog shown, starting from the effects
      // it has (or none); Cancel in the dialog changes nothing
      const menuId = page ? (await styleMenu()).get(page) : undefined;
      await whenFree(() => modal("WavePlug " + label, async () => {
        await prepare();
        if (menuId !== undefined) {
          const done = await ps().core.performMenuCommand({ commandID: menuId });
          log("info", "layer style page", page, menuId, JSON.stringify(done));
          if (done !== false && (done as any)?.available !== false) return;
        }
        const [cur] = await play([{ _obj: "get", _target: [{ _property: "layerEffects" }, target] }]);
        const effects = cur?.layerEffects ?? { _obj: "layerEffects", scale: pct(100) };
        const [r] = await play([{ _obj: "set", _target: [{ _ref: "property", _property: "layerEffects" }, target], to: effects, _options: { dialogOptions: "display" } }]);
        // Cancel in the dialog comes back as an error result (-128, "user cancelled")
        if (r?._obj === "error" && r.result !== -128 && !/cancel|取消/i.test(String(r.message ?? ""))) {
          log("warn", "layer style dialog", JSON.stringify(r));
          throw new Error(r.message || "Photoshop 打不开图层样式");
        }
      }, { interactive: true }));
      return;
    }
    if (action === "editFilter") {
      // a double-click on a smart filter: that filter again with its dialog, from its own settings
      // (numbered like the switches, see "toggleFilter"); Cancel changes nothing
      const { pos } = JSON.parse(arg ?? "{}");
      await whenFree(() => modal("WavePlug " + label, async () => {
        await prepare();
        const [d] = await play([{ _obj: "get", _target: [{ _property: "smartObject" }, target] }]);
        const list = d?.smartObject?.filterFX ?? [], f = list[pos];
        if (!f?.filter) throw new Error("读不到这个智能滤镜的设置");
        const i = filtersReversed ? list.length - pos : pos + 1;
        const [r] = await play([{ _obj: "set", _target: [{ _ref: "filterFX", _index: i }, target], filterFX: { _obj: "filterFX", filter: f.filter }, _options: { dialogOptions: "display" } }]);
        log("info", "smart filter edit", pos, i, JSON.stringify(r).slice(0, 200));
        if (r?._obj === "error" && r.result !== -128 && !/cancel|取消/i.test(String(r.message ?? ""))) throw new Error(r.message || "Photoshop 打不开这个滤镜");
      }, { interactive: true }));
      return;
    }
    if (action === "loadSelection") {
      // Ctrl+click on a thumbnail. The layer is named by id (the layer selection stays); when Photoshop
      // refuses that, the layer is selected for a moment and named as the target. Each refusal is logged
      // with what was sent, and what came of it.
      const [d] = await actionDescs(docId, action, ids, arg) as any[];
      const asTarget = JSON.parse(JSON.stringify(d).replace(`{"_ref":"layer","_id":${ids[0]}}`, JSON.stringify(target)));
      const [t] = await play([{ _obj: "get", _target: [{ _property: "targetLayersIDs" }, { _ref: "document", _id: docId }] }]);
      const keep: number[] = (t?.targetLayersIDs ?? []).map((x: any) => Number(x._id));
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        try { await act(d); }
        catch (e) {
          log("warn", "load selection by id", arg, String((e as Error).message ?? e), JSON.stringify(d));
          await selectLayers([ids[0]]);
          try { await act(asTarget); log("info", "load selection as target ok", arg); }
          catch (e2) { log("warn", "load selection as target", String((e2 as Error).message ?? e2), JSON.stringify(asTarget)); throw e2; }
          finally { if (keep.length) await selectLayers(keep).catch(x => log("warn", "reselect", x)); }
        }
      }));
      const [b] = await play([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }] }]);
      log("info", "load selection", ids[0], arg, b?.selection ? JSON.stringify(b.selection).slice(0, 160) : "no selection");
      return;
    }
    if (action === "addVectorMask") {
      // 图层 › 矢量蒙版 › 显示全部. The recorded form failed once ("建立 当前不可用") on a layer we didn't
      // log: other ways of writing the reference are tried, and what the layer was is logged.
      const layer = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };
      const tries = [
        { _obj: "make", new: { _class: "path" }, at: vmaskRef, using: { _enum: "vectorMaskEnabled", _value: "revealAll" } },
        { _obj: "make", new: { _class: "path" }, at: { _ref: [vmaskRef, layer] }, using: { _enum: "vectorMaskEnabled", _value: "revealAll" } },
        { _obj: "make", new: { _class: "path" }, at: { _ref: [vmaskRef] }, using: { _enum: "vectorMaskEnabled", _value: "revealAll" } },
      ];
      const menuId = await vectorMaskMenu();
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        await prepare();
        const errors: string[] = [];
        // the menu item, as a click in Photoshop's Layers panel does it (batchPlay's make kept failing)
        if (menuId !== undefined) {
          const done = await ps().core.performMenuCommand({ commandID: menuId });
          log("info", "vector mask menu", menuId, JSON.stringify(done));
          const [chk] = await play([{ _obj: "get", _target: [{ _property: "hasVectorMask" }, { _ref: "layer", _id: ids[0] }, { _ref: "document", _id: docId }] }]);
          if (chk?.hasVectorMask) return;
          errors.push("menu " + JSON.stringify(done));
        }
        for (const [i, d] of tries.entries()) {
          try { await act(d); if (i) log("info", "vector mask made with form", i); return; } catch (e) { errors.push(String((e as Error).message ?? e)); }
        }
        const [info] = await play([{ _obj: "get", _target: [{ _ref: "layer", _id: ids[0] }, { _ref: "document", _id: docId }] }]);
        log("warn", "vector mask make failed", JSON.stringify(errors), JSON.stringify({ kind: info?.layerKind, background: info?.background, locking: info?.layerLocking, hasVectorMask: info?.hasVectorMask, hasUserMask: info?.hasUserMask, artboard: info?.artboardEnabled }));
        throw new Error("Photoshop 不能给这个图层添加矢量蒙版");
      }));
      return;
    }
    if (action === "viewMask") {
      // Alt+click on a mask: the mask alone (gray); Alt+Shift+click: over the picture in red; again: back
      // to the picture. Not undo steps, so outside history. "…:filter": the 智能滤镜 mask.
      const [how, which] = (arg ?? "").split(":");
      const ref = which === "filter" ? filterMaskRef : maskRef;
      await whenFree(() => modal("WavePlug " + label, async () => {
        await prepare();
        if (how === "alone") await act({ _obj: "select", _target: [ref], makeVisible: true });
        else if (how === "overlay") await act({ _obj: "show", null: [ref] });
        else {
          const composite = await compositeOf(docId);
          if (how === "off-overlay") await act({ _obj: "hide", null: [ref] });
          else await act({ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: composite }] });
          log("info", "mask view off", composite);
        }
      }));
      return;
    }
    if (action === "moveEffect" || action === "moveEffects" || action === "deleteEffect") {
      // dragging in the effects: one effect (or the whole style) onto another layer moves it, Alt+drag
      // copies it, onto the trash deletes it — Photoshop's Layers panel. Done on the layers' layerEffects
      // (core/layers/effects.ts), each set on its layer while that is selected; the selection is put back.
      const { key, multi, toLayer, copy } = JSON.parse(arg ?? "{}");
      const src = ids[0];
      const fxOf = async (id: number) => (await play([{ _obj: "get", _target: [{ _property: "layerEffects" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] }]))[0]?.layerEffects;
      const setFx = async (id: number, fx: Record<string, any> | null) => {
        await selectLayers([id]);
        await act(fx && hasEffects(fx) ? { _obj: "set", _target: [{ _ref: "property", _property: "layerEffects" }, target], to: fx } : { _obj: "disableLayerStyle", _target: [target] });
      };
      const [t] = await play([{ _obj: "get", _target: [{ _property: "targetLayersIDs" }, { _ref: "document", _id: docId }] }]);
      const keep: number[] = (t?.targetLayersIDs ?? []).map((x: any) => Number(x._id));
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        const sfx = await fxOf(src);
        if (!hasEffects(sfx)) throw new Error("这个图层已经没有图层样式了");
        try {
          if (action === "deleteEffect") {
            if (!effectItem(sfx, key, multi)) throw new Error("这个效果已经不在了");
            await setFx(src, removeEffect(sfx, key, multi));
          } else if (action === "moveEffects") {
            // the whole style: in place of the destination's (as 粘贴图层样式 does)
            await setFx(toLayer, sfx);
            if (!copy) await setFx(src, null);
          } else {
            const item = effectItem(sfx, key, multi);
            if (!item) throw new Error("这个效果已经不在了");
            const before = effectsOf(await fxOf(toLayer)).filter(e => e.key === key).length;
            await setFx(toLayer, addEffect(await fxOf(toLayer), key, item));
            const after = effectsOf(await fxOf(toLayer)).filter(e => e.key === key).length;
            if (after < Math.max(1, before)) { log("warn", "effect move", key, multi, before, after); throw new Error("Photoshop 没有加上这个效果"); }
            if (!copy) await setFx(src, removeEffect(sfx, key, multi));
          }
        } finally { if (keep.length) await selectLayers(keep).catch(e => log("warn", "reselect", e)); }
      }));
      log("info", "effect drag", action, JSON.stringify({ src, toLayer, key, multi, copy: !!copy }));
      return;
    }
    if (action === "moveFilters" || action === "deleteFilters") {
      // the 智能滤镜 row: all of a smart object's filters dragged onto another smart object (moved; Alt:
      // copied) or onto the trash (cleared). duplicate / delete of the filterFX class, as scripts do it
      // (Adobe community, r-bin); counts are checked afterwards.
      const { toLayer, copy } = JSON.parse(arg ?? "{}");
      const src = ids[0];
      const count = async (id: number) => ((await play([{ _obj: "get", _target: [{ _property: "smartObject" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] }]))[0]?.smartObject?.filterFX ?? []).length;
      const all = (id: number) => [{ _ref: "filterFX" }, { _ref: "layer", _id: id }];
      const n = await count(src), m = action === "moveFilters" ? await count(toLayer) : 0;
      if (!n) throw new Error("这个智能对象已经没有智能滤镜了");
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        await selectLayers([src]);
        if (action === "moveFilters") {
          await act({ _obj: "duplicate", _target: all(src), to: { _ref: "layer", _id: toLayer } });
          const got = await count(toLayer);
          log("info", "smart filters copied", JSON.stringify({ src, toLayer, n, before: m, after: got }));
          if (got !== m + n && got !== n) throw new Error("Photoshop 没有复制这些智能滤镜");
          if (copy) return;
        }
        await act({ _obj: "delete", _target: all(src) });
        if (await count(src)) throw new Error("Photoshop 没有删除这些智能滤镜");
      }));
      return;
    }
    if (action === "deleteFilter") {
      // one smart filter onto the trash; numbered like the switches (see "toggleFilter"), checked by its id
      const { pos } = JSON.parse(arg ?? "{}");
      const src = ids[0];
      const read = async () => ((await play([{ _obj: "get", _target: [{ _property: "smartObject" }, { _ref: "layer", _id: src }, { _ref: "document", _id: docId }] }]))[0]?.smartObject?.filterFX ?? []).map((f: any) => Number(f?.filterID));
      const a0 = await read(), n = a0.length;
      if (a0[pos] === undefined) throw new Error("这个智能滤镜已经不在了");
      const want = a0.filter((_: number, i: number) => i !== pos).join();
      for (const reversed of [filtersReversed, !filtersReversed]) {
        const i = reversed ? n - pos : pos + 1;
        try {
          await whenFree(() => step("WavePlug " + label, docId, async () => {
            await selectLayers([src]);
            await act({ _obj: "delete", _target: [{ _ref: "filterFX", _index: i }, target] });
            if ((await read()).join() !== want) throw new Error("deleted another one");
          }));
          if (reversed !== filtersReversed) { filtersReversed = reversed; log("info", "smart filter order", reversed ? "reversed" : "as listed"); }
          return;
        } catch (e) { log("info", "smart filter delete", pos, i, String((e as Error)?.message ?? e)); }
      }
      throw new Error("Photoshop 不接受删除这个智能滤镜");
    }
    if (action === "moveFilter") {
      // Photoshop doesn't document how a smart filter is moved: likely numberings are tried one by one,
      // each as its own undo step that is checked (by the filters' ids) and rolled back if it didn't
      // land where wanted; the one that works is remembered.
      // `copy` (Alt+drag): the filter duplicated there instead, the source keeping its own
      const { from, toLayer, toPos, copy } = JSON.parse(arg ?? "{}");
      const src = ids[0], same = toLayer === src;
      const read = async (id: number) => {
        const [r] = await play([{ _obj: "get", _target: [{ _property: "smartObject" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] }]);
        return (r?.smartObject?.filterFX ?? []).map((f: any) => ({ id: Number(f?.filterID), name: String(f?.name ?? "") }));
      };
      const a0 = await read(src), b0 = same ? a0 : await read(toLayer), n = a0.length, len = same && !copy ? n : b0.length + 1;
      if (!a0[from]) throw new Error("这个智能滤镜已经不在了");
      const want = same ? (() => { const x = a0.map((f: any) => f.id); const [m] = x.splice(from, 1); x.splice(toPos, 0, m); return x; })() : null;
      const fromIdx = [filtersReversed ? n - from : from + 1, filtersReversed ? from + 1 : n - from];
      const toIdx = [toPos + 1, toPos, toPos + 2, len - toPos, len - toPos + 1, len - toPos - 1].filter((v, i, all) => v >= 1 && v <= len + 1 && all.indexOf(v) === i);
      const toRef = (i: number): object[] => same ? [{ _ref: "filterFX", _index: i }]
        : [[{ _ref: "filterFX", _index: i }, { _ref: "layer", _id: toLayer }], { _ref: [{ _ref: "filterFX", _index: i }, { _ref: "layer", _id: toLayer }] }];
      const tries: { f: number; t: number; to: object }[] = [];
      for (const f of [...new Set(fromIdx)]) for (const t of toIdx) for (const to of toRef(t)) tries.push({ f, t, to });
      // what worked last time first
      tries.sort((x, y) => +(y.f === filterMove.f && y.t - toPos === filterMove.dt) - +(x.f === filterMove.f && x.t - toPos === filterMove.dt));
      for (const tr of tries) {
        try {
          await whenFree(() => step("WavePlug " + label, docId, async () => {
            await selectLayers([src]);
            await act({ _obj: copy ? "duplicate" : "move", _target: [{ _ref: "filterFX", _index: tr.f }, target], to: tr.to });
            const a1 = await read(src), b1 = same ? a1 : await read(toLayer);
            const ok = copy ? a1.length === (same ? n + 1 : n) && b1.length === b0.length + 1 && b1[toPos]?.name === a0[from].name && a0.every((f: any) => b1.some((g: any) => g.id === f.id) || !same)
              : same ? a1.map((f: any) => f.id).join() === want!.join()
              : a1.length === n - 1 && b1.length === b0.length + 1 && b1[toPos]?.name === a0[from].name;
            if (!ok) throw new Error("landed elsewhere");
          }));
          filterMove = { f: tr.f, dt: tr.t - toPos };
          log("info", "smart filter move", JSON.stringify({ from, toPos, same, copy: !!copy, used: { f: tr.f, t: tr.t, to: tr.to } }));
          return;
        } catch (e) {
          // the step was rolled back; make sure of it before trying the next numbering
          const back = await read(src), backTo = same ? back : await read(toLayer);
          if (back.map((f: any) => f.id).join() !== a0.map((f: any) => f.id).join() || backTo.length !== b0.length) {
            log("warn", "smart filter move not rolled back", JSON.stringify({ tr: { f: tr.f, t: tr.t }, e: String((e as Error)?.message ?? e) }));
            throw new Error("移动智能滤镜没有成功，滤镜顺序可能变了，请用 Ctrl+Z 检查");
          }
        }
      }
      log("warn", "smart filter move failed", JSON.stringify({ from, toPos, same, copy: !!copy, n, tried: tries.length }));
      throw new Error("Photoshop 不接受这个智能滤镜的移动");
    }
    if (action === "toggleEffect") {
      // one effect on / off, checked against the effects read again
      const { key, multi, on } = JSON.parse(arg ?? "{}");
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        await prepare();
        const states = async () => effectsOf((await play([{ _obj: "get", _target: [{ _property: "layerEffects" }, target] }]))[0]?.layerEffects);
        const before = await states();
        const at = before.findIndex(e => e.key === key && e.multi === multi);
        if (at < 0) throw new Error("这个效果已经不在了");
        if (before[at].enabled === on) return;
        // show / hide on one effect is refused ("当前不可用") whichever way it is addressed, so the
        // layer's effects are set again with this one's enabled switched, as the 图层样式 dialog does
        const [cur] = await play([{ _obj: "get", _target: [{ _property: "layerEffects" }, target] }]);
        const fx = cur?.layerEffects;
        const list = fx?.[key + "Multi"];
        const one = Array.isArray(list) ? list[Math.max(0, multi)] : fx?.[key];
        if (!one) throw new Error("这个效果已经不在了");
        one.enabled = on;
        if (Array.isArray(list) && multi <= 0 && fx[key]) fx[key].enabled = on;
        await act({ _obj: "set", _target: [{ _ref: "property", _property: "layerEffects" }, target], to: fx });
        if ((await states())[at]?.enabled === on) return;
        log("warn", "effect switch", key, multi, JSON.stringify(Object.keys(fx)));
        throw new Error("Photoshop 没有切换这个效果");
      }));
      return;
    }
    if (action === "showVariant") {
      // a variant layer (an AI group) shows the variation `arg`, its others hidden, as 切换变体 does
      const vid = Number(arg);
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        const g = findLayer(docById(docId).layers, ids[0]);
        if (!g) throw new Error("这个变体图层已经不在了");
        const kids = (g.layers ?? []).filter((x: any) => /^v\d+/.test(x.name));
        if (!kids.some((x: any) => x.id === vid)) throw new Error("这个变体已经不在了");
        for (const x of kids) x.visible = x.id === vid;
        g.visible = true;
      }));
      return;
    }
    if (action === "deleteVariant") {
      // as 删除变体 on the main panel: the shown one gone, the last left takes its place
      const vid = Number(arg);
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        const g = findLayer(docById(docId).layers, ids[0]);
        const v = g && (g.layers ?? []).find((x: any) => x.id === vid);
        if (!v) throw new Error("这个变体已经不在了");
        const wasShown = v.visible;
        const [response] = await play([{
          _obj: "delete", _target: [{ _ref: "layer", _id: vid }, docRef(docId)],
          _options: { dialogOptions: "silent" },
        }]);
        if (response?._obj === "error") throw new Error(response.message || "Photoshop 拒绝删除此变体");
        if (findLayer(docById(docId).layers, vid)) throw new Error("Photoshop 未删除该变体图层");
        const rest = (g.layers ?? []).filter((x: any) => /^v\d+/.test(x.name));
        if (wasShown && rest.length) rest[rest.length - 1].visible = true;
      }));
      return;
    }
    if (action === "lock" || action === "unlock") {
      // Background layers cannot be changed with applyLocking. Unlock them by converting them
      // to normal layers; apply the ordinary lock command only to the remaining selected layers.
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        const doc = docById(docId);
        const existing = ids.filter(id => !!findLayer(doc.layers, id));
        const backgrounds = existing.filter(id => !!findLayer(doc.layers, id)?.isBackgroundLayer);
        const ordinary = existing.filter(id => !backgrounds.includes(id));
        const replacements = new Map<number, number>();
        if (action === "unlock") for (const id of backgrounds) replacements.set(id, await unlockBackgroundLayer(docId, id));
        if (ordinary.length) {
          await selectLayers(ordinary);
          await act({ _obj: "applyLocking", _target: [target], layerLocking: {
            _obj: "layerLocking", ...(action === "unlock" ? { protectNone: true } : { protectAll: true }),
          } });
        }
        const currentLayers = docById(docId).layers;
        const remaining = existing.map(id => replacements.get(id) ?? id).filter(id => !!findLayer(currentLayers, id));
        if (remaining.length) await selectLayers(remaining).catch(e => log("warn", "reselect", e));
      }));
      return;
    }
    if (action === "setLock") {
      // locks apply to the selected layers only: each layer is selected in turn, then the
      // selection is put back
      const plan: { id: number; locks: Record<string, boolean> }[] = JSON.parse(arg ?? "[]");
      const [t] = await play([{ _obj: "get", _target: [{ _property: "targetLayersIDs" }, { _ref: "document", _id: docId }] }]);
      const keep: number[] = (t?.targetLayersIDs ?? []).map((x: any) => Number(x._id));
      const replacements = new Map<number, number>();
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        for (const { id, locks: k } of plan) {
          const layer = findLayer(docById(docId).layers, id);
          const none = !k.protectAll && !k.protectPosition && !k.protectComposite && !k.protectTransparency;
          if (layer?.isBackgroundLayer) {
            if (none) replacements.set(id, await unlockBackgroundLayer(docId, id));
            continue;
          }
          await selectLayers([id]);
          await act({ _obj: "applyLocking", _target: [target], layerLocking: { _obj: "layerLocking", ...(none ? { protectNone: true } : k) } });
        }
        const currentLayers = docById(docId).layers;
        const restore = keep.map(id => replacements.get(id) ?? id).filter(id => !!findLayer(currentLayers, id));
        if (restore.length) await selectLayers(restore).catch(e => log("warn", "reselect", e));
      }));
      return;
    }
    if (action === "editContents") {
      // WaveLayer's smart-object double click and its ordinary "编辑内容" menu share
      // this command. For a PNG-backed smart object, reuse the existing "转为可编辑"
      // tool to create a PSB FIRST; the tool replaces the layer and its numeric ID.
      // Opening by the old ID can open the wrong content or fail after conversion.
      const id = ids[0];
      if (!Number.isInteger(id)) throw new Error("请选择一个智能对象");
      const [metadata] = await play([{
        _obj: "get",
        _target: [{ _property: "smartObject" }, { _ref: "layer", _id: id }, docRef(docId)],
        _options: { dialogOptions: "silent" },
      }]);
      if (metadata?._obj === "error" || !metadata?.smartObject)
        throw new Error("无法读取智能对象内容格式，已停止打开以避免错误转换");
      const file = String(metadata.smartObject.fileReference ?? "");
      const open = (actualId: number) => whenFree(() => modal("WavePlug " + label, async () => {
        requireActiveDoc(docId);
        if (!findLayer(docById(docId).layers, actualId)) throw new Error("待编辑的智能对象图层已不存在");
        await selectLayers([actualId]);
        await act({ _obj: "placedLayerEditContents" });
      }));
      const result = await openSmartContents(id, file, {
        convertPng: async () => {
          // Double click can happen while a different row is selected in native Photoshop.
          // Restrict the existing batch conversion tool to this exact WaveLayer row.
          await whenFree(() => modal("WavePlug 选中待转换的 PNG 智能对象", async () => {
            requireActiveDoc(docId);
            if (!findLayer(docById(docId).layers, id)) throw new Error("PNG 智能对象图层已不存在");
            await selectLayers([id]);
          }));
          requireActiveDoc(docId);
          return whenFree(() => new UxpTools().makeEditable());
        },
        convertedLayerId: () => {
          requireActiveDoc(docId);
          return docById(docId).activeLayers?.[0]?.id ?? null;
        },
        open,
      });
      log("info", "smart contents opened", JSON.stringify({
        docId, sourceId: id, actualId: result.layerId, sourceFile: file, pngConverted: result.converted,
      }));
      return;
    }
    if (action === "linkToFile") { await linkToFile(docId, ids[0], label); return; }
    // Photoshop's own dialogs (a file picker, 新建图层): shown, and Cancel there changes nothing
    const dialog = DIALOG_COMMANDS[action];
    if (dialog) {
      await whenFree(() => modal("WavePlug " + label, async () => {
        await prepare();
        const [r] = await play([{ ...dialog, _options: { dialogOptions: "display" } }]);
        log("info", "layer dialog command", action, JSON.stringify(r ?? null).slice(0, 300));
        if (r?._obj === "error" && r.result !== -128 && !/cancel|取消/i.test(String(r.message ?? ""))) {
          throw new Error(r.message || `Photoshop 无法执行「${label}」`);
        }
      }, { interactive: true }));
      return;
    }
    // commands that only exist as menu items (图层 › 快速导出为 PNG / 复制 CSS / 复制 SVG): the layers
    // are selected first, then Photoshop runs its own command on the selection
    const menu = MENU_COMMANDS[action];
    if (menu) {
      const menuId = await layerMenuCommand(action, menu);
      if (menuId === undefined) throw new Error(`在 Photoshop 的菜单里没找到「${label}」（见日志 layer menu command）`);
      await whenFree(() => modal(SELECT, async () => { await prepare(); }));
      const done = await ps().core.performMenuCommand({ commandID: menuId });
      log("info", "layer menu command run", action, menuId, JSON.stringify(done ?? null));
      if (done === false || (done as any)?.available === false) throw new Error(`Photoshop 现在不能执行「${label}」`);
      return;
    }
    await whenFree(() => step("WavePlug " + label, docId, async () => {
      await prepare();
      for (const desc of await actionDescs(docId, action, ids, arg)) await act(desc);
      if (opts.above !== undefined) {
        // Photoshop made it inside the selected group: out, just above that group
        const doc = docById(docId), made = doc.activeLayers?.[0], group = findLayer(doc.layers, opts.above);
        if (made && group && made.id !== group.id) await made.move(group, ps().constants.ElementPlacement.PLACEBEFORE);
      }
    }));
    if (action === "setColor" && ids.length) {
      // what Photoshop kept (the frame colour comes from this label)
      const [d] = await play([{ _obj: "get", _target: [{ _property: "color" }, { _ref: "layer", _id: ids[0] }, { _ref: "document", _id: docId }] }]);
      log("info", "layer color", ids[0], arg, JSON.stringify(d?.color ?? null));
    }
    if (action === "targetLayer" || action === "targetMask" || action === "targetVectorMask" || action === "targetFilterMask") {
      // which channel Photoshop really targets now (智能滤镜蒙版 was picked only some of the time)
      const [c] = await play([{ _obj: "get", _target: [{ _ref: "channel", _enum: "ordinal", _value: "targetEnum" }] }]).catch(() => [null]);
      log("info", "target part", action, ids[0], JSON.stringify(c ? { name: c.channelName, index: c.itemIndex, keys: Object.keys(c).slice(0, 12) } : null));
    }
    if (action === "link" && ids.length) {
      // which property tells a layer is linked (shown as 🔗 in the list)
      const [d] = await play([{ _obj: "get", _target: [{ _property: "linkedLayerIDs" }, { _ref: "layer", _id: ids[0] }, { _ref: "document", _id: docId }] }]);
      log("info", "layer link ids", JSON.stringify(d?.linkedLayerIDs ?? null));
    }
  }

  private listeners: [string[], (event: string, desc: any) => void][] = [];

  onEdited(cb: (ids: number[] | "all") => void) {
    const fn = (event: string, desc: any) => {
      const ref = desc?._target?.[0]?._ref;
      // undo / redo / a click in the History panel can change any layer
      if (event === "select") { if (ref === "historyState" || ref === "snapshotClass") cb("all"); return; }
      // anything else that made a history state edited the selected layers
      selectedEdited();
    };
    const selectedEdited = () => { try { cb((ps().app.activeDocument?.activeLayers ?? []).map((l: any) => l.id)); } catch { cb("all"); } };
    // the plugin's own tools (裁剪边缘, 替换内容 …) send no notifications
    onModalDone(name => { if (name !== THUMBS && name !== SELECT) selectedEdited(); });
    const events = ["historyStateChanged", "select"];
    ps().action.addNotificationListener(events, fn);
    this.listeners.push([events, fn]);
  }

  onChange(cb: () => void) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => { if (timer) clearTimeout(timer); timer = setTimeout(cb, 80); };
    onModalDone(name => { if (name !== THUMBS) fire(); });
    const events = ["select", "set", "make", "delete", "open", "close", "move", "show", "hide", "historyStateChanged", "newPlacedLayer", "placedLayerMakeCopy", "placedLayerConvertToLayers", "placedLayerConvertToEmbedded"];
    const fn = () => fire();
    ps().action.addNotificationListener(events, fn);
    this.listeners.push([events, fn]);
  }

  onTarget(cb: (part: TargetPart) => void) {
    const fn = (_event: string, desc: any) => {
      const t = desc?._target?.[0];
      if (t?._ref === "channel") cb(t._value === "mask" ? "mask" : t._value === "filterMask" ? "filterMask" : "layer");
      else if (t?._ref === "path" && t._value === "vectorMask") cb("vmask");
      else if (t?._ref === "layer") cb("layer");
    };
    ps().action.addNotificationListener(["select"], fn);
    this.listeners.push([["select"], fn]);
  }

  dispose() {
    for (const [events, fn] of this.listeners) { try { ps().action.removeNotificationListener(events, fn); } catch { /* host gone */ } }
    this.listeners = [];
  }
}

/** 图层 › 图层样式's commands by effect key. Menu ids differ between Photoshop versions, so they are
 *  found once by their titles: 斜面和浮雕 first (a title no other menu has), the rest beside it. */
let pickerLogged = false;

/** 图层 › 矢量蒙版 › 显示全部: the 显示全部 next to 当前路径 (图层蒙版 has a 显示全部 of its own), found once by titles */
let vectorMenuId: Promise<number | undefined> | null = null;
function vectorMaskMenu(): Promise<number | undefined> {
  return vectorMenuId ??= (async () => {
    const core = ps().core, t0 = Date.now();
    const title = async (id: number) => { try { return plainTitle(String(await core.getMenuCommandTitle({ commandID: id }) ?? "")); } catch { return ""; } };
    const reveal: number[] = [], path: number[] = [];
    for (let start = 1; start < 12000; start += 250) {
      const ts = await Promise.all(Array.from({ length: 250 }, (_, i) => title(start + i)));
      ts.forEach((t, i) => {
        if (t === "显示全部" || t === "RevealAll") reveal.push(start + i);
        if (t === "当前路径" || t === "CurrentPath") path.push(start + i);
      });
    }
    const near = (id: number) => Math.min(...path.map(p => Math.abs(p - id)));
    const best = path.length ? reveal.filter(id => near(id) <= 10).sort((a, b) => near(a) - near(b))[0] : undefined;
    log("info", "vector mask menu ids", Date.now() - t0, "ms", JSON.stringify({ reveal, path, best }));
    return best;
  })();
}
let styleMenuIds: Promise<Map<string, number>> | null = null;
function styleMenu(): Promise<Map<string, number>> {
  return styleMenuIds ??= (async () => {
    const core = ps().core, t0 = Date.now(), out = new Map<string, number>();
    const title = async (id: number) => { try { return plainTitle(String(await core.getMenuCommandTitle({ commandID: id }) ?? "")); } catch { return ""; } };
    const names = new Map<string, string>([...EFFECTS.map(([k, n]) => [n, k] as [string, string]), ...STYLE_TITLES_EN.map(([k, n]) => [plainTitle(n), k] as [string, string])]);
    let bevel = -1;
    for (let start = 1; start < 12000 && bevel < 0; start += 250) {
      const ts = await Promise.all(Array.from({ length: 250 }, (_, i) => title(start + i)));
      const i = ts.findIndex(x => names.get(x) === "bevelEmboss");
      if (i >= 0) bevel = start + i;
    }
    if (bevel > 0) {
      const ts = await Promise.all(Array.from({ length: 121 }, (_, i) => title(bevel - 60 + i)));
      // the nearest of each title to 斜面和浮雕 (描边… is also in 编辑)
      ts.map((x, i) => ({ key: names.get(x), id: bevel - 60 + i })).filter(x => x.key)
        .sort((a, b) => Math.abs(a.id - bevel) - Math.abs(b.id - bevel))
        .forEach(x => { if (!out.has(x.key!)) out.set(x.key!, x.id); });
    }
    log("info", "layer style menu", Date.now() - t0, "ms", JSON.stringify([...out]));
    return out;
  })();
}
const STYLE_TITLES_EN: [string, string][] = [
  ["bevelEmboss", "Bevel & Emboss"], ["frameFX", "Stroke"], ["innerShadow", "Inner Shadow"], ["innerGlow", "Inner Glow"], ["chromeFX", "Satin"],
  ["solidFill", "Color Overlay"], ["gradientFill", "Gradient Overlay"], ["patternFill", "Pattern Overlay"], ["outerGlow", "Outer Glow"], ["dropShadow", "Drop Shadow"],
];
/** a menu title without its mnemonic, dots and spaces: "描边(K)..." → "描边" */
const plainTitle = (t: string) => t.replace(/\(&?\w\)|[&.…\s]/g, "");

const target = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };
const maskRef = { _ref: "channel", _enum: "channel", _value: "mask" };
const vmaskRef = { _ref: "path", _enum: "path", _value: "vectorMask" };
const filterMaskRef = { _ref: "channel", _enum: "channel", _value: "filterMask" };
/** the document's composite channel (selecting it targets the layer's pixels rather than a mask) */
async function compositeOf(docId: number): Promise<string> {
  const [d] = await play([{ _obj: "get", _target: [{ _property: "mode" }, { _ref: "document", _id: docId }] }]);
  const mode = String(d?.mode?._value ?? "");
  return /CMYK/i.test(mode) ? "CMYK" : /lab/i.test(mode) ? "lab" : /gray/i.test(mode) ? "black" : "RGB";
}
const preset = { presetKind: { _enum: "presetKindType", _value: "presetKindDefault" } };
const pct = (v: number) => ({ _unit: "percentUnit", _value: v });

/** History names (after "WavePlug "). */
const ACTION_NAMES: Partial<Record<LayerAction, string>> = {
  layerStyle: "图层样式", duplicate: "复制图层", delete: "删除图层", rename: "重命名图层", newLayer: "新建图层", newGroup: "新建组",
  groupLayers: "从图层新建组", ungroup: "取消图层编组", merge: "合并图层", convertSmart: "转换为智能对象", rasterize: "栅格化图层",
  addMask: "添加图层蒙版", addMaskHide: "添加图层蒙版", deleteMask: "删除图层蒙版", applyMask: "应用图层蒙版", toggleMask: "停用/启用图层蒙版",
  moveMask: "移动/复制图层蒙版", moveVectorMask: "移动/复制矢量蒙版", moveFilterMask: "移动/复制智能滤镜蒙版",
  targetMask: "选择图层蒙版", clip: "创建剪贴蒙版", unclip: "释放剪贴蒙版", copyStyle: "拷贝图层样式", pasteStyle: "粘贴图层样式",
  clearStyle: "清除图层样式", toggleEffects: "显示/隐藏图层样式", link: "链接图层", unlink: "取消链接图层", lock: "锁定图层", unlock: "解除锁定",
  solo: "只显示此图层", editContents: "编辑智能对象内容", toggleFilter: "显示/隐藏智能滤镜", toggleEffect: "显示/隐藏图层效果", moveFilter: "移动智能滤镜", effectStyle: "编辑图层效果", setColor: "图层颜色", loadSelection: "载入选区",
  addVectorMask: "添加矢量蒙版", deleteVectorMask: "删除矢量蒙版", toggleVectorMask: "停用/启用矢量蒙版", targetVectorMask: "选择矢量蒙版",
  toggleMaskLink: "链接/取消链接蒙版", moveEffect: "移动图层效果", moveEffects: "移动图层样式", deleteEffect: "删除图层效果", moveFilters: "移动智能滤镜", deleteFilter: "删除智能滤镜", deleteFilters: "清除智能滤镜",
  targetLayer: "选择图层", targetFilterMask: "选择智能滤镜蒙版", deleteFilterMask: "删除智能滤镜蒙版", viewMask: "查看蒙版", editFilter: "编辑智能滤镜", showVariant: "切换变体", deleteVariant: "删除变体", setProps: "图层属性", setLock: "锁定/解锁图层", adjustment: "新建调整图层",
  mergeDown: "向下合并", mergeVisible: "合并可见图层", flatten: "拼合图像", rasterizeStyle: "栅格化图层样式", smartViaCopy: "通过拷贝新建智能对象",
  embedLinked: "嵌入链接的智能对象", convertToLinked: "转换为链接对象", relink: "重新链接到文件", linkToFile: "链接到已有文件", updateModified: "更新修改的内容", updateAllModified: "更新所有修改的内容", align: "对齐图层", distribute: "分布图层",
  artboardFromLayers: "来自图层的画板", newLayerDialog: "新建图层", quickExport: "快速导出为 PNG", copyCSS: "复制 CSS", copySVG: "复制 SVG",
};

/** 链接到已有文件: an embedded smart object made a linked one, pointing at a file the user picks.
 *  Photoshop's own 重新链接到文件 first; when it refuses an embedded layer, the file is placed as a
 *  linked smart object in the same place (size, name, opacity, blend) right above it, and the old
 *  layer is hidden, not deleted (its masks, effects and filters stay there). One history step. */
async function linkToFile(docId: number, id: number, label: string): Promise<void> {
  const lfs = require("uxp").storage.localFileSystem;
  const file = await lfs.getFileForOpening({ types: ["psd", "psb", "ai", "pdf", "eps", "svg", "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp"] });
  if (!file) return;
  const token = lfs.createSessionToken(file);
  const linkedOf = async (layerId: number) => {
    const [r] = await play([{ _obj: "get", _target: [{ _property: "smartObject" }, { _ref: "layer", _id: layerId }, docRef(docId)] }]).catch(() => [null]);
    return !!r?.smartObject?.linked;
  };
  let route = "relink";
  await whenFree(() => step("WavePlug " + label, docId, async () => {
    requireActiveDoc(docId);
    const doc = docById(docId), old = findLayer(doc.layers, id);
    if (!old) throw new Error("这个智能对象图层已不存在");
    await selectLayers([id]);
    try {
      await act({ _obj: "placedLayerRelinkToFile", null: { _path: token, _kind: "local" } });
      if (await linkedOf(id)) return;
    } catch (e) { log("info", "link to file: relink refused", e); }
    route = "place";
    const { constants } = ps();
    const box = (l: any) => { const b = l.boundsNoEffects ?? l.bounds; return { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) }; };
    const want = box(old);
    await play([{ _obj: "placeEvent", null: { _path: token, _kind: "local" }, linked: true,
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } } }]);
    const made = docById(docId).activeLayers?.[0];
    if (!made || made.id === id) throw new Error("没能置入这个文件");
    let b = box(made);
    const w = want.right - want.left, h = want.bottom - want.top;
    if (w > 0 && h > 0) await made.scale(w / Math.max(0.01, b.right - b.left) * 100, h / Math.max(0.01, b.bottom - b.top) * 100, constants.AnchorPosition.TOPLEFT);
    b = box(made);
    if (Math.abs(want.left - b.left) > 0.01 || Math.abs(want.top - b.top) > 0.01) await made.translate(want.left - b.left, want.top - b.top);
    await made.move(old, constants.ElementPlacement.PLACEBEFORE);
    try { made.name = old.name; } catch { /* keeps the file's name */ }
    try { made.opacity = old.opacity; } catch { /* 100 */ }
    try { made.blendMode = old.blendMode; } catch { /* normal */ }
    try { old.visible = false; } catch { /* stays shown */ }
  }));
  log("info", "link to file", JSON.stringify({ docId, id, route, file: String(file.name ?? "") }));
}

/** Commands run with Photoshop's own dialog shown (dialogOptions "display"). */
const DIALOG_COMMANDS: Partial<Record<LayerAction, object>> = {
  newLayerDialog: { _obj: "make", _target: [{ _ref: "layer" }] },
  // 转换为链接对象 / 重新链接到文件 are MENU_COMMANDS: as a batchPlay inside a modal Photoshop
  // answered "命令当前不可用" (11-14 15:59), its own menu item shows its save / open dialog normally
  artboardFromLayers: { _obj: "make", _target: [{ _ref: "artboardSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" } },
};

const FALLBACK = Symbol("fallback");
function nativeCommandsOn(): boolean {
  try { return localStorage.getItem(NATIVE_COMMANDS_KEY) === "on"; } catch { return false; }
}
/** 原版命令: select the rows in Photoshop, then run Photoshop's own command on them — its menu item
 *  (dialogs, availability, history name all Photoshop's), or for delete the plain action its Delete
 *  key records. No extra checks, no plugin history step. */
async function runNative(docId: number, action: LayerAction, ids: number[], label: string): Promise<void | LayerDeleteResult | typeof FALLBACK> {
  const t0 = Date.now();
  let menuId: number | undefined;
  const spec = NATIVE_MENU[action];
  if (spec) {
    const index = await menuIndex();
    const all = (titles: string[]) => titles.flatMap(t => index.get(plainTitle(t)) ?? []);
    const found = all(spec.titles), anchors = spec.near ? all(spec.near) : [];
    menuId = pickMenuId(found, anchors);
    if (menuId === undefined) {
      log("info", "native command fallback", action, JSON.stringify({ found, anchors }));
      return FALLBACK;
    }
  }
  const before = new Map<number, string>();
  await whenFree(() => modal(SELECT, async () => {
    requireActiveDoc(docId);
    const doc = docById(docId), there = ids.filter(id => findLayer(doc.layers, id));
    if (!there.length) throw new Error("图层已不存在");
    for (const id of there) before.set(id, String(findLayer(doc.layers, id)?.name ?? "#" + id));
    await selectLayers(there);
  }));
  if (menuId !== undefined) {
    const done = await ps().core.performMenuCommand({ commandID: menuId });
    log("info", "native command", action, JSON.stringify({ route: "menu", menuId, done: done ?? null, ms: Date.now() - t0 }));
    if (done === false || (done as any)?.available === false) throw new Error(`Photoshop 现在不能执行「${label}」`);
    return;
  }
  if (NATIVE_ACTIONS.has(action)) {
    // what Photoshop's Delete key records: delete the target (selected) layers, as its own history step
    let refused: string | null = null;
    await whenFree(() => modal("删除图层", async () => {
      requireActiveDoc(docId);
      try {
        const [r] = await play([{ _obj: "delete", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }]);
        if (r?._obj === "error" && r.result !== -128) refused = String(r.message || "Photoshop 拒绝删除");
      } catch (e) { refused = String((e as Error)?.message ?? e); }
    }));
    if (refused) {
      // 11-23: a group alone was refused here every time ("命令"删除"当前不可用") while the plugin's own
      // delete by id was never tried. Note what the targets were, then delete them the plugin's way.
      const doc = docById(docId);
      const info = [...before.keys()].map(id => {
        const l = findLayer(doc.layers, id);
        return { id, kind: l?.kind ?? null, top: !!l && !l.parent, children: l?.layers?.length ?? 0, locked: !!l?.allLocked };
      });
      log("warn", "native delete refused: falling back to delete by id", JSON.stringify({ refused, targets: info, topLevel: doc.layers?.length ?? null }));
      return FALLBACK;
    }
    const doc = docById(docId), surviving = new Set<number>();
    for (const id of before.keys()) if (findLayer(doc.layers, id)) surviving.add(id);
    const { deleted, skipped } = nativeDeleteOutcome([...before.keys()], surviving, before);
    const selected = (doc.activeLayers ?? [])[0]?.id ?? null;
    log("info", "native command", action, JSON.stringify({ route: "action", deleted, skipped: skipped.length, selected, ms: Date.now() - t0 }));
    return { kind: "delete", deleted, skipped, selected };
  }
  return FALLBACK;
}

/** Menu-only commands: the item's titles (Chinese, English), and a title only the 图层 menu has next to
 *  it (文件 › 导出 has a 快速导出为 PNG of its own, which exports the whole document). */
const MENU_COMMANDS: Partial<Record<LayerAction, { titles: string[]; near?: string[] }>> = {
  quickExport: { titles: ["快速导出为PNG", "QuickExportasPNG"], near: ["复制CSS", "CopyCSS"] },
  copyCSS: { titles: ["复制CSS", "CopyCSS"] },
  copySVG: { titles: ["复制SVG", "CopySVG"] },
  convertToLinked: { titles: ["转换为链接对象", "ConverttoLinked"] },
  relink: { titles: ["重新链接到文件", "RelinktoFile"] },
  // 图层 › 智能对象 › 更新修改的内容 / 更新所有修改的内容 (the linked files changed outside)
  updateModified: { titles: ["更新修改的内容", "UpdateModifiedContent"] },
  updateAllModified: { titles: ["更新所有修改的内容", "UpdateAllModifiedContent"] },
};
/** Every menu command's title → ids, read once (menu ids differ between Photoshop versions). */
let menuTitles: Promise<Map<string, number[]>> | null = null;
function menuIndex(): Promise<Map<string, number[]>> {
  return menuTitles ??= (async () => {
    const core = ps().core, t0 = Date.now(), out = new Map<string, number[]>();
    const title = async (id: number) => { try { return plainTitle(String(await core.getMenuCommandTitle({ commandID: id }) ?? "")); } catch { return ""; } };
    for (let start = 1; start < 12000; start += 250) {
      const ts = await Promise.all(Array.from({ length: 250 }, (_, i) => title(start + i)));
      ts.forEach((t, i) => { if (t) { const ids = out.get(t); if (ids) ids.push(start + i); else out.set(t, [start + i]); } });
    }
    log("info", "menu index", Date.now() - t0, "ms", out.size, "titles");
    return out;
  })();
}
/** The menu id of `action`: the only item with one of its titles, or the one nearest to `near`. */
async function layerMenuCommand(action: string, m: { titles: string[]; near?: string[] }): Promise<number | undefined> {
  const index = await menuIndex();
  const all = (titles: string[]) => titles.flatMap(t => index.get(plainTitle(t)) ?? []);
  const found = all(m.titles), anchors = m.near ? all(m.near) : [];
  const dist = (id: number) => Math.min(...anchors.map(a => Math.abs(a - id)));
  const best = found.length <= 1 || !anchors.length ? found[0] : [...found].sort((a, b) => dist(a) - dist(b))[0];
  log("info", "layer menu command", action, JSON.stringify({ found, anchors, best }));
  return best;
}

/** 新建调整图层: the adjustment as Photoshop's own default */
const ADJUSTMENT_TYPES: Record<string, object> = {
  brightness: { _obj: "brightnessEvent", useLegacy: false },
  levels: { _obj: "levels", ...preset },
  curves: { _obj: "curves", ...preset },
  exposure: { _obj: "exposure", ...preset, exposure: 0, offset: 0, gammaCorrection: 1 },
  vibrance: { _obj: "vibrance" },
  hueSaturation: { _obj: "hueSaturation", ...preset, colorize: false },
  colorBalance: { _obj: "colorBalance", shadowLevels: [0, 0, 0], midtoneLevels: [0, 0, 0], highlightLevels: [0, 0, 0], preserveLuminosity: true },
  blackAndWhite: { _obj: "blackAndWhite", ...preset, red: 40, yellow: 60, grain: 40, cyan: 60, blue: 20, magenta: 80, useTint: false },
  photoFilter: { _obj: "photoFilter", color: { _obj: "labColor", luminance: 67.06, a: 32, b: 120 }, density: 25, preserveLuminosity: true },
  channelMixer: { _obj: "channelMixer", ...preset, red: { _obj: "channelMatrix", red: pct(100) }, grain: { _obj: "channelMatrix", grain: pct(100) }, blue: { _obj: "channelMatrix", blue: pct(100) } },
  invert: { _obj: "invert" },
  posterize: { _obj: "posterization", levels: 4 },
  threshold: { _obj: "thresholdClassEvent", level: 128 },
  selectiveColor: { _obj: "selectiveColor", ...preset, method: { _enum: "correctionMethod", _value: "relative" } },
};

/** The batchPlay steps of a layer command, run on the selected layers. */
async function actionDescs(docId: number, action: LayerAction, ids: number[], arg?: string): Promise<object[]> {
  switch (action) {
    case "duplicate": return [{ _obj: "duplicate", _target: [target], version: 5 }];
    case "delete": return [{ _obj: "delete", _target: [target] }];
    case "rename": return [{ _obj: "set", _target: [{ _ref: "layer", _id: ids[0] }], to: { _obj: "layer", name: arg ?? "" } }];
    // 载入选区 (Ctrl+click on a thumbnail): the layer's transparency, its mask or its vector mask's path
    case "loadSelection": {
      const { mode, mask } = JSON.parse(arg ?? "{}");
      const layer = { _ref: "layer", _id: ids[0] };
      const src = { _ref: [mask === "vector" ? vmaskRef : { _ref: "channel", _enum: "channel", _value: mask === "filter" ? "filterMask" : mask ? "mask" : "transparencyEnum" }, layer] };
      const path = mask === "vector" ? { version: 1, vectorMaskParams: true } : {};
      const sel = { _ref: "channel", _property: "selection" };
      if (mode === "add") return [{ _obj: "add", null: src, to: sel, ...path }];
      if (mode === "subtract") return [{ _obj: "subtract", null: src, from: sel, ...path }];
      if (mode === "intersect") return [{ _obj: "intersectWith", null: src, with: sel, ...path }];
      return [{ _obj: "set", _target: [sel], to: src, ...path }];
    }
    // 矢量蒙版 (Photoshop's 图层 › 矢量蒙版 › 显示全部 / 删除 / 停用); a click on its thumbnail selects it
    case "addVectorMask": return [{ _obj: "make", new: { _class: "path" }, at: vmaskRef, using: { _enum: "vectorMaskEnabled", _value: "revealAll" } }];
    case "deleteVectorMask": return [{ _obj: "delete", _target: [vmaskRef] }];
    case "toggleVectorMask": return [{ _obj: "set", _target: [target], to: { _obj: "layer", vectorMaskEnabled: arg === "on" } }];
    case "targetVectorMask": return [{ _obj: "select", _target: [vmaskRef] }];
    // the chain between a layer and its mask: whether the mask moves with the layer
    case "toggleMaskLink": {
      const { vector, on } = JSON.parse(arg ?? "{}");
      return [{ _obj: "set", _target: [target], to: { _obj: "layer", [vector ? "vectorMaskLinked" : "userMaskLinked"]: !!on } }];
    }
    // 图层颜色 (the colour label; the panel draws an artboard's frame in it)
    case "setColor": return [{ _obj: "set", _target: [target], to: { _obj: "layer", color: { _enum: "color", _value: arg || "none" } } }];
    case "newLayer": return [{ _obj: "make", _target: [{ _ref: "layer" }] }];
    case "newGroup": return [{ _obj: "make", _target: [{ _ref: "layerSection" }] }];
    case "groupLayers": return [{ _obj: "make", _target: [{ _ref: "layerSection" }], from: target }];
    case "ungroup": return [{ _obj: "ungroupLayersEvent", _target: [target] }];
    case "merge": case "mergeDown": return [{ _obj: "mergeLayersNew" }];
    case "mergeVisible": return [{ _obj: "mergeVisible" }];
    case "flatten": return [{ _obj: "flattenImage" }];
    case "rasterizeStyle": return [{ _obj: "rasterizeLayer", _target: [target], what: { _enum: "rasterizeItem", _value: "layerStyle" } }];
    case "smartViaCopy": return [{ _obj: "placedLayerMakeCopy" }];
    case "embedLinked": return [{ _obj: "placedLayerConvertToEmbedded" }];
    // 图层 › 对齐 / 分布: Photoshop moves the selected layers itself (locked ones stay)
    case "align": case "distribute": {
      if (![...ALIGNS, ...DISTRIBUTES].some(([k]) => k === arg)) throw new Error(`不认识的对齐方式：${arg}`);
      return [{ _obj: action, _target: [target], using: { _enum: "alignDistributeSelector", _value: arg }, ...(action === "align" ? { alignToCanvas: false } : {}) }];
    }
    case "convertSmart": return [{ _obj: "newPlacedLayer" }];
    case "rasterize": return [{ _obj: "rasterizeLayer", _target: [target] }];
    case "addMask": case "addMaskHide": {
      // like Photoshop's button: with a selection the mask shows (or hides) just the selection
      const [r] = await play([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }] }]);
      const sel = r?.selection?.left !== undefined, hide = action === "addMaskHide";
      return [{ _obj: "make", new: { _class: "channel" }, at: maskRef, using: { _enum: "userMaskEnabled", _value: hide ? (sel ? "hideSelection" : "hideAll") : (sel ? "revealSelection" : "revealAll") } }];
    }
    case "deleteMask": return [{ _obj: "delete", _target: [maskRef] }];
    case "applyMask": return [{ _obj: "delete", _target: [maskRef], apply: true }];
    case "toggleMask": return [{ _obj: "set", _target: [target], to: { _obj: "layer", userMaskEnabled: arg === "on" } }];
    case "targetMask": return [{ _obj: "select", _target: [maskRef], makeVisible: false }];
    // a click on the layer's own thumbnail: back from its mask to its pixels (the document's composite channel)
    case "targetLayer": return [{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: await compositeOf(docId) }], makeVisible: false }];
    case "targetFilterMask": return [{ _obj: "select", _target: [filterMaskRef], makeVisible: false }];
    case "deleteFilterMask": return [{ _obj: "delete", _target: [filterMaskRef] }];
    case "clip": return [{ _obj: "groupEvent", _target: [target] }];
    case "unclip": return [{ _obj: "ungroup", _target: [target] }];
    case "copyStyle": return [{ _obj: "copyEffects" }];
    case "pasteStyle": return [{ _obj: "pasteEffects", allowPasteFXOnLayerSet: true }];
    case "clearStyle": return [{ _obj: "disableLayerStyle", _target: [target] }];
    case "toggleEffects": throw new Error("toggleEffects must use the dedicated FX visibility handler");
    case "link": return [{ _obj: "linkSelectedLayers", _target: [target] }];
    case "unlink": return [{ _obj: "unlinkSelectedLayers", _target: [target] }];
    case "lock": return [{ _obj: "applyLocking", _target: [target], layerLocking: { _obj: "layerLocking", protectAll: true } }];
    case "unlock": return [{ _obj: "applyLocking", _target: [target], layerLocking: { _obj: "layerLocking", protectNone: true } }];
    case "setProps": {
      // 混合模式 / 不透明度 / 填充 of the selected layers
      const p = JSON.parse(arg ?? "{}");
      const to: Record<string, unknown> = { _obj: "layer" };
      if (p.mode) to.mode = { _enum: "blendMode", _value: p.mode };
      if (p.opacity !== undefined) to.opacity = pct(p.opacity);
      if (p.fill !== undefined) to.fillOpacity = pct(p.fill);
      return [{ _obj: "set", _target: [target], to }];
    }
    case "solo": return [{ _obj: "show", null: [{ _ref: "layer", _id: ids[0] }], toggleOptionsPalette: true }];
    case "adjustment": {
      if (arg === "solidColor") {
        const [r] = await play([{ _obj: "get", _target: [{ _property: "foregroundColor" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }] }]);
        return [{ _obj: "make", _target: [{ _ref: "contentLayer" }], using: { _obj: "contentLayer", type: { _obj: "solidColorLayer", color: r?.foregroundColor ?? { _obj: "RGBColor", red: 128, grain: 128, blue: 128 } } } }];
      }
      const type = ADJUSTMENT_TYPES[arg ?? ""];
      if (!type) throw new Error(`不认识的调整图层：${arg}（可选：${ADJUSTMENTS.map(a => a[1]).join("、")}）`);
      return [{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }], using: { _obj: "adjustmentLayer", type } }];
    }
    default: throw new Error(`不支持的图层命令：${action}`);
  }
}
