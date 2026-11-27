// Photoshop UXP implementation, Generative-Fill style: one layer group per fill, masked by the
// selection, one cropped pixel layer per variation inside it.

import { encodePng, type Pixels, withPlacementHints } from "../core/image/png.ts";
import { type Rect, nonZeroBounds, rectH, rectW } from "../core/image/region.ts";
import { placeGray } from "../core/image/compose.ts";
import { crumb, flushLog, log } from "../app/log.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import type { VectorInput } from "../core/overlay/svgFragment.ts";
import { type FileDropItem, type FileDropResult, type FileDropSpot, pageImage, webImageExt, webImageName } from "../core/layers/fileDrop.ts";
import { type ActiveLayer, type Capture, type DocInfo, BLEND_PREFIX, EXPAND_PREFIX, EXTRACT_PREFIX, FILL_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX, type FillGroup, type LayerInfo, type Pads, type PsHost, type Variation, type VariationMask, padsLabel, parsePads } from "./host.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const uxpStorage = () => require("uxp").storage;
// "silent", not "dontDisplay": with dontDisplay Photoshop still puts up its own alert for every
// command it refuses (「WavePlug Studio: 命令“删除”当前不可用」), also for the ones the plugin only
// tries and has a fallback for. The refusal still comes back as an error result; the plugin
// reports what matters in its own status line.
const DONT = { dialogOptions: "silent" };
const SRGB = "sRGB IEC61966-2.1";
const VARIATION = /^v(\d+)(?:\s*·\s*(.*))?$/;

/**
 * batchPlay without Photoshop's error alerts: every command runs "silent" unless it asks for its
 * dialog (`dialogOptions: "display"`). A refused command comes back as `{ _obj: "error" }` as
 * before; refusals of anything but a read are logged, so the log shows what Photoshop turned down
 * even where the caller had a fallback.
 */
export async function play(descriptors: object[]): Promise<any[]> {
  const quiet = descriptors.map(d => {
    const o = (d as any)._options;
    return o?.dialogOptions === "display" ? d : { ...d, _options: { ...o, dialogOptions: "silent" } };
  });
  const done = track("play " + descriptors.map(d => (d as any)?._obj).join(","));
  let out: any[];
  try { out = await ps().action.batchPlay(quiet, {}); } finally { done(); }
  out?.forEach?.((r, i) => {
    const d = descriptors[i] as any;
    if (r?._obj === "error" && d?._obj !== "get" && r.result !== -128) {
      log("warn", "photoshop refused", d?._obj, JSON.stringify({ message: r.message, result: r.result, target: d?._target }).slice(0, 400));
    }
  });
  return out;
}

const modalDone: ((name: string) => void)[] = [];
/** Called after each of this plugin's modal commands ends: Photoshop doesn't notify a plugin of the
 *  changes its own commands make. */
export function onModalDone(cb: (name: string) => void): () => void {
  modalDone.push(cb);
  return () => { const i = modalDone.indexOf(cb); if (i >= 0) modalDone.splice(i, 1); };
}

/** `interactive`: Photoshop dialogs (图层样式) may open while it runs */
export async function modal<T>(name: string, fn: (ctx: any) => Promise<T>, opts: { interactive?: boolean } = {}): Promise<T> {
  // every Photoshop command the plugin runs, for the report (not the constant thumbnail / selection ones)
  if (!/缩略图|选择图层/.test(name)) crumb("PS：" + name.replace(/^WavePlug\s*/, ""));
  // how long it waited for Photoshop and how long it held it: the panels stall while one runs
  probeStalls();
  const t0 = Date.now();
  let started = 0;
  const done = track("modal " + name);
  try { return await ps().core.executeAsModal((ctx: any) => { started = Date.now(); return fn(ctx); }, { commandName: name, ...opts }); }
  finally {
    done();
    const end = Date.now();
    if (end - t0 > 250) log("info", "modal slow", name, JSON.stringify({ waitMs: (started || end) - t0, runMs: started ? end - started : 0 }));
    for (const cb of modalDone) { try { cb(name); } catch (e) { log("warn", "modal done", e); } }
  }
}

// 面板卡顿探针: a timer due every 200 ms that comes late means the plugin's script (all its panels
// share one) didn't get to run for that long; logged with the Photoshop commands then in flight.
// 11-25 it found seconds-long stalls from input handlers flooded by a fast mouse (layerTree.ts).
let stallProbe: ReturnType<typeof setInterval> | null = null, stallLines = 0;
const inflight = new Map<number, { name: string; at: number }>();
let inflightSeq = 0;
function track(name: string): () => void {
  const id = ++inflightSeq;
  inflight.set(id, { name, at: Date.now() });
  return () => { inflight.delete(id); };
}
function probeStalls(): void {
  if (stallProbe) return;
  let last = Date.now();
  const t: any = stallProbe = setInterval(() => {
    const now = Date.now(), late = now - last - 200;
    last = now;
    if (late > 400 && stallLines < 40) {
      stallLines++;
      const busy = [...inflight.values()].map(x => `${x.name.replace(/^WavePlug\s*/, "")}:${now - x.at}ms`);
      log("info", "panel stalled", late, "ms", JSON.stringify({ inflight: busy.slice(0, 6) }));
    }
  }, 200);
  t?.unref?.(); // never keeps a test run alive
}

/** Runs `fn` as one undo step named `name` in document `docId`. */
export async function step<T>(name: string, docId: number, fn: (ctx: any) => Promise<T>): Promise<T> {
  return modal(name, async ctx => {
    const hc = ctx.hostControl;
    const s = await hc.suspendHistory({ documentID: docId, name });
    try { const r = await fn(ctx); await hc.resumeHistory(s, true); return r; }
    catch (e) { await hc.resumeHistory(s, false).catch(() => undefined); throw e; }
  });
}

export function docById(id: number): any {
  const d = ps().app.documents.find((x: any) => x.id === id);
  if (!d) throw new Error("发起任务的 PSD 已关闭");
  return d;
}

function info(d: any): DocInfo {
  return { id: d.id, name: d.title ?? d.name, width: Math.round(d.width), height: Math.round(d.height), mode: String(d.mode), bits: Number(String(d.bitsPerChannel).replace(/\D/g, "")) || 8 };
}

/** when "canvas view display scale unavailable" was last logged */
let viewLogged = false;
/** a Photoshop document window's scrollbar, logical px (Windows) */
const SCROLLBAR_PX = 15;
let viewWarnedAt = 0;
export function findLayer(layers: any[], id: number): any | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.layers?.length) { const f = findLayer(l.layers, id); if (f) return f; }
  }
  return null;
}

