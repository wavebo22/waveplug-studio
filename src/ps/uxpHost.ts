// Photoshop UXP implementation, Generative-Fill style: one layer group per fill, masked by the
// selection, one cropped pixel layer per variation inside it.

import { encodePng, type Pixels, withPlacementHints } from "../core/image/png.ts";
import { type Rect, nonZeroBounds, rectH, rectW } from "../core/image/region.ts";
import { placeGray } from "../core/image/compose.ts";
import { flushLog, log } from "../app/log.ts";
import { type Capture, type DocInfo, FILL_PREFIX, type FillGroup, type LayerInfo, type PsHost, type Variation } from "./host.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const uxpStorage = () => require("uxp").storage;
const DONT = { dialogOptions: "dontDisplay" };
const SRGB = "sRGB IEC61966-2.1";
const VARIATION = /^v(\d+)(?:\s*·\s*(.*))?$/;

async function play(descriptors: object[]): Promise<any[]> {
  return ps().action.batchPlay(descriptors, {});
}

async function modal<T>(name: string, fn: (ctx: any) => Promise<T>): Promise<T> {
  return ps().core.executeAsModal(fn, { commandName: name });
}

/** Runs `fn` as one undo step named `name` in document `docId`. */
async function step<T>(name: string, docId: number, fn: () => Promise<T>): Promise<T> {
  return modal(name, async ctx => {
    const hc = ctx.hostControl;
    const s = await hc.suspendHistory({ documentID: docId, name });
    try { const r = await fn(); await hc.resumeHistory(s, true); return r; }
    catch (e) { await hc.resumeHistory(s, false).catch(() => undefined); throw e; }
  });
}

function docById(id: number): any {
  const d = ps().app.documents.find((x: any) => x.id === id);
  if (!d) throw new Error("发起任务的 PSD 已关闭");
  return d;
}

function info(d: any): DocInfo {
  return { id: d.id, name: d.title ?? d.name, width: Math.round(d.width), height: Math.round(d.height), mode: String(d.mode), bits: Number(String(d.bitsPerChannel).replace(/\D/g, "")) || 8 };
}

function findLayer(layers: any[], id: number): any | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.layers?.length) { const f = findLayer(l.layers, id); if (f) return f; }
  }
  return null;
}

const isFillGroup = (l: any) => !!l && String(l.kind) === "group" && String(l.name).startsWith(FILL_PREFIX);

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
async function grayInto(r: any, want: Rect, fill: number): Promise<Pixels> {
  try {
    const d = r.imageData;
    const px: Pixels = { width: d.width, height: d.height, channels: 1, data: new Uint8Array(await d.getData({ chunky: true })) };
    const got = boundsOf(r.sourceBounds, { left: want.left, top: want.top, right: want.left + d.width, bottom: want.top + d.height });
    return placeGray(px, got, want, fill);
  } finally { r.imageData.dispose(); }
}

