// WavePlug Studio panel. Layout follows V1.4: versions on top → workflow row → prompt →
// references → "参考当前画面" + selection → generate → collapsed advanced → status line.

import { type Comfy, ComfyError } from "../core/comfy/client.ts";
import type { Rect } from "../core/image/region.ts";
import { asApiGraph } from "../core/workflow/api.ts";
import { missingBuiltins } from "../core/workflow/builtin.ts";
import { MAX_SEED, randomSeed } from "../core/workflow/inject.ts";
import { normalizeVariationCount, stepVariationCountByWheel } from "../core/workflow/variationCount.ts";
import { type Binding, type Profile, type TaskType, ROLE_LABEL, carryOver, inpaintLike, newProfile, validateProfile } from "../core/workflow/profile.ts";
import { stripOptimizer, withoutOptimizer } from "../core/workflow/stripOptimizer.ts";
import { closeSetupPanels } from "./setupPanel.ts";
import { PROMPT_SYSTEM, isPromptMode, optimizeBlocked, parsePromptAnswer, promptRequest } from "../core/assistant/promptOptimize.ts";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import { isBlendGraph, recognize } from "../core/workflow/recognize.ts";
import { uiToApi } from "../core/workflow/uiToApi.ts";
import { findLocalMaskLinks } from "../core/workflow/localMask.ts";
import { LORA_MAX, LORA_MIN, MAX_LORAS, type LoraSlot, loraLabel, loraTargets } from "../core/workflow/loras.ts";
import { MAX_REFERENCES, findReferenceSlots, planLayerReferenceDrop, type LayerReferenceCandidate } from "../core/workflow/references.ts";
import { MAX_UPSCALE_EDGE, type RefSource, type RunResult, StashedResult, runInpaint } from "../app/generate.ts";
import { type ProfileState, type Services, type Settings, store } from "../app/services.ts";
import type { DocInfo, FillGroup, Pads, Variation } from "../ps/host.ts";
import { crumb, diagnosticReport, log, withTimeout } from "../app/log.ts";
import { openCalibration } from "./calibrate.ts";
import { every, h, icon, listen, replace } from "./dom.ts";
import { encodePng } from "../core/image/png.ts";
import { downscale, onWhite } from "../core/image/compose.ts";
import { BLEND_PREFIX, EXPAND_PREFIX, EXTRACT_PREFIX, FILL_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX } from "../ps/host.ts";
import { RATIOS, createExpandEditor } from "./expandEditor.ts";
import { createToolsView } from "./tools.ts";
import { type Overlay, connectOverlay } from "../app/overlay.ts";
import { type GenerateSections, type PanelMode, type PanelParam, isPanelMode, shownPanelMode } from "../core/overlay/generatePanel.ts";
import { OPEN_APP_HELPER_VERSION, appSettingsOf, hangDocs, redactSettings } from "../core/overlay/protocol.ts";
import { attachGenerateSurface } from "./generateSurface.ts";
import { attachIllustratorBridge } from "../app/illustratorBridge.ts";
import { attachVariantsSurface } from "./variantsSurface.ts";
import { type Change, describe, unseenChanges, userVisible } from "../core/whatsNew.ts";

declare const __CHANGES__: Change[] | undefined;
const CHANGES: Change[] = typeof __CHANGES__ !== "undefined" && Array.isArray(__CHANGES__) ? __CHANGES__ : [];
const SEEN_KEY = "wp.seenChange";

