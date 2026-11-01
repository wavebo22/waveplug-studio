// Minimal PNG decoder (inflate + unfilter) for ComfyUI results: 8/16-bit gray, gray+alpha, RGB,
// RGBA and palette images, not interlaced. UXP has no DecompressionStream, so inflate is done here.

import type { Pixels } from "./png.ts";

// ── inflate (RFC 1951) ──

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Huffman lookup table indexed by the next `bits` input bits (LSB first): symbol << 4 | code length. */
interface Huff { table: Uint16Array; bits: number }

function huff(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16), next = new Uint16Array(16);
  let max = 1;
  for (let i = 0; i < n; i++) { count[lengths[i]]++; if (lengths[i] > max) max = lengths[i]; }
  count[0] = 0;
  for (let len = 1, code = 0; len < 16; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
  const table = new Uint16Array(1 << max);
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let code = next[len]++, rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | (code & 1); code >>= 1; }
    for (let r = rev; r < table.length; r += 1 << len) table[r] = (sym << 4) | len;
  }
  return { table, bits: max };
}

const FIXED = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  return { lit: huff(l, 288), dist: huff(new Uint8Array(30).fill(5), 30) };
})();

/** Inflates a zlib stream into a buffer of the expected size. */
export function inflate(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let pos = 2, bit = 0, buf = 0, o = 0; // skip the 2-byte zlib header
  const bits = (n: number) => {
    while (bit < n) { if (pos >= src.length) throw new Error("PNG 数据不完整"); buf |= src[pos++] << bit; bit += 8; }
    const v = buf & ((1 << n) - 1);
    buf >>>= n; bit -= n;
    return v;
  };
  const decode = (h: Huff) => {
    // past the end the missing bits read as zeros; a valid stream never uses them
    while (bit < h.bits) { buf |= (pos < src.length ? src[pos] : 0) << bit; pos++; bit += 8; }
    const e = h.table[buf & ((1 << h.bits) - 1)], len = e & 15;
    if (!len) throw new Error("PNG 压缩数据无效");
    buf >>>= len; bit -= len;
    return e >> 4;
  };
  for (let final = 0; !final;) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0; bit = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      out.set(src.subarray(pos, pos + len), o);
      pos += len; o += len;
      continue;
    }
    let lit = FIXED.lit, dist = FIXED.dist;
    if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clh = huff(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          const [rep, prev] = sym === 16 ? [3 + bits(2), lens[i - 1]] : sym === 17 ? [3 + bits(3), 0] : [11 + bits(7), 0];
          lens.fill(prev, i, i + rep); i += rep;
        }
      }
      lit = huff(lens.subarray(0, hlit), hlit); dist = huff(lens.subarray(hlit), hdist);
    } else if (type !== 1) throw new Error("PNG 压缩数据无效");
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { out[o++] = sym; continue; }
      if (sym === 256) break;
      const s = sym - 257, len = LEN_BASE[s] + bits(LEN_EXTRA[s]);
      const d = decode(dist), back = DIST_BASE[d] + bits(DIST_EXTRA[d]);
      for (let i = 0; i < len; i++, o++) out[o] = out[o - back];
    }
  }
  return out;
}

// ── PNG ──

/** Decodes a PNG into 8-bit gray / RGB / RGBA pixels. */
export function decodePng(png: Uint8Array): Pixels {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let w = 0, h = 0, depth = 8, type = 2, palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 8 <= png.length;) {
    const len = dv.getUint32(o), t = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const data = png.subarray(o + 8, o + 8 + len);
    if (t === "IHDR") {
      w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = png[o + 16]; type = png[o + 17];
      if (png[o + 20]) throw new Error("不支持隔行扫描的 PNG");
    } else if (t === "PLTE") palette = data;
    else if (t === "tRNS") trns = data;
    else if (t === "IDAT") idat.push(data);
    else if (t === "IEND") break;
    o += 12 + len;
  }
  const comps = type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : 4;
  if (type === 3 ? depth !== 8 : depth !== 8 && depth !== 16) throw new Error(`不支持的 PNG 位深 ${depth}`);
  const bpp = comps * depth / 8, stride = w * bpp;
  const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (z.set(c, o), o + c.length), 0);
  const raw = inflate(z, (stride + 1) * h);
  // unfilter into `img`, one tight loop per filter type
  const img = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (f === 0 || (f === 2 && !y)) img.set(raw.subarray(src, src + stride), row);
    else if (f === 1) {
      for (let x = 0; x < bpp; x++) img[row + x] = raw[src + x];
      for (let x = bpp; x < stride; x++) img[row + x] = raw[src + x] + img[row + x - bpp];
    } else if (f === 2) for (let x = 0; x < stride; x++) img[row + x] = raw[src + x] + img[up + x];
    else if (f === 3) {
      for (let x = 0; x < bpp; x++) img[row + x] = raw[src + x] + (y ? img[up + x] >> 1 : 0);
      for (let x = bpp; x < stride; x++) img[row + x] = raw[src + x] + ((img[row + x - bpp] + (y ? img[up + x] : 0)) >> 1);
    } else if (f === 4) {
      for (let x = 0; x < bpp; x++) img[row + x] = raw[src + x] + (y ? img[up + x] : 0);
      for (let x = bpp; x < stride; x++) {
        const a = img[row + x - bpp], b = y ? img[up + x] : 0, c = y ? img[up + x - bpp] : 0;
        const p = a + b - c, pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
        img[row + x] = raw[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
    } else throw new Error("PNG 过滤类型无效");
  }
  const n = w * h, at = (i: number) => depth === 16 ? img[i * 2] : img[i]; // 16-bit: keep the high byte
  if (type === 3) {
    if (!palette) throw new Error("PNG 缺少调色板");
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const k = img[i];
      out[i * 4] = palette[k * 3]; out[i * 4 + 1] = palette[k * 3 + 1]; out[i * 4 + 2] = palette[k * 3 + 2];
      out[i * 4 + 3] = trns && k < trns.length ? trns[k] : 255;
    }
    return { width: w, height: h, channels: 4, data: out };
  }
  if (type === 4) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { const g = at(i * 2); out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = at(i * 2 + 1); }
    return { width: w, height: h, channels: 4, data: out };
  }
  const ch = comps as 1 | 3 | 4;
  if (depth === 8) return { width: w, height: h, channels: ch, data: img };
  const out = new Uint8Array(n * ch);
  for (let i = 0; i < n * ch; i++) out[i] = img[i * 2];
  return { width: w, height: h, channels: ch, data: out };
}
