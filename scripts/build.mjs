// Builds the UXP plugin into dist/plugin and the browser preview into dist/preview.
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const BUILT_AT = new Date().toISOString().slice(5, 16).replace("T", " ");
const common = { define: { __BUILT_AT__: JSON.stringify(BUILT_AT) }, bundle: true, external: ["photoshop", "uxp"], format: "iife", target: "es2020", charset: "utf8", logLevel: "info", sourcemap: false };

mkdirSync("dist/plugin", { recursive: true });
mkdirSync("dist/preview", { recursive: true });
mkdirSync("dist/dev", { recursive: true });
for (const f of ["manifest.json", "index.html", "styles.css"]) cpSync(`plugin/${f}`, `dist/plugin/${f}`);
cpSync("plugin/icons", "dist/plugin/icons", { recursive: true });
cpSync("plugin/styles.css", "dist/preview/styles.css");
cpSync("src/preview/preview.html", "dist/preview/index.html");
cpSync("src/preview/gallery.html", "dist/preview/gallery.html");
cpSync("tests/fixtures/ui/guhai_inpaint_ps.json", "dist/preview/fixture.json");
cpSync("tests/fixtures/ui/guhai_remove_inpaint_outpaint.json", "dist/preview/fixture_outpaint.json");
cpSync("tests/fixtures/ui/qwen_txt2img.json", "dist/preview/fixture_txt2img.json");
cpSync("tests/fixtures/ui/vosr2_upscale.json", "dist/preview/fixture_upscale.json");

// development loader: separate plugin id, loads dist/plugin/index.js from F: at runtime
const manifest = JSON.parse(readFileSync("plugin/manifest.json", "utf8"));
// the loader has its own version: UPIA refuses to install a lower one over what is there (-418),
// and the installed dev loader was 1.3.0 before releases were renumbered. Bump when dev/ or the
// panels in the manifest change.
const DEV_LOADER_VERSION = "1.4.0";
const devManifest = {
  ...manifest,
  version: DEV_LOADER_VERSION,
  id: manifest.id + ".dev",
  name: manifest.name + " Dev",
  entrypoints: manifest.entrypoints.map(e => ({ ...e, id: e.id + "-dev", label: { default: e.label.default + " Dev" } })),
  requiredPermissions: { ...manifest.requiredPermissions, localFileSystem: "fullAccess", allowCodeGenerationFromStrings: true },
};
writeFileSync("dist/dev/manifest.json", JSON.stringify(devManifest, null, 2));
cpSync("dev/index.html", "dist/dev/index.html");
cpSync("dev/loader.js", "dist/dev/loader.js");

// The native helper is launched by UXP through launchProcess permission.
// Keep a copy beside each manifest so release plugins can resolve it with getPluginFolder().
if (existsSync("dist/waveplug-overlay.exe")) {
  cpSync("dist/waveplug-overlay.exe", "dist/plugin/waveplug-overlay.exe");
  cpSync("dist/waveplug-overlay.exe", "dist/dev/waveplug-overlay.exe");
}

const targets = [
  { ...common, entryPoints: ["src/main.uxp.ts"], outfile: "dist/plugin/index.js" },
  { ...common, entryPoints: ["src/preview/main.preview.ts"], outfile: "dist/preview/preview.js" },
  { ...common, entryPoints: ["src/preview/gallery.ts"], outfile: "dist/preview/gallery.js" },
];

if (watch) for (const t of targets) await (await context(t)).watch();
else await Promise.all(targets.map(t => build(t)));
