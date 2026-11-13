// External surfaces (外附介面): UI the plugin shows outside its UXP panels, drawn natively by the
// WavePlug overlay helper (native/overlay, a Windows program) — UXP can't draw past a panel's
// edge. The plugin stays the only place that works anything out or touches Photoshop; a surface
// draws the state it is sent and reports what the user did there.
//
// One WebSocket (ws://127.0.0.1:OVERLAY_PORT, JSON text frames) carries every surface; each
// message names its surface (`panel`). Same shapes as native/overlay/src/protocol.rs.
// A surface's state is a set of named sections, and only the sections that changed are sent
// (see sections.ts). To add a surface: docs in native/overlay/HANDOFF.md, 「新增一個外附介面」.

import type { Rect } from "../image/region.ts";

export const OVERLAY_PORT = 47821;
export const OVERLAY_URL = `ws://127.0.0.1:${OVERLAY_PORT}`;

/** A screen rectangle in physical pixels (what Photoshop's view bounds and Windows both use). */
export interface ScreenRect { left: number; top: number; right: number; bottom: number }

/** plugin → helper */
export type OverlayCommand =
  | { type: "hello" }
  /** put surface `panel` up, placed against `view` (Photoshop's canvas on screen) */
  | { type: "show"; panel: string; view: ScreenRect | null }
  | { type: "hide"; panel: string }
  /** the surface's state; `rev` only grows per surface, so the helper drops anything older */
  | { type: "state"; panel: string; rev: number; sections: Record<string, unknown> }
  /** a notice in the bottom-right corner of `view` (shared by every surface; shown even while
   *  no surface is up), gone after `ms` or a click */
  | { type: "toast"; title: string; text: string; view: ScreenRect | null; ms: number }
  /** Start or reconcile the configured local ComfyUI process under the native helper. */
  | { type: "manage-comfy"; path: string; base: string; closeWithPhotoshop: boolean; restartIfNeeded: boolean; disableBrowser: boolean; startIfMissing: boolean; restart?: boolean }
  /** Start the helper's exe again and quit the running copy; the ComfyUI it started keeps running. */
  | { type: "restart-helper" }
  /** A normal WaveLayer row began dragging; the native surface tracks the global cursor until release. */
  | { type: "layer-drag-start"; docId: number; layers: { layerId: number; name: string }[]; totalCount: number; thumb?: string }
  /** Escape / cancellation: stop the external reference drop without changing the layer. */
  | { type: "layer-drag-cancel" }
  /** Independent native cursor-following card; data is limited to small cached thumbnails. */
  | { type: "layer-drag-preview-start"; layers: { layerId: number; name: string; thumb?: string }[]; totalCount: number }
  | { type: "layer-drag-preview-update"; action: string; tone: "move" | "copy" | "delete" | "workbench" | "invalid" }
  | { type: "layer-drag-preview-end" }
  /** A WaveLayer row is hovered: a thin frame around `rect` on screen, cut to `clip` (the canvas
   *  view). Click-through and never activated; `rect: null` takes it away. */
  | { type: "hover-frame"; rect: ScreenRect | null; clip?: ScreenRect }
  /** A WaveLayer drag left the panel: PNGs for `totalCount` layers are being written (cross-app drag).
   *  `keys` (one per layer version) let the helper say which it already has (external-drag-cached). */
  | { type: "external-drag-prepare"; sessionId: string; docId: number; totalCount: number; keys: string[] }
  /** Every PNG is written; the helper copies them into its own cache (no image bytes on the socket). */
  | { type: "external-drag-ready"; sessionId: string; files: ExternalDragFile[] }
  /** `done` of `total` layers are exported so far: the helper's card shows the progress. */
  | { type: "external-drag-progress"; sessionId: string; done: number; total: number }
  /** The drag ended without the helper taking it over (or export failed). */
  | { type: "external-drag-cancel"; sessionId: string; reason: string }
  /** WaveLayer's right-click menu as a native menu at the cursor (native/overlay/src/menu.rs);
   *  answered by `menu-result`. */
  | { type: "menu-open"; menuId: string; title: string; items: MenuNode[] }
  /** Take the menu away (Esc, the document changed); without an id: whatever is open. */
  | { type: "menu-close"; menuId?: string };

/** One row of a menu: a command (`id`), a submenu (`children`), a heading (neither) or a separator. */
export interface MenuNode {
  /** what comes back when the row is picked */
  id?: string;
  label?: string;
  /** shown at the right: a shortcut */
  hint?: string;
  enabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  children?: MenuNode[];
}

/** The helper version that first shows menus (menu-open). */
export const MENU_HELPER_VERSION = "0.8.0";

/** One exported layer of a cross-app drag; `path` is a native file path, `order` is list order (0 = top).
 *  `key` names this layer version; `path` is "" when the helper already has that key exported. */
export interface ExternalDragFile {
  layerId: number; name: string; path: string; order: number; key?: string;
  /** where the PNG's pixels sit in the document (px): the helper's combined SVG keeps the layers'
   *  positions relative to each other */
  rect?: { left: number; top: number; right: number; bottom: number };
  /** text / shape layers: the layer as an SVG fragment in document pixels (svgFragment.ts);
   *  missing when it can't be expressed (the PNG goes instead) */
  vector?: string;
  /** the document's resolution (ppi): the combined SVG lands at the layers' printed size */
  res?: number;
}

export type ExternalDragStatus = "dropped" | "cancelled" | "rejected" | "error";

