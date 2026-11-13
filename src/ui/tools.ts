// 工具 page: Photoshop layer tools that need no ComfyUI. Each acts on the layers selected in
// Photoshop (multi-select works) and is one undo step.
// What the WavePlug 图层 panel's right-click menu already offers (the smart-object commands,
// 转换为智能对象 …) is not repeated here: this page keeps the tools that need settings (裁剪边缘,
// 像素岛, 批量重命名) or a report first (文档优化).

import { crumb, log } from "../app/log.ts";
import { type ToolLayer, type ToolResult, isSmart, resultText } from "../core/layers/smart.ts";
import { type DocScan, type SlimItem, type SlimKind, docStats, planSlim, sizeText, slimWarnings } from "../core/layers/slim.ts";
import { type RenameOptions, RENAME_DEFAULTS, renameActive, renamePlan } from "../core/layers/batchRename.ts";
import type { LayerTools } from "../ps/host.ts";
import { h, replace } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error") => void;

interface Tool {
  label: string;
  /** past tense for the status line, e.g. "已清理" */
  verb: string;
  /** appended to the status line when something was done */
  after?: string;
  run: () => Promise<ToolResult | null>;
}

/** 裁剪边缘 / 像素岛 settings, remembered per panel */
interface PixelSettings { strength: number; minArea: number; merge: number }
const PIXEL_KEY = "wp.tools.pixel";
/** Splits making more layers than this ask for a second click first. */
export const CONFIRM_ABOVE = 20;
/** The settings last used on this page: the 图层 panel's right-click 裁剪边缘 / 拆分像素岛 run with them. */
export function pixelSettings(): PixelSettings {
  const saved: PixelSettings = { strength: 0.4, minArea: 50, merge: 0 };
  try { Object.assign(saved, JSON.parse(localStorage.getItem(PIXEL_KEY) ?? "{}")); } catch { /* defaults */ }
  return saved;
}
/** More layers than this are refused: Photoshop gets very slow and the result is unusable anyway. */
const MAX_SPLIT = 200;

