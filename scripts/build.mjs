// Builds the UXP plugin into dist/plugin and the browser preview into dist/preview.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
cpSync("tests/fixtures/ui/guhai_inpaint_ps.json", "dist/preview/fixture.json");

// development loader: separate plugin id, loads dist/plugin/index.js from F: at runtime
const manifest = JSON.parse(readFileSync("plugin/manifest.json", "utf8"));
const devManifest = {
  ...manifest,
  id: manifest.id + ".dev",
  name: manifest.name + " Dev",
  entrypoints: manifest.entrypoints.map(e => ({ ...e, id: e.id + "-dev", label: { default: e.label.default + " Dev" } })),
  requiredPermissions: { ...manifest.requiredPermissions, localFileSystem: "fullAccess", allowCodeGenerationFromStrings: true },
};
writeFileSync("dist/dev/manifest.json", JSON.stringify(devManifest, null, 2));
cpSync("dev/index.html", "dist/dev/index.html");
cpSync("dev/loader.js", "dist/dev/loader.js");

const targets = [
  { ...common, entryPoints: ["src/main.uxp.ts"], outfile: "dist/plugin/index.js" },
  { ...common, entryPoints: ["src/preview/main.preview.ts"], outfile: "dist/preview/preview.js" },
];

if (watch) for (const t of targets) await (await context(t)).watch();
else await Promise.all(targets.map(t => build(t)));
