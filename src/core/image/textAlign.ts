// AI 拆层 · 校准文字范围: DeepSeek says well what the text blocks are and in which order they sit,
// but reads their places poorly — with many parts its boxes drift by up to ~7% of the picture, and
// not by one shift for all (11-28 log, 围炉煮茶 poster: the address +25 px, the prices +75 px, the
// title fine but twice as tall). So its boxes are only a starting point; the pixels decide:
//   1. an ink map: pixels that stand out from the paper around them (strokes; not the grain),
//   2. for each box, up to ~10 places nearby (12% of the picture up or down) where a box of its size
//      holds ink with no ink on its edge, each snapped to the ink it holds (trimmed, on over small
//      gaps to more glyphs of the same line or list, cut off at wide empty gaps),
//   3. one place per box, all together (beam search): each place's own fit, votes from the boxes
//      near it that fit well moved by about as much (a list's lines drift together), never two boxes
//      on the same text, never against DeepSeek's order (what it put above stays above),
//   4. a second pass for the unsure ones with the placed text erased (text touching its neighbour),
//   5. what still isn't a clean text block is unsure: DeepSeek's box is kept, the user can fix it.
// Pure (tests/text_align.test.ts).

import type { Pixels } from "./png.ts";
import type { Rect } from "./region.ts";

export interface InkMap {
  width: number;
  height: number;
  /** 1: ink */
  ink: Uint8Array;
  /** summed-area table of `ink`, (width + 1) × (height + 1) */
  sum: Uint32Array;
}

export interface AlignedBox {
  box: Rect;
  /** the box looks like a text block now (ink inside, an empty ring around it) */
  ok: boolean;
  score: number;
}

/** Pixels that differ from the mean of their neighbourhood by more than the picture's noise. */
export function inkMap(p: Pixels): InkMap {
  const { width: w, height: h, channels: ch, data } = p;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    if (ch >= 3) lum[i] = ch === 4 && data[o + 3] < 128 ? 255 : 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    else lum[i] = data[o];
  }
  const W1 = w + 1;
  const r = Math.max(4, Math.round(Math.min(w, h) / 30));
  /** |lum − the mean of the window (radius `rad`) around each pixel|, the mean over pixels with
   *  `use` set (all when null); NaN where fewer than a tenth of the window's pixels are used */
  const diffs = (use: Uint8Array | null, rad = r) => {
    const ls = new Float64Array(W1 * (h + 1)), ns = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0, cnt = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, u = use ? use[i] : 1;
        row += u ? lum[i] : 0; cnt += u;
        ls[(y + 1) * W1 + x + 1] = ls[y * W1 + x + 1] + row;
        ns[(y + 1) * W1 + x + 1] = ns[y * W1 + x + 1] + cnt;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const t = Math.max(0, y - rad), b = Math.min(h, y + rad + 1);
      for (let x = 0; x < w; x++) {
        const l = Math.max(0, x - rad), rr = Math.min(w, x + rad + 1);
        const n = ns[b * W1 + rr] - ns[t * W1 + rr] - ns[b * W1 + l] + ns[t * W1 + l];
        if (n < 0.1 * (b - t) * (rr - l)) { out[y * w + x] = NaN; continue; }
        const mean = (ls[b * W1 + rr] - ls[t * W1 + rr] - ls[b * W1 + l] + ls[t * W1 + l]) / n;
        out[y * w + x] = Math.abs(lum[y * w + x] - mean);
      }
    }
    return out;
  };
  let diff = diffs(null);
  for (let i = 0; i < w * h; i++) if (Number.isNaN(diff[i])) diff[i] = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) hist[Math.min(255, diff[i] | 0)]++;
  let acc = 0, median = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= w * h / 2) { median = i; break; } }
  const T = Math.max(18, 3 * median + 10);
  // again with the mean of the background only: next to a heavy stroke the plain mean is pulled
  // dark, and the paper beside it would count as ink (a halo as wide as the window)
  const bg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bg[i] = diff[i] > T ? 0 : 1;
  const first = diff;
  diff = diffs(bg);
  // inside a big block of text the window may hold no paper: look wider, then fall back to the first pass
  for (const k of [2, 4]) {
    if (!diff.some(Number.isNaN)) break;
    const wide = diffs(bg, r * k);
    for (let i = 0; i < w * h; i++) if (Number.isNaN(diff[i])) diff[i] = wide[i];
  }
  for (let i = 0; i < w * h; i++) if (Number.isNaN(diff[i])) diff[i] = first[i];
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = diff[i] > T ? 1 : 0;
  // single specks (paper grain, JPEG noise) are not ink
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!raw[y * w + x]) continue;
    let n = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) n += raw[yy * w + xx];
    if (n >= 3) ink[y * w + x] = 1;
  }
  return finishInk(w, h, ink);
}

