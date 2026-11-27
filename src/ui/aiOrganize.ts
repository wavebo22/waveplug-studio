// AI 整理图层 (WavePlug 图层 panel's AI 整理 button): asks DeepSeek for clear names and new groups for
// the layers in scope (core/assistant/organize.ts) and shows the plan in the helper's window beside
// the panel — the same window slot, highlight and lines as 检查结果 (core/overlay/organizePanel.ts).
// Each item can be unticked; the ticked ones are applied in Photoshop as one undo step
// (LayerTree.organize), after checking the plan again against a fresh read of the document.

import type { Overlay } from "../app/overlay.ts";
import type { LayerTree } from "../ps/host.ts";
import type { TreeLayer } from "../core/layers/tree.ts";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import { type OrganizePlan, type OrganizeScope, ORGANIZE_MAX_LAYERS, ORGANIZE_MAX_PICTURES, ORGANIZE_SYSTEM, chosenPlan, describeLayers, organizeLookIds, organizeScope, organizeUserPrompt, parseOrganizePlan, textRenames } from "../core/assistant/organize.ts";
import { ORGANIZE_PANEL, type OrganizeAction, type OrganizeSections, organizeItemIds, organizePlanSection, parseOrganizeAction } from "../core/overlay/organizePanel.ts";
import { log, withTimeout } from "../app/log.ts";
import { ORGANIZE_SETUP, type SetupSections } from "../core/overlay/setupPanel.ts";
import type { CanvasView } from "../core/overlay/protocol.ts";
import { createSetupPanel } from "./setupPanel.ts";
import { SETUP_HELPER_VERSION } from "../core/overlay/protocol.ts";
import { h } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

export interface AiOrganizeDeps {
  overlay?: Overlay;
  tree: LayerTree;
  /** the panel's current read of the document */
  state(): { docId: number | null; layers: TreeLayer[]; selected: ReadonlySet<number>; width: number; height: number };
  status: Status;
  refresh(): void;
  fetch: typeof fetch;
  /** the key and model from 功能设置 (read each time: they can change while the panel is open) */
  settings(): { key: string; model: string };
  /** light up these layers (the same as 检查结果's hover; null: none) */
  mark(ids: number[], sev: "warn" | null): void;
  /** the window is about to show AI 整理: whatever else it showed (检查结果) closes */
  opening(): void;
  /** the canvas view, to put the settings panel in the corner */
  view?(docId: number): Promise<CanvasView | null>;
}

const EXTRA_KEY = "wp.ai.organize.extra", RENAME_ONLY_KEY = "wp.ai.organize.renameOnly", TEXT_NAMES_KEY = "wp.ai.organize.textNames", LOOK_KEY = "wp.ai.organize.look";
/** a layer picture's long edge (px) for 参考图层画面 */
const PICTURE_PX = 160;
/** DeepSeek can take a while for a long list; give up after this long */
const TIMEOUT_MS = 180_000;
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } };

