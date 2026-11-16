// 编辑工作台: a list of layer references from any open PSD, below the WaveLayer list in the same
// panel. While a layer drag runs it opens as a spring-loaded overlay; at rest it is an ordinary
// subsection (or hidden). Entries are kept across reloads (workbenchStore.ts), grouped by their
// source document, checked against Photoshop (source closed / layer deleted) and placed into any
// open document back at their place on the canvas (core/layers/placementRestore.ts).
import type { LayerTree } from "../ps/host.ts";
import {
  canPlace, clickSelection, stateText, docLabel, entryStatus, groupBySource, pointInWorkbench, rebindEntries,
  stagedKey, type EntryStatus, type OpenDoc, type StagedLayer,
} from "../core/layers/workbench.ts";
import {
  explainCompatibilityWarnings, explainWorkbenchError, type WorkbenchDiagnostic,
} from "../core/layers/workbenchCompatibility.ts";
import { log } from "../app/log.ts";
import { h, icon, replace, setShown } from "./dom.ts";
import {
  addToWorkbench, clearWorkbench, onWorkbenchChange, removeFromWorkbench, setWorkbenchPrefs,
  updateWorkbench, workbenchState,
} from "./workbenchStore.ts";

export interface WorkbenchSection {
  el: HTMLElement;
  toggleButton: HTMLElement;
  openForDrag(): void;
  finishDrag(accepted: boolean): void;
  setDragHover(hover: boolean): void;
  isDropTarget(x: number, y: number): boolean;
  add(items: StagedLayer[]): void;
  /** The panel's document changed or its layers did: re-read the open documents and check entries. */
  refreshDocs(): void;
  /** The open documents last read (for 发送到). */
  docs(): OpenDoc[];
  /** What the workbench knows about an entry now (source open, layer there). */
  statusOf(e: StagedLayer): EntryStatus;
  /** 置入 of the entries `keys` (null: the selection, else all) into `targetDocId` (default: the
   *  target chosen in the settings, else the panel's document). */
  place(keys: string[] | null, targetDocId?: number | null): void;
  /** placing right now, and the last status line */
  state(): { busy: boolean; line: string };
  /** after every repaint (the native window follows) */
  onPaint(fn: () => void): void;
  /** the native window (helper), when it can be shown: 工作台 toggles it instead of this section */
  setNative(native: { available(): boolean; shown(): boolean; toggle(): void } | null): void;
}

/** How often Photoshop is asked about the entries at most (each check walks the source documents). */
const PROBE_MS = 1500;

