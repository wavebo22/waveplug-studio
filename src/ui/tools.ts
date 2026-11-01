// 工具 page: Photoshop layer tools that need no ComfyUI. Each acts on the layers selected in
// Photoshop (multi-select works) and is one undo step.

import { log } from "../app/log.ts";
import { type ToolLayer, type ToolResult, isSmart, resultText } from "../core/layers/smart.ts";
import type { LayerTools } from "../ps/host.ts";
import { h, replace } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error") => void;

interface Tool {
  label: string;
  tip: string;
  /** past tense for the status line, e.g. "已断开" */
  verb: string;
  /** appended to the status line when something was done */
  after?: string;
  /** enabled when … */
  needs: "smart" | "any";
  run: () => Promise<ToolResult | null>;
  primary?: boolean;
}

/** 裁剪边缘 / 像素岛 settings, remembered per panel */
interface PixelSettings { strength: number; minArea: number; merge: number }
const PIXEL_KEY = "wp.tools.pixel";
/** Splits making more layers than this ask for a second click first. */
const CONFIRM_ABOVE = 20;
/** More layers than this are refused: Photoshop gets very slow and the result is unusable anyway. */
const MAX_SPLIT = 200;

export function createToolsView(tools: LayerTools, status: Status) {
  let layers: ToolLayer[] | null = null, busy = false;
  const infoEl = h("div", { class: "tool-info" });
  /** the selected smart objects and whether each shares its content */
  const soList = h("div", { class: "so-list" });
  const SO_ROWS = 6;

  const list: Tool[] = [
    { label: "断开链接", verb: "已断开", after: "，现在每个都有自己的内容", needs: "smart", primary: true, run: () => tools.makeUnique(),
      tip: "复制出来的智能对象共用同一份内容，改一个全部跟着变。断开后每个都有自己的内容，位置、顺序、外观不变" },
    { label: "查找同源", verb: "已选中", after: "共用同一份内容的智能对象", needs: "smart", run: () => tools.selectSameSource(),
      tip: "选中所有和当前智能对象共用同一份内容的副本" },
    { label: "转换为智能对象", verb: "已转换", needs: "any", run: () => tools.convert(false),
      tip: "把选中的图层合在一起转换成一个智能对象" },
    { label: "分别转换", verb: "已转换", needs: "any", run: () => tools.convert(true),
      tip: "选中的每个图层各自转换成一个智能对象" },
    { label: "解包图层", verb: "已解包", needs: "smart", run: () => tools.unpack(),
      tip: "把智能对象展开回里面的图层（Photoshop「转换为图层」）" },
    { label: "重置变换", verb: "已重置", needs: "smart", run: () => tools.resetTransform(),
      tip: "撤销智能对象的缩放、旋转和变形，恢复置入时的状态" },
    { label: "替换内容…", verb: "已替换", needs: "smart", run: () => tools.replaceContents(),
      tip: "选一个文件替换智能对象的内容，保留现有的位置和变换。共用内容的副本会一起变" },
    { label: "导出内容…", verb: "已导出", needs: "smart", run: () => tools.exportContents(),
      tip: "把智能对象里面的文件（PSB、PNG 等）保存到选定的文件夹，同源副本只导出一次" },
  ];

  const buttons = list.map(t => {
    const b = h("button", { class: "btn tool-btn" + (t.primary ? " primary wide" : ""), title: t.tip }, t.label);
    b.addEventListener("click", () => void use(t));
    return b;
  });

  async function use(t: Pick<Tool, "label" | "verb" | "after" | "run">) {
    if (busy) return;
    busy = true; render();
    status(t.label.replace("…", "") + "中…");
    try {
      const r = await t.run();
      if (r) status(r.done && t.after ? resultText(t.verb, r).replace(/^(\S+ \d+ 个)/, "$1" + t.after) : resultText(t.verb, r), r.done ? "ok" : "error");
      else status("已取消");
    } catch (e) {
      log("error", "tool", t.label, e);
      status(`${t.label.replace("…", "")}失败：${(e as Error).message ?? e}`, "error");
    } finally { busy = false; await refresh(); }
  }

  function render() {
    const sel = layers?.filter(l => l.selected) ?? [], smart = sel.filter(isSmart);
    const shared = smart.filter(l => l.contentId && (layers ?? []).filter(x => x.contentId === l.contentId).length > 1).length;
    replace(infoEl, !layers ? "未打开文档"
      : !sel.length ? "在图层面板选中要处理的图层（可多选）"
      : `已选 ${sel.length} 个图层` + (smart.length ? ` · ${smart.length} 个智能对象` : "") + (shared ? ` · ${shared} 个与其他图层共用内容` : ""));
    infoEl.className = "tool-info" + (sel.length ? "" : " muted");
    const users = (l: ToolLayer) => l.contentId ? (layers ?? []).filter(x => x.contentId === l.contentId).length : 1;
    replace(soList, ...smart.slice(0, SO_ROWS).map(l => {
      const n = users(l);
      const [text, cls, tip] = l.linked ? ["外部链接", "", "内容链接到外部文件"]
        : n > 1 ? [`共用 ×${n}`, " shared", `和另外 ${n - 1} 个智能对象共用同一份内容，改一个全部跟着变`]
        : ["独立", " own", "内容只属于这一个图层"];
      return h("div", { class: "so-row", title: tip }, h("span", { class: "so-name" }, l.name), h("span", { class: "so-tag" + cls }, text));
    }), smart.length > SO_ROWS ? h("div", { class: "muted small" }, `还有 ${smart.length - SO_ROWS} 个…`) : null);
    soList.hidden = !smart.length;
    buttons.forEach((b, i) => { (b as any).disabled = busy || (list[i].needs === "smart" ? !smart.length : !sel.length); });
    renderPixel();
  }

  async function refresh() {
    if (busy) return;
    try { layers = await tools.inspect(); } catch (e) { log("warn", "tools inspect", e); layers = null; }
    pending = null;
    render();
  }

  // ── 裁剪边缘 / 像素岛 (pixel layers) ──
  const px: PixelSettings = { strength: 0.4, minArea: 50, merge: 0 };
  try { Object.assign(px, JSON.parse(localStorage.getItem(PIXEL_KEY) ?? "{}")); } catch { /* defaults */ }
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

  const [unique, same, ...rest] = buttons;
  const el = h("div", { class: "tools" },
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("span", { class: "label" }, "智能对象")),
      infoEl, soList,
      h("div", { class: "tool-grid" }, unique, same, ...rest),
      h("div", { class: "muted small tool-note" }, "作用于图层面板里选中的图层，支持多选；每次操作可用 Ctrl+Z 一步撤销")),
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
      splitBtn));
  render();
  return { el, refresh };
}
