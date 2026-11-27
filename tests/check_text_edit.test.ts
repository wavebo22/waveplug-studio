import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceInTextKey } from "../src/core/check/textEdit.ts";

const key = (text: string, runs: [number, number, string][]) => ({
  _obj: "textLayer", textKey: text, transform: { xx: 1 }, textClickPoint: { horizontal: 10 },
  textStyleRange: runs.map(([from, to, font]) => ({ _obj: "textStyleRange", from, to, textStyle: { fontPostScriptName: font } })),
  paragraphStyleRange: [{ _obj: "paragraphStyleRange", from: 0, to: text.length + 1, paragraphStyle: { align: "center" } }],
});
const runs = (k: any) => k.textStyleRange.map((r: any) => [r.from, r.to, r.textStyle.fontPostScriptName]);

test("改一个词：后面的样式段跟着移动，前面的不动，位置和变换原样保留", () => {
  // 「欢迎」A「登陆会员」B「中心」C
  const k = key("欢迎登陆会员中心", [[0, 2, "A"], [2, 6, "B"], [6, 8, "C"]]);
  const r: any = replaceInTextKey(k, "登陆", "登录账号")!;
  assert.equal(r.textKey, "欢迎登录账号会员中心");
  assert.deepEqual(runs(r), [[0, 2, "A"], [2, 8, "B"], [8, 10, "C"]]);
  assert.equal(r.paragraphStyleRange[0].to, 11);
  assert.deepEqual(r.transform, { xx: 1 });
  assert.deepEqual(r.textClickPoint, { horizontal: 10 });
  assert.equal(k.textKey, "欢迎登陆会员中心", "the input is not changed");
});

test("替换跨两段：新字用第一段的样式；整段被吞掉的去掉", () => {
  const k = key("ABCDEF", [[0, 2, "A"], [2, 3, "B"], [3, 6, "C"]]);
  const r: any = replaceInTextKey(k, "BCD", "x")!;
  assert.equal(r.textKey, "Ax" + "EF");
  assert.deepEqual(runs(r), [[0, 2, "A"], [2, 4, "C"]]);
});

test("换行：\\n 和 Photoshop 的 \\r 都能对上；找不到原文时不改", () => {
  const k = key("第一行\r第二行", [[0, 7, "A"]]);
  assert.equal((replaceInTextKey(k, "一行\n第二", "1 行\n第 2") as any).textKey, "第1 行\r第 2行");
  assert.equal(replaceInTextKey(k, "没有", "x"), null);
});

test("整段改写：一个样式段时拉伸到新长度", () => {
  const k = key("立即购买", [[0, 4, "A"]]);
  const r: any = replaceInTextKey(k, "", "Buy now", true)!;
  assert.equal(r.textKey, "Buy now");
  assert.deepEqual(runs(r), [[0, 7, "A"]]);
  assert.equal(r.paragraphStyleRange[0].to, 8);
});
