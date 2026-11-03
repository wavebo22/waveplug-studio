// Photoshop entry point.

import { ComfyClient } from "./core/comfy/client.ts";
import type { Services } from "./app/services.ts";
import { UxpHost } from "./ps/uxpHost.ts";
import { UxpTools } from "./ps/uxpTools.ts";
import { UxpLayerTree } from "./ps/uxpLayers.ts";
import { log, setLogSink } from "./app/log.ts";
import { mountApp } from "./ui/app.ts";
import { mountLayersPanel } from "./ui/layersPanel.ts";
import { disposeGlobals } from "./ui/dom.ts";
import { diagnose, uxpFetch } from "./ps/net.ts";

declare const require: (m: string) => any;

const uxp = require("uxp");
const { localFileSystem: fs, formats } = uxp.storage;
declare const __BUILT_AT__: string;
const VERSION = "1.1.0";
const DEV = typeof (globalThis as any).__waveplugDevReload === "function";

// Diagnostic log: plugin data folder, mirrored into the project's reports folder on F: when that
// drive is reachable, so it can be read without the UXP developer console.
const MIRROR = ["file:F:/waveplug/studio/reports/uxp_runtime.log", "file:///F:/waveplug/studio/reports/uxp_runtime.log"];
async function openLog(): Promise<any[]> {
  const files: any[] = [];
  try {
    const dir = await fs.getDataFolder();
    try { files.push(await dir.getEntry("waveplug.log")); } catch { files.push(await dir.createFile("waveplug.log", { overwrite: false })); }
  } catch (e) { console.warn("data-folder log unavailable", e); }
  for (const url of DEV ? MIRROR : []) {
    try { files.push(await fs.getEntryWithUrl(url)); break; } catch { /* not there yet */ }
    try { files.push(await fs.createEntryWithUrl(url, { overwrite: false })); break; } catch { /* try next form */ }
  }
  return files;
}
let logFiles: Promise<any[]> | null = null;
setLogSink(async line => {
  logFiles ??= openLog();
  for (const f of await logFiles) { try { await f.write(line, { append: true, format: formats.utf8 }); } catch { /* keep going */ } }
});
log("info", "uxp", JSON.stringify(uxp.versions ?? {}), "host", JSON.stringify(uxp.host ?? {}));

const host = new UxpHost();
// lets the development loader detach this build's Photoshop listeners, document / window listeners
// and timers before loading a new one
const layerTree = new UxpLayerTree();
// the loader calls the old build's dispose before it reads the files, so several quick ⟳ can each
// start a build: the one that started just before this one is still running, stop it here
try { (globalThis as any).__waveplugDispose?.(); } catch { /* old build */ }
(globalThis as any).__waveplugDispose =() => { host.dispose(); layerTree.dispose(); disposeGlobals(); };

const services: Services = {
  host,
  tools: new UxpTools(),
  layers: layerTree,
  comfy: base => new ComfyClient(base, { fetch: uxpFetch, WebSocket }),
  diagnose,
  debugSave: DEV ? (name, png) => {
    void (async () => {
      for (const url of [`file:F:/waveplug/studio/reports/debug_${name}`, `file:///F:/waveplug/studio/reports/debug_${name}`]) {
        try { const f = await fs.createEntryWithUrl(url, { overwrite: true }); await f.write(png, { format: formats.binary }); return; } catch { /* next form */ }
      }
    })();
  } : undefined,
  async pickLauncher() {
    const f = await fs.getFileForOpening({ types: ["bat", "cmd", "exe"] });
    return f ? f.nativePath : null;
  },
  async launch(path) {
    // shows Photoshop's own confirmation the first time; returns "" on success
    try { const r = await uxp.shell.openPath(path); return r ? String(r) : null; }
    catch (e) { return (e as Error).message; }
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
    try { url = await host.imageFileThumbnail(f, 128); } catch (e) { log("warn", "reference thumbnail", f.name, e); }
    return { name: f.name, bytes, url };
  },
  async saveImage(png, suggested) {
    const f = await fs.getFileForSaving(suggested, { types: ["png"] });
    if (!f) return false;
    await f.write(png, { format: formats.binary });
    return true;
  },
  version: DEV ? `dev · ${__BUILT_AT__}` : VERSION,
  devReload: DEV ? () => (globalThis as any).__waveplugDevReload() : undefined,
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
const panels: Panels | null = DEV ? (globalThis as any).__waveplugPanels ?? null : releasePanels();
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
