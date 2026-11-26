// AI 整理图层 (WavePlug 图层 panel): asks DeepSeek for clear names and new groups for the layers in
// scope (core/assistant/organize.ts), shows the plan on a sheet where each item can be unticked,
// and applies the ticked ones in Photoshop as one undo step (LayerTree.organize). The plan is checked
// again against a fresh read just before it is applied, in case the document changed meanwhile.

import type { LayerTree } from "../ps/host.ts";
import type { TreeLayer } from "../core/layers/tree.ts";
import { deepseekJson } from "../core/assistant/deepseek.ts";
import { type OrganizePlan, ORGANIZE_MAX_LAYERS, ORGANIZE_SYSTEM, chosenPlan, describeLayers, organizeScope, organizeUserPrompt, parseOrganizePlan } from "../core/assistant/organize.ts";
import { log, withTimeout } from "../app/log.ts";
import { h, icon, replace } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

export interface AiOrganizeDeps {
  tree: LayerTree;
  /** the panel's current read of the document */
  state(): { docId: number | null; layers: TreeLayer[]; selected: ReadonlySet<number>; width: number; height: number };
  status: Status;
  refresh(): void;
  fetch: typeof fetch;
  /** the key and model from 功能设置 (read each time: they can change while the panel is open) */
  settings(): { key: string; model: string };
  /** where the sheet goes (a positioned element that the sheet covers) */
  host(): HTMLElement;
  /** the sheet opened or closed: UXP draws native text fields above everything regardless of z-index,
   *  so the panel takes its own (the search box) out of the DOM while the sheet is up */
  onOpenChange?(open: boolean): void;
}

const EXTRA_KEY = "wp.ai.organize.extra", RENAME_ONLY_KEY = "wp.ai.organize.renameOnly";
/** DeepSeek can take a while for a long list; give up after this long */
const TIMEOUT_MS = 180_000;

