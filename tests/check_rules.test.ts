import { test } from "node:test";
import assert from "node:assert/strict";
import { type CheckDoc, type CheckText, contrast, guessPurpose, ringColor, runChecks } from "../src/core/check/rules.ts";
import { copyPrompt, parseCopyIssues, parseVisualIssues, replaceOnce } from "../src/core/check/ai.ts";
import { parseJsonAnswer } from "../src/core/assistant/deepseek.ts";
import type { ScanLayer } from "../src/core/layers/slim.ts";
import type { Quad } from "../src/core/layers/smart.ts";

const quad = (l: number, t: number, w: number, h: number): Quad => [l, t, l + w, t, l + w, t + h, l, t + h];
const layer = (id: number, name: string, kind: string, extra: Partial<ScanLayer> = {}): ScanLayer =>
  ({ id, name, kind, visible: true, bounds: { left: 100, top: 100, right: 200, bottom: 150 }, parentId: null, opacity: 100, ...extra });
const text = (id: number, extra: Partial<CheckText> = {}): CheckText =>
  ({ id, name: "文字 " + id, contents: "立即购买", fonts: ["SourceHanSansSC-Regular"], fontNames: ["思源黑体"], sizesPx: [32], ranges: 1,
     rgb: { r: 0, g: 0, b: 0 }, bounds: { left: 200, top: 200, right: 400, bottom: 240 }, visible: true, ...extra });
const doc = (x: Partial<CheckDoc> = {}, layers: ScanLayer[] = []): CheckDoc => ({
  width: 1920, height: 1080, mode: "rgb", bits: 8, ppi: 72,
  scan: { width: 1920, height: 1080, bytesPerPixel: 4, bits: 8, layers, alphaChannels: [] },
  texts: [], installed: new Set(["SourceHanSansSC-Regular"]), links: [], fills: [], backgrounds: new Map(), contentIds: new Map(), ...x,
});
const keys = (d: CheckDoc, p: "print" | "screen" | "mobile" = "screen") => runChecks(d, p).map(i => i.key);

test("缺失字体：按字体归并，列出用它的图层；读不到已装字体时不报", () => {
  const d = doc({ texts: [text(1, { fonts: ["Missing-Bold"], fontNames: ["缺的字体"] }), text(2, { fonts: ["Missing-Bold", "SourceHanSansSC-Regular"], fontNames: ["缺的字体", "思源黑体"] })] });
  const f = runChecks(d, "screen").filter(i => i.category === "font");
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].ids, [1, 2]);
  assert.match(f[0].title, /缺的字体/);
  assert.equal(runChecks({ ...d, installed: null }, "screen").filter(i => i.category === "font").length, 0);
});

test("智能对象：比显示大很多、比画布大很多、又占用高才算严重；共用内容按最大实例算", () => {
  const smart = (w: number, h: number, q: Quad, extra = {}) => ({ file: "photo.jpg", linked: false, filters: false, shared: false, styled: false, quad: q, width: w, height: h, ...extra });
  // 8000×6000 shown at 400×300: 400× the pixels, 4× the canvas' long edge, ~183 MB
  const huge = layer(1, "大图", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 400, 300)) });
  const r = runChecks(doc({}, [huge]), "screen").find(i => i.key.startsWith("smart:big"))!;
  assert.equal(r.severity, "error");
  assert.equal(r.fix?.kind, "shrinkSmart");
  assert.match(r.detail, /4\.2 倍/);
  // the same content shown big elsewhere: not oversized any more
  const big2 = layer(2, "大图 拷贝", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 7000, 5250), { shared: true }) });
  const shared = doc({ contentIds: new Map([[1, "c"], [2, "c"]]) }, [huge, { ...huge, smart: { ...huge.smart!, shared: true } }, big2].slice(1));
  assert.ok(!keys(shared).some(k => k.startsWith("smart:big")));
  // vector content never; small content shown big is blurry instead
  assert.ok(!keys(doc({}, [layer(3, "logo", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 100, 75), { file: "logo.ai" }) })])).length);
  const blur = runChecks(doc({}, [layer(4, "小图", "smartObject", { smart: smart(200, 100, quad(0, 0, 800, 400)) })]), "print").find(i => i.key.startsWith("smart:up"))!;
  assert.equal(blur.severity, "error");
  // with smart filters: advice, no one-click fix
  const filtered = runChecks(doc({}, [layer(5, "滤镜", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 400, 300), { filters: true }) })]), "screen").find(i => i.key.startsWith("smart:big"))!;
  assert.equal(filtered.fix, undefined);
  assert.match(filtered.detail, /智能滤镜/);
});

test("链接丢失和已修改", () => {
  const k = keys(doc({ links: [{ id: 7, missing: true, changed: false }, { id: 8, missing: false, changed: true }] }));
  assert.ok(k.includes("smart:missing:7") && k.includes("smart:changed:8"));
});

test("交付：印刷稿查模式、分辨率、安全边距、四色黑小字；屏幕稿查 CMYK", () => {
  const print = doc({ ppi: 150, texts: [text(1, { bounds: { left: 5, top: 500, right: 300, bottom: 540 }, cmyk: { c: 75, m: 68, y: 67, k: 90 }, sizesPx: [20] })] });
  const k = keys(print, "print");
  for (const want of ["del:mode", "del:ppi", "del:bleed", "del:edge", "del:richblack"]) assert.ok(k.includes(want), want);
  assert.ok(keys(doc({ mode: "cmyk" }), "screen").includes("del:mode"));
  assert.equal(guessPurpose({ mode: "cmyk", width: 100, height: 100 }), "print");
  assert.equal(guessPurpose({ mode: "rgb", width: 750, height: 1624 }), "mobile");
  assert.equal(guessPurpose({ mode: "rgb", width: 1920, height: 1080 }), "screen");
});

