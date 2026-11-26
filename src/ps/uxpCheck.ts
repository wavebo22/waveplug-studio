// 文档检查 in Photoshop: reads what core/check/rules.ts needs — the 文档优化 scan (smart objects,
// links), every text layer's copy, fonts, sizes and colours, the installed fonts, fill / shape
// colours. Read only, apart from setText.
// The first text layers' raw descriptors are logged, so the size / box conversions can be checked
// against a real document (reports/uxp_runtime.log, "check text raw").

import { log } from "../app/log.ts";
import type { CheckDoc, CheckText, CMYK, RGB, StyleEdit } from "../core/check/rules.ts";
import { replaceOnce } from "../core/check/ai.ts";
import type { Rect } from "../core/image/region.ts";
import type { DocChecker } from "./host.ts";
import { docById, findLayer, play, step } from "./uxpHost.ts";
import { act, type UxpTools } from "./uxpTools.ts";

declare const require: (m: string) => any;

const ps = () => require("photoshop");
const num = (v: any): number => typeof v === "number" ? v : Number(v?._value ?? NaN);

/** a colour descriptor as RGB (CMYK and gray converted roughly: enough for contrast and likeness) */
function colourOf(c: any): { rgb?: RGB; cmyk?: CMYK } {
  if (!c || typeof c !== "object") return {};
  if ("red" in c) return { rgb: { r: num(c.red), g: num(c.grain ?? c.green), b: num(c.blue) } };
  if ("cyan" in c) {
    const k = { c: num(c.cyan), m: num(c.magenta), y: num(c.yellowColor ?? c.yellow), k: num(c.black) };
    const f = (x: number) => 255 * (1 - x / 100) * (1 - k.k / 100);
    return { cmyk: k, rgb: { r: f(k.c), g: f(k.m), b: f(k.y) } };
  }
  if ("gray" in c) { const g = 255 * (1 - num(c.gray) / 100); return { rgb: { r: g, g, b: g } }; }
  return {};
}

/** a colour descriptor as the DOM's SolidColor (text colour) */
function solidColour(c: any): any {
  const s = new (ps().app.SolidColor)();
  if ("cyan" in c) { s.cmyk.cyan = num(c.cyan); s.cmyk.magenta = num(c.magenta); s.cmyk.yellow = num(c.yellowColor ?? c.yellow); s.cmyk.black = num(c.black); }
  else if ("red" in c) { s.rgb.red = num(c.red); s.rgb.green = num(c.grain ?? c.green); s.rgb.blue = num(c.blue); }
  else if ("gray" in c) { s.gray.gray = num(c.gray); }
  else throw new Error("不认识的颜色");
  return s;
}

