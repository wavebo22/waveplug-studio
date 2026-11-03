import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInpaint } from "../src/app/generate.ts";
import { encodePng } from "../src/core/image/png.ts";
import type { Rect } from "../src/core/image/region.ts";
import { uiToApi } from "../src/core/workflow/uiToApi.ts";
import { recognize } from "../src/core/workflow/recognize.ts";
import { newProfile } from "../src/core/workflow/profile.ts";
import type { FillGroup } from "../src/ps/host.ts";

// Re-generating an older expansion after the canvas was expanded again: the original image and
// the placement must come from that expansion's own area, not from the current canvas size.
test("再生成 on an older 扩图 uses the group's own area", async () => {
  const g = uiToApi(JSON.parse(readFileSync(new URL("./fixtures/ui/guhai_remove_inpaint_outpaint.json", import.meta.url), "utf8"))).api;
  const r = recognize(g);
  const profile = newProfile("扩图", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  profile.taskType = "outpaint"; profile.options.outpaint = r.outpaint; profile.options.allowEmptyPrompt = true;

  // first expansion: 100×80 image + left 20 / bottom 10 → 120×90, later expanded again by left 50 top 30
  const older: FillGroup = { kind: "outpaint", pads: { left: 20, right: 0, top: 0, bottom: 10 }, docId: 1, layerId: 9, name: "←20 →0 ↑0 ↓10", rect: { left: 50, top: 30, right: 170, bottom: 120 } };
  const calls: { capture?: Rect; placement?: Rect; maskRect?: Rect } = {};
  const host: any = {
    activeDoc: () => ({ id: 1, name: "t", width: 170, height: 120, mode: "RGBColorMode", bits: 8 }),
    docExists: () => true,
    refreshFillGroup: async (x: FillGroup) => x,
    capture: async (_d: number, rect: Rect) => { calls.capture = rect; const w = rect.right - rect.left, h = rect.bottom - rect.top; return { rect, image: { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3) }, selection: { width: w, height: h, channels: 1, data: new Uint8Array(w * h) } }; },
    expandCanvas: async () => { throw new Error("must not expand again"); },
    addVariation: async (_g: FillGroup, _png: Uint8Array, placement: Rect, _p: string, m: { rect: Rect }) => { calls.placement = placement; calls.maskRect = m.rect; return { layerId: 1, number: 2, label: "2", prompt: "", visible: true }; },
  };
  const comfy: any = {
    uploadImage: async (_b: Uint8Array, name: string) => name,
    queue: async () => ({ promptId: "p", number: 1 }),
    waitFor: async () => ({ outputs: { "315": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } }, status: { completed: true } }),
    view: async () => encodePng({ width: 120, height: 90, channels: 3, data: new Uint8Array(120 * 90 * 3) }),
  };
  await runInpaint(host, comfy, { profile, prompt: "", seed: 1, params: {}, references: {}, count: 1, addTo: older },
    { stage: () => {}, progress: () => {}, signal: { aborted: false } });
  assert.deepEqual(calls.capture, { left: 70, top: 30, right: 170, bottom: 110 });
  assert.deepEqual(calls.placement, older.rect);
  assert.deepEqual(calls.maskRect, { left: 70, top: 30, right: 170, bottom: 110 });
});

// A new expansion whose variation fails to write: the canvas is already expanded and the group made
// (separate undo steps), so the result must be kept and the message must say what changed.
test("扩图 keeps the result when writing the variation fails after the canvas grew", async () => {
  const g = uiToApi(JSON.parse(readFileSync(new URL("./fixtures/ui/guhai_remove_inpaint_outpaint.json", import.meta.url), "utf8"))).api;
  const r = recognize(g);
  const profile = newProfile("扩图", g, r.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
  profile.taskType = "outpaint"; profile.options.outpaint = r.outpaint; profile.options.allowEmptyPrompt = true;
  const out = encodePng({ width: 120, height: 90, channels: 3, data: new Uint8Array(120 * 90 * 3) });
  const host: any = {
    activeDoc: () => ({ id: 1, name: "t", width: 100, height: 80, mode: "RGBColorMode", bits: 8 }),
    docExists: () => true,
    capture: async (_d: number, rect: Rect) => { const w = rect.right - rect.left, h = rect.bottom - rect.top; return { rect, image: { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3) }, selection: { width: w, height: h, channels: 1, data: new Uint8Array(w * h) } }; },
    expandCanvas: async () => ({}),
    createFillGroup: async (docId: number, rect: Rect, _p: string, pads: any) => ({ kind: "outpaint", pads, docId, layerId: 9, name: "x", rect }),
    addVariation: async () => { throw new Error("置入失败"); },
  };
  const comfy: any = {
    uploadImage: async (_b: Uint8Array, name: string) => name,
    queue: async () => ({ promptId: "p", number: 1 }),
    waitFor: async () => ({ outputs: { "315": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } }, status: { completed: true } }),
    view: async () => out,
  };
  await assert.rejects(
    runInpaint(host, comfy, { profile, prompt: "", seed: 1, params: {}, references: {}, count: 1, pads: { left: 20, right: 0, top: 0, bottom: 10 } },
      { stage: () => {}, progress: () => {}, signal: { aborted: false } }),
    (e: any) => {
      assert.equal(e.constructor.name, "StashedResult");
      assert.equal(e.png, out);
      assert.match(e.message, /置入失败，结果未写入；画布已扩展并新建了空的扩图图层组/);
      return true;
    });
});
