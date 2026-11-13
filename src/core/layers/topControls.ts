/** WaveLayer top controls: migrate the old four thumbnail steps to continuous percent. */
export const THUMB_PERCENT_KEY = "wp.layers.thumbPercent";
export const legacyThumbPercent = (size: string | null, wasOff: boolean): number =>
  size === "off" ? 0 : size === "s" ? 63 : size === "l" ? 150 : size === "m" ? 100 : wasOff ? 0 : 100;

export const clampThumbPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(150, Math.round(value))) : 100;

export function thumbnailMetrics(value: number) {
  const percent = clampThumbPercent(value);
  const thumb = percent === 0 ? 0 : Math.max(12, Math.round(percent <= 100
    ? 38 * percent / 100 : 38 + (percent - 100) * 16 / 50));
  return { percent, thumb, row: Math.max(30, thumb + 6), short: 26 };
}
