// WaveLayer for Illustrator: the panel's pure logic (src/ai/model.ts), the call format into the
// host script (src/ai/host.ts) and the Photoshop ⇄ Illustrator bridge messages (core/overlay/bridge.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type AiNode, clickSelect, dropProblem, dropText, dropWhere, footerText, keepOpen, neighbour, outermost, rows, selectedKeys } from "../src/ai/model.ts";
import { callScript, createHost, readAnswer } from "../src/ai/host.ts";
import { connectPs } from "../src/ai/bridge.ts";
import { keepLinks, parseBridgeRequest, parseBridgeResult, pngScale, safeFileName } from "../src/core/overlay/bridge.ts";
import { demoDocument, loadHost, openDocuments } from "../src/ai/fake.ts";

const n = (key: string, kind: AiNode["kind"], label: string, extra: Partial<AiNode> = {}): AiNode =>
  ({ key, kind, label, name: label, hidden: false, locked: false, sel: false, count: 0, ...extra });

const sample = (): AiNode[] => [
  n("l0", "layer", "内容", { color: "#4f80ff", count: 2, children: [
    n("l0/i0", "group", "Logo", { count: 2, sel: true, children: [n("l0/i0/i0", "text", "WAVE", { sel: true }), n("l0/i0/i1", "path", "<路径>", { sel: true })] }),
    n("l0/i1", "text", "标题"),
  ] }),
  n("l1", "layer", "背景", { color: "#ff4f4f", hidden: true, count: 1, children: [n("l1/i0", "path", "底色")] }),
  n("l2", "layer", "空图层"),
];

test("行：按树的顺序，带层级、所在图层的颜色、隐藏的变暗", () => {
  const r = rows(sample());
  assert.deepEqual(r.map(x => x.node.key), ["l0", "l0/i0", "l0/i0/i0", "l0/i0/i1", "l0/i1", "l1", "l1/i0", "l2"]);
  assert.deepEqual(r.map(x => x.depth), [0, 1, 2, 2, 1, 0, 1, 0]);
  assert.equal(r[2].layerColor, "#4f80ff");
  assert.equal(r[6].layerColor, "#ff4f4f");
  assert.equal(r[6].dim, true);
  assert.equal(r[0].open, true);
  assert.equal(r[7].open, false);
});

test("选中的：只要最外层（编组选中时它的子项也是选中的）", () => {
  assert.deepEqual(selectedKeys(sample()), ["l0/i0"]);
});

test("点击 / Ctrl / Shift 选择", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(clickSelect(order, ["a"], "a", "c", { ctrl: false, shift: false }), { keys: ["c"], anchor: "c" });
  assert.deepEqual(clickSelect(order, ["a"], "a", "c", { ctrl: true, shift: false }).keys, ["a", "c"]);
  assert.deepEqual(clickSelect(order, ["a", "c"], "c", "c", { ctrl: true, shift: false }).keys, ["a"]);
  assert.deepEqual(clickSelect(order, ["b"], "b", "d", { ctrl: false, shift: true }), { keys: ["b", "c", "d"], anchor: "b" });
  assert.deepEqual(clickSelect(order, ["a"], "c", "b", { ctrl: true, shift: true }).keys, ["a", "b", "c"]);
});

test("操作对象：去掉已经在别的选中项里面的，按行的顺序", () => {
  const order = rows(sample()).map(r => r.node.key);
  assert.deepEqual(outermost(["l0/i0/i1", "l1", "l0/i0"], order), ["l0/i0", "l1"]);
});

test("放置位置：容器的中间是放进去，上下边是前后；普通对象只有前后", () => {
  const group = n("g", "group", "G"), path = n("p", "path", "P");
  assert.equal(dropWhere(group, 0.1, false), "before");
  assert.equal(dropWhere(group, 0.5, false), "inside");
  assert.equal(dropWhere(group, 0.9, false), "after");
  // an open container's lower edge: inside, at its top
  assert.equal(dropWhere(group, 0.9, true), "inside");
  assert.equal(dropWhere(path, 0.4, false), "before");
  assert.equal(dropWhere(path, 0.6, false), "after");
});

