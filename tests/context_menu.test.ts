import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawLayer, buildTree, contentUsers, layerMenu } from "../src/core/layers/tree.ts";
import { contextMenu, contextTitle, menuIds } from "../src/core/layers/contextMenu.ts";
import { type MenuNode, parseOverlayEvent } from "../src/core/overlay/protocol.ts";

const px = { width: 10, height: 10 };
const raw = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer =>
  ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, ...px, ...extra });
const end = (): RawLayer => ({ id: 0, name: "</Layer group>", kind: 13, section: "end", visible: true, locked: false, mask: false });
const COLORS = [["red", "红色"], ["blue", "蓝色"]] as const;

// 标题 | 组 { 徽章, 徽章 拷贝 } | 外链 | 图 | 背景
const tree = () => buildTree([
  raw(1, "标题", 3, { color: "red" }),
  raw(20, "组", 7), raw(21, "徽章", 5, { contentId: "a", file: "徽章.psb" }), raw(22, "徽章 拷贝", 5, { contentId: "a", file: "徽章.psb" }), end(),
  raw(3, "外链", 5, { contentId: "b", file: "b.png", linked: true }), raw(4, "图", 1),
  raw(9, "背景", 1, { background: true, locked: true, lockAll: true }),
]);
const menu = (smartTools: boolean, ...ids: number[]) => {
  const layers = tree();
  return contextMenu({ layers, selected: new Set(ids), users: contentUsers(layers), smartTools, colors: COLORS });
};
const top = (items: MenuNode[]) => items.map(i => i.separator ? "-" : i.children ? i.label + " ▶" : i.label);
const find = (items: MenuNode[], label: string) => items.find(i => i.label === label)!;

test("右键菜单: a title, everyday commands, the rest in submenus by subject", () => {
  const m = menu(true, 4);
  assert.equal(m.title, "图 · 像素图层");
  assert.deepEqual(top(m.items), [
    "混合选项…", "重命名图层…", "复制图层", "删除图层", "-",
    "从图层新建组", "合并 ▶", "转换 ▶", "排列 ▶", "对齐 ▶", "分布 ▶", "-",
    "蒙版 ▶", "创建剪贴蒙版", "图层样式 ▶", "-",
    "锁定全部", "只显示此图层", "图层颜色 ▶", "-",
    "选择 ▶", "导出 ▶",
  ]);
  assert.equal(find(m.items, "复制图层").hint, "Ctrl+J");
  // one layer: 对齐 needs two
  assert.equal(find(m.items, "对齐").enabled, false);
  assert.deepEqual(find(m.items, "排列").children!.map(c => [c.label, c.hint, c.enabled]), [
    ["置为顶层", "Shift+Ctrl+]", true], ["前移一层", "Ctrl+]", true], ["后移一层", "Ctrl+[", false], ["置为底层", "Shift+Ctrl+[", false],
  ]);
});

test("右键菜单: every command of the flat menu that applies is in the tree, none twice", () => {
  for (const [tools, ids] of [[true, [4]], [true, [21]], [false, [21]], [true, [1, 4]], [true, [20]], [true, [9]], [true, [3]]] as [boolean, number[]][]) {
    const layers = tree(), m = menu(tools, ...ids), all = menuIds(m.items);
    assert.equal(new Set(all).size, all.length, JSON.stringify(ids));
    const acts = new Set(all.filter(i => i.startsWith("act:")).map(i => i.slice(4)));
    const missing = layerMenu(layers.filter(l => ids.includes(l.id))).filter(x => x !== "-" && x.enabled && !acts.has(x.action))
      // without the 工具 page the smart-object tools aren't offered; 取消链接 only with a link
      .filter(x => x !== "-" && !(x.action === "unlink") && !(!tools && ["makeUnique", "selectSameSource", "makeEditable", "unpack"].includes(x.action)));
    assert.deepEqual(missing, [], JSON.stringify(ids));
  }
});

test("右键菜单 › 智能对象: WavePlug's tools first, status in the title", () => {
  const m = menu(true, 21);
  assert.equal(m.title, "徽章 · PSB · 链接×2");
  assert.equal(top(m.items)[0], "智能对象 ▶");
  assert.deepEqual(top(find(m.items, "智能对象").children!), [
    "编辑智能对象内容", "选中同源的智能对象", "断开共用，成为独立内容", "转为可编辑的 PSB", "-",
    "替换内容…", "导出内容…", "解包图层", "重置变换", "-",
    "通过拷贝新建智能对象", "转换为链接对象…", "链接到已有文件…",
  ]);
  // already an editable PSB: nothing to convert; shared by two: can be selected and split
  const so = find(m.items, "智能对象").children!;
  assert.equal(find(so, "转为可编辑的 PSB").enabled, false);
  assert.equal(find(so, "选中同源的智能对象").enabled, true);
  // not a smart object: no such submenu
  assert.ok(!top(menu(true, 4).items).includes("智能对象 ▶"));
  assert.equal(contextTitle([], new Map()), "图层");
  assert.equal(menu(true, 1, 4).title, "已选 2 个图层");
});

