// Photoshop entry point.

import { ComfyClient } from "./core/comfy/client.ts";
import type { Services } from "./app/services.ts";
import { UxpHost } from "./ps/uxpHost.ts";
import { UxpTools } from "./ps/uxpTools.ts";
import { UxpLayerTree } from "./ps/uxpLayers.ts";
import { log, setLogContext, setLogSink } from "./app/log.ts";
import { UxpChecker } from "./ps/uxpCheck.ts";
import { mountApp } from "./ui/app.ts";
import { mountLayersPanel } from "./ui/layersPanel.ts";
import { disposeGlobals } from "./ui/dom.ts";
import * as bridgePs from "./ps/uxpBridge.ts";
import { diagnose, uxpFetch } from "./ps/net.ts";
import { dumpStorage, importPlan, MOVED_FLAG } from "./core/storageMove.ts";

declare const require: (m: string) => any;

const uxp = require("uxp");
const { localFileSystem: fs, formats } = uxp.storage;
declare const __BUILT_AT__: string;
const VERSION = "1.3.2";
// one plugin for users and development: the loader (plugin/loader.js) runs either the build in the
// development folder ("dev": live reload, logs mirrored to reports\) or the one inside the plugin
// The old separate development plugin (com.waveplug.studio.dev) runs this code through its old
// loader, which sets no __waveplugSource: still the development build, and it hands its data over.
const OLD_DEV_PLUGIN = typeof (globalThis as any).__waveplugDevReload === "function" && (globalThis as any).__waveplugSource === undefined;
const DEV = (globalThis as any).__waveplugSource === "dev" || OLD_DEV_PLUGIN;
const DEV_ROOT: string = (globalThis as any).__waveplugDevRoot ?? "G:/waveplug/studio/dist/plugin/";

// Diagnostic log: plugin data folder, mirrored into the project's reports folder on G: when that
// drive is reachable, so it can be read without the UXP developer console.
const MIRROR = ["file:G:/waveplug/studio/reports/uxp_runtime.log", "file:///G:/waveplug/studio/reports/uxp_runtime.log"];
/** A log file past this size is set aside as *.prev.log when the plugin starts (one generation kept). */
const LOG_MAX_BYTES = 4 * 1024 * 1024;
/** The data folder's file `name`, started afresh when it has grown past LOG_MAX_BYTES. */
async function dataLog(dir: any, name: string): Promise<any> {
  let f: any;
  try { f = await dir.getEntry(name); } catch { return dir.createFile(name, { overwrite: false }); }
  try {
    const size = Number((await f.getMetadata())?.size ?? 0);
    if (size > LOG_MAX_BYTES) {
      await f.moveTo(dir, { newName: name.replace(/\.log$/, ".prev.log"), overwrite: true });
      return dir.createFile(name, { overwrite: true });
    }
  } catch (e) { console.warn("log rotation", name, e); }
  return f;
}
/** `all`: every line; `problems`: warnings and errors only (waveplug-errors.log, short enough to read) */
async function openLog(): Promise<{ all: any[]; problems: any[] }> {
  const all: any[] = [], problems: any[] = [];
  try {
    const dir = await fs.getDataFolder();
    all.push(await dataLog(dir, "waveplug.log"));
    problems.push(await dataLog(dir, "waveplug-errors.log"));
  } catch (e) { console.warn("data-folder log unavailable", e); }
  for (const url of DEV ? MIRROR : []) {
    try { all.push(await fs.getEntryWithUrl(url)); break; } catch { /* not there yet */ }
    try { all.push(await fs.createEntryWithUrl(url, { overwrite: false })); break; } catch { /* try next form */ }
  }
  for (const url of DEV ? MIRROR.map(u => u.replace("uxp_runtime.log", "uxp_errors.log")) : []) {
    try { problems.push(await fs.getEntryWithUrl(url)); break; } catch { /* not there yet */ }
    try { problems.push(await fs.createEntryWithUrl(url, { overwrite: false })); break; } catch { /* try next form */ }
  }
  return { all, problems };
}
let logFiles: ReturnType<typeof openLog> | null = null;
setLogSink(async (line, level) => {
  logFiles ??= openLog();
  const files = await logFiles;
  for (const f of files.all) { try { await f.write(line, { append: true, format: formats.utf8 }); } catch { /* keep going */ } }
  if (level !== "info") for (const f of files.problems) { try { await f.write(line, { append: true, format: formats.utf8 }); } catch { /* keep going */ } }
});
// what a report needs to say about where it ran
{
  let photoshop = "", os = "";
  try { const h = uxp.host ?? {}; photoshop = `${h.name ?? "Photoshop"} ${h.version ?? ""} ${h.uiLocale ?? ""}`.trim(); } catch { /* unknown */ }
  try { const o = require("os"); os = `${o.platform?.() ?? ""} ${o.release?.() ?? ""} ${o.arch?.() ?? ""}`.trim(); } catch { /* unknown */ }
  setLogContext({ 插件版本: DEV ? `dev · ${__BUILT_AT__}` : VERSION, 构建时间: __BUILT_AT__, Photoshop: photoshop, 系统: os, UXP: uxp.versions ?? {}, 外置框架: "未连接" });
}
log("info", "==== session start ====", DEV ? `dev · ${__BUILT_AT__}` : VERSION);
log("info", "uxp", JSON.stringify(uxp.versions ?? {}), "host", JSON.stringify(uxp.host ?? {}));
// errors nothing caught: without these they only reach the developer console
try {
  const onError = (e: any) => log("error", "uncaught", e?.error ?? e?.message ?? e, e?.filename ? `${e.filename}:${e.lineno}:${e.colno}` : "");
  const onRejection = (e: any) => log("error", "unhandled rejection", e?.reason ?? e);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
} catch (e) { console.warn("global error handlers", e); }

