import { test } from "node:test";
import assert from "node:assert/strict";
import { UxpHost, modal } from "../src/ps/uxpHost.ts";
import type { FillGroup } from "../src/ps/host.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("WaveLayer selection modals notify the generation panel; mask reads do not loop", async () => {
  const group = { id: 42, name: "AI填充 · 产品", kind: "group", layers: [] };
  const regular = { id: 7, name: "背景", kind: "pixel" };
  const doc = {
    id: 1, width: 256, height: 256, title: "test.psd", mode: "RGBColorMode",
    bitsPerChannel: "8", layers: [group, regular], activeLayers: [regular],
  };
  let listener: (() => void) | null = null;
  const fakePs = {
    app: { activeDocument: doc, documents: [doc] },
    core: { executeAsModal: async (fn: () => Promise<unknown>) => fn() },
    action: {
      addNotificationListener: (_events: string[], callback: () => void) => { listener = callback; },
      removeNotificationListener: () => { listener = null; },
      batchPlay: async (descriptors: any[]) => descriptors.map(d => {
        if (d._obj === "select") {
          const id = d._target?.[0]?._id;
          const layer = doc.layers.find(l => l.id === id);
          if (!layer) return { _obj: "error", message: "missing layer" };
          doc.activeLayers = [layer] as typeof doc.activeLayers;
        }
        return {};
      }),
    },
  };
  const previous = (globalThis as any).require;
  (globalThis as any).require = (name: string) => {
    assert.equal(name, "photoshop");
    return fakePs;
  };
  const host = new UxpHost();
  let refreshed = 0;
  try {
    host.onChange(() => refreshed++);

    // The WaveLayer panel selects layers via an internal UXP modal, which does not
    // necessarily generate Photoshop's native "select" notification.
    await modal("WavePlug 选择图层", async () => { doc.activeLayers = [group]; });
    await sleep(650);
    assert.equal(refreshed, 1);

    // A group-info refresh uses read-only modals: they must not recursively refresh.
    await modal("WavePlug 读取填充范围", async () => {});
    await modal("WavePlug 缩略图", async () => {});
    await sleep(650);
    assert.equal(refreshed, 1);

    // A finished job should select the group that WaveLayer represents as the AI layer.
    doc.activeLayers = [regular];
    const target: FillGroup = {
      kind: "inpaint", docId: doc.id, layerId: group.id, name: "产品",
      rect: { left: 5, top: 6, right: 25, bottom: 26 },
    };
    await host.selectFillGroup(target);
    assert.equal(doc.activeLayers[0].id, group.id);
    await sleep(650);
    assert.equal(refreshed, 2);

    // Deleting/switching a variation in WaveLayer also updates the generator panel.
    await modal("WavePlug 切换变体", async () => {});
    await sleep(650);
    assert.equal(refreshed, 3);

    // Do not regress the native Photoshop Layers-panel notifications.
    assert.ok(listener);
    (listener as () => void)();
    await sleep(650);
    assert.equal(refreshed, 4);

    // Do not hijack a different document if the user switched away during generation.
    const other = { ...doc, id: 2, activeLayers: [regular] };
    (fakePs.app as any).activeDocument = other;
    await host.selectFillGroup(target);
    assert.equal(other.activeLayers[0].id, regular.id);

    // Development reload must not leave our extra modal listener behind.
    host.dispose();
    await modal("WavePlug 选择图层", async () => {});
    await sleep(650);
    assert.equal(refreshed, 4);
  } finally {
    host.dispose();
    (globalThis as any).require = previous;
  }
});
