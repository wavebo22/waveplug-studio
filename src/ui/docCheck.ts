// 文档检查 (WavePlug 图层 panel's 检查 button): the local checks (core/check/rules.ts) and, when ticked,
// DeepSeek's copy and picture checks (core/check/ai.ts), shown in the helper's 检查结果 window beside
// the panel (core/overlay/checkPanel.ts). Hovering an issue lights its layers up in the panel and on
// the canvas; a click selects them; a fix is one undo step.
//
// Every document has its own check (its list, what was fixed, what is running): switching documents
// hides the window (docChanged), coming back shows that document's list again (reshow).
//
// The list follows the document: whenever Photoshop's history moves (an edit, a fix, Ctrl+Z) the
// local checks run again. A fixed issue that is gone stays listed as 已处理; one that comes back
// (the fix was undone) is open again. Copy suggestions are checked against the text itself.

import type { Overlay } from "../app/overlay.ts";
import type { DocChecker, LayerTools, LayerTree } from "../ps/host.ts";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import { CATEGORY_NAMES, type Category, type CheckDoc, type Issue, filterIssues, runChecks } from "../core/check/rules.ts";
import { CHECK_SETUP, type SetupSections } from "../core/overlay/setupPanel.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { createSetupPanel } from "./setupPanel.ts";
import { SETUP_HELPER_VERSION } from "../core/overlay/protocol.ts";
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
  /** the selected layers with what is inside selected groups ([]: nothing selected) */
  selection?(): number[];
  /** the canvas view, to put the settings panel in the corner */
  view?(docId: number): Promise<CanvasView | null>;
}

/** the local categories the settings offer, in their order (copy / visual are the AI options) */
const LOCAL_CATS: Category[] = ["font", "smart", "delivery", "text", "design", "hygiene"];
const SETUP_KEY = "wp.check.setup";
interface CheckSetup { cats: Category[]; scope: "doc" | "selection" }
function loadSetup(): CheckSetup {
  try {
    const v = JSON.parse(localStorage.getItem(SETUP_KEY) ?? "null");
    if (v && Array.isArray(v.cats)) return { cats: v.cats.filter((c: string) => (LOCAL_CATS as string[]).includes(c)), scope: v.scope === "selection" ? "selection" : "doc" };
  } catch { /* first time */ }
  return { cats: [...LOCAL_CATS], scope: "doc" };
}

const COPY_KEY = "wp.check.copy", VISUAL_KEY = "wp.check.visual";
const TIMEOUT_MS = 180_000;
/** history moves come in bursts: check once it has been quiet this long */
const RECHECK_MS = 700;
const flag = (k: string, def: boolean) => { try { return (localStorage.getItem(k) ?? (def ? "on" : "off")) === "on"; } catch { return def; } };
const keep = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? "on" : "off"); } catch { /* not kept */ } };

