// WavePlug 图层 panel in Photoshop: the whole layer list (with each layer's status) is read with one
// multiGet, so documents with thousands of layers stay quick; the tree is built in core/layers/tree.ts.

import { log } from "../app/log.ts";
import { type Bounds, frameThumb, thumbArea } from "../core/layers/thumbs.ts";
import type { ToolResult } from "../core/layers/smart.ts";
import { type LayerAction, type MoveStep, type RawLayer, buildTree, nextLayerAfterDelete, planLayerDeletion, effectsOf, EFFECTS, rawProblem } from "../core/layers/tree.ts";
import { addEffect, effectItem, hasEffects, removeEffect } from "../core/layers/effects.ts";
import { type LayerDeleteResult, type LayerTree, type RunOptions, type TargetPart, ADJUSTMENTS } from "./host.ts";
import { docById, findLayer, modal, onModalDone, play, step } from "./uxpHost.ts";
import { act, selectLayers } from "./uxpTools.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const docRef = (id: number) => ({ _ref: "document", _id: id });
/** UI commands must never mutate an earlier PSD after the user switches tabs mid-operation. */
const requireActiveDoc = (docId: number) => {
  if (ps().app.activeDocument?.id !== docId) throw new Error("当前文档已切换，已取消操作以防误删其他 PSD");
};
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

let filterKeysLogged = false, layerFilterKeysLogged = false;
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
  const so = r.smartObject, more = r.smartObjectMore, b = r.boundsNoEffects;
  return {
    id: Number(r.layerID), name: String(r.name ?? ""), kind: Number(r.layerKind ?? 0),
    section: /End/.test(sec) ? "end" : /Start/.test(sec) ? "start" : "content",
    visible: r.visible !== false, locked: isLocked(r.layerLocking), lockAll: !!r.layerLocking?.protectAll, mask: !!r.hasUserMask,
    lockPosition: !!r.layerLocking?.protectPosition, lockPixels: !!r.layerLocking?.protectComposite, lockTransparency: !!r.layerLocking?.protectTransparency,
    ...smartFilters(so),
    effectList: effectsOf(r.layerEffects),
    mode: r.mode?._value ?? (typeof r.mode === "string" ? r.mode : undefined), opacity: percent(r.opacity), fill: percent(r.fillOpacity),
    links: Array.isArray(r.linkedLayerIDs) ? r.linkedLayerIDs.map((x: any) => Number(typeof x === "object" && x ? x._id ?? x.layerID : x)).filter((x: number) => Number.isFinite(x)) : [], background: !!r.background,
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
      out.push({ id: l.id, name: String(l.name), kind: 0, section: group ? "start" : "content", visible: !!l.visible, locked: !!l.allLocked, mask: false });
      if (group) { walk(l.layers ?? []); out.push({ id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false }); }
    }
  };
  walk(d.layers);
  const res = await play(ids.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }, docRef(docId)] })));
  const byId = new Map(res.filter((r: any) => r?.layerID !== undefined).map((r: any) => [Number(r.layerID), rawOf(r)]));
  return out.map(l => { const r = byId.get(l.id); return r && l.section !== "end" ? { ...r, section: l.section } : l; });
}

