// AI 拆层（试验）on the 工具 page: DeepSeek looks at the picture and lists the parts it could be split
// into, each with a rough box (core/assistant/decompose.ts). The panel shows the boxes over a
// thumbnail and the list; a click on a part selects its box in Photoshop (a second click its crop,
// what 心宝抠图 would get). This step changes no layers — cutting the parts out comes next.

import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import {
  DECOMPOSE_SYSTEM, type DecomposeDetail, type DecomposePass, type DecomposePlan, combineAnswers, REFINE_BATCH, REFINE_MAX_PIXELS, REFINE_SYSTEM, applyRefine,
  alignTextParts, decomposeRequest, isDecomposeDetail, parseDecomposeAnswer, refineRegion, refineRequest, visionSize, withManualBox,
} from "../core/assistant/decompose.ts";
import { inkMap } from "../core/image/textAlign.ts";
import { withGrid } from "../core/image/grid.ts";
import { type Pixels, encodePng } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";
import type { PsHost } from "../ps/host.ts";
import { crumb, log, withTimeout } from "../app/log.ts";
import { h, replace } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error") => void;

export interface AiDecomposeDeps {
  host: PsHost;
  fetch: typeof fetch;
  /** the DeepSeek API Key from 功能设置 ("" when not filled in) */
  key(): string;
  status: Status;
  /** 抠文字 → 去除文字 → 抠图形 → 去除图形 with the 抠图 and 局部重绘 workflows (app.ts): one plain
   *  layer per part, the removals as two smart objects; `report` follows its progress. Missing: no 抠图 button. */
  cut?(docId: number, parts: readonly { name: string; box: Rect; kind: "object" | "text"; remove: number }[], report: (done: number, total: number, text: string) => void, clean: CleanMode): Promise<{ done: number; failed: string[]; stopped: boolean; background: { done: number; total: number; failed: string[] } | null }>;
  cancelCut?(): void;
}

const DETAIL_KEY = "wp.decompose.detail", REFINE_KEY = "wp.decompose.refine", CLEAN_KEY = "wp.decompose.clean", SCOPE_KEY = "wp.decompose.scope";
/** 去除背景: not at all, or each cut-out part's box removed from the original, one after another */
export type CleanMode = "off" | "box";
const CLEANS: [CleanMode, string, string][] = [
  ["off", "不去除", "只抠图，不动原图"],
  ["box", "按范围去除", "先抠文字，再用「局部重绘」的移除工作流按 DeepSeek 给的顺序把文字一处一处去掉；然后从去掉文字的画面上抠图形，再把图形去掉。去掉文字的结果合成一个「去除文字」智能对象，去掉图形的合成一个「去除图形」智能对象，放在所有抠图层下面，原图层不动"],
];
type Scope = "doc" | "selection";
const SCOPES: [Scope, string, string][] = [
  ["doc", "整个画面", "DeepSeek 看整个画面"],
  ["selection", "当前选区", "只看 PS 里当前选区框住的地方：东西少、占的像素多，框得更准。点列表选中范围也会改变选区，重新框选后再分析"],
];
const TIMEOUT_MS = 180_000;
const DETAILS: [DecomposeDetail, string, string][] = [
  ["coarse", "粗", "只拆 2～4 个最主要的部分"],
  ["medium", "中", "每组连在一起的插画、每个单独摆放的物件、每块文字各一个"],
  ["fine", "细", "单独摆放的小图标、logo、线框也拆出来，每块文字单独一个；连在一起的插画仍算一个"],
];
/** box colours, in turn (the panel's palette tokens) */
const COLORS = 8;

interface Result {
  docId: number;
  docName: string;
  size: { width: number; height: number };
  thumb: string;
  /** what the thumbnail shows (the whole document, or the selection it was asked about) */
  area: Rect;
  plan: DecomposePlan;
  /** what the second look couldn't do */
  notes: string[];
  note: string;
}

function dataUrl(p: Pixels): string {
  const bytes = encodePng(p);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}