const PREFIXES = [FILL_PREFIX, EXPAND_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX, BLEND_PREFIX, EXTRACT_PREFIX];
const isFillGroup = (l: any) => !!l && String(l.kind) === "group" && PREFIXES.some(p => String(l.name).startsWith(p));
const isExpandGroup = (l: any) => String(l?.name ?? "").startsWith(EXPAND_PREFIX);
const isGenerateGroup = (l: any) => String(l?.name ?? "").startsWith(GENERATE_PREFIX);
const isUpscaleGroup = (l: any) => String(l?.name ?? "").startsWith(UPSCALE_PREFIX);
const isBlendGroup = (l: any) => String(l?.name ?? "").startsWith(BLEND_PREFIX);
const isExtractGroup = (l: any) => String(l?.name ?? "").startsWith(EXTRACT_PREFIX);
const groupKind = (l: any) => isExpandGroup(l) ? "outpaint" as const : isGenerateGroup(l) ? "txt2img" as const : isUpscaleGroup(l) ? "upscale" as const : isBlendGroup(l) ? "blend" as const : isExtractGroup(l) ? "extract" as const : "inpaint" as const;
const groupName = (l: any) => String(l.name).slice((PREFIXES.find(p => String(l.name).startsWith(p)) ?? "").length);

/** The outermost AI group containing `l` (itself included), or null. */
function outermostFillGroup(l: any): any | null {
  let top = null;
  for (let p = l; p; p = p.parent) if (isFillGroup(p)) top = p;
  return top;
}

/**
 * A new group is made above the active layer — inside the previous fill when one of its variations
 * is selected — so consecutive runs nested fills in each other. Moves every AI group that sits inside
 * another one out, just above the outermost one. Returns how many were moved.
 */
async function unnestFillGroups(doc: any): Promise<number> {
  const nested: any[] = [];
  const walk = (ls: any[], inside: boolean) => {
    for (const l of ls) {
      if (inside && isFillGroup(l)) nested.push(l);
      if (l.layers?.length) walk(l.layers, inside || isFillGroup(l));
    }
  };
  walk(doc.layers, false);
  for (const g of nested) {
    const host = outermostFillGroup(g.parent);
    if (host) await g.move(host, ps().constants.ElementPlacement.PLACEBEFORE);
  }
  return nested.length;
}

const rectKey = (doc: any, groupId: number) => `${doc.id}:${groupId}:${Math.round(doc.width)}x${Math.round(doc.height)}`;

async function selectLayer(layerId: number) {
  await play([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false, _options: DONT }]);
}

async function readPixels(opts: object): Promise<Pixels> {
  const r = await ps().imaging.getPixels({ componentSize: 8, colorSpace: "RGB", colorProfile: SRGB, ...opts });
  try {
    const d = r.imageData;
    const data = new Uint8Array(await d.getData({ chunky: true }));
    return { width: d.width, height: d.height, channels: d.components, data };
  } finally { r.imageData.dispose(); }
}

function boundsOf(b: any, fallback: Rect): Rect {
  if (!b) return fallback;
  const v = (x: any) => Math.round(typeof x === "number" ? x : x?._value ?? x);
  return { left: v(b.left), top: v(b.top), right: v(b.right), bottom: v(b.bottom) };
}

/** Reads a 1-channel imaging result and places it into `want` (PS trims it to its own bounds). */
export async function grayInto(r: any, want: Rect, fill: number): Promise<Pixels> {
  // no imageData: nothing there (a layer without a mask). Said plainly, not a TypeError from the
  // finally below (11-23 log: 「reading 'dispose'」)
  if (!r?.imageData) throw new Error("Photoshop 没有返回图像数据（图层没有蒙版或区域是空的）");
  try {
    const d = r.imageData;
    const px: Pixels = { width: d.width, height: d.height, channels: 1, data: new Uint8Array(await d.getData({ chunky: true })) };
    const got = boundsOf(r.sourceBounds, { left: want.left, top: want.top, right: want.left + d.width, bottom: want.top + d.height });
    return placeGray(px, got, want, fill);
  } finally { r.imageData.dispose(); }
}

/** A layer's pixels (sRGB, 8 bit) and where they are on the canvas. */
export async function readLayerImage(docId: number, layerId: number): Promise<{ pixels: Pixels; rect: Rect }> {
  const layer = findLayer(docById(docId).layers, layerId);
  if (!layer) throw new Error("图层已不存在");
  return modal("WavePlug 读取图层", async () => {
    const r = await ps().imaging.getPixels({ documentID: docId, layerID: layerId, componentSize: 8, colorSpace: "RGB", colorProfile: SRGB });
    try {
      const d = r.imageData;
      const pixels: Pixels = { width: d.width, height: d.height, channels: d.components, data: new Uint8Array(await d.getData({ chunky: true })) };
      const b = boundsOf(r.sourceBounds, boundsRect(layer));
      return { pixels, rect: { left: b.left, top: b.top, right: b.left + d.width, bottom: b.top + d.height } };
    } finally { r.imageData.dispose(); }
  });
}

/**
 * A group's merged pixels (what it shows: its children, their visibility, masks, blend modes and the
 * group's own opacity / mask) and where they are. Photoshop has no direct read for a group, so inside
 * one modal with history suspended: duplicate the group, make the copy visible, Merge Group, read the
 * merged layer, then resume history *without committing* — the document is exactly as before (no
 * undo step). The layer selection is put back too.
 */
export async function readGroupImage(docId: number, groupId: number, maxEdge = 0): Promise<{ pixels: Pixels; rect: Rect }> {
  return modal("WavePlug 合并读取图层组", async ctx => {
    const doc = docById(docId);
    if (!findLayer(doc.layers, groupId)) throw new Error("图层组已不存在");
    const before = (doc.activeLayers ?? []).map((l: any) => l.id as number);
    const hc = ctx.hostControl;
    const s = await hc.suspendHistory({ documentID: docId, name: "WavePlug 合并读取图层组" });
    try {
      // a refused select would have the next steps copy and merge whatever was selected before
      const [sel] = await play([{ _obj: "select", _target: [{ _ref: "layer", _id: groupId }], makeVisible: false, _options: DONT }]);
      if (sel?._obj === "error") throw new Error(sel.message || "选不中图层组");
      await play([{ _obj: "duplicate", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], version: 5, _options: DONT }]);
      const copy = doc.activeLayers[0];
      if (!copy || copy.id === groupId) throw new Error("复制图层组失败");
      copy.visible = true;
      await play([{ _obj: "mergeLayersNew", _options: DONT }]);
      const merged = doc.activeLayers[0];
      if (!merged || merged.kind === ps().constants.LayerKind.GROUP) throw new Error("合并图层组失败");
      const mb = boundsRect(merged);
      const opts: Record<string, unknown> = { documentID: docId, layerID: merged.id, componentSize: 8, colorSpace: "RGB", colorProfile: SRGB };
      const scaled = maxEdge > 0 && Math.max(rectW(mb), rectH(mb)) > maxEdge;
      if (scaled) opts.targetSize = rectW(mb) >= rectH(mb) ? { width: maxEdge } : { height: maxEdge };
      const r = await ps().imaging.getPixels(opts);
      try {
        const d = r.imageData;
        const pixels: Pixels = { width: d.width, height: d.height, channels: d.components, data: new Uint8Array(await d.getData({ chunky: true })) };
        const b = boundsOf(r.sourceBounds, mb);
        return { pixels, rect: scaled ? b : { left: b.left, top: b.top, right: b.left + d.width, bottom: b.top + d.height } };
      } finally { r.imageData.dispose(); }
    } finally {
      await hc.resumeHistory(s, false);
      try { if (before.length) await play([{ _obj: "select", _target: before.map((id: number) => ({ _ref: "layer", _id: id })), makeVisible: false, _options: DONT }]); }
      catch (e) { log("warn", "group read: selection not restored", e); }
    }
  });
}

