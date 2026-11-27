// 总览图 (AI 整理 › 参考图层画面): many layer pictures in one image, each in a numbered cell, so the
// vision model sees dozens of layers for the price of one picture (an image costs at most ~1024
// tokens and is looked at at about 1300×1300 px, however big it is sent: SHEET_EDGE stays under
// that). Cells are as big as the count allows (few layers: big cells), at least MIN_CELL; more than
// fit go on the next sheet. Each picture keeps its proportions, centred on neutral gray (no
// checkerboard: in a small cell it reads as content); the number sits in the cell's top-left
// corner, drawn with a built-in pixel font (no system font needed). Pure
// (tests/image_contact_sheet.test.ts); src/ps/uxpLayers.ts reads the pixels and encodes the sheets.

export const SHEET_EDGE = 1280;
export const MIN_CELL = 128;
export const MAX_CELL = 420;
const GRAY = 128;

export interface Rgb { width: number; height: number; data: Uint8Array }
export interface Pixels { width: number; height: number; channels: number; data: Uint8Array }

export interface SheetLayout { count: number; cols: number; rows: number; cell: number }
/** where picture `n` (1-based, all sheets) went */
export interface Cell { n: number; sheet: number; row: number; col: number }

/** How `n` pictures are laid out: sheets of at most (SHEET_EDGE / MIN_CELL)² cells, each as
 *  square a grid as the count gives, cells as big as fit (≤ MAX_CELL). */
export function sheetLayouts(n: number, edge = SHEET_EDGE, minCell = MIN_CELL, maxCell = MAX_CELL): SheetLayout[] {
  if (n <= 0) return [];
  const side = Math.max(1, Math.floor(edge / minCell)), per = side * side;
  const out: SheetLayout[] = [];
  for (let left = n; left > 0; left -= per) {
    const count = Math.min(per, left);
    const cols = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / cols);
    out.push({ count, cols, rows, cell: Math.min(maxCell, Math.floor(edge / cols)) });
  }
  return out;
}

/** picture `i` (0-based) of `layouts`: its sheet, row and column */
export function cellOf(layouts: readonly SheetLayout[], i: number): Cell | null {
  let at = i;
  for (const [s, l] of layouts.entries()) {
    if (at < l.count) return { n: i + 1, sheet: s, row: Math.floor(at / l.cols), col: at % l.cols };
    at -= l.count;
  }
  return null;
}

/** `px` (gray / gray+alpha / RGB / RGBA, any size) fitted into a `cell`-px square: proportions kept,
 *  centred, `pad` px clear on every side, transparency over gray. */
export function fitCell(px: Pixels | null, cell: number, pad = 3): Rgb {
  const out = new Uint8Array(cell * cell * 3).fill(GRAY);
  if (!px || px.width < 1 || px.height < 1 || px.channels < 1 || px.channels > 4 || px.data.length < px.width * px.height * px.channels) return { width: cell, height: cell, data: out };
  const room = Math.max(1, cell - 2 * pad), k = Math.min(room / px.width, room / px.height);
  const w = Math.max(1, Math.round(px.width * k)), h = Math.max(1, Math.round(px.height * k));
  const x0 = Math.floor((cell - w) / 2), y0 = Math.floor((cell - h) / 2), ch = px.channels;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(px.width - 1, Math.floor((x + .5) / k)), sy = Math.min(px.height - 1, Math.floor((y + .5) / k));
    const s = (sy * px.width + sx) * ch, d = ((y0 + y) * cell + x0 + x) * 3;
    const rgb = ch >= 3 ? [px.data[s], px.data[s + 1], px.data[s + 2]] : [px.data[s], px.data[s], px.data[s]];
    const a = ch === 4 ? px.data[s + 3] / 255 : ch === 2 ? px.data[s + 1] / 255 : 1;
    for (let c = 0; c < 3; c++) out[d + c] = Math.round(rgb[c] * a + GRAY * (1 - a));
  }
  return { width: cell, height: cell, data: out };
}

/** 3×5 digits, rows top to bottom, 3 bits each (left = 4) */
const DIGITS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7], "4": [5, 5, 7, 1, 1],
  "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 1, 1], "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
};

/** `text` (digits) in white on a black box at the top-left corner of `img`; `scale`: px per font dot */
export function drawLabel(img: Rgb, text: string, scale: number, x = 0, y = 0) {
  const s = Math.max(1, Math.round(scale)), pad = s;
  const glyphs = [...text].filter(c => DIGITS[c]);
  const bw = pad * 2 + glyphs.length * 4 * s - s, bh = pad * 2 + 5 * s;
  const put = (px: number, py: number, v: number) => {
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return;
    const d = (py * img.width + px) * 3;
    img.data[d] = img.data[d + 1] = img.data[d + 2] = v;
  };
  for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) put(x + xx, y + yy, 0);
  glyphs.forEach((c, i) => DIGITS[c].forEach((bits, row) => {
    for (let col = 0; col < 3; col++) if (bits & (4 >> col))
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) put(x + pad + i * 4 * s + col * s + dx, y + pad + row * s + dy, 255);
  }));
}

/** One sheet: `cells[i]` (already fitCell'd to `layout.cell`) in reading order, numbered from
 *  `first`; a thin dark line between cells. */
export function drawSheet(layout: SheetLayout, cells: readonly Rgb[], first: number): Rgb {
  const W = layout.cols * layout.cell, H = layout.rows * layout.cell;
  const img: Rgb = { width: W, height: H, data: new Uint8Array(W * H * 3).fill(40) };
  const scale = Math.max(2, Math.round(layout.cell / 40));
  cells.slice(0, layout.count).forEach((c, i) => {
    const ox = (i % layout.cols) * layout.cell, oy = Math.floor(i / layout.cols) * layout.cell;
    for (let y = 1; y < layout.cell; y++) {
      const from = (y * c.width + 1) * 3, to = ((oy + y) * W + ox + 1) * 3;
      img.data.set(c.data.subarray(from, from + (layout.cell - 1) * 3), to);
    }
    // digits only: a 3×5 "#" reads as "H"
    drawLabel(img, String(first + i), scale, ox + 1, oy + 1);
  });
  return img;
}
