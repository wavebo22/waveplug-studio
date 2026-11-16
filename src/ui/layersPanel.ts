// WavePlug 图层: the layer list as a panel of its own, which docks and groups with Photoshop's
// panels like the Layers panel does. Refreshes only while it is shown.

import type { Services } from "../app/services.ts";
import { createLayerTreeView } from "./layerTree.ts";
import { askIllustrator, linkOfLayer, pushBoardToIllustrator, pushToIllustrator } from "../app/illustratorBridge.ts";
import { h, icon, replace } from "./dom.ts";
import { fileBaseName, fileDropResultText, fileDropZoneAt, fileDropZones, webDrop, webDropResultText, pathsFromDropText, planFileDrop } from "../core/layers/fileDrop.ts";
import { log } from "../app/log.ts";

export function mountLayersPanel(root: HTMLElement, svc: Services, isShown: () => boolean) {
  const statusEl = h("div", { class: "lp-status small" });
  let clear: ReturnType<typeof setTimeout> | null = null;
  const status = (text: string, kind: "info" | "ok" | "error" | "busy" = "info") => {
    replace(statusEl, text);
    statusEl.className = "lp-status small " + kind;
    if (clear) clearTimeout(clear);
    // A large artboard delete may keep Photoshop modal for tens of seconds. Do not clear the
    // pending message after 3s while Photoshop is still working.
    clear = kind === "busy" ? null : setTimeout(() => replace(statusEl), kind === "error" ? 8000 : 3000);
  };
  const view = createLayerTreeView(svc.layers, status, svc.tools, svc.overlay, svc.host.canvasView ? id => svc.host.canvasView!(id) : undefined,
    (docId, layerId, sessionId, order) => svc.host.exportLayerPng(docId, layerId, sessionId, order),
    docId => svc.host.docVersion(docId),
    (docId, layerId, kind) => svc.host.layerDragInfo(docId, layerId, kind),
    // the connection belongs to the Studio panel and may come later than this one: looked up each time
    svc.bridgePs ? {
      ready: () => !!svc.overlay?.illustrator,
      push: (docId, ids) => svc.overlay?.illustrator ? pushToIllustrator(svc.overlay, svc.host, svc.bridgePs!, docId, ids) : Promise.reject(new Error("Illustrator 的 WaveLayer 面板没有连接")),
      pushBoard: (docId, layers, selected) => svc.overlay?.illustrator ? pushBoardToIllustrator(svc.overlay, svc.host, svc.bridgePs!, docId, layers, selected) : Promise.reject(new Error("Illustrator 的 WaveLayer 面板没有连接")),
      linkOf: (docId, layerId) => linkOfLayer(docId, layerId),
      ask: (kind, link) => { if (svc.overlay) askIllustrator(svc.overlay, kind, link); },
    } : undefined);
  const dropEl = h("div", { class: "lp-drop" });
  const panel = h("div", { class: "lp" }, view.el, statusEl, dropEl);
  replace(root, panel);
  mountFileDrop(panel, dropEl, svc, status, () => void view.refresh());
  // hover help is the host's own tooltip from `title` (1.2: the panel's drawn .tip box showed a second copy)
  svc.layers.onChange(() => { if (isShown()) void view.refresh(); });
  return { show: () => void view.refresh() };
}

/** 拖拽文件置入: files dragged from the file manager onto the panel are placed into the active
 *  document (core/layers/fileDrop.ts: dropped on the upper half embedded, on the lower half linked). WaveLayer's own
 *  layer drags are mouse events, so they never get here.
 *
 *  11-15 first try in Photoshop: nothing happened and no `file drop` line was logged, so drop never
 *  reached the handler. Now every drag is let in (no filtering on dataTransfer.types, which UXP may
 *  not fill as browsers do: without preventDefault on dragover there is no drop), the events are
 *  heard on the panel and on the document (in case UXP doesn't bubble them), and each drag is logged
 *  (`file drag` / `file drop`) with what the event carried. */