test("拖放规则和宿主脚本一致", () => {
  const s = sample(), [content, bg] = s, logo = content.children![0], text = content.children![1];
  assert.equal(dropProblem([logo], logo.children![0], "before"), "不能移到它自己里面");
  assert.equal(dropProblem([content], logo, "inside"), "不能移到它自己里面");
  assert.equal(dropProblem([bg], logo, "before"), "图层只能放在图层旁边或图层里");
  assert.equal(dropProblem([bg, text], content, "inside"), "图层和对象不能一起拖");
  assert.equal(dropProblem([text], logo.children![1], "inside"), "只能放进图层或编组");
  assert.equal(dropProblem([text], n("x", "layer", "锁", { locked: true }), "inside"), "目标已锁定");
  assert.equal(dropProblem([text], logo, "inside"), null);
  assert.equal(dropProblem([bg], content, "before"), null);
  assert.equal(dropText("before", logo, true, 2), "复制 2 个到「Logo」上方");
  assert.equal(dropText("inside", content, false, 1), "移动 1 个到「内容」里");
});

test("展开状态：键指向的东西变了就不再展开", () => {
  const open = new Map([["l0", "内容"], ["l0/i0", "Logo"], ["l1", "别的"]]);
  assert.deepEqual([...keepOpen(open, sample()).keys()], ["l0", "l0/i0"]);
});

test("上下键和底栏文字", () => {
  const order = ["a", "b", "c"];
  assert.equal(neighbour(order, ["b"], true), "a");
  assert.equal(neighbour(order, ["b"], false), "c");
  assert.equal(neighbour(order, [], false), "a");
  assert.equal(neighbour(order, ["c"], false), "c");
  assert.equal(footerText({ doc: null }), "没有打开的文档");
  assert.equal(footerText({ doc: { name: "a", path: "", saved: true, artboards: [], artboard: 0 }, layers: sample(), selCount: 3 }), "3 个图层 · 已选 3");
});

test("调用宿主脚本：脚本文本是合法的 ES3，U+2028 被转义", () => {
  const code = callScript("rename", { items: [{ key: "l0", name: "a b\"c" }] });
  assert.equal(code.includes(" "), false);
  assert.match(code, /^WavePlugWL\.call\("rename",\{/);
  assert.deepEqual(readAnswer('{"ok":true,"value":3}'), 3);
  assert.throws(() => readAnswer('{"ok":false,"error":"图层已变化"}'), /图层已变化/);
  assert.throws(() => readAnswer("EvalScript error."), /没有正常返回/);
  assert.throws(() => readAnswer(""), /没有加载/);
});

test("宿主连接：一次一个；脚本没加载时重新加载再试一次；同样的读取合并", async () => {
  openDocuments(demoDocument());
  const src = readFileSync(new URL("../ai/host/wavelayer.jsx", import.meta.url), "utf8");
  let wl: ReturnType<typeof loadHost> | null = null, loads = 0, running = 0, maxRunning = 0, evals = 0;
  const host = createHost({
    async evalScript(code) {
      evals++;
      running++; maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      if (!wl) return "EvalScript error.";
      return new Function("WavePlugWL", `return ${code};`)(wl);
    },
    async load() { loads++; wl = loadHost(src); },
  });
  const [a, b, c] = await Promise.all([host.call("tree", {}), host.call("tree", {}), host.call("sig")]);
  assert.equal(loads, 1);
  assert.equal(maxRunning, 1);
  assert.equal(a, b, "the same read is merged");
  assert.equal(typeof c, "string");
  assert.equal(evals, 3, "failed tree + retried tree + sig");
  await assert.rejects(host.call("nope"), /unknown op/);
  assert.equal(host.busy, 0);
});

test("桥接消息：只接受约定的字段，文件名不能带路径", () => {
  assert.deepEqual(parseBridgeRequest({ kind: "info", reqId: "r1" }), { kind: "info", reqId: "r1" });
  assert.equal(parseBridgeRequest({ kind: "info" }), null);
  assert.deepEqual(parseBridgeRequest({ kind: "place", reqId: "r2", fileName: "L1_2.ai", name: "Logo", pixels: true, link: "L1" }),
    { kind: "place", reqId: "r2", fileName: "L1_2.ai", name: "Logo", pixels: true, link: "L1" });
  assert.equal(parseBridgeRequest({ kind: "place", reqId: "r2", fileName: "..\\..\\x.ai", name: "x" }), null);
  assert.equal(parseBridgeRequest({ kind: "update", reqId: "r3", fileName: "a.ai" }), null, "needs a link");
  assert.deepEqual(parseBridgeRequest({ kind: "set-color", reqId: "r4", hex: "#AABBCC" }), { kind: "set-color", reqId: "r4", hex: "#aabbcc" });
  assert.equal(parseBridgeRequest({ kind: "set-color", reqId: "r4", hex: "red" }), null);
  assert.equal(parseBridgeRequest({ kind: "rm", reqId: "r5" }), null);
  assert.equal(safeFileName("a/b.ai"), false);
  assert.equal(safeFileName(".hidden"), false);
  assert.deepEqual(parseBridgeResult({ kind: "result", reqId: "r1", ok: false }), { kind: "result", reqId: "r1", ok: false, error: "Photoshop 出错" });
  assert.deepEqual(parseBridgeResult({ kind: "missing", to: "photoshop", reqId: "r9" }), { kind: "missing", reqId: "r9" });
});

test("关联记录只留最近的", () => {
  const links = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`L${i}`, { docId: 1, docName: "a", layerId: i, name: "x", at: i }]));
  assert.deepEqual(Object.keys(keepLinks(links, 2)), ["L4", "L3"]);
  assert.equal(pngScale(300), 417);
  assert.equal(pngScale(72), 100);
  assert.equal(pngScale(0), 100);
  assert.equal(pngScale(10000), 776);
});

