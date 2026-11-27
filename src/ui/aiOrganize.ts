// AI 整理图层 (WavePlug 图层 panel's AI 整理 button): asks DeepSeek for clear names and new groups for
// the layers in scope (core/assistant/organize.ts) and shows the plan in the helper's window beside
// the panel — the same window slot, highlight and lines as 检查结果 (core/overlay/organizePanel.ts).
// Each item can be unticked; the ticked ones are applied in Photoshop as one undo step
// (LayerTree.organize), after checking the plan again against a fresh read of the document.
//
// Every document has its own session (its plan, ticks, what is running): switching documents
// hides the window (docChanged) and coming back shows that document's again (reshow); an analysis
// still running finishes into the document it started for.

import type { Overlay } from "../app/overlay.ts";
import type { LayerTree } from "../ps/host.ts";
import type { TreeLayer } from "../core/layers/tree.ts";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import { SHEET_EDGE } from "../core/image/contactSheet.ts";
import { type OrganizePictures, type OrganizePlan, type OrganizeScope, ORGANIZE_MAX_LAYERS, ORGANIZE_MAX_PICTURES, ORGANIZE_SYSTEM, chosenPlan, describeLayers, organizeLookIds, organizeScope, organizeUserPrompt, parseOrganizePlan, textRenames } from "../core/assistant/organize.ts";
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
  /** the whole picture as a data URL, at most `maxEdge` px a side (参考图层画面) */
  composite?(docId: number, maxEdge: number): Promise<string>;
}

const EXTRA_KEY = "wp.ai.organize.extra", RENAME_ONLY_KEY = "wp.ai.organize.renameOnly", TEXT_NAMES_KEY = "wp.ai.organize.textNames", LOOK_KEY = "wp.ai.organize.look";

/** DeepSeek can take a while for a long list; give up after this long */
const TIMEOUT_MS = 180_000;
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } };

export function createAiOrganize(d: AiOrganizeDeps) {
  const button = h("button", { class: "lt-head-btn", title: "AI 整理：用 DeepSeek 给图层起清楚的中文名字，并把属于同一元素的相邻图层归进新组。方案显示在图层面板左边的窗口里，鼠标停在一项上，相关图层在面板和画面上标出并连线；勾选后一步执行，可以 Ctrl+Z 撤销。选中组：整理组内；选中多个图层：整理它们；否则整理整个文档。每个文档的方案分开保存。API Key 在 WavePlug 程序 › 功能设置 › AI 助手 里填写" }, "AI 整理");

  interface Session {
    docId: number;
    open: boolean;
    scope: OrganizeScope | null;
    plan: OrganizePlan | null;
    busy: string;
    error: string;
    run: number;
    /** the text layers' words as read for the plan (their names come from them) */
    texts: Map<number, string>;
    offRenames: Set<number>;
    offGroups: Set<number>;
  }
  const sessions = new Map<number, Session>();
  const sessionOf = (docId: number) => {
    let s = sessions.get(docId);
    if (!s) { s = { docId, open: false, scope: null, plan: null, busy: "", error: "", run: 0, texts: new Map(), offRenames: new Set(), offGroups: new Set() }; sessions.set(docId, s); }
    return s;
  };
  /** the session of the document in front (the one the window shows) */
  const cur = () => { const id = d.state().docId; return id === null ? null : sessions.get(id) ?? null; };
  const front = (s: Session) => d.state().docId === s.docId;
  let extra = read(EXTRA_KEY), renameOnly = read(RENAME_ONLY_KEY) === "on", textNames = read(TEXT_NAMES_KEY) !== "off", look = read(LOOK_KEY) === "on";

  const sections = (): OrganizeSections => {
    const s = cur();
    const nameOf = (id: number) => s?.plan?.renames.find(r => r.id === id)?.to ?? d.state().layers.find(l => l.id === id)?.name ?? `#${id}`;
    return {
      head: { scope: s?.scope ? `${s.scope.label} · ${s.scope.ids.length} 个图层` : "", busy: s?.busy ?? "", error: s?.error ?? "" },
      opts: { extra, renameOnly },
      plan: organizePlanSection(s?.plan ?? null, s?.offRenames ?? new Set(), s?.offGroups ?? new Set(), nameOf),
    };
  };
  /** a session changed: the window shows it when it is the front document's */
  const sync = (s?: Session | null) => { if (s && s.open && front(s)) d.overlay?.queueSync(); };

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
    const st = d.state();
    if (st.docId === null) { d.status("没有打开的文档", "error"); return; }
    const sc = organizeScope(st.layers, st.selected);
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
    const ov = d.overlay, st = d.state();
    if (!ov || st.docId === null) return;
    const sc = organizeScope(st.layers, st.selected);
    if (!sc.ids.length || sc.ids.length > ORGANIZE_MAX_LAYERS) return;
    d.opening();
    const s = sessionOf(st.docId);
    s.open = true; s.scope = sc;
    ov.hub.show(ORGANIZE_PANEL, null);
    void analyse(s);
  }

  const settingsPanel = createSetupPanel({
    overlay: d.overlay, id: ORGANIZE_SETUP, docId: () => d.state().docId,
    view: id => d.view?.(id) ?? Promise.resolve(null),
    form: (): SetupSections["form"] => {
      const st = d.state(), sc = organizeScope(st.layers, st.selected);
      const tooMany = sc.ids.length > ORGANIZE_MAX_LAYERS;
      return {
        title: "AI 整理图层",
        scope: `${sc.label} · ${sc.ids.length} 个图层（选中组：整理组内；选中多个图层：整理它们）`,
        fields: [
          { key: "textNames", kind: "toggle", label: "文字图层用文字内容命名", value: textNames, tip: "不交给 AI：文字图层的名字直接换成它的文字（第一行）" },
          { key: "renameOnly", kind: "toggle", label: "只改名字，不新建组", value: renameOnly },
          { key: "look", kind: "toggle", label: "参考图层画面（上传缩略图）", value: look, tip: "把整个画面的缩略图，和看不出内容的像素图层、智能对象拼成的带编号总览图发给 DeepSeek，按画的内容命名；会慢一些，保密的稿子不要勾" },
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

  /** closes the front document's AI 整理 (its plan is dropped) */
  function close() {
    settingsPanel.close();
    const s = cur();
    if (!s?.open) return;
    s.open = false; ++s.run; s.plan = null; s.busy = "";
    d.mark([], null);
    d.overlay?.hub.hide(ORGANIZE_PANEL);
  }

  async function analyse(s: Session) {
    if (!s.scope) return;
    const mine = ++s.run, id = s.docId, sc = s.scope;
    s.busy = "DeepSeek 正在分析图层…"; s.error = ""; s.plan = null; s.offRenames.clear(); s.offGroups.clear();
    sync(s);
    const started = Date.now();
    try {
      const now = d.state();
      if (now.docId !== id) throw new Error("请在这个文档里重新分析");
      const textIds = sc.ids.filter(x => now.layers.find(l => l.id === x)?.kind === "text");
      s.texts = textIds.length ? await d.tree.texts(id, textIds).catch(e => { log("warn", "ai organize texts", e); return new Map<number, string>(); }) : new Map<number, string>();
      // 参考图层画面: the whole picture, and the layers whose name says nothing (pixel / smart
      // object) numbered on 总览图 sheets — a picture costs the same however much is on it
      const images: string[] = [];
      const pictures: OrganizePictures = { overview: false, cells: [] };
      let picturesLeft = 0;
      if (look) {
        const want = organizeLookIds(now.layers, sc.ids);
        picturesLeft = want.more;
        s.busy = want.ids.length ? `正在拼 ${want.ids.length} 个图层的缩略图…` : "正在读取画面…"; sync(s);
        const whole = await d.composite?.(id, SHEET_EDGE).catch(e => { log("warn", "ai organize overview", e); return null; });
        if (whole) { images.push(whole); pictures.overview = true; }
        if (want.ids.length && d.tree.layerSheets) {
          const byId = new Map(now.layers.map(l => [l.id, l]));
          const sheets = await d.tree.layerSheets(id, want.ids.map(x => { const l = byId.get(x)!; return { id: x, bounds: { left: l.left, top: l.top, right: l.left + l.width, bottom: l.top + l.height } }; }))
            .catch(e => { log("warn", "ai organize sheets", e); return null; });
          if (sheets?.images.length) {
            images.push(...sheets.images);
            sheets.cells.forEach((c, i) => { if (c && c.sheet < sheets.images.length) pictures.cells.push({ ...c, id: want.ids[i] }); });
          }
        }
        if (images.length) { s.busy = "DeepSeek 正在看图分析图层…"; sync(s); }
      }
      if (mine !== s.run || !s.open) return;
      const user = organizeUserPrompt(describeLayers(now.layers, sc.ids, s.texts), { width: now.width, height: now.height, renameOnly, extra, pictures });
      const cfg = d.settings();
      const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: images.length ? DEEPSEEK_VISION_MODEL : cfg.model },
        { system: ORGANIZE_SYSTEM, user, ...(images.length ? { images, maxTokens: 8000 } : {}) }), TIMEOUT_MS, "DeepSeek ");
      if (mine !== s.run || !s.open) return;
      // the document's layers now; another document in front: as they were read at the start
      const fresh = d.state().docId === id ? d.state().layers : now.layers;
      const p = parseOrganizePlan(r.value, fresh, sc.ids, { texts: s.texts });
      // text layers: named by their words, not by DeepSeek
      const fromText = textNames ? textRenames(fresh, sc.ids, s.texts).filter(t => !p.renames.some(x => x.id === t.id)) : [];
      p.renames = [...fromText, ...p.renames];
      if (picturesLeft) p.dropped.push(`看不出内容的图层太多，只给前 ${pictures.cells.length} 个附了缩略图，剩下 ${picturesLeft} 个只按图层信息判断：可以分组选中再整理一次`);
      if (renameOnly) p.groups = [];
      s.plan = p;
      log("info", "ai organize plan", JSON.stringify({ doc: id, model: r.model, layers: sc.ids.length, pictures: pictures.cells.length, overview: pictures.overview, images: images.length, renames: p.renames.length, groups: p.groups.length, dropped: p.dropped.length, usage: r.usage, ms: Date.now() - started }));
    } catch (e) {
      if (mine !== s.run) return;
      s.error = (e as Error)?.message ?? String(e);
      log("warn", "ai organize", s.error);
    }
    if (mine === s.run) { s.busy = ""; sync(s); }
  }

  async function apply() {
    const s = cur();
    if (!s?.plan || !s.scope || s.busy) return;
    const id = s.docId, sc = s.scope;
    s.busy = "正在应用…"; s.error = ""; sync(s);
    try {
      // the document may have changed while the plan was shown: check the plan again on a fresh read
      const fresh = await d.tree.read();
      if (!fresh || fresh.docId !== id) throw new Error("文档已切换，没有应用");
      const chosen = chosenPlan(s.plan, s.offRenames, s.offGroups);
      const checked = parseOrganizePlan(chosen, fresh.layers, sc.ids, { texts: s.texts });
      const final = chosenPlan(checked, new Set(), new Set());
      const lost = chosen.renames.length + chosen.groups.length - (final.renames.length + final.groups.length);
      const res = await d.tree.organize(id, final);
      if (front(s)) close(); else { s.open = false; s.plan = null; s.busy = ""; }
      const parts = [`改名 ${final.renames.length} 个`, ...(final.groups.length ? [`新建组 ${final.groups.length} 个`] : [])];
      const skippedText = res.skipped.length ? `；${res.skipped.length} 项没做成：${res.skipped.slice(0, 3).join("；")}` : "";
      d.status(`AI 整理完成：${parts.join("，")}（Ctrl+Z 可一步撤销）${lost ? `；${lost} 项因文档已改变跳过` : ""}${skippedText}`, res.skipped.length ? "error" : "ok");
      d.refresh();
    } catch (e) {
      s.busy = ""; s.error = (e as Error)?.message ?? String(e);
      log("warn", "ai organize apply", s.error);
      sync(s);
    }
  }

  async function act(a: OrganizeAction) {
    const s = cur();
    switch (a.kind) {
      case "hover": {
        const ids = a.key ? organizeItemIds(s?.plan ?? null, a.key) : [];
        d.mark(ids, ids.length ? "warn" : null);
        return;
      }
      case "toggle": {
        if (!s) return;
        const n = Number(a.key.slice(2)), set = a.key.startsWith("r:") ? s.offRenames : s.offGroups;
        if (!set.delete(n)) set.add(n);
        sync(s);
        return;
      }
      case "extra": extra = a.text; keep(EXTRA_KEY, extra); sync(s); return;
      case "rename-only": renameOnly = a.on; keep(RENAME_ONLY_KEY, a.on ? "on" : "off"); sync(s); return;
      case "analyse": if (s) void analyse(s); return;
      case "apply": void apply(); return;
      case "close": close(); return;
    }
  }

  return {
    button,
    /** the front document has AI 整理 open (or its settings) */
    isOpen: () => !!cur()?.open || settingsPanel.isOpen(),
    close,
    syncSetup: () => settingsPanel.sync(),
    /** another document is in front: the window goes (its session stays) */
    docChanged() { d.overlay?.hub.hide(ORGANIZE_PANEL); },
    /** the front document had AI 整理 open: show it again; false when it hadn't */
    reshow(): boolean {
      const s = cur();
      if (!s?.open) return false;
      d.overlay?.hub.show(ORGANIZE_PANEL, null);
      return true;
    },
    /** a document closed: its session goes */
    forget(docId: number) { sessions.delete(docId); },
  };
}