/** An ink map from a ready mask (1: ink): long straight thin lines taken out, summed. */
export function finishInk(w: number, h: number, ink: Uint8Array): InkMap {
  const W1 = w + 1;
  // long straight thin lines (a rule beside vertical text, a frame) are not text: a box that fits
  // the text has them right on its edge
  const L = Math.max(40, Math.round(0.15 * Math.max(w, h)));
  const drop: number[] = [];
  // thin: a few pixels to either side, mostly no ink along it (not the inside of a filled shape)
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h ? ink[y * w + x] : 0;
  for (let x = 0; x < w; x++) for (let y = 0, run = 0; y <= h; y++) {
    if (y < h && ink[y * w + x]) { run++; continue; }
    if (run >= L) {
      let side = 0;
      for (let k = y - run; k < y; k++) side += at(x - 4, k) + at(x + 4, k);
      if (side < 0.6 * run) for (let k = y - run; k < y; k++) drop.push(k * w + x);
    }
    run = 0;
  }
  for (let y = 0; y < h; y++) for (let x = 0, run = 0; x <= w; x++) {
    if (x < w && ink[y * w + x]) { run++; continue; }
    if (run >= L) {
      let side = 0;
      for (let k = x - run; k < x; k++) side += at(k, y - 4) + at(k, y + 4);
      if (side < 0.6 * run) for (let k = x - run; k < x; k++) drop.push(y * w + k);
    }
    run = 0;
  }
  for (const i of drop) ink[i] = 0;
  const sum = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += ink[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; }
  }
  return { width: w, height: h, ink, sum };
}

/** ink pixels in `r` (clipped to the picture; any numbers) */
export function inkIn(m: InkMap, r: Rect): number {
  const l = Math.max(0, Math.min(m.width, Math.round(r.left))), t = Math.max(0, Math.min(m.height, Math.round(r.top)));
  const rr = Math.max(l, Math.min(m.width, Math.round(r.right))), b = Math.max(t, Math.min(m.height, Math.round(r.bottom)));
  const W1 = m.width + 1;
  return m.sum[b * W1 + rr] - m.sum[t * W1 + rr] - m.sum[b * W1 + l] + m.sum[t * W1 + l];
}

