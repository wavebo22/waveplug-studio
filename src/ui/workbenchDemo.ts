// Inline editing workbench below the WaveLayer list. No external window or system drag.
// While dragging it expands as a spring-loaded overlay, then becomes an ordinary subsection.
import type { LayerTree } from "../ps/host.ts";
import { pointInWorkbench, type StagedLayer } from "../core/layers/workbench.ts";
import {
  explainCompatibilityWarnings, explainWorkbenchError, type WorkbenchDiagnostic,
} from "../core/layers/workbenchCompatibility.ts";
import { h, icon, replace, setShown } from "./dom.ts";
import {
  addToWorkbenchDemo, clearWorkbenchDemo, onWorkbenchDemoChange,
  removeFromWorkbenchDemo, workbenchDemoState,
} from "./workbenchStore.ts";

export interface WorkbenchPlacementTarget {
  docId: number | null;
  /** Topmost selected layer in the current document, or null when nothing is selected. */
  layerId: number | null;
}
export interface WorkbenchSection {
  el: HTMLElement;
  toggleButton: HTMLElement;
  openForDrag(): void;
  finishDrag(accepted: boolean): void;
  setDragHover(hover: boolean): void;
  isDropTarget(x: number, y: number): boolean;
  add(items: StagedLayer[]): void;
}

