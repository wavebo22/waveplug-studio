import { test } from "node:test";
import assert from "node:assert/strict";
import { type MenuItem, type RawLayer, ancestors, effectsOf, isVariantLayer, packChips, rawProblem, buildTree, clickSelect, contentUsers, dropPlan, dropZone, filterCounts, layerMenu, layerTags, linkPeers, lockPlan, lockedByGroup, sharedColors, visibleRows } from "../src/core/layers/tree.ts";
import { ThumbCache, frameThumb, thumbArea } from "../src/core/layers/thumbs.ts";

const raw = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, ...extra });
const end = (): RawLayer => ({ id: 0, name: "</Layer group>", kind: 13, section: "end", visible: true, locked: false, mask: false });

// 标题 | AI填充 · 杯子 { v1, v2 } | 组 { 徽章, 内组 { 徽章 拷贝 }, 产品 } | 背景
const doc = (): RawLayer[] => [
  raw(1, "标题", 3),
  raw(10, "AI填充 · 杯子", 7), raw(11, "v2 · 橘子汁", 1), raw(12, "v1 · 橘子汁", 1, { mask: true }), end(),
  raw(20, "组", 7),
  raw(21, "徽章", 5, { contentId: "a", file: "徽章.psb" }),
  raw(22, "内组", 7), raw(23, "徽章 拷贝", 5, { contentId: "a", file: "徽章.psb" }), end(),
  raw(24, "产品", 5, { contentId: "b", file: "产品.png" }),
  end(),
  raw(30, "背景", 12, { locked: true }),
];

test("图层列表: depth, parent, children and AI variations from Photoshop's flat list", () => {
  const t = buildTree(doc());
  assert.deepEqual(t.map(l => [l.id, l.depth, l.parentId]), [[1, 0, null], [10, 0, null], [11, 1, 10], [12, 1, 10], [20, 0, null], [21, 1, 20], [22, 1, 20], [23, 2, 22], [24, 1, 20], [30, 0, null]]);
  assert.equal(t.find(l => l.id === 20)!.children, 3);
  assert.deepEqual(t.find(l => l.id === 10)!.ai, { label: "AI填充", variations: 2, ids: [11, 12], shown: 11 });
  assert.equal(t.find(l => l.id === 30)!.kind, "background");
  assert.equal(t.find(l => l.id === 21)!.kind, "smartObject");
});

test("图层列表: status cells", () => {
  const t = buildTree(doc()), users = contentUsers(t), tags = (id: number) => layerTags(t.find(l => l.id === id)!, users).map(x => x.text);
  assert.deepEqual(tags(21), ["共用×2", "可编辑"]);
  assert.deepEqual(tags(24), ["独立", "图片"]);
  assert.deepEqual(tags(10), ["AI填充 ×2"]);
  assert.deepEqual(tags(12), ["蒙版"]);
  const linked = buildTree([raw(1, "L", 5, { contentId: "x", linked: true, file: "logo.ai" })]);
  assert.deepEqual(layerTags(linked[0], contentUsers(linked)).map(x => x.text), ["链接", "矢量"]);
  assert.deepEqual(filterCounts(t, users), { shared: 2, uneditable: 1, ai: 1 });
});

test("图层列表: collapsed groups hide their contents, filters keep the groups of matches", () => {
  const t = buildTree(doc()), users = contentUsers(t), ids = (r: { layer: { id: number } }[]) => r.map(x => x.layer.id);
  assert.deepEqual(ids(visibleRows(t, new Set(), "all", users)), [1, 10, 20, 21, 22, 23, 24, 30]);
  assert.deepEqual(ids(visibleRows(t, new Set([10, 22]), "all", users)), [1, 10, 20, 21, 22, 24, 30]);
  assert.deepEqual(ids(visibleRows(t, new Set([20]), "all", users)), [1, 10, 20, 30]);
  const shared = visibleRows(t, new Set([20, 22]), "shared", users);
  assert.deepEqual(shared.map(r => [r.layer.id, r.context]), [[20, true], [21, false], [22, true], [23, false]]);
  assert.deepEqual(ids(visibleRows(t, new Set(), "uneditable", users)), [20, 24]);
  assert.deepEqual(ids(visibleRows(t, new Set(), "ai", users)), [10]);
  assert.deepEqual(ancestors(t, 23), [22, 20]);
});

