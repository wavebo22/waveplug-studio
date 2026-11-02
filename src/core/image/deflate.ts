// zlib/deflate compressor for the PNGs sent to ComfyUI (UXP has no CompressionStream). zlib's
// Z_RLE strategy: runs of one byte value become distance-1 matches, everything else literals, each
// block with its own (dynamic) Huffman code. On PNG-filtered rows that is fast and close to zlib's
// default level for photos; flat poster areas collapse to almost nothing.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** match length (3–258) → length symbol index (0–28) */
const LEN_SYM = (() => { const t = new Uint8Array(259); for (let i = 0; i < 29; i++) for (let l = LEN_BASE[i]; l < (LEN_BASE[i + 1] ?? 259); l++) t[l] = i; t[258] = 28; return t; })();
/** input bytes per block: each block gets a code fitted to its own statistics */
const BLOCK = 1 << 18;

/** Huffman code lengths (≤ maxLen) for the frequencies; unused symbols get 0. */
export function codeLengths(freq: ArrayLike<number>, maxLen: number): Uint8Array {
  const lens = new Uint8Array(freq.length);
  let f = Array.from(freq);
  for (;;) {
    const used = f.map((v, i) => [v, i] as [number, number]).filter(([v]) => v > 0).sort((x, y) => x[0] - y[0]);
    if (!used.length) return lens;
    if (used.length === 1) { lens[used[0][1]] = 1; return lens; }
    // two-queue Huffman: leaves 0..L-1 (sorted), merged nodes L.. (created in increasing weight)
    const L = used.length, weight = used.map(([v]) => v), parent = new Int32Array(2 * L - 1);
    let li = 0, mi = L;
    const pick = () => (li < L && (mi >= weight.length || weight[li] <= weight[mi]) ? li++ : mi++);
    for (let k = 0; k < L - 1; k++) {
      const x = pick(), y = pick(), id = weight.length;
      weight.push(weight[x] + weight[y]); parent[x] = id; parent[y] = id;
    }
    const depth = new Int32Array(weight.length);
    for (let i = weight.length - 2; i >= 0; i--) depth[i] = depth[parent[i]] + 1;
    let max = 0;
    for (let i = 0; i < L; i++) { lens[used[i][1]] = depth[i]; if (depth[i] > max) max = depth[i]; }
    if (max <= maxLen) return lens;
    // too deep: flatten the statistics and try again
    f = f.map(v => (v > 0 ? Math.max(1, v >> 1) : 0));
    lens.fill(0);
  }
}

/** Canonical codes for the lengths, bit-reversed for an LSB-first stream. */
function codes(lens: Uint8Array): Uint16Array {
  const count = new Uint16Array(16), next = new Uint16Array(16), out = new Uint16Array(lens.length);
  for (const l of lens) count[l]++;
  count[0] = 0;
  for (let l = 1, c = 0; l < 16; l++) { c = (c + count[l - 1]) << 1; next[l] = c; }
  for (let s = 0; s < lens.length; s++) {
    const l = lens[s];
    if (!l) continue;
    let c = next[l]++, r = 0;
    for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    out[s] = r;
  }
  return out;
}