/** helper → plugin, about a cross-app drag session. */
export type ExternalDragEvent =
  /** the answer to prepare: the keys the helper already has exported (no PNG needed for those) */
  | { type: "external-drag-cached"; sessionId: string; keys: string[] }
  /** the helper has its own copies: the plugin's temporary files can go */
  | { type: "external-drag-files-copied"; sessionId: string }
  /** the system drag (DoDragDrop) is over; the plugin may never see a mouseup, so this ends the drag */
  | { type: "external-drag-finished"; sessionId: string; status: ExternalDragStatus; effect: "copy" | "none" | "embed"; target?: string; count?: number };

/** helper → plugin. `action` is the surface's own (checked by that surface). */
export type ComfyManagerStatus = {
  type: "comfy-status";
  state: "not-configured" | "path-missing" | "remote" | "starting" | "ready" | "already-running" | "managed-running" | "restart-required" | "autostart-disabled" | "external-running" | "failed" | "timeout";
  message: string;
  owned: boolean;
};

export type OverlayEvent =
  | { type: "ready"; version: string }
  | { type: "action"; panel: string; action: unknown }
  /** Photoshop's window moved or changed size: send `show` again with the new view */
  | { type: "view-request"; panel: string }
  | ComfyManagerStatus
  | ExternalDragEvent
  /** the row picked in menu `menuId` (its id), or null when the menu was closed */
  | { type: "menu-result"; menuId: string; item: string | null };

/** The helper build this plugin's protocol needs (native/overlay/Cargo.toml). Bump both together:
 *  an older helper still connects, but e.g. can't arbitrate drag verdicts (drag_target.rs), and
 *  without this check a stale exe looks exactly like a bug in new code. */
export const EXPECTED_HELPER_VERSION = "0.10.1";

/** `version` is older than EXPECTED_HELPER_VERSION (numeric x.y.z; unparsable counts as older). */
export function helperOutdated(version: string | null, expected = EXPECTED_HELPER_VERSION): boolean {
  if (version === null) return false;
  const parts = (v: string) => v.trim().split(".").map(n => Number.parseInt(n, 10));
  const a = parts(version), b = parts(expected);
  if (a.some(n => !Number.isFinite(n))) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

export function parseOverlayEvent(text: string): OverlayEvent | null {
  let m: any;
  try { m = JSON.parse(text); } catch { return null; }
  if (m?.type === "ready" && typeof m.version === "string") return { type: "ready", version: m.version };
  if (m?.type === "comfy-status"
    && typeof m.state === "string"
    && ["not-configured", "path-missing", "remote", "starting", "ready", "already-running", "managed-running", "restart-required", "autostart-disabled", "external-running", "failed", "timeout"].includes(m.state)
    && typeof m.message === "string"
    && typeof m.owned === "boolean") {
    return { type: "comfy-status", state: m.state, message: m.message, owned: m.owned };
  }
  if (m?.type === "external-drag-cached" && typeof m.sessionId === "string" && m.sessionId
    && Array.isArray(m.keys) && m.keys.every((k: unknown) => typeof k === "string")) {
    return { type: "external-drag-cached", sessionId: m.sessionId, keys: m.keys };
  }
  if (m?.type === "external-drag-files-copied" && typeof m.sessionId === "string" && m.sessionId) {
    return { type: "external-drag-files-copied", sessionId: m.sessionId };
  }
  if (m?.type === "external-drag-finished" && typeof m.sessionId === "string" && m.sessionId
    && ["dropped", "cancelled", "rejected", "error"].includes(m.status)
    && (m.effect === "copy" || m.effect === "none" || m.effect === "embed")) {
    return {
      type: "external-drag-finished", sessionId: m.sessionId, status: m.status, effect: m.effect,
      ...(typeof m.target === "string" ? { target: m.target } : {}),
      ...(typeof m.count === "number" && Number.isFinite(m.count) ? { count: m.count } : {}),
    };
  }
  if (m?.type === "menu-result" && typeof m.menuId === "string" && m.menuId && (m.item === null || m.item === undefined || typeof m.item === "string")) {
    return { type: "menu-result", menuId: m.menuId, item: m.item ?? null };
  }
  if (typeof m?.panel !== "string") return null;
  if (m.type === "view-request") return { type: "view-request", panel: m.panel };
  if (m.type === "action" && m.action && typeof m.action === "object") return { type: "action", panel: m.panel, action: m.action };
  return null;
}

/** Identifies the active selection; "" when there is none. */
export const selectionKey = (docId: number | null, sel: Rect | null): string =>
  docId === null || !sel ? "" : `${docId}:${sel.left},${sel.top},${sel.right},${sel.bottom}`;

/** Where a document's canvas is on screen, from Photoshop's document properties:
 *  `view` = viewInfo.activeView.globalBounds (screen px), `center` = the document point at the
 *  view's centre (`center`, converted from points to document px), `zoom` = 1 for 100%. */
export interface CanvasView { view: ScreenRect; center: { x: number; y: number }; zoom: number }

/** The document rectangle `r` on screen. */
export function docToScreen(r: Rect, v: CanvasView): ScreenRect {
  const cx = (v.view.left + v.view.right) / 2, cy = (v.view.top + v.view.bottom) / 2;
  // Action Manager's center is already zoom-scaled; only the document coordinate
  // is multiplied here. Multiplying the center by zoom again causes large drift above 100%.
  const x = (d: number) => Math.round(cx + d * v.zoom - v.center.x);
  const y = (d: number) => Math.round(cy + d * v.zoom - v.center.y);
  return { left: x(r.left), top: y(r.top), right: x(r.right), bottom: y(r.bottom) };
}
