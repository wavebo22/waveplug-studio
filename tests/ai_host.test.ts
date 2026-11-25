// The Illustrator host script (ai/host/wavelayer.jsx) run against the model of Illustrator's
// object model in src/ai/fake.ts, and checked for syntax ExtendScript (ES3) doesn't have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { FakeItem, FakeLayer, app, demoDocument, loadHost, openDocuments, written } from "../src/ai/fake.ts";

const SOURCE = readFileSync(new URL("../ai/host/wavelayer.jsx", import.meta.url), "utf8");

function host() {
  const doc = demoDocument();
  openDocuments(doc);
  const wl = loadHost(SOURCE);
  const call = (op: string, args: unknown = {}) => {
    const r = JSON.parse(wl.call(op, args));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const fail = (op: string, args: unknown = {}) => {
    const r = JSON.parse(wl.call(op, args));
    assert.equal(r.ok, false, `${op} should fail`);
    return r.error as string;
  };
  return { doc, wl, call, fail };
}
const labels = (nodes: any[]) => nodes.map(n => n.label);

test("ExtendScript 语法：没有 ES5 以后的写法和 ExtendScript 没有的函数", () => {
  // esbuild refuses let / const / arrows / classes / templates when asked for ES5
  transformSync(SOURCE, { loader: "js", target: "es5" });
  const code = SOURCE.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, "\"\"");
  for (const bad of [/\.forEach\(/, /\.map\(/, /\.filter\(/, /\.reduce\(/, /\bJSON\./, /Object\.keys/, /\.trim\(\)/, /Array\.isArray/, /Date\.now/, /,\s*[}\]]/, /\.(delete|default|class|new)\b/])
    assert.equal(bad.test(code), false, `wavelayer.jsx uses ${bad}`);
});

test("树：图层、子图层和对象按前后顺序，名字照 Illustrator 的叫法", () => {
  const { call } = host();
  const t = call("tree", { open: ["l0", "l0/i0", "l0/l0", "l0/l0/i0"] });
  assert.equal(t.doc.name, "海报.ai");
  assert.deepEqual(t.doc.artboards, ["海报 A4", "横幅"]);
  assert.deepEqual(labels(t.layers), ["内容", "装饰", "背景", "备注", "空图层"]);
  const content = t.layers[0];
  assert.deepEqual(labels(content.children), ["Logo", "产品", "限时 8 折 全场包邮", "<文字>", "空编组"]);
  assert.equal(content.children[1].key, "l0/l0");
  assert.equal(content.children[0].key, "l0/i0");
  assert.deepEqual(labels(content.children[0].children), ["WAVE PLUG", "<路径>", "<复合路径>"]);
  assert.equal(content.children[0].children[1].fill, "#3fb59f");
  const clip = content.children[1].children[0];
  assert.equal(clip.kind, "clip");
  assert.equal(clip.label, "<剪切组>");
  assert.equal(clip.count, 2);
  // not open: counted, not listed
  assert.equal(t.layers[1].children, undefined);
  assert.equal(t.layers[1].count, 3);
  assert.equal(t.layers[3].hidden, true);
  assert.equal(t.layers[3].locked, true);
  assert.equal(t.layers[0].color, "#4f80ff");
});

test("选择：点对象选中它，点图层只设为当前图层", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l1/i0" }] });
  assert.equal(doc.selection.length, 1);
  assert.equal(doc.selection[0].name, "星星 1");
  call("select", { targets: [{ key: "l1/i2" }], add: true });
  assert.equal(doc.selection.length, 2);
  // a hidden item can't be selected: counted as failed
  const r = call("select", { targets: [{ key: "l1/i1" }] });
  assert.equal(r.failed, 1);
  call("select", { targets: [{ key: "l2" }] });
  assert.equal(doc.activeLayer.name, "背景");
  const t = call("tree", { open: ["l1"] });
  assert.equal(t.active, "l2");
});

test("定位选择：选中的对象和要展开的上级", () => {
  const { call, doc } = host();
  (doc.layers[0] as FakeLayer).pageItems[0].pageItems[1].selected = true;
  const r = call("reveal");
  assert.deepEqual(r.keys, ["l0/i0/i1"]);
  assert.deepEqual(r.open, ["l0/i0", "l0"]);
});

test("显示 / 锁定，Alt 只显示这一个，再按一次全部恢复", () => {
  const { call, doc } = host();
  call("setProp", { targets: [{ key: "l1/i0" }], prop: "hidden", value: true });
  assert.equal((doc.layers[1] as FakeLayer).pageItems[0].hidden, true);
  call("setProp", { targets: [{ key: "l2" }], prop: "locked", value: true });
  assert.equal((doc.layers[2] as FakeLayer).locked, true);
  call("setProp", { targets: [{ key: "l3" }], prop: "hidden", value: false });
  call("others", { target: { key: "l0" }, prop: "hidden" });
  assert.deepEqual((doc.layers as FakeLayer[]).map(l => l.visible), [true, false, false, false, false]);
  const again = call("others", { target: { key: "l0" }, prop: "hidden" });
  assert.equal(again.restored, true);
  assert.deepEqual((doc.layers as FakeLayer[]).map(l => l.visible), [true, true, true, true, true]);
});

test("改名、删除；文档变化后用旧的键会被拒绝", () => {
  const { call, fail, doc } = host();
  call("rename", { items: [{ key: "l4", name: "草稿" }, { key: "l0/i0", expect: { kind: "group", label: "Logo" }, name: "标志" }] });
  assert.equal((doc.layers[4] as FakeLayer).name, "草稿");
  assert.match(fail("rename", { items: [{ key: "l0/i0", expect: { kind: "group", label: "Logo" }, name: "x" }] }), /已变化/);
  call("remove", { targets: [{ key: "l1/i0" }, { key: "l1/i2" }, { key: "l1" }] });
  assert.deepEqual((doc.layers as FakeLayer[]).map(l => l.name), ["内容", "背景", "备注", "草稿"]);
});

test("最后一个图层不能删", () => {
  const { call, fail } = host();
  call("remove", { targets: [{ key: "l1" }, { key: "l2" }, { key: "l3" }, { key: "l4" }] });
  assert.match(fail("remove", { targets: [{ key: "l0" }] }), /至少/);
});

test("拖动：排在前 / 后、放进编组、放到图层边上就进图层、图层进图层", () => {
  const { call, fail, doc } = host();
  const names = (l: any) => l.kids.map((k: any) => k.name || k.typename);
  // 星星 2 and 光斑 above 星星 1, in that order
  call("move", { targets: [{ key: "l1/i1" }, { key: "l1/i2" }], dest: { key: "l1/i0" }, where: "before" });
  assert.deepEqual(names(doc.layers[1]), ["星星 2", "SymbolItem", "星星 1"]);
  // into the Logo group, at its top
  call("move", { targets: [{ key: "l1/i2" }], dest: { key: "l0/i0" }, where: "inside" });
  assert.equal((doc.layers[0] as FakeLayer).pageItems[0].pageItems[0].name, "星星 1");
  // an item dropped before a layer row lands inside that layer, at the top
  call("move", { targets: [{ key: "l1/i0" }], dest: { key: "l2" }, where: "before" });
  assert.equal((doc.layers[2] as FakeLayer).pageItems[0].name, "星星 2");
  // and after a layer row: at its bottom
  call("move", { targets: [{ key: "l1/i0" }], dest: { key: "l2" }, where: "after" });
  assert.equal((doc.layers[2] as FakeLayer).kids.at(-1)!.typename, "SymbolItem");
  // a layer into another layer
  call("move", { targets: [{ key: "l4" }], dest: { key: "l0" }, where: "inside" });
  assert.equal((doc.layers[0] as FakeLayer).kids[0].name, "空图层");
  // a layer can't go into a group, nor into itself
  assert.match(fail("move", { targets: [{ key: "l1" }], dest: { key: "l0/i1" }, where: "inside" }), /图层/);
  assert.match(fail("move", { targets: [{ key: "l0" }], dest: { key: "l0/i1" }, where: "inside" }), /自己/);
});

test("Alt 拖动复制，原来的留着", () => {
  const { call, doc } = host();
  call("move", { targets: [{ key: "l1/i0" }], dest: { key: "l2/i0" }, where: "after", copy: true });
  assert.equal((doc.layers[1] as FakeLayer).pageItems.length, 3);
  assert.deepEqual((doc.layers[2] as FakeLayer).pageItems.map(i => i.name), ["底色", "星星 1", "渐变光"]);
  // a whole layer, with what is in it
  call("move", { targets: [{ key: "l1" }], dest: { key: "l0" }, where: "before", copy: true });
  assert.deepEqual((doc.layers as FakeLayer[]).map(l => l.name).slice(0, 3), ["装饰", "内容", "装饰"]);
  assert.equal((doc.layers[0] as FakeLayer).pageItems.length, 3);
});

test("复制、新建图层 / 子图层、收集到新图层", () => {
  const { call, doc } = host();
  call("duplicate", { targets: [{ key: "l1/i0" }] });
  assert.deepEqual((doc.layers[1] as FakeLayer).pageItems.map(i => i.name), ["星星 1", "星星 1", "星星 2", ""]);
  call("newLayer", { target: { key: "l2" } });
  assert.equal((doc.layers[2] as FakeLayer).name, "图层 6");
  call("newLayer", { target: { key: "l0" }, sub: true, name: "子层" });
  assert.equal((doc.layers[0] as FakeLayer).kids[0].name, "子层");
  assert.equal(doc.activeLayer.name, "子层");
  const r = call("collect", { targets: [{ key: "l1/i2" }, { key: "l1/i1" }], name: "收集" });
  assert.equal(r.moved, 2);
  assert.equal((doc.layers[1] as FakeLayer).name, "收集");
  assert.deepEqual((doc.layers[1] as FakeLayer).pageItems.map(i => i.name), ["星星 2", "星星 1"]);
});

test("编组 / 取消编组走 Illustrator 的菜单命令", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l1/i0" }, { key: "l1/i1" }] });
  // 星星 2 is hidden: only 星星 1 got selected
  call("select", { targets: [{ key: "l1/i0" }, { key: "l1/i2" }] });
  call("menu", { cmd: "group" });
  assert.equal(app.menuLog.at(-1), "group");
  assert.equal((doc.layers[1] as FakeLayer).pageItems[0].typename, "GroupItem");
  assert.match(JSON.parse(loadHost(SOURCE).call("menu", { cmd: "rm -rf" })).error, /unknown/);
});

