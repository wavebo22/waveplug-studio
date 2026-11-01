import { test } from "node:test";
import assert from "node:assert/strict";
import { lineName, onlyLine, textLines } from "../src/core/layers/text.ts";

test("按行拆分: paragraphs and forced line breaks are lines; blank ones are skipped", () => {
  const text = "限时特惠\r\r全场 8 折\u0003仅此三天";
  assert.deepEqual(textLines(text), [{ index: 0, text: "限时特惠" }, { index: 2, text: "全场 8 折" }, { index: 3, text: "仅此三天" }]);
  assert.deepEqual(textLines("一行"), [{ index: 0, text: "一行" }]);
});

test("按行拆分: one line kept in place, the others emptied but their breaks kept", () => {
  const text = "A\rBB\u0003CCC";
  assert.equal(onlyLine(text, 0), "A\r\u0003");
  assert.equal(onlyLine(text, 1), "\rBB\u0003");
  assert.equal(onlyLine(text, 2), "\r\u0003CCC");
  const long = lineName("  很长很长".repeat(10));
  assert.ok(long.length <= 41 && long.endsWith("长…"));
  assert.equal(lineName(" 全场  8 折 "), "全场 8 折");
});
