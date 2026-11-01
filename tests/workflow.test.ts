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

test("custom widget types (colour picker) keep the following values aligned", () => {
  const { api, warnings } = uiToApi(ui("guhai_inpaint_ps"));
  const n = api["209"].inputs;
  assert.equal(n["填充颜色"], "#364254");
  assert.equal(n["整除数"], 0);
  assert.equal(n["缩放方法"], "自定义宽高");
  assert.ok(isLink(n["宽度"]), "linked widget keeps its link");
  assert.equal(api["267"].inputs.noise_seed, 73987074229914);
  assert.ok(!("$control" in api["267"].inputs));
  assert.equal(api["258"].inputs.lora_name, "Qwen\\Qwen2.1 一致性无偏移_GH_V1.0.safetensors");
  // GH_CropRestore has a widget unknown offline; it must be flagged, not silently shifted
  assert.deepEqual(warnings.filter(w => /错位/.test(w)).map(w => w.split(" ")[0]), ["#212", "#252"]);
});

test("object_info marks control_after_generate even when the node lists its own widgets", () => {
  const wf = { nodes: [{ id: 1, type: "KS", inputs: [{ name: "seed", type: "INT", link: null, widget: { name: "seed" } }, { name: "steps", type: "INT", link: null, widget: { name: "steps" } }], outputs: [{ name: "o", type: "X", links: [1] }], widgets_values: [5, "fixed", 20] }], links: [] };
  const info = { KS: { input: { required: { seed: ["INT", { control_after_generate: true }], steps: ["INT", {}] } } } } as any;
  const { api } = uiToApi(wf, info);
  assert.deepEqual(api["1"].inputs, { seed: 5, steps: 20 });
});

test("'repaint only inside the selection' links the cropped mask into the encoder, execution copy only", async () => {
  const { findLocalMaskLinks } = await import("../src/core/workflow/localMask.ts");
  const g = api("guhai_inpaint_ps");
  const info = {
    TextEncodeQwenImage21GH: { input: { required: { clip: ["CLIP"], vae: ["VAE"] }, optional: { mask: ["MASK"], image_01: ["IMAGE"], image_02: ["IMAGE"] } }, output: ["CONDITIONING", "CONDITIONING", "LATENT", "QWEN_IMAGE_21_GH_RESTORE_INFO"] },
    "图像缩放V2_孤海": { input: { required: { "图像": ["IMAGE"] }, optional: { "遮罩": ["MASK"] } }, output: ["IMAGE", "INT", "INT", "MASK"] },
    "图像缩放范围孤海": { input: { required: { "图像": ["IMAGE"] }, optional: { "遮罩": ["MASK"] } }, output: ["IMAGE", "MASK"] },
    GH_MaskCropV2: { input: { required: { "图像": ["IMAGE"], "遮罩": ["MASK"] } }, output: ["SEAM", "IMAGE", "MASK"] },
  } as any;
  const links = findLocalMaskLinks(g, info);
  assert.deepEqual(links.map(l => `${l.nodeId}.${l.input}<-${l.from.join(":")}`).sort(), ["118.mask<-209:3", "255.mask<-250:3"]);
  const p = newProfile("x", g, recognize(g).suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  p.options.localMask = { enabled: true, links };
  const run = prepareRun(p, { image: "a.png", prompt: "杯子", seed: 1 });
  assert.deepEqual(run.api["255"].inputs.mask, ["250", 3]);
  assert.equal(p.api["255"].inputs.mask, undefined, "template untouched");
  p.options.localMask.enabled = false;
  assert.equal(prepareRun(p, { image: "a.png", prompt: "杯子", seed: 1 }).api["255"].inputs.mask, undefined);
});

test("reference images: free encoder inputs are found and wired only in the execution copy", async () => {
  const { findReferenceSlots } = await import("../src/core/workflow/references.ts");
  const g = api("guhai_inpaint_ps");
  const images = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`image_${String(i + 1).padStart(2, "0")}`, ["IMAGE"]]));
  const info = { TextEncodeQwenImage21GH: { input: { required: { clip: ["CLIP"] }, optional: { vae: ["VAE"], mask: ["MASK"], ...images } }, output: ["CONDITIONING", "CONDITIONING", "LATENT", "X"] } } as any;
  const slots = findReferenceSlots(g, info)!;
  assert.deepEqual(slots.nodes.map(n => `${n.nodeId}:${n.inputs[0]}`).sort(), ["118:image_02", "255:image_02"]);
  const p = newProfile("x", g, recognize(g).suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  p.options.refSlots = slots;
  const without = prepareRun(p, { image: "a.png", prompt: "x", seed: 1 });
  assert.equal(Object.keys(without.api).length, Object.keys(g).length, "no reference → nothing added");
  const run = prepareRun(p, { image: "a.png", prompt: "换成图2中的饮料", seed: 1, references: { 1: "waveplug/ref.png" } });
  const link = run.api["255"].inputs.image_02 as [string, number];
  assert.ok(isLink(link));
  assert.equal(run.api[link[0]].class_type, "LoadImage");
  assert.equal(run.api[link[0]].inputs.image, "waveplug/ref.png");
  assert.deepEqual(run.api["118"].inputs.image_02, link);
  assert.equal(p.api["255"].inputs.image_02, undefined, "template untouched");
});

test("each variation gets its own reference loader node (no shared cached encoding)", async () => {
  const { applyReferences } = await import("../src/core/workflow/references.ts");
  const slots = { nodes: [{ nodeId: "255", inputs: ["image_02"] }] };
  const a = api("guhai_inpaint_ps"), b = api("guhai_inpaint_ps");
  applyReferences(a, slots, ["r.png"], 0); applyReferences(b, slots, ["r.png"], 1);
  assert.notDeepEqual(a["255"].inputs.image_02, b["255"].inputs.image_02);
});

