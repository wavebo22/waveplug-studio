// WaveLayer for Illustrator: the CEP panel's entry (dist/ai/main.js). Connects the panel to
// Illustrator through CEP's evalScript and to Photoshop through the WavePlug helper.

import { createHost } from "./host.ts";
import { connectPs } from "./bridge.ts";
import { mountPanel } from "./panel.ts";

declare const __BUILT_AT__: string;
const VERSION = "0.1.0";

const cep = (window as any).__adobe_cep__;

/** the extension's folder as a plain path (what CSInterface.getSystemPath("extension") gives) */
function extensionPath(): string {
  let p = decodeURI(String(cep.getSystemPath("extension")));
  p = /^file:\/\/\/[A-Za-z]:/.test(p) ? p.replace("file:///", "") : p.replace("file://", "");
  return p;
}

function evalScript(code: string): Promise<string> {
  return new Promise(resolve => cep.evalScript(code, (r: string) => resolve(r)));
}

/** loads the host script again: a new build takes effect without restarting Illustrator */
async function load() {
  const file = (extensionPath() + "/host/wavelayer.jsx").replace(/\\/g, "/");
  await evalScript(`$.evalFile(${JSON.stringify(file)})`);
}

/** Illustrator's panel colours: the panel background and a matching text colour. */
function applyTheme() {
  try {
    const env = JSON.parse(cep.getHostEnvironment());
    const c = env.appSkinInfo.panelBackgroundColor.color;
    const root = document.documentElement.style;
    root.setProperty("--c-bg", `rgb(${Math.round(c.red)}, ${Math.round(c.green)}, ${Math.round(c.blue)})`);
    const light = (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) > 150;
    document.documentElement.classList.toggle("light", light);
    root.setProperty("--c-text", light ? "#1f1f1f" : "#ececec");
  } catch { /* the defaults (dark) stay */ }
}

async function start() {
  applyTheme();
  try { cep.addEventListener("com.adobe.csxs.events.ThemeColorChanged", applyTheme); } catch { /* old CEP */ }
  await load();
  const host = createHost({ evalScript, load });
  const ps = connectPs();
  mountPanel(document.getElementById("app")!, { host, ps, version: `${VERSION} · ${__BUILT_AT__}`, reload: () => location.reload() });
  watchBuild();
}

/** the build stamp npm run build / update.cmd writes last (scripts/build.mjs), or null */
function readStamp(): string | null {
  const path = extensionPath() + "/build-stamp.txt";
  try {
    const r = (window as any).cep?.fs?.readFile(path);
    if (r && r.err === 0) return String(r.data).trim();
  } catch { /* no cep.fs */ }
  try {
    const x = new XMLHttpRequest();
    x.open("GET", "file:///" + path.replace(/^\/+/, ""), false);
    x.send();
    return x.responseText ? x.responseText.trim() : null;
  } catch { return null; }
}

/** a new build is loaded by itself (as if the panel's refresh button had been clicked) */
function watchBuild() {
  let seen = readStamp();
  setInterval(() => {
    const now = readStamp();
    if (!now) return;
    if (seen === null) { seen = now; return; }
    if (now !== seen) location.reload();
  }, 2000);
}

void start();
