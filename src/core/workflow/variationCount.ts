/** UXP generation count: accept whole numbers only and keep them in [1, 4]. */
export function normalizeVariationCount(value: string | number | null | undefined): number {
  if (value === "" || value === null || value === undefined) return 1;
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(1, Math.min(4, n)) : 1;
}

/** A mouse-wheel notch over the count field changes one variation, clamped to 1–4. */
export function stepVariationCountByWheel(value: string | number | null | undefined, deltaY: number): number {
  const current = normalizeVariationCount(value);
  if (!Number.isFinite(deltaY) || deltaY === 0) return current;
  return Math.max(1, Math.min(4, current + (deltaY < 0 ? 1 : -1)));
}
