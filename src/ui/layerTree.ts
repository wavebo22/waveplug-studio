// WavePlug 图层 panel, the list itself: Photoshop's layers with status cells, filters, click / Ctrl / Shift selection,
// eye toggles, drag to reorder, thumbnails with layer masks, clipping marks, a right-click menu,
// double-click for 图层样式 and Photoshop's bottom toolbar, kept in step with the document.
// Only the rows in view exist in the DOM (a fixed pool, re-filled on scroll), and only they get
// thumbnails (queued in the background, cached per layer), so documents with thousands of layers
// stay smooth.

import { log } from "../app/log.ts";
import { resultText } from "../core/layers/smart.ts";
import { ThumbCache } from "../core/layers/thumbs.ts";
import { type Filter, type LayerAction, type LayerKind, type LockKey, type MoveStep, type Row, type SmartAction, type TreeLayer, type Where, BLEND_MODES, ancestors, queryActive, clickSelect, contentUsers, dropPlan, dropZone, filterCounts, isVariantLayer, layerMenu, layerTags, linkPeers, lockPlan, packChips, lockedByGroup, sharedColors, visibleRows } from "../core/layers/tree.ts";
import { type LayerTools, type LayerTree, type RunOptions, type TargetPart, ADJUSTMENTS } from "../ps/host.ts";
import { h, icon, isShown, replace, setShown } from "./dom.ts";
import { type PopItem, createPopup } from "./popupMenu.ts";
import { createSlider } from "./slider.ts";

type Status = (text: string, kind?: "info" | "ok" | "error") => void;

/** 缩略图大小, like Photoshop's 面板选项: row height, thumbnail box and icon scale (无: icons only) */
type Size = "off" | "s" | "m" | "l";
const SIZES: Record<Size, { row: number; short: number; thumb: number; icon: number; label: string }> = {
  off: { row: 32, short: 28, thumb: 0, icon: 1.2, label: "无" }, s: { row: 32, short: 28, thumb: 26, icon: 1.2, label: "小" },
  m: { row: 44, short: 32, thumb: 38, icon: 1.35, label: "中" }, l: { row: 60, short: 38, thumb: 54, icon: 1.5, label: "大" },
};
let size: Size = (() => {
  try {
    const v = localStorage.getItem("wp.layers.size");
    if (v && v in SIZES) return v as Size;
    return localStorage.getItem("wp.layers.thumbs") === "off" ? "off" : "m";
  } catch { return "m"; }
})();
/** row height in px; groups and sub-rows (effects, smart filters, variations) are shorter */
let ROW = SIZES[size].row, SHORT = SIZES[size].short;
const isShort = (r: Row) => !!r.filter || (r.layer.kind === "group" && !isVariantLayer(r.layer));
const heightOf = (r: Row) => isShort(r) ? SHORT : ROW;
const INDENT = 14;
/** px from the row's left edge to where the indent starts: colour stripe, eye, 可移动, 可编辑, padding */
const LEAD = 4 + 30 + 24 + 24 + 4;
/** icon and name of each kind of layer (in place of a thumbnail, or as a badge on it) */
const KIND_ICON: Record<TreeLayer["kind"], [string, string]> = {
  pixel: ["image", "像素图层"], text: ["text", "文字图层"], shape: ["shape", "形状图层"], adjustment: ["adjust", "调整图层"], fill: ["fill", "填充图层"],
  smartObject: ["smart", "智能对象"], group: ["folder", "图层组"], background: ["image", "背景"], other: ["image", "图层"],
};
/** the panel's icons: Photoshop-style ones where there are, scaled with the 缩略图 size */
const PS_ICON: Record<string, string> = { eye: "psEye", lock: "psLock", link: "psLink", mask: "psMask", adjust: "psAdjust", folder: "psFolder", folderOpen: "psFolderOpen", trash: "psTrash", clip: "psClip", text: "psText", newLayer: "psNew", smart: "psSmart" };
/** 画板 frames: Photoshop's 图层颜色 labels; artboards without one take these in turn */
const LABELS: [string, string, string][] = [["red", "红色", "#e5534b"], ["orange", "橙色", "#f0a04b"], ["yellowColor", "黄色", "#e3cf4a"], ["grain", "绿色", "#5cc26b"], ["blue", "蓝色", "#4f9cf0"], ["violet", "紫色", "#a77ff0"], ["gray", "灰色", "#a0a0a0"]];
/** 自定义颜色: Photoshop's labels are only seven, so other colours are the panel's own, kept here by
 *  document (its file) and layer id; the last few used come back as squares in the colour menu */
const CUSTOM_KEY = "wp.layers.custom", RECENT_KEY = "wp.layers.recent";
const loadJson = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const saveJson = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not kept */ } };
const customColors: Record<string, Record<string, string>> = loadJson(CUSTOM_KEY, {});
let recentColors: string[] = loadJson(RECENT_KEY, []);
const AUTO_FRAMES = ["#4f9cf0", "#f0a04b", "#a77ff0", "#5cc26b", "#e5534b", "#e3cf4a", "#6be0e8", "#ec86d6"];
const ic = (name: string, px = 14) => icon(PS_ICON[name] ?? name, Math.round(px * SIZES[size].icon));
const kindIcon = (l: TreeLayer, open: boolean) => h("span", { class: "lt-kind k-" + l.kind, title: KIND_ICON[l.kind][1] }, ic(l.kind === "group" && open && l.children ? "folderOpen" : KIND_ICON[l.kind][0], 15));

/** thumbnail px read: twice the box, for sharpness (never more than 108 — see core/layers/thumbs.ts) */
const thumbPx = () => SIZES[size].thumb * 2;
/** thumbnails read per Photoshop call */
const THUMB_BATCH = 6;
/** layers whose pixels make a useful thumbnail (groups, text and adjustments get their mark, like Photoshop) */
let thumbsOn = size !== "off";
/** resting on a row selects its layer in Photoshop for the moment, so the canvas marks where it is */
// off unless turned on: each hover selects in Photoshop, which can stall it (see LAYER_PANEL_HANDOFF §5)
let peekOn = (() => { try { return localStorage.getItem("wp.layers.peek") === "on"; } catch { return false; } })();
/** layers drawn with a picture (an empty layer's is blank, like Photoshop's); hasThumb: one to read */
const hasPicture = (l: TreeLayer) => thumbsOn && (l.kind === "pixel" || l.kind === "smartObject" || l.kind === "shape" || l.kind === "fill" || l.kind === "background");
const hasThumb = (l: TreeLayer) => hasPicture(l) && l.width > 0 && l.height > 0;
/** hovering a closed group this long while dragging opens it */
const OPEN_DELAY = 600;
/** an effect chip's press waits this long for a second one (then it edits instead of switching) */
const CHIP_DOUBLE = 450;
/** two presses on a row this close together are a double-click (图层样式) */
const DOUBLE_CLICK = 600;
/** width of a variation chip (picture and number) in a variant layer's row */
const VCHIP_W = 78;
/** how long the mouse rests on a row before its layer is marked on the canvas */
const PEEK_DELAY = 60;
/** A thumbnail: always a small picture (at most 48 px, never more than 4 : 1), the layer's content
 *  or a mask's whole canvas — see core/layers/thumbs.ts thumbArea / frameThumb */
