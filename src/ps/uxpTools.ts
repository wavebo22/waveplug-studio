// 工具 · 智能对象 in Photoshop: Photoshop's own smart-object commands, applied to every selected
// layer in one undo step. Which layers a tool touches is decided in core/layers/smart.ts.

import { log } from "../app/log.ts";
import { type FreeTransform, type Quad, type ToolLayer, type ToolResult, centredQuad, editablePlan, freeName, isAffineQuad, isSmart, sameSourceIds, selectedContents, subQuad, transformBetween, uniquePlan } from "../core/layers/smart.ts";
import type { LayerTools } from "./host.ts";
import { findLayer, grayInto, modal, play, step } from "./uxpHost.ts";
import { cleanMask, cleanRgba, cleanSettings, findIslands } from "../core/layers/islands.ts";
import { decodePng } from "../core/image/decode.ts";
import { lineName, onlyLine, textLines } from "../core/layers/text.ts";
import { type DocScan, type ScanLayer, type SlimKind, planSlim, sizeText } from "../core/layers/slim.ts";
import { BLEND_PREFIX, EXPAND_PREFIX, EXTRACT_PREFIX, FILL_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX } from "./host.ts";
import { encodePng } from "../core/image/png.ts";
import type { Pixels } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const fs = () => require("uxp").storage.localFileSystem;
const DONT = { dialogOptions: "dontDisplay" };
const layerRef = (id: number) => ({ _ref: "layer", _id: id });

/** Runs one action; batchPlay reports most failures as an "error" result instead of throwing. */
export async function act(desc: object): Promise<any> {
  const [r] = await play([{ ...desc, _options: DONT }]);
  if (r?._obj === "error") throw new Error(r.message || `Photoshop 无法执行「${(desc as any)._obj}」`);
  return r;
}

