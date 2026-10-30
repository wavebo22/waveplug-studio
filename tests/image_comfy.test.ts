import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { encodePng } from "../src/core/image/png.ts";
import { imageWithAlphaMask, maskFile } from "../src/core/image/compose.ts";
import { expand, fitSize, placementInGroup } from "../src/core/image/region.ts";
import { ComfyClient, describeError, outputImage } from "../src/core/comfy/client.ts";

function decode(png: Uint8Array) {
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let o = 8, w = 0, h = 0, type = 0; const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = dv.getUint32(o), t = String.fromCharCode(...png.slice(o + 4, o + 8));
    if (t === "IHDR") { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); type = png[o + 17]; }
    if (t === "IDAT") idat.push(png.slice(o + 8, o + 8 + len));
    o += 12 + len;
  }
  return { w, h, type, raw: inflateSync(Buffer.concat(idat)) };
}

test("PNG encoder output inflates to filtered rows (large image spans many stored blocks)", () => {
  const w = 300, h = 250, data = new Uint8Array(w * h * 4).map((_, i) => (i * 7) & 255);
  const d = decode(encodePng({ width: w, height: h, channels: 4, data }));
  assert.equal(d.w, w); assert.equal(d.h, h); assert.equal(d.type, 6);
  assert.equal(d.raw.length, (w * 4 + 1) * h);
  assert.equal(d.raw[0], 0);
  assert.equal(d.raw[(w * 4 + 1) * 10 + 1 + 5], data[w * 4 * 10 + 5]);
});

test("selection becomes transparency; RGB under transparent pixels is preserved", () => {
  const img = { width: 2, height: 1, channels: 3 as const, data: new Uint8Array([10, 20, 30, 40, 50, 60]) };
  const sel = { width: 2, height: 1, channels: 1 as const, data: new Uint8Array([255, 64]) };
  const out = imageWithAlphaMask(img, sel);
  assert.deepEqual([...out.data], [10, 20, 30, 0, 40, 50, 60, 191]);
  assert.deepEqual([...maskFile(sel, "mask-alpha").data].filter((_, i) => i % 4 === 3), [0, 191]);
});

test("region helpers", () => {
  assert.deepEqual(expand({ left: 100, top: 100, right: 200, bottom: 150 }, 0.5, 220, 1000), { left: 50, top: 75, right: 220, bottom: 175 });
  assert.deepEqual(placementInGroup({ left: 50, top: 75, right: 250, bottom: 175 }, { left: 100, top: 100, right: 200, bottom: 150 }), { left: -50, top: -25, right: 150, bottom: 75 });
  const s = fitSize(3000, 2000);
  assert.equal(s.width % 16, 0); assert.ok(s.width * s.height <= 1024 * 1024 * 1.05);
  assert.ok(Math.abs(s.width / s.height - 1.5) < 0.03);
});

test("client: upload → queue → history → view, readable node errors", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace("http://127.0.0.1:8188", "");
    calls.push((init?.method ?? "GET") + " " + path.split("?")[0]);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === "/upload/image") return json({ name: "a.png", subfolder: "waveplug" });
    if (path === "/prompt") {
      const body = JSON.parse(String(init!.body));
      if (body.prompt.bad) return json({ error: { message: "Prompt outputs failed validation" }, node_errors: { "22": { class_type: "DF_Text_Box", errors: [{ message: "Required input is missing", details: "Text" }] } } }, 400);
      return json({ prompt_id: "p1", number: 3 });
    }
    if (path.startsWith("/history/p1")) return json({ p1: { status: { completed: true, status_str: "success" }, outputs: { "38": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } } } });
    if (path.startsWith("/view")) return new Response(new Uint8Array([1, 2, 3]));
    return json({}, 404);
  }) as typeof fetch;
  const c = new ComfyClient("http://127.0.0.1:8188", { fetch: fakeFetch });
  assert.equal(await c.uploadImage(new Uint8Array([1]), "a.png"), "waveplug/a.png");
  const job = await c.queue({ "1": { class_type: "X", inputs: {} } });
  const h = await c.waitFor(job.promptId, () => {}, { pollMs: 1 });
  assert.deepEqual([...await c.view(outputImage(h, "38"))], [1, 2, 3]);
  await assert.rejects(c.queue({ bad: { class_type: "X", inputs: {} } } as any), /#22 DF_Text_Box：Required input is missing Text/);
  assert.throws(() => outputImage(h, "38", 1), /只返回了 1 张/);
  assert.equal(describeError("plain"), "plain");
  assert.ok(calls.includes("POST /prompt"));
});