const host = new UxpHost();

// lets the development loader detach this build's Photoshop listeners, document / window listeners
// and timers before loading a new one
const layerTree = new UxpLayerTree();
// the loader calls the old build's dispose before it reads the files, so several quick ⟳ can each
// start a build: the one that started just before this one is still running, stop it here
try { (globalThis as any).__waveplugDispose?.(); } catch { /* old build */ }
// 开发版: a new build (npm run build / update.cmd writes dist/plugin/build-stamp.txt last) is loaded
// by itself, as if ⟳ had been clicked
let devWatch: ReturnType<typeof setInterval> | null = null;
if (DEV) {
  let seen: string | null = null, busy = false;
  const STAMP = [`file:${DEV_ROOT}build-stamp.txt`, `file:///${DEV_ROOT}build-stamp.txt`];
  devWatch = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let text: string | null = null;
      for (const url of STAMP) { try { text = String(await (await fs.getEntryWithUrl(url)).read({ format: formats.utf8 })).trim(); break; } catch { /* next form */ } }
      if (text === null) return;
      if (seen === null) { seen = text; return; }
      if (text !== seen) { seen = text; log("info", "dev build changed, reloading", text); (globalThis as any).__waveplugDevReload(); }
    } finally { busy = false; }
  }, 2000);
}
(globalThis as any).__waveplugDispose =() => { if (devWatch) clearInterval(devWatch); host.dispose(); layerTree.dispose(); disposeGlobals(); };