export function createWorkbenchSection(tree: LayerTree, currentDoc: () => number | null): WorkbenchSection {
  let open = false, autoOpened = false, dragging = false, dragHover = false, placing = false;
  let docs: OpenDoc[] = [];
  let probes = new Map<string, { name: string } | null>();
  let selected = new Set<string>(), anchor: string | null = null;
  const collapsed = new Set<string>();
  let showOptions = false;
  let lineText = "";
  const painted: (() => void)[] = [];
  let native: { available(): boolean; shown(): boolean; toggle(): void } | null = null;

  const count = h("span", { class: "wb-count" }, "0 项");
  const toggleButton = h("button", { class: "lt-head-btn wb-toggle", title: "展开或收起编辑工作台" }, "工作台");
  const clear = h("button", { class: "wb-action", title: "清空工作台清单（不删除任何图层）" }, "清空");
  const header = h("div", { class: "wb-head" }, h("span", { class: "wb-heading" }, "编辑工作台"), count, clear);

  // shown ONLY during a layer drag, never while editing the list
  const dropHint = h("div", { class: "wb-dropzone" },
    h("span", { class: "wb-drop-title" }, "拖到这里，松开暂存"),
    h("span", { class: "wb-drop-hint" }, "支持多选和图层组；源文档不变"));
  const items = h("div", { class: "wb-items", tabindex: "-1" });

  // ── settings (shared with 发送到) ──
  const target = h("select", { class: "field wb-target", title: "置入到哪份打开的 PSD" }) as HTMLSelectElement;
  const check = (label: string, tip: string, get: () => boolean, set: (on: boolean) => void) => {
    const box = h("span", { class: "wb-check" });
    const row = h("div", { class: "wb-opt", title: tip }, box, h("span", null, label));
    row.addEventListener("click", () => { if (!placing) set(!get()); });
    return { row, paint: () => { box.classList.toggle("on", get()); row.classList.toggle("is-disabled", placing); } };
  };
  const posTop = h("div", { class: "wb-seg-btn", title: "放在目标文档最上方" }, "置顶");
  const posSel = h("div", { class: "wb-seg-btn", title: "放在目标文档最上方的选中图层上方；没有选中时置顶" }, "选中图层上方");
  posTop.addEventListener("click", () => { if (!placing) setWorkbenchPrefs({ position: "top" }); });
  posSel.addEventListener("click", () => { if (!placing) setWorkbenchPrefs({ position: "selection" }); });
  const prefs = () => workbenchState().prefs;
  const wrap = check("包成一个组", "置入的图层放进一个新图层组", () => prefs().wrapGroup, on => setWorkbenchPrefs({ wrapGroup: on }));
  const groupName = h("input", { class: "field wb-name", type: "text", title: "新图层组的名字（重名时自动加序号）" }) as HTMLInputElement;
  groupName.addEventListener("change", () => setWorkbenchPrefs({ groupName: groupName.value.trim() || "工作台素材" }));
  const restore = check("还原画面位置", "按来源画布上的位置放回：同尺寸位置不变；尺寸不同时贴边的保持边距，其余保持相对位置",
    () => prefs().restore, on => setWorkbenchPrefs({ restore: on }));
  const longEdge = check("按长边缩放", "来源画面视为 100%，按目标画面长边 ÷ 来源画面长边缩放，长边方向始终还原原比例（像素图层会重新取样）",
    () => prefs().scaleLongEdge, on => setWorkbenchPrefs({ scaleLongEdge: on, ...(on ? { scaleWithCanvas: false } : {}) }));
  const scale = check("随画布缩放", "画布尺寸不同时按宽、高比例中较小者缩放（像素图层会重新取样，画质可能下降）",
    () => prefs().scaleWithCanvas, on => setWorkbenchPrefs({ scaleWithCanvas: on, ...(on ? { scaleLongEdge: false } : {}) }));
  const removeAfter = check("置入后移出清单", "置入成功后，把这些条目从工作台移出",
    () => prefs().removeAfter, on => setWorkbenchPrefs({ removeAfter: on }));
  const switchAfter = check("置入后切到目标文档", "目标不是当前文档时，置入后切换过去",
    () => prefs().switchAfter, on => setWorkbenchPrefs({ switchAfter: on }));
  const options = h("div", { class: "wb-options" },
    h("div", { class: "wb-opt-line" }, h("span", { class: "wb-opt-label" }, "目标"), target),
    h("div", { class: "wb-opt-line" }, h("span", { class: "wb-opt-label" }, "位置"), h("div", { class: "wb-seg" }, posTop, posSel)),
    h("div", { class: "wb-opt-line" }, wrap.row, groupName),
    h("div", { class: "wb-opt-line" }, restore.row, longEdge.row, scale.row),
    h("div", { class: "wb-opt-line" }, removeAfter.row, switchAfter.row));

  const optionsBtn = h("button", { class: "wb-icon-btn wb-options-btn", title: "置入设置：目标文档、位置、包组、还原位置", "aria-label": "置入设置" }, icon("chevron", 16));
  const place = h("button", { class: "wb-place", title: "把工作台内容复制到目标 PSD（一步，可撤销）" }, icon("wbPlace", 16), h("span", { class: "wb-place-text" }, "置入"));
  const placeText = place.querySelector(".wb-place-text") as HTMLElement;
  const actions = h("div", { class: "wb-actions" }, optionsBtn, h("span", { class: "grow" }), place);
  const line = h("span", { class: "wb-state" }, "只暂存图层引用；置入时来源 PSD 需要打开");
  const setLine = (text: string) => { lineText = text; setLine(text); };

  const noticeTitle = h("span", { class: "wb-notice-title" });
  const noticeReason = h("div", { class: "wb-notice-reason" });
  const noticeAdvice = h("div", { class: "wb-notice-advice" });
  const rawError = h("div", { class: "wb-notice-raw" });
  const expandError = h("button", { class: "wb-notice-more", title: "查看 Photoshop 返回的原始错误，方便排查" }, "查看原始错误");
  const dismissNotice = h("button", { class: "wb-notice-dismiss", title: "关闭本次提醒", "aria-label": "关闭本次提醒" }, icon("close", 12));
  const notice = h("div", { class: "wb-notice", role: "alert" },
    h("div", { class: "wb-notice-head" }, icon("warn", 14), noticeTitle, dismissNotice),
    noticeReason, noticeAdvice, expandError, rawError);
  const panel = h("div", { class: "wb-section" }, header, dropHint, items, actions, options, line, notice);
  const arrow = h("button", { class: "wb-arrow", title: "收起编辑工作台，保留清单", "aria-label": "收起编辑工作台" }, icon("chevron", 16));
  const shell = h("div", { class: "wb-shell" }, panel, arrow);
  for (const el of [shell, dropHint, notice, rawError, expandError, options]) setShown(el, false);

  function showNotice(data: WorkbenchDiagnostic | null) {
    setShown(notice, !!data);
    panel.classList.toggle("has-notice", !!data);
    if (!data) return;
    notice.classList.toggle("is-error", data.level === "error");
    notice.classList.toggle("is-warning", data.level === "warning");
    replace(noticeTitle, data.title);
    replace(noticeReason, data.reason);
    replace(noticeAdvice, "建议：" + data.advice);
    replace(rawError, data.details ?? "");
    setShown(expandError, !!data.details);
    setShown(rawError, false);
    replace(expandError, "查看原始错误");
  }
  dismissNotice.addEventListener("click", () => showNotice(null));
  expandError.addEventListener("click", () => {
    const expanded = rawError.style.display === "none";
    setShown(rawError, expanded);
    replace(expandError, expanded ? "收起原始错误" : "查看原始错误");
  });

  const statusOf = (e: StagedLayer): EntryStatus => entryStatus(e, docs, probes.get(stagedKey(e)));
  /** what 置入 copies: the selected usable entries, or all usable ones when none is selected */
  function placeable() {
    const all = workbenchState().staged;
    const picked = selected.size ? all.filter(e => selected.has(stagedKey(e))) : all;
    return { picked, ok: picked.filter(e => canPlace(e, statusOf(e))) };
  }

  function paint() {
    const { staged, prefs: p } = workbenchState();
    const keys = new Set(staged.map(stagedKey));
    selected = new Set([...selected].filter(k => keys.has(k)));
    const n = staged.length;
    replace(count, n + " 项");
    replace(toggleButton, n ? "工作台 " + n : "工作台");
    (clear as any).disabled = placing || !n;
    clear.classList.toggle("is-disabled", placing || !n);

    const { picked, ok } = placeable();
    replace(placeText, placing ? "置入中…" : selected.size ? `置入所选 ${ok.length}` : n ? `全部置入 ${ok.length}` : "置入");
    const placeOk = !placing && ok.length > 0;
    (place as any).disabled = !placeOk;
    place.classList.toggle("is-disabled", !placeOk);
    place.classList.toggle("busy", placing);
    if (picked.length > ok.length) place.title = `有 ${picked.length - ok.length} 项来源未打开或已删除，会跳过`;
    else place.title = "把" + (selected.size ? "所选条目" : "工作台全部内容") + "复制到目标 PSD（一步，可撤销）";

    // settings
    const cur = currentDoc();
    const opts = [h("option", { value: "", selected: target.value === "" ? "" : undefined }, "当前文档")];
    for (const d of docs) if (d.docId !== cur) opts.push(h("option", { value: String(d.docId), selected: target.value === String(d.docId) ? "" : undefined }, d.name || docLabel(d.docKey)));
    const keep = target.value;
    replace(target, ...opts);
    target.value = docs.some(d => String(d.docId) === keep && d.docId !== cur) ? keep : "";
    posTop.classList.toggle("on", p.position === "top");
    posSel.classList.toggle("on", p.position === "selection");
    for (const c of [wrap, restore, longEdge, scale, removeAfter, switchAfter]) c.paint();
    if (document.activeElement !== groupName) groupName.value = p.groupName;
    setShown(groupName, p.wrapGroup);
    scale.row.classList.toggle("is-disabled", placing || !p.restore);
    longEdge.row.classList.toggle("is-disabled", placing || !p.restore);
    setShown(options, showOptions);
    optionsBtn.classList.toggle("on", showOptions);

    // the list, grouped by source document
    const order = staged.map(stagedKey);
    const rows: HTMLElement[] = [];
    for (const g of groupBySource(staged)) {
      const st = g.items.map(statusOf);
      const docOpen = !st.every(s => s === "docClosed");
      const fold = collapsed.has(g.docKey);
      const head = h("div", { class: "wb-src" + (fold ? " folded" : ""), title: g.docKey },
        icon("chevron", 12), h("span", { class: "wb-dot" + (docOpen ? " on" : "") }),
        h("span", { class: "wb-src-name" }, g.label), h("span", { class: "wb-src-count" }, String(g.items.length)));
      head.addEventListener("click", () => { if (fold) collapsed.delete(g.docKey); else collapsed.add(g.docKey); paint(); });
      rows.push(head);
      if (fold) continue;
      g.items.forEach((item, i) => {
        const key = stagedKey(item), status = st[i];
        const remove = h("button", { class: "wb-remove", title: "从工作台移出（不删除图层）", "aria-label": "移出" }, icon("close", 12));
        remove.addEventListener("click", e => { e.stopPropagation(); if (!placing) removeFromWorkbench(new Set([key])); });
        const pic = item.thumb ? h("img", { class: "wb-thumb", src: item.thumb, alt: "" }) : h("span", { class: "wb-thumb" });
        const row = h("div", { class: "wb-item" + (selected.has(key) ? " sel" : "") + (canPlace(item, status) ? "" : " stale"), title: item.name },
          pic, h("span", { class: "wb-item-name" }, item.name),
          stateText(item, status) ? h("span", { class: "wb-item-state" }, stateText(item, status)) : null, remove);
        row.addEventListener("click", e => {
          const m = e as MouseEvent;
          const next = clickSelection(order, selected, anchor, key, { ctrl: m.ctrlKey || m.metaKey, shift: m.shiftKey });
          selected = next.selected; anchor = next.anchor;
          items.focus();
          paint();
        });
        rows.push(row);
      });
    }
    if (!n) rows.push(h("span", { class: "wb-empty" }, "把图层拖到这里暂存"));
    replace(items, ...rows);
    for (const fn of painted) try { fn(); } catch (e) { log("warn", "workbench paint listener", e); }
  }
  onWorkbenchChange(paint);

  // ── snapshots: a PNG per staged layer, placed when its source is closed (core: canPlace) ──
  let snapQueue: StagedLayer[] = [], snapping = false;
  let snapsKept = new Set(workbenchState().staged.flatMap(e => e.snap ? [e.snap] : []));
  onWorkbenchChange(() => {
    const now = new Set(workbenchState().staged.flatMap(e => e.snap ? [e.snap] : []));
    const gone = [...snapsKept].filter(n => !now.has(n));
    snapsKept = now;
    if (gone.length) void tree.dropSnapshots(gone).catch(e => log("warn", "workbench snapshot delete", e));
  });
  async function takeSnapshots() {
    if (snapping) return;
    snapping = true;
    try {
      while (snapQueue.length) {
        const e = snapQueue.shift()!;
        const name = await tree.snapshotStaged(e.docId, e.docKey, e.layerId).catch(err => { log("warn", "workbench snapshot", e.layerId, err); return null; });
        if (name) updateWorkbench(list => list.map(x => stagedKey(x) === stagedKey(e) ? { ...x, snap: name } : x));
      }
    } finally { snapping = false; }
  }

  items.addEventListener("keydown", e => {
    const k = (e as KeyboardEvent).key;
    if ((k === "Delete" || k === "Backspace") && selected.size && !placing) {
      e.preventDefault();
      e.stopPropagation();
      removeFromWorkbench(selected);
      setLine("已移出所选条目；图层没有改动");
    } else if (k === "Escape" && selected.size) { selected = new Set(); paint(); }
  });
  optionsBtn.addEventListener("click", () => { showOptions = !showOptions; paint(); });
  target.addEventListener("change", paint);

  function refreshVisibility() {
    setShown(shell, open || dragging);
    setShown(dropHint, dragging);
    // Only an automatically opened workbench overlays the list while dragging: the list keeps its
    // height in the middle of a drag-to-reorder gesture.
    shell.classList.toggle("drag-ready", autoOpened && dragging);
    shell.classList.toggle("drag-over", dragging && dragHover);
    arrow.classList.toggle("on", open);
    arrow.setAttribute("aria-label", open ? "收起编辑工作台" : "展开编辑工作台");
    arrow.title = open ? "收起编辑工作台" : "展开编辑工作台";
    toggleButton.setAttribute("aria-expanded", String(open));
    toggleButton.classList.toggle("on", open || !!native?.shown());
    setShown(arrow, open || dragging);
  }
  function toggle() {
    autoOpened = false;
    open = !open;
    refreshVisibility();
    if (open) refreshDocs();
  }
  toggleButton.addEventListener("click", () => {
    // with the helper the workbench is its own window beside the canvas, whatever document is active
    if (native?.available()) { native.toggle(); paint(); return; }
    toggle();
  });
  arrow.addEventListener("click", toggle);
  clear.addEventListener("click", () => {
    if (placing) return;
    clearWorkbench();
    selected = new Set();
    setLine("清单已清空；图层没有改动");
  });

  // ── checking entries against Photoshop ──
  let probing = false, probeAgain = false, lastProbe = 0, probeTimer: ReturnType<typeof setTimeout> | null = null;
  async function probe() {
    if (probing) { probeAgain = true; return; }
    probing = true;
    try {
      do {
        probeAgain = false;
        lastProbe = Date.now();
        docs = await tree.openDocs();
        updateWorkbench(entries => rebindEntries(entries, docs));
        const entries = workbenchState().staged;
        if (entries.length && (open || native?.shown())) {
          const found = await tree.probeStaged(entries.map(e => ({ docId: e.docId, layerId: e.layerId })));
          probes = new Map(entries.map((e, i) => [stagedKey(e), found[i] ?? null]));
          // renamed in Photoshop: the entry follows the layer's name
          updateWorkbench(list => list.map(e => {
            const f = probes.get(stagedKey(e));
            return f && f.name !== e.name ? { ...e, name: f.name } : e;
          }));
        }
        paint();
      } while (probeAgain);
    } catch (e) { log("warn", "workbench probe", e); }
    finally { probing = false; }
  }
  function refreshDocs() {
    if (probeTimer) return;
    const wait = Math.max(0, PROBE_MS - (Date.now() - lastProbe));
    probeTimer = setTimeout(() => { probeTimer = null; void probe(); }, wait);
  }

  // Unlike staging, placement writes into Photoshop: one history step of the target document.
  function doPlace(keys: string[] | null, forced?: number | null) {
    if (placing) return;
    const all = workbenchState().staged;
    const picked = keys ? all.filter(e => keys.includes(stagedKey(e))) : placeable().picked;
    const ok = picked.filter(e => canPlace(e, statusOf(e)));
    if (!ok.length) { setLine("没有可置入的条目：来源 PSD 需要打开"); paint(); return; }
    const cur = currentDoc();
    const targetDocId = forced ?? (target.value ? Number(target.value) : cur);
    if (targetDocId === null) { setLine("没有目标文档"); return; }
    const p = workbenchState().prefs;
    showNotice(null);
    placing = true;
    paint();
    setLine("正在复制图层，请勿切换 PSD");
    const skipped = picked.length - ok.length;
    void new Promise<void>(resolve => setTimeout(resolve, 25)).then(() => tree.placeStaged(ok, {
      targetDocId, position: p.position, wrapGroup: p.wrapGroup, groupName: p.groupName,
      restore: p.restore, scaleLongEdge: p.scaleLongEdge, scaleWithCanvas: p.scaleWithCanvas, matchParents: p.matchParents, switchAfter: p.switchAfter,
    })).then(result => {
      const where = result.placement === "above-selection" ? `，位于「${result.anchorName ?? "所选图层"}」上方`
        : result.placement === "top" ? "，置于顶端" : "";
      const into = result.groupName ? `到「${result.groupName}」` : "";
      const docName = docs.find(d => d.docId === result.docId)?.name;
      setLine(`已置入 ${result.count} 个图层${into}${docName && result.docId !== cur ? "（" + docName + "）" : ""}${where}`
        + (result.restored ? `；${result.restored} 个已还原画面位置` : "")
        + (result.snapshots ? `；${result.snapshots} 个来源未打开，用快照置入（像素智能对象）` : "")
        + (result.nestedSkipped ? `；合并了 ${result.nestedSkipped} 个重复的组内子图层` : "")
        + (skipped ? `；跳过 ${skipped} 个失效条目` : "") + "；可 Ctrl+Z 撤销");
      showNotice(explainCompatibilityWarnings(result.compatibility ?? []));
      if (p.removeAfter) { removeFromWorkbench(new Set(ok.map(stagedKey))); selected = new Set(); }
    }).catch(error => {
      setLine("置入失败 · 详情见下方");
      showNotice(explainWorkbenchError(error));
    }).finally(() => {
      placing = false;
      paint();
      refreshDocs();
    });
  }
  place.addEventListener("click", () => doPlace(null));

  paint();
  refreshVisibility();
  refreshDocs();
  return {
    el: shell, toggleButton,
    openForDrag() {
      // the native window is the drop target then: the list keeps all its room
      if (native?.shown()) return;
      dragging = true;
      if (!open) { open = true; autoOpened = true; }
      refreshVisibility();
    },
    finishDrag(accepted: boolean) {
      dragging = false;
      dragHover = false;
      if (autoOpened && !accepted) open = false;
      autoOpened = false;
      refreshVisibility();
    },
    setDragHover(hover: boolean) {
      if (dragHover === hover) return;
      dragHover = hover;
      refreshVisibility();
    },
    isDropTarget(x: number, y: number) {
      if (!open) return false;
      return pointInWorkbench(shell.getBoundingClientRect(), x, y);
    },
    add(incoming: StagedLayer[]) {
      const added = addToWorkbench(incoming);
      // groups and adjustments have no picture of their own to keep
      snapQueue.push(...incoming.filter(e => e.kind !== "group" && e.kind !== "adjustment" && e.geom?.bounds).slice(0, 40));
      void takeSnapshots();
      const again = incoming.length - added;
      setLine(`新增暂存 ${added} 个图层` + (again > 0 ? `（${again} 个已在清单中，已更新）` : "") + "；源 PSD 没有改动");
      open = true;
      autoOpened = false;
      refreshVisibility();
      refreshDocs();
    },
    refreshDocs,
    docs: () => docs,
    statusOf,
    place: (keys, targetDocId) => doPlace(keys, targetDocId),
    state: () => ({ busy: placing, line: lineText }),
    onPaint: fn => { painted.push(fn); },
    setNative(n) { native = n; },
  };
}