export function createAiOrganize(d: AiOrganizeDeps) {
  let sheet: HTMLElement | null = null;
  const button = h("button", { class: "lt-head-btn", title: "AI 整理：用 DeepSeek 给图层起清楚的中文名字，并把属于同一元素的相邻图层归进新组。先列出方案，勾选后一步执行，可以 Ctrl+Z 撤销。选中组：整理组内；选中多个图层：整理它们；否则整理整个文档。DeepSeek 看不到图像，只根据图层类型、文字内容、位置大小、智能对象文件名等判断。API Key 在 WavePlug 程序 › 功能设置 › AI 助手 里填写" }, "AI 整理");
  button.addEventListener("click", () => open());

  function close() {
    if (!sheet) return;
    sheet.remove(); sheet = null;
    d.onOpenChange?.(false);
  }

  function open() {
    if (sheet) return;
    const s = d.state();
    if (s.docId === null) { d.status("没有打开的文档", "error"); return; }
    const docId = s.docId;
    const scope = organizeScope(s.layers, s.selected);
    if (!scope.ids.length) { d.status("没有可以整理的图层（背景和 AI 结果组内部不整理）", "error"); return; }
    if (scope.ids.length > ORGANIZE_MAX_LAYERS) {
      d.status(`${scope.label}有 ${scope.ids.length} 个图层，一次最多整理 ${ORGANIZE_MAX_LAYERS} 个：先选中一个组或一部分图层`, "error");
      return;
    }
    if (!d.settings().key.trim()) { d.status("还没有填写 DeepSeek API Key：在 WavePlug 程序 › 功能设置 › AI 助手 里填写", "error"); return; }

    let plan: OrganizePlan | null = null, busy = false, run = 0;
    const offRenames = new Set<number>(), offGroups = new Set<number>();

    const extra = h("input", { class: "field", placeholder: "补充要求（可选），例如：按钮统一叫「按钮-…」", value: localStorage.getItem(EXTRA_KEY) ?? "" }) as HTMLInputElement;
    extra.addEventListener("input", () => { try { localStorage.setItem(EXTRA_KEY, extra.value); } catch { /* not kept */ } });
    extra.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Enter") void analyse(); e.stopPropagation(); });
    const renameOnly = h("input", { type: "checkbox" }) as HTMLInputElement;
    renameOnly.checked = localStorage.getItem(RENAME_ONLY_KEY) === "on";
    renameOnly.addEventListener("change", () => { try { localStorage.setItem(RENAME_ONLY_KEY, renameOnly.checked ? "on" : "off"); } catch { /* not kept */ } });
    const result = h("div", { class: "ai-org-result" });
    const msg = h("span", { class: "sheet-msg" });
    const againBtn = h("button", { class: "btn", title: "按上面的补充要求重新让 DeepSeek 分析" }, "重新分析");
    const applyBtn = h("button", { class: "btn primary" }, "应用");
    againBtn.addEventListener("click", () => void analyse());
    applyBtn.addEventListener("click", () => void apply());

    sheet = h("div", { class: "sheet ai-org" },
      h("div", { class: "sheet-head" },
        h("span", { class: "sheet-title" }, "AI 整理图层"),
        h("button", { class: "icon-btn", title: "关闭", onClick: close }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("div", { class: "muted small" }, `范围：${scope.label} · ${scope.ids.length} 个图层`),
        h("div", { class: "ai-org-ask" }, extra,
          h("label", { class: "check-row", title: "只改名字，不新建组" }, renameOnly, h("span", null, "只重命名，不归组"))),
        result),
      h("div", { class: "sheet-foot" }, msg, h("button", { class: "btn", onClick: close }, "取消"), againBtn, applyBtn));
    d.host().append(sheet);
    d.onOpenChange?.(true);
    render();
    void analyse();

    function render() {
      (againBtn as any).disabled = busy;
      const n = plan ? plan.renames.filter(r => !offRenames.has(r.id)).length + plan.groups.filter((_, i) => !offGroups.has(i)).length : 0;
      (applyBtn as any).disabled = busy || !n;
      replace(applyBtn, n ? `应用 ${n} 项` : "应用");
      if (busy) { replace(result, h("div", { class: "ai-org-wait" }, "DeepSeek 正在分析图层…（图层多时要几十秒）")); return; }
      if (!plan) { replace(result); return; }
      if (!plan.renames.length && !plan.groups.length) {
        replace(result, h("div", { class: "ai-org-wait" }, "DeepSeek 认为这些图层不需要整理"), notes(plan));
        return;
      }
      const check = (on: boolean, toggle: () => void) => {
        const c = h("input", { type: "checkbox" }) as HTMLInputElement;
        c.checked = on;
        c.addEventListener("change", () => { toggle(); render(); });
        return c;
      };
      const byId = new Map(d.state().layers.map(l => [l.id, l]));
      replace(result,
        plan.renames.length ? h("div", { class: "group-label" }, `改名（${plan.renames.length}）`) : null,
        ...plan.renames.map(r => h("label", { class: "check-row ai-org-row", title: `${r.from} → ${r.to}` },
          check(!offRenames.has(r.id), () => { if (!offRenames.delete(r.id)) offRenames.add(r.id); }),
          h("span", { class: "ai-org-from" }, r.from), h("span", { class: "ai-org-arrow" }, "→"), h("span", { class: "ai-org-to" }, r.to))),
        plan.groups.length ? h("div", { class: "group-label" }, `新建组（${plan.groups.length}）`) : null,
        ...plan.groups.map((g, i) => {
          const names = g.ids.map(id => plan!.renames.find(r => r.id === id)?.to ?? byId.get(id)?.name ?? `#${id}`);
          return h("label", { class: "check-row ai-org-row", title: `新组「${g.name}」：${names.join("、")}` },
            check(!offGroups.has(i), () => { if (!offGroups.delete(i)) offGroups.add(i); }),
            h("span", { class: "ai-org-to" }, g.name), h("span", { class: "ai-org-members" }, `${g.ids.length} 个：${names.join("、")}`));
        }),
        notes(plan));
    }

    function notes(p: OrganizePlan) {
      if (!p.dropped.length) return null;
      const shown = p.dropped.slice(0, 6);
      return h("div", { class: "muted small ai-org-notes", title: p.dropped.join("\n") },
        `没采用的建议（为了不改变画面）：${shown.join("；")}${p.dropped.length > shown.length ? ` 等 ${p.dropped.length} 条` : ""}`);
    }

    async function analyse() {
      if (busy) return;
      const mine = ++run;
      busy = true; plan = null; offRenames.clear(); offGroups.clear();
      msg.textContent = "";
      render();
      const started = Date.now();
      try {
        const now = d.state();
        if (now.docId !== docId) throw new Error("文档已切换，请重新打开 AI 整理");
        const textIds = scope.ids.filter(id => now.layers.find(l => l.id === id)?.kind === "text");
        const texts = textIds.length ? await d.tree.texts(docId, textIds).catch(e => { log("warn", "ai organize texts", e); return new Map<number, string>(); }) : new Map<number, string>();
        const lines = describeLayers(now.layers, scope.ids, texts);
        const user = organizeUserPrompt(lines, { width: now.width, height: now.height, renameOnly: renameOnly.checked, extra: extra.value });
        const cfg = d.settings();
        const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: cfg.model }, { system: ORGANIZE_SYSTEM, user }), TIMEOUT_MS, "DeepSeek ");
        if (mine !== run || !sheet) return;
        const fresh = d.state();
        const p = parseOrganizePlan(r.value, fresh.layers, scope.ids);
        if (renameOnly.checked) p.groups = [];
        plan = p;
        log("info", "ai organize plan", JSON.stringify({ model: r.model, layers: scope.ids.length, renames: p.renames.length, groups: p.groups.length, dropped: p.dropped.length, usage: r.usage, ms: Date.now() - started }));
      } catch (e) {
        if (mine !== run) return;
        msg.textContent = (e as Error)?.message ?? String(e);
        log("warn", "ai organize", msg.textContent);
      } finally {
        if (mine === run) { busy = false; if (sheet) render(); }
      }
    }

    async function apply() {
      if (busy || !plan) return;
      busy = true; render();
      try {
        // the document may have changed while the plan was shown: check the plan again on a fresh read
        const fresh = await d.tree.read();
        if (!fresh || fresh.docId !== docId) throw new Error("文档已切换，没有应用");
        const chosen = chosenPlan(plan, offRenames, offGroups);
        const checked = parseOrganizePlan(chosen, fresh.layers, scope.ids);
        const final = chosenPlan(checked, new Set(), new Set());
        const lost = chosen.renames.length + chosen.groups.length - (final.renames.length + final.groups.length);
        close();
        d.status("AI 整理：正在应用…", "busy");
        const res = await d.tree.organize(docId, final);
        const parts = [`改名 ${final.renames.length} 个`, ...(final.groups.length ? [`新建组 ${final.groups.length} 个`] : [])];
        const skippedText = res.skipped.length ? `；${res.skipped.length} 项没做成：${res.skipped.slice(0, 3).join("；")}` : "";
        d.status(`AI 整理完成：${parts.join("，")}（Ctrl+Z 可一步撤销）${lost ? `；${lost} 项因文档已改变跳过` : ""}${skippedText}`, res.skipped.length ? "error" : "ok");
        d.refresh();
      } catch (e) {
        const text = (e as Error)?.message ?? String(e);
        log("warn", "ai organize apply", text);
        if (sheet) { busy = false; msg.textContent = text; render(); }
        else d.status("AI 整理失败：" + text, "error");
      }
    }
  }

  return { button, open, isOpen: () => !!sheet, close };
}
