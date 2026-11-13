import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("layer rows keep the native eye only, the expand controls and the smart-object glyphs", () => {
  const css = readFileSync(new URL("../plugin/styles.css", import.meta.url), "utf8");
  const rows = readFileSync(new URL("../src/ui/layerTree.ts", import.meta.url), "utf8");
  // Layer rows use Photoshop's native visibility eye only; move/edit lock switches are removed.
  assert.match(rows, /replace\(r\.eye, l\.visible \? ic\("eye", 14\) : null\)/);
  assert.doesNotMatch(rows, /replace\(r\.move, lockIcons\.move/);
  assert.doesNotMatch(rows, /replace\(r\.edit, lockIcons\.edit/);
  for (const name of ["expandGroupsBtn", "expandEffectsBtn", "collapseGroupsBtn", "collapseEffectsBtn", "collapseAllBtn"])
    assert.match(rows, new RegExp("const " + name + " = h\\("));
  assert.match(rows, /lt-expand-divider/);
  assert.match(rows, /expandCollapseControls/);
  const glyphs = readFileSync(new URL("../src/ui/dom.ts", import.meta.url), "utf8");
  for (const name of ["soReplace", "soExport", "soUnpack", "soReset"])
    assert.match(glyphs, new RegExp("\\b" + name + ":"));
  assert.match(glyphs, /SMART_LUCIDE\.has\(name\) \? "0 0 24 24"/);
});
