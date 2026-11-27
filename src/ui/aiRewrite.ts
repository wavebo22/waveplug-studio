// AI 改写文字 (WavePlug 图层 panel's 改写 button and right-click menu): DeepSeek translates or
// rewrites the text layers in scope by one instruction (core/assistant/rewrite.ts); the old → new list
// is shown in the helper's window beside the panel — the AI 整理 window with presets
// (core/overlay/organizePanel.ts REWRITE_PANEL). Hovering a row lights its layer up; the ticked ones
// are replaced in Photoshop as one undo step (DocChecker.rewrite), each only if its text is unchanged.

import type { Overlay } from "../app/overlay.ts";
import type { DocChecker } from "../ps/host.ts";
import type { TreeLayer } from "../core/layers/tree.ts";
import { deepseekJson } from "../core/assistant/deepseek.ts";
import { REWRITE_MAX_LAYERS, REWRITE_PRESETS, REWRITE_SYSTEM, type RewriteItem, parseRewrite, rewriteScope, rewriteUserPrompt } from "../core/assistant/rewrite.ts";
import { type OrganizeAction, type OrganizeSections, REWRITE_PANEL, parseOrganizeAction, rewritePlanSection } from "../core/overlay/organizePanel.ts";
import { SETUP_HELPER_VERSION } from "../core/overlay/protocol.ts";
import { log, withTimeout } from "../app/log.ts";
import { REWRITE_SETUP, type SetupSections } from "../core/overlay/setupPanel.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { createSetupPanel } from "./setupPanel.ts";
import { h } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

export interface AiRewriteDeps {
  overlay?: Overlay;
  checker: DocChecker;
  state(): { docId: number | null; layers: TreeLayer[]; selected: ReadonlySet<number> };
  status: Status;
  refresh(): void;
  fetch: typeof fetch;
  settings(): { key: string; model: string };
  mark(ids: number[], sev: "warn" | null): void;
  /** the window is about to show AI 改写: whatever else it showed closes */
  opening(): void;
  /** the canvas view, to put the settings panel in the corner */
  view?(docId: number): Promise<CanvasView | null>;
}

const ASK_KEY = "wp.ai.rewrite.ask";
const TIMEOUT_MS = 180_000;
const read = () => { try { return localStorage.getItem(ASK_KEY) ?? ""; } catch { return ""; } };
const keep = (v: string) => { try { localStorage.setItem(ASK_KEY, v); } catch { /* not kept */ } };

