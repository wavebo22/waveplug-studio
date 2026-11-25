// Photoshop's side of 牵手 Illustrator (src/app/illustratorBridge.ts decides what to do; this file
// only touches Photoshop). Files come and go through the plugin's own temporary folder: the
// Illustrator panel writes into `aibridge` there (Photoshop may read its own temporary folder
// without asking for file access), and layers for Illustrator are written there too.

import { log } from "../app/log.ts";
import { docById, findLayer, modal, play, step } from "./uxpHost.ts";
import { act } from "./uxpTools.ts";
import { type BoardNode, psBlendOf } from "../core/overlay/bridge.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const uxp = () => require("uxp");
const DONT = { dialogOptions: "silent" };

export interface PsDocInfo { docId: number; name: string; ppi: number; width: number; height: number }

async function inboxFolder(): Promise<any> {
  const temp = await uxp().storage.localFileSystem.getTemporaryFolder();
  try { return await temp.getEntry("aibridge"); }
  catch { return await temp.createFolder("aibridge"); }
}

/** The native path Illustrator writes its files into. */
export async function inboxPath(): Promise<string> {
  return String((await inboxFolder()).nativePath ?? "");
}

export function activeDocInfo(): PsDocInfo | null {
  const d = ps().app.activeDocument;
  if (!d) return null;
  return { docId: d.id, name: String(d.title ?? d.name), ppi: Number(d.resolution) || 72, width: Number(d.width) || 0, height: Number(d.height) || 0 };
}

async function inboxEntry(fileName: string): Promise<any> {
  if (!/^[\w.\-]+$/.test(fileName)) throw new Error("文件名不对：" + fileName);
  try { return await (await inboxFolder()).getEntry(fileName); }
  catch { throw new Error("找不到 Illustrator 发来的文件，可能已被清理"); }
}

/** Removes a file Illustrator sent once it is placed (Photoshop keeps its own copy). */
export async function dropInbox(fileName: string) {
  try { await (await inboxEntry(fileName)).delete(); } catch (e) { log("warn", "bridge inbox file not deleted", fileName, e); }
}

/** Places a file from Illustrator into the active document (a new document when none is open):
 *  an .ai becomes a vector smart object, a PNG a smart object or, with `pixels`, a pixel layer.
 *  One history step. */
export async function placeFromIllustrator(fileName: string, name: string, pixels: boolean, newDoc = false): Promise<{ docId: number; layerId: number; docName: string }> {
  const entry = await inboxEntry(fileName);
  const { app } = ps();
  if (newDoc || !app.activeDocument) {
    // nothing open: the file becomes its own document (Photoshop asks how to open an .ai)
    const doc = await require("photoshop").core.executeAsModal(() => app.open(entry), { commandName: "WavePlug 打开 Illustrator 对象", interactive: true });
    return { docId: doc.id, layerId: doc.layers?.[0]?.id ?? 0, docName: String(doc.title ?? doc.name) };
  }
  const doc = app.activeDocument;
  const token = uxp().storage.localFileSystem.createSessionToken(entry);
  return step("WavePlug 置入 Illustrator 对象", doc.id, async () => {
    // act(): a refused place throws (and the step is undone). With play() the layer selected before
    // was taken for the placed one: renamed to the object, rasterized, linked to Illustrator.
    const before = doc.activeLayers?.[0]?.id ?? null;
    await act({
      _obj: "placeEvent", null: { _path: token, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
    });
    const layer = doc.activeLayers[0];
    if (!layer || layer.id === before) throw new Error("Photoshop 没有置入这个文件");
    try { layer.name = name; } catch { /* keeps the file name */ }
    if (pixels) await act({ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _id: layer.id }], what: { _enum: "rasterizeItem", _value: "placed" } });
    log("info", "bridge placed", JSON.stringify({ fileName, name, pixels, layerId: layer.id }));
    return { docId: doc.id, layerId: layer.id as number, docName: String(doc.title ?? doc.name) };
  });
}

/** The document with `docId`, else an open one named `docName` (ids change when Photoshop restarts). */
export function findDoc(docId: number, docName: string): any | null {
  const { app } = ps();
  const docs: any[] = [...(app.documents ?? [])];
  return docs.find(d => d.id === docId) ?? docs.find(d => String(d.title ?? d.name) === docName) ?? null;
}