function isGroupId(docId: number, layerId: number): boolean {
  const l = findLayer(docById(docId).layers, layerId);
  return !!l && l.kind === ps().constants.LayerKind.GROUP;
}

/** Writes a temporary PNG for placeEvent; `remove()` deletes it once Photoshop has placed it. */
async function tempPng(bytes: Uint8Array): Promise<{ token: string; remove(): Promise<void> }> {
  const fs = uxpStorage().localFileSystem;
  const folder = await fs.getTemporaryFolder();
  const file = await folder.createFile(`waveplug_${Date.now()}.png`, { overwrite: true });
  await file.write(bytes, { format: uxpStorage().formats.binary });
  return {
    token: fs.createSessionToken(file),
    // a full-size result can be tens of MB; without this every variation stayed in the temp folder
    remove: async () => { try { await file.delete(); } catch (e) { log("warn", "temp png not deleted", e); } },
  };
}

function variationLayers(group: any): { layer: any; n: number; prompt: string }[] {
  const out: { layer: any; n: number; prompt: string }[] = [];
  for (const l of group.layers ?? []) {
    const m = VARIATION.exec(String(l.name));
    if (m) out.push({ layer: l, n: Number(m[1]), prompt: m[2] ?? "" });
  }
  return out.sort((a, b) => a.n - b.n);
}

function boundsRect(l: any): Rect {
  const b = l.boundsNoEffects ?? l.bounds;
  return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
}

/** The full frame of a placed smart object in document pixels (its corners), or null. */
async function placedFrame(docId: number, layerId: number): Promise<Rect | null> {
  try {
    const [r] = await play([{ _obj: "get", _target: [{ _property: "smartObjectMore" }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }], _options: DONT }]);
    const q = (r?.smartObjectMore?.transform ?? []).map(Number);
    if (q.length !== 8 || q.some((v: number) => !Number.isFinite(v))) return null;
    return { left: Math.min(q[0], q[6]), top: Math.min(q[1], q[3]), right: Math.max(q[2], q[4]), bottom: Math.max(q[5], q[7]) };
  } catch (e) { log("warn", "placed frame", e); return null; }
}

export class UxpHost implements PsHost {
  readonly kind = "uxp" as const;

  activeDoc(): DocInfo | null {
    const d = ps().app.activeDocument;
    return d ? info(d) : null;
  }

  docExists(id: number) { return ps().app.documents.some((d: any) => d.id === id); }

