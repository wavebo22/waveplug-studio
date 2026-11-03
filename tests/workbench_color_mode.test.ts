import { test } from "node:test";
import assert from "node:assert/strict";
import { placeWorkbenchLayers } from "../src/ps/uxpWorkbench.ts";

type Setup = "fallbackSucceeds" | "fallbackNoop" | "mixedIsolated" | "partialBatch";

/** Reproduces UXP cross-mode no-op: duplicateLayers returns a Layer proxy but
 *  Photoshop creates NO layer in the CMYK destination. The Layer.duplicate()
 *  command may succeed, or may also silently no-op, depending on adjustment.
 *  No real PSD or user settings are touched. */
async function scenario(setup: Setup) {
  const previousRequire = (globalThis as any).require;
  const historyCommits: boolean[] = [];
  let nextId = 100;
  let nativeCalls = 0;
  let fallbackCalls = 0;
  const target: any = {
    id: 65, mode: setup === "partialBatch" ? "RGB" : "CMYK",
    name: "WavePlug_TEST_CMYK.psd",
    layers: [{ id: 12, name: "Background", kind: "normal" }],
    async createLayerGroup(options: any) {
      const group = { id: nextId++, name: options.name, kind: "group", layers: [] };
      target.layers.unshift(group);
      return group;
    },
  };
  const makeCopy = (source: any) => {
    const copy = {
      id: nextId++, kind: source.kind, name: source.name,
      async move(group: any, place: string) {
        assert.equal(place, "inside");
        target.layers.splice(target.layers.indexOf(this), 1);
        group.layers.unshift(this);
      },
    };
    target.layers.unshift(copy);
    return copy;
  };
  const hueSat = {
    id: 7, kind: "hueSaturation", name: "色相/饱和度 1",
    async duplicate(doc: any) {
      assert.equal(doc, target);
      fallbackCalls++;
      if (setup === "fallbackSucceeds" || setup === "mixedIsolated") makeCopy(this);
      return this; // some hosts return a stale proxy even if target copy exists
    },
  };
  const pixel = { id: 9, kind: "normal", name: "图片图层" };
  const source: any = {
    id: 64, mode: "RGB", name: "WavePlug_TEST_RGB.psd",
    layers: [hueSat, pixel],
    async duplicateLayers(layers: any[], doc: any) {
      assert.equal(doc, target);
      nativeCalls++;
      if ((setup === "partialBatch" || setup === "mixedIsolated") && layers.length === 2) {
        makeCopy(pixel); // an adjustment is skipped while a regular layer is copied
        return [...layers];
      }
      for (const layer of layers) if (layer.kind !== "hueSaturation") makeCopy(layer);
      return [...layers]; // valid-length array, but hue/saturation silently skipped
    },
  };
  const fakePS: any = {
    app: { documents: [source, target], activeDocument: target },
    constants: { ElementPlacement: { PLACEINSIDE: "inside" } },
    core: { async executeAsModal(fn: any) {
      return fn({ reportProgress() {}, hostControl: {
        async suspendHistory() { return "H-65"; },
        async resumeHistory(_state: string, commit: boolean) { historyCommits.push(commit); },
      } });
    } },
  };
  (globalThis as any).require = (name: string) => {
    if (name === "photoshop") return fakePS;
    throw new Error("unexpected module " + name);
  };
  try {
    const stage = (id: number, name: string, kind: string) =>
      ({ docId: 64, docKey: "RGB.psd", layerId: id, name, kind });
    const layers = (setup === "partialBatch" || setup === "mixedIsolated")
      ? [stage(7, hueSat.name, hueSat.kind), stage(9, pixel.name, pixel.kind)]
      : [stage(7, hueSat.name, hueSat.kind)];
    const result = await placeWorkbenchLayers(layers);
    return { result, target, nativeCalls, fallbackCalls, historyCommits };
  } finally {
    (globalThis as any).require = previousRequire;
  }
}

test("RGB → CMYK 色相/饱和度：批量复制零新增时尝试单层原生复制，核验成功后才建组", async () => {
  const r = await scenario("fallbackSucceeds");
  assert.equal(r.result.count, 1);
  assert.deepEqual(r.result.compatibility?.map(n => n.code), ["COLOR_MODE"]);
  assert.equal(r.fallbackCalls, 1);
  const group = r.target.layers.find((l: any) => l.id === r.result.groupId);
  assert.deepEqual(group.layers.map((l: any) => l.name), ["色相/饱和度 1"]);
  assert.deepEqual(r.historyCommits, [true]);
});

test("RGB → CMYK 调整层两种复制均零新增：报告具体图层和色彩模式，不虚报成功", async () => {
  await assert.rejects(scenario("fallbackNoop"), error => {
    assert.match(String((error as Error).message), /色相\/饱和度 1/);
    assert.match(String((error as Error).message), /RGB/);
    assert.match(String((error as Error).message), /CMYK/);
    return true;
  });
});

test("跨模式混合调整图层与像素图层：先拆开分别复制，避免调整层被批量操作略过", async () => {
  const r = await scenario("mixedIsolated");
  assert.equal(r.result.count, 2);
  assert.equal(r.fallbackCalls, 1);
  const group = r.target.layers.find((l: any) => l.id === r.result.groupId);
  assert.deepEqual(group.layers.map((l: any) => l.name).sort(), ["图片图层", "色相/饱和度 1"].sort());
});

test("同模式批量只复制部分图层时不得自动补复制，以免产生重复", async () => {
  await assert.rejects(scenario("partialBatch"), /部分|数量不符|预期/);
});