test("Illustrator 这边的连接：先报到，请求按 id 对上回答，Photoshop 不在时直接说明", async () => {
  const sent: any[] = [];
  let sock: any;
  const ps = connectPs(() => {
    sock = { readyState: 1, send: (t: string) => sent.push(JSON.parse(t)), close() {}, onopen: null, onclose: null, onmessage: null, onerror: null };
    return sock;
  });
  sock.onopen();
  assert.deepEqual(sent[0], { type: "join", role: "illustrator" });
  assert.equal(ps.helper, true);
  assert.equal(ps.ready, false);
  await assert.rejects(ps.request({ kind: "info" }), /插件没有连接/);
  sock.onmessage({ data: JSON.stringify({ type: "peer", role: "photoshop", connected: true }) });
  assert.equal(ps.ready, true);
  const p = ps.request<{ doc: null }>({ kind: "info" });
  const req = sent.at(-1);
  assert.equal(req.type, "bridge");
  assert.equal(req.to, "photoshop");
  sock.onmessage({ data: JSON.stringify({ type: "bridge", from: "photoshop", msg: { kind: "result", reqId: req.msg.reqId, ok: true, value: { doc: null } } }) });
  assert.deepEqual(await p, { doc: null });
  const q = ps.request({ kind: "pull" });
  sock.onmessage({ data: JSON.stringify({ type: "bridge", from: "photoshop", msg: { kind: "result", reqId: sent.at(-1).msg.reqId, ok: false, error: "先选中图层" } }) });
  await assert.rejects(q, /先选中图层/);
  // the plugin goes away: waiting requests fail at once
  const w = ps.request({ kind: "pull" });
  sock.onmessage({ data: JSON.stringify({ type: "peer", role: "photoshop", connected: false }) });
  await assert.rejects(w, /断开/);
  sock.readyState = 3;
  ps.onChange(() => undefined);
});

test("Photoshop 图层右键 › 发送到：Illustrator 面板连着才有这一行", async () => {
  const { sendMenu } = await import("../src/core/layers/contextMenu.ts");
  const prefs = { restore: true, scaleWithCanvas: false, matchParents: true, position: "top" as const, switchAfter: false };
  assert.equal(sendMenu({ docs: [], prefs }, 2)[0].id, "send:none");
  const rows = sendMenu({ docs: [{ id: 5, name: "b.psd" }], prefs, illustrator: true }, 2);
  assert.equal(rows[0].id, "send:ai");
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[1].id, "send:aiboard");
  assert.equal(rows[3].id, "send:5");
});