type Conn = { state: "checking" | "ok" | "down"; text: string };

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** A bound number's slider range and whether it counts in whole steps (the panel and the external panel). */
function paramRange(b: Binding, base: unknown): { int: boolean; lo: number; hi: number } {
  const int = Number.isInteger(base) && !/strength|强度|cfg|denoise/i.test(b.label ?? b.input);
  return { int, lo: b.min ?? 0, hi: b.max ?? (int ? Math.max(Number(base) * 2, 10) : Math.max(2, Number(base) * 2)) };
}
function defaultParam(_b: Binding, base: unknown): number | boolean {
  return base as number | boolean;
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

/** "lora:2" / "lora:2:on" from the external panel → that LoRA slot */
function loraSlotOf(ps: ProfileState, key: string): LoraSlot | undefined {
  const m = /^lora:(\d+)(:on)?$/.exec(key);
  return m ? ps.loras?.[Number(m[1])] : undefined;
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
  // One-time lifecycle defaults for the design-only development installation.
  // Keep these user-editable after migration; do not reset them on every panel reload.
  const DEV_LIFECYCLE_KEY = "wp.dev.lifecycleConfigured.v1";
  if (svc.devReload && localStorage.getItem(DEV_LIFECYCLE_KEY) !== "1") {
    settings.helperAutoStart = true;
    settings.comfyAutoStartWithPhotoshop = true;
    settings.comfyCloseWithPhotoshop = true;
    settings.comfyNoBrowser = true;
    settings.debugFiles = false;
    store.saveSettings(settings);
    localStorage.setItem(DEV_LIFECYCLE_KEY, "1");
  }
  let profiles: Profile[] = store.profiles();
  // prompts are optimised with DeepSeek (AI 优化) now: saved workflows lose their own optimiser nodes
  {
    const stripped = profiles.map(withoutOptimizer);
    if (stripped.some((p, i) => p !== profiles[i])) {
      log("info", "prompt optimiser nodes removed from saved workflows", stripped.filter((p, i) => p !== profiles[i]).map(p => p.name).join("、"));
      profiles = stripped;
      store.saveProfiles(profiles);
    }
  }
  // a panel that never had workflows starts with WavePlug's built-in ones (once: deleting them
  // later sticks; 导入工作流 › WavePlug 内置工作流 brings them back)
  const BUILTIN_SEEDED_KEY = "wp.builtinsSeeded.v1";
  if (!profiles.length && localStorage.getItem(BUILTIN_SEEDED_KEY) !== "1") {
    profiles = missingBuiltins(profiles);
    store.saveProfiles(profiles);
    log("info", "built-in workflows added", profiles.length);
  }
  try { localStorage.setItem(BUILTIN_SEEDED_KEY, "1"); } catch { /* storage off */ }
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
  // Explicit mode/workflow choices must win over an in-flight Photoshop selection refresh.
  let modeIntentRevision = 0;
  let hasObservedFillState = false;
  let profile: Profile | null = pickFor(mode);
  let pstate: ProfileState | null = profile ? store.state(profile.id) : null;
  let comfy: Comfy = svc.comfy(settings.comfyUrl);
  let conn: Conn = { state: "checking", text: "连接中…" };
  let doc: DocInfo | null = null, sel: Rect | null = null, group: FillGroup | null = null;
  // Variations follow the selected Photoshop AI layer.
  let lastGroupKey = "";
  /** the last selection seen (doc:rect), for telling a newly drawn one from a blink */
  let lastSelKey = "";
  /** 外置生成面板 (native/overlay): only in Photoshop; null while not set up */
  let overlay: Overlay | null = null, genSurface: ReturnType<typeof attachGenerateSurface> | null = null;
  let variantSurface: ReturnType<typeof attachVariantsSurface> | null = null;
  /** the page's state may have changed: the external panel gets what differs (cheap when nothing did) */
  // also lets the corner window look again: a run starting / ending changes whether the generate panel is wanted
  const outSync = () => { if (genSurface) genSurface.refresh(); else overlay?.queueSync(); };
  const near = (a: Rect, b: Rect) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  const willAdd = () => {
    if (!group || group.kind !== mode || mode === "upscale") return false;
    if (mode === "outpaint") return !padTotal();
    if (!sel) return true;
    return near(sel, group.rect);
  };
  let variations: Variation[] = [];
  // thumbnails keyed "docId:layerId" — rebuilt from Photoshop when missing
  const thumbs = new Map<string, string>();
  const refs: Record<number, RefSlot | undefined> = {};
  let layerReferenceDropInProgress = false;
  let run: null | { stage: string; progress: number | null; detail: string; promptId?: string; signal: { aborted: boolean } } = null;
  let lastCutout: { group: FillGroup; cutout: NonNullable<RunResult["cutout"]> } | null = null;
  let status: { text: string; kind: "info" | "ok" | "error" } = { text: "就绪", kind: "info" };
  let connectionCheckSeq = 0;
  let lastConnectionError: string | null = null;
  let stash: Uint8Array | null = null;
  let pads: Pads = { left: 0, right: 0, top: 0, bottom: 0 };
  const padTotal = () => pads.left + pads.right + pads.top + pads.bottom;

  // ── skeleton ──
  const connEl = h("button", { class: "conn", title: "设置（在 WavePlug 程序里打开）", onClick: () => void openAppSettings() });
  const targetEl = h("span", { class: "target" });
  const flowName = h("span", { class: "flow-name" });
  const flowBtn = h("button", { class: "flow-btn", title: "切换、导入或校准工作流", onClick: () => openWorkflows() }, icon("flow", 14), flowName, icon("chevron", 12));
  // UXP's native select can fail to commit a new choice during panel refreshes.
  // A numeric field commits on input and change, without being reset while focused.
  const countLabel = h("button", { class: "count-reset", title: "重置数量为 1", "aria-label": "重置数量为 1" }, "×");
  const countInput = h("input", { class: "field count-input", type: "number", min: "1", max: "4", step: "1",
    value: "1", title: "本次生成数量（1～4）；鼠标滚轮可增减", "aria-label": "生成数量" }) as HTMLInputElement;
  let countEditing = false, countEditingProfile: string | null = null;
  const saveCount = (n: number) => {
    if (!pstate || !profile || pstate.count === n) return;
    pstate.count = n;
    store.saveState(profile.id, pstate);
  };
  const resetCount = () => {
    countInput.value = "1";
    countEditing = false;
    countEditingProfile = profile?.id ?? null;
    saveCount(1);
    renderAction();
  };
  const commitCount = () => {
    // A mode/profile switch during an edit must not save the old digit to the new workflow.
    if (countEditing && countEditingProfile !== (profile?.id ?? null)) {
      countInput.value = String(normalizeVariationCount(pstate?.count));
      countEditing = false;
      return;
    }
    const raw = countInput.value.trim();
    const n = raw ? normalizeVariationCount(raw) : normalizeVariationCount(pstate?.count);
    countInput.value = String(n);
    saveCount(n);
  };
  countLabel.addEventListener("click", resetCount);
  countInput.addEventListener("focus", () => { countEditing = true; countEditingProfile = profile?.id ?? null; });
  countInput.addEventListener("input", () => {
    // Store a valid single digit immediately; partial values wait for change/blur.
    if (/^[1-4]$/.test(countInput.value)) saveCount(Number(countInput.value));
  });
  countInput.addEventListener("change", commitCount);
  countInput.addEventListener("blur", () => { commitCount(); countEditing = false; });
  countInput.addEventListener("wheel", e => {
    const wheel = e as WheelEvent;
    if (!Number.isFinite(wheel.deltaY) || wheel.deltaY === 0) return;
    wheel.preventDefault();
    const current = normalizeVariationCount(countInput.value);
    const next = stepVariationCountByWheel(countInput.value, wheel.deltaY);
    if (next === current) return;
    countInput.value = String(next);
    saveCount(next);
    renderAction();
  });
  const prompt = h("textarea", { class: "prompt", rows: 4 }) as HTMLTextAreaElement;
  const refsEl = h("div", { class: "refs" });
  const promptHint = h("div", { class: "prompt-hint" });
  const selEl = h("span", { class: "sel-state" });
  const genBtn = h("button", { class: "generate" });
  const progEl = h("div", { class: "progress" });
  const advHead = h("button", { class: "adv-head" });
  const advBody = h("div", { class: "adv-body" });
  const statusEl = h("div", { class: "status" });
  // 更新提醒: the helper found a newer WavePlug; one 「更新」 does it all (native/overlay/src/autoupdate.rs)
  const updateBar = h("div", { class: "update-bar" });
  updateBar.hidden = true;
  let update: { version: string; notes: string; dev: boolean } | null = null, updating = false, updateText = "", updateOk: boolean | null = null;
  function renderUpdate() {
    updateBar.hidden = !update && !updateText;
    if (updateBar.hidden) return;
    const what = update ? (update.dev ? `源码有 ${update.version}` : `WavePlug 有新版本 ${update.version}`) : "";
    const text = updateText || what;
    const btn = update && !updating ? h("button", { class: "btn primary small-btn", title: update.notes || "下载并装好新版本：插件当场换成新版本，WavePlug 程序自动重启，不用关 Photoshop", onClick: () => { updating = true; updateOk = null; updateText = "正在更新…"; renderUpdate(); overlay?.updateNow(); } }, "更新") : null;
    const close = !updating ? h("button", { class: "icon-btn", title: "先不更新（下次打开 Photoshop 时再提醒）", onClick: () => { update = null; updateText = ""; renderUpdate(); } }, icon("close", 10)) : null;
    updateBar.className = "update-bar" + (updateOk === false ? " error" : "");
    replace(updateBar, h("span", { class: "update-text", title: update?.notes ?? "" }, text), ...(btn ? [btn] : []), ...(close ? [close] : []));
  }
  /** after an update: load the new build once nothing is running (the loader picks the newer code) */
  function reloadWhenIdle() {
    if (run) { setTimeout(reloadWhenIdle, 2000); return; }
    log("info", "update installed: loading the new build");
    (globalThis as any).__waveplugDevReload?.();
  }
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
  // AI 优化 (DeepSeek, core/assistant/promptOptimize.ts) and, right after it, 还原
  const optBtn = h("button", { class: "ub fav-star ai-opt", onClick: () => void optimizePrompt() });
  const optUndo = h("button", { class: "ub fav-star", title: "恢复成优化前的提示词", onClick: () => restorePrompt() }, h("span", null, "↶ 还原"));
  const favEl = h("div", { class: "fav" }, h("div", { class: "fav-bar" }, favStar, favToggle, optBtn, optUndo), favList);
  favStar.addEventListener("click", () => {
    const text = prompt.value.trim(), list = favorites[favKey()] ?? [];
    if (!text) return;
    favorites[favKey()] = list.includes(text) ? list.filter(x => x !== text) : [text, ...list].slice(0, MAX_FAVORITES);
    store.saveFavorites(favorites); renderFav();
  });
  favToggle.addEventListener("click", () => { favOpen = !favOpen; renderFav(); });
  /** Puts `text` into the prompt box as if typed (saved with the workflow's state). */
  const setPromptText = (text: string) => { prompt.value = text; prompt.dispatchEvent(new Event("input")); };

  // ── AI 优化提示词 ──
  /** what was typed before the last optimisation, and what it became (还原 while the box still shows it) */
  let optBefore: string | null = null, optAfter = "", optBusy = false, optRun = 0;
  const optWithImage = () => settings.deepseekPromptImage !== false && (mode === "inpaint" || mode === "blend" || mode === "outpaint");
  /** why 「AI 优化」 can't run now (null: it can) */
  function optBlocked(): string | null {
    if (!(settings.deepseekKey ?? "").trim()) return "先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key";
    if (optWithImage() && !doc) return "没有打开的文档";
    return optimizeBlocked(mode, prompt.value, optWithImage());
  }
  const canRestore = () => optBefore !== null && prompt.value === optAfter;
  function renderOpt() {
    const shown = isPromptMode(mode);
    optBtn.hidden = !shown;
    optUndo.hidden = !shown || !canRestore() || optBusy;
    const why = optBusy ? null : optBlocked();
    optBtn.className = "ub fav-star ai-opt" + (why || optBusy ? " is-disabled" : "");
    optBtn.title = optBusy ? "DeepSeek 正在优化提示词…" : why ?? `让 DeepSeek 把提示词写得更完整、更适合 Qwen-Image${optWithImage() ? "（会上传画面缩略图，可在 WavePlug 程序 › 功能设置 › AI 助手 里关闭）" : ""}；优化后可以点「还原」`;
    replace(optBtn, h("span", null, optBusy ? "优化中…" : "✦ AI 优化"));
  }
  async function optimizePrompt() {
    if (optBusy || !isPromptMode(mode)) return;
    const why = optBlocked();
    if (why) { setStatus(why, "error"); return; }
    const m = mode, text = prompt.value, withImage = optWithImage(), d = doc, mine = ++optRun;
    optBusy = true; renderOpt(); outSync();
    const t0 = Date.now();
    try {
      const image = withImage && d ? await svc.host.docThumbnail(d.id, 1024) : null;
      const user = promptRequest(m, text, { image: !!image, sel: m === "outpaint" ? null : sel, size: d ? { width: d.width, height: d.height } : null, ratio: settings.t2iRatio });
      const r = await withTimeout(deepseekJson(svc.aiFetch ?? fetch, { key: settings.deepseekKey ?? "", model: image ? DEEPSEEK_VISION_MODEL : settings.deepseekModel },
        { system: PROMPT_SYSTEM, user, images: image ? [image] : undefined, maxTokens: 1500 }), 90_000, "DeepSeek ");
      const out = parsePromptAnswer(r.value);
      log("info", "ai prompt", JSON.stringify({ mode: m, image: !!image, chars: out.length, usage: r.usage, model: r.model, ms: Date.now() - t0 }));
      if (mine !== optRun) return;
      if (!out) throw new Error("DeepSeek 没有返回提示词");
      if (mode !== m || prompt.value !== text) { setStatus("提示词在优化期间改过了，没有替换", "info"); return; }
      optBefore = text; optAfter = out;
      setPromptText(out);
      setStatus("提示词已优化（不满意可以点「还原」）", "ok");
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log("warn", "ai prompt", msg);
      setStatus("AI 优化失败：" + msg, "error");
    } finally {
      if (mine === optRun) { optBusy = false; renderOpt(); outSync(); }
    }
  }
  function restorePrompt() {
    if (!canRestore()) return;
    const before = optBefore!;
    optBefore = null;
    setPromptText(before);
    setStatus("已还原成优化前的提示词", "info");
  }

  // 抠图 → 拆图: remove the cut-out object from the original afterwards (局部重绘's removal)
  const exRemoveBox = h("input", { type: "checkbox", onChange: (e: Event) => { settings.extractRemove = (e.target as HTMLInputElement).checked; store.saveSettings(settings); } }) as HTMLInputElement;
  const exRemoveLabel = h("label", { class: "check-row ex-remove", title: "抠出来之后，用「局部重绘」模式里的移除工作流（提示词留空 = 移除）把原图里的这个物件去掉，结果放在抠图下面一层，相当于把它拆成单独的一层" },
    exRemoveBox, h("span", null, "抠完后从原图移除（拆图）"));
  const exBackgroundBtn = h("button", { class: "btn ex-background", type: "button", title: "完成一次抠图后可手动补充原背景", onClick: () => void supplementBackground() }, "补充背景") as HTMLButtonElement;
  const exRemoveRow = h("div", { class: "param ex-remove-row" }, exRemoveLabel, exBackgroundBtn);

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
    updateBar,
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("span", { class: "mark" }, "W"), h("span", { class: "brand-name" }, "WavePlug"),
        h("span", { class: "brand-tag", title: "测试版 1：功能还在打磨，遇到问题请把 reports\\uxp_runtime.log 发给开发者" }, "Beta"),
        svc.devReload ? h("button", { class: "icon-btn dev-reload", title: "重新加载开发版代码（G:\\waveplug\\studio\\dist\\plugin）", onClick: () => svc.devReload!() }, icon("refresh", 13)) : null),
      h("div", { class: "top-right" }, flowBtn, connEl)),
    (mainEl.append(viewEl, (genView.append(
      modeEl,
      expandCard,
      t2iCard,
      upCard,
      h("section", { class: "card" },
        prompt, promptHint, favEl, exRemoveRow, refsEl,
        h("div", { class: "ctx-row" }, targetEl, selEl),
        h("div", { class: "gen-row" }, countLabel, countInput, genBtn),
        progEl),
      h("section", { class: "card adv" }, advHead, advBody)), genView), toolsView.el), mainEl),
    (footEl.append(statusEl, h("button", { class: "ver link", title: "查看更新记录", onClick: () => openChanges(CHANGES.filter(userVisible).slice(0, 30), "更新记录") }, svc.version)), footEl),
    sheetHost);

  // re-check the 生成 button as the user types (a required prompt enables it)
  prompt.addEventListener("input", () => { promptHint.hidden = !!prompt.value; renderFav(); if (!run) renderAction(); });
  prompt.addEventListener("input", () => { if (pstate && profile) { pstate.prompt = prompt.value; store.saveState(profile.id, pstate); } });
  genBtn.addEventListener("click", () => { if (run) cancel(); else if (conn.state !== "ok") void launchComfy(); else void generate(); });
  advHead.addEventListener("click", () => { settings.advancedOpen = !settings.advancedOpen; store.saveSettings(settings); renderAdvanced(); });

  // ── rendering ──
  function setStatus(text: string, kind: "info" | "ok" | "error" = "info") { status = { text, kind }; renderStatus(); }

  function renderFav() {
    outSync();
    favEl.hidden = mode === "upscale";
    const list = favorites[favKey()] ?? [], text = prompt.value.trim(), saved = !!text && list.includes(text);
    renderOpt();
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
    outSync();
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
    const selectionBased = !!sel && inpaintLike(mode);
    targetEl.textContent = selectionBased ? "按蒙版自动分组" : add && group ? "当前 AI 图层 · " + group.name
      : mode === "outpaint" ? "新建扩图" : mode === "txt2img" ? "新建生成"
      : mode === "upscale" ? (upLayerMode() ? "智能对象" : "新文档")
      : mode === "blend" ? "新建融图" : mode === "extract" ? "新建抠图" : "新建填充";
    targetEl.title = selectionBased ? "仅当选区蒙版与当前 AI 图层逐像素相同时增加变体，否则新建 AI 图层"
      : add ? "沿用当前选中 AI 图层的蒙版继续生成变体" : "新建 AI 图层；选择其他 AI 图层即可查看对应变体";
    targetEl.className = "target " + (add && !selectionBased ? "cont" : "new");
    // Keep variant thumbnails for the separate native variant rail; the main generate page
    // no longer renders its own variation card.
    void loadThumbs();
    // Keep the independent native variant rail synced even while the generate panel is hidden.
    variantSurface?.refresh();
  }

  let loadingThumbs = false;
  async function loadThumbs() {
    if (!group || loadingThumbs) return;
    loadingThumbs = true;
    try {
      // WaveLayer selection can change while a thumbnail read is in flight.
      // Re-evaluate the current AI group after each read, not a stale variation list.
      while (group) {
        const target: FillGroup = group;
        const v = variations.find(x => !thumbs.has(target.docId + ":" + x.layerId));
        if (!v) break;
        const key = target.docId + ":" + v.layerId;
        try { thumbs.set(key, await svc.host.thumbnail(target, v.layerId, 128)); }
        catch (e) { log("warn", "thumbnail", e); thumbs.set(key, ""); }
        if (group?.docId === target.docId && group.layerId === target.layerId) renderHistory();
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
    countInput.hidden = countLabel.hidden = mode === "upscale" && upLayerMode();
    t2iRatio.value = settings.t2iRatio ?? T2I_FOLLOW;
    t2iLong.value = String(settings.t2iLong ?? 1536);
    flowName.textContent = profile ? profile.name : mode === "outpaint" ? "导入扩图工作流" : mode === "txt2img" ? "导入文生图工作流" : mode === "upscale" ? "导入放大工作流" : mode === "blend" ? "导入融图工作流" : mode === "extract" ? "导入抠图工作流" : "导入工作流";
    flowBtn.title = profile ? `工作流：${profile.name}（点击切换、导入或校准）` : "导入 ComfyUI 工作流";
    flowBtn.classList.toggle("warn", !!profile && validateProfile(profile).length > 0);
    // Do not overwrite partially typed digits while a Photoshop/ComfyUI refresh runs.
    if (!countEditing || countEditingProfile !== (profile?.id ?? null)) {
      countInput.value = String(normalizeVariationCount(pstate?.count));
    }
    const allowEmpty = profile?.options.allowEmptyPrompt;
    // UXP's native textarea can merge its placeholder into the typed text, so the hint lives outside it
    promptHint.textContent = mode === "txt2img" ? "描述想要生成的画面"
      : mode === "outpaint" ? "描述扩展出来的内容（可留空，自动延续画面）"
      : mode === "extract" ? "可选：要抠的东西，例如 护肤品、红色价格牌；留空 = 抠选区里的主体"
      : mode === "blend" ? `可选：补充光影要求，例如 夕阳暖光、木桌上的倒影；留空 = ${(profile && emptyMeaning(profile)) || "默认融图提示词"}`
      : allowEmpty ? `描述要画进选区的内容；留空 = ${(profile && emptyMeaning(profile)) || "移除选区内的内容"}` : "描述要画进选区的内容";
    prompt.title = promptHint.textContent;
    // only when it differs: setting the value moves the caret to the end, in the middle of an edit
    // (this runs on connection / workflow updates while the user types)
    const text = pstate?.prompt ?? "";
    if (prompt.value !== text) prompt.value = text;
    promptHint.hidden = !!prompt.value || mode === "upscale";
    renderFav();
  }

  /** All slots the active workflow can actually accept, capped at eight. */
  function refSlotCapacity(): number[] {
    const bound = profile?.bindings.filter(b => b.role === "reference").map(b => b.slot!) ?? [];
    if (bound.length) return [...new Set(bound)].filter(s => Number.isInteger(s) && s >= 1 && s <= MAX_REFERENCES).sort((a, b) => a - b);
    if (!profile?.options.refSlots?.nodes.length) return [];
    const max = Math.min(MAX_REFERENCES, ...profile.options.refSlots.nodes.map(n => n.inputs.length));
    return Array.from({ length: Math.max(0, max) }, (_, i) => i + 1);
  }

  /** Show filled slots plus one empty slot; retain gaps when a drag starts at a later slot. */
  function refSlotNumbers(): number[] {
    const capacity = refSlotCapacity();
    if (!capacity.length) return [];
    if (profile?.bindings.some(b => b.role === "reference" && Number.isInteger(b.slot) && b.slot! >= 1 && b.slot! <= MAX_REFERENCES)) return capacity;
    let lastFilled = -1;
    capacity.forEach((slot, index) => { if (refs[slot]) lastFilled = index; });
    return capacity.slice(0, Math.min(capacity.length, lastFilled + 2));
  }

  /** references wired automatically (no 参考 bindings): the canvas is 图1, so reference n is 图(n+1) */
  const autoRefs = () => !!profile && !profile.bindings.some(b => b.role === "reference" && Number.isInteger(b.slot) && b.slot! >= 1 && b.slot! <= MAX_REFERENCES);
  const refTag = (slot: number) => autoRefs() ? `图${slot + 1}` : `参考 ${slot}`;

  function renderRefs() {
    outSync();
    const slots = refSlotNumbers();
    const auto = autoRefs();
    const hasAutoReference = auto && slots.some(slot => !!refs[slot]);
    refsEl.hidden = !slots.length;
    replace(refsEl, ...slots.map(slot => {
      const r = refs[slot];
      // with auto-wired references the canvas is 图1, so reference n is 图(n+1)
      const tag = refTag(slot);
      return h("button", { class: "ref" + (r ? " set" : " add"), title: r ? `${tag}：${r.name}（点击更换或移除）` : `添加参考图（${tag}）：PS 图层、图片文件或剪贴板（Ctrl+V）`, onClick: (e: Event) => refMenu(slot, e.currentTarget as HTMLElement) },
        r?.thumb ? h("img", { src: r.thumb, onError: (e: Event) => { const el = e.currentTarget as HTMLElement; el.replaceWith(h("span", { class: "ref-ext" }, (/\.(\w+)$/.exec(r.name)?.[1] ?? "图片").toUpperCase())); } })
          : r ? icon("image", 16) : icon("plus", 14),
        h("span", { class: "ref-num" }, r ? tag : "参考图"),
        r ? h("button", { class: "ref-del", title: `移除${tag}`, onClick: (e: Event) => { e.stopPropagation(); removeRef(slot); } }, icon("close", 10)) : null);
    }), hasAutoReference ? h("div", { class: "ref-hint" }, "画布为图1，参考图依次为图2～图9；在提示词中按编号指代")
      : mode === "txt2img" && slots.length && !hasAutoReference ? h("div", { class: "ref-hint" }, "可选：放一张参考图，工作流会按它来生成") : null);
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

  function blockedReason(text = prompt.value): string | null {
    if (!profile) return (mode === "outpaint" ? "请先导入扩图工作流（含「外补画板」节点）" : mode === "txt2img" ? "请先导入文生图工作流" : mode === "upscale" ? "请先导入放大工作流" : mode === "blend" ? "请先导入融图工作流（含融图 LoRA）" : mode === "extract" ? "请先导入抠图工作流（如心宝强化抠图）" : "请先导入工作流") + "。「导入工作流」里有 WavePlug 内置工作流";
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
    if (mode === "outpaint" && !willAdd() && !padTotal()) return "拖动上面画布的边缘，设定要扩展的尺寸";
    if (inpaintLike(mode) && !sel && !willAdd()) return mode === "blend" ? "请先框选要融合的产品和它周围一圈" : mode === "extract" ? "请先框选要抠的东西" : "请先建立选区";
    if (inpaintLike(modeOf(profile)) && !profile.options.allowEmptyPrompt && profile.bindings.some(b => b.role === "prompt") && !text.trim()) return "请输入提示词（留空移除可在「接口校准」里开启）";
    return null;
  }

  /** the generate button's text */
  const actionLabel = () => willAdd() ? "生成更多变体" : mode === "outpaint" ? "扩图" : mode === "upscale" ? "放大" : mode === "blend" ? "融图" : mode === "extract" ? "抠图" : "生成";

  function renderAction() {
    outSync();
    const canSupplement = !!lastCutout && !!doc && doc.id === lastCutout.group.docId && !run;
    exBackgroundBtn.disabled = !canSupplement;
    exBackgroundBtn.title = !lastCutout ? "完成一次抠图后可手动补充原背景"
      : !doc || doc.id !== lastCutout.group.docId ? "上一次抠图不在当前文档中"
      : run ? "当前任务结束后可补充背景"
      : "根据最近一次抠图结果移除原主体并补全背景，结果放在抠图图层下方";
    if (run) {
      genBtn.className = "generate running";
      replace(genBtn, icon("stop"), h("span", null, "取消"));
      genBtn.disabled = false;
      replace(progEl, h("div", { class: "bar" }, h("span", { style: `width:${Math.round((run.progress ?? 0) * 100)}%` })),
        h("div", { class: "stage" }, run.stage + (run.detail ? " · " + run.detail : "")));
      progEl.hidden = false;
      return;
    }
    const needsComfy = conn.state !== "ok";
    const why = needsComfy ? null : blockedReason();
    genBtn.className = "generate";
    genBtn.disabled = launching || !!why;
    genBtn.title = needsComfy ? "启动并连接 ComfyUI" : (why ?? "");
    replace(genBtn, icon(needsComfy ? "play" : "spark"), h("span", null, needsComfy ? "启动 ComfyUI" : actionLabel()));
    progEl.hidden = !why;
    replace(progEl, why ? h("div", { class: "stage muted" }, why,
      conn.state === "down" && svc.launch ? h("button", { class: "link", onClick: () => void launchComfy() }, "  一键启动") : null) : null);
  }

  function renderAdvanced() {
    outSync();
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
      const { int: isInt, lo, hi } = paramRange(b, base);
      const num = h("input", { class: "num", type: "number", value: String(val), step: isInt ? "1" : "0.01" }) as HTMLInputElement;
      const range = h("input", { type: "range", min: String(lo), max: String(hi), step: isInt ? "1" : "0.01", value: String(val) }) as HTMLInputElement;
      const set = (v: number) => { if (!Number.isFinite(v)) return; ps.params[k] = v; num.value = String(v); range.value = String(v); save(); };
      range.addEventListener("input", () => set(Number(range.value)));
      num.addEventListener("change", () => set(Number(num.value)));
      rows.push(h("div", { class: "param" }, h("div", { class: "param-top" }, label,
        k in ps.params && ps.params[k] !== base ? h("button", { class: "link small", title: "恢复工作流中的原始值", onClick: () => { delete ps.params[k]; save(); renderAdvanced(); } }, "复原") : null),
        h("div", { class: "param-ctl" }, range, num)));
    }
    if (loraTargets(p.api).length) rows.push(loraSection(p, ps));
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
    const intentAtStart = modeIntentRevision;
    let switchTo: TaskType | null = null;
    try {
      const previousDocId = doc?.id ?? null;
      doc = svc.host.activeDoc();
      if (previousDocId !== doc?.id) lastCutout = null;
      sel = doc ? await svc.host.selectionBounds(doc.id) : null;
      // a new selection drawn: the generate panel takes the corner (an open settings panel goes);
      // the same selection back after Photoshop's brief "no selection" isn't a new one
      const selKey = sel ? `${doc?.id}:${sel.left},${sel.top},${sel.right},${sel.bottom}` : "";
      if (selKey && selKey !== lastSelKey) { lastSelKey = selKey; closeSetupPanels(); }
      const active = doc ? await svc.host.activeFillGroup() : null;
      group = active;
      variations = group ? await svc.host.variations(group) : [];
      const now = group ? String(group.docId) + ":" + String(group.layerId) : "";
      const firstObservation = !hasObservedFillState;
      const groupChanged = now !== lastGroupKey;
      // Only follow Photoshop's selected AI group when the selection actually changes.
      // Re-reading the same selected AI upscale group must not undo the user's explicit switch
      // back to 局部重绘. On first observation, honor a mode choice made while refresh was pending.
      if (groupChanged && active && active.kind !== mode && !run
        && (!firstObservation || intentAtStart === 0)) switchTo = active.kind;
      if (groupChanged) {
        log("info", "current fill", now || "none", active ? "(selected)" : "");
        lastGroupKey = now;
      }
      hasObservedFillState = true;
    } catch (e) { log("warn", "refresh failed", e); }
    finally { refreshing = false; }
    if (switchTo && modeIntentRevision === intentAtStart) setMode(switchTo, "refresh");
    void loadDocThumb();
    renderHistory(); renderSelection(); renderAction();
    genSurface?.refresh();
    if (again) { again = false; void refresh(); }
  }

  // ── LoRA (高级参数): extra LoRAs inserted into the execution copy, see core/workflow/loras.ts ──
  let loraFiles: string[] | null = null, loraLoading = false, loraError = "";
  async function loadLoraFiles() {
    if (loraLoading) return;
    loraLoading = true; loraError = "";
    try { loraFiles = await comfy.loraNames(); log("info", "lora files", loraFiles.length); }
    catch (e) { loraError = "读取 LoRA 列表失败：" + (e as Error).message; log("warn", "lora files", e); }
    finally { loraLoading = false; renderAdvanced(); }
  }
  function loraSection(p: Profile, ps: ProfileState): HTMLElement {
    const slots = ps.loras ??= [];
    const save = () => store.saveState(p.id, ps);
    if (loraFiles === null && !loraLoading && !loraError) void loadLoraFiles();
    const files = loraFiles ?? [];
    const rows: HTMLElement[] = [];
    slots.forEach((s, i) => {
      const sel = h("select", { class: "field", title: s.name || "选择 LoRA 文件", disabled: !s.on },
        h("option", { value: "" }, files.length ? "选择 LoRA…" : loraLoading ? "读取中…" : "（ComfyUI 里没有 LoRA）"),
        ...(s.name && !files.includes(s.name) ? [h("option", { value: s.name }, loraLabel(s.name) + "（未找到）")] : []),
        ...files.map(f => h("option", { value: f }, f.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "")))) as HTMLSelectElement;
      sel.value = s.name;
      sel.addEventListener("change", () => { s.name = sel.value; sel.title = s.name; save(); });
      const on = h("input", { type: "checkbox", checked: s.on, title: "开启 / 关闭这个 LoRA（关闭后不会加进工作流）",
        onChange: (e: Event) => { s.on = (e.target as HTMLInputElement).checked; save(); renderAdvanced(); } });
      const num = h("input", { class: "num", type: "number", value: String(s.strength), step: "0.05", min: String(LORA_MIN), max: String(LORA_MAX), disabled: !s.on }) as HTMLInputElement;
      const range = h("input", { type: "range", min: String(LORA_MIN), max: String(LORA_MAX), step: "0.05", value: String(s.strength), disabled: !s.on }) as HTMLInputElement;
      const set = (v: number) => { if (!Number.isFinite(v)) return; v = Math.max(LORA_MIN, Math.min(LORA_MAX, Math.round(v * 100) / 100)); s.strength = v; num.value = String(v); range.value = String(v); save(); };
      range.addEventListener("input", () => set(Number(range.value)));
      num.addEventListener("change", () => set(Number(num.value)));
      rows.push(h("div", { class: "param lora" + (s.on ? "" : " off") },
        h("div", { class: "param-top lora-top" }, on, sel,
          h("button", { class: "icon-btn sm", title: "移除这个 LoRA", onClick: () => { slots.splice(i, 1); save(); renderAdvanced(); } }, icon("close"))),
        h("div", { class: "param-ctl" }, range, num)));
    });
    const head = h("div", { class: "param-top" },
      h("span", { class: "param-label", title: "额外的 LoRA 只加进本次提交给 ComfyUI 的副本：接在模型加载节点后面，工作流里原有的 LoRA 照常生效。不修改 ComfyUI 中的工作流" }, "LoRA"),
      h("span", { class: "lora-actions" },
        h("button", { class: "icon-btn sm", title: "重新读取 ComfyUI 的 LoRA 列表（放进 models/loras 的新文件）", onClick: () => { loraFiles = null; loraError = ""; void loadLoraFiles(); } }, icon("refresh")),
        h("button", { class: "icon-btn sm", title: slots.length >= MAX_LORAS ? `最多 ${MAX_LORAS} 个` : "添加一个 LoRA", disabled: slots.length >= MAX_LORAS,
          onClick: () => { slots.push({ name: "", strength: 1, on: true } satisfies LoraSlot); save(); renderAdvanced(); } }, icon("plus"))));
    return h("div", { class: "lora-group" }, head, ...rows,
      loraError ? h("div", { class: "muted small" }, loraError) : !slots.length ? h("div", { class: "muted small" }, "点 + 添加 LoRA，最多 " + MAX_LORAS + " 个") : null);
  }

  /** 高级参数 as the external panel lists them (same order and rules as renderAdvanced) */
  function panelParams(): PanelParam[] {
    if (!profile || !pstate) return [];
    const p = profile, ps = pstate, out: PanelParam[] = [];
    for (const b of p.bindings.filter(x => x.role === "param")) {
      const key = b.nodeId + "." + b.input, base = p.api[b.nodeId]?.inputs[b.input];
      const val = key in ps.params ? ps.params[key] : defaultParam(b, base);
      const label = b.label ?? b.input;
      if (typeof base === "boolean") { out.push({ kind: "toggle", key, label, value: !!val, tip: "" }); continue; }
      const { int, lo, hi } = paramRange(b, base);
      out.push({ kind: "number", key, label, value: Number(val), base: Number(base), min: lo, max: hi, int });
    }
    if (loraTargets(p.api).length) (ps.loras ?? []).forEach((s, i) => {
      if (!s.name) return;
      out.push({ kind: "toggle", key: `lora:${i}:on`, label: "LoRA · " + loraLabel(s.name), value: s.on, tip: "开启 / 关闭这个 LoRA" });
      if (s.on) out.push({ kind: "number", key: `lora:${i}`, label: "LoRA 强度 · " + loraLabel(s.name), value: s.strength, base: 1, min: LORA_MIN, max: LORA_MAX, int: false });
    });
    if (p.bindings.some(b => b.role === "seed")) out.push({ kind: "seed", random: ps.seedMode === "random", value: ps.seed });
    if (p.options.localMask?.links.length) out.push({ kind: "toggle", key: "localMask", label: "只重绘选区内", value: p.options.localMask.enabled, tip: "把遮罩接到工作流，让模型只在选区内生成" });
    if (modeOf(p) === "blend" || modeOf(p) === "extract") out.push({ kind: "toggle", key: "keepDetail", label: "保留原图细节", value: ps.keepDetail !== false, tip: "纹理和文字等细节用原图" });
    out.push({ kind: "toggle", key: "fullRun", label: "每次完整运行（不使用 ComfyUI 缓存，较慢）", value: !!ps.fullRun, tip: "" });
    return out;
  }

  /** a parameter changed from the external panel: save it and redraw 高级参数 here too */
  function setParam(change: (p: Profile, ps: ProfileState) => void) {
    if (!profile || !pstate) return;
    change(profile, pstate);
    store.saveState(profile.id, pstate);
    renderAdvanced();
  }

  /** Reconcile existing ComfyUI even when auto-start is disabled; manual launch overrides it. */
  function syncComfyManager(startIfMissing: boolean, restartIfNeeded = false, restart = false) {
    overlay?.manageComfy({
      path: settings.comfyLaunch,
      base: settings.comfyUrl,
      closeWithPhotoshop: settings.comfyCloseWithPhotoshop !== false,
      restartIfNeeded,
      disableBrowser: settings.comfyNoBrowser !== false,
      startIfMissing,
      restart,
    });
  }

  /** 性能监视: the meters at the right of the helper's status bar (canvas bottom), as the setting says. */
  function syncMonitor() {
    overlay?.setMonitor(settings.perfMonitor !== false, settings.comfyUrl);
  }

  /** 卡死保护: the switch and the open documents (names and paths, for where backups go). */
  let hangSyncing = false;
  async function syncHangGuard() {
    if (!overlay || hangSyncing) return;
    hangSyncing = true;
    try {
      const docs = settings.hangGuard !== false ? hangDocs(await svc.layers.openDocs()) : [];
      overlay.setHangGuard(settings.hangGuard !== false, settings.hangAutoBackup !== false, docs);
    } catch (e) { log("warn", "hang guard docs", e); }
    finally { hangSyncing = false; }
  }

  /** The external panel while the plugin is in a mode it has no tab for (扩图 / 放大): it keeps
   *  showing its own mode, with that mode's saved prompt and count, and says that acting here
   *  switches the plugin back (generateSurface.ts does the switch before any action). */
  function standbyPanelSections(shown: PanelMode): GenerateSections {
    const p = pickFor(shown), ps = p ? store.state(p.id) : null;
    const label = (m: string) => MODES.find(([k]) => k === m)?.[1] ?? m;
    return {
      mode: shown,
      prompt: ps?.prompt ?? "",
      hint: "描述要生成的内容",
      favorites: [...(favorites[shown] ?? [])],
      refs: [],
      count: normalizeVariationCount(ps?.count),
      action: shown === "blend" ? "融图" : shown === "extract" ? "抠图" : "生成",
      blocked: run ? null : p ? null : `请先在插件面板里导入${label(shown)}工作流`,
      params: [],
      run: run ? { stage: run.stage + (run.detail ? " · " + run.detail : ""), progress: run.progress ?? 0 } : null,
      status: { tone: status.kind, text: status.text },
      note: run ? `插件正在「${label(mode)}」` : `插件面板现在是「${label(mode)}」；在这里操作会切回「${label(shown)}」`,
    };
  }

  /** The canvas moves on screen without any event the plugin hears (a docked panel beside it
   *  widened or folded, the window resized): look at Photoshop's view bounds a few times a
   *  second — one cheap read — and when they changed, tell the helper the new canvas so every
   *  external window follows at once (native/overlay/src/layout.rs). The first reading of each
   *  document is sent too, and "no document" (null): the status bar sits on the canvas whether or
   *  not any panel is up, so it can't wait for a panel's show to learn where the canvas is. */
  function watchCanvas() {
    let busy = false, last = "";
    // a helper that (re)connects knows no canvas yet
    overlay?.onConnected(() => { last = ""; });
    every(async () => {
      if (busy || !overlay?.connected || !svc.host.viewBounds || !svc.host.canvasView) return;
      if (!doc) {
        if (last !== "none") { last = "none"; overlay.canvasMoved(null); log("info", "canvas: no document"); }
        return;
      }
      busy = true;
      try {
        const id = doc.id;
        const bounds = await svc.host.viewBounds(id);
        const key = bounds ? `${id}:${bounds}` : "";
        if (!key || key === last) return;
        last = key;
        const v = await svc.host.canvasView(id);
        if (v) { overlay.canvasMoved(v.view); log("info", "canvas moved", JSON.stringify(v.view)); }
      } catch { /* Photoshop busy (a modal step): next time */ }
      finally { busy = false; }
    }, 200);
  }

  /** Ctrl+F in Photoshop (taken from Photoshop by the helper, so its 上次滤镜 doesn't run):
   *  Photoshop's 原位粘贴 into the active document, above the selected layer */
  let pasting = false;
  async function pasteInPlace() {
    if (pasting) return;
    const active = svc.host.activeDoc();
    if (!active) { setStatus("原位粘贴（Ctrl+F）：没有打开的文档", "error"); return; }
    pasting = true;
    try {
      await svc.layers.run(active.id, "pasteInPlace", []);
      log("info", "paste in place", active.id);
    } catch (e) {
      log("warn", "paste in place", e);
      setStatus("原位粘贴（Ctrl+F）失败：" + ((e as Error)?.message ?? e), "error");
    } finally { pasting = false; }
  }

  function startOverlay() {
    overlay = connectOverlay({
      launch: svc.launchOverlay,
      autoLaunch: () => settings.helperAutoStart !== false,
      onAutoLaunchFailed: error => {
        conn = { state: "down", text: "未连接" };
        renderConn(); renderAction();
        setStatus("WavePlug 外置框架没有随 Photoshop 启动：" + error + "。点右上角的连接状态可以重新启动它", "error");
      },
    });
    svc.overlay = overlay;
    if (svc.bridgePs) attachIllustratorBridge(overlay, svc.bridgePs, svc.host, (text, kind) => setStatus(text, kind));
    syncMonitor();
    void syncHangGuard();
    watchCanvas();
    overlay.onConnected(() => {
      syncComfyManager(settings.comfyAutoStartWithPhotoshop !== false);
      // the program restarted into its new version while updating (a source update compiles it
      // midway, so the old copy can't say it finished): the update is done
      if (updating) {
        const dev = update?.dev;
        updating = false; updateOk = true; update = null; updateText = "已更新：WavePlug 程序已重启成新版本";
        if (!dev) setTimeout(reloadWhenIdle, 1500);
        setTimeout(() => { if (!updating && updateOk) { updateText = ""; renderUpdate(); } }, 8000);
        renderUpdate();
      }
    });
    overlay.onUpdate(u => {
      if (u.type === "update-available") {
        if (!updating) { update = { version: u.version, notes: u.notes, dev: u.dev }; updateText = ""; updateOk = null; }
      } else {
        updateText = u.text;
        if (u.done) {
          updating = false; updateOk = u.ok;
          if (u.ok) {
            const dev = update?.dev;
            update = null;
            // a release: its code is in the update folder now; a source update reloads by itself
            if (!dev) setTimeout(reloadWhenIdle, 1500);
            setTimeout(() => { if (!updating && updateOk) { updateText = ""; renderUpdate(); } }, 8000);
          }
        }
      }
      renderUpdate();
    });
    overlay.onPasteInPlace(() => void pasteInPlace());
    // the WavePlug app window's 功能设置: the same settings, shown and edited there
    // 从开发文件夹加载代码 only where it applies (someone who ran from the development folder)
    const devLoadShown = () => !!svc.loadFrom && (svc.loadFrom.source === "dev" || (() => { try { return localStorage.getItem("wp.loadFrom") === "bundled"; } catch { return false; } })());
    const shareAppSettings = () => overlay?.sendAppSettings({
      ...appSettingsOf(settings as unknown as Record<string, unknown>),
      ...(devLoadShown() ? { devLoad: svc.loadFrom!.source === "dev" } : {}),
    });
    shareAppSettings();
    every(shareAppSettings, 2000);
    overlay.onAppSettingsSet(changes => {
      if (typeof changes.devLoad === "boolean") {
        const to = changes.devLoad ? "dev" : "bundled";
        delete changes.devLoad;
        if (svc.loadFrom && svc.loadFrom.source !== to) { svc.loadFrom.set(to); return; }
      }
      const keys = Object.keys(changes);
      if (!keys.length) return;
      if (typeof changes.comfyUrl === "string") changes.comfyUrl = normalizeUrl(changes.comfyUrl);
      Object.assign(settings, changes);
      store.saveSettings(settings);
      log("info", "settings from the WavePlug app", JSON.stringify(redactSettings(changes)));
      if (keys.includes("perfMonitor") || keys.includes("comfyUrl")) syncMonitor();
      if (keys.includes("hangGuard") || keys.includes("hangAutoBackup")) void syncHangGuard();
      if (keys.includes("comfyUrl")) { comfy = svc.comfy(settings.comfyUrl); void checkConn(); }
      if (keys.some(k => k.startsWith("comfy"))) syncComfyManager(settings.comfyAutoStartWithPhotoshop !== false);
      shareAppSettings();
      setStatus("已按 WavePlug 程序里的修改更新设置", "info");
    });
    // 导出诊断信息 in the app window: this panel's part (environment, every problem, recent log)
    overlay.onPluginReport(folder => {
      void svc.writeTextAt?.(folder.replace(/[\\/]+$/, "") + "\\Photoshop插件诊断报告.txt", diagnosticReport())
        .then(ok => log(ok ? "info" : "warn", "plugin report for the app", folder, ok));
    });
    overlay.onComfyStatus(status => {
      if (status.state === "starting") {
        conn = { state: "checking", text: "ComfyUI 启动中…" };
        renderConn();
        setStatus(status.message, "info");
      } else if (status.state === "not-configured" || status.state === "path-missing"
        || status.state === "failed" || status.state === "timeout") {
        conn = { state: "down", text: "未连接" };
        renderConn(); renderAction();
        setStatus(status.message, "error");
      } else if (status.state === "autostart-disabled") {
        conn = { state: "down", text: "未连接" };
        renderConn(); renderAction();
        setStatus(status.message, "info");
      } else if (status.state === "restart-required" || status.state === "external-running") {
        void checkConn();
        setStatus(status.message, "info");
      } else {
        // Existing local instance, newly started instance, or a remote endpoint: let the
        // normal Comfy client make the final connection check and populate its version.
        void checkConn();
      }
    });
    genSurface = attachGenerateSurface(overlay, {
      sections: () => {
        const shown = shownPanelMode(mode, settings.panelMode);
        if (shown !== mode) return standbyPanelSections(shown);
        return {
        mode: shown,
        prompt: prompt.value,
        hint: promptHint.textContent ?? "",
        favorites: [...(favorites[favKey()] ?? [])],
        refs: refSlotNumbers().map(slot => ({
          slot,
          tag: refs[slot] ? refTag(slot) : null,
          name: refs[slot]?.name ?? null,
          thumb: refs[slot]?.thumb ?? null,
        })),
        count: normalizeVariationCount(countInput.value),
        action: actionLabel(),
        blocked: run ? null : blockedReason(),
        params: panelParams(),
        run: run ? { stage: run.stage + (run.detail ? " · " + run.detail : ""), progress: run.progress ?? 0 } : null,
        status: { tone: status.kind, text: status.text },
        note: null,
        ai: isPromptMode(shown) ? { busy: optBusy, blocked: optBusy ? null : optBlocked(), undo: canRestore() && !optBusy } : null,
        };
      },
      where: () => ({ docId: doc?.id ?? null, sel }),
      pluginMode: () => mode,
      panelMode: () => shownPanelMode(mode, settings.panelMode),
      canvasView: id => svc.host.canvasView?.(id) ?? Promise.resolve(null),
      setMode: m => { if (isPanelMode(m)) setMode(m); },
      setPrompt: text => setPromptText(text),
      setCount: n => { countInput.value = String(n); saveCount(n); renderAction(); },
      setNumber: (key, value) => setParam((_, ps) => { const l = loraSlotOf(ps, key); if (l) l.strength = Math.max(LORA_MIN, Math.min(LORA_MAX, value)); else ps.params[key] = value; }),
      resetNumber: key => setParam((_, ps) => { const l = loraSlotOf(ps, key); if (l) l.strength = 1; else delete ps.params[key]; }),
      setToggle: (key, value) => {
        if (key === "localMask") { if (profile?.options.localMask) { profile.options.localMask.enabled = value; store.saveProfiles(profiles); renderAdvanced(); } return; }
        setParam((_, ps) => { if (key === "keepDetail") ps.keepDetail = value; else if (key === "fullRun") ps.fullRun = value; else if (loraSlotOf(ps, key)) loraSlotOf(ps, key)!.on = value; else ps.params[key] = value; });
      },
      setSeed: (random, value) => setParam((_, ps) => { ps.seedMode = random ? "random" : "fixed"; ps.seed = Math.max(0, Math.min(MAX_SEED, Math.floor(value))); }),
      newSeed: () => setParam((_, ps) => { ps.seed = randomSeed(); ps.seedMode = "fixed"; }),
      generate: () => { if (!run) void generate(); },
      cancel: () => { if (run) void cancel(); },
      // the same handlers as this page's ☆ 收藏 and 收藏夹 entries
      toggleFavorite: () => favStar.click(),
      optimizePrompt: () => void optimizePrompt(),
      restorePrompt: () => restorePrompt(),
      pickFavorite: text => setPromptText(text),
      removeFavorite: text => { favorites[favKey()] = (favorites[favKey()] ?? []).filter(x => x !== text); store.saveFavorites(favorites); renderFav(); },
      addRef: (slot, source) => { void addReferenceFromSurface(slot, source); },
      addLayerReference: (slot, docId, layerId, name) => { void addLayerReference(slot, docId, layerId, name); },
      addLayerReferences: (slot, docId, layers, totalCount) => { void addLayerReferences(slot, docId, layers, totalCount); },
      finishLayerDrag: () => document.dispatchEvent(new Event("waveplug:external-layer-drag-finished")),
      removeRef: slot => removeRef(slot),
    });
    variantSurface = attachVariantsSurface(overlay, {
      sections: () => group && variations.length
        ? {
            docId: group.docId, groupId: group.layerId, name: group.name,
            items: variations.map(v => ({
              layerId: v.layerId, number: v.number, visible: v.visible,
              thumb: thumbs.get(`${group!.docId}:${v.layerId}`) || null,
            })),
          }
        : null,
      canvasView: id => svc.host.canvasView?.(id) ?? Promise.resolve(null),
      showVariant: (layerId, groupId) => {
        if (!group || group.layerId !== groupId || run) return;
        const selected = variations.find(v => v.layerId === layerId);
        if (selected && !selected.visible) void showVariation(selected);
      },
      deleteVariant: (layerId, groupId) => {
        if (!group || group.layerId !== groupId || run) return;
        const v = variations.find(x => x.layerId === layerId);
        if (v) void deleteVariation(v);
      },
    });
    variantSurface.refresh();
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

  function setMode(m: TaskType, source: "user" | "refresh" = "user") {
    if (run) return;
    // Even clicking the already-active mode is an explicit choice that can dismiss a pending
    // automatic switch from the first Photoshop state read.
    if (source === "user") modeIntentRevision++;
    if (m === mode) return;
    const previous = mode;
    mode = m; settings.mode = m;
    if (isPanelMode(m)) settings.panelMode = m;
    store.saveSettings(settings);
    log("info", "generate mode changed", JSON.stringify({ from: previous, to: m, source, selectedGroup: lastGroupKey }));
    profile = pickFor(m);
    pstate = profile ? store.state(profile.id) : null;
    for (const k of Object.keys(refs)) delete refs[Number(k)];
    renderAll();
    void loadDocThumb();
    if (profile && conn.state === "ok") void quietSync(profile);
  }

  /** 删除 from the variant rail: one Photoshop history step; the shown one gone, the last left
   *  takes its place (uxpHost deleteVariation). The AI layer keeps at least one variation. */
  let deletingVariation = false;
  async function deleteVariation(v: Variation) {
    if (!group || run || deletingVariation) return;
    if (variations.length <= 1) { setStatus("这是最后一个变体；要去掉整个 AI 图层，请在图层面板里删除", "info"); return; }
    const g = group;
    deletingVariation = true;
    try {
      await svc.host.deleteVariation(g, v.layerId);
      thumbs.delete(g.docId + ":" + v.layerId);
      if (group?.docId === g.docId && group.layerId === g.layerId) variations = await svc.host.variations(g);
      log("info", "variation deleted from the rail", g.layerId, v.layerId, `v${v.number}`);
      setStatus(`已删除变体 v${v.number}`, "ok");
      renderHistory();
    } catch (e) {
      setStatus("删除变体失败：" + (e as Error).message, "error");
    } finally { deletingVariation = false; }
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

  // ── connection ──
  /** Returns null on success, else the raw error text (also logged). */
  async function checkConn(): Promise<string | null> {
    const checkId = ++connectionCheckSeq;
    conn = { state: "checking", text: "连接中…" }; renderConn();
    let error: string | null = null;
    try {
      const s = await withTimeout(comfy.systemStats(), 6000, "连接 ComfyUI ");
      if (checkId !== connectionCheckSeq) return conn.state === "ok" ? null : "连接状态已更新，正在重新检查";
      conn = { state: "ok", text: "ComfyUI " + (s.system?.comfyui_version ?? "") };
      log("info", "connected", comfy.base, s.system?.comfyui_version);
      // A cold-start probe can fail before the native manager has finished launching ComfyUI.
      // Clear only that exact stale connection error; never erase an unrelated generation error.
      if (lastConnectionError && status.kind === "error" && status.text === lastConnectionError) {
        setStatus("ComfyUI 已连接", "ok");
      }
      lastConnectionError = null;
    } catch (e) {
      if (checkId !== connectionCheckSeq) return conn.state === "ok" ? null : "连接状态已更新，正在重新检查";
      const err = e as Error;
      error = `${err.name && err.name !== "Error" ? err.name + "：" : ""}${err.message}`;
      conn = { state: "down", text: "未连接" };
      lastConnectionError = error;
      log("error", "connect failed", comfy.base, err);
      setStatus(error, "error");
    }
    renderConn(); renderAction();
    if (!error && profile) void quietSync(profile);
    return error;
  }

  let launching = false;
  /** Ask the native helper to start ComfyUI under the selected lifetime/terminal policy
   *  (`restart`: the one it started is stopped first). Starts the helper first when needed. */
  async function launchComfy(report: (kind: "ok" | "error" | "info", text: string) => void = (k, t) => setStatus(t, k), restart = false) {
    if (launching) return;
    // no launcher chosen: the helper uses the ComfyUI pack in WavePlug's install folder (comfyui\),
    // and says so when there is none
    if (!overlay?.connected) {
      report("info", "正在启动 WavePlug 外置框架…");
      const error = await overlay?.launchHelper();
      if (error !== null) { report("error", "外置框架没有启动：" + (error ?? "未知原因")); return; }
    }
    launching = true;
    renderAction();
    try {
      log("info", "request managed ComfyUI start", settings.comfyLaunch, settings.comfyCloseWithPhotoshop, restart ? "restart" : "");
      syncComfyManager(true, true, restart);
      // a restart first stops the old one: don't take it for the new one
      if (restart) {
        report("info", "正在停止当前的 ComfyUI…");
        const t1 = Date.now();
        while (Date.now() - t1 < 15_000) {
          const up = await withTimeout(comfy.systemStats(), 1500, "连接").then(() => true, () => false);
          if (!up) break;
          await new Promise(r => setTimeout(r, 500));
        }
      }
      const t0 = Date.now();
      conn = { state: "checking", text: "启动中…" }; renderConn();
      while (Date.now() - t0 < 180_000) {
        report("info", `正在启动 ComfyUI… ${Math.round((Date.now() - t0) / 1000)} 秒`);
        await new Promise(r => setTimeout(r, 2500));
        try {
          const s = await withTimeout(comfy.systemStats(), 2200, "连接");
          conn = { state: "ok", text: "ComfyUI " + (s.system?.comfyui_version ?? "") }; renderConn(); renderAction();
          report("ok", "ComfyUI 已就绪并连接");
          setStatus("ComfyUI 已就绪并连接", "ok");
          return;
        } catch { /* helper is still starting the server */ }
      }
      conn = { state: "down", text: "未连接" }; renderConn(); renderAction();
      report("error", "3 分钟内没有连上 ComfyUI，请检查启动脚本和 reports/comfy_runtime.log");
    } finally { launching = false; renderAction(); }
  }

  /** 设置 lives in the WavePlug program's window (功能设置: ComfyUI, 启动与关闭, 性能监视, 卡死保护,
   *  排查问题, 开发者); the panel only opens it, starting the program first when needed. */
  async function openAppSettings() {
    if (!overlay || !svc.launch) { setStatus("这个环境没有 WavePlug 程序，设置在 WavePlug 程序里", "error"); return; }
    if (!overlay.connected) {
      setStatus("正在启动 WavePlug 程序…", "info");
      const error = await overlay.launchHelper();
      if (error !== null) { setStatus("WavePlug 程序没有启动：" + (error ?? "未知原因"), "error"); return; }
    }
    if (overlay.openApp("settings")) setStatus("设置已在 WavePlug 程序里打开", "info");
    else setStatus(`WavePlug 程序 ${overlay.helperVersion ?? ""} 太旧，打不开设置：请更新 WavePlug（需要 ${OPEN_APP_HELPER_VERSION}）`, "error");
  }

  // ── workflows ──
  function selectProfile(id: string) {
    // Selecting a workflow is an explicit user choice even when its task type is unchanged.
    modeIntentRevision++;
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
              (modeOf(p) === "outpaint" ? "扩图 · " : modeOf(p) === "txt2img" ? "文生图 · " : modeOf(p) === "upscale" ? "放大 · " : modeOf(p) === "blend" ? "融图 · " : modeOf(p) === "extract" ? "抠图 · " : "局部重绘 · ") + (p.source?.kind === "comfy" ? "ComfyUI 已保存的工作流" : p.source?.kind === "builtin" ? "WavePlug 内置" : "JSON 文件") + (bad ? " · 需要校准" : ""))));
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
        h("button", { class: "menu-item", onClick: () => { menu.remove(); addBuiltins(); } },
          icon("flow"), h("span", null, h("b", null, "WavePlug 内置工作流"), h("span", { class: "muted small block" }, "局部重绘、扩图、文生图、放大、融图、抠图，已绑定好，配合 WavePlug 的 ComfyUI 包"))),
        h("button", { class: "menu-item", onClick: async () => { menu.remove(); await importFromFile(); } },
          icon("folder"), h("span", null, h("b", null, "工作流 JSON 文件"), h("span", { class: "muted small block" }, "ComfyUI 保存的工作流或「导出 (API)」都可以；前者需要已连接 ComfyUI"))),
        h("button", { class: "menu-item", onClick: async () => { menu.remove(); await importFromComfy(); } },
          icon("flow"), h("span", null, h("b", null, "ComfyUI 中已保存的工作流"), h("span", { class: "muted small block" }, "需要已连接 ComfyUI，自动转换为 API 格式")))));
    sheetHost.append(menu);
  }

  /** WavePlug 内置工作流: the ones not there yet (by id); each mode gets its built-in if it has none */
  function addBuiltins() {
    const add = missingBuiltins(profiles);
    if (!add.length) { setStatus("内置工作流都已经在列表里了", "info"); return; }
    profiles.push(...add);
    store.saveProfiles(profiles);
    selectProfile((add.find(p => modeOf(p) === mode) ?? add[0]).id);
    setStatus(`已添加 ${add.length} 个内置工作流：${add.map(p => p.name).join("、")}`, "ok");
  }

  async function importFromFile() {
    try {
      const f = await svc.pickJson();
      if (!f) return;
      const json = JSON.parse(f.text.replace(/^\uFEFF/, ""));
      const name = f.name.replace(/\.json$/i, "");
      // ComfyUI's own saved format (nodes + links): converted like a workflow read from ComfyUI,
      // which needs ComfyUI's node list
      if (json && Array.isArray(json.nodes) && Array.isArray(json.links)) {
        setStatus("转换为 API 格式（需要 ComfyUI 的节点信息）…");
        const info = await comfy.objectInfo().catch(() => { throw new Error("这是 ComfyUI 保存的工作流，转换需要先连上 ComfyUI（或者在 ComfyUI 里用「导出 (API)」保存后再导入）"); });
        const { api, warnings } = uiToApi(json, info);
        if (warnings.length) log("warn", "conversion", warnings);
        await adopt(name, api, warnings);
        return;
      }
      await adopt(name, asApiGraph(json), []);
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
    // the workflow's own prompt optimiser goes: WavePlug optimises with DeepSeek (AI 优化) instead
    const stripped = stripOptimizer(api, []);
    if (stripped) { api = stripped.api as typeof api; warnings = [...warnings, "已去掉工作流里的提示词优化节点：提示词用面板上的「AI 优化」（DeepSeek）优化"]; }
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
  /** empties a slot; the later references move up one */
  function removeRef(slot: number) {
    if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再调整槽位", "info"); return; }
    for (let s2 = slot; s2 < MAX_REFERENCES; s2++) refs[s2] = refs[s2 + 1];
    refs[MAX_REFERENCES] = undefined;
    renderRefs();
  }
  /** Reference picker: clipboard, image file, or any layer of the document (with previews). */
  function refMenu(slot: number, _anchor?: HTMLElement) {
    if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再调整槽位", "info"); return; }
    const auto = autoRefs();
    const tag = auto ? `图${slot + 1}` : `参考 ${slot}`;
    const set = (r: RefSlot) => {
      if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再调整槽位", "info"); return; }
      refs[slot] = r; sheet.remove(); renderRefs();
    };
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
        h("button", { class: "btn", onClick: () => { sheet.remove(); removeRef(slot); } }, "移除这张参考图")) : null);
    sheetHost.append(sheet);
    // thumbnails one by one so a long layer list stays responsive
    void (async () => { for (const row of Array.from(list.children)) { if (!sheet.parentNode) break; await (row as any)._load?.(); } })();
  }

  /** Adds a Photoshop layer as a reference. The source document and layer are revalidated at drop time. */
  async function addLayerReference(slot: number, sourceDocId: number, layerId: number, _dragName = "") {
    if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再试", "info"); return; }
    if (!refSlotNumbers().includes(slot)) {
      setStatus("当前工作流没有这个参考图插槽", "error");
      return;
    }
    if (run) {
      setStatus("生成过程中不能替换参考图", "info");
      return;
    }
    if (!svc.host.docExists(sourceDocId)) {
      setStatus("来源 PSD 已关闭，无法读取这个图层", "error");
      return;
    }
    const layer = svc.host.listLayers(sourceDocId).find(l => l.id === layerId);
    // folders and AI layers are read as one merged image of what they show (uxpHost.readGroupImage)
    if (!layer || (_dragName && layer.name !== _dragName)) {
      setStatus("图层已变化，无法拖入参考图", "error");
      return;
    }
    try {
      const thumb = await svc.host.layerThumbnail(sourceDocId, layerId, 128);
      if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再试", "info"); return; }
      refs[slot] = { kind: "layer", docId: sourceDocId, layerId, name: layer.name, thumb };
      renderRefs();
      log("info", "reference layer dropped", JSON.stringify({ slot, docId: sourceDocId, layerId, name: layer.name }));
      setStatus(`已将图层「${layer.name}」放入参考图 ${slot}`, "ok");
    } catch (e) {
      log("warn", "reference layer drop failed", sourceDocId, layerId, e);
      setStatus("读取拖入图层失败：" + (e as Error).message, "error");
    }
  }

  /** Adds a multi-selection from one WaveLayer drop, filling empty slots in layer order. */
  async function addLayerReferences(startSlot: number, sourceDocId: number, candidates: LayerReferenceCandidate[], totalCount: number) {
    if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再拖入", "info"); return; }
    const capacity = refSlotCapacity();
    if (!capacity.includes(startSlot)) {
      setStatus("当前工作流没有这个参考图插槽", "error");
      return;
    }
    if (run) {
      setStatus("生成过程中不能添加参考图", "info");
      return;
    }
    if (!svc.host.docExists(sourceDocId)) {
      setStatus("来源 PSD 已关闭，无法读取这些图层", "error");
      return;
    }
    layerReferenceDropInProgress = true;
    try {
    const current = svc.host.listLayers(sourceDocId);
    const byId = new Map(current.map(layer => [layer.id, layer]));
    const unique = [...new Map(candidates.map(layer => [layer.layerId, layer])).values()];
    const valid = unique.filter(candidate => {
      const layer = byId.get(candidate.layerId);
      // folders and AI layers too: read as one merged image (uxpHost.readGroupImage)
      return !!layer && layer.name === candidate.name;
    });
    const plan = planLayerReferenceDrop(
      startSlot,
      valid,
      Math.max(totalCount, candidates.length),
      capacity,
      capacity.filter(slot => !!refs[slot]),
    );
    if (!plan.assignments.length) {
      setStatus(`从参考图 ${startSlot} 开始没有空槽位；已有参考图不会被覆盖`, "error");
      return;
    }

    let added = 0;
    for (const item of plan.assignments) {
      const layer = byId.get(item.layer.layerId);
      if (!layer) continue;
      try {
        const thumb = await svc.host.layerThumbnail(sourceDocId, layer.id, 128);
        refs[item.slot] = { kind: "layer", docId: sourceDocId, layerId: layer.id, name: layer.name, thumb };
        added++;
        log("info", "reference layer batch dropped", JSON.stringify({ slot: item.slot, docId: sourceDocId, layerId: layer.id, name: layer.name }));
      } catch (e) {
        log("warn", "reference layer batch item failed", item.slot, sourceDocId, layer.id, e);
      }
    }
    renderRefs();
    const notPlaced = Math.max(0, Math.max(totalCount, candidates.length) - added);
    if (!added) setStatus("读取拖入图层失败，没有添加参考图", "error");
    else if (notPlaced) setStatus(`已放入 ${added} 张参考图；${notPlaced} 张未放入（最多 6 张或空位不足）`, "info");
    else setStatus(`已将 ${added} 个图层依次放入参考图`, "ok");
    } finally {
      layerReferenceDropInProgress = false;
    }
  }

  /** The native surface uses the same Photoshop/file/clipboard sources as the UXP picker. */
  async function addReferenceFromSurface(slot: number, source: "layer" | "file" | "clipboard") {
    if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再试", "info"); return; }
    if (!refSlotNumbers().includes(slot)) {
      setStatus("当前工作流没有这个参考图插槽", "error");
      return;
    }
    if (source === "clipboard") {
      await pasteReference(slot);
      return;
    }
    if (source === "file") {
      try {
        const file = await svc.pickImage();
        if (!file) return;
        if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再调整槽位", "info"); return; }
        refs[slot] = { kind: "file", name: file.name, bytes: file.bytes, thumb: file.url };
        renderRefs();
        setStatus(`已添加参考图：${file.name}`, "ok");
      } catch (e) {
        log("warn", "overlay reference file", e);
        setStatus("选择参考图失败：" + (e as Error).message, "error");
      }
      return;
    }
    if (!doc) {
      setStatus("请先打开 Photoshop 文档并选中要用作参考的图层", "error");
      return;
    }
    const layer = svc.host.activeLayer(doc.id);
    if (!layer || layer.kind === "group"
      || [FILL_PREFIX, BLEND_PREFIX, EXTRACT_PREFIX, EXPAND_PREFIX, GENERATE_PREFIX, UPSCALE_PREFIX].some(prefix => layer.name.startsWith(prefix))) {
      setStatus("请先在 Photoshop 图层面板选中一个普通图层", "error");
      return;
    }
    try {
      const thumb = await svc.host.layerThumbnail(doc.id, layer.id, 128);
      if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再试", "info"); return; }
      refs[slot] = { kind: "layer", docId: doc.id, layerId: layer.id, name: layer.name, thumb };
      renderRefs();
      setStatus(`已添加当前图层为参考图：${layer.name}`, "ok");
    } catch (e) {
      log("warn", "overlay reference layer", layer.id, e);
      setStatus("读取当前图层失败：" + (e as Error).message, "error");
    }
  }

  /** Clipboard → reference slot (button in the picker, or Ctrl+V on the panel). */
  async function pasteReference(slot?: number) {
    if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再粘贴", "info"); return; }
    const slots = refSlotNumbers();
    if (!slots.length) { setStatus("当前工作流不支持参考图", "error"); return; }
    const target = slot ?? (slots.find(s => !refs[s]) ?? slots[slots.length - 1]);
    setStatus("读取剪贴板…");
    try {
      const px = await svc.host.clipboardImage(1536);
      if (!px) { setStatus("剪贴板里没有图片", "error"); return; }
      const flat = onWhite(px);
      const bytes = encodePng(flat);
      // the slot shows a 128 px copy, not the uploaded picture as base64
      const k = Math.min(1, 128 / Math.max(px.width, px.height));
      const small = downscale(flat, Math.max(1, Math.round(px.width * k)), Math.max(1, Math.round(px.height * k)));
      if (layerReferenceDropInProgress) { setStatus("正在批量添加参考图，请稍后再粘贴", "info"); return; }
      refs[target] = { kind: "file", name: "剪贴板.png", bytes, thumb: bytesToDataUrl(encodePng(small), "image/png") };
      renderRefs();
      const auto = autoRefs();
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
    if (p.source?.kind === "file" || p.source?.kind === "builtin") return null;
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

  async function generate() {
    if (!profile || !pstate || run) return;
    // Pin the intended mode/profile before any async connection, Photoshop or ComfyUI work.
    // A selection refresh must never silently replace an inpaint request with an upscale profile.
    const requestedMode = mode, requestedProfile = profile, requestedState = pstate;
    const intentAtStart = modeIntentRevision;
    const changedDuringPrepare = () => modeIntentRevision !== intentAtStart
      || mode !== requestedMode || profile?.id !== requestedProfile.id
      || modeOf(requestedProfile) !== requestedMode;
    const abortForModeChange = () => {
      log("warn", "generate preparation aborted: mode/profile changed", JSON.stringify({
        requestedMode, requestedProfile: requestedProfile.name, requestedProfileMode: modeOf(requestedProfile),
        currentMode: mode, currentProfile: profile?.name ?? null,
      }));
      setStatus("生成准备期间模式或工作流发生变化，本次任务已停止；请确认当前模式和工作流后重新生成", "error");
    };
    if (modeOf(requestedProfile) !== requestedMode) { abortForModeChange(); return; }
    await checkConn();
    await refresh();
    if (changedDuringPrepare()) { abortForModeChange(); return; }
    const why = blockedReason();
    if (why) { setStatus(why, "error"); return; }
    const syncError = await syncProfile(requestedProfile);
    if (syncError) { setStatus(syncError, "error"); return; }
    if (changedDuringPrepare()) { abortForModeChange(); return; }
    setStatus("生成中…");
    const p = requestedProfile, ps = requestedState;
    crumb("生成：" + requestedMode);
    log("info", "generate dispatch", JSON.stringify({ mode: requestedMode, profileMode: modeOf(p), profile: p.name, profileId: p.id }));
    if (modeOf(p) === "extract") lastCutout = null;
    run = { stage: "准备中…", progress: null, detail: "", signal: { aborted: false } };
    const current = run;
    // Remember the actual group written to the PSD, including a partially successful run.
    // A new AI result is represented as one group in WaveLayer, not its vN child layer.
    const written = { group: null as FillGroup | null };
    stash = null;
    renderAll();
    try {
      const res = await runInpaint(svc.host, comfy, {
        profile: p, prompt: cleanPrompt(prompt.value), seed: ps.seedMode === "fixed" ? ps.seed : null, params: effectiveParams(p, ps), loras: ps.loras,
        addTo: willAdd() ? group ?? undefined : undefined,
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
          written.group = g;
          // the canvas has grown: clear the extension at once, so a later failure / cancel
          // can't leave it set and expand the canvas a second time
          if (g.kind === "outpaint" && group?.layerId !== g.layerId && padTotal()) { pads = { left: 0, right: 0, top: 0, bottom: 0 }; expander.setPads(pads); }
          if (group?.layerId !== g.layerId) variations = [];
          group = g;
          variations = [...variations.map(x => ({ ...x, visible: false })), v]; renderHistory();
        },
        debug: settings.debugFiles ? svc.debugSave : undefined,
      });
      if (ps.seedMode === "random") { ps.seed = res.seeds[res.seeds.length - 1]; store.saveState(p.id, ps); }
      if (modeOf(p) === "extract" && res.cutout && res.group) {
        lastCutout = { group: res.group, cutout: res.cutout };
        renderAction();
        if (!res.continued && settings.extractRemove !== false) {
          const removed = await removeCutout(res.group, res.cutout, current);
          if (removed !== true) { setStatus(`已抠出，变体 ${res.variations.map(v => v.number).join("、")}；${removed}`, removed.startsWith("从原图移除失败") ? "error" : "info"); return; }
          lastCutout = null;
          setStatus(`已抠出并从原图移除（拆图），变体 ${res.variations.map(v => v.number).join("、")}`, "ok");
          return;
        }
      }
      if (!res.group) setStatus(`已放大 ${res.upscaled ?? 1} 个图层，结果是上方的智能对象，原图层已隐藏` + (res.failed?.length ? `；${res.failed.length} 个失败（${res.failed[0]}${res.failed.length > 1 ? " 等" : ""}）` : ""), res.failed?.length ? "error" : "ok");
      else setStatus(`${res.continued ? "已加入" : modeOf(p) === "outpaint" ? "已扩展画布，" : modeOf(p) === "txt2img" ? "已生成，" : modeOf(p) === "upscale" ? "已放大到新文档，" : modeOf(p) === "blend" ? "已新建 AI 融图，" : modeOf(p) === "extract" ? "已抠出，" : "已新建 AI 填充，"}变体 ${res.variations.map(v => v.number).join("、")} · seed ${res.seeds.join("、")}`, "ok");
    } catch (e) {
      log("error", "generate failed", e);
      if (e instanceof StashedResult) { stash = e.png; setStatus(e.message, "error"); }
      else setStatus(current.signal.aborted ? "已取消" : (e as Error).message, current.signal.aborted ? "info" : "error");
    } finally {
      run = null;
      // Do this after all variants and optional cutout-removal work finish. Photoshop's
      // placeEvent leaves the vN child selected; WaveLayer treats its parent as one AI layer.
      const writtenGroup = written.group;
      if (writtenGroup) {
        try { await svc.host.selectFillGroup(writtenGroup); }
        catch (e) {
          log("warn", "select generated AI layer failed", writtenGroup.layerId, e);
          setStatus("图片已生成，但自动选中 AI 图层失败：" + (e as Error).message, "error");
        }
      }
      renderAll();
      await refresh();
      void loadDocThumb(true);
    }
  }

  async function supplementBackground() {
    const saved = lastCutout;
    if (!saved || run) return;
    const activeDoc = svc.host.activeDoc();
    if (!activeDoc || activeDoc.id !== saved.group.docId) {
      doc = activeDoc; lastCutout = null; renderAction();
      setStatus("上一次抠图不在当前文档中，请重新抠图后再补充背景", "error");
      return;
    }
    doc = activeDoc;
    const current = { stage: "补充背景准备中…", progress: null as number | null, detail: "", signal: { aborted: false } };
    run = current; stash = null; setStatus("正在补充背景…"); renderAll();
    try {
      const result = await removeCutout(saved.group, saved.cutout, current, "补充背景");
      if (result === true) {
        if (lastCutout === saved) lastCutout = null;
        setStatus("背景已补充，结果已放在抠图图层下方", "ok");
      } else setStatus(result, "error");
    } catch (e) {
      log("error", "extract background supplement failed", e);
      setStatus(current.signal.aborted ? "已取消补充背景" : "补充背景失败：" + (e as Error).message, current.signal.aborted ? "info" : "error");
    } finally {
      if (run === current) run = null;
      renderAll();
      await refresh();
      void loadDocThumb(true);
    }
  }

  /** The inpaint workflow removes the cut-out object from the original (prompt left empty), then
   *  places the reconstructed background directly below the cut-out. Returns true, or why it didn't run. */
  async function removeCutout(cut: FillGroup, mask: NonNullable<RunResult["cutout"]>, current: NonNullable<typeof run>, purpose = "拆图"): Promise<true | string> {
    const rp = pickFor("inpaint");
    if (!rp) return purpose === "拆图" ? "要从原图移除，先在「局部重绘」模式导入移除工作流（留空提示词 = 移除）" : "要补充背景，先在「局部重绘」模式导入移除工作流（留空提示词 = 移除）";
    if (!rp.options.allowEmptyPrompt) return purpose === "拆图"
      ? `「局部重绘」当前的工作流「${rp.name}」不支持留空移除，换成移除工作流后再试`
      : `「局部重绘」当前的工作流「${rp.name}」不支持留空补背景，换成支持空提示词的移除工作流后再试`;
    const err = await syncProfile(rp);
    if (err) return (purpose === "拆图" ? "从原图移除失败：" : "补充背景失败：") + err;
    try {
      const rps = store.state(rp.id);
      const res = await runInpaint(svc.host, comfy, {
        profile: rp, prompt: "", seed: null, params: effectiveParams(rp, rps), loras: rps.loras, references: {}, count: 1,
        selectionMask: mask, hide: cut,
      }, {
        signal: current.signal,
        stage: t => { current.stage = purpose + " · " + t; current.detail = ""; renderAction(); },
        progress: (f, t) => { current.progress = f; current.detail = t ?? ""; renderAction(); },
        promptQueued: id => { current.promptId = id; },
        debug: settings.debugFiles ? svc.debugSave : undefined,
      });
      if (!res.group) return purpose === "拆图" ? "从原图移除失败：局部重绘没有返回结果图层" : "补充背景失败：局部重绘没有返回结果图层";
      await svc.host.placeBelow(cut.docId, res.group.layerId, cut.layerId);
      log("info", purpose === "拆图" ? "extract removed" : "extract background supplemented", res.group.layerId);
      return true;
    } catch (e) {
      if (current.signal.aborted) throw e;
      log("error", purpose === "拆图" ? "extract remove failed" : "extract background supplement failed", e);
      if (e instanceof StashedResult) stash = e.png;
      return (purpose === "拆图" ? "从原图移除失败：" : "补充背景失败：") + (e as Error).message;
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

  listen(document, "keydown", e => {
    const k = e as KeyboardEvent;
    if (!(k.ctrlKey || k.metaKey) || k.key.toLowerCase() !== "v") return;
    const t = k.target as HTMLElement | null;
    if (t && /^(TEXTAREA|INPUT|SELECT)$/.test(t.tagName)) return; // normal paste into fields
    if (sheetHost.querySelector(".sheet") || run) return;
    k.preventDefault();
    void pasteReference();
  });

  // ── start ──
  listen(window, "error", e => { log("error", "uncaught", (e as ErrorEvent).error ?? (e as ErrorEvent).message); setStatus("插件内部错误：" + ((e as ErrorEvent).message ?? ""), "error"); });
  listen(window, "unhandledrejection", e => { log("error", "unhandled", (e as PromiseRejectionEvent).reason); setStatus("插件内部错误：" + String((e as PromiseRejectionEvent).reason?.message ?? (e as PromiseRejectionEvent).reason), "error"); });
  log("info", "start", svc.version, svc.host.kind, settings.comfyUrl);

  // ── 更新内容: after an update, list what changed since the last build the user saw ──
  function openChanges(list: Change[], title: string) {
    const markSeen = () => { try { if (CHANGES[0]) localStorage.setItem(SEEN_KEY, CHANGES[0].hash); } catch { /* storage off */ } };
    const items = list.map(c => {
      const d = describe(c);
      return h("li", { class: "change" },
        h("div", { class: "change-top" }, h("span", { class: "change-kind" }, d.kind), h("span", { class: "change-text" }, d.text)),
        h("div", { class: "change-date muted small" }, c.date.slice(0, 10)),
        ...d.detail.map(l => h("div", { class: "change-detail small" }, l)));
    });
    const close = () => { markSeen(); sheet.remove(); };
    const sheet: HTMLElement = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, title),
        h("button", { class: "icon-btn sm", title: "关闭", onClick: close }, icon("close"))),
      h("div", { class: "sheet-body" }, items.length ? h("ul", { class: "change-list" }, ...items) : h("div", { class: "muted small" }, "这个版本没有附带更新记录")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn primary", onClick: close }, "知道了")));
    sheetHost.append(sheet);
  }
  {
    let seen: string | null = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch { /* storage off */ }
    const fresh = unseenChanges(CHANGES, seen);
    if (fresh.length) { log("info", "whats new", fresh.length, CHANGES[0].hash.slice(0, 7)); openChanges(fresh, "WavePlug 已更新"); }
    else if (CHANGES[0] && seen !== CHANGES[0].hash) { try { localStorage.setItem(SEEN_KEY, CHANGES[0].hash); } catch { /* storage off */ } }
  }
  renderAll();
  // 卡死保护 only needs the list of open documents: at most every 5 s, not on every change
  let hangSyncedAt = 0, hangTimer: ReturnType<typeof setTimeout> | null = null;
  svc.host.onChange(() => {
    void refresh();
    const since = Date.now() - hangSyncedAt;
    if (since > 5000) { hangSyncedAt = Date.now(); void syncHangGuard(); }
    else if (!hangTimer) hangTimer = setTimeout(() => { hangTimer = null; hangSyncedAt = Date.now(); void syncHangGuard(); }, 5000 - since);
    if (toolsMode()) void toolsView.refresh();
  });
  const managedColdStart = svc.host.kind === "uxp"
    && settings.helperAutoStart !== false
    && settings.comfyAutoStartWithPhotoshop !== false;
  if (svc.host.kind === "uxp") startOverlay();
  void refresh();
  if (toolsMode()) void toolsView.refresh();
  // When both helpers are configured to autostart, wait for the native manager's
  // starting/ready event instead of probing 127.0.0.1 before ComfyUI has bound its port.
  if (!managedColdStart) void checkConn();
}
