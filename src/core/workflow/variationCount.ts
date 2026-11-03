/** UXP generation count: accept manual numeric input, always keep it in [1, 4]. */
export function normalizeVariationCount(value: string | number | null | undefined): number {
  if (value === "" || value === null || value === undefined) return 1;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(4, Math.trunc(n))) : 1;
}
