// WavePlug Studio panel. Layout follows V1.4: versions on top → workflow row → prompt →
// references → "参考当前画面" + selection → generate → collapsed advanced → status line.

import { type Comfy, ComfyError } from "../core/comfy/client.ts";
import type { Rect } from "../core/image/region.ts";
import { asApiGraph } from "../core/workflow/api.ts";
import { MAX_SEED, randomSeed } from "../core/workflow/inject.ts";
import { type Binding, type Profile, type TaskType, ROLE_LABEL, carryOver, inpaintLike, newProfile, validateProfile } from "../core/workflow/profile.ts";
import { isBlendGraph, recognize } from "../core/workflow/recognize.ts";
import { uiToApi } from "../core/workflow/uiToApi.ts";
import { findLocalMaskLinks } from "../core/workflow/localMask.ts";
import { MAX_REFERENCES, findReferenceSlots } from "../core/workflow/references.ts";
import { MAX_UPSCALE_EDGE, type RefSource, StashedResult, runInpaint } from "../app/generate.ts";
import { type ProfileState, type Services, type Settings, store } from "../app/services.ts";
import type { DocInfo, FillGroup, Pads, Variation } from "../ps/host.ts";
import { log, withTimeout } from "../app/log.ts";
import { openCalibration } from "./calibrate.ts";
import { h, icon, replace } from "./dom.ts";
import { encodePng } from "../core/image/png.ts";
import { onWhite } from "../core/image/compose.ts";
import { BLEND_PREFIX, EXPAND_PREFIX, EXTRACT_PREFIX, FILL_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX } from "../ps/host.ts";
import { RATIOS, createExpandEditor } from "./expandEditor.ts";
import { createToolsView } from "./tools.ts";

type Conn = { state: "checking" | "ok" | "down"; text: string };

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Prompt optimisers (an LLM rewriting the prompt) are slow and off unless the user turns them on. */
const OPTIMIZER = /提示词优化|prompt\s*optimi[sz]/i;
function defaultParam(b: Binding, base: unknown): number | boolean {
  return typeof base === "boolean" && OPTIMIZER.test(b.label ?? b.title ?? "") ? false : (base as number | boolean);
}
function effectiveParams(p: Profile, ps: ProfileState): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const b of p.bindings.filter(x => x.role === "param")) {
    const k = b.nodeId + "." + b.input;
    const d = defaultParam(b, p.api[b.nodeId]?.inputs[b.input]);
    if (d !== p.api[b.nodeId]?.inputs[b.input]) out[k] = d;
  }
  return { ...out, ...ps.params };
}

const OLD_HINTS = ["描述要画进选区的内容；留空 = 移除选区内的内容", "描述要画进选区的内容"];
/** Strips hint text that older versions' placeholder may have merged into the prompt. */
export function cleanPrompt(s: string): string {
  for (const h of OLD_HINTS) s = s.split(h).join("");
  return s.trim();
}

/** Accepts "127.0.0.1", "127.0.0.1:8188", "http://host:port/" … and returns "http://host:port". */
export function normalizeUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return "http://127.0.0.1:8188";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/^https?:\/\/[^/]+:\d+/i.test(s) && /^http:/i.test(s)) s = s.replace(/^(http:\/\/[^/]+)/i, "$1:8188");
  return s;
}
type RefSlot = RefSource & { thumb?: string };

