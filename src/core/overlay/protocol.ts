// The WavePlug overlay helper (native/overlay, a small Windows program) shows a prompt + 生成 bar
// next to the pointer right after a selection is made — outside the panel, where UXP can't draw.
// Messages are JSON text frames over ws://127.0.0.1:OVERLAY_PORT; same shapes as
// native/overlay/src/protocol.rs.

import type { Rect } from "../image/region.ts";

export const OVERLAY_PORT = 47821;
export const OVERLAY_URL = `ws://127.0.0.1:${OVERLAY_PORT}`;

/** A screen rectangle in physical pixels (what Photoshop's view bounds and Windows both use). */
export interface ScreenRect { left: number; top: number; right: number; bottom: number }

/** panel → helper. `anchor` is the selection on screen: the bar goes centred under it, like
 *  Photoshop's contextual task bar; without it the helper falls back to the pointer. */
export type OverlayCommand =
  | { type: "hello" }
  | { type: "show"; prompt: string; count: number; anchor?: ScreenRect }
  | { type: "hide" };

/** Where a document's canvas is on screen, from Photoshop's document properties:
 *  `view` = viewInfo.activeView.globalBounds (screen px), `center` = the document point at the
 *  view's centre (`center`, converted from points to document px), `zoom` = 1 for 100%. */
export interface CanvasView { view: ScreenRect; center: { x: number; y: number }; zoom: number }

/** The document rectangle `r` on screen. */
export function docToScreen(r: Rect, v: CanvasView): ScreenRect {
  const cx = (v.view.left + v.view.right) / 2, cy = (v.view.top + v.view.bottom) / 2;
  const x = (d: number) => Math.round(cx + (d - v.center.x) * v.zoom);
  const y = (d: number) => Math.round(cy + (d - v.center.y) * v.zoom);
  return { left: x(r.left), top: y(r.top), right: x(r.right), bottom: y(r.bottom) };
}

/** helper → panel */
export type OverlayEvent =
  | { type: "ready"; version: string }
  | { type: "generate"; prompt: string; count: number };

export function parseOverlayEvent(text: string): OverlayEvent | null {
  let m: any;
  try { m = JSON.parse(text); } catch { return null; }
  if (m?.type === "ready" && typeof m.version === "string") return { type: "ready", version: m.version };
  if (m?.type === "generate" && typeof m.prompt === "string" && Number.isFinite(m.count))
    return { type: "generate", prompt: m.prompt, count: Math.max(1, Math.min(4, Math.round(m.count))) };
  return null;
}

/** Identifies the active selection; "" when there is none. */
export const selectionKey = (docId: number | null, sel: Rect | null): string =>
  docId === null || !sel ? "" : `${docId}:${sel.left},${sel.top},${sel.right},${sel.bottom}`;

/** What the bar should do when the selection key goes from `prev` to `next`: a new or changed
 *  selection shows it, no selection hides it, the same selection leaves it alone.
 *  `prev` is null before the first look, so a selection already there when the panel opens
 *  doesn't pop the bar up. */
export function overlayStep(prev: string | null, next: string): "show" | "hide" | null {
  if (prev === null || prev === next) return null;
  return next ? "show" : "hide";
}