export function createAiRewrite(d: AiRewriteDeps) {
  const button = h("button", { class: "lt-head-btn", title: "AI 改写：用 DeepSeek 批量翻译或改写文字图层（翻译成英文 / 日文、更口语、缩短…）。选中文字图层或组：改写它们；否则改写全部文字图层。新旧对照显示在图层面板左边的窗口里，勾选后一步替换，可以 Ctrl+Z 撤销；混排样式的图层只给建议" }, "改写");

  let open = false, docId: number | null = null, scope: { ids: number[]; label: string } | null = null;
  let items: RewriteItem[] = [], mixed = new Set<number>(), busy = "", error = "", run = 0, cutNote = "";
  let ask = read();
  const off = new Set<number>();

  const sections = (): OrganizeSections => ({
    head: { title: "AI 改写", scope: scope ? scope.label : "", busy, error },
    opts: { extra: ask, renameOnly: false, toggle: "", hint: "改写要求，例如：翻译成英文 / 每条不超过 10 个字", presets: REWRITE_PRESETS, go: "生成" },
    plan: { ...rewritePlanSection(items, off, mixed, ask.trim() ? "点「生成」开始改写" : "选一个预设，或写下改写要求后按 Enter"), ...(cutNote ? { dropped: [cutNote] } : {}) },
  });
  const sync = () => { if (open) d.overlay?.queueSync(); };

  d.overlay?.hub.register<OrganizeSections, OrganizeAction>({
    id: REWRITE_PANEL,
    sections,
    parseAction: parseOrganizeAction,
    onAction: a => void act(a),
  });

  button.addEventListener("click", () => {
    const ov = d.overlay;
    if (!ov?.connected) { d.status("AI 改写的对照表显示在 WavePlug 程序里，它现在没有运行：点 Studio 面板右上角的连接状态启动它", "error"); return; }
    if (!ov.setupReady) { d.status(`AI 改写需要 WavePlug 程序 ${SETUP_HELPER_VERSION}（现在是 ${ov.helperVersion ?? "旧版"}）：在面板顶部的更新提醒里点「更新」`, "error"); return; }
    const s = d.state();
    if (s.docId === null) { d.status("没有打开的文档", "error"); return; }
    const sc = rewriteScope(s.layers, s.selected);
    if (!sc.ids.length) { d.status("文档里没有文字图层", "error"); return; }
    if (sc.ids.length > REWRITE_MAX_LAYERS) { d.status(`${sc.label}，一次最多改写 ${REWRITE_MAX_LAYERS} 个：先选中一部分或一个组`, "error"); return; }
    if (!d.settings().key.trim()) { d.status("还没有填写 DeepSeek API Key：在 WavePlug 程序 › 功能设置 › AI 助手 里填写", "error"); return; }
    // the click is in this panel: the helper takes the window under the cursor as the panel
    ov.anchorPanel();
    settingsPanel.open();
  });

  /** 开始 in the settings: the text layers in scope now, then DeepSeek */
  function begin() {
    const ov = d.overlay, s = d.state();
    if (!ov || s.docId === null || !ask.trim()) return;
    const sc = rewriteScope(s.layers, s.selected);
    if (!sc.ids.length || sc.ids.length > REWRITE_MAX_LAYERS) return;
    d.opening();
    open = true; docId = s.docId; scope = sc; items = []; mixed = new Set(); off.clear(); error = ""; busy = ""; cutNote = "";
    ov.hub.show(REWRITE_PANEL, null);
    void generate();
  }

  const CUSTOM = "自定义";
  const settingsPanel = createSetupPanel({
    overlay: d.overlay, id: REWRITE_SETUP, docId: () => d.state().docId,
    view: id => d.view?.(id) ?? Promise.resolve(null),
    form: (): SetupSections["form"] => {
      const s = d.state(), sc = rewriteScope(s.layers, s.selected);
      const preset = REWRITE_PRESETS.includes(ask) ? ask : CUSTOM;
      const tooMany = sc.ids.length > REWRITE_MAX_LAYERS;
      return {
        title: "AI 翻译 / 改写文字",
        scope: `${sc.label}（选中文字图层或组：改写它们；否则改写全部文字图层）`,
        fields: [
          { key: "preset", kind: "choice", label: "怎么改", value: preset, options: [...REWRITE_PRESETS, CUSTOM].map(v => ({ value: v, label: v })) },
          { key: "ask", kind: "text", label: "改写要求", hint: "例如：每条不超过 10 个字，语气活泼", value: ask },
        ],
        start: sc.ids.length && !tooMany && ask.trim() ? "开始改写" : "",
        note: !sc.ids.length ? "文档里没有文字图层" : tooMany ? `一次最多改写 ${REWRITE_MAX_LAYERS} 个：先选中一部分或一个组` : !ask.trim() ? "选一种改法，或写下改写要求" : "保留原有字体、字号和颜色；混排样式的图层只给建议",
      };
    },
    set(k, v) {
      if (k === "preset" && typeof v === "string") { if (v !== CUSTOM) ask = v; else if (REWRITE_PRESETS.includes(ask)) ask = ""; keep(ask); }
      else if (k === "ask" && typeof v === "string") { ask = v; keep(ask); }
    },
    start: begin,
  });

  function close() {
    settingsPanel.close();
    if (!open) return;
    open = false; ++run;
    d.mark([], null);
    d.overlay?.hub.hide(REWRITE_PANEL);
  }

  async function generate() {
    if (!scope || docId === null) return;
    if (!ask.trim()) { error = "先写改写要求，或点一个预设"; sync(); return; }
    const mine = ++run, id = docId, sc = scope;
    busy = "DeepSeek 正在改写…"; error = ""; items = []; off.clear(); cutNote = ""; sync();
    const t0 = Date.now();
    try {
      if (d.state().docId !== id) throw new Error("文档已切换，请重新打开 AI 改写");
      const info = await d.checker.textInfo(id, sc.ids);
      const names = new Map(d.state().layers.map(l => [l.id, l.name]));
      const texts = info.map(t => ({ id: t.id, name: names.get(t.id) ?? "", text: t.text }));
      const p = rewriteUserPrompt(texts, ask);
      if (!p.count) throw new Error("这些文字图层都是空的");
      const cfg = d.settings();
      const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: cfg.model }, { system: REWRITE_SYSTEM, user: p.user, maxTokens: 8000 }), TIMEOUT_MS, "DeepSeek ");
      if (mine !== run || !open) return;
      items = parseRewrite(r.value, texts);
      mixed = new Set(info.filter(t => t.ranges > 1).map(t => t.id));
      if (p.cut) cutNote = `文字太多，这次只改写了前 ${p.count} 个，剩下 ${p.cut} 个请分批选中再改写`;
      log("info", "ai rewrite plan", JSON.stringify({ model: r.model, texts: p.count, items: items.length, mixed: items.filter(i => mixed.has(i.id)).length, usage: r.usage, ms: Date.now() - t0 }));
    } catch (e) {
      if (mine !== run) return;
      error = (e as Error)?.message ?? String(e);
      log("warn", "ai rewrite", error);
    }
    if (mine === run) { busy = ""; sync(); }
  }

  async function apply() {
    if (docId === null || busy) return;
    const chosen = items.filter(i => !off.has(i.id) && !mixed.has(i.id));
    if (!chosen.length) return;
    busy = "正在替换…"; error = ""; sync();
    try {
      if (d.state().docId !== docId) throw new Error("文档已切换，没有替换");
      const r = await d.checker.rewrite(docId, chosen);
      close();
      d.status(`AI 改写完成：替换了 ${r.done} 个文字图层（Ctrl+Z 可一步撤销）${r.skipped.length ? `；${r.skipped.length} 个没替换：${r.skipped.slice(0, 2).join("；")}` : ""}`, r.skipped.length ? "error" : "ok");
      d.refresh();
    } catch (e) {
      busy = ""; error = (e as Error)?.message ?? String(e);
      log("warn", "ai rewrite apply", error);
      sync();
    }
  }

  async function act(a: OrganizeAction) {
    switch (a.kind) {
      case "hover": {
        const n = a.key?.startsWith("r:") ? Number(a.key.slice(2)) : NaN;
        const ids = items.some(i => i.id === n) ? [n] : [];
        d.mark(ids, ids.length ? "warn" : null);
        return;
      }
      case "toggle": {
        const n = Number(a.key.slice(2));
        if (mixed.has(n)) return;
        if (!off.delete(n)) off.add(n);
        sync();
        return;
      }
      case "extra": ask = a.text; keep(ask); sync(); return;
      case "analyse": void generate(); return;
      case "apply": void apply(); return;
      case "close": close(); return;
      case "rename-only": return;
    }
  }

  return { button, isOpen: () => open || settingsPanel.isOpen(), close, syncSetup: () => settingsPanel.sync() };
}
