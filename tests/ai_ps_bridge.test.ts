// Photoshop's side of 牵手 Illustrator (src/app/illustratorBridge.ts) with stand-ins for Photoshop,
// the helper connection and localStorage.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };

const { attachIllustratorBridge, pushToIllustrator } = await import("../src/app/illustratorBridge.ts");

function setup() {
  store.clear();
  const sent: any[] = [], said: string[] = [], dropped: string[] = [], calls: string[] = [];
  let listener: ((m: unknown) => void) | null = null;
  const overlay: any = { sendBridge: (m: unknown) => sent.push(m), onBridge: (cb: any) => { listener = cb; return () => undefined; } };
  let fg = "#112233";
  const bridgePs: any = {
    inboxPath: async () => "C:\\Temp\\aibridge",
    activeDocInfo: () => ({ docId: 7, name: "海报.psd", ppi: 300, width: 100, height: 200 }),
    placeFromIllustrator: async (f: string, name: string, pixels: boolean, newDoc: boolean) => { calls.push(`place ${f} ${name} ${pixels} ${newDoc}`); return { docId: 7, layerId: 42, docName: "海报.psd" }; },
    replaceFromIllustrator: async (docId: number, docName: string, layerId: number, f: string) => { calls.push(`replace ${docId} ${docName} ${layerId} ${f}`); return { docId: 8 }; },
    dropInbox: async (f: string) => { dropped.push(f); },
    foregroundHex: () => fg,
    setForegroundHex: async (h: string) => { fg = h; },
    layerExists: () => true,
    revealLayer: async (docId: number, docName: string, layerId: number) => { calls.push(`reveal ${docId} ${docName} ${layerId}`); },
    writeTemp: async (name: string, text: string) => { calls.push(`svg ${name} ${text.length > 0}`); return { path: "C:\\Temp\\" + name, remove: async () => undefined }; },
  };
  const host: any = {
    activeLayers: () => [{ id: 1, name: "产品", kind: "pixel" }, { id: 2, name: "阴影", kind: "pixel" }, { id: 3, name: "标题", kind: "text" }],
    layerDragInfo: async (_d: number, id: number) => ({ rect: { left: 0, top: 0, right: 300, bottom: 60 }, res: 300, vector: id === 3 ? { kind: "text", layer: {}, res: 300, docW: 100, docH: 100 } : null }),
    exportLayerPng: async (_d: number, id: number) => ({ path: `C:\\Temp\\l${id}.png`, rect: { left: 10 * id, top: 5, right: 10 * id + 50, bottom: 45 }, remove: async () => undefined }),
  };
  attachIllustratorBridge(overlay, bridgePs, host, t => said.push(t));
  const ask = async (msg: object) => {
    listener!(msg);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    return sent.at(-1);
  };
  return { ask, sent, said, dropped, calls, overlay, bridgePs, host, fg: () => fg };
}

test("info：当前文档和放文件的文件夹", async () => {
  const { ask } = setup();
  const r = await ask({ kind: "info", reqId: "a" });
  assert.deepEqual(r, { kind: "result", reqId: "a", ok: true, value: { doc: { name: "海报.psd", ppi: 300, width: 100, height: 200 }, inbox: "C:\\Temp\\aibridge", links: [] } });
});