test("桥接：画板请求的检查，混合模式两边互换", async () => {
  const { psBlendOf, aiBlendOf, boardFiles, BOARD_MAX_ITEMS } = await import("../src/core/overlay/bridge.ts");
  const item = (f: string) => ({ name: f, hidden: false, opacity: 100, blend: "NORMAL", fileName: f, left: 0, top: 0, width: 10, height: 10 });
  const ok = parseBridgeRequest({ kind: "board", reqId: "b", name: "A4", width: 595, height: 842, ppi: 300, nodes: [{ name: "图层 1", opacity: 150, children: [item("a.ai")] }, item("b.ai")] }) as any;
  assert.equal(ok.kind, "board");
  assert.equal(ok.nodes[0].opacity, 100, "opacity clamped");
  assert.equal(ok.nodes[0].hidden, false);
  assert.deepEqual(boardFiles(ok.nodes), ["a.ai", "b.ai"]);
  assert.equal(parseBridgeRequest({ kind: "board", reqId: "b", width: 0, height: 1, ppi: 72, nodes: [] }), null);
  assert.equal(parseBridgeRequest({ kind: "board", reqId: "b", width: 1, height: 1, ppi: 72, nodes: [{ name: "x" }] }), null, "an item without a file");
  assert.equal(parseBridgeRequest({ kind: "board", reqId: "b", width: 1, height: 1, ppi: 72, nodes: [item("../x.ai")] }), null);
  const many = Array.from({ length: BOARD_MAX_ITEMS + 1 }, (_, i) => item(`f${i}.ai`));
  assert.equal(parseBridgeRequest({ kind: "board", reqId: "b", width: 1, height: 1, ppi: 72, nodes: many }), null);
  assert.equal(psBlendOf("MULTIPLY"), "MULTIPLY");
  assert.equal(psBlendOf("SATURATIONBLEND"), "SATURATION");
  assert.equal(psBlendOf("NORMAL", true), "PASSTHROUGH");
  assert.equal(psBlendOf("SCREEN", true), "SCREEN");
  assert.equal(aiBlendOf("colorDodge"), "COLORDODGE");
  assert.equal(aiBlendOf("passThrough"), "NORMAL");
  assert.equal(aiBlendOf("linearBurn"), "NORMAL");
});

test("画板置入 Illustrator 的计划：选哪个画板，每种图层怎么转", async () => {
  const { illustratorPlan } = await import("../src/core/overlay/bridge.ts");
  const L = (id: number, kind: string, parentId: number | null, extra: object = {}) => ({ id, name: "L" + id, kind, parentId, visible: true, opacity: 100, mode: "normal", width: 10, height: 10, clipped: false, artboard: false, ...extra });
  const layers = [
    L(1, "group", null, { artboard: true, board: { left: 0, top: 0, right: 100, bottom: 50 } }),
    L(2, "text", 1), L(3, "shape", 1), L(4, "fill", 1),
    L(5, "smartObject", 1, { smart: { file: "a.PDF" } }),
    L(6, "smartObject", 1, { smart: { file: "b.psb" } }),
    L(7, "smartObject", 1, { smart: { file: "c.ai" }, filters: [{}] }),
    L(8, "pixel", 1, { clipped: true }), L(9, "pixel", 1, { width: 0 }), L(10, "adjustment", 1),
    L(20, "group", null, { artboard: true, board: { left: 200, top: 0, right: 300, bottom: 80 } }), L(21, "pixel", 20),
  ];
  const p = illustratorPlan(layers, [21], { name: "x.psd", width: 500, height: 500 });
  assert.deepEqual([p.name, p.left, p.width, p.height], ["L20", 200, 100, 80]);
  const q = illustratorPlan(layers, [], { name: "x.psd", width: 500, height: 500 });
  assert.equal(q.name, "L1", "nothing selected: the first artboard");
  assert.deepEqual(q.leaves.map(l => [l.id, l.how, l.vectorKind ?? l.ext ?? ""]), [[2, "svg", "text"], [3, "svg", "shape"], [4, "svg", "shape"], [5, "vector", "pdf"], [6, "png", ""], [7, "png", ""], [8, "png", ""]]);
  assert.equal(q.notes.length, 3);
  // no artboards: the whole canvas, top-level groups kept
  const flat = illustratorPlan([L(30, "group", null, { visible: false, mode: "multiply" }), L(31, "pixel", 30)], [31], { name: "图.psd", width: 640, height: 480 });
  assert.deepEqual([flat.name, flat.left, flat.top, flat.width, flat.height], ["图", 0, 0, 640, 480]);
  assert.deepEqual(flat.groups, { "30": { name: "L30", hidden: true, opacity: 100, blend: "MULTIPLY" } });
  assert.deepEqual(flat.leaves[0].group, ["30"]);
});

