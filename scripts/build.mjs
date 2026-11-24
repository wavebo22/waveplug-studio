// Builds the UXP plugin into dist/plugin and the browser preview into dist/preview.
import { build, context } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const BUILT_AT = new Date().toISOString().slice(5, 16).replace("T", " ");
// 更新内容: the latest commits go into the build, the panel lists the unseen ones after an update
// (src/core/whatsNew.ts). No git (a copied source folder) = no list.
function recentChanges() {
  try {
    const out = execFileSync("git", ["log", "-n", "80", "--format=%H%x1f%cI%x1f%s%x1f%b%x1e"], { encoding: "utf8" });
    return out.split("\x1e").map(r => r.trim()).filter(Boolean).map(r => { const [hash, date, subject, body = ""] = r.split("\x1f"); return { hash, date, subject, body: body.trim() }; });
  } catch (e) { console.warn("git log failed, no 更新内容 in this build:", e.message); return []; }
}
const common = { define: { __BUILT_AT__: JSON.stringify(BUILT_AT), __CHANGES__: JSON.stringify(recentChanges()) }, bundle: true, external: ["photoshop", "uxp"], format: "iife", target: "es2020", charset: "utf8", logLevel: "info", sourcemap: false };

mkdirSync("dist/plugin", { recursive: true });
mkdirSync("dist/preview", { recursive: true });
for (const f of ["manifest.json", "index.html", "loader.js", "styles.css"]) cpSync(`plugin/${f}`, `dist/plugin/${f}`);
// an empty plugin/icons is not kept by git: a fresh clone has none
if (existsSync("plugin/icons")) cpSync("plugin/icons", "dist/plugin/icons", { recursive: true });
cpSync("plugin/styles.css", "dist/preview/styles.css");
cpSync("src/preview/preview.html", "dist/preview/index.html");
cpSync("src/preview/gallery.html", "dist/preview/gallery.html");
cpSync("tests/fixtures/ui/guhai_inpaint_ps.json", "dist/preview/fixture.json");
cpSync("tests/fixtures/ui/guhai_remove_inpaint_outpaint.json", "dist/preview/fixture_outpaint.json");
cpSync("tests/fixtures/ui/qwen_txt2img.json", "dist/preview/fixture_txt2img.json");
cpSync("tests/fixtures/ui/vosr2_upscale.json", "dist/preview/fixture_upscale.json");

// One plugin (com.waveplug.studio) for users and development: plugin/loader.js runs the build in
// G:\waveplug\studio\dist\plugin when that folder is reachable (live reload), else the one
// packed beside it. The separate development plugin (com.waveplug.studio.dev, dist/dev) is gone.

// The native helper is launched by UXP through launchProcess permission.
// Keep a copy beside each manifest so release plugins can resolve it with getPluginFolder().
// A copy that is running can't be overwritten: rename it out of the way first (it restarts into
// the new file by itself and removes the renamed one, native/overlay/src/life.rs).
const putHelper = to => {
  const from = "dist/waveplug-overlay.exe";
  if (existsSync(to)) {
    const a = statSync(from), b = statSync(to);
    if (a.size === b.size && a.mtimeMs <= b.mtimeMs) return;
    renameSync(to, to.replace(/\.exe$/, `.old-${Date.now()}.exe`));
  }
  cpSync(from, to);
};
if (existsSync("dist/waveplug-overlay.exe")) {
  for (const to of ["dist/plugin/waveplug-overlay.exe"]) {
    try { putHelper(to); } catch (e) { console.warn(`helper not copied to ${to}: ${e.message}`); }
  }
}
// renamed copies no longer running (a running one can't be removed: it goes next time)
for (const dir of ["dist", "dist/plugin"]) {
  for (const f of readdirSync(dir)) if (/^waveplug-overlay\.old-.*\.exe$/i.test(f)) { try { rmSync(`${dir}/${f}`); } catch { /* still running */ } }
}

// WaveLayer for Illustrator (CEP panel, ai/): dist/ai is the extension folder ai/install_dev.cmd
// links into Illustrator; dist/ai-preview runs the same panel and host script in a browser.
mkdirSync("dist/ai/CSXS", { recursive: true });
mkdirSync("dist/ai/host", { recursive: true });
mkdirSync("dist/ai-preview", { recursive: true });
for (const f of ["CSXS/manifest.xml", "index.html", "wavelayer.css", ".debug", "host/wavelayer.jsx"]) cpSync(`ai/${f}`, `dist/ai/${f}`);
cpSync("plugin/styles.css", "dist/ai/base.css");
for (const f of ["index.html", "wavelayer.css"]) cpSync(`ai/${f}`, `dist/ai-preview/${f}`);
cpSync("plugin/styles.css", "dist/ai-preview/base.css");

/** After a successful build: `dir`/build-stamp.txt changes, and the open panels (the development
 *  loader in Photoshop, the WaveLayer panel in Illustrator) notice it and load the new build. */
const stamp = dir => ({ name: "stamp", setup(b) { b.onEnd(r => { if (!r.errors.length) writeFileSync(`${dir}/build-stamp.txt`, String(Date.now())); }); } });

const targets = [
  { ...common, entryPoints: ["src/ai/main.cep.ts"], outfile: "dist/ai/main.js", plugins: [stamp("dist/ai")] },
  { ...common, entryPoints: ["src/ai/preview.ts"], outfile: "dist/ai-preview/main.js", loader: { ".jsx": "text" } },
  { ...common, entryPoints: ["src/main.uxp.ts"], outfile: "dist/plugin/index.js", plugins: [stamp("dist/plugin")] },
  { ...common, entryPoints: ["src/preview/main.preview.ts"], outfile: "dist/preview/preview.js" },
  { ...common, entryPoints: ["src/preview/gallery.ts"], outfile: "dist/preview/gallery.js" },
];

if (watch) for (const t of targets) await (await context(t)).watch();
else await Promise.all(targets.map(t => build(t)));
