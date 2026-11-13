/**
 * Photoshop layer descriptors → SVG fragments, for drags into vector programs (Illustrator):
 * text stays editable text, shapes stay paths. Coordinates are document pixels; the helper
 * puts the fragments (and the pixel layers as embedded PNGs) into one SVG.
 *
 * Layer effects are dropped on purpose (the text stays editable). Anything this can't express
 * faithfully returns a reason instead, and the layer goes as its PNG.
 */

export interface VectorInput {
  kind: "text" | "shape";
  /** batchPlay `get` of the layer (textKey, adjustment, AGMStrokeStyleInfo, opacity, fillOpacity) */
  layer: any;
  /** batchPlay `get` of the layer's vector mask path (shapes) */
  path?: any;
  /** document resolution (ppi) and size (px) */
  res: number;
  docW: number;
  docH: number;
}

export type VectorResult = { svg: string } | { svg: null; reason: string };

const fail = (reason: string): VectorResult => ({ svg: null, reason });

const n = (v: unknown): number => {
  const x = typeof v === "object" && v !== null && "_value" in v ? Number((v as any)._value) : Number(v);
  return Number.isFinite(x) ? x : NaN;
};

/** A Photoshop length in document pixels: points / distance at the document's resolution,
 *  percent of `size`, pixels as they are. */
export function px(v: unknown, res: number, size = 0): number {
  const unit = typeof v === "object" && v !== null ? String((v as any)._unit ?? "") : "";
  const x = n(v);
  if (unit === "pointsUnit" || unit === "distanceUnit") return x * res / 72;
  if (unit === "percentUnit") return x / 100 * size;
  return x;
}

const r3 = (x: number) => String(Math.round(x * 1000) / 1000);

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** "#rrggbb" for an RGB colour descriptor; null for other colour models. */
export function rgbHex(c: any): string | null {
  if (!c || (c._obj && c._obj !== "RGBColor")) return null;
  const parts = [c.red, c.grain ?? c.green, c.blue].map(n);
  if (parts.some(x => !Number.isFinite(x))) return null;
  return "#" + parts.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
}

/** 0–1 from a layer's opacity (0–255, or a percent descriptor). */
export function opacity01(v: unknown): number {
  if (v === undefined || v === null) return 1;
  const unit = typeof v === "object" ? String((v as any)._unit ?? "") : "";
  const x = n(v);
  if (!Number.isFinite(x)) return 1;
  return Math.max(0, Math.min(1, unit === "percentUnit" ? x / 100 : x / 255));
}

/** The layer's opacity and fill opacity (fill opacity is what Photoshop applies before effects). */
function opacityAttrs(layer: any): string {
  const o = opacity01(layer?.opacity), f = opacity01(layer?.fillOpacity);
  return (o < 1 ? ` opacity="${r3(o)}"` : "") + (f < 1 ? ` fill-opacity="${r3(f)}"` : "");
}

// ── text ──

interface Run { from: number; to: number; style: any }

/** Lines of a text layer: [start, end) in the text, split on Photoshop's \r (and \n). */
export function textLineRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\r" || c === "\n" || c === "\u0003") { out.push([start, i]); start = i + 1; }
  }
  out.push([start, text.length]);
  return out;
}

function runsIn(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const a = Math.max(from, r.from), b = Math.min(to, r.to);
    if (b > a) out.push({ from: a, to: b, style: r.style });
  }
  return out;
}

function sizePx(style: any, res: number, transformed: boolean): number {
  // with a transform the matrix carries the scale: the base size; else the size as shown
  const v = transformed ? style?.size : (style?.impliedFontSize ?? style?.size);
  return px(v, res);
}

function leadingPx(style: any, res: number, size: number, transformed: boolean): number {
  if (style?.autoLeading !== false) return size * 1.2;
  const v = transformed ? style?.leading : (style?.impliedLeading ?? style?.leading);
  const l = px(v, res);
  return Number.isFinite(l) && l > 0 ? l : size * 1.2;
}

function runAttrs(style: any, res: number, transformed: boolean): string | null {
  const fill = rgbHex(style?.color ?? { _obj: "RGBColor", red: 0, grain: 0, blue: 0 });
  if (!fill) return null;
  const size = sizePx(style, res, transformed);
  if (!(size > 0)) return null;
  const font = String(style?.fontPostScriptName ?? style?.fontName ?? "");
  let a = ` font-size="${r3(size)}" fill="${fill}"`;
  if (font) a += ` font-family="'${escapeXml(font)}'"`;
  const tracking = n(style?.tracking);
  if (Number.isFinite(tracking) && tracking !== 0) a += ` letter-spacing="${r3(tracking / 1000 * size)}"`;
  if (style?.fauxBold) a += ` font-weight="bold"`;
  if (style?.fauxItalic) a += ` font-style="italic"`;
  const deco = [
    String(style?.underline?._value ?? "underlineOff") !== "underlineOff" ? "underline" : "",
    String(style?.strikethrough?._value ?? "strikethroughOff") !== "strikethroughOff" ? "line-through" : "",
  ].filter(Boolean).join(" ");
  if (deco) a += ` text-decoration="${deco}"`;
  return a;
}