const rectOf = (b: any): Rect | null => {
  if (!b) return null;
  const r = { left: num(b.left), top: num(b.top), right: num(b.right), bottom: num(b.bottom) };
  return [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top ? r : null;
};

export class UxpChecker implements DocChecker {
  constructor(private tools: UxpTools) {}

  async read(docId: number): Promise<CheckDoc | null> {
    const d = ps().app.activeDocument;
    if (!d || d.id !== docId) return null;
    const scan = await this.tools.scanDoc();
    if (!scan) return null;
    const ppi = Number(d.resolution) || 72;
    const modeText = String(d.mode);
    const mode: CheckDoc["mode"] = /CMYK/i.test(modeText) ? "cmyk" : /RGB/i.test(modeText) ? "rgb" : /Gray/i.test(modeText) ? "gray" : /Lab/i.test(modeText) ? "lab" : "other";

    // walk the DOM once for kinds (scanDoc already lists the layers, its kinds are the DOM's)
    const textIds = scan.layers.filter(l => /text/i.test(l.kind)).map(l => l.id);
    const fillIds = scan.layers.filter(l => /solidColor|fill|shape/i.test(l.kind)).map(l => l.id);
    const visible = new Map(scan.layers.map(l => [l.id, l.visible]));

    const texts: CheckText[] = [];
    let logged = 0;
    for (let i = 0; i < textIds.length; i += 40) {
      const chunk = textIds.slice(i, i + 40);
      const res = await play(chunk.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }, { _ref: "document", _id: docId }] })));
      res.forEach((r: any, k: number) => {
        const t = r?.textKey;
        if (!t) return;
        const id = chunk[k];
        const tr = t.transform, scale = tr ? Math.sqrt(Math.abs(num(tr.xx) * num(tr.yy) - num(tr.xy) * num(tr.yx))) || 1 : 1;
        const ranges: any[] = Array.isArray(t.textStyleRange) ? t.textStyleRange : [];
        const styles = ranges.map(x => x?.textStyle ?? {});
        const px = (st: any) => {
          const implied = st.impliedFontSize, size = st.size;
          const v = implied !== undefined ? implied : size;
          const unit = String(v?._unit ?? "");
          const value = num(v);
          if (!Number.isFinite(value)) return NaN;
          if (/pixels/i.test(unit)) return implied !== undefined ? value : value * scale;
          return (implied !== undefined ? value : value * scale) * ppi / 72;
        };
        const sizes = styles.map(px).filter(Number.isFinite);
        const first = colourOf(styles[0]?.color);
        // 段落文字: the box, from the click point and the shape's bounds (points, scaled by the transform)
        let box: Rect | undefined;
        const shape = Array.isArray(t.textShape) ? t.textShape[0] : null;
        const click = t.textClickPoint;
        if (shape && String(shape.char?._value ?? "") === "box" && shape.bounds && click) {
          const ox = num(click.horizontal) / 100 * d.width, oy = num(click.vertical) / 100 * d.height;
          const k2 = ppi / 72 * scale;
          const b = rectOf(shape.bounds);
          if (b && Number.isFinite(ox) && Number.isFinite(oy)) box = { left: ox + b.left * k2, top: oy + b.top * k2, right: ox + b.right * k2, bottom: oy + b.bottom * k2 };
        }
        if (logged < 3) { logged++; log("info", "check text raw", JSON.stringify({ id, scale, style: styles[0], shape, click, bounds: r.boundsNoEffects ?? r.bounds, box, sizes })); }
        texts.push({
          id, name: String(r.name ?? "#" + id), contents: String(t.textKey ?? ""),
          fonts: styles.map(s => String(s.fontPostScriptName ?? "")), fontNames: styles.map(s => String(s.fontName ?? s.fontPostScriptName ?? "")),
          sizesPx: sizes, ...first, ranges: Math.max(1, ranges.length),
          bounds: rectOf(r.boundsNoEffects ?? r.bounds), ...(box ? { box } : {}), visible: visible.get(id) !== false,
        });
      });
    }

    let installed: Set<string> | null = null;
    const fontLabels = new Map<string, string>();
    try {
      for (const f of ps().app.fonts ?? []) { const n = String(f.postScriptName); fontLabels.set(n, String(f.name ?? n)); }
      installed = fontLabels.size ? new Set(fontLabels.keys()) : null;
    } catch (e) { log("warn", "check fonts", e); }

    const fills: { id: number; rgb: RGB }[] = [];
    if (fillIds.length) {
      const res = await play(fillIds.map(id => ({ _obj: "get", _target: [{ _property: "adjustment" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] })));
      res.forEach((r: any, k: number) => {
        const a = Array.isArray(r?.adjustment) ? r.adjustment[0] : null;
        const c = a?._obj === "solidColorLayer" ? colourOf(a.color).rgb : undefined;
        if (c) fills.push({ id: fillIds[k], rgb: c });
      });
    }

    const links = scan.layers.filter(l => l.smart?.linked && (l.smart.linkMissing || l.smart.linkChanged))
      .map(l => ({ id: l.id, missing: !!l.smart!.linkMissing, changed: !!l.smart!.linkChanged }));
    const contentIds = new Map(scan.layers.filter(l => l.smart?.contentId).map(l => [l.id, l.smart!.contentId!]));
    log("info", "check read", JSON.stringify({ layers: scan.layers.length, texts: texts.length, fonts: installed?.size ?? null, fills: fills.length, links: links.length, mode, ppi }));
    return { width: scan.width, height: scan.height, mode, bits: scan.bits, ppi, scan, texts, installed, fontLabels, links, fills, contentIds };
  }

  async restyle(docId: number, edits: StyleEdit[]): Promise<{ done: number; skipped: string[] }> {
    // the colours to copy, as Photoshop describes them (a CMYK file keeps its exact CMYK values)
    const from = [...new Set(edits.map(e => e.colourFrom).filter((x): x is number => x !== undefined))];
    const colours = new Map<number, any>();
    if (from.length) {
      const res = await play(from.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }, { _ref: "document", _id: docId }] })));
      res.forEach((r: any, k: number) => {
        const c = r?.textKey?.textStyleRange?.[0]?.textStyle?.color ?? (Array.isArray(r?.adjustment) ? r.adjustment[0]?.color : undefined);
        if (c) colours.set(from[k], c);
      });
    }
    const skipped: string[] = [];
    let done = 0;
    await step("WavePlug 检查：统一样式", docId, async () => {
      const doc = docById(docId);
      for (const e of edits) {
        const layer = findLayer(doc.layers, e.id);
        if (!layer) { skipped.push(`#${e.id}：图层已不存在`); continue; }
        try {
          const colour = e.colourFrom !== undefined ? colours.get(e.colourFrom)
            : e.cmyk ? { _obj: "CMYKColorClass", cyan: e.cmyk.c, magenta: e.cmyk.m, yellowColor: e.cmyk.y, black: e.cmyk.k } : undefined;
          if (e.colourFrom !== undefined && !colour) throw new Error("读不到要统一成的颜色");
          if (layer.textItem) {
            const cs = layer.textItem.characterStyle;
            const before = { font: cs.font, size: cs.size };
            if (e.font) cs.font = e.font;
            if (e.scale) cs.size = Math.round(Number(cs.size) * e.scale * 100) / 100;
            if (colour) cs.color = solidColour(colour);
            log("info", "check restyle", JSON.stringify({ id: e.id, edit: e, before, after: { font: cs.font, size: cs.size } }));
          } else if (colour) {
            await act({ _obj: "set", _target: [{ _ref: "contentLayer", _id: e.id }], to: { _obj: "solidColorLayer", color: colour } });
          } else throw new Error("不是文字或填充图层");
          done++;
        } catch (err) { skipped.push(`「${layer.name}」：${(err as Error)?.message ?? err}`); }
      }
    });
    return { done, skipped };
  }

  async textInfo(docId: number, ids: number[]): Promise<{ id: number; text: string; ranges: number }[]> {
    const out: { id: number; text: string; ranges: number }[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await play(chunk.map(id => ({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] })));
      res.forEach((r: any, k: number) => {
        const t = r?.textKey;
        if (typeof t?.textKey !== "string") return;
        out.push({ id: chunk[k], text: t.textKey.replace(/\r\n?|\u0003/g, "\n"), ranges: Array.isArray(t.textStyleRange) ? Math.max(1, t.textStyleRange.length) : 1 });
      });
    }
    return out;
  }

  async rewrite(docId: number, edits: { id: number; from: string; to: string }[]): Promise<{ done: number; skipped: string[] }> {
    const skipped: string[] = [];
    let done = 0;
    const norm = (x: string) => x.replace(/\r\n?|\u0003/g, "\n");
    await step("WavePlug AI 改写文字", docId, async () => {
      const doc = docById(docId);
      for (const e of edits) {
        const layer = findLayer(doc.layers, e.id);
        if (!layer?.textItem) { skipped.push(`#${e.id}：文字图层已不存在`); continue; }
        if (norm(String(layer.textItem.contents ?? "")) !== norm(e.from)) { skipped.push(`「${layer.name}」：文字已经改过`); continue; }
        try { layer.textItem.contents = e.to.replace(/\n/g, "\r"); done++; }
        catch (err) { skipped.push(`「${layer.name}」：${(err as Error)?.message ?? err}`); }
      }
    });
    log("info", "ai rewrite", JSON.stringify({ edits: edits.length, done, skipped: skipped.length }));
    return { done, skipped };
  }

  async setText(docId: number, id: number, from: string, to: string): Promise<boolean> {
    return step("WavePlug 采用文案建议", docId, async () => {
      const layer = findLayer(docById(docId).layers, id);
      if (!layer?.textItem) throw new Error("文字图层已不存在");
      const next = replaceOnce(String(layer.textItem.contents ?? ""), from, to);
      if (next === null) return false;
      layer.textItem.contents = next;
      return true;
    });
  }
}
