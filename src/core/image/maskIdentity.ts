// Two masks are identical only when their position, size, and grayscale values all match.
// 255 means repaint. Partial/antialiased pixels matter as much as solid regions.
import type { Pixels } from "./png.ts";
import type { Rect } from "./region.ts";

export function sameMaskAt(a: Pixels, ar: Rect, b: Pixels, br: Rect): boolean {
  if (ar.left !== br.left || ar.top !== br.top || ar.right !== br.right || ar.bottom !== br.bottom) return false;
  const w = ar.right - ar.left, h = ar.bottom - ar.top;
  if (w <= 0 || h <= 0 || a.channels !== 1 || b.channels !== 1) return false;
  if (a.width !== w || b.width !== w || a.height !== h || b.height !== h || a.data.length !== w * h || b.data.length !== w * h) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}