/** zlib stream (header, dynamic-Huffman deflate blocks, Adler-32) of `data`. */
export function zlibDeflate(data: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(1024, (data.length >>> 1) + 1024)), o = 2, bits = 0, nbits = 0;
  out[0] = 0x78; out[1] = 0x01;
  const put = (v: number, n: number) => {
    bits |= v << nbits; nbits += n;
    while (nbits >= 8) {
      if (o >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; }
      out[o++] = bits & 0xff; bits >>>= 8; nbits -= 8;
    }
  };
  const n = data.length;
  // tokens of one block: literal byte (< 256) or 256 + run length
  const tok = new Uint16Array(BLOCK);
  for (let start = 0; start < n || start === 0;) {
    const end = Math.min(n, start + BLOCK);
    let t = 0;
    for (let i = start; i < end;) {
      const v = data[i];
      if (i > start && data[i - 1] === v) {
        let l = 0;
        const max = Math.min(258, end - i);
        while (l < max && data[i + l] === v) l++;
        if (l >= 3) { tok[t++] = 256 + l; i += l; continue; }
      }
      tok[t++] = v; i++;
    }
    // statistics and codes for this block
    const lf = new Uint32Array(286), df = new Uint32Array(30);
    let runs = 0;
    for (let k = 0; k < t; k++) { const v = tok[k]; if (v < 256) lf[v]++; else { lf[257 + LEN_SYM[v - 256]]++; runs++; } }
    lf[256] = 1;
    df[0] = Math.max(1, runs);
    const ll = codeLengths(lf, 15), dl = codeLengths(df, 15);
    const lc = codes(ll), dc = codes(dl);
    let hlit = 286; while (hlit > 257 && !ll[hlit - 1]) hlit--;
    const hdist = 1;
    // code-length sequence, run-length coded with 16 / 17 / 18
    const seq = [...ll.subarray(0, hlit), ...dl.subarray(0, hdist)];
    const cl: [number, number][] = []; // [symbol, extra]
    for (let i = 0; i < seq.length;) {
      const v = seq[i];
      let r = 1;
      while (i + r < seq.length && seq[i + r] === v) r++;
      if (v === 0 && r >= 3) { const m = Math.min(r, 138); cl.push(m >= 11 ? [18, m - 11] : [17, m - 3]); i += m; continue; }
      if (v !== 0 && r >= 4) { cl.push([v, 0]); const m = Math.min(r - 1, 6); cl.push([16, m - 3]); i += 1 + m; continue; }
      cl.push([v, 0]); i++;
    }
    const cf = new Uint32Array(19);
    for (const [s] of cl) cf[s]++;
    const cll = codeLengths(cf, 7), clc = codes(cll);
    let hclen = 19; while (hclen > 4 && !cll[CL_ORDER[hclen - 1]]) hclen--;
    // block header
    put(end >= n ? 1 : 0, 1); put(2, 2);
    put(hlit - 257, 5); put(hdist - 1, 5); put(hclen - 4, 4);
    for (let i = 0; i < hclen; i++) put(cll[CL_ORDER[i]], 3);
    for (const [s, x] of cl) { put(clc[s], cll[s]); if (s === 16) put(x, 2); else if (s === 17) put(x, 3); else if (s === 18) put(x, 7); }
    // data
    for (let k = 0; k < t; k++) {
      const v = tok[k];
      if (v < 256) { put(lc[v], ll[v]); continue; }
      const len = v - 256, s = LEN_SYM[len], sym = 257 + s;
      put(lc[sym], ll[sym]);
      if (LEN_EXTRA[s]) put(len - LEN_BASE[s], LEN_EXTRA[s]);
      put(dc[0], dl[0]); // distance 1
    }
    put(lc[256], ll[256]);
    start = end;
    if (n === 0) break;
  }
  if (nbits) put(0, 8 - nbits);
  let a = 1, b = 0;
  for (let i = 0; i < n;) {
    const e = Math.min(n, i + 5552);
    for (; i < e; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  if (o + 4 > out.length) { const g = new Uint8Array(o + 4); g.set(out); out = g; }
  out[o++] = b >>> 8; out[o++] = b & 0xff; out[o++] = a >>> 8; out[o++] = a & 0xff;
  return out.subarray(0, o);
}

/**
 * PNG scanlines with a per-row filter (None, Sub, Up or Paeth — whichever gives the smallest sum of
 * absolute bytes, the usual heuristic): the input of the PNG IDAT stream.
 */
export function filterRows(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp, out = new Uint8Array((stride + 1) * height);
  const sub = new Uint8Array(stride), up = new Uint8Array(stride), pae = new Uint8Array(stride);
  const abs = (v: number) => (v < 128 ? v : 256 - v);
  for (let y = 0; y < height; y++) {
    const row = y * stride, prev = row - stride;
    let cn = 0, cs = 0, cu = 0, cp = 0;
    for (let x = 0; x < stride; x++) {
      const cur = data[row + x], a = x >= bpp ? data[row + x - bpp] : 0, b = y ? data[prev + x] : 0, c = x >= bpp && y ? data[prev + x - bpp] : 0;
      const p = a + b - c, pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
      const vs = (cur - a) & 0xff, vu = (cur - b) & 0xff, vp = (cur - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      sub[x] = vs; up[x] = vu; pae[x] = vp;
      cn += abs(cur); cs += abs(vs); cu += abs(vu); cp += abs(vp);
    }
    const o = y * (stride + 1);
    const best = Math.min(cn, cs, cu, cp);
    if (best === cs) { out[o] = 1; out.set(sub, o + 1); }
    else if (best === cu) { out[o] = 2; out.set(up, o + 1); }
    else if (best === cp) { out[o] = 4; out.set(pae, o + 1); }
    else { out[o] = 0; out.set(data.subarray(row, row + stride), o + 1); }
  }
  return out;
}