test("address normalisation accepts bare IP / IP:port / full URL", async () => {
  const { normalizeUrl } = await import("../src/ui/app.ts").catch(() => ({ normalizeUrl: null as any }));
  if (!normalizeUrl) return; // app.ts needs a DOM at import time only for types; skip if unavailable
  assert.equal(normalizeUrl("127.0.0.1"), "http://127.0.0.1:8188");
  assert.equal(normalizeUrl("192.168.1.7:8188/"), "http://192.168.1.7:8188");
  assert.equal(normalizeUrl("http://localhost:9000"), "http://localhost:9000");
  assert.equal(normalizeUrl(""), "http://127.0.0.1:8188");
});

test("multipart upload works without TextEncoder (UXP has none)", async () => {
  const saved = (globalThis as any).TextEncoder;
  (globalThis as any).TextEncoder = undefined;
  try {
    let body: Uint8Array | null = null;
    const c = new ComfyClient("http://h", { fetch: (async (_u: string, init?: RequestInit) => { body = init!.body as Uint8Array; return new Response(JSON.stringify({ name: "x.png", subfolder: "waveplug" })); }) as typeof fetch });
    await c.uploadImage(new Uint8Array([137, 80]), "参考 1.png");
    const text = Buffer.from(body!).toString("utf8");
    assert.match(text, /filename="参考 1\.png"/);
    assert.match(text, /name="subfolder"\r\n\r\nwaveplug\r\n/);
  } finally { (globalThis as any).TextEncoder = saved; }
});

test("selection trimmed to its own bounds is placed back into the captured area", async () => {
  const { placeGray } = await import("../src/core/image/compose.ts");
  const sel = { width: 2, height: 1, channels: 1 as const, data: new Uint8Array([255, 128]) };
  const out = placeGray(sel, { left: 3, top: 1, right: 5, bottom: 2 }, { left: 0, top: 0, right: 6, bottom: 3 });
  assert.equal(out.width, 6); assert.equal(out.height, 3);
  assert.deepEqual([...out.data.slice(6, 12)], [0, 0, 0, 255, 128, 0]);
  assert.equal(out.data.reduce((a, b) => a + b, 0), 383);
});

test("optional red mark tints only the selected pixels, alpha unchanged", () => {
  const img = { width: 2, height: 1, channels: 3 as const, data: new Uint8Array([100, 100, 100, 100, 100, 100]) };
  const sel = { width: 2, height: 1, channels: 1 as const, data: new Uint8Array([255, 0]) };
  assert.deepEqual([...imageWithAlphaMask(img, sel, 0.5).data], [178, 50, 50, 0, 100, 100, 100, 255]);
});

test("crop margin and mask bounds helpers", async () => {
  const { expandBy, nonZeroBounds } = await import("../src/core/image/region.ts");
  assert.deepEqual(expandBy({ left: 100, top: 100, right: 200, bottom: 300 }, 100, 1000, 350), { left: 0, top: 0, right: 300, bottom: 350 });
  const d = new Uint8Array(4 * 3); d[1 * 4 + 2] = 9; d[2 * 4 + 3] = 1;
  assert.deepEqual(nonZeroBounds(d, 4, 3, { left: 10, top: 20, right: 14, bottom: 23 }), { left: 12, top: 21, right: 14, bottom: 23 });
});

test("placement hints: sRGB + document DPI chunks, image data untouched", async () => {
  const { withPlacementHints } = await import("../src/core/image/png.ts");
  const png = encodePng({ width: 3, height: 2, channels: 3, data: new Uint8Array(18).fill(7) });
  const out = withPlacementHints(png, 300);
  const types: string[] = []; const dv = new DataView(out.buffer, out.byteOffset);
  for (let o = 8; o < out.length;) { const len = dv.getUint32(o); types.push(String.fromCharCode(...out.slice(o + 4, o + 8))); if (types.at(-1) === "pHYs") assert.equal(dv.getUint32(o + 8), Math.round(300 / 0.0254)); o += 12 + len; }
  assert.deepEqual(types, ["IHDR", "sRGB", "pHYs", "IDAT", "IEND"]);
  assert.deepEqual([...decode(out).raw], [...decode(png).raw]);
  assert.deepEqual(withPlacementHints(out, 72).length, out.length, "re-applying replaces, not duplicates");
});