test("图层列表: click, Ctrl and Shift selection", () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(clickSelect(rows, [1, 2], 1, 3, { ctrl: false, shift: false }), { ids: [3], anchor: 3 });
  assert.deepEqual(clickSelect(rows, [3], 3, 5, { ctrl: true, shift: false }), { ids: [3, 5], anchor: 5 });
  assert.deepEqual(clickSelect(rows, [3, 5], 5, 3, { ctrl: true, shift: false }), { ids: [5], anchor: 3 });
  assert.deepEqual(clickSelect(rows, [2], 2, 4, { ctrl: false, shift: true }), { ids: [2, 3, 4], anchor: 2 });
  assert.deepEqual(clickSelect(rows, [5], 4, 2, { ctrl: true, shift: true }), { ids: [5, 2, 3, 4], anchor: 4 });
  // the anchor scrolled away (filtered out): Shift acts like a plain click
  assert.deepEqual(clickSelect(rows, [9], 9, 2, { ctrl: false, shift: true }), { ids: [2], anchor: 2 });
});

test("拖动: drop zones of layers and groups", () => {
  const t = buildTree(doc()), g = t.find(l => l.id === 20)!, px = t.find(l => l.id === 1)!;
  assert.equal(dropZone(px, 0.2, false), "above");
  assert.equal(dropZone(px, 0.8, false), "below");
  assert.equal(dropZone(g, 0.1, false), "above");
  assert.equal(dropZone(g, 0.5, false), "inside");
  assert.equal(dropZone(g, 0.9, false), "below");
  assert.equal(dropZone(g, 0.9, true), "inside");
});

test("拖动: move plans keep the dragged layers' order", () => {
  const t = buildTree(doc());
  // 标题 and 产品 dragged above 组: each goes before it, top one first
  assert.deepEqual(dropPlan(t, [24, 1], 20, "above"), [{ id: 1, rel: 20, place: "before" }, { id: 24, rel: 20, place: "before" }]);
  // below 标题: the first after it, the next after that one
  assert.deepEqual(dropPlan(t, [21, 24], 1, "below"), [{ id: 21, rel: 1, place: "after" }, { id: 24, rel: 21, place: "after" }]);
  // into 组: on top of its first layer that isn't being dragged
  assert.deepEqual(dropPlan(t, [1, 21], 20, "inside"), [{ id: 1, rel: 22, place: "before" }, { id: 21, rel: 22, place: "before" }]);
  // into a group that becomes empty
  assert.deepEqual(dropPlan(t, [23, 1], 22, "inside"), [{ id: 1, rel: 22, place: "inside" }, { id: 23, rel: 1, place: "after" }]);
  // a layer inside a dragged group moves with it; the background stays; nothing goes below it
  assert.deepEqual(dropPlan(t, [20, 23, 30], 1, "above"), [{ id: 20, rel: 1, place: "before" }]);
  // above / below the background: after the top-level layer above it (Photoshop won't move relative to the background)
  assert.deepEqual(dropPlan(t, [1], 30, "below"), [{ id: 1, rel: 20, place: "after" }]);
  assert.deepEqual(dropPlan(t, [1, 24], 30, "above"), [{ id: 1, rel: 20, place: "after" }, { id: 24, rel: 1, place: "after" }]);
  // Photoshop lists the background as a pixel layer with background: true
  assert.equal(buildTree([raw(5, "背景", 1, { background: true })])[0].kind, "background");
});

