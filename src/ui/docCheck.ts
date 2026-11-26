// 文档检查 (WavePlug 图层 panel): the local checks (core/check/rules.ts) show at once; DeepSeek's
// copy check and, when allowed, its look at the picture (core/check/ai.ts) are added when they come
// back. Every issue can select its layers; many have a button that deals with them (each one undo
// step). Nothing is changed without a click.

import type { DocChecker, LayerTools, LayerTree } from "../ps/host.ts";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import { type Category, type CheckDoc, type Issue, type Purpose, CATEGORY_NAMES, PURPOSE_NAMES, guessPurpose, runChecks } from "../core/check/rules.ts";
import { COPY_SYSTEM, VISUAL_SYSTEM, copyPrompt, parseCopyIssues, parseVisualIssues } from "../core/check/ai.ts";
import { log, withTimeout } from "../app/log.ts";
import { h, icon, replace } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

export interface DocCheckDeps {
  checker: DocChecker;
  tree: LayerTree;
  tools?: LayerTools;
  state(): { docId: number | null };
  status: Status;
  refresh(): void;
  fetch: typeof fetch;
  settings(): { key: string; model: string };
  /** the whole picture as a PNG data URL, at most `maxEdge` px a side (看图检查) */
  composite?(docId: number, maxEdge: number): Promise<string>;
  host(): HTMLElement;
}

const PURPOSE_KEY = "wp.check.purpose", COPY_KEY = "wp.check.copy", VISUAL_KEY = "wp.check.visual";
const ORDER: Category[] = ["font", "smart", "delivery", "text", "copy", "visual", "design", "hygiene"];
const SHORT: Record<Purpose, string> = { print: "印刷", screen: "屏幕", mobile: "手机" };
const SEVERITY_NAMES = { error: "错误", warn: "警告", info: "提示" } as const;
const TIMEOUT_MS = 180_000;
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } };

