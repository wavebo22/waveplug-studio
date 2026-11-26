// 文档检查 (WavePlug 图层 panel's 检查 button): the local checks (core/check/rules.ts) and, when ticked,
// DeepSeek's copy and picture checks (core/check/ai.ts), shown in the helper's 检查结果 window beside
// the panel (core/overlay/checkPanel.ts). Hovering an issue lights its layers up in the panel and on
// the canvas; a click selects them; a fix is one undo step.
//
// The list follows the document: whenever Photoshop's history moves (an edit, a fix, Ctrl+Z) the
// local checks run again. A fixed issue that is gone stays listed as 已处理; one that comes back
// (the fix was undone) is open again. Copy suggestions are checked against the text itself.

import type { Overlay } from "../app/overlay.ts";
import type { DocChecker, LayerTools, LayerTree } from "../ps/host.ts";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import { type CheckDoc, type Issue, runChecks } from "../core/check/rules.ts";
import { COPY_SYSTEM, VISUAL_SYSTEM, copyPrompt, parseCopyIssues, parseVisualIssues } from "../core/check/ai.ts";
import { CHECK_PANEL, type CheckAction, type CheckSections, checkIssues, checkSummary, parseCheckAction } from "../core/overlay/checkPanel.ts";
import { log, withTimeout } from "../app/log.ts";
import { h } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

export interface DocCheckDeps {
  overlay?: Overlay;
  checker: DocChecker;
  tree: LayerTree;
  tools?: LayerTools;
  docId(): number | null;
  /** Photoshop's history state of the document: the list is checked again when it moves */
  docVersion?(docId: number): string | null;
  status: Status;
  refresh(): void;
  fetch: typeof fetch;
  settings(): { key: string; model: string };
  /** the whole picture as a PNG data URL, at most `maxEdge` px a side (看画面) */
  composite?(docId: number, maxEdge: number): Promise<string>;
  /** light up these layers in the issue's colour (null: none) */
  mark(ids: number[], sev: Issue["severity"] | null): void;
  /** the window is about to show 检查结果: whatever else it showed (AI 整理) closes */
  opening?(): void;
}

const COPY_KEY = "wp.check.copy", VISUAL_KEY = "wp.check.visual";
const TIMEOUT_MS = 180_000;
/** history moves come in bursts: check once it has been quiet this long */
const RECHECK_MS = 700;
const flag = (k: string, def: boolean) => { try { return (localStorage.getItem(k) ?? (def ? "on" : "off")) === "on"; } catch { return def; } };
const keep = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? "on" : "off"); } catch { /* not kept */ } };

