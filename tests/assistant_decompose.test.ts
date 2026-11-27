import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECOMPOSE_MAX_PARTS, DECOMPOSE_MAX_PIXELS, REFINE_BATCH, applyRefine, cropFor, decomposeRequest, parseDecomposeAnswer, refineRegion, refineRequest, visionSize,
} from "../src/core/assistant/decompose.ts";
import { withGrid } from "../src/core/image/grid.ts";

test("坐标网格：画在副本上，线在每十分之一处，原图不变", () => {
  const p = { width: 200, height: 100, channels: 3 as const, data: new Uint8Array(200 * 100 * 3).fill(0) };
  const g = withGrid(p);
  assert.equal(p.data.some(v => v !== 0), false);
  const at = (x: number, y: number) => Array.from(g.data.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3));
  assert.deepEqual(at(100, 55), [128, 0, 128]);
  assert.deepEqual(at(55, 55), [0, 0, 0]);
  const gray = { width: 2, height: 2, channels: 1 as const, data: new Uint8Array(4) };
  assert.equal(withGrid(gray), gray);
});

test("细化：每个部分在自己的局部图里重新定位，换算回文档像素；找不到的保留第一次的框", () => {
  const size = { width: 2000, height: 1000 };
  const first = parseDecomposeAnswer({ parts: Array.from({ length: REFINE_BATCH + 1 }, (_, i) => ({ name: `物件${i}`, box: [100 + i * 50, 100, 300 + i * 50, 400] })) }, size);
  const regions = first.parts.map(p => refineRegion(p.box, size));
  for (const [i, r] of regions.entries()) {
    assert.ok(r.left <= first.parts[i].box.left && r.right >= first.parts[i].box.right && r.top <= first.parts[i].box.top && r.bottom >= first.parts[i].box.bottom);
    assert.ok(r.bottom - r.top >= 200);
  }
  const answers = [
    { boxes: [{ i: 1, box: [0, 0, 500, 500] }, { i: 2, box: null }] },
    null,
  ];
  const r = applyRefine(first.parts, regions, answers, size);
  const r0 = regions[0];
  assert.deepEqual(r.parts[0].box, { left: r0.left, top: r0.top, right: r0.left + Math.ceil((r0.right - r0.left) / 2), bottom: r0.top + Math.ceil((r0.bottom - r0.top) / 2) });
  assert.equal(r.parts[0].refined, true);
  assert.deepEqual(r.parts[1].box, first.parts[1].box);
  assert.equal(r.parts[1].refined, false);
  assert.equal(r.parts[REFINE_BATCH].refined, false);
  assert.ok(r.notes.some(n => /没找到/.test(n)) && r.notes.some(n => /请求失败/.test(n)));
  assert.match(refineRequest(["奶牛头", "键盘"]), /第 2 张：找「键盘」/);
});

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
