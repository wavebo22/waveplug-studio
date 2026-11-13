import { test } from "node:test";
import assert from "node:assert/strict";
import { crumb, diagnosticReport, explain, flushLog, log, logProblems, resetLog, setLogContext, setLogSink } from "../src/app/log.ts";

const quiet = <T>(fn: () => T): T => {
  const c = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { Object.assign(console, c); }
};

test("日志: a problem is written once with its likely cause and what came before it", async () => {
  resetLog();
  const lines: [string, string][] = [];
  setLogSink(async (line, level) => { lines.push([level, line]); });
  quiet(() => {
    crumb("右键菜单：act:deleteMask（1 个图层）");
    crumb("PS：删除图层蒙版");
    log("info", "layer menu", { native: true });
    log("warn", "layer command deleteMask", new Error("命令“删除”当前不可用。"));
    log("warn", "layer command deleteMask", new Error("命令“删除”当前不可用。"));
  });
  await flushLog();
  assert.equal(lines.length, 3);
  assert.equal(lines[0][0], "info");
  const first = lines[1][1], again = lines[2][1];
  assert.match(first, /\[warn\] layer command deleteMask Error: 命令“删除”当前不可用/);
  assert.match(first, /原因：Photoshop 拒绝了这个命令/);
  assert.match(first, /之前的操作：.*右键菜单：act:deleteMask.* → .*PS：删除图层蒙版/);
  // the same problem again: the line only, counted
  assert.doesNotMatch(again, /原因：/);
  const p = logProblems();
  assert.equal(p.length, 1);
  assert.equal(p[0].count, 2);
});

test("日志: errors keep their fields, stack and cause; the same message with other numbers is one problem", () => {
  resetLog();
  const lines: string[] = [];
  setLogSink(async line => { lines.push(line); });
  quiet(() => {
    const inner = new Error("XHR 网络错误（status 0）");
    const outer = Object.assign(new Error("无法连接 ComfyUI"), { detail: { url: "http://127.0.0.1:8188" }, cause: inner });
    log("error", "connect failed", outer);
    log("warn", "tools inspect", new Error("The 图层 with an id of 68 does not exist."));
    log("warn", "tools inspect", new Error("The 图层 with an id of 135 does not exist."));
  });
  const p = logProblems();
  assert.equal(p.length, 2);
  assert.match(p[0].text, /detail=\{"url":"http:\/\/127\.0\.0\.1:8188"\}/);
  assert.match(p[0].text, /caused by Error: XHR 网络错误/);
  assert.match(p[0].cause!, /连不上 ComfyUI/);
  assert.equal(p[1].count, 2);
  assert.match(p[1].cause!, /已经不在了/);
});

test("日志: known causes, and null for what isn't known", () => {
  assert.match(explain("Error: 连接 ComfyUI 超时（6 秒无响应）")!, /超时/);
  assert.match(explain("TypeError: Cannot read properties of undefined (reading 'x')")!, /插件自身的错误/);
  assert.match(explain("overlay helper outdated: rebuild native/overlay")!, /外置框架/);
  assert.match(explain("Error: 当前文档已切换，已取消操作以防误删其他 PSD")!, /切换了文档/);
  assert.equal(explain("something nobody has seen before"), null);
});

test("诊断报告: environment, each problem once, the last actions and the log", () => {
  resetLog();
  setLogContext({ 插件版本: "1.1.0", Photoshop: "Photoshop 27.10" });
  setLogContext({ 外置框架: "0.8.0" });
  quiet(() => {
    crumb("工具：批量重命名");
    log("info", "batch rename 3 of 3");
    log("error", "mount failed", new Error("boom"));
    for (let i = 0; i < 3; i++) log("warn", "photoshop refused delete", { message: "命令“删除”当前不可用。" });
  });
  const r = diagnosticReport(Date.UTC(2026, 10, 12, 21, 0));
  assert.match(r, /^WavePlug Studio 诊断报告\n生成时间：2026-11-12T21:00:00\.000Z/);
  assert.match(r, /插件版本: 1\.1\.0\nPhotoshop: Photoshop 27\.10\n外置框架: 0\.8\.0/);
  assert.match(r, /== 问题（1 种错误，1 种警告）==/);
  // errors first; the repeated warning once, with its count
  assert.ok(r.indexOf("[错误] ×1") < r.indexOf("[警告] ×3"));
  assert.match(r, /原因：未归类/);
  assert.match(r, /== 最近的操作 ==\n\S+ 工具：批量重命名/);
  assert.match(r, /== 最近的日志（5 行）==/);
  resetLog();
  assert.match(diagnosticReport(), /本次运行没有记录到错误或警告/);
});