test("右键菜单 › 图层颜色: the current label ticked; 选择 says how many", () => {
  const colors = find(menu(true, 1).items, "图层颜色").children!;
  assert.deepEqual(colors.filter(c => c.checked).map(c => c.id), ["color:red"]);
  assert.equal(colors[colors.length - 1].id, "color:custom");
  const select = find(menu(true, 1).items, "选择").children!;
  assert.match(select.find(c => c.id === "select:all")!.label!, /所有图层（\d+）/);
});

test("menu-result from the helper: the picked row or null", () => {
  assert.deepEqual(parseOverlayEvent('{"type":"menu-result","menuId":"m3","item":"act:rename"}'), { type: "menu-result", menuId: "m3", item: "act:rename" });
  assert.deepEqual(parseOverlayEvent('{"type":"menu-result","menuId":"m3","item":null}'), { type: "menu-result", menuId: "m3", item: null });
  assert.equal(parseOverlayEvent('{"type":"menu-result","item":"x"}'), null);
  assert.equal(parseOverlayEvent('{"type":"menu-result","menuId":"m3","item":7}'), null);
});

test("右键菜单 › 转换: the 工具 page's tools, only for layers they work on", () => {
  const rows = (tools: boolean, ...ids: number[]) => new Map(find(menu(tools, ...ids).items, "转换").children!.filter(c => c.id).map(c => [c.id!, c.enabled !== false]));
  const text = rows(true, 1), pixel = rows(true, 4), two = rows(true, 1, 4);
  assert.deepEqual([text.get("tool:textLines"), text.get("tool:trim"), text.get("tool:islands")], [true, false, false]);
  assert.deepEqual([pixel.get("tool:textLines"), pixel.get("tool:trim"), pixel.get("tool:islands")], [false, true, true]);
  // 分别转换 only makes sense for several layers
  assert.equal(pixel.has("act:convertSeparately"), false);
  assert.equal(two.get("act:convertSeparately"), true);
  // without the 工具 page's host none of them is offered
  assert.ok(![...rows(false, 1, 4).keys()].some(k => k.startsWith("tool:") || k === "act:convertSeparately"));
});

test("从网页拖入: web-drop / web-drop-leave from the helper", () => {
  assert.deepEqual(parseOverlayEvent('{"type":"web-drop-leave"}'), { type: "web-drop-leave" });
  assert.deepEqual(parseOverlayEvent('{"type":"web-drop","files":[{"file":"w.png","name":"猫"},{"file":"..\\\\x.png","name":"bad"},{"file":"","name":"e"}],"html":"<img>","text":"","url":"u","formats":["PNG",3]}'),
    { type: "web-drop", files: [{ file: "w.png", name: "猫" }], html: "<img>", text: "", url: "u", formats: ["PNG"] });
  assert.equal(parseOverlayEvent('{"type":"web-drop"}'), null);
});

test("WavePlug 程序的功能设置: only known keys, right kinds", async () => {
  const { appSettingChanges, appSettingsOf } = await import("../src/core/overlay/protocol.ts");
  assert.deepEqual(appSettingChanges({ perfMonitor: false, comfyUrl: " http://127.0.0.1:8188 ", hangGuard: "yes", evil: true }), { perfMonitor: false, comfyUrl: "http://127.0.0.1:8188" });
  const view = appSettingsOf({ perfMonitor: false, comfyUrl: "u" });
  assert.equal(view.perfMonitor, false);
  assert.equal(view.hangGuard, true);
  assert.equal(view.comfyLaunch, "");
  assert.deepEqual(parseOverlayEvent('{"type":"app-settings-set","changes":{"hangAutoBackup":false}}'), { type: "app-settings-set", changes: { hangAutoBackup: false } });
});

test("右键菜单: AI 整理 only when the AI assistant is available, after 编组", () => {
  const layers = tree();
  const ids = (assistant: boolean) => menuIds(contextMenu({ layers, selected: new Set([4]), users: contentUsers(layers), smartTools: true, colors: COLORS, assistant }).items);
  assert.ok(ids(true).includes("assist:organize"));
  assert.ok(!ids(false).includes("assist:organize"));
});