test("置入并记住关联，之后按关联更新；用过的文件都删掉", async () => {
  const { ask, calls, dropped, said } = setup();
  const r = await ask({ kind: "place", reqId: "p", fileName: "L1_2.ai", name: "Logo", pixels: false, link: "L1" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["place L1_2.ai Logo false false"]);
  assert.deepEqual(dropped, ["L1_2.ai"]);
  assert.match(said[0], /Logo/);
  const u = await ask({ kind: "update", reqId: "u", link: "L1", fileName: "L1_3.ai" });
  assert.equal(u.ok, true);
  assert.deepEqual(u.value, { name: "Logo", docName: "海报.psd" });
  assert.equal(calls[1], "replace 7 海报.psd 42 L1_3.ai");
  // the document id Photoshop reported back is kept for next time
  await ask({ kind: "update", reqId: "u2", link: "L1", fileName: "L1_4.ai" });
  assert.equal(calls[2], "replace 8 海报.psd 42 L1_4.ai");
  assert.deepEqual(dropped, ["L1_2.ai", "L1_3.ai", "L1_4.ai"]);
  const v = await ask({ kind: "reveal", reqId: "v", link: "L1" });
  assert.equal(v.ok, true);
  assert.equal(calls[3], "reveal 8 海报.psd 42");
});

test("像素图层不记关联；画板作为新文档", async () => {
  const { ask, calls } = setup();
  await ask({ kind: "place", reqId: "p", fileName: "L2_1.ai", name: "x", pixels: true, link: "L2" });
  const u = await ask({ kind: "update", reqId: "u", link: "L2", fileName: "L2_2.ai" });
  assert.equal(u.ok, false);
  assert.match(u.error, /没有和它关联/);
  await ask({ kind: "place", reqId: "b", fileName: "B_1.ai", name: "海报 A4", pixels: false, newDoc: true });
  assert.equal(calls.at(-1), "place B_1.ai 海报 A4 false true");
});

test("取回选中图层、颜色互通、坏请求不回答", async () => {
  const { ask, sent, fg } = setup();
  const p = await ask({ kind: "pull", reqId: "g" });
  assert.equal(p.value.docName, "海报.psd");
  assert.deepEqual(p.value.files.slice(0, 2), [
    { path: "C:\\Temp\\l1.png", name: "产品", left: 10, top: 5, width: 50, height: 40, how: "png" },
    { path: "C:\\Temp\\l2.png", name: "阴影", left: 20, top: 5, width: 50, height: 40, how: "png" },
  ]);
  // a text layer whose fragment can't be made (empty descriptor here) goes as PNG
  assert.equal(p.value.files[2].name, "标题");
  assert.deepEqual((await ask({ kind: "get-color", reqId: "c" })).value, { hex: "#112233" });
  await ask({ kind: "set-color", reqId: "s", hex: "#ABCDEF" });
  assert.equal(fg(), "#abcdef");
  const n = sent.length;
  await ask({ kind: "place", reqId: "x", fileName: "../evil.ai", name: "x" });
  assert.equal(sent.length, n, "an unsafe file name gets no answer at all");
});

test("Photoshop 主动发送到 Illustrator：图层导出成 PNG，带位置和分辨率", async () => {
  const { overlay, host, bridgePs, sent } = setup();
  const n = await pushToIllustrator(overlay, host, bridgePs, 7, [2]);
  assert.equal(n, 1);
  assert.deepEqual(sent.at(-1), { kind: "push", docName: "海报.psd", ppi: 300, files: [{ path: "C:\\Temp\\l2.png", name: "阴影", left: 20, top: 5, width: 50, height: 40, how: "png" }] });
});

test("从 Illustrator 来的图层：找到它的关联，请 Illustrator 更新 / 选中", async () => {
  const { linkOfLayer, askIllustrator } = await import("../src/app/illustratorBridge.ts");
  const { ask, overlay, sent } = setup();
  await ask({ kind: "place", reqId: "p", fileName: "L9_1.ai", name: "Logo", pixels: false, link: "L9" });
  assert.equal(linkOfLayer(7, 42), "L9");
  assert.equal(linkOfLayer(7, 43), null);
  askIllustrator(overlay, "update", "L9");
  assert.deepEqual(sent.at(-1), { kind: "update-request", link: "L9" });
  askIllustrator(overlay, "reveal", "L9");
  assert.deepEqual(sent.at(-1), { kind: "reveal-request", link: "L9" });
});

test("画板从 Illustrator 来：新文档，每个对象一个智能对象，关联都记住，文件都删掉", async () => {
  const { linkOfLayer } = await import("../src/app/illustratorBridge.ts");
  const { ask, bridgePs, dropped, said } = setup();
  let got: any = null;
  bridgePs.buildBoardFromIllustrator = async (req: any) => { got = req; return { docId: 9, docName: "海报 A4", placed: [{ link: "B1", layerId: 101, name: "Logo" }, { link: "B2", layerId: 102, name: "标题" }], failed: [] }; };
  const nodes = [
    { name: "内容", hidden: false, opacity: 100, blend: "NORMAL", children: [
      { name: "Logo", hidden: false, opacity: 80, blend: "MULTIPLY", fileName: "B1_1.ai", link: "B1", left: 40, top: 10, width: 220, height: 50 },
    ] },
    { name: "标题", hidden: true, opacity: 100, blend: "NORMAL", fileName: "B2_1.ai", link: "B2", left: 40, top: 500, width: 260, height: 80 },
  ];
  const r = await ask({ kind: "board", reqId: "b", name: "海报 A4", width: 600, height: 800, ppi: 300, nodes });
  assert.deepEqual(r.value, { docName: "海报 A4", placed: 2, failed: [] });
  assert.equal(got.ppi, 300);
  assert.equal(got.nodes[0].children[0].blend, "MULTIPLY");
  assert.equal(linkOfLayer(9, 101), "B1");
  assert.equal(linkOfLayer(9, 102), "B2");
  assert.deepEqual(dropped, ["B1_1.ai", "B2_1.ai"]);
  assert.match(said.at(-1)!, /2 个智能对象/);
  // a file name with a folder in it: no answer
  const n = (await ask({ kind: "info", reqId: "i" })) && 0;
  void n;
  const before = dropped.length;
  await ask({ kind: "board", reqId: "x", name: "x", width: 10, height: 10, ppi: 72, nodes: [{ name: "a", fileName: "..\\a.ai" }] });
  assert.equal(dropped.length, before);
});

test("当前画板置入 Illustrator：按内容转换，组结构和样式带过去，坐标相对画板", async () => {
  const { pushBoardToIllustrator } = await import("../src/app/illustratorBridge.ts");
  const { overlay, host, bridgePs, sent } = setup();
  bridgePs.exportSmartContents = async (_d: number, id: number, name: string) => ({ path: "C:\\Temp\\" + name, rect: { left: 1100, top: 120, right: 1300, bottom: 320 }, remove: async () => undefined });
  const L = (id: number, name: string, kind: string, parentId: number | null, extra: object = {}) => ({ id, name, kind, parentId, visible: true, opacity: 100, mode: "normal", width: 50, height: 40, clipped: false, artboard: false, ...extra });
  const layers: any[] = [
    L(10, "画板 1", "group", null, { artboard: true, board: { left: 1000, top: 100, right: 2000, bottom: 900 } }),
    L(11, "标题组", "group", 10, { opacity: 80 }),
    L(3, "标题", "text", 11),
    L(12, "Logo", "smartObject", 11, { smart: { file: "logo.ai" }, mode: "multiply" }),
    L(13, "调色", "adjustment", 10),
    L(2, "阴影", "pixel", 10, { visible: false, opacity: 50 }),
    L(20, "画板 2", "group", null, { artboard: true, board: { left: 0, top: 0, right: 900, bottom: 900 } }),
    L(21, "别的", "pixel", 20),
  ];
  const r = await pushBoardToIllustrator(overlay, host, bridgePs, 7, layers, [12]);
  assert.equal(r.name, "画板 1");
  assert.equal(r.count, 3);
  assert.match(r.notes[0], /调整图层/);
  const m = sent.at(-1);
  assert.equal(m.kind, "push");
  assert.deepEqual(m.board, { name: "画板 1", width: 1000, height: 800 });
  assert.deepEqual(m.groups, { "11": { name: "标题组", hidden: false, opacity: 80, blend: "NORMAL" } });
  assert.deepEqual(m.files.map((f: any) => [f.name, f.how, f.group]), [["标题", "png", ["11"]], ["Logo", "vector", ["11"]], ["阴影", "png", []]]);
  // the smart object's own file, placed against the artboard's corner, with its blend mode
  assert.deepEqual(m.files[1], { path: m.files[1].path, name: "Logo", left: 100, top: 20, width: 200, height: 200, how: "vector", group: ["11"], hidden: false, opacity: 100, blend: "MULTIPLY" });
  assert.match(m.files[1].path, /\.ai$/);
  assert.equal(m.files[2].hidden, true);
  assert.equal(m.files[2].opacity, 50);
});
