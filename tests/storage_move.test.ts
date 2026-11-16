import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVED_FLAG, dumpStorage, importPlan } from "../src/core/storageMove.ts";

const storage = (data: Record<string, string>) => {
  const keys = Object.keys(data);
  return { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => data[k] ?? null };
};

test("旧开发版数据：导出全部键，不带本机的加载方式和搬家标记", () => {
  const dump = dumpStorage(storage({ "wp.profiles": "[1]", "wp.settings": "{}", "wp.loadFrom": "bundled", [MOVED_FLAG]: "x" }));
  assert.deepEqual(dump, { "wp.profiles": "[1]", "wp.settings": "{}" });
});

test("新插件导入：只导入一次，坏文件不导入，只收字符串", () => {
  const text = JSON.stringify({ "wp.profiles": "[1]", "wp.devRoot": "X:/", n: 3 });
  assert.deepEqual(importPlan(text, false), [["wp.profiles", "[1]"]]);
  assert.deepEqual(importPlan(text, true), []);
  assert.deepEqual(importPlan("not json", false), []);
  assert.deepEqual(importPlan("[1,2]", false), []);
});