test("面板有键盘时，复制粘贴快捷键交给 Illustrator 自己的编辑菜单", () => {
  const { call } = host();
  for (const [cmd, id] of [["copy", "copy"], ["cut", "cut"], ["paste", "paste"], ["pasteFront", "pasteFront"], ["pasteBack", "pasteBack"], ["pasteInPlace", "pasteInPlace"], ["pasteAllArtboards", "pasteInAllArtboard"]]) {
    call("menu", { cmd });
    assert.equal(app.menuLog.at(-1), id);
  }
});

test("搜索：按名字、类型和状态，带上路径", () => {
  const { call } = host();
  const r = call("search", { text: "星" });
  assert.deepEqual(r.results.map((n: any) => n.label), ["星星 1", "星星 2"]);
  assert.equal(r.results[0].trail, "装饰");
  assert.equal(r.results[0].key, "l1/i0");
  assert.deepEqual(call("search", { kinds: ["text"] }).results.map((n: any) => n.label), ["WAVE PLUG", "限时 8 折 全场包邮", "<文字>", "不要印刷这一层"]);
  assert.deepEqual(call("search", { flags: ["hidden"] }).results.map((n: any) => n.label), ["星星 2", "备注"]);
  assert.deepEqual(call("search", { flags: ["empty"] }).results.map((n: any) => n.label), ["空编组", "空图层"]);
  assert.equal(call("search", { text: "WAVE" }).results[0].trail, "内容 › Logo");
});

