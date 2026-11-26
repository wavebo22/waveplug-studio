import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIssues, checkSummary, parseCheckAction } from "../src/core/overlay/checkPanel.ts";
import { unionShapes } from "../src/core/overlay/hoverFrame.ts";
import type { Issue } from "../src/core/check/rules.ts";

const issue = (key: string, category: Issue["category"], severity: Issue["severity"], extra: Partial<Issue> = {}): Issue =>
  ({ key, category, severity, title: key, detail: "", ids: [1], ...extra });

test("检查结果窗口：按类别、再按严重程度排；处理中 / 已处理替换按钮", () => {
  const list = [issue("h", "hygiene", "info"), issue("f2", "font", "warn"), issue("f1", "font", "error"),
    issue("s", "smart", "warn", { fix: { kind: "shrinkSmart", ids: [1] }, fixLabel: "按显示大小重做" }), issue("v", "visual", "warn", { ids: [] })];
  const out = checkIssues(list, new Map([["f1", "已处理"]]));
  assert.deepEqual(out.map(i => i.key), ["f1", "f2", "s", "v", "h"]);
  assert.equal(out[0].state, "已处理");
  assert.equal(out[2].fix, "按显示大小重做");
  assert.equal(out[3].pick, false);
  assert.equal(out[0].cat, "字体");
});

test("摘要只数还没处理的", () => {
  const list = [issue("a", "font", "error"), issue("b", "font", "warn"), issue("c", "text", "warn")];
  assert.equal(checkSummary(list, new Map([["a", "已处理"]])), "2 个警告");
  assert.equal(checkSummary(list, new Map([["a", "已处理"], ["b", "已处理"], ["c", "已处理"]])), "都处理好了");
  assert.equal(checkSummary([], new Map()), "没有发现问题");
});

test("窗口发来的操作逐个检查", () => {
  assert.deepEqual(parseCheckAction({ kind: "hover", key: null }), { kind: "hover", key: null });
  assert.deepEqual(parseCheckAction({ kind: "hover", key: "font:x" }), { kind: "hover", key: "font:x" });
  assert.deepEqual(parseCheckAction({ kind: "opt", name: "visual", on: true }), { kind: "opt", name: "visual", on: true });
  assert.equal(parseCheckAction({ kind: "opt", name: "evil", on: true }), null);
  assert.equal(parseCheckAction({ kind: "fix" }), null);
  assert.deepEqual(parseCheckAction({ kind: "close" }), { kind: "close" });
});

test("几个图层的形状合成一个高亮", () => {
  const a = { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, width: 1, height: 1, alpha: new Uint8Array([255]) };
  const b = { bounds: { left: 30, top: 0, right: 40, bottom: 10 }, width: 1, height: 1, alpha: new Uint8Array([128]) };
  const u = unionShapes([a, b], 40)!;
  assert.deepEqual(u.bounds, { left: 0, top: 0, right: 40, bottom: 10 });
  assert.equal(u.width, 40);
  assert.equal(u.height, 10);
  assert.equal(u.alpha[5], 255);   // inside a
  assert.equal(u.alpha[20], 0);    // the gap
  assert.equal(u.alpha[35], 128);  // inside b
  assert.equal(unionShapes([a]), a);
  assert.equal(unionShapes([]), null);
});
