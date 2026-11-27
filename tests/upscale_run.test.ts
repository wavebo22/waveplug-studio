import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInpaint } from "../src/app/generate.ts";
import { encodePng } from "../src/core/image/png.ts";
import { decodePng } from "../src/core/image/decode.ts";
import type { Rect } from "../src/core/image/region.ts";
import { uiToApi } from "../src/core/workflow/uiToApi.ts";
import { recognize } from "../src/core/workflow/recognize.ts";
import { newProfile } from "../src/core/workflow/profile.ts";
import type { FillGroup } from "../src/ps/host.ts";

const profile = () => {
  const g = uiToApi(JSON.parse(readFileSync(new URL("./fixtures/ui/vosr2_upscale.json", import.meta.url), "utf8"))).api;
  const r = recognize(g);
  const p = newProfile("放大", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  p.taskType = "upscale"; p.options.upscale = r.upscale; p.options.allowEmptyPrompt = true;
  return p;
};

function fakes(sel: Rect | null, out: { width: number; height: number }) {
  const calls: { capture?: Rect; doc?: [number, number, string]; group?: [number, Rect, string, string | undefined]; placement?: Rect; queued?: any } = {};
  const host: any = {
    activeDoc: () => ({ id: 1, name: "海报.psd", width: 400, height: 300, mode: "RGBColorMode", bits: 8 }),
    docExists: () => true,
    selectionBounds: async () => sel,
    capture: async (_d: number, rect: Rect) => { calls.capture = rect; const w = rect.right - rect.left, h = rect.bottom - rect.top; return { rect, image: { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3) }, selection: { width: w, height: h, channels: 1, data: new Uint8Array(w * h).fill(255) } }; },
    createDocument: async (w: number, h: number, name: string) => { calls.doc = [w, h, name]; return { id: 2, name, width: w, height: h, mode: "RGBColorMode", bits: 8 }; },
    createFillGroup: async (d: number, rect: Rect, label: string, _p: unknown, kind: string): Promise<FillGroup> => { calls.group = [d, rect, label, kind]; return { kind: "upscale", docId: d, layerId: 5, name: label, rect }; },
    refreshFillGroup: async (x: FillGroup) => x,
    addVariation: async (_g: FillGroup, _png: Uint8Array, placement: Rect) => { calls.placement = placement; return { layerId: 6, number: 1, label: "1", prompt: "", visible: true }; },
  };
  const comfy: any = {
    uploadImage: async (_b: Uint8Array, name: string) => name,
    queue: async (api: any) => { calls.queued = api; return { promptId: "p", number: 1 }; },
    waitFor: async () => ({ outputs: { "1": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } }, status: { completed: true } }),
    view: async () => encodePng({ width: out.width, height: out.height, channels: 3, data: new Uint8Array(out.width * out.height * 3) }),
  };
  return { host, comfy, calls };
}
const hooks = () => ({ stage: () => {}, progress: () => {}, signal: { aborted: false } });

test("放大: whole canvas into a new document at the output size", async () => {
  const { host, comfy, calls } = fakes(null, { width: 800, height: 600 });
  const res = await runInpaint(host, comfy, { profile: profile(), prompt: "", seed: 1, params: {}, references: {}, count: 1, scale: 2 }, hooks());
  assert.deepEqual(calls.capture, { left: 0, top: 0, right: 400, bottom: 300 });
  assert.equal(calls.queued["4"].inputs.value, 2);
  assert.deepEqual(calls.doc, [800, 600, "海报 ×2"]);
  assert.deepEqual(calls.group, [2, { left: 0, top: 0, right: 800, bottom: 600 }, "×2", "upscale"]);
  assert.deepEqual(calls.placement, { left: 0, top: 0, right: 800, bottom: 600 });
  assert.equal(res.group.kind, "upscale");
});

test("放大: only the selection's bounds are sent", async () => {
  const { host, comfy, calls } = fakes({ left: 10, top: 20, right: 110, bottom: 70 }, { width: 400, height: 200 });
  await runInpaint(host, comfy, { profile: profile(), prompt: "", seed: 1, params: {}, references: {}, count: 1, scale: 4 }, hooks());
  assert.deepEqual(calls.capture, { left: 10, top: 20, right: 110, bottom: 70 });
  assert.deepEqual(calls.doc, [400, 200, "海报 ×4 选区 100×50"]);
});