const tools = new UxpTools();
const services: Services = {
  host,
  tools,
  checker: new UxpChecker(tools),
  layers: layerTree,
  bridgePs,
  comfy: base => new ComfyClient(base, { fetch: uxpFetch, WebSocket }),
  aiFetch: uxpFetch,
  diagnose,
  debugSave: DEV ? (name, png) => {
    void (async () => {
      for (const url of [`file:G:/waveplug/studio/reports/debug_${name}`, `file:///G:/waveplug/studio/reports/debug_${name}`]) {
        try { const f = await fs.createEntryWithUrl(url, { overwrite: true }); await f.write(png, { format: formats.binary }); return; } catch { /* next form */ }
      }
    })();
  } : undefined,
  async pickLauncher() {
    const f = await fs.getFileForOpening({ types: ["bat", "cmd", "exe"] });
    return f ? f.nativePath : null;
  },
  async launch(path) {
    // Legacy manual launcher; process lifecycle is managed by the native helper.
    try { const r = await uxp.shell.openPath(path); return r ? String(r) : null; }
    catch (e) { return (e as Error).message; }
  },
  async launchOverlay() {
    // The exe itself, never a .cmd: a GUI program shows no terminal, and nothing else has to stay
    // in step with it. (Until 11-06 the dev build started dist\waveplug-overlay-dev.cmd, which
    // the hover POC rollback removed, so the helper silently stopped starting with Photoshop.)
    // Dev: build.cmd's dist\waveplug-overlay.exe (its log goes to reports\). Release: the copy
    // packed beside the manifest. Both paths stay the same across updates; the files are swapped
    // in place (see native/overlay/src/life.rs), so Photoshop's launch permission keeps applying.
    let path = "";
    try {
      if (DEV) path = "G:\\waveplug\\studio\\dist\\waveplug-overlay.exe";
      else path = (await (await fs.getPluginFolder()).getEntry("waveplug-overlay.exe")).nativePath;
    } catch (e) { return "插件文件夹里没有 waveplug-overlay.exe：" + (e as Error).message; }
    try {
      const r = await uxp.shell.openPath(path, "启动 WavePlug 外置框架（外置面板和 ComfyUI 进程管理，不显示命令行窗口）。");
      return r ? `${String(r)}（${path}）` : null;
    } catch (e) { return `${(e as Error).message}（${path}）`; }
  },
  async pickJson() {
    const f = await fs.getFileForOpening({ types: ["json"] });
    return f ? { name: f.name, text: await f.read({ format: formats.utf8 }) } : null;
  },
  async pickImage() {
    const f = await fs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"] });
    if (!f) return null;
    const bytes = new Uint8Array(await f.read({ format: formats.binary }));
    // the panel shows a 128 px copy, not the whole file as base64; without one it shows the file type
    let url: string | undefined;
    try {
      url = await host.imageFileThumbnail(f, 128);
      log("info", "reference thumbnail ready", f.name, `source=${bytes.byteLength}`, `preview=${url.length}`);
    } catch (e) {
      log("warn", "reference thumbnail", f.name, e);
    }
    return { name: f.name, bytes, url };
  },
  async writeTextAt(nativePath, text) {
    const p = nativePath.replace(/\\/g, "/");
    for (const url of [`file:${p}`, `file:///${p}`]) {
      try { const f = await fs.createEntryWithUrl(url, { overwrite: true }); await f.write(text, { format: formats.utf8 }); return true; }
      catch { /* next form */ }
    }
    return false;
  },
  async saveText(text, suggested) {
    const f = await fs.getFileForSaving(suggested, { types: ["txt"] });
    if (!f) return false;
    await f.write(text, { format: formats.utf8 });
    return true;
  },
  async saveImage(png, suggested) {
    const f = await fs.getFileForSaving(suggested, { types: ["png"] });
    if (!f) return false;
    await f.write(png, { format: formats.binary });
    return true;
  },
  version: DEV ? `dev · ${__BUILT_AT__}` : `${VERSION} 测试版`,
  devReload: DEV ? () => (globalThis as any).__waveplugDevReload() : undefined,
  loadFrom: typeof (globalThis as any).__waveplugDevReload === "function" ? {
    source: DEV ? "dev" : "bundled",
    devRoot: DEV_ROOT,
    devMissing: String((globalThis as any).__waveplugDevMissing ?? ""),
    set(to) {
      try { localStorage.setItem("wp.loadFrom", to); } catch { /* storage off */ }
      log("info", "load from", to);
      (globalThis as any).__waveplugDevReload();
    },
  } : undefined,
};