/** Replaces the contents of the smart object Illustrator sent earlier. One history step. */
export async function replaceFromIllustrator(docId: number, docName: string, layerId: number, fileName: string): Promise<{ docId: number }> {
  const doc = findDoc(docId, docName);
  if (!doc) throw new Error(`「${docName}」没有打开`);
  const layer = findLayer(doc.layers, layerId);
  if (!layer) throw new Error("Photoshop 里对应的图层已经删除");
  const entry = await inboxEntry(fileName);
  const token = uxp().storage.localFileSystem.createSessionToken(entry);
  await step("WavePlug 从 Illustrator 更新", doc.id, async () => {
    const { app } = ps();
    if (app.activeDocument?.id !== doc.id) app.activeDocument = doc;
    // act(): a refusal throws, so a failed replace isn't reported as done (and a failed select
    // can't let the replace land on whatever smart object was selected before)
    await act({ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false });
    await act({ _obj: "placedLayerReplaceContents", null: { _path: token, _kind: "local" } });
  });
  log("info", "bridge replaced", JSON.stringify({ docId: doc.id, layerId, fileName }));
  return { docId: doc.id };
}

/** Brings the linked layer's document to the front and selects the layer. */
export async function revealLayer(docId: number, docName: string, layerId: number) {
  const doc = findDoc(docId, docName);
  if (!doc) throw new Error(`「${docName}」没有打开`);
  if (!findLayer(doc.layers, layerId)) throw new Error("Photoshop 里对应的图层已经删除");
  await ps().core.executeAsModal(async () => {
    const { app } = ps();
    if (app.activeDocument?.id !== doc.id) app.activeDocument = doc;
    await play([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: true, _options: DONT }]);
  }, { commandName: "WavePlug 定位关联图层" });
}

/** A text file in the plugin's temporary folder (the SVG of a text / shape layer for Illustrator). */
export async function writeTemp(name: string, text: string): Promise<{ path: string; remove(): Promise<void> }> {
  const folder = await uxp().storage.localFileSystem.getTemporaryFolder();
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(text, { format: uxp().storage.formats.utf8 });
  const path = String(file.nativePath ?? "");
  const remove = async () => { try { await file.delete(); } catch (e) { log("warn", "bridge temp file not deleted", name, e); } };
  if (!path) { await remove(); throw new Error("临时文件没有原生路径"); }
  return { path, remove };
}

export function foregroundHex(): string {
  return "#" + String(ps().app.foregroundColor.rgb.hexValue).toLowerCase();
}

export async function setForegroundHex(hex: string) {
  const { app, core } = ps();
  await core.executeAsModal(async () => {
    const c = new app.SolidColor();
    c.rgb.hexValue = hex.replace("#", "");
    app.foregroundColor = c;
  }, { commandName: "WavePlug 前景色" });
}

/** whether layer `layerId` of `docId` still exists */
export function layerExists(docId: number, layerId: number): boolean {
  try { return !!findLayer(docById(docId).layers, layerId); } catch { return false; }
}

/** 画板 from Illustrator: a new document the artboard's size (points at `ppi`), every item placed
 *  as a vector smart object at its place, in groups for Illustrator's layers / groups, with their
 *  names, opacity, blend mode and visibility. The building is one history step. */
