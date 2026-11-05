export interface AlphaRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AlphaPixels {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export type OutlineSegment = [number, number, number, number];

export interface AlphaOutlineInput extends AlphaPixels {
  sourceBounds: AlphaRect;
  level?: number;
}

export interface AlphaOutline {
  bounds: AlphaRect;
  segments: OutlineSegment[];
  threshold: number;
  sourceSize: { width: number; height: number };
  pixelScale: { x: number; y: number };
  opaquePixels: number;
}

function alphaOffset(channels: number): number {
  if (channels === 4) return 3;
  if (channels === 2) return 1;
  return -1;
}

/**
 * Extracts the pixel boundary of non-transparent pixels.
 * Coordinates are returned in full-resolution document pixels.
 *
 * This deliberately returns merged straight segments instead of a bounding rectangle.
 * It is a small, deterministic first-stage POC; the native renderer can stroke the segments
 * without needing to reconstruct polygon winding or holes.
 */
export function buildAlphaOutline(
  input: AlphaOutlineInput,
  options: { threshold?: number; maxSegments?: number } = {},
): AlphaOutline {
  const { width, height, channels, data, sourceBounds } = input;
  const threshold = Math.max(0, Math.min(255, Math.round(options.threshold ?? 16)));
  const maxSegments = Math.max(4, Math.floor(options.maxSegments ?? 8192));

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("invalid alpha image dimensions");
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 4) {
    throw new Error("unsupported alpha image component count");
  }
  if (data.length < width * height * channels) {
    throw new Error("alpha image buffer is shorter than its dimensions");
  }
  if (![sourceBounds.left, sourceBounds.top, sourceBounds.right, sourceBounds.bottom].every(Number.isFinite)
    || sourceBounds.right <= sourceBounds.left || sourceBounds.bottom <= sourceBounds.top) {
    throw new Error("invalid alpha source bounds");
  }

  const alphaIndex = alphaOffset(channels);
  const opaque = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (alphaIndex < 0) return true;
    return data[(y * width + x) * channels + alphaIndex] > threshold;
  };

  let opaquePixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (opaque(x, y)) opaquePixels++;
  }

  const levelScale = 2 ** Math.max(0, Number.isFinite(input.level) ? input.level! : 0);
  const pixelScale = {
    x: (sourceBounds.right - sourceBounds.left) * levelScale / width,
    y: (sourceBounds.bottom - sourceBounds.top) * levelScale / height,
  };
  const mapX = (x: number) => (sourceBounds.left + x * (sourceBounds.right - sourceBounds.left) / width) * levelScale;
  const mapY = (y: number) => (sourceBounds.top + y * (sourceBounds.bottom - sourceBounds.top) / height) * levelScale;

  const segments: OutlineSegment[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    if (segments.length >= maxSegments) throw new Error("alpha outline exceeds segment budget");
    segments.push([mapX(x1), mapY(y1), mapX(x2), mapY(y2)]);
  };

  if (opaquePixels > 0) {
    // Horizontal boundaries. Consecutive pixel edges are merged into one segment.
    for (let y = 0; y <= height; y++) {
      let start = -1;
      for (let x = 0; x < width; x++) {
        const edge = opaque(x, y - 1) !== opaque(x, y);
        if (edge && start < 0) start = x;
        if (!edge && start >= 0) {
          add(start, y, x, y);
          start = -1;
        }
      }
      if (start >= 0) add(start, y, width, y);
    }

    // Vertical boundaries. This also captures holes and disconnected islands.
    for (let x = 0; x <= width; x++) {
      let start = -1;
      for (let y = 0; y < height; y++) {
        const edge = opaque(x - 1, y) !== opaque(x, y);
        if (edge && start < 0) start = y;
        if (!edge && start >= 0) {
          add(x, start, x, y);
          start = -1;
        }
      }
      if (start >= 0) add(x, start, x, height);
    }
  }

  return {
    bounds: {
      left: mapX(0),
      top: mapY(0),
      right: mapX(width),
      bottom: mapY(height),
    },
    segments,
    threshold,
    sourceSize: { width, height },
    pixelScale,
    opaquePixels,
  };
}
