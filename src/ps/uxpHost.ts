// Photoshop UXP implementation. The Action descriptors mirror poc/so_lib.jsx, which was verified
// in Photoshop 27.10 via ExtendScript; this file still needs its first live run inside UXP.

import type { Pixels } from "../core/image/png.ts";
import { type Rect, rectH, rectW } from "../core/image/region.ts";
import { readCounter, writeCounter } from "../core/xmp.ts";
import { placeGray } from "../core/image/compose.ts";
import { log } from "../app/log.ts";
import type { Capture, DocInfo, LayerInfo, PsHost, TaskGroup, Version } from "./host.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const uxpStorage = () => require("uxp").storage;
const DONT = { dialogOptions: "dontDisplay" };
const FILE_RE = /^WavePlug_([A-Za-z0-9]+)\.psb$/;
const VERSION_NAME = /^\d{3,}$/;
const SRGB = "sRGB IEC61966-2.1";
const pad = (n: number) => String(n).padStart(3, "0");

async function play(descriptors: object[]): Promise<any[]> {
  return ps().action.batchPlay(descriptors, {});
}

async function modal<T>(name: string, fn: (ctx: any) => Promise<T>): Promise<T> {
  return ps().core.executeAsModal(fn, { commandName: name });
}

function docById(id: number): any {
  const d = ps().app.documents.find((x: any) => x.id === id);
  if (!d) throw new Error("发起任务的 PSD 已关闭");
  return d;
}

function info(d: any): DocInfo {
  return { id: d.id, name: d.title ?? d.name, width: Math.round(d.width), height: Math.round(d.height), mode: String(d.mode), bits: Number(String(d.bitsPerChannel).replace(/\D/g, "")) || 8 };
}

async function layerDesc(docId: number, layerId: number): Promise<any> {
  const [r] = await play([{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }], _options: DONT }]);
  return r;
}

async function selectLayer(layerId: number) {
  await play([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false, _options: DONT }]);
}

function rectFromTransform(t: number[]): Rect | null {
  // transform = 4 corners (x,y) clockwise from top-left
  const [x0, y0, x1, y1, x2, y2, x3, y3] = t;
  const axis = Math.abs(y0 - y1) < 0.5 && Math.abs(x1 - x2) < 0.5 && Math.abs(y2 - y3) < 0.5 && Math.abs(x3 - x0) < 0.5;
  if (!axis) return null;
  return { left: Math.round(x0), top: Math.round(y0), right: Math.round(x2), bottom: Math.round(y2) };
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

async function getXmp(docId: number): Promise<string> {
  const [r] = await play([{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: docId }], _options: DONT }]);
  return r.XMPMetadataAsUTF8 ?? "";
}
async function setXmp(docId: number, xmp: string) {
  await play([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: docId }], to: { _obj: "document", XMPMetadataAsUTF8: xmp }, _options: DONT }]);
}

function versionLayers(psb: any): any[] {
  return psb.layers.filter((l: any) => VERSION_NAME.test(l.name));
}

/** One comp per version layer, each showing only that layer; comps of deleted layers are dropped. */
async function rebuildComps(psb: any, comments: Record<string, string> = {}) {
  const versions = versionLayers(psb);
  const names = new Set(versions.map((l: any) => l.name));
  for (const comp of [...psb.layerComps]) {
    if (VERSION_NAME.test(comp.name) && !names.has(comp.name)) await (comp.delete ?? comp.remove).call(comp);
  }
  for (const layer of versions) {
    for (const other of versions) other.visible = other === layer;
    const comp = [...psb.layerComps].find((c: any) => c.name === layer.name);
    if (comp) await comp.recapture({ visibility: true });
    else await psb.layerComps.add({ name: layer.name, comment: comments[layer.name] ?? "", visibility: true, position: false, appearance: false });
  }
}

export class UxpHost implements PsHost {
  readonly kind = "uxp" as const;
  private reconciling = false;

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

  async activeTaskGroup(): Promise<TaskGroup | null> {
    const d = ps().app.activeDocument;
    const layer = d?.activeLayers?.[0];
    if (!layer || String(layer.kind) !== "smartObject") return null;
    return this.groupFromLayer(d.id, layer.id).catch(() => null);
  }

  private async groupFromLayer(docId: number, layerId: number): Promise<TaskGroup> {
    const desc = await layerDesc(docId, layerId);
    const file = desc.smartObject?.fileReference ?? "";
    const m = FILE_RE.exec(file);
    if (!m) throw new Error("所选智能对象不是 WavePlug 任务组");
    const rect = rectFromTransform(desc.smartObjectMore?.transform ?? []);
    if (!rect) throw new Error("任务组智能对象被旋转或变形，无法续写；请新建任务");
    return { docId, layerId, taskId: m[1], fileName: file, layerName: desc.name, rect };
  }