test("放大: too large an output is refused before anything is sent", async () => {
  const { host, comfy, calls } = fakes(null, { width: 1, height: 1 });
  host.activeDoc = () => ({ id: 1, name: "大图", width: 5000, height: 3000, mode: "RGBColorMode", bits: 8 });
  await assert.rejects(runInpaint(host, comfy, { profile: profile(), prompt: "", seed: 1, params: {}, references: {}, count: 1, scale: 4 }, hooks()), /超过上限/);
  assert.equal(calls.capture, undefined);
});

test("放大 · 当前图层: smart object over the layer's own rect, transparency kept", async () => {
  const { host, comfy, calls } = fakes(null, { width: 40, height: 20 });
  // 20×10 layer at (5,6), left half transparent
  const px = new Uint8Array(20 * 10 * 4);
  for (let i = 0; i < 200; i++) { px[i * 4] = 50; px[i * 4 + 3] = i % 20 < 10 ? 0 : 255; }
  host.layerImage = async () => ({ pixels: { width: 20, height: 10, channels: 4, data: px }, rect: { left: 5, top: 6, right: 25, bottom: 16 } });
  let placed: any = null;
  host.placeUpscaledLayer = async (d: number, l: number, png: Uint8Array, rect: Rect, name: string) => { placed = { d, l, png, rect, name }; return 99; };
  const res = await runInpaint(host, comfy, { profile: profile(), prompt: "", seed: 1, params: {}, references: {}, count: 3, scale: 2, layers: [{ id: 7, name: "产品" }] }, hooks());
  assert.equal(calls.doc, undefined, "no new document");
  assert.equal(calls.queued["4"].inputs.value, 2);
  assert.deepEqual([placed.d, placed.l, placed.rect, placed.name], [1, 7, { left: 5, top: 6, right: 25, bottom: 16 }, "产品 ×2"]);
  const out = decodePng(placed.png);
  assert.deepEqual([out.width, out.height, out.channels], [40, 20, 4]);
  assert.equal(out.data[3], 0, "transparent corner stays transparent");
  assert.equal(out.data[(39) * 4 + 3], 255, "opaque side stays opaque");
  assert.equal(res.group, undefined);
});

test("批量放大: selected layers in turn; one failing doesn't stop the others", async () => {
  const { host, comfy } = fakes(null, { width: 40, height: 20 });
  host.layerImage = async (_d: number, id: number) => {
    if (id === 8) return { pixels: { width: 1, height: 1, channels: 3, data: new Uint8Array(3) }, rect: { left: 0, top: 0, right: 1, bottom: 1 } };
    return { pixels: { width: 20, height: 10, channels: 3, data: new Uint8Array(600) }, rect: { left: id, top: 0, right: id + 20, bottom: 10 } };
  };
  const placed: string[] = [], stages: string[] = [];
  host.placeUpscaledLayer = async (_d: number, _l: number, _png: Uint8Array, _r: Rect, name: string) => { placed.push(name); return 99; };
  const h = { ...hooks(), stage: (t: string) => stages.push(t) };
  const res = await runInpaint(host, comfy, { profile: profile(), prompt: "", seed: 1, params: {}, references: {}, count: 1, scale: 2,
    layers: [{ id: 7, name: "产品" }, { id: 8, name: "空图层" }, { id: 9, name: "瓶子" }] }, h);
  assert.deepEqual(placed, ["产品 ×2", "瓶子 ×2"]);
  assert.equal(res.upscaled, 2);
  assert.equal(res.failed!.length, 1);
  assert.match(res.failed![0], /^空图层：/);
  assert.ok(stages.some(s => s.endsWith("（3/3「瓶子」）")));
});

test("output aspect check allows multiple-of-32 rounding but not a crop", async () => {
  const { sameAspect } = await import("../src/app/generate.ts");
  assert.ok(sameAspect({ width: 992, height: 1056 }, { width: 1040, height: 1131 }), "the reported case");
  assert.ok(sameAspect({ width: 2264, height: 4096 }, { width: 2692, height: 4870 }));
  assert.ok(!sameAspect({ width: 1024, height: 1024 }, { width: 1040, height: 1500 }), "a square crop of a tall picture");
  assert.ok(!sameAspect({ width: 3000, height: 2000 }, { width: 3000, height: 2200 }));
});