const thumbImg = (src: string) => h("div", { class: "lt-pic", style: `background-image: url("${src}")` });
/** mask thumbnails share the cache under the negative layer id */
const maskKey = (id: number) => -id;
/** vector masks: below every layer mask key */
const VKEY = 1_000_000_000;
const vmaskKey = (id: number) => -(id + VKEY);
/** a cache key's layer id, and which picture it is */
const keyLayer = (k: number) => k <= -VKEY ? -k - VKEY : Math.abs(k);
/** a 图层颜色 label (or the panel's own colour) as the eye column's tint (artboards show theirs as their frame) */
const labelTint = (l: TreeLayer, custom?: string) => {
  const c = l.artboard ? undefined : custom ?? LABELS.find(([k]) => k === l.color)?.[2];
  if (!c) return "";
  const n = parseInt(c.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, .55)`;
};
const SMART_VERB: Record<SmartAction, string> = { makeUnique: "已断开", selectSameSource: "已选中", makeEditable: "已转换", unpack: "已解包" };
const isSmartAction = (a: string): a is SmartAction => a in SMART_VERB;

/** `sub`: the row shows a smart filter (index 0: all of them) of layer `id` */
/** Status columns at the right of each row, always in this order; a column shows only when some
 *  layer in the document uses it, and stays blank on the rows that don't. */
type Col = "content" | "filters" | "fx" | "chain" | "lock";
const COLS: Col[] = ["content", "filters", "fx", "chain", "lock"];

interface RowEl { index: number; el: HTMLElement; eye: HTMLElement; move: HTMLElement; edit: HTMLElement; twisty: HTMLElement; name: HTMLElement; body: HTMLElement; key: string; id: number; sub: Row["filter"] | null }

/** The list fills the height it is given (the whole WavePlug 图层 panel); `tools` adds the 智能对象
 *  tools to the right-click menu. */
export function createLayerTreeView(tree: LayerTree, status: Status, tools?: LayerTools) {
  let docId: number | null = null, layers: TreeLayer[] = [], users = new Map<string, number>(), canvas = { width: 0, height: 0 };
  let selected = new Set<number>(), rows: Row[] = [], filter: Filter = "all", anchor: number | null = null;
  /** collapsed groups per document; groups start collapsed */
  const expandedByDoc = new Map<number, Set<number>>();
  const expanded = () => { if (docId === null) return new Set<number>(); let s = expandedByDoc.get(docId); if (!s) expandedByDoc.set(docId, s = new Set()); return s; };
  let collapsed = new Set<number>();
  /** the last selection the panel asked for, so its echo from Photoshop doesn't scroll the list */
  let ownSelect: string | null = null;
  /** smart objects whose filters are folded away (shown by default, like Photoshop), per document */
  /** layers whose effects / smart filters are shown (folded by default), per document */
  const openByDoc = new Map<number, Set<number>>();
  const openSubs = () => { const id = docId ?? -1; let s = openByDoc.get(id); if (!s) openByDoc.set(id, s = new Set()); return s; };
  const thumbsByDoc = new Map<number, ThumbCache>();
  const thumbs = () => { const id = docId ?? -1; let c = thumbsByDoc.get(id); if (!c) thumbsByDoc.set(id, c = new ThumbCache()); return c; };
  // Double-clicks act by where they land: the thumbnail opens 图层样式, the status icons open a
  // smart object's content; elsewhere they do nothing. A press on either part marks `downZone` before
  // the row sees it.
  type Zone = "thumb" | "status" | "name" | "variant" | "filter";
  let downZone: Zone | null = null;
  /** where on the row the last left / right press was (its click acts on that part) */
  let pressZone: Zone | null = null;
  /** the mask shown alone / in red after an Alt+click on it */
  let maskView: { id: number; overlay: boolean; filter?: boolean } | null = null;
  /** a press on an eye (or a 可移动 / 可编辑 switch) switches it; dragging switches every row from the
   *  pressed one to the one under the pointer (rows a fast move skips included), and dragging back puts
   *  the rows left behind as they were. Sent to Photoshop as one call when the button comes up.
   *  `orig`: each touched row's state before the press. */
  /** what of the active layer Photoshop paints on (its pixels unless a mask was clicked); framed in
   *  green on every selected layer */
  let focus: { id: number; part: TargetPart } | null = null;
  const partOf = (id: number): TargetPart => focus?.id === id ? focus.part : "layer";
  const framed = (l: TreeLayer): TargetPart | null => selected.has(l.id) ? partOf(l.id) : null;
  /** a click on a thumbnail: that part becomes the one painted on (the layer selected alone) */
  function targetPart(id: number, part: TargetPart) {
    const same = selected.size === 1 && selected.has(id) && partOf(id) === part;
    selected = new Set([id]); anchor = id;
    focus = { id, part };
    for (const r of pool) if (r.id === id) r.key = "";
    render();
    if (same && part !== "layer") return;
    void run(part === "layer" ? "targetLayer" : part === "mask" ? "targetMask" : part === "vmask" ? "targetVectorMask" : "targetFilterMask", [id]);
  }
  /** 删除 (toolbar, menu, Delete key): the targeted mask when one is, else the selected layers */
  function deleteSelected() {
    const ids = [...selected], l = ids.length === 1 ? layers.find(x => x.id === ids[0]) : undefined;
    const part = l ? framed(l) : null;
    if (l && part && part !== "layer") {
      focus = null;
      void run(part === "mask" ? "deleteMask" : part === "vmask" ? "deleteVectorMask" : "deleteFilterMask", ids);
    } else if (ids.length) void run("delete", ids);
  }
  // Delete / Backspace: like the trash button, while the panel was the last thing clicked (the main
  // panel shares this document) and no text field has the keys
  let panelActive = false;
  document.addEventListener("mousedown", e => { panelActive = el.contains(e.target as Node); }, true);
  document.addEventListener("keydown", e => {
    const k = (e as KeyboardEvent).key, t = e.target as HTMLElement | null;
    if ((k !== "Delete" && k !== "Backspace") || !panelActive || docId === null || renaming !== null) return;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    deleteSelected();
  });
  /** the open document across sessions (custom colours are kept by it) */
  let docKey = "";
  const customOf = (id: number): string | undefined => customColors[docKey]?.[id];
  /** what a layer's (and its masks') thumbnail shows, as in Photoshop: its artboard, or the whole canvas */
  function areaOf(l: TreeLayer): { left: number; top: number; right: number; bottom: number } {
    const b = boardOf.get(l.id), board = b === undefined ? undefined : layers.find(x => x.id === b);
    if (board?.board) return board.board;
    if (board && board.width > 0 && board.height > 0) return { left: board.left, top: board.top, right: board.left + board.width, bottom: board.top + board.height };
    return { left: 0, top: 0, right: Math.max(1, canvas.width), bottom: Math.max(1, canvas.height) };
  }
  /** a thumbnail box as wide as its area's shape needs at the row's height (½ to 2 × the height) */
  function thumbW(l: TreeLayer): number {
    const a = areaOf(l), t = SIZES[size].thumb;
    return Math.round(t * Math.min(2, Math.max(0.5, (a.right - a.left) / Math.max(1, a.bottom - a.top))));
  }
  /** the row under the pointer (see the row's mouseover) */
  let hoverEl: HTMLElement | null = null;
  let paint: { col: "eye" | "position" | "pixels"; to: boolean; start: number; orig: Map<number, boolean>; group?: boolean } | null = null;
  /** the last left press on a row, and when a double-click last acted (the native dblclick may follow) */
  let lastDown: { id: number; at: number; zone: Zone | null } | null = null, doubleAt = 0;
  const onDouble = (id: number, zone: Zone) => {
    if (Date.now() - doubleAt < 800) return;
    const l = layers.find(x => x.id === id);
    if (!l || (zone === "status" && l.kind !== "smartObject") || (zone === "variant" && !isVariantLayer(l))) return;
    doubleAt = Date.now();
    // a variant layer's ✦ (on its picture) opens / closes its variations under it
    if (zone === "variant") { toggleGroup(id); return; }
    if (zone === "name") setTimeout(() => startRename(id), 0);
    else if (zone === "thumb" && l.artboard) setTimeout(() => openColorMenu(id), 0);
    else void run(zone === "thumb" ? "layerStyle" : "editContents", [id]);
  };
  /** marks presses on `el` as `zone` and takes the native double-click there */
  const zoneOf = (el: HTMLElement, id: number, zone: Zone) => {
    // the innermost part pressed wins (✦ on a picture)
    el.addEventListener("mousedown", () => { downZone ??= zone; });
    el.addEventListener("dblclick", () => onDouble(id, zone));
    return el;
  };
  const selectedLayers = () => layers.filter(l => selected.has(l.id));

  // 悬停定位: resting on a row selects its layer in Photoshop (no history step), so the canvas marks
  // it (变换控件 of the move tool, or 图层边缘); leaving the list or pressing a row puts the list's
  // selection back. Meanwhile the list keeps showing its own selection (`peekHold`).
  let peek: number | null = null, peekHold = false, peekTimer: ReturnType<typeof setTimeout> | null = null;
  let peekWork: Promise<void> = Promise.resolve();
  const peekQueue = (fn: () => Promise<void>) => (peekWork = peekWork.then(fn).catch(e => log("warn", "layer peek", e)));
  const peekAt = (id: number) => {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
    if (!peekOn || drag || docId === null || id === peek) return;
    peekTimer = setTimeout(() => {
      peekTimer = null;
      const d = docId;
      if (d === null || drag || (peek === null && selected.size === 1 && selected.has(id))) return;
      peek = id; peekHold = true;
      // a row passed over before Photoshop got to it is skipped
      void peekQueue(async () => { if (peek === id) await tree.select(d, [id]); });
    }, PEEK_DELAY);
  };
  /** ends the preview; `restore`: put the list's selection back in Photoshop (else the caller selects) */
  const endPeek = (restore = true): Promise<void> => {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
    if (peek === null) return peekWork;
    peek = null;
    const d = docId, ids = layers.filter(l => selected.has(l.id)).map(l => l.id);
    if (!restore || d === null) { peekHold = false; return peekWork; }
    return peekQueue(() => tree.select(d, ids)).then(() => { if (peek === null && peekHold) { peekHold = false; void refresh(); } });
  };

  const countEl = h("span", { class: "muted small" });
  /** 属性: what the selected layer is, in small type under the title */
  const infoEl = h("div", { class: "lt-info" });
  /** shared contents and their colour; the layers linked with the selection */
  let cols = new Set<Col>(), colsKey = "";
  /** contents of the selected smart objects: only their instances show their colour */
  /** layers inside a fully locked group (their own locks wait until the group is unlocked) */
  let groupLocked = new Set<number>();
  let activeContents = new Set<string>(), groupColor = new Map<number, number>();
  /** 画板: the artboard each layer is on, and each artboard's frame colour */
  let boardOf = new Map<number, number>(), boardColor = new Map<number, string>();
  const sharedColor = (l: TreeLayer) => { const c = l.smart?.contentId; return c && activeContents.has(c) ? colors.get(c) : undefined; };
  let colors = new Map<string, number>(), peers = new Set<number>(), peerList: number[] = [], peerAt = 0;
  const peersBtn = h("button", { class: "lt-peers", title: "选中的图层和这些图层链接在一起：单击依次定位" });
  peersBtn.addEventListener("click", () => {
    if (!peerList.length) return;
    const id = peerList[peerAt++ % peerList.length];
    if (filter !== "all") filter = "all";
    for (const g of ancestors(layers, id)) expanded().add(g);
    render();
    scrollTo(id, true);
  });
  // 缩略图 size: 无 / 小 / 中 / 大 (rows, thumbnails and icons together)
  const sizeBtns = (Object.keys(SIZES) as Size[]).map(k => {
    const b = h("button", { class: "lt-size-btn" + (k === "off" ? " first" : ""), title: k === "off" ? "不显示缩略图，只显示类型图标" : `缩略图：${SIZES[k].label}（行高、缩略图和图标一起变）` }, SIZES[k].label);
    b.addEventListener("click", () => setSize(k));
    return b;
  });
  const thumbBtn = h("div", { class: "lt-size" }, h("span", { class: "lt-size-label" }, "缩略图"), ...sizeBtns);
  const renderThumbBtn = () => (Object.keys(SIZES) as Size[]).forEach((k, i) => sizeBtns[i].classList.toggle("on", k === size));
  function setSize(k: Size) {
    if (k === size) return;
    const grew = SIZES[k].thumb > SIZES[size].thumb;
    size = k; ROW = SIZES[k].row; SHORT = SIZES[k].short; thumbsOn = k !== "off";
    try { localStorage.setItem("wp.layers.size", k); } catch { /* not kept */ }
    for (const c of ["off", "s", "m", "l"]) list.classList.toggle("sz-" + c, c === k);
    // bigger boxes want sharper pictures: read again (smaller ones just shrink what is there)
    if (grew) for (const c of thumbsByDoc.values()) c.invalidate("all");
    renderThumbBtn();
    for (const r of pool) r.key = "";
    render();
  }
  renderThumbBtn();
  const peekBtn = h("button", { class: "lt-head-btn", title: "悬停定位：鼠标停在一行上，就在 PS 里临时选中这个图层，画布上会框出它（需要移动工具勾选「显示变换控件」，或打开「视图 › 显示 › 图层边缘」）；移开后恢复原来的选中" }, "悬停定位");
  const renderPeekBtn = () => peekBtn.classList.toggle("off", !peekOn);
  peekBtn.addEventListener("click", () => {
    peekOn = !peekOn;
    try { localStorage.setItem("wp.layers.peek", peekOn ? "on" : "off"); } catch { /* not kept */ }
    renderPeekBtn();
    if (!peekOn) void endPeek();
  });
  renderPeekBtn();
  const openAll = h("button", { class: "lt-head-btn", title: "展开所有图层组" }, "展开");
  const closeAll = h("button", { class: "lt-head-btn", title: "折叠所有图层组" }, "折叠");
  openAll.addEventListener("click", () => { for (const l of layers) if (l.kind === "group") expanded().add(l.id); render(); });
  closeAll.addEventListener("click", () => { expanded().clear(); render(); });

  // 搜索 and 类型: Photoshop's kind filter, with a name search beside it
  const query = { text: "", kinds: new Set<LayerKind>() };
  const searchBox = h("input", { class: "field lt-search", type: "text", placeholder: "搜索图层名" }) as HTMLInputElement;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchBox.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query.text = searchBox.value; firstRow = 0; render(); }, 150);
  });
  searchBox.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Escape") { searchBox.value = ""; query.text = ""; render(); } });
  const KINDS: [LayerKind, string, string][] = [
    ["pixel", "image", "像素图层"], ["adjustment", "adjust", "调整 / 填充图层"], ["text", "text", "文字图层"],
    ["shape", "shape", "形状图层"], ["smartObject", "smart", "智能对象"], ["group", "folder", "图层组"],
  ];
  const kindBtns = KINDS.map(([k, ico, tip]) => {
    const b = h("button", { class: "lt-kindbtn", title: "只看" + tip + "（可多选，再点取消）" }, ic(ico, 15));
    b.addEventListener("click", () => { if (query.kinds.has(k)) query.kinds.delete(k); else query.kinds.add(k); firstRow = 0; render(); });
    return b;
  });

  const FILTERS: [Filter, string, string][] = [
    ["all", "全部", "显示所有图层"],
    ["shared", "共用", "只看和其他图层共用内容的智能对象（改一个全部跟着变）"],
    ["uneditable", "不可编辑", "只看内容是图片、矢量文件或外部链接的智能对象（可以用下面的「转为可编辑」）"],
    ["ai", "AI 结果", "只看 WavePlug 生成的结果组"],
  ];
  const filterBtns = FILTERS.map(([f, , tip]) => {
    const b = h("button", { class: "seg-btn lt-filter", title: tip });
    b.addEventListener("click", () => { filter = filter === f && f !== "all" ? "all" : f; firstRow = 0; render(); });
    return b;
  });

  const list = h("div", { class: "lt-list sz-" + size });
  // No scrolling box: UXP didn't paint the content of a scrolled list (rows complete and in place in
  // the log, blank on screen until hovered). The list is a fixed box holding just the rows that fit;
  // scrolling (wheel, our own scrollbar) changes which layers those rows show, whole rows at a time,
  // and a row whose content changes is repainted. `firstRow` is the first row shown.
  let firstRow = 0;
  const inner = h("div", { class: "lt-inner" });
  const sthumb = h("div", { class: "lt-sthumb" });
  const sbar = h("div", { class: "lt-sbar" }, sthumb);
  const empty = h("div", { class: "lt-empty muted" });
  list.append(inner, empty, sbar);
  list.addEventListener("mouseleave", () => { void endPeek(); hoverEl?.classList.remove("hover"); hoverEl = null; });
  const pool: RowEl[] = [];

  function makeRow(): RowEl {
    const eye = h("div", { class: "lt-eye", title: "显示 / 隐藏（Alt+单击：只显示这个图层）" });
    const twisty = h("div", { class: "lt-twisty" });
    const name = h("span", { class: "lt-name" });
    const body = h("div", { class: "lt-body" });
    const stripe = h("div", { class: "lt-stripe" });
    // 可移动 / 可编辑: Photoshop's 锁定位置 / 锁定图像像素, as switches next to the eye
    const move = h("div", { class: "lt-toggle" }), edit = h("div", { class: "lt-toggle" });
    const el = h("div", { class: "lt-row" }, stripe, eye, move, edit, body);
    const r: RowEl = { index: 0, el, eye, move, edit, twisty, name, body, key: "", id: 0, sub: null };
    // double-click on the name renames, as in Photoshop
    name.addEventListener("mousedown", () => { if (!r.sub) downZone = "name"; });
    name.addEventListener("dblclick", () => { if (!r.sub) onDouble(r.id, "name"); });
    const lockDown = (which: "position" | "pixels") => (e: Event) => {
      const m = e as MouseEvent;
      const l = layers.find(x => x.id === r.id);
      if (!l || l.kind === "background" || r.sub || m.button !== 0 || docId === null) return;
      // a group's switch (in the 可移动 place) is its 锁定全部
      if (l.kind === "group" && which === "pixels") return;
      if (groupLocked.has(l.id)) { status("所在的图层组已全部锁定：先解锁外面的图层组", "error"); return; }
      const to = l.kind === "group" ? !l.lockAll : which === "position" ? !l.lockPosition : !l.lockPixels;
      // a group's switch locks all of it: a drag switches groups only when it started on one, layers otherwise
      paint = { col: which, to, start: r.index, orig: new Map(), group: l.kind === "group" };
      paintTo(r.index);
    };
    move.addEventListener("mousedown", lockDown("position"));
    edit.addEventListener("mousedown", lockDown("pixels"));
    eye.addEventListener("click", e => {
      e.stopPropagation();
      const s = r.sub;
      if (s?.kind === "effects" && s.line || s?.kind === "variants") return;
      if (s?.kind === "effects") {
        if (!s.index) void run("toggleEffects", [r.id], s.enabled ? "off" : "on");
        else void run("toggleEffect", [r.id], JSON.stringify({ key: s.effect!.key, multi: s.effect!.multi, on: !s.enabled }));
      } else if (s) void run("toggleFilter", [r.id], JSON.stringify({ index: s.index }));
      else if ((e as MouseEvent).altKey) void run("solo", [r.id]);
    });
    eye.addEventListener("mousedown", e => {
      const m = e as MouseEvent;
      if (r.sub || m.button !== 0 || m.altKey || docId === null) return;
      const l = layers.find(x => x.id === r.id);
      if (!l) return;
      paint = { col: "eye", to: !l.visible, start: r.index, orig: new Map() };
      paintTo(r.index);
    });
    // anywhere on a row: the pointer may leave the column a little while dragging
    el.addEventListener("mouseover", () => {
      if (paint) paintTo(r.index);
      // hover drawn by a class: UXP keeps :hover on rows a drag went over
      if (hoverEl !== el) { hoverEl?.classList.remove("hover"); hoverEl = el; }
      el.classList.add("hover");
    });
    twisty.addEventListener("click", e => { e.stopPropagation(); toggleGroup(r.id); });
    for (const x of [eye, move, edit, twisty]) x.addEventListener("mousedown", e => e.stopPropagation());
    for (const x of [move, edit]) x.addEventListener("click", e => e.stopPropagation());
    // A double-click is told from two presses on the same part of the row (the first click re-draws
    // the row, which can swallow the second click event) and from the native dblclick on that part,
    // whichever comes first.
    el.addEventListener("mousedown", e => {
      void endPeek();
      // Ctrl+click on the thumbnail / type icon: the layer's pixels as the selection, like Photoshop
      // (+Shift add, +Alt subtract, +Shift+Alt intersect); the layer selection stays as it is
      const pressed = e as MouseEvent;
      if (downZone === "thumb" && !r.sub && pressed.button === 0 && (pressed.ctrlKey || pressed.metaKey)) {
        downZone = null; lastDown = null;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 300);
        // a shape layer: its shape (stored as its vector mask), as Photoshop does
        loadSelection(r.id, layers.find(x => x.id === r.id)?.kind === "shape" ? "vector" : false, pressed);
        return;
      }
      // an artboard's row: a double-click anywhere but its name picks its frame colour
      const m = e as MouseEvent, zone = downZone ?? (r.sub?.kind === "effects" || (!r.sub && layers.find(x => x.id === r.id)?.artboard) ? "thumb"
        : r.sub?.kind === "filters" && r.sub.index > 0 ? "filter" : null);
      downZone = null;
      pressZone = zone;
      if (m.button === 2) { openRowMenu(r.id); return; }
      if (m.button !== 0) return;
      const now = Date.now();
      if (zone && lastDown && lastDown.id === r.id && lastDown.zone === zone && now - lastDown.at < DOUBLE_CLICK && !m.ctrlKey && !m.metaKey && !m.shiftKey) {
        lastDown = null;
        drag = null;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, DOUBLE_CLICK);
        // a smart filter: that filter's dialog again
        if (zone === "filter" && r.sub) { void run("editFilter", [r.id], JSON.stringify({ pos: r.sub.index - 1 })); return; }
        onDouble(r.id, zone);
        return;
      }
      lastDown = { id: r.id, at: now, zone };
      // a smart filter can be dragged (reordered, or onto another smart object); other sub rows only select
      if (!r.sub) startDrag(r.id, m);
      else if (r.sub.kind === "filters" && r.sub.index > 0) startDrag(r.id, m, { pos: r.sub.index - 1, row: r.index });
    });
    el.addEventListener("mouseover", () => peekAt(r.id));
    el.addEventListener("contextmenu", e => e.preventDefault());
    el.addEventListener("click", e => {
      if (suppressClick) return;
      const m = e as MouseEvent;
      // the layer's own thumbnail while one of its masks is painted on: back to its pixels
      const l = r.sub ? undefined : layers.find(x => x.id === r.id);
      if (l && pressZone === "thumb" && !m.ctrlKey && !m.metaKey && !m.shiftKey && partOf(l.id) !== "layer") { targetPart(l.id, "layer"); return; }
      void clickRow(r.id, { ctrl: m.ctrlKey || m.metaKey, shift: m.shiftKey });
    });
    inner.append(el);
    return r;
  }

  /** A smart filter row: the 智能滤镜 row (all of them) or one filter, under its smart object. */
  function fillFilter(r: RowEl, row: Row, index: number) {
    const l = row.layer, f = row.filter!, sel = selected.has(l.id), fx = f.kind === "effects";
    const allOn = fx ? l.effectsOn : l.filtersOn;
    const moving = !!drag?.active && !!drag.filter && drag.filter.layerId === l.id && drag.filter.pos === f.index - 1 && !fx;
    // effects may take several lines of chips: only the first has the eye and the fx mark
    const more = fx && !!f.line;
    const key = ["f", f.kind, l.id, f.index ? "" : framed(l), l.filterMask, maskView?.id === l.id && maskView.filter, f.index, f.name, f.enabled, allOn, l.depth, sel, moving, f.line, (f.chips ?? []).join(), fx ? l.effectList.map(e => e.name + +e.enabled).join() : ""].join("|");
    r.index = index;
    setShown(r.el, true);
    if (key === r.key) return;
    r.key = key; r.id = l.id; r.sub = f;
    const shown = f.enabled && (f.index === 0 || allOn);
    r.el.className = "lt-row lt-filter-row" + (sel ? " on" : "") + (shown ? "" : " off") + (moving ? " moving" : "") + (r.el === hoverEl ? " hover" : "");
    (r.el.firstChild as HTMLElement).className = "lt-stripe";
    replace(r.eye, f.enabled && !more ? ic("eye", 14) : null);
    r.eye.className = "lt-eye" + (more ? " none" : f.enabled ? "" : " hidden");
    r.eye.style.backgroundColor = "";
    r.eye.title = fx ? (f.index ? (f.enabled ? "隐藏这个效果" : "显示这个效果") : (f.enabled ? "隐藏全部效果" : "显示全部效果"))
      : f.index ? (f.enabled ? "隐藏这个滤镜" : "显示这个滤镜") : (f.enabled ? "隐藏全部智能滤镜" : "显示全部智能滤镜");
    replace(r.move); r.move.className = "lt-toggle"; r.move.title = "";
    replace(r.edit); r.edit.className = "lt-toggle"; r.edit.title = "";
    replace(r.name, f.name);
    r.name.className = "lt-name";
    replace(r.body, h("div", { class: "lt-indent" }, ...Array.from({ length: l.depth + (f.index ? 2 : 1) }, () => h("span", { class: "lt-guide" }))),
      fx ? h("div", { class: "lt-mark" }, more ? null : h("span", { class: "lt-kind k-fx" }, "fx"))
        : f.index ? h("div", { class: "lt-mark" }, h("span", { class: "lt-kind k-filter" }, ic("sliders", 13)))
        : h("div", { class: "lt-mark has-thumb" }, filterMaskCell(l)),
      fx ? effectChips(l, f.chips ?? l.effectList.map((_, i) => i)) : r.name);
    r.el.title = fx ? (f.index ? `图层样式：${f.name}（双击打开图层样式）` : `${l.name} 的图层样式（双击打开）`)
      : f.index ? `智能滤镜：${f.name}（双击：重新打开设置；可拖动调整顺序，或拖到别的智能对象上）` : `${l.name} 的智能滤镜（${l.filters.length} 个）`;
  }

  /** Effect chips need more than one line when they don't fit: the effects row becomes as many rows
   *  as it takes (fixed-height rows keep the list virtual). Chip widths are estimated from their text. */
  function layoutEffects(rs: Row[]): Row[] {
    const w = list.clientWidth || 300;
    const chipW = (name: string) => 16 + [...name].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 11.5 : 7), 0);
    return rs.flatMap(r => {
      if (r.filter?.kind === "variants") {
        const avail = w - LEAD - (r.layer.depth + 1) * INDENT - 10;
        // by number (v1 first), as the main panel lists them
        const num = (id: number) => Number(/^v(\d+)/.exec(layers.find(x => x.id === id)?.name ?? "")?.[1] ?? 0);
        const ids = r.layer.ai!.ids, order = ids.map((_, i) => i).sort((a, b) => num(ids[a]) - num(ids[b]));
        const lines = packChips(order.map(() => VCHIP_W), avail);
        return lines.map((chips, line) => ({ ...r, filter: { ...r.filter!, line, chips: chips.map(k => order[k]) } }));
      }
      if (r.filter?.kind !== "effects") return [r];
      const avail = w - LEAD - (r.layer.depth + 1) * INDENT - 22 - 10;
      const lines = packChips(r.layer.effectList.map(e => chipW(e.name)), avail);
      return lines.map((chips, line) => ({ ...r, filter: { ...r.filter!, line, chips } }));
    });
  }

  /** 图层样式 on one row: each effect a chip, click to switch it, double-click for the dialog */
  function effectChips(l: TreeLayer, places: number[]): HTMLElement {
    return h("div", { class: "lt-chips" }, ...places.map(i => l.effectList[i]).map(e => {
      const chip = h("span", { class: "lt-chip" + (e.enabled && l.effectsOn ? "" : " off"), title: `${e.name}：单击${e.enabled ? "隐藏" : "显示"}，双击打开图层样式` }, e.name);
      // A press waits a moment: a second press makes it a double-click (edit), not two switches. Told
      // from the presses, as UXP can lose the second click event; the native dblclick backs it up.
      let pending: ReturnType<typeof setTimeout> | null = null, editedAt = 0;
      const edit = () => {
        if (pending) { clearTimeout(pending); pending = null; }
        if (Date.now() - editedAt < DOUBLE_CLICK) return;
        editedAt = Date.now();
        void run("effectStyle", [l.id], JSON.stringify({ key: e.key, multi: e.multi }));
      };
      chip.addEventListener("mousedown", ev => {
        ev.stopPropagation();
        const m = ev as MouseEvent;
        if (m.button !== 0) return;
        if (pending) { edit(); return; }
        pending = setTimeout(() => { pending = null; void run("toggleEffect", [l.id], JSON.stringify({ key: e.key, multi: e.multi, on: !e.enabled })); }, CHIP_DOUBLE);
      });
      chip.addEventListener("click", ev => ev.stopPropagation());
      chip.addEventListener("dblclick", ev => { ev.stopPropagation(); edit(); });
      return chip;
    }));
  }

  /** A variant layer's variations, each a small picture with its number (the shown one marked):
   *  a click shows that one. Several lines when they don't fit, like effect chips. */
  function fillVariants(r: RowEl, row: Row, index: number) {
    const l = row.layer, f = row.filter!, ai = l.ai!, sel = selected.has(l.id);
    const places = f.chips ?? ai.ids.map((_, i) => i);
    const key = ["v", l.id, f.line, places.join(), ai.ids.join(), ai.shown, l.depth, sel, thumbsOn, ...places.map(i => thumbs().version(ai.ids[i]))].join("|");
    r.index = index;
    setShown(r.el, true);
    if (key === r.key) return;
    r.key = key; r.id = l.id; r.sub = f;
    r.el.className = "lt-row lt-filter-row lt-variant-row" + (sel ? " on" : "") + (r.el === hoverEl ? " hover" : "");
    (r.el.firstChild as HTMLElement).className = "lt-stripe";
    replace(r.eye); r.eye.className = "lt-eye none"; r.eye.title = ""; r.eye.style.backgroundColor = "";
    replace(r.move); r.move.className = "lt-toggle"; r.move.title = "";
    replace(r.edit); r.edit.className = "lt-toggle"; r.edit.title = "";
    replace(r.body, h("div", { class: "lt-indent" }, ...Array.from({ length: l.depth + 1 }, () => h("span", { class: "lt-guide" }))),
      h("div", { class: "lt-chips" }, ...places.map(i => variantChip(l, i))));
    r.el.title = `${l.name} 的变体：单击换成那一个，× 删除`;
  }

  function variantChip(l: TreeLayer, i: number): HTMLElement {
    const ai = l.ai!, id = ai.ids[i], on = id === ai.shown, url = thumbsOn ? thumbs().get(id) : undefined;
    const name = layers.find(x => x.id === id)?.name ?? "";
    const num = /^v(\d+)/.exec(name)?.[1] ?? String(i + 1);
    // × shows on the chip under the mouse (its room is always kept, so nothing moves)
    const del = h("span", { class: "lt-vdel", title: `删除 v${num}（可撤销）` }, ic("close", 9));
    del.addEventListener("click", e => { e.stopPropagation(); void run("deleteVariant", [l.id], String(id)); });
    const chip = h("span", { class: "lt-vchip" + (on ? " on" : ""), title: name + (on ? "（当前显示）" : "\n单击：换成这个变体") },
      thumbsOn ? h("span", { class: "lt-vpic" }, url ? thumbImg(url) : null) : null, "v" + num, del);
    chip.addEventListener("mousedown", e => e.stopPropagation());
    chip.addEventListener("click", e => { e.stopPropagation(); if (!on) void run("showVariant", [l.id], String(id)); });
    return chip;
  }

  function fill(r: RowEl, row: Row, index: number) {
    if (row.filter?.kind === "variants") { fillVariants(r, row, index); return; }
    if (row.filter) { fillFilter(r, row, index); return; }
    // filtered lists show every match whatever is collapsed; a smart object's twisty folds its filters
    const l = row.layer, sel = selected.has(l.id), vl = isVariantLayer(l);
    // groups fold their layers; other layers fold their effects and smart filters; a variant layer
    // (an AI group shown as one layer) its variations
    const subs = vl || l.kind !== "group" && (l.filters.length > 0 || l.effectList.length > 0);
    const open = l.kind !== "group" || vl ? openSubs().has(l.id) : filter !== "all" || !collapsed.has(l.id);
    // a variant layer's picture is its shown variation's
    const shown = vl && thumbsOn ? l.ai!.shown : null;
    const moving = !!drag?.active && drag.ids.includes(l.id), thumb = shown !== null ? thumbs().get(shown) : hasThumb(l) ? thumbs().get(l.id) : undefined;
    const maskThumb = l.mask && thumbsOn ? thumbs().get(maskKey(l.id)) : undefined;
    const vmaskThumb = l.vmask && thumbsOn ? thumbs().get(vmaskKey(l.id)) : undefined;
    const key = [l.id, l.name, l.visible, l.locked, l.lockAll, l.lockPosition, l.lockPixels, l.lockTransparency, groupLocked.has(l.id), l.links.length, peers.has(l.id), sharedColor(l), l.mask, l.maskOn, l.clipped, l.clipBase, l.effects, l.effectsOn, l.depth, l.children, l.ai?.variations, l.smart?.contentId, l.smart?.linked, l.smart?.file, l.filters.length, l.filtersOn, l.effectList.map(e => +e.enabled).join(""), groupColor.get(l.id),
      users.get(l.smart?.contentId ?? "") ?? 0, sel, open, row.context, moving, thumbs().version(l.id), thumbs().version(maskKey(l.id)), thumbs().version(vmaskKey(l.id)), l.vmask, l.vmaskOn, l.maskLinked, l.vmaskLinked, l.color, customOf(l.id), maskView?.id === l.id, hasPicture(l), framed(l), thumbW(l), shown, shown !== null ? thumbs().version(shown) : 0, l.ai?.shown, colsKey].join("|");
    r.index = index;
    setShown(r.el, true);
    if (key === r.key) return;
    r.key = key; r.id = l.id; r.sub = null;
    // a closed group shows the colour of the selected content's copies inside it
    const inside = l.kind === "group" && !open ? groupColor.get(l.id) : undefined;
    const color = sharedColor(l) ?? inside, peer = peers.has(l.id);
    // the other copies of the selected content, and the layers linked with the selection, in a paler
    // shade of the selection's green (a closed group holding a copy, paler still)
    const tint = sel ? "" : sharedColor(l) !== undefined || peer ? " peer" : inside !== undefined ? " peer inside" : "";
    r.el.className = "lt-row" + (l.kind === "group" && !vl ? " group" : "") + (sel ? " on" : "") + (row.context ? " context" : "") + (l.visible ? "" : " off") + (moving ? " moving" : "") + tint + (r.el === hoverEl ? " hover" : "");
    (r.el.firstChild as HTMLElement).className = "lt-stripe";
    replace(r.eye, l.visible ? ic("eye", 14) : null);
    r.eye.className = "lt-eye" + (l.visible ? "" : " hidden");
    r.eye.style.backgroundColor = labelTint(l, customOf(l.id));
    // groups lock only as a whole (锁定全部), like Photoshop: their switch sits in front of the folder;
    // their layers then show it
    const group = l.kind === "group", bare = l.kind === "background" || group, byGroup = groupLocked.has(l.id);
    if (group) {
      replace(r.move, ic("lock", 13));
      r.move.className = "lt-toggle lt-grouplock" + (byGroup ? " inherit" : l.lockAll ? " on" : "");
      r.move.title = byGroup ? "外面的图层组已全部锁定" : l.lockAll ? "图层组已全部锁定：单击解锁" : "单击锁定整个图层组";
    } else {
      replace(r.move, bare ? null : ic("move", 13));
      r.move.className = "lt-toggle" + (bare ? "" : byGroup ? " inherit" : l.lockPosition ? " off" : "");
      r.move.title = bare ? "" : byGroup ? "所在的图层组已全部锁定" : l.lockPosition ? "位置已锁定：单击解锁" : "可移动：单击锁定位置";
    }
    replace(r.edit, bare ? null : ic("brush", 13));
    r.edit.className = "lt-toggle" + (bare ? "" : byGroup ? " inherit" : l.lockPixels ? " off" : "");
    r.edit.title = bare ? "" : byGroup ? "所在的图层组已全部锁定" : l.lockPixels ? "图像像素已锁定：单击解锁" : "可编辑：单击锁定图像像素";
    // a variant layer opens its variations from the ✦ on its picture, not a twisty
    const folds = vl ? false : l.kind === "group" ? l.children > 0 : subs;
    replace(r.twisty, folds ? (open ? "▾" : "▸") : "");
    r.twisty.title = !folds ? "" : vl ? (open ? "收起变体" : "展开变体") : l.kind === "group" ? (open ? "折叠" : "展开") : (open ? "收起效果和智能滤镜" : "展开效果和智能滤镜");
    replace(r.name, l.name);
    r.name.className = "lt-name" + (l.clipBase ? " clip-base" : "");
    const pictured = hasPicture(l) || shown !== null;
    const mark = pictured
      ? h("div", { class: "lt-thumb" + (framed(l) === "layer" ? " lt-target" : ""), style: `width: ${thumbW(l)}px` }, thumb ? thumbImg(thumb) : null,
        l.kind === "shape" || l.kind === "fill" ? h("span", { class: "lt-badge k-" + l.kind, title: KIND_ICON[l.kind][1] }, ic(KIND_ICON[l.kind][0], 10))
          : vl ? zoneOf(h("span", { class: "lt-badge k-variant", title: `变体图层 · ${l.ai!.variations} 个变体\n双击：打开变体栏` }, ic("spark", 10)), l.id, "variant")
          : smartBadge(l, color))
      : kindIcon(l, open);

    // one guide line per level, continuing from row to row like Blender's outliner
    replace(r.body, h("div", { class: "lt-indent" }, ...Array.from({ length: l.depth }, () => h("span", { class: "lt-guide" }))), r.twisty,
      l.clipped ? h("div", { class: "lt-clip", title: "剪贴到下方图层（剪贴蒙版）" }, ic("clip", 13)) : null,
      zoneOf(h("div", { class: "lt-mark" + (pictured ? " has-thumb" : ""), style: pictured ? `width: ${thumbW(l) + 2}px` : "", title: "双击：图层样式；Ctrl+单击：载入选区（+Shift 添加，+Alt 减去）" }, mark), l.id, "thumb"),
      // as in Photoshop: picture ⛓ layer mask ⛓ vector mask, each chain its mask's link
      l.mask ? maskChain(l, false) : null,
      l.mask ? maskCell(l, maskThumb) : null,
      l.vmask ? maskChain(l, true) : null,
      l.vmask ? vmaskCell(l, vmaskThumb) : null,
      r.name,
      ...COLS.filter(c => cols.has(c)).map(c => cell(l, c, color, peer)));
    r.el.title = l.name + (vl ? `（变体图层，${l.ai!.variations} 个变体：双击 ✦ 选择变体；PS 图层面板里是图层组）` : l.kind === "group" ? `（图层组，${l.children} 个图层）` : "") + (l.clipBase ? "（剪贴蒙版的基底图层）" : "");
  }

  /** A smart object's mark on its picture: 独立 / 共用 (in its content's colour) / 外部链接;
   *  double-click opens the content. */
  function smartBadge(l: TreeLayer, color: number | undefined): HTMLElement | null {
    const t = l.kind === "smartObject" ? layerTags(l, users).find(x => x.cls === "own" || x.cls === "shared" || x.cls === "link") : undefined;
    if (!t) return null;
    const what = t.cls === "link" ? "外部链接" : t.cls === "shared" ? "共用内容（同色＝同一份内容）" : "内容独立";
    return zoneOf(h("span", { class: "lt-badge k-smart " + t.cls + (t.cls === "shared" && color !== undefined ? " c" + color : ""), title: `智能对象 · ${what}\n${t.tip}\n双击：打开智能对象内容` },
      ic(t.cls === "link" ? "external" : "smart", 10)), l.id, "status");
  }

  /** The layer mask's thumbnail: click selects the mask for painting, Shift+click turns it off / on. */
  function maskCell(l: TreeLayer, url: string | null | undefined): HTMLElement {
    const cell = h("div", { class: "lt-thumb lt-mask" + (l.maskOn ? "" : " off") + (maskView?.id === l.id && !maskView.filter ? " viewing" : "") + (framed(l) === "mask" ? " lt-target" : ""), style: `width: ${thumbW(l)}px`, title: l.maskOn ? "图层蒙版：单击选中蒙版来编辑，Shift+单击停用，Ctrl+单击载入选区，Alt+单击只看蒙版（Alt+Shift：红色叠加），再按一次恢复" : "图层蒙版已停用：Shift+单击启用，Ctrl+单击载入选区" },
      url ? thumbImg(url) : null);
    cell.addEventListener("mousedown", e => e.stopPropagation());
    cell.addEventListener("click", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      if (m.ctrlKey || m.metaKey) loadSelection(l.id, true, m);
      else if (m.altKey) viewMask(l.id, m.shiftKey);
      else if (m.shiftKey) void run("toggleMask", [l.id], l.maskOn ? "off" : "on");
      else targetPart(l.id, "mask");
    });
    return cell;
  }

  /** The 智能滤镜 mask (white: Photoshop's default shows all): click to paint on it, like Photoshop */
  function filterMaskCell(l: TreeLayer): HTMLElement {
    const cell = h("div", { class: "lt-thumb lt-filter-mask" + (l.filterMask ? "" : " none") + (framed(l) === "filterMask" ? " lt-target" : "") + (maskView?.id === l.id && maskView.filter ? " viewing" : ""),
      title: l.filterMask ? "智能滤镜蒙版：单击选中来编辑（单击图层缩略图回到图层），Ctrl+单击载入选区（+Shift 添加，+Alt 减去），Alt+单击只看蒙版（Alt+Shift：红色叠加），再按一次恢复" : "没有智能滤镜蒙版" });
    if (!l.filterMask) return cell;
    // the same clicks as the layer mask's
    cell.addEventListener("mousedown", e => e.stopPropagation());
    cell.addEventListener("click", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      if (m.ctrlKey || m.metaKey) loadSelection(l.id, "filter", m);
      else if (m.altKey) viewMask(l.id, m.shiftKey, true);
      else targetPart(l.id, "filterMask");
    });
    return cell;
  }

  /** The chain between the picture and the mask: the mask moves with the layer; click to unlink / link. */
  function maskChain(l: TreeLayer, vector: boolean): HTMLElement {
    const on = vector ? l.vmaskLinked : l.maskLinked;
    const cell = h("div", { class: "lt-mlink" + (on ? "" : " off"), title: on ? "蒙版和图层链接在一起（一起移动）：单击取消链接" : "蒙版没有和图层链接：单击链接" }, on ? ic("link", 11) : null);
    cell.addEventListener("mousedown", e => e.stopPropagation());
    cell.addEventListener("click", e => { e.stopPropagation(); void run("toggleMaskLink", [l.id], JSON.stringify({ vector, on: !on })); });
    return cell;
  }

  /** The vector mask's thumbnail: click selects it, Shift+click turns it off / on, Ctrl+click loads its path as the selection. */
  function vmaskCell(l: TreeLayer, url: string | null | undefined): HTMLElement {
    const cell = h("div", { class: "lt-thumb lt-mask lt-vmask" + (l.vmaskOn ? "" : " off") + (framed(l) === "vmask" ? " lt-target" : ""), style: `width: ${thumbW(l)}px`, title: l.vmaskOn ? "矢量蒙版：单击选中，Shift+单击停用，Ctrl+单击载入选区" : "矢量蒙版已停用：Shift+单击启用，Ctrl+单击载入选区" },
      url ? thumbImg(url) : null);
    cell.addEventListener("mousedown", e => e.stopPropagation());
    cell.addEventListener("click", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      if (m.ctrlKey || m.metaKey) loadSelection(l.id, "vector", m);
      else if (m.shiftKey) void run("toggleVectorMask", [l.id], l.vmaskOn ? "off" : "on");
      else targetPart(l.id, "vmask");
    });
    return cell;
  }

  /** Alt+click on a mask: the mask alone in the document window (Alt+Shift: over the picture in red);
   *  the same again goes back */
  function viewMask(id: number, overlay: boolean, filter = false) {
    const was = maskView, which = (f?: boolean) => f ? ":filter" : "";
    if (was && was.id === id && !!was.filter === filter) { maskView = null; void run("viewMask", [id], (was.overlay ? "off-overlay" : "off-alone") + which(was.filter)); }
    else { maskView = { id, overlay, filter }; void run("viewMask", [id], (overlay ? "overlay" : "alone") + which(filter)); }
    for (const r of pool) if (r.id === id) r.key = "";
    render();
  }

  /** 载入选区: the layer's pixels (or its mask) as the selection; Shift adds, Alt subtracts, both intersect */
  function loadSelection(id: number, mask: boolean | "vector" | "filter", m: MouseEvent) {
    const mode = m.shiftKey && m.altKey ? "intersect" : m.shiftKey ? "add" : m.altKey ? "subtract" : "set";
    void run("loadSelection", [id], JSON.stringify({ mode, mask }));
  }

  /** fx: the layer has effects; click opens 图层样式 */
  function fxCell(l: TreeLayer): HTMLElement {
    const cell = h("span", { class: "lt-col col-fx lt-fx" + (l.effectsOn ? "" : " off"), title: l.effectsOn ? "图层样式：单击打开" : "图层样式已隐藏：单击打开" }, "fx");
    cell.addEventListener("mousedown", e => e.stopPropagation());
    cell.addEventListener("click", e => { e.stopPropagation(); void run("layerStyle", [l.id]); });
    return cell;
  }

  /** Whether layer `l` has something to show in column `c`. */
  function cellUsed(l: TreeLayer, c: Col): boolean {
    switch (c) {
      case "content": return !!l.smart?.file;
      case "filters": return l.filters.length > 0;
      case "fx": return l.effects;
      case "chain": return l.links.length > 0;
      case "lock": return l.kind !== "group" && (l.lockAll || l.lockTransparency);
    }
  }

  /** Column `c` of layer `l`: its icon, or a blank of the same width. */
  function cell(l: TreeLayer, c: Col, color: number | undefined, peer: boolean): HTMLElement {
    const box = (cls: string, tip: string, ...kids: (Node | null)[]) => h("span", { class: `lt-col col-${c} ${cls}`, title: tip }, ...kids);
    if (!cellUsed(l, c)) return h("span", { class: `lt-col col-${c}` });
    const tag = (cls: string[]) => layerTags(l, users).find(t => cls.includes(t.cls.split(" ")[0]));
    const count = (n?: number) => n ? h("span", { class: "lt-count" }, String(n)) : null;
    switch (c) {
      case "content": { const t = tag(["edit", "content"])!; return box(t.cls + " " + t.icon, "智能对象内容 · " + t.text + "\n" + t.tip, ic(t.icon, 14)); }
      case "filters": { const t = tag(["filters"])!; return box(t.cls, "智能滤镜（数字＝滤镜个数）\n" + t.tip, ic("filters", 14), count(t.count)); }
      case "fx": return fxCell(l);
      case "chain": return box("lt-chain" + (peer ? " peer" : ""), peer ? "和选中的图层链接在一起" : `和 ${l.links.length} 个图层链接（一起移动、变换）`, ic("link", 13));
      case "lock": return box("lt-lock" + (l.lockAll ? "" : " part"), l.lockAll ? "锁定全部（上方的锁定按钮可以解开）" : "锁定透明像素（上方的锁定按钮可以解开）", ic("lock", 13));
    }
  }



  /** fill(), but a row that fails is still placed and named, and the rest of the list still drawn;
   *  the error goes to the log (once per kind of failure) */
  const fillErrors = new Set<string>();
  function safeFill(r: RowEl, row: Row, index: number) {
    try { fill(r, row, index); }
    catch (e) {
      const msg = String((e as Error)?.stack ?? e).slice(0, 600);
      if (!fillErrors.has(msg)) { fillErrors.add(msg); log("warn", "layer row draw", row.layer.kind, row.filter?.kind ?? "", msg); }
      r.key = ""; r.id = row.layer.id; r.sub = row.filter ?? null;
      r.index = index;
      setShown(r.el, true);
      replace(r.body, h("span", { class: "lt-name" }, row.filter ? row.filter.name : row.layer.name));
    }
  }

  // Rows differ in height (heightOf): positions are added up from `firstRow`.
  /** px from the list's top to row `idx` (negative above `firstRow`) */
  const yOf = (idx: number) => {
    let y = 0;
    for (let i = firstRow; i < idx; i++) y += heightOf(rows[i]);
    for (let i = idx; i < firstRow; i++) y -= heightOf(rows[i]);
    return y;
  };
  /** the row at `y` px from the list's top (clamped to the list) */
  const rowAt = (y: number) => {
    let i = Math.min(Math.max(0, firstRow), Math.max(0, rows.length - 1));
    let top = yOf(i);
    while (y < top && i > 0) { i--; top -= heightOf(rows[i]); }
    while (i < rows.length - 1 && y >= top + heightOf(rows[i])) { top += heightOf(rows[i]); i++; }
    return { idx: i, top };
  };
  const listH = () => list.clientHeight || 12 * ROW;
  /** whole rows that fit from row `from` */
  const fitsFrom = (from: number) => {
    let n = 0, y = 0;
    for (let i = from; i < rows.length; i++) { y += heightOf(rows[i]); if (y > listH()) break; n++; }
    return Math.max(1, n);
  };
  /** rows that fit in the list */
  const fits = () => fitsFrom(firstRow);
  /** the last first row: the bottom rows just fill the list */
  const maxFirst = () => {
    let y = 0, i = rows.length;
    while (i > 0 && y + heightOf(rows[i - 1]) <= listH()) { y += heightOf(rows[i - 1]); i--; }
    return Math.max(0, i);
  };

  /** Fills the rows that fit, from `firstRow`, and sets the scrollbar. */
  function draw() {
    firstRow = Math.max(0, Math.min(firstRow, maxFirst()));
    const first = firstRow, count = fits() + 1;
    while (pool.length < count) pool.push(makeRow());
    for (let i = 0; i < pool.length; i++) {
      const idx = first + i;
      if (i < count && idx < rows.length) { safeFill(pool[i], rows[idx], idx); pool[i].el.classList.toggle("short", isShort(rows[idx])); frame(pool[i].el, idx); }
      else setShown(pool[i].el, false);
    }
    inView = rows.slice(first, first + count).map(r => r.layer);
    // scrollbar: only when there's more than fits
    const more = maxFirst() > 0, H = list.clientHeight || 1;
    setShown(sbar, more);
    inner.classList.toggle("with-bar", more);
    drawBoards(first, count, more);
    if (more) {
      const th = Math.max(24, Math.round(H * fits() / rows.length)), room = H - th;
      sthumb.style.height = th + "px";
      sthumb.style.top = Math.round(room * first / Math.max(1, maxFirst())) + "px";
      sthumb.classList.toggle("a", !sthumb.classList.contains("a"));
    }
    queueThumbs();
  }

  /** 画板: rows on an artboard sit inside its box (drawn over the list by drawBoards); the artboard's
   *  own row is filled with its colour */
  function frame(el: HTMLElement, idx: number) {
    const row = rows[idx], b = boardOf.get(row.layer.id), c = b === undefined ? undefined : boardColor.get(b);
    const head = c !== undefined && row.layer.id === b && !row.filter;
    el.classList.toggle("ab", c !== undefined);
    el.classList.toggle("ab-head", head);
    el.style.backgroundColor = head ? c! : "";
  }
  /** one rounded box per artboard in view, outlined in its colour: a single element over its rows
   *  (no lines between them), open past the list's edge when the artboard goes on above or below */
  const boards: HTMLElement[] = [];
  function drawBoards(first: number, count: number, bar: boolean) {
    const spans: { b: number; from: number; to: number }[] = [];
    for (let idx = first; idx < Math.min(rows.length, first + count); idx++) {
      const b = boardOf.get(rows[idx].layer.id);
      if (b === undefined || !boardColor.has(b)) continue;
      const last = spans[spans.length - 1];
      if (last && last.b === b && last.to === idx - 1) last.to = idx; else spans.push({ b, from: idx, to: idx });
    }
    while (boards.length < spans.length) { const f = h("div", { class: "lt-board" }); boards.push(f); inner.append(f); }
    boards.forEach((f, i) => {
      const sp = spans[i];
      setShown(f, !!sp);
      if (!sp) return;
      const starts = rows[sp.from].layer.id === sp.b && !rows[sp.from].filter;
      const ends = !rows[sp.to + 1] || boardOf.get(rows[sp.to + 1].layer.id) !== sp.b;
      const top = starts ? yOf(sp.from) : -8, bottom = ends ? yOf(sp.to + 1) : listH() + 8;
      f.style.top = top + "px";
      f.style.height = Math.max(0, bottom - top) + "px";
      f.style.right = (bar ? 12 : 2) + "px";
      f.style.borderColor = boardColor.get(sp.b)!;
    });
  }

  /** Scrolls by `n` rows (negative: up). */
  function scrollRows(n: number) {
    const before = firstRow;
    firstRow = Math.max(0, Math.min(firstRow + n, maxFirst()));
    if (firstRow !== before) draw();
  }






  // ── thumbnails: the rows in view, a few per Photoshop call, after scrolling settles ──
  /** thumbnails Photoshop failed to give: how often, and when to ask again */
  const failures = new Map<number, number>(), retryAt = new Map<number, number>();
  let inView: TreeLayer[] = [], thumbTimer: ReturnType<typeof setTimeout> | null = null, fetching = false;
  function queueThumbs(delay = 150) {
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => { thumbTimer = null; void fetchThumbs(); }, delay);
  }
  async function fetchThumbs() {
    // nothing to do while the list isn't on screen (another page, a hidden panel) or a drag runs
    if (fetching || docId === null || drag?.active || !list.clientHeight) return;
    const now = Date.now();
    // a variant layer: its shown variation, all of them while they are listed
    const variants = (l: TreeLayer) => !thumbsOn || !isVariantLayer(l) ? [] : openSubs().has(l.id) ? l.ai!.ids : l.ai!.shown !== null ? [l.ai!.shown] : [];
    const keys = [...new Set(inView.flatMap(l => [...hasThumb(l) ? [l.id] : [], ...variants(l), ...l.mask && thumbsOn ? [maskKey(l.id)] : [], ...l.vmask && thumbsOn ? [vmaskKey(l.id)] : []]))].filter(k => (retryAt.get(k) ?? 0) <= now);
    const want = thumbs().next(keys, THUMB_BATCH);
    if (!want.length) return;
    const doc = docId, cache = thumbs(), byId = new Map(layers.map(l => [l.id, l]));
    // a thumbnail shows the layer's artboard, or the canvas (core/layers/thumbs.ts thumbArea)
    const items = want.filter(k => byId.has(keyLayer(k))).map(k => {
      const bounds = areaOf(byId.get(keyLayer(k))!);
      return k <= -VKEY ? { key: k, id: keyLayer(k), mask: "vector" as const, bounds } : k < 0 ? { key: k, id: -k, mask: true, bounds } : { key: k, id: k, bounds };
    });
    fetching = true;
    try {
      const urls = await tree.thumbnails(doc, items.map(({ key: _, ...x }) => x), canvas, thumbPx());
      items.forEach((x, i) => {
        const url = urls[i];
        if (url !== undefined) { cache.put(x.key, url); failures.delete(x.key); retryAt.delete(x.key); return; }
        // Photoshop was busy: try again in a few seconds, and give up after a few tries
        const n = (failures.get(x.key) ?? 0) + 1;
        failures.set(x.key, n);
        if (n >= 3) cache.put(x.key, null); else retryAt.set(x.key, Date.now() + 2500 * n);
      });
      if (retryAt.size) setTimeout(() => queueThumbs(0), 2600);
      if (doc === docId) draw();
    } catch (e) {
      // Photoshop is busy with something modal: try again a little later
      log("info", "layer thumbnails", e);
      fetching = false;
      queueThumbs(1500);
      return;
    }
    fetching = false;
    queueThumbs(0);
  }
  // a mask or the pixels targeted in Photoshop's own panel: on the (first) selected layer
  tree.onTarget(part => {
    const id = [...selected][0];
    if (id === undefined) return;
    focus = part === "layer" ? null : { id, part };
    for (const r of pool) if (r.id === id) r.key = "";
    render();
  });
  tree.onEdited(ids => {
    const keys = ids === "all" ? "all" : [...ids, ...ids.map(maskKey), ...ids.map(vmaskKey)];
    thumbs().invalidate(keys);
    if (keys === "all") { failures.clear(); retryAt.clear(); } else for (const k of keys) { failures.delete(k); retryAt.delete(k); }
    queueThumbs(300);
  });
  // wheel: three rows a notch; the scrollbar thumb drags by the pointer's travel
  list.addEventListener("wheel", e => {
    const w = e as WheelEvent;
    if (!w.deltaY) return;
    e.preventDefault();
    scrollRows((w.deltaY > 0 ? 1 : -1) * Math.max(1, Math.min(10, Math.round(Math.abs(w.deltaY) / 40)) || 3));
  });
  let thumbDrag: { y0: number; f0: number } | null = null;
  sthumb.addEventListener("mousedown", e => { e.stopPropagation(); thumbDrag = { y0: (e as MouseEvent).clientY, f0: firstRow }; });
  sbar.addEventListener("mousedown", e => {
    // a press beside the thumb pages up / down
    if (e.target !== sbar) return;
    e.stopPropagation();
    const m = e as MouseEvent;
    scrollRows((typeof m.offsetY === "number" && m.offsetY < sthumb.offsetTop ? -1 : 1) * fits());
  });
  document.addEventListener("mousemove", e => {
    if (!thumbDrag) return;
    const H = list.clientHeight || 1, th = sthumb.offsetHeight, room = Math.max(1, H - th);
    const n = thumbDrag.f0 + Math.round(((e as MouseEvent).clientY - thumbDrag.y0) / room * maxFirst());
    scrollRows(n - firstRow);
  });
  document.addEventListener("mouseup", () => { thumbDrag = null; });


  function render() {
    const exp = expanded();
    collapsed = new Set(layers.filter(l => l.kind === "group" && !exp.has(l.id)).map(l => l.id));
    rows = layoutEffects(visibleRows(layers, collapsed, filter, users, openSubs(), query));
    groupLocked = lockedByGroup(layers);
    cols = new Set(COLS.filter(c => layers.some(l => cellUsed(l, c))));
    colsKey = [...cols].join(",");
    KINDS.forEach(([k], i) => kindBtns[i].classList.toggle("on", query.kinds.has(k)));
    activeContents = new Set(layers.filter(l => selected.has(l.id) && l.smart?.contentId).map(l => l.smart!.contentId!));
    boardOf = new Map(); boardColor = new Map();
    let board: number | null = null, auto = 0;
    for (const l of layers) {
      if (l.depth === 0) board = l.artboard ? l.id : null;
      if (l.depth === 0 && l.artboard) boardColor.set(l.id, customOf(l.id) ?? LABELS.find(([k]) => k === l.color)?.[2] ?? AUTO_FRAMES[auto++ % AUTO_FRAMES.length]);
      if (board !== null) boardOf.set(l.id, board);
    }
    groupColor = new Map();
    for (const l of layers) { const c = sharedColor(l); if (c !== undefined) for (const g of ancestors(layers, l.id)) if (!groupColor.has(g)) groupColor.set(g, c); }
    peerList = linkPeers(layers, selected);
    const peerKey = peerList.join(",");
    if (peerKey !== [...peers].join(",")) peerAt = 0;
    peers = new Set(peerList);
    replace(peersBtn, ic("link", 12), ` 链接 ${peerList.length}`);
    setShown(peersBtn, peerList.length > 0);
    const counts = filterCounts(layers, users);
    FILTERS.forEach(([f, label], i) => {
      const n = f === "all" ? 0 : counts[f];
      replace(filterBtns[i], f === "all" ? label : `${label} ${n}`);
      filterBtns[i].classList.toggle("on", filter === f);
      (filterBtns[i] as any).disabled = docId === null || (f !== "all" && !n && filter !== f);
    });
    replace(countEl, docId === null ? "" : `${layers.length} 个` + (selected.size ? ` · 已选 ${selected.size}` : ""));
    (openAll as any).disabled = (closeAll as any).disabled = docId === null || filter !== "all" || queryActive(query);
    setShown(empty, !rows.length);
    replace(empty, docId === null ? "未打开文档" : !layers.length ? "文档里没有图层" : "没有符合筛选的图层");
    renderBar();
    draw();
  }

  /** Brings the first selected layer into view (opening its groups), after Photoshop changed the selection. */
  function reveal() {
    const first = layers.find(l => selected.has(l.id));
    if (!first) return;
    if (filter === "all") { const exp = expanded(); for (const g of ancestors(layers, first.id)) exp.add(g); }
    render();
    scrollTo(first.id);
  }

  /** Scrolls row `id` into view (`middle`: into the middle of the list). */
  function scrollTo(id: number, middle = false) {
    const idx = rows.findIndex(r => r.layer.id === id);
    if (idx < 0) return;
    if (middle) {
      // back from the row until half the list is above it
      let y = heightOf(rows[idx]) / 2, i = idx;
      while (i > 0 && y + heightOf(rows[i - 1]) <= listH() / 2) { y += heightOf(rows[i - 1]); i--; }
      firstRow = i;
    } else if (idx < firstRow) firstRow = idx;
    else while (firstRow < idx && yOf(idx + 1) > listH()) firstRow++;
    draw();
  }


  let reading = false, again = false;
  /** the list's own selection on its way to Photoshop: `selecting` requests in flight, and a count of
   *  clicks, so a read that saw Photoshop's selection from before can't put it back (a flash of the
   *  old layer before the new one) */
  let selecting = 0, selectGen = 0;
  async function refresh() {
    // while a row is previewed only the selection changes, and that is ours: read once it ends
    if (peekHold) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      do {
        again = false;
        const gen = selectGen;
        const r = await tree.read().catch(e => { log("warn", "layer tree read", e); return null; });
        // the list chose layers while this was read: keep its selection and read again afterwards
        const stale = selecting > 0 || gen !== selectGen;
        const before = [...selected].sort().join(",");
        if (!r) { docId = null; layers = []; selected = new Set(); users = new Map(); }
        else {
          docKey = r.docKey;
          if (r.docId !== docId) { firstRow = 0; anchor = null; }
          else {
            // a layer whose size changed was edited (transform, crop …), whatever the events said
            const old = new Map(layers.map(l => [l.id, l]));
            thumbs().invalidate(r.layers.filter(l => { const o = old.get(l.id); return o && (o.width !== l.width || o.height !== l.height); }).map(l => l.id));
            // a mask that came or went
            thumbs().invalidate(r.layers.filter(l => l.mask && !old.get(l.id)?.mask).map(l => maskKey(l.id)));
            // masks show the whole canvas: a new canvas size redraws the thumbnails
            if (r.width !== canvas.width || r.height !== canvas.height) thumbs().invalidate("all");
          }
          if ((!peekHold && !stale) || r.docId !== docId) selected = new Set(r.selected);
          else if (stale && !peekHold) again = selecting === 0;
          docId = r.docId; layers = r.layers; users = contentUsers(layers); colors = sharedColors(layers, users); canvas = { width: r.width, height: r.height };
        }
        const now = [...selected].sort().join(",");
        if (now !== before && now !== ownSelect && selected.size) reveal(); else render();
        if (now === ownSelect) ownSelect = null;
      } while (again);
    } finally { reading = false; }
  }

  async function clickRow(id: number, mods: { ctrl: boolean; shift: boolean }) {
    if (docId === null) return;
    const r = clickSelect(rows.filter(x => !x.filter).map(x => x.layer.id), layers.filter(l => selected.has(l.id)).map(l => l.id), anchor, id, mods);
    anchor = r.anchor;
    selected = new Set(r.ids);
    if (focus && !(selected.size === 1 && selected.has(focus.id))) focus = null;
    ownSelect = [...selected].sort().join(",");
    selectGen++; selecting++;
    render();
    try {
      await endPeek(false);
      await tree.select(docId, layers.filter(l => selected.has(l.id)).map(l => l.id));
    } catch (e) { log("warn", "layer tree select", e); status(`选择图层失败：${(e as Error).message ?? e}`, "error"); ownSelect = null; }
    finally { selecting--; }
    // Photoshop has it now: one read brings the rest (shared contents, links …) up to date
    if (!selecting) void refresh();
  }

  /** the switch being dragged, on layer `l` */
  const paintGet = (l: TreeLayer, col: "eye" | "position" | "pixels") =>
    col === "eye" ? l.visible : l.kind === "group" ? l.lockAll : col === "position" ? l.lockPosition : l.lockPixels;
  function paintSet(l: TreeLayer, col: "eye" | "position" | "pixels", on: boolean) {
    if (col === "eye") l.visible = on;
    else if (l.kind === "group") l.lockAll = on;
    else if (col === "position") l.lockPosition = on;
    else l.lockPixels = on;
  }
  /** the drag is over row `index`: the rows from the pressed one to it switched, the others as they were */
  function paintTo(index: number) {
    if (!paint) return;
    const lo = Math.min(paint.start, index), hi = Math.max(paint.start, index), inRange = new Set<number>();
    for (let i = lo; i <= hi; i++) {
      const row = rows[i], l = row?.layer;
      if (!l || row.filter) continue;
      // locks: not the background, not inside a fully locked group; groups only when the drag began on one
      if (paint.col !== "eye" && (l.kind === "background" || groupLocked.has(l.id) || (l.kind === "group") !== paint.group)) continue;
      inRange.add(l.id);
      if (!paint.orig.has(l.id)) paint.orig.set(l.id, paintGet(l, paint.col));
      paintSet(l, paint.col, paint.to);
    }
    for (const [id, was] of paint.orig) {
      const l = layers.find(x => x.id === id);
      if (l && !inRange.has(id)) paintSet(l, paint.col, was);
    }
    render();
  }
  document.addEventListener("mouseup", () => {
    const d = paint, doc = docId;
    paint = null;
    if (!d || doc === null) return;
    const ids = [...d.orig].filter(([, was]) => was !== d.to).map(([id]) => id)
      .filter(id => { const l = layers.find(x => x.id === id); return l && paintGet(l, d.col) === d.to; });
    if (!ids.length) return;
    if (d.col !== "eye") {
      const plan = ids.flatMap(id => lockPlan(layers, [id], d.group ? "all" : d.col as "position" | "pixels", d.to));
      void run("setLock", plan.map(p => p.id), JSON.stringify(plan));
      return;
    }
    tree.setVisible(doc, ids, d.to)
      .catch(e => { log("warn", "layer tree visible", e); status(`显示/隐藏失败：${(e as Error).message ?? e}`, "error"); void refresh(); });
  });

  function toggleGroup(id: number) {
    const l = layers.find(x => x.id === id);
    if (l && (isVariantLayer(l) || l.kind !== "group" && (l.filters.length || l.effectList.length))) {
      const c = openSubs();
      if (c.has(id)) c.delete(id); else c.add(id);
      render();
      return;
    }
    if (filter !== "all" || l?.kind !== "group") return;
    const exp = expanded();
    if (exp.has(id)) exp.delete(id); else exp.add(id);
    render();
  }

  // ── layer commands (right-click menu, toolbar, mask / fx cells) ──
  async function run(action: LayerAction | SmartAction, ids: number[], arg?: string, opts?: RunOptions) {
    if (docId === null) return;
    await endPeek();
    try {
      if (isSmartAction(action)) {
        if (!tools) return;
        const r = await tools[action]();
        status(resultText(SMART_VERB[action], r), r.done ? "ok" : "error");
      } else await tree.run(docId, action, ids, arg, opts);
    } catch (e) {
      log("warn", "layer command", action, e);
      status(`操作失败：${(e as Error).message ?? e}`, "error");
    }
    void refresh();
  }

  // ── drag to reorder: the selected layers (or the one grabbed), dropped above / below / into a row ──
  // Positions are kept relative to the list's visible area (`view`, px from its top) and never come
  // from getBoundingClientRect, whose coordinates don't match the mouse's in UXP. The pointer's
  // movement since the grab gives `view`; while it is over the list, a transparent layer laid over
  // the rows reports the exact spot (offsetY), which corrects for where in the row it was grabbed.
  // Dropped on the toolbar's 新建组 / 新建图层 / 删除 buttons, the layers are grouped / copied / deleted.
  let drag: {
    ids: number[]; y0: number; view0: number; fix: number; view: number; active: boolean; probed: boolean;
    target: { id: number; where: Where; plan: MoveStep[] } | null;
    /** dragging a smart filter: its layer and place, and where it would go */
    filter: { layerId: number; pos: number } | null; ftarget: { layerId: number; toPos: number } | null;
    hover: number | null; overTool: HTMLElement | null;
    hoverTimer: ReturnType<typeof setTimeout> | null; scroller: ReturnType<typeof setInterval> | null;
  } | null = null;
  let suppressClick = false;
  const marker = h("div", { class: "lt-drop" });
  setShown(marker, false);
  const hit = h("div", { class: "lt-hit" });
  setShown(hit, false);
  inner.append(marker, hit);
  hit.addEventListener("mousemove", e => {
    const m = e as MouseEvent;
    if (!drag?.active || typeof m.offsetY !== "number") return;
    const exact = m.offsetY;
    drag.fix = exact - (drag.view0 + m.clientY - drag.y0);
    if (!drag.probed) {
      drag.probed = true;
      log("info", "layer drag probe", JSON.stringify({ clientY: m.clientY, offsetY: m.offsetY, firstRow, view0: drag.view0, fix: drag.fix }));
    }
  });

  function startDrag(id: number, e: MouseEvent, filterAt?: { pos: number; row: number }) {
    if (e.button !== 0 || docId === null) return;
    // the selection when the grabbed layer is part of it, in list order; else just that layer
    const ids = filterAt ? [] : selected.has(id) ? layers.filter(l => selected.has(l.id)).map(l => l.id) : [id];
    const idx = filterAt ? filterAt.row : Math.max(0, rows.findIndex(r => r.layer.id === id));
    drag = { ids, y0: e.clientY, view0: yOf(idx) + heightOf(rows[idx]) / 2, fix: 0, view: 0, active: false, probed: false,
      target: null, filter: filterAt ? { layerId: id, pos: filterAt.pos } : null, ftarget: null,
      hover: null, overTool: null, hoverTimer: null, scroller: null };
  }

  /** Where a dragged smart filter would land at row `idx`: between the filters of a smart object
   *  (its own or another), or on top of another smart object's filters when dropped on that layer. */
  function trackFilter(idx: number, frac: number) {
    const d = drag!, row = rows[idx], l = row.layer, f = row.filter;
    let dest: TreeLayer | null = null, pos = 0, line = -1, box = false;
    if (f?.kind === "filters" && f.index > 0) { dest = l; pos = f.index - 1 + (frac >= 0.5 ? 1 : 0); line = frac >= 0.5 ? idx + 1 : idx; }
    else if (l.kind === "smartObject" && l.id !== d.filter!.layerId && (!f || f.kind === "filters")) { dest = l; pos = 0; box = !f; line = f ? idx + 1 : idx; }
    let toPos = pos;
    if (dest && dest.id === d.filter!.layerId) { if (pos > d.filter!.pos) toPos = pos - 1; if (toPos === d.filter!.pos) dest = null; }
    d.ftarget = dest ? { layerId: dest.id, toPos } : null;
    if (!dest) { setShown(marker, false); return; }
    setShown(marker, true);
    marker.className = "lt-drop" + (box ? " into" : "");
    marker.style.left = LEAD + (dest.depth + (box ? 0 : 2)) * INDENT + "px";
    marker.style.top = (box ? yOf(idx) : yOf(line) - 1) + "px";
    marker.style.height = box ? heightOf(rows[idx]) + "px" : "";
  }

  function track() {
    if (!drag || !rows.length) return;
    if (drag.overTool) { setShown(marker, false); drag.target = null; drag.ftarget = null; return; }
    const { idx, top } = rowAt(drag.view);
    const frac = Math.max(0, Math.min(1, (drag.view - top) / heightOf(rows[idx])));
    if (drag.filter) { trackFilter(idx, frac); return; }
    const l = rows[idx].layer, open = filter !== "all" || !collapsed.has(l.id);
    // a smart filter row stands for "below its smart object"
    const where = rows[idx].filter ? "below" : dropZone(l, frac, open);
    const plan = dropPlan(layers, drag.ids, l.id, where);
    drag.target = plan ? { id: l.id, where, plan } : null;
    // hovering a closed group opens it after a moment
    const opens = where === "inside" && !open && l.children > 0 && plan ? l.id : null;
    if (opens !== drag.hover) {
      if (drag.hoverTimer) clearTimeout(drag.hoverTimer);
      drag.hover = opens;
      drag.hoverTimer = opens === null ? null : setTimeout(() => { if (drag?.hover === opens) { expanded().add(opens); render(); track(); } }, OPEN_DELAY);
    }
    if (!plan) { setShown(marker, false); return; }
    setShown(marker, true);
    const indent = LEAD + l.depth * INDENT + (where === "inside" ? 0 : 16);
    marker.className = "lt-drop" + (where === "inside" ? " into" : "");
    marker.style.left = indent + "px";
    marker.style.top = (where === "inside" ? yOf(idx) : yOf(where === "above" ? idx : idx + 1) - 1) + "px";
    marker.style.height = where === "inside" ? heightOf(rows[idx]) + "px" : "";
  }

  /** -1 / 1 while the pointer is near (or past) the list's top / bottom edge */
  const edgeDir = () => !drag || drag.overTool ? 0 : drag.view < 22 ? -1 : drag.view > list.clientHeight - 22 ? 1 : 0;

  document.addEventListener("mousemove", e => {
    if (!drag) return;
    const m = e as MouseEvent;
    if (!drag.active) {
      if (Math.abs(m.clientY - drag.y0) < 5) return;
      drag.active = true;
      list.classList.add("dragging");
      setShown(hit, true);
      draw();
    }
    drag.view = drag.view0 + m.clientY - drag.y0 + drag.fix;
    track();
    // near the top / bottom edge the list scrolls by itself
    if (edgeDir() && !drag.scroller) drag.scroller = setInterval(() => {
      const dir = edgeDir();
      if (dir) { scrollRows(dir); track(); }
    }, 90);
    if (!edgeDir() && drag.scroller) { clearInterval(drag.scroller); drag.scroller = null; }
  });

  function endDrag(): typeof drag {
    const d = drag;
    drag = null;
    if (d?.hoverTimer) clearTimeout(d.hoverTimer);
    if (d?.scroller) clearInterval(d.scroller);
    setShown(marker, false);
    setShown(hit, false);
    list.classList.remove("dragging");
    for (const b of dropTools) b.el.classList.remove("drop-on");
    if (d?.active) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); draw(); }
    return d;
  }
  document.addEventListener("mouseup", () => {
    const d = endDrag();
    if (!d?.active) return;
    const tool = dropTools.find(b => b.el === d.overTool);
    // the toolbar takes layers, not a dragged smart filter
    if (tool && !d.filter) void run(tool.action, d.ids);
    else if (d.filter && d.ftarget) void run("moveFilter", [d.filter.layerId], JSON.stringify({ from: d.filter.pos, toLayer: d.ftarget.layerId, toPos: d.ftarget.toPos }));
    else if (d.target) void drop(d.target.id, d.target.where, d.target.plan, d.ids.length);
  });
  document.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Escape" && drag?.active) endDrag(); });

  async function drop(targetId: number, where: Where, plan: MoveStep[], count: number) {
    if (docId === null) return;
    if (where === "inside") expanded().add(targetId);
    try {
      const r = await tree.move(docId, plan);
      if (r.skipped.length || r.done < count) status(resultText("已移动", { ...r, unit: "个图层" }), r.done ? "ok" : "error");
    } catch (e) { log("warn", "layer move", e); status(`移动图层失败：${(e as Error).message ?? e}`, "error"); }
    void refresh();
  }

  // ── right-click menu, rename, toolbar ──
  const el = h("section", { class: "lt fill" });
  const popup = createPopup(el);
  /** y (px from the panel section's top) just below row `idx` */
  const rowBottom = (idx: number) => list.offsetTop + yOf(idx + 1);

  function openRowMenu(id: number) {
    if (docId === null) return;
    // like Photoshop: right-clicking a layer outside the selection selects it first
    if (!selected.has(id)) void clickRow(id, { ctrl: false, shift: false });
    const sel = selectedLayers(), ids = sel.map(l => l.id);
    const items: PopItem[] = layerMenu(sel)
      .filter(m => m === "-" || !isSmartAction(m.action) || tools)
      .map(m => m === "-" ? m : { label: m.label, hint: m.hint, enabled: m.enabled, run: () => m.action === "rename" ? startRename(ids[0]) : void run(m.action, ids) });
    items.push({ label: "图层颜色…", hint: "眼睛列的底色", enabled: ids.length > 0, run: () => setTimeout(() => openColorMenu(ids[0], ids), 0) });
    // after this mousedown has reached the document (which closes open menus)
    setTimeout(() => popup.open(items, rowBottom(Math.max(0, rows.findIndex(r => r.layer.id === id)))), 0);
  }

  /** 图层颜色 / 画板颜色 as colour squares: Photoshop's labels (kept in the PSD), the colours used lately and
   *  自定义颜色… (Photoshop's colour picker; the panel's own, kept in this panel only) */
  function openColorMenu(id: number, ids = [id]) {
    const l = layers.find(x => x.id === id);
    if (!l || docId === null) return;
    const board = l.artboard && ids.length === 1, one = ids.length === 1;
    const custom = one ? customOf(id) : undefined, cur = one && !custom ? l.color : null;
    const label = (k: string) => run("setColor", ids, k).then(() => setCustom(ids, null));
    const items: PopItem[] = [
      { swatches: [
        { color: null, title: board ? "自动（不设颜色）" : "无颜色", on: cur === "none", run: () => void label("none") },
        ...LABELS.map(([k, name, hex]) => ({ color: hex, title: name, on: cur === k, run: () => void label(k) })),
      ] },
      ...recentColors.length ? [{ swatches: recentColors.map(hex => ({ color: hex, title: "自定义颜色 " + hex + "（只在本插件里显示）", on: custom === hex, run: () => setCustom(ids, hex) })) }] : [],
      "-",
      { label: "自定义颜色…", hint: "只在本插件里显示", run: () => void pickCustom(ids, custom ?? LABELS.find(([k]) => k === l.color)?.[2] ?? "#4f9cf0") },
    ];
    popup.open(items, rowBottom(Math.max(0, rows.findIndex(r => r.layer.id === id))));
  }
  async function pickCustom(ids: number[], from: string) {
    const hex = await tree.pickColor(from).catch(e => { log("warn", "color picker", e); status(`打不开拾色器：${(e as Error).message ?? e}`, "error"); return null; });
    if (hex) setCustom(ids, hex);
  }
  /** the panel's own colour of `ids` (null: back to Photoshop's label) */
  function setCustom(ids: number[], hex: string | null) {
    const m = customColors[docKey] ??= {};
    for (const id of ids) { if (hex) m[id] = hex; else delete m[id]; }
    if (!Object.keys(m).length) delete customColors[docKey];
    saveJson(CUSTOM_KEY, customColors);
    if (hex) { recentColors = [hex, ...recentColors.filter(c => c !== hex)].slice(0, 8); saveJson(RECENT_KEY, recentColors); }
    render();
  }

  /** 重命名: an input over the row's name; Enter or leaving it renames, Esc cancels. */
  const renameBox = h("input", { class: "lt-rename", type: "text" }) as HTMLInputElement;
  setShown(renameBox, false);
  inner.append(renameBox);
  let renaming: number | null = null;
  renameBox.addEventListener("mousedown", e => e.stopPropagation());
  renameBox.addEventListener("click", e => e.stopPropagation());
  function startRename(id: number) {
    const idx = rows.findIndex(r => r.layer.id === id);
    const l = layers.find(x => x.id === id);
    if (idx < 0 || !l) return;
    renaming = id;
    renameBox.value = l.name;
    renameBox.style.top = yOf(idx) + Math.max(0, (heightOf(rows[idx]) - 24) / 2) + "px";
    renameBox.style.left = LEAD + l.depth * INDENT + 16 + "px";
    setShown(renameBox, true);
    renameBox.focus();
    renameBox.select();
  }
  function endRename(save: boolean) {
    if (renaming === null) return;
    const id = renaming, name = renameBox.value.trim(), old = layers.find(x => x.id === id)?.name;
    renaming = null;
    setShown(renameBox, false);
    if (save && name && name !== old) void run("rename", [id], name);
  }
  renameBox.addEventListener("keydown", e => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter") endRename(true);
    else if (k === "Escape") endRename(false);
    e.stopPropagation();
  });
  renameBox.addEventListener("blur", () => endRename(true));

  // Photoshop's toolbar under the Layers panel
  const tool = (name: string, tip: string, onClick: (e: MouseEvent) => void) => {
    const b = h("button", { class: "lt-tool", title: tip }, ic(name, 16));
    b.addEventListener("click", e => onClick(e as MouseEvent));
    return b;
  };
  const ids = () => selectedLayers().map(l => l.id);
  const linkBtn = tool("link", "链接图层（选中多个时链接，选中一个时取消链接）", () => void run(selected.size > 1 ? "link" : "unlink", ids()));
  const fxBtn = h("button", { class: "lt-tool lt-tool-fx", title: "图层样式" }, "fx");
  fxBtn.addEventListener("click", () => {
    const sel = selectedLayers(), one = sel.length === 1, hidden = sel.some(l => l.effects && !l.effectsOn);
    popup.open([
      { label: "混合选项…", enabled: one, run: () => void run("layerStyle", ids()) },
      "-",
      { label: "拷贝图层样式", enabled: one && sel[0].effects, run: () => void run("copyStyle", ids()) },
      { label: "粘贴图层样式", enabled: sel.length > 0, run: () => void run("pasteStyle", ids()) },
      { label: "清除图层样式", enabled: sel.some(l => l.effects), run: () => void run("clearStyle", ids()) },
      "-",
      { label: hidden ? "显示图层样式" : "隐藏图层样式", enabled: sel.some(l => l.effects), run: () => void run("toggleEffects", ids(), hidden ? "on" : "off") },
    ], bar.offsetTop - 2, { upward: true, from: fxBtn });
  });
  // like Photoshop's button: a layer mask first; on a layer that has one, a vector mask
  const maskBtn = tool("mask", "添加图层蒙版（有选区时只显示选区；Alt+单击：隐藏）；已有图层蒙版时添加矢量蒙版", e => {
    const sel = selectedLayers(), l = sel.length === 1 ? sel[0] : undefined;
    if (l?.mask && l.vmask) { status("这个图层已经有图层蒙版和矢量蒙版", "error"); return; }
    // a shape layer's shape is its vector mask already
    if (l?.mask && l.kind === "shape") { status("形状图层的形状本身就是矢量蒙版，只能再加一个图层蒙版", "error"); return; }
    void run(l?.mask ? "addVectorMask" : e.altKey ? "addMaskHide" : "addMask", ids());
  });
  const adjBtn = tool("adjust", "新建填充或调整图层", () => {
    popup.open(ADJUSTMENTS.map(([key, label]) => ({ label, run: () => void run("adjustment", ids(), key, outsideAi()) })), bar.offsetTop - 2, { upward: true, from: adjBtn, left: 80 });
  });
  const groupBtn = tool("folder", "新建组（把图层拖到这里：从图层新建组）", () => void run("newGroup", ids(), undefined, outsideAi()));
  const newBtn = tool("newLayer", "新建图层（把图层拖到这里：复制图层）", () => void run("newLayer", ids(), undefined, outsideAi()));
  /** new layers next to a selected AI result (a group in Photoshop) go above it, not into it */
  const outsideAi = (): RunOptions => { const top = selectedLayers()[0]; return top && isVariantLayer(top) ? { above: top.id } : {}; };
  const trashBtn = tool("trash", "删除图层；选中的是蒙版时（缩略图带绿框）删除蒙版。也可以把图层拖到这里；Delete 键同样", () => deleteSelected());
  const dropTools: { el: HTMLElement; action: LayerAction }[] = [
    { el: groupBtn, action: "groupLayers" }, { el: newBtn, action: "duplicate" }, { el: trashBtn, action: "delete" },
  ];
  for (const b of dropTools) {
    b.el.addEventListener("mouseenter", () => { if (drag?.active) { drag.overTool = b.el; b.el.classList.add("drop-on"); track(); } });
    b.el.addEventListener("mouseleave", () => { if (drag?.overTool === b.el) { drag.overTool = null; b.el.classList.remove("drop-on"); } });
  }
  const bar = h("div", { class: "lt-bar" }, linkBtn, fxBtn, maskBtn, adjBtn, groupBtn, newBtn, trashBtn);

  // 混合模式 / 不透明度 / 填充 and the locks, for the selected layers
  const modeSel = h("select", { class: "field lt-mode", title: "混合模式" },
    // shown when the selected layers differ (or none is selected)
    h("option", { disabled: true, value: "" }, "混合模式"),
    ...BLEND_MODES.map(m => m === "-" ? h("option", { disabled: true, value: "" }, "──────") : h("option", { value: m[0] }, m[1]))) as HTMLSelectElement;
  modeSel.addEventListener("change", () => { if (modeSel.value) void run("setProps", ids(), JSON.stringify({ mode: modeSel.value })); });
  /** 不透明度 / 填充: a slider and a number; the slider shows its value while dragged and is written
   *  to Photoshop when let go (one history step, as Photoshop's own slider) */
  /** 不透明度 / 填充: a slider and its value; the value is text (click it to type one), so the row
   *  stays low in UXP, where inputs are tall */
  const percentRow = (key: "opacity" | "fill", label: string, tip: string) => {
    const val = h("span", { class: "lt-pct-val", title: tip + "\n单击输入数值" });
    const edit = h("input", { class: "lt-pct-edit", type: "text" }) as HTMLInputElement;
    setShown(edit, false);
    const apply = (v: number) => {
      if (!Number.isFinite(v) || !selected.size) { renderProps(); return; }
      const n = Math.max(0, Math.min(100, Math.round(v)));
      replace(val, n + "%"); slider.value = n;
      void run("setProps", ids(), JSON.stringify({ [key]: n }));
    };
    const slider = createSlider({ title: tip, onInput: v => replace(val, v + "%"), onChange: apply });
    let editing = false;
    const stopEdit = (save: boolean) => {
      if (!editing) return;
      editing = false; setShown(edit, false); setShown(val, true);
      if (save && edit.value.trim()) apply(Number(edit.value.replace(/[%\s]/g, "")));
    };
    val.addEventListener("click", () => {
      if ((val as any).disabled || !selected.size) return;
      editing = true;
      edit.value = String(slider.value);
      setShown(val, false); setShown(edit, true);
      edit.focus(); edit.select();
    });
    edit.addEventListener("keydown", e => { const k = (e as KeyboardEvent).key; if (k === "Enter") stopEdit(true); else if (k === "Escape") stopEdit(false); e.stopPropagation(); });
    edit.addEventListener("blur", () => stopEdit(true));
    const row = h("div", { class: "lt-pct-row" }, h("span", { class: "lt-pct-label", title: tip }, label), slider.el, h("div", { class: "lt-pct-box" }, val, edit));
    return { row, slider, val, isEditing: () => editing };
  };
  const opacity = percentRow("opacity", "不透明", "不透明度：图层和它的样式一起变淡");
  const fillPct = percentRow("fill", "填充", "填充：只让图层像素变淡，图层样式不变");
  const LOCKS: [LockKey, string, string, (l: TreeLayer) => boolean][] = [
    ["transparency", "checker", "锁定透明像素", l => l.lockTransparency],
    ["pixels", "brush", "锁定图像像素", l => l.lockPixels],
    ["position", "move", "锁定位置", l => l.lockPosition],
    ["all", "lock", "锁定全部", l => l.lockAll],
  ];
  const lockBtns = LOCKS.map(([key, ico, tip, has]) => {
    const b = h("button", { class: "lt-lockbtn", title: tip + (key === "all" ? "（作用于选中的图层和图层组）" : "（作用于选中的图层；图层组只能锁定全部）") }, ic(ico, 14));
    b.addEventListener("click", () => {
      const sel = selectedLayers().filter(x => x.kind !== "background" && (x.kind !== "group" || key === "all"));
      if (!sel.length) return;
      const plan = lockPlan(layers, sel.map(x => x.id), key, !sel.every(has));
      void run("setLock", plan.map(p => p.id), JSON.stringify(plan));
    });
    return b;
  });
  // 混合模式 and the locks share a line; 不透明度 / 填充 below
  const props = h("div", { class: "lt-props" }, modeSel, h("div", { class: "lt-locks" }, ...lockBtns));

  function renderProps() {
    const sel = selectedLayers(), l = sel[0], none = docId === null || !l;
    const same = <T,>(f: (x: TreeLayer) => T) => sel.every(x => f(x) === f(l));
    (modeSel as any).disabled = none;
    opacity.slider.disabled = fillPct.slider.disabled = none;
    if (document.activeElement !== modeSel) modeSel.value = l && same(x => x.mode) ? l.mode : "";
    for (const [p, get] of [[opacity, (x: TreeLayer) => x.opacity], [fillPct, (x: TreeLayer) => x.fill]] as const) {
      if (p.isEditing()) continue;
      const v = l && same(get) ? String(get(l)) : "";
      replace(p.val, none ? "" : v ? v + "%" : "—");
      p.val.classList.toggle("off", none);
      p.slider.value = v ? Number(v) : 100;
    }
    LOCKS.forEach(([, , , has], i) => {
      // groups take 锁定全部 only, like Photoshop
      const takes = sel.filter(x => x.kind !== "background" && (x.kind !== "group" || LOCKS[i][0] === "all"));
      (lockBtns[i] as any).disabled = none || !takes.length;
      lockBtns[i].classList.toggle("on", takes.length > 0 && takes.every(has));
    });
  }

  function renderInfo() {
    const sel = selectedLayers();
    const text = docId === null ? "" : !sel.length ? "未选中图层" : sel.length > 1 ? `已选 ${sel.length} 个图层` : layerInfo(sel[0]).join(" · ");
    if (text === infoEl.textContent) return;
    replace(infoEl, text);
    infoEl.title = sel.length === 1 ? [sel[0].name, ...layerInfo(sel[0])].join("\n") : sel.map(l => l.name).join("\n");
  }

  /** The selected layer's properties, short; a variant layer also tells its shown variation's. */
  function layerInfo(l: TreeLayer): string[] {
    const vl = isVariantLayer(l), v = vl ? layers.find(x => x.id === l.ai!.shown) : undefined, s = v ?? l;
    const out = [vl ? "变体图层" : l.ai ? `${l.ai.label}结果组` : KIND_ICON[l.kind][1]];
    if (vl) out.push(`${l.ai!.variations} 个变体` + (v ? `，当前 ${/^v\d+/.exec(v.name)?.[0] ?? v.name}` : ""));
    if (s.smart) {
      const n = s.smart.contentId ? users.get(s.smart.contentId) ?? 1 : 1;
      out.push(s.smart.linked ? "外部链接" : n > 1 ? `共用内容 ×${n}` : "内容独立");
      if (s.smart.file) out.push(s.smart.file);
    }
    if (l.kind === "group" && !vl) out.push(`${l.children} 个图层`);
    if (s.kind !== "group" && s.width > 0 && s.height > 0) out.push(`${s.width}×${s.height}`);
    if (!l.visible) out.push("已隐藏");
    if (l.mode !== "normal" && l.mode !== "passThrough") out.push((BLEND_MODES.find(m => m !== "-" && m[0] === l.mode) as [string, string] | undefined)?.[1] ?? l.mode);
    if (l.opacity < 100) out.push(`不透明度 ${l.opacity}%`);
    if (l.fill < 100) out.push(`填充 ${l.fill}%`);
    if (l.mask || s.mask) out.push((l.mask ? l.maskOn : s.maskOn) ? "蒙版" : "蒙版（停用）");
    if (l.clipped) out.push("剪贴蒙版");
    if (l.clipBase) out.push("剪贴基底");
    if (l.effectList.length) out.push(`效果 ${l.effectList.length}` + (l.effectsOn ? "" : "（隐藏）"));
    if (s.filters.length) out.push(`智能滤镜 ${s.filters.length}` + (s.filtersOn ? "" : "（隐藏）"));
    if (l.links.length) out.push(`链接 ${l.links.length}`);
    const locks = l.lockAll ? ["全部"] : [l.lockPosition && "位置", l.lockPixels && "像素", l.lockTransparency && "透明"].filter(Boolean);
    if (locks.length) out.push("锁定" + locks.join("、"));
    return out;
  }

  function renderBar() {
    renderProps();
    renderInfo();
    const sel = selectedLayers(), none = docId === null || !sel.length;
    (linkBtn as any).disabled = none;
    (fxBtn as any).disabled = none;
    (maskBtn as any).disabled = none || sel.length !== 1 || sel[0].mask || sel[0].kind === "background";
    (adjBtn as any).disabled = docId === null;
    (groupBtn as any).disabled = (newBtn as any).disabled = docId === null;
    (trashBtn as any).disabled = none;
  }

  // the panel can be resized without an event reaching the list: re-fill when its height changes
  // (a new width re-flows the effect chips)
  let lastH = 0, lastW = 0;
  setInterval(() => {
    const ht = list.clientHeight, wd = list.clientWidth;
    if (wd !== lastW) { lastW = wd; lastH = ht; render(); }
    else if (ht !== lastH) { lastH = ht; draw(); }
  }, 400);


  list.title = "点击选中，Ctrl / ⌘ 加选，Shift 连选；双击打开图层样式；右键更多操作；拖动改顺序（拖到图层组中间放进组里）";
  el.append(
    h("div", { class: "card-head" }, h("span", { class: "label" }, "图层"), countEl, h("span", { class: "grow" }), peersBtn),
    infoEl,
    h("div", { class: "lt-find" }, searchBox, h("div", { class: "lt-kinds" }, ...kindBtns)),
    h("div", { class: "seg lt-seg" }, ...filterBtns),
    props, opacity.row, fillPct.row,
    list,
    h("div", { class: "lt-foot" }, h("div", { class: "lt-foot-btns" }, peekBtn, thumbBtn, openAll, closeAll), bar));
  render();
  return { el, refresh };
}
