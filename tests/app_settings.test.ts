import { test } from "node:test";
import assert from "node:assert/strict";
import { appSettingChanges, appSettingsOf, parseOverlayEvent } from "../src/core/overlay/protocol.ts";

test("功能设置搬到 WavePlug 程序：调试文件默认关，开发者开关不当设置发送", () => {
  const s = appSettingsOf({ comfyUrl: "http://127.0.0.1:8188" });
  assert.equal(s.debugFiles, false);
  assert.equal(s.perfMonitor, true);
  assert.equal("devLoad" in s, false);
  assert.equal(appSettingsOf({ debugFiles: true }).debugFiles, true);
});

test("程序发来的修改：开发者开关和调试文件是布尔，其他未知键丢掉", () => {
  assert.deepEqual(appSettingChanges({ devLoad: false, debugFiles: true, evil: 1, comfyUrl: 3 }), { devLoad: false, debugFiles: true });
});

test("导出诊断信息：只接受 Windows 路径", () => {
  assert.deepEqual(parseOverlayEvent(JSON.stringify({ type: "plugin-report", folder: "E:\\User\\desktop\\WavePlug诊断" })), { type: "plugin-report", folder: "E:\\User\\desktop\\WavePlug诊断" });
  assert.equal(parseOverlayEvent(JSON.stringify({ type: "plugin-report", folder: "../x" })), null);
});

test("Ctrl+F from the helper (hotkey.rs) is read as paste-in-place", () => {
  assert.deepEqual(parseOverlayEvent(JSON.stringify({ type: "paste-in-place" })), { type: "paste-in-place" });
});
