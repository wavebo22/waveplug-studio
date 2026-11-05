import assert from "node:assert/strict";
import test from "node:test";
import { buildAlphaOutline } from "../src/core/layers/alphaOutline.ts";

function rgba(width: number, height: number, alpha: (x: number, y: number) => number) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alpha(x, y);
    }
  }
  return data;
}

const bounds = { left: 0, top: 0, right: 5, bottom: 5 };

test("extracts the actual silhouette, not the image rectangle", () => {
  const result = buildAlphaOutline({
    width: 5, height: 5, channels: 4,
    data: rgba(5, 5, (x, y) => x >= 1 && x <= 3 && y >= 1 && y <= 3 ? 255 : 0),
    sourceBounds: bounds,
  });
  assert.deepEqual(result.segments, [
    [1, 1, 4, 1], [1, 4, 4, 4],
    [1, 1, 1, 4], [4, 1, 4, 4],
  ]);
  assert.equal(result.opaquePixels, 9);
});

test("keeps inner holes and disconnected islands", () => {
  const result = buildAlphaOutline({
    width: 5, height: 5, channels: 4,
    data: rgba(5, 5, (x, y) => (x === 2 && y === 2) ? 0 : 255),
    sourceBounds: bounds,
  });
  assert.equal(result.segments.length, 8);
  assert.equal(result.opaquePixels, 24);
});

test("uses a threshold to ignore nearly transparent fringe pixels", () => {
  const data = rgba(3, 3, (x, y) => x === 1 && y === 1 ? 16 : 0);
  const ignored = buildAlphaOutline({
    width: 3, height: 3, channels: 4, data,
    sourceBounds: { left: 0, top: 0, right: 3, bottom: 3 },
  }, { threshold: 16 });
  const retained = buildAlphaOutline({
    width: 3, height: 3, channels: 4, data,
    sourceBounds: { left: 0, top: 0, right: 3, bottom: 3 },
  }, { threshold: 15 });
  assert.equal(ignored.segments.length, 0);
  assert.equal(retained.segments.length, 4);
});

test("maps reduced pyramid pixels back to full-resolution document coordinates", () => {
  const result = buildAlphaOutline({
    width: 5, height: 5, channels: 4,
    data: rgba(5, 5, (x, y) => x >= 1 && x <= 3 && y >= 1 && y <= 3 ? 255 : 0),
    sourceBounds: { left: 10, top: 20, right: 15, bottom: 25 },
    level: 1,
  });
  assert.deepEqual(result.segments[0], [22, 42, 28, 42]);
  assert.deepEqual(result.bounds, { left: 20, top: 40, right: 30, bottom: 50 });
  assert.deepEqual(result.pixelScale, { x: 2, y: 2 });
});

test("opaque RGB data produces its actual trimmed rectangle", () => {
  const result = buildAlphaOutline({
    width: 2, height: 2, channels: 3,
    data: new Uint8Array(12).fill(255),
    sourceBounds: { left: 8, top: 9, right: 10, bottom: 11 },
  });
  assert.equal(result.segments.length, 4);
  assert.equal(result.opaquePixels, 4);
});

test("rejects malformed buffers and excessive contour complexity", () => {
  assert.throws(() => buildAlphaOutline({
    width: 5, height: 5, channels: 4,
    data: new Uint8Array(2), sourceBounds: bounds,
  }), /shorter/);
  assert.throws(() => buildAlphaOutline({
    width: 5, height: 5, channels: 4,
    data: rgba(5, 5, (x, y) => (x + y) % 2 ? 255 : 0),
    sourceBounds: bounds,
  }, { maxSegments: 4 }), /segment budget/);
});