async function tempPng(bytes: Uint8Array): Promise<string> {
  const fs = uxpStorage().localFileSystem;
  const folder = await fs.getTemporaryFolder();
  const file = await folder.createFile(`waveplug_${Date.now()}.png`, { overwrite: true });
  await file.write(bytes, { format: uxpStorage().formats.binary });
  return fs.createSessionToken(file);
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

  async activeFillGroup(): Promise<FillGroup | null> {
    const d = ps().app.activeDocument;
    let l = d?.activeLayers?.[0];
    if (!l) return null;
    if (!isFillGroup(l)) l = l.parent;
    if (!isFillGroup(l)) return null;
    return this.groupInfo(d, l).catch(e => { log("warn", "active fill group unreadable", l.id, e); return null; });
  }

  /** The fill area = non-zero bounds of a variation's layer mask (variations may extend past it). */
  /** fill rect per "docId:groupId" — reading a mask needs a modal scope, so it is done once */
  private rects = new Map<string, Rect>();

  private async groupInfo(doc: any, group: any): Promise<FillGroup> {
    const vs = variationLayers(group);
    if (!vs.length) throw new Error("AI 填充图层组里没有变体");
    const key = `${doc.id}:${group.id}`;
    let rect = this.rects.get(key);
    if (!rect) {
      const lb = boundsRect(vs[0].layer);
      try {
        rect = await modal("WavePlug 读取填充范围", async () => {
          const mask = await grayInto(await ps().imaging.getLayerMask({ documentID: doc.id, layerID: vs[0].layer.id, sourceBounds: lb }), lb, 0);
          return nonZeroBounds(mask.data, mask.width, mask.height, lb) ?? lb;
        });
        this.rects.set(key, rect);
      } catch (e) {
        // e.g. Photoshop busy with another modal operation: use the layer bounds for now, retry next time
        log("warn", "fill rect from mask failed, using layer bounds", e);
        rect = lb;
      }
    }
    return { docId: doc.id, layerId: group.id, name: String(group.name).slice(FILL_PREFIX.length), rect };
  }

  listFillGroups(docId: number): { layerId: number; name: string }[] {
    const out: { layerId: number; name: string }[] = [];
    const walk = (ls: any[]) => { for (const l of ls) { if (isFillGroup(l)) out.push({ layerId: l.id, name: String(l.name).slice(FILL_PREFIX.length) }); else if (l.layers?.length) walk(l.layers); } };
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
    return { ...g, name: String(group.name).slice(FILL_PREFIX.length) };
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

  async layerPixels(docId: number, layerId: number): Promise<Pixels> {
    return modal("WavePlug 读取参考图层", () => readPixels({ documentID: docId, layerID: layerId }));
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

  async deleteVariation(g: FillGroup, layerId: number): Promise<void> {
    await step("WavePlug 删除变体", g.docId, async () => {
      const doc = docById(g.docId);
      const group = findLayer(doc.layers, g.layerId);
      const layer = group && findLayer(group.layers, layerId);
      if (!layer) return;
      const wasVisible = layer.visible;
      await layer.delete();
      const rest = variationLayers(group);
      if (wasVisible && rest.length) rest[rest.length - 1].layer.visible = true;
    });
  }

  async createFillGroup(docId: number, rect: Rect, prompt: string): Promise<FillGroup> {
    return step("WavePlug 新建 AI 填充", docId, async () => {
      const doc = docById(docId);
      ps().app.activeDocument = doc;
      const group = await doc.createLayerGroup({ name: FILL_PREFIX + (prompt.trim().slice(0, 24) || "移除") });
      this.rects.set(`${docId}:${group.id}`, rect);
      return { docId, layerId: group.id, name: String(group.name).slice(FILL_PREFIX.length), rect };
    });
  }

  async addVariation(g: FillGroup, png: Uint8Array, placement: Rect, prompt: string, mask: Pixels): Promise<Variation> {
    const target = docById(g.docId);
    const dpi = Number(target.resolution) || 72;
    log("info", "document", JSON.stringify({ mode: String(target.mode), profile: target.colorProfileName ?? null, dpi }));
    const token = await tempPng(withPlacementHints(png, dpi));
    const trace = async (what: string) => { log("info", "write-back", what); await flushLog(); };
    return step("WavePlug AI 填充", g.docId, async () => {
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
        _obj: "placeEvent", null: { _path: token, _kind: "local" },
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
        _options: DONT,
      }]);
      const layer = doc.activeLayers[0];
      const b = boundsRect(layer);
      await trace(`scale ${rectW(b)}x${rectH(b)} -> ${rectW(placement)}x${rectH(placement)}`);
      if (rectW(b) !== rectW(placement) || rectH(b) !== rectH(placement)) {
        await layer.scale(rectW(placement) / rectW(b) * 100, rectH(placement) / rectH(b) * 100, constants.AnchorPosition.TOPLEFT);
      }
      const nb = boundsRect(layer);
      if (nb.left !== placement.left || nb.top !== placement.top) await layer.translate(placement.left - nb.left, placement.top - nb.top);
      await trace("rasterize");
      await layer.rasterize(constants.RasterizeType.ENTIRELAYER);
      // the full prompt lives in the layer name (PS allows 255 chars) so 再生成 can reuse it
      layer.name = `v${n} · ${prompt.trim().replace(/\s+/g, " ").slice(0, 200) || "移除"}`;
      await trace("move into group");
      if (layer.parent?.id !== group.id) await layer.move(group, constants.ElementPlacement.PLACEINSIDE);

      // mask: hide everything, then reveal the selection inside the fill rect
      await trace("mask");
      await selectLayer(layer.id);
      await play([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "hideAll" }, _options: DONT }]);
      const m = await imaging.createImageDataFromBuffer(mask.data, { width: mask.width, height: mask.height, components: 1, colorSpace: "Grayscale", chunky: true });
      try { await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: m, targetBounds: { left: g.rect.left, top: g.rect.top } }); }
      finally { m.dispose(); }

      for (const v of variationLayers(group)) v.layer.visible = v.layer.id === layer.id;
      group.visible = true;
      if (userDoc && userDoc.id !== doc.id && this.docExists(userDoc.id)) app.activeDocument = userDoc;
      await trace(`done v${n}`);
      return { layerId: layer.id, number: n, label: String(n), prompt: prompt.trim(), visible: true };
    });
  }

  async thumbnail(g: FillGroup, layerId: number, size: number): Promise<string> {
    const px = await modal("WavePlug 缩略图", () => readPixels({ documentID: g.docId, layerID: layerId, sourceBounds: g.rect, targetSize: { height: size } }));
    const bytes = encodePng(px);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  }

  private listeners: [string[], () => void][] = [];

  onChange(cb: () => void): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => { if (timer) clearTimeout(timer); timer = setTimeout(cb, 150); };
    const events = ["select", "set", "make", "delete", "open", "close", "move", "show", "hide", "historyStateChanged"];
    ps().action.addNotificationListener(events, fire);
    this.listeners.push([events, fire]);
  }

  dispose() {
    for (const [events, fn] of this.listeners) { try { ps().action.removeNotificationListener(events, fn); } catch { /* host gone */ } }
    this.listeners = [];
  }
}
