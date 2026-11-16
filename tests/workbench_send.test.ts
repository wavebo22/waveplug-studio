import { test } from "node:test";
import assert from "node:assert/strict";
import { placeWorkbenchLayers } from "../src/ps/uxpWorkbench.ts";

/** 发送到 with a mocked UXP Photoshop DOM: the copy lands somewhere else in a wider target, is moved
 *  back to its place on the canvas (left edge kept, scaled by the width ratio), goes into the target's
 *  group with the same name, all in one history step of the TARGET, and the source stays active. */
async function send(opts: { scaleWithCanvas?: boolean; matchParents?: boolean; position?: "top" | "selection" } = {}) {
  const prevRequire = (globalThis as any).require;
  let next = 500;
  const history: { doc: number; commit: boolean }[] = [];
  const moves: { id: number; rel: number; place: string }[] = [];
  const scales: number[] = [];
  const mk = (id: number, name: string, kind: string, b: number[] | null, layers?: any[]) => ({
    id, name, kind, layers,
    boundsNoEffects: b ? { left: b[0], top: b[1], right: b[2], bottom: b[3] } : { left: 0, top: 0, right: 0, bottom: 0 },
  });
  const logo = mk(11, "Logo", "pixel", [20, 20, 120, 70]);
  const tint = mk(12, "色相/饱和度 1", "hueSaturation", null);
  const source: any = { id: 10, width: 1000, height: 1000, name: "src.psd",
    layers: [mk(9, "卡片", "group", [20, 20, 120, 70], [logo, tint])] };
  const card = mk(31, "卡片", "group", [0, 0, 10, 10], []);
  const other = mk(32, "背景", "pixel", [0, 0, 2000, 1000]);
  const target: any = { id: 20, width: 2000, height: 1000, name: "dst.psd", layers: [card, other], activeLayers: [other] };
  const findIn = (layers: any[], id: number): any => {
    for (const l of layers) { if (l.id === id) return l; const f = l.layers && findIn(l.layers, id); if (f) return f; }
    return null;
  };
  const detach = (layers: any[], l: any): boolean => {
    const i = layers.indexOf(l);
    if (i >= 0) { layers.splice(i, 1); return true; }
    return layers.some(x => x.layers && detach(x.layers, l));
  };
  const parentList = (layers: any[], rel: any): any[] | null => {
    if (layers.includes(rel)) return layers;
    for (const x of layers) { const f = x.layers && parentList(x.layers, rel); if (f) return f; }
    return null;
  };
  source.duplicateLayers = async (layers: any[], doc: any) => {
    assert.equal(doc, target);
    const copies = layers.map(l => {
      const b = l.boundsNoEffects, off = l.kind === "pixel" ? 300 : 0;
      const copy: any = {
        id: next++, name: l.name, kind: l.kind,
        boundsNoEffects: { left: b.left + off, top: b.top + off, right: b.right + off, bottom: b.bottom + off },
        async translate(dx: number, dy: number) { const r = this.boundsNoEffects; this.boundsNoEffects = { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy }; },
        async scale(pct: number) { scales.push(pct); const r = this.boundsNoEffects, cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2, w = (r.right - r.left) * pct / 200, h = (r.bottom - r.top) * pct / 200; this.boundsNoEffects = { left: cx - w, top: cy - h, right: cx + w, bottom: cy + h }; },
        async move(rel: any, place: string) {
          moves.push({ id: this.id, rel: rel.id, place });
          detach(target.layers, this);
          if (place === "inside") rel.layers.unshift(this);
          else { const list = parentList(target.layers, rel)!; list.splice(list.indexOf(rel) + (place === "after" ? 1 : 0), 0, this); }
        },
      };
      return copy;
    });
    target.layers.unshift(...copies);
    return copies;
  };
  const fakePS: any = {
    app: { documents: [source, target], activeDocument: source },
    constants: { ElementPlacement: { PLACEINSIDE: "inside", PLACEBEFORE: "before", PLACEAFTER: "after" }, AnchorPosition: { MIDDLECENTER: "mc" } },
    action: { async batchPlay(d: any[]) { return d.map(() => ({ artboardEnabled: false })); } },
    core: { async executeAsModal(fn: any) {
      return fn({ reportProgress() {}, hostControl: {
        async suspendHistory(o: any) { history.push({ doc: o.documentID, commit: false }); return "H"; },
        async resumeHistory(_s: string, commit: boolean) { history[history.length - 1].commit = commit; },
      } });
    } },
  };
  (globalThis as any).require = (name: string) => { if (name === "photoshop") return fakePS; throw new Error(name); };
  try {
    const result = await placeWorkbenchLayers([
      { docId: 10, docKey: "src.psd", layerId: 11, name: "Logo", kind: "pixel" },
      { docId: 10, docKey: "src.psd", layerId: 12, name: "色相/饱和度 1", kind: "hueSaturation" },
    ], { targetDocId: 20, wrapGroup: false, ...opts });
    return { result, target, card, history, moves, scales, findIn, fakePS, source };
  } finally { (globalThis as any).require = prevRequire; }
}

