// 悬停边框: resting the pointer on a WaveLayer row frames that layer on Photoshop's canvas.
// The frame is the layer's bounds (no pixels are read, nothing is selected in Photoshop), drawn by
// the overlay helper as a click-through window (native/overlay/src/frame.rs). Resting a moment
// longer tints the layer's own shape (悬停高亮: its pixels read once, scaled down to TINT_SIZE, and
// cached per document version). This file works out the rectangles; layerTree.ts decides when.

import type { Rect } from "../image/region.ts";
import { type CanvasView, type ScreenRect, docToScreen } from "./protocol.ts";

/** What a layer row frames, in document pixels: an artboard's board, else the layer's bounds
 *  (without effects; a group's is all of its content). null when there is nothing to frame. */
export function layerFrame(l: { left: number; top: number; width: number; height: number; board?: Rect }): Rect | null {
  if (l.board && l.board.right > l.board.left && l.board.bottom > l.board.top) return { ...l.board };
  if (!(l.width > 0 && l.height > 0)) return null;
  return { left: l.left, top: l.top, right: l.left + l.width, bottom: l.top + l.height };
}

/** The frame on screen and the canvas view it is cut to; null when none of it is in view. */
export function frameOnScreen(r: Rect, v: CanvasView): { rect: ScreenRect; clip: ScreenRect } | null {
  const rect = docToScreen(r, v), clip = v.view;
  // at a low zoom a small layer still gets a frame you can see
  if (rect.right - rect.left < 1) rect.right = rect.left + 1;
  if (rect.bottom - rect.top < 1) rect.bottom = rect.top + 1;
  if (rect.right <= clip.left || rect.left >= clip.right || rect.bottom <= clip.top || rect.top >= clip.bottom) return null;
  return { rect, clip };
}

/** Identifies a frame message, so the same one isn't sent twice. */
export const frameKey = (f: { rect: ScreenRect; clip: ScreenRect } | null): string =>
  f ? [f.rect.left, f.rect.top, f.rect.right, f.rect.bottom, f.clip.left, f.clip.top, f.clip.right, f.clip.bottom].join(",") : "";

/** 悬停高亮: the longest side of the layer shape read for the tint (Photoshop scales it down) */
export const TINT_SIZE = 256;

/** The coverage (0–255 per pixel) of read layer pixels: their alpha, or all covered without one. */
export function shapeAlpha(data: Uint8Array, width: number, height: number, channels: number): Uint8Array | null {
  const n = width * height;
  if (!(width >= 1 && height >= 1 && channels >= 1 && channels <= 4) || data.length < n * channels) return null;
  const out = new Uint8Array(n);
  if (channels === 4 || channels === 2) for (let i = 0; i < n; i++) out[i] = data[i * channels + channels - 1];
  else out.fill(255);
  return out;
}

/** Base64 of `bytes` (btoa takes a string of char codes; built in pieces to stay off the stack limit). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Several layers' shapes as one (文档检查: an issue's layers light up together): their coverage
 *  grids put on one grid over the union of their bounds, at most `max` px a side, taking the
 *  highest coverage where they overlap. null without shapes. */
export function unionShapes(shapes: readonly { bounds: Rect; width: number; height: number; alpha: Uint8Array }[], max = TINT_SIZE): { bounds: Rect; width: number; height: number; alpha: Uint8Array } | null {
  const ok = shapes.filter(s => s.width >= 1 && s.height >= 1 && s.bounds.right > s.bounds.left && s.bounds.bottom > s.bounds.top && s.alpha.length >= s.width * s.height);
  if (!ok.length) return null;
  if (ok.length === 1) return ok[0];
  const b: Rect = {
    left: Math.min(...ok.map(s => s.bounds.left)), top: Math.min(...ok.map(s => s.bounds.top)),
    right: Math.max(...ok.map(s => s.bounds.right)), bottom: Math.max(...ok.map(s => s.bounds.bottom)),
  };
  const bw = b.right - b.left, bh = b.bottom - b.top, k = max / Math.max(bw, bh);
  const width = Math.max(1, Math.round(bw * k)), height = Math.max(1, Math.round(bh * k));
  const alpha = new Uint8Array(width * height);
  for (const s of ok) {
    const sw = s.bounds.right - s.bounds.left, sh = s.bounds.bottom - s.bounds.top;
    const x0 = Math.max(0, Math.floor((s.bounds.left - b.left) * k)), x1 = Math.min(width, Math.ceil((s.bounds.right - b.left) * k));
    const y0 = Math.max(0, Math.floor((s.bounds.top - b.top) * k)), y1 = Math.min(height, Math.ceil((s.bounds.bottom - b.top) * k));
    for (let y = y0; y < y1; y++) {
      const sy = Math.min(s.height - 1, Math.max(0, Math.floor(((y + 0.5) / k + b.top - s.bounds.top) / sh * s.height)));
      for (let x = x0; x < x1; x++) {
        const sx = Math.min(s.width - 1, Math.max(0, Math.floor(((x + 0.5) / k + b.left - s.bounds.left) / sw * s.width)));
        const v = s.alpha[sy * s.width + sx], i = y * width + x;
        if (v > alpha[i]) alpha[i] = v;
      }
    }
  }
  return { bounds: b, width, height, alpha };
}
