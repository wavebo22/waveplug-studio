// WavePlug 图层: the layer list as a panel of its own, which docks and groups with Photoshop's
// panels like the Layers panel does. Refreshes only while it is shown.

import type { Services } from "../app/services.ts";
import { createLayerTreeView } from "./layerTree.ts";
import { askIllustrator, linkOfLayer, pushBoardToIllustrator, pushToIllustrator } from "../app/illustratorBridge.ts";
import { h, icon, replace } from "./dom.ts";
import { type FileDropSpot, fileBaseName, fileDropResultText, webDrop, webDropResultText, pathsFromDropText, planFileDrop } from "../core/layers/fileDrop.ts";
import { log } from "../app/log.ts";
import { createHintBar, type HintBar } from "./hintBar.ts";
import { NO_KEYS, hintItems } from "../core/layers/hints.ts";

export function mountLayersPanel(root: HTMLElement, svc: Services, isShown: () => boolean) {
  // 提示栏 (Blender-style status bar): hints for the pointer, the panel's state, the last results.
  // A busy message (a long artboard delete …) stays until its result; errors stay until the next one.
  const hintBar = createHintBar(svc.overlay);
  const status = (text: string, kind: "info" | "ok" | "error" | "busy" = "info") => hintBar.message(text, kind);
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
    } : undefined, hintBar);
  const dropEl = h("div", { class: "lp-drop" });
  const panel = h("div", { class: "lp" }, view.el, hintBar.el, dropEl);
  replace(root, panel);
  mountFileDrop(panel, dropEl, svc, status, () => void view.refresh(), hintBar, view);
  // hover help is the host's own tooltip from `title` (1.2: the panel's drawn .tip box showed a second copy)
  svc.layers.onChange(() => { if (isShown()) void view.refresh(); });
  // the helper draws the hints along the bottom of the canvas: tell it where the canvas is (one
  // property read every 2 s while the panel is shown), and take them off when the panel is hidden
  // (read when the document changes and then every 10 s: each read is four Photoshop queries)
  let viewReading = false, viewDoc: number | null = null, viewAt = 0;
  setInterval(() => {
    const shown = isShown();
    hintBar.active(shown);
    const doc = view.docId();
    if (!shown || viewReading || doc === null || !svc.overlay?.statusBarReady || !svc.host.canvasView) return;
    if (doc === viewDoc && Date.now() - viewAt < 10_000) return;
    viewReading = true; viewDoc = doc; viewAt = Date.now();
    svc.host.canvasView(doc).then(v => hintBar.view(v?.view ?? null), () => undefined).finally(() => { viewReading = false; });
  }, 1000);
  return { show: () => void view.refresh() };
}

/** 拖拽文件置入: files dragged from the file manager onto the panel are placed into the active
 *  document at the insertion line under the pointer (drawn by the list, like a layer drag); embedded,
 *  or linked while Alt is held — UXP tells a panel no keys during a drag, the helper reads them
 *  (watch-keys). WaveLayer's own layer drags are mouse events, so they never get here.
 *
 *  11-15 first try in Photoshop: nothing happened and no `file drop` line was logged, so drop never
 *  reached the handler. Now every drag is let in (no filtering on dataTransfer.types, which UXP may
 *  not fill as browsers do: without preventDefault on dragover there is no drop), the events are
 *  heard on the panel and on the document (in case UXP doesn't bubble them), and each drag is logged
 *  (`file drag` / `file drop`) with what the event carried. */