test("整理：空图层、空编组、空文字；锁定的不动", () => {
  const { call, doc } = host();
  const r = call("cleanup", { what: ["emptyLayers", "emptyGroups", "emptyText"] });
  assert.deepEqual(r, { emptyLayers: 1, emptyGroups: 1, emptyText: 1 });
  assert.deepEqual((doc.layers as FakeLayer[]).map(l => l.name), ["内容", "装饰", "背景", "备注"]);
  assert.deepEqual((doc.layers[0] as FakeLayer).kids.map(k => k.name || k.typename), ["Logo", "产品", "TextFrame"]);
});

test("画板：切换并适合窗口", () => {
  const { call, doc } = host();
  call("artboard", { index: 1, fit: true });
  assert.equal(doc.board, 1);
  assert.equal(app.menuLog.at(-1), "fitin");
});

test("发送到 Photoshop：选中的对象复制到新文档存成 .ai，原文档不变并记下关联", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l0/i0" }] });
  const r = call("exportItems", { format: "ai" });
  assert.match(r.file, /WavePlugBridge\/L[\d_]+\.ai$/);
  assert.equal(r.name, "Logo");
  assert.equal(r.count, 1);
  assert.equal(r.widthPt, 220);
  assert.equal(app.activeDocument, doc);
  assert.equal(app.documents.length, 1, "the export document is closed");
  assert.ok(written.has(r.file));
  // linked: found again, and sent again under the same link
  const logo = (doc.layers[0] as FakeLayer).pageItems[0];
  assert.equal(logo.note, "wavelink:" + r.link);
  assert.deepEqual(call("linksInSelection").links, [r.link]);
  const again = call("exportItems", { format: "png", link: r.link, scale: 300 });
  assert.equal(again.link, r.link);
  assert.match(again.file, /\.png$/);
  doc.selection = null;
  assert.equal(call("selectLink", { link: r.link }).selected, 1);
  // a note the user wrote stays
  logo.note = "客户确认版";
  call("exportItems", { format: "ai" });
  assert.match(logo.note, /^客户确认版\nwavelink:L/);
});

