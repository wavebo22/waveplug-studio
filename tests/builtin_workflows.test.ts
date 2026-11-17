import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PROFILES, missingBuiltins } from "../src/core/workflow/builtin.ts";
import { validateProfile } from "../src/core/workflow/profile.ts";

test("内置工作流：六种模式各一个，绑定都有效", () => {
  assert.deepEqual(BUILTIN_PROFILES.map(p => p.taskType).sort(), ["blend", "extract", "inpaint", "outpaint", "txt2img", "upscale"]);
  for (const p of BUILTIN_PROFILES) {
    assert.deepEqual(validateProfile(p), [], p.name);
    assert.equal(p.source?.kind, "builtin");
  }
});

test("内置工作流：只补缺的，返回的是副本", () => {
  const all = missingBuiltins([]);
  assert.equal(all.length, 6);
  all[0].name = "改过";
  assert.notEqual(BUILTIN_PROFILES[0].name, "改过");
  assert.equal(missingBuiltins(all).length, 0);
  assert.equal(missingBuiltins(all.slice(2)).length, 2);
});
