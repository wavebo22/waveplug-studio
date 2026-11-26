import { test } from "node:test";
import assert from "node:assert/strict";
import { organizeItemIds, organizePlanSection, parseOrganizeAction } from "../src/core/overlay/organizePanel.ts";
import type { OrganizePlan } from "../src/core/assistant/organize.ts";

const plan: OrganizePlan = {
  renames: [{ id: 1, from: "图层 1", to: "标题" }, { id: 2, from: "图层 2", to: "按钮底" }],
  groups: [{ name: "按钮", ids: [2, 3], parentId: null }],
  dropped: ["「背景」不在整理范围内"],
};
const names: Record<number, string> = { 2: "按钮底", 3: "按钮文字" };

test("AI 整理窗口：改名和新组逐项列出，取消勾选的显示为未勾", () => {
  const p = organizePlanSection(plan, new Set([2]), new Set(), id => names[id] ?? `#${id}`);
  assert.deepEqual(p.renames.map(r => [r.key, r.on]), [["r:1", true], ["r:2", false]]);
  assert.equal(p.groups[0].members, "2 个：按钮底、按钮文字");
  assert.equal(p.dropped.length, 1);
  assert.deepEqual(organizePlanSection(null, new Set(), new Set(), String), { renames: [], groups: [], dropped: [] });
});

test("悬停一项：改名是它的图层，新组是组里的图层", () => {
  assert.deepEqual(organizeItemIds(plan, "r:1"), [1]);
  assert.deepEqual(organizeItemIds(plan, "g:0"), [2, 3]);
  assert.deepEqual(organizeItemIds(plan, "r:9"), []);
  assert.deepEqual(organizeItemIds(null, "g:0"), []);
});

test("窗口发来的操作逐个检查", () => {
  assert.deepEqual(parseOrganizeAction({ kind: "hover", key: null }), { kind: "hover", key: null });
  assert.deepEqual(parseOrganizeAction({ kind: "toggle", key: "g:0" }), { kind: "toggle", key: "g:0" });
  assert.equal(parseOrganizeAction({ kind: "toggle", key: "x" }), null);
  assert.deepEqual(parseOrganizeAction({ kind: "extra", text: "用英文" }), { kind: "extra", text: "用英文" });
  assert.deepEqual(parseOrganizeAction({ kind: "rename-only", on: true }), { kind: "rename-only", on: true });
  assert.equal(parseOrganizeAction({ kind: "rename-only" }), null);
  assert.deepEqual(parseOrganizeAction({ kind: "apply" }), { kind: "apply" });
});