/** Makes exactly `ids` the selected layers. */
export async function selectLayers(ids: number[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await act({ _obj: "select", _target: [layerRef(id)], makeVisible: false, layerID: [id],
      ...(i ? { selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" } } : {}) });
  }
}

function activeDoc(): any {
  const d = ps().app.activeDocument;
  if (!d) throw new Error("请先打开 PSD");
  return d;
}

const message = (e: unknown) => (e as Error)?.message ?? String(e);

/** One layer at a time; a failure is reported for that layer and the others still run. */
async function each(layers: ToolLayer[], skipped: string[], fn: (l: ToolLayer) => Promise<void>): Promise<number> {
  let done = 0;
  for (const l of layers) {
    try { await fn(l); done++; } catch (e) { skipped.push(`${l.name}：${message(e)}`); log("warn", "tool", l.name, e); }
  }
  return done;
}

/** A smart object's corners in the document and its content size. */
async function placement(docId: number, layerId: number): Promise<{ quad: Quad; width: number; height: number; warped: boolean }> {
  const [r] = await play([{ _obj: "get", _target: [{ _property: "smartObjectMore" }, layerRef(layerId), { _ref: "document", _id: docId }] }]);
  const m = r?.smartObjectMore, q = (m?.transform ?? []).map(Number);
  if (q.length !== 8 || q.some((v: number) => !Number.isFinite(v))) throw new Error("读不到智能对象的变换");
  const warp = String(m.warp?.warpStyle?._value ?? m.warp?.warpStyle ?? "warpNone");
  return { quad: q as Quad, width: Number(m.size?.width ?? 0), height: Number(m.size?.height ?? 0), warped: warp !== "warpNone" };
}

const px = (v: number) => ({ _unit: "pixelsUnit", _value: v });
const deg = (v: number) => ({ _unit: "angleUnit", _value: v });
/** batchPlay fields of a free transform about a fixed point. */
function transformDesc(t: FreeTransform): object {
  return {
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSIndependent" },
    position: { _obj: "paint", horizontal: px(t.ref[0]), vertical: px(t.ref[1]) },
    offset: { _obj: "offset", horizontal: px(t.offset[0]), vertical: px(t.offset[1]) },
    width: { _unit: "percentUnit", _value: t.width },
    height: { _unit: "percentUnit", _value: t.height },
    angle: deg(t.angle),
    skew: { _obj: "paint", horizontal: deg(t.skew), vertical: deg(0) },
    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
  };
}

// ── pixel-layer helpers (裁剪边缘 / 像素岛): masks go to Photoshop as selections, so the layer's own
// pixels never round-trip and colours stay exact in any document mode ──

/** Largest layer read for 裁剪边缘 / 像素岛 (pixels): the labels take 4 bytes per pixel. */
const MAX_PIXELS = 40_000_000;

const layerRect = (l: any): Rect => { const b = l.boundsNoEffects ?? l.bounds; return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
const noSelection = { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } };

/** The user's selection, to put back after the tools have used the selection themselves. */
async function saveSelection(docId: number): Promise<() => Promise<void>> {
  const [r] = await play([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }], _options: DONT }]);
  const b = r?.selection;
  if (!b || b.left === undefined) return () => act(noSelection);
  const v = (x: any) => Math.round(typeof x === "number" ? x : x._value);
  const rect = { left: v(b.left), top: v(b.top), right: v(b.right), bottom: v(b.bottom) };
  const saved = await grayInto(await ps().imaging.getSelection({ documentID: docId, sourceBounds: rect }), rect, 0);
  return () => putSelection(docId, saved, rect);
}

/** Replaces the selection with a 1-channel mask (255 = selected) covering `rect`. */
async function putSelection(docId: number, mask: Pixels, rect: Rect): Promise<void> {
  const imaging = ps().imaging;
  const data = await imaging.createImageDataFromBuffer(mask.data, { width: mask.width, height: mask.height, components: 1, colorSpace: "Grayscale", chunky: true });
  try { await imaging.putSelection({ documentID: docId, imageData: data, replace: true, targetBounds: { left: rect.left, top: rect.top } }); }
  finally { data.dispose(); }
}

/** A pixel layer's alpha over its bounds (read as its transparency selection, as Ctrl+clicking the thumbnail). */
async function layerAlpha(docId: number, layer: any): Promise<{ alpha: Uint8Array; rect: Rect }> {
  const rect = layerRect(layer), w = rect.right - rect.left, h = rect.bottom - rect.top;
  if (w <= 0 || h <= 0) return { alpha: new Uint8Array(0), rect };
  if (w * h > MAX_PIXELS) throw new Error(`图层太大（${w}×${h}）`);
  await selectLayers([layer.id]);
  await act({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" } });
  const px = await grayInto(await ps().imaging.getSelection({ documentID: docId, sourceBounds: rect }), rect, 0);
  return { alpha: px.data, rect };
}

/** Clears the pixels of the active layer where `mask` (over `rect`) is 255. */
async function clearMasked(docId: number, mask: Uint8Array, rect: Rect): Promise<void> {
  await putSelection(docId, { width: rect.right - rect.left, height: rect.bottom - rect.top, channels: 1, data: mask }, rect);
  await act({ _obj: "delete" });
}

/** Selected pixel layers; locked ones are reported (other kinds are left alone silently: the card
 *  already says it works on pixel layers, and mixed selections are common). */
function pixelTargets(layers: ToolLayer[], skipped: string[]): ToolLayer[] {
  const out: ToolLayer[] = [];
  for (const l of layers.filter(x => x.selected && x.kind === "pixel")) {
    if (l.locked) skipped.push(`${l.name}：图层已锁定`);
    else out.push(l);
  }
  return out;
}

/**
 * 裁剪边缘 inside a smart object whose content is a PNG: exported (no document opens), cleaned and
 * cropped, put back with 替换内容, and every instance moved so the remaining pixels stay exactly
 * where they were. "mask" when the content isn't a PNG or an instance is in perspective / warped.
 */
async function trimSmartContent(doc: any, l: ToolLayer, instances: ToolLayer[], opts: { alpha: number; minArea: number }): Promise<"done" | "mask"> {
  if (l.linked) return "mask";
  const shown = await Promise.all(instances.map(i => placement(doc.id, i.id)));
  if (shown.some(p => !isAffineQuad(p.quad))) return "mask";
  const storage = require("uxp").storage, folder = await fs().getTemporaryFolder();
  const exported = await folder.createFile(`waveplug_so_${Date.now()}_${freeName(l.file || "content.png", [])}`, { overwrite: true });
  let cleaned: Uint8Array, crop: Rect, size: { w: number; h: number }, cleared: number;
  try {
    await selectLayers([l.id]);
    await act({ _obj: "placedLayerExportContents", null: { _path: fs().createSessionToken(exported), _kind: "local" } });
    const bytes = new Uint8Array(await exported.read({ format: storage.formats.binary }));
    if (!isPng(bytes)) return "mask";
    const content = decodePng(bytes);
    if (content.channels !== 4) throw new Error("内容没有透明区域");
    const r = cleanRgba(content, opts);
    if (!r) throw new Error("边缘已经很干净");
    cleaned = encodePng(r.pixels); crop = r.crop; size = { w: content.width, h: content.height }; cleared = r.cleared;
  } finally { await exported.delete().catch(() => undefined); }
  const want = shown.map(p => subQuad(p.quad, size.w, size.h, crop));
  const file = await folder.createFile(`waveplug_so_${Date.now()}.png`, { overwrite: true });
  try {
    await file.write(cleaned, { format: storage.formats.binary });
    await selectLayers([l.id]);
    await act({ _obj: "placedLayerReplaceContents", null: { _path: fs().createSessionToken(file), _kind: "local" } });
  } finally { await file.delete().catch(() => undefined); }
  // 替换内容 re-fits the smaller content: put each instance's pixels back in place
  for (const [k, inst] of instances.entries()) {
    const t = transformBetween((await placement(doc.id, inst.id)).quad, want[k]);
    if (t) { await selectLayers([inst.id]); await act({ _obj: "transform", _target: [layerRef(inst.id)], ...transformDesc(t) }); }
  }
  log("info", "trim smart content", l.name, JSON.stringify({ ...opts, instances: instances.length, crop, size, cleared }));
  return "done";
}

/** 裁剪边缘 for a smart object that can't be cleaned inside: its layer mask hides the cleared pixels. */
async function trimSmartByMask(doc: any, l: ToolLayer, opts: { alpha: number; minArea: number }): Promise<void> {
  const layer = findLayer(doc.layers, l.id);
  if (!layer) throw new Error("图层已不存在");
  const { alpha, rect } = await layerAlpha(doc.id, layer);
  const w = rect.right - rect.left, h = rect.bottom - rect.top;
  const c = cleanMask(alpha, w, h, opts);
  if (!c) throw new Error("边缘已经很干净");
  const imaging = ps().imaging;
  const [has] = await play([{ _obj: "get", _target: [{ _property: "hasUserMask" }, layerRef(l.id)] }]);
  let mask: Uint8Array;
  if (has?.hasUserMask) {
    // keep what the existing mask hides
    mask = (await grayInto(await imaging.getLayerMask({ documentID: doc.id, layerID: l.id, sourceBounds: rect }), rect, 255)).data;
  } else {
    await selectLayers([l.id]);
    await act({ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealAll" } });
    mask = new Uint8Array(w * h).fill(255);
  }
  for (let i = 0; i < mask.length; i++) if (c.mask[i]) mask[i] = 0;
  const data = await imaging.createImageDataFromBuffer(mask, { width: w, height: h, components: 1, colorSpace: "Grayscale", chunky: true });
  try { await imaging.putLayerMask({ documentID: doc.id, layerID: l.id, imageData: data, targetBounds: { left: rect.left, top: rect.top } }); }
  finally { data.dispose(); }
  log("info", "trim smart mask", l.name, JSON.stringify({ ...opts, cleared: c.cleared }));
}

const AI_PREFIXES = [FILL_PREFIX, EXPAND_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX, BLEND_PREFIX, EXTRACT_PREFIX];
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** 像素岛: selected pixel layers and smart objects (rasterized only once they really split). */
function splitTargets(layers: ToolLayer[], skipped: string[]): ToolLayer[] {
  const out = pixelTargets(layers, skipped);
  for (const l of layers.filter(x => x.selected && isSmart(x))) {
    if (l.locked) skipped.push(`${l.name}：图层已锁定`);
    else out.push(l);
  }
  return out;
}

export class UxpTools implements LayerTools {
  async inspect(): Promise<ToolLayer[] | null> {
    const d = ps().app.activeDocument;
    if (!d) return null;
    const selected = new Set((d.activeLayers ?? []).map((l: any) => l.id));
    const out: ToolLayer[] = [];
    const walk = (ls: any[]) => {
      for (const l of ls) {
        out.push({ id: l.id, name: String(l.name), kind: String(l.kind), selected: selected.has(l.id), locked: !!l.allLocked });
        if (l.layers?.length) walk(l.layers);
      }
    };
    walk(d.layers);
    const smart = out.filter(isSmart);
    if (smart.length) {
      const get = (prop: string, id: number) => ({ _obj: "get", _target: [{ _property: prop }, layerRef(id), { _ref: "document", _id: d.id }] });
      const res = await play(smart.flatMap(l => [get("smartObject", l.id), get("smartObjectMore", l.id)]));
      smart.forEach((l, i) => {
        const so = res[i * 2]?.smartObject, more = res[i * 2 + 1]?.smartObjectMore;
        // smartObjectMore.ID is shared by instances (Ctrl+J copies); smartObject.documentID is not
        l.contentId = more?.ID ? String(more.ID) : null;
        l.linked = !!so?.linked || !!so?.link;
        l.file = so?.fileReference ? String(so.fileReference) : undefined;
      });
    }
    return out;
  }

  private async layers(): Promise<{ doc: any; layers: ToolLayer[] }> {
    const doc = activeDoc();
    return { doc, layers: (await this.inspect()) ?? [] };
  }

  async makeUnique(): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const { copy, skipped } = uniquePlan(layers);
    if (!copy.length) return { done: 0, skipped };
    const keep = layers.filter(l => l.selected).map(l => l.id), replaced = new Map<number, number>();
    const done = await step("WavePlug 断开智能对象链接", doc.id, async () => {
      const n = await each(copy, skipped, async l => {
        const old = findLayer(doc.layers, l.id);
        if (!old) throw new Error("图层已不存在");
        const clipped = !!old.isClippingMask, visible = !!old.visible;
        await selectLayers([l.id]);
        // 「通过拷贝新建智能对象」: the copy (own content, same transform, mask and style) lands just above
        await act({ _obj: "placedLayerMakeCopy" });
        const fresh = doc.activeLayers[0];
        if (!fresh || fresh.id === l.id) throw new Error("没有生成副本");
        await act({ _obj: "delete", _target: [layerRef(l.id)] });
        fresh.name = l.name;
        if (fresh.visible !== visible) fresh.visible = visible;
        try { if (!!fresh.isClippingMask !== clipped) fresh.isClippingMask = clipped; } catch (e) { log("warn", "clipping", e); }
        replaced.set(l.id, fresh.id);
      });
      await selectLayers(keep.map(id => replaced.get(id) ?? id)).catch(e => log("warn", "reselect", e));
      return n;
    });
    log("info", "tool make unique", done, "skipped", skipped.length);
    return { done, skipped };
  }

  async selectSameSource(): Promise<ToolResult> {
    const { layers } = await this.layers();
    const ids = sameSourceIds(layers);
    if (!ids.length) return { done: 0, skipped: layers.some(l => l.selected) ? ["请选中一个嵌入的智能对象"] : [] };
    await modal("WavePlug 选择同源智能对象", () => selectLayers(ids));
    return { done: ids.length, skipped: [] };
  }

  async convert(separately: boolean): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const sel = layers.filter(l => l.selected), skipped: string[] = [];
    if (!sel.length) return { done: 0, skipped };
    if (!separately) {
      await step("WavePlug 转换为智能对象", doc.id, () => act({ _obj: "newPlacedLayer" }));
      return { done: 1, skipped };
    }
    // a selected layer inside a selected group is converted with its group
    const ids = new Set(sel.map(l => l.id));
    const inGroup = (l: ToolLayer) => { for (let p = findLayer(doc.layers, l.id)?.parent; p; p = p.parent) if (ids.has(p.id)) return true; return false; };
    const made: number[] = [];
    const done = await step("WavePlug 分别转换为智能对象", doc.id, async () => {
      const n = await each(sel.filter(l => !inGroup(l)), skipped, async l => {
        await selectLayers([l.id]);
        await act({ _obj: "newPlacedLayer" });
        made.push(doc.activeLayers[0]?.id);
      });
      if (made.length) await selectLayers(made.filter(Boolean)).catch(e => log("warn", "reselect", e));
      return n;
    });
    return { done, skipped };
  }

  /** Runs `desc` on each selected smart object. */
  private async perSmart(name: string, desc: object, linkedToo = true): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const skipped: string[] = [], targets: ToolLayer[] = [];
    for (const l of layers.filter(x => x.selected)) {
      if (!isSmart(l)) skipped.push(`${l.name}：不是智能对象`);
      else if (!linkedToo && l.linked) skipped.push(`${l.name}：链接到外部文件`);
      else targets.push(l);
    }
    if (!targets.length) return { done: 0, skipped };
    const done = await step(name, doc.id, () => each(targets, skipped, async l => { await selectLayers([l.id]); await act(desc); }));
    return { done, skipped };
  }

  /** 解包 leaves the layers untransformed (Photoshop has no "apply transforms" option for scripts),
   *  so the smart object's transform is measured first and put back on the unpacked layers. */
  async unpack(): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const skipped: string[] = [], targets = layers.filter(l => l.selected && isSmart(l));
    for (const l of layers.filter(x => x.selected && !isSmart(x))) skipped.push(`${l.name}：不是智能对象`);
    if (!targets.length) return { done: 0, skipped };
    const made: number[] = [];
    const done = await step("WavePlug 解包智能对象", doc.id, async () => {
      const n = await each(targets, skipped, async l => {
        await selectLayers([l.id]);
        const shown = await placement(doc.id, l.id);
        // where the content sits untransformed: the smart object after 重置变换
        let plain: Quad;
        try { await act({ _obj: "placedLayerResetTransforms" }); plain = (await placement(doc.id, l.id)).quad; }
        catch (e) { log("warn", "unpack reset", e); plain = centredQuad(shown.quad, shown.width, shown.height); }
        await act({ _obj: "placedLayerConvertToLayers" });
        const fresh = doc.activeLayers[0];
        const t = transformBetween(plain, shown.quad);
        log("info", "unpack", l.name, JSON.stringify({ shown: shown.quad, plain, t }));
        if (t && fresh) await act({ _obj: "transform", _target: [layerRef(fresh.id)], ...transformDesc(t) });
        if (!isAffineQuad(shown.quad)) skipped.push(`${l.name}：已解包，透视/变形无法还原，只保留了缩放和旋转`);
        if (fresh) made.push(fresh.id);
      });
      if (made.length) await selectLayers(made).catch(e => log("warn", "reselect", e));
      return n;
    });
    return { done, skipped };
  }

  /**
   * 转为可编辑: linked content is embedded, then the content is unpacked at its own resolution and
   * wrapped into a new smart object (content = PSB) that takes over the old transform — position,
   * scale, rotation and flips, still editable as a transform. A perspective / warp, or content
   * Photoshop can't unpack, is kept by nesting instead: the smart object itself goes inside a new
   * PSB smart object, with everything it had (resolution, warp, smart filters).
   */
  async makeEditable(): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const { targets, skipped } = editablePlan(layers);
    if (!targets.length) return { done: 0, skipped };
    const made: number[] = [];
    let nested = 0;
    const done = await step("WavePlug 转为可编辑智能对象", doc.id, async () => {
      const n = await each(targets, skipped, async l => {
        await selectLayers([l.id]);
        let id = l.id;
        if (l.linked) {
          try { await act({ _obj: "placedLayerConvertToEmbedded" }); id = doc.activeLayers[0]?.id ?? id; }
          catch (e) { log("warn", "embed linked", l.name, e); }
        }
        const shown = await placement(doc.id, id);
        const nest = async () => { await selectLayers([id]); await act({ _obj: "newPlacedLayer" }); nested++; return doc.activeLayers[0]; };
        let fresh: any = null;
        if (shown.warped || !isAffineQuad(shown.quad)) fresh = await nest();
        else {
          let plain: Quad | null = null;
          try {
            await act({ _obj: "placedLayerResetTransforms" });
            plain = (await placement(doc.id, id)).quad;
            await act({ _obj: "placedLayerConvertToLayers" });
            await act({ _obj: "newPlacedLayer" });
            fresh = doc.activeLayers[0];
            const t = transformBetween(plain, shown.quad);
            if (fresh && t) await act({ _obj: "transform", _target: [layerRef(fresh.id)], ...transformDesc(t) });
          } catch (e) {
            // can't be unpacked: put the transform back if it was reset, then nest it as it is
            log("warn", "editable nest", l.name, e);
            const back = plain ? transformBetween(plain, shown.quad) : null;
            if (back) await act({ _obj: "transform", _target: [layerRef(id)], ...transformDesc(back) }).catch(x => log("warn", "restore transform", x));
            fresh = await nest();
          }
        }
        if (!fresh) throw new Error("没有生成新的智能对象");
        fresh.name = l.name;
        made.push(fresh.id);
      });
      if (made.length) await selectLayers(made).catch(e => log("warn", "reselect", e));
      return n;
    });
    log("info", "make editable", done, "nested", nested);
    return { done, skipped, note: nested ? `${nested} 个带透视/变形或内容无法展开，整个套进了新的可编辑智能对象，原样保留` : undefined };
  }

  resetTransform(): Promise<ToolResult> {
    return this.perSmart("WavePlug 重置智能对象变换", { _obj: "placedLayerResetTransforms" });
  }

  async replaceContents(): Promise<ToolResult | null> {
    const { doc, layers } = await this.layers();
    const { layers: targets, skipped } = selectedContents(layers);
    if (!targets.length) return { done: 0, skipped };
    const file = await fs().getFileForOpening({ types: ["psd", "psb", "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp", "svg", "ai", "pdf", "eps"] });
    if (!file) return null;
    const token = fs().createSessionToken(file);
    const keep = layers.filter(l => l.selected).map(l => l.id);
    const done = await step("WavePlug 替换智能对象内容", doc.id, async () => {
      const n = await each(targets, skipped, async l => {
        await selectLayers([l.id]);
        await act({ _obj: "placedLayerReplaceContents", null: { _path: token, _kind: "local" } });
      });
      await selectLayers(keep).catch(e => log("warn", "reselect", e));
      return n;
    });
    return { done, skipped };
  }

  async exportContents(): Promise<ToolResult | null> {
    const { layers } = await this.layers();
    const { layers: targets, skipped } = selectedContents(layers);
    if (!targets.length) return { done: 0, skipped };
    const folder = await fs().getFolder();
    if (!folder) return null;
    const taken = (await folder.getEntries()).map((e: any) => String(e.name));
    const keep = layers.filter(l => l.selected).map(l => l.id);
    // exporting changes nothing in the document: no history step, only the selection is restored
    const done = await modal("WavePlug 导出智能对象内容", async () => {
      const n = await each(targets, skipped, async l => {
        const name = freeName(l.file || l.name + ".psb", taken);
        taken.push(name);
        const out = await folder.createFile(name, { overwrite: false });
        await selectLayers([l.id]);
        await act({ _obj: "placedLayerExportContents", null: { _path: fs().createSessionToken(out), _kind: "local" } });
      });
      await selectLayers(keep).catch(e => log("warn", "reselect", e));
      return n;
    });
    return { done, skipped };
  }

  /** 裁剪边缘. Pixel layers: the pixels are cleared. Smart objects, without opening them: PNG content
   *  is cleaned and cropped, then put back where it was (every instance); other content (PSB, …)
   *  gets the cleared pixels hidden by its layer mask. */
  async trimEdges(strength: number): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const skipped: string[] = [], opts = cleanSettings(strength);
    const pixels = pixelTargets(layers, skipped);
    const smart = layers.filter(l => l.selected && isSmart(l));
    for (const l of smart.filter(x => x.locked)) skipped.push(`${l.name}：图层已锁定`);
    // one cleanup per content: instances share it
    const seen = new Set<string>(), smartTargets = smart.filter(l => !l.locked && (!l.contentId || !seen.has(l.contentId) && !!seen.add(l.contentId)));
    if (!pixels.length && !smartTargets.length) return { done: 0, skipped };
    const keep = layers.filter(l => l.selected).map(l => l.id);
    let masked = 0;
    const done = await step("WavePlug 裁剪边缘", doc.id, async () => {
      const restore = await saveSelection(doc.id);
      let n = 0;
      try {
        n = await each(pixels, skipped, async l => {
          const layer = findLayer(doc.layers, l.id);
          if (!layer) throw new Error("图层已不存在");
          const { alpha, rect } = await layerAlpha(doc.id, layer);
          const c = cleanMask(alpha, rect.right - rect.left, rect.bottom - rect.top, opts);
          if (!c) throw new Error("边缘已经很干净");
          await clearMasked(doc.id, c.mask, rect);
          log("info", "trim edges", l.name, JSON.stringify({ ...opts, faint: c.faint, specks: c.specks, cleared: c.cleared }));
        });
        n += await each(smartTargets, skipped, async l => {
          const instances = l.contentId ? layers.filter(x => x.contentId === l.contentId) : [l];
          const how = await trimSmartContent(doc, l, instances, opts);
          if (how === "mask") { await trimSmartByMask(doc, l, opts); masked++; }
        });
      } finally { await restore().catch(e => log("warn", "restore selection", e)); }
      await selectLayers(keep).catch(e => log("warn", "reselect", e));
      return n;
    });
    return { done, skipped, note: masked ? `${masked} 个智能对象的内容不是 PNG，用图层蒙版隐藏了杂色` : undefined };
  }

  async countIslands(minArea: number, merge: number): Promise<number> {
    const { doc, layers } = await this.layers();
    const targets = splitTargets(layers, []);
    if (!targets.length) return 0;
    const keep = layers.filter(l => l.selected).map(l => l.id);
    // reading uses the selection; no history step, the selection and layers are put back
    return modal("WavePlug 统计像素岛", async () => {
      const restore = await saveSelection(doc.id);
      let total = 0;
      try {
        for (const l of targets) {
          const layer = findLayer(doc.layers, l.id);
          if (!layer) continue;
          const { alpha, rect } = await layerAlpha(doc.id, layer);
          const n = findIslands(alpha, rect.right - rect.left, rect.bottom - rect.top, 0, merge).filter(i => i.area >= minArea).length;
          if (n > 1) total += n;
        }
      } finally { await restore().catch(e => log("warn", "restore selection", e)); await selectLayers(keep).catch(() => undefined); }
      return total;
    });
  }

  async splitIslands(minArea: number, merge: number): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const skipped: string[] = [], targets = splitTargets(layers, skipped);
    if (!targets.length) return { done: 0, skipped };
    const made: number[] = [];
    let rasterized = 0;
    const done = await step("WavePlug 拆分像素岛", doc.id, async () => {
      const restore = await saveSelection(doc.id);
      let n = 0;
      try {
        n = await each(targets, skipped, async l => {
          const layer = findLayer(doc.layers, l.id);
          if (!layer) throw new Error("图层已不存在");
          const { alpha, rect } = await layerAlpha(doc.id, layer);
          const w = rect.right - rect.left, h = rect.bottom - rect.top;
          const islands = findIslands(alpha, w, h, 0, merge).filter(i => i.area >= minArea);
          if (islands.length < 2) throw new Error(islands.length ? "只有一块，不用拆" : "没有足够大的像素块");
          // a smart object becomes pixels first (its layer style, mask and opacity stay on the layer)
          if (isSmart(l)) {
            await selectLayers([l.id]);
            try { await act({ _obj: "rasterizeLayer", _target: [layerRef(l.id)], what: { _enum: "rasterizeItem", _value: "placed" } }); }
            catch (e) { log("warn", "rasterize placed", e); await layer.rasterize(ps().constants.RasterizeType.PLACED); }
            rasterized++;
          }
          // each island: a duplicate of the layer (keeps opacity, blend mode, style, mask) with
          // everything else cleared
          const inAny = new Uint8Array(w * h), parts: any[] = [];
          for (const [k, isl] of islands.entries()) {
            const outside = new Uint8Array(w * h).fill(255), bw = isl.bounds.right - isl.bounds.left;
            for (let i = 0; i < isl.mask.length; i++) {
              if (!isl.mask[i]) continue;
              const j = (isl.bounds.top + Math.floor(i / bw)) * w + isl.bounds.left + i % bw;
              outside[j] = 0; inAny[j] = 255;
            }
            await selectLayers([l.id]);
            await act({ _obj: "duplicate", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], name: `${l.name} ${k + 1}` });
            await clearMasked(doc.id, outside, rect);
            parts.push(doc.activeLayers[0]);
          }
          // what stays on the original: the pieces below the minimum area, if any
          await selectLayers([l.id]);
          let leftover = false;
          for (let i = 0; i < alpha.length; i++) if (alpha[i] && !inAny[i]) { leftover = true; break; }
          if (leftover) { await clearMasked(doc.id, inAny, rect); layer.name = `${l.name} 零碎`; parts.push(layer); }
          else await act({ _obj: "delete", _target: [layerRef(l.id)] });
          await act(noSelection);
          const group = await doc.createLayerGroup({ name: l.name, fromLayers: parts.reverse() });
          made.push(group.id);
          log("info", "split islands", l.name, islands.length, leftover ? "with leftovers" : "");
        });
      } finally { await restore().catch(e => log("warn", "restore selection", e)); }
      if (made.length) await selectLayers(made).catch(e => log("warn", "reselect", e));
      return n;
    });
    return { done, skipped, note: rasterized ? `${rasterized} 个智能对象已栅格化` : undefined };
  }

  /** Each line: a duplicate of the layer (same style, transform and effects) showing only that line,
   *  the other lines emptied so it stays in place; then the empty lines are dropped and the layer
   *  moved back by however far that shifted the glyphs. */
  async splitTextLines(): Promise<ToolResult> {
    const { doc, layers } = await this.layers();
    const skipped: string[] = [], targets: ToolLayer[] = [];
    for (const l of layers.filter(x => x.selected && x.kind === "text")) {
      if (l.locked) skipped.push(`${l.name}：图层已锁定`); else targets.push(l);
    }
    if (!targets.length) return { done: 0, skipped };
    const made: number[] = [];
    let mixed = 0;
    const done = await step("WavePlug 按行拆分文字", doc.id, () => each(targets, skipped, async l => {
      const layer = findLayer(doc.layers, l.id);
      if (!layer) throw new Error("图层已不存在");
      const text = String(layer.textItem.contents ?? "");
      const lines = textLines(text);
      if (lines.length < 2) throw new Error("只有一行");
      const [info] = await play([{ _obj: "get", _target: [{ _property: "textKey" }, layerRef(l.id)] }]);
      if ((info?.textKey?.textStyleRange?.length ?? 1) > 1) mixed++;
      const parts: any[] = [];
      // bottom line first: every duplicate lands just above the original, so the first line ends on top
      for (const line of [...lines].reverse()) {
        const dup = await layer.duplicate();
        dup.textItem.contents = onlyLine(text, line.index);
        const at = layerRect(dup);
        dup.textItem.contents = line.text;
        const now = layerRect(dup);
        if (now.left !== at.left || now.top !== at.top) await dup.translate(at.left - now.left, at.top - now.top);
        dup.name = lineName(line.text);
        parts.push(dup);
      }
      await act({ _obj: "delete", _target: [layerRef(l.id)] });
      const group = await doc.createLayerGroup({ name: l.name, fromLayers: parts.reverse() });
      made.push(group.id);
      log("info", "split text", l.name, lines.length);
    }));
    if (made.length) await modal("WavePlug 选中拆分结果", () => selectLayers(made)).catch(e => log("warn", "reselect", e));
    return { done, skipped, note: mixed ? `${mixed} 个图层原来混用了多种样式，拆分后每行统一成该行开头的样式` : undefined };
  }

  async scanDoc(): Promise<DocScan | null> {
    const d = ps().app.activeDocument;
    if (!d) return null;
    const mode = String(d.mode), bits = Number(String(d.bitsPerChannel).replace(/\D/g, "")) || 8;
    const colour = /CMYK/i.test(mode) ? 4 : /Gray|Bitmap|Duotone|Indexed/i.test(mode) ? 1 : 3;
    const layers: ScanLayer[] = [], smart: { layer: ScanLayer; id: number }[] = [];
    const aiGroup = (g: any) => !!g && String(g.kind) === "group" && AI_PREFIXES.some(p => String(g.name).startsWith(p));
    const walk = (ls: any[]) => {
      for (const l of ls) {
        const b = l.boundsNoEffects ?? l.bounds, kind = String(l.kind);
        const rect = b && b.right > b.left && b.bottom > b.top ? layerRect(l) : null;
        const s: ScanLayer = { id: l.id, name: String(l.name), kind, visible: !!l.visible, bounds: rect };
        if (aiGroup(l.parent) && /^v\d+/.test(String(l.name))) s.variationOf = l.parent.id;
        if (kind === "group") s.children = l.layers?.length ?? 0;
        layers.push(s);
        if (kind === "smartObject") smart.push({ layer: s, id: l.id });
        if (l.layers?.length) walk(l.layers);
      }
    };
    walk(d.layers);
    if (smart.length) {
      const res = await play(smart.map(x => ({ _obj: "get", _target: [layerRef(x.id), { _ref: "document", _id: d.id }] })));
      const contentIds = res.map((r: any) => String(r?.smartObjectMore?.ID ?? ""));
      smart.forEach((x, i) => {
        const r = res[i], so = r?.smartObject, more = r?.smartObjectMore, q = (more?.transform ?? []).map(Number);
        if (!so || !more || q.length !== 8) return;
        x.layer.smart = {
          file: String(so.fileReference ?? ""), linked: !!so.linked || !!so.link, filters: !!so.filterFX,
          shared: !!contentIds[i] && contentIds.filter((c: string) => c === contentIds[i]).length > 1,
          styled: !!r.layerEffects || !!r.hasUserMask, quad: q as Quad,
          width: Number(more.size?.width ?? 0), height: Number(more.size?.height ?? 0),
        };
      });
    }
    const alphaChannels = (d.channels ?? []).filter((c: any) => /maskedArea|selectedArea/i.test(String(c.kind))).map((c: any) => String(c.name));
    let maxCompatibility: boolean | undefined;
    try {
      const [r] = await play([{ _obj: "get", _target: [{ _property: "fileSavePrefs" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }] }]);
      const v = r?.fileSavePrefs?.maximizeCompatibility;
      if (v !== undefined) maxCompatibility = v === true || /always/i.test(String(v?._value ?? v));
    } catch (e) { log("warn", "max compatibility", e); }
    return { width: Math.round(d.width), height: Math.round(d.height), bytesPerPixel: (colour + 1) * bits / 8, bits, layers, alphaChannels, maxCompatibility };
  }

  async slim(kinds: SlimKind[]): Promise<ToolResult> {
    const doc = activeDoc(), scan = await this.scanDoc();
    if (!scan) return { done: 0, skipped: [] };
    const items = planSlim(scan).filter(i => kinds.includes(i.kind));
    const skipped: string[] = [];
    let saved = 0;
    const order: SlimKind[] = ["variations", "hidden", "bigSmart", "empty", "offCanvas", "channels"];
    const done = await step("WavePlug 文档瘦身", doc.id, async () => {
      const restore = await saveSelection(doc.id);
      let n = 0;
      try {
        for (const kind of order) {
          const item = items.find(i => i.kind === kind);
          if (!item) continue;
          try {
            await this.slimItem(doc, kind, item.ids, skipped);
            n++; saved += item.bytes;
          } catch (e) { skipped.push(`${item.label}：${message(e)}`); log("warn", "slim", kind, e); }
        }
      } finally { await restore().catch(e => log("warn", "restore selection", e)); }
      return n;
    });
    log("info", "slim", JSON.stringify(kinds), "saved ≈", saved);
    return { done, skipped, unit: "项", note: (saved ? sizeText(saved) + "，" : "") + "保存后文件才会变小" };
  }

  private async slimItem(doc: any, kind: SlimKind, ids: number[], skipped: string[]): Promise<void> {
    const del = (id: number) => act({ _obj: "delete", _target: [layerRef(id)] });
    if (kind === "variations" || kind === "hidden" || kind === "empty") {
      for (const id of ids) if (findLayer(doc.layers, id)) await del(id).catch(e => skipped.push(`#${id}：${message(e)}`));
    } else if (kind === "bigSmart") {
      // rasterized at the size it's shown, then made a smart object again (content = what's on screen)
      for (const id of ids) {
        const layer = findLayer(doc.layers, id);
        if (!layer) continue;
        try {
          await selectLayers([id]);
          await act({ _obj: "rasterizeLayer", _target: [layerRef(id)], what: { _enum: "rasterizeItem", _value: "placed" } });
          await act({ _obj: "newPlacedLayer" });
        } catch (e) { skipped.push(`${layer.name}：${message(e)}`); }
      }
    } else if (kind === "offCanvas") {
      // 全选 + 图像 → 裁剪: every pixel layer loses what lies outside the canvas
      await act({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "allEnum" } });
      await act({ _obj: "crop", delete: true });
    } else if (kind === "channels") {
      for (const c of [...(doc.channels ?? [])].filter((c: any) => /maskedArea|selectedArea/i.test(String(c.kind)))) await c.remove();
    }
  }

  async purgeMemory(): Promise<void> {
    await modal("WavePlug 释放 PS 内存", async () => {
      // 编辑 → 清理 → 全部; if that one isn't available, the parts it is made of
      try { await act({ _obj: "purge", null: { _enum: "purgeItem", _value: "allEnum" } }); return; }
      catch (e) { log("warn", "purge all", e); }
      let ok = 0;
      for (const item of ["history", "clipboard", "snapshot"]) {
        try { await act({ _obj: "purge", null: { _enum: "purgeItem", _value: item } }); ok++; } catch (e) { log("warn", "purge", item, e); }
      }
      if (!ok) throw new Error("Photoshop 现在不能清理内存，可以手动用「编辑 → 清理 → 全部」");
    });
  }
}