  async selectionBounds(docId: number): Promise<Rect | null> {
    const [r] = await play([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }], _options: DONT }]);
    const s = r?.selection;
    if (!s || s.left === undefined) return null;
    const v = (x: any) => Math.round(typeof x === "number" ? x : x._value);
    return { left: v(s.left), top: v(s.top), right: v(s.right), bottom: v(s.bottom) };
  }

  async selectRects(docId: number, rects: Rect[]): Promise<void> {
    if (!rects.length) return;
    const px = (v: number) => ({ _unit: "pixelsUnit", _value: Math.round(v) });
    const sel = { _ref: "channel", _property: "selection" };
    await step("WavePlug 拆层选区", docId, async () => {
      const doc = docById(docId);
      if (ps().app.activeDocument?.id !== docId) ps().app.activeDocument = doc;
      const out = await play(rects.map((r, i) => ({
        _obj: i ? "addTo" : "set", _target: [sel],
        to: { _obj: "rectangle", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) },
      })));
      const bad = out.find(r => r?._obj === "error");
      if (bad) throw new Error(bad.message ?? "Photoshop 没有建立选区");
    });
  }

  async docPixels(docId: number, rect: Rect | null, maxPixels: number): Promise<Pixels> {
    const doc = docById(docId);
    const r = rect ?? { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) };
    const w = rectW(r), h = rectH(r);
    const s = Math.min(1, Math.sqrt(maxPixels / Math.max(1, w * h)));
    const target = w >= h ? { width: Math.max(1, Math.floor(w * s)) } : { height: Math.max(1, Math.floor(h * s)) };
    return modal("WavePlug 读取画面", () => readPixels({ documentID: docId, sourceBounds: r, ...(s < 1 ? { targetSize: target } : {}) }));
  }

  async viewBounds(docId: number): Promise<string | null> {
    const [vi] = await play([{ _obj: "get", _target: [{ _property: "viewInfo" }, { _ref: "document", _id: docId }], _options: DONT }]);
    const b = vi?.viewInfo?.activeView?.globalBounds;
    return b ? `${b.left},${b.top},${b.right},${b.bottom}` : null;
  }

  async canvasView(docId: number): Promise<CanvasView | null> {
    const doc = { _ref: "document", _id: docId };
    const get = (p: string) => ({ _obj: "get", _target: [{ _property: p }, doc], _options: DONT });
    const [z, c, vi, res] = await play([get("zoom"), get("center"), get("viewInfo"), get("resolution")]);
    const num = (x: any) => typeof x === "number" ? x : Number(x?._value);
    const b = vi?.viewInfo?.activeView?.globalBounds, zoom = num(z?.zoom), ppi = num(res?.resolution) || 72;
    const h = num(c?.center?.horizontal), v = num(c?.center?.vertical);
    if (!b || ![zoom, h, v, b.left, b.top, b.right, b.bottom].every(Number.isFinite) || zoom <= 0) return null;

    // Windows reports view bounds in physical screen pixels, but Action Manager's center
    // is in logical display units. Convert with the scale factor of the monitor containing
    // the Photoshop view center. Document PPI is not the Windows UI scale factor.
    let centerScale = ppi / 72;
    if (/win/i.test(navigator.platform)) {
      try {
        const displays = await ps().core.getDisplayConfiguration({ physicalResolution: true });
        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
        const display = displays.find((d: any) =>
          cx >= d.globalBounds.left && cx < d.globalBounds.right
          && cy >= d.globalBounds.top && cy < d.globalBounds.bottom);
        const scale = Number(display?.scaleFactor);
        if (!Number.isFinite(scale) || scale <= 0) {
          // the view off every screen (Photoshop minimised …): said once a minute, not on every read
          if (Date.now() - viewWarnedAt > 60_000) { viewWarnedAt = Date.now(); log("warn", "canvas view display scale unavailable", JSON.stringify({ cx, cy, displays: displays.length })); }
          return null;
        }
        centerScale = scale;
        if (!viewLogged) { viewLogged = true; log("info", "canvas view", JSON.stringify({ bounds: b, center: { h, v }, zoom, scale, display: display?.globalBounds, displays: displays.map((x: any) => ({ b: x.globalBounds, s: x.scaleFactor })) })); }
      } catch (e) {
        log("warn", "canvas view display configuration failed", e);
        return null;
      }
    }

    // globalBounds take in the document window's scrollbars (right and bottom, 15 px at 100 %:
    // 11-25, 22 screen px at 150 %), but `center` is the middle of the canvas between them: taken
    // as the middle of the whole area, everything drawn on the canvas sat half a scrollbar right
    // and low. The scrollbar is sized by the monitor's scale, so this holds on every display.
    const bar = /win/i.test(navigator.platform) ? Math.round(SCROLLBAR_PX * centerScale) : 0;
    return {
      view: { left: b.left, top: b.top, right: b.right - bar, bottom: b.bottom - bar },
      center: { x: h * centerScale, y: v * centerScale },
      zoom,
    };
  }

  async selectionMask(docId: number, rect: Rect): Promise<Pixels> {
    return modal("WavePlug 读取选区蒙版", async () =>
      grayInto(await ps().imaging.getSelection({ documentID: docId, sourceBounds: rect }), rect, 0));
  }

  async activeFillGroup(): Promise<FillGroup | null> {
    const d = ps().app.activeDocument;
    const l = outermostFillGroup(d?.activeLayers?.[0]);
    if (!d || !l) return null;
    return this.groupInfo(d, l).catch(e => { log("warn", "active fill group unreadable", l.id, e); return null; });
  }

  /** The fill area = non-zero bounds of a variation's layer mask (variations may extend past it). */
  /** fill rect per document + group + canvas size — reading a mask needs a modal scope, so it is
   *  done once; a canvas resize (扩图) moves the layers, so the size is part of the key */
  private rects = new Map<string, Rect>();

  private async groupInfo(doc: any, group: any): Promise<FillGroup> {
    if (isExpandGroup(group)) {
      // an expansion covers the canvas as it was right after expanding; the pads are in the name.
      // Its variations are opaque and placed over exactly that area, so their bounds give it even
      // after the canvas was expanded again (which moves every layer).
      const pads = parsePads(String(group.name));
      if (!pads) throw new Error("AI 扩图图层组的名称被改动，无法读取扩展尺寸");
      const first = variationLayers(group)[0];
      const rect = first ? boundsRect(first.layer) : { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) };
      return { kind: "outpaint", pads, docId: doc.id, layerId: group.id, name: groupName(group), rect };
    }
    const vs = variationLayers(group);
    if (!vs.length) throw new Error("AI 填充图层组里没有变体");
    const key = rectKey(doc, group.id);
    let rect = this.rects.get(key);
    if (!rect) {
      const lb = boundsRect(vs[0].layer);
      try {
        rect = await modal("WavePlug 读取填充范围", async () => {
          const r = await ps().imaging.getLayerMask({ documentID: doc.id, layerID: vs[0].layer.id, sourceBounds: lb });
          // a variation without a mask fills its whole layer: its bounds are the area (and are kept,
          // not read again on every refresh)
          if (!r?.imageData) return lb;
          const mask = await grayInto(r, lb, 0);
          return nonZeroBounds(mask.data, mask.width, mask.height, lb) ?? lb;
        });
        this.rects.set(key, rect);
      } catch (e) {
        // e.g. Photoshop busy with another modal operation: use the layer bounds for now, retry next time
        log("warn", "fill rect from mask failed, using layer bounds", e);
        rect = lb;
      }
    }
    return { kind: groupKind(group), docId: doc.id, layerId: group.id, name: groupName(group), rect };
  }

  listFillGroups(docId: number): { layerId: number; name: string; kind: FillGroup["kind"] }[] {
    const out: { layerId: number; name: string; kind: FillGroup["kind"] }[] = [];
    const walk = (ls: any[]) => { for (const l of ls) { if (isFillGroup(l)) out.push({ layerId: l.id, name: groupName(l), kind: groupKind(l) }); else if (l.layers?.length) walk(l.layers); } };
    if (this.docExists(docId)) walk(docById(docId).layers);
    return out;
  }

  async fillGroupById(docId: number, layerId: number): Promise<FillGroup | null> {
    if (!this.docExists(docId)) return null;
    const doc = docById(docId);
    const l = findLayer(doc.layers, layerId);
    return isFillGroup(l) ? this.groupInfo(doc, l).catch(e => { log("warn", "fill group unreadable", layerId, e); return null; }) : null;
  }

  async refreshFillGroup(g: FillGroup): Promise<FillGroup> {
    if (!this.docExists(g.docId)) throw new Error("填充所在的 PSD 已关闭");
    const doc = docById(g.docId);
    const group = findLayer(doc.layers, g.layerId);
    if (!isFillGroup(group)) throw new Error("AI 填充图层组已被删除或改名");
    return isExpandGroup(group) ? this.groupInfo(doc, group) : { ...g, name: groupName(group) };
  }

  async groupMask(g: FillGroup): Promise<Pixels> {
    return modal("WavePlug 读取遮罩", async () => {
      const group = findLayer(docById(g.docId).layers, g.layerId);
      const vs = group ? variationLayers(group) : [];
      const src = vs.find(v => v.layer.visible) ?? vs[0];
      if (!src) throw new Error("AI 填充图层组里没有变体，请重新框选");
      const r = await ps().imaging.getLayerMask({ documentID: g.docId, layerID: src.layer.id, sourceBounds: g.rect });
      return grayInto(r, g.rect, 0);
    });
  }

  async capture(docId: number, rect: Rect, selection: "active" | Pixels, hide?: FillGroup): Promise<Capture> {
    // reading happens with the fill group hidden, so variations are always made from the original
    return step("WavePlug 读取画面", docId, async () => {
      const doc = docById(docId);
      const group = hide ? findLayer(doc.layers, hide.layerId) : null;
      const wasVisible = group?.visible;
      if (group) group.visible = false;
      try {
        const image = await readPixels({ documentID: docId, sourceBounds: rect });
        if (image.width !== rectW(rect) || image.height !== rectH(rect)) throw new Error(`读取到的画面 ${image.width}×${image.height} 与范围不一致`);
        let sel: Pixels;
        if (selection === "active") sel = await grayInto(await ps().imaging.getSelection({ documentID: docId, sourceBounds: rect }), rect, 0);
        else sel = selection;
        return { doc: info(doc), rect, image, selection: sel };
      } finally {
        if (group) group.visible = wasVisible;
      }
    });
  }

  listLayers(docId: number): LayerInfo[] {
    const out: LayerInfo[] = [];
    const walk = (ls: any[], depth: number) => { for (const l of ls) { out.push({ id: l.id, name: l.name, depth, kind: String(l.kind) }); if (l.layers?.length) walk(l.layers, depth + 1); } };
    walk(docById(docId).layers, 0);
    return out;
  }

  async layerPixels(docId: number, layerId: number, maxEdge = 0): Promise<Pixels> {
    const layer = findLayer(docById(docId).layers, layerId);
    if (!layer) throw new Error("参考图层已不存在");
    if (layer.kind === ps().constants.LayerKind.GROUP) return (await readGroupImage(docId, layerId, maxEdge)).pixels;
    const b = boundsRect(layer);
    const opts: Record<string, unknown> = { documentID: docId, layerID: layerId };
    if (maxEdge && Math.max(rectW(b), rectH(b)) > maxEdge) opts.targetSize = rectW(b) >= rectH(b) ? { width: maxEdge } : { height: maxEdge };
    return modal("WavePlug 读取参考图层", () => readPixels(opts));
  }

  activeLayers(docId: number): ActiveLayer[] {
    if (!this.docExists(docId)) return [];
    return (docById(docId).activeLayers ?? []).map((l: any) => ({ id: l.id, name: String(l.name), kind: String(l.kind), rect: boundsRect(l) }));
  }

  activeLayer(docId: number): ActiveLayer | null {
    if (!this.docExists(docId)) return null;
    const l = docById(docId).activeLayers?.[0];
    return l ? { id: l.id, name: String(l.name), kind: String(l.kind), rect: boundsRect(l) } : null;
  }

  async layerImage(docId: number, layerId: number): Promise<{ pixels: Pixels; rect: Rect }> {
    // a group (a folder, or an AI layer) is read as one merged image of what it shows
    return isGroupId(docId, layerId) ? readGroupImage(docId, layerId) : readLayerImage(docId, layerId);
  }

  async placeDroppedFiles(files: FileDropItem[], at?: FileDropSpot | null): Promise<FileDropResult> {
    const fs = uxpStorage().localFileSystem;
    const { app } = ps();
    const out: FileDropResult = { linked: 0, embedded: 0, opened: 0, failed: [] };
    // what the drop gave is a UXP entry (dataTransfer.uxpEntries) or only a native path
    const entryOf = async (f: any): Promise<any> => {
      if (f && (f.isFile === true || typeof f.read === "function")) return f;
      const path = String(f?.nativePath ?? f?.path ?? "");
      if (!path) throw new Error("拖入的文件没有路径");
      // which URL form UXP takes for a Windows path is not confirmed: try the plain one, then file:/C:/…
      const urls = ["file:" + path, "file:/" + path.replace(/\\/g, "/"), "file:///" + path.replace(/\\/g, "/")];
      let last: unknown = null;
      for (const url of urls) {
        try { return await fs.getEntryWithUrl(url); } catch (e) { last = e; }
      }
      log("warn", "file drop entry", path, last);
      throw last ?? new Error("找不到拖入的文件");
    };
    const tokenOf = async (f: any): Promise<string> => {
      try { return fs.createSessionToken(await entryOf(f)); }
      catch (e) {
        // an entry the drop made may not take a token: ask for the file again by its path
        const path = String(f?.nativePath ?? "");
        if (!path) throw e;
        return fs.createSessionToken(await fs.getEntryWithUrl("file:" + path));
      }
    };
    const doc = app.activeDocument;
    if (!doc) {
      // nothing open: there is nothing to place into, the files become documents
      for (const f of files) {
        try {
          const entry = await entryOf(f.file);
          await modal("WavePlug 打开拖入的文件", () => app.open(entry), { interactive: true });
          out.opened++;
        } catch (e) { log("warn", "file drop open", f.name, e); out.failed.push(f.name); }
      }
      log("info", "file drop opened", JSON.stringify({ opened: out.opened, failed: out.failed }));
      return out;
    }
    const NONE = "没有文件置入";
    try {
      await step("WavePlug 置入文件", doc.id, async () => {
        for (const f of files) {
          try {
            const token = await tokenOf(f.file);
            const before = doc.activeLayers?.[0]?.id ?? null;
            const [r] = await play([{
              _obj: "placeEvent", null: { _path: token, _kind: "local" },
              ...(f.mode === "linked" ? { linked: true } : {}),
              freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
              offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
              _options: DONT,
            }]);
            const placed = doc.activeLayers?.[0]?.id ?? null;
            if (r?._obj === "error" || placed === null || placed === before) throw new Error(String(r?.message ?? "Photoshop 没有置入这个文件"));
            if (f.mode === "linked") out.linked++; else out.embedded++;
            log("info", "file drop placed", JSON.stringify({ name: f.name, mode: f.mode, layerId: placed }));
            // to the insertion line the drop was let go on, in the same history step
            if (at) {
              const made = findLayer(doc.layers, placed), rel = findLayer(doc.layers, at.rel);
              const where = ps().constants.ElementPlacement;
              if (made && rel && rel.id !== made.id) {
                try { await made.move(rel, at.place === "before" ? where.PLACEBEFORE : at.place === "after" ? where.PLACEAFTER : where.PLACEINSIDE); }
                catch (e) { log("warn", "file drop move to the line", JSON.stringify({ placed, at }), e); }
              } else if (!rel) log("warn", "file drop line layer gone", JSON.stringify(at));
            }
          } catch (e) { log("warn", "file drop place", f.name, f.mode, e); out.failed.push(f.name); }
        }
        // nothing went in: leave no empty history step
        if (!out.linked && !out.embedded) throw new Error(NONE);
      });
    } catch (e) { if ((e as Error)?.message !== NONE) throw e; }
    return out;
  }

  async downloadDropImages(urls: string[]): Promise<{ files: FileDropItem[]; failed: string[] }> {
    const storage = uxpStorage(), folder = await storage.localFileSystem.getTemporaryFolder();
    const files: FileDropItem[] = [], failed: string[] = [];
    let n = 0;
    for (let url of urls) {
      let name = webImageName(url);
      try {
        let bytes: ArrayBuffer, type = "";
        if (/^data:/i.test(url)) {
          const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(url);
          if (!m) throw new Error("data 地址看不懂");
          type = m[1];
          const body = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
          const u8 = new Uint8Array(body.length);
          for (let i = 0; i < body.length; i++) u8[i] = body.charCodeAt(i) & 255;
          bytes = u8.buffer;
        } else {
          let res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          type = res.headers.get("content-type") ?? "";
          if (/html/i.test(type)) {
            // a page (the image sat inside a link): its own picture (og:image), if it names one
            const pic = pageImage(await res.text(), url);
            log("info", "web drop page image", JSON.stringify({ page: url.slice(0, 160), image: pic?.url.slice(0, 160) ?? null }));
            if (!pic) throw new Error("浏览器只给了图片外面的网页链接，网页没提供封面图。改用：图片上右键「复制图片」后在 PS 里 Ctrl+V，或「在新标签页中打开图片」后从那里拖");
            if (pic.title) name = pic.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
            res = await fetch(pic.url);
            if (!res.ok) throw new Error(`封面图 HTTP ${res.status}`);
            type = res.headers.get("content-type") ?? "";
            url = pic.url;
          }
          bytes = await res.arrayBuffer();
        }
        const ext = webImageExt(type, url);
        if (!ext) throw new Error(`不是图片（${type || "未知类型"}）`);
        if (!bytes.byteLength) throw new Error("下载到的是空文件");
        const file = await folder.createFile(`waveplug_web_${Date.now()}_${n++}.${ext}`, { overwrite: true });
        await file.write(bytes, { format: storage.formats.binary });
        files.push({ file, name, mode: "embedded" });
        log("info", "web drop downloaded", JSON.stringify({ url: url.slice(0, 160), type, bytes: bytes.byteLength }));
      } catch (e) {
        log("warn", "web drop download", url.slice(0, 160), e);
        failed.push(`${name}：${(e as Error)?.message ?? e}`);
      }
    }
    return { files, failed };
  }

  async webDropFolder(): Promise<string | null> {
    const folder = await uxpStorage().localFileSystem.getTemporaryFolder();
    return String(folder?.nativePath ?? "") || null;
  }

  async webDropItems(files: { file: string; name: string }[]): Promise<{ items: FileDropItem[]; failed: string[] }> {
    const folder = await uxpStorage().localFileSystem.getTemporaryFolder();
    const items: FileDropItem[] = [], failed: string[] = [];
    for (const f of files) {
      try { items.push({ file: await folder.getEntry(f.file), name: f.name, mode: "embedded" }); }
      catch (e) { log("warn", "web drop entry", f.file, e); failed.push(f.name); }
    }
    return { items, failed };
  }

  async addDroppedText(text: string): Promise<void> {
    const doc = ps().app.activeDocument;
    if (!doc) throw new Error("没有打开的文档");
    const pct = (v: number) => ({ _unit: "percentUnit", _value: v });
    await step("WavePlug 置入网页文字", doc.id, async () => {
      await play([{
        _obj: "make", _target: [{ _ref: "textLayer" }],
        using: {
          _obj: "textLayer", textKey: text,
          textClickPoint: { _obj: "paint", horizontal: pct(50), vertical: pct(50) },
          textStyleRange: [{ _obj: "textStyleRange", from: 0, to: text.length, textStyle: { _obj: "textStyle", size: { _unit: "pointsUnit", _value: 24 } } }],
          paragraphStyleRange: [{ _obj: "paragraphStyleRange", from: 0, to: text.length, paragraphStyle: { _obj: "paragraphStyle", align: { _enum: "alignmentType", _value: "center" } } }],
        },
      }]);
    });
    log("info", "web drop text", JSON.stringify({ chars: text.length }));
  }

  docVersion(docId: number): string | null {
    try {
      const h = docById(docId)?.activeHistoryState;
      return h && h.id != null ? String(h.id) : null;
    } catch { return null; }
  }

  async layerDragInfo(docId: number, layerId: number, kind: string): Promise<{ rect: Rect | null; vector: VectorInput | null; res: number }> {
    const doc = docById(docId);
    const ref = [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }];
    // Only the properties needed, one `get` each. A whole-layer `get` of a smart object took ~20 s
    // (and on a deleted / converted layer it hung Photoshop while a delete waited behind it).
    const props = ["boundsNoEffects", "bounds",
      ...(kind === "text" ? ["textKey", "opacity", "fillOpacity"] : kind === "shape" ? ["adjustment", "AGMStrokeStyleInfo", "opacity", "fillOpacity"] : [])];
    const got = await play(props.map(p => ({ _obj: "get", _target: [{ _property: p }, ...ref], _options: DONT })));
    const layer: any = {};
    for (const r of got) if (r && r._obj !== "error") Object.assign(layer, r);
    // a group is exported merged, with its layers' effects: its bounds with effects
    const b = kind === "group" ? (layer?.bounds ?? layer?.boundsNoEffects) : (layer?.boundsNoEffects ?? layer?.bounds);
    const rect = b ? boundsOf(b, { left: 0, top: 0, right: 0, bottom: 0 }) : null;
    const res = Number(doc?.resolution) || 72;
    if (kind !== "text" && kind !== "shape") return { rect, vector: null, res };
    let path: any;
    if (kind === "shape") {
      [path] = await play([{ _obj: "get", _target: [{ _ref: "path", _enum: "path", _value: "vectorMask" }, ...ref], _options: DONT }]);
    }
    return { rect, res, vector: { kind, layer, path, res, docW: Number(doc?.width) || 0, docH: Number(doc?.height) || 0 } };
  }

  async exportLayerPng(docId: number, layerId: number, sessionId: string, order: number): Promise<{ path: string; rect: Rect; remove(): Promise<void> }> {
    // a group (an AI layer is one too) goes as one merged image of what it shows
    const { pixels, rect } = await this.layerImage(docId, layerId);
    const fs = uxpStorage().localFileSystem;
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`waveplug_drag_${sessionId}_${order}.png`, { overwrite: true });
    await file.write(encodePng(pixels), { format: uxpStorage().formats.binary });
    const path = String(file?.nativePath ?? "");
    const remove = async () => { try { await file.delete(); } catch (e) { log("warn", "drag png not deleted", e); } };
    if (!path) { await remove(); throw new Error("临时文件没有原生路径"); }
    return { path, rect, remove };
  }

  async placeUpscaledLayer(docId: number, layerId: number, png: Uint8Array, rect: Rect, name: string): Promise<number> {
    const target = docById(docId);
    const temp = await tempPng(withPlacementHints(png, Number(target.resolution) || 72));
    try {
      return await step("WavePlug AI 放大图层", docId, async () => {
        const { app, constants } = ps();
        const userDoc = app.activeDocument;
        const doc = docById(docId);
        app.activeDocument = doc;
        const orig = findLayer(doc.layers, layerId);
        if (!orig) throw new Error("要放大的图层已不存在");
        // placing with the original selected puts the smart object directly above it (in its group)
        await selectLayer(layerId);
        await play([{
          _obj: "placeEvent", null: { _path: temp.token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
          _options: DONT,
        }]);
        const layer = doc.activeLayers[0];
        // shown at the original size: the smart object keeps the upscaled pixels inside
        const b = boundsRect(layer);
        if (rectW(b) !== rectW(rect) || rectH(b) !== rectH(rect)) await layer.scale(rectW(rect) / rectW(b) * 100, rectH(rect) / rectH(b) * 100, constants.AnchorPosition.TOPLEFT);
        const nb = boundsRect(layer);
        if (nb.left !== rect.left || nb.top !== rect.top) await layer.translate(rect.left - nb.left, rect.top - nb.top);
        layer.name = name;
        try { layer.opacity = orig.opacity; layer.blendMode = orig.blendMode; } catch (e) { log("warn", "copy layer style", e); }
        orig.visible = false;
        log("info", "upscaled layer placed", layer.id, JSON.stringify(boundsRect(layer)));
        if (userDoc && userDoc.id !== doc.id && this.docExists(userDoc.id)) app.activeDocument = userDoc;
        return layer.id as number;
      });
    } finally { await temp.remove(); }
  }

  async clipboardImage(maxEdge: number): Promise<Pixels | null> {
    // Photoshop's own paste reads every clipboard format it understands (browser images,
    // screenshots, copied layers): paste into a throw-away document and read the layer.
    return modal("WavePlug 读取剪贴板", async () => {
      const { app, constants } = ps();
      const userDoc = app.activeDocument;
      const tmp = await app.documents.add({ width: 64, height: 64, resolution: 72, mode: "RGBColorMode", fill: constants.DocumentFill.TRANSPARENT, name: "WavePlug 剪贴板" });
      try {
        try { await play([{ _obj: "paste", antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" }, as: { _class: "pixel" }, _options: DONT }]); }
        catch (e) { log("info", "clipboard has no image", e); return null; }
        await play([{ _obj: "revealAll", _options: DONT }]);
        const layer = tmp.activeLayers[0];
        if (!layer) return null;
        const b = boundsRect(layer);
        if (rectW(b) <= 1 || rectH(b) <= 1) return null;
        const opts: Record<string, unknown> = { documentID: tmp.id, layerID: layer.id };
        if (Math.max(rectW(b), rectH(b)) > maxEdge) opts.targetSize = rectW(b) >= rectH(b) ? { width: maxEdge } : { height: maxEdge };
        return await readPixels(opts);
      } finally {
        await tmp.closeWithoutSaving();
        if (userDoc && this.docExists(userDoc.id)) app.activeDocument = userDoc;
      }
    });
  }

  /** A small picture of an image file (参考图), so the panel never holds the whole file as a data
   *  URL: Photoshop opens it, reads a copy scaled to `maxEdge` and closes it again. A file that is
   *  already open is read where it is and left open. */
  async imageFileThumbnail(file: any, maxEdge: number): Promise<string> {
    const px = await modal("WavePlug 参考图缩略图", async () => {
      const { app } = ps();
      const userDoc = app.activeDocument;
      const path = String(file?.nativePath ?? "");
      const open = path ? app.documents.find((d: any) => { try { return String(d.path ?? "") === path; } catch { return false; } }) : null;
      const d = open ?? await app.open(file);
      try {
        const w = Math.round(d.width), h = Math.round(d.height);
        return await readPixels({ documentID: d.id, targetSize: w >= h ? { width: Math.min(w, maxEdge) } : { height: Math.min(h, maxEdge) } });
      } finally {
        if (!open) await d.closeWithoutSaving();
        if (userDoc && this.docExists(userDoc.id)) app.activeDocument = userDoc;
      }
    });
    const bytes = encodePng(px);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  }

  async layerThumbnail(docId: number, layerId: number, size: number): Promise<string> {
    const px = await this.layerPixels(docId, layerId, size);
    const bytes = encodePng(px);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  }

  async variations(g: FillGroup): Promise<Variation[]> {
    const group = findLayer(docById(g.docId).layers, g.layerId);
    if (!group) return [];
    return variationLayers(group).map(v => ({ layerId: v.layer.id, number: v.n, label: String(v.n), prompt: v.prompt, visible: !!v.layer.visible }));
  }

  async showVariation(g: FillGroup, layerId: number): Promise<void> {
    await step("WavePlug 切换变体", g.docId, async () => {
      const group = findLayer(docById(g.docId).layers, g.layerId);
      if (!group) throw new Error("AI 填充图层组已不存在");
      for (const v of variationLayers(group)) v.layer.visible = v.layer.id === layerId;
      group.visible = true;
    });
  }

  /** A result group is the AI layer shown by WaveLayer; selecting its child vN hides
   *  the visible selection in WaveLayer because variation rows are collapsed into the group. */
  async selectFillGroup(g: FillGroup): Promise<void> {
    // Do not steal focus from another document the user opened during a long ComfyUI job.
    if (ps().app.activeDocument?.id !== g.docId || !this.docExists(g.docId)) return;
    await modal("WavePlug 选中 AI 图层", async () => {
      if (ps().app.activeDocument?.id !== g.docId) return;
      const doc = docById(g.docId);
      if (!isFillGroup(findLayer(doc.layers, g.layerId))) throw new Error("生成的 AI 图层已不存在");
      const [result] = await play([{
        _obj: "select", _target: [{ _ref: "layer", _id: g.layerId }],
        makeVisible: false, _options: DONT,
      }]);
      if (result?._obj === "error") throw new Error(result.message || "无法选中 AI 图层");
    });
  }

  async setFillVisible(g: FillGroup, visible: boolean): Promise<void> {
    await modal("WavePlug 对比原图", async () => {
      const group = findLayer(docById(g.docId).layers, g.layerId);
      if (group) group.visible = visible;
    });
  }

  async deleteVariation(g: FillGroup, layerId: number): Promise<void> {
    await step("WavePlug 删除变体", g.docId, async () => {
      const doc = docById(g.docId);
      const group = findLayer(doc.layers, g.layerId);
      const layer = group && findLayer(group.layers, layerId);
      if (!layer) return;
      const wasVisible = layer.visible;
      const [result] = await play([{
        _obj: "delete", _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: g.docId }],
        _options: { dialogOptions: "silent" },
      }]);
      if (result?._obj === "error") throw new Error(result?.message || "Photoshop 无法删除变体图层");
      if (findLayer(doc.layers, layerId)) throw new Error("变体删除后仍存在，请重试");
      const rest = variationLayers(group);
      if (wasVisible && rest.length) rest[rest.length - 1].layer.visible = true;
    });
  }

  async createFillGroup(docId: number, rect: Rect, prompt: string, pads?: Pads, kind?: FillGroup["kind"]): Promise<FillGroup> {
    const gen = kind === "txt2img", up = kind === "upscale", blend = kind === "blend", ex = kind === "extract";
    return step(pads ? "WavePlug 新建 AI 扩图" : gen ? "WavePlug 新建 AI 生成" : up ? "WavePlug 新建 AI 放大" : blend ? "WavePlug 新建 AI 融图" : ex ? "WavePlug 新建 AI 抠图" : "WavePlug 新建 AI 填充", docId, async () => {
      const doc = docById(docId);
      ps().app.activeDocument = doc;
      const name = pads ? EXPAND_PREFIX + padsLabel(pads) : up ? UPSCALE_PREFIX + prompt
        : blend ? BLEND_PREFIX + (prompt.trim().slice(0, 24) || "默认光影")
        : ex ? EXTRACT_PREFIX + (prompt.trim().slice(0, 24) || "主体")
        : (gen ? GENERATE_PREFIX : FILL_PREFIX) + (prompt.trim().slice(0, 24) || (gen ? "无提示词" : "移除"));
      const group = await doc.createLayerGroup({ name });
      const moved = await unnestFillGroups(doc);
      if (moved) log("info", "fill groups un-nested", moved);
      if (pads) { await group.move(doc.layers[0], ps().constants.ElementPlacement.PLACEBEFORE); return { kind: "outpaint" as const, pads, docId, layerId: group.id, name: groupName(group), rect }; }
      this.rects.set(rectKey(doc, group.id), rect);
      return { kind: kind ?? "inpaint", docId, layerId: group.id, name: groupName(group), rect };
    });
  }

  async createDocument(width: number, height: number, name: string): Promise<DocInfo> {
    return modal("WavePlug 新建文档", async () => {
      const { app, constants } = ps();
      const doc = await app.documents.add({ width, height, resolution: 72, mode: "RGBColorMode", fill: constants.DocumentFill.WHITE, name });
      log("info", "document created", doc.id, width, height);
      return info(doc);
    });
  }

  async placeBelow(docId: number, layerId: number, belowId: number): Promise<void> {
    await step("WavePlug 移到抠图下方", docId, async () => {
      const doc = docById(docId), layer = findLayer(doc.layers, layerId), ref = findLayer(doc.layers, belowId);
      if (!layer || !ref) return;
      await layer.move(ref, ps().constants.ElementPlacement.PLACEAFTER);
    });
  }

  async expandCanvas(docId: number, pads: Pads): Promise<DocInfo> {
    return step("WavePlug 扩展画布", docId, async () => {
      const { app, constants } = ps();
      const doc = docById(docId);
      app.activeDocument = doc;
      const w = Math.round(doc.width), h = Math.round(doc.height);
      // two resizes: grow right/bottom anchored top-left, then left/top anchored bottom-right
      if (pads.right || pads.bottom) await doc.resizeCanvas(w + pads.right, h + pads.bottom, constants.AnchorPosition.TOPLEFT);
      if (pads.left || pads.top) await doc.resizeCanvas(w + pads.right + pads.left, h + pads.bottom + pads.top, constants.AnchorPosition.BOTTOMRIGHT);
      log("info", "canvas expanded", w, h, "->", Math.round(doc.width), Math.round(doc.height));
      return info(doc);
    });
  }

  async docThumbnail(docId: number, maxEdge: number): Promise<string> {
    const doc = docById(docId);
    const w = Math.round(doc.width), h = Math.round(doc.height);
    const px = await modal("WavePlug 画布缩略图", () => readPixels({ documentID: docId, targetSize: w >= h ? { width: Math.min(w, maxEdge) } : { height: Math.min(h, maxEdge) } }));
    const bytes = encodePng(px);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  }

  async addVariation(g: FillGroup, png: Uint8Array, placement: Rect, prompt: string, mask: VariationMask): Promise<Variation> {
    const target = docById(g.docId);
    const dpi = Number(target.resolution) || 72;
    log("info", "document", JSON.stringify({ mode: String(target.mode), profile: target.colorProfileName ?? null, dpi }));
    const temp = await tempPng(withPlacementHints(png, dpi));
    const trace = async (what: string) => { log("info", "write-back", what); await flushLog(); };
    try { return await step("WavePlug AI 填充", g.docId, async () => {
      const { app, imaging, constants } = ps();
      const userDoc = app.activeDocument;
      const doc = docById(g.docId);
      app.activeDocument = doc;
      const group = findLayer(doc.layers, g.layerId);
      if (!isFillGroup(group)) throw new Error("AI 填充图层组已不存在");
      const n = Math.max(0, ...variationLayers(group).map(v => v.n)) + 1;

      await trace(`place v${n} ${rectW(placement)}x${rectH(placement)}`);
      await selectLayer(group.id);
      await play([{
        _obj: "placeEvent", null: { _path: temp.token, _kind: "local" },
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
        _options: DONT,
      }]);
      const layer = doc.activeLayers[0];
      const b = boundsRect(layer);
      // A transparent PNG's bounds are only its visible pixels: size it by the placed picture's own
      // frame instead (the smart object's corners), about that frame's corner.
      const frame = await placedFrame(doc.id, layer.id);
      if (frame && (Math.abs(rectW(frame) - rectW(b)) > 1 || Math.abs(rectH(frame) - rectH(b)) > 1)) {
        await trace(`scale frame ${Math.round(rectW(frame))}x${Math.round(rectH(frame))} -> ${rectW(placement)}x${rectH(placement)}`);
        const px = (v: number) => ({ _unit: "pixelsUnit", _value: v });
        await play([{
          _obj: "transform", _target: [{ _ref: "layer", _id: layer.id }],
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSIndependent" },
          position: { _obj: "paint", horizontal: px(frame.left), vertical: px(frame.top) },
          offset: { _obj: "offset", horizontal: px(placement.left - frame.left), vertical: px(placement.top - frame.top) },
          width: { _unit: "percentUnit", _value: rectW(placement) / rectW(frame) * 100 },
          height: { _unit: "percentUnit", _value: rectH(placement) / rectH(frame) * 100 },
          interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
          _options: DONT,
        }]);
      } else {
        await trace(`scale ${rectW(b)}x${rectH(b)} -> ${rectW(placement)}x${rectH(placement)}`);
        if (rectW(b) !== rectW(placement) || rectH(b) !== rectH(placement)) {
          await layer.scale(rectW(placement) / rectW(b) * 100, rectH(placement) / rectH(b) * 100, constants.AnchorPosition.TOPLEFT);
        }
        const nb = boundsRect(layer);
        if (nb.left !== placement.left || nb.top !== placement.top) await layer.translate(placement.left - nb.left, placement.top - nb.top);
      }
      await trace("rasterize");
      await layer.rasterize(constants.RasterizeType.ENTIRELAYER);
      // the full prompt lives in the layer name (PS allows 255 chars) so 再生成 can reuse it
      layer.name = `v${n} · ${prompt.trim().replace(/\s+/g, " ").slice(0, 200) || "移除"}`;
      await trace("move into group");
      if (layer.parent?.id !== group.id) await layer.move(group, constants.ElementPlacement.PLACEINSIDE);

      // mask: hide everything, then reveal the selection inside the fill rect
      await trace("mask");
      await selectLayer(layer.id);
      await play([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: mask.outside === "hide" ? "hideAll" : "revealAll" }, _options: DONT }]);
      const mp = mask.pixels;
      const m = await imaging.createImageDataFromBuffer(mp.data, { width: mp.width, height: mp.height, components: 1, colorSpace: "Grayscale", chunky: true });
      try { await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: m, targetBounds: { left: mask.rect.left, top: mask.rect.top } }); }
      finally { m.dispose(); }

      for (const v of variationLayers(group)) v.layer.visible = v.layer.id === layer.id;
      group.visible = true;
      if (userDoc && userDoc.id !== doc.id && this.docExists(userDoc.id)) app.activeDocument = userDoc;
      await trace(`done v${n}`);
      return { layerId: layer.id, number: n, label: String(n), prompt: prompt.trim(), visible: true };
    }); } finally { await temp.remove(); }
  }

  async thumbnail(g: FillGroup, layerId: number, size: number): Promise<string> {
    const px = await modal("WavePlug 缩略图", () => readPixels({ documentID: g.docId, layerID: layerId, sourceBounds: g.rect, targetSize: { height: size } }));
    const bytes = encodePng(px);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  }

  private listeners: [string[], () => void][] = [];
  private modalListeners: (() => void)[] = [];

  onChange(cb: () => void): void {
    let timer: ReturnType<typeof setTimeout> | null = null, lastAt = 0;
    // The main panel re-reads Photoshop on every change. While changes keep coming (rows clicked
    // one after another in WaveLayer) it waits for a pause: one read after the last click, not one
    // per click competing with WaveLayer's own (11-24: reads waited up to 6.8 s for Photoshop).
    const fire = () => {
      const now = Date.now(), busy = now - lastAt < 1000;
      lastAt = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(cb, busy ? 600 : 150);
    };
    // Photoshop does NOT deliver native action notifications for every batchPlay operation
    // initiated by this plugin. WaveLayer uses such a modal command to select its rows.
    // Only selection-affecting commands below fire; do not listen to mask/thumbnail read
    // modals here or merely viewing an AI group would recursively trigger refresh().
    const selectionCommands = new Set([
      "WavePlug 选择图层", "WavePlug 选中 AI 图层", "WavePlug 切换变体",
      "WavePlug 删除变体", "WavePlug 选择同源智能对象", "WavePlug 选中拆分结果",
    ]);
    const off = onModalDone(name => { if (selectionCommands.has(name)) fire(); });
    this.modalListeners.push(() => { off(); if (timer) clearTimeout(timer); });
    const events = ["select", "set", "make", "delete", "open", "close", "move", "show", "hide", "historyStateChanged"];
    ps().action.addNotificationListener(events, fire);
    this.listeners.push([events, fire]);
  }

  dispose() {
    for (const [events, fn] of this.listeners) { try { ps().action.removeNotificationListener(events, fn); } catch { /* host gone */ } }
    this.listeners = [];
    for (const off of this.modalListeners) off();
    this.modalListeners = [];
    // the next build (the development loader's ⟳ / auto reload) starts its own probe
    if (stallProbe) { clearInterval(stallProbe); stallProbe = null; }
  }
}