export function createAiDecompose(d: AiDecomposeDeps) {
  let detail: DecomposeDetail = "medium";
  try { const v = localStorage.getItem(DETAIL_KEY) ?? ""; if (isDecomposeDetail(v)) detail = v; } catch { /* default */ }
  let busy = false, result: Result | null = null, failed = "";
  /** parts left out of 抠图 (unticked), by index; cleared with every new analysis */
  const skip = new Set<number>();
  /** 抠图 running: what it is doing */
  let cutting: string | null = null;
  let clean: CleanMode = "box";
  try { if (localStorage.getItem(CLEAN_KEY) === "off") clean = "off"; } catch { /* default */ }
  const cleanBtns = CLEANS.map(([k, label, tip]) => h("button", { class: "seg-btn", title: tip, onClick: () => { if (cutting) return; clean = k; try { localStorage.setItem(CLEAN_KEY, k); } catch { /* not kept */ } render(); } }, label));
  const cleanRow = h("div", { class: "param", title: "抠完以后，要不要把抠出的东西从原图上去掉、补出干净的背景（放在所有抠图层下面，原图层不动）" },
    h("div", { class: "param-top" }, h("span", { class: "param-label" }, "去除背景")),
    h("div", { class: "seg dc-seg" }, ...cleanBtns));
  let scope: Scope = "doc";
  try { if (localStorage.getItem(SCOPE_KEY) === "selection") scope = "selection"; } catch { /* default */ }
  const scopeBtns = SCOPES.map(([k, label, tip]) => h("button", { class: "seg-btn", title: tip, onClick: () => { scope = k; try { localStorage.setItem(SCOPE_KEY, k); } catch { /* not kept */ } render(); } }, label));
  let refine = false;
  // off unless ticked: on small pictures the crops show DeepSeek nothing new, it costs minutes, and
  // the boxes come out about as good (11-27 log)
  try { refine = localStorage.getItem(REFINE_KEY) === "on"; } catch { /* default */ }
  /** the part whose box (false) or crop (true) is selected now */
  let shown: { i: number; crop: boolean } | null = null;

  const detailBtns = DETAILS.map(([k, label, tip]) => h("button", { class: "seg-btn", title: tip, onClick: () => { detail = k; try { localStorage.setItem(DETAIL_KEY, k); } catch { /* not kept */ } render(); } }, label));
  const hint = h("input", { class: "field", type: "text", placeholder: "补充要求（可选），例如：文字不用拆" }) as HTMLInputElement;
  const refineBox = h("input", { type: "checkbox", checked: refine }) as HTMLInputElement;
  refineBox.addEventListener("change", () => { refine = refineBox.checked; try { localStorage.setItem(REFINE_KEY, refine ? "on" : "off"); } catch { /* not kept */ } });
  const runBtn = h("button", { class: "btn tool-btn wide primary", title: "把画面发给 DeepSeek（deepseek-flash），同时问两次：一次找图像、物件和装饰图形，一次找文字，合起来列出可以拆成独立图层的部分（文字在上）。只分析，不改动文档", onClick: () => void run() }, "分析画面");
  const info = h("div", { class: "tool-info muted" });
  const view = h("div", { class: "dc-view" });
  const list = h("div", { class: "dc-list" });
  const allBtn = h("button", { class: "btn tool-btn wide", title: "在画面上选中全部部分的范围", onClick: () => void select(null, false) }, "选中全部范围");
  const dropped = h("div", { class: "muted small dc-dropped" });
  const cutBtn = h("button", { class: "btn tool-btn wide primary", title: "用「抠图」模式当前的工作流（如心宝强化抠图），按上面勾选的部分逐个抠图：每个部分的范围当作选区，名字当作物件名。从后往前做，前面的部分最后在最上面；每个部分一个普通图层（不再是变体组）；顺序是 抠文字 → 去除文字 → 抠图形（从去掉文字的画面上抠）→ 去除图形，去除按 DeepSeek 给的顺序，结果分别合成「去除文字」「去除图形」两个智能对象", onClick: () => void cut() }, "按范围抠图");
  const stopBtn = h("button", { class: "btn tool-btn wide", title: "做完当前这一个就停下，已经抠好的保留", onClick: () => { d.cancelCut?.(); cutting = "正在停止…"; render(); } }, "停止");
  const cutInfo = h("div", { class: "tool-info dc-cut-info" });
  const manualBtn = h("button", { class: "btn tool-btn wide", title: "点列表里的一项后，在 PS 里用选框工具把它的范围框好，再点这里：PS 当前选区的外框就是这一项的范围（不再用 DeepSeek 的框）", onClick: () => void useSelection() }, "用选区作为范围");

  async function useSelection() {
    const r = result;
    if (!r || !shown || busy || cutting) return;
    if (!d.host.docExists(r.docId)) { d.status(`「${r.docName}」已关闭`, "error"); return; }
    const b = await d.host.selectionBounds(r.docId).catch(() => null);
    if (!b) { d.status("PS 里没有选区：先用选框工具框好范围", "error"); return; }
    const i = shown.i, p = r.plan.parts[i];
    r.plan.parts[i] = withManualBox(p, b, r.size);
    skip.delete(i);
    shown = { i, crop: false };
    d.status(`「${p.name}」的范围改成了当前选区`, "ok");
    render();
  }

  async function cut() {
    if (!result || !d.cut || cutting || busy) return;
    const r = result;
    const parts = r.plan.parts.filter((_, i) => !skip.has(i));
    if (!parts.length) { d.status("先勾选要抠的部分", "error"); return; }
    if (!d.host.docExists(r.docId)) { d.status(`「${r.docName}」已关闭`, "error"); return; }
    cutting = `准备抠图 ${parts.length} 个…`; render();
    const started = Date.now();
    try {
      const out = await d.cut(r.docId, parts.map(p => ({ name: p.name, box: p.box, kind: p.kind, remove: p.remove })), (_done, _total, text) => { if (cutting !== "正在停止…") { cutting = text; render(); } }, clean);
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      const bg = out.background;
      const head = (out.stopped ? `已停止：抠好 ${out.done} 个` : `抠图完成：${out.done}/${parts.length} 个`)
        + (bg && bg.done ? bg.done === bg.total ? `，背景已去除（${bg.total} 处）` : `，背景去除 ${bg.done}/${bg.total} 处` : "");
      const bgFail = bg?.failed.length ? `去除背景失败：${bg.failed.join("；")}` : "";
      const bad = out.failed.length || out.stopped || !!bgFail;
      d.status(`AI 拆层 ${head}（${mins} 分钟）` + (out.failed.length ? `，${out.failed.length} 个失败（${out.failed[0]}${out.failed.length > 1 ? " 等" : ""}）` : "") + (bgFail ? "；" + bgFail : ""), bad ? "error" : "ok");
      cutResult = [head + `，用时 ${mins} 分钟`, ...out.failed, ...(bgFail ? [bgFail] : [])].join("\n");
    } catch (e) {
      log("error", "decompose cut", e);
      d.status(`AI 拆层抠图失败：${(e as Error).message ?? e}`, "error");
      cutResult = `抠图没有开始：${(e as Error).message ?? e}`;
    } finally { cutting = null; render(); }
  }
  let cutResult = "";

  async function run() {
    if (busy) return;
    const doc = d.host.activeDoc();
    if (!doc) { d.status("先打开一个文档", "error"); return; }
    if (!d.key().trim()) { d.status("先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key", "error"); return; }
    // a new analysis replaces the last one at once: a failure never leaves another picture's boxes up
    if (cutting) return;
    busy = true; result = null; shown = null; failed = ""; cutResult = ""; skip.clear(); render();
    crumb("工具：AI 拆层 分析");
    d.status("AI 拆层：DeepSeek 正在分别找图像和文字…");
    const started = Date.now();
    const size = { width: doc.width, height: doc.height };
    let area: Rect = { left: 0, top: 0, right: doc.width, bottom: doc.height };
    if (scope === "selection") {
      const b = await d.host.selectionBounds(doc.id).catch(() => null);
      if (!b || !d.host.docPixels) { busy = false; failed = "「当前选区」要先在 PS 里框一个选区"; d.status(failed, "error"); render(); return; }
      area = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(doc.width, b.right), bottom: Math.min(doc.height, b.bottom) };
    }
    const whole = area.left === 0 && area.top === 0 && area.right === doc.width && area.bottom === doc.height;
    const cfg = { key: d.key(), model: DEEPSEEK_VISION_MODEL };
    let tokens = 0;
    // both looks think (DeepSeek's default). Without it the boxes come back well off, mostly up and
    // down (11-27 log: 心宝 icon, 品质秒杀, SONG 颂 70–100 px low in the crop); its reasoning takes
    // thousands of tokens, so the limit is high.
    const ask = async (system: string, user: string, images: string[]) => {
      const r = await withTimeout(deepseekJson(d.fetch, cfg, { system, user, images, maxTokens: 32000 }), TIMEOUT_MS, "DeepSeek ");
      if (r.usage) tokens += r.usage.prompt + r.usage.completion;
      return r.value;
    };
    try {
      // 1. the whole picture (with a grid to read positions against): what the parts are, roughly where
      const t = visionSize(area.right - area.left, area.bottom - area.top);
      let thumb: string, sent: string, px: Pixels | null = null;
      if (d.host.docPixels) {
        px = await d.host.docPixels(doc.id, whole ? null : area, t.width * t.height);
        thumb = dataUrl(px); sent = dataUrl(withGrid(px));
      } else thumb = sent = await d.host.docThumbnail(doc.id, Math.max(t.width, t.height));
      // two looks at the same time, one for the objects and graphics, one for the text
      const look = (pass: DecomposePass) => ask(DECOMPOSE_SYSTEM[pass], decomposeRequest(pass, detail, t, hint.value), [sent]);
      const [objects, text] = await Promise.allSettled([look("objects"), look("text")]);
      const notes: string[] = [];
      for (const [r, what] of [[objects, "图像和物件"], [text, "文字"]] as const)
        if (r.status === "rejected") { log("warn", "decompose " + what, r.reason); notes.push(`找${what}的那次请求失败（${(r.reason as Error)?.message ?? r.reason}），这次只有另一类`); }
      if (objects.status === "rejected" && text.status === "rejected") throw objects.reason;
      const value = (r: PromiseSettledResult<unknown>) => r.status === "fulfilled" ? r.value : null;
      const first = combineAnswers(value(text), value(objects));
      let plan = parseDecomposeAnswer(first, size, {}, whole ? undefined : area);
      log("info", "decompose", JSON.stringify({ doc: doc.name, size: [doc.width, doc.height], thumb: [t.width, t.height], detail, parts: plan.parts.length, dropped: plan.dropped, answer: JSON.stringify(first).slice(0, 4000) }));
      // 2. each part again in a zoomed-in crop of the full-resolution picture: a box that fits
      if (refine && plan.parts.length && d.host.docPixels) {
        d.status(`AI 拆层：找到 ${plan.parts.length} 个部分，正在放大细化每个部分的范围…`);
        const regions = plan.parts.map(p => refineRegion(p.box, size));
        const crops: string[] = [];
        for (const r of regions) crops.push(dataUrl(withGrid(await d.host.docPixels(doc.id, r, REFINE_MAX_PIXELS))));
        const batches: Promise<unknown>[] = [];
        for (let i = 0; i < plan.parts.length; i += REFINE_BATCH) {
          const names = plan.parts.slice(i, i + REFINE_BATCH).map(p => p.name);
          batches.push(ask(REFINE_SYSTEM, refineRequest(names), crops.slice(i, i + REFINE_BATCH)).catch(e => { log("warn", "decompose refine", e); return null; }));
        }
        const answers = await Promise.all(batches);
        log("info", "decompose refine", JSON.stringify({ regions, answers: JSON.stringify(answers).slice(0, 4000) }));
        const refined = applyRefine(plan.parts, regions, answers, size);
        plan = { ...plan, parts: refined.parts };
        notes.push(...refined.notes);
      }
      // 3. the text boxes moved onto the text in the picture: DeepSeek's places drift by up to ~7%
      // of the picture (11-28), its reading of what and in which order doesn't
      if (px && plan.parts.length) {
        const a0 = Date.now();
        plan = alignTextParts(plan, inkMap(px), area, px.width / (area.right - area.left), size);
        const unsure = plan.parts.filter(p => p.aligned === false);
        log("info", "decompose align", JSON.stringify({ ms: Date.now() - a0, parts: plan.parts.length, unsure: unsure.map(p => p.name), boxes: plan.parts.map(p => [p.name, p.raw]) }));
        if (unsure.length) notes.push(`${unsure.length} 个部分在画面上没找到对得上的位置（标「未校准」，没有勾选），用的是 DeepSeek 的框：点一下它，在 PS 里把范围框好，再点「用选区作为范围」`);
      }
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      result = { docId: doc.id, docName: doc.name, size, thumb, area, plan, notes, note: `${secs} 秒` + (tokens ? ` · ${tokens} tokens` : "") };
      shown = null;
      // a text box that couldn't be aligned may be anywhere: not cut or removed unless the user says so
      plan.parts.forEach((p, i) => { if (p.aligned === false) skip.add(i); });
      d.status(plan.parts.length ? `AI 拆层：找到 ${plan.parts.length} 个部分，点一项在画面上选中它` : "AI 拆层：DeepSeek 没有找到可以拆的部分", plan.parts.length ? "ok" : "error");
    } catch (e) {
      log("error", "decompose", e);
      failed = `「${doc.name}」分析失败：${(e as Error).message ?? e}`;
      d.status(`AI 拆层失败：${(e as Error).message ?? e}`, "error");
    } finally { busy = false; render(); }
  }

  /** `i` null: every part's box */
  async function select(i: number | null, crop: boolean) {
    if (!result || !d.host.selectRects) return;
    if (!d.host.docExists(result.docId)) { d.status(`「${result.docName}」已关闭`, "error"); return; }
    const parts = result.plan.parts;
    const rects: Rect[] = i === null ? parts.map(p => p.box) : [crop ? parts[i].crop : parts[i].box];
    try {
      await d.host.selectRects(result.docId, rects);
      shown = i === null ? null : { i, crop };
      if (i !== null) d.status(`已选中「${parts[i].name}」的${crop ? "裁剪范围（送去抠图的区域）" : "范围"}${crop ? "" : "，再点一次看裁剪范围"}`, "ok");
      else d.status(`已选中全部 ${parts.length} 个部分的范围`, "ok");
    } catch (e) {
      log("error", "decompose select", e);
      d.status(`建立选区失败：${(e as Error).message ?? e}`, "error");
    }
    render();
  }

  const pct = (v: number, of: number) => `${(v / of * 100).toFixed(2)}%`;
  const boxStyle = (r: Rect, a: Rect, c: number) => {
    const w = a.right - a.left, hh = a.bottom - a.top;
    return `left:${pct(r.left - a.left, w)};top:${pct(r.top - a.top, hh)};width:${pct(r.right - r.left, w)};height:${pct(r.bottom - r.top, hh)};border-color:var(--lc-${c});color:var(--lc-${c})`;
  };

  function render() {
    detailBtns.forEach((b, i) => b.classList.toggle("on", DETAILS[i][0] === detail));
    scopeBtns.forEach((b, i) => b.classList.toggle("on", SCOPES[i][0] === scope));
    (runBtn as any).disabled = busy;
    replace(runBtn, busy ? "分析中…" : result ? "重新分析" : "分析画面");
    const r = result;
    info.classList.toggle("err", !r && !!failed);
    replace(info, !r && failed ? failed : !r ? "DeepSeek 看画面，列出文字和图形的大致范围和去除顺序（连在一起的插画算一个）。点一项在画面上选中它的范围；不要的取消勾选。按 抠文字 → 去除文字 → 抠图形 → 去除图形 的顺序做。"
      : `「${r.docName}」${r.area.left || r.area.top || r.area.right !== r.size.width || r.area.bottom !== r.size.height ? "选区内" : ""}：${r.plan.parts.length} 个部分（从前到后）· ${r.note}`);
    (cutBtn as any).disabled = busy || !!cutting;
    if (!r) { replace(view); replace(list); replace(dropped); view.hidden = list.hidden = dropped.hidden = allBtn.hidden = cutBtn.hidden = stopBtn.hidden = cutInfo.hidden = cleanRow.hidden = manualBtn.hidden = true; return; }
    const picked = r.plan.parts.length - [...skip].filter(i => i < r.plan.parts.length).length;
    cutBtn.hidden = !d.cut || !r.plan.parts.length || !!cutting;
    cleanRow.hidden = cutBtn.hidden;
    cleanBtns.forEach((b, i) => b.classList.toggle("on", CLEANS[i][0] === clean));
    replace(cutBtn, `按范围抠图（${picked} 个）`);
    stopBtn.hidden = !cutting;
    manualBtn.hidden = !shown || !!cutting || !r.plan.parts.length;
    if (shown) replace(manualBtn, `用选区作为「${r.plan.parts[shown.i]?.name ?? ""}」的范围`);
    cutInfo.hidden = !cutting && !cutResult;
    replace(cutInfo, cutting ?? cutResult);
    view.hidden = false;
    // the range itself (`raw`); the margin added for cutting and removing isn't shown
    const boxes = r.plan.parts.map((p, i) => h("div", { class: "dc-box" + (shown?.i === i ? " on" : ""), style: boxStyle(p.raw, r.area, i % COLORS) }, h("span", { class: "dc-num" }, String(i + 1))));
    const s = shown && r.plan.parts[shown.i];
    replace(view, h("img", { class: "dc-thumb", src: r.thumb }), ...boxes,
      s ? h("div", { class: "dc-box crop", style: boxStyle(s.crop, r.area, shown!.i % COLORS) }) : null);
    list.hidden = !r.plan.parts.length;
    replace(list, ...r.plan.parts.map((p, i) => {
      const row = h("div", { class: "dc-row" + (shown?.i === i ? " on" : ""), title: "点一下：在画面上选中它的范围；再点一下：选中裁剪范围（送去抠图的区域）",
        onClick: () => void select(i, shown?.i === i && !shown.crop) },
        d.cut ? tick(i) : null,
        h("span", { class: "dc-num", style: `color:var(--lc-${i % COLORS})` }, String(i + 1)),
        h("span", { class: "dc-name" }, p.name),
        p.kind === "text" ? h("span", { class: "dc-tag" }, "文字") : null,
        h("span", { class: "dc-tag", title: "去除顺序：同一类里按这个顺序一个一个从原图上去掉" }, `去除 ${p.remove}`),
        p.manual ? h("span", { class: "dc-tag", title: "范围是你用 PS 选区设定的" }, "手动")
          : p.aligned === false ? h("span", { class: "dc-tag warn", title: "画面上没找到和它对得上的文字位置，框是 DeepSeek 估的，可能不准：点一下它，在 PS 里框好范围，再点「用选区作为范围」" }, "未校准") : null,
        p.refined === false ? h("span", { class: "dc-tag", title: "放大细化时没找到它，框是第一次看整个画面时估的，可能不准" }, "未细化") : null);
      row.addEventListener("mouseenter", () => boxes[i].classList.add("on"));
      row.addEventListener("mouseleave", () => { if (shown?.i !== i) boxes[i].classList.remove("on"); });
      return row;
    }));
    allBtn.hidden = r.plan.parts.length < 2 || !d.host.selectRects;
    const extra = [...(r.plan.dropped.length ? [`没采用：${r.plan.dropped.join("；")}`] : []), ...(r.notes.length ? [r.notes.join("；")] : [])];
    dropped.hidden = !extra.length;
    replace(dropped, extra.join("\n"));
  }

  function tick(i: number) {
    const box = h("input", { type: "checkbox", checked: !skip.has(i), title: "勾选的部分会被抠图" }) as HTMLInputElement;
    box.addEventListener("click", e => e.stopPropagation());
    box.addEventListener("change", () => { if (box.checked) skip.delete(i); else skip.add(i); render(); });
    return box;
  }

  const el = h("section", { class: "card" },
    h("div", { class: "card-head" }, h("span", { class: "label" }, "AI 拆层（试验）")),
    info,
    h("div", { class: "param", title: "DeepSeek 看哪里：整个画面，或者 PS 里当前选区框住的地方" },
      h("div", { class: "param-top" }, h("span", { class: "param-label" }, "分析范围")),
      h("div", { class: "seg dc-seg" }, ...scopeBtns)),
    h("div", { class: "param", title: "拆多细：越细部分越多，以后抠图花的时间也越多" },
      h("div", { class: "param-top" }, h("span", { class: "param-label" }, "拆分粒度")),
      h("div", { class: "seg dc-seg" }, ...detailBtns)),
    h("div", { class: "param", title: "告诉 DeepSeek 哪些要拆、哪些不要，例如「人物和衣服算一个」「文字不用拆」" }, hint),
    h("label", { class: "check-row dc-refine", title: "看完整个画面后，再把每个部分周围放大看一次，框取两次的合并范围（更不容易漏掉边缘）。要多花一两分钟；大图上更有用" }, refineBox, h("span", null, "放大细化每个部分的范围")),
    runBtn, view, list, manualBtn, allBtn, cleanRow, cutBtn, stopBtn, cutInfo, dropped);
  render();
  return { el };
}