export function createAiOrganize(d: AiOrganizeDeps) {
  const button = h("button", { class: "lt-head-btn", title: "AI 整理：用 DeepSeek 给图层起清楚的中文名字，并把属于同一元素的相邻图层归进新组。方案显示在图层面板左边的窗口里，鼠标停在一项上，相关图层在面板和画面上标出并连线；勾选后一步执行，可以 Ctrl+Z 撤销。选中组：整理组内；选中多个图层：整理它们；否则整理整个文档。API Key 在 WavePlug 程序 › 功能设置 › AI 助手 里填写" }, "AI 整理");

  let open = false, docId: number | null = null, scope: OrganizeScope | null = null;
  let plan: OrganizePlan | null = null, busy = "", error = "", run = 0;
  /** the text layers' words as read for the plan (their names come from them) */
  let texts = new Map<number, string>();
  let extra = read(EXTRA_KEY), renameOnly = read(RENAME_ONLY_KEY) === "on", textNames = read(TEXT_NAMES_KEY) !== "off", look = read(LOOK_KEY) === "on";
  const offRenames = new Set<number>(), offGroups = new Set<number>();

  const nameOf = (id: number) => plan?.renames.find(r => r.id === id)?.to ?? d.state().layers.find(l => l.id === id)?.name ?? `#${id}`;
  const sections = (): OrganizeSections => ({
    head: { scope: scope ? `${scope.label} · ${scope.ids.length} 个图层` : "", busy, error },
    opts: { extra, renameOnly },
    plan: organizePlanSection(plan, offRenames, offGroups, nameOf),
  });
  const sync = () => { if (open) d.overlay?.queueSync(); };

  d.overlay?.hub.register<OrganizeSections, OrganizeAction>({
    id: ORGANIZE_PANEL,
    sections,
    parseAction: parseOrganizeAction,
    onAction: a => void act(a),
  });

  button.addEventListener("click", () => {
    const ov = d.overlay;
    if (!ov?.connected) { d.status("AI 整理的方案显示在 WavePlug 程序里，它现在没有运行：点 Studio 面板右上角的连接状态启动它", "error"); return; }
    if (!ov.setupReady) { d.status(`AI 整理需要 WavePlug 程序 ${SETUP_HELPER_VERSION}（现在是 ${ov.helperVersion ?? "旧版"}）：在面板顶部的更新提醒里点「更新」`, "error"); return; }
    const s = d.state();
    if (s.docId === null) { d.status("没有打开的文档", "error"); return; }
    const sc = organizeScope(s.layers, s.selected);
    if (!sc.ids.length) { d.status("没有可以整理的图层（背景和 AI 结果组内部不整理）", "error"); return; }
    if (sc.ids.length > ORGANIZE_MAX_LAYERS) {
      d.status(`${sc.label}有 ${sc.ids.length} 个图层，一次最多整理 ${ORGANIZE_MAX_LAYERS} 个：先选中一个组或一部分图层`, "error");
      return;
    }
    if (!d.settings().key.trim()) { d.status("还没有填写 DeepSeek API Key：在 WavePlug 程序 › 功能设置 › AI 助手 里填写", "error"); return; }
    // the click is in this panel: the helper takes the window under the cursor as the panel
    // (the plan goes beside it once 开始 is clicked in the settings)
    ov.anchorPanel();
    settingsPanel.open();
  });

  /** 开始 in the settings: the layers in scope now, then DeepSeek */
  function begin() {
    const ov = d.overlay, s = d.state();
    if (!ov || s.docId === null) return;
    const sc = organizeScope(s.layers, s.selected);
    if (!sc.ids.length || sc.ids.length > ORGANIZE_MAX_LAYERS) return;
    d.opening();
    open = true; docId = s.docId; scope = sc;
    ov.hub.show(ORGANIZE_PANEL, null);
    void analyse();
  }

  const settingsPanel = createSetupPanel({
    overlay: d.overlay, id: ORGANIZE_SETUP, docId: () => d.state().docId,
    view: id => d.view?.(id) ?? Promise.resolve(null),
    form: (): SetupSections["form"] => {
      const s = d.state(), sc = organizeScope(s.layers, s.selected);
      const tooMany = sc.ids.length > ORGANIZE_MAX_LAYERS;
      return {
        title: "AI 整理图层",
        scope: `${sc.label} · ${sc.ids.length} 个图层（选中组：整理组内；选中多个图层：整理它们）`,
        fields: [
          { key: "textNames", kind: "toggle", label: "文字图层用文字内容命名", value: textNames, tip: "不交给 AI：文字图层的名字直接换成它的文字（第一行）" },
          { key: "renameOnly", kind: "toggle", label: "只改名字，不新建组", value: renameOnly },
          { key: "look", kind: "toggle", label: "参考图层画面（上传缩略图）", value: look, tip: `把看不出内容的像素图层和智能对象的小缩略图（每次最多 ${ORGANIZE_MAX_PICTURES} 张）发给 DeepSeek，按画的内容命名；会更慢一些，保密的稿子不要勾` },
          { key: "extra", kind: "text", label: "补充要求（可选）", hint: "例如：按钮统一叫「按钮-…」", value: extra },
        ],
        start: sc.ids.length && !tooMany ? "开始分析" : "",
        note: !sc.ids.length ? "没有可以整理的图层（背景和 AI 结果组内部不整理）" : tooMany ? `一次最多整理 ${ORGANIZE_MAX_LAYERS} 个图层：先选中一个组或一部分图层` : "只改看不出内容的名字；归组只收相邻的同级图层，不改变画面",
      };
    },
    set(k, v) {
      if (k === "textNames" && typeof v === "boolean") { textNames = v; keep(TEXT_NAMES_KEY, v ? "on" : "off"); }
      else if (k === "renameOnly" && typeof v === "boolean") { renameOnly = v; keep(RENAME_ONLY_KEY, v ? "on" : "off"); }
      else if (k === "look" && typeof v === "boolean") { look = v; keep(LOOK_KEY, v ? "on" : "off"); }
      else if (k === "extra" && typeof v === "string") { extra = v; keep(EXTRA_KEY, v); }
    },
    start: begin,
  });

  function close() {
    settingsPanel.close();
    if (!open) return;
    open = false; ++run;
    d.mark([], null);
    d.overlay?.hub.hide(ORGANIZE_PANEL);
  }

  async function analyse() {
    if (!scope || docId === null) return;
    const mine = ++run, id = docId, sc = scope;
    busy = "DeepSeek 正在分析图层…"; error = ""; plan = null; offRenames.clear(); offGroups.clear();
    sync();
    const started = Date.now();
    try {
      const now = d.state();
      if (now.docId !== id) throw new Error("文档已切换，请重新打开 AI 整理");
      const textIds = sc.ids.filter(x => now.layers.find(l => l.id === x)?.kind === "text");
      texts = textIds.length ? await d.tree.texts(id, textIds).catch(e => { log("warn", "ai organize texts", e); return new Map<number, string>(); }) : new Map<number, string>();
      // 参考图层画面: pictures of the layers whose name says nothing (pixel / smart object)
      const pictures: number[] = [], images: string[] = [];
      let picturesLeft = 0;
      if (look) {
        const want = organizeLookIds(now.layers, sc.ids);
        picturesLeft = want.more;
        if (want.ids.length) {
          busy = `正在读取 ${want.ids.length} 个图层的缩略图…`; sync();
          const byId = new Map(now.layers.map(l => [l.id, l]));
          const urls = await d.tree.thumbnails(id, want.ids.map(x => { const l = byId.get(x)!; return { id: x, bounds: { left: l.left, top: l.top, right: l.left + l.width, bottom: l.top + l.height } }; }), { width: now.width, height: now.height }, PICTURE_PX)
            .catch(e => { log("warn", "ai organize pictures", e); return [] as (string | null | undefined)[]; });
          urls.forEach((u, i) => { if (typeof u === "string" && u.startsWith("data:image/")) { pictures.push(want.ids[i]); images.push(u); } });
          busy = "DeepSeek 正在看图分析图层…"; sync();
        }
      }
      if (mine !== run || !open) return;
      const user = organizeUserPrompt(describeLayers(now.layers, sc.ids, texts), { width: now.width, height: now.height, renameOnly, extra, pictures });
      const cfg = d.settings();
      const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: images.length ? DEEPSEEK_VISION_MODEL : cfg.model },
        { system: ORGANIZE_SYSTEM, user, ...(images.length ? { images, maxTokens: 8000 } : {}) }), TIMEOUT_MS, "DeepSeek ");
      if (mine !== run || !open) return;
      const fresh = d.state().layers;
      const p = parseOrganizePlan(r.value, fresh, sc.ids, { texts });
      // text layers: named by their words, not by DeepSeek
      const fromText = textNames ? textRenames(fresh, sc.ids, texts).filter(t => !p.renames.some(x => x.id === t.id)) : [];
      p.renames = [...fromText, ...p.renames];
      if (picturesLeft) p.dropped.push(`看不出内容的图层太多，只给前 ${pictures.length} 个附了缩略图，剩下 ${picturesLeft} 个只按图层信息判断：可以分组选中再整理一次`);
      if (renameOnly) p.groups = [];
      plan = p;
      log("info", "ai organize plan", JSON.stringify({ model: r.model, layers: sc.ids.length, pictures: pictures.length, renames: p.renames.length, groups: p.groups.length, dropped: p.dropped.length, usage: r.usage, ms: Date.now() - started }));
    } catch (e) {
      if (mine !== run) return;
      error = (e as Error)?.message ?? String(e);
      log("warn", "ai organize", error);
    }
    if (mine === run) { busy = ""; sync(); }
  }

  async function apply() {
    if (!plan || !scope || docId === null || busy) return;
    const id = docId, sc = scope;
    busy = "正在应用…"; error = ""; sync();
    try {
      // the document may have changed while the plan was shown: check the plan again on a fresh read
      const fresh = await d.tree.read();
      if (!fresh || fresh.docId !== id) throw new Error("文档已切换，没有应用");
      const chosen = chosenPlan(plan, offRenames, offGroups);
      const checked = parseOrganizePlan(chosen, fresh.layers, sc.ids, { texts });
      const final = chosenPlan(checked, new Set(), new Set());
      const lost = chosen.renames.length + chosen.groups.length - (final.renames.length + final.groups.length);
      const res = await d.tree.organize(id, final);
      close();
      const parts = [`改名 ${final.renames.length} 个`, ...(final.groups.length ? [`新建组 ${final.groups.length} 个`] : [])];
      const skippedText = res.skipped.length ? `；${res.skipped.length} 项没做成：${res.skipped.slice(0, 3).join("；")}` : "";
      d.status(`AI 整理完成：${parts.join("，")}（Ctrl+Z 可一步撤销）${lost ? `；${lost} 项因文档已改变跳过` : ""}${skippedText}`, res.skipped.length ? "error" : "ok");
      d.refresh();
    } catch (e) {
      busy = ""; error = (e as Error)?.message ?? String(e);
      log("warn", "ai organize apply", error);
      sync();
    }
  }

  async function act(a: OrganizeAction) {
    switch (a.kind) {
      case "hover": {
        const ids = a.key ? organizeItemIds(plan, a.key) : [];
        d.mark(ids, ids.length ? "warn" : null);
        return;
      }
      case "toggle": {
        const n = Number(a.key.slice(2)), set = a.key.startsWith("r:") ? offRenames : offGroups;
        if (!set.delete(n)) set.add(n);
        sync();
        return;
      }
      case "extra": extra = a.text; keep(EXTRA_KEY, extra); sync(); return;
      case "rename-only": renameOnly = a.on; keep(RENAME_ONLY_KEY, a.on ? "on" : "off"); sync(); return;
      case "analyse": void analyse(); return;
      case "apply": void apply(); return;
      case "close": close(); return;
    }
  }

  return { button, isOpen: () => open || settingsPanel.isOpen(), close, syncSetup: () => settingsPanel.sync() };
}