export function createDocCheck(d: DocCheckDeps) {
  const button = h("button", { class: "lt-head-btn", title: "文档检查：缺失字体、太大或发糊的智能对象、丢失的链接、CMYK 文件的印刷设置（分辨率、出血和安全边距、四色黑、过小的字）、可能超出文本框的文字、占位文字、图层整洁、颜色 / 字号 / 间距是否统一；可选让 DeepSeek 检查文案和看画面。结果显示在图层面板左边的窗口里，鼠标停在一条上，相关图层在面板和画面上用红色 / 黄色标出；点了按钮才会修改，撤销后状态跟着恢复" }, "检查");

  interface Session {
    docId: number;
    open: boolean;
    /** Photoshop's history state the list was read at */
    version: string | null;
    doc: CheckDoc | null;
    local: Issue[];
    ai: Issue[];
    /** issues fixed here, shown as 已处理 while they are gone from the list */
    fixed: Map<string, Issue>;
    working: Set<string>;
    busy: string;
    error: string;
    run: number;
    aiRun: number;
    reading: boolean;
    again: boolean;
    /** what this check covers: set when it starts (开始), kept for the re-checks */
    cats: Set<Category>;
    scope: Set<number> | null;
    scopeLabel: string;
  }
  const sessions = new Map<number, Session>();
  const sessionOf = (docId: number) => {
    let s = sessions.get(docId);
    if (!s) {
      s = { docId, open: false, version: null, doc: null, local: [], ai: [], fixed: new Map(), working: new Set(), busy: "", error: "", run: 0, aiRun: 0,
        reading: false, again: false, cats: new Set(), scope: null, scopeLabel: "整个文档" };
      sessions.set(docId, s);
    }
    return s;
  };
  const cur = () => { const id = d.docId(); return id === null ? null : sessions.get(id) ?? null; };
  const front = (s: Session) => d.docId() === s.docId;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  const opts = { copy: flag(COPY_KEY, true), visual: flag(VISUAL_KEY, false) };
  const setup = loadSetup();
  const saveSetup = () => { try { localStorage.setItem(SETUP_KEY, JSON.stringify(setup)); } catch { /* not kept */ } };
  const hasKey = () => !!d.settings().key.trim();

  /** a copy suggestion is done when the text no longer has the original and has the suggestion */
  function copyDone(s: Session, i: Issue): boolean {
    if (i.fix?.kind !== "setText" || !s.doc) return false;
    const fx = i.fix;
    const t = s.doc.texts.find(x => x.id === fx.id);
    const text = t?.contents.replace(/\r\n?|\u0003/g, "\n") ?? "";
    return !!t && !text.includes(fx.from) && text.includes(fx.to);
  }
  /** what the window lists: the live issues, plus fixed ones that are gone */
  function listed(s: Session | null): { issues: Issue[]; states: Map<string, string> } {
    const states = new Map<string, string>();
    if (!s) return { issues: [], states };
    const live = [...s.local, ...s.ai];
    const liveKeys = new Set(live.map(i => i.key));
    for (const i of live) {
      if (s.working.has(i.key)) states.set(i.key, "处理中…");
      else if (copyDone(s, i)) states.set(i.key, "已处理");
    }
    const gone = [...s.fixed.values()].filter(i => !liveKeys.has(i.key));
    for (const i of gone) states.set(i.key, s.working.has(i.key) ? "处理中…" : "已处理");
    return { issues: [...live, ...gone], states };
  }

  const sections = (): CheckSections => {
    const s = cur(), { issues, states } = listed(s);
    return {
      head: { summary: s?.doc ? `${s.scopeLabel} · ${checkSummary(issues, states)}` : "", busy: s?.busy ?? "", error: s?.error ?? "" },
      opts: { copy: opts.copy && hasKey(), visual: opts.visual && hasKey(), ai: hasKey() },
      issues: checkIssues(issues, states),
    };
  };
  /** a session changed: the window shows it when it is the front document's */
  const sync = (s?: Session | null) => { if (s && s.open && front(s)) d.overlay?.queueSync(); };

  d.overlay?.hub.register<CheckSections, CheckAction>({
    id: CHECK_PANEL,
    sections,
    parseAction: parseCheckAction,
    onAction: a => void act(a),
  });

  button.addEventListener("click", () => {
    const ov = d.overlay;
    if (!ov?.connected) { d.status("检查结果显示在 WavePlug 程序里，它现在没有运行：点 Studio 面板右上角的连接状态启动它", "error"); return; }
    if (!ov.setupReady) { d.status(`检查需要 WavePlug 程序 ${SETUP_HELPER_VERSION}（现在是 ${ov.helperVersion ?? "旧版"}）：在面板顶部的更新提醒里点「更新」`, "error"); return; }
    const id = d.docId();
    if (id === null) { d.status("没有打开的文档", "error"); return; }
    // the click is in this panel: the helper takes the window under the cursor as the panel
    // (the results go beside it once 开始 is clicked in the settings)
    ov.anchorPanel();
    settingsPanel.open();
  });

  /** 开始 in the settings: what is ticked and the layers it covers, then the check */
  function begin() {
    const id = d.docId(), ov = d.overlay;
    if (id === null || !ov) return;
    const s = sessionOf(id);
    const sel = setup.scope === "selection" ? d.selection?.() ?? [] : [];
    s.scope = sel.length ? new Set(sel) : null;
    s.scopeLabel = s.scope ? `选中的 ${s.scope.size} 个图层` : "整个文档";
    s.cats = new Set<Category>([...setup.cats, "copy", "visual"]);
    d.opening?.();
    s.open = true;
    ov.hub.show(CHECK_PANEL, null);
    void start(s, true);
  }

  const settingsPanel = createSetupPanel({
    overlay: d.overlay, id: CHECK_SETUP, docId: d.docId,
    view: docId => d.view?.(docId) ?? Promise.resolve(null),
    form: (): SetupSections["form"] => {
      const key = hasKey(), selected = d.selection?.().length ?? 0;
      const noCats = !setup.cats.length && !(key && (opts.copy || opts.visual));
      return {
        title: "文档检查",
        scope: setup.scope === "selection" ? (selected ? `选中的 ${selected} 个图层（含组内）` : "没有选中图层：将检查整个文档") : "整个文档",
        fields: [
          { key: "scope", kind: "choice", label: "范围", value: setup.scope, options: [{ value: "doc", label: "整个文档" }, { value: "selection", label: "只查选中的图层" }] },
          { key: "h-local", kind: "heading", label: "检查哪些内容" },
          ...LOCAL_CATS.map(c => ({ key: "cat:" + c, kind: "toggle" as const, label: c === "delivery" ? "交付设置（CMYK 文件才按印刷查）" : CATEGORY_NAMES[c], value: setup.cats.includes(c) })),
          { key: "h-ai", kind: "heading", label: "AI 检查（DeepSeek）" },
          { key: "copy", kind: "toggle", label: "文案：错别字、标点、广告法用语、前后不一致", value: opts.copy && key, disabled: !key, tip: key ? "只发送文字内容" : "先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key" },
          { key: "visual", kind: "toggle", label: "看画面：AI 生成瑕疵、排版问题", value: opts.visual && key, disabled: !key, tip: key ? "会把画面缩略图上传到 DeepSeek，保密的稿子不要勾" : "先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key" },
        ],
        start: noCats ? "" : "开始检查",
        note: noCats ? "至少勾选一项" : "",
      };
    },
    set(k, v) {
      if (k === "scope" && (v === "doc" || v === "selection")) setup.scope = v;
      else if (k.startsWith("cat:") && typeof v === "boolean") {
        const c = k.slice(4) as Category;
        setup.cats = LOCAL_CATS.filter(x => x === c ? v : setup.cats.includes(x));
      } else if ((k === "copy" || k === "visual") && typeof v === "boolean") { opts[k] = v; keep(k === "copy" ? COPY_KEY : VISUAL_KEY, v); }
      saveSetup();
    },
    start: begin,
  });

  /** closes the front document's check (its list is dropped) */
  function close() {
    settingsPanel.close();
    const s = cur();
    if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = null; }
    if (!s?.open) return;
    s.open = false; ++s.run; ++s.aiRun; s.busy = "";
    d.mark([], null);
    d.overlay?.hub.hide(CHECK_PANEL);
  }

  /** a full check of the session's document; `withAi`: the ticked DeepSeek checks too */
  async function start(s: Session, withAi: boolean) {
    // a fresh check: what DeepSeek is still checking belongs to the old one
    if (withAi) { s.fixed.clear(); s.ai = []; ++s.aiRun; if (s.busy === "DeepSeek 正在检查…") s.busy = ""; }
    s.error = "";
    await readLocal(s, true);
    if (withAi && s.open && s.doc) void runAi(s);
  }

  /** reads the document and runs the local checks (again); only for the document in front */
  async function readLocal(s: Session, first = false) {
    if (!front(s)) return; // read when it is in front again
    if (s.reading) { s.again = true; return; }
    s.reading = true;
    const mine = ++s.run, id = s.docId;
    if (first) { s.busy = "正在读取文档…"; sync(s); }
    const t0 = Date.now();
    try {
      s.version = d.docVersion?.(id) ?? null;
      const read = await d.checker.read(id);
      if (mine !== s.run || !s.open) return;
      if (!read) { if (!front(s)) return; throw new Error("读不到文档"); } // switched away meanwhile: read again when back
      s.doc = read;
      s.local = filterIssues(runChecks(read), s.cats, s.scope);
      // a fixed issue that is back (its fix was undone) is open again
      for (const i of s.local) if (s.fixed.has(i.key) && !s.working.has(i.key)) s.fixed.delete(i.key);
      log("info", "check local", JSON.stringify({ doc: id, issues: s.local.length, ms: Date.now() - t0 }));
    } catch (e) {
      if (mine === s.run) { s.error = (e as Error)?.message ?? String(e); log("warn", "check read", e); }
    } finally {
      s.reading = false;
      if (s.busy === "正在读取文档…") s.busy = "";
      sync(s);
      if (s.again) { s.again = false; void readLocal(s); }
    }
  }

  async function runAi(s: Session) {
    if (!s.doc || !hasKey()) return;
    const mine = ++s.aiRun, id = s.docId, read = s.doc, cfg = d.settings(), scope = s.scope;
    const jobs: Promise<void>[] = [];
    if (opts.copy) {
      const p = copyPrompt(scope ? read.texts.filter(t => scope.has(t.id)) : read.texts);
      if (p.count) jobs.push(withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: cfg.model }, { system: COPY_SYSTEM, user: p.user }), TIMEOUT_MS, "DeepSeek ").then(r => {
        if (mine !== s.aiRun) return;
        s.ai.push(...parseCopyIssues(r.value, read.texts));
        if (p.cut) s.ai.push({ key: "copy:cut", category: "copy", severity: "info", ids: [], title: "文字太多，只检查了前面一部分", detail: "选中一个组或分几次检查剩下的" });
        log("info", "check copy", JSON.stringify({ doc: id, texts: p.count, usage: r.usage }));
      }));
    }
    if (opts.visual && d.composite) {
      jobs.push((async () => {
        const png = await d.composite!(id, 1280);
        const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: DEEPSEEK_VISION_MODEL }, { system: VISUAL_SYSTEM, user: "这是设计稿的画面，请检查。", images: [png], maxTokens: 4000 }), TIMEOUT_MS, "DeepSeek ");
        if (mine !== s.aiRun) return;
        s.ai.push(...parseVisualIssues(r.value));
        log("info", "check visual", JSON.stringify({ doc: id, usage: r.usage, model: r.model }));
      })());
    }
    if (!jobs.length) return;
    s.busy = "DeepSeek 正在检查…"; sync(s);
    const results = await Promise.allSettled(jobs);
    if (mine !== s.aiRun) return;
    const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) { s.error = "AI 检查失败：" + ((failed.reason as Error)?.message ?? String(failed.reason)); log("warn", "check ai", s.error); }
    s.busy = ""; sync(s);
  }

  const issueOf = (s: Session | null, key: string) => listed(s).issues.find(i => i.key === key);

  async function act(a: CheckAction) {
    const s = cur();
    switch (a.kind) {
      case "hover": {
        const it = a.key ? issueOf(s, a.key) : undefined;
        d.mark(it ? it.ids : [], it && it.ids.length ? it.severity : null);
        return;
      }
      case "pick": {
        const it = issueOf(s, a.key);
        if (s && it?.ids.length) await d.tree.select(s.docId, it.ids).catch(e => { s.error = "选不中这些图层：" + ((e as Error)?.message ?? e); sync(s); });
        return;
      }
      case "fix": if (s) await fix(s, a.key, a.choice); return;
      case "opt":
        opts[a.name] = a.on; keep(a.name === "copy" ? COPY_KEY : VISUAL_KEY, a.on); sync(s);
        return;
      case "recheck": if (s) void start(s, true); return;
      case "close": close(); return;
    }
  }

  async function fix(s: Session, key: string, choice?: number) {
    const it = issueOf(s, key);
    if (!it?.fix || s.working.has(key) || !front(s)) return;
    const f = (choice !== undefined ? it.choices?.[choice]?.fix : undefined) ?? it.fix, id = s.docId;
    s.working.add(key); s.fixed.set(key, it); s.error = ""; sync(s);
    try {
      if (f.kind === "shrinkSmart" || f.kind === "deleteVariants") {
        if (!d.tools) throw new Error("这个环境不能处理");
        const r = await d.tools.slim([f.kind === "shrinkSmart" ? "bigSmart" : "variations"], f.ids);
        if (!r.done && r.skipped.length) throw new Error(r.skipped.slice(0, 2).join("；"));
      } else if (f.kind === "delete") await d.tree.run(id, "delete", f.ids);
      else if (f.kind === "updateLinked") await d.tree.run(id, "updateModified", f.ids);
      else if (f.kind === "relink") await d.tree.run(id, "relink", f.ids);
      else if (f.kind === "setText") { if (!await d.checker.setText(id, f.id, f.from, f.to)) throw new Error("文字已经改过，找不到原文"); }
      else if (f.kind === "restyle") {
        const r = await d.checker.restyle(id, f.edits);
        if (!r.done) throw new Error(r.skipped.slice(0, 2).join("；") || "没有改成");
        if (r.skipped.length) d.status(`${it.fixLabel ?? "处理"}：${r.skipped.length} 个图层没改成：${r.skipped.slice(0, 2).join("；")}`, "error");
      }
      d.refresh();
    } catch (e) {
      s.fixed.delete(key);
      s.error = `${it.fixLabel ?? "处理"}失败：${(e as Error)?.message ?? e}`;
      log("warn", "check fix", key, e);
    } finally {
      s.working.delete(key);
      await readLocal(s);
    }
  }

  // the document moved on (an edit, a fix, Ctrl+Z / Ctrl+Alt+Z): check the front one again once quiet
  d.tree.onChange(() => {
    if (!cur()?.open) return;
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      const s = cur();
      if (!s?.open) return;
      const v = d.docVersion?.(s.docId) ?? null;
      if (v !== null && v === s.version) return; // only the selection changed
      void readLocal(s);
    }, RECHECK_MS);
  });

  return {
    button,
    isOpen: () => !!cur()?.open || settingsPanel.isOpen(),
    close,
    syncSetup: () => settingsPanel.sync(),
    /** another document is in front: the window goes (its check stays) */
    docChanged() {
      if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = null; }
      d.overlay?.hub.hide(CHECK_PANEL);
    },
    /** the front document had its check open: show it again (re-read: it may have changed meanwhile) */
    reshow(): boolean {
      const s = cur();
      if (!s?.open) return false;
      d.overlay?.hub.show(CHECK_PANEL, null);
      void readLocal(s);
      return true;
    },
    forget(docId: number) { sessions.delete(docId); },
  };
}
