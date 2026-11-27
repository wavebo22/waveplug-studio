// 变体栏的悬停预览: where the bigger picture goes — just below the pointer, or above it when there
// is no room below; never past the panel's sides. Pure (tests/hover_preview.test.ts).

export const PREVIEW_DELAY_MS = 150;
/** the preview's picture, px a side (it shows the variant over its own area, proportions kept) */
export const PREVIEW_PX = 220;

/** Top-left of a `size` box for a pointer at `at` inside a `room` (all px of the panel). */
export function previewPlace(at: { x: number; y: number }, size: { w: number; h: number }, room: { w: number; h: number }, gap = 16): { left: number; top: number } {
  const below = at.y + gap, above = at.y - gap - size.h;
  const top = below + size.h <= room.h || above < 0 ? Math.max(0, Math.min(below, room.h - size.h)) : above;
  const left = Math.max(0, Math.min(at.x - size.w / 2, room.w - size.w));
  return { left: Math.round(left), top: Math.round(top) };
}
