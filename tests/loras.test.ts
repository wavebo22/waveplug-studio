import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLoras, applyLoras, loraNamesFrom, loraTargets } from "../src/core/workflow/loras.ts";
import type { ApiGraph } from "../src/core/workflow/api.ts";
import { BUILTIN_PROFILES } from "../src/core/workflow/builtin.ts";

const unetGraph = (): ApiGraph => ({
  "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors", weight_dtype: "default" } },
  "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "own.safetensors", strength_model: 1 } },
  "3": { class_type: "KSampler", inputs: { model: ["2", 0], seed: 1 } },
  "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
});

test("LoRAs chain after the UNET loader and every MODEL consumer is rewired", () => {
  const g = unetGraph();
  const added = applyLoras(g, [
    { name: "a.safetensors", strength: 0.8, on: true },
    { name: "off.safetensors", strength: 1, on: false },
    { name: "", strength: 1, on: true },
    { name: "b/c.safetensors", strength: -0.5, on: true },
  ]);
  assert.deepEqual(added, ["5", "6"]);
  assert.deepEqual(g["5"].inputs, { model: ["1", 0], lora_name: "a.safetensors", strength_model: 0.8 });
  assert.deepEqual(g["6"].inputs, { model: ["5", 0], lora_name: "b/c.safetensors", strength_model: -0.5 });
  assert.deepEqual(g["2"].inputs.model, ["6", 0]);
  assert.deepEqual(g["4"].inputs.model, ["6", 0]);
});

test("no active LoRA leaves the graph untouched", () => {
  const g = unetGraph(), before = JSON.stringify(g);
  assert.deepEqual(applyLoras(g, [{ name: "a.safetensors", strength: 1, on: false }, { name: "z", strength: 0, on: true }]), []);
  assert.deepEqual(applyLoras(g, undefined), []);
  assert.equal(JSON.stringify(g), before);
});

test("checkpoints get LoraLoader patching MODEL and CLIP", () => {
  const g: ApiGraph = {
    "10": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
    "11": { class_type: "CLIPTextEncode", inputs: { clip: ["10", 1], text: "x" } },
    "12": { class_type: "KSampler", inputs: { model: ["10", 0], positive: ["11", 0] } },
    "13": { class_type: "VAEDecode", inputs: { vae: ["10", 2] } },
  };
  applyLoras(g, [{ name: "a.safetensors", strength: 0.7, on: true }]);
  assert.equal(g["14"].class_type, "LoraLoader");
  assert.deepEqual(g["14"].inputs.clip, ["10", 1]);
  assert.deepEqual(g["11"].inputs.clip, ["14", 1]);
  assert.deepEqual(g["12"].inputs.model, ["14", 0]);
  assert.deepEqual(g["13"].inputs.vae, ["10", 2]);
});

test("workflows without a model loader refuse active LoRAs", () => {
  const g: ApiGraph = { "1": { class_type: "UpscaleModelLoader", inputs: { model_name: "4x.pth" } }, "2": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["1", 0] } } };
  assert.deepEqual(loraTargets(g), []);
  assert.throws(() => applyLoras(g, [{ name: "a", strength: 1, on: true }]), /找不到模型加载节点/);
  assert.throws(() => applyLoras(unetGraph(), [{ name: "a", strength: 3, on: true }]), /强度/);
});

test("LoRA names come from either object_info shape", () => {
  assert.deepEqual(loraNamesFrom({ LoraLoaderModelOnly: { input: { required: { lora_name: [["a.safetensors", "b/c.safetensors"]] } } } } as any), ["a.safetensors", "b/c.safetensors"]);
  assert.deepEqual(loraNamesFrom({ LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: ["x.safetensors"] }] } } } } as any), ["x.safetensors"]);
  assert.deepEqual(loraNamesFrom(null), []);
  assert.equal(activeLoras([{ name: "a", strength: 1, on: true }]).length, 1);
});

test("every built-in diffusion workflow has a LoRA target", () => {
  for (const w of BUILTIN_PROFILES) {
    const g = w.api as ApiGraph;
    const hasUnet = Object.values(g).some(n => n.class_type === "UNETLoader");
    assert.equal(loraTargets(g).length > 0, hasUnet, w.name);
  }
});

test("prepareRun adds the enabled LoRAs to a built-in workflow's execution copy only", async () => {
  const { prepareRun } = await import("../src/core/workflow/inject.ts");
  const p = BUILTIN_PROFILES.find(x => x.taskType === "txt2img" && loraTargets(x.api).length)!;
  const before = JSON.stringify(p.api);
  const run = prepareRun(p, { prompt: "猫", seed: 1, size: { width: 1024, height: 1024 }, loras: [{ name: "style.safetensors", strength: 0.6, on: true }] });
  const added = Object.entries(run.api).filter(([id]) => !(id in p.api));
  assert.equal(added.length, loraTargets(p.api).length);
  assert.equal(added[0][1].inputs.lora_name, "style.safetensors");
  assert.equal(JSON.stringify(p.api), before);
});
