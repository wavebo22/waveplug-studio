// Photoshop entry point.

import { ComfyClient } from "./core/comfy/client.ts";
import type { Services } from "./app/services.ts";
import { UxpHost } from "./ps/uxpHost.ts";
import { mountApp } from "./ui/app.ts";

declare const require: (m: string) => any;

const { localFileSystem: fs, formats } = require("uxp").storage;

const services: Services = {
  host: new UxpHost(),
  comfy: base => new ComfyClient(base, { fetch: fetch.bind(globalThis), WebSocket }),
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
  version: "0.1.0",
};

mountApp(document.getElementById("app")!, services);