test("发送到：复制件回到画面上的位置（贴左边保持边距），放进目标里同名的组，一步历史，源文档保持激活", async () => {
  const { result, target, card, history, moves, findIn, fakePS, source } = await send();
  assert.equal(result.count, 2);
  assert.equal(result.groupId, null);
  assert.equal(result.placement, "matched");
  assert.equal(result.restored, 1); // the adjustment layer has no bounds: not moved
  const logo = findIn(target.layers, result.ids[0]);
  assert.deepEqual(logo.boundsNoEffects, { left: 40, top: 20, right: 140, bottom: 70 });
  assert.deepEqual(card.layers.map((l: any) => l.name), ["Logo", "色相/饱和度 1"]);
  assert.deepEqual(moves.map(m => m.place), ["inside", "after"]);
  assert.deepEqual(history, [{ doc: 20, commit: true }]);
  assert.equal(fakePS.app.activeDocument, source);
});

test("发送到：不放进同名组时置于选中图层上方；随画布缩放按较小比例", async () => {
  const { result, target, scales, findIn } = await send({ matchParents: false, position: "selection", scaleWithCanvas: true });
  assert.equal(result.placement, "above-selection");
  assert.equal(result.anchorName, "背景");
  assert.deepEqual(scales, []); // min(2000/1000, 1000/1000) = 1: nothing to scale
  assert.deepEqual(target.layers.map((l: any) => l.name), ["卡片", "Logo", "色相/饱和度 1", "背景"]);
  assert.deepEqual(findIn(target.layers, result.ids[0]).boundsNoEffects, { left: 40, top: 20, right: 140, bottom: 70 });
});

test("来源 PSD 已关闭：用快照置入为智能对象，恢复原像素大小和画面位置，放进工作台组", async () => {
  const prevRequire = (globalThis as any).require;
  let next = 700;
  const target: any = { id: 30, width: 1000, height: 500, name: "dst.psd", layers: [{ id: 1, name: "背景", kind: "pixel" }], activeLayers: [] };
  target.createLayerGroup = async (o: any) => { const g = { id: next++, name: o.name, kind: "group", layers: [] as any[] }; target.layers.unshift(g); return g; };
  const placedFiles: string[] = [];
  const fakePS: any = {
    app: { documents: [target], activeDocument: target },
    constants: { ElementPlacement: { PLACEINSIDE: "inside", PLACEBEFORE: "before", PLACEAFTER: "after" }, AnchorPosition: { MIDDLECENTER: "mc" } },
    action: { async batchPlay(d: any[]) {
      for (const x of d) if (x._obj === "placeEvent") {
        placedFiles.push(x.null._path);
        // Photoshop places at the canvas centre, at 72/300 of the size (another resolution)
        const layer: any = { id: next++, name: "wb_file", kind: "smartObject", boundsNoEffects: { left: 480, top: 240, right: 520, bottom: 260 },
          async scale(px: number, py: number) { const r = this.boundsNoEffects, cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2, w = (r.right - r.left) * px / 200, h = (r.bottom - r.top) * py / 200; this.boundsNoEffects = { left: cx - w, top: cy - h, right: cx + w, bottom: cy + h }; },
          async translate(dx: number, dy: number) { const r = this.boundsNoEffects; this.boundsNoEffects = { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy }; },
          async move(rel: any, place: string) { target.layers.splice(target.layers.indexOf(this), 1); assert.equal(place, "inside"); rel.layers.unshift(this); },
        };
        target.layers.unshift(layer);
        target.activeLayers = [layer];
      }
      return d.map(() => ({}));
    } },
    core: { async executeAsModal(fn: any) { return fn({ reportProgress() {}, hostControl: { async suspendHistory() { return "H"; }, async resumeHistory() {} } }); } },
  };
  const folder = { async getEntry(name: string) { return { name }; } };
  const fakeUxp = { storage: { localFileSystem: { async getDataFolder() { return { async getEntry() { return folder; } }; }, createSessionToken: (f: any) => "token:" + f.name } } };
  (globalThis as any).require = (name: string) => name === "photoshop" ? fakePS : name === "uxp" ? fakeUxp : (() => { throw new Error(name); })();
  try {
    const result = await placeWorkbenchLayers([{
      docId: 99, docKey: "D:/closed.psd", layerId: 4, name: "Logo", kind: "pixel", snap: "wb_abc_4.png",
      geom: { canvas: { width: 1000, height: 500 }, bounds: { left: 10, top: 20, right: 210, bottom: 120 } },
    }], { targetDocId: 30 });
    assert.equal(result.snapshots, 1);
    assert.equal(result.count, 1);
    assert.deepEqual(placedFiles, ["token:wb_abc_4.png"]);
    const group = target.layers.find((l: any) => l.id === result.groupId);
    const logo = group.layers[0];
    assert.equal(logo.name, "Logo");
    assert.deepEqual(logo.boundsNoEffects, { left: 10, top: 20, right: 210, bottom: 120 }); // same canvas: same pixels, same place
  } finally { (globalThis as any).require = prevRequire; }
});