test("拖动: impossible drops", () => {
  const t = buildTree(doc());
  // an AI result (AI填充 · 杯子, shown as one layer) takes nothing in: not into it, not beside its variants
  const ai = t.find(l => l.id === 10)!;
  assert.equal(dropZone(ai, 0.4, false), "above");
  assert.equal(dropZone(ai, 0.6, true), "below");
  assert.equal(dropPlan(t, [1], 10, "inside"), null);
  assert.equal(dropPlan(t, [1], 11, "above"), null);
  assert.equal(dropPlan(t, [1], 12, "below"), null);
  assert.deepEqual(dropPlan(t, [1], 10, "below"), [{ id: 1, rel: 10, place: "after" }]);
  assert.equal(dropPlan(t, [20], 23, "above"), null); // into itself
  assert.equal(dropPlan(t, [20], 20, "inside"), null);
  assert.equal(dropPlan(t, [1], 21, "inside"), null); // not a group
  assert.equal(dropPlan(t, [30], 1, "above"), null); // only the background
});

test("缩略图: missing first, stale ones keep their picture until refetched", () => {
  const c = new ThumbCache();
  c.put(1, "a"); c.put(2, "b"); c.put(3, null);
  assert.deepEqual(c.next([1, 2, 3, 4, 5], 5), [4, 5]);
  c.invalidate([2, 9]);
  assert.deepEqual(c.next([1, 2, 3, 4, 5], 5), [4, 5, 2]);
  assert.deepEqual(c.next([1, 2, 3, 4, 5], 2), [4, 5]);
  assert.equal(c.get(2), "b");
  const v = c.version(2);
  c.put(2, "b2");
  assert.equal(c.version(2), v + 1);
  c.invalidate("all");
  assert.deepEqual(c.next([1, 2, 3], 5), [1, 2, 3]);
});

test("剪贴蒙版: clipped layers and their base, per group", () => {
  const t = buildTree([
    raw(1, "调色", 2, { clipped: true }), raw(2, "阴影", 1, { clipped: true }), raw(3, "人物", 1),
    raw(4, "组", 7), raw(5, "裁切", 1, { clipped: true }), raw(6, "底", 1), end(),
    raw(7, "背景", 1, { background: true }),
  ]);
  assert.deepEqual(t.map(l => [l.id, l.clipped, l.clipBase]), [[1, true, false], [2, true, false], [3, false, true], [4, false, false], [5, true, false], [6, false, true], [7, false, false]]);
});

test("右键菜单: items follow the selection", () => {
  const t = buildTree(doc());
  const menu = (ids: number[]) => layerMenu(t.filter(l => ids.includes(l.id)));
  const on = (ids: number[]) => menu(ids).filter((m): m is Exclude<MenuItem, "-"> => m !== "-" && m.enabled).map(m => m.action);
  assert.ok(on([21]).includes("makeUnique"));
  assert.ok(!on([1]).includes("makeUnique"));
  assert.ok(on([12]).includes("deleteMask") && on([12]).includes("toggleMask"));
  assert.ok(on([1]).includes("addMask") && !on([1]).includes("deleteMask"));
  assert.ok(!on([30]).includes("clip") && !on([30]).includes("addMask"));
  assert.ok(on([1, 24]).includes("link") && on([1, 24]).includes("merge"));
  assert.ok(!on([1, 24]).includes("layerStyle"));
  const clipped = buildTree([raw(1, "a", 1, { clipped: true }), raw(2, "b", 1)]);
  assert.ok(layerMenu([clipped[0]]).some(m => m !== "-" && m.action === "unclip"));
});

test("共用内容 get one colour each; 链接 peers of the selection", () => {
  const t = buildTree([
    raw(1, "a", 5, { contentId: "x", file: "a.psb" }), raw(2, "b", 5, { contentId: "y", file: "b.png" }),
    raw(3, "a 拷贝", 5, { contentId: "x", file: "a.psb" }), raw(4, "c", 5, { contentId: "z", file: "c.png" }),
    raw(5, "b 拷贝", 5, { contentId: "y", file: "b.png" }),
    raw(6, "文字", 3, { links: [7, 8] }), raw(7, "形状", 4, { links: [6, 8] }), raw(8, "图", 1, { links: [6, 7] }),
  ]);
  const colours = sharedColors(t, contentUsers(t));
  assert.deepEqual([...colours], [["x", 0], ["y", 1]]);
  assert.deepEqual(linkPeers(t, new Set([7])), [6, 8]);
  assert.deepEqual(linkPeers(t, new Set([6, 7])), [8]);
  assert.deepEqual(linkPeers(t, new Set([1])), []);
});