export async function buildBoardFromIllustrator(req: { name: string; width: number; height: number; ppi: number; nodes: BoardNode[] }): Promise<{ docId: number; docName: string; placed: { link: string; layerId: number; name: string }[]; failed: string[] }> {
  const { app, constants } = ps();
  const k = req.ppi / 72;
  const doc = await modal("WavePlug 新建画板文档", async () => app.documents.add({
    width: Math.max(1, Math.round(req.width * k)), height: Math.max(1, Math.round(req.height * k)), resolution: req.ppi,
    mode: "RGBColorMode", fill: constants.DocumentFill.TRANSPARENT, name: req.name,
  }));
  const placed: { link: string; layerId: number; name: string }[] = [], failed: string[] = [];
  await step("WavePlug 从 Illustrator 置入画板", doc.id, async () => {
    const first = doc.layers[0];
    const bounds = (l: any) => { const b = l.boundsNoEffects ?? l.bounds; return { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) }; };
    // the new layer on top of its group (or of the document): built bottom up, each lands on top
    const put = async (layer: any, parent: any) => {
      if (parent) await layer.move(parent, constants.ElementPlacement.PLACEINSIDE);
      else if (doc.layers[0]?.id !== layer.id) await layer.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);
    };
    const look = (layer: any, n: BoardNode, group: boolean) => {
      try { layer.name = n.name || (group ? "组" : "对象"); } catch { /* keeps its name */ }
      try { if (n.opacity < 100) layer.opacity = n.opacity; } catch (e) { log("warn", "board opacity", e); }
      const mode = constants.BlendMode[psBlendOf(n.blend, group)];
      try { if (mode && String(layer.blendMode) !== String(mode)) layer.blendMode = mode; } catch (e) { log("warn", "board blend", n.blend, e); }
      if (n.hidden) try { layer.visible = false; } catch { /* stays shown */ }
    };
    const placeOne = async (n: BoardNode): Promise<any> => {
      const entry = await inboxEntry(n.fileName!);
      const token = uxp().storage.localFileSystem.createSessionToken(entry);
      await play([{
        _obj: "placeEvent", null: { _path: token, _kind: "local" },
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
        _options: DONT,
      }]);
      const layer = doc.activeLayers[0];
      if (!layer || layer.id === first?.id) throw new Error("没有置入");
      // the item's own size and place (Photoshop may have shrunk it to fit the canvas)
      const w = (n.width ?? 0) * k, h = (n.height ?? 0) * k;
      let b = bounds(layer);
      if (w > 0 && h > 0 && (Math.abs(b.right - b.left - w) > 0.5 || Math.abs(b.bottom - b.top - h) > 0.5))
        await layer.scale(w / Math.max(0.01, b.right - b.left) * 100, h / Math.max(0.01, b.bottom - b.top) * 100, constants.AnchorPosition.TOPLEFT);
      b = bounds(layer);
      const dx = (n.left ?? 0) * k - b.left, dy = (n.top ?? 0) * k - b.top;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy);
      return layer;
    };
    const build = async (nodes: BoardNode[], parent: any) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.children) {
          const g = await doc.createLayerGroup({ name: n.name || "组" });
          await put(g, parent);
          await build(n.children, g);
          look(g, n, true);
          continue;
        }
        let layer: any;
        try { layer = await placeOne(n); }
        catch (e) { failed.push(n.name); log("warn", "board place", n.fileName, e); continue; }
        await put(layer, parent);
        look(layer, n, false);
        if (n.link) placed.push({ link: n.link, layerId: layer.id as number, name: n.name });
      }
    };
    await build(req.nodes, null);
    // the empty layer the new document came with
    if (first && doc.layers.length > 1) { try { await first.delete(); } catch (e) { log("warn", "board first layer", e); } }
  });
  log("info", "bridge board", JSON.stringify({ docId: doc.id, placed: placed.length, failed: failed.length }));
  return { docId: doc.id, docName: String(doc.title ?? doc.name), placed, failed };
}

/** A smart object's own file (the .ai / .pdf … inside it) written to the temporary folder, and
 *  where the layer is (bounds without effects). Read only for the document. */
export async function exportSmartContents(docId: number, layerId: number, name: string): Promise<{ path: string; rect: { left: number; top: number; right: number; bottom: number }; remove(): Promise<void> }> {
  const folder = await uxp().storage.localFileSystem.getTemporaryFolder();
  const file = await folder.createFile(name, { overwrite: true });
  const remove = async () => { try { await file.delete(); } catch (e) { log("warn", "bridge temp file not deleted", name, e); } };
  const token = uxp().storage.localFileSystem.createSessionToken(file);
  const ref = [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }];
  const [r] = await modal("WavePlug 导出智能对象内容", () => play([{ _obj: "placedLayerExportContents", _target: ref, null: { _path: token, _kind: "local" }, _options: DONT }]));
  if (r?._obj === "error") { await remove(); throw new Error("Photoshop 没有导出智能对象内容：" + (r.message ?? r.result)); }
  const layer = findLayer(docById(docId).layers, layerId);
  const b = layer?.boundsNoEffects ?? layer?.bounds;
  const path = String(file.nativePath ?? "");
  if (!b || !path) { await remove(); throw new Error("读不到智能对象的位置"); }
  return { path, rect: { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) }, remove };
}
