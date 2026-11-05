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
  /** A WaveLayer row is hovered: a thin frame around `rect` on screen, cut to `clip` (the canvas
   *  view). Click-through and never activated; `rect: null` takes it away. */
  | { type: "hover-frame"; rect: ScreenRect | null; clip?: ScreenRect };

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
  | ComfyManagerStatus;

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
