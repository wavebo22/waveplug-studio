// Minimal PNG encoder (8-bit gray / RGB / RGBA). Uses stored (uncompressed) deflate blocks:
// localhost upload size doesn't matter, encode speed does, and UXP has no CompressionStream.

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

export function encodePng(p: Pixels): Uint8Array {
  const { width: w, height: h, channels: ch, data } = p;
  if (data.length !== w * h * ch) throw new Error(`像素数据长度 ${data.length} 与 ${w}×${h}×${ch} 不符`);
  const colorType = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  const rowLen = w * ch + 1;
  const rawLen = rowLen * h;
  const MAX_BLOCK = 65535;
  const blocks = Math.max(1, Math.ceil(rawLen / MAX_BLOCK));
  const zlibLen = 2 + rawLen + blocks * 5 + 4;
  const total = 8 + (12 + 13) + (12 + zlibLen) + 12;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); o = 8;

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

  chunk("IDAT", zlibLen, () => {
    out[o++] = 0x78; out[o++] = 0x01;
    let a = 1, b = 0; // adler32
    let row = 0, col = 0; // position in the virtual filtered stream
    let remaining = rawLen;
    while (remaining > 0) {
      const len = Math.min(MAX_BLOCK, remaining);
      remaining -= len;
      out[o++] = remaining === 0 ? 1 : 0;
      out[o++] = len & 0xff; out[o++] = len >>> 8;
      out[o++] = ~len & 0xff; out[o++] = (~len >>> 8) & 0xff;
      for (let i = 0; i < len; i++) {
        const byte = col === 0 ? 0 : data[row * w * ch + col - 1];
        out[o++] = byte;
        a = (a + byte) % 65521; b = (b + a) % 65521;
        if (++col === rowLen) { col = 0; row++; }
      }
    }
    dv.setUint32(o, ((b << 16) | a) >>> 0); o += 4;
  });

  chunk("IEND", 0, () => {});
  return out;
}