test("锁定: one lock on or off, the others kept; groups only lock as a whole", () => {
  const t = buildTree([
    raw(1, "组", 7, { locked: true, lockAll: true }), raw(2, "a", 1, { locked: true, lockPosition: true, lockTransparency: true }), raw(3, "b", 1), end(),
    raw(4, "c", 1, { locked: true, lockAll: true }), raw(5, "背景", 1, { background: true, locked: true, lockAll: true }),
  ]);
  const ids = (p: { id: number }[]) => p.map(x => x.id);
  // a group takes 锁定全部 only, and doesn't write its layers
  assert.deepEqual(ids(lockPlan(t, [1], "position", false)), []);
  assert.deepEqual(lockPlan(t, [1], "all", false), [{ id: 1, locks: { protectAll: false, protectPosition: false, protectComposite: false, protectTransparency: false } }]);
  assert.deepEqual([...lockedByGroup(t)], [2, 3]);
  // locking pixels where position and transparency are on is 锁定全部
  assert.deepEqual(lockPlan(t, [2], "pixels", true)[0].locks, { protectAll: true, protectPosition: false, protectComposite: false, protectTransparency: false });
  // a fully locked layer losing one lock keeps the other two
  assert.deepEqual(lockPlan(t, [4], "pixels", false)[0].locks, { protectAll: false, protectPosition: true, protectComposite: false, protectTransparency: true });
  assert.deepEqual(ids(lockPlan(t, [4, 5], "all", false)), [4]);
});

test("智能滤镜: one row under their smart object (each filter a chip on it), foldable, and a status icon", () => {
  const t = buildTree([
    raw(1, "图层 2", 5, { contentId: "a", file: "a.psb", filters: [{ name: "亮度/对比度", enabled: true }, { name: "表面模糊", enabled: false }], filtersOn: true }),
    raw(2, "背景", 1, { background: true }),
  ]);
  // folded by default; opened from the 智能滤镜 icon (minus the layer's id; its id opens the effects)
  assert.deepEqual(visibleRows(t, new Set(), "all", contentUsers(t)).map(r => r.layer.id), [1, 2]);
  assert.deepEqual(visibleRows(t, new Set(), "all", contentUsers(t), new Set([1])).map(r => r.layer.id), [1, 2]);
  const rows = visibleRows(t, new Set(), "all", contentUsers(t), new Set([-1]));
  assert.deepEqual(rows.map(r => [r.layer.id, r.filter?.index ?? null, r.filter?.name ?? null]), [[1, null, null], [1, 0, "智能滤镜"], [2, null, null]]);
  assert.equal(t[0].filters[1].enabled, false);
  assert.ok(layerTags(t[0], contentUsers(t)).some(x => x.text === "智能滤镜" && x.count === 2));
});

test("搜索 / 类型: matches with their groups as context", () => {
  const t = buildTree(doc()), users = contentUsers(t);
  const q = (text: string, kinds: string[] = []) => visibleRows(t, new Set([20, 22]), "all", users, new Set(), { text, kinds: new Set(kinds as never[]) }).map(r => [r.layer.id, r.context]);
  assert.deepEqual(q("徽章"), [[20, true], [21, false], [22, true], [23, false]]);
  assert.deepEqual(q("", ["text"]), [[1, false]]);
  // the background counts as a pixel layer
  // a variant layer's variations aren't listed
  assert.deepEqual(q("", ["pixel"]).map(x => x[0]), [30]);
  assert.deepEqual(q("v1", ["pixel"]), []);
});