test("从 Photoshop 置入：PNG 按像素位置放到当前画板，嵌入并命名", () => {
  const { call, doc } = host();
  written.add("C:\\tmp\\a.png");
  const r = call("placeFiles", { ppi: 144, layerName: "来自 Photoshop · 海报.psd", files: [
    { path: "C:\\tmp\\a.png", name: "产品", left: 100, top: 50, width: 200, height: 100 },
    { path: "C:\\tmp\\gone.png", name: "丢失" },
  ] });
  assert.deepEqual(r, { placed: 1, missing: 1, artboard: null });
  const layer = doc.layers[0] as FakeLayer;
  assert.equal(layer.name, "来自 Photoshop · 海报.psd");
  const img = layer.pageItems[0];
  assert.equal(img.typename, "RasterItem");
  assert.equal(img.name, "产品");
  // 144 ppi: 1 px = 0.5 pt, from the artboard's top-left (0, 800)
  assert.deepEqual(img.visibleBounds, [50, 775, 150, 725]);
});

test("颜色：读选中对象的填色，改成别的颜色", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l1/i0" }] });
  assert.equal(call("fillHex").hex, "#ffd76a");
  call("setFill", { hex: "#102030" });
  assert.equal(call("fillHex").hex, "#102030");
  assert.equal((doc.layers[1] as FakeLayer).pageItems[0].fillColor.red, 16);
});

test("没有文档时不报错", () => {
  openDocuments();
  const wl = loadHost(SOURCE);
  assert.equal(JSON.parse(wl.call("sig")).value, "none");
  assert.equal(JSON.parse(wl.call("tree")).value.doc, null);
  assert.match(JSON.parse(wl.call("search", { text: "x" })).error, /没有打开的文档/);
});

test("JSON：特殊字符和换行", () => {
  const { wl } = host();
  const s = (wl as any).json({ a: "引号\"\\\n\u2028", b: [1, null, true], c: undefined, d: NaN });
  assert.deepEqual(JSON.parse(s), { a: "引号\"\\\n\u2028", b: [1, null, true], d: null });
  void FakeItem;
});

test("图层选项：颜色、打印、预览（轮廓）", () => {
  const { call, doc } = host();
  call("layerOptions", { targets: [{ key: "l0" }, { key: "l0/i0" }], color: "#102030", printable: false, preview: false });
  const l = doc.layers[0] as FakeLayer;
  assert.equal(l.color.green, 32);
  assert.equal(l.printable, false);
  assert.equal(l.preview, false);
  const t = call("tree", {});
  assert.equal(t.layers[0].printable, false);
  assert.equal(t.layers[0].color, "#102030");
});

test("外观：不透明度和混合模式", () => {
  const { call, doc, fail } = host();
  assert.deepEqual(call("appearance", { target: { key: "l1/i0" } }), { opacity: 100, blend: "NORMAL" });
  call("setAppearance", { targets: [{ key: "l1/i0" }, { key: "l2" }], opacity: 40, blend: "MULTIPLY" });
  assert.deepEqual(call("appearance", { target: { key: "l1/i0" } }), { opacity: 40, blend: "MULTIPLY" });
  assert.equal((doc.layers[2] as FakeLayer).opacity, 40);
  assert.match(fail("setAppearance", { targets: [{ key: "l1/i0" }], blend: "PLUS" }), /unknown blend/);
});

