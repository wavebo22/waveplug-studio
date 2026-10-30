// Builds the UXP plugin into dist/plugin and the browser preview into dist/preview.
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const common = { bundle: true, external: ["photoshop", "uxp"], format: "iife", target: "es2020", charset: "utf8", logLevel: "info", sourcemap: false };

mkdirSync("dist/plugin", { recursive: true });
mkdirSync("dist/preview", { recursive: true });
for (const f of ["manifest.json", "index.html", "styles.css"]) cpSync(`plugin/${f}`, `dist/plugin/${f}`);
cpSync("plugin/icons", "dist/plugin/icons", { recursive: true });
cpSync("plugin/styles.css", "dist/preview/styles.css");
cpSync("src/preview/preview.html", "dist/preview/index.html");
cpSync("tests/fixtures/ui/guhai_inpaint_ps.json", "dist/preview/fixture.json");

const targets = [
  { ...common, entryPoints: ["src/main.uxp.ts"], outfile: "dist/plugin/index.js" },
  { ...common, entryPoints: ["src/preview/main.preview.ts"], outfile: "dist/preview/preview.js" },
];

if (watch) for (const t of targets) await (await context(t)).watch();
else await Promise.all(targets.map(t => build(t)));