// Two panels: WavePlug Studio and WavePlug 图层 (the layer list on its own, dockable like
// Photoshop's Layers panel). The development loader registers them itself (setup can only run once,
// before the build is read); an older loader without them shows the Studio panel only.
interface Panels { root(name: PanelName): HTMLElement; isShown(name: PanelName): boolean; onShow(cb: (name: PanelName, shown: boolean) => void): void }
type PanelName = "studio" | "layers";
function releasePanels(): Panels {
  const roots = { studio: document.getElementById("app")!, layers: document.getElementById("layers-app")! };
  const shown = { studio: false, layers: false };
  const listeners: ((name: PanelName, shown: boolean) => void)[] = [];
  const on = (name: PanelName, value: boolean, arg: any) => {
    const node = arg?.node ?? arg;
    if (value && node?.appendChild && roots[name].parentNode !== node) node.appendChild(roots[name]);
    shown[name] = value;
    listeners.forEach(cb => cb(name, value));
  };
  const panel = (name: PanelName) => ({ show: (a: any) => on(name, true, a), hide: (a: any) => on(name, false, a) });
  uxp.entrypoints.setup({ panels: { studio: panel("studio"), layers: panel("layers") } });
  return { root: n => roots[n], isShown: n => shown[n], onShow: cb => listeners.push(cb) };
}
const panels: Panels | null = (globalThis as any).__waveplugPanels ?? releasePanels();
/** the element a panel mounts into: the loader's root holds a fresh #app / #layers-app */
const mountPoint = (name: PanelName, id: string): HTMLElement | null =>
  (panels?.root(name).querySelector("#" + id) as HTMLElement | null) ?? panels?.root(name) ?? document.getElementById(id);

const appEl = mountPoint("studio", "app")!;
try {
  mountApp(appEl, services);
} catch (e) {
  log("error", "mount failed", e);
  appEl.textContent = "WavePlug Studio 启动失败：" + (e as Error).message;
}
if (panels) {
  const layersEl = mountPoint("layers", "layers-app")!;
  try {
    const lp = mountLayersPanel(layersEl, services, () => panels.isShown("layers"));
    panels.onShow((name, shown) => { if (name === "layers" && shown) lp.show(); });
    if (panels.isShown("layers")) lp.show();
  } catch (e) {
    log("error", "layers panel mount failed", e);
    layersEl.textContent = "WavePlug 图层 启动失败：" + (e as Error).message;
  }
}

// ── the old development plugin's data → the one plugin (src/core/storageMove.ts) ──
// file in the development folder's parent (dist\), reachable by both plugins on this computer
const MOVE_FILE = DEV_ROOT.replace(/[^/]+\/$/, "") + "dev-plugin-data.json";
void (async () => {
  try {
    if (OLD_DEV_PLUGIN) {
      const text = JSON.stringify(dumpStorage(localStorage));
      for (const url of [`file:${MOVE_FILE}`, `file:///${MOVE_FILE}`]) {
        try { const f = await fs.createEntryWithUrl(url, { overwrite: true }); await f.write(text, { format: formats.utf8 }); log("info", "dev plugin data written for the move", MOVE_FILE); return; }
        catch { /* next form */ }
      }
      return;
    }
    if (!DEV || localStorage.getItem(MOVED_FLAG)) return;
    let text: string | null = null;
    for (const url of [`file:${MOVE_FILE}`, `file:///${MOVE_FILE}`]) {
      try { text = String(await (await fs.getEntryWithUrl(url)).read({ format: formats.utf8 })); break; } catch { /* next form */ }
    }
    if (text === null) return;
    const plan = importPlan(text, false);
    for (const [k, v] of plan) localStorage.setItem(k, v);
    localStorage.setItem(MOVED_FLAG, new Date().toISOString());
    log("info", "took over the old dev plugin's data", plan.length);
    // the panels read settings / workflows when they mount: start again with the moved data
    if (plan.length) (globalThis as any).__waveplugDevReload?.();
  } catch (e) { log("warn", "dev plugin data move", e); }
})();
