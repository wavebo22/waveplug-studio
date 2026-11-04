import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Catch accidental regression to the old compact horizontal icon strip.
// The Photoshop UXP popup must show: type -> content link -> 4 icons, top to bottom.
test("smart-object right-click sidebar is a single vertical column, beside ordinary menu", () => {
  const css = readFileSync(new URL("../plugin/styles.css", import.meta.url), "utf8");
  const popup = readFileSync(new URL("../src/ui/popupMenu.ts", import.meta.url), "utf8");
  assert.match(css, /\.pm-split\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.pm-stat-row\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.pm-quick-grid\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.pm-quick\s*\{[^}]*width:\s*30px;\s*height:\s*30px/);
  assert.match(css, /\.pm-stat\.lt-tag\s*\{[^}]*width:\s*30px/);
  assert.match(css, /\.pm-stat-row\s*\{[^}]*align-items:\s*center/);
  assert.match(css, /\.pm-sidebar\s*\{[^}]*width:\s*44px/);
  assert.match(css, /\.pm-main-menu \.pm-item\s*\{[^}]*padding-left:\s*2px;\s*padding-right:\s*6px/);
  const rows = readFileSync(new URL("../src/ui/layerTree.ts", import.meta.url), "utf8");
  assert.match(rows, /replace\(r\.move, lockIcons\.move \? ic\("move", 13\) : null\)/);
  assert.match(rows, /replace\(r\.edit, lockIcons\.edit \? ic\("brush", 13\) : null\)/);
  const glyphs = readFileSync(new URL("../src/ui/dom.ts", import.meta.url), "utf8");
  for (const name of ["soReplace", "soExport", "soUnpack", "soReset"])
    assert.match(glyphs, new RegExp("\\b" + name + ":"));
  assert.match(glyphs, /SMART_LUCIDE\.has\(name\) \? "0 0 24 24"/);
  assert.ok(popup.indexOf("stat(data.type)") < popup.indexOf("stat(data.shared, true)"));
  assert.ok(popup.indexOf("stat(data.shared, true)") < popup.indexOf('h("div", { class: "pm-quick-grid" }'));
});
