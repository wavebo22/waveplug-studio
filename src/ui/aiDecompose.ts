// AI 拆层（试验）on the 工具 page: DeepSeek looks at the picture and lists the parts it could be split
// into, each with a rough box (core/assistant/decompose.ts). The panel shows the boxes over a
// thumbnail and the list; a click on a part selects its box in Photoshop (a second click its crop,
// what 心宝抠图 would get). This step changes no layers — cutting the parts out comes next.

import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../core/assistant/deepseek.ts";
import {
  DECOMPOSE_SYSTEM, type DecomposeDetail, type DecomposePlan, decomposeRequest, isDecomposeDetail, parseDecomposeAnswer, visionSize,
} from "../core/assistant/decompose.ts";
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
}

const DETAIL_KEY = "wp.decompose.detail";
const TIMEOUT_MS = 180_000;
const DETAILS: [DecomposeDetail, string, string][] = [
  ["coarse", "粗", "只拆 2～4 个最主要的部分"],
  ["medium", "中", "每个独立的物件、每块文字各一个，约 4～8 个"],
  ["fine", "细", "能单独移动的都拆出来，约 8～15 个"],
];
/** box colours, in turn (the panel's palette tokens) */
const COLORS = 8;

interface Result {
  docId: number;
  docName: string;
  size: { width: number; height: number };
  thumb: string;
  plan: DecomposePlan;
  note: string;
}