test("释放到图层：每个对象一个子图层，顺序不变", () => {
  const { call, doc } = host();
  const r = call("releaseToLayers", { target: { key: "l1" } });
  assert.equal(r.made, 3);
  const deco = doc.layers[1] as FakeLayer;
  assert.deepEqual(deco.layers.map(l => l.name), ["星星 1", "星星 2", "光斑"]);
  assert.deepEqual(deco.layers.map(l => (l as FakeLayer).pageItems.length), [1, 1, 1]);
  assert.equal(deco.pageItems.length, 0);
});

test("合并图层：其余图层的内容移到第一个后面，其余删除", () => {
  const { call, doc, fail } = host();
  const r = call("mergeLayers", { targets: [{ key: "l1" }, { key: "l2" }] });
  assert.deepEqual(r, { moved: 2, removed: 1 });
  assert.deepEqual((doc.layers as FakeLayer[]).map(l => l.name), ["内容", "装饰", "备注", "空图层"]);
  assert.deepEqual((doc.layers[1] as FakeLayer).pageItems.map(i => i.name), ["星星 1", "星星 2", "", "底色", "渐变光"]);
  assert.match(fail("mergeLayers", { targets: [{ key: "l0" }, { key: "l0/i0" }] }), /只能合并图层/);
});

test("文档检查：各种问题和对应的对象", () => {
  const { call } = host();
  const r = call("report");
  const by = Object.fromEntries(r.issues.map((x: any) => [x.id, x]));
  assert.equal(by.stray.count, 1);
  assert.deepEqual(by.stray.keys, ["l3/i1"]);
  assert.equal(by.emptyText.count, 1);
  assert.equal(by.emptyGroup.count, 1);
  assert.equal(by.emptyLayer.count, 1);
  assert.equal(by.hidden.count, 1);
  assert.equal(by.linked.count, 1);
  assert.equal(by.missing.count, 0);
  assert.equal(r.counts.text, 4);
  assert.equal(r.counts.layer, 6);
});

test("画板发到 Photoshop：画板上的对象，页面就是画板", () => {
  const { call, doc } = host();
  const r = call("exportItems", { format: "ai", artboard: 0 });
  assert.equal(r.name, "海报 A4");
  assert.equal(r.widthPt, 600, "the artboard, not the items' bounds");
  assert.equal(r.heightPt, 800);
  assert.equal(doc.selection.length, 0, "the selection made for the export is dropped");
  assert.equal((doc.layers[0] as FakeLayer).pageItems[0].note, "", "no link for an artboard");
});

test("文档里所有发到 Photoshop 的关联", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l0/i0" }] });
  const a = call("exportItems", { format: "ai" });
  call("select", { targets: [{ key: "l1/i0" }] });
  const b = call("exportItems", { format: "ai" });
  doc.selection = null;
  assert.deepEqual(call("allLinks").links, [{ link: a.link, label: "Logo" }, { link: b.link, label: "星星 1" }]);
});

test("自动同步的指纹：关联对象改了才变", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l0/i0" }] });
  const { link } = call("exportItems", { format: "ai" });
  const a = call("linkSignatures", { rescan: true }).sigs[link];
  assert.ok(a);
  assert.equal(call("linkSignatures").sigs[link], a, "same when nothing changed");
  const logo = (doc.layers[0] as FakeLayer).pageItems[0];
  logo.pageItems[0].contents = "WAVE PLUG 2";
  const b = call("linkSignatures").sigs[link];
  assert.notEqual(b, a);
  logo.pageItems[1].bounds = [41, 790, 90, 740];
  assert.notEqual(call("linkSignatures").sigs[link], b);
  // something not linked changing: no difference
  const c = call("linkSignatures").sigs[link];
  (doc.layers[1] as FakeLayer).pageItems[0].hidden = true;
  assert.equal(call("linkSignatures").sigs[link], c);
});

test("按画板位置发送：页面是画板，只带选中的", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l1/i0" }] });
  const r = call("exportItems", { format: "ai", pageArtboard: 0, name: "装饰" });
  assert.equal(r.widthPt, 600);
  assert.equal(r.heightPt, 800);
  assert.equal(r.name, "装饰");
  assert.equal(r.count, 1);
  assert.ok((doc.layers[1] as FakeLayer).pageItems[0].note.startsWith("wavelink:"), "linked: it can be updated");
});

