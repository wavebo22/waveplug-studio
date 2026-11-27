import { test } from "node:test";
import assert from "node:assert/strict";
import { cellOf, drawLabel, drawSheet, fitCell, sheetLayouts } from "../src/core/image/contactSheet.ts";

test("总览图排版：图层少格子大，最多每格 420；超过 100 个换下一张", () => {
  assert.deepEqual(sheetLayouts(0), []);
  assert.deepEqual(sheetLayouts(1), [{ count: 1, cols: 1, rows: 1, cell: 420 }]);
  assert.deepEqual(sheetLayouts(9), [{ count: 9, cols: 3, rows: 3, cell: 420 }]);
  assert.deepEqual(sheetLayouts(20), [{ count: 20, cols: 5, rows: 4, cell: 256 }]);
  assert.deepEqual(sheetLayouts(100), [{ count: 100, cols: 10, rows: 10, cell: 128 }]);
  const two = sheetLayouts(130);
  assert.deepEqual(two.map(l => [l.count, l.cols, l.cell]), [[100, 10, 128], [30, 6, 213]]);
  assert.ok(two.every(l => l.cols * l.cell <= 1280 && l.rows * l.cell <= 1280));
  assert.deepEqual(cellOf(two, 0), { n: 1, sheet: 0, row: 0, col: 0 });
  assert.deepEqual(cellOf(two, 12), { n: 13, sheet: 0, row: 1, col: 2 });
  assert.deepEqual(cellOf(two, 107), { n: 108, sheet: 1, row: 1, col: 1 });
  assert.equal(cellOf(two, 130), null);
});

test("放进格子：保持比例居中，透明处是灰色", () => {
  // a 4×2 red picture, its right half transparent
  const data = new Uint8Array(4 * 2 * 4);
  for (let i = 0; i < 8; i++) { data[i * 4] = 255; data[i * 4 + 3] = i % 4 < 2 ? 255 : 0; }
  const c = fitCell({ width: 4, height: 2, channels: 4, data }, 20, 2);
  const at = (x: number, y: number) => [...c.data.subarray((y * 20 + x) * 3, (y * 20 + x) * 3 + 3)];
  assert.deepEqual(at(0, 0), [128, 128, 128], "outside the picture: gray");
  assert.deepEqual(at(5, 10), [255, 0, 0], "opaque left half");
  assert.deepEqual(at(15, 10), [128, 128, 128], "transparent right half over gray");
  assert.deepEqual(at(10, 3), [128, 128, 128], "above the 2:1 picture: gray");
  assert.equal(fitCell(null, 8).data.every(v => v === 128), true);
});

test("编号：黑底白字画在左上角；拼图按阅读顺序放格子", () => {
  const img = { width: 40, height: 20, data: new Uint8Array(40 * 20 * 3).fill(128) };
  drawLabel(img, "17", 2);
  assert.equal(img.data[0], 0, "the box");
  // "7"'s top row is all lit: glyph 2 starts at pad 2 + 4 dots × 2 px
  const x = 2 + 8, y = 2;
  assert.equal(img.data[(y * 40 + x) * 3], 255);
  const red = { width: 128, height: 128, data: new Uint8Array(128 * 128 * 3).map((_, i) => i % 3 === 0 ? 255 : 0) };
  const sheet = drawSheet({ count: 2, cols: 2, rows: 1, cell: 128 }, [red, red], 5);
  assert.deepEqual([sheet.width, sheet.height], [256, 128]);
  assert.equal(sheet.data[(64 * 256 + 64) * 3], 255, "first cell's picture");
  assert.equal(sheet.data[(64 * 256 + 128) * 3], 40, "the line between cells");
});
