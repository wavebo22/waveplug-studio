import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECOMPOSE_MAX_PARTS, DECOMPOSE_MAX_PIXELS, cropFor, decomposeRequest, parseDecomposeAnswer, visionSize,
} from "../src/core/assistant/decompose.ts";

test("拆层缩略图：不超过 1300×1300 像素数，保持比例，小图不放大", () => {
  assert.deepEqual(visionSize(800, 600), { width: 800, height: 600 });
  const t = visionSize(4000, 3000);
  assert.ok(t.width * t.height <= DECOMPOSE_MAX_PIXELS);
  assert.ok(Math.abs(t.width / t.height - 4 / 3) < 0.01);
  assert.ok(t.width * t.height > DECOMPOSE_MAX_PIXELS * 0.99);
});

test("拆层请求：写明缩略图尺寸、粒度和用户补充", () => {
  const s = decomposeRequest("coarse", { width: 1300, height: 1000 }, "  文字不用拆  ");
  assert.match(s, /1300×1000/);
  assert.match(s, /2～4/);
  assert.match(s, /用户的补充要求：文字不用拆/);
  assert.doesNotMatch(decomposeRequest("fine", { width: 10, height: 10 }), /补充要求/);
});

test("拆层回答：0～1000 的框换算成文档像素，保持从前到后的顺序", () => {
  const plan = parseDecomposeAnswer({ parts: [
    { name: "红色瓶子", kind: "object", box: [100, 200, 300, 600] },
    { name: "标题文字“新品”", kind: "text", box: [500, 50, 900, 150] },
  ] }, { width: 2000, height: 1000 });
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(plan.parts.map(p => p.name), ["红色瓶子", "标题文字“新品”"]);
  assert.deepEqual(plan.parts[0].box, { left: 200, top: 200, right: 600, bottom: 600 });
  assert.equal(plan.parts[1].kind, "text");
});

test("拆层回答：坏的项目被丢掉并说明原因，重名加编号，左右颠倒的框会纠正", () => {
  const size = { width: 1000, height: 1000 };
  const plan = parseDecomposeAnswer({ parts: [
    { name: "", box: [0, 0, 100, 100] },
    { name: "没有框" },
    { name: "超出", box: [0, 0, 1500, 100] },
    { name: "极小", box: [10, 10, 20, 20] },
    { name: "背景墙", box: [0, 0, 1000, 1000] },
    { name: "瓶子", box: [300, 300, 100, 100] },
    { name: "瓶子", box: [500, 500, 700, 700] },
  ] }, size);
  assert.deepEqual(plan.parts.map(p => p.name), ["瓶子", "瓶子（2）"]);
  assert.deepEqual(plan.parts[0].box, { left: 100, top: 100, right: 300, bottom: 300 });
  assert.equal(plan.dropped.length, 5);
  assert.ok(plan.dropped.some(d => /背景/.test(d)));
  assert.deepEqual(parseDecomposeAnswer("好的", size).parts, []);
});

test("拆层回答：最多保留规定的部分数", () => {
  const parts = Array.from({ length: DECOMPOSE_MAX_PARTS + 3 }, (_, i) => ({ name: `物件${i}`, box: [0, 0, 200, 200] }));
  const plan = parseDecomposeAnswer({ parts }, { width: 1000, height: 1000 });
  assert.equal(plan.parts.length, DECOMPOSE_MAX_PARTS);
  assert.equal(plan.dropped.length, 3);
});

test("裁剪范围：四周留边，太小的补到最小边长，靠边时往里挪而不是截断", () => {
  const size = { width: 2000, height: 1000 };
  assert.deepEqual(cropFor({ left: 800, top: 400, right: 1200, bottom: 600 }, size), { left: 700, top: 300, right: 1300, bottom: 700 });
  const small = cropFor({ left: 990, top: 490, right: 1010, bottom: 510 }, size);
  assert.equal(small.right - small.left, 384);
  assert.equal(small.bottom - small.top, 384);
  const edge = cropFor({ left: 0, top: 0, right: 40, bottom: 40 }, size);
  assert.deepEqual(edge, { left: 0, top: 0, right: 384, bottom: 384 });
  const huge = cropFor({ left: 0, top: 0, right: 2000, bottom: 900 }, size);
  assert.deepEqual(huge, { left: 0, top: 0, right: 2000, bottom: 1000 });
});
