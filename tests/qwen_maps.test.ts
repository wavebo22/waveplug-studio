import { test } from "node:test";
import assert from "node:assert/strict";
import { fitToArea, isMagenta, qwenInk } from "../src/core/image/qwenMaps.ts";
import { alignTextBoxes, finishInk, inkMap, textUnits } from "../src/core/image/textAlign.ts";
import { expectedChars } from "../src/core/assistant/decompose.ts";
import type { Pixels } from "../src/core/image/png.ts";
import type { Rect } from "../src/core/image/region.ts";

const W = 400, H = 600;

/** glyph blocks (gh × gh, `gap` apart) along `r`, sideways or down */
function glyphs(mask: Uint8Array, r: Rect, gap: number, down = false) {
  const g = down ? r.right - r.left : r.bottom - r.top;
  if (down) for (let y0 = r.top; y0 + g <= r.bottom; y0 += g + gap) for (let y = y0; y < y0 + g; y++) for (let x = r.left; x < r.right; x++) mask[y * W + x] = (x + y) % 5 ? 1 : 0;
  else for (let x0 = r.left; x0 + g <= r.right; x0 += g + gap) for (let y = r.top; y < r.bottom; y++) for (let x = x0; x < x0 + g; x++) mask[y * W + x] = (x + y) % 5 ? 1 : 0;
}

// a list of three lines, two vertical columns side by side, a heading next to a big price
const list = [0, 1, 2].map(k => ({ left: 40, top: 300 + k * 34, right: 198, bottom: 320 + k * 34 }));
const cols = [{ left: 300, top: 40, right: 320, bottom: 198 }, { left: 330, top: 40, right: 350, bottom: 198 }];
const heading = { left: 40, top: 450, right: 158, bottom: 478 }, price = { left: 164, top: 430, right: 224, bottom: 490 };
const mask = new Uint8Array(W * H);
list.forEach(r => glyphs(mask, r, 3));
cols.forEach(r => glyphs(mask, r, 3, true));
glyphs(mask, heading, 2);
glyphs(mask, price, 4);
const m = finishInk(W, H, mask);

const near = (a: Rect, b: Rect, tol = 3) => Math.abs(a.left - b.left) <= tol && Math.abs(a.top - b.top) <= tol && Math.abs(a.right - b.right) <= tol && Math.abs(a.bottom - b.bottom) <= tol;

test("品红：纯品红和抗锯齿的浅品红算文字，红色印章、橙色、灰色不算", () => {
  assert.ok(isMagenta(255, 0, 255) && isMagenta(250, 170, 250));
  assert.ok(!isMagenta(200, 40, 50) && !isMagenta(240, 140, 40) && !isMagenta(200, 200, 200) && !isMagenta(255, 255, 255));
});

test("文字块：列表每行一块、两列竖排各一块（不会横着连成行）、标题和大号价格分开", () => {
  const u = textUnits(m);
  for (const r of [...list, ...cols]) assert.ok(u.some(x => near(x, r)), `没找到 ${JSON.stringify(r)}：${JSON.stringify(u)}`);
  assert.ok(u.some(x => near(x, heading, 4)), "标题");
  assert.ok(!u.some(x => x.left <= heading.left + 2 && x.right >= price.right - 2), "标题和价格连成了一块");
});

test("按文字块校准：整体偏了一行多，字数对得上的那一块胜出；名字里的字数", () => {
  const off = (r: Rect, dy: number): Rect => ({ ...r, top: r.top + dy, bottom: r.bottom + dy });
  const boxes = [off(list[0], -45), off(list[1], -45), off(list[2], -45), off(cols[0], 30), off(cols[1], 30)];
  const got = alignTextBoxes(m, boxes, { units: true, chars: [9, 9, 9, 7, 7] });
  [...list, ...cols].forEach((r, i) => { assert.ok(got[i].ok, `第 ${i} 块没校准`); assert.ok(near(got[i].box, r), `第 ${i} 块 ${JSON.stringify(got[i].box)}`); });
  assert.equal(expectedChars("文字“精选茶饮1壶”"), 5 + 0.55);
  assert.equal(expectedChars("文字“ADD：厦门市……”"), null);
  assert.equal(expectedChars("茶炉静物插画"), null);
});

test("分区图：和原图重合时采用（文字图只有品红，图形图是两张里所有非白色）；对不上时不用", () => {
  const pic = (paint: (x: number, y: number) => [number, number, number]): Pixels => {
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(paint(x, y), (y * W + x) * 3);
    return { width: W, height: H, channels: 3, data };
  };
  const inText = (x: number, y: number) => x >= 40 && x < 200 && y >= 100 && y < 130;
  const inArt = (x: number, y: number) => x >= 100 && x < 300 && y >= 250 && y < 450;
  const original = inkMap(pic((x, y) => inText(x, y) && (x + y) % 3 ? [60, 40, 20] : inArt(x, y) && (x * y) % 7 < 3 ? [90, 60, 30] : [230, 220, 190]));
  const magenta = pic((x, y) => inText(x, y) && (x + y) % 3 ? [255, 0, 255] : inArt(x, y) ? [120, 80, 40] : [255, 255, 255]);
  const black = pic((x, y) => inText(x, y) && (x + y) % 3 ? [0, 0, 0] : inArt(x, y) ? [120, 80, 40] : [255, 255, 255]);
  const q = qwenInk(magenta, black, original);
  assert.ok(q.ok, `重合 ${q.agree}`);
  assert.equal(q.text.ink[115 * W + 61], 1);
  assert.equal(q.text.ink[300 * W + 150], 0);
  assert.equal(q.objects.ink[300 * W + 150], 1);
  const shifted = pic((x, y) => inText(x - 150, y + 200) ? [255, 0, 255] : [255, 255, 255]);
  assert.equal(qwenInk(shifted, null, original).ok, false);
});

test("分区图换算到分析区域：工作流画的是发送范围，取出分析区域那块并缩放", () => {
  // the picture covers the document's 0..200 × 0..100 at half size; the area 50..150 × 0..100 at 50 × 50
  const pic: Pixels = { width: 100, height: 50, channels: 1, data: new Uint8Array(100 * 50).map((_, i) => i % 100) };
  const out = fitToArea(pic, { left: 0, top: 0, right: 200, bottom: 100 }, { left: 50, top: 0, right: 150, bottom: 100 }, { width: 50, height: 50 });
  assert.equal(out.data[0], 25);
  assert.equal(out.data[49], 74);
});