test("outpaint workflow: image + four pads recognised, pads injected as exact pixels", () => {
  const g = api("guhai_remove_inpaint_outpaint");
  const r = recognize(g);
  assert.equal(r.taskType, "outpaint");
  assert.deepEqual(r.blockers, []);
  const pick = (role: string) => r.suggestions.filter(s => s.binding.role === role);
  assert.equal(pick("image")[0].binding.nodeId, "308");
  assert.deepEqual(pick("pad").map(s => `${s.binding.side}:${s.binding.nodeId}`), ["left:342", "right:343", "top:346", "bottom:347"]);
  assert.equal(pick("prompt")[0].binding.nodeId, "313");
  assert.equal(pick("output")[0].binding.nodeId, "315");
  assert.ok(!pick("param").some(s => ["342", "343", "346", "347"].includes(s.binding.nodeId)), "pads are not listed as params");
  assert.equal(r.outpaint?.nodeId, "314");
  const p = newProfile("扩图", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  p.taskType = "outpaint"; p.options.outpaint = r.outpaint; p.options.allowEmptyPrompt = true;
  assert.deepEqual(validateProfile(p), []);
  const run = prepareRun(p, { image: "src.png", prompt: "", seed: 3, pads: { left: 120, right: 80, top: 0, bottom: 300 } });
  assert.equal(run.api["342"].inputs.value, 120);
  assert.equal(run.api["347"].inputs.value, 300);
  assert.equal(run.api["314"].inputs["单位"], "像素");
  assert.equal(run.api["314"].inputs.gh_visual_ratio, "自由比例");
  assert.equal(run.api["314"].inputs.gh_visual_layout, "");
  assert.equal(run.api["308"].inputs.image, "src.png");
  assert.throws(() => prepareRun(p, { image: "a", prompt: "", seed: 1, pads: { left: 3500, right: 0, top: 0, bottom: 0 } }), /3000/);

  // "只重绘选区内" belongs to inpaint: a stored link must not reach an outpaint encoder
  p.options.localMask = { enabled: true, links: [{ nodeId: "332", input: "mask", from: ["329", 3] }] };
  const noMask = prepareRun(p, { image: "src.png", prompt: "", seed: 3, pads: { left: 1, right: 0, top: 0, bottom: 0 } });
  assert.equal(noMask.api["332"].inputs.mask, undefined);
});

test("text-to-image: size node, optional reference, forced custom ratio", () => {
  const g = api("qwen_txt2img");
  const r = recognize(g);
  assert.equal(r.taskType, "txt2img");
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(find(r, "size").map(s => `${s.binding.axis}:${s.binding.nodeId}.${s.binding.input}`), ["w:39.自定宽度", "h:39.自定高度"]);
  const ref = find(r, "reference")[0];
  assert.equal(ref.binding.emptyValue, "无");
  assert.equal(r.txt2img?.multiple, 32);
  const p = newProfile("t2i", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  p.taskType = "txt2img"; p.options.txt2img = r.txt2img; p.options.allowEmptyPrompt = false;
  assert.deepEqual(validateProfile(p), []);
  const run = prepareRun(p, { prompt: "猫", seed: 7, size: { width: 1536, height: 864 } });
  assert.equal(run.api["39"].inputs["自定宽度"], 1536);
  assert.equal(run.api["39"].inputs["自定高度"], 864);
  assert.equal(run.api["39"].inputs["比例"], "自定义宽高");
  assert.equal(run.api["193"].inputs.image, "无");
  const withRef = prepareRun(p, { prompt: "猫", seed: 7, size: { width: 1024, height: 1024 }, references: { 1: "waveplug/r.png" } });
  assert.equal(withRef.api["193"].inputs.image, "waveplug/r.png");
  assert.throws(() => prepareRun(p, { prompt: "猫", seed: 7, size: { width: 20000, height: 10 } }), /最多/);
});

test("upscale (VOSR2): loaded image + scale factor, no mask", () => {
  const g = api("vosr2_upscale");
  const r = recognize(g);
  assert.equal(r.taskType, "upscale");
  assert.deepEqual(r.blockers, []);
  assert.equal(find(r, "image")[0].binding.nodeId, "2");
  assert.equal(find(r, "image")[0].binding.encoding, "rgb");
  // the factor is set on the 「easy int」 feeding TESpeedVOSR2Image.scale
  assert.deepEqual(find(r, "scale").map(s => `${s.binding.nodeId}.${s.binding.input}`), ["4.value"]);
  assert.equal(find(r, "reference").length, 0);
  const p = newProfile("up", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  p.taskType = "upscale"; p.options.upscale = r.upscale; p.options.allowEmptyPrompt = true;
  assert.deepEqual(validateProfile(p), []);
  const run = prepareRun(p, { image: "src.png", prompt: "", seed: 5, scale: 2 });
  assert.equal(run.api["4"].inputs.value, 2);
  assert.equal(run.api["2"].inputs.image, "src.png");
  assert.equal(run.api["11"].inputs.seed, 5);
  assert.throws(() => prepareRun(p, { image: "src.png", prompt: "", seed: 5 }), /放大倍数/);
});

test("an inpaint workflow with a scale node is still inpaint", () => {
  assert.equal(recognize(api("guhai_inpaint_ps")).taskType, "inpaint");
  assert.equal(recognize(api("guhai_remove_inpaint_outpaint")).taskType, "outpaint");
});
