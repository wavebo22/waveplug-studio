// WavePlug 图层 panel, the list itself: Photoshop's layers with status cells, filters, click / Ctrl / Shift selection,
// eye toggles, drag to reorder, thumbnails with layer masks, clipping marks, a right-click menu,
// double-click for 图层样式 and Photoshop's bottom toolbar, kept in step with the document.
// Only the rows in view exist in the DOM (a fixed pool, re-filled on scroll), and only they get
// thumbnails (queued in the background, cached per layer), so documents with thousands of layers
// stay smooth.

import { log } from "../app/log.ts";
import { resultText } from "../core/layers/smart.ts";
import { ThumbCache, thumbRetryDelay } from "../core/layers/thumbs.ts";
import { workbenchPlacementAnchor } from "../core/layers/workbench.ts";
import { clampThumbPercent, legacyThumbPercent, thumbnailMetrics, THUMB_PERCENT_KEY } from "../core/layers/topControls.ts";
import { MULTI_EFFECTS } from "../core/layers/effects.ts";
import { type AdvancedFilter, type Filter, type LayerAction, type LayerKind, type LockKey, type MoveStep, type Row, type SmartAction, type TreeLayer, type Where, BLEND_MODES, ancestors, isCompactRow, queryActive, clickSelect, contentUsers, canDropToDelete, canDropMaskOnto, copyPlan, dropPlan, previewMoveTree, dropZone, filterCounts, isVariantLayer, layerMenu, smartQuickMenu, nextLayerAfterDelete, layerTags, linkPeers, lockPlan, packChips, lockedByGroup, sharedColors, selectionAfterLocalClear, visibleRows } from "../core/layers/tree.ts";
import { type LayerTools, type LayerTree, type RunOptions, type TargetPart, ADJUSTMENTS } from "../ps/host.ts";
import { every, h, icon, isShown, listen, replace, setShown } from "./dom.ts";
import { type PopItem, createPopup } from "./popupMenu.ts";
import { onSmartTarget } from "./smartTarget.ts";
import { createSlider } from "./slider.ts";
import { createWorkbenchSection } from "./workbenchDemo.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

/** 0–150% thumbnail size. The old four settings are migrated on first use.
 *  Only thumbnail boxes and their ordinary row height change; icons/sub-rows remain fixed. */
let thumbPercent = (() => {
  try {
    const saved = localStorage.getItem(THUMB_PERCENT_KEY);
    if (saved !== null && saved.trim() !== "" && Number.isFinite(Number(saved))) return clampThumbPercent(Number(saved));
    return legacyThumbPercent(localStorage.getItem("wp.layers.size"), localStorage.getItem("wp.layers.thumbs") === "off");
  } catch { return 100; }
})();
let thumbSize = thumbnailMetrics(thumbPercent);
/** row height in px; groups and sub-rows (effects, smart filters, variations) are shorter */
let ROW = thumbSize.row, SHORT = thumbSize.short;
const isShort = (r: Row) => isCompactRow(r);
const heightOf = (r: Row) => isShort(r) ? SHORT : ROW;
const INDENT = 14;
/** px from the row's left edge to where the indent starts: colour stripe, eye, padding */
const LEAD = 4 + 22 + 2;
/** icon and name of each kind of layer (in place of a thumbnail, or as a badge on it) */
const KIND_ICON: Record<TreeLayer["kind"], [string, string]> = {
  pixel: ["image", "像素图层"], text: ["text", "文字图层"], shape: ["shape", "形状图层"], adjustment: ["adjust", "调整图层"], fill: ["fill", "填充图层"],
  smartObject: ["smart", "智能对象"], group: ["folder", "图层组"], background: ["image", "背景"], other: ["image", "图层"],
};
/** the panel's Photoshop-style icons keep a constant optical size. */
const PS_ICON: Record<string, string> = {
  eye: "psEye", lock: "psLock", link: "psLink", mask: "psMask", adjust: "psAdjust", folder: "psFolder", folderOpen: "psFolderOpen", trash: "psTrash", clip: "psClip", text: "psText",
  newLayer: "psNew", smart: "psSmart", image: "psImage", shape: "psShape", fill: "psFill", move: "psMove", brush: "psBrush", filters: "psFilters",
  copies: "psShared", single: "psSingle", external: "psExternal", vector: "psVector", layers: "psEditable",
  checker: "psChecker", chainV: "psChainV",
};
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
const ic = (name: string, px = 14) => icon(PS_ICON[name] ?? name, Math.round(px * 1.15));
const kindIcon = (l: TreeLayer, open: boolean) => h("span", { class: "lt-kind k-" + l.kind, title: KIND_ICON[l.kind][1] }, ic(l.kind === "group" && open && l.children ? "folderOpen" : KIND_ICON[l.kind][0], 15));

/** thumbnail px read: twice the box, for sharpness (max 108). */
const thumbPx = () => thumbSize.thumb * 2;
/** thumbnails read per Photoshop call */
const THUMB_BATCH = 6;
/** layers whose pixels make a useful thumbnail (groups, text and adjustments get their mark, like Photoshop) */
let thumbsOn = thumbPercent > 0;
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
const SMART_VERB: Record<SmartAction, string> = {
  makeUnique: "已断开", selectSameSource: "已选中", makeEditable: "已转换", unpack: "已解包",
  resetTransform: "已重置", replaceContents: "已替换", exportContents: "已导出",
  convertTogether: "已转换", convertSeparately: "已转换",
};
const isSmartAction = (a: string): a is SmartAction => a in SMART_VERB;

/** `sub`: the row shows a smart filter (index 0: all of them) of layer `id` */
/** Status columns at the right of each row, always in this order; a column shows only when some
 *  layer in the document uses it, and stays blank on the rows that don't. */
type Col = "content" | "filters" | "fx" | "chain" | "lock";
const COLS: Col[] = ["fx", "filters", "content", "chain", "lock"];

interface RowEl { index: number; el: HTMLElement; eye: HTMLElement; twisty: HTMLElement; name: HTMLElement; body: HTMLElement; key: string; id: number; sub: Row["filter"] | null }

/** The list fills the height it is given (the whole WavePlug 图层 panel); `tools` adds the 智能对象
 *  tools to the right-click menu. */