const DEFAULT_POSITION_KEY = "wp.workbench.defaultPosition";
export function createWorkbenchSection(
  tree: LayerTree,
  getPlacementTarget?: () => WorkbenchPlacementTarget,
): WorkbenchSection {
  let open = false, autoOpened = false, dragging = false, dragHover = false, placing = false;
  let useSelectedPosition = (() => {
    try { return localStorage.getItem(DEFAULT_POSITION_KEY) === "selected"; }
    catch { return false; }
  })();
  const title = h("span", { class: "wb-heading" }, "编辑工作台");
  const count = h("span", { class: "wb-count" }, "0 项");
  const toggleButton = h("button", { class: "lt-head-btn wb-toggle", title: "展开或收起编辑工作台" }, "工作台");
  const clear = h("button", { class: "wb-action", title: "只清空工作台清单，不删除原图层" }, "清空");
  const header = h("div", { class: "wb-head" }, title, count, clear);

  // This prompt appears ONLY during a normal layer drag, never while editing a staged list.
  const dropHint = h("div", { class: "wb-dropzone" },
    h("span", { class: "wb-drop-title" }, "拖到这里，松开暂存"),
    h("span", { class: "wb-drop-hint" }, "支持多选；源文档保持不变"));
  const items = h("div", { class: "wb-items" });
  const copy = h("button", { class: "wb-icon-btn wb-place", title: "置入：将工作台全部图层复制到当前 PSD 的新文件夹（可撤销）",
    "aria-label": "置入当前文档" }, icon("wbPlace", 16));
  const defaultPositionInput = h("input", {
    class: "wb-default-position",
    type: "checkbox",
    checked: useSelectedPosition,
    title: "勾选：置于当前选中图层上方；无选中图层时置顶。不勾选：始终置顶",
    "aria-label": "默认置于选中图层上方",
  }) as HTMLInputElement;
  defaultPositionInput.addEventListener("change", () => {
    if (placing) { defaultPositionInput.checked = useSelectedPosition; return; }
    useSelectedPosition = defaultPositionInput.checked;
    try { localStorage.setItem(DEFAULT_POSITION_KEY, useSelectedPosition ? "selected" : "top"); }
    catch { /* preference remains active for this panel session */ }
    paint();
  });
  const exportButton = h("button", { class: "wb-icon-btn wb-pending", title: "导出：尚未接入，后续版本开放",
    "aria-label": "导出（尚未接入）" }, icon("wbExport", 16));
  (exportButton as any).disabled = true;
  const actions = h("div", { class: "wb-actions" }, defaultPositionInput, copy, exportButton);
  const line = h("span", { class: "wb-state" }, "仅暂存图层引用；源 PSD 需要保持打开");
  const noticeTitle = h("span", { class: "wb-notice-title" });
  const noticeReason = h("div", { class: "wb-notice-reason" });
  const noticeAdvice = h("div", { class: "wb-notice-advice" });
  const rawError = h("div", { class: "wb-notice-raw" });
  const expandError = h("button", { class: "wb-notice-more", title: "查看 Photoshop 返回的原始错误，方便排查" }, "查看原始错误");
  const dismissNotice = h("button", { class: "wb-notice-dismiss", title: "关闭本次提醒", "aria-label": "关闭本次提醒" }, icon("close", 12));
  const notice = h("div", { class: "wb-notice", role: "alert" },
    h("div", { class: "wb-notice-head" }, icon("warn", 14), noticeTitle, dismissNotice),
    noticeReason, noticeAdvice, expandError, rawError);
  const panel = h("div", { class: "wb-section" }, header, dropHint, items, actions, line, notice);
  const arrow = h("button", { class: "wb-arrow", title: "收起编辑工作台，保留暂存清单", "aria-label": "收起编辑工作台" },
    icon("chevron", 16));
  const shell = h("div", { class: "wb-shell" }, panel, arrow);
  setShown(shell, false);
  setShown(dropHint, false);
  setShown(notice, false);
  setShown(rawError, false);
  setShown(expandError, false);

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

  const nameOf = (key: string) => key.split(/[\\/]/).pop() || key;
  const paint = () => {
    const state = workbenchDemoState();
    const n = state.staged.length;
    replace(count, n + " 项");
    replace(toggleButton, n ? "工作台 " + n : "工作台");
    toggleButton.classList.toggle("on", open);
    (copy as any).disabled = placing || n === 0;
    (clear as any).disabled = placing;
    copy.classList.toggle("busy", placing);
    if (!placing) copy.title = useSelectedPosition
      ? "置入：将工作台内容放到当前选中图层上方；无选中图层时置顶"
      : "置入：将工作台内容放到当前 PSD 图层顶端";
    defaultPositionInput.checked = useSelectedPosition;
    defaultPositionInput.title = useSelectedPosition
      ? "已勾选：置于当前 PSD 最上方的选中图层上方；没有选中图层时置顶"
      : "未勾选：始终置于当前 PSD 图层顶端";
    defaultPositionInput.disabled = placing;
    replace(items, ...state.staged.map(item => {
      const remove = h("button", { class: "wb-remove", title: "从工作台移出，不删除 Photoshop 图层" }, "×");
      (remove as any).disabled = placing;
      remove.addEventListener("click", e => { e.stopPropagation(); if (!placing) removeFromWorkbenchDemo(item); });
      return h("div", { class: "wb-item" },
        h("span", { class: "wb-item-name", title: item.name }, item.name),
        h("span", { class: "wb-item-source", title: item.docKey }, nameOf(item.docKey)), remove);
    }));
    if (!n) replace(items, h("span", { class: "wb-empty" }, "还没有暂存图层"));
  };
  onWorkbenchDemoChange(paint);

  function refreshVisibility() {
    const show = open || dragging;
    setShown(shell, show);
    setShown(dropHint, dragging);
    // Only an automatically opened workbench overlays the list while dragging; this avoids
    // reducing list height in the middle of an existing drag-to-reorder gesture.
    shell.classList.toggle("drag-ready", autoOpened && dragging);
    shell.classList.toggle("drag-over", dragging && dragHover);
    arrow.classList.toggle("on", open);
    arrow.setAttribute("aria-label", open ? "收起编辑工作台" : "展开编辑工作台");
    arrow.title = open ? "收起编辑工作台" : "展开编辑工作台";
    toggleButton.setAttribute("aria-expanded", String(open));
    toggleButton.classList.toggle("on", open);
    // The arrow is below the workbench: hidden at rest when collapsed, always present if open.
    setShown(arrow, open || dragging);
  }
  function toggle() {
    autoOpened = false;
    open = !open;
    refreshVisibility();
  }
  toggleButton.addEventListener("click", toggle);
  arrow.addEventListener("click", toggle);
  clear.addEventListener("click", () => { if (!placing) clearWorkbenchDemo(); });

  // Unlike staging, placement writes into Photoshop. It runs as one host history transaction.
  copy.addEventListener("click", () => {
    if (placing) return;
    const staged = workbenchDemoState().staged;
    if (!staged.length) { replace(line, "工作台没有可放入的内容"); return; }
    showNotice(null);
    placing = true;
    paint();
    copy.setAttribute("title", "正在置入图层，请勿重复点击或切换 PSD");
    replace(line, "正在复制图层并创建文件夹，请勿切换 PSD");
    const target = getPlacementTarget?.() ?? { docId: null, layerId: null };
    const options = target.docId === null ? undefined : {
      targetDocId: target.docId,
      aboveLayerId: useSelectedPosition ? target.layerId ?? undefined : undefined,
    };
    void new Promise<void>(resolve => setTimeout(resolve, 25)).then(() => tree.placeStaged(staged, options)).then(result => {
      const placementText = result.placement === "above-selection"
        ? `（位于「${result.anchorName ?? "所选图层"}」上方）` : "（置于图层顶端）";
      replace(line, `已放入 ${result.count} 个图层到「${result.groupName}」${placementText}；可 Ctrl+Z 撤销`
        + (result.nestedSkipped ? `（已合并 ${result.nestedSkipped} 个重复的组内子图层）` : ""));
      showNotice(explainCompatibilityWarnings(result.compatibility ?? []));
    }).catch(error => {
      const diagnosis = explainWorkbenchError(error);
      replace(line, "置入失败 · 详情见下方");
      showNotice(diagnosis);
    }).finally(() => {
      placing = false;
      copy.setAttribute("title", "置入：将工作台全部图层复制到当前 PSD 的新文件夹（可撤销）");
      paint();
    });
  });

  paint();
  refreshVisibility();
  return {
    el: shell, toggleButton,
    openForDrag() {
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
      const b = shell.getBoundingClientRect();
      return pointInWorkbench(b, x, y);
    },
    add(incoming: StagedLayer[]) {
      const added = addToWorkbenchDemo(incoming);
      replace(line, "新增暂存 " + added + " 个图层；未修改源 PSD");
      open = true;
      autoOpened = false;
      refreshVisibility();
    },
  };
}