const areaIn = (m: InkMap, r: Rect) => Math.max(0, Math.min(m.width, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(m.height, r.bottom) - Math.max(0, r.top));

/** How much `r` looks like a whole block of text: ink inside, and none on a thin band just outside
 *  its edge (a box that cuts through characters has ink there; text nearby, not touching, doesn't
 *  count against it). `dIn`: the ink density inside. */
export function blockScore(m: InkMap, r: Rect): { score: number; dIn: number } {
  const bw = r.right - r.left, bh = r.bottom - r.top;
  if (bw < 2 || bh < 2) return { score: -1, dIn: 0 };
  const g = Math.max(2, Math.round(Math.min(m.width, m.height) / 300));
  const outer = { left: r.left - g, top: r.top - g, right: r.right + g, bottom: r.bottom + g };
  const aIn = Math.max(1, areaIn(m, r)), aOut = areaIn(m, outer);
  const inside = inkIn(m, r), edge = inkIn(m, outer) - inside;
  const dIn = inside / aIn, dEdge = aOut - aIn > 0 ? edge / (aOut - aIn) : 0;
  return { score: Math.min(dIn, 0.3) - 2 * dEdge, dIn };
}

const rowInk = (m: InkMap, y: number, l: number, r: number) => inkIn(m, { left: l, top: y, right: r, bottom: y + 1 });
const colInk = (m: InkMap, x: number, t: number, b: number) => inkIn(m, { left: x, top: t, right: x + 1, bottom: b });

/** `box` grown over ink it cuts through, trimmed of empty edges, and — when wide empty gaps split
 *  what it holds — cut down to the part that looks most like a text block. */
export function snap(m: InkMap, box: Rect): Rect {
  let l = Math.max(0, Math.round(box.left)), t = Math.max(0, Math.round(box.top));
  let r = Math.min(m.width, Math.round(box.right)), b = Math.min(m.height, Math.round(box.bottom));
  if (r - l < 2 || b - t < 2) return box;
  // grow where ink runs over the edge (a cut-off line of text), a little: more would run into the
  // next block (「双人套餐」 into 「¥88」)
  const growW = Math.round(0.1 * (r - l)), growH = Math.round(0.15 * (b - t));
  const busy = (n: number, span: number) => n > Math.max(1, 0.02 * span);
  for (let k = 0; k < growH && t > 0 && busy(rowInk(m, t - 1, l, r), r - l) && busy(rowInk(m, t, l, r), r - l); k++) t--;
  for (let k = 0; k < growH && b < m.height && busy(rowInk(m, b, l, r), r - l) && busy(rowInk(m, b - 1, l, r), r - l); k++) b++;
  for (let k = 0; k < growW && l > 0 && busy(colInk(m, l - 1, t, b), b - t) && busy(colInk(m, l, t, b), b - t); k++) l--;
  for (let k = 0; k < growW && r < m.width && busy(colInk(m, r, t, b), b - t) && busy(colInk(m, r - 1, t, b), b - t); k++) r++;
  // along the line (sideways for a wide box, down for a tall one), on over small gaps to more glyphs
  // of the same height (width): a box that stops at a gap between characters, one character short.
  // A neighbour of another size (「¥88」 beside 「双人套餐」) doesn't continue the line.
  const bridge = Math.max(3, Math.round(0.016 * Math.max(m.width, m.height)));
  const extend = (pos: number, dir: 1 | -1, max: number, limit: number, fits: (i: number) => boolean) => {
    let last = pos, gap = 0;
    for (let p = pos, n = 0; n < limit; p += dir, n++) {
      const q = dir > 0 ? p : p - 1;
      if (q < 0 || q >= max) break;
      if (fits(q)) { last = dir > 0 ? q + 1 : q; gap = 0; } else if (++gap > bridge) break;
    }
    return last;
  };
  // a glyph of the same line: its ink spans at least half the line's height, inside the line, and
  // the glyphs nearby (a few pixels either way) do too. Done again once the box is tight: the
  // line's height is only right then (「¥138」's 「1」 left out).
  const along = () => {
    const spanCol = (x: number) => { let a = -1, z = -1; for (let y = t; y < b; y++) if (m.ink[y * m.width + x]) { if (a < 0) a = y; z = y; } return a < 0 ? 0 : z - a + 1; };
    const spanRow = (y: number) => { let a = -1, z = -1; for (let x = l; x < r; x++) if (m.ink[y * m.width + x]) { if (a < 0) a = x; z = x; } return a < 0 ? 0 : z - a + 1; };
    if (r - l >= b - t) {
      const half = (b - t) / 2;
      const fitsCol = (x: number) => { const inside = colInk(m, x, t, b); return busy(inside, b - t) && colInk(m, x, t - half, t) + colInk(m, x, b, b + half) <= 0.35 * inside && spanCol(x) >= 0.5 * (b - t); };
      const lim = Math.round(0.5 * (r - l));
      r = extend(r, 1, m.width, lim, fitsCol); l = extend(l, -1, m.width, lim, fitsCol);
    } else {
      const half = (r - l) / 2;
      const fitsRow = (y: number) => { const inside = rowInk(m, y, l, r); return busy(inside, r - l) && rowInk(m, y, l - half, l) + rowInk(m, y, r, r + half) <= 0.35 * inside && spanRow(y) >= 0.5 * (r - l); };
      const lim = Math.round(0.5 * (b - t));
      b = extend(b, 1, m.height, lim, fitsRow); t = extend(t, -1, m.height, lim, fitsRow);
    }
  };
  along();
  // bands of rows (then columns) with ink, wide gaps between them: keep the best one
  const gapY = Math.max(4, Math.round(0.03 * m.height)), gapX = Math.max(4, Math.round(0.03 * m.width));
  const bands = (lo: number, hi: number, has: (i: number) => boolean, gap: number): [number, number][] => {
    const out: [number, number][] = [];
    let start = -1, last = -1;
    for (let i = lo; i < hi; i++) {
      if (!has(i)) continue;
      if (start < 0) start = i;
      else if (i - last > gap) { out.push([start, last + 1]); start = i; }
      last = i;
    }
    if (start >= 0) out.push([start, last + 1]);
    return out;
  };
  // edges with only a few specks of grain (about 1% of the line) are trimmed too
  const tight = (rect: Rect): Rect => {
    let { left, top, right, bottom } = rect;
    const rt = () => Math.floor(0.012 * (right - left)), ct = () => Math.floor(0.012 * (bottom - top));
    for (let again = true; again;) {
      again = false;
      while (bottom - top > 1 && rowInk(m, top, left, right) <= rt()) { top++; again = true; }
      while (bottom - top > 1 && rowInk(m, bottom - 1, left, right) <= rt()) { bottom--; again = true; }
      while (right - left > 1 && colInk(m, left, top, bottom) <= ct()) { left++; again = true; }
      while (right - left > 1 && colInk(m, right - 1, top, bottom) <= ct()) { right--; again = true; }
    }
    return { left, top, right, bottom };
  };
  const minW = 0.35 * (box.right - box.left), minH = 0.35 * (box.bottom - box.top);
  let cur = tight({ left: l, top: t, right: r, bottom: b });
  if (cur.right - cur.left < minW || cur.bottom - cur.top < minH) return box;
  ({ left: l, top: t, right: r, bottom: b } = cur);
  along();
  cur = tight({ left: l, top: t, right: r, bottom: b });
  const pick = (cands: Rect[]) => {
    if (cands.length < 2) return;
    let best = cur, bestScore = blockScore(m, cur).score;
    for (const c of cands) {
      // a sliver (a rule line beside vertical text, one stroke) is not the block
      if (c.right - c.left < minW || c.bottom - c.top < minH) continue;
      const s = blockScore(m, c).score;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    cur = best;
  };
  // a few specks of paper grain in a gap don't close it
  const rowThr = (c: Rect) => Math.max(1, Math.floor(0.01 * (c.right - c.left)));
  pick(bands(cur.top, cur.bottom, y => rowInk(m, y, cur.left, cur.right) > rowThr(cur), gapY).map(([a, z]) => tight({ left: cur.left, top: a, right: cur.right, bottom: z })));
  const colThr = (c: Rect) => Math.max(1, Math.floor(0.01 * (c.bottom - c.top)));
  pick(bands(cur.left, cur.right, x => colInk(m, x, cur.top, cur.bottom) > colThr(cur), gapX).map(([a, z]) => tight({ left: a, top: cur.top, right: z, bottom: cur.bottom })));
  // a list cut short (its box fell between lines): on to the next line above / below while it has
  // the same height and left edge and the block stays within DeepSeek's height for it
  if (cur.right - cur.left >= cur.bottom - cur.top) {
    const boxH = box.bottom - box.top;
    const ls = bands(cur.top, cur.bottom, y => rowInk(m, y, cur.left, cur.right) > rowThr(cur), 1);
    const lineH = ls.map(([a, z]) => z - a).sort((x, y) => x - y)[ls.length >> 1] ?? (cur.bottom - cur.top);
    const firstInk = (lt: number, lb: number) => { for (let x = Math.max(0, Math.round(cur.left - 0.04 * m.width)); x < cur.right; x++) if (colInk(m, x, lt, lb)) return x; return -1; };
    const nextLine = (from: number, dir: 1 | -1): [number, number] | null => {
      const thr = rowThr(cur), reach = Math.round(1.5 * lineH);
      let y = from, n = 0;
      while (n < reach && y >= 0 && y < m.height && rowInk(m, y, cur.left, cur.right) <= thr) { y += dir; n++; }
      if (n >= reach || y < 0 || y >= m.height) return null;
      const start = y;
      for (let gap = 0; y >= 0 && y < m.height && gap <= 1; y += dir) gap = rowInk(m, y, cur.left, cur.right) > thr ? 0 : gap + 1;
      const a = Math.min(start, y - 2 * dir), z = Math.max(start, y - 2 * dir) + 1;
      return [a, z];
    };
    for (const dir of [1, -1] as const) {
      for (let k = 0; k < 10; k++) {
        const ln = nextLine(dir > 0 ? cur.bottom : cur.top - 1, dir);
        if (!ln) break;
        const [a, z] = ln, h2 = z - a;
        const tall = Math.max(cur.bottom, z) - Math.min(cur.top, a);
        const x0 = firstInk(a, z);
        if (Math.abs(h2 - lineH) > 0.4 * lineH || tall > 1.2 * boxH || x0 < 0 || Math.abs(x0 - cur.left) > 0.04 * m.width) break;
        cur = { ...cur, top: Math.min(cur.top, a), bottom: Math.max(cur.bottom, z) };
      }
    }
  }
  // a block of several lines: each line on along itself (a list's longest line may run past the box)
  if (cur.right - cur.left >= cur.bottom - cur.top) {
    const lines = bands(cur.top, cur.bottom, y => rowInk(m, y, cur.left, cur.right) > rowThr(cur), 1);
    // only real lines: about the same height, with real gaps between (「¥88」's 「¥」 and 「88」 are not)
    const hs = lines.map(([a, z]) => z - a).sort((x, y) => x - y), med = hs[hs.length >> 1] ?? 0;
    const even = lines.length > 1 && hs.every(v => Math.abs(v - med) <= 0.4 * med)
      && lines.every(([a], k) => k === 0 || a - lines[k - 1][1] >= 0.2 * med);
    if (even) {
      let { left, right } = cur;
      for (const [lt, lb] of lines) {
        const half = (lb - lt) / 2;
        const spanIn = (x: number) => { let a = -1, z = -1; for (let y = lt; y < lb; y++) if (m.ink[y * m.width + x]) { if (a < 0) a = y; z = y; } return a < 0 ? 0 : z - a + 1; };
        const fits = (x: number) => { const inside = colInk(m, x, lt, lb); return inside > 0 && colInk(m, x, lt - half, lt) + colInk(m, x, lb, lb + half) <= 0.2 * inside && spanIn(x) >= 0.4 * (lb - lt); };
        const lim = Math.round(0.5 * (cur.right - cur.left));
        right = Math.max(right, extend(cur.right, 1, m.width, lim, fits));
        left = Math.min(left, extend(cur.left, -1, m.width, lim, fits));
      }
      cur = { ...cur, left, right };
    }
  }
  return cur;
}

/** the share of the smaller box that the other covers (a line inside a whole list counts as on it) */
const cover = (a: Rect, b: Rect) => {
  const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left), ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (iw <= 0 || ih <= 0) return 0;
  return iw * ih / Math.max(1, Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top)));
};