test("按画板位置发送的关联，更新时还用画板做页面", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l1/i0" }] });
  const r = call("exportItems", { format: "ai", pageArtboard: 1 });
  const star = (doc.layers[1] as FakeLayer).pageItems[0];
  assert.equal(star.note, "wavelink:" + r.link + ";page=1");
  const again = call("exportItems", { format: "ai", link: r.link });
  assert.equal(again.widthPt, 1200, "the 横幅 artboard");
  assert.deepEqual(call("linksInSelection").links, [r.link]);
  // sent again plainly: the page goes
  call("exportItems", { format: "ai" });
  assert.match(star.note, /^wavelink:L[\d_]+$/);
});

test("画板：列表、改名、按选中新建、缩放、删除（至少留一个）", () => {
  const { call, doc, fail } = host();
  assert.deepEqual(call("artboards"), { boards: [{ name: "海报 A4", width: 600, height: 800 }, { name: "横幅", width: 1200, height: 400 }], active: 0 });
  call("boardOp", { op: "rename", index: 1, name: "Banner" });
  assert.equal(doc.artboardList[1].name, "Banner");
  assert.match(fail("boardOp", { op: "add" }), /先选中/);
  call("select", { targets: [{ key: "l1/i0" }] });
  assert.deepEqual(call("boardOp", { op: "add", name: "星星" }), { index: 2 });
  assert.equal(doc.artboardList[2].name, "星星");
  assert.deepEqual(doc.artboardList[2].artboardRect, [480, 760, 500, 740]);
  call("boardOp", { op: "fit", index: 0 });
  assert.deepEqual(doc.artboardList[0].artboardRect, [480, 760, 500, 740]);
  call("boardOp", { op: "remove", index: 2 });
  call("boardOp", { op: "remove", index: 1 });
  assert.match(fail("boardOp", { op: "remove", index: 0 }), /至少/);
});

test("文档：列出打开的文档并切换", async () => {
  const { FakeDocument } = await import("../src/ai/fake.ts");
  const a = demoDocument(), b = new FakeDocument("名片.ai", [new FakeLayer("图层 1")], "D:\\名片.ai");
  openDocuments(a, b);
  const wl = loadHost(SOURCE);
  const call = (op: string, args: unknown = {}) => JSON.parse(wl.call(op, args)).value;
  assert.deepEqual(call("documents"), { docs: ["海报.ai", "名片.ai"], active: 0 });
  call("activateDocument", { index: 1 });
  assert.equal(app.activeDocument, b);
  assert.equal(call("tree").doc.name, "名片.ai");
});

test("按尺寸新建画板：放在最右边画板的右侧", () => {
  const { call, doc } = host();
  call("boardOp", { op: "addSize", width: 595.3, height: 841.9, name: "海报" });
  const b = doc.artboardList[2];
  assert.equal(b.name, "海报");
  assert.deepEqual(b.artboardRect.map(v => Math.round(v * 10) / 10), [1940, 800, 2535.3, -41.9]);
  assert.equal(doc.board, 2);
});

test("撤销 / 重做交给 Illustrator", () => {
  const { call } = host();
  call("undo");
  call("redo");
  assert.deepEqual(app.menuLog.slice(-2), ["undo", "redo"]);
});

test("链接图像：文件不在（读 file 会出错）算缺失", () => {
  const { call, doc } = host();
  const placed = (doc.layers[0] as FakeLayer).kids[1] as any; // 产品 sublayer
  const img = placed.kids[0].kids[1];
  Object.defineProperty(img, "file", { get() { throw new Error("file not found"); } });
  const t = call("tree", { open: ["l0", "l0/l0", "l0/l0/i0"] });
  const node = t.layers[0].children[1].children[0].children[1];
  assert.equal(node.kind, "placed");
  assert.equal(node.missing, true);
  assert.equal(node.label, "<链接文件>");
  assert.equal(call("report").issues.find((x: any) => x.id === "missing").count, 1);
});

test("从 Photoshop 来的 SVG（文字 / 形状图层）：导入成可编辑的编组，放到原位置", () => {
  const { call, doc } = host();
  written.add("C:\\tmp\\title.svg");
  const r = call("placeFiles", { ppi: 72, files: [{ path: "C:\\tmp\\title.svg", name: "标题", left: 30, top: 40, width: 100, height: 50 }] });
  assert.deepEqual(r, { placed: 1, missing: 0, artboard: null });
  const g = (doc.layers[0] as FakeLayer).pageItems[0];
  assert.equal(g.typename, "GroupItem");
  assert.equal(g.name, "标题");
  assert.deepEqual(g.visibleBounds, [30, 760, 130, 710]);
});