export function createToolsView(tools: LayerTools, status: Status) {
  let layers: ToolLayer[] | null = null, busy = false;
  async function use(t: Tool) {
    if (busy) return;
    busy = true; render();
    crumb("工具：" + t.label);
    status(t.label.replace("…", "") + "中…");
    try {
      const r = await t.run();
      if (r) status(r.done && t.after ? resultText(t.verb, r).replace(/^(\S+ \d+ [^\s（；]+)/, "$1" + t.after) : resultText(t.verb, r), r.done ? "ok" : "error");
      else status("已取消");
    } catch (e) {
      log("error", "tool", t.label, e);
      status(`${t.label.replace("…", "")}失败：${(e as Error).message ?? e}`, "error");
    } finally { busy = false; await refresh(); }
  }

  function render() {
    renderPixel();
    renderText();
    renderRename();
    renderSlim();
  }

  async function refresh() {
    if (busy) return;
    try { layers = await tools.inspect(); } catch (e) { log("warn", "tools inspect", e); layers = null; }
    pending = null;
    render();
  }

  // ── 裁剪边缘 / 像素岛 (pixel layers) ──
  const px = pixelSettings();
  const savePx = () => { try { localStorage.setItem(PIXEL_KEY, JSON.stringify(px)); } catch { /* not kept */ } };
  const num = (key: "minArea" | "merge", max: number) => {
    const el = h("input", { class: "num", type: "number", min: "0", max: String(max), step: "1", value: String(px[key]) }) as HTMLInputElement;
    el.addEventListener("change", () => { const v = Math.round(Number(el.value)); if (Number.isFinite(v)) px[key] = Math.max(0, Math.min(max, v)); el.value = String(px[key]); savePx(); pending = null; render(); });
    return el;
  };
  const strRange = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(px.strength) }) as HTMLInputElement;
  const strVal = h("span", { class: "num-label" });
  const strText = () => { strVal.textContent = px.strength < 0.3 ? "轻" : px.strength < 0.7 ? "中" : "强"; };
  strRange.addEventListener("input", () => { px.strength = Number(strRange.value); strText(); savePx(); });
  strText();
  const pxInfo = h("div", { class: "tool-info" });
  const trimBtn = h("button", { class: "btn tool-btn wide", title: "清除半透明杂色和零碎的小像素块，边界随内容收紧。智能对象不用打开：PNG 内容直接清理，其他内容用图层蒙版隐藏" }, "裁剪边缘");
  const splitBtn = h("button", { class: "btn tool-btn wide", title: "把图层里互不相连的每一块拆成单独的图层，原位不动，放进一个同名图层组。智能对象会先栅格化（只有真的能拆时才会）" }, "拆分像素岛");
  /** a large split waiting for its second click */
  let pending: number | null = null;
  trimBtn.addEventListener("click", () => void use({ label: "裁剪边缘", verb: "已清理", run: () => tools.trimEdges(px.strength) }));
  splitBtn.addEventListener("click", () => void split());
  async function split() {
    if (busy) return;
    if (pending === null) {
      busy = true; render(); status("统计像素岛…");
      let n = 0;
      try { n = await tools.countIslands(px.minArea, px.merge); }
      catch (e) { status(`统计失败：${(e as Error).message ?? e}`, "error"); busy = false; render(); return; }
      busy = false;
      if (!n) { status("没有可拆的图层：每个图层只有一块（可以减小最小面积或合并距离）", "error"); render(); return; }
      if (n > MAX_SPLIT) { status(`会生成 ${n} 个图层，太多了（最多 ${MAX_SPLIT}）：调大最小面积或合并距离`, "error"); render(); return; }
      if (n > CONFIRM_ABOVE) { pending = n; status(`将生成 ${n} 个图层，再点一次确认`); render(); return; }
    }
    pending = null;
    await use({ label: "拆分像素岛", verb: "已拆分", after: "图层，每块放进了同名图层组", run: () => tools.splitIslands(px.minArea, px.merge) });
  }
  const pixelSel = () => (layers ?? []).filter(l => l.selected && l.kind === "pixel");
  const renderPixel = () => {
    const n = pixelSel().length, so = (layers ?? []).filter(l => l.selected && isSmart(l)).length;
    replace(pxInfo, !layers ? "未打开文档"
      : n || so ? [n ? `${n} 个像素图层` : "", so ? `${so} 个智能对象` : ""].filter(Boolean).join(" · ")
      : "选中像素图层或智能对象（文字、形状图层需要先栅格化）");
    pxInfo.className = "tool-info" + (n || so ? "" : " muted");
    (trimBtn as any).disabled = busy || !(n || so);
    (splitBtn as any).disabled = busy || !(n || so);
    replace(splitBtn, pending !== null ? `确认拆成 ${pending} 个图层` : "拆分像素岛");
    splitBtn.classList.toggle("primary", pending !== null);
  };

  // ── 文字 ──
  const textInfo = h("div", { class: "tool-info" });
  const textBtn = h("button", { class: "btn tool-btn wide", title: "多行文字拆成每行一个文字图层，位置、字体、样式不变，放进一个同名图层组。按回车或 Shift+回车 换的行都算一行" }, "按行拆分文字");
  textBtn.addEventListener("click", () => void use({ label: "按行拆分文字", verb: "已拆分", after: "文字图层，每行放进了同名图层组", run: () => tools.splitTextLines() }));
  const renderText = () => {
    const n = (layers ?? []).filter(l => l.selected && l.kind === "text").length;
    replace(textInfo, !layers ? "未打开文档" : n ? `已选 ${n} 个文字图层` : "选中多行的文字图层");
    textInfo.className = "tool-info" + (n ? "" : " muted");
    (textBtn as any).disabled = busy || !n;
  };

  // ── 批量重命名 (the selected layers, in list order) ──
  const RENAME_KEY = "wp.tools.rename";
  const rn: RenameOptions = { ...RENAME_DEFAULTS };
  try { Object.assign(rn, JSON.parse(localStorage.getItem(RENAME_KEY) ?? "{}")); } catch { /* defaults */ }
  const saveRn = () => { try { localStorage.setItem(RENAME_KEY, JSON.stringify(rn)); } catch { /* not kept */ } };
  const text = (key: "find" | "replace" | "prefix" | "suffix", hint: string) => {
    const el = h("input", { class: "field", type: "text", placeholder: hint, value: rn[key], spellcheck: "false" }) as HTMLInputElement;
    el.addEventListener("input", () => { rn[key] = el.value; saveRn(); renderRename(); });
    return el;
  };
  const numberBox = h("input", { type: "checkbox", checked: rn.number }) as HTMLInputElement;
  numberBox.addEventListener("change", () => { rn.number = numberBox.checked; saveRn(); renderRename(); });
  const startBox = h("input", { class: "num", type: "number", min: "0", max: "99999", step: "1", value: String(rn.start), title: "第一个图层的序号" }) as HTMLInputElement;
  startBox.addEventListener("change", () => { const v = Math.round(Number(startBox.value)); rn.start = Number.isFinite(v) ? Math.max(0, Math.min(99999, v)) : 1; startBox.value = String(rn.start); saveRn(); renderRename(); });
  const renameInfo = h("div", { class: "tool-info" });
  const renamePreview = h("div", { class: "muted small rename-preview" });
  const renameBtn = h("button", { class: "btn tool-btn wide", title: "按上面的规则给选中的图层改名，可以 Ctrl+Z 一步撤销" }, "重命名");
  const renameTargets = () => renamePlan((layers ?? []).filter(l => l.selected).map(l => ({ id: l.id, name: l.name })), rn);
  renameBtn.addEventListener("click", () => {
    const plan = renameTargets();
    if (plan.length) void use({ label: "批量重命名", verb: "已重命名", run: () => tools.renameLayers(plan.map(x => ({ id: x.id, name: x.to }))) });
  });
  const renameField = (label: string, tip: string, el: HTMLElement) => h("div", { class: "param", title: tip }, h("div", { class: "param-top" }, h("span", { class: "param-label" }, label)), el);
  const renameForm = h("div", null,
    h("div", { class: "tool-pair" },
      renameField("查找", "名称里要替换掉的文字；留空表示不查找", text("find", "例如 拷贝")),
      renameField("替换为", "查找到的文字换成这个。「查找」留空而这里有字：整个名称改成这个", text("replace", "留空 = 删掉"))),
    h("div", { class: "tool-pair" },
      renameField("前缀", "加在名称前面", text("prefix", "例如 btn/")),
      renameField("后缀", "加在名称后面", text("suffix", "例如 @2x"))),
    h("label", { class: "check-row rename-number", title: "按图层在列表里从上到下的顺序，在名称末尾加 01、02、03…" }, numberBox, h("span", null, "末尾加序号，从"), startBox, h("span", null, "开始")));
  const renameRule = () => renameActive(rn);
  function renderRename() {
    const sel = (layers ?? []).filter(l => l.selected), plan = renameTargets();
    replace(renameInfo, !layers ? "未打开文档" : !sel.length ? "选中要改名的图层（可多选）" : `已选 ${sel.length} 个图层` + (renameRule() ? ` · ${plan.length} 个会改名` : ""));
    renameInfo.className = "tool-info" + (sel.length ? "" : " muted");
    replace(renamePreview, ...plan.slice(0, 3).map(x => h("div", { class: "rename-row", title: `${x.from} → ${x.to}` }, h("span", { class: "rename-from" }, x.from), " → ", h("span", { class: "rename-to" }, x.to))),
      plan.length > 3 ? h("div", null, `… 还有 ${plan.length - 3} 个`) : null);
    renamePreview.hidden = !plan.length;
    (renameBtn as any).disabled = busy || !plan.length;
    replace(renameBtn, plan.length ? `重命名 ${plan.length} 个图层` : "重命名");
  }

  // ── 文档优化: a report first, then what to clean (safe ones ticked, trade-offs left to choose) ──
  let scan: DocScan | null = null, slimItems: SlimItem[] = [];
  const picked = new Set<SlimKind>();
  const slimBody = h("div");
  const scanBtn = h("button", { class: "btn tool-btn wide", title: "检查这个文档：哪些东西占空间又没用，各占多少。只检查，不改动任何东西" }, "检查文档");
  const cleanBtn = h("button", { class: "btn tool-btn wide primary", title: "清理勾选的项目，可以 Ctrl+Z 一步撤销；保存后文件才会变小" }, "优化已选");
  const purgeBtn = h("button", { class: "btn tool-btn wide", title: "Photoshop「编辑 → 清理 → 全部」：清空历史记录、剪贴板和缓存，PS 会变快，但之前的操作不能再撤销" }, "释放 PS 内存（清空历史记录）");
  scanBtn.addEventListener("click", () => void doScan());
  cleanBtn.addEventListener("click", () => void use({ label: "文档优化", verb: "已优化", run: async () => { const r = await tools.slim([...picked]); await doScan(true); return r; } }));
  purgeBtn.addEventListener("click", () => void use({ label: "释放内存", verb: "已释放", run: async () => { await tools.purgeMemory(); return { done: 1, skipped: [], note: "历史记录已清空" }; } }));
  /** an item with nothing it can act on (every candidate was skipped) */
  const inert = (i: SlimItem) => !i.ids.length && i.kind !== "offCanvas" && i.kind !== "channels";
  async function doScan(quiet = false) {
    if (busy && !quiet) return;
    if (!quiet) { busy = true; render(); status("检查文档…"); }
    try {
      scan = await tools.scanDoc();
      slimItems = scan ? planSlim(scan) : [];
      picked.clear();
      // only what changes nothing is ticked to begin with; a trade-off is the user's to tick
      for (const i of slimItems) if (i.on && i.risk === "safe" && !inert(i)) picked.add(i.kind);
      const total = slimItems.reduce((n, i) => n + i.bytes, 0);
      if (!quiet) status(!scan ? "未打开文档" : slimItems.length ? `找到 ${slimItems.length} 项可以优化${total ? "，" + sizeText(total) : ""}` : "这个文档很干净，没有可以优化的", "ok");
    } catch (e) { log("error", "scan", e); status(`检查失败：${(e as Error).message ?? e}`, "error"); }
    finally { if (!quiet) { busy = false; render(); } }
  }
  const slimRow = (i: SlimItem) => {
    const box = h("input", { type: "checkbox", checked: picked.has(i.kind), disabled: inert(i),
      onChange: (e: Event) => { if ((e.target as HTMLInputElement).checked) picked.add(i.kind); else picked.delete(i.kind); render(); } });
    return h("div", { class: "slim-item" },
      h("label", { class: "check-row slim-head" }, box, h("span", { class: "slim-label" }, i.label), h("span", { class: "slim-size" }, sizeText(i.bytes))),
      h("div", { class: "muted small slim-detail" }, i.detail),
      i.skipped.length ? h("div", { class: "muted small slim-detail", title: i.skipped.join("\n") }, `跳过 ${i.skipped.length} 个：${i.skipped[0]}${i.skipped.length > 1 ? " 等" : ""}`) : null);
  };
  const slimGroup = (title: string, tip: string, items: SlimItem[]) => items.length
    ? [h("div", { class: "slim-group", title: tip }, title), h("div", { class: "slim-list" }, ...items.map(slimRow))] : [];
  const renderSlim = () => {
    const warn = scan ? slimWarnings(scan) : [], stats = scan ? docStats(scan) : null;
    const pickedBytes = slimItems.filter(i => picked.has(i.kind)).reduce((n, i) => n + i.bytes, 0);
    replace(slimBody, !scan || !stats ? h("div", { class: "tool-info muted" }, "文件做久了会变大变卡。先检查，看清楚每一项占多少再决定清理什么")
      : h("div", { class: "slim-stats" },
        h("div", null, `${stats.layers} 个图层 · ${stats.groups} 个组` + (stats.smart ? ` · ${stats.smart} 个智能对象` : "")),
        h("div", { class: "muted small" }, `图层像素${sizeText(stats.bytes) || "很少"}（未压缩的估算，只用来比较大小）`)),
      ...(scan && !slimItems.length ? [h("div", { class: "tool-info" }, "这个文档很干净，没有可以优化的")] : []),
      ...slimGroup("安全优化 · 画面和可编辑性都不变", "清理后看起来和用起来完全一样", slimItems.filter(i => i.risk === "safe")),
      ...slimGroup("需要你决定 · 有取舍", "会放弃一些东西：隐藏的备份、以后再放大的清晰度、存储的选区", slimItems.filter(i => i.risk === "review")),
      ...(warn.length ? [h("div", { class: "slim-group" }, "建议 · 需要手动处理")] : []),
      ...warn.map(w => h("div", { class: "small slim-warn" }, w)));
    (scanBtn as any).disabled = busy || !layers;
    replace(scanBtn, scan ? "重新检查" : "检查文档");
    cleanBtn.hidden = !slimItems.length;
    (cleanBtn as any).disabled = busy || !picked.size;
    replace(cleanBtn, picked.size ? `优化已选的 ${picked.size} 项${pickedBytes ? "（" + sizeText(pickedBytes) + "）" : ""}` : "优化已选");
    (purgeBtn as any).disabled = busy || !layers;
  };

  const el = h("div", { class: "tools" },
    h("div", { class: "muted small tool-note tools-lead" }, "作用于选中的图层，可多选，每次操作一步撤销。智能对象、转换、合并、对齐等命令在「WavePlug 图层」面板的右键菜单里"),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("span", { class: "label" }, "边缘与像素岛")),
      pxInfo,
      h("div", { class: "param", title: "越强：清掉的半透明像素越多（不透明度 2%–31% 以下），清掉的零碎小块越大（4–400 像素以下）" },
        h("div", { class: "param-top" }, h("span", { class: "param-label" }, "清理强度"), strVal),
        h("div", { class: "param-ctl" }, strRange)),
      trimBtn,
      h("div", { class: "tool-pair" },
        h("div", { class: "param", title: "比这小的零碎小块不单独成层，留在「零碎」图层里" }, h("div", { class: "param-top" }, h("span", { class: "param-label" }, "最小面积"), h("span", { class: "muted small" }, "像素")), num("minArea", 100000)),
        h("div", { class: "param", title: "相距不超过这么多像素的几块算作同一块（比如文字的笔画、虚线）" }, h("div", { class: "param-top" }, h("span", { class: "param-label" }, "合并距离"), h("span", { class: "muted small" }, "像素")), num("merge", 500))),
      splitBtn),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("span", { class: "label" }, "文字")),
      textInfo, textBtn),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("span", { class: "label" }, "批量重命名")),
      renameInfo, renameForm, renamePreview, renameBtn),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("span", { class: "label" }, "文档优化")),
      slimBody, scanBtn, cleanBtn, purgeBtn));
  render();
  return { el, refresh };
}