const iou = (a: Rect, b: Rect) => {
  const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left), ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (iw <= 0 || ih <= 0) return 0;
  const i = iw * ih;
  return i / ((a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - i);
};

/** a snapped box counts as a text block from this score and inside density on */
export const OK_SCORE = 0.05, OK_DENSITY = 0.03;

interface Candidate { box: Rect; dx: number; dy: number; score: number; fit: number }

/** what differing in size from DeepSeek's box costs, per e-fold of width and of height */
const SIZE = 0.12;
/** a candidate's score less what it costs to differ in size from DeepSeek's box (it reads sizes better than places) */
const fitOf = (r: Rect, box: Rect, score: number) =>
  score - SIZE * (Math.abs(Math.log(Math.max(1, r.right - r.left) / Math.max(1, box.right - box.left))) + Math.abs(Math.log(Math.max(1, r.bottom - r.top) / Math.max(1, box.bottom - box.top))));

/** Up to `k` places near `box` where a box of its size looks like a text block (the best of each
 *  neighbourhood), each snapped; always includes the box where it is, snapped. */
function candidates(m: InkMap, box: Rect, k = 10): Candidate[] {
  const my = Math.round(0.12 * m.height), mx = Math.round(0.06 * m.width);
  const sy = Math.max(1, Math.round(m.height / 300)), sx = Math.max(1, Math.round(m.width / 300));
  const shifted: { dx: number; dy: number; score: number }[] = [];
  for (let dy = -my; dy <= my; dy += sy) for (let dx = -mx; dx <= mx; dx += sx)
    shifted.push({ dx, dy, score: blockScore(m, { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy }).score });
  shifted.sort((a, b) => b.score - a.score);
  // peaks some way apart (not more than 2% of the picture: a tall box's best unsnapped place may be
  // well off, and the right one close beside it)
  const ry = Math.max(sy, Math.min(0.5 * (box.bottom - box.top), 0.02 * m.height)), rx = Math.max(sx, Math.min(0.5 * (box.right - box.left), 0.02 * m.width));
  const peaks: { dx: number; dy: number }[] = [{ dx: 0, dy: 0 }];
  for (const c of shifted) {
    if (peaks.length > k || c.score < OK_SCORE) break;
    if (peaks.some(p => Math.abs(p.dy - c.dy) < ry && Math.abs(p.dx - c.dx) < rx)) continue;
    peaks.push(c);
  }
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  const out: Candidate[] = [];
  for (const c of peaks.map(p => {
    const r = snap(m, { left: box.left + p.dx, top: box.top + p.dy, right: box.right + p.dx, bottom: box.bottom + p.dy });
    const score = blockScore(m, r).score;
    return { box: r, dx: (r.left + r.right) / 2 - cx, dy: (r.top + r.bottom) / 2 - cy, score, fit: fitOf(r, box, score) };
  })) {
    // peaks that snapped onto the same text are one candidate (the first: DeepSeek's own place first)
    if (!out.some(o => Math.abs(o.box.left - c.box.left) <= 2 && Math.abs(o.box.top - c.box.top) <= 2 && Math.abs(o.box.right - c.box.right) <= 2 && Math.abs(o.box.bottom - c.box.bottom) <= 2)) out.push(c);
  }
  return out;
}

