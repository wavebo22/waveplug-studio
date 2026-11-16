// WaveLayer for Illustrator: the panel. Reads the document through the host script (ai/host/
// wavelayer.jsx) and draws it like Illustrator's own Layers panel, with what WaveLayer adds:
// search with type filters, paint-drag over eyes and locks, batch rename, 整理, artboard switch,
// and 牵手 Photoshop (send selections over as vector smart objects, update them, take layers back,
// swap colours) through the WavePlug helper.
//
// Illustrator is the source of truth: after every change the tree is read again. Keys name places
// (core: src/ai/model.ts); open groups are remembered with their label so a key that now names
// something else isn't opened by mistake.

import { h, icon, replace, setShown } from "../ui/dom.ts";
import { createPopup, type PopItem } from "../ui/popupMenu.ts";
import { type RenameOptions, RENAME_DEFAULTS, renamePlan } from "../core/layers/batchRename.ts";
import { BOARD_MAX_ITEMS, type BoardNode, type PsInfo } from "../core/overlay/bridge.ts";
import type { AiHost } from "./host.ts";
import type { PsLink } from "./bridge.ts";
import {
  type AiNode, type AiTree, type Row, type Where, FILTER_FLAGS, FILTER_KINDS, KIND_LABEL, clickSelect, dropProblem, dropText, dropWhere,
  footerText, index, isContainer, keepOpen, neighbour, outermost, rows, selectedKeys, within,
} from "./model.ts";

export interface PanelDeps {
  host: AiHost;
  ps: PsLink;
  version: string;
  /** reloads the panel and the host script (development) */
  reload?: () => void;
}

interface Settings { follow: boolean; swatches: boolean; dense: boolean; autoSync: boolean; keepPlace: boolean; /** 发送 as pixels (else a vector smart object) */ sendPixels: boolean; /** 画板 → Photoshop: the new document's resolution */ boardPpi: number }
const SETTINGS_KEY = "wl.ai.settings";
const POLL_MS = 700, FULL_MS = 4000;

/** Illustrator's own layer colours */
const LAYER_COLORS: [string, string][] = [["#4f80ff", "浅蓝色"], ["#ff4f4f", "红色"], ["#4fff4f", "绿色"], ["#4f4fff", "蓝色"], ["#ffff4f", "黄色"],
  ["#ff4fff", "洋红色"], ["#4fffff", "青色"], ["#808080", "灰色"], ["#000000", "黑色"], ["#ff6600", "橙色"]];

const KIND_ICON: Record<string, string> = {
  layer: "psFolder", group: "psFolder", clip: "psClip", path: "psShape", compound: "psShape", text: "psText",
  placed: "psLink", raster: "psImage", symbol: "psSmart", mesh: "psShape", plugin: "psSmart", graph: "psAdjust", other: "psShape",
};