export class UxpLayerTree implements LayerTree {
  async read() {
    const d = ps().app.activeDocument;
    if (!d) return null;
    const t0 = Date.now();
    const [bg, target] = await play([
      { _obj: "get", _target: [{ _property: "hasBackgroundLayer" }, docRef(d.id)] },
      { _obj: "get", _target: [{ _property: "targetLayersIDs" }, docRef(d.id)] },
    ]);
    const raw = await readRaw(d.id, !!bg?.hasBackgroundLayer);
    const layers = buildTree(raw);
    const withFilters = layers.find(l => l.filters.length);
    if (withFilters && !layerFilterKeysLogged) {
      // where Photoshop keeps "all smart filters shown" (not in smartObject)
      layerFilterKeysLogged = true;
      const [full] = await play([{ _obj: "get", _target: [{ _ref: "layer", _id: withFilters.id }, docRef(d.id)] }]);
      log("info", "smart filter layer keys", JSON.stringify(Object.fromEntries(Object.entries(full ?? {}).filter(([k]) => /filter|fx|mask/i.test(k)).map(([k, v]) => [k, typeof v === "object" ? "{…}" : v]))));
    }
    let selected: number[] = (target?.targetLayersIDs ?? []).map((x: any) => Number(x._id));
    if (!target?.targetLayersIDs) selected = (d.activeLayers ?? []).map((l: any) => l.id);
    const ms = Date.now() - t0;
    if (ms > 300) log("info", "layer tree read", layers.length, "layers", ms, "ms");
    let docKey = "";
    try { docKey = String(d.path || d.title || d.name || ""); } catch { /* unsaved: title only */ }
    return { docId: d.id, docKey: docKey || "doc" + d.id, layers, selected, width: Math.round(d.width), height: Math.round(d.height) };
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
      await modal(SELECT, async () => { requireActiveDoc(_docId); await selectLayers(ids); });
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

  async move(docId: number, steps: MoveStep[]): Promise<ToolResult> {
    const doc = docById(docId), P = ps().constants.ElementPlacement;
    const place = { before: P.PLACEBEFORE, after: P.PLACEAFTER, inside: P.PLACEINSIDE };
    const skipped: string[] = [];
    const done = await step("WavePlug 移动图层", docId, async () => {
      let n = 0;
      for (const s of steps) {
        const l = findLayer(doc.layers, s.id), rel = findLayer(doc.layers, s.rel);
        if (!l || !rel) { skipped.push(`#${s.id}：图层已不存在`); continue; }
        try { await l.move(rel, place[s.place]); n++; }
        catch (e) { skipped.push(`${l.name}：${(e as Error)?.message ?? e}`); log("warn", "layer move", l.name, e); }
      }
      return n;
    });
    return { done, skipped };
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
    if (action === "delete") {
      // Explicit layer IDs (never active pixels/masks). All successful deletions form one undo step.
      return whenFree(() => step("WavePlug " + label, docId, async (): Promise<LayerDeleteResult> => {
        requireActiveDoc(docId);
        const doc = docById(docId);
        const live: { id: number; parentId: number | null; name: string; locked: boolean; background: boolean }[] = [];
        const collect = (ls: any[], parentId: number | null, dest: typeof live) => {
          for (const l of ls) {
            dest.push({ id: l.id, parentId, name: String(l.name ?? ("#" + l.id)),
              locked: !!l.allLocked, background: !!l.isBackgroundLayer });
            if (l.layers?.length) collect(l.layers, l.id, dest);
          }
        };
        collect(doc.layers, null, live);
        const { targets, skipped } = planLayerDeletion(live, ids);
        const names = new Map(live.map(l => [l.id, l.name]));
        const attempted: number[] = [];
        log("info", "layer delete targets", JSON.stringify({ docId, requested: ids, targets, skipped }));
        for (const id of targets) {
          if (!findLayer(doc.layers, id)) {
            skipped.push({ id, name: names.get(id) ?? ("#" + id), reason: "删除前图层已不存在" });
            continue;
          }
          try {
            const [response] = await play([{
              _obj: "delete", _target: [{ _ref: "layer", _id: id }, docRef(docId)],
              _options: { dialogOptions: "silent" },
            }]);
            if (response?._obj === "error") throw new Error(response.message || "Photoshop 拒绝删除此图层");
            attempted.push(id);
          } catch (e) {
            const reason = String((e as Error)?.message ?? e);
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
    // these act on the layer by id, leaving the selection alone
    const prepare = async () => {
      if (!ids.length || action === "solo" || action === "setLock" || action === "loadSelection") return;
      // a layer deleted since the list was read can't be selected: leave it out
      requireActiveDoc(docId);
      const doc = docById(docId), there = ids.filter(id => findLayer(doc.layers, id));
      if (!there.length) throw new Error("图层已不存在");
      await selectLayers(there);
    };
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
    if (action === "setLock") {
      // locks apply to the selected layers only: each layer is selected in turn, then the
      // selection is put back
      const plan: { id: number; locks: Record<string, boolean> }[] = JSON.parse(arg ?? "[]");
      const [t] = await play([{ _obj: "get", _target: [{ _property: "targetLayersIDs" }, { _ref: "document", _id: docId }] }]);
      const keep: number[] = (t?.targetLayersIDs ?? []).map((x: any) => Number(x._id));
      await whenFree(() => step("WavePlug " + label, docId, async () => {
        for (const { id, locks: k } of plan) {
          await selectLayers([id]);
          const none = !k.protectAll && !k.protectPosition && !k.protectComposite && !k.protectTransparency;
          await act({ _obj: "applyLocking", _target: [target], layerLocking: { _obj: "layerLocking", ...(none ? { protectNone: true } : k) } });
        }
        if (keep.length) await selectLayers(keep).catch(e => log("warn", "reselect", e));
      }));
      return;
    }
    if (action === "editContents") {
      // opens the content as its own document, like a double-click on the thumbnail in Photoshop
      await whenFree(() => modal("WavePlug " + label, async () => { await prepare(); await act({ _obj: "placedLayerEditContents" }); }));
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
      const [d] = await play([{ _obj: "get", _target: [{ _ref: "layer", _id: ids[0] }, { _ref: "document", _id: docId }] }]);
      log("info", "layer link keys", JSON.stringify(Object.keys(d ?? {}).filter(k => /link/i.test(k))), JSON.stringify(d?.linkedLayerIDs ?? null));
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
  targetMask: "选择图层蒙版", clip: "创建剪贴蒙版", unclip: "释放剪贴蒙版", copyStyle: "拷贝图层样式", pasteStyle: "粘贴图层样式",
  clearStyle: "清除图层样式", toggleEffects: "显示/隐藏图层样式", link: "链接图层", unlink: "取消链接图层", lock: "锁定图层", unlock: "解除锁定",
  solo: "只显示此图层", editContents: "编辑智能对象内容", toggleFilter: "显示/隐藏智能滤镜", toggleEffect: "显示/隐藏图层效果", moveFilter: "移动智能滤镜", effectStyle: "编辑图层效果", setColor: "图层颜色", loadSelection: "载入选区",
  addVectorMask: "添加矢量蒙版", deleteVectorMask: "删除矢量蒙版", toggleVectorMask: "停用/启用矢量蒙版", targetVectorMask: "选择矢量蒙版",
  toggleMaskLink: "链接/取消链接蒙版", moveEffect: "移动图层效果", moveEffects: "移动图层样式", deleteEffect: "删除图层效果", moveFilters: "移动智能滤镜", deleteFilter: "删除智能滤镜", deleteFilters: "清除智能滤镜",
  targetLayer: "选择图层", targetFilterMask: "选择智能滤镜蒙版", deleteFilterMask: "删除智能滤镜蒙版", viewMask: "查看蒙版", editFilter: "编辑智能滤镜", showVariant: "切换变体", deleteVariant: "删除变体", setProps: "图层属性", setLock: "锁定/解锁图层", adjustment: "新建调整图层",
};

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
    case "merge": return [{ _obj: "mergeLayersNew" }];
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
    case "toggleEffects": return [{ _obj: arg === "on" ? "show" : "hide", null: [{ _ref: "layerEffects" }, target] }];
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
