// Photoshop entry point.

import { ComfyClient } from "./core/comfy/client.ts";
import type { Services } from "./app/services.ts";
import { UxpHost } from "./ps/uxpHost.ts";
import { log, setLogSink } from "./app/log.ts";
import { mountApp } from "./ui/app.ts";
import { diagnose, uxpFetch } from "./ps/net.ts";

declare const require: (m: string) => any;

const uxp = require("uxp");
const { localFileSystem: fs, formats } = uxp.storage;
const VERSION = "0.2.4";

// Diagnostic log: plugin data folder, mirrored into the project's reports folder on F: when that
// drive is reachable, so it can be read without the UXP developer console.
const MIRROR = ["file:F:/waveplug/studio/reports/uxp_runtime.log", "file:///F:/waveplug/studio/reports/uxp_runtime.log"];
async function openLog(): Promise<any[]> {
  const files: any[] = [];
  try {
    const dir = await fs.getDataFolder();
    try { files.push(await dir.getEntry("waveplug.log")); } catch { files.push(await dir.createFile("waveplug.log", { overwrite: false })); }
  } catch (e) { console.warn("data-folder log unavailable", e); }
  for (const url of MIRROR) {
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

const services: Services = {
  host: new UxpHost(),
  comfy: base => new ComfyClient(base, { fetch: uxpFetch, WebSocket }),
  diagnose,
  debugSave(name, png) {
    void (async () => {
      for (const url of [`file:F:/waveplug/studio/reports/debug_${name}`, `file:///F:/waveplug/studio/reports/debug_${name}`]) {
        try { const f = await fs.createEntryWithUrl(url, { overwrite: true }); await f.write(png, { format: formats.binary }); return; } catch { /* next form */ }
      }
    })();
  },
  async pickJson() {
    const f = await fs.getFileForOpening({ types: ["json"] });
    return f ? { name: f.name, text: await f.read({ format: formats.utf8 }) } : null;
  },
  async pickImage() {
    const f = await fs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"] });
    if (!f) return null;
    const bytes = new Uint8Array(await f.read({ format: formats.binary }));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const mime = /\.png$/i.test(f.name) ? "image/png" : /\.webp$/i.test(f.name) ? "image/webp" : "image/jpeg";
    return { name: f.name, bytes, url: `data:${mime};base64,${btoa(bin)}` };
  },
  async saveImage(png, suggested) {
    const f = await fs.getFileForSaving(suggested, { types: ["png"] });
    if (!f) return false;
    await f.write(png, { format: formats.binary });
    return true;
  },
  version: VERSION,
};

try {
  mountApp(document.getElementById("app")!, services);
} catch (e) {
  log("error", "mount failed", e);
  document.getElementById("app")!.textContent = "WavePlug Studio 启动失败：" + (e as Error).message;
}
