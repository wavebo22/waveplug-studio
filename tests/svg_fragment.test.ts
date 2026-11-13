import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeXml, opacity01, pathData, px, rgbHex, textLineRanges, vectorFragment } from "../src/core/overlay/svgFragment.ts";

const pt = (v: number) => ({ _unit: "pointsUnit", _value: v });
const pct = (v: number) => ({ _unit: "percentUnit", _value: v });
const dist = (v: number) => ({ _unit: "distanceUnit", _value: v });
const rgb = (r: number, g: number, b: number) => ({ _obj: "RGBColor", red: r, grain: g, blue: b });
const base = { res: 144, docW: 1000, docH: 500 };

test("SVG 片段：单位换算（点按分辨率、百分比按文档尺寸、像素原样）", () => {
  assert.equal(px(pt(36), 144), 72);
  assert.equal(px(dist(10), 72), 10);
  assert.equal(px(pct(50), 72, 1000), 500);
  assert.equal(px({ _unit: "pixelsUnit", _value: 7 }, 300), 7);
  assert.equal(px(5, 300), 5);
});

test("SVG 片段：颜色、不透明度、转义", () => {
  assert.equal(rgbHex(rgb(255, 128, 0)), "#ff8000");
  assert.equal(rgbHex({ _obj: "CMYKColorClass", cyan: 1 }), null);
  assert.equal(opacity01(255), 1);
  assert.equal(opacity01(pct(50)), 0.5);
  assert.equal(opacity01(undefined), 1);
  assert.equal(escapeXml(`<a&"'>`), "&lt;a&amp;&quot;&apos;&gt;");
});

test("SVG 片段：文字按 \\r 分行", () => {
  assert.deepEqual(textLineRanges("ab\rc"), [[0, 2], [3, 4]]);
  assert.deepEqual(textLineRanges("x"), [[0, 1]]);
});

const textLayer = (over: any = {}) => ({
  textKey: {
    textKey: "你好\rWorld",
    textClickPoint: { horizontal: pct(10), vertical: pct(20) },
    textShape: [{ char: { _value: "point" }, orientation: { _value: "horizontal" } }],
    textStyleRange: [
      { from: 0, to: 3, textStyle: { fontPostScriptName: "SourceHanSansSC-Bold", size: pt(36), color: rgb(255, 0, 0) } },
      { from: 3, to: 8, textStyle: { fontPostScriptName: "Arial-BoldMT", size: pt(18), color: rgb(0, 0, 255), tracking: 100 } },
    ],
    paragraphStyleRange: [{ from: 0, to: 8, paragraphStyle: { align: { _value: "center" } } }],
    ...over,
  },
  opacity: 255, fillOpacity: 255,
});

test("SVG 片段：点文字 → 可编辑 <text>，多行多样式，居中，效果不带", () => {
  const r = vectorFragment({ kind: "text", layer: textLayer(), ...base });
  assert.ok(r.svg, JSON.stringify(r));
  const svg = r.svg!;
  assert.match(svg, /^<text transform="translate\(100 100\)" text-anchor="middle"/);
  assert.match(svg, /<tspan x="0" y="0" font-size="72" fill="#ff0000" font-family="'SourceHanSansSC-Bold'">你好<\/tspan>/);
  // second line: leading = 1.2 × the line's size (36 px)
  assert.match(svg, /<tspan x="0" y="43.2" font-size="36" fill="#0000ff" font-family="'Arial-BoldMT'" letter-spacing="3.6">World<\/tspan>/);
  assert.doesNotMatch(svg, /filter|stroke/);
});

test("SVG 片段：变换文字用基础字号和 matrix", () => {
  const r = vectorFragment({ kind: "text", layer: textLayer({ transform: { xx: 2, xy: 0, yx: 0, yy: 2, tx: 0, ty: 0 },
    textStyleRange: [{ from: 0, to: 8, textStyle: { size: pt(10), impliedFontSize: pt(20), color: rgb(0, 0, 0) } }] }), ...base });
  assert.match(r.svg!, /transform="matrix\(2 0 0 2 100 100\)"/);
  assert.match(r.svg!, /font-size="20"/); // 10 pt at 144 ppi, not the implied 20 pt
});

test("SVG 片段：变形文字、竖排、非 RGB 颜色回退为 PNG", () => {
  assert.equal(vectorFragment({ kind: "text", layer: textLayer({ warp: { warpStyle: { _value: "warpArc" } } }), ...base }).svg, null);
  assert.equal(vectorFragment({ kind: "text", layer: textLayer({ textShape: [{ orientation: { _value: "vertical" } }] }), ...base }).svg, null);
  assert.equal(vectorFragment({ kind: "text", layer: textLayer({ textStyleRange: [{ from: 0, to: 8, textStyle: { size: pt(10), color: { _obj: "grayscale", gray: 1 } } }] }), ...base }).svg, null);
});

const anchor = (x: number, y: number) => ({ anchor: { horizontal: dist(x), vertical: dist(y) } });
const rect = (x0: number, y0: number, x1: number, y1: number, op = "add") => ({
  shapeOperation: { _value: op },
  subpathListKey: [{ closedSubpath: true, points: [anchor(x0, y0), anchor(x1, y0), anchor(x1, y1), anchor(x0, y1)] }],
});

test("SVG 片段：形状路径（直线段写成控制点等于锚点的曲线），减去时 evenodd", () => {
  const one = pathData({ pathComponents: [rect(0, 0, 10, 10)] }, 72, 100, 100);
  assert.equal(one.d, "M0 0C0 0 10 0 10 0C10 0 10 10 10 10C10 10 0 10 0 10C0 10 0 0 0 0Z");
  const holed = pathData({ pathComponents: [rect(0, 0, 10, 10), rect(2, 2, 8, 8, "subtract")] }, 72, 100, 100);
  assert.ok(holed.d && "evenodd" in holed && holed.evenodd);
  assert.equal(pathData({ pathComponents: [rect(0, 0, 1, 1), rect(0, 0, 1, 1, "interfaceIconFrameDimmed")] }, 72, 1, 1).d, null);
});

test("SVG 片段：纯色形状 + 描边；渐变填充回退", () => {
  const layer = {
    adjustment: [{ _obj: "solidColorLayer", color: rgb(0, 255, 0) }],
    AGMStrokeStyleInfo: { strokeEnabled: true, fillEnabled: true, strokeStyleLineWidth: pt(2), strokeStyleContent: { _obj: "solidColorLayer", color: rgb(0, 0, 0) }, strokeStyleLineJoinType: { _value: "strokeStyleRoundJoin" } },
    opacity: 128,
  };
  const r = vectorFragment({ kind: "shape", layer, path: { pathContents: { pathComponents: [rect(0, 0, 5, 5)] } }, res: 144, docW: 10, docH: 10 });
  assert.match(r.svg!, /^<path d="M0 0C/);
  assert.match(r.svg!, /fill="#00ff00" stroke="#000000" stroke-width="4" stroke-linejoin="round" opacity="0.502"\/>$/);
  const g = vectorFragment({ kind: "shape", layer: { adjustment: [{ _obj: "gradientLayer" }] }, path: { pathContents: { pathComponents: [rect(0, 0, 5, 5)] } }, ...base });
  assert.equal(g.svg, null);
  assert.match((g as any).reason, /gradientLayer/);
});