export function createDocCheck(d: DocCheckDeps) {
  const button = h("button", { class: "lt-head-btn", title: "文档检查：缺失字体、太大或发糊的智能对象、丢失的链接、CMYK 文件的印刷设置（分辨率、出血和安全边距、四色黑、过小的字）、可能超出文本框的文字、占位文字、图层整洁、颜色 / 字号 / 间距是否统一；可选让 DeepSeek 检查文案和看画面。结果显示在图层面板左边的窗口里，鼠标停在一条上，相关图层在面板和画面上用红色 / 黄色标出；点了按钮才会修改，撤销后状态跟着恢复" }, "检查");

  let open = false, docId: number | null = null, version: string | null = null;
  let doc: CheckDoc | null = null, local: Issue[] = [], ai: Issue[] = [];
  /** issues fixed here, shown as 已处理 while they are gone from the list */
  const fixed = new Map<string, Issue>();
  const working = new Set<string>();
  let busy = "", error = "", run = 0, aiRun = 0, recheckTimer: ReturnType<typeof setTimeout> | null = null, reading = false, again = false;
  const opts = { copy: flag(COPY_KEY, true), visual: flag(VISUAL_KEY, false) };
  const hasKey = () => !!d.settings().key.trim();

  /** a copy suggestion is done when the text no longer has the original and has the suggestion */
  function copyDone(i: Issue): boolean {
    if (i.fix?.kind !== "setText" || !doc) return false;
    const fx = i.fix;
    const t = doc.texts.find(x => x.id === fx.id);
    const text = t?.contents.replace(/\r\n?|\u0003/g, "\n") ?? "";
    return !!t && !text.includes(fx.from) && text.includes(fx.to);
  }
  /** what the window lists: the live issues, plus fixed ones that are gone */
  function listed(): { issues: Issue[]; states: Map<string, string> } {
    const states = new Map<string, string>();
    const live = [...local, ...ai];
    const liveKeys = new Set(live.map(i => i.key));
    for (const i of live) {
      if (working.has(i.key)) states.set(i.key, "处理中…");
      else if (copyDone(i)) states.set(i.key, "已处理");
    }
    const gone = [...fixed.values()].filter(i => !liveKeys.has(i.key));
    for (const i of gone) states.set(i.key, working.has(i.key) ? "处理中…" : "已处理");
    return { issues: [...live, ...gone], states };
  }

  const sections = (): CheckSections => {
    const { issues, states } = listed();
    return {
      head: { summary: doc ? checkSummary(issues, states) : "", busy, error },
      opts: { copy: opts.copy && hasKey(), visual: opts.visual && hasKey(), ai: hasKey() },
      issues: checkIssues(issues, states),
    };
  };
  const sync = () => { if (open) d.overlay?.queueSync(); };

  d.overlay?.hub.register<CheckSections, CheckAction>({
    id: CHECK_PANEL,
    sections,
    parseAction: parseCheckAction,
    onAction: a => void act(a),
  });

  button.addEventListener("click", () => {
    const ov = d.overlay;
    if (!ov?.connected) { d.status("检查结果显示在 WavePlug 程序里，它现在没有运行：点 Studio 面板右上角的连接状态启动它", "error"); return; }
    if (!ov.checkReady) { d.status(`检查结果窗口需要 WavePlug 程序 0.31.0（现在是 ${ov.helperVersion ?? "旧版"}）：双击 update.cmd 更新`, "error"); return; }
    const id = d.docId();
    if (id === null) { d.status("没有打开的文档", "error"); return; }
    d.opening?.();
    // the click is in this panel: the helper takes the window under the cursor as the panel
    ov.anchorPanel();
    open = true;
    ov.hub.show(CHECK_PANEL, null);
    void start(id, true);
  });

  function close() {
    open = false; ++run; ++aiRun;
    if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = null; }
    d.mark([], null);
    d.overlay?.hub.hide(CHECK_PANEL);
  }

  /** a full check of document `id`; `withAi`: the ticked DeepSeek checks too */
  async function start(id: number, withAi: boolean) {
    // another document, or a fresh check: what DeepSeek is still checking belongs to the old one
    if (id !== docId || withAi) { fixed.clear(); ai = []; ++aiRun; if (busy === "DeepSeek 正在检查…") busy = ""; }
    docId = id;
    error = "";
    await readLocal(true);
    if (withAi && open && doc) void runAi();
  }

  /** reads the document and runs the local checks (again) */
  async function readLocal(first = false) {
    if (docId === null) return;
    if (reading) { again = true; return; }
    reading = true;
    const mine = ++run, id = docId;
    if (first) { busy = "正在读取文档…"; sync(); }
    const t0 = Date.now();
    try {
      version = d.docVersion?.(id) ?? null;
      const read = await d.checker.read(id);
      if (mine !== run || !open) return;
      if (!read) throw new Error("读不到文档（是不是切换了文档？）");
      doc = read;
      local = runChecks(read);
      // a fixed issue that is back (its fix was undone) is open again
      for (const i of local) if (fixed.has(i.key) && !working.has(i.key)) fixed.delete(i.key);
      log("info", "check local", JSON.stringify({ issues: local.length, ms: Date.now() - t0 }));
    } catch (e) {
      if (mine === run) { error = (e as Error)?.message ?? String(e); log("warn", "check read", e); }
    } finally {
      reading = false;
      if (busy === "正在读取文档…") busy = "";
      sync();
      if (again) { again = false; void readLocal(); }
    }
  }

  async function runAi() {
    if (!doc || docId === null || !hasKey()) return;
    const mine = ++aiRun, id = docId, read = doc, cfg = d.settings();
    const jobs: Promise<void>[] = [];
    if (opts.copy) {
      const p = copyPrompt(read.texts);
      if (p.count) jobs.push(withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: cfg.model }, { system: COPY_SYSTEM, user: p.user }), TIMEOUT_MS, "DeepSeek ").then(r => {
        if (mine !== aiRun) return;
        ai.push(...parseCopyIssues(r.value, read.texts));
        if (p.cut) ai.push({ key: "copy:cut", category: "copy", severity: "info", ids: [], title: "文字太多，只检查了前面一部分", detail: "选中一个组或分几次检查剩下的" });
        log("info", "check copy", JSON.stringify({ texts: p.count, usage: r.usage }));
      }));
    }
    if (opts.visual && d.composite) {
      jobs.push((async () => {
        const png = await d.composite!(id, 1280);
        const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: DEEPSEEK_VISION_MODEL }, { system: VISUAL_SYSTEM, user: "这是设计稿的画面，请检查。", images: [png], maxTokens: 4000 }), TIMEOUT_MS, "DeepSeek ");
        if (mine !== aiRun) return;
        ai.push(...parseVisualIssues(r.value));
        log("info", "check visual", JSON.stringify({ usage: r.usage, model: r.model }));
      })());
    }
    if (!jobs.length) return;
    busy = "DeepSeek 正在检查…"; sync();
    const results = await Promise.allSettled(jobs);
    if (mine !== aiRun) return;
    const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) { error = "AI 检查失败：" + ((failed.reason as Error)?.message ?? String(failed.reason)); log("warn", "check ai", error); }
    busy = ""; sync();
  }

  const issueOf = (key: string) => listed().issues.find(i => i.key === key);

  async function act(a: CheckAction) {
    switch (a.kind) {
      case "hover": {
        const it = a.key ? issueOf(a.key) : undefined;
        d.mark(it ? it.ids : [], it && it.ids.length ? it.severity : null);
        return;
      }
      case "pick": {
        const it = issueOf(a.key);
        if (it?.ids.length && docId !== null) await d.tree.select(docId, it.ids).catch(e => { error = "选不中这些图层：" + ((e as Error)?.message ?? e); sync(); });
        return;
      }
      case "fix": return fix(a.key);
      case "opt":
        opts[a.name] = a.on; keep(a.name === "copy" ? COPY_KEY : VISUAL_KEY, a.on); sync();
        return;
      case "recheck": { const id = d.docId(); if (id !== null) void start(id, true); return; }
      case "close": close(); return;
    }
  }

  async function fix(key: string) {
    const it = issueOf(key);
    if (!it?.fix || docId === null || working.has(key)) return;
    const f = it.fix, id = docId;
    // the fixes work on the document in front: not on another one switched to meanwhile
    if (d.docId() !== id) { error = "文档已切换：回到这个文档再处理，或重新检查"; sync(); return; }
    working.add(key); fixed.set(key, it); error = ""; sync();
    try {
      if (f.kind === "shrinkSmart" || f.kind === "deleteVariants") {
        if (!d.tools) throw new Error("这个环境不能处理");
        const r = await d.tools.slim([f.kind === "shrinkSmart" ? "bigSmart" : "variations"], f.ids);
        if (!r.done && r.skipped.length) throw new Error(r.skipped.slice(0, 2).join("；"));
      } else if (f.kind === "delete") await d.tree.run(id, "delete", f.ids);
      else if (f.kind === "updateLinked") await d.tree.run(id, "updateModified", f.ids);
      else if (f.kind === "relink") await d.tree.run(id, "relink", f.ids);
      else if (f.kind === "setText") { if (!await d.checker.setText(id, f.id, f.from, f.to)) throw new Error("文字已经改过，找不到原文"); }
      d.refresh();
    } catch (e) {
      fixed.delete(key);
      error = `${it.fixLabel ?? "处理"}失败：${(e as Error)?.message ?? e}`;
      log("warn", "check fix", key, e);
    } finally {
      working.delete(key);
      await readLocal();
    }
  }

  // the document moved on (an edit, a fix, Ctrl+Z / Ctrl+Alt+Z): check again once quiet
  d.tree.onChange(() => {
    if (!open) return;
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      const id = d.docId();
      if (!open || id === null) return;
      if (id !== docId) { void start(id, false); return; } // another document: its local checks
      const v = d.docVersion?.(id) ?? null;
      if (v !== null && v === version) return; // only the selection changed
      void readLocal();
    }, RECHECK_MS);
  });

  return { button, isOpen: () => open, close };
}