test("色板：按颜色新建", () => {
  const { call, doc } = host();
  assert.deepEqual(call("addSwatch", { hex: "#e05a3c", name: "PS #E05A3C" }), { name: "PS #E05A3C" });
  assert.equal(doc.swatchList[0].color.red, 224);
  assert.equal(call("addSwatch", { hex: "#000000" }).name, "#000000");
});

test("自动同步：关联对象缓存起来，删掉后重新扫描", () => {
  const { call, doc } = host();
  call("select", { targets: [{ key: "l1/i0" }] });
  const one = call("exportItems", { format: "ai" }).link;
  assert.deepEqual(Object.keys(call("linkSignatures", { rescan: true }).sigs), [one]);
  // linked later: not seen until a rescan
  call("select", { targets: [{ key: "l1/i2" }] });
  const two = call("exportItems", { format: "ai" }).link;
  assert.deepEqual(Object.keys(call("linkSignatures").sigs), [one]);
  assert.deepEqual(Object.keys(call("linkSignatures", { rescan: true }).sigs).sort(), [one, two].sort());
  (doc.layers[1] as FakeLayer).pageItems[0].note = "";
  assert.deepEqual(Object.keys(call("linkSignatures").sigs), [two], "an unlinked item drops out");
});

test("一次读取的节点有上限：超出的容器显示还有几项", async () => {
  const { FakeDocument } = await import("../src/ai/fake.ts");
  const many = Array.from({ length: 9 }, (_, i) => new FakeLayer("层 " + i, Array.from({ length: 400 }, (_, j) => new FakeItem("PathItem", { name: `p${i}-${j}` }))));
  openDocuments(new FakeDocument("大.ai", many));
  const wl = loadHost(SOURCE);
  const t = JSON.parse(wl.call("tree", { open: many.map((_, i) => "l" + i) })).value;
  const listed = t.layers.reduce((s: number, l: any) => s + (l.children?.length ?? 0), 0);
  assert.ok(listed <= 3000, String(listed));
  assert.ok(listed > 2900);
  const last = t.layers[8];
  assert.equal(last.children.length + last.more, 400);
});

test("导出图层：每个图层一个文件，重名加序号，空图层跳过，取消不做事", async () => {
  const { FakeFolder } = await import("../src/ai/fake.ts");
  const { call, doc } = host();
  (doc.layers[2] as FakeLayer).name = "装饰";
  const r = call("exportLayers", { targets: [{ key: "l1" }, { key: "l2" }, { key: "l4" }], format: "png", scale: 200 });
  assert.equal(r.folder, "/out");
  assert.deepEqual(r.files, ["/out/装饰.png", "/out/装饰 (2).png"]);
  assert.deepEqual(r.skipped, ["空图层"]);
  assert.equal(app.documents.length, 1, "export documents closed");
  assert.equal(doc.selection.length, 0);
  const svg = call("exportLayers", { targets: [{ key: "l0" }], format: "svg", folder: "/svg" });
  assert.deepEqual(svg.files, ["/svg/内容.svg"]);
  FakeFolder.picked = null;
  assert.deepEqual(call("exportLayers", { targets: [{ key: "l1" }], format: "png" }), { cancelled: true });
  FakeFolder.picked = "/out";
});

test("画板计划：图层 / 子图层 / 编组的结构，只要画板上的，位置相对画板角", () => {
  const { call } = host();
  const p = call("boardPlan", { artboard: 0 });
  assert.equal(p.name, "海报 A4");
  assert.equal(p.deep, true);
  assert.deepEqual([p.width, p.height], [600, 800]);
  // 备注 is off the artboard except its stray point; 空图层 has nothing
  assert.deepEqual(p.nodes.map((n: any) => n.name), ["内容", "装饰", "背景", "备注"]);
  const content = p.nodes[0];
  const logo = content.children[0];
  assert.equal(logo.name, "Logo");
  assert.ok(logo.children, "a plain group is opened up");
  const star2 = p.nodes[1].children.find((n: any) => n.name === "星星 2");
  assert.equal(star2.hidden, true);
  assert.deepEqual([star2.left, star2.top, star2.width, star2.height], [520, 70, 16, 16]);
  // too many items: groups go whole
  const flat = call("boardPlan", { artboard: 0, limit: 3 });
  assert.equal(flat.deep, false);
  assert.equal(flat.nodes[0].children[0].children, undefined);
});

