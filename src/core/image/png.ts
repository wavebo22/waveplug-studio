// Minimal PNG encoder (8-bit gray / RGB / RGBA). Rows are filtered and deflate-compressed
// (deflate.ts): uncompressed, a large crop passed ComfyUI's 100 MB upload limit.

import { filterRows, zlibDeflate } from "./deflate.ts";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface Pixels {
  width: number;
  height: number;
  /** 1 = gray, 3 = RGB, 4 = RGBA */
  channels: 1 | 3 | 4;
  data: Uint8Array;
}

/** PNG (8-bit gray / RGB / RGBA) with filtered, deflate-compressed rows. */
export function encodePng(p: Pixels): Uint8Array {
  const { width: w, height: h, channels: ch, data } = p;
  if (data.length !== w * h * ch) throw new Error(`像素数据长度 ${data.length} 与 ${w}×${h}×${ch} 不符`);
  const colorType = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  const z = zlibDeflate(filterRows(data, w, h, ch));
  const out = new Uint8Array(8 + (12 + 13) + (12 + z.length) + 12);
  const dv = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  const chunk = (type: string, len: number, write: () => void) => {
    dv.setUint32(o, len); o += 4;
    const start = o;
    for (let i = 0; i < 4; i++) out[o++] = type.charCodeAt(i);
    write();
    dv.setUint32(o, crc32(out, start, o)); o += 4;
  };
  chunk("IHDR", 13, () => {
    dv.setUint32(o, w); dv.setUint32(o + 4, h);
    out[o + 8] = 8; out[o + 9] = colorType; out[o + 10] = 0; out[o + 11] = 0; out[o + 12] = 0;
    o += 13;
  });
  chunk("IDAT", z.length, () => { out.set(z, o); o += z.length; });
  chunk("IEND", 0, () => {});
  return out;
}

/**
 * Prepares a PNG for placing into Photoshop: tags it as sRGB (the colour space it was captured in,
 * so Photoshop converts it into the document's profile instead of reading the numbers as document
 * RGB) and writes the document resolution, so it is placed at 1:1 pixels instead of being scaled
 * to fit the canvas and resampled back. An embedded ICC profile is kept as is.
 */
export function withPlacementHints(png: Uint8Array, dpi: number): Uint8Array {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; start: number; end: number }[] = [];
  for (let o = 8; o + 12 <= png.length;) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    chunks.push({ type, start: o, end: o + 12 + len });
    o += 12 + len;
    if (type === "IEND") break;
  }
  if (!chunks.length || chunks[0].type !== "IHDR") throw new Error("不是有效的 PNG");
  const hasIcc = chunks.some(c => c.type === "iCCP");
  const make = (type: string, data: number[]) => {
    const out = new Uint8Array(12 + data.length), d = new DataView(out.buffer);
    d.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    d.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const ppm = Math.max(1, Math.round(dpi / 0.0254));
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const extra = [make("pHYs", [...u32(ppm), ...u32(ppm), 1])];
  if (!hasIcc) extra.unshift(make("sRGB", [0]));
  const drop = new Set(hasIcc ? ["pHYs"] : ["pHYs", "sRGB", "gAMA", "cHRM"]);
  const parts: Uint8Array[] = [png.subarray(0, 8), png.subarray(chunks[0].start, chunks[0].end), ...extra];
  for (const c of chunks.slice(1)) if (!drop.has(c.type)) parts.push(png.subarray(c.start, c.end));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