test("文字：太小、占位文字、对比度低、字号几乎一样", () => {
  const d = doc({
    texts: [text(1, { sizesPx: [9] }), text(2, { contents: "Lorem ipsum" }), text(3, { rgb: { r: 200, g: 200, b: 200 } }),
      text(4, { sizesPx: [23.8] }), text(5, { sizesPx: [24] })],
    backgrounds: new Map([[3, { r: 255, g: 255, b: 255 }]]),
  });
  const k = keys(d);
  assert.ok(k.includes("text:tiny") && k.includes("text:placeholder:2") && k.includes("text:contrast:3") && k.includes("text:size:23.8:24"));
  // a colour overlay recolours the text: its own colour says nothing about contrast
  assert.ok(!keys({ ...d, texts: d.texts.map(t => t.id === 3 ? { ...t, overlay: true } : t) }).includes("text:contrast:3"));
  // 31.8 / 32.4: a real difference, not a slip
  assert.ok(!keys(doc({ texts: [text(6, { sizesPx: [31.8] }), text(7, { sizesPx: [32.4] })] })).some(k => k.startsWith("text:size")));
  assert.ok(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) > 20);
});

test("文本框排满时提示可能截断", () => {
  const d = doc({ texts: [text(1, { box: { left: 0, top: 0, right: 300, bottom: 100 }, bounds: { left: 0, top: 2, right: 290, bottom: 96 }, sizesPx: [20] })] });
  assert.ok(keys(d).includes("text:overflow:1"));
  const roomy = doc({ texts: [text(1, { box: { left: 0, top: 0, right: 300, bottom: 300 }, bounds: { left: 0, top: 2, right: 290, bottom: 60 }, sizesPx: [20] })] });
  assert.ok(!keys(roomy).includes("text:overflow:1"));
});

test("整洁：空图层、画布外、AI 没用的变体、默认名", () => {
  const ls = [
    layer(1, "空", "pixel", { bounds: null }), layer(2, "外面", "pixel", { bounds: { left: 3000, top: 0, right: 3100, bottom: 50 } }),
    layer(3, "v2 · 橘子", "smartObject", { visible: false, variationOf: 9 }),
    ...[10, 11, 12, 13, 14].map(i => layer(i, `图层 ${i}`, "pixel", { bounds: { left: i * 10, top: 900, right: i * 10 + 5, bottom: 905 } })),
  ];
  const r = runChecks(doc({}, ls), "screen");
  const by = (k: string) => r.find(i => i.key === k)!;
  assert.deepEqual(by("hyg:empty").fix, { kind: "delete", ids: [1] });
  assert.deepEqual(by("hyg:off").ids, [2]);
  assert.equal(by("hyg:variants").fix?.kind, "deleteVariants");
  assert.equal(by("hyg:names").ids.length, 5);
});

test("一致性：几乎一样的颜色、明显不均匀的间距（1～2 px 不报）", () => {
  const d = doc({ texts: [text(1, { rgb: { r: 255, g: 90, b: 31 } }), text(2, { rgb: { r: 255, g: 91, b: 32 }, bounds: { left: 200, top: 300, right: 400, bottom: 340 } })] });
  assert.ok(keys(d).some(k => k.startsWith("design:colour:")));
  // 1–2 px differences are not reported (rounding); 4 px is
  const row = (d: number) => [0, 1, 2, 3].map(i => layer(10 + i, "格 " + i, "shape", { bounds: { left: 100 + i * 124 + (i === 3 ? d : 0), top: 500, right: 200 + i * 124 + (i === 3 ? d : 0), bottom: 600 } }));
  assert.ok(!keys(doc({}, row(2))).some(k => k.startsWith("design:gap:")));
  assert.ok(keys(doc({}, row(4))).some(k => k.startsWith("design:gap:")));
});

test("背景取色：文字外圈的中位色", () => {
  const W = 20, H = 20, data = new Uint8Array(W * H * 3).fill(255);
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) data.set([0, 0, 0], (y * W + x) * 3);
  assert.deepEqual(ringColor({ width: W, height: H, channels: 3, data }, { left: 8, top: 8, right: 12, bottom: 12 }, 1), { r: 255, g: 255, b: 255 });
});

test("AI 文案：只收文档里有的图层和原文；单一样式才给「采用建议」", () => {
  const texts = [text(1, { contents: "欢迎登陆\r我们的APP" }), text(2, { contents: "全网最低价", ranges: 2 })];
  const r = parseCopyIssues({ issues: [
    { id: 1, type: "typo", original: "登陆", suggestion: "登录", reason: "登录账号用「登录」" },
    { id: 1, type: "typo", original: "不存在的字", suggestion: "x" },
    { id: 99, type: "typo", original: "登陆", suggestion: "登录" },
    { id: 2, type: "ad_law", original: "最低价", suggestion: "超低价", reason: "广告法禁用「最」" },
  ] }, texts);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].fix, { kind: "setText", id: 1, from: "登陆", to: "登录" });
  assert.equal(r[1].fix, undefined);
  assert.equal(replaceOnce("欢迎登陆\r我们的APP", "登陆", "登录"), "欢迎登录\r我们的APP");
  assert.equal(replaceOnce("abc", "x", "y"), null);
  assert.equal(copyPrompt(texts).count, 2);
});

test("AI 画面：没有 problem 的丢掉；JSON 外面有文字也能读", () => {
  assert.equal(parseVisualIssues({ issues: [{ type: "ai_artifact", where: "左手", problem: "六根手指" }, { where: "x" }] }).length, 1);
  assert.deepEqual(parseJsonAnswer("好的，结果如下：\n{\"issues\":[]}\n以上"), { issues: [] });
});