test("画板逐个导出：不带自身的不透明度 / 混合模式 / 隐藏，关联记成 bare，更新时也一样", () => {
  const { call, doc } = host();
  const star = (doc.layers[1] as FakeLayer).pageItems[1] as FakeItem;
  star.opacity = 40;
  const r = call("exportItems", { format: "ai", folder: "C:\\in", targets: [{ key: "l1/i1", expect: { kind: "path", label: "星星 2" } }], bare: true, name: "星星 2" });
  const out = app.documents.find(d => d !== doc);
  assert.equal(out, undefined, "the export document is closed");
  assert.match(star.note, /^wavelink:L[\d_]+;bare$/);
  assert.equal(star.opacity, 40, "the original is left as it was");
  assert.equal(star.hidden, true);
  // the copy that was saved: checked through a fresh export of the link
  let saved: FakeItem | null = null;
  const add = (app.documents as any).add;
  (app.documents as any).add = (...a: any[]) => { const d = add(...a); const orig = d.saveAs.bind(d); d.saveAs = (f: any, o: any) => { saved = (d.layers[0] as FakeLayer).pageItems[0] as FakeItem; orig(f, o); }; return d; };
  call("exportItems", { format: "ai", folder: "C:\\in", link: r.link });
  (app.documents as any).add = add;
  assert.equal(saved!.opacity, 100);
  assert.equal(saved!.hidden, false);
});

test("从 Photoshop 置入画板：新画板在最右边，组结构、混合模式、不透明度、隐藏都带上", () => {
  const { call, doc } = host();
  for (const f of ["a.svg", "b.ai", "c.png"]) written.add("C:\\tmp\\" + f);
  const r = call("placeFiles", { ppi: 144, layerName: "来自 Photoshop · 画板 1", board: { name: "画板 1", width: 400, height: 200 },
    groups: { "5": { name: "标题组", hidden: true, opacity: 80, blend: "SCREEN" } },
    files: [
      { path: "C:\\tmp\\a.svg", name: "标题", left: 20, top: 20, width: 100, height: 50, how: "svg", group: ["5"], opacity: 50 },
      { path: "C:\\tmp\\b.ai", name: "Logo", left: 200, top: 0, width: 100, height: 100, how: "vector", group: ["5"], blend: "MULTIPLY" },
      { path: "C:\\tmp\\c.png", name: "照片", left: 0, top: 100, width: 400, height: 100, how: "png", opacity: 60, hidden: true },
    ] });
  assert.deepEqual(r, { placed: 3, missing: 0, artboard: "画板 1" });
  const ab = doc.artboardList.at(-1)!;
  assert.equal(ab.name, "画板 1");
  // right of 横幅 (ends at 1900), as tall as the highest top (800); 144 ppi: 400 px = 200 pt
  assert.deepEqual(ab.artboardRect, [1940, 800, 2140, 700]);
  assert.equal(doc.board, 2);
  const layer = doc.layers[0] as FakeLayer;
  assert.equal(layer.name, "来自 Photoshop · 画板 1");
  const [group, photo] = layer.pageItems as FakeItem[];
  assert.equal(group.name, "标题组");
  assert.equal(group.hidden, true);
  assert.equal(group.opacity, 80);
  assert.equal(photo.name, "照片");
  assert.equal(photo.opacity, 60);
  assert.equal(photo.hidden, true);
  assert.deepEqual(photo.visibleBounds, [1940, 750, 2140, 700]);
  const [title, logo] = group.pageItems as FakeItem[];
  assert.equal(title.name, "标题");
  assert.equal(title.opacity, 100, "an SVG of a text layer carries its own opacity");
  assert.equal(logo.name, "Logo");
  assert.equal(logo.blendingMode, 1);
});

test("从 Photoshop 置入画板：没有打开的文档时新建一个画板大小的文档", () => {
  const { call } = host();
  openDocuments();
  written.add("C:\\tmp\\c.png");
  const r = call("placeFiles", { ppi: 72, board: { name: "Banner", width: 300, height: 100 }, files: [{ path: "C:\\tmp\\c.png", name: "图", left: 0, top: 0, width: 300, height: 100 }] });
  assert.equal(r.placed, 1);
  const d = app.activeDocument;
  assert.equal(d.artboardList[0].name, "Banner");
  assert.deepEqual(d.artboardList[0].artboardRect, [0, 100, 300, 0]);
  assert.equal(d.layers.length, 1);
});