export function createDocCheck(d: DocCheckDeps) {
  let sheet: HTMLElement | null = null;
  const button = h("button", { class: "lt-head-btn", title: "文档检查：缺失字体、太大或发糊的智能对象、丢失的链接、交付设置（颜色模式、分辨率、出血和安全边距、四色黑）、文字（太小、可能截断、对比度低、占位文字）、图层整洁、颜色 / 字号 / 间距是否统一；可选让 DeepSeek 检查文案（错别字、标点、前后不一致、广告法用语、翻译）和看画面（AI 生成瑕疵、排版问题）。只列出问题，点了按钮才会修改" }, "检查");
  button.addEventListener("click", () => open());
  const close = () => { sheet?.remove(); sheet = null; };

  function open() {
    if (sheet) return;
    const docId = d.state().docId;
    if (docId === null) { d.status("没有打开的文档", "error"); return; }

    let doc: CheckDoc | null = null, local: Issue[] = [], ai: Issue[] = [];
    let localBusy = false, aiBusy = "", aiError = "", run = 0;
    const done = new Map<string, string>(); // key → what happened ("已处理" …)
    const purposeChoice = () => (localStorage.getItem(PURPOSE_KEY) ?? "auto") as Purpose | "auto";
    const purpose = (): Purpose => { const p = purposeChoice(); return p === "auto" ? (doc ? guessPurpose(doc) : "screen") : p; };

    const seg = h("div", { class: "seg check-seg" });
    const renderSeg = () => {
      const auto = doc ? PURPOSE_NAMES[guessPurpose(doc)] : "";
      replace(seg, ...(["auto", "print", "screen", "mobile"] as const).map(p => {
        const b = h("button", { class: "seg-btn" + (purposeChoice() === p ? " on" : ""), title: p === "auto" ? `按颜色模式和画布尺寸判断${auto ? `（现在是${auto}）` : ""}：CMYK 是印刷，手机宽度的竖图是手机界面，其他是屏幕` : `按${PURPOSE_NAMES[p]}的标准检查` },
          p === "auto" ? "自动" : SHORT[p]);
        b.addEventListener("click", () => { keep(PURPOSE_KEY, p); renderSeg(); if (doc) { local = runChecks(doc, purpose()); render(); } });
        return b;
      }));
    };
    const hasKey = () => !!d.settings().key.trim();
    const check = (key: string, def: boolean, label: string, tip: string) => {
      const c = h("input", { type: "checkbox" }) as HTMLInputElement;
      c.checked = hasKey() && (localStorage.getItem(key) ?? (def ? "on" : "off")) === "on";
      (c as any).disabled = !hasKey();
      c.addEventListener("change", () => keep(key, c.checked ? "on" : "off"));
      return { el: h("label", { class: "check-row", title: hasKey() ? tip : "先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key" }, c, h("span", null, label)), box: c };
    };
    const copyOpt = check(COPY_KEY, true, "让 DeepSeek 检查文案（只发送文字）", "错别字、标点、前后不一致、价格日期格式、占位文字、广告法用语、翻译是否一致；只把文字图层的内容发给 DeepSeek");
    const visualOpt = check(VISUAL_KEY, false, "让 DeepSeek 看画面（会上传画面缩略图）", "AI 生成的瑕疵（手指、乱码文字）、文字被挡住、贴边、变形；会把整个画面缩到 1280 px 上传到 DeepSeek，保密的稿子不要勾");
    const result = h("div", { class: "check-result" });
    const summary = h("div", { class: "muted small check-summary" });
    const msg = h("span", { class: "sheet-msg" });
    const againBtn = h("button", { class: "btn primary", title: "重新读取文档再检查一遍（勾选的 AI 检查也会重新做）" }, "重新检查");
    againBtn.addEventListener("click", () => void start());

    sheet = h("div", { class: "sheet ai-org doc-check" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "文档检查"),
        h("button", { class: "icon-btn", title: "关闭", onClick: close }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("div", { class: "group-label check-first" }, "按什么用途检查"), seg,
        h("div", { class: "ai-org-ask" }, copyOpt.el, visualOpt.el),
        summary, result),
      h("div", { class: "sheet-foot" }, msg, h("button", { class: "btn", onClick: close }, "关闭"), againBtn));
    d.host().append(sheet);
    renderSeg();
    void start();

    function render() {
      (againBtn as any).disabled = localBusy || !!aiBusy;
      const all = [...local, ...ai];
      const n = (s: Issue["severity"]) => all.filter(i => i.severity === s && !done.has(i.key)).length;
      replace(summary, localBusy ? "正在读取文档…" : doc
        ? `${PURPOSE_NAMES[purpose()]}标准 · ${n("error")} 个错误 · ${n("warn")} 个警告 · ${n("info")} 个提示` + (aiBusy ? ` · ${aiBusy}` : "") + (aiError ? ` · AI 检查失败：${aiError}` : "")
        : "");
      if (localBusy) { replace(result); return; }
      if (!all.length) { replace(result, h("div", { class: "ai-org-wait" }, aiBusy ? "本地检查没有发现问题，AI 检查还在进行…" : "没有发现问题")); return; }
      const parts: (HTMLElement | null)[] = [];
      for (const cat of ORDER) {
        const items = all.filter(i => i.category === cat);
        if (!items.length) continue;
        parts.push(h("div", { class: "group-label" }, `${CATEGORY_NAMES[cat]}（${items.length}）`));
        for (const it of items) parts.push(row(it));
      }
      replace(result, ...parts);
    }

    function row(it: Issue): HTMLElement {
      const state = done.get(it.key);
      const title = h("div", { class: "check-title" + (it.ids.length ? " pickable" : ""), title: it.ids.length ? "单击选中相关图层" : "" }, it.title);
      if (it.ids.length) title.addEventListener("click", () => void select(it));
      const actions: HTMLElement[] = [];
      if (state) actions.push(h("span", { class: "check-done" }, state));
      else if (it.fix) {
        const b = h("button", { class: "btn check-fix", title: "处理这一项（可以 Ctrl+Z 撤销）" }, it.fixLabel ?? "处理");
        b.addEventListener("click", () => void fix(it));
        actions.push(b);
      }
      return h("div", { class: "check-row-item sev-" + it.severity + (state ? " is-done" : "") },
        h("span", { class: "check-sev" }, SEVERITY_NAMES[it.severity]),
        h("div", { class: "check-main" }, title, h("div", { class: "check-detail" }, it.detail)),
        ...actions);
    }

    async function select(it: Issue) {
      try { await d.tree.select(docId!, it.ids); }
      catch (e) { msg.textContent = "选不中这些图层：" + ((e as Error)?.message ?? e); }
    }

    async function fix(it: Issue) {
      const f = it.fix!;
      msg.textContent = "";
      done.set(it.key, "处理中…"); render();
      try {
        if (f.kind === "shrinkSmart" || f.kind === "deleteVariants") {
          if (!d.tools) throw new Error("这个环境不能处理");
          const r = await d.tools.slim([f.kind === "shrinkSmart" ? "bigSmart" : "variations"], f.ids);
          if (!r.done && r.skipped.length) throw new Error(r.skipped.slice(0, 2).join("；"));
        } else if (f.kind === "delete") await d.tree.run(docId!, "delete", f.ids);
        else if (f.kind === "updateLinked") await d.tree.run(docId!, "updateModified", f.ids);
        else if (f.kind === "relink") await d.tree.run(docId!, "relink", f.ids);
        else if (f.kind === "setText") { if (!await d.checker.setText(docId!, f.id, f.from, f.to)) throw new Error("文字已经改过，找不到原文"); }
        done.set(it.key, "已处理");
        d.refresh();
      } catch (e) {
        done.delete(it.key);
        msg.textContent = `${it.fixLabel ?? "处理"}失败：${(e as Error)?.message ?? e}`;
        log("warn", "check fix", it.key, e);
      }
      if (sheet) render();
    }

    async function start() {
      const mine = ++run;
      localBusy = true; aiBusy = ""; aiError = ""; ai = []; local = []; done.clear(); msg.textContent = "";
      render();
      const t0 = Date.now();
      try {
        if (d.state().docId !== docId) throw new Error("文档已切换，请重新打开检查");
        doc = await d.checker.read(docId!);
        if (mine !== run || !sheet) return;
        if (!doc) throw new Error("读不到文档（是不是切换了文档？）");
        local = runChecks(doc, purpose());
        log("info", "check local", JSON.stringify({ issues: local.length, ms: Date.now() - t0, purpose: purpose() }));
      } catch (e) {
        if (mine !== run) return;
        msg.textContent = (e as Error)?.message ?? String(e);
        log("warn", "check read", e);
      }
      localBusy = false;
      renderSeg(); render();
      if (!doc || mine !== run) return;
      const jobs: Promise<void>[] = [];
      const cfg = d.settings();
      if (copyOpt.box.checked && hasKey()) {
        const p = copyPrompt(doc.texts);
        if (p.count) jobs.push(withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: cfg.model }, { system: COPY_SYSTEM, user: p.user }), TIMEOUT_MS, "DeepSeek ").then(r => {
          if (mine !== run) return;
          ai.push(...parseCopyIssues(r.value, doc!.texts));
          if (p.cut) ai.push({ key: "copy:cut", category: "copy", severity: "info", ids: [], title: "文字太多，只检查了前面一部分", detail: "选中一个组或分几次检查剩下的" });
          log("info", "check copy", JSON.stringify({ texts: p.count, usage: r.usage }));
        }));
      }
      if (visualOpt.box.checked && hasKey() && d.composite) {
        jobs.push((async () => {
          const png = await d.composite!(docId!, 1280);
          const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: DEEPSEEK_VISION_MODEL }, { system: VISUAL_SYSTEM, user: "这是设计稿的画面，请检查。", images: [png], maxTokens: 4000 }), TIMEOUT_MS, "DeepSeek ");
          if (mine !== run) return;
          ai.push(...parseVisualIssues(r.value));
          log("info", "check visual", JSON.stringify({ usage: r.usage, model: r.model }));
        })());
      }
      if (!jobs.length) return;
      aiBusy = "DeepSeek 正在检查…";
      render();
      const results = await Promise.allSettled(jobs);
      if (mine !== run || !sheet) return;
      const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) { aiError = (failed.reason as Error)?.message ?? String(failed.reason); log("warn", "check ai", aiError); }
      aiBusy = "";
      render();
    }
  }

  return { button, open, isOpen: () => !!sheet, close };
}
