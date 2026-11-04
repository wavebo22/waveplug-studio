import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, contentUsers, smartQuickMenu, type RawLayer } from "../src/core/layers/tree.ts";

const smart = (id: number, name: string, contentId: string, file: string, linked = false, locked = false): RawLayer => ({
  id, name, kind: 5, section: "content", visible: true, locked, mask: false,
  contentId, linked, file,
});
const normal: RawLayer = {
  id: 10, name: "普通图层", kind: 1, section: "content", visible: true, locked: false, mask: false,
};
const layers = buildTree([
  smart(1, "PNG智能对象", "shared", "product.PNG"),
  smart(2, "共享副本", "shared", "product.png"),
  smart(3, "PSB对象", "independent", "art.psb"),
  smart(4, "外部链接", "external", "logo.ai", true),
  smart(5, "锁定共享", "shared", "product.png", false, true),
  normal,
]);
const users = contentUsers(layers);
const layer = (id: number) => layers.find(l => l.id === id)!;

test("仅在智能对象右键展示状态侧栏，普通图层没有", () => {
  assert.equal(smartQuickMenu([layer(10)], users), null);
  assert.equal(smartQuickMenu([], users), null);
});

test("去除转换、分别转换、复制、类型、同源等重复 icon，仅留四项专用操作", () => {
  const panel = smartQuickMenu([layer(1)], users)!;
  assert.deepEqual(panel.actions.map(x => x.action), [
    "replaceContents", "exportContents", "unpack", "resetTransform",
  ]);
  assert.deepEqual(new Set(panel.actions.map(x => x.icon)).size, 4);
  assert.ok(panel.actions.every(x => x.enabled && x.hint.length > 12));
  assert.equal(panel.actions.length, 4);
});

test("PNG 不可编辑智能对象类型入口可转 PSB；PSB、PSD 状态不重复转换", () => {
  const png = smartQuickMenu([layer(1)], users)!;
  assert.equal(png.type.value, "PNG");
  assert.equal(png.type.tone, "content");
  assert.equal(png.type.enabled, true);
  assert.equal(png.type.action, "makeEditable");
  assert.equal(smartQuickMenu([layer(3)], users)!.type.value, "PSB");
  assert.equal(smartQuickMenu([layer(3)], users)!.type.tone, "edit");
  assert.equal(smartQuickMenu([layer(3)], users)!.type.enabled, false);
  assert.equal(smartQuickMenu([layer(3)], users)!.type.action, undefined);
});

test("共用数量：单击查找同源、双击独立；独立和外部链接不可误断开", () => {
  const shared = smartQuickMenu([layer(1)], users)!;
  assert.equal(shared.shared.value, "链接×3");
  assert.equal(shared.shared.tone, "shared");
  assert.equal(shared.shared.action, "selectSameSource");
  assert.equal(shared.shared.doubleAction, "makeUnique");
  const alone = smartQuickMenu([layer(3)], users)!;
  assert.equal(alone.shared.value, "独立");
  assert.equal(alone.shared.tone, "own");
  assert.equal(alone.shared.enabled, false);
  assert.equal(alone.shared.doubleAction, undefined);
  const ext = smartQuickMenu([layer(4)], users)!;
  assert.equal(ext.shared.value, "外链");
  assert.equal(ext.shared.tone, "link");
  assert.equal(ext.shared.enabled, false);
  assert.equal(ext.shared.doubleAction, undefined);
  assert.equal(ext.type.enabled, true);
  const locked = smartQuickMenu([layer(5)], users)!;
  assert.equal(locked.shared.enabled, true); // may still select the shared sources
  assert.equal(locked.shared.doubleAction, undefined); // cannot copy a locked layer
});

test("多选状态入口不可误操作，批量专用图标保持可用", () => {
  const selected = [layer(1), layer(2), layer(10)];
  const before = selected.map(x => x.id);
  const panel = smartQuickMenu(selected, users)!;
  assert.equal(panel.type.enabled, false);
  assert.equal(panel.type.value, "多选");
  assert.equal(panel.type.tone, "mask");
  assert.equal(panel.shared.enabled, false);
  assert.equal(panel.shared.value, "多选");
  assert.equal(panel.shared.action, undefined);
  assert.equal(panel.shared.doubleAction, undefined);
  assert.ok(panel.actions.every(x => x.enabled));
  assert.deepEqual(selected.map(x => x.id), before);
});