export function createAiDecompose(d: AiDecomposeDeps) {
  let detail: DecomposeDetail = "medium";
  try { const v = localStorage.getItem(DETAIL_KEY) ?? ""; if (isDecomposeDetail(v)) detail = v; } catch { /* default */ }
  let busy = false, result: Result | null = null;
  /** the part whose box (false) or crop (true) is selected now */
  let shown: { i: number; crop: boolean } | null = null;

  const detailBtns = DETAILS.map(([k, label, tip]) => h("button", { class: "seg-btn", title: tip, onClick: () => { detail = k; try { localStorage.setItem(DETAIL_KEY, k); } catch { /* not kept */ } render(); } }, label));
  const hint = h("input", { class: "field", type: "text", placeholder: "补充要求（可选），例如：文字不用拆" }) as HTMLInputElement;
  const runBtn = h("button", { class: "btn tool-btn wide primary", title: "把画面的缩略图发给 DeepSeek（deepseek-flash），列出可以拆成独立图层的部分和大致范围。只分析，不改动文档", onClick: () => void run() }, "分析画面");
  const info = h("div", { class: "tool-info muted" });
  const view = h("div", { class: "dc-view" });
  const list = h("div", { class: "dc-list" });
  const allBtn = h("button", { class: "btn tool-btn wide", title: "在画面上选中全部部分的范围", onClick: () => void select(null, false) }, "选中全部范围");
  const dropped = h("div", { class: "muted small dc-dropped" });

  async function run() {
    if (busy) return;
    const doc = d.host.activeDoc();
    if (!doc) { d.status("先打开一个文档", "error"); return; }
    if (!d.key().trim()) { d.status("先在 WavePlug 程序 › 功能设置 › AI 助手 里填写 DeepSeek API Key", "error"); return; }
    busy = true; render();
    crumb("工具：AI 拆层 分析");
    d.status("AI 拆层：DeepSeek 正在看画面…");
    const started = Date.now();
    try {
      const t = visionSize(doc.width, doc.height);
      const thumb = await d.host.docThumbnail(doc.id, Math.max(t.width, t.height));
      const r = await withTimeout(deepseekJson(d.fetch, { key: d.key(), model: DEEPSEEK_VISION_MODEL },
        { system: DECOMPOSE_SYSTEM, user: decomposeRequest(detail, t, hint.value), images: [thumb], maxTokens: 8000, temperature: 0.2 }), TIMEOUT_MS, "DeepSeek ");
      const plan = parseDecomposeAnswer(r.value, { width: doc.width, height: doc.height });
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      log("info", "decompose", JSON.stringify({ doc: doc.name, size: [doc.width, doc.height], thumb: [t.width, t.height], detail, parts: plan.parts.length, dropped: plan.dropped, usage: r.usage, answer: JSON.stringify(r.value).slice(0, 3000) }));
      result = { docId: doc.id, docName: doc.name, size: { width: doc.width, height: doc.height }, thumb, plan, note: `${secs} 秒` + (r.usage ? ` · ${r.usage.prompt + r.usage.completion} tokens` : "") };
      shown = null;
      d.status(plan.parts.length ? `AI 拆层：找到 ${plan.parts.length} 个部分，点一项在画面上选中它` : "AI 拆层：DeepSeek 没有找到可以拆的部分", plan.parts.length ? "ok" : "error");
    } catch (e) {
      log("error", "decompose", e);
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
  const boxStyle = (r: Rect, size: { width: number; height: number }, c: number) =>
    `left:${pct(r.left, size.width)};top:${pct(r.top, size.height)};width:${pct(r.right - r.left, size.width)};height:${pct(r.bottom - r.top, size.height)};border-color:var(--lc-${c});color:var(--lc-${c})`;

  function render() {
    detailBtns.forEach((b, i) => b.classList.toggle("on", DETAILS[i][0] === detail));
    (runBtn as any).disabled = busy;
    replace(runBtn, busy ? "分析中…" : result ? "重新分析" : "分析画面");
    const r = result;
    replace(info, !r ? "DeepSeek 看画面，列出可以拆成独立图层的部分和大致范围。现在只做到这一步：点一项在画面上选中它的范围，检查准不准；还不会抠图。"
      : `「${r.docName}」：${r.plan.parts.length} 个部分（从前到后）· ${r.note}`);
    if (!r) { replace(view); replace(list); replace(dropped); view.hidden = list.hidden = dropped.hidden = allBtn.hidden = true; return; }
    view.hidden = false;
    const boxes = r.plan.parts.map((p, i) => h("div", { class: "dc-box" + (shown?.i === i ? " on" : ""), style: boxStyle(p.box, r.size, i % COLORS) }, h("span", { class: "dc-num" }, String(i + 1))));
    const s = shown && r.plan.parts[shown.i];
    replace(view, h("img", { class: "dc-thumb", src: r.thumb }), ...boxes,
      s ? h("div", { class: "dc-box crop", style: boxStyle(s.crop, r.size, shown!.i % COLORS) }) : null);
    list.hidden = !r.plan.parts.length;
    replace(list, ...r.plan.parts.map((p, i) => {
      const row = h("div", { class: "dc-row" + (shown?.i === i ? " on" : ""), title: "点一下：在画面上选中它的范围；再点一下：选中裁剪范围（送去抠图的区域）",
        onClick: () => void select(i, shown?.i === i && !shown.crop) },
        h("span", { class: "dc-num", style: `color:var(--lc-${i % COLORS})` }, String(i + 1)),
        h("span", { class: "dc-name" }, p.name),
        p.kind === "text" ? h("span", { class: "dc-tag" }, "文字") : null);
      row.addEventListener("mouseenter", () => boxes[i].classList.add("on"));
      row.addEventListener("mouseleave", () => { if (shown?.i !== i) boxes[i].classList.remove("on"); });
      return row;
    }));
    allBtn.hidden = r.plan.parts.length < 2 || !d.host.selectRects;
    dropped.hidden = !r.plan.dropped.length;
    replace(dropped, r.plan.dropped.length ? `没采用：${r.plan.dropped.join("；")}` : "");
  }

  const el = h("section", { class: "card" },
    h("div", { class: "card-head" }, h("span", { class: "label" }, "AI 拆层（试验）")),
    info,
    h("div", { class: "param", title: "拆多细：越细部分越多，以后抠图花的时间也越多" },
      h("div", { class: "param-top" }, h("span", { class: "param-label" }, "拆分粒度")),
      h("div", { class: "seg dc-seg" }, ...detailBtns)),
    h("div", { class: "param", title: "告诉 DeepSeek 哪些要拆、哪些不要，例如「人物和衣服算一个」「文字不用拆」" }, hint),
    runBtn, view, list, allBtn, dropped);
  render();
  return { el };
}