const ANCHOR: Record<string, string> = { left: "start", center: "middle", right: "end", justifyLeft: "start", justifyCenter: "middle", justifyRight: "end", justifyAll: "start" };

export function textFragment(input: VectorInput): VectorResult {
  const t = input.layer?.textKey;
  if (!t) return fail("no textKey");
  const text = String(t.textKey ?? "");
  if (!text.trim()) return fail("empty text");
  const warp = String(t.warp?.warpStyle?._value ?? "warpNone");
  if (warp !== "warpNone") return fail(`warped text (${warp})`);
  const shape = Array.isArray(t.textShape) ? t.textShape[0] : undefined;
  if (String(shape?.orientation?._value ?? "horizontal") !== "horizontal") return fail("vertical text");
  const box = String(shape?.char?._value ?? "point") === "paragraph";
  const { res, docW, docH } = input;
  const cx = px(t.textClickPoint?.horizontal, res, docW), cy = px(t.textClickPoint?.vertical, res, docH);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return fail("no text position");
  const m = t.transform;
  const transformed = !!m && [m.xx, m.xy, m.yx, m.yy].every(v => Number.isFinite(n(v)))
    && !(n(m.xx) === 1 && n(m.xy) === 0 && n(m.yx) === 0 && n(m.yy) === 1);

  const ranges: any[] = Array.isArray(t.textStyleRange) ? t.textStyleRange : [];
  const runs: Run[] = ranges.map(r => ({ from: n(r.from), to: n(r.to), style: r.textStyle }))
    .filter(r => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from);
  if (!runs.length) runs.push({ from: 0, to: text.length, style: {} });
  const firstStyle = runs[0].style;
  const para = Array.isArray(t.paragraphStyleRange) ? t.paragraphStyleRange[0]?.paragraphStyle : undefined;
  const align = String(para?.align?._value ?? "left");
  const anchor = ANCHOR[align] ?? "start";

  // where the first baseline starts, relative to the click point
  let x0 = 0, y0 = 0;
  if (box) {
    const b = shape?.bounds ?? {};
    const left = px(b.left, res), right = px(b.right, res), top = px(b.top, res);
    if (![left, right, top].every(Number.isFinite)) return fail("no text box bounds");
    x0 = anchor === "middle" ? (left + right) / 2 : anchor === "end" ? right : left;
    y0 = top + sizePx(firstStyle, res, transformed) * 0.88;
  }

  const parts: string[] = [];
  let y = y0;
  const lines = textLineRanges(text);
  for (const [li, [from, to]] of lines.entries()) {
    const lineRuns = runsIn(runs, from, to);
    // an empty line keeps the style of the run it sits in
    const styles = lineRuns.length ? lineRuns.map(r => r.style) : [runs.find(r => r.from <= from && from < r.to)?.style ?? firstStyle];
    const lead = Math.max(...styles.map(st => leadingPx(st, res, sizePx(st, res, transformed), transformed)));
    if (li > 0) y += lead;
    for (const [ri, r] of lineRuns.entries()) {
      const attrs = runAttrs(r.style, res, transformed);
      if (attrs === null) return fail("text colour is not RGB");
      const pos = ri === 0 ? ` x="${r3(x0)}" y="${r3(y)}"` : "";
      parts.push(`<tspan${pos}${attrs}>${escapeXml(text.slice(r.from, r.to))}</tspan>`);
    }
  }
  const matrix = transformed
    ? `matrix(${[m.xx, m.xy, m.yx, m.yy].map(v => r3(n(v))).join(" ")} ${r3(cx)} ${r3(cy)})`
    : `translate(${r3(cx)} ${r3(cy)})`;
  const svg = `<text transform="${matrix}" text-anchor="${anchor}" xml:space="preserve"${opacityAttrs(input.layer)}>${parts.join("")}</text>`;
  return { svg };
}

// ── shapes ──

const point = (p: any, res: number, docW: number, docH: number): [number, number] | null => {
  if (!p) return null;
  const x = px(p.horizontal, res, docW), y = px(p.vertical, res, docH);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
};