type DropSpotView = { fileDropSpot(target: EventTarget | null, offsetY: number | undefined, link: boolean): (FileDropSpot & { label: string }) | null; clearFileDropSpot(): void };
function mountFileDrop(panel: HTMLElement, dropEl: HTMLElement, svc: Services, status: (text: string, kind?: "info" | "ok" | "error" | "busy") => void, refresh: () => void, hintBar: HintBar, view: DropSpotView) {
  const place = svc.host.placeDroppedFiles?.bind(svc.host);
  if (!place) return;
  let hide: ReturnType<typeof setTimeout> | null = null, busy = false, loggedAt = 0;
  const handled = new WeakSet<Event>();
  // Alt (from the helper, or the event if UXP ever fills it) links; the line under the pointer is where
  let hoverCount = 0, shown = "", fromWeb = false, alt = false, spot: (FileDropSpot & { label: string }) | null = null, keysAt = 0;
  let lastOver: { target: EventTarget | null; offsetY: unknown } | null = null;
  svc.overlay?.onKeys(k => {
    if (alt === k.alt || !panel.classList.contains("dropping")) return;
    alt = k.alt;
    if (lastOver) spotOf(lastOver); // the line takes the link colour
    paint();
  });
  /** keep the helper reporting keys while the drag lasts (it stops 3 s after the last ask) */
  const watchKeys = () => { const now = Date.now(); if (now - keysAt > 1000) { keysAt = now; svc.overlay?.watchKeys(true); } };
  // 从网页拖入 through the helper: UXP only passes text, the helper's drop catcher (webdrop.rs)
  // over this area reads the whole drag (the image itself, like other Windows programs do)
  let catching = false, webFolder: string | null = null, webSpot: FileDropSpot | null = null;
  void svc.host.webDropFolder?.().then(f => { webFolder = f; }, () => undefined);
  const startCatch = (e: any) => {
    const ov = svc.overlay, r = dropEl.getBoundingClientRect?.();
    if (!ov || !webFolder || !r || !r.width || !Number.isFinite(Number(e?.clientX))) return;
    catching = ov.webCatch({ clientX: Number(e.clientX), clientY: Number(e.clientY), left: r.left, top: r.top, width: r.width, height: r.height, folder: webFolder });
    log("info", "web catch", JSON.stringify({ asked: catching, x: e.clientX, y: e.clientY, w: r.width, h: r.height }));
  };
  /** the banner at the bottom of the panel: what letting go does, and where */
  const paint = () => {
    const mode = alt ? "linked" : "embedded";
    const key = mode + hoverCount + fromWeb + (spot?.label ?? "");
    if (key === shown) return;
    shown = key;
    hintBar.hints(hintItems({ mode: "fileDrag", fileDrag: { count: hoverCount, fromWeb }, keys: { ...NO_KEYS, alt } }));
    const n = hoverCount > 1 ? ` ${hoverCount} 个文件` : "";
    const where = spot ? `放到${spot.label}` : "放到当前图层上方";
    const title = fromWeb ? "置入网页内容" : mode === "linked" ? `链接置入${n}` : `嵌入为智能对象${n}`;
    const sub = fromWeb ? `图片嵌入、文字新建文字图层 · ${where}` : `${where} · ${mode === "linked" ? "松开 Alt：改为嵌入" : "按住 Alt：改为链接"}`;
    replace(dropEl, h("div", { class: "lp-drop-zone " + mode + " on" },
      h("div", { class: "lp-drop-icon" }, icon(fromWeb ? "image" : mode === "linked" ? "psLink" : "psSmart", 20)),
      h("div", { class: "lp-drop-text" }, h("div", { class: "lp-drop-title" }, title), h("div", { class: "lp-drop-sub" }, sub))));
  };
  /** the insertion line under the pointer (the list draws it) */
  const spotOf = (e: any) => { spot = view.fileDropSpot(e?.target ?? null, Number.isFinite(Number(e?.offsetY)) ? Number(e.offsetY) : undefined, alt && !fromWeb); };
  const off = () => {
    if (hide) clearTimeout(hide);
    hide = null; hoverCount = 0; shown = ""; fromWeb = false;
    if (keysAt) { svc.overlay?.watchKeys(false); keysAt = 0; }
    alt = false; lastOver = null;
    view.clearFileDropSpot();
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
    if (e.altKey) alt = true;
    lastOver = { target: e?.target ?? null, offsetY: e?.offsetY };
    watchKeys();
    spotOf(e);
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
    webSpot = spot ? { rel: spot.rel, place: spot.place } : null;
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
      const done = got.items.length ? await place!(got.items, webSpot) : { linked: 0, embedded: 0, opened: 0, failed: [] as string[] };
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
    if (panel.classList.contains("dropping")) spotOf(e);
    const mode = alt || e?.altKey ? "linked" : "embedded", at = spot ? { rel: spot.rel, place: spot.place } : null;
    log("info", "file drop spot", JSON.stringify({ mode, at, label: spot?.label ?? null }));
    off();
    e.preventDefault?.();
    e.stopPropagation?.();
    const dt = e?.dataTransfer;
    const raw = droppedFiles(dt);
    log("info", "file drop", JSON.stringify({ ...describe(e, via), got: raw.length, names: raw.slice(0, 5).map(f => f.name) }));
    if (busy) { status("上一批文件还在置入", "info"); return; }
    if (!raw.length) { webSpot = at; void dropWeb(dt); return; }
    const plan = planFileDrop(raw, false, mode);
    if (!plan.items.length) { const r = fileDropResultText({ linked: 0, embedded: 0, opened: 0, failed: [] }, plan); status(r.text, r.kind); return; }
    busy = true;
    status(`正在置入 ${plan.items.length} 个文件…`, "busy");
    place(plan.items, at).then(
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
          const done = await place!(got.files, webSpot);
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
