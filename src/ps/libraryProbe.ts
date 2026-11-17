// WaveLibrary POC probe (P0-3, P2-12), development build only. Temporary: remove once the POC is done.
//
// Logs, as "wavelibrary probe" lines in uxp_runtime.log, what the plugin receives when a document is
// saved or closed, and the active layer's link path whenever the history state changes or a layer is
// relinked. Reads only the properties it needs (no whole-layer get), never inside a modal.

import { log } from "../app/log.ts";

declare const require: (m: string) => any;
const ps = () => require("photoshop");

const EVENTS = ["save", "close", "open", "historyStateChanged", "placedLayerRelinkToFile", "placedLayerConvertToLinked"];

/** The fields of a notification descriptor worth logging (paths, ids, names), nothing large. */
function summary(desc: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!desc || typeof desc !== "object") return out;
  for (const [k, v] of Object.entries(desc)) {
    if (k === "_isCommand") continue;
    if (v && typeof v === "object") {
      const o = v as any;
      if (typeof o._path === "string") out[k] = o._path;
      else if (Array.isArray(o)) out[k] = JSON.stringify(o).slice(0, 200);
      else out[k] = JSON.stringify(o).slice(0, 200);
    } else out[k] = v;
  }
  return out;
}

async function activeLink(): Promise<Record<string, unknown>> {
  const doc = ps().app.activeDocument;
  if (!doc) return { doc: null };
  const info: Record<string, unknown> = { docId: doc.id, docName: doc.name, docPath: (() => { try { return doc.path; } catch { return null; } })(), saved: (() => { try { return doc.saved; } catch { return null; } })() };
  const layer = doc.activeLayers?.[0];
  if (!layer) return info;
  info.layerId = layer.id;
  info.layerName = layer.name;
  const t0 = Date.now();
  const [r] = await ps().action.batchPlay([{
    _obj: "get",
    _target: [{ _property: "smartObject" }, { _ref: "layer", _id: layer.id }, { _ref: "document", _id: doc.id }],
  }], {});
  const so = r?.smartObject;
  if (so) {
    info.linked = !!so.linked;
    info.link = so.link?._path ?? so.link ?? null;
    info.fileReference = so.fileReference ?? null;
  } else info.smartObject = false;
  info.readMs = Date.now() - t0;
  return info;
}

/** Starts listening; returns a function that stops it. */
export function startLibraryProbe(): () => void {
  const fn = async (event: string, desc: any) => {
    const at = Date.now();
    let state: Record<string, unknown> = {};
    try { state = await activeLink(); } catch (e) { state = { readError: String(e) }; }
    log("info", "wavelibrary probe", event, JSON.stringify({ desc: summary(desc), state, afterMs: Date.now() - at }));
  };
  ps().action.addNotificationListener(EVENTS, fn);
  log("info", "wavelibrary probe", "started", EVENTS.join(","));
  return () => { try { ps().action.removeNotificationListener(EVENTS, fn); } catch { /* host gone */ } };
}