  async refreshTaskGroup(g: TaskGroup): Promise<TaskGroup> {
    if (!this.docExists(g.docId)) throw new Error("任务组所在的 PSD 已关闭");
    const fresh = await this.groupFromLayer(g.docId, g.layerId).catch(e => { throw new Error("任务组智能对象已被删除或替换：" + e.message); });
    if (fresh.fileName !== g.fileName) throw new Error("任务组智能对象已被替换");
    return fresh;
  }

  async groupMask(g: TaskGroup): Promise<Pixels> {
    return modal("WavePlug 读取任务组遮罩", async () => {
      const r = await ps().imaging.getLayerMask({ documentID: g.docId, layerID: g.layerId, sourceBounds: g.rect });
      return grayInto(r, g.rect, 0);
    });
  }

  async capture(docId: number, rect: Rect, selection: "active" | Pixels): Promise<Capture> {
    return modal("WavePlug 读取画面", async () => {
      const doc = info(docById(docId));
      const image = await readPixels({ documentID: docId, sourceBounds: rect });
      if (image.width !== rectW(rect) || image.height !== rectH(rect)) throw new Error(`读取到的画面 ${image.width}×${image.height} 与范围不一致`);
      let sel: Pixels;
      if (selection === "active") {
        const r = await ps().imaging.getSelection({ documentID: docId, sourceBounds: rect });
        sel = await grayInto(r, rect, 0);
      } else sel = selection;
      return { doc, rect, image, selection: sel };
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

  async versions(g: TaskGroup) {
    const desc = await layerDesc(g.docId, g.layerId);
    const more = desc.smartObjectMore ?? {};
    const list: any[] = more.compInfo?.compList ?? [];
    const versions: Version[] = list
      .filter(c => VERSION_NAME.test(c.name))
      .map(c => ({ number: Number(c.name), label: c.name, compId: Number(c.ID ?? c.id), comment: c.comment ?? "" }))
      .sort((a, b) => a.number - b.number);
    const cur = Number(more.comp);
    return { versions, currentCompId: Number.isFinite(cur) && cur >= 0 ? cur : null };
  }

  async switchVersion(g: TaskGroup, compId: number): Promise<void> {
    await modal("WavePlug 切换版本", async () => {
      await play([{ _obj: "setPlacedLayerComp", _target: [{ _ref: "layer", _id: g.layerId }, { _ref: "document", _id: g.docId }], compID: compId, _options: DONT }]);
    });
  }

  async createTaskGroup(docId: number, groupRect: Rect, base: Pixels, mask: Pixels, taskId: string): Promise<TaskGroup> {
    return modal("WavePlug 新建任务组", async ctx => {
      const { app, imaging } = ps();
      const doc = docById(docId);
      app.activeDocument = doc;
      const hc = ctx.hostControl;
      const suspension = await hc.suspendHistory({ documentID: docId, name: "WavePlug 新建任务组" });
      try {
        const baseId = await this.baseLayer(doc, docId, groupRect, base, taskId);
        await selectLayer(baseId);
        await play([{ _obj: "newPlacedLayer", _options: DONT }]);
        const so = doc.activeLayers[0];
        so.name = "AI 结果 · " + taskId;
        await play([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealAll" }, _options: DONT }]);
        const m = await imaging.createImageDataFromBuffer(mask.data, { width: mask.width, height: mask.height, components: 1, colorSpace: "Grayscale", chunky: true });
        try { await imaging.putLayerMask({ documentID: docId, layerID: so.id, imageData: m, targetBounds: { left: groupRect.left, top: groupRect.top } }); }
        finally { m.dispose(); }
        await hc.resumeHistory(suspension, true);
        return this.groupFromLayer(docId, so.id);
      } catch (e) {
        await hc.resumeHistory(suspension, false);
        throw e;
      }
    });
  }

  /** Original pixels of the group area as a new layer. RGB data is converted by Photoshop when the
   *  document is CMYK; if that fails, the layer is copied from a stamp of the visible document. */
  private async baseLayer(doc: any, docId: number, r: Rect, base: Pixels, taskId: string): Promise<number> {
    const { imaging } = ps();
    const layer = await doc.createPixelLayer({ name: "WavePlug_" + taskId });
    try {
      const img = await imaging.createImageDataFromBuffer(base.data, { width: base.width, height: base.height, components: base.channels, colorSpace: "RGB", colorProfile: SRGB, chunky: true });
      try { await imaging.putPixels({ documentID: docId, layerID: layer.id, imageData: img, targetBounds: { left: r.left, top: r.top } }); }
      finally { img.dispose(); }
      return layer.id;
    } catch (e) {
      log("warn", "putPixels failed, copying from visible pixels instead", String(doc.mode), e);
      await play([{ _obj: "delete", _target: [{ _ref: "layer", _id: layer.id }], _options: DONT }]);
    }
    const px = (v: number) => ({ _unit: "pixelsUnit", _value: v });
    let stampId: number | null = null;
    if (doc.layers.length > 1) {
      await play([{ _obj: "mergeVisible", duplicate: true, _options: DONT }]);
      stampId = doc.activeLayers[0].id;
    } else await selectLayer(doc.layers[0].id);
    await play([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _obj: "rectangle", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) }, _options: DONT }]);
    await play([{ _obj: "copyToLayer", _options: DONT }]);
    const id = doc.activeLayers[0].id;
    doc.activeLayers[0].name = "WavePlug_" + taskId;
    if (stampId !== null) await play([{ _obj: "delete", _target: [{ _ref: "layer", _id: stampId }], _options: DONT }]);
    await play([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" }, _options: DONT }]);
    return id;
  }

  async appendVersion(g: TaskGroup, png: Uint8Array, placement: Rect, comment: string): Promise<Version> {
    const token = await tempPng(png);
    let newLabel = "";
    await modal("WavePlug 写入新版本", async () => {
      const { app, constants } = ps();
      const userDoc = app.activeDocument;
      const doc = docById(g.docId);
      app.activeDocument = doc;
      await selectLayer(g.layerId);
      await play([{ _obj: "placedLayerEditContents", _options: DONT }]);
      const psb = app.activeDocument;
      if ((psb.title ?? psb.name) !== g.fileName) {
        throw new Error(`打开的内部文件 ${psb.title ?? psb.name} 与任务组 ${g.fileName} 不一致，已停止写入`);
      }
      let saved = false;
      try {
        for (const l of psb.layers) if (/^WavePlug_/.test(l.name)) l.name = "原图";
        const xmp = await getXmp(psb.id);
        const highest = Math.max(readCounter(xmp), ...versionLayers(psb).map((l: any) => Number(l.name)), 0);
        const label = pad(highest + 1);
        newLabel = label;

        await play([{
          _obj: "placeEvent", null: { _path: token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
          _options: DONT,
        }]);
        const layer = psb.activeLayers[0];
        const b = layer.boundsNoEffects ?? layer.bounds;
        const bw = b.right - b.left, bh = b.bottom - b.top;
        await layer.scale(rectW(placement) / bw * 100, rectH(placement) / bh * 100, constants.AnchorPosition.TOPLEFT);
        const nb = layer.boundsNoEffects ?? layer.bounds;
        await layer.translate(placement.left - nb.left, placement.top - nb.top);
        await layer.rasterize(constants.RasterizeType.ENTIRELAYER);
        layer.name = label;
        if (psb.layers[0] !== layer) layer.move(psb.layers[0], constants.ElementPlacement.PLACEBEFORE);

        await rebuildComps(psb, { [label]: comment });
        for (const l of versionLayers(psb)) l.visible = l.name === label;
        await setXmp(psb.id, writeCounter(await getXmp(psb.id), highest + 1));
        this.reconciling = true;
        await psb.save();
        saved = true;
        await psb.close(constants.SaveOptions.DONOTSAVECHANGES);
      } catch (e) {
        if (!saved) await psb.close(constants.SaveOptions.DONOTSAVECHANGES).catch(() => undefined);
        throw e;
      } finally {
        this.reconciling = false;
      }
      // leave the user on the document they were looking at
      app.activeDocument = userDoc && this.docExists(userDoc.id) ? userDoc : doc;
    });
    const { versions } = await this.versions(g);
    const v = versions.find(x => x.label === newLabel);
    if (!v) throw new Error(`版本 ${newLabel} 已写入内部文件，但主文档未读到对应的图层复合`);
    await this.switchVersion(g, v.compId);
    return v;
  }

  async thumbnail(g: TaskGroup, size: number): Promise<string> {
    const { encodePng } = await import("../core/image/png.ts");
    const px = await modal("WavePlug 缩略图", () => readPixels({ documentID: g.docId, layerID: g.layerId, targetSize: { height: size } }));
    const bytes = encodePng(px);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  }

  onChange(cb: () => void): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => { if (timer) clearTimeout(timer); timer = setTimeout(cb, 150); };
    const events = ["select", "set", "make", "delete", "open", "close", "move", "placedLayerEditContents", "setPlacedLayerComp", "historyStateChanged"];
    ps().action.addNotificationListener(events, fire);
    // The user saved a task-group PSB after editing it by hand: drop comps whose layer was deleted.
    ps().action.addNotificationListener(["save"], async () => {
      const d = ps().app.activeDocument;
      if (this.reconciling || !d || !FILE_RE.test(d.title ?? d.name)) { fire(); return; }
      const before = [...d.layerComps].map((c: any) => c.name).join();
      const live = new Set(versionLayers(d).map((l: any) => l.name));
      if ([...d.layerComps].every((c: any) => !VERSION_NAME.test(c.name) || live.has(c.name))) { fire(); return; }
      this.reconciling = true;
      try {
        await modal("WavePlug 同步版本", async () => {
          const visible = versionLayers(d).filter((l: any) => l.visible).map((l: any) => l.name);
          await rebuildComps(d);
          for (const l of versionLayers(d)) l.visible = visible.includes(l.name);
          await d.save();
        });
      } catch (e) { console.warn("同步任务组版本失败", before, e); }
      finally { this.reconciling = false; fire(); }
    });
  }
}