function mountFileDrop(panel: HTMLElement, dropEl: HTMLElement, svc: Services, status: (text: string, kind?: "info" | "ok" | "error" | "busy") => void, refresh: () => void) {
  const place = svc.host.placeDroppedFiles?.bind(svc.host);
  if (!place) return;
  let hide: ReturnType<typeof setTimeout> | null = null, busy = false, loggedAt = 0;
  const handled = new WeakSet<Event>();
  // the zone under the pointer (上半 嵌入, 下半 链接) is the mode; UXP gives no Alt during a drag
  let hoverCount = 0, zone: "embedded" | "linked" = "embedded", shown = "", fromWeb = false;
  // 从网页拖入 through the helper: UXP only passes text, the helper's drop catcher (webdrop.rs)
  // over this area reads the whole drag (the image itself, like other Windows programs do)
  let catching = false, webFolder: string | null = null;
  void svc.host.webDropFolder?.().then(f => { webFolder = f; }, () => undefined);
  const startCatch = (e: any) => {
    const ov = svc.overlay, r = dropEl.getBoundingClientRect?.();
    if (!ov || !webFolder || !r || !r.width || !Number.isFinite(Number(e?.clientX))) return;
    catching = ov.webCatch({ clientX: Number(e.clientX), clientY: Number(e.clientY), left: r.left, top: r.top, width: r.width, height: r.height, folder: webFolder });
    log("info", "web catch", JSON.stringify({ asked: catching, x: e.clientX, y: e.clientY, w: r.width, h: r.height }));
  };
  const paint = () => {
    const key = zone + hoverCount + fromWeb;
    if (key === shown) return;
    shown = key;
    // from a browser: no files, one zone (images are downloaded and embedded, words become text)
    const zones = fromWeb ? [{ mode: "embedded" as const, title: "置入网页内容", sub: "图片下载后嵌入为智能对象；文字新建文字图层" }] : fileDropZones(hoverCount);
    const lit = fromWeb ? "embedded" : zone;
    replace(dropEl, ...zones.map(z =>
      h("div", { class: "lp-drop-zone " + z.mode + (z.mode === lit ? " on" : "") },
        h("div", { class: "lp-drop-icon" }, icon(fromWeb ? "image" : z.mode === "linked" ? "psLink" : "psSmart", z.mode === lit ? 56 : 28)),
        h("div", { class: "lp-drop-title" }, z.title),
        h("div", { class: "lp-drop-sub" }, z.sub))));
  };
  const zoneOf = (e: any) => {
    const r = dropEl.getBoundingClientRect?.(), y = Number(e?.clientY);
    if (!r || !r.height || !Number.isFinite(y)) return zone;
    return fileDropZoneAt((y - r.top) / r.height);
  };
  const off = () => {
    if (hide) clearTimeout(hide);
    hide = null; hoverCount = 0; shown = ""; fromWeb = false;
    if (catching) { catching = false; svc.overlay?.webCatch(null); }
    panel.classList.remove("dropping");
  };
  /** this panel's drag: on the panel, or on no particular element (the document, its body). The
   *  Studio panel lives in the same document: a drag over it is not this panel's. */
  const ours = (e: any) => {
    const t = e?.target;
    if (!t || t === document || t === document.body || t === document.documentElement) return true;
    try { return panel.contains(t); } catch { return true; }
  };
  const describe = (e: any, via: string) => {
    const dt = e?.dataTransfer, t = e?.target;
    let entries: number | string = "none", files: number | string = "none";
    try { entries = dt?.uxpEntries ? Array.from(dt.uxpEntries).length : "none"; } catch (x) { entries = "error " + (x as Error)?.message; }
    try { files = dt?.files ? dt.files.length : "none"; } catch (x) { files = "error " + (x as Error)?.message; }
    return {
      ev: e?.type, via, dt: !!dt, types: (() => { try { return Array.from(dt?.types ?? []); } catch { return "error"; } })(),
      entries, files, alt: !!e?.altKey, y: e?.clientY, target: t ? `${t.tagName ?? t.nodeName ?? "?"}.${String(t.className ?? "").slice(0, 40)}` : null,
    };
  };
  const over = (via: string) => (e: any) => {
    if (handled.has(e) || !ours(e)) return;
    handled.add(e);
    e.preventDefault?.();
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } catch { /* read-only in some hosts */ }
    const now = Date.now();
    if (now - loggedAt > 1500) { loggedAt = now; log("info", "file drag", JSON.stringify(describe(e, via))); }
    if (!panel.classList.contains("dropping")) {
      panel.classList.add("dropping");
      try { hoverCount = droppedFiles(e.dataTransfer).length; } catch { hoverCount = 0; }
      let types: string[] = [];
      try { types = Array.from(e.dataTransfer?.types ?? []); } catch { /* none */ }
      fromWeb = !hoverCount && !types.includes("application/uxp-entry-type") && !types.includes("Files") && types.some(t => /^text\//i.test(t));
      if (fromWeb) startCatch(e);
    }
    zone = zoneOf(e);
    paint();
    // dragleave also fires between the panel's own children, and UXP sends dragover only while the
    // pointer moves: the overlay goes once nothing came for a while, or the pointer left the panel
    if (hide) clearTimeout(hide);
    // while the helper holds the drag, UXP hears nothing more: its answer ends the overlay
    hide = setTimeout(off, catching ? 60000 : 1500);
  };
  svc.overlay?.onWebDrop(ev => {
    if (!catching) return;
    catching = false;
    off();
    if (ev.type === "web-drop-leave") return;
    log("info", "web drop (helper)", JSON.stringify({ files: ev.files.length, formats: ev.formats, html: ev.html.length, url: ev.url.slice(0, 160), text: ev.text.length }));
    if (busy) { status("上一批文件还在置入", "info"); return; }
    if (ev.files.length) { void placeWebFiles(ev.files); return; }
    void dropWebTexts([{ type: "text/html", text: ev.html }, { type: "text/uri-list", text: ev.url }, { type: "text/plain", text: ev.text }].filter(t => t.text), ev.formats);
  });
  async function placeWebFiles(files: { file: string; name: string }[]) {
    if (!svc.host.webDropItems) return;
    busy = true;
    try {
      status(`正在置入 ${files.length} 张网页图片…`, "busy");
      const got = await svc.host.webDropItems(files);
      const done = got.items.length ? await place!(got.items) : { linked: 0, embedded: 0, opened: 0, failed: [] as string[] };
      const r = webDropResultText({ placed: done.embedded + done.linked + done.opened, failed: [...got.failed, ...done.failed] });
      status(r.text, r.kind);
      refresh();
    } catch (err) {
      log("error", "web drop failed", err);
      status("置入失败：" + ((err as Error)?.message ?? err), "error");
    } finally { busy = false; }
  }
  const leave = (e: any) => {
    // the helper's catcher coming over the panel makes UXP see the drag leave: not the end
    if (catching) return;
    const r = panel.getBoundingClientRect?.(), x = Number(e?.clientX), y = Number(e?.clientY);
    if (r && Number.isFinite(x) && Number.isFinite(y) && (x <= r.left || x >= r.right || y <= r.top || y >= r.bottom)) off();
  };
  const drop = (via: string) => (e: any) => {
    if (handled.has(e) || !ours(e)) return;
    handled.add(e);
    const mode = panel.classList.contains("dropping") ? zoneOf(e) : zone;
    off();
    e.preventDefault?.();
    e.stopPropagation?.();
    const dt = e?.dataTransfer;
    const raw = droppedFiles(dt);
    log("info", "file drop", JSON.stringify({ ...describe(e, via), got: raw.length, names: raw.slice(0, 5).map(f => f.name) }));
    if (busy) { status("上一批文件还在置入", "info"); return; }
    if (!raw.length) { void dropWeb(dt); return; }
    const plan = planFileDrop(raw, false, mode);
    if (!plan.items.length) { const r = fileDropResultText({ linked: 0, embedded: 0, opened: 0, failed: [] }, plan); status(r.text, r.kind); return; }
    busy = true;
    status(`正在置入 ${plan.items.length} 个文件…`, "busy");
    place(plan.items).then(
      done => { const r = fileDropResultText(done, plan); status(r.text, r.kind); refresh(); },
      err => { log("error", "file drop failed", err); status("置入失败：" + ((err as Error)?.message ?? err), "error"); },
    ).finally(() => { busy = false; });
  };
  /** 从网页拖入: no files, only text — image addresses are downloaded and embedded, words become a text layer */
  async function dropWeb(dt: any) {
    const texts: { type: string; text: string }[] = [];
    let types: string[] = [];
    try { types = Array.from(dt?.types ?? []); } catch { /* none */ }
    for (const type of [...new Set(["text/uri-list", "text/html", "text/plain", ...types])]) {
      try { const text = String(dt?.getData?.(type) ?? ""); if (text) texts.push({ type, text }); } catch { /* not offered */ }
    }
    log("info", "web drop", JSON.stringify({ types, got: texts.map(t => `${t.type}:${t.text.length}`), head: texts[0]?.text.slice(0, 160) ?? "" }));
    await dropWebTexts(texts, types);
  }
  async function dropWebTexts(texts: { type: string; text: string }[], formats: string[]) {
    const what = webDrop(texts);
    log("info", "web drop kind", JSON.stringify({ formats, kind: what?.kind ?? null }));
    if (!what) { status("拖入的内容里没有图片或文字", "error"); return; }
    busy = true;
    try {
      if (what.kind === "text") {
        if (!svc.host.addDroppedText) { status("这里不支持置入文字", "error"); return; }
        status("正在新建文字图层…", "busy");
        await svc.host.addDroppedText(what.text);
        status(`已新建文字图层（${what.text.length} 个字）`, "ok");
      } else {
        if (!svc.host.downloadDropImages) { status("这里不支持置入网页图片", "error"); return; }
        status(`正在下载 ${what.urls.length} 张网页图片…`, "busy");
        const got = await svc.host.downloadDropImages(what.urls);
        let placed = 0;
        const failed = [...got.failed];
        if (got.files.length) {
          const done = await place!(got.files);
          placed = done.embedded + done.linked + done.opened;
          failed.push(...done.failed);
        }
        const r = webDropResultText({ placed, failed });
        status(r.text, r.kind);
      }
      refresh();
    } catch (err) {
      log("error", "web drop failed", err);
      status("置入失败：" + ((err as Error)?.message ?? err), "error");
    } finally { busy = false; }
  }
  for (const [target, via] of [[panel, "panel"], [document, "document"]] as const) {
    target.addEventListener("dragenter", over(via), true);
    target.addEventListener("dragover", over(via), true);
    target.addEventListener("drop", drop(via), true);
    target.addEventListener("dragleave", leave, true);
  }
}

/** What a drop carried, each with a name: UXP entries (dataTransfer.uxpEntries), else File objects
 *  (a browser; in UXP they may carry a native path), else file paths in the text the drag offers. */
function droppedFiles(dt: any): { file: unknown; name: string }[] {
  const named = (f: any) => ({ file: f, name: fileBaseName(String(f?.name || f?.nativePath || f?.path || "")) });
  try { const entries = Array.from(dt?.uxpEntries ?? []) as any[]; if (entries.length) return entries.map(named); } catch (e) { log("warn", "file drop entries", e); }
  try { const files = Array.from(dt?.files ?? []) as any[]; if (files.length) return files.map(named); } catch (e) { log("warn", "file drop files", e); }
  let types: string[] = [];
  try { types = Array.from(dt?.types ?? []); } catch { /* none */ }
  for (const type of ["text/uri-list", "text/plain", ...types]) {
    let text = "";
    try { text = String(dt?.getData?.(type) ?? ""); } catch { continue; }
    const paths = pathsFromDropText(text);
    if (paths.length) return paths.map(p => ({ file: { nativePath: p, name: fileBaseName(p) }, name: fileBaseName(p) }));
  }
  return [];
}
