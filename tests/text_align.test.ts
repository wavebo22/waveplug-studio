import { test } from "node:test";
import assert from "node:assert/strict";
import { alignTextBoxes, blockScore, inkMap, snap } from "../src/core/image/textAlign.ts";
import { alignTextParts, parseDecomposeAnswer, withManualBox } from "../src/core/assistant/decompose.ts";
import type { Pixels } from "../src/core/image/png.ts";
import type { Rect } from "../src/core/image/region.ts";

const W = 600, H = 1000;

/** a beige page with paper grain and "text": rows of dark glyph blocks (6 px gaps) in `lines` */
function page(lines: Rect[]): Pixels {
  const data = new Uint8Array(W * H * 3);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let i = 0; i < W * H; i++) { const g = 225 + Math.round(rnd() * 12); data[i * 3] = g; data[i * 3 + 1] = g - 10; data[i * 3 + 2] = g - 35; }
  for (const r of lines) {
    const gh = r.bottom - r.top;
    for (let x0 = r.left; x0 < r.right; x0 += gh + 6) for (let y = r.top; y < r.bottom; y++) for (let x = x0; x < Math.min(r.right, x0 + gh); x++) {
      if ((x + y) % 4 === 0) continue; // strokes, not solid blocks
      const o = (y * W + x) * 3; data[o] = 70; data[o + 1] = 45; data[o + 2] = 20;
    }
  }
  return { width: W, height: H, channels: 3, data };
}

const near = (a: Rect, b: Rect, tol: number) => Math.abs(a.left - b.left) <= tol && Math.abs(a.top - b.top) <= tol && Math.abs(a.right - b.right) <= tol && Math.abs(a.bottom - b.bottom) <= tol;
const shift = (r: Rect, dx: number, dy: number): Rect => ({ left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy });

// the layout: a title, a heading touching its price, a list of three lines, an address
const title = { left: 60, top: 60, right: 300, bottom: 160 };
const heading = { left: 40, top: 600, right: 160, bottom: 630 }, price = { left: 175, top: 585, right: 290, bottom: 640 };
const list = [0, 1, 2].map(k => ({ left: 40, top: 680 + k * 40, right: 280, bottom: 700 + k * 40 }));
const address = { left: 150, top: 940, right: 450, bottom: 955 };
const truth = [title, heading, price, ...list, address];
const m = inkMap(page(truth));

test("墨迹：文字笔画是墨迹，纸张颗粒不是", () => {
  assert.ok(blockScore(m, { left: 400, top: 300, right: 550, bottom: 400 }).dIn < 0.01);
  assert.ok(blockScore(m, title).dIn > 0.3);
});

test("贴边：框大了收到文字上；框被空白隔开的另一块不要", () => {
  const got = snap(m, { left: 40, top: 40, right: 320, bottom: 260 });
  assert.ok(near(got, title, 3), JSON.stringify(got));
});

test("校准：整体偏了大约一行（列表三行一起偏），每块回到自己那行，不落到上一行", () => {
  const given = truth.map(r => shift(r, 10, -70));
  const got = alignTextBoxes(m, given);
  got.forEach((a, i) => {
    assert.ok(a.ok, `第 ${i} 块没校准`);
    assert.ok(near(a.box, truth[i], 4), `第 ${i} 块：${JSON.stringify(a.box)} ≠ ${JSON.stringify(truth[i])}`);
  });
});

test("校准：本来就准的框不被挪走（挨着价格的标题也一样）", () => {
  const got = alignTextBoxes(m, truth.map(r => ({ left: r.left - 3, top: r.top - 2, right: r.right + 4, bottom: r.bottom + 3 })));
  got.forEach((a, i) => assert.ok(near(a.box, truth[i], 4), `第 ${i} 块被挪到 ${JSON.stringify(a.box)}`));
});

test("校准：附近没有文字的框标成未校准，保留原来的框", () => {
  const empty = { left: 380, top: 300, right: 560, bottom: 330 };
  const got = alignTextBoxes(m, [...truth.map(r => shift(r, 0, -20)), empty]);
  const last = got[got.length - 1];
  assert.equal(last.ok, false);
  assert.deepEqual(last.box, empty);
});

test("拆层计划：文字按分析区域和缩放换算后校准，边距变小；物件不动；手动范围直接采用", () => {
  // the picture was read at half size, of the region starting at (100, 50) of a 1300×2100 document
  const size = { width: 1300, height: 2100 }, area = { left: 100, top: 50, right: 1300, bottom: 2050 };
  const toDoc = (r: Rect) => ({ left: r.left * 2 + 100, top: r.top * 2 + 50, right: r.right * 2 + 100, bottom: r.bottom * 2 + 50 });
  const k = (v: number, of: number) => Math.round(v / of * 1000);
  const off = toDoc(shift(list[1], 0, -15)), obj = { left: 600, top: 400, right: 1000, bottom: 900 };
  const plan = parseDecomposeAnswer({ parts: [
    { name: "文字“第二行”", kind: "text", box: [k(off.left - 100, 1200), k(off.top - 50, 2000), k(off.right - 100, 1200), k(off.bottom - 50, 2000)] },
    { name: "插画", kind: "object", box: [k(obj.left - 100, 1200), k(obj.top - 50, 2000), k(obj.right - 100, 1200), k(obj.bottom - 50, 2000)] },
  ] }, size, {}, area);
  const out = alignTextParts(plan, m, area, 0.5, size);
  const [t, o] = out.parts;
  assert.equal(t.aligned, true);
  assert.ok(near(t.raw, toDoc(list[1]), 10), JSON.stringify(t.raw));
  assert.ok(t.box.left >= t.raw.left - 20 && t.box.right <= t.raw.right + 20, "校准后的边距应该很小");
  assert.equal(o.aligned, undefined);
  assert.deepEqual(o.box, plan.parts[1].box);
  const man = withManualBox(o, { left: 10, top: 20, right: 300, bottom: 400 }, size);
  assert.deepEqual(man.raw, { left: 10, top: 20, right: 300, bottom: 400 });
  assert.equal(man.manual, true);
});
