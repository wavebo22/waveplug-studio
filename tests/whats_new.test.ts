import { test } from "node:test";
import assert from "node:assert/strict";
import { type Change, describe, unseenChanges, userVisible } from "../src/core/whatsNew.ts";

const c = (hash: string, subject: string, body = ""): Change => ({ hash, date: "2026-11-19T10:00:00+08:00", subject, body });
const log = [c("e", "fix: 修好扩图边缘"), c("d", "docs: 规格"), c("b", "feat: 生图面板可加 LoRA", "可选文件、调强度\n\nCo-Authored-By: Claude <x@y>"), c("a", "poc: 实验")];

test("only the commits after the last seen one, without docs / poc", () => {
  assert.deepEqual(unseenChanges(log, "b").map(x => x.hash), ["e"]);
  assert.deepEqual(unseenChanges(log, "e"), []);
  assert.deepEqual(unseenChanges(log, null).map(x => x.hash), ["e", "b"]);
  assert.deepEqual(unseenChanges(log, "zzz").map(x => x.hash), ["e", "b"]);
  assert.deepEqual(unseenChanges([], null), []);
});

test("subjects read as 新功能 / 修复 and drop attribution lines", () => {
  assert.deepEqual(describe(log[2]), { kind: "新功能", text: "生图面板可加 LoRA", detail: ["可选文件、调强度"] });
  assert.equal(describe(log[0]).kind, "修复");
  assert.deepEqual(describe(c("x", "内置工作流：改用 JSON 复制")), { kind: "改动", text: "内置工作流：改用 JSON 复制", detail: [] });
  assert.equal(userVisible(c("x", "built-in workflows: JSON copy")), false);
  assert.equal(userVisible(c("x", "chore(release): 1.3.3")), false);
  assert.deepEqual(describe(c("x", "feat: y", "第一段，\n接着写\nmore words\nhere\n\n- 一条\n- 两条")).detail, ["第一段，接着写 more words here", "- 一条", "- 两条"]);
});