/** partial choices kept while placing the boxes */
const BEAM = 200;
/** what leaving a box unplaced costs a whole assignment */
const UNPLACED = 0.3;
/** how much the neighbours' votes count against a place's own fit */
const VOTE = 1;
/** a box whose snapped self scores this much where DeepSeek put it gets KEEP_BONUS there */
export const KEEP = 0.15;
const KEEP_BONUS = 0.05;
/** what moving a box costs (per picture height) */
const STAY = 1;
/** what two boxes on the same text cost */
const CLASH = 1;

/** `m` with the ink inside `rects` taken away (text already placed doesn't count against its neighbour). */
export function withoutInk(m: InkMap, rects: readonly Rect[]): InkMap {
  const ink = new Uint8Array(m.ink);
  for (const r of rects) {
    const l = Math.max(0, Math.round(r.left)), t = Math.max(0, Math.round(r.top)), rr = Math.min(m.width, Math.round(r.right)), b = Math.min(m.height, Math.round(r.bottom));
    for (let y = t; y < b; y++) ink.fill(0, y * m.width + l, y * m.width + Math.max(l, rr));
  }
  const W1 = m.width + 1, sum = new Uint32Array(W1 * (m.height + 1));
  for (let y = 0; y < m.height; y++) {
    let row = 0;
    for (let x = 0; x < m.width; x++) { row += ink[y * m.width + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; }
  }
  return { width: m.width, height: m.height, ink, sum };
}

/** DeepSeek's text boxes (in the ink map's pixels) moved onto the text they name: once, then the
 *  unsure ones again with the ink of the placed ones taken away (「3-4人套餐」 touches 「¥138」: with
 *  the price there, no box around the words has a clean edge). */
export function alignTextBoxes(m: InkMap, boxes: readonly Rect[], opts: { units?: boolean; chars?: readonly (number | null)[] } = {}): AlignedBox[] {
  const gen = (map: InkMap) => {
    if (!opts.units) return (b: Rect) => candidates(map, b).map((c, k) => k === 0 && c.score >= KEEP ? { ...c, fit: c.fit + KEEP_BONUS } : c);
    const units = textUnits(map);
    return (b: Rect, i: number) => unitCandidates(map, units, b, opts.chars?.[i] ?? null);
  };
  const first = alignOnce(m, boxes, [], gen(m));
  const placed = first.filter(a => a.ok).map(a => a.box);
  let out = first;
  if (placed.length && placed.length < boxes.length) {
    const rest = withoutInk(m, placed);
    const again = alignOnce(rest, boxes, first.map(a => a.ok ? a.box : null), gen(rest));
    out = first.map((a, i) => a.ok ? a : again[i]);
  }
  if (opts.units) out = absorb(m, out);
  return out;
}

/** Text lines nobody took that lie mostly inside a placed box join it (the bottom 「茶」 of a title
 *  whose box DeepSeek drew a little short), and so do those just past its end along its line (the
 *  thin 「一」 on top of 「一炉烟火」, a list's bullet). */
function absorb(m: InkMap, got: AlignedBox[]): AlignedBox[] {
  const out = got.map(a => ({ ...a }));
  const along = (u: Rect, b: Rect) => {
    const bw = b.right - b.left, bh = b.bottom - b.top;
    if (bh > bw) { // a column: just above or below, mostly within its width
      const ov = Math.min(u.right, b.right) - Math.max(u.left, b.left), gap = Math.max(u.top - b.bottom, b.top - u.bottom);
      return ov >= 0.5 * (u.right - u.left) && gap <= 1.2 * bw && u.right - u.left <= 1.3 * bw ? 1 : 0;
    }
    // sideways: the box may be several lines, so the gap is measured against the piece's own size
    const ov = Math.min(u.bottom, b.bottom) - Math.max(u.top, b.top), gap = Math.max(u.left - b.right, b.left - u.right);
    const cs = Math.min(u.right - u.left, u.bottom - u.top);
    return ov >= 0.5 * (u.bottom - u.top) && gap <= 1.5 * cs + 2 && u.bottom - u.top <= 1.3 * bh ? 1 : 0;
  };
  for (const u of textUnits(m)) {
    if (out.some(a => a.ok && coverOf(u, a.box) >= 0.9)) continue;
    let best = -1, bestCover = 0.3;
    out.forEach((a, k) => { if (!a.ok) return; const c = Math.max(coverOf(u, a.box), along(u, a.box) * 0.31); if (c > bestCover) { bestCover = c; best = k; } });
    if (best < 0) continue;
    const b = out[best].box;
    out[best].box = { left: Math.min(b.left, u.left), top: Math.min(b.top, u.top), right: Math.max(b.right, u.right), bottom: Math.max(b.bottom, u.bottom) };
  }
  return out;
}
/** the share of `u` that `b` covers */
const coverOf = (u: Rect, b: Rect) => {
  const iw = Math.min(u.right, b.right) - Math.max(u.left, b.left), ih = Math.min(u.bottom, b.bottom) - Math.max(u.top, b.top);
  return iw <= 0 || ih <= 0 ? 0 : iw * ih / Math.max(1, (u.right - u.left) * (u.bottom - u.top));
};

/** what a block's character count differing from the one its name implies costs, per e-fold */
const CHARS = 0.15;

// ── 文字块: on a clean text mask (the 分区图's magenta), the text cut into lines and blocks ──

/** The text lines in a clean mask: glyph pieces joined into glyphs, glyphs into lines — sideways
 *  when a glyph has a neighbour of about its size on the same line, else down (a vertical column). */
export function textUnits(m: InkMap): Rect[] {
  const { width: w, height: h, ink } = m;
  const label = new Int32Array(w * h).fill(-1), parent: number[] = [];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!ink[i]) continue;
    const ns = [x > 0 ? label[i - 1] : -1, y > 0 ? label[i - w] : -1, y > 0 && x > 0 ? label[i - w - 1] : -1, y > 0 && x < w - 1 ? label[i - w + 1] : -1].filter(v => v >= 0);
    if (!ns.length) { label[i] = parent.length; parent.push(parent.length); continue; }
    const r = find(ns[0]); label[i] = r;
    for (const v of ns) { const q = find(v); if (q !== r) parent[q] = r; }
  }
  const boxes = new Map<number, Rect & { n: number }>();
  for (let i = 0; i < w * h; i++) {
    if (label[i] < 0) continue;
    const r = find(label[i]), x = i % w, y = (i / w) | 0;
    const b = boxes.get(r);
    if (!b) boxes.set(r, { left: x, top: y, right: x + 1, bottom: y + 1, n: 1 });
    else { b.left = Math.min(b.left, x); b.top = Math.min(b.top, y); b.right = Math.max(b.right, x + 1); b.bottom = Math.max(b.bottom, y + 1); b.n++; }
  }
  // pieces of one glyph (a radical, a dot): boxes overlapping (characters 1–2 px apart stay apart)
  let glyphs: Rect[] = [...boxes.values()].filter(b => b.n >= 6 && (b.right - b.left >= 2 || b.bottom - b.top >= 2)).map(({ n, ...r }) => r);
  const near = (a: Rect, b: Rect, g: number) => a.left - g < b.right && b.left - g < a.right && a.top - g < b.bottom && b.top - g < a.bottom;
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < glyphs.length && !again; i++) for (let j = i + 1; j < glyphs.length; j++) {
      if (!near(glyphs[i], glyphs[j], 0)) continue;
      const a = glyphs[i], b = glyphs[j];
      glyphs[i] = { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
      glyphs.splice(j, 1); again = true; break;
    }
  }
  const gw = (r: Rect) => r.right - r.left, gh = (r: Rect) => r.bottom - r.top;
  const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
  // a "glyph" may be a few characters run together (2 px apart): its character size is its shorter side
  const cs = (r: Rect) => Math.min(gw(r), gh(r));
  const sideways = (a: Rect, b: Rect) => ov(a.top, a.bottom, b.top, b.bottom) >= 0.5 * Math.min(gh(a), gh(b))
    && Math.max(a.left, b.left) - Math.min(a.right, b.right) <= 0.8 * Math.max(cs(a), cs(b))
    && Math.max(gh(a), gh(b)) <= 1.6 * Math.min(gh(a), gh(b));
  const down = (a: Rect, b: Rect) => ov(a.left, a.right, b.left, b.right) >= 0.5 * Math.min(gw(a), gw(b))
    && Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom) <= 0.6 * Math.max(cs(a), cs(b))
    && Math.max(gw(a), gw(b)) <= 1.6 * Math.min(gw(a), gw(b));
  const n = glyphs.length, up = Array.from({ length: n }, (_, i) => i);
  const root = (a: number): number => { while (up[a] !== a) { up[a] = up[up[a]]; a = up[a]; } return a; };
  const join = (a: number, b: number) => { const x = root(a), y = root(b); if (x !== y) up[y] = x; };
  // each glyph reads the way its nearest neighbour lies (relative to its size): sideways in a line
  // of text, down in a column — two columns side by side are not rows, a list's lines not a column
  const hGap = new Array(n).fill(Infinity), vGap = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const a = glyphs[i], b = glyphs[j];
    if (sideways(a, b)) hGap[i] = Math.min(hGap[i], Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)) / Math.max(cs(a), cs(b)));
    if (down(a, b)) vGap[i] = Math.min(vGap[i], Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) / Math.max(cs(a), cs(b)));
  }
  const dir = glyphs.map((_, i) => hGap[i] === Infinity && vGap[i] === Infinity ? "" : hGap[i] <= vGap[i] ? "h" : "v");
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (dir[i] === "h" && dir[j] === "h" && sideways(glyphs[i], glyphs[j])) join(i, j);
    else if (dir[i] === "v" && dir[j] === "v" && down(glyphs[i], glyphs[j])) join(i, j);
  }
  const lines = new Map<number, Rect>();
  glyphs.forEach((g, i) => {
    const r = root(i), b = lines.get(r);
    lines.set(r, b ? { left: Math.min(b.left, g.left), top: Math.min(b.top, g.top), right: Math.max(b.right, g.right), bottom: Math.max(b.bottom, g.bottom) } : { ...g });
  });
  return [...lines.values()];
}

