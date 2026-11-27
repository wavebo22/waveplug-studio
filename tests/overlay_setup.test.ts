import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetupAction } from "../src/core/overlay/setupPanel.ts";
import { type Issue, filterIssues } from "../src/core/check/rules.ts";

test("设置面板发来的操作逐个检查", () => {
  assert.deepEqual(parseSetupAction({ kind: "set", key: "cat:font", value: false }), { kind: "set", key: "cat:font", value: false });
  assert.deepEqual(parseSetupAction({ kind: "set", key: "extra", value: "按钮统一叫" }), { kind: "set", key: "extra", value: "按钮统一叫" });
  assert.equal(parseSetupAction({ kind: "set", key: "bad key!", value: true }), null);
  assert.equal(parseSetupAction({ kind: "set", key: "x", value: 3 }), null);
  assert.deepEqual(parseSetupAction({ kind: "start" }), { kind: "start" });
  assert.deepEqual(parseSetupAction({ kind: "close" }), { kind: "close" });
  assert.equal(parseSetupAction({ kind: "go" }), null);
});

test("检查设置：只留勾选的类别；只查选中图层时去掉和它们无关的、整个文件的问题", () => {
  const i = (key: string, category: Issue["category"], ids: number[]): Issue => ({ key, category, severity: "warn", title: key, detail: "", ids });
  const all = [i("font", "font", [1]), i("ppi", "delivery", []), i("empty", "hygiene", [2, 3]), i("copy", "copy", [3])];
  assert.deepEqual(filterIssues(all, new Set(["font", "delivery", "hygiene", "copy"]), null).map(x => x.key), ["font", "ppi", "empty", "copy"]);
  assert.deepEqual(filterIssues(all, new Set(["font", "hygiene", "copy"]), null).map(x => x.key), ["font", "empty", "copy"]);
  assert.deepEqual(filterIssues(all, new Set(["font", "delivery", "hygiene", "copy"]), new Set([3])).map(x => x.key), ["empty", "copy"]);
});