function loadSettings(): Settings {
  const base: Settings = { follow: true, swatches: true, dense: false, autoSync: false, keepPlace: false, sendPixels: false, boardPpi: 300 };
  try { return { ...base, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") }; }
  catch { return base; }
}

export function mountPanel(root: HTMLElement, deps: PanelDeps) {
  const { host, ps } = deps;
  const settings = loadSettings();
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ } };

  // ── state ──
  let tree: AiTree = { doc: null }, treeText = "", lastSig = "", lastFull = 0;
  let open = new Map<string, string>(), docKey = "";
  /** open groups per document (keys are places in one document), kept between sessions */
  const OPEN_KEY = "wl.ai.open";
  const savedOpen = (): Record<string, [string, string][]> => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") ?? {}; } catch { return {}; } };
  const saveOpen = () => {
    if (!docKey) return;
    const all = savedOpen();
    delete all[docKey];
    all[docKey] = [...open].slice(0, 300);
    // the 20 documents used last
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(all)); } catch { /* full */ }
  };
  let picked: string[] = [], anchor: string | null = null, lastAiSel = "", followHold = false;
  let searchText = "", kinds = new Set<string>(), flags = new Set<string>(), results: AiNode[] | null = null, truncated = false;
  let renaming: string | null = null, paint: { prop: "hidden" | "locked"; value: boolean; done: Set<string> } | null = null;
  let drag: { keys: string[]; nodes: AiNode[]; startY: number; active: boolean; target?: { node: AiNode; where: Where; ok: boolean } } | null = null;
  let psInfo: PsInfo | null = null, psBusy = false;

  // ── layout ──
  const docName = h("select", { class: "wl-doc grow", title: "打开的文档：切换" }) as HTMLSelectElement;
  docName.addEventListener("change", () => void act("activateDocument", { index: Number(docName.value) }));
  docName.addEventListener("mousedown", () => void fillDocs());
  /** the open documents, read when the list is about to open (and when the document changes) */
  async function fillDocs() {
    try {
      const r = await host.call<{ docs: string[]; active: number }>("documents");
      replace(docName, ...(r.docs.length ? r.docs : ["没有打开的文档"]).map((n, i) => h("option", { value: String(i), selected: i === r.active }, n + (i === r.active && tree.doc && !tree.doc.saved ? " *" : ""))));
      docName.disabled = !r.docs.length;
    } catch { /* busy */ }
  }
  const boardSel = h("select", { class: "wl-board", title: "画板：切换并适合窗口" }) as HTMLSelectElement;
  const head = h("div", { class: "wl-head" }, docName, boardSel,
    h("button", { class: "icon-btn", title: "选择当前画板上的对象", onClick: () => act("artboard", { index: boardSel.selectedIndex, select: true }) }, icon("psMove")),
    h("button", { class: "icon-btn", title: "画板：改名、删除、按选中对象新建或缩放", onClick: () => void openBoards() }, icon("image")),
    h("button", { class: "icon-btn", title: "文档检查：缺失链接、游离点、空文字……", onClick: () => void openReport() }, icon("warn")),
    h("button", { class: "icon-btn", title: "设置", onClick: () => openSettings() }, icon("sliders")),
    deps.reload ? h("button", { class: "icon-btn", title: "重新载入面板和脚本（开发）", onClick: () => deps.reload!() }, icon("refresh")) : null);
  boardSel.addEventListener("change", () => act("artboard", { index: boardSel.selectedIndex, fit: true }));

  const psDot = h("span", { class: "wl-dot" }), psText = h("span", { class: "wl-ps-text grow" });
  const psBtn = (label: string, tip: string, run: () => Promise<void>) => {
    const b = h("button", { class: "btn wl-ps-btn", title: tip, onClick: () => { if (!psBusy) void bridgeRun(run); } }, label);
    return b;
  };
  // 发送: one button, sending the way the list next to it says (remembered)
  const sendMode = h("select", { class: "wl-board wl-send-mode", title: "发送方式：矢量智能对象（可以「更新」，双击在 Illustrator 里编辑）或像素图层（按 Photoshop 文档的分辨率栅格化）" },
    h("option", { value: "vector", selected: !settings.sendPixels }, "矢量智能对象"), h("option", { value: "pixels", selected: settings.sendPixels }, "像素图层")) as HTMLSelectElement;
  sendMode.addEventListener("change", () => { settings.sendPixels = sendMode.value === "pixels"; saveSettings(); });
  const psButtons: HTMLElement[] = [
    psBtn("发送", "把 Illustrator 里选中的对象发送到 Photoshop 当前文档（方式见右边）", () => sendToPs(settings.sendPixels)),
    sendMode,
    psBtn("更新", "选中的对象以前发送过：把 Photoshop 里对应的智能对象换成现在的样子。什么都没选时更新整个文档的所有关联", () => updatePs()),
    psBtn("画板", "当前画板在 Photoshop 里作为新文档打开：每个对象单独一个矢量智能对象，图层 / 编组结构、名字、位置、不透明度、混合模式和显示状态不变，以后都可以「更新」", () => artboardToPs()),
  ];
  const psBar = h("div", { class: "wl-ps" }, h("div", { class: "wl-ps-line" }, psDot, psText), h("div", { class: "wl-ps-btns" }, ...psButtons));

  const search = h("input", { class: "field wl-search", type: "search", placeholder: "搜索名称或文字", title: "在整个文档里找（Ctrl+F）。回车搜索，Esc 清除" }) as HTMLInputElement;
  const filterBtn = h("button", { class: "icon-btn", title: "按类型和状态筛选", onClick: () => { setShown(chips, chips.style.display === "none"); } }, icon("filters"));
  const tools = h("div", { class: "wl-tools" }, search, filterBtn,
    h("button", { class: "icon-btn", title: "定位到 Illustrator 里选中的对象", onClick: () => void revealSelection(true) }, icon("psMove")),
    h("button", { class: "icon-btn", title: "全部折叠", onClick: () => { open.clear(); followHold = true; void refresh(true); } }, icon("chevronUp")));
  const chips = h("div", { class: "wl-chips" });
  setShown(chips, false);

  const list = h("div", { class: "wl-list", tabIndex: 0 });
  const status = h("div", { class: "wl-status" });
  const footText = h("span", { class: "wl-foot-text grow" });
  const foot = h("div", { class: "wl-foot" }, footText,
    h("button", { class: "icon-btn", title: "撤销（面板里 Ctrl+Z）", onClick: () => void act("undo", {}, "已撤销") }, icon("soReset")),
    h("button", { class: "icon-btn", title: "收集到新图层", onClick: () => collect() }, icon("psFolderOpen")),
    h("button", { class: "icon-btn", title: "新建子图层", onClick: () => newLayer(true) }, icon("layers")),
    h("button", { class: "icon-btn", title: "新建图层", onClick: () => newLayer(false) }, icon("psNew")),
    h("button", { class: "icon-btn", title: "删除选中的（Delete）", onClick: () => removePicked() }, icon("psTrash")));
  const BLEND_LABELS: [string, string][] = [["NORMAL", "正常"], ["MULTIPLY", "正片叠底"], ["SCREEN", "滤色"], ["OVERLAY", "叠加"], ["SOFTLIGHT", "柔光"], ["HARDLIGHT", "强光"],
    ["COLORDODGE", "颜色减淡"], ["COLORBURN", "颜色加深"], ["DARKEN", "变暗"], ["LIGHTEN", "变亮"], ["DIFFERENCE", "差值"], ["EXCLUSION", "排除"],
    ["HUE", "色相"], ["SATURATIONBLEND", "饱和度"], ["COLORBLEND", "混色"], ["LUMINOSITY", "明度"]];
  const opacityIn = h("input", { class: "field wl-opacity", type: "number", min: "0", max: "100", step: "1", title: "不透明度（%），回车应用；滚轮每格 5" }) as HTMLInputElement;
  const blendSel = h("select", { class: "wl-blend", title: "混合模式" }, ...BLEND_LABELS.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  const propsBar = h("div", { class: "wl-props" }, h("span", { class: "small muted" }, "不透明度"), opacityIn, h("span", { class: "small muted" }, "%"), blendSel);
  setShown(propsBar, false);
  let propsFor = "";
  async function showAppearance() {
    const first = pickedNodes()[0];
    const want = first ? first.key + "|" + first.label : "";
    setShown(propsBar, !!first);
    if (!first || want === propsFor) return;
    propsFor = want;
    try {
      const a = await host.call<{ opacity: number; blend: string }>("appearance", { target: expect(first) });
      if (document.activeElement !== opacityIn) opacityIn.value = String(a.opacity);
      blendSel.value = a.blend;
    } catch { /* the tree changed meanwhile */ }
  }
  const applyOpacity = () => {
    const v = Math.max(0, Math.min(100, Math.round(Number(opacityIn.value))));
    if (!Number.isFinite(v)) return;
    opacityIn.value = String(v);
    const ns = pickedNodes();
    if (ns.length) void act("setAppearance", { targets: ns.map(expect), opacity: v }, `不透明度 ${v}%（${ns.length} 项）`);
  };
  opacityIn.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") applyOpacity(); });
  opacityIn.addEventListener("change", applyOpacity);
  opacityIn.addEventListener("wheel", e => {
    e.preventDefault();
    opacityIn.value = String(Math.max(0, Math.min(100, (Number(opacityIn.value) || 0) + (e.deltaY < 0 ? 5 : -5))));
    applyOpacity();
  }, { passive: false });
  blendSel.addEventListener("change", () => {
    const ns = pickedNodes();
    if (ns.length) void act("setAppearance", { targets: ns.map(expect), blend: blendSel.value }, `混合模式：${blendSel.selectedOptions[0]?.textContent}`);
  });
  const sheetHost = h("div", { class: "wl-sheets" });
  const ghost = h("div", { class: "wl-ghost" });
  setShown(ghost, false);
  const shell = h("div", { class: "wl" + (settings.dense ? " dense" : "") }, head, psBar, tools, chips, list, propsBar, status, foot, sheetHost, ghost);
  replace(root, shell);
  const popup = createPopup(shell);

  // ── status ──
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  function say(text: string, kind: "info" | "ok" | "error" = "info") {
    status.textContent = text;
    status.className = "wl-status " + kind;
    if (statusTimer) clearTimeout(statusTimer);
    if (kind !== "error") statusTimer = setTimeout(() => { status.textContent = ""; }, 6000);
  }

  // ── reading ──
  const order = () => (results ? results.map(n => n.key) : rows(tree.layers ?? []).map(r => r.node.key));
  const nodes = () => index(results ?? tree.layers ?? []);

  async function refresh(force = false) {
    if (renaming || drag?.active || paint) return;
    let t: AiTree;
    try { t = await host.call<AiTree>("tree", { open: [...open.keys()] }); }
    catch (e) { say((e as Error).message, "error"); return; }
    lastFull = Date.now();
    // another document came to the front: its own open groups, nothing picked
    const key = t.doc ? (t.doc.path || t.doc.name) : "";
    if (key !== docKey) {
      saveOpen();
      docKey = key;
      open = new Map(savedOpen()[key] ?? []);
      picked = []; anchor = null; lastAiSel = ""; results = null; search.value = "";
      if (open.size) {
        try { t = await host.call<AiTree>("tree", { open: [...open.keys()] }); } catch { /* keep the first read */ }
      }
      // filters still on: the same search in this document
      if (kinds.size || flags.size) setTimeout(() => void runSearch(), 0);
    }
    tree = t;
    // labels of keys opened by 定位 are filled in now; those naming something else are dropped
    const idx0 = index(t.layers ?? []);
    for (const [k, label] of open) if (!label && idx0.has(k)) open.set(k, idx0.get(k)!.label);
    open = keepOpen(open, t.layers ?? []);
    saveOpen();
    // the selection Illustrator has (changed there, or by us): rows follow it
    const aiSel = selectedKeys(t.layers ?? []), selText = aiSel.join(",") + "|" + (t.selCount ?? 0);
    if (selText !== lastAiSel) {
      const known = nodes();
      const external = !aiSel.every(k => picked.includes(k)) || picked.some(k => !known.has(k));
      lastAiSel = selText;
      if (external) picked = aiSel.length ? aiSel : t.active ? [t.active] : [];
      // not after the user folded something: its selected children went out of view, the
      // selection itself didn't change (跟随选择 would open it again)
      if (settings.follow && !followHold && (t.selCount ?? 0) > 0 && aiSel.length === 0 && !results) { void revealSelection(false); }
    }
    followHold = false;
    const known = nodes();
    picked = picked.filter(k => known.has(k));
    if (!picked.length && t.active && !(t.selCount ?? 0)) picked = [t.active];
    const text = JSON.stringify(t) + "|" + picked.join(",");
    if (force || text !== treeText) { treeText = text; render(); }
  }

  // a changed sig is read in full only once it stayed the same for one more poll: right after a
  // paste (Ctrl+F / Ctrl+B) or a transform Illustrator is still rebuilding the bounding box, and
  // reading every item's selection then gave 「定界框或自由变换遇到未知错误 PARM」 and hangs
  let seenSig = "", quietUntil = 0;
  async function poll() {
    if (document.hidden || host.busy || renaming || drag?.active || paint || Date.now() < quietUntil) return;
    try {
      const s = await host.call<string>("sig");
      if (s !== lastSig && s !== seenSig) { seenSig = s; return; }
      // a full read on a (settled) change, or now and then while the pointer is over the panel
      // (each read makes Illustrator wait a moment; changes deep inside groups don't show in the sig)
      if (s !== lastSig || (pointerIn && Date.now() - lastFull > FULL_MS)) { lastSig = s; seenSig = s; await refresh(); }
    } catch { quietUntil = Date.now() + 3000; /* Illustrator busy (a dialog, an error): leave it alone for a while */ }
  }
  setInterval(() => { void poll(); }, POLL_MS);
  let pointerIn = false;
  root.addEventListener("mouseenter", () => { pointerIn = true; void refresh(); });
  root.addEventListener("mouseleave", () => { pointerIn = false; });

  async function revealSelection(loud: boolean) {
    try {
      const r = await host.call<{ keys: string[]; open: string[] }>("reveal", { limit: 200 });
      if (!r.keys.length) { if (loud) say("Illustrator 里没有选中的对象"); return; }
      // labels are filled in when the tree comes back
      for (const k of r.open) if (!open.has(k)) open.set(k, "");
      const t = await host.call<AiTree>("tree", { open: [...open.keys()] });
      const idx = index(t.layers ?? []);
      for (const k of r.open) { const n = idx.get(k); if (n) open.set(k, n.label); }
      picked = r.keys;
      anchor = r.keys[0];
      await refresh(true);
      list.querySelector(`[data-key="${CSS.escape(r.keys[0])}"]`)?.scrollIntoView({ block: "nearest" });
    } catch (e) { say((e as Error).message, "error"); }
  }

  // ── changes ──
  const expect = (n: AiNode) => ({ key: n.key, expect: { kind: n.kind, label: n.label } });
  const pickedNodes = () => { const m = nodes(); return outermost(picked, order()).map(k => m.get(k)).filter((n): n is AiNode => !!n); };

  async function act(op: string, args: unknown, done?: string) {
    try {
      const v = await host.call(op, args);
      if (done) say(done, "ok");
      return v;
    } catch (e) { say((e as Error).message, "error"); return null; }
    finally { await refresh(); if (results) await runSearch(); }
  }

  async function selectKeys(keys: string[], opts: { art?: boolean } = {}) {
    const m = nodes(), ns = keys.map(k => m.get(k)).filter((n): n is AiNode => !!n);
    const items = ns.filter(n => n.kind !== "layer");
    picked = keys;
    markPicked();
    if (items.length) await host.call("select", { targets: items.map(expect) }).catch(e => say((e as Error).message, "error"));
    else if (ns.length) await host.call("select", { targets: [expect(ns[0])], add: !opts.art, art: opts.art }).catch(e => say((e as Error).message, "error"));
    await refresh();
  }

  /** the picked rows highlighted in place: replacing the rows between two clicks would lose a double click */
  function markPicked() {
    for (const el of Array.from(list.querySelectorAll(".wl-row"))) {
      const row = el as HTMLElement;
      row.classList.toggle("picked", picked.includes(row.dataset.key ?? ""));
    }
  }

  /** each layer into its own file, in a folder Illustrator asks for */
  async function exportLayersTo(ns: AiNode[], format: "png" | "svg") {
    say(`正在导出 ${ns.length} 个图层…`);
    const r = await act("exportLayers", { targets: ns.map(expect), format, scale: 200 }) as { cancelled?: boolean; folder?: string; files?: string[]; skipped?: string[] } | null;
    if (!r || r.cancelled) { if (r?.cancelled) say("已取消导出"); return; }
    say(`已导出 ${r.files!.length} 个文件到 ${r.folder}` + (r.skipped!.length ? `；${r.skipped!.length} 个图层没有可见对象（${r.skipped!.join("、")}）` : ""), "ok");
  }

  function removePicked() {
    const ns = pickedNodes();
    if (!ns.length) return say("先选中要删除的图层或对象");
    void act("remove", { targets: ns.map(expect) }).then(v => {
      picked = [];
      const r = v as { removed: number } | null;
      if (!r) return;
      say(r.removed === ns.length ? `已删除 ${r.removed} 项（Ctrl+Z 撤销）` : `删除了 ${r.removed} 项，${ns.length - r.removed} 项没删掉（锁定的图层或对象删不了，先解锁）`, r.removed === ns.length ? "ok" : "error");
    });
  }

  function newLayer(sub: boolean) {
    const ref = pickedNodes()[0];
    if (sub && !ref) return say("先选中一个图层");
    void act("newLayer", { target: ref ? expect(ref) : undefined, sub }, sub ? "已新建子图层" : "已新建图层");
  }

  function collect() {
    const ns = pickedNodes();
    if (!ns.length) return say("先选中要收集的图层或对象");
    void act("collect", { targets: ns.map(expect) }, `已把 ${ns.length} 项收集到新图层`);
  }

  async function menuCmd(cmd: string, done?: string) {
    const ns = pickedNodes().filter(n => n.kind !== "layer");
    if (ns.length) await host.call("select", { targets: ns.map(expect) }).catch(() => undefined);
    await act("menu", { cmd }, done);
  }

  // ── search ──
  async function runSearch() {
    const text = search.value.trim();
    searchText = text;
    if (!text && !kinds.size && !flags.size) { results = null; render(); return; }
    try {
      const r = await host.call<{ results: AiNode[]; truncated: boolean }>("search", { text, kinds: [...kinds], flags: [...flags] });
      results = r.results;
      truncated = r.truncated;
    } catch (e) { say((e as Error).message, "error"); results = []; }
    render();
  }
  search.addEventListener("keydown", e => {
    if (e.key === "Enter") void runSearch();
    if (e.key === "Escape") { search.value = ""; void runSearch(); }
  });
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => { if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(() => void runSearch(), 350); });

  function renderChips() {
    const chip = (label: string, on: boolean, toggle: () => void) => {
      const c = h("button", { class: "wl-chip" + (on ? " on" : ""), onClick: () => { toggle(); renderChips(); void runSearch(); } }, label);
      return c;
    };
    replace(chips,
      ...FILTER_KINDS.map(k => chip(KIND_LABEL[k], kinds.has(k), () => { if (kinds.has(k)) kinds.delete(k); else kinds.add(k); })),
      h("span", { class: "wl-chip-sep" }),
      ...FILTER_FLAGS.map(([f, label]) => chip(label, flags.has(f), () => { if (flags.has(f)) flags.delete(f); else flags.add(f); })));
    filterBtn.classList.toggle("on", kinds.size + flags.size > 0);
  }
  renderChips();

  // ── drawing ──
  function rowEl(r: Row | { node: AiNode; depth: number; open: boolean; layerColor: string | null; dim: boolean }, flat: boolean): HTMLElement {
    const n = r.node, on = picked.includes(n.key);
    const eye = h("div", { class: "wl-cell wl-eye" + (n.hidden ? " off" : ""), title: "显示 / 隐藏（Alt+点：只显示这个；按住拖过多行）" }, n.hidden ? null : icon("psEye"));
    const lock = h("div", { class: "wl-cell wl-lock" + (n.locked ? " on" : ""), title: "锁定（Alt+点：只解锁这个；按住拖过多行）" }, n.locked ? icon("psLock") : null);
    const twist = h("div", { class: "wl-twist" }, n.count > 0 && isContainer(n.kind) && !flat ? icon(r.open ? "chevron" : "chevronRight", 12) : null);
    const swatch = settings.swatches && n.fill && n.fill.startsWith("#") ? h("span", { class: "wl-swatch", style: `background:${n.fill}` }) : null;
    const kindIcon = h("span", { class: "wl-kind k-" + n.kind + (n.mask ? " mask" : ""), title: KIND_LABEL[n.kind] + (n.mask ? "（剪切路径）" : "") }, icon(KIND_ICON[n.kind] ?? "psShape", 14));
    const labelEl = h("span", { class: "wl-label" + (n.name ? "" : " auto") + (n.missing ? " missing" : "") }, n.label);
    const countEl = isContainer(n.kind) && n.count > 0 && !r.open && !flat ? h("span", { class: "wl-count", title: `${n.count} 项` }, String(n.count)) : null;
    const linkBadge = n.link ? h("span", { class: "wl-badge", title: "已发送到 Photoshop（点一下：更新到 Photoshop）" }, "PS") : null;
    const target = h("div", { class: "wl-target" + (n.sel ? " on" : ""), title: n.kind === "layer" ? "选择这个图层里的所有对象" : "选择 / 取消选择" });
    const main = h("div", { class: "wl-main", style: `padding-left:${flat ? 4 : 4 + r.depth * 14}px` }, twist, swatch ?? kindIcon, h("div", { class: "wl-text" }, labelEl, flat && n.trail ? h("span", { class: "wl-trail" }, n.trail) : null), countEl, linkBadge);
    const row = h("div", { class: "wl-row" + (n.kind === "layer" ? " layer" : "") + (on ? " picked" : "") + (r.dim || n.hidden ? " dim" : "") + (flat ? " flat" : ""), "data-key": n.key },
      h("span", { class: "wl-color", style: r.layerColor ? `background:${r.layerColor}` : "" }), eye, lock, main, target);

    eye.addEventListener("mousedown", e => cellDown(e, n, "hidden"));
    lock.addEventListener("mousedown", e => cellDown(e, n, "locked"));
    eye.addEventListener("mouseenter", () => cellEnter(n, "hidden"));
    lock.addEventListener("mouseenter", () => cellEnter(n, "locked"));
    twist.addEventListener("mousedown", e => e.stopPropagation());
    twist.addEventListener("click", e => { e.stopPropagation(); toggleOpen(n, e.altKey); });
    target.addEventListener("mousedown", e => e.stopPropagation());
    target.addEventListener("click", e => {
      e.stopPropagation();
      if (n.kind === "layer") void selectKeys([n.key], { art: true });
      else void act("select", { targets: [expect(n)], add: true, toggle: true });
    });
    linkBadge?.addEventListener("mousedown", e => e.stopPropagation());
    linkBadge?.addEventListener("click", e => { e.stopPropagation(); void bridgeRun(() => updateLink(n.link!, n.label)); });
    linkBadge?.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      const r = shell.getBoundingClientRect();
      popup.open([
        { heading: "和 Photoshop 的关联" },
        { label: "更新到 Photoshop", enabled: ps.ready, run: () => void bridgeRun(() => updateLink(n.link!, n.label)) },
        { label: "在 Photoshop 中选中", enabled: ps.ready, run: () => void bridgeRun(async () => { const v = await ps.request<{ name: string; docName: string }>({ kind: "reveal", link: n.link! }); say(`已在 Photoshop 里选中「${v.name}」（${v.docName}）`, "ok"); }) },
        { label: "选中 Illustrator 里关联的对象", run: () => void act("selectLink", { link: n.link }) },
      ], (e as MouseEvent).clientY - r.top, { left: (e as MouseEvent).clientX - r.left });
    });
    main.addEventListener("mousedown", e => rowDown(e as MouseEvent, n));
    row.addEventListener("contextmenu", e => { e.preventDefault(); contextMenu(e as MouseEvent, n); });
    return row;
  }

  function render() {
    if (renaming) return;
    const shownDoc = tree.doc ? tree.doc.name : "";
    if (docName.dataset.doc !== shownDoc + (tree.doc?.saved ? "" : "*")) { docName.dataset.doc = shownDoc + (tree.doc?.saved ? "" : "*"); void fillDocs(); }
    docName.title = (tree.doc?.path || "") + "\n切换打开的文档";
    replace(boardSel, ...(tree.doc?.artboards ?? []).map((b, i) => h("option", { value: String(i), selected: i === tree.doc!.artboard }, `${i + 1}. ${b}`)));
    boardSel.disabled = !tree.doc;
    footText.textContent = results ? `找到 ${results.length}${truncated ? "+" : ""} 项` : footerText(tree);
    shell.classList.toggle("dense", settings.dense);
    const scroll = list.scrollTop;
    if (!tree.doc) {
      replace(list, h("div", { class: "wl-empty" }, "在 Illustrator 里打开一个文档"));
      return;
    }
    if (results) {
      const head = h("div", { class: "wl-results-head" },
        h("span", { class: "grow" }, results.length ? `搜索结果${truncated ? "（只列出前 500 项）" : ""}` : "没有找到"),
        results.length ? h("button", { class: "btn wl-mini", title: "在 Illustrator 里选中所有结果", onClick: () => void selectKeys(results!.filter(n => n.kind !== "layer").map(n => n.key)) }, "全选结果") : null,
        h("button", { class: "btn wl-mini", onClick: () => { search.value = ""; kinds.clear(); flags.clear(); renderChips(); void runSearch(); } }, "清除"));
      replace(list, head, ...results.map(n => rowEl({ node: n, depth: 0, open: false, layerColor: null, dim: false }, true)));
    } else {
      replace(list, ...rows(tree.layers ?? []).map(r => {
        const el = rowEl(r, false);
        return r.node.more && r.open ? [el, h("div", { class: "wl-more", style: `padding-left:${60 + (r.depth + 1) * 14}px` }, `还有 ${r.node.more} 项没有列出`)] : [el];
      }).flat());
    }
    list.scrollTop = scroll;
    renderPs();
    void showAppearance();
  }

  function toggleOpen(n: AiNode, all: boolean) {
    if (open.has(n.key)) {
      for (const k of [...open.keys()]) if (within(k, n.key)) open.delete(k);
      followHold = true;
      void refresh(true);
      return;
    }
    open.set(n.key, n.label);
    if (!all) { void refresh(true); return; }
    // Alt: everything inside, a few levels deep
    void (async () => {
      for (let round = 0; round < 5; round++) {
        const t = await host.call<AiTree>("tree", { open: [...open.keys()] });
        let added = 0;
        for (const x of index(t.layers ?? []).values()) {
          if (within(x.key, n.key) && x.count > 0 && isContainer(x.kind) && !open.has(x.key)) { open.set(x.key, x.label); added++; }
        }
        if (!added) break;
      }
      await refresh(true);
    })();
  }

  // ── eye / lock painting ──
  function cellDown(e: Event, n: AiNode, prop: "hidden" | "locked") {
    e.stopPropagation();
    e.preventDefault();
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    if (me.altKey) { void act("others", { target: expect(n), prop }, prop === "hidden" ? "只显示这一项（再按一次 Alt 恢复）" : "只解锁这一项（再按一次 Alt 恢复）"); return; }
    const value = prop === "hidden" ? !n.hidden : !n.locked;
    paint = { prop, value, done: new Set([n.key]) };
    void host.call("setProp", { targets: [expect(n)], prop, value }).catch(err => say((err as Error).message, "error"));
    markCell(n.key, prop, value);
  }
  // the button is let go anywhere: painting ends, and the tree is read again
  document.addEventListener("mouseup", () => { if (paint) { paint = null; void refresh(); } });
  window.addEventListener("blur", () => { if (paint) { paint = null; void refresh(); } });
  function cellEnter(n: AiNode, prop: "hidden" | "locked") {
    if (!paint || paint.prop !== prop || paint.done.has(n.key)) return;
    paint.done.add(n.key);
    void host.call("setProp", { targets: [expect(n)], prop, value: paint.value }).catch(err => say((err as Error).message, "error"));
    markCell(n.key, prop, paint.value);
  }
  function markCell(key: string, prop: "hidden" | "locked", value: boolean) {
    const cell = list.querySelector(`[data-key="${CSS.escape(key)}"] .${prop === "hidden" ? "wl-eye" : "wl-lock"}`) as HTMLElement | null;
    if (!cell) return;
    if (prop === "hidden") { cell.classList.toggle("off", value); replace(cell, value ? null : icon("psEye")); }
    else { cell.classList.toggle("on", value); replace(cell, value ? icon("psLock") : null); }
  }

  // ── rows: click, drag ──
  let lastClick = { key: "", at: 0 };
  function rowDown(e: MouseEvent, n: AiNode) {
    if (e.button !== 0) return;
    list.focus();
    drag = { keys: picked.includes(n.key) ? outermost(picked, order()) : [n.key], nodes: [], startY: e.clientY, active: false };
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    const startNode = n;
    const move = (m: MouseEvent) => {
      if (!drag) return;
      if (!drag.active && Math.abs(m.clientY - drag.startY) > 4 && !results) {
        drag.active = true;
        const idx = nodes();
        drag.nodes = drag.keys.map(k => idx.get(k)).filter((x): x is AiNode => !!x);
        ghost.textContent = drag.nodes.length === 1 ? drag.nodes[0].label : `${drag.nodes.length} 项`;
        setShown(ghost, true);
      }
      if (drag.active) dragOver(m);
    };
    const up = (m: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const d = drag;
      drag = null;
      clearDropMarks();
      setShown(ghost, false);
      if (d?.active) {
        if (d.target?.ok) {
          const copy = m.altKey;
          void act("move", { targets: d.nodes.map(expect), dest: expect(d.target.node), where: d.target.where, copy }, dropText(d.target.where, d.target.node, copy, d.nodes.length));
        } else if (d.target) say(dropProblem(d.nodes, d.target.node, d.target.where) ?? "", "error");
        return;
      }
      // a second click on the same row soon after: rename (the rows may have been drawn again in
      // between, so the browser's own dblclick isn't reliable)
      const now = Date.now();
      if (!mods.ctrl && !mods.shift && lastClick.key === startNode.key && now - lastClick.at < 450) {
        lastClick = { key: "", at: 0 };
        const el = list.querySelector(`[data-key="${CSS.escape(startNode.key)}"] .wl-label`) as HTMLElement | null;
        const cur = nodes().get(startNode.key);
        if (el && cur) startRename(cur, el);
        return;
      }
      lastClick = { key: startNode.key, at: now };
      // a click
      const r = clickSelect(order(), picked, anchor, startNode.key, mods);
      anchor = r.anchor;
      void selectKeys(r.keys);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function clearDropMarks() {
    for (const el of Array.from(list.querySelectorAll(".drop-before, .drop-after, .drop-inside, .drop-bad"))) el.classList.remove("drop-before", "drop-after", "drop-inside", "drop-bad");
  }

  function dragOver(m: MouseEvent) {
    if (!drag) return;
    ghost.style.left = m.clientX + 12 + "px";
    ghost.style.top = m.clientY + 8 + "px";
    ghost.classList.toggle("copy", m.altKey);
    clearDropMarks();
    const rowNode = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest(".wl-row") as HTMLElement | null;
    // near the list's edges: scroll
    const lr = list.getBoundingClientRect();
    if (m.clientY < lr.top + 24) list.scrollTop -= 12;
    else if (m.clientY > lr.bottom - 24) list.scrollTop += 12;
    if (!rowNode) { drag.target = undefined; return; }
    const n = nodes().get(rowNode.dataset.key ?? "");
    if (!n) { drag.target = undefined; return; }
    const rr = rowNode.getBoundingClientRect();
    const where = dropWhere(n, (m.clientY - rr.top) / rr.height, !!n.children);
    const problem = dropProblem(drag.nodes, n, where);
    drag.target = { node: n, where, ok: !problem };
    rowNode.classList.add(problem ? "drop-bad" : "drop-" + where);
    say(problem ?? dropText(where, n, m.altKey, drag.nodes.length), problem ? "error" : "info");
  }

  // ── rename ──
  function startRename(n: AiNode, labelEl: HTMLElement) {
    renaming = n.key;
    const input = h("input", { class: "field wl-rename", value: n.name || "" }) as HTMLInputElement;
    if (!n.name) input.placeholder = n.label;
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      if (save && name !== n.name) void act("rename", { items: [{ ...expect(n), name }] }, "已改名");
      else void refresh(true);
    };
    input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
  }

  // ── keyboard ──
  list.addEventListener("keydown", e => {
    if (renaming) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); removePicked(); }
    else if (k === "F2") {
      const n = pickedNodes()[0], el = n && list.querySelector(`[data-key="${CSS.escape(n.key)}"] .wl-label`) as HTMLElement | null;
      if (n && el) startRename(n, el);
    } else if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      const next = neighbour(order(), picked, k === "ArrowUp");
      if (next) { anchor = next; void selectKeys([next]); list.querySelector(`[data-key="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" }); }
    } else if (k === "ArrowRight" || k === "ArrowLeft") {
      const n = pickedNodes()[0];
      if (n && isContainer(n.kind) && (k === "ArrowRight") !== open.has(n.key)) toggleOpen(n, false);
    } else if (ctrl && k.toLowerCase() === "g") { e.preventDefault(); void menuCmd(e.shiftKey ? "ungroup" : "group", e.shiftKey ? "已取消编组" : "已编组"); }
    else if (ctrl && k.toLowerCase() === "f") { e.preventDefault(); search.focus(); }
    // the panel has the keyboard: Illustrator's own Ctrl+Z wouldn't reach it
    else if (ctrl && k.toLowerCase() === "z") { e.preventDefault(); void act(e.shiftKey ? "redo" : "undo", {}, e.shiftKey ? "已重做" : "已撤销"); }
    else if (ctrl && k.toLowerCase() === "y") { e.preventDefault(); void act("redo", {}, "已重做"); }
  });

  // ── menus ──
  function contextMenu(e: MouseEvent, n: AiNode) {
    if (!picked.includes(n.key)) { picked = [n.key]; anchor = n.key; void selectKeys([n.key]); }
    const ns = pickedNodes(), one = ns.length === 1, items = ns.filter(x => x.kind !== "layer"), layersOnly = !items.length;
    const anyGroup = ns.some(x => x.kind === "group" || x.kind === "clip"), anyClip = ns.some(x => x.kind === "clip"), anyCompound = ns.some(x => x.kind === "compound");
    const menu: PopItem[] = [
      { label: one ? "重命名" : `批量重命名 ${ns.length} 项…`, hint: one ? "F2" : undefined, run: () => { if (one) { const el = list.querySelector(`[data-key="${CSS.escape(n.key)}"] .wl-label`) as HTMLElement | null; if (el) startRename(n, el); } else openRename(ns); } },
      { label: "复制", run: () => void act("duplicate", { targets: ns.map(expect) }, `已复制 ${ns.length} 项`) },
      { label: "删除", hint: "Delete", run: () => removePicked() },
      "-",
      { label: "新建子图层", enabled: n.kind === "layer", run: () => newLayer(true) },
      { label: "释放到图层（顺序）", enabled: one && n.kind === "layer" && n.count > 0, run: () => void act("releaseToLayers", { target: expect(n) }, "已把每个对象放进自己的子图层") },
      { label: `导出图层为 PNG（${layersOnly ? ns.length : 0} 个，2 倍）…`, enabled: layersOnly, run: () => void exportLayersTo(ns, "png") },
      { label: `导出图层为 SVG（${layersOnly ? ns.length : 0} 个）…`, enabled: layersOnly, run: () => void exportLayersTo(ns, "svg") },
      { label: `合并所选图层（${layersOnly ? ns.length : 0}）`, enabled: layersOnly && ns.length > 1, run: () => void act("mergeLayers", { targets: ns.map(expect) }, `已合并到「${ns[0].label}」`).then(() => { picked = []; }) },
      { label: "收集到新图层", run: () => collect() },
      ...(layersOnly ? [
        { heading: "图层选项" } as PopItem,
        { swatches: LAYER_COLORS.map(([c, title]) => ({ color: c, title, on: n.color === c, run: () => void act("layerOptions", { targets: ns.map(expect), color: c }) })) } as PopItem,
        { label: (n.printable === false ? "" : "✓ ") + "打印", run: () => void act("layerOptions", { targets: ns.map(expect), printable: n.printable === false }, n.printable === false ? "图层会打印" : "图层不打印（导出 PDF / 打印时跳过）") } as PopItem,
        { label: (n.preview === false ? "" : "✓ ") + "预览（取消 = 轮廓）", run: () => void act("layerOptions", { targets: ns.map(expect), preview: n.preview === false }) } as PopItem,
      ] : []),
      "-",
      { label: "编组", hint: "Ctrl+G", enabled: items.length > 0, run: () => void menuCmd("group", "已编组") },
      { label: "取消编组", hint: "Ctrl+Shift+G", enabled: anyGroup, run: () => void menuCmd("ungroup", "已取消编组") },
      { label: "建立剪切蒙版", enabled: items.length > 1, run: () => void menuCmd("makeMask", "已建立剪切蒙版") },
      { label: "释放剪切蒙版", enabled: anyClip, run: () => void menuCmd("releaseMask", "已释放剪切蒙版") },
      { label: "建立复合路径", enabled: items.length > 1, run: () => void menuCmd("compound", "已建立复合路径") },
      { label: "释放复合路径", enabled: anyCompound, run: () => void menuCmd("releaseCompound", "已释放复合路径") },
      "-",
      { heading: "排列" },
      { label: "置于顶层", enabled: !layersOnly, run: () => void menuCmd("bringFront") },
      { label: "前移一层", enabled: !layersOnly, run: () => void menuCmd("bringForward") },
      { label: "后移一层", enabled: !layersOnly, run: () => void menuCmd("sendBackward") },
      { label: "置于底层", enabled: !layersOnly, run: () => void menuCmd("sendBack") },
      "-",
      { label: "只显示这一项", hint: "Alt+眼睛", enabled: one, run: () => void act("others", { target: expect(n), prop: "hidden" }) },
      { label: "只解锁这一项", hint: "Alt+锁", enabled: one, run: () => void act("others", { target: expect(n), prop: "locked" }) },
      { label: "全部显示", run: () => void act("menu", { cmd: "showAll" }, "已全部显示") },
      { label: "全部解锁", run: () => void act("menu", { cmd: "unlockAll" }, "已全部解锁") },
      "-",
      { heading: "选择相同" },
      ...([["sameFill", "填充颜色"], ["sameStroke", "描边颜色"], ["sameFillStroke", "填色和描边"], ["sameStrokeWeight", "描边粗细"], ["sameOpacity", "不透明度"], ["sameBlend", "混合模式"], ["sameAppearance", "外观"], ["sameStyle", "图形样式"], ["sameSymbol", "符号实例"]] as const)
        .map(([cmd, label]) => ({ label, enabled: one && !layersOnly, run: () => void menuCmd(cmd) })),
      "-",
      { heading: "Photoshop" },
      { label: "发送到 Photoshop（矢量智能对象）", enabled: !layersOnly && ps.ready, run: () => void bridgeRun(() => sendToPs(false)) },
      { label: "发送到 Photoshop（像素图层）", enabled: !layersOnly && ps.ready, run: () => void bridgeRun(() => sendToPs(true)) },
      { label: "更新到 Photoshop", enabled: ps.ready && ns.some(x => x.link), run: () => void bridgeRun(() => updatePs()) },
      { label: "Photoshop 前景色加入色板", enabled: ps.ready, run: () => void bridgeRun(async () => {
        const { hex } = await ps.request<{ hex: string }>({ kind: "get-color" });
        const r = await host.call<{ name: string }>("addSwatch", { hex, name: `PS ${hex.toUpperCase()}` });
        say(`已加入色板「${r.name}」`, "ok");
      }) },
      { label: `按图层分别发送（${layersOnly ? ns.length : 0} 个图层）`, enabled: layersOnly && ps.ready, run: () => void bridgeRun(() => layersToPs(ns)) },
    ];
    const r = shell.getBoundingClientRect();
    popup.open(menu, e.clientY - r.top, { left: e.clientX - r.left });
  }

  // ── sheets ──
  function sheet(title: string, ...body: (Node | null)[]): HTMLElement {
    const s = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, title), h("button", { class: "icon-btn", onClick: () => s.remove() }, icon("close"))),
      h("div", { class: "sheet-body" }, ...body));
    replace(sheetHost, s);
    return s;
  }

  function openRename(ns: AiNode[]) {
    const o: RenameOptions = { ...RENAME_DEFAULTS, number: true };
    const field = (label: string, key: keyof RenameOptions, type = "text") => {
      const input = h("input", { class: "field", type, value: String(o[key]) }) as HTMLInputElement;
      input.addEventListener("input", () => { (o as any)[key] = type === "number" ? Number(input.value) : input.value; preview(); });
      return h("div", { class: "param" }, h("span", { class: "small" }, label), input);
    };
    const num = h("input", { type: "checkbox", checked: o.number }) as HTMLInputElement;
    num.addEventListener("change", () => { o.number = num.checked; preview(); });
    const out = h("div", { class: "wl-rename-preview" });
    const plan = () => renamePlan(ns.map((n, i) => ({ id: i, name: n.name || n.label })), o);
    const preview = () => {
      const p = plan();
      replace(out, ...p.slice(0, 40).map(x => h("div", { class: "small" }, `${x.from} → ${x.to}`)), p.length > 40 ? h("div", { class: "small muted" }, `…共 ${p.length} 项`) : null);
    };
    const s = sheet(`批量重命名 ${ns.length} 项`,
      field("查找", "find"), field("替换为", "replace"), field("前缀", "prefix"), field("后缀", "suffix"),
      h("label", { class: "check-row" }, num, h("span", null, "末尾加序号")),
      field("起始序号", "start", "number"), field("位数", "digits", "number"),
      out,
      h("button", { class: "btn primary", onClick: () => {
        const p = plan();
        s.remove();
        if (!p.length) return say("没有名字需要改");
        void act("rename", { items: p.map(x => ({ ...expect(ns[x.id]), name: x.to })) }, `已重命名 ${p.length} 项`);
      } }, "重命名"));
    preview();
  }

  function openCleanup() {
    const boxes: [string, string, boolean][] = [["emptyLayers", "删除空图层（至少留一个图层）", true], ["emptyGroups", "删除空编组", true], ["emptyText", "删除空文字", true]];
    const inputs = boxes.map(([, , on]) => h("input", { type: "checkbox", checked: on }) as HTMLInputElement);
    const s = sheet("整理文档",
      ...boxes.map(([, label], i) => h("label", { class: "check-row" }, inputs[i], h("span", null, label))),
      h("div", { class: "small muted" }, "锁定的不动。做完可以在 Illustrator 里撤销。"),
      h("button", { class: "btn primary", onClick: async () => {
        s.remove();
        const what = boxes.filter((_, i) => inputs[i].checked).map(([k]) => k);
        const r = await act("cleanup", { what }) as { emptyLayers: number; emptyGroups: number; emptyText: number } | null;
        if (r) say(`已删除 ${r.emptyLayers} 个空图层、${r.emptyGroups} 个空编组、${r.emptyText} 个空文字`, "ok");
      } }, "整理"));
    void s;
  }

  async function openBoards() {
    let r: { boards: { name: string; width: number; height: number }[]; active: number };
    try { r = await host.call("artboards"); } catch (e) { say((e as Error).message, "error"); return; }
    const again = () => { s.remove(); void openBoards(); };
    const op = async (args: object, done: string) => { const v = await act("boardOp", args, done); if (v) again(); };
    const s = sheet(`画板（${r.boards.length}）`,
      ...r.boards.map((b, i) => {
        const name = h("input", { class: "field wl-board-name", value: b.name, title: "回车改名" }) as HTMLInputElement;
        name.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter" && name.value.trim()) void op({ op: "rename", index: i, name: name.value.trim() }, "已改名"); });
        return h("div", { class: "wl-boardrow" + (i === r.active ? " on" : "") },
          h("span", { class: "wl-board-i" }, String(i + 1)), name,
          h("span", { class: "small muted wl-board-size" }, `${b.width}×${b.height}`),
          h("button", { class: "icon-btn", title: "切到这个画板并适合窗口", onClick: () => { void act("artboard", { index: i, fit: true }); s.remove(); } }, icon("psMove")),
          h("button", { class: "icon-btn", title: "缩放到选中的对象", onClick: () => void op({ op: "fit", index: i }, "画板已缩放到选中对象") }, icon("wbPlace")),
          h("button", { class: "icon-btn", title: "删除画板（上面的对象不删）", onClick: () => void op({ op: "remove", index: i }, "已删除画板") }, icon("psTrash")));
      }),
      h("button", { class: "btn", onClick: () => void op({ op: "add" }, "已按选中对象新建画板") }, "按选中对象新建画板"),
      h("button", { class: "btn", title: "和 Photoshop 当前文档一样大（按它的分辨率换算成点）：以「保留在画板上的位置」发送时，放进 Photoshop 就是 1:1 的位置", onClick: async () => {
        try {
          const i = await info();
          if (!i.doc) { say("Photoshop 没有打开的文档"); return; }
          const k = 72 / (i.doc.ppi || 72);
          await op({ op: "addSize", width: i.doc.width * k, height: i.doc.height * k, name: i.doc.name.replace(/\.[^.]+$/, "") }, `已按「${i.doc.name}」新建画板`);
        } catch (e) { say((e as Error).message, "error"); }
      } }, "按 Photoshop 文档新建画板"));
  }

  async function openReport() {
    let r: { total: number; counts: Record<string, number>; issues: { id: string; label: string; count: number; keys: string[] }[]; artboards: number };
    try { r = await host.call("report"); } catch (e) { say((e as Error).message, "error"); return; }
    const found = r.issues.filter(x => x.count > 0);
    const counts = Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k} ${v}`).join(" · ");
    const s = sheet("文档检查",
      h("div", { class: "small muted" }, `共 ${r.total} 项，${r.artboards} 个画板：${counts}`),
      found.length ? null : h("div", { class: "small" }, "没有发现问题"),
      ...found.map(x => h("div", { class: "wl-issue" },
        h("span", { class: "grow" }, `${x.label}`),
        h("span", { class: "wl-issue-n" }, String(x.count)),
        h("button", { class: "btn wl-mini", title: x.keys.length < x.count ? `选中前 ${x.keys.length} 个` : "在 Illustrator 里选中它们", onClick: async () => {
          s.remove();
          const sel = await host.call<{ selected: number; failed?: number }>("selectKeys", { targets: x.keys.map(key => ({ key })) }).catch(e => { say((e as Error).message, "error"); return null; });
          if (sel) say(`已选中 ${sel.selected ?? 0} 项` + (sel.failed ? `，${sel.failed} 项隐藏或锁定、选不中` : ""), "ok");
          await revealSelection(false);
        } }, "选中"))),
      h("div", { class: "small muted" }, "隐藏和锁定的对象在 Illustrator 里选不中：先「全部显示」「全部解锁」。"));
    void s;
  }

  /** 画板 → Photoshop: the resolution of the new document */
  function boardPpiRow(): HTMLElement {
    const sel = h("select", { class: "wl-board" }, ...[72, 150, 300].map(v => h("option", { value: String(v), selected: settings.boardPpi === v }, `${v} ppi`))) as HTMLSelectElement;
    sel.addEventListener("change", () => { settings.boardPpi = Number(sel.value) || 300; saveSettings(); });
    return h("div", { class: "param", title: "「画板」发送到 Photoshop 时新文档的分辨率（1 点 = 分辨率 / 72 像素）" }, h("span", { class: "small" }, "画板发送分辨率"), sel);
  }

  function openSettings() {
    type Flag = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
    const check = (label: string, key: Flag, tip: string) => {
      const box = h("input", { type: "checkbox", checked: settings[key] }) as HTMLInputElement;
      box.addEventListener("change", () => { settings[key] = box.checked; saveSettings(); render(); });
      return h("label", { class: "check-row", title: tip }, box, h("span", null, label));
    };
    sheet("WaveLayer 设置",
      check("跟随选择", "follow", "在 Illustrator 画布上选中对象时，自动展开到它所在的位置"),
      check("显示填色", "swatches", "路径行显示填充颜色的小方块（代替类型图标）"),
      check("紧凑行", "dense", "行高变小，一屏显示更多"),
      check("发送时保留在画板上的位置", "keepPlace", "发送到 Photoshop 的智能对象以整个画板为页面：Photoshop 文档和画板一样大时，放进去就在同样的位置（智能对象会包含画板的空白部分）"),
      boardPpiRow(),
      check("自动同步到 Photoshop", "autoSync", "发送过的对象（有 PS 标记）在 Illustrator 里改了以后，停手 2 秒就自动更新 Photoshop 里对应的智能对象"),
      h("button", { class: "btn", onClick: () => openCleanup() }, "整理文档…"),
      h("div", { class: "group-label" }, "快捷键（列表有焦点时）"),
      ...([["Delete", "删除"], ["F2 / 连点两下", "改名"], ["↑ ↓", "上一行 / 下一行"], ["← →", "折叠 / 展开"], ["Ctrl+G / Ctrl+Shift+G", "编组 / 取消编组"],
        ["Ctrl+Z / Ctrl+Shift+Z", "撤销 / 重做"], ["Ctrl+F", "搜索"], ["Alt+点眼睛 / 锁", "只显示 / 只解锁这一项"], ["Alt+拖动", "复制"], ["Alt+点三角", "展开里面所有层级"]] as const)
        .map(([k, v]) => h("div", { class: "wl-key" }, h("span", { class: "wl-key-k" }, k), h("span", { class: "small muted" }, v))),
      h("div", { class: "small muted" }, `WaveLayer for Illustrator ${deps.version}`));
  }

  // ── 牵手 Photoshop ──
  async function bridgeRun(run: () => Promise<void>) {
    psBusy = true;
    renderPs();
    try { await run(); }
    catch (e) { say((e as Error).message, "error"); }
    finally { psBusy = false; renderPs(); }
  }

  async function info(): Promise<PsInfo> {
    psInfo = await ps.request<PsInfo>({ kind: "info" }, 10_000);
    renderPs();
    return psInfo;
  }

  async function sendToPs(pixels: boolean) {
    const i = await info();
    if (!i.doc) say("Photoshop 没有打开的文档：会作为新文档打开");
    say("正在发送到 Photoshop…");
    const ex = await host.call<{ fileName: string; name: string; link: string; count: number }>("exportItems", { format: "ai", folder: i.inbox, pageArtboard: settings.keepPlace ? tree.doc?.artboard ?? 0 : undefined });
    await ps.request({ kind: "place", fileName: ex.fileName, name: ex.name, pixels, link: pixels ? undefined : ex.link }, 180_000);
    say(`已发送「${ex.name}」${ex.count > 1 ? `等 ${ex.count} 个对象` : ""}到 Photoshop${pixels ? "（像素图层）" : "，之后改了可以点「更新」"}`, "ok");
    await refresh(true);
  }

  /** 按图层分别发送: each layer's artwork as its own smart object, all on the artboard's page so
   *  they keep their places relative to each other */
  async function layersToPs(ns: AiNode[]) {
    const i = await info();
    const board = tree.doc?.artboard ?? 0;
    let done = 0;
    for (const n of ns) {
      say(`正在发送图层「${n.label}」（${done + 1}/${ns.length}）…`);
      await host.call("select", { targets: [expect(n)], art: true });
      let ex: { fileName: string; name: string; link: string };
      try { ex = await host.call("exportItems", { format: "ai", folder: i.inbox, pageArtboard: board, name: n.label }); }
      catch (e) { say(`图层「${n.label}」：${(e as Error).message}`, "error"); continue; }
      await ps.request({ kind: "place", fileName: ex.fileName, name: ex.name, pixels: false, link: ex.link }, 180_000);
      done++;
    }
    await host.call("menu", { cmd: "deselect" }).catch(() => undefined);
    say(`已把 ${done} 个图层分别发送到 Photoshop（按画板对齐）`, done ? "ok" : "error");
    await refresh(true);
  }

  /** 画板: every item on the artboard its own vector smart object in a new Photoshop document the
   *  artboard's size, in the same layers / groups, attributes kept (core/overlay/bridge.ts BoardNode) */
  async function artboardToPs() {
    const i = await info();
    type PlanNode = { name: string; hidden: boolean; opacity: number; blend: string; children?: PlanNode[]; key?: string; kind?: string; label?: string; left?: number; top?: number; width?: number; height?: number };
    const plan = await host.call<{ name: string; width: number; height: number; nodes: PlanNode[]; count: number; deep: boolean }>("boardPlan", { artboard: tree.doc?.artboard ?? 0, limit: BOARD_MAX_ITEMS });
    if (!plan.count) { say("这个画板上没有对象"); return; }
    if (plan.count > BOARD_MAX_ITEMS) { say(`画板上有 ${plan.count} 个对象，一次最多 ${BOARD_MAX_ITEMS} 个：先把它们编组`, "error"); return; }
    let done = 0;
    const failed: string[] = [];
    // each item into its own file, without its opacity / blend mode (the Photoshop layer gets them)
    const exportNode = async (n: PlanNode): Promise<BoardNode | null> => {
      const base = { name: n.name, hidden: n.hidden, opacity: n.opacity, blend: n.blend };
      if (n.children) {
        const children: BoardNode[] = [];
        for (const c of n.children) { const x = await exportNode(c); if (x) children.push(x); }
        return children.length ? { ...base, children } : null;
      }
      say(`正在导出「${n.name}」（${++done}/${plan.count}）…`);
      try {
        const ex = await host.call<{ fileName: string; link: string }>("exportItems", { format: "ai", folder: i.inbox, targets: [{ key: n.key, expect: { kind: n.kind, label: n.label } }], bare: true, name: n.name });
        return { ...base, fileName: ex.fileName, link: ex.link, left: n.left, top: n.top, width: n.width, height: n.height };
      } catch (e) { failed.push(`${n.name}：${(e as Error).message}`); return null; }
    };
    const nodes: BoardNode[] = [];
    for (const n of plan.nodes) { const x = await exportNode(n); if (x) nodes.push(x); }
    if (!nodes.length) { say("没有导出任何对象：" + failed.join("；"), "error"); return; }
    say(`Photoshop 正在置入 ${done - failed.length} 个智能对象…`);
    const r = await ps.request<{ docName: string; placed: number; failed: string[] }>({ kind: "board", name: plan.name, width: plan.width, height: plan.height, ppi: settings.boardPpi, nodes }, 60_000 + done * 5000);
    const lost = [...failed, ...r.failed];
    say(`画板「${plan.name}」已在 Photoshop 里打开：${r.placed} 个智能对象${plan.deep ? "" : "（对象太多，编组没有拆开）"}` + (lost.length ? `；${lost.length} 个没过去（${lost.slice(0, 3).join("；")}）` : ""), lost.length ? "error" : "ok");
    await refresh(true);
  }

  async function updateLink(link: string, name: string) {
    const i = await info();
    const ex = await host.call<{ fileName: string }>("exportItems", { format: "ai", folder: i.inbox, link });
    await ps.request({ kind: "update", link, fileName: ex.fileName }, 180_000);
    say(`已更新 Photoshop 里的「${name}」`, "ok");
  }

  async function updatePs() {
    const r = await host.call<{ links: string[]; count: number }>("linksInSelection");
    if (!r.links.length) {
      if (r.count) { say("选中的对象没有发送过：先点「发送」"); return; }
      // nothing selected: every link in the document
      const all = await host.call<{ links: { link: string; label: string }[] }>("allLinks");
      if (!all.links.length) { say("这个文档里没有发送到 Photoshop 的对象"); return; }
      let done = 0;
      const failed: string[] = [];
      for (const l of all.links) {
        try { await updateLink(l.link, l.label); done++; }
        catch (e) { failed.push(`${l.label}：${(e as Error).message}`); }
      }
      say(`已更新 ${done} 个关联` + (failed.length ? `；${failed.length} 个没更新（${failed.join("；")}）` : ""), failed.length ? "error" : "ok");
      return;
    }
    for (const l of r.links) await updateLink(l, l);
    if (r.links.length > 1) say(`已更新 Photoshop 里的 ${r.links.length} 个智能对象`, "ok");
  }

  function renderPs() {
    const ready = ps.ready;
    psDot.className = "wl-dot " + (ready ? "ok" : ps.helper ? "wait" : ps.outdated ? "bad" : "off");
    psText.classList.toggle("bad", !!ps.outdated);
    psText.textContent = ps.outdated ? `WavePlug 外置框架 ${ps.outdated} 太旧，不能同时连 Illustrator：在 Windows 运行 native\\overlay\\build.cmd 更新到 0.15.0，再点刷新`
      : !ps.helper ? "Photoshop 未连接（打开 Photoshop 和 WavePlug 插件后自动连上）"
      : !ready ? "等待 Photoshop 的 WavePlug 插件…"
      : psInfo?.doc ? `Photoshop · ${psInfo.doc.name} · ${psInfo.doc.ppi} ppi` : "Photoshop · 没有打开的文档";
    for (const b of psButtons) (b as any).disabled = !ready || psBusy;
    psBar.classList.toggle("busy", psBusy);
  }
  ps.onPush(push => {
    void (async () => {
      try {
        say(`正在放入 Photoshop 发来的 ${push.files.length} 个图层…`);
        const done = await host.call<{ placed: number; missing: number; artboard: string | null }>("placeFiles", { files: push.files, ppi: push.ppi, board: push.board, groups: push.groups,
          layerName: push.board ? `来自 Photoshop · ${push.board.name}` : `来自 Photoshop · ${push.docName}` });
        const where = done.artboard ? `新画板「${done.artboard}」` : "新图层";
        say(`Photoshop 发来 ${done.placed} 个图层，已放进${where}` + (done.missing ? `，${done.missing} 个文件找不到` : ""), done.missing ? "error" : "ok");
      } catch (e) { say("放入 Photoshop 发来的图层失败：" + (e as Error).message, "error"); }
      await refresh();
    })();
  });
  ps.onAsk((kind, link) => {
    if (kind === "update") void bridgeRun(() => updateLink(link, "关联对象"));
    else void (async () => {
      const r = await act("selectLink", { link }) as { selected: number } | null;
      if (r) { say(r.selected ? `Photoshop 请求：已选中 ${r.selected} 个关联对象` : "这个文档里没有找到 Photoshop 要的关联对象", r.selected ? "ok" : "error"); if (r.selected) await revealSelection(false); }
    })();
  });
  ps.onChange(() => { renderPs(); if (ps.ready) void info().catch(() => undefined); });
  setInterval(() => { if (ps.ready && !psBusy && !document.hidden) void info().catch(() => undefined); }, 5000);

  // 自动同步: linked items whose fingerprint changed, and then stayed the same for one more check
  // (the user stopped editing), are sent again
  let syncSeen: Record<string, string> | null = null, syncDoc = "", syncSig = "", syncTick = 0;
  const syncPending = new Map<string, string>();
  async function autoSync() {
    if (!settings.autoSync || !ps.ready || psBusy || host.busy || paint || drag?.active || renaming || !tree.doc) return;
    const doc = tree.doc.path || tree.doc.name;
    let now: Record<string, string>;
    // a full scan for linked items when the document changed shape, else every 10th check
    const rescan = lastSig !== syncSig || ++syncTick % 10 === 0;
    syncSig = lastSig;
    try { now = (await host.call<{ sigs: Record<string, string> }>("linkSignatures", { rescan })).sigs; } catch { return; }
    if (!syncSeen || doc !== syncDoc) { syncSeen = now; syncDoc = doc; syncPending.clear(); return; }
    const due: string[] = [];
    for (const [link, sig] of Object.entries(now)) {
      if (syncSeen[link] === undefined || syncSeen[link] === sig) { if (syncPending.get(link) === sig) due.push(link); continue; }
      syncPending.set(link, sig);
    }
    syncSeen = now;
    if (!due.length) return;
    for (const link of due) syncPending.delete(link);
    await bridgeRun(async () => {
      for (const link of due) await updateLink(link, "关联对象");
      say(`已自动同步 ${due.length} 个关联到 Photoshop`, "ok");
    });
  }
  setInterval(() => { void autoSync(); }, 2000);

  void refresh(true);
  renderPs();
  if (ps.ready) void info().catch(() => undefined);
  return { refresh, get state() { return { tree, picked, open: [...open.keys()], results, searchText }; } };
}