test("变体图层: an AI group of only variations is one row, its variations a row under it", () => {
  const t = buildTree(doc()), users = contentUsers(t), g = t.find(l => l.id === 10)!;
  assert.ok(isVariantLayer(g));
  assert.deepEqual(visibleRows(t, new Set([20]), "all", users, new Set([10])).map(r => [r.layer.id, r.filter?.kind ?? null]), [[1, null], [10, null], [10, "variants"], [20, null], [30, null]]);
  // the shown one is the visible variation
  const hidden = buildTree(doc().map(r => r.id === 11 ? { ...r, visible: false } : r));
  assert.equal(hidden.find(l => l.id === 10)!.ai!.shown, 12);
  // a layer of the user's own inside the group: listed as a group again
  const mixed = buildTree([raw(10, "AI填充 · 杯子", 7), raw(13, "修补", 1), raw(11, "v1 · 橘子汁", 1), end()]);
  assert.ok(!isVariantLayer(mixed[0]));
  assert.deepEqual(visibleRows(mixed, new Set(), "all", contentUsers(mixed)).map(r => r.layer.id), [10, 13, 11]);
});

test("图层样式: effects listed under the layer, several strokes kept apart", () => {
  const fx = effectsOf({ _obj: "layerEffects", scale: 100, frameFX: { enabled: true }, frameFXMulti: [{ enabled: true }, { enabled: false }],
    dropShadow: { enabled: true, present: true }, innerGlow: { enabled: true, present: false } });
  assert.deepEqual(fx.map(e => [e.key, e.multi, e.name, e.enabled]), [["frameFX", 0, "描边", true], ["frameFX", 1, "描边", false], ["dropShadow", -1, "投影", true]]);
  const t = buildTree([raw(1, "a", 1, { effects: true, effectsOn: true, effectList: fx }), raw(2, "b", 1)]);
  // one row for all the effects (each shown as a chip on it)
  const rows = visibleRows(t, new Set(), "all", contentUsers(t), new Set([1]));
  assert.deepEqual(rows.map(r => r.filter ? `${r.filter.kind}:${r.filter.index}` : String(r.layer.id)), ["1", "effects:0", "2"]);
  assert.deepEqual(visibleRows(t, new Set(), "all", contentUsers(t)).length, 2);
});

test("图层样式 chips wrap onto more lines, order kept", () => {
  assert.deepEqual(packChips([40, 40, 40, 40, 40], 120), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(packChips([40, 40, 40, 40, 40], 130), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(packChips([40, 200, 40], 130), [[0], [1], [2]]);
  assert.deepEqual(packChips([], 130), []);
  assert.deepEqual(packChips([30, 30, 30], 1000), [[0, 1, 2]]);
});

test("a layer list read in one go is checked before use", () => {
  assert.equal(rawProblem(doc(), 4), null);
  // an end marker lost: everything after the group would hide in it
  const lost = doc().filter((r, i) => !(r.section === "end" && i === 4));
  assert.match(rawProblem(lost, 4)!, /没有结束标记/);
  assert.match(rawProblem(doc(), 5)!, /顶层图层 4 个/);
  assert.match(rawProblem([raw(1, "a", 1), raw(1, "b", 1)], 2)!, /重复/);
});

test("thumbnails are always a small square, the area centred in it", () => {
  const canvas = { width: 1000, height: 2000 }, at = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b });
  // a 30000 × 2 px line read at full size: still a 48 × 48 square (the canvas 24 wide in the middle), the line a 1 px row
  const line = frameThumb(canvas, 48, { width: 30000, height: 2, channels: 4, data: new Uint8Array(30000 * 2 * 4).fill(0).map((_, i) => i % 4 === 3 ? 255 : 0) }, at(-14000, 1000, 16000, 1002))!;
  assert.deepEqual([line.width, line.height, line.data.length], [48, 48, 48 * 48 * 3]);
  assert.deepEqual([...line.data.subarray((24 * 48 + 12) * 3, (24 * 48 + 12) * 3 + 3)], [0, 0, 0]);  // on the line
  assert.notDeepEqual([...line.data.subarray((24 * 48 + 4) * 3, (24 * 48 + 4) * 3 + 3)], [0, 0, 0]); // beside the canvas: checker
  assert.deepEqual([...line.data.subarray(0, 3)], [255, 255, 255]);                         // checkerboard
  // half-transparent red over the checker, placed where it sits: right half of the canvas
  const red = frameThumb(canvas, 48, { width: 2, height: 2, channels: 4, data: new Uint8Array(16).map((_, i) => [255, 0, 0, 128][i % 4]) }, at(500, 0, 1000, 2000))!;
  assert.deepEqual([...red.data.subarray(0, 3)], [255, 255, 255]);            // left half: checker
  assert.deepEqual([...red.data.subarray(24 * 3, 24 * 3 + 3)], [255, 127, 127]); // right half: red over white
  // a mask (gray): outside white, inside as read
  const m = frameThumb({ width: 4, height: 4 }, 48, { width: 2, height: 2, channels: 1, data: new Uint8Array(4) }, at(0, 0, 2, 2), true)!;
  assert.deepEqual([m.width, m.height], [4, 4]);
  assert.deepEqual([...m.data.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...m.data.subarray(3 * 3, 3 * 3 + 3)], [255, 255, 255]);
  // nothing or too little data, or no area: no picture
  assert.equal(frameThumb(canvas, 48, { width: 0, height: 4, channels: 3, data: new Uint8Array(0) }, at(0, 0, 1, 1)), null);
  assert.equal(frameThumb(canvas, 48, { width: 10, height: 10, channels: 4, data: new Uint8Array(10) }, at(0, 0, 1, 1)), null);
  assert.equal(frameThumb(canvas, 48, { width: 1, height: 1, channels: 3, data: new Uint8Array(3) }, at(5, 5, 5, 9)), null);
});

