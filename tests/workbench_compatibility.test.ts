import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkbenchPlaceError, collectWorkbenchCompatibility, explainCompatibilityWarnings, explainWorkbenchError,
} from "../src/core/layers/workbenchCompatibility.ts";

test("兼容性提示：RGB 到 CMYK 以及 8→16 位、不同色彩配置文件，只提醒不认定失败", () => {
  const rgb = { id: 1, mode: "RGB", bitsPerChannel: "8", colorProfileName: "sRGB" };
  const cmyk = { id: 2, mode: "CMYK", bitsPerChannel: "16", colorProfileName: "Coated FOGRA39" };
  const notes = collectWorkbenchCompatibility(rgb, cmyk, "标题.psd");
  assert.deepEqual(notes.map(x => x.code), ["COLOR_MODE", "BIT_DEPTH", "COLOR_PROFILE"]);
  assert.match(notes[0].detail, /RGB → CMYK/);
  assert.match(notes[1].detail, /8 位 → 16 位/);
  const diagnosis = explainCompatibilityWarnings(notes);
  assert.equal(diagnosis?.level, "warning");
  assert.match(diagnosis!.reason, /标题.psd/);
  assert.match(diagnosis!.advice, /不代表复制失败/);
});

test("兼容性提示：同模式同位深同配置无提示；未知或 getter 异常的字段不妄报风险", () => {
  const same = { mode: "RGB", bitsPerChannel: 8, colorProfileName: "sRGB" };
  assert.deepEqual(collectWorkbenchCompatibility(same, { ...same }, "A.psd"), []);
  assert.deepEqual(collectWorkbenchCompatibility(same, same, "A.psd"), []);
  const unknown = { mode: undefined, get bitsPerChannel() { throw Error("API denied"); } };
  assert.deepEqual(collectWorkbenchCompatibility(unknown, { mode: "CMYK", bitsPerChannel: 16 }, "B.psd"), []);
  assert.equal(explainCompatibilityWarnings([]), null);
});

test("已确认的复制失败原因与操作建议要同时显示，原始技术错误单独保存", () => {
  const error = new WorkbenchPlaceError("COPY_NO_OUTPUT",
    "Photoshop 没有在 CMYK 文档生成「色相/饱和度 1」。具体不兼容原因尚未确定。",
    "请先单独测试这个图层，必要时在目标文档重建调整图层。",
    "batchPlay: duplicate unavailable");
  const message = explainWorkbenchError(error);
  assert.equal(message.level, "error");
  assert.match(message.title, /未生成目标图层/);
  assert.match(message.reason, /色相\/饱和度 1/);
  assert.match(message.advice, /重建调整图层/);
  assert.equal(message.details, "batchPlay: duplicate unavailable");
});

test("未分类 Photoshop 异常：不能直接误判为颜色模式不兼容", () => {
  const message = explainWorkbenchError(new TypeError("Cannot read properties of undefined (reading 'map')"));
  assert.equal(message.level, "error");
  assert.match(message.title, /原因待确认/);
  assert.match(message.reason, /尚不能确定/);
  assert.match(message.details ?? "", /reading 'map'/);
});