export function mountApp(root: HTMLElement, svc: Services) {
  let settings: Settings = store.settings();
  let profiles: Profile[] = store.profiles();
  // Each mode (局部重绘 / 融图 / 扩图 / 文生图 / 放大) has its own current workflow.
  const modeOf = (p: Profile): TaskType => p.taskType ?? "inpaint";
  // 融图 workflows imported under 局部重绘 before the 融图 mode existed move over
  if (profiles.some(p => modeOf(p) === "inpaint" && isBlendGraph(p.api))) {
    for (const p of profiles) if (modeOf(p) === "inpaint" && isBlendGraph(p.api)) { p.taskType = "blend"; p.options.allowEmptyPrompt = true; }
    store.saveProfiles(profiles);
  }
  const pickFor = (m: TaskType) => {
    const id = settings.activeByMode?.[m] ?? (m === "inpaint" ? settings.activeProfile : null);
    return profiles.find(p => p.id === id && modeOf(p) === m) ?? profiles.find(p => modeOf(p) === m) ?? null;
  };
  let mode: TaskType = settings.mode ?? "inpaint";
  let profile: Profile | null = pickFor(mode);
  let pstate: ProfileState | null = profile ? store.state(profile.id) : null;
  let comfy: Comfy = svc.comfy(settings.comfyUrl);
  let conn: Conn = { state: "checking", text: "连接中…" };
  let doc: DocInfo | null = null, sel: Rect | null = null, group: FillGroup | null = null;
  // The panel's current fill stays put while other layers are selected; it only changes when an AI
  // fill group (or a layer in it) is selected, another fill is picked in the panel, or a new fill is made.
  const pinned = new Map<number, number>();
  let fills: { layerId: number; name: string }[] = [];
  let lastActive = "", lastGroupKey = "";
  // explicit choice of the context chip for the current selection (add to the fill / make a new one)
  let choice: { sel: string; add: boolean } | null = null;
  const selKey = (r: Rect | null) => r ? `${r.left},${r.top},${r.right},${r.bottom}` : "";
  const near = (a: Rect, b: Rect) => Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 && Math.abs(a.right - b.right) <= 2 && Math.abs(a.bottom - b.bottom) <= 2;
  /** true: the next 生成 adds variations to the current fill; false: it creates a new fill */
  const willAdd = () => {
    if (!group || group.kind !== mode || mode === "upscale") return false;
    // 扩图: with no extension set, 生成 adds variations to the current expansion
    if (mode === "outpaint") return !padTotal();
    if (choice && choice.sel === selKey(sel)) return choice.add;
    if (!sel) return true;
    if (mode === "txt2img") {
      // a generated image is fitted inside its selection: same area = inside it, spanning its width or height
      const r = group.rect, d = 2;
      const inside = r.left >= sel.left - d && r.top >= sel.top - d && r.right <= sel.right + d && r.bottom <= sel.bottom + d;
      return inside && (Math.abs((r.right - r.left) - (sel.right - sel.left)) <= d || Math.abs((r.bottom - r.top) - (sel.bottom - sel.top)) <= d);
    }
    return near(sel, group.rect);
  };
  let variations: Variation[] = [];
  // thumbnails keyed "docId:layerId" — rebuilt from Photoshop when missing
  const thumbs = new Map<string, string>();
  const refs: Record<number, RefSlot | undefined> = {};
  let run: null | { stage: string; progress: number | null; detail: string; promptId?: string; signal: { aborted: boolean } } = null;
  let status: { text: string; kind: "info" | "ok" | "error" } = { text: "就绪", kind: "info" };
  let stash: Uint8Array | null = null;
  let pads: Pads = { left: 0, right: 0, top: 0, bottom: 0 };
  const padTotal = () => pads.left + pads.right + pads.top + pads.bottom;

  // ── skeleton ──
  const connEl = h("button", { class: "conn", title: "ComfyUI 连接设置", onClick: () => openSettings() });
  const targetEl = h("span", { class: "target" });
  targetEl.addEventListener("click", () => {
    // inpaint: only with a selection (without one there is nothing new to fill); 文生图: always
    if (!group || group.kind !== mode || mode === "outpaint" || mode === "upscale" || (inpaintLike(mode) && !sel)) return;
    choice = { sel: selKey(sel), add: !willAdd() };
    renderHistory(); renderSelection(); renderAction();
  });
  const historyEl = h("div", { class: "history vars" });
  const varPromptEl = h("div", { class: "var-prompt" });
  const varCountEl = h("span", { class: "hint" });
  const fillSel = h("select", { class: "field fill-sel", title: "当前填充（切换其他图层不会改变它）" }) as HTMLSelectElement;
  fillSel.addEventListener("change", () => { if (doc) { pinned.set(doc.id, Number(fillSel.value)); choice = null; void refresh(); } });
  const regenBtn = h("button", { class: "regen", onClick: () => void regenerate() }, icon("refresh", 12), h("span", null, "再生成"));
  const flowName = h("span", { class: "flow-name" });
  const flowBtn = h("button", { class: "flow-btn", title: "切换、导入或校准工作流", onClick: () => openWorkflows() }, icon("flow", 14), flowName, icon("chevron", 12));
  const countSel = h("select", { class: "field count-sel", title: "这次生成几个变体" }, ...[1, 2, 3, 4].map(n => h("option", { value: String(n) }, `× ${n}`))) as HTMLSelectElement;
  countSel.addEventListener("change", () => { if (pstate && profile) { pstate.count = Number(countSel.value); store.saveState(profile.id, pstate); } });
  const compareBtn = h("button", { class: "icon-btn sm compare", title: "按住查看原图（隐藏当前填充）" }, icon("eye", 14));
  const prompt = h("textarea", { class: "prompt", rows: 4 }) as HTMLTextAreaElement;
  const refsEl = h("div", { class: "refs" });
  const promptHint = h("div", { class: "prompt-hint" });
  const selEl = h("span", { class: "sel-state" });
  const genBtn = h("button", { class: "generate" });
  const progEl = h("div", { class: "progress" });
  const advHead = h("button", { class: "adv-head" });
  const advBody = h("div", { class: "adv-body" });
  const statusEl = h("div", { class: "status" });
  const sheetHost = h("div", { class: "sheet-host" });

  const MODES = [["inpaint", "局部重绘"], ["blend", "融图"], ["extract", "抠图"], ["outpaint", "扩图"], ["txt2img", "文生图"], ["upscale", "放大"]] as const;
  const modeBtns = MODES.map(([m, label]) => h("button", { class: "seg-btn", onClick: () => setMode(m) }, label));
  const modeEl = h("div", { class: "seg" }, ...modeBtns);
  // 生成 (the AI modes above) | 工具 (Photoshop layer tools, no ComfyUI)
  const toolsView = createToolsView(svc.tools, (text, kind) => setStatus(text, kind));
  const viewBtns = ([["generate", "生成"], ["tools", "工具"]] as const).map(([v, label]) =>
    h("button", { class: "seg-btn", onClick: () => setView(v) }, label));
  const viewEl = h("div", { class: "seg view-seg" }, ...viewBtns);
  const genView = h("div");
  const toolsMode = () => settings.view === "tools";
  const expander = createExpandEditor({ maxPad: 3000, onChange: p => { pads = p; renderHistory(); renderSelection(); renderAction(); } });
  const expandCard = h("section", { class: "card xp-card" }, expander.el);
  let thumbKey = "";
  // 文生图: aspect (follow the selection / canvas, or a preset) and long side
  const T2I_FOLLOW = "跟随选区/画布";
  const t2iRatio = h("select", { class: "field t2i-ratio", title: "生成图片的比例" },
    ...[T2I_FOLLOW, ...RATIOS.slice(1)].map(r => h("option", { value: r }, r))) as HTMLSelectElement;
  const t2iLong = h("input", { class: "num t2i-long", type: "number", min: "256", max: "4096", step: "64", title: "生成图片的长边（像素）" }) as HTMLInputElement;
  const t2iInfo = h("div", { class: "t2i-info" });
  t2iRatio.addEventListener("change", () => { settings.t2iRatio = t2iRatio.value; store.saveSettings(settings); renderSelection(); });
  t2iLong.addEventListener("change", () => {
    const v = Math.max(256, Math.min(4096, Math.round(Number(t2iLong.value) || 1536)));
    t2iLong.value = String(v); settings.t2iLong = v; store.saveSettings(settings); renderSelection();
  });
  const t2iCard = h("section", { class: "card t2i-card" },
    h("div", { class: "t2i-row" }, h("span", { class: "t2i-k" }, "比例"), t2iRatio, h("span", { class: "t2i-k" }, "长边"), t2iLong),
    t2iInfo);

  // 放大: factor buttons and what will be sent
  const upBtns = h("div", { class: "seg up-seg" });
  const upScope = h("div", { class: "seg up-seg" });
  const upInfo = h("div", { class: "t2i-info" });
  const upCard = h("section", { class: "card up-card" },
    h("div", { class: "t2i-row" }, h("span", { class: "t2i-k" }, "范围"), upScope),
    h("div", { class: "t2i-row up-row" }, h("span", { class: "t2i-k" }, "倍数"), upBtns), upInfo);
  const upFactors = () => profile?.options.upscale?.factors ?? [1, 2, 3, 4];
  const upScale = () => { const f = upFactors(); return f.includes(settings.upScale ?? 2) ? settings.upScale ?? 2 : f[Math.min(1, f.length - 1)]; };
  const upLayerMode = () => settings.upTarget === "layer";
  /** 放大 · 当前图层: the selected layers that have pixels of their own (not groups / adjustment layers) */
  const upLayers = () => (doc ? svc.host.activeLayers(doc.id) : []).filter(l => /^(pixel|smartObject|text|solidColor|gradientFill|pattern)$/i.test(l.kind));
  /** 放大 · 当前图层: the selected layer whose upscale would be largest */
  const upLargest = () => upLayers().reduce<ReturnType<typeof upLayers>[number] | null>((m, l) =>
    !m || Math.max(l.rect.right - l.rect.left, l.rect.bottom - l.rect.top) > Math.max(m.rect.right - m.rect.left, m.rect.bottom - m.rect.top) ? l : m, null);
  /** 放大: the (largest) selected layer, or the selection's bounds, else the whole canvas */
  const upSource = () => !doc ? null : upLayerMode() ? upLargest()?.rect ?? null : sel ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };

  // prompt favorites, one list per place a prompt is typed (重绘 / 扩图 / 文生图)
  const MAX_FAVORITES = 40;
  let favorites = store.favorites();
  let favOpen = false;
  const favKey = () => mode;
  const favStar = h("button", { class: "fav-star" });
  const favToggle = h("button", { class: "fav-toggle", title: "收藏的提示词" });
  const favList = h("div", { class: "fav-list" });
  const favEl = h("div", { class: "fav" }, h("div", { class: "fav-bar" }, favStar, favToggle), favList);
  favStar.addEventListener("click", () => {
    const text = prompt.value.trim(), list = favorites[favKey()] ?? [];
    if (!text) return;
    favorites[favKey()] = list.includes(text) ? list.filter(x => x !== text) : [text, ...list].slice(0, MAX_FAVORITES);
    store.saveFavorites(favorites); renderFav();
  });
  favToggle.addEventListener("click", () => { favOpen = !favOpen; renderFav(); });
  /** Puts `text` into the prompt box as if typed (saved with the workflow's state). */
  const setPromptText = (text: string) => { prompt.value = text; prompt.dispatchEvent(new Event("input")); };

  // 抠图 → 拆图: remove the cut-out object from the original afterwards (局部重绘's removal)
  const exRemoveBox = h("input", { type: "checkbox", onChange: (e: Event) => { settings.extractRemove = (e.target as HTMLInputElement).checked; store.saveSettings(settings); } }) as HTMLInputElement;
  const exRemoveRow = h("label", { class: "param check-row ex-remove", title: "抠出来之后，用「局部重绘」模式里的移除工作流（提示词留空 = 移除）把原图里的这个物件去掉，结果放在抠图下面一层，相当于把它拆成单独的一层" },
    exRemoveBox, h("span", null, "抠完后从原图移除（拆图）"));

  const mainEl = h("main", { class: "scroll" });
  const footEl = h("footer", { class: "foot" });
  // UXP draws native text fields above everything regardless of z-index, so while a sheet is open
  // the work area is taken out of the DOM (not hidden — a visibility toggle coincided with a host
  // crash in 0.1.4) and put back when the last sheet closes. Element state (prompt text) is kept.
  const syncSheets = () => {
    const open = !!sheetHost.querySelector(".sheet");
    if (open && mainEl.parentNode) mainEl.remove();
    else if (!open && !mainEl.parentNode) root.insertBefore(mainEl, footEl);
  };
  const appendToHost = sheetHost.append.bind(sheetHost);
  sheetHost.append = (...nodes: (Node | string)[]) => {
    for (const n of nodes) if (n instanceof HTMLElement && n.classList.contains("sheet")) {
      const detach = n.remove.bind(n);
      n.remove = () => { detach(); syncSheets(); };
    }
    appendToHost(...nodes);
    syncSheets();
  };

  root.append(
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("span", { class: "mark" }, "W"), h("span", { class: "brand-name" }, "WavePlug"),
        svc.devReload ? h("button", { class: "icon-btn dev-reload", title: "重新加载开发版代码（F:\\waveplug\\studio\\dist\\plugin）", onClick: () => svc.devReload!() }, icon("refresh", 13)) : null),
      h("div", { class: "top-right" }, flowBtn, connEl)),
    (mainEl.append(viewEl, (genView.append(
      modeEl,
      expandCard,
      t2iCard,
      upCard,
      h("section", { class: "card" },
        prompt, promptHint, favEl, exRemoveRow, refsEl,
        h("div", { class: "ctx-row" }, targetEl, selEl),
        h("div", { class: "gen-row" }, countSel, genBtn),
        progEl),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("span", { class: "label" }, "变体"), varCountEl, h("span", { class: "grow" }), compareBtn, regenBtn),
        fillSel,
        historyEl, varPromptEl),
      h("section", { class: "card adv" }, advHead, advBody)), genView), toolsView.el), mainEl),
    (footEl.append(statusEl, h("span", { class: "ver" }, svc.version)), footEl),
    sheetHost);

  // re-check the 生成 button as the user types (a required prompt enables it)
  prompt.addEventListener("input", () => { promptHint.hidden = !!prompt.value; renderFav(); if (!run) renderAction(); });
  prompt.addEventListener("input", () => { if (pstate && profile) { pstate.prompt = prompt.value; store.saveState(profile.id, pstate); } });
  // compare: hold to see the original (the fill group hidden), release to restore
  const showOriginal = (hide: boolean) => { if (group && !run) void svc.host.setFillVisible(group, !hide).catch(e => log("warn", "compare", e)); compareBtn.classList.toggle("on", hide); };
  compareBtn.addEventListener("mousedown", () => showOriginal(true));
  compareBtn.addEventListener("mouseup", () => showOriginal(false));
  compareBtn.addEventListener("mouseleave", () => { if (compareBtn.classList.contains("on")) showOriginal(false); });
  genBtn.addEventListener("click", () => (run ? cancel() : generate()));
  advHead.addEventListener("click", () => { settings.advancedOpen = !settings.advancedOpen; store.saveSettings(settings); renderAdvanced(); });

  // ── rendering ──
  function setStatus(text: string, kind: "info" | "ok" | "error" = "info") { status = { text, kind }; renderStatus(); }

  function renderFav() {
    favEl.hidden = mode === "upscale";
    const list = favorites[favKey()] ?? [], text = prompt.value.trim(), saved = !!text && list.includes(text);
    favStar.className = "ub fav-star" + (saved ? " on" : "") + (text ? "" : " is-disabled");
    favStar.title = !text ? "先输入提示词再收藏" : saved ? "取消收藏这条提示词" : "收藏这条提示词";
    replace(favStar, h("span", { class: "fav-icon" }, saved ? "★" : "☆"), h("span", null, saved ? "已收藏" : "收藏"));
    replace(favToggle, h("span", null, `收藏夹 ${list.length}`), h("span", { class: "chev" + (favOpen ? " open" : "") }, icon("chevron", 12)));
    favList.hidden = !favOpen;
    if (!favOpen) return;
    replace(favList, ...(list.length ? list.map(t => h("div", { class: "fav-item" + (t === text ? " on" : "") },
      h("button", { class: "fav-text", title: t, onClick: () => setPromptText(t) }, t),
      h("button", { class: "fav-del", title: "从收藏夹删除", onClick: () => { favorites[favKey()] = (favorites[favKey()] ?? []).filter(x => x !== t); store.saveFavorites(favorites); renderFav(); } }, icon("close", 10))))
      : [h("div", { class: "fav-empty" }, "还没有收藏。输入提示词后点「☆ 收藏」")]));
  }

  function renderStatus() {
    replace(statusEl, h("span", { class: "dot " + status.kind }), h("span", { class: "status-text", title: status.text }, status.text),
      stash ? h("button", { class: "link", onClick: saveStash }, "保存未写入的结果") : null);
  }

  function renderConn() {
    connEl.className = "conn " + conn.state;
    connEl.title = conn.text + " · " + settings.comfyUrl + "（点击设置）";
    replace(connEl, h("span", { class: "dot" }), h("span", null, conn.state === "ok" ? "已连接" : conn.state === "checking" ? conn.text : "未连接"));
  }

  function renderHistory() {
    const add = willAdd();
    targetEl.textContent = add ? `添加到「${group!.name}」` : mode === "outpaint" ? "新建扩图" : mode === "txt2img" ? "新建生成" : mode === "upscale" ? (upLayerMode() ? "智能对象" : "新文档") : mode === "blend" ? "新建融图" : mode === "extract" ? "新建抠图" : "新建填充";
    targetEl.title = mode === "upscale" ? (upLayerMode() ? "结果放在原图层上方，是同样大小的智能对象（里面是放大后的图片），原图层隐藏" : "放大结果放进一个新文档，原文档不改动")
      : mode === "txt2img"
      ? (add ? `新变体加入「${group!.name}」，放在它原来的位置。点击改为新建` : group?.kind === "txt2img" ? `新建一组生成结果。点击改为添加到「${group.name}」` : "生成结果放进选区；没有选区时铺满画布；没有打开文档时新建文档")
      : mode === "outpaint"
      ? (add ? `新变体加入「${group!.name}」，使用它原来的扩展尺寸。拖动上面的画布边缘可改为新建扩图` : "按上面设定的尺寸扩展画布，并生成扩展部分")
      : !group ? "用当前选区新建一个 AI 填充"
      : add ? `新变体加入「${group.name}」，使用它原来的遮罩${sel ? "。点击改为用当前选区新建填充" : ""}`
      : `当前选区和「${group.name}」不同，将新建填充。点击改为添加到「${group.name}」`;
    targetEl.className = "target " + (add ? "cont" : "new") + (group && group.kind === mode && (mode === "txt2img" || (sel && inpaintLike(mode))) ? " switchable" : "");
    replace(fillSel, ...fills.map(f => h("option", { value: String(f.layerId) }, f.name)));
    fillSel.hidden = fills.length < 1;
    fillSel.value = group ? String(group.layerId) : "";
    const ratio = group ? (group.rect.bottom - group.rect.top) / Math.max(1, group.rect.right - group.rect.left) : 1;
    const h0 = Math.round(Math.max(56, Math.min(132, 96 * ratio)));
    const tiles: HTMLElement[] = variations.map(v => {
      const thumb = thumbs.get(`${group!.docId}:${v.layerId}`);
      return h("div", { class: "var" + (v.visible ? " on" : ""), title: v.prompt || "（无提示词）" },
        h("button", { class: "var-img", style: `height:${h0}px`, onClick: () => showVariation(v) },
          thumb ? h("img", { src: thumb }) : h("span", { class: "tile-ph" }, icon("image", 16))),
        h("span", { class: "var-badge" }, String(v.number)),
        h("button", { class: "var-del", title: "删除这个变体", onClick: () => deleteVariation(v) }, icon("close", 10)));
    });
    if (run) tiles.push(h("div", { class: "var pending" },
      h("div", { class: "var-img", style: `height:${h0}px` },
        h("span", { class: "var-fill", style: `width:${Math.round((run.progress ?? 0) * 100)}%` }),
        h("span", { class: "var-wait" }, `${Math.round((run.progress ?? 0) * 100)}%`))));
    if (!tiles.length) tiles.push(h("div", { class: "history-empty" }, group ? "这个填充还没有变体" : "生成的结果会以变体出现在这里，点击即可切换"));
    varCountEl.textContent = variations.length ? `${variations.length} 个` : "";
    const shown = variations.find(x => x.visible) ?? variations[variations.length - 1];
    regenBtn.hidden = !group || !shown || group.kind === "upscale";
    regenBtn.disabled = !!run;
    regenBtn.title = !shown ? "" : group?.kind === "outpaint"
      ? `用变体 ${shown.number} 的提示词和原来的扩展尺寸，再生成新的变体`
      : `用变体 ${shown.number} 的提示词「${shown.prompt || "移除"}」和原来的遮罩，再生成新的变体（不读取当前选区和输入框）`;
    replace(historyEl, ...tiles);
    const active = variations.find(v => v.visible);
    replace(varPromptEl, active ? h("span", null, h("span", { class: "muted" }, `变体 ${active.number}：`), active.prompt || "（无提示词）") : null);
    void loadThumbs();
  }

  let loadingThumbs = false;
  async function loadThumbs() {
    if (!group || loadingThumbs) return;
    loadingThumbs = true;
    try {
      for (const v of variations) {
        const key = `${group.docId}:${v.layerId}`;
        if (thumbs.has(key)) continue;
        try { thumbs.set(key, await svc.host.thumbnail(group, v.layerId, 128)); } catch (e) { log("warn", "thumbnail", e); thumbs.set(key, ""); }
        renderHistory();
      }
    } finally { loadingThumbs = false; }
  }

  function renderFlows() {
    modeBtns.forEach((b, i) => b.classList.toggle("on", MODES[i][0] === mode));
    expandCard.hidden = mode !== "outpaint";
    t2iCard.hidden = mode !== "txt2img";
    upCard.hidden = mode !== "upscale";
    const factor = upScale();
    replace(upBtns, ...upFactors().map(f => h("button", { class: "seg-btn" + (f === factor ? " on" : ""), title: f === 1 ? "原尺寸修复（不放大）" : `放大 ${f} 倍`,
      onClick: () => { settings.upScale = f; store.saveSettings(settings); renderFlows(); renderSelection(); renderAction(); } }, f === 1 ? "修复" : `${f}×`)));
    const scope = upLayerMode() ? "layer" : "canvas";
    replace(upScope, ...([["canvas", "整个画面", "选区或整个画面（所有可见图层）放大到新文档"], ["layer", "当前图层", "放大选中的图层（可多选，依次处理），结果是同样大小的智能对象，里面是放大后的图片"]] as const).map(([k, label, tip]) =>
      h("button", { class: "seg-btn" + (k === scope ? " on" : ""), title: tip, onClick: () => { settings.upTarget = k; store.saveSettings(settings); renderFlows(); renderHistory(); renderSelection(); renderAction(); } }, label)));
    // the upscale workflow has no prompt; one layer gives one result
    prompt.hidden = mode === "upscale";
    exRemoveRow.hidden = mode !== "extract";
    exRemoveBox.checked = settings.extractRemove !== false;
    countSel.hidden = mode === "upscale" && upLayerMode();
    t2iRatio.value = settings.t2iRatio ?? T2I_FOLLOW;
    t2iLong.value = String(settings.t2iLong ?? 1536);
    flowName.textContent = profile ? profile.name : mode === "outpaint" ? "导入扩图工作流" : mode === "txt2img" ? "导入文生图工作流" : mode === "upscale" ? "导入放大工作流" : mode === "blend" ? "导入融图工作流" : mode === "extract" ? "导入抠图工作流" : "导入工作流";
    flowBtn.title = profile ? `工作流：${profile.name}（点击切换、导入或校准）` : "导入 ComfyUI 工作流";
    flowBtn.classList.toggle("warn", !!profile && validateProfile(profile).length > 0);
    countSel.value = String(pstate?.count ?? 1);
    const allowEmpty = profile?.options.allowEmptyPrompt;
    // UXP's native textarea can merge its placeholder into the typed text, so the hint lives outside it
    promptHint.textContent = mode === "txt2img" ? "描述想要生成的画面"
      : mode === "outpaint" ? "描述扩展出来的内容（可留空，自动延续画面）"
      : mode === "extract" ? "可选：要抠的东西，例如 护肤品、红色价格牌；留空 = 抠选区里的主体"
      : mode === "blend" ? `可选：补充光影要求，例如 夕阳暖光、木桌上的倒影；留空 = ${(profile && emptyMeaning(profile)) || "默认融图提示词"}`
      : allowEmpty ? `描述要画进选区的内容；留空 = ${(profile && emptyMeaning(profile)) || "移除选区内的内容"}` : "描述要画进选区的内容";
    prompt.title = promptHint.textContent;
    prompt.value = pstate?.prompt ?? "";
    promptHint.hidden = !!prompt.value || mode === "upscale";
    renderFav();
  }

  /** Reference slots: the workflow's own reference loaders, or free encoder inputs (auto-wired). */
  function refSlotNumbers(): number[] {
    const bound = profile?.bindings.filter(b => b.role === "reference").map(b => b.slot!) ?? [];
    if (bound.length) return bound;
    if (!profile?.options.refSlots) return [];
    const max = Math.min(MAX_REFERENCES, ...profile.options.refSlots.nodes.map(n => n.inputs.length));
    const used = Array.from({ length: max }, (_, i) => i + 1).filter(s => refs[s]);
    // filled slots plus one empty "add" slot
    return Array.from({ length: Math.min(max, used.length + 1) }, (_, i) => i + 1);
  }

  function renderRefs() {
    const slots = refSlotNumbers();
    const auto = !!profile && !profile.bindings.some(b => b.role === "reference");
    refsEl.hidden = !slots.length;
    replace(refsEl, ...slots.map(slot => {
      const r = refs[slot];
      // with auto-wired references the canvas is 图1, so reference n is 图(n+1)
      const tag = auto ? `图${slot + 1}` : `参考 ${slot}`;
      return h("button", { class: "ref" + (r ? " set" : " add"), title: r ? `${tag}：${r.name}（点击更换或移除）` : `添加参考图（${tag}）：PS 图层、图片文件或剪贴板（Ctrl+V）`, onClick: (e: Event) => refMenu(slot, e.currentTarget as HTMLElement) },
        r?.thumb ? h("img", { src: r.thumb, onError: (e: Event) => { const el = e.currentTarget as HTMLElement; el.replaceWith(h("span", { class: "ref-ext" }, (/\.(\w+)$/.exec(r.name)?.[1] ?? "图片").toUpperCase())); } })
          : r ? icon("image", 16) : icon("plus", 14),
        h("span", { class: "ref-num" }, r ? tag : "参考图"));
    }), refs[1] && auto ? h("div", { class: "ref-hint" }, "提示词里用「图2」指代参考图，例如：把选区里的杯子换成图2中的饮料")
      : mode === "txt2img" && slots.length && !refs[1] ? h("div", { class: "ref-hint" }, "可选：放一张参考图，工作流会按它来生成") : null);
  }

  /** 文生图: where the result goes and the aspect it should have. */
  function t2iTarget(): { aspect: number; where: string; fixed: boolean } {
    const r = (x: Rect) => (x.right - x.left) / Math.max(1, x.bottom - x.top);
    const dim = (x: Rect) => `${x.right - x.left} × ${x.bottom - x.top}`;
    if (group && willAdd()) return { aspect: r(group.rect), where: `「${group.name}」原来的位置 ${dim(group.rect)}`, fixed: true };
    if (doc && sel) return { aspect: r(sel), where: `选区 ${dim(sel)}`, fixed: false };
    if (doc) return { aspect: doc.width / Math.max(1, doc.height), where: `整个画布 ${doc.width} × ${doc.height}`, fixed: false };
    return { aspect: 1, where: "新文档（未打开文档）", fixed: false };
  }

  /** 文生图 output size: the chosen aspect at the chosen long side, on the workflow's grid. */
  function t2iSize(): { width: number; height: number } {
    const t = t2iTarget();
    const m = /^(\d+):(\d+)$/.exec(settings.t2iRatio ?? "");
    // adding to an existing result keeps its shape, whatever preset is chosen
    const aspect = !t.fixed && m ? Number(m[1]) / Number(m[2]) : t.aspect;
    const long = settings.t2iLong ?? 1536;
    const grid = profile?.options.txt2img?.multiple ?? 16;
    const snap = (v: number) => Math.max(grid, Math.round(v / grid) * grid);
    return aspect >= 1 ? { width: snap(long), height: snap(long / aspect) } : { width: snap(long * aspect), height: snap(long) };
  }

  function renderSelection() {
    if (mode === "txt2img") {
      const t = t2iTarget(), s = t2iSize();
      selEl.textContent = `输出 ${s.width} × ${s.height}`;
      selEl.className = "sel-state";
      replace(t2iInfo, h("span", { class: "muted" }, "放入："), t.where);
      return;
    }
    if (!doc) { selEl.textContent = "未打开文档"; if (mode === "upscale") replace(upInfo); return; }
    if (mode === "upscale" && upLayerMode()) {
      const ls = upLayers(), l = upLargest(), f = upScale();
      if (!l) { selEl.textContent = "未选中图层"; selEl.className = "sel-state warn"; replace(upInfo, h("span", { class: "muted" }, "在图层面板选中要放大的图层（可多选）")); return; }
      const w = l.rect.right - l.rect.left, hh = l.rect.bottom - l.rect.top;
      selEl.textContent = ls.length > 1 ? `${ls.length} 个图层` : `内容 ${w * f} × ${hh * f}`;
      selEl.className = "sel-state" + (Math.max(w, hh) * f > MAX_UPSCALE_EDGE ? " warn" : "");
      replace(upInfo, h("span", { class: "muted" }, "放大："), ls.length > 1 ? `${ls.length} 个图层，依次放大` : `图层「${l.name}」 ${w} × ${hh}`, h("span", { class: "muted" }, "（放大后变成智能对象，原图层隐藏）"));
      return;
    }
    if (mode === "upscale") {
      const r = upSource()!, w = r.right - r.left, hh = r.bottom - r.top, f = upScale();
      selEl.textContent = `输出 ${w * f} × ${hh * f}`;
      selEl.className = "sel-state" + (Math.max(w, hh) * f > MAX_UPSCALE_EDGE ? " warn" : "");
      replace(upInfo, h("span", { class: "muted" }, "放大："), sel ? `选区 ${w} × ${hh}` : `整个画面 ${w} × ${hh}`, h("span", { class: "muted" }, "（所有可见图层）"));
      return;
    }
    if (mode === "outpaint") {
      selEl.textContent = willAdd() && group?.pads ? `扩展 ${group.pads.left + group.pads.right} × ${group.pads.top + group.pads.bottom}`
        : `画布 ${doc.width} × ${doc.height}` + (padTotal() ? ` → ${doc.width + pads.left + pads.right} × ${doc.height + pads.top + pads.bottom}` : "");
      selEl.className = "sel-state" + (!padTotal() && !willAdd() ? " warn" : "");
      return;
    }
    if (sel) selEl.textContent = `选区 ${sel.right - sel.left} × ${sel.bottom - sel.top}`;
    else selEl.textContent = group ? "无选区 · 用原来的遮罩" : "无选区";
    selEl.className = "sel-state" + (!sel && !group ? " warn" : "");
  }

  function blockedReason(text = prompt.value, regenerating = false): string | null {
    if (!profile) return mode === "outpaint" ? "请先导入扩图工作流（含「外补画板」节点）" : mode === "txt2img" ? "请先导入文生图工作流" : mode === "upscale" ? "请先导入放大工作流" : mode === "blend" ? "请先导入融图工作流（含融图 LoRA）" : mode === "extract" ? "请先导入抠图工作流（如心宝强化抠图）" : "请先导入工作流";
    const problems = validateProfile(profile);
    if (problems.length) return "工作流需要校准：" + problems[0];
    if (conn.state !== "ok") return "未连接 ComfyUI";
    if (mode === "txt2img") {
      if (!profile.options.allowEmptyPrompt && profile.bindings.some(b => b.role === "prompt") && !text.trim()) return "请输入提示词";
      return null;
    }
    if (!doc) return "请先打开 PSD";
    if (mode === "upscale") {
      const r = upSource();
      if (!r) return "请在图层面板选中要放大的图层（不能是图层组或调整图层）";
      return Math.max(r.right - r.left, r.bottom - r.top) * upScale() <= MAX_UPSCALE_EDGE ? null
        : upLayerMode() ? `图层「${upLargest()!.name}」放大后超过 ${MAX_UPSCALE_EDGE} 像素，请降低倍数或不选它` : `放大后超过 ${MAX_UPSCALE_EDGE} 像素，请框选一部分或降低倍数`;
    }
    if (mode === "outpaint" && !regenerating && !willAdd() && !padTotal()) return "拖动上面画布的边缘，设定要扩展的尺寸";
    if (inpaintLike(mode) && !regenerating && !sel && !willAdd()) return mode === "blend" ? "请先框选要融合的产品和它周围一圈" : mode === "extract" ? "请先框选要抠的东西" : "请先建立选区";
    if (inpaintLike(modeOf(profile)) && !profile.options.allowEmptyPrompt && profile.bindings.some(b => b.role === "prompt") && !text.trim()) return "请输入提示词（留空移除可在「接口校准」里开启）";
    return null;
  }

  function renderAction() {
    if (run) {
      genBtn.className = "generate running";
      replace(genBtn, icon("stop"), h("span", null, "取消"));
      genBtn.disabled = false;
      replace(progEl, h("div", { class: "bar" }, h("span", { style: `width:${Math.round((run.progress ?? 0) * 100)}%` })),
        h("div", { class: "stage" }, run.stage + (run.detail ? " · " + run.detail : "")));
      progEl.hidden = false;
      return;
    }
    const why = blockedReason();
    genBtn.className = "generate";
    genBtn.disabled = !!why;
    genBtn.title = why ?? "";
    replace(genBtn, icon("spark"), h("span", null, willAdd() ? "生成更多变体" : mode === "outpaint" ? "扩图" : mode === "upscale" ? "放大" : mode === "blend" ? "融图" : mode === "extract" ? "抠图" : "生成"));
    progEl.hidden = !why;
    replace(progEl, why ? h("div", { class: "stage muted" }, why,
      conn.state === "down" && svc.launch ? h("button", { class: "link", onClick: () => void launchComfy() }, settings.comfyLaunch ? "  一键启动" : "  设置启动文件") : null) : null);
  }

  function renderAdvanced() {
    const open = settings.advancedOpen;
    replace(advHead, icon("sliders"), h("span", { class: "grow" }, "高级参数"), h("span", { class: "chev" + (open ? " open" : "") }, icon("chevron")));
    advBody.hidden = !open;
    if (!open) return;
    if (!profile || !pstate) { replace(advBody, h("div", { class: "muted small" }, "导入工作流后显示")); return; }
    const ps = pstate, p = profile;
    const save = () => store.saveState(p.id, ps);
    const rows: HTMLElement[] = [];
    for (const b of p.bindings.filter(x => x.role === "param")) {
      const k = b.nodeId + "." + b.input;
      const base = p.api[b.nodeId]?.inputs[b.input];
      const val = k in ps.params ? ps.params[k] : defaultParam(b, base);
      const label = h("span", { class: "param-label", title: `#${b.nodeId}.${b.input}` }, b.label ?? b.input);
      if (typeof base === "boolean") {
        rows.push(h("label", { class: "param check-row" }, h("input", { type: "checkbox", checked: !!val, onChange: (e: Event) => { ps.params[k] = (e.target as HTMLInputElement).checked; save(); } }), label));
        continue;
      }
      const isInt = Number.isInteger(base) && !/strength|强度|cfg|denoise/i.test(b.label ?? b.input);
      const lo = b.min ?? (isInt ? 0 : 0), hi = b.max ?? (isInt ? Math.max(Number(base) * 2, 10) : Math.max(2, Number(base) * 2));
      const num = h("input", { class: "num", type: "number", value: String(val), step: isInt ? "1" : "0.01" }) as HTMLInputElement;
      const range = h("input", { type: "range", min: String(lo), max: String(hi), step: isInt ? "1" : "0.01", value: String(val) }) as HTMLInputElement;
      const set = (v: number) => { if (!Number.isFinite(v)) return; ps.params[k] = v; num.value = String(v); range.value = String(v); save(); };
      range.addEventListener("input", () => set(Number(range.value)));
      num.addEventListener("change", () => set(Number(num.value)));
      rows.push(h("div", { class: "param" }, h("div", { class: "param-top" }, label,
        k in ps.params && ps.params[k] !== base ? h("button", { class: "link small", title: "恢复工作流中的原始值", onClick: () => { delete ps.params[k]; save(); renderAdvanced(); } }, "复原") : null),
        h("div", { class: "param-ctl" }, range, num)));
    }
    if (p.bindings.some(b => b.role === "seed")) {
      const seedNum = h("input", { class: "num wide", type: "number", value: String(ps.seed), disabled: ps.seedMode === "random" }) as HTMLInputElement;
      seedNum.addEventListener("change", () => { ps.seed = Math.max(0, Math.min(MAX_SEED, Math.floor(Number(seedNum.value) || 0))); save(); });
      const mode = h("select", { class: "field" }, h("option", { value: "random" }, "每次随机"), h("option", { value: "fixed" }, "固定")) as HTMLSelectElement;
      mode.value = ps.seedMode;
      mode.addEventListener("change", () => { ps.seedMode = mode.value as "random" | "fixed"; save(); renderAdvanced(); });
      rows.push(h("div", { class: "param" }, h("div", { class: "param-top" }, h("span", { class: "param-label" }, "随机种子")),
        h("div", { class: "param-ctl" }, mode, seedNum,
          h("button", { class: "icon-btn", title: "换一个种子", onClick: () => { ps.seed = randomSeed(); ps.seedMode = "fixed"; save(); renderAdvanced(); } }, icon("dice")))));
    }
    if (p.options.localMask?.links.length) {
      const lm = p.options.localMask;
      rows.push(h("label", { class: "param check-row", title: "把遮罩接到 " + lm.links.map(l => `#${l.nodeId}.${l.input}`).join("、") + "，让模型只在选区内生成。只改本次提交的副本，不修改 ComfyUI 中的工作流" },
        h("input", { type: "checkbox", checked: lm.enabled, onChange: (e: Event) => { lm.enabled = (e.target as HTMLInputElement).checked; store.saveProfiles(profiles); } }),
        h("span", { class: "param-label" }, "只重绘选区内")));
    }
    {
      if (modeOf(profile) === "blend" || modeOf(profile) === "extract") rows.push(h("label", { class: "param check-row", title: modeOf(profile) === "extract"
        ? "抠出来的物件在原图里看得见的部分，用原图的全分辨率细节（文字、纹理不走样）；被挡住、由 AI 补全的部分仍用 AI 画的。想完全用 AI 的结果就关掉"
        : "光影、阴影和颜色用 AI 的结果，纹理和文字等细节用原图。人脸、文字、纹理保持原样，不会被 AI 重画走样（AI 只在 2048 像素内采样）。如果想让 AI 修掉原图的白边、毛边或者改变形状，就关掉" },
        h("input", { type: "checkbox", checked: ps.keepDetail !== false, onChange: (e: Event) => { ps.keepDetail = (e.target as HTMLInputElement).checked; save(); } }),
        h("span", null, "保留原图细节")));
      rows.push(h("label", { class: "param check-row", title: "生成前调用 ComfyUI 自带的「释放」接口，清空节点缓存并卸载模型，让工作流每个节点都重新执行。结果与使用缓存时相同，但每次都要重新加载模型，明显更慢" },
        h("input", { type: "checkbox", checked: !!ps.fullRun, onChange: (e: Event) => { ps.fullRun = (e.target as HTMLInputElement).checked; save(); } }),
        h("span", { class: "param-label" }, "每次完整运行（不使用 ComfyUI 缓存，较慢）")));
    }
    if (!rows.length) rows.push(h("div", { class: "muted small" }, "该工作流没有绑定可调参数。可在「接口校准」中添加已有 LoRA 强度、步数等字段。"));
    replace(advBody, ...rows);
  }

  function renderAll() { renderView(); renderConn(); renderFlows(); renderHistory(); renderRefs(); renderSelection(); renderAction(); renderAdvanced(); renderStatus(); }

  // ── Photoshop state ──
  let refreshing = false, again = false;
  async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    let switchTo: TaskType | null = null;
    try {
      doc = svc.host.activeDoc();
      sel = doc ? await svc.host.selectionBounds(doc.id) : null;
      fills = doc ? svc.host.listFillGroups(doc.id) : [];
      const active = doc ? await svc.host.activeFillGroup() : null;
      // only a *newly* selected fill layer takes over, so picking another fill in the panel sticks
      const activeKey = active ? `${active.docId}:${active.layerId}` : "";
      if (doc && active && activeKey !== lastActive && pinned.get(doc.id) !== active.layerId) {
        pinned.set(doc.id, active.layerId); choice = null;
        if (active.kind !== mode && !run) switchTo = active.kind; // selecting an expansion opens 扩图 and vice versa
      }
      lastActive = activeKey;
      const pin = doc ? pinned.get(doc.id) : undefined;
      group = doc && pin !== undefined ? await svc.host.fillGroupById(doc.id, pin) : null;
      if (doc && !group && pin !== undefined && !fills.some(f => f.layerId === pin)) pinned.delete(doc.id);
      variations = group ? await svc.host.variations(group) : [];
      const now = group ? `${group.docId}:${group.layerId}` : "";
      if (now !== lastGroupKey) { log("info", "current fill", now || "none", active ? "(selected)" : pin !== undefined ? "(pinned)" : ""); lastGroupKey = now; }
    } catch (e) { log("warn", "refresh failed", e); }
    finally { refreshing = false; }
    if (switchTo) setMode(switchTo);
    void loadDocThumb();
    renderHistory(); renderSelection(); renderAction();
    if (again) { again = false; void refresh(); }
  }

  /** The expand editor shows the current canvas; reloaded when the document or its size changes. */
  async function loadDocThumb(force = false) {
    if (mode !== "outpaint") return;
    const key = doc ? `${doc.id}:${doc.width}x${doc.height}` : "";
    if (key === thumbKey && !force) return;
    thumbKey = key;
    if (!doc) { expander.setImage(null, 1, 1); return; }
    const d = doc;
    expander.setImage(null, d.width, d.height);
    try {
      const url = await svc.host.docThumbnail(d.id, 480);
      if (thumbKey === key) expander.setImage(url, d.width, d.height);
    } catch (e) { log("warn", "doc thumbnail", e); }
  }

  function setView(v: "generate" | "tools") {
    if (run) return;
    settings.view = v; store.saveSettings(settings);
    renderView();
    if (v === "tools") void toolsView.refresh();
  }

  function renderView() {
    viewBtns.forEach((b, i) => b.classList.toggle("on", (i === 1) === toolsMode()));
    genView.hidden = toolsMode();
    toolsView.el.hidden = !toolsMode();
    flowBtn.hidden = toolsMode();
  }

  function setMode(m: TaskType) {
    if (m === mode || run) return;
    mode = m; settings.mode = m; store.saveSettings(settings);
    profile = pickFor(m);
    pstate = profile ? store.state(profile.id) : null;
    for (const k of Object.keys(refs)) delete refs[Number(k)];
    renderAll();
    void loadDocThumb();
    if (profile && conn.state === "ok") void quietSync(profile);
  }

  async function showVariation(v: Variation) {
    if (!group || run) return;
    try {
      await svc.host.showVariation(group, v.layerId); variations = variations.map(x => ({ ...x, visible: x.layerId === v.layerId })); renderHistory();
      // the picked variation's prompt goes into the prompt box
      if (group.kind !== "upscale" && group.kind === mode) setPromptText(v.prompt === "移除" ? "" : v.prompt);
    }
    catch (e) { setStatus("切换失败：" + (e as Error).message, "error"); }
  }

  async function deleteVariation(v: Variation) {
    if (!group || run) return;
    try { await svc.host.deleteVariation(group, v.layerId); await refresh(); setStatus(`已删除变体 ${v.number}`, "ok"); }
    catch (e) { setStatus("删除失败：" + (e as Error).message, "error"); }
  }

  // ── connection ──
  /** Returns null on success, else the raw error text (also logged). */
  async function checkConn(): Promise<string | null> {
    conn = { state: "checking", text: "连接中…" }; renderConn();
    let error: string | null = null;
    try {
      const s = await withTimeout(comfy.systemStats(), 6000, "连接 ComfyUI ");
      conn = { state: "ok", text: "ComfyUI " + (s.system?.comfyui_version ?? "") };
      log("info", "connected", comfy.base, s.system?.comfyui_version);
    } catch (e) {
      const err = e as Error;
      error = `${err.name && err.name !== "Error" ? err.name + "：" : ""}${err.message}`;
      conn = { state: "down", text: "未连接" };
      log("error", "connect failed", comfy.base, err);
      setStatus(error, "error");
    }
    renderConn(); renderAction();
    if (!error && profile) void quietSync(profile);
    return error;
  }

  let launching = false;
  /** Starts ComfyUI with the configured script and waits (up to 3 min) until it answers. */
  async function launchComfy(report: (kind: "ok" | "error" | "info", text: string) => void = (k, t) => setStatus(t, k)) {
    if (!svc.launch || launching) return;
    if (!settings.comfyLaunch) { report("error", "请先在「ComfyUI 连接」中选择 ComfyUI 的启动文件"); openSettings(); return; }
    launching = true;
    try {
      log("info", "launch comfy", settings.comfyLaunch);
      const err = await svc.launch(settings.comfyLaunch);
      if (err) { report("error", "启动失败：" + err); return; }
      const t0 = Date.now();
      conn = { state: "checking", text: "启动中…" }; renderConn();
      while (Date.now() - t0 < 180_000) {
        report("info", `正在启动 ComfyUI… ${Math.round((Date.now() - t0) / 1000)} 秒`);
        await new Promise(r => setTimeout(r, 3000));
        try {
          const s = await withTimeout(comfy.systemStats(), 2500, "连接");
          conn = { state: "ok", text: "ComfyUI " + (s.system?.comfyui_version ?? "") }; renderConn(); renderAction();
          report("ok", "ComfyUI 已启动并连接");
          setStatus("ComfyUI 已启动并连接", "ok");
          return;
        } catch { /* still starting */ }
      }
      conn = { state: "down", text: "未连接" }; renderConn(); renderAction();
      report("error", "3 分钟内没有连上 ComfyUI，请看 ComfyUI 窗口里的报错");
    } finally { launching = false; }
  }

  function openSettings() {
    const url = h("input", { class: "field", value: settings.comfyUrl, placeholder: "127.0.0.1:8188" }) as HTMLInputElement;
    const result = h("div", { class: "conn-result" });
    const launchPath = h("input", { class: "field grow", value: settings.comfyLaunch, placeholder: "ComfyUI 启动文件路径" }) as HTMLInputElement;
    launchPath.addEventListener("change", () => { settings.comfyLaunch = launchPath.value.trim().replace(/^"|"$/g, ""); store.saveSettings(settings); });
    const show = (kind: "ok" | "error" | "info", text: string) => replace(result, h("span", { class: "dot " + kind }), h("span", null, text));
    const connect = async () => {
      show("info", "正在保存…");
      settings.comfyUrl = normalizeUrl(url.value);
      url.value = settings.comfyUrl;
      store.saveSettings(settings);
      comfy = svc.comfy(settings.comfyUrl);
      show("info", "正在连接 " + settings.comfyUrl + " …");
      const error = await checkConn();
      if (error) show("error", error);
      else { show("ok", conn.text + " · 已连接"); setStatus("已连接 " + settings.comfyUrl, "ok"); setTimeout(() => sheet.remove(), 700); }
    };
    const sheet = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "ComfyUI 连接"),
        h("button", { class: "icon-btn", onClick: () => sheet.remove() }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("div", { class: "group-label" }, "地址"), url,
        h("div", { class: "muted small" }, "可以只填 IP 和端口，例如 127.0.0.1:8188。插件只调用 ComfyUI 自带的接口，不需要安装节点或修改启动参数。"),
        result,
        svc.launch ? h("div", { class: "group-label" }, "一键启动") : null,
        svc.launch ? h("div", { class: "row launch-row" }, launchPath,
          h("button", { class: "icon-btn", title: "选择启动文件（.bat / .cmd / .exe）", onClick: async () => {
            const p = await svc.pickLauncher?.();
            if (p) { launchPath.value = p; settings.comfyLaunch = p; store.saveSettings(settings); }
          } }, icon("folder"))) : null,
        svc.launch ? h("div", { class: "muted small" }, "ComfyUI 未运行时可在这里或面板上一键启动，例如 run_nvidia_gpu.bat。第一次启动时 Photoshop 会询问是否允许。") : null,
        svc.debugSave ? h("div", { class: "group-label" }, "排查问题") : null,
        svc.debugSave && h("label", { class: "check-row", title: "每次生成时把发送的图片、返回的图片和提交的工作流保存到 F:\\waveplug\\studio\\reports\\debug_*。大图一张可达几十 MB，排查完请关闭" },
          h("input", { type: "checkbox", checked: settings.debugFiles, onChange: (e: Event) => { settings.debugFiles = (e.target as HTMLInputElement).checked; store.saveSettings(settings); } }),
          h("span", null, "保存调试文件（图片较大，仅排查时打开）"))),
      h("div", { class: "sheet-foot" },
        svc.diagnose ? h("button", { class: "btn", title: "逐项测试 fetch / XHR / WebSocket，结果同时写入日志", onClick: async () => {
          settings.comfyUrl = normalizeUrl(url.value); url.value = settings.comfyUrl;
          show("info", "诊断中…");
          const lines = await svc.diagnose!(settings.comfyUrl).catch(e => ["诊断失败：" + (e as Error).message]);
          replace(result, h("pre", { class: "diag" }, lines.join("\n")));
        } }, "诊断") : null,
        h("button", { class: "btn", onClick: () => sheet.remove() }, "关闭"),
        svc.launch ? h("button", { class: "btn", title: "运行上面的启动文件，并等待 ComfyUI 就绪", onClick: async () => {
          settings.comfyLaunch = launchPath.value.trim().replace(/^"|"$/g, ""); store.saveSettings(settings);
          settings.comfyUrl = normalizeUrl(url.value); url.value = settings.comfyUrl; comfy = svc.comfy(settings.comfyUrl);
          await launchComfy(show);
          if (conn.state === "ok") setTimeout(() => sheet.remove(), 700);
        } }, "启动") : null,
        h("button", { class: "btn primary", onClick: () => void connect() }, "保存并连接")));
    sheetHost.append(sheet);
    if (conn.state === "down" && status.kind === "error") show("error", status.text);
  }

  // ── workflows ──
  function selectProfile(id: string) {
    profile = profiles.find(p => p.id === id) ?? null;
    pstate = profile ? store.state(profile.id) : null;
    if (profile) {
      mode = modeOf(profile); settings.mode = mode;
      settings.activeByMode = { ...settings.activeByMode, [mode]: profile.id };
      if (mode === "inpaint") settings.activeProfile = profile.id;
    }
    store.saveSettings(settings);
    for (const k of Object.keys(refs)) delete refs[Number(k)];
    renderFlows(); renderRefs(); renderHistory(); renderSelection(); renderAction(); renderAdvanced();
    void loadDocThumb();
    if (profile && conn.state === "ok") void quietSync(profile);
  }

  /** Background sync (workflow + reference/mask detection) without leaving a status message. */
  async function quietSync(p: Profile) {
    if (run) return;
    const before = status;
    const err = await syncProfile(p).catch(e => (e as Error).message);
    if (err) log("warn", "background sync", err);
    if (status.text === "同步 ComfyUI 工作流…") { status = before; renderStatus(); }
    renderRefs();
  }

  function openWorkflows() {
    const sheet: HTMLElement = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "工作流"),
        h("button", { class: "icon-btn", title: "关闭", onClick: () => sheet.remove() }, icon("close"))),
      h("div", { class: "sheet-body" },
        profiles.length ? null : h("div", { class: "muted" }, "还没有导入工作流。"),
        ...[...profiles].sort((a, b) => Number(modeOf(a) !== mode) - Number(modeOf(b) !== mode)).map(p => {
          const bad = validateProfile(p).length > 0;
          return h("button", { class: "menu-item flow-item" + (p.id === profile?.id ? " on" : ""), onClick: () => { selectProfile(p.id); sheet.remove(); } },
            icon(p.id === profile?.id ? "check" : "flow"),
            h("span", { class: "grow" }, h("b", null, p.name), h("span", { class: "muted small block" },
              (modeOf(p) === "outpaint" ? "扩图 · " : modeOf(p) === "txt2img" ? "文生图 · " : modeOf(p) === "upscale" ? "放大 · " : modeOf(p) === "blend" ? "融图 · " : modeOf(p) === "extract" ? "抠图 · " : "局部重绘 · ") + (p.source?.kind === "comfy" ? "ComfyUI 已保存的工作流" : "API JSON") + (bad ? " · 需要校准" : ""))));
        })),
      h("div", { class: "sheet-foot" },
        profile ? h("button", { class: "btn", onClick: () => { sheet.remove(); void calibrate(); } }, "校准当前") : null,
        h("button", { class: "btn primary", onClick: () => { sheet.remove(); importMenu(); } }, "导入工作流")));
    sheetHost.append(sheet);
  }

  function importMenu() {
    const menu = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "导入工作流"),
        h("button", { class: "icon-btn", onClick: () => menu.remove() }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("button", { class: "menu-item", onClick: async () => { menu.remove(); await importFromFile(); } },
          icon("folder"), h("span", null, h("b", null, "API 格式 JSON 文件"), h("span", { class: "muted small block" }, "ComfyUI 菜单 → 导出 (API)"))),
        h("button", { class: "menu-item", onClick: async () => { menu.remove(); await importFromComfy(); } },
          icon("flow"), h("span", null, h("b", null, "ComfyUI 中已保存的工作流"), h("span", { class: "muted small block" }, "需要已连接 ComfyUI，自动转换为 API 格式")))));
    sheetHost.append(menu);
  }

  async function importFromFile() {
    try {
      const f = await svc.pickJson();
      if (!f) return;
      await adopt(f.name.replace(/\.json$/i, ""), asApiGraph(JSON.parse(f.text)), []);
    } catch (e) { setStatus("导入失败：" + (e as Error).message, "error"); }
  }

  async function importFromComfy() {
    try {
      setStatus("读取 ComfyUI 工作流列表…");
      const list = await comfy.listWorkflows();
      const pickSel = h("select", { class: "field" }, ...list.map(p => h("option", { value: p }, p.replace(/\.json$/, ""))));
      const sheet = h("div", { class: "sheet" },
        h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "选择 ComfyUI 工作流"),
          h("button", { class: "icon-btn", onClick: () => sheet.remove() }, icon("close"))),
        h("div", { class: "sheet-body" }, list.length ? pickSel : h("div", { class: "muted" }, "ComfyUI 中没有已保存的工作流")),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onClick: () => sheet.remove() }, "取消"),
          h("button", { class: "btn primary", disabled: !list.length, onClick: async () => {
            sheet.remove();
            try {
              setStatus("转换为 API 格式…");
              const [ui, info] = await Promise.all([comfy.readWorkflow(pickSel.value), comfy.objectInfo()]);
              const { api, warnings } = uiToApi(ui, info);
              await adopt(pickSel.value.split("/").pop()!.replace(/\.json$/, ""), api, warnings, { kind: "comfy", path: pickSel.value });
              if (warnings.length) log("warn", "conversion", warnings);
            } catch (e) { setStatus("导入失败：" + (e as Error).message, "error"); }
          } }, "导入")));
      sheetHost.append(sheet);
      setStatus("就绪");
    } catch (e) { setStatus((e instanceof ComfyError ? "" : "读取失败：") + (e as Error).message, "error"); }
  }

  /** New import, or re-import of a workflow with the same name: carry valid bindings over. */
  /** Bindings to use without asking, when every required role was recognised unambiguously. */
  function autoBindings(rec: ReturnType<typeof recognize>): Binding[] | null {
    if (rec.blockers.length) return null;
    const one = (role: string) => rec.suggestions.filter(s => s.binding.role === role);
    const image = one("image"), output = one("output"), prompt = one("prompt"), mask = one("mask");
    if (rec.taskType !== "txt2img" && (image.length !== 1 || image[0].confidence !== "certain")) return null;
    if (output.length !== 1 || output[0].confidence !== "certain") return null;
    if (prompt.length && prompt[0].confidence !== "certain") return null;
    if (mask.length && mask[0].confidence !== "certain") return null;
    return rec.suggestions.filter(s => s.confidence === "certain").map(s => s.binding);
  }

  /** An empty prompt is valid: a removal workflow, or a prompt box its author titled 「可留空」. */
  const looksLikeRemoval = (name: string, bindings: Binding[]) =>
    /移除|清除|擦除|remove|erase|可留空|留空\s*[=＝]/i.test(name + " " + bindings.filter(b => b.role === "prompt").map(b => b.title ?? "").join(" "));
  /** What an empty prompt does, from a prompt box titled e.g. 「提示词（可留空，留空=默认融图提示词）」. */
  const emptyMeaning = (p: Profile) => /留空\s*[=＝]\s*([^）)，,]+)/.exec(p.bindings.find(b => b.role === "prompt")?.title ?? "")?.[1]?.trim();

  /** Short confirmation shown instead of the full calibration sheet when recognition is clear. */
  function openSummary(name: string, bindings: Binding[], options: Profile["options"]): Promise<"ok" | "adjust" | null> {
    return new Promise(resolve => {
      const line = (label: string, b?: Binding, note = "") => b
        ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, label), h("span", { class: "sum-v" }, `#${b.nodeId} ${b.title ?? b.classType}${note}`))
        : null;
      const params = bindings.filter(b => b.role === "param").map(b => b.label ?? b.input);
      const img = bindings.find(b => b.role === "image");
      const empty = h("input", { type: "checkbox", checked: options.allowEmptyPrompt, onChange: (e: Event) => { options.allowEmptyPrompt = (e.target as HTMLInputElement).checked; } });
      const done = (v: "ok" | "adjust" | null) => { sheet.remove(); resolve(v); };
      const sheet = h("div", { class: "sheet" },
        h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "已识别工作流"),
          h("button", { class: "icon-btn", title: "关闭", onClick: () => done(null) }, icon("close"))),
        h("div", { class: "sheet-body" },
          h("div", { class: "sum-name" }, icon("check", 16), h("span", null, name)),
          h("div", { class: "muted small" }, "所有必需的接口都已自动找到，可以直接使用。"),
          h("div", { class: "sum" },
            line(bindings.some(b => b.role === "pad" || b.role === "scale") ? "原图" : "画面 + 选区", img, img?.encoding === "rgba-alpha-mask" ? "（选区写入透明通道）" : ""),
            line("选区遮罩", bindings.find(b => b.role === "mask")),
            bindings.some(b => b.role === "size") ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, ROLE_LABEL.size),
              h("span", { class: "sum-v" }, bindings.filter(b => b.role === "size").map(b => `#${b.nodeId}.${b.input}`).join("、") + "（由面板上的比例和长边控制）")) : null,
            ...bindings.filter(b => b.role === "reference").map(b => line(`参考图 ${b.slot}`, b, b.emptyValue ? "（可选）" : "")),
            bindings.some(b => b.role === "pad") ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, ROLE_LABEL.pad),
              h("span", { class: "sum-v" }, bindings.filter(b => b.role === "pad").map(b => `#${b.nodeId}.${b.input}`).join("、") + "（由面板上的画布控制）")) : null,
            bindings.some(b => b.role === "scale") ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, ROLE_LABEL.scale),
              h("span", { class: "sum-v" }, bindings.filter(b => b.role === "scale").map(b => `#${b.nodeId}.${b.input}`).join("、") + "（由面板上的倍数控制）")) : null,
            line("提示词", bindings.find(b => b.role === "prompt")),
            line("输出", bindings.find(b => b.role === "output")),
            params.length ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, "高级参数"), h("span", { class: "sum-v" }, params.join("、"))) : null),
          bindings.some(b => b.role === "prompt") && !bindings.some(b => b.role === "pad" || b.role === "size" || b.role === "scale")
            ? h("label", { class: "check-row sum-opt" }, empty, h("span", null, "提示词留空时执行「移除选区内容」")) : null),
        h("div", { class: "sheet-foot" },
          h("button", { class: "btn", onClick: () => done("adjust") }, "手动调整"),
          h("button", { class: "btn primary", onClick: () => done("ok") }, "完成")));
      sheetHost.append(sheet);
    });
  }

  /** New import, or re-import of a workflow with the same name: carry valid bindings over. */
  async function adopt(name: string, api: ReturnType<typeof asApiGraph>, warnings: string[], source: Profile["source"] = { kind: "file" }) {
    const rec = recognize(api);
    if (warnings.length) rec.notes.push(...warnings);
    /** 扩图 workflows: task type, the canvas node's fixed inputs, prompt may be empty */
    const typed = (p: Profile) => {
      p.taskType = rec.taskType;
      if (rec.taskType === "outpaint") { p.options.outpaint = rec.outpaint; p.options.allowEmptyPrompt = true; }
      else delete p.options.outpaint;
      if (rec.taskType === "txt2img") { p.options.txt2img = rec.txt2img; p.options.allowEmptyPrompt = false; }
      else delete p.options.txt2img;
      if (rec.taskType === "upscale") { p.options.upscale = rec.upscale; p.options.allowEmptyPrompt = true; }
      else delete p.options.upscale;
      return p;
    };
    const old = profiles.find(p => p.name === name);
    if (old) {
      const c = carryOver(old, api);
      if (!c.broken.length && !validateProfile(c.profile).length) {
        typed(Object.assign(old, { ...c.profile, source, updatedAt: Date.now() }));
        saveProfiles(old.id);
        setStatus(`已更新「${old.name}」，原有绑定全部有效`, "ok");
        return;
      }
      const result = await openCalibration(sheetHost, api, rec, { name, bindings: c.profile.bindings, options: c.profile.options }, false);
      if (!result) return;
      typed(Object.assign(old, { ...c.profile, source, name: result.name, bindings: result.bindings, options: result.options, updatedAt: Date.now() }));
      saveProfiles(old.id);
      setStatus(`已更新「${old.name}」：保留 ${c.kept.length} 项，自动迁移 ${c.remapped.length} 项` + (c.broken.length ? `，${c.broken.length} 项已重新绑定` : ""), "ok");
      return;
    }
    const options = newProfile(name, api, []).options;
    const auto = autoBindings(rec);
    if (auto) {
      options.allowEmptyPrompt = rec.taskType === "outpaint" || rec.taskType === "upscale" || rec.taskType === "blend" || rec.taskType === "extract" || (rec.taskType === "inpaint" && looksLikeRemoval(name, auto));
      const choice = await openSummary(name, auto, options);
      if (!choice) return;
      if (choice === "ok") {
        const p = newProfile(name, api, auto);
        p.options = options;
        p.source = source;
        profiles.push(typed(p));
        saveProfiles(p.id);
        setStatus(`已导入「${p.name}」，可以开始生成`, "ok");
        return;
      }
    }
    const result = await openCalibration(sheetHost, api, rec, { name, bindings: auto ?? [], options }, true);
    if (!result) return;
    const p = newProfile(result.name, api, result.bindings);
    p.options = result.options;
    p.source = source;
    profiles.push(typed(p));
    saveProfiles(p.id);
    setStatus(`已导入「${p.name}」`, "ok");
  }

  async function calibrate() {
    if (!profile) return importMenu();
    const p = profile;
    const result = await openCalibration(sheetHost, p.api, recognize(p.api), { name: p.name, bindings: p.bindings, options: p.options }, false);
    if (!result) return;
    Object.assign(p, { name: result.name, bindings: result.bindings, options: result.options, updatedAt: Date.now() });
    saveProfiles(p.id);
    setStatus("校准已保存", "ok");
  }

  function saveProfiles(activeId: string) {
    store.saveProfiles(profiles);
    selectProfile(activeId);
  }

  // ── references ──
  /** Reference picker: clipboard, image file, or any layer of the document (with previews). */
  function refMenu(slot: number, _anchor?: HTMLElement) {
    const auto = !!profile && !profile.bindings.some(b => b.role === "reference");
    const tag = auto ? `图${slot + 1}` : `参考 ${slot}`;
    const set = (r: RefSlot) => { refs[slot] = r; sheet.remove(); renderRefs(); };
    const layers = doc ? svc.host.listLayers(doc.id).filter(l => l.kind !== "group" && !l.name.startsWith(FILL_PREFIX) && !l.name.startsWith(BLEND_PREFIX) && !l.name.startsWith(EXTRACT_PREFIX) && !l.name.startsWith(EXPAND_PREFIX) && !l.name.startsWith(GENERATE_PREFIX) && !l.name.startsWith(UPSCALE_PREFIX)) : [];
    const list = h("div", { class: "layer-list" }, ...layers.map(l => {
      const img = h("div", { class: "layer-thumb" }, icon("image", 14));
      const row = h("button", { class: "layer-row", title: l.name, onClick: () => {
        if (!doc) return;
        const thumb = img.querySelector("img")?.getAttribute("src") ?? undefined;
        set({ kind: "layer", docId: doc.id, layerId: l.id, name: l.name, thumb });
      } }, img, h("span", { class: "layer-name", style: `padding-left:${l.depth * 10}px` }, l.name));
      (row as any)._load = () => svc.host.layerThumbnail(doc!.id, l.id, 64).then(t => replace(img, h("img", { src: t })), () => undefined);
      return row;
    }));
    const sheet: HTMLElement = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, `添加参考图（${tag}）`),
        h("button", { class: "icon-btn", title: "关闭", onClick: () => sheet.remove() }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("div", { class: "row ref-actions" },
          h("button", { class: "btn grow", title: "也可以在面板上直接按 Ctrl+V", onClick: async () => { sheet.remove(); await pasteReference(slot); } }, icon("paste", 14), h("span", null, "粘贴剪贴板")),
          h("button", { class: "btn grow", onClick: async () => {
            const f = await svc.pickImage();
            if (f) set({ kind: "file", name: f.name, bytes: f.bytes, thumb: f.url });
          } }, icon("folder", 14), h("span", null, "选择图片文件"))),
        h("div", { class: "group-label" }, "文档中的图层"),
        layers.length ? list : h("div", { class: "muted small" }, "当前文档没有可用的图层")),
      refs[slot] ? h("div", { class: "sheet-foot" },
        h("button", { class: "btn", onClick: () => {
          for (let s2 = slot; s2 < MAX_REFERENCES; s2++) refs[s2] = refs[s2 + 1];
          refs[MAX_REFERENCES] = undefined;
          sheet.remove(); renderRefs();
        } }, "移除这张参考图")) : null);
    sheetHost.append(sheet);
    // thumbnails one by one so a long layer list stays responsive
    void (async () => { for (const row of Array.from(list.children)) { if (!sheet.parentNode) break; await (row as any)._load?.(); } })();
  }

  /** Clipboard → reference slot (button in the picker, or Ctrl+V on the panel). */
  async function pasteReference(slot?: number) {
    const slots = refSlotNumbers();
    if (!slots.length) { setStatus("当前工作流不支持参考图", "error"); return; }
    const target = slot ?? (slots.find(s => !refs[s]) ?? slots[slots.length - 1]);
    setStatus("读取剪贴板…");
    try {
      const px = await svc.host.clipboardImage(1536);
      if (!px) { setStatus("剪贴板里没有图片", "error"); return; }
      const bytes = encodePng(onWhite(px));
      refs[target] = { kind: "file", name: "剪贴板.png", bytes, thumb: bytesToDataUrl(bytes, "image/png") };
      renderRefs();
      const auto = !!profile && !profile.bindings.some(b => b.role === "reference");
      setStatus(`已从剪贴板添加参考图（${auto ? "图" + (target + 1) : "参考 " + target}）`, "ok");
    } catch (e) { log("warn", "paste reference", e); setStatus("读取剪贴板失败：" + (e as Error).message, "error"); }
  }


  // ── generate ──
  let objectInfo: Awaited<ReturnType<Comfy["objectInfo"]>> | null = null;

  /**
   * Re-reads a ComfyUI-saved workflow and converts it with the current converter, so edits made in
   * ComfyUI (and converter fixes) take effect without re-importing. Older profiles without a
   * recorded source are matched to a saved workflow of the same name. Returns an error or null.
   */
  async function syncProfile(p: Profile): Promise<string | null> {
    if (p.source?.kind === "file") return null;
    let path = p.source?.kind === "comfy" ? p.source.path : null;
    if (!path) {
      const list = await comfy.listWorkflows().catch(() => [] as string[]);
      path = list.find(x => x.split("/").pop()!.replace(/\.json$/, "") === p.name) ?? null;
      if (!path) return null;
    }
    try {
      setStatus("同步 ComfyUI 工作流…");
      objectInfo ??= await comfy.objectInfo();
      const { api, warnings } = uiToApi(await comfy.readWorkflow(path), objectInfo);
      // ComfyUI validates every node itself and reports misalignments precisely, so conversion
      // warnings are logged rather than blocking (display-only widgets also trigger them).
      if (warnings.length) log("warn", "conversion", warnings);
      const c = carryOver(p, api);
      if (c.broken.length) return `ComfyUI 中的工作流已修改，${c.broken.length} 项绑定失效（${c.broken[0].reason}），请点「接口校准」重新确认`;
      Object.assign(p, { api: c.profile.api, bindings: c.profile.bindings, source: { kind: "comfy", path }, updatedAt: Date.now() });
      if (modeOf(p) === "outpaint") {
        const op = recognize(api).outpaint;
        if (!op) return "ComfyUI 中的工作流里找不到「外补画板」节点了。如果它和局部重绘共用一个工作流，请在 ComfyUI 里切回扩图模式后保存";
        p.options.outpaint = op;
      }
      if (modeOf(p) === "txt2img") {
        const t = recognize(api).txt2img;
        if (!t) return "ComfyUI 中的工作流里找不到设置输出尺寸的节点了，请点「接口校准」重新确认";
        p.options.txt2img = t;
      }
      if (modeOf(p) === "upscale") {
        const u = recognize(api).upscale;
        if (!u) return "ComfyUI 中的工作流里找不到放大节点了，请点「接口校准」重新确认";
        p.options.upscale = u;
      }
      if (!p.options.cropDefault) Object.assign(p.options, { sendScope: "crop", cropMargin: 1, cropDefault: true });
      refreshMaskLinks(p);
      store.saveProfiles(profiles);
      log("info", "workflow synced", path, c.remapped.length ? `remapped ${c.remapped.length}` : "");
      return null;
    } catch (e) {
      log("warn", "workflow sync failed", path, e);
      return "读取 ComfyUI 工作流失败：" + (e as Error).message;
    }
  }

  /** Detects the optional "repaint only inside the selection" links; on by default when found. */
  function refreshMaskLinks(p: Profile) {
    if (!objectInfo) return;
    const slots = findReferenceSlots(p.api, objectInfo);
    const had = !!p.options.refSlots;
    p.options.refSlots = slots ?? undefined;
    if (!!slots !== had) { log("info", "reference slots", JSON.stringify(slots)); renderRefs(); }
    // only inpaint: in 扩图 / 文生图 workflows such a link would feed e.g. an empty mask to the encoder
    const links = inpaintLike(modeOf(p)) ? findLocalMaskLinks(p.api, objectInfo) : [];
    const was = p.options.localMask;
    p.options.localMask = links.length ? { enabled: was ? was.enabled : true, links } : undefined;
    store.saveProfiles(profiles);
    if (links.length && !was) { log("info", "local mask links", JSON.stringify(links)); renderAdvanced(); }
  }

  /** 再生成: same fill area (the group's mask) and the shown variation's prompt, one more variation set. */
  async function regenerate() {
    const v = variations.find(x => x.visible) ?? variations[variations.length - 1];
    if (!group || !v || run) return;
    // a fill is regenerated with a workflow of its own kind
    if (group.kind !== mode) setMode(group.kind);
    if (!profile) { setStatus(group.kind === "outpaint" ? "请先导入扩图工作流" : group.kind === "txt2img" ? "请先导入文生图工作流" : group.kind === "upscale" ? "请先导入放大工作流" : group.kind === "blend" ? "请先导入融图工作流" : group.kind === "extract" ? "请先导入抠图工作流" : "请先导入局部重绘工作流", "error"); return; }
    await generate({ addTo: group, prompt: v.prompt === "移除" ? "" : v.prompt });
  }

  async function generate(again?: { addTo: FillGroup; prompt: string }) {
    if (!profile || !pstate || run) return;
    await checkConn();
    await refresh();
    const why = again ? blockedReason(again.prompt, true) : blockedReason();
    if (why) { setStatus(why, "error"); return; }
    const syncError = await syncProfile(profile);
    if (syncError) { setStatus(syncError, "error"); return; }
    setStatus("生成中…");
    const p = profile, ps = pstate;
    run = { stage: "准备中…", progress: null, detail: "", signal: { aborted: false } };
    const current = run;
    stash = null;
    renderAll();
    try {
      const res = await runInpaint(svc.host, comfy, {
        profile: p, prompt: again ? again.prompt : cleanPrompt(prompt.value), seed: ps.seedMode === "fixed" ? ps.seed : null, params: effectiveParams(p, ps),
        addTo: again ? again.addTo : willAdd() ? group ?? undefined : undefined,
        pads: modeOf(p) === "outpaint" ? { ...pads } : undefined,
        size: modeOf(p) === "txt2img" ? t2iSize() : undefined,
        scale: modeOf(p) === "upscale" ? upScale() : undefined,
        layers: modeOf(p) === "upscale" && upLayerMode() ? upLayers().map(({ id, name }) => ({ id, name })) : undefined,
        references: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v])),
        count: ps.count ?? 1,
        fullRun: !!ps.fullRun,
        keepDetail: (modeOf(p) === "blend" || modeOf(p) === "extract") && ps.keepDetail !== false,
      }, {
        signal: current.signal,
        stage: t => { current.stage = t; current.detail = ""; renderAction(); },
        progress: (f, t) => { current.progress = f; current.detail = t ?? ""; renderAction(); renderHistory(); },
        promptQueued: id => { current.promptId = id; },
        variationAdded: (g, v) => {
          // the canvas has grown: clear the extension at once, so a later failure / cancel
          // can't leave it set and expand the canvas a second time
          if (g.kind === "outpaint" && group?.layerId !== g.layerId && padTotal()) { pads = { left: 0, right: 0, top: 0, bottom: 0 }; expander.setPads(pads); }
          if (group?.layerId !== g.layerId) variations = [];
          group = g; pinned.set(g.docId, g.layerId); choice = null;
          variations = [...variations.map(x => ({ ...x, visible: false })), v]; renderHistory();
        },
        debug: settings.debugFiles ? svc.debugSave : undefined,
      });
      if (ps.seedMode === "random") { ps.seed = res.seeds[res.seeds.length - 1]; store.saveState(p.id, ps); }
      if (modeOf(p) === "extract" && !res.continued && res.cutout && res.group && settings.extractRemove !== false) {
        const removed = await removeCutout(res.group, res.cutout, current);
        if (removed !== true) { setStatus(`已抠出，变体 ${res.variations.map(v => v.number).join("、")}；${removed}`, removed.startsWith("从原图移除失败") ? "error" : "info"); return; }
        setStatus(`已抠出并从原图移除（拆图），变体 ${res.variations.map(v => v.number).join("、")}`, "ok");
        return;
      }
      if (!res.group) setStatus(`已放大 ${res.upscaled ?? 1} 个图层，结果是上方的智能对象，原图层已隐藏` + (res.failed?.length ? `；${res.failed.length} 个失败（${res.failed[0]}${res.failed.length > 1 ? " 等" : ""}）` : ""), res.failed?.length ? "error" : "ok");
      else setStatus(`${res.continued ? "已加入" : modeOf(p) === "outpaint" ? "已扩展画布，" : modeOf(p) === "txt2img" ? "已生成，" : modeOf(p) === "upscale" ? "已放大到新文档，" : modeOf(p) === "blend" ? "已新建 AI 融图，" : modeOf(p) === "extract" ? "已抠出，" : "已新建 AI 填充，"}变体 ${res.variations.map(v => v.number).join("、")} · seed ${res.seeds.join("、")}`, "ok");
    } catch (e) {
      log("error", "generate failed", e);
      if (e instanceof StashedResult) { stash = e.png; setStatus(e.message, "error"); }
      else setStatus(current.signal.aborted ? "已取消" : (e as Error).message, current.signal.aborted ? "info" : "error");
    } finally {
      run = null;
      renderAll();
      await refresh();
      void loadDocThumb(true);
    }
  }

  /** 拆图: the 局部重绘 workflow removes the cut-out from the original (prompt left empty), its result
   *  goes directly below the cut-out. Returns true, or why it didn't run. */
  async function removeCutout(cut: FillGroup, mask: { pixels: import("../core/image/png.ts").Pixels; rect: Rect }, current: NonNullable<typeof run>): Promise<true | string> {
    const rp = pickFor("inpaint");
    if (!rp) return "要从原图移除，先在「局部重绘」模式导入移除工作流（留空提示词 = 移除）";
    if (!rp.options.allowEmptyPrompt) return `「局部重绘」当前的工作流「${rp.name}」不支持留空移除，换成移除工作流后再试`;
    const err = await syncProfile(rp);
    if (err) return "从原图移除失败：" + err;
    try {
      const rps = store.state(rp.id);
      const res = await runInpaint(svc.host, comfy, {
        profile: rp, prompt: "", seed: null, params: effectiveParams(rp, rps), references: {}, count: 1,
        selectionMask: mask, hide: cut,
      }, {
        signal: current.signal,
        stage: t => { current.stage = "拆图 · " + t; current.detail = ""; renderAction(); },
        progress: (f, t) => { current.progress = f; current.detail = t ?? ""; renderAction(); },
        promptQueued: id => { current.promptId = id; },
        debug: settings.debugFiles ? svc.debugSave : undefined,
      });
      if (res.group) await svc.host.placeBelow(cut.docId, res.group.layerId, cut.layerId);
      log("info", "extract removed", res.group?.layerId ?? "");
      return true;
    } catch (e) {
      if (current.signal.aborted) throw e;
      log("error", "extract remove failed", e);
      if (e instanceof StashedResult) stash = e.png;
      return "从原图移除失败：" + (e as Error).message;
    }
  }

  async function cancel() {
    if (!run) return;
    run.signal.aborted = true;
    run.stage = "正在取消…"; renderAction();
    if (run.promptId) await comfy.cancel(run.promptId).catch(e => console.warn("取消失败", e));
  }

  async function saveStash() {
    if (!stash) return;
    if (await svc.saveImage(stash, `waveplug_${Date.now()}.png`)) { stash = null; setStatus("结果已另存", "ok"); }
  }

  document.addEventListener("keydown", e => {
    const k = e as KeyboardEvent;
    if (!(k.ctrlKey || k.metaKey) || k.key.toLowerCase() !== "v") return;
    const t = k.target as HTMLElement | null;
    if (t && /^(TEXTAREA|INPUT|SELECT)$/.test(t.tagName)) return; // normal paste into fields
    if (sheetHost.querySelector(".sheet") || run) return;
    k.preventDefault();
    void pasteReference();
  });

  // ── start ──
  window.addEventListener("error", e => { log("error", "uncaught", (e as ErrorEvent).error ?? (e as ErrorEvent).message); setStatus("插件内部错误：" + ((e as ErrorEvent).message ?? ""), "error"); });
  window.addEventListener("unhandledrejection", e => { log("error", "unhandled", (e as PromiseRejectionEvent).reason); setStatus("插件内部错误：" + String((e as PromiseRejectionEvent).reason?.message ?? (e as PromiseRejectionEvent).reason), "error"); });
  log("info", "start", svc.version, svc.host.kind, settings.comfyUrl);
  renderAll();
  svc.host.onChange(() => { void refresh(); if (toolsMode()) void toolsView.refresh(); });
  void refresh();
  if (toolsMode()) void toolsView.refresh();
  void checkConn();
}
