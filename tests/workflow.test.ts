import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { uiToApi } from "../src/core/workflow/uiToApi.ts";
import { recognize } from "../src/core/workflow/recognize.ts";
import { newProfile, carryOver, validateProfile } from "../src/core/workflow/profile.ts";
import { prepareRun } from "../src/core/workflow/inject.ts";
import { asApiGraph, isLink } from "../src/core/workflow/api.ts";

const ui = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ui/${name}.json`, import.meta.url), "utf8"));
const api = (name: string) => uiToApi(ui(name)).api;
const find = (r: ReturnType<typeof recognize>, role: string) => r.suggestions.filter(s => s.binding.role === role);

test("UI → API resolves Set/Get, drops bypassed nodes, keeps titles", () => {
  const g = api("guhai_inpaint_ps");
  assert.ok(!Object.values(g).some(n => /^(SetNode|GetNode|Reroute)$/.test(n.class_type)));
  assert.equal(g["303"].class_type, "LoadImage");
  assert.equal(g["303"]._meta?.title, "# 1.加载图像");
  // #179 used GetNode("image") → must now point at the real producer
  const img = g["179"].inputs["图像_01"];
  assert.ok(isLink(img) && g[img[0]], "GetNode link resolved to a real node");
  const edit = api("qwen_edit");
  assert.equal(Object.values(edit).filter(n => n.class_type === "LoadImage").length, 1, "7 bypassed loaders dropped");
});

test("API JSON import rejects UI format with a readable message", () => {
  assert.throws(() => asApiGraph(ui("qwen_t2i")), /界面格式/);
});

test("Gu Hai PS inpaint: image+alpha mask, prompt, output, exposed params", () => {
  const r = recognize(api("guhai_inpaint_ps"));
  assert.deepEqual(r.blockers, []);
  const [image] = find(r, "image");
  assert.equal(image.binding.nodeId, "303");
  assert.equal(image.binding.encoding, "rgba-alpha-mask");
  assert.equal(image.confidence, "certain");
  assert.equal(find(r, "mask").length, 0, "no separate mask binding needed");
  const [prompt] = find(r, "prompt");
  assert.equal(prompt.binding.nodeId, "22");
  assert.equal(prompt.confidence, "certain");
  const [out] = find(r, "output");
  assert.equal(out.binding.nodeId, "38");
  assert.equal(out.confidence, "certain");
  assert.ok(find(r, "seed").some(s => s.binding.nodeId === "267"));
  const params = find(r, "param").map(s => s.binding.nodeId + "." + s.binding.input);
  for (const p of ["304.value", "306.value", "307.value"]) assert.ok(params.includes(p), p);
  // LoRA #258 strength is linked from #307 — must not be listed twice
  assert.equal(params.filter(p => p.startsWith("307.")).length, 1);
});

test("Gu Hai Turbo inpaint (no numbered titles) still recognised", () => {
  const r = recognize(api("guhai_inpaint_turbo"));
  assert.deepEqual(r.blockers, []);
  assert.equal(find(r, "image")[0].binding.nodeId, "193");
  assert.equal(find(r, "prompt")[0].binding.nodeId, "22");
});

test("edit-only and text-to-image workflows are rejected for inpaint", () => {
  assert.match(recognize(api("qwen_edit")).blockers.join(), /没有任何遮罩入口/);
  assert.match(recognize(api("qwen_t2i")).blockers.join(), /没有加载图像节点/);
});

test("execution copy injects values and leaves the template untouched", () => {
  const g = api("guhai_inpaint_ps");
  const r = recognize(g);
  const p = newProfile("孤海局部重绘", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  assert.deepEqual(validateProfile(p), []);
  const before = JSON.stringify(p.api);
  const run = prepareRun(p, { image: "waveplug/a.png", prompt: "红色杯子", seed: 42, params: { "307.value": 0.5 } });
  assert.equal(run.api["303"].inputs.image, "waveplug/a.png");
  assert.equal(run.api["22"].inputs.Text, "红色杯子");
  assert.equal(run.api["267"].inputs.noise_seed, 42);
  assert.equal(run.api["307"].inputs.value, 0.5);
  assert.equal(JSON.stringify(p.api), before);
  assert.throws(() => prepareRun(p, { image: "a.png", prompt: "  ", seed: 1 }), /提示词/);
  p.options.allowEmptyPrompt = true;
  assert.doesNotThrow(() => prepareRun(p, { image: "a.png", prompt: "", seed: 1 }));
});

test("re-import keeps valid bindings, remaps renumbered nodes, flags broken ones", () => {
  const g = api("guhai_inpaint_ps");
  const p = newProfile("x", g, recognize(g).suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  const edited = JSON.parse(JSON.stringify(g));
  edited["999"] = edited["303"]; delete edited["303"];           // loader got a new id
  for (const n of Object.values(edited) as any[]) for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && v[0] === "303") n.inputs[k] = ["999", v[1]];
  delete edited["304"];                                            // a parameter node was removed
  const c = carryOver(p, edited);
  assert.ok(c.remapped.some(r => r.from.nodeId === "303" && r.to.nodeId === "999"));
  assert.ok(c.broken.some(b => b.binding.nodeId === "304"));
  assert.ok(!c.profile.bindings.some(b => b.nodeId === "304"));
});