/** SVG path data for a vector mask's components; null when a component can't be drawn. */
export function pathData(contents: any, res: number, docW: number, docH: number): { d: string; evenodd: boolean } | { d: null; reason: string } {
  const comps: any[] = contents?.pathComponents ?? [];
  if (!comps.length) return { d: null, reason: "no path components" };
  let evenodd = false;
  const out: string[] = [];
  for (const c of comps) {
    const op = String(c?.shapeOperation?._value ?? "add");
    if (op === "interfaceIconFrameDimmed" || op === "intersect") return { d: null, reason: "intersecting shapes" };
    if (op === "subtract" || op === "xor") evenodd = true;
    const subs: any[] = c?.subpathListKey ?? [];
    if (!subs.length) return { d: null, reason: "component without points" };
    for (const s of subs) {
      const pts: any[] = s?.points ?? [];
      if (!pts.length) return { d: null, reason: "subpath without points" };
      const A = pts.map(p => point(p.anchor, res, docW, docH));
      if (A.some(a => !a)) return { d: null, reason: "bad anchor" };
      const F = pts.map((p, i) => point(p.forward, res, docW, docH) ?? A[i]!);
      const B = pts.map((p, i) => point(p.backward, res, docW, docH) ?? A[i]!);
      const seg = (i: number, j: number) => `C${r3(F[i][0])} ${r3(F[i][1])} ${r3(B[j][0])} ${r3(B[j][1])} ${r3(A[j]![0])} ${r3(A[j]![1])}`;
      let d = `M${r3(A[0]![0])} ${r3(A[0]![1])}`;
      for (let i = 1; i < pts.length; i++) d += seg(i - 1, i);
      if (s?.closedSubpath !== false) d += seg(pts.length - 1, 0) + "Z";
      out.push(d);
    }
  }
  return { d: out.join(""), evenodd };
}

export function shapeFragment(input: VectorInput): VectorResult {
  const { layer, res, docW, docH } = input;
  const contents = input.path?.pathContents ?? input.path;
  const pd = pathData(contents, res, docW, docH);
  if (pd.d === null) return fail(pd.reason);
  const fillLayer = Array.isArray(layer?.adjustment) ? layer.adjustment[0] : undefined;
  const stroke = layer?.AGMStrokeStyleInfo;
  const fillOn = stroke?.fillEnabled !== false;
  let fill = "none";
  if (fillOn) {
    if (!fillLayer || fillLayer._obj !== "solidColorLayer") return fail(`fill is ${fillLayer?._obj ?? "missing"}`);
    const hex = rgbHex(fillLayer.color);
    if (!hex) return fail("fill colour is not RGB");
    fill = hex;
  }
  let a = ` d="${pd.d}" fill="${fill}"`;
  if (pd.evenodd) a += ` fill-rule="evenodd"`;
  if (stroke?.strokeEnabled) {
    const content = stroke.strokeStyleContent;
    if (!content || content._obj !== "solidColorLayer") return fail(`stroke is ${content?._obj ?? "missing"}`);
    const hex = rgbHex(content.color);
    if (!hex) return fail("stroke colour is not RGB");
    const w = px(stroke.strokeStyleLineWidth, res);
    if (!(w > 0)) return fail("no stroke width");
    a += ` stroke="${hex}" stroke-width="${r3(w)}"`;
    const so = opacity01(stroke.strokeStyleOpacity ?? { _unit: "percentUnit", _value: 100 });
    if (so < 1) a += ` stroke-opacity="${r3(so)}"`;
    const cap = String(stroke.strokeStyleLineCapType?._value ?? "");
    if (cap === "strokeStyleRoundCap") a += ` stroke-linecap="round"`;
    else if (cap === "strokeStyleSquareCap") a += ` stroke-linecap="square"`;
    const join = String(stroke.strokeStyleLineJoinType?._value ?? "");
    if (join === "strokeStyleRoundJoin") a += ` stroke-linejoin="round"`;
    else if (join === "strokeStyleBevelJoin") a += ` stroke-linejoin="bevel"`;
    const dash: any[] = Array.isArray(stroke.strokeStyleLineDashSet) ? stroke.strokeStyleLineDashSet : [];
    if (stroke.strokeStyleLineDashSet && dash.length) a += ` stroke-dasharray="${dash.map(v => r3(n(v) * w)).join(" ")}"`;
  }
  return { svg: `<path${a}${opacityAttrs(layer)}/>` };
}

export function vectorFragment(input: VectorInput): VectorResult {
  try {
    return input.kind === "text" ? textFragment(input) : shapeFragment(input);
  } catch (e) {
    return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
