import { test } from "node:test";
import assert from "node:assert/strict";
import { UxpLayerTree } from "../src/ps/uxpLayers.ts";
import { UxpTools } from "../src/ps/uxpTools.ts";

test("真实 UxpLayerTree.editContents 先转换 PNG、读取新图层 ID 再打开；PSB 直接打开", async () => {
  const calls: string[] = [];
  const png = { id: 21, name: "PNG智能对象", file: "original.PNG" };
  const psb = { id: 22, name: "已有PSB智能对象", file: "art.psb" };
  const doc: any = { id: 1, layers: [png, psb], activeLayers: [psb] };
  const fakePs = {
    app: { activeDocument: doc, documents: [doc] },
    core: { executeAsModal: async (fn: (ctx: any) => Promise<any>) => fn({ hostControl: {} }) },
    action: {
      batchPlay: async (actions: any[]) => actions.map(d => {
        if (d._obj === "get" && d._target?.[0]?._property === "smartObject") {
          const id = d._target[1]._id;
          const layer = doc.layers.find((x: any) => x.id === id);
          return layer ? { smartObject: { fileReference: layer.file } } : { _obj: "error", message: "missing layer" };
        }
        if (d._obj === "select") {
          const id = d._target?.[0]?._id;
          const layer = doc.layers.find((x: any) => x.id === id);
          if (!layer) return { _obj: "error", message: "missing layer" };
          doc.activeLayers = [layer];
          calls.push("select:" + id);
          return {};
        }
        if (d._obj === "placedLayerEditContents") {
          calls.push("open:" + doc.activeLayers[0]?.id);
          return {};
        }
        throw new Error("unexpected action " + d._obj);
      }),
    },
  };
  const previousRequire = (globalThis as any).require;
  const previousMakeEditable = UxpTools.prototype.makeEditable;
  (globalThis as any).require = (name: string) => {
    assert.equal(name, "photoshop");
    return fakePs;
  };
  const tree = new UxpLayerTree();
  let succeed = true;
  UxpTools.prototype.makeEditable = async () => {
    calls.push("convert:" + doc.activeLayers[0]?.id);
    if (!succeed) return { done: 0, skipped: ["不支持转换"] };
    const fresh = { id: 83, name: png.name, file: "original.psb" };
    doc.layers.splice(doc.layers.indexOf(png), 1, fresh);
    doc.activeLayers = [fresh];
    return { done: 1, skipped: [] };
  };
  try {
    await tree.run(1, "editContents", [21]);
    assert.deepEqual(calls, ["select:21", "convert:21", "select:83", "open:83"]);
    calls.length = 0;
    await tree.run(1, "editContents", [22]);
    assert.deepEqual(calls, ["select:22", "open:22"]);

    const png2 = { id: 31, name: "损坏的 PNG", file: "broken.png" };
    doc.layers.push(png2);
    calls.length = 0;
    succeed = false;
    await assert.rejects(tree.run(1, "editContents", [31]), /PNG 转为可编辑 PSB 失败/);
    assert.deepEqual(calls, ["select:31", "convert:31"]);
  } finally {
    UxpTools.prototype.makeEditable = previousMakeEditable;
    (globalThis as any).require = previousRequire;
  }
});
