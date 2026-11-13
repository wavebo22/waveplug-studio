import { test } from "node:test";
import assert from "node:assert/strict";
import { RENAME_DEFAULTS, renameActive, renamePlan, renamed } from "../src/core/layers/batchRename.ts";

const L = [{ id: 1, name: "图层 1" }, { id: 2, name: "图层 2 拷贝" }, { id: 3, name: "Logo" }];
const o = (x: Partial<typeof RENAME_DEFAULTS>) => ({ ...RENAME_DEFAULTS, ...x });

test("批量重命名: find / replace, prefix and suffix; unchanged layers are left out", () => {
  assert.deepEqual(renamePlan(L, o({ find: " 拷贝", replace: "" })), [{ id: 2, from: "图层 2 拷贝", to: "图层 2" }]);
  assert.deepEqual(renamePlan(L, o({ find: "图层", replace: "按钮" })).map(x => x.to), ["按钮 1", "按钮 2 拷贝"]);
  assert.deepEqual(renamePlan(L, o({ prefix: "btn/", suffix: "@2x" })).map(x => x.to), ["btn/图层 1@2x", "btn/图层 2 拷贝@2x", "btn/Logo@2x"]);
  assert.deepEqual(renamePlan(L, o({})), []);
  assert.equal(renameActive(o({})), false);
});

test("批量重命名: one base name with a running number, in list order", () => {
  assert.deepEqual(renamePlan(L, o({ replace: "卡片", number: true })).map(x => x.to), ["卡片 01", "卡片 02", "卡片 03"]);
  assert.deepEqual(renamePlan(L, o({ number: true, start: 9, digits: 1 })).map(x => x.to), ["图层 1 9", "图层 2 拷贝 10", "Logo 11"]);
  assert.equal(renamed("a", 0, o({ number: true, start: 7, digits: 3 })), "a 007");
});

test("批量重命名: never an empty or over-long name", () => {
  assert.deepEqual(renamePlan([{ id: 1, name: "拷贝" }], o({ find: "拷贝", replace: "" })), []);
  assert.equal(renamed("x".repeat(300), 0, o({ suffix: "!" })).length, 255);
  assert.equal(renamed("a\nb", 0, o({ prefix: " " })), "a b");
});
