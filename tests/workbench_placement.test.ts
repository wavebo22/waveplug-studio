import { test } from "node:test";
import assert from "node:assert/strict";
import { placeWorkbenchLayers } from "../src/ps/uxpWorkbench.ts";

/** Integration test of the *real* WaveLayer placement function with a mocked UXP Photoshop DOM.
 *  Reproduces the exact observed message when document.groupLayers() returns null for a
 *  multi-layer payload. No real PSD is ever opened or modified. */
async function runCrossDocumentCase(proxyIds: "target" | "source", count = 2, maxBatch = Number.POSITIVE_INFINITY, partialFailure = false) {
  const prevRequire = (globalThis as any).require;
  const oldLog = console.log;
  let next = 100;
  const original: any[] = [
    { id: 17, name: "月季 A", kind: "group", layers: [{ id: 19, name: "variation" }] },
    { id: 18, name: "月季 B", kind: "group", layers: [{ id: 20, name: "variation" }] },
  ];
  for (let i = 2; i < count; i++) original.push({ id: 200 + i, name: "AI填充·月季 " + i, kind: "group", layers: [{ id: 400 + i, name: "v1" }] });
  const destination: any = {
    id: 90,
    name: "WavePlug_TEST_workbench_target.psd",
    layers: [{ id: 7, name: "Background", kind: "pixel" }, { id: 17, name: "Existing layer", kind: "pixel" }],
    activeLayers: [],
    async groupLayers(_layers: any[]) { return null; }, // host signal that caused screenshot error
    async createLayerGroup(opts: { name: string }) {
      const group = { id: next++, name: opts.name, kind: "group", layers: [] as any[] };
      destination.layers.unshift(group);
      return group;
    },
  };
  const source: any = {
    id: 89,
    name: "WavePlug_TEST_workbench_source.psd",
    layers: original,
    async duplicateLayers(layers: any[], target: any) {
      if (layers.length > maxBatch) {
        if (partialFailure) target.layers.unshift({ id: next++, name: layers[0].name + " (partial)", kind: "group", layers: [] });
        throw new TypeError("Cannot read properties of undefined (reading 'map')");
      }
      return layers.map(layer => {
        const copy = { id: next++, name: layer.name, kind: layer.kind, parent: null as any,
          layers: layer.layers ? [...layer.layers] : undefined,
          async move(group: any, place: string) {
            assert.equal(place, "placeInside");
            this.parent = group;
            target.layers.splice(target.layers.indexOf(this), 1);
            group.layers.unshift(this); // PLACEINSIDE inserts at top, matching Photoshop layer ordering
          },
        };
        target.layers.unshift(copy);
        // Photoshop UXP may return a Layer proxy still bound to the SOURCE document
        // even though its duplicate is physically present in the target document.
        // This reproduces the user-visible error from a cross-PSD workbench placement.
        return {
          id: proxyIds === "target" ? copy.id : layer.id, name: copy.name, kind: copy.kind,
          async move() { throw new Error("You can only move layers in the same document."); },
        };
      });
    },
  };
  const fakePS: any = {
    app: { documents: [source, destination], activeDocument: destination },
    constants: { ElementPlacement: { PLACEINSIDE: "placeInside" } },
    core: { async executeAsModal(fn: (ctx: any) => Promise<any>) {
      return fn({ reportProgress() {}, hostControl: {
        async suspendHistory() { return "history-90"; },
        async resumeHistory() {},
      } });
    } },
  };
  (globalThis as any).require = (name: string) => {
    if (name === "photoshop") return fakePS;
    throw new Error("unexpected UXP module: " + name);
  };
  try {
    const result = await placeWorkbenchLayers(original.map(layer => ({
      docId: 89, docKey: "WavePlug_TEST_source.psd", layerId: layer.id, name: layer.name, kind: "group",
    })));
    assert.equal(result.count, count);
    assert.equal(result.docId, 90);
    assert.ok(result.groupId > 0);
    const group = destination.layers.find((layer: any) => layer.id === result.groupId);
    assert.ok(group);
    assert.deepEqual(group.layers.map((layer: any) => layer.name).sort(), original.map(layer => layer.name).sort());
    assert.equal(original.length, count); // source PSD unchanged
    assert.ok(destination.layers.some((layer: any) => layer.id === 17 && layer.name === "Existing layer"));
  } finally {
    (globalThis as any).require = prevRequire;
    console.log = oldLog;
  }
}

test("跨 PSD 返回源文档代理时，使用目标图层重新绑定后放入文件夹",
  () => runCrossDocumentCase("target"));
test("跨 PSD 返回源图层 ID 且目标存在相同 ID 时，不移动目标已有图层",
  () => runCrossDocumentCase("source"));

test("27 个 AI 图层批量复制触发 undefined.map 时，安全拆批后全部放入新组",
  () => runCrossDocumentCase("source", 27, 4));

test("四图层复制也报 undefined.map 时，仅在零新增的情况下再拆成两个图层",
  () => runCrossDocumentCase("source", 9, 2));

test("Photoshop 报错前已产生部分复制内容时，中止并明确说明实际复制数量",
  async () => assert.rejects(runCrossDocumentCase("source", 9, 2, true), error => {
    assert.equal((error as any).code, "COPY_PARTIAL");
    assert.match(String((error as Error).message), /目标 PSD 已出现 1\/4 个副本/);
    assert.match(String((error as any).advice), /防止重复图层/);
    return true;
  }));
