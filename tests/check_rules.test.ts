import { test } from "node:test";
import assert from "node:assert/strict";
import { type CheckDoc, type CheckText, runChecks } from "../src/core/check/rules.ts";
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
  texts: [], installed: new Set(["SourceHanSansSC-Regular"]), links: [], fills: [], contentIds: new Map(), ...x,
});
const keys = (d: CheckDoc) => runChecks(d).map(i => i.key);

test("缺失字体：按字体归并，列出用它的图层；读不到已装字体时不报", () => {
  const d = doc({ texts: [text(1, { fonts: ["Missing-Bold"], fontNames: ["缺的字体"] }), text(2, { fonts: ["Missing-Bold", "SourceHanSansSC-Regular"], fontNames: ["缺的字体", "思源黑体"] })] });
  const f = runChecks(d).filter(i => i.category === "font");
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].ids, [1, 2]);
  assert.match(f[0].title, /缺的字体/);
  assert.equal(runChecks({ ...d, installed: null }).filter(i => i.category === "font").length, 0);
});

test("智能对象：比显示大很多、比画布大很多、又占用高才算严重；共用内容按最大实例算", () => {
  const smart = (w: number, h: number, q: Quad, extra = {}) => ({ file: "photo.jpg", linked: false, filters: false, shared: false, styled: false, quad: q, width: w, height: h, ...extra });
  // 8000×6000 shown at 400×300: 400× the pixels, 4× the canvas' long edge, ~183 MB
  const huge = layer(1, "大图", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 400, 300)) });
  const r = runChecks(doc({}, [huge])).find(i => i.key.startsWith("smart:big"))!;
  assert.equal(r.severity, "error");
  assert.equal(r.fix?.kind, "shrinkSmart");
  assert.match(r.detail, /4\.2 倍/);
  // the same content shown big elsewhere: not oversized any more
  const big2 = layer(2, "大图 拷贝", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 7000, 5250), { shared: true }) });
  const shared = doc({ contentIds: new Map([[1, "c"], [2, "c"]]) }, [huge, { ...huge, smart: { ...huge.smart!, shared: true } }, big2].slice(1));
  assert.ok(!keys(shared).some(k => k.startsWith("smart:big")));
  // vector content never; small content shown big is blurry instead
  assert.ok(!keys(doc({}, [layer(3, "logo", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 100, 75), { file: "logo.ai" }) })])).length);
  const blur = runChecks(doc({ mode: "cmyk" }, [layer(4, "小图", "smartObject", { smart: smart(200, 100, quad(0, 0, 800, 400)) })])).find(i => i.key.startsWith("smart:up"))!;
  assert.equal(blur.severity, "error");
  // with smart filters: advice, no one-click fix
  const filtered = runChecks(doc({}, [layer(5, "滤镜", "smartObject", { smart: smart(8000, 6000, quad(0, 0, 400, 300), { filters: true }) })])).find(i => i.key.startsWith("smart:big"))!;
  assert.equal(filtered.fix, undefined);
  assert.match(filtered.detail, /智能滤镜/);
});

test("链接丢失和已修改", () => {
  const k = keys(doc({ links: [{ id: 7, missing: true, changed: false }, { id: 8, missing: false, changed: true }] }));
  assert.ok(k.includes("smart:missing:7") && k.includes("smart:changed:8"));
});

test("印刷：只有 CMYK 文件才查分辨率、安全边距、四色黑、小于 6 pt 的字", () => {
  const texts = [text(1, { bounds: { left: 5, top: 500, right: 300, bottom: 540 }, cmyk: { c: 75, m: 68, y: 67, k: 90 }, sizesPx: [10] })];
  const k = keys(doc({ mode: "cmyk", ppi: 150, texts }));
  for (const want of ["del:ppi", "del:bleed", "del:edge", "del:richblack", "del:tiny"]) assert.ok(k.includes(want), want);
  // the same in RGB: nothing judged by device
  assert.ok(!keys(doc({ ppi: 150, texts })).some(x => x.startsWith("del:")));
});

test("文字：占位文字、字号几乎一样；不查对比度和屏幕字号", () => {
  const d = doc({ texts: [text(1, { sizesPx: [9] }), text(2, { contents: "Lorem ipsum" }), text(4, { sizesPx: [23.8] }), text(5, { sizesPx: [24] })] });
  const k = keys(d);
  assert.ok(k.includes("text:placeholder:2") && k.includes("text:size:23.8:24"));
  assert.ok(!k.some(x => x.startsWith("text:contrast") || x === "text:tiny"));
  // 31.8 / 32.4: a real difference, not a slip
  assert.ok(!keys(doc({ texts: [text(6, { sizesPx: [31.8] }), text(7, { sizesPx: [32.4] })] })).some(x => x.startsWith("text:size")));
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
  const r = runChecks(doc({}, ls));
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

test("一键统一：缺失字体给几个替换选项，只改整层都是这个字体的；混排的说明要手动改", () => {
  const d = doc({ installed: new Set(["SourceHanSansSC-Regular", "MicrosoftYaHei"]), fontLabels: new Map([["SourceHanSansSC-Regular", "思源黑体"]]),
    texts: [text(1, { fonts: ["Missing-Bold"], fontNames: ["缺"] }), text(2, { fonts: ["Missing-Bold", "SourceHanSansSC-Regular"], fontNames: ["缺", "思源黑体"], ranges: 2 }), text(3)] });
  const f = runChecks(d).find(i => i.key === "font:Missing-Bold")!;
  assert.deepEqual(f.choices!.map(c => c.label), ["换成「思源黑体」", "换成「MicrosoftYaHei」"]);
  assert.deepEqual(f.choices![1].fix, { kind: "restyle", edits: [{ id: 1, font: "MicrosoftYaHei" }] });
  assert.equal(f.fix, f.choices![0].fix);
  assert.match(f.detail, /1 个图层是混排样式/);
});

test("一键统一：颜色和字号统一成用得多的那个；四色黑小字改单黑", () => {
  const near = runChecks(doc({ texts: [text(1, { rgb: { r: 255, g: 90, b: 31 } }), text(2, { rgb: { r: 255, g: 90, b: 31 } }), text(3, { rgb: { r: 255, g: 92, b: 33 } })] }))
    .find(i => i.key.startsWith("design:colour"))!;
  assert.deepEqual(near.fix, { kind: "restyle", edits: [{ id: 3, colourFrom: 1 }] });
  assert.equal(near.fixLabel, "统一成 #FF5A1F");
  const size = runChecks(doc({ texts: [text(1, { sizesPx: [24] }), text(2, { sizesPx: [24] }), text(3, { sizesPx: [23.8] }), text(4, { sizesPx: [24, 40], ranges: 2 }), text(5, { sizesPx: [23.8], ranges: 3 })] }))
    .find(i => i.key.startsWith("text:size"))!;
  assert.deepEqual(size.fix, { kind: "restyle", edits: [{ id: 3, scale: 24 / 23.8 }] });
  assert.match(size.detail, /1 个图层是混排样式/);
  const rich = runChecks(doc({ mode: "cmyk", ppi: 300, texts: [text(1, { sizesPx: [30], cmyk: { c: 60, m: 50, y: 50, k: 100 } })] })).find(i => i.key === "del:richblack")!;
  assert.deepEqual(rich.fix, { kind: "restyle", edits: [{ id: 1, cmyk: { c: 0, m: 0, y: 0, k: 100 } }] });
});
