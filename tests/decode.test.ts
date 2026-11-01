import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng } from "../src/core/image/decode.ts";
import { encodePng, type Pixels } from "../src/core/image/png.ts";
import { bleedTransparent, resizeAlpha, withAlpha } from "../src/core/image/compose.ts";

/** A compressed PNG like the ones ComfyUI (PIL) writes, using filter `(y % 5)` on row y. */
function zpng(p: Pixels): Uint8Array {
  const ch = p.channels, stride = p.width * ch, raw = new Uint8Array((stride + 1) * p.height);
  const at = (x: number, y: number) => x < 0 || y < 0 ? 0 : p.data[y * stride + x];
  for (let y = 0; y < p.height; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = at(x - ch, y), b = at(x, y - 1), c = at(x - ch, y - 1), v = at(x, y);
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const stored = encodePng(p); // reuse its IHDR, swap the IDAT
  const ihdr = stored.subarray(8, 8 + 25), z = deflateSync(raw, { level: 9 });
  const idat = new Uint8Array(12 + z.length), dv = new DataView(idat.buffer);
  dv.setUint32(0, z.length); idat.set([73, 68, 65, 84], 4); idat.set(z, 8);
  return new Uint8Array([...stored.subarray(0, 8), ...ihdr, ...idat, 0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82]);
}

const noise = (w: number, h: number, ch: 3 | 4): Pixels => {
  const data = new Uint8Array(w * h * ch);
  let s = 7;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) >>> 0; data[i] = i % 3 === 0 ? (i >> 4) & 255 : s >>> 24; }
  return { width: w, height: h, channels: ch, data };
};

test("PNG decode: stored and compressed, all filter types", () => {
  for (const p of [noise(37, 23, 3), noise(64, 40, 4), noise(1, 1, 3)]) {
    assert.deepEqual(decodePng(encodePng(p)), p);
    assert.deepEqual(decodePng(zpng(p)), p);
  }
});

test("transparent layer: bleed fills hidden pixels, alpha is resized and merged", () => {
  const p: Pixels = { width: 4, height: 1, channels: 4, data: new Uint8Array([0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 0, 0, 0, 0, 0]) };
  assert.deepEqual([...bleedTransparent(p).data], [10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
  const a = resizeAlpha(p, 8, 2);
  assert.equal(a.data.length, 16);
  assert.equal(a.data[0], 0);
  assert.ok(a.data[3] > 100, "the opaque pixel stays opaque-ish");
  const rgba = withAlpha({ width: 8, height: 2, channels: 3, data: new Uint8Array(48).fill(9) }, a);
  assert.equal(rgba.data[3 * 4 + 3], a.data[3]);
});