/** Places for `box` made of whole text lines near it: a line, a line with its neighbours on the
 *  same row, lines stacked below one another (a list, a two-line title); sized about like `box`. */
function unitCandidates(m: InkMap, units: readonly Rect[], box: Rect, chars: number | null): Candidate[] {
  const H = m.height, W = m.width;
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2, bw = box.right - box.left, bh = box.bottom - box.top;
  const win = units.filter(u => Math.abs((u.top + u.bottom) / 2 - cy) <= 0.12 * H + bh / 2 && Math.abs((u.left + u.right) / 2 - cx) <= 0.08 * W + bw / 2);
  const union = (a: Rect, b: Rect): Rect => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
  const hgt = (r: Rect) => r.bottom - r.top, wid = (r: Rect) => r.right - r.left;
  // about how many characters a line holds: its long side over its short side
  const est = (u: Rect) => Math.max(wid(u), hgt(u)) / Math.max(1, Math.min(wid(u), hgt(u)));
  const out: { r: Rect; n: number }[] = [];
  for (const u of win) {
    out.push({ r: u, n: est(u) });
    // on along the row
    let row = u, n = est(u);
    for (let k = 0; k < 4; k++) {
      const next = win.filter(v => v.left >= row.right && v.left - row.right <= 1.2 * Math.max(hgt(row), hgt(v)) && Math.min(v.bottom, row.bottom) - Math.max(v.top, row.top) >= 0.4 * Math.min(hgt(v), hgt(row)))
        .sort((a, b) => a.left - b.left)[0];
      if (!next) break;
      row = union(row, next); n += est(next); out.push({ r: row, n });
    }
    // on down the stack (and across, for vertical columns side by side)
    let col = u; n = est(u);
    for (let k = 0; k < 5; k++) {
      const next = win.filter(v => v.top >= col.bottom - 1 && v.top - col.bottom <= 1.5 * hgt(u) && Math.min(v.right, col.right) - Math.max(v.left, col.left) >= 0.3 * Math.min(wid(v), wid(col)))
        .sort((a, b) => a.top - b.top)[0];
      if (!next) break;
      col = union(col, next); n += est(next); out.push({ r: col, n });
    }
  }
  const seen = new Set<string>();
  const res: Candidate[] = [];
  for (const { r, n } of out) {
    const key = `${r.left},${r.top},${r.right},${r.bottom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fw = wid(r) / Math.max(1, bw), fh = hgt(r) / Math.max(1, bh);
    if (fw < 0.35 || fw > 3 || fh < 0.35 || fh > 3) continue;
    const score = blockScore(m, r).score;
    const charCost = chars ? CHARS * Math.abs(Math.log(Math.max(0.5, n) / chars)) : 0;
    res.push({ box: r, dx: (r.left + r.right) / 2 - cx, dy: (r.top + r.bottom) / 2 - cy, score, fit: fitOf(r, box, Math.max(score, 0.3)) - charCost });
  }
  return res.sort((a, b) => b.fit - a.fit).slice(0, 16);
}

/** One pass; `fixed[i]`: box i is already placed there. */
function alignOnce(m: InkMap, boxes: readonly Rect[], fixed: readonly (Rect | null)[], gen: (b: Rect, i: number) => Candidate[]): AlignedBox[] {
  const cands = boxes.map((b, i) => {
    const f = fixed[i];
    if (f) { const c = { left: (b.left + b.right) / 2, top: (b.top + b.bottom) / 2 }; return [{ box: f, dx: (f.left + f.right) / 2 - c.left, dy: (f.top + f.bottom) / 2 - c.top, score: 0.3, fit: 0.3 }]; }
    // (sliding mode) where DeepSeek put it, snapped, fitting well, gets a little extra: not a lock —
    // a drifted box may hold the line next to its own, 「水果拼盘」's box the line 「精选茶饮」
    return gen(b, i);
  });
  const n = boxes.length, H = m.height, W = m.width;
  const centre = boxes.map(b => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }));
  // neighbours: weight falls off with the distance between the boxes as DeepSeek gave them
  const near = (i: number, j: number) => Math.exp(-Math.hypot((centre[i].x - centre[j].x) / W, (centre[i].y - centre[j].y) / H) / 0.1);
  // order[i][j](a, b): box i at a and box j at b are in the wrong order
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0.3 * Math.min(a1 - a0, b1 - b0);
  const order = boxes.map((a, i) => boxes.map((b, j): ((x: Rect, y: Rect) => boolean) | null => {
    if (i === j) return null;
    const ya = centre[i].y, yb = centre[j].y, xa = centre[i].x, xb = centre[j].x;
    if (overlap(a.left, a.right, b.left, b.right) && Math.abs(ya - yb) > 0.3 * Math.min(a.bottom - a.top, b.bottom - b.top))
      return ya < yb ? (x, y) => x.top + x.bottom > y.top + y.bottom : (x, y) => x.top + x.bottom < y.top + y.bottom;
    if (overlap(a.top, a.bottom, b.top, b.bottom) && Math.abs(xa - xb) > 0.3 * Math.min(a.right - a.left, b.right - b.left))
      return xa < xb ? (x, y) => x.left + x.right > y.left + y.right : (x, y) => x.left + x.right < y.left + y.right;
    return null;
  }));
  // votes: a place is likelier where the boxes near it also fit well moved by about as much (the
  // drift is shared locally: a list's lines all move together, so a line doesn't take the one above)
  const sy = 0.012 * H, sx = 0.02 * W;
  const total = cands.map((cs, i) => cs.map(c => {
    let support = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let best = 0;
      for (const o of cands[j]) best = Math.max(best, Math.max(0, o.fit) * Math.exp(-(((c.dy - o.dy) / sy) ** 2) - (((c.dx - o.dx) / sx) ** 2)));
      support += near(i, j) * best;
    }
    // staying where DeepSeek put it is preferred a little: it is often right
    return Math.max(-0.2, c.fit) + VOTE * support - STAY * (Math.abs(c.dy) / H + Math.abs(c.dx) / W);
  }));
  // one place per box (or none), all together: a beam search over the boxes top to bottom, keeping
  // the best partial choices. A place that sits on an already placed box's text, or reverses
  // DeepSeek's order with it, is out. (Picking the surest places first let one line of a list take
  // the line above and left the rest of the list nowhere to go.)
  const seq = boxes.map((_, i) => i).sort((a, b) => centre[a].y - centre[b].y || centre[a].x - centre[b].x);
  type State = { pick: number[]; energy: number };
  let beam: State[] = [{ pick: new Array(n).fill(-1), energy: 0 }];
  for (const i of seq) {
    const next: State[] = [];
    for (const st of beam) {
      next.push({ pick: st.pick, energy: st.energy - UNPLACED });
      for (let ci = 0; ci < cands[i].length; ci++) {
        const c = cands[i][ci];
        let ok = true;
        for (let j = 0; j < n && ok; j++) {
          if (st.pick[j] < 0) continue;
          const o = cands[j][st.pick[j]];
          const wrong = order[i][j];
          ok = cover(c.box, o.box) <= 0.3 && !(wrong && wrong(c.box, o.box));
        }
        if (!ok) continue;
        const pick = st.pick.slice(); pick[i] = ci;
        next.push({ pick, energy: st.energy + total[i][ci] });
      }
    }
    next.sort((a, b) => b.energy - a.energy);
    beam = next.slice(0, BEAM);
  }
  const pick = beam[0].pick;
  const out = boxes.map((b, i): AlignedBox => {
    if (pick[i] < 0) return { box: b, ok: false, score: 0 };
    const c = cands[i][pick[i]];
    if (fixed[i]) return { box: c.box, ok: true, score: c.score };
    const { score, dIn } = blockScore(m, c.box);
    const ok = score >= OK_SCORE && dIn >= OK_DENSITY;
    return { box: ok ? c.box : b, ok, score };
  });
  // still two boxes on the same text: the weaker one is unsure
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!out[i].ok || !out[j].ok || cover(out[i].box, out[j].box) < 0.5) continue;
    const weak = out[i].score >= out[j].score ? j : i;
    out[weak] = { box: boxes[weak], ok: false, score: out[weak].score };
  }
  return out;
}