test("桥接：定位关联图层的请求", () => {
  assert.deepEqual(parseBridgeRequest({ kind: "reveal", reqId: "r1", link: "L1" }), { kind: "reveal", reqId: "r1", link: "L1" });
  assert.equal(parseBridgeRequest({ kind: "reveal", reqId: "r1" }), null);
});

test("Illustrator 这边的连接：外置框架太旧时立即离开、不再重连", async () => {
  let made = 0, sock: any;
  const ps = connectPs(() => { made++; sock = { readyState: 1, send() {}, close() { sock.closed = true; }, onopen: null, onclose: null, onmessage: null, onerror: null }; return sock; });
  sock.onopen();
  sock.onmessage({ data: JSON.stringify({ type: "ready", version: "0.14.0" }) });
  assert.equal(sock.closed, true);
  assert.equal(ps.outdated, "0.14.0");
  assert.equal(ps.helper, false);
  sock.onclose();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(made, 1, "no reconnect");
  await assert.rejects(ps.request({ kind: "info" }), /没有运行/);
});

test("一个文字 / 形状图层的 SVG：页面就是图层范围，按分辨率换成点", async () => {
  const { layerSvg, vectorKind } = await import("../src/core/overlay/bridge.ts");
  const s = layerSvg('<text x="10">标题</text>', { left: 100, top: 50, right: 400, bottom: 150 }, 300);
  assert.match(s, /width="72" height="24" viewBox="100 50 300 100"/);
  assert.match(s, /<text x="10">标题<\/text>/);
  assert.equal(vectorKind("text"), "text");
  assert.equal(vectorKind("solidColor"), "shape");
  assert.equal(vectorKind("pixel"), "");
});

test("Photoshop 图层右键：从 Illustrator 来的图层可以请 Illustrator 更新 / 选中", async () => {
  const { contextMenu } = await import("../src/core/layers/contextMenu.ts");
  const layer: any = { id: 1, name: "Logo", kind: "smartObject", parentId: null, depth: 0, visible: true, children: 0, links: [], locks: { protectAll: false, protectPosition: false, protectComposite: false, protectTransparency: false } };
  const prefs = { restore: true, scaleWithCanvas: false, matchParents: true, position: "top" as const, switchAfter: false };
  const ids = (items: any[]): string[] => items.flatMap(i => [i.id, ...(i.children ? ids(i.children) : [])]).filter(Boolean);
  const m = contextMenu({ layers: [layer], selected: new Set([1]), users: new Map(), smartTools: false, colors: [], send: { docs: [], prefs, illustrator: true, illustratorLink: true } });
  assert.ok(ids(m.items).includes("ai:update"));
  assert.ok(ids(m.items).includes("ai:reveal"));
  const plain = contextMenu({ layers: [layer], selected: new Set([1]), users: new Map(), smartTools: false, colors: [], send: { docs: [], prefs, illustrator: true } });
  assert.equal(ids(plain.items).includes("ai:update"), false);
});

test("Illustrator 这边：收到 Photoshop 的更新 / 选中请求", () => {
  let sock: any;
  const ps = connectPs(() => { sock = { readyState: 1, send() {}, close() {}, onopen: null, onclose: null, onmessage: null, onerror: null }; return sock; });
  sock.onopen();
  const got: string[] = [];
  ps.onAsk((kind, link) => got.push(`${kind} ${link}`));
  sock.onmessage({ data: JSON.stringify({ type: "bridge", from: "photoshop", msg: { kind: "update-request", link: "L1" } }) });
  sock.onmessage({ data: JSON.stringify({ type: "bridge", from: "photoshop", msg: { kind: "reveal-request", link: "L2" } }) });
  sock.onmessage({ data: JSON.stringify({ type: "bridge", from: "photoshop", msg: { kind: "reveal-request" } }) });
  assert.deepEqual(got, ["update L1", "reveal L2"]);
});
