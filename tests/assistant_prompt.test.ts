import { test } from "node:test";
import assert from "node:assert/strict";
import { isPromptMode, optimizeBlocked, parsePromptAnswer, promptRequest } from "../src/core/assistant/promptOptimize.ts";
import { stripOptimizer, withoutOptimizer } from "../src/core/workflow/stripOptimizer.ts";
import { BUILTIN_PROFILES } from "../src/core/workflow/builtin.ts";
import type { Binding, Profile } from "../src/core/workflow/profile.ts";

test("AI 优化：哪些模式能用；局部重绘留空 = 移除，不优化；融图留空时看画面也能写", () => {
  assert.ok(isPromptMode("inpaint") && isPromptMode("txt2img") && !isPromptMode("extract") && !isPromptMode("upscale"));
  assert.equal(optimizeBlocked("inpaint", "一只猫", true), null);
  assert.match(optimizeBlocked("inpaint", " ", true)!, /移除/);
  assert.equal(optimizeBlocked("blend", "", true), null);
  assert.match(optimizeBlocked("blend", "", false)!, /先写一句想法/);
  assert.match(optimizeBlocked("txt2img", "", false)!, /先写一句想法/);
  assert.match(optimizeBlocked("upscale", "x", false)!, /不用/);
});

test("AI 优化：请求里有模式说明、选区位置（百分比）、用户原话", () => {
  const u = promptRequest("inpaint", "  一只\n橘猫 ", { image: true, sel: { left: 100, top: 50, right: 300, bottom: 250 }, size: { width: 1000, height: 500 } });
  assert.match(u, /局部重绘/);
  assert.match(u, /左边 10%、上边 10% 到左边 30%、上边 50%/);
  assert.match(u, /用户的想法：一只 橘猫$/);
  const t = promptRequest("txt2img", "海边", { image: false, ratio: "16:9" });
  assert.ok(!/缩略图/.test(t));
  assert.match(t, /画面比例：16:9/);
  assert.equal(parsePromptAnswer({ prompt: " 一只橘猫\r\n趴着 " }), "一只橘猫\n趴着");
  assert.equal(parsePromptAnswer({}), "");
});

test("去掉工作流的提示词优化：开关和 if-else 换成原提示词，优化节点和显示节点删掉", () => {
  const api = {
    "22": { class_type: "DF_Text_Box", inputs: { Text: "猫" }, _meta: { title: "# 2.提示词" } },
    "179": { class_type: "QwenImagePromptOptimizer", inputs: { "用户提示词": ["22", 0], "图像_01": ["50", 0] } },
    "277": { class_type: "GoohaiDisplayAny", inputs: { Any: ["179", 0] } },
    "306": { class_type: "easy boolean", inputs: { value: true }, _meta: { title: "# 3.提示词优化" } },
    "305": { class_type: "easy ifElse", inputs: { boolean: ["306", 0], on_true: ["277", 0], on_false: ["22", 0] } },
    "255": { class_type: "TextEncode", inputs: { prompt: ["305", 0], image: ["50", 0] } },
    "50": { class_type: "LoadImage", inputs: { image: "a.png" } },
  };
  const bindings = [{ role: "prompt", nodeId: "22", input: "Text" }, { role: "param", nodeId: "306", input: "value" }] as Binding[];
  const r = stripOptimizer(api, bindings)!;
  assert.deepEqual(r.removed.sort(), ["179", "277", "305", "306"]);
  assert.deepEqual(r.api["255"].inputs.prompt, ["22", 0]);
  assert.deepEqual(r.bindings.map(b => b.nodeId), ["22"]);
  assert.ok("179" in api, "the input is not changed");
  assert.equal(stripOptimizer(r.api, r.bindings), null);
});

test("没有开关、直接接在编码器上的优化节点：提示词输出换成原提示词，是否反推换成 false", () => {
  const api = {
    "22": { class_type: "DF_Text_Box", inputs: { Text: "猫" } },
    "179": { class_type: "QwenImagePromptOptimizer", inputs: { "用户提示词": ["22", 0] } },
    "195": { class_type: "GoohaiDisplayAny", inputs: { Any: ["179", 0] } },
    "170": { class_type: "GoohaiRouteBlocker", inputs: { "是否阻断": ["179", 2], any: ["50", 0] } },
    "118": { class_type: "TextEncode", inputs: { prompt: ["195", 0], image_01: ["170", 0] } },
    "50": { class_type: "LoadImage", inputs: { image: "a.png" } },
  };
  const r = stripOptimizer(api, [])!;
  assert.deepEqual(r.removed, ["179"]);
  assert.deepEqual(r.api["195"].inputs.Any, ["22", 0]);
  assert.equal(r.api["170"].inputs["是否阻断"], false);
});

test("内置工作流里已经没有提示词优化；没有的工作流原样返回", () => {
  for (const p of BUILTIN_PROFILES) {
    assert.equal(stripOptimizer(p.api as any, p.bindings), null, p.name);
    assert.equal(withoutOptimizer(p as Profile), p);
    assert.ok(!JSON.stringify(p).includes("提示词优化"), p.name);
  }
});