test("shaped thumbnails take the area's own shape (an artboard / the canvas, as in Photoshop)", () => {
  const at = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b });
  const black = (w: number, h: number) => ({ width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3) });
  // a 1920 × 1080 artboard at (2000, 0): 48 × 27, the layer's left half of it black
  const wide = frameThumb({ width: 1920, height: 1080, left: 2000, top: 0 }, 48, black(2, 2), at(2000, 0, 2960, 1080), false, true)!;
  assert.deepEqual([wide.width, wide.height], [48, 27]);
  assert.deepEqual([...wide.data.subarray(0, 3)], [0, 0, 0]);                     // left: the layer
  assert.notDeepEqual([...wide.data.subarray(47 * 3, 47 * 3 + 3)], [0, 0, 0]);    // right: checker
  // a tall canvas: tall picture
  const tall = frameThumb({ width: 1000, height: 2000 }, 48, black(1, 1), at(0, 0, 1000, 2000), false, true)!;
  assert.deepEqual([tall.width, tall.height], [24, 48]);
});

test("a layer's thumbnail shows its own bounds, a thin one widened to at most 4 : 1", () => {
  assert.deepEqual(thumbArea({ left: 10, top: 20, right: 110, bottom: 70 }), { left: 10, top: 20, right: 110, bottom: 70 });
  // a 1000 × 2 line: read as 1000 × 250, centred on it
  assert.deepEqual(thumbArea({ left: 0, top: 100, right: 1000, bottom: 102 }), { left: 0, top: -24, right: 1000, bottom: 226 });
  assert.deepEqual(thumbArea({ left: 0, top: 0, right: 2, bottom: 800 }), { left: -99, top: 0, right: 101, bottom: 800 });
  assert.equal(thumbArea({ left: 0, top: 0, right: 0, bottom: 5 }), null);
  // framed over that area: the line fills the width, as a thin band in the middle of the square
  const area = thumbArea({ left: 0, top: 100, right: 1000, bottom: 102 })!;
  const t = frameThumb({ width: 1000, height: 250, left: area.left, top: area.top }, 48, { width: 48, height: 1, channels: 4, data: new Uint8Array(48 * 4).map((_, i) => i % 4 === 3 ? 255 : 0) }, { left: 0, top: 100, right: 1000, bottom: 102 })!;
  assert.deepEqual([t.width, t.height], [48, 48]);
  const row = (y: number) => [...t.data.subarray(y * 48 * 3, y * 48 * 3 + 3)];
  assert.deepEqual(row(23), [0, 0, 0]);      // the line, black
  assert.notDeepEqual(row(0), [0, 0, 0]);    // checkerboard above it
});