export function createLayerTreeView(tree: LayerTree, status: Status, tools?: LayerTools) {
  let docId: number | null = null, layers: TreeLayer[] = [], users = new Map<string, number>(), canvas = { width: 0, height: 0 };
  /** the layers by id (kept with `layers`): lookups in drawing and dragging, which run for every row */
  let byId = new Map<number, TreeLayer>();
  // A local move projection is shown immediately after mouseup. While it is pending,
  // ignore host reads of the old tree; the completed Photoshop modal event will reconcile it.
  let orderPreview = false;
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
  type Zone = "thumb" | "status" | "name" | "variant";
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
    if (deleting) return;
    const same = selected.size === 1 && selected.has(id) && partOf(id) === part;
    localClear = null;
    selected = new Set([id]); anchor = id;
    focus = { id, part };
    for (const r of pool) if (r.id === id) r.key = "";
    render();
    if (same && part !== "layer") return;
    void run(part === "layer" ? "targetLayer" : part === "mask" ? "targetMask" : part === "vmask" ? "targetVectorMask" : "targetFilterMask", [id]);
  }
  /** Bottom trash click. Keyboard deletion is intentionally disabled in WaveLayer. */
  let deleting = false;
  function deleteSelected() {
    if (deleting) return;
    // only layers still in the last read: a quick second Delete must not ask for the one just deleted
    const ids = [...selected].filter(id => byId.has(id)), l = ids.length === 1 ? layers.find(x => x.id === ids[0]) : undefined;
    const part = l ? framed(l) : null;
    if (!ids.length) {
      if (selected.size) {
        log("info", "layer delete stale selection", JSON.stringify([...selected]));
        status("所选图层已发生变化，正在同步列表", "info");
        void refresh();
      }
      return;
    }
    if (l && part && part !== "layer") {
      focus = null;
      void run(part === "mask" ? "deleteMask" : part === "vmask" ? "deleteVectorMask" : "deleteFilterMask", ids);
    } else void run("delete", ids);
  }
  // WaveLayer deliberately does NOT intercept Delete / Backspace. The native Photoshop shortcuts
  // remain Photoshop's responsibility; WaveLayer deletes via drag targets and the bottom trash.
  // A Photoshop command (selecting the clicked rows, deleting …) can take the focus back to
  // Photoshop: the panel takes it again afterwards, and whenever the pointer is over the list.
  // pointerIn: the pointer is over this panel (a click on the canvas never reaches this document,
  // so only this tells the panel is still the one being used)
  let panelActive = false, pointerIn = false;
  const typing = (t: Element | null) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t as HTMLElement).isContentEditable);
  // After a Photoshop command UXP still reports the section as focused while Photoshop has the
  // keys (only the first Delete arrived): blur first, so focus() really asks for the keyboard again.
  const refocus = (why: string) => {
    // Photoshop may reclaim UXP keyboard focus *after* the modal promise resolves. A synchronous
    // blur/focus is therefore racy. Retry on the next turns, but only while the pointer remains
    // over this panel and the user has not started typing or dragging.
    const delays = why === "delete" || why === "select" ? [0, 80, 220] : [0];
    for (const delay of delays) setTimeout(() => {
      if (!el.isConnected) return;
      const active = document.activeElement;
      if (!panelActive || !pointerIn || renaming !== null || drag?.active || typing(active)) {
        if (why === "delete" && delay === 0)
          log("info", "layer panel focus restore skipped", why, JSON.stringify({ panelActive, pointerIn, active: active?.tagName ?? "none", typing: typing(active) }));
        return;
      }
      try {
        if (active && active !== el) (active as HTMLElement).blur();
        el.focus();
      } catch { /* host without focus on sections */ }
      log("info", "layer panel focus restore", why, delay,
        JSON.stringify({ focused: document.activeElement === el, active: document.activeElement?.tagName ?? "none", panelActive, pointerIn }));
    }, delay);
  };
  // when the panel gains / loses the keyboard (evidence for the above)
  let focusLogged = 0;
  for (const type of ["focus", "blur"]) listen(window, type, () => { if (focusLogged < 40) { focusLogged++; log("info", "layer panel window", type); } });
  listen(document, "mousedown", e => {
    const t = e.target as HTMLElement | null;
    panelActive = el.contains(t);
    if (panelActive && !typing(t)) { try { el.focus(); } catch { /* host without focus on sections */ } }
  }, true);
  /** the open document across sessions (custom colours are kept by it) */
  let docKey = "";
  const customOf = (id: number): string | undefined => customColors[docKey]?.[id];
  /** what a layer's (and its masks') thumbnail shows, as in Photoshop: its artboard, or the whole canvas */
  function areaOf(l: TreeLayer): { left: number; top: number; right: number; bottom: number } {
    const b = boardOf.get(l.id), board = b === undefined ? undefined : byId.get(b);
    if (board?.board) return board.board;
    if (board && board.width > 0 && board.height > 0) return { left: board.left, top: board.top, right: board.left + board.width, bottom: board.top + board.height };
    return { left: 0, top: 0, right: Math.max(1, canvas.width), bottom: Math.max(1, canvas.height) };
  }
  /** a thumbnail box as wide as its area's shape needs at the row's height (½ to 2 × the height) */
  function thumbW(l: TreeLayer): number {
    const a = areaOf(l), t = thumbSize.thumb;
    return Math.round(t * Math.min(2, Math.max(0.5, (a.right - a.left) / Math.max(1, a.bottom - a.top))));
  }
  /** the row under the pointer (see the row's mouseover) */
  let hoverEl: HTMLElement | null = null;
  let paint: { col: "eye"; to: boolean; start: number; orig: Map<number, boolean> } | null = null;
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
    // Photoshop convention: double-click smart-object thumbnail or smart badge.
    // The host automatically converts PNG content to PSB before opening it.
    else void run(zone === "thumb" && l.kind !== "smartObject" ? "layerStyle" : "editContents", [id]);
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
  // Thumbnail-size settings live behind one icon; 0% means no thumbnails.
  // Group/sub-row height and all icons remain unchanged at any percentage.
  const thumbButton = h("button", { class: "lt-top-icon", title: "缩略图大小（0–150%），0% 隐藏缩略图" }, ic("image", 15));
  const thumbValue = h("input", { class: "lt-thumb-value", type: "text", value: thumbPercent + "%", title: "缩略图大小百分比；Enter 应用，Esc 取消" }) as HTMLInputElement;
  const thumbSlider = createSlider({
    title: "缩略图大小（0% 隐藏，100% 为原中档，150% 为原大档）", min: 0, max: 150,
    onInput: v => { thumbValue.value = v + "%"; },
    onChange: v => applyThumbPercent(v),
  });
  thumbSlider.value = thumbPercent;
  const thumbPopup = h("div", { class: "lt-top-popup lt-thumb-popup" },
    h("div", { class: "lt-thumb-head" }, h("span", {}, "缩略图大小"), thumbValue),
    thumbSlider.el,
    h("div", { class: "lt-thumb-range" }, h("span", {}, "0% · 关闭"), h("span", {}, "150%")));
  setShown(thumbPopup, false);
  const renderThumbMetrics = () => {
    list.style.setProperty("--lt-row", ROW + "px");
    list.style.setProperty("--lt-short", SHORT + "px");
    list.style.setProperty("--lt-thumb", (thumbSize.thumb || 24) + "px");
    list.style.setProperty("--lt-mark", (thumbSize.thumb ? thumbSize.thumb + 2 : 26) + "px");
    list.classList.toggle("sz-off", !thumbsOn);
    list.classList.toggle("sz-l", thumbSize.thumb >= 48);
  };
  function applyThumbPercent(value: number) {
    const v = clampThumbPercent(value);
    thumbValue.value = v + "%";
    thumbSlider.value = v;
    if (v === thumbPercent) return;
    const oldThumb = thumbSize.thumb;
    thumbPercent = v;
    thumbSize = thumbnailMetrics(v);
    ROW = thumbSize.row; SHORT = thumbSize.short; thumbsOn = v !== 0;
    try { localStorage.setItem(THUMB_PERCENT_KEY, String(v)); } catch { /* storage unavailable */ }
    renderThumbMetrics();
    // Only growing sizes require sharper image data; shrinking reuses the cached images.
    if (thumbSize.thumb > oldThumb) for (const c of thumbsByDoc.values()) c.invalidate("all");
    for (const r of pool) r.key = "";
    render();
  }
  const commitThumbValue = () => {
    const raw = thumbValue.value.replace(/[％%\s]/g, "");
    if (raw === "" || !Number.isFinite(Number(raw))) { thumbValue.value = thumbPercent + "%"; return; }
    applyThumbPercent(Number(raw));
  };
  thumbValue.addEventListener("keydown", e => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter") { e.preventDefault(); commitThumbValue(); thumbValue.blur(); }
    if (k === "Escape") { e.preventDefault(); thumbValue.value = thumbPercent + "%"; thumbValue.blur(); }
    e.stopPropagation();
  });
  thumbValue.addEventListener("blur", commitThumbValue);
  thumbValue.addEventListener("mousedown", e => e.stopPropagation());
  thumbButton.addEventListener("click", () => {
    setShown(filterPopup, false);
    const open = !isShown(thumbPopup);
    setShown(thumbPopup, open);
    if (open) { thumbValue.value = thumbPercent + "%"; thumbSlider.value = thumbPercent; }
  });
  const peekBtn = h("button", { class: "lt-head-btn", title: "悬停定位：鼠标停在一行上，就在 PS 里临时选中这个图层，画布上会框出它（需要移动工具勾选「显示变换控件」，或打开「视图 › 显示 › 图层边缘」）；移开后恢复原来的选中" }, "悬停定位");
  const renderPeekBtn = () => peekBtn.classList.toggle("off", !peekOn);
  peekBtn.addEventListener("click", () => {
    peekOn = !peekOn;
    try { localStorage.setItem("wp.layers.peek", peekOn ? "on" : "off"); } catch { /* not kept */ }
    renderPeekBtn();
    if (!peekOn) void endPeek();
  });
  renderPeekBtn();
  // Expand/collapse actions sit in the search row, right of the search box (11-04 top redesign).
  const folderExpandIcon = h("span", { class: "lt-action-icon" }, ic("folderOpen", 14));
  const fxExpandIcon = h("span", { class: "lt-action-icon lt-fx-action" }, h("span", {}, "fx"), icon("chevron", 9));
  const folderCollapseIcon = h("span", { class: "lt-action-icon" }, ic("folder", 14));
  const fxCollapseIcon = h("span", { class: "lt-action-icon lt-fx-action" }, h("span", {}, "fx"), icon("chevronRight", 9));
  const allCollapseIcon = h("span", { class: "lt-action-icon lt-stack-action" }, ic("layers", 14), icon("chevronUp", 8));
  const expandGroupsBtn = h("button", { class: "lt-expand-btn", title: "展开组：展开所有图层组", "aria-label": "展开组" }, folderExpandIcon);
  const expandEffectsBtn = h("button", { class: "lt-expand-btn", title: "展开效果：展开所有图层效果", "aria-label": "展开效果" }, fxExpandIcon);
  const collapseGroupsBtn = h("button", { class: "lt-expand-btn", title: "折叠组：折叠所有图层组", "aria-label": "折叠组" }, folderCollapseIcon);
  const collapseEffectsBtn = h("button", { class: "lt-expand-btn", title: "折叠效果：折叠所有图层效果", "aria-label": "折叠效果" }, fxCollapseIcon);
  const collapseAllBtn = h("button", { class: "lt-expand-btn", title: "折叠全部：折叠所有图层组、效果、智能滤镜和变体", "aria-label": "折叠全部" }, allCollapseIcon);
  const expandCollapseDivider = h("span", { class: "lt-expand-divider", "aria-hidden": "true" });
  const expandCollapseControls = h("div", { class: "lt-expand-controls" },
    expandGroupsBtn, expandEffectsBtn, expandCollapseDivider, collapseGroupsBtn, collapseEffectsBtn, collapseAllBtn);
  expandGroupsBtn.addEventListener("click", () => {
    if (docId === null) return;
    for (const l of layers) if (l.kind === "group" && !isVariantLayer(l)) expanded().add(l.id);
    render();
  });
  expandEffectsBtn.addEventListener("click", () => {
    if (docId === null) return;
    for (const l of layers) if (l.effectList.length && !isVariantLayer(l)) openSubs().add(l.id);
    render();
  });
  collapseGroupsBtn.addEventListener("click", () => {
    if (docId === null) return;
    expanded().clear();
    render();
  });
  collapseEffectsBtn.addEventListener("click", () => {
    if (docId === null) return;
    for (const l of layers) if (l.effectList.length && !isVariantLayer(l)) openSubs().delete(l.id);
    render();
  });
  collapseAllBtn.addEventListener("click", () => {
    if (docId === null) return;
    expanded().clear();
    openSubs().clear();
    render();
  });


  // Photoshop-style filter bar: name search, funnel menu, filter on/off, thumbnail menu.
  // A disabled filter switch suspends filtering without clearing any current conditions.
  let filterEnabled = true;
  const query = { text: "", kinds: new Set<LayerKind>(), advanced: new Set<AdvancedFilter>(), selectedIds: selected };
  const searchBox = h("input", { class: "field lt-search", type: "text", placeholder: "搜索图层", title: "搜索图层名称（Esc 清空）" }) as HTMLInputElement;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchBox.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query.text = searchBox.value; firstRow = 0; render(); }, 150);
  });
  searchBox.addEventListener("keydown", e => {
    if ((e as KeyboardEvent).key === "Escape") { searchBox.value = ""; query.text = ""; firstRow = 0; render(); }
  });
  const KINDS: [LayerKind, string, string][] = [
    ["pixel", "image", "像素图层"], ["adjustment", "adjust", "调整 / 填充图层"], ["text", "text", "文字图层"],
    ["shape", "shape", "形状图层"], ["smartObject", "smart", "智能对象"], ["group", "folder", "图层组"],
  ];
  const kindBtns = KINDS.map(([k, ico, tip]) => {
    const b = h("button", { class: "lt-filter-option", title: "只看" + tip + "（可多选，再点取消）" },
      ic(ico, 14), h("span", {}, tip));
    b.addEventListener("click", () => {
      if (query.kinds.has(k)) query.kinds.delete(k); else query.kinds.add(k);
      firstRow = 0; render();
    });
    return b;
  });

  // The previous three exclusive quick filters retain their exact semantics and counts.
  const FILTERS: [Filter, string, string, string][] = [
    ["shared", "共用", "psShared", "只看和其他图层共用内容的智能对象（改一个全部跟着变）"],
    ["uneditable", "不可编辑", "psUneditable", "只看内容是图片、矢量文件或外部链接的智能对象（可以用下面的「转为可编辑」）"],
    ["ai", "AI 结果", "spark", "只看 WavePlug 生成的结果组"],
  ];
  const allFilterBtn = h("button", { class: "lt-quick-option", title: "显示所有类型的图层" },
    h("span", { class: "lt-radio" }), "全部");
  allFilterBtn.addEventListener("click", () => { filter = "all"; firstRow = 0; render(); });
  const filterBtns = FILTERS.map(([f, label, ico]) => {
    const b = h("button", { class: "lt-quick-option", title: label }, ic(ico, 13), h("span", {}, label));
    b.addEventListener("click", () => { filter = filter === f ? "all" : f; firstRow = 0; render(); });
    return b;
  });
  const ADVANCED: [AdvancedFilter, string][] = [
    ["visible", "可见图层"], ["hidden", "隐藏图层"], ["locked", "已锁定"], ["unlocked", "未锁定"],
    ["empty", "空像素图层"], ["mask", "带蒙版"], ["clip", "剪贴蒙版"], ["effects", "有图层效果"],
    ["smartFilters", "有智能滤镜"], ["artboard", "画板"], ["selected", "已选中"],
  ];
  const advancedBtns = ADVANCED.map(([key, label]) => {
    const b = h("button", { class: "lt-advanced-option", title: "按" + label + "筛选" },
      h("span", { class: "lt-check-square" }), h("span", {}, label));
    b.addEventListener("click", () => {
      if (query.advanced.has(key)) query.advanced.delete(key);
      else {
        // The two opposite visibility/lock choices cannot be selected together.
        if (key === "visible") query.advanced.delete("hidden");
        if (key === "hidden") query.advanced.delete("visible");
        if (key === "locked") query.advanced.delete("unlocked");
        if (key === "unlocked") query.advanced.delete("locked");
        query.advanced.add(key);
      }
      firstRow = 0; render();
    });
    return b;
  });
  const advancedBox = h("div", { class: "lt-filter-advanced" },
    h("div", { class: "lt-advanced-grid" }, ...advancedBtns));
  setShown(advancedBox, false);
  const advancedButton = h("button", { class: "lt-filter-more", title: "高级筛选：图层属性、蒙版和效果" },
    ic("sliders", 14), "高级筛选", ic("chevron", 11));
  advancedButton.addEventListener("click", () => {
    setShown(advancedBox, !isShown(advancedBox));
    advancedButton.classList.toggle("on", isShown(advancedBox));
  });
  const clearFilterBtn = h("button", { class: "lt-filter-clear", title: "清空所有搜索和过滤条件" }, "清除筛选");
  clearFilterBtn.addEventListener("click", () => {
    query.kinds.clear(); query.advanced.clear(); query.text = ""; searchBox.value = ""; filter = "all";
    firstRow = 0; render();
  });
  const filterPopup = h("div", { class: "lt-top-popup lt-filter-popup" },
    h("div", { class: "lt-filter-title" }, h("span", {}, "图层类型"), clearFilterBtn),
    h("div", { class: "lt-filter-grid" }, ...kindBtns),
    h("div", { class: "lt-filter-title" }, h("span", {}, "快捷筛选")),
    h("div", { class: "lt-quick-grid" }, allFilterBtn, ...filterBtns),
    advancedButton, advancedBox);
  setShown(filterPopup, false);
  const funnelButton = h("button", { class: "lt-top-icon lt-funnel", title: "图层类型 / 快捷筛选 / 高级筛选" }, ic("psFilters", 16));
  funnelButton.addEventListener("click", () => {
    setShown(thumbPopup, false);
    setShown(filterPopup, !isShown(filterPopup));
  });
  // Photoshop's upright filter switch: knob up and lit while filtering is on
  const filterSwitch = h("button", { class: "lt-filter-switch on", title: "筛选开关：暂停 / 恢复筛选，不清空条件" }, ic("psToggleOn", 14));
  filterSwitch.addEventListener("click", () => { filterEnabled = !filterEnabled; firstRow = 0; render(); });
  // search | expand / collapse … funnel, switch at the far right; on a narrow panel (.lt-narrow) the
  // expand / collapse buttons drop to a line of their own under the search box
  const findRow = h("div", { class: "lt-find" }, searchBox, expandCollapseControls, h("span", { class: "grow" }),
    funnelButton, filterSwitch, filterPopup, thumbPopup);
  listen(document, "mousedown", e => {
    const t = e.target as Node;
    if (!filterPopup.contains(t) && !funnelButton.contains(t)) setShown(filterPopup, false);
    if (!thumbPopup.contains(t) && !thumbButton.contains(t)) setShown(thumbPopup, false);
  });
  const list = h("div", { class: "lt-list" });
  renderThumbMetrics();
  // The workbench lives immediately BELOW the layer list in the same UXP panel.
  // At rest it occupies no space; a normal layer drag reveals it automatically.
  const workbench = createWorkbenchSection(tree, () => ({
    docId,
    layerId: workbenchPlacementAnchor(true, docId !== null, layers, selected),
  }));
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
    // Photoshop 原生图层行只保留显示/隐藏眼睛；锁定统一使用面板顶部的锁定控件。
    const el = h("div", { class: "lt-row" }, stripe, eye, body);
    const r: RowEl = { index: 0, el, eye, twisty, name, body, key: "", id: 0, sub: null };
    // double-click on the name renames, as in Photoshop
    name.addEventListener("mousedown", () => { if (!r.sub) downZone = "name"; });
    name.addEventListener("dblclick", () => { if (!r.sub) onDouble(r.id, "name"); });
    eye.addEventListener("click", e => {
      e.stopPropagation();
      const s = r.sub;
      if (s?.line || s?.kind === "variants") return;
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
    for (const x of [eye, twisty]) x.addEventListener("mousedown", e => e.stopPropagation());
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
      const m = e as MouseEvent, zone = downZone ?? (r.sub?.kind === "effects" || (!r.sub && layers.find(x => x.id === r.id)?.artboard) ? "thumb" : null);
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
        onDouble(r.id, zone);
        return;
      }
      lastDown = { id: r.id, at: now, zone };
      // the 智能滤镜 / 效果 rows drag as in Photoshop: all the filters, or the whole style, onto another
      // layer (Alt copies) or the trash; their chips drag one by one (filterChips / effectChips)
      if (!r.sub) startDrag(r.id, m);
      else if (r.sub.kind === "filters") startDrag(r.id, m, { what: { kind: "filters", layerId: r.id }, row: r.index });
      else if (r.sub.kind === "effects") startDrag(r.id, m, { what: { kind: "effects", layerId: r.id }, row: r.index });
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

  /** The 效果 / 智能滤镜 row under a layer: an eye for all of them and each effect / filter a chip
   *  (several lines when they don't fit; only the first has the eye and the mark). */
  function fillFilter(r: RowEl, row: Row, index: number) {
    const l = row.layer, f = row.filter!, sel = selected.has(l.id), fx = f.kind === "effects";
    const allOn = fx ? l.effectsOn : l.filtersOn;
    const ds = drag?.active ? drag.sub : null;
    const moving = !!ds && ds.layerId === l.id && (ds.kind === "filters" && !fx || ds.kind === "effects" && fx);
    // the chip being dragged is drawn faded where it was
    const held = !ds || ds.layerId !== l.id ? "" : ds.kind === "filter" && !fx ? "f" + ds.pos : ds.kind === "effect" && fx ? ds.key + ds.multi : "";
    const more = !!f.line;
    const key = ["f", f.kind, l.id, more ? "" : framed(l), l.filterMask, maskView?.id === l.id && maskView.filter, f.name, f.enabled, allOn, l.depth, sel, moving, held, f.line, (f.chips ?? []).join(),
      fx ? l.effectList.map(e => e.name + +e.enabled).join() : l.filters.map(x => x.name + +x.enabled).join(), thumbPercent].join("|");
    r.index = index;
    setShown(r.el, true);
    if (key === r.key) return;
    r.key = key; r.id = l.id; r.sub = f;
    r.el.className = "lt-row lt-filter-row" + (sel ? " on" : "") + (f.enabled ? "" : " off") + (moving ? " moving" : "") + (r.el === hoverEl ? " hover" : "");
    (r.el.firstChild as HTMLElement).className = "lt-stripe";
    replace(r.eye, f.enabled && !more ? ic("eye", 14) : null);
    r.eye.className = "lt-eye" + (more ? " none" : f.enabled ? "" : " hidden");
    r.eye.style.backgroundColor = "";
    r.eye.title = more ? "" : fx ? (f.enabled ? "隐藏全部效果" : "显示全部效果") : (f.enabled ? "隐藏全部智能滤镜" : "显示全部智能滤镜");
    replace(r.name, f.name);
    r.name.className = "lt-name";
    const places = f.chips ?? (fx ? l.effectList : l.filters).map((_, i) => i);
    replace(r.body, h("div", { class: "lt-indent" }, ...Array.from({ length: l.depth + 1 }, () => h("span", { class: "lt-guide" }))),
      fx ? h("div", { class: "lt-mark" }, more ? null : h("span", { class: "lt-kind k-fx" }, "fx"))
        : h("div", { class: "lt-mark has-thumb" }, more ? null : filterMaskCell(l)),
      fx ? effectChips(l, places, r, held) : filterChips(l, places, r, held));
    r.el.title = fx ? `${l.name} 的图层样式（双击打开）。拖动这一行到别的图层上：移动整个样式（按住 Alt 复制，替换那个图层原有的样式）；拖到垃圾桶：清除`
      : `${l.name} 的智能滤镜，从右往左依次应用（和 PS 里从下往上一样）。拖动这一行到别的智能对象上：移动全部（按住 Alt 复制）；拖到垃圾桶：全部清除`;
  }

  /** Effect / filter chips need more than one line when they don't fit: the row becomes as many rows
   *  as it takes (fixed-height rows keep the list virtual). Chip widths are estimated from their text. */
  function layoutEffects(rs: Row[]): Row[] {
    const w = list.clientWidth || 300;
    const chipW = (name: string) => 16 + [...name].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 11.5 : 7), 0);
    return rs.flatMap(r => {
      if (r.filter?.kind === "variants") {
        const avail = w - LEAD - (r.layer.depth + 1) * INDENT - 10;
        // by number (v1 first), as the main panel lists them
        const num = (id: number) => Number(/^v(\d+)/.exec(byId.get(id)?.name ?? "")?.[1] ?? 0);
        const ids = r.layer.ai!.ids, order = ids.map((_, i) => i).sort((a, b) => num(ids[a]) - num(ids[b]));
        const lines = packChips(order.map(() => VCHIP_W), avail);
        return lines.map((chips, line) => ({ ...r, filter: { ...r.filter!, line, chips: chips.map(k => order[k]) } }));
      }
      if (r.filter?.kind !== "effects" && r.filter?.kind !== "filters") return [r];
      const fx = r.filter.kind === "effects";
      // after the fx mark, or the filter mask's box
      const avail = w - LEAD - (r.layer.depth + 1) * INDENT - (fx ? 22 : thumbSize.thumb + 8) - 10;
      const lines = packChips((fx ? r.layer.effectList : r.layer.filters).map(e => chipW(e.name)), avail);
      return lines.map((chips, line) => ({ ...r, filter: { ...r.filter!, line, chips } }));
    });
  }

  /** A chip's clicks: a press waits a moment, so a second press makes it a double-click (`edit`)
   *  rather than two `toggle`s — told from the presses, as UXP can lose the second click event; the
   *  native dblclick backs it up. A press can also start dragging the chip (`what`): then nothing
   *  is switched; held still, the switch comes on release. */
  function chipPress(chip: HTMLElement, layerId: number, row: RowEl, toggle: () => void, edit: () => void, what: (m: MouseEvent) => SubDrag) {
    let pending: ReturnType<typeof setTimeout> | null = null, editedAt = 0;
    const twice = () => {
      if (pending) { clearTimeout(pending); pending = null; }
      if (Date.now() - editedAt < DOUBLE_CLICK) return;
      editedAt = Date.now();
      edit();
    };
    chip.addEventListener("mousedown", ev => {
      ev.stopPropagation();
      const m = ev as MouseEvent;
      if (m.button !== 0) return;
      if (pending) { twice(); return; }
      const grabbed = what(m);
      startDrag(layerId, m, { what: grabbed, row: row.index });
      pending = setTimeout(() => {
        pending = null;
        if ("dragged" in grabbed && grabbed.dragged) return;
        const s = drag?.sub;
        if (s === grabbed && "chip" in s) { if (!drag!.active) s.toggleOnUp = toggle; return; } // still held: decided on release
        toggle();
      }, CHIP_DOUBLE);
    });
    chip.addEventListener("click", ev => ev.stopPropagation());
    chip.addEventListener("dblclick", ev => { ev.stopPropagation(); twice(); });
  }

  /** where a chip sits from its row's left edge, and the pointer pressed on it (for dragging it along the row) */
  const xInRow = (el: HTMLElement) => { let x = 0, e: HTMLElement | null = el; while (e && !e.classList.contains("lt-row")) { x += e.offsetLeft; e = e.offsetParent as HTMLElement | null; } return x; };

  /** 图层样式 on one row: each effect a chip, click to switch it, double-click for the dialog, drag it
   *  onto another layer (move; Alt: copy), onto 新建图层 (another one here) or the trash (delete) */
  function effectChips(l: TreeLayer, places: number[], row: RowEl, held: string): HTMLElement {
    return h("div", { class: "lt-chips" }, ...places.map(i => l.effectList[i]).map(e => {
      const chip = h("span", { class: "lt-chip" + (e.enabled && l.effectsOn ? "" : " off") + (held === e.key + e.multi ? " held" : ""),
        title: `${e.name}：单击${e.enabled ? "隐藏" : "显示"}，双击打开图层样式。拖到别的图层上移动（按住 Alt 复制），拖到「新建图层」按钮上在本图层再加一个，拖到垃圾桶删除` }, e.name);
      chipPress(chip, l.id, row,
        () => void run("toggleEffect", [l.id], JSON.stringify({ key: e.key, multi: e.multi, on: !e.enabled })),
        () => void run("effectStyle", [l.id], JSON.stringify({ key: e.key, multi: e.multi })),
        () => ({ kind: "effect", layerId: l.id, key: e.key, multi: e.multi, name: e.name, chip }));
      return chip;
    }));
  }

  /** 智能滤镜 on one row, in Photoshop's order (it applies them bottom up: here right to left): click
   *  to switch one, double-click for its dialog, drag it along the row (reorder) or onto another smart
   *  object (move; Alt: copy), onto 新建图层 (a copy here) or the trash (delete) */
  function filterChips(l: TreeLayer, places: number[], row: RowEl, held: string): HTMLElement {
    return h("div", { class: "lt-chips" }, ...places.map(i => {
      const f = l.filters[i];
      const chip = h("span", { class: "lt-chip lt-fchip" + (f.enabled && l.filtersOn ? "" : " off") + (held === "f" + i ? " held" : ""),
        title: `智能滤镜：${f.name}。单击${f.enabled ? "隐藏" : "显示"}，双击重新打开设置。左右拖动调整顺序，拖到别的智能对象上移动（按住 Alt 复制），拖到「新建图层」按钮上复制一份，拖到垃圾桶删除` }, f.name);
      chipPress(chip, l.id, row,
        () => void run("toggleFilter", [l.id], JSON.stringify({ index: i + 1 })),
        () => void run("editFilter", [l.id], JSON.stringify({ pos: i })),
        m => ({ kind: "filter", layerId: l.id, pos: i, name: f.name, chip, x: xInRow(chip) + (typeof m.offsetX === "number" ? m.offsetX : 0) }));
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
    del.addEventListener("mousedown", e => e.stopPropagation());
    del.addEventListener("click", e => { e.stopPropagation(); void run("deleteVariant", [l.id], String(id)); });
    const chip = h("span", { class: "lt-vchip" + (on ? " on" : ""), title: name + (on ? "（当前显示）" : "\n单击：换成这个变体") },
      thumbsOn ? h("span", { class: "lt-vpic" }, url ? thumbImg(url) : null) : null, "v" + num, del);
    chip.addEventListener("mousedown", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      const at = rows.findIndex(r => r.layer.id === l.id && r.filter?.kind === "variants");
      if (m.button === 0 && at >= 0) startDrag(l.id, m, { what: { kind: "variant", layerId: l.id, variantId: id }, row: at });
    });
    chip.addEventListener("click", e => { e.stopPropagation(); if (suppressClick) return; if (!on) void run("showVariant", [l.id], String(id)); });
    return chip;
  }

  function fill(r: RowEl, row: Row, index: number) {
    if (row.filter?.kind === "variants") { fillVariants(r, row, index); return; }
    if (row.filter) { fillFilter(r, row, index); return; }
    // filtered lists show every match whatever is collapsed
    const l = row.layer, sel = selected.has(l.id), vl = isVariantLayer(l);
    // open: a group's layers shown; another layer's effects (its smart filters: openSubs has minus its
    // id); a variant layer's (an AI group shown as one layer) variations
    const open = l.kind !== "group" || vl ? openSubs().has(l.id) : filterEnabled && (filter !== "all" || queryActive(query)) || !collapsed.has(l.id);
    // a variant layer's picture is its shown variation's
    const shown = vl && thumbsOn ? l.ai!.shown : null;
    const moving = !!drag?.active && drag.ids.includes(l.id), thumb = shown !== null ? thumbs().get(shown) : hasThumb(l) ? thumbs().get(l.id) : undefined;
    const maskThumb = l.mask && thumbsOn ? thumbs().get(maskKey(l.id)) : undefined;
    const vmaskThumb = l.vmask && thumbsOn ? thumbs().get(vmaskKey(l.id)) : undefined;
    const key = [l.id, l.name, l.visible, l.locked, l.lockAll, l.lockPosition, l.lockPixels, l.lockTransparency, groupLocked.has(l.id), l.links.length, peers.has(l.id), sharedColor(l), l.mask, l.maskOn, l.clipped, l.clipBase, l.effects, l.effectsOn, l.depth, l.children, l.ai?.variations, l.smart?.contentId, l.smart?.linked, l.smart?.file, l.filters.length, l.filtersOn, l.effectList.map(e => +e.enabled).join(""), groupColor.get(l.id),
      users.get(l.smart?.contentId ?? "") ?? 0, sel, open, row.context, moving, thumbs().version(l.id), thumbs().version(maskKey(l.id)), thumbs().version(vmaskKey(l.id)), l.vmask, l.vmaskOn, l.maskLinked, l.vmaskLinked, l.color, customOf(l.id), maskView?.id === l.id, hasPicture(l), framed(l), thumbW(l), openSubs().has(-l.id), shown, shown !== null ? thumbs().version(shown) : 0, l.ai?.shown].join("|");
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
    // a variant layer opens its variations from the ✦ on its picture, not a twisty
    // effects and smart filters open from their status icons (fx / 智能滤镜), not a twisty
    const folds = !vl && l.kind === "group" && l.children > 0;
    replace(r.twisty, folds ? (open ? "▾" : "▸") : "");
    r.twisty.title = !folds ? "" : open ? "折叠" : "展开";
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
      zoneOf(h("div", { class: "lt-mark" + (pictured ? " has-thumb" : ""), style: pictured ? `width: ${thumbW(l) + 2}px` : "", title: l.kind === "smartObject"
          ? "双击：编辑智能对象内容（PNG 自动转换为可编辑 PSB）；Ctrl+单击：载入选区"
          : "双击：图层样式；Ctrl+单击：载入选区（+Shift 添加，+Alt 减去）" }, mark), l.id, "thumb"),
      // as in Photoshop: picture ⛓ layer mask ⛓ vector mask, each chain its mask's link
      l.mask ? maskChain(l, false) : null,
      l.mask ? maskCell(l, maskThumb) : null,
      l.vmask ? maskChain(l, true) : null,
      l.vmask ? vmaskCell(l, vmaskThumb) : null,
      r.name,
      // the status icons this layer has, at the right in a fixed order and spacing (no empty places)
      h("div", { class: "lt-cells" }, ...COLS.filter(c => cellUsed(l, c)).map(c => cell(l, c, color, peer))));
    r.el.title = l.name + (vl ? `（变体图层，${l.ai!.variations} 个变体：双击 ✦ 选择变体；PS 图层面板里是图层组）` : l.kind === "group" ? `（图层组，${l.children} 个图层）` : "") + (l.clipBase ? "（剪贴蒙版的基底图层）" : "");
  }

  /** A smart object's mark on its picture: 独立 / 共用 (in its content's colour) / 外部链接;
   *  double-click opens the content. */
  function smartBadge(l: TreeLayer, color: number | undefined): HTMLElement | null {
    const t = l.kind === "smartObject" ? layerTags(l, users).find(x => x.cls === "own" || x.cls === "shared" || x.cls === "link") : undefined;
    if (!t) return null;
    const what = t.cls === "link" ? "外部链接" : t.cls === "shared" ? "共用内容（同色＝同一份内容）" : "内容独立";
    return zoneOf(h("span", { class: "lt-badge k-smart " + t.cls + (t.cls === "shared" && color !== undefined ? " c" + color : ""), title: `智能对象 · ${what}\n${t.tip}\n双击：编辑内容（PNG 自动转可编辑 PSB）` },
      ic(t.cls === "link" ? "external" : "smart", 10)), l.id, "status");
  }

  /** The layer mask's thumbnail: click selects the mask for painting, Shift+click turns it off / on. */
  function maskCell(l: TreeLayer, url: string | null | undefined): HTMLElement {
    const cell = h("div", { class: "lt-thumb lt-mask" + (l.maskOn ? "" : " off") + (maskView?.id === l.id && !maskView.filter ? " viewing" : "") + (framed(l) === "mask" ? " lt-target" : ""), style: `width: ${thumbW(l)}px`, title: (l.maskOn ? "图层蒙版：单击选中蒙版来编辑，Shift+单击停用，Ctrl+单击载入选区，Alt+单击只看蒙版（Alt+Shift：红色叠加），再按一次恢复" : "图层蒙版已停用：Shift+单击启用，Ctrl+单击载入选区") + "\n拖到其他图层：移动蒙版；Alt+拖动：复制；拖到左侧红区或垃圾桶：删除" },
      url ? thumbImg(url) : null);
    cell.addEventListener("mousedown", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      if (m.button === 0) startDrag(l.id, m, { what: { kind: "mask", layerId: l.id }, row: rowOf(l.id) });
    });
    cell.addEventListener("click", e => {
      e.stopPropagation();
      if (suppressClick) return;
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
      title: l.filterMask ? "智能滤镜蒙版：单击选中来编辑（单击图层缩略图回到图层），Ctrl+单击载入选区（+Shift 添加，+Alt 减去），Alt+单击只看蒙版（Alt+Shift：红色叠加），再按一次恢复\n拖到其他含智能滤镜且无滤镜蒙版的智能对象：移动；Alt+拖动：复制；拖到红区或垃圾桶：删除" : "没有智能滤镜蒙版" });
    if (!l.filterMask) return cell;
    // the same clicks as the layer mask's
    cell.addEventListener("mousedown", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      const at = rows.findIndex(r => r.layer.id === l.id && r.filter?.kind === "filters");
      if (m.button === 0 && at >= 0) startDrag(l.id, m, { what: { kind: "filterMask", layerId: l.id }, row: at });
    });
    cell.addEventListener("click", e => {
      e.stopPropagation();
      if (suppressClick) return;
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
    const cell = h("div", { class: "lt-mlink" + (on ? "" : " off"), title: on ? "蒙版和图层链接在一起（一起移动）：单击取消链接" : "蒙版没有和图层链接：单击链接" }, on ? ic("chainV", 11) : null);
    cell.addEventListener("mousedown", e => e.stopPropagation());
    cell.addEventListener("click", e => { e.stopPropagation(); void run("toggleMaskLink", [l.id], JSON.stringify({ vector, on: !on })); });
    return cell;
  }

  /** The vector mask's thumbnail: click selects it, Shift+click turns it off / on, Ctrl+click loads its path as the selection. */
  function vmaskCell(l: TreeLayer, url: string | null | undefined): HTMLElement {
    const cell = h("div", { class: "lt-thumb lt-mask lt-vmask" + (l.vmaskOn ? "" : " off") + (framed(l) === "vmask" ? " lt-target" : ""), style: `width: ${thumbW(l)}px`, title: (l.vmaskOn ? "矢量蒙版：单击选中，Shift+单击停用，Ctrl+单击载入选区" : "矢量蒙版已停用：Shift+单击启用，Ctrl+单击载入选区") + "\n拖到其他图层：移动蒙版；Alt+拖动：复制；拖到红区或垃圾桶：删除" },
      url ? thumbImg(url) : null);
    cell.addEventListener("mousedown", e => {
      e.stopPropagation();
      const m = e as MouseEvent;
      if (m.button === 0) startDrag(l.id, m, { what: { kind: "vmask", layerId: l.id }, row: rowOf(l.id) });
    });
    cell.addEventListener("click", e => {
      e.stopPropagation();
      if (suppressClick) return;
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
    const open = openSubs().has(l.id);
    const cell = h("span", { class: "lt-col col-fx lt-fx" + (l.effectsOn ? "" : " off") + (open ? " open" : ""),
      title: (l.effectsOn ? "图层样式" : "图层样式（已隐藏）") + `：单击${open ? "收起" : "展开"}效果；拖到别的图层上移动整个样式（按住 Alt 复制），拖到垃圾桶清除；双击缩略图打开图层样式` }, "fx");
    // dragged like Photoshop's fx icon: onto another layer (move; Alt: copy), the trash (clear)
    cell.addEventListener("mousedown", e => { e.stopPropagation(); startDrag(l.id, e as MouseEvent, { what: { kind: "effects", layerId: l.id }, row: rowOf(l.id) }); });
    cell.addEventListener("click", e => { e.stopPropagation(); if (!suppressClick) toggleSub(l.id); });
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
  /** a layer's own row in the list now (rows move as groups open and the list scrolls) */
  const rowOf = (id: number) => Math.max(0, rows.findIndex(x => x.layer.id === id && !x.filter));
  function cell(l: TreeLayer, c: Col, color: number | undefined, peer: boolean): HTMLElement {
    const box = (cls: string, tip: string, ...kids: (Node | null)[]) => h("span", { class: `lt-col col-${c} ${cls}`, title: tip }, ...kids);
    if (!cellUsed(l, c)) return h("span", { class: `lt-col col-${c}` });
    const tag = (cls: string[]) => layerTags(l, users).find(t => cls.includes(t.cls.split(" ")[0]));
    switch (c) {
      case "content": { const t = tag(["edit", "content"])!; return box(t.cls + " " + t.icon, "智能对象内容 · " + t.text + "\n" + t.tip, ic(t.icon, 14)); }
      case "filters": {
        // a click opens / closes the 智能滤镜 row, as the fx cell does the effects
        const t = tag(["filters"])!, open = openSubs().has(-l.id);
        const b = box(t.cls + " lt-subcell" + (open ? " open" : ""), `智能滤镜：单击${open ? "收起" : "展开"}；拖到别的智能对象上移动全部（按住 Alt 复制），拖到垃圾桶清除\n` + t.tip, ic("filters", 14));
        // dragged like Photoshop's smart filter icon: onto another smart object (move; Alt: copy), the trash (clear)
        b.addEventListener("mousedown", e => { e.stopPropagation(); startDrag(l.id, e as MouseEvent, { what: { kind: "filters", layerId: l.id }, row: rowOf(l.id) }); });
        b.addEventListener("click", e => { e.stopPropagation(); if (!suppressClick) toggleSub(-l.id); });
        return b;
      }
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
  let inView: TreeLayer[] = [], thumbTimer: ReturnType<typeof setTimeout> | null = null, retryTimer: ReturnType<typeof setTimeout> | null = null, fetching = false;
  function queueThumbs(delay = 150) {
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => { thumbTimer = null; void fetchThumbs(); }, delay);
  }
  /** wakes the queue when the next failed thumbnail is due again */
  function scheduleRetry() {
    const now = Date.now(), due = [...retryAt.values()].filter(t => t > now);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = due.length ? setTimeout(() => { retryTimer = null; queueThumbs(0); }, Math.min(...due) - now + 100) : null;
  }
  async function fetchThumbs() {
    // nothing to do while the list isn't on screen (another page, a hidden panel) or a drag runs
    if (fetching || docId === null || drag?.active || !list.clientHeight) return;
    const now = Date.now();
    // a variant layer: its shown variation, all of them while they are listed
    const variants = (l: TreeLayer) => !thumbsOn || !isVariantLayer(l) ? [] : openSubs().has(l.id) ? l.ai!.ids : l.ai!.shown !== null ? [l.ai!.shown] : [];
    const keys = [...new Set(inView.flatMap(l => [...hasThumb(l) ? [l.id] : [], ...variants(l), ...l.mask && thumbsOn ? [maskKey(l.id)] : [], ...l.vmask && thumbsOn ? [vmaskKey(l.id)] : []]))].filter(k => (retryAt.get(k) ?? 0) <= now);
    const want = thumbs().next(keys, THUMB_BATCH);
    if (!want.length) { scheduleRetry(); return; }
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
        // Photoshop was busy: keep any older picture, show none after a few tries, and keep asking
        // less and less often (core thumbRetryDelay)
        const n = (failures.get(x.key) ?? 0) + 1;
        failures.set(x.key, n);
        if (n >= 3 && cache.get(x.key) === undefined) cache.put(x.key, null);
        cache.invalidate([x.key]);
        retryAt.set(x.key, Date.now() + thumbRetryDelay(n));
      });
      scheduleRetry();
      if (doc === docId) draw();
      refocus("thumbnails");
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
  listen(document, "mousemove", e => {
    if (!thumbDrag) return;
    const H = list.clientHeight || 1, th = sthumb.offsetHeight, room = Math.max(1, H - th);
    const n = thumbDrag.f0 + Math.round(((e as MouseEvent).clientY - thumbDrag.y0) / room * maxFirst());
    scrollRows(n - firstRow);
  });
  listen(document, "mouseup", () => { thumbDrag = null; });


  function render() {
    const exp = expanded();
    collapsed = new Set(layers.filter(l => l.kind === "group" && !exp.has(l.id)).map(l => l.id));
    query.selectedIds = selected;
    const effectiveFilter = filterEnabled ? filter : "all";
    const effectiveQuery = filterEnabled ? query : undefined;
    rows = layoutEffects(visibleRows(layers, collapsed, effectiveFilter, users, openSubs(), effectiveQuery));
    groupLocked = lockedByGroup(layers);
    KINDS.forEach(([k], i) => kindBtns[i].classList.toggle("on", query.kinds.has(k)));
    ADVANCED.forEach(([k], i) => advancedBtns[i].classList.toggle("on", query.advanced.has(k)));
    allFilterBtn.classList.toggle("on", filter === "all");
    funnelButton.classList.toggle("has", filter !== "all" || queryActive(query));
    if (filterSwitch.classList.contains("on") !== filterEnabled) replace(filterSwitch, ic(filterEnabled ? "psToggleOn" : "psToggleOff", 14));
    filterSwitch.classList.toggle("on", filterEnabled);
    findRow.classList.toggle("paused", !filterEnabled);
    activeContents = new Set(layers.filter(l => selected.has(l.id) && l.smart?.contentId).map(l => l.smart!.contentId!));
    boardOf = new Map(); boardColor = new Map();
    let board: number | null = null, auto = 0;
    for (const l of layers) {
      if (l.depth === 0) board = l.artboard ? l.id : null;
      if (l.depth === 0 && l.artboard) boardColor.set(l.id, customOf(l.id) ?? LABELS.find(([k]) => k === l.color)?.[2] ?? AUTO_FRAMES[auto++ % AUTO_FRAMES.length]);
      if (board !== null) boardOf.set(l.id, board);
    }
    groupColor = new Map();
    for (const l of layers) {
      const c = sharedColor(l);
      if (c !== undefined) for (let g = l.parentId; g !== null && !groupColor.has(g); g = byId.get(g)?.parentId ?? null) groupColor.set(g, c);
    }
    peerList = linkPeers(layers, selected);
    const peerKey = peerList.join(",");
    if (peerKey !== [...peers].join(",")) peerAt = 0;
    peers = new Set(peerList);
    replace(peersBtn, ic("link", 12), ` 链接 ${peerList.length}`);
    setShown(peersBtn, peerList.length > 0);
    const counts = filterCounts(layers, users);
    FILTERS.forEach(([f, label, , tip], i) => {
      const n = counts[f as Exclude<Filter, "all">];
      filterBtns[i].title = `${label}（${n} 个）：${tip}${filter === f ? "；再点一次显示全部" : ""}`;
      filterBtns[i].classList.toggle("on", filter === f);
      (filterBtns[i] as any).disabled = docId === null || (!n && filter !== f);
    });
    replace(countEl, docId === null ? "" : `${layers.length} 个` + (selected.size ? ` · 已选 ${selected.size}` : ""));
    const groupsDisabled = docId === null || (filterEnabled && (filter !== "all" || queryActive(query)));
    (expandGroupsBtn as any).disabled = (collapseGroupsBtn as any).disabled = groupsDisabled;
    (expandEffectsBtn as any).disabled = (collapseEffectsBtn as any).disabled = (collapseAllBtn as any).disabled = docId === null;
    setShown(empty, !rows.length);
    replace(empty, docId === null ? "未打开文档" : !layers.length ? "文档里没有图层" : "没有符合筛选的图层");
    renderBar();
    draw();
  }

  /** Brings the first selected layer into view (opening its groups), after Photoshop changed the selection. */
  function reveal() {
    const first = layers.find(l => selected.has(l.id));
    if (!first) return;
    if (!filterEnabled || filter === "all" && !queryActive(query)) { const exp = expanded(); for (const g of ancestors(layers, first.id)) exp.add(g); }
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
  /** When Photoshop refuses to deselect (e.g. only Background is left), keep the panel blank
   *  until the host selection actually changes or the user picks a row. */
  let lastHostSelection: { docId: number; ids: number[] } | null = null;
  let localClear: { docId: number; hostIds: number[] } | null = null;
  function holdEmptySelection(before: number[]) {
    if (docId === null) return;
    localClear = { docId, hostIds: lastHostSelection?.docId === docId ? [...lastHostSelection.ids] : [...before] };
  }
  /** the list's own selection on its way to Photoshop: `selecting` requests in flight, and a count of
   *  clicks, so a read that saw Photoshop's selection from before can't put it back (a flash of the
   *  old layer before the new one) */
  let selecting = 0, selectGen = 0;
  /** Serialise Photoshop selection changes. Rapid Ctrl/Shift clicks must not overlap modal calls. */
  let selectTail: Promise<void> = Promise.resolve();
  async function refresh() {
    // Ignore intermediate selections and layer states during a batch delete. The delete command
    // itself requests a fresh read after Photoshop commits its history step.
    if (deleting || orderPreview) return;
    // while a row is previewed only the selection changes, and that is ours: read once it ends
    if (peekHold) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      do {
        again = false;
        const gen = selectGen;
        const r = await tree.read().catch(e => { log("warn", "layer tree read", e); return null; });
        if (deleting || orderPreview) return; // a pre-move read must not overwrite the optimistic order
        // the list chose layers while this was read: keep its selection and read again afterwards
        const stale = selecting > 0 || gen !== selectGen;
        const before = [...selected].sort().join(",");
        if (!r) { docId = null; layers = []; byId = new Map(); selected = new Set(); users = new Map(); localClear = null; lastHostSelection = null; }
        else {
          docKey = r.docKey;
          lastHostSelection = { docId: r.docId, ids: [...r.selected] };
          if (localClear) {
            if (localClear.docId !== r.docId || !selectionAfterLocalClear(r.selected, localClear.hostIds).keepClear) localClear = null;
          }
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
          if ((!peekHold && !stale) || r.docId !== docId) selected = localClear ? new Set() : new Set(r.selected);
          else if (stale && !peekHold) again = selecting === 0;
          docId = r.docId; layers = r.layers; byId = new Map(layers.map(l => [l.id, l])); users = contentUsers(layers); colors = sharedColors(layers, users); canvas = { width: r.width, height: r.height };
        }
        const now = [...selected].sort().join(",");
        if (now !== before && now !== ownSelect && selected.size) reveal(); else render();
        if (now === ownSelect) ownSelect = null;
      } while (again);
    } finally { reading = false; }
  }

  /** Commit the panel selection to Photoshop, including the empty selection. The generation
   *  check prevents a previous Ctrl/Shift click from restoring layers after a blank-area click. */
  async function commitSelection(why: "select" | "clear") {
    if (docId === null || deleting) return;
    ownSelect = [...selected].sort().join(",");
    const gen = ++selectGen, doc = docId, wanted = layers.filter(l => selected.has(l.id)).map(l => l.id);
    selecting++;
    render();
    const job = selectTail.then(async () => {
      if (gen !== selectGen || doc !== docId || deleting) return;
      await endPeek(false);
      if (gen !== selectGen || doc !== docId || deleting) return;
      await tree.select(doc, wanted);
    });
    selectTail = job.catch(() => undefined);
    try {
      await job;
    } catch (e) { log("warn", "layer tree select", e); status(`选择图层失败：${(e as Error).message ?? e}`, "error"); ownSelect = null; }
    finally { selecting--; refocus(why); }
    // Photoshop has it now: one read brings the rest (shared contents, links …) up to date
    if (!selecting) void refresh();
  }

  async function clickRow(id: number, mods: { ctrl: boolean; shift: boolean }) {
    if (docId === null || deleting) return;
    const before = [...selected];
    const r = clickSelect(rows.filter(x => !x.filter).map(x => x.layer.id), layers.filter(l => selected.has(l.id)).map(l => l.id), anchor, id, mods);
    anchor = r.anchor;
    selected = new Set(r.ids);
    if (selected.size) localClear = null; else holdEmptySelection(before);
    if (focus && !(selected.size === 1 && selected.has(focus.id))) focus = null;
    await commitSelection("select");
  }

  // Only the unused space of the layer list (below the last row or its empty-state label)
  // clears selection. Don't let a row drag ending in that space, a scrollbar press, or a
  // toolbar/search click accidentally deselect layers.
  const blankListTarget = (target: EventTarget | null) => target === list || target === inner || target === empty;
  let blankPress: { x: number; y: number } | null = null;
  list.addEventListener("mousedown", e => {
    const m = e as MouseEvent;
    blankPress = blankListTarget(e.target) && m.button === 0 && !m.ctrlKey && !m.metaKey && !m.shiftKey && !m.altKey
      ? { x: m.clientX, y: m.clientY } : null;
  });
  list.addEventListener("click", e => {
    const press = blankPress, m = e as MouseEvent;
    blankPress = null;
    if (!press || !blankListTarget(e.target) || Math.abs(m.clientX - press.x) > 4 || Math.abs(m.clientY - press.y) > 4
      || drag?.active || thumbDrag || deleting || docId === null || !selected.size) return;
    holdEmptySelection([...selected]);
    selected = new Set();
    anchor = null;
    focus = null;
    log("info", "layer panel clear selection", "blank");
    void commitSelection("clear");
  });

  /** the switch being dragged, on layer `l` */
  const paintGet = (l: TreeLayer) => l.visible;
  function paintSet(l: TreeLayer, on: boolean) { l.visible = on; }
  /** the drag is over row `index`: the rows from the pressed one to it switched, the others as they were */
  function paintTo(index: number) {
    if (!paint) return;
    const lo = Math.min(paint.start, index), hi = Math.max(paint.start, index), inRange = new Set<number>();
    for (let i = lo; i <= hi; i++) {
      const row = rows[i], l = row?.layer;
      if (!l || row.filter) continue;
      inRange.add(l.id);
      if (!paint.orig.has(l.id)) paint.orig.set(l.id, paintGet(l));
      paintSet(l, paint.to);
    }
    for (const [id, was] of paint.orig) {
      const l = byId.get(id);
      if (l && !inRange.has(id)) paintSet(l, was);
    }
    render();
  }
  listen(document, "mouseup", () => {
    const d = paint, doc = docId;
    paint = null;
    if (!d || doc === null) return;
    const ids = [...d.orig].filter(([, was]) => was !== d.to).map(([id]) => id)
      .filter(id => { const l = byId.get(id); return l && paintGet(l) === d.to; });
    if (!ids.length) return;
    tree.setVisible(doc, ids, d.to)
      .catch(e => { log("warn", "layer tree visible", e); status(`显示/隐藏失败：${(e as Error).message ?? e}`, "error"); void refresh(); });
  });

  /** the 效果 row (a layer's id) or the 智能滤镜 row (minus its id) under a layer: shown / hidden */
  function toggleSub(key: number) {
    const c = openSubs();
    if (c.has(key)) c.delete(key); else c.add(key);
    render();
  }

  function toggleGroup(id: number) {
    const l = layers.find(x => x.id === id);
    if (l && isVariantLayer(l)) {
      const c = openSubs();
      if (c.has(id)) c.delete(id); else c.add(id);
      render();
      return;
    }
    if (filterEnabled && (filter !== "all" || queryActive(query)) || l?.kind !== "group") return;
    const exp = expanded();
    if (exp.has(id)) exp.delete(id); else exp.add(id);
    render();
  }

  // ── layer commands (right-click menu, toolbar, mask / fx cells) ──
  async function run(action: LayerAction | SmartAction, ids: number[], arg?: string, opts?: RunOptions) {
    if (docId === null) return;
    // Delete from keyboard, toolbar, right-click menu and drag-to-trash must all use the same
    // guard. Previously only the keyboard/toolbar had protection against concurrent deletes.
    const destructive = action === "delete" || action === "deleteMask" || action === "applyMask"
      || action === "deleteVectorMask" || action === "deleteFilterMask"
      || action === "deleteVariant" || action === "deleteFilter"
      || action === "deleteFilters" || action === "deleteEffect" || action === "clearStyle";
    if (destructive && deleting) {
      log("info", "layer delete busy", action, JSON.stringify(ids));
      return;
    }
    if (destructive) deleting = true;
    const doc = docId, generation = selectGen;
    const artboardIds = action === "delete" ? ids.filter(id => byId.get(id)?.artboard) : [];
    const startedAt = Date.now();
    let deleteReported = false;
    let deleteHadError = false;
    const afterDeleteSelect = action === "delete"
      ? nextLayerAfterDelete(layers, ids, [...new Set(rows.filter(r => !r.filter).map(r => r.layer.id))]) : null;
    try {
      // A quick succession of Ctrl/Shift clicks can leave selection modals in flight.
      await selectTail;
      // Delete targets explicit layer IDs, so a hover-preview restoration is unnecessary and
      // may fail if the old previewed layer has already disappeared.
      await endPeek(action !== "delete");
      if (artboardIds.length) {
        const boardName = byId.get(artboardIds[0])?.name ?? "画板";
        status(`正在删除画板「${boardName}」… Photoshop 可能需要较长时间处理其内容`, "busy");
        // Allow UXP to paint the busy state before Photoshop enters a potentially long modal.
        await new Promise<void>(resolve => setTimeout(resolve, 30));
      }
      if (isSmartAction(action)) {
        if (!tools) return;
        // Legacy LayerTools reads Photoshop.activeLayers, not the WaveLayer row ID.
        // Always commit the exact targets before a smart shortcut, particularly the
        // 链接×N double-click's makeUnique operation.
        const r = await onSmartTarget(ids, ids => tree.select(doc, ids), async () =>
          action === "convertTogether" ? tools.convert(false)
          : action === "convertSeparately" ? tools.convert(true)
          : action === "resetTransform" ? tools.resetTransform()
          : action === "replaceContents" ? tools.replaceContents()
          : action === "exportContents" ? tools.exportContents()
          : tools[action]());
        if (r) status(resultText(SMART_VERB[action], r), r.done ? "ok" : "error");
        else status("已取消", "info");
      } else {
        const result = await tree.run(doc, action, ids, arg,
          action === "delete" ? { ...opts, afterDeleteSelect, artboardIds } : opts);
        if (action === "delete" && result && result.kind === "delete") {
          deleteReported = true;
          if (result.skipped.length) {
            const reasons = result.skipped.slice(0, 3).map(s => s.name + "：" + s.reason).join("；");
            status("已删除 " + result.deleted.length + " 个图层，跳过 " + result.skipped.length + " 个。" + reasons
              + (result.skipped.length > 3 ? "…" : ""), result.deleted.length ? "info" : "error");
          } else if (!result.deleted.length) status("没有可删除的图层", "error");
          else if (artboardIds.length) {
            const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            status(`画板已删除（用时约 ${seconds} 秒）`, "ok");
          }
          if (docId === doc && selectGen === generation) {
            // Use Photoshop's confirmed post-delete selection, not the predicted next row.
            selected = result.selected === null ? new Set() : new Set([result.selected]);
            anchor = result.selected;
            focus = null;
            localClear = null;
            ownSelect = [...selected].sort().join(",");
            selectGen++;
            log("info", "layer panel delete next", result.selected ?? "none");
            if (selected.size) reveal(); else render();
          }
        }
      }
    } catch (e) {
      deleteHadError = true;
      log("warn", "layer command", action, e);
      status("操作失败：" + ((e as Error).message ?? e), "error");
    } finally {
      if (destructive) deleting = false;
      if (artboardIds.length && !deleteReported && !deleteHadError && docId === doc) {
        // An unexpected void result must not leave a permanent "deleting" message behind.
        status("画板删除操作已结束，请检查图层列表", "info");
      }
      refocus(action);
      void refresh();
    }
  }

  // ── drag to reorder: the selected layers (or the one grabbed), dropped above / below / into a row ──
  // Positions are kept relative to the list's visible area (`view`, px from its top) and never come
  // from getBoundingClientRect, whose coordinates don't match the mouse's in UXP. The pointer's
  // movement since the grab gives `view`; while it is over the list, a transparent layer laid over
  // the rows reports the exact spot (offsetY), which corrects for where in the row it was grabbed.
  // Dropped on the toolbar's 新建组 / 新建图层 / 删除 buttons, the layers are grouped / copied / deleted.
  /** what a press on a sub row grabbed: one filter / effect chip (`name`, the `chip` and its switch to
   *  run if let go without dragging; a filter: `x`, the pointer from the row's left edge), or the
   *  whole 智能滤镜 / 效果 row */
  type SubDrag = { kind: "filter"; layerId: number; pos: number; name: string; chip: HTMLElement; x: number; toggleOnUp?: () => void; dragged?: boolean }
    | { kind: "filters"; layerId: number } | { kind: "effects"; layerId: number }
    | { kind: "effect"; layerId: number; key: string; multi: number; name: string; chip: HTMLElement; toggleOnUp?: () => void; dragged?: boolean }
    | { kind: "mask" | "vmask" | "filterMask"; layerId: number }
    | { kind: "variant"; layerId: number; variantId: number };
  let drag: {
    ids: number[]; y0: number; view0: number; fix: number; view: number; active: boolean; probed: boolean;
    target: { id: number; where: Where; plan: MoveStep[] } | null;
    /** dragging a smart filter / all of them / one effect / the whole style instead of layers; where a
     *  filter would go (`toPos` as moved, `insertAt` as copied), the layer the rest would go onto, and
     *  whether Alt is down (copy) */
    sub: SubDrag | null; ftarget: { layerId: number; toPos: number; insertAt: number } | null; ltarget: number | null; alt: boolean;
    /** the pointer across the list: where it was pressed (clientX) and now, from a row's left edge (filter chips) */
    x0: number; px: number;
    hover: number | null; overTool: HTMLElement | null;
    canDelete: boolean; overLeftDelete: boolean; overWorkbench: boolean;
    pointerX: number; pointerY: number;
    hoverTimer: ReturnType<typeof setTimeout> | null; scroller: ReturnType<typeof setInterval> | null;
  } | null = null;
  // Mousemove can fire much more often than the active drop target changes. Recompute
  // the multi-layer drag plan only when the hovered row/zone/Alt state or tree changes.
  let dragPlanCache: { tree: TreeLayer[]; id: number; where: Where; alt: boolean; plan: MoveStep[] | null } | null = null;
  let suppressClick = false;
  const marker = h("div", { class: "lt-drop" });
  setShown(marker, false);
  const hit = h("div", { class: "lt-hit" });
  setShown(hit, false);
  // a label beside the pointer while dragging: what is dragged and what letting go here would do
  const ghost = h("div", { class: "lt-ghost" });
  setShown(ghost, false);
  inner.append(marker, hit);
  // Drag label belongs to the WHOLE WaveLayer panel, not the scroll-clipped layer list.
  // It stays under the pointer when the workbench appears below the list.
  // A fixed overlay on the left edge of the visible list: no new column and no layout shift.
  // It receives mouse enter/leave only *during* a draggable, deletable item. Never takes a click
  // from the left-hand eye / movement / editing controls in the resting panel.
  const leftDelete = h("div", { class: "lt-left-delete", title: "松开鼠标删除（Ctrl+Z 可撤销）" }, ic("trash", 15));
  setShown(leftDelete, false);
  list.append(leftDelete);
  leftDelete.addEventListener("mouseenter", () => {
    if (!drag?.active || !drag.canDelete) return;
    drag.overLeftDelete = true;
    leftDelete.classList.add("hot");
    track();
  });
  leftDelete.addEventListener("mouseleave", () => {
    if (drag) {
      drag.overLeftDelete = false;
      // Until the pointer moves over another row again, treat leaving the rail as cancel.
      // In particular, moving completely outside the panel must NOT turn into a stale reorder.
      drag.target = null; drag.ftarget = null; drag.ltarget = null;
      setShown(marker, false);
    }
    leftDelete.classList.remove("hot");
  });
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

  // Cached overlay content, size and panel bounds: mousemove should never rebuild DOM
  // or force a synchronous layout read at 60+ events/second.
  let ghostContent = "";
  let ghostSize = { width: 160, height: 26 };
  let ghostPanel: { left: number; top: number; width: number; height: number } | null = null;
  function startDrag(id: number, e: MouseEvent, sub?: { what: SubDrag; row: number }) {
    if (e.button !== 0 || docId === null || deleting || orderPreview) return;
    ghostContent = "";
    ghostPanel = null;
    dragPlanCache = null;
    // the selection when the grabbed layer is part of it, in list order; else just that layer
    const ids = sub ? [] : selected.has(id) ? layers.filter(l => selected.has(l.id)).map(l => l.id) : [id];
    const idx = sub ? sub.row : Math.max(0, rows.findIndex(r => r.layer.id === id));
    drag = { ids, y0: e.clientY, view0: yOf(idx) + heightOf(rows[idx]) / 2, fix: 0, view: 0, active: false, probed: false,
      target: null, sub: sub?.what ?? null, ftarget: null, ltarget: null, alt: e.altKey,
      x0: e.clientX, px: sub && "x" in sub.what ? sub.what.x : 0,
      hover: null, overTool: null, hoverTimer: null, scroller: null,
      canDelete: canDropToDelete(layers, ids, sub?.what), overLeftDelete: false,
      overWorkbench: false, pointerX: e.clientX, pointerY: e.clientY };
  }

  /** Where all the filters / an effect / the whole style would go at row `idx`: onto that row's layer
   *  (its sub rows count as the layer) — smart objects only for filters, never the background. */
  function trackOnto(idx: number) {
    const d = drag!, s = d.sub!, dest = rows[idx].layer;
    const isMask = s.kind === "mask" || s.kind === "vmask" || s.kind === "filterMask";
    const ok = isMask ? canDropMaskOnto(layers, s.layerId, dest.id, s.kind as "mask" | "vmask" | "filterMask", groupLocked)
      : dest.id !== s.layerId && dest.kind !== "background" && (s.kind !== "filters" || dest.kind === "smartObject");
    d.ltarget = ok ? dest.id : null;
    if (!ok) { setShown(marker, false); return; }
    const at = rows.findIndex(r => r.layer.id === dest.id && !r.filter);
    const row = at >= 0 ? at : idx;
    setShown(marker, true);
    marker.className = "lt-drop into" + (d.alt ? " copy" : "");
    marker.style.left = LEAD + dest.depth * INDENT + "px";
    marker.style.top = yOf(row) + "px";
    marker.style.height = heightOf(rows[row]) + "px";
  }

  /** Where a dragged smart filter would land at row `idx`: between the chips of a 智能滤镜 row (its own
   *  — reordering — or another smart object's), by the pointer's place along the row; or on top of
   *  another smart object's filters when dropped on that layer's own row. */
  function trackFilter(idx: number) {
    const d = drag!, row = rows[idx], l = row.layer, f = row.filter, fs = d.sub as Extract<SubDrag, { kind: "filter" }>;
    let dest: TreeLayer | null = null, pos = 0, bar: number | null = null;
    if (f?.kind === "filters" && l.kind === "smartObject") {
      dest = l;
      const places = f.chips ?? l.filters.map((_, i) => i);
      const el = pool.find(p => p.index === idx && isShown(p.el))?.el;
      const chips = el ? Array.from(el.querySelectorAll(".lt-fchip")) as HTMLElement[] : [];
      // the gap before the first chip whose middle is right of the pointer
      let k = chips.findIndex(c => xInRow(c) + c.offsetWidth / 2 > d.px);
      if (k < 0) k = chips.length;
      pos = k < places.length ? places[k] : places.length ? places[places.length - 1] + 1 : 0;
      const last = chips[chips.length - 1];
      bar = (el?.offsetLeft ?? 0) + (k < chips.length ? xInRow(chips[k]) - 3 : last ? xInRow(last) + last.offsetWidth - 1 : LEAD);
    } else if (!f && l.kind === "smartObject" && l.id !== fs.layerId) dest = l;
    let toPos = pos;
    // moved in its own row: counted without itself; copied (Alt), it may land right beside itself
    if (dest && dest.id === fs.layerId) { if (pos > fs.pos) toPos = pos - 1; if (toPos === fs.pos && !d.alt) dest = null; }
    d.ftarget = dest ? { layerId: dest.id, toPos, insertAt: pos } : null;
    if (!dest) { setShown(marker, false); return; }
    setShown(marker, true);
    const h0 = heightOf(rows[idx]);
    marker.className = "lt-drop" + (bar === null ? " into" : " vbar") + (d.alt ? " copy" : "");
    marker.style.left = (bar ?? LEAD + dest.depth * INDENT) + "px";
    marker.style.top = (bar === null ? yOf(idx) : yOf(idx) + 4) + "px";
    marker.style.height = (bar === null ? h0 : h0 - 8) + "px";
  }

  function track() {
    trackDrop();
    drawGhost();
  }
  function drawGhost() {
    const d = drag;
    if (!d?.active) { setShown(ghost, false); return; }
    const s = d.sub, tool = d.overLeftDelete ? "delete" : dropTools.find(b => b.el === d.overTool)?.action ?? null;
    const nameOf = (id: number | null) => layers.find(x => x.id === id)?.name ?? "";
    const what = !s ? (d.ids.length > 1 ? `${d.ids.length} 个图层` : nameOf(d.ids[0]))
      : s.kind === "filter" || s.kind === "effect" ? s.name
      : s.kind === "filters" ? `全部智能滤镜（${layers.find(x => x.id === s.layerId)?.filters.length ?? 0}）`
      : s.kind === "effects" ? "整个图层样式"
      : s.kind === "mask" ? "图层蒙版" : s.kind === "vmask" ? "矢量蒙版"
      : s.kind === "variant" ? nameOf(s.variantId) : "智能滤镜蒙版";
    let act = "", cls = "";
    if (d.overWorkbench && !s) { act = "加入编辑工作台"; cls = ""; }
    else if (tool === "delete") { act = s && s.kind !== "filters" && s.kind !== "effects" ? "删除" : s ? "全部清除" : "删除"; cls = " del"; }
    else if (tool && s) {
      const ok = tool === "duplicate" && (s.kind === "filter" || s.kind === "effect" && MULTI_EFFECTS.has(s.key));
      act = ok ? "在本图层复制一份" : s.kind === "effect" && tool === "duplicate" ? "这种效果一个图层只能有一个" : "不能放在这里";
      cls = ok ? " copy" : " no";
    } else if (tool) act = tool === "duplicate" ? "复制图层" : tool === "groupLayers" ? "编组" : "";
    else if (s?.kind === "mask" || s?.kind === "vmask" || s?.kind === "filterMask") {
      const dest = layers.find(l => l.id === d.ltarget);
      act = dest ? `${d.alt ? "复制" : "移"}到「${dest.name}」` : "不能放在这里（目标已带蒙版、被锁定或不支持）";
      cls = !dest ? " no" : d.alt ? " copy" : "";
    } else if (s?.kind === "variant") {
      act = "拖到左侧红色区域或垃圾桶删除";
    } else if (s?.kind === "filter") {
      const t = d.ftarget;
      act = !t ? "不能放在这里" : t.layerId === s.layerId ? (d.alt ? "在这里复制一份" : "调整顺序") : `${d.alt ? "复制" : "移"}到「${nameOf(t.layerId)}」`;
      cls = !t ? " no" : d.alt ? " copy" : "";
    } else if (s) {
      act = d.ltarget === null ? (s.kind === "filters" ? "只能放到智能对象上" : "不能放在这里") : `${d.alt ? "复制" : "移"}到「${nameOf(d.ltarget)}」`;
      cls = d.ltarget === null ? " no" : d.alt ? " copy" : "";
    } else {
      act = d.target ? (d.alt ? "+ 复制" : "移动") : "不能放在这里";
      cls = d.target ? (d.alt ? " copy" : "") : " no";
    }
    const content = what + "\x1f" + act + "\x1f" + cls;
    if (content !== ghostContent) {
      replace(ghost, h("span", { class: "lt-ghost-what" }, what), act ? h("span", { class: "lt-ghost-act" }, act) : null);
      ghost.className = "lt-ghost" + cls;
      setShown(ghost, true);
      // Size changes only when the label/action changes, not on every mousemove.
      ghostSize = { width: ghost.offsetWidth || 160, height: ghost.offsetHeight || 26 };
      ghostContent = content;
    }
    // Its containing panel is stable during a drag. Opening the workbench resets
    // this cache. UXP does not consistently support 3D transforms, so use the proven
    // absolute position with NO layout reads after the first measurement.
    if (!ghostPanel) {
      const rect = el.getBoundingClientRect();
      ghostPanel = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    const x = Math.max(4, Math.min(d.pointerX - ghostPanel.left + 14, ghostPanel.width - ghostSize.width - 4));
    const y = Math.max(4, Math.min(d.pointerY - ghostPanel.top + 12, ghostPanel.height - ghostSize.height - 4));
    ghost.style.left = x + "px";
    ghost.style.top = y + "px";
  }
  function trackDrop() {
    if (!drag || !rows.length) return;
    if (drag.overTool || drag.overLeftDelete || drag.overWorkbench) {
      setShown(marker, false); drag.target = null; drag.ftarget = null; drag.ltarget = null;
      if (drag.hoverTimer) clearTimeout(drag.hoverTimer);
      drag.hoverTimer = null; drag.hover = null;
      return;
    }
    const { idx, top } = rowAt(drag.view);
    const frac = Math.max(0, Math.min(1, (drag.view - top) / heightOf(rows[idx])));
    if (drag.sub) {
      if (drag.sub.kind === "filter") trackFilter(idx);
      else if (drag.sub.kind === "variant") {
        setShown(marker, false); drag.ltarget = null;
      } else trackOnto(idx);
      return;
    }
    const l = rows[idx].layer, open = filterEnabled && (filter !== "all" || queryActive(query)) || !collapsed.has(l.id);
    // a smart filter row stands for "below its smart object"
    const where = rows[idx].filter ? "below" : dropZone(l, frac, open);
    let plan: MoveStep[] | null;
    if (dragPlanCache && dragPlanCache.tree === layers && dragPlanCache.id === l.id &&
        dragPlanCache.where === where && dragPlanCache.alt === drag.alt) plan = dragPlanCache.plan;
    else {
      plan = drag.alt ? copyPlan(layers, drag.ids, l.id, where) : dropPlan(layers, drag.ids, l.id, where);
      dragPlanCache = { tree: layers, id: l.id, where, alt: drag.alt, plan };
    }
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
    marker.className = "lt-drop" + (where === "inside" ? " into" : "") + (drag.alt ? " copy" : "");
    marker.style.left = indent + "px";
    marker.style.top = (where === "inside" ? yOf(idx) : yOf(where === "above" ? idx : idx + 1) - 1) + "px";
    marker.style.height = where === "inside" ? heightOf(rows[idx]) + "px" : "";
  }

  /** -1 / 1 while the pointer is near (or past) the list's top / bottom edge */
  const edgeDir = () => !drag || drag.overTool || drag.overLeftDelete || drag.overWorkbench ? 0
    : drag.view < 22 ? -1 : drag.view > list.clientHeight - 22 ? 1 : 0;

  listen(document, "mousemove", e => {
    if (!drag) return;
    const m = e as MouseEvent;
    if (!drag.active) {
      // Horizontal movement must also start a drag: the delete rail is on the left edge.
      if (Math.abs(m.clientY - drag.y0) < 5 && Math.abs(m.clientX - drag.x0) < 5) return;
      drag.active = true;
      if (!drag.sub) workbench.openForDrag();
      ghostPanel = null; // opening the workbench may change panel geometry
      list.classList.add("dragging");
      setShown(hit, true);
      setShown(leftDelete, drag.canDelete);
      draw();
    }
    drag.pointerX = m.clientX;
    drag.pointerY = m.clientY;
    drag.overWorkbench = !drag.sub && workbench.isDropTarget(m.clientX, m.clientY);
    workbench.setDragHover(drag.overWorkbench);
    drag.view = drag.view0 + m.clientY - drag.y0 + drag.fix;
    drag.alt = m.altKey;
    if (drag.sub?.kind === "filter") drag.px = drag.sub.x + m.clientX - drag.x0;
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
    ghostContent = "";
    ghostPanel = null;
    dragPlanCache = null;
    if (d?.hoverTimer) clearTimeout(d.hoverTimer);
    if (d?.scroller) clearInterval(d.scroller);
    setShown(marker, false);
    setShown(hit, false);
    setShown(ghost, false);
    setShown(leftDelete, false);
    leftDelete.classList.remove("hot");
    list.classList.remove("dragging");
    for (const b of dropTools) b.el.classList.remove("drop-on");
    if (d?.active) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); draw(); }
    return d;
  }
  listen(document, "mouseup", e => {
    const release = e as MouseEvent;
    const accepted = !!drag?.active && !drag.sub && workbench.isDropTarget(release.clientX, release.clientY);
    const d = endDrag();
    if (accepted && d && docId !== null) {
      workbench.add(d.ids.map(layerId => {
        const layer = layers.find(l => l.id === layerId)!;
        return { docId: docId!, docKey, layerId, name: layer.name, kind: layer.kind };
      }));
      workbench.finishDrag(true);
      status("已加入工作台 " + d.ids.length + " 个图层；原 PSD 没有修改", "ok");
      return;
    }
    workbench.finishDrag(false);
    // an effect chip pressed and let go without dragging: its switch
    if (!d?.active) { if (d?.sub && "chip" in d.sub) d.sub.toggleOnUp?.(); return; }
    // a chip that was dragged isn't also switched when its press's moment is up
    if (d.sub && "chip" in d.sub) d.sub.dragged = true;
    const tool = dropTools.find(b => b.el === d.overTool);
    const action = d.overLeftDelete && d.canDelete ? "delete" : tool?.action ?? null;
    if (d.sub) { dropSub(d.sub, d, action, (e as MouseEvent).altKey || d.alt); return; }
    if (action === "delete") { if (d.canDelete) void run("delete", d.ids); return; }
    if (tool) void run(tool.action, d.ids);
    else if (d.target && list.contains(e.target as Node)) {
      // Mouseup is authoritative: Alt may have been released just before the pointer.
      const copy = release.altKey;
      const plan = copy ? copyPlan(layers, d.ids, d.target.id, d.target.where)
        : dropPlan(layers, d.ids, d.target.id, d.target.where);
      if (plan) void drop(d.target.id, d.target.where, plan, plan.length, copy);
    }
  });
  /** a dragged filter / effect let go: moved or copied (Alt) where it was over, or deleted on the trash */
  function dropSub(s: SubDrag, d: NonNullable<typeof drag>, tool: LayerAction | null, copy: boolean) {
    // onto 新建图层: one more of this filter / effect on its own layer, as a layer dropped there is copied
    if (tool === "duplicate") {
      if (s.kind === "filter") void run("moveFilter", [s.layerId], JSON.stringify({ from: s.pos, toLayer: s.layerId, toPos: s.pos, copy: true }));
      else if (s.kind === "effect" && MULTI_EFFECTS.has(s.key)) void run("moveEffect", [s.layerId], JSON.stringify({ key: s.key, multi: s.multi, toLayer: s.layerId, copy: true }));
      return;
    }
    if (tool && tool !== "delete") return;
    if (tool) {
      if (s.kind === "filter") void run("deleteFilter", [s.layerId], JSON.stringify({ pos: s.pos }));
      else if (s.kind === "filters") void run("deleteFilters", [s.layerId]);
      else if (s.kind === "effect") void run("deleteEffect", [s.layerId], JSON.stringify({ key: s.key, multi: s.multi }));
      else if (s.kind === "effects") void run("clearStyle", [s.layerId]);
      else if (s.kind === "mask") void run("deleteMask", [s.layerId]);
      else if (s.kind === "vmask") void run("deleteVectorMask", [s.layerId]);
      else if (s.kind === "filterMask") void run("deleteFilterMask", [s.layerId]);
      else if (s.kind === "variant") void run("deleteVariant", [s.layerId], String(s.variantId));
      return;
    }
    if (s.kind === "mask" || s.kind === "vmask" || s.kind === "filterMask") {
      if (d.ltarget !== null) {
        const action = s.kind === "mask" ? "moveMask" : s.kind === "vmask" ? "moveVectorMask" : "moveFilterMask";
        void run(action, [s.layerId], JSON.stringify({ toLayer: d.ltarget, copy }));
      }
      return;
    }
    if (s.kind === "variant") return;
    if (s.kind === "filter") {
      const t = d.ftarget;
      if (t) void run("moveFilter", [s.layerId], JSON.stringify({ from: s.pos, toLayer: t.layerId, toPos: copy && t.layerId === s.layerId ? t.insertAt : t.toPos, copy }));
      return;
    }
    if (d.ltarget === null) return;
    const arg = { toLayer: d.ltarget, copy };
    if (s.kind === "filters") void run("moveFilters", [s.layerId], JSON.stringify(arg));
    else if (s.kind === "effect") void run("moveEffect", [s.layerId], JSON.stringify({ ...arg, key: s.key, multi: s.multi }));
    else void run("moveEffects", [s.layerId], JSON.stringify(arg));
  }
  listen(document, "keydown", e => {
    if (!drag?.active) return;
    const key = (e as KeyboardEvent).key;
    if (key === "Escape") {
      endDrag();
      workbench.finishDrag(false);
    } else if (key === "Alt") {
      drag.alt = true;
      track(); // updates copy marker and allowed targets even without pointer movement
    }
  });
  listen(document, "keyup", e => {
    if (drag?.active && (e as KeyboardEvent).key === "Alt") {
      drag.alt = false;
      track(); // Alt released before mouseup => move instead of copy
    }
  });

  async function drop(targetId: number, where: Where, plan: MoveStep[], count: number, copy: boolean) {
    if (docId === null || orderPreview) return;
    const doc = docId, generation = selectGen, dragStart = Date.now();
    let visualMs = 0, nativeStart = 0, nativeMs = 0;
    if (where === "inside") expanded().add(targetId);
    // Native Photoshop operations can take hundreds of milliseconds or longer. Render the
    // intended order in WaveLayer NOW, without waiting for a modal history step or a full
    // Photoshop layer-tree read. A result group and all its hidden variants stay atomic.
    const projected = copy ? null : previewMoveTree(layers, plan);
    if (projected) {
      orderPreview = true;
      layers = projected;
      byId = new Map(layers.map(l => [l.id, l]));
      render();
      visualMs = Date.now() - dragStart;
    }
    let needsRestore = false;
    try {
      // Give the UI a paint opportunity before Photoshop's modal blocks host interaction.
      if (projected) await new Promise<void>(resolve => setTimeout(resolve, 16));
      // An earlier Ctrl/Shift selection modal must finish before a drag creates clones.
      await selectTail;
      await endPeek(false);
      if (copy) {
        status("正在复制 " + count + " 个图层…", "busy");
        await new Promise<void>(resolve => setTimeout(resolve, 30));
        nativeStart = Date.now();
        const r = await tree.copy(doc, plan);
        nativeMs = Date.now() - nativeStart;
        if (r.ids.length && docId === doc && selectGen === generation) {
          selected = new Set(r.ids);
          anchor = r.ids[0];
          focus = null;
          localClear = null;
          ownSelect = [...selected].sort().join(",");
          selectGen++;
          reveal();
        }
        status(r.skipped.length
          ? "已复制 " + r.done + " 个图层；" + r.skipped.slice(0, 2).join("；")
          : "已复制 " + r.done + " 个图层", r.done ? (r.skipped.length ? "info" : "ok") : "error");
      } else {
        nativeStart = Date.now();
        const r = await tree.move(doc, plan);
        nativeMs = Date.now() - nativeStart;
        needsRestore = !!r.skipped.length || r.done < count;
        if (needsRestore) status(resultText("已移动", { ...r, unit: "个图层" }), r.done ? "info" : "error");
        else status("已移动 " + r.done + " 个图层", "ok");
      }
    } catch (e) {
      needsRestore = true;
      log("warn", copy ? "layer copy" : "layer move", e);
      status((copy ? "复制" : "移动") + "图层失败：" + ((e as Error).message ?? e), "error");
    } finally {
      if (nativeStart && !nativeMs) nativeMs = Date.now() - nativeStart;
      orderPreview = false;
      log("info", "layer drag performance", JSON.stringify({
        copy, layers: count, visualMs, nativeMs, totalMs: Date.now() - dragStart,
        optimistic: !!projected, recovery: needsRestore,
      }));
      // Photoshop's modal-done event provides the success refresh. On an error (including
      // before executeAsModal starts), force a read to undo the speculative visual order.
      if (needsRestore) void refresh();
    }
  }

  // ── right-click menu, rename, toolbar ──
  const el = h("section", { class: "lt fill", tabindex: "-1" });
  el.append(ghost);
  el.addEventListener("mouseenter", () => { pointerIn = true; refocus("hover"); });
  el.addEventListener("mouseleave", () => { pointerIn = false; });
  const popup = createPopup(el);
  /** y (px from the panel section's top) just below row `idx` */
  const rowBottom = (idx: number) => list.offsetTop + yOf(idx + 1);

  function openRowMenu(id: number) {
    if (docId === null) return;
    // like Photoshop: right-clicking a layer outside the selection selects it first
    if (!selected.has(id)) void clickRow(id, { ctrl: false, shift: false });
    const sel = selectedLayers(), ids = sel.map(l => l.id);
    // Smart objects use a narrow left rail (status + four unique tools) alongside
    // Photoshop-like ordinary text commands. Conversion/duplicate remain for regular
    // layers only, not redundant smart-object icons.
    const smartClick = byId.get(id)?.kind === "smartObject" && !!tools;
    const panel = smartClick ? smartQuickMenu(sel, users) : null;
    const items: PopItem[] = [];
    if (panel) {
      const bindStatus = (chip: typeof panel.type) => ({
        label: chip.label, value: chip.value, tone: chip.tone,
        hint: chip.hint, enabled: chip.enabled, disabledReason: chip.disabledReason,
        run: chip.action ? () => { void run(chip.action!, ids); } : undefined,
        runDouble: chip.doubleAction ? () => { void run(chip.doubleAction!, ids); } : undefined,
      });
      items.push({ sidebar: {
        title: "智能对象",
        type: bindStatus(panel.type),
        shared: bindStatus(panel.shared),
        icons: panel.actions.map(q => ({
          label: q.label, icon: q.icon, hint: q.hint,
          enabled: q.enabled, disabledReason: q.disabledReason,
          run: () => void run(q.action, ids),
        })),
      } });
    }
    // For a smart-object right-click, old dedicated SmartAction rows are now entirely
    // represented by the left rail; native "duplicate", "edit contents" and "rasterize"
    // remain in the RIGHT normal menu rather than duplicating a shortcut icon.
    const ordinary = layerMenu(sel)
      .filter(m => m === "-" || (
        !isSmartAction(m.action) && !(panel && m.action === "convertSmart")
      ))
      .map(m => m === "-" ? m : {
        label: m.label, hint: m.hint, enabled: m.enabled,
        run: () => m.action === "rename" ? startRename(ids[0]) : void run(m.action, ids),
      });
    items.push(...ordinary);
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
  const trashBtn = tool("trash", "单击删除所选图层或蒙版；也可以将图层、蒙版、效果拖到这里，或拖到列表左侧红色区域删除", () => deleteSelected());
  const dropTools: { el: HTMLElement; action: LayerAction }[] = [
    { el: groupBtn, action: "groupLayers" }, { el: newBtn, action: "duplicate" }, { el: trashBtn, action: "delete" },
  ];
  for (const b of dropTools) {
    b.el.addEventListener("mouseenter", () => { if (drag?.active) { drag.overTool = b.el; b.el.classList.add("drop-on"); track(); } });
    b.el.addEventListener("mouseleave", () => { if (drag?.overTool === b.el) { drag.overTool = null; b.el.classList.remove("drop-on"); drawGhost(); } });
  }
  const bar = h("div", { class: "lt-bar" }, linkBtn, fxBtn, maskBtn, adjBtn, groupBtn, newBtn, trashBtn);

  // 混合模式 / 不透明度 / 填充 and the locks, for the selected layers
  const modeSel = h("select", { class: "field lt-mode", title: "混合模式" },
    // shown when the selected layers differ (or none is selected)
    h("option", { disabled: true, value: "" }, "混合模式"),
    ...BLEND_MODES.map(m => m === "-" ? h("option", { disabled: true, value: "" }, "──────") : h("option", { value: m[0] }, m[1]))) as HTMLSelectElement;
  modeSel.addEventListener("change", () => { if (modeSel.value) void run("setProps", ids(), JSON.stringify({ mode: modeSel.value })); });
  /** Photoshop-style percentage field: editable value + a narrow arrow that opens a scrub slider. */
  const percentRow = (key: "opacity" | "fill", label: string, tip: string) => {
    const value = h("span", { class: "lt-pct-display", title: tip + "\n单击输入数值" }, "100%");
    const input = h("input", { class: "lt-pct-input", type: "text" }) as HTMLInputElement;
    setShown(input, false);
    const arrow = h("button", { class: "lt-pct-arrow", title: "打开滑块" }, ic("chevron", 10));
    const control = h("div", { class: "lt-pct-control" }, value, input, arrow);
    const pop = h("div", { class: "lt-pct-pop" });
    setShown(pop, false);
    let editing = false, disabled = true, editOriginal = "";
    let row: HTMLElement;
    const closeSlider = () => { setShown(pop, false); row.classList.remove("open"); };
    const apply = (v: number) => {
      if (!Number.isFinite(v) || !selected.size) { renderProps(); closeSlider(); return; }
      const n = Math.max(0, Math.min(100, Math.round(v)));
      replace(value, n + "%");
      slider.value = n;
      closeSlider();
      void run("setProps", ids(), JSON.stringify({ [key]: n }));
    };
    const slider = createSlider({ title: tip, onInput: v => { if (!editing) replace(value, v + "%"); }, onChange: apply });
    pop.append(slider.el);
    const setValue = (v: string) => {
      if (editing) return;
      replace(value, v ? v + "%" : "—");
      slider.value = v && Number.isFinite(Number(v)) ? Number(v) : 100;
    };
    const setDisabled = (v: boolean) => {
      disabled = v;
      input.disabled = v;
      (arrow as any).disabled = v;
      value.classList.toggle("off", v);
      control.classList.toggle("off", v);
      row.classList.toggle("off", v);
      if (v) closeSlider();
    };
    const finishEdit = (save: boolean) => {
      if (!editing) return;
      editing = false;
      setShown(input, false);
      setShown(value, true);
      if (save) {
        const raw = input.value.replace(/[%\s]/g, "").trim();
        const value = Number(raw), original = Number(editOriginal.replace(/[%\s]/g, "").trim());
        if (!raw || !Number.isFinite(value)) renderProps();
        else if (Number.isFinite(original) && Math.round(Math.max(0, Math.min(100, value))) === original) renderProps();
        else apply(value);
      } else renderProps();
    };
    input.addEventListener("keydown", e => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter") { e.preventDefault(); finishEdit(true); input.blur(); }
      else if (k === "Escape") { e.preventDefault(); finishEdit(false); input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("mousedown", e => e.stopPropagation());
    value.addEventListener("click", () => {
      if (disabled) return;
      editing = true;
      editOriginal = value.textContent ?? "";
      input.value = editOriginal.replace(/%$/, "");
      setShown(value, false);
      setShown(input, true);
      input.focus();
      input.select();
    });
    arrow.addEventListener("mousedown", e => e.stopPropagation());
    arrow.addEventListener("click", () => {
      if (disabled) return;
      if (isShown(pop)) { closeSlider(); return; }
      const current = Number((value.textContent ?? "").replace(/[%\s]/g, ""));
      slider.value = Number.isFinite(current) ? current : 100;
      setShown(pop, true);
      row.classList.add("open");
    });
    pop.addEventListener("mousedown", e => e.stopPropagation());
    row = h("div", { class: "lt-pct-row" },
      h("span", { class: "lt-pct-label", title: tip }, label), control, pop);
    listen(document, "mousedown", e => { if (!row.contains(e.target as Node)) closeSlider(); });
    return { row, setValue, setDisabled, isEditing: () => editing };
  };
  const opacity = percentRow("opacity", "不透明度", "不透明度：图层和它的样式一起变淡");
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
  // Compact Photoshop-style property lines. Each label sits immediately beside its numeric control.
  const props = h("div", { class: "lt-props" }, modeSel, opacity.row);
  const lockRow = h("div", { class: "lt-lock-row" },
    h("span", { class: "lt-lock-label" }, "锁定"),
    h("div", { class: "lt-locks" }, ...lockBtns),
    fillPct.row);

  function renderProps() {
    const sel = selectedLayers(), l = sel[0], none = docId === null || !l;
    const same = <T,>(f: (x: TreeLayer) => T) => sel.every(x => f(x) === f(l));
    (modeSel as any).disabled = none;
    opacity.setDisabled(none);
    fillPct.setDisabled(none);
    if (document.activeElement !== modeSel) modeSel.value = l && same(x => x.mode) ? l.mode : "";
    for (const [p, get] of [[opacity, (x: TreeLayer) => x.opacity], [fillPct, (x: TreeLayer) => x.fill]] as const) {
      if (p.isEditing()) continue;
      const v = l ? (same(get) ? String(get(l)) : "") : "100";
      p.setValue(v);
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
    // the info line is no longer shown: the title's count carries it as a tooltip
    countEl.title = infoEl.title || text;
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
  every(() => {
    const ht = list.clientHeight, wd = list.clientWidth;
    // below this the search row can't hold search + 5 expand / collapse buttons + funnel + switch
    // (.lt-tiny, near the panel's 220px minimum: the 锁定 label goes and 混合模式 narrows)
    if (wd !== lastW) {
      lastW = wd; lastH = ht;
      el.classList.toggle("lt-narrow", wd > 0 && wd < 276);
      el.classList.toggle("lt-tiny", wd > 0 && wd < 212);
      render();
    }
    else if (ht !== lastH) { lastH = ht; draw(); }
  }, 400);


  list.title = "点击图层选中，点击列表空白处取消全选；Ctrl / ⌘ 加选，Shift 连选；双击打开图层样式；右键更多操作；拖动改顺序（拖到图层组中间放进组里）";
  el.append(
    h("div", { class: "card-head lt-top-head" }, h("span", { class: "label" }, "图层"), countEl, peersBtn, h("span", { class: "grow" }), thumbButton),
    findRow,
    props, lockRow,
    list,
    workbench.el,
    h("div", { class: "lt-foot" }, h("div", { class: "lt-foot-btns" }, peekBtn, workbench.toggleButton), bar));
  render();
  return { el, refresh };
}
