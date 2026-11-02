import { test } from "node:test";
import assert from "node:assert/strict";
import { type Quad, type ToolLayer, centredQuad, freeName, isAffineQuad, resultText, sameSourceIds, selectedContents, transformBetween, uniquePlan } from "../src/core/layers/smart.ts";

const so = (id: number, contentId: string, selected: boolean, extra: Partial<ToolLayer> = {}): ToolLayer =>
  ({ id, name: "L" + id, kind: "smartObject", selected, contentId, ...extra });

test("断开链接: selected instances get their own content; a fully selected set keeps one", () => {
  // a: 1, 2 selected, 3 not → both selected are copied; b: 4, 5 both selected → only 5 is copied
  const r = uniquePlan([so(1, "a", true), so(2, "a", true), so(3, "a", false), so(4, "b", true), so(5, "b", true)]);
  assert.deepEqual(r.copy.map(l => l.id), [1, 2, 5]);
  assert.deepEqual(r.skipped, []);
});

test("断开链接 skips layers that have nothing to break", () => {
  const r = uniquePlan([
    so(1, "a", true),
    so(2, "b", true, { linked: true }),
    so(3, "c", true, { locked: true }), so(4, "c", false),
    { id: 5, name: "背景", kind: "pixel", selected: true },
  ]);
  assert.deepEqual(r.copy, []);
  assert.equal(r.skipped.length, 4);
  assert.match(r.skipped[0], /本来就是独立的/);
  assert.match(r.skipped[1], /外部文件/);
  assert.match(r.skipped[2], /锁定/);
  assert.match(r.skipped[3], /不是智能对象/);
});

test("查找同源 selects every instance of the selected contents", () => {
  assert.deepEqual(sameSourceIds([so(1, "a", false), so(2, "a", true), so(3, "b", false), so(4, "a", false)]), [1, 2, 4]);
  assert.deepEqual(sameSourceIds([so(1, "a", false), { id: 2, name: "t", kind: "text", selected: true }]), []);
});

test("替换 / 导出 act once per shared content", () => {
  const r = selectedContents([so(1, "a", true), so(2, "a", true), so(3, "b", true), { id: 4, name: "t", kind: "text", selected: true }]);
  assert.deepEqual(r.layers.map(l => l.id), [1, 3]);
  assert.equal(r.skipped.length, 1);
});

test("export file names don't overwrite", () => {
  assert.equal(freeName("logo.psb", ["a.png"]), "logo.psb");
  assert.equal(freeName("logo.psb", ["LOGO.psb", "logo 2.psb"]), "logo 3.psb");
  assert.equal(freeName("a/b:c", []), "a_b_c");
  assert.match(resultText("已断开", { done: 2, skipped: ["x：y"] }), /^已断开 2 个；跳过 1 个/);
  assert.equal(resultText("已断开", { done: 0, skipped: [] }), "没有可处理的图层");
});

test("解包: the smart object's scale, rotation and position are measured for re-applying", () => {
  const plain: Quad = [0, 0, 100, 0, 100, 50, 0, 50];
  // 2× and turned 90° clockwise, top-left corner at (300, 300)
  const t = transformBetween(plain, [300, 300, 300, 500, 200, 500, 200, 300])!;
  assert.deepEqual(t.ref, [0, 0]);
  assert.deepEqual(t.offset, [300, 300]);
  assert.ok(Math.abs(t.width - 200) < 1e-9 && Math.abs(t.height - 200) < 1e-9);
  assert.ok(Math.abs(t.angle - 90) < 1e-9 && Math.abs(t.skew) < 1e-9);
  // flipped vertically: negative height
  assert.ok(transformBetween(plain, [0, 50, 100, 50, 100, 0, 0, 0])!.height < 0);
  assert.equal(transformBetween(plain, plain), null);
  assert.ok(isAffineQuad(plain));
  assert.ok(!isAffineQuad([0, 0, 100, 10, 90, 60, 0, 50]));
  assert.deepEqual(centredQuad([0, 0, 200, 0, 200, 100, 0, 100], 20, 10), [90, 45, 110, 45, 110, 55, 90, 55]);
});

test("status line counting word", () => {
  assert.equal(resultText("已清理", { done: 4, skipped: [], unit: "项", note: "约 1.0 MB" }), "已清理 4 项（约 1.0 MB）");
});

test("转为可编辑: images, vector files and links are converted; embedded PSB/PSD already are editable", async () => {
  const { editablePlan } = await import("../src/core/layers/smart.ts");
  const r = editablePlan([
    so(1, "a", true, { file: "产品.png" }),
    so(2, "b", true, { file: "logo.ai" }),
    so(3, "c", true, { file: "图.psb", linked: true }),
    so(4, "d", true, { file: "合成.psb" }),
    so(5, "e", true, { file: "x.jpg", locked: true }),
    { id: 6, name: "背景", kind: "pixel", selected: true },
  ]);
  assert.deepEqual(r.targets.map(l => l.id), [1, 2, 3]);
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped.join(), /已经可以编辑.*锁定.*不是智能对象/);
});
