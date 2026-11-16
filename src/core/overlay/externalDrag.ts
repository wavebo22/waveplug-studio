// Cross-app drag (把图层拖出 Photoshop), plugin side: when a WaveLayer drag first leaves the panel,
// the selected layers are written as PNGs to the temporary folder and their paths handed to the
// helper (native/overlay), which copies them into its own cache and starts the Windows system drag
// (OLE / CF_HDROP) once the cursor is over another program. No image bytes go over the socket.
//
//   idle → exporting → ready → handedOff     (helper sent external-drag-finished)
//              ↘          ↘
//               cancelled  (the drag ended first, export failed, or the helper went away)
//
// This module only decides; layerTree.ts sends the messages and deletes the files.

import type { ExternalDragFile } from "./protocol.ts";
import type { LayerDragRegion } from "../layers/drag.ts";

export type ExternalDragPhase = "idle" | "exporting" | "ready" | "handedOff" | "cancelled";

/** `key`: this layer version (see externalDragKey); absent means the export is never reused */
export interface ExternalDragLayer { layerId: number; name: string; key?: string; kind?: string }

/** At most this many layers go out in one drag: each is a full-size PNG. */
export const MAX_EXTERNAL_LAYERS = 20;

/** The layers that go out, and how many were left out by MAX_EXTERNAL_LAYERS. */
export function capExternalLayers<T>(layers: readonly T[]): { layers: T[]; leftOut: number } {
  return { layers: layers.slice(0, MAX_EXTERNAL_LAYERS), leftOut: Math.max(0, layers.length - MAX_EXTERNAL_LAYERS) };
}

/** A layer version for reusing its export: this plugin load (so a document or history id reused
 *  after a restart never matches), the document, its current history state and the layer. Any
 *  edit to the document moves the history state, so a changed layer never matches. "" when the
 *  history state is unknown: no reuse. */
export function externalDragKey(load: string, docId: number, historyState: string | null, layerId: number): string {
  return historyState ? `${load}:${docId}:${historyState}:${layerId}` : "";
}

/** The WaveLayer status line after a drag to another program; null when there is nothing to say
 *  (cancelled on purpose). A cancel because it was let go over Photoshop is said, so a release
 *  the user meant for another program doesn't go unnoticed. */
export function externalDragResultText(status: string, target: string | undefined, count: number | undefined, effect?: string): { text: string; kind: "ok" | "error" | "info" } | null {
  const where = target || "目标程序";
  const n = count && count > 0 ? count : 1;
  // imported through the target's own scripting (Illustrator): embedded, text and shapes editable
  if (effect === "embed") {
    if (status === "dropped") return { text: `已把 ${n} 个图层嵌入 ${where}（文字和形状可编辑）`, kind: "ok" };
    if (status === "error") return { text: `导入 ${where} 失败；松手时按住 Alt 可改用普通拖放`, kind: "error" };
  }
  if (status === "dropped") return { text: `已把 ${n} 个图层复制到 ${where}`, kind: "ok" };
  if (status === "rejected") return { text: `${where} 没有接收这些文件`, kind: "error" };
  if (status === "error") return { text: "拖出失败，请再试一次", kind: "error" };
  if (status === "cancelled" && target === "Photoshop") return { text: "在 Photoshop 上松手：已取消，文件没有放到其他程序", kind: "info" };
  return null;
}

/** Which layers need a PNG: those whose key the helper doesn't already have. */
export function layersToExport(layers: readonly ExternalDragLayer[], cached: ReadonlySet<string>): ExternalDragLayer[] {
  return layers.filter(l => !l.key || !cached.has(l.key));
}

export interface ExternalDragSession {
  sessionId: string;
  docId: number;
  /** what is exported, in list order (top first); `order` of a file is its index here */
  layers: ExternalDragLayer[];
  phase: ExternalDragPhase;
  files: ExternalDragFile[];
  /** the plugin's temporary files are gone (after files-copied, or when the session ended) */
  filesRemoved: boolean;
  startedAt: number;
}

/** Unique per drag; also part of the file name, so only [a-z0-9]. */
export function externalDragSessionId(now = Date.now(), random = Math.random): string {
  const r = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return `${now.toString(36)}${r}`;
}

/** The layers a drag would export: the dragged (selected) layers, in list order. A group (a folder,
 *  or an AI layer, which is a group of variations) goes as one merged image of what it shows, so a
 *  layer inside a dragged group is not exported again on its own. A sub drag (mask, effects,
 *  filters, variant) exports nothing. */
export function externalDragCandidates(
  layers: readonly { id: number; name: string; kind: string; parentId?: number | null }[], ids: readonly number[], sub: boolean,
): ExternalDragLayer[] {
  if (sub) return [];
  const want = new Set(ids);
  const parent = new Map(layers.map(l => [l.id, l.parentId ?? null]));
  const insideWanted = (id: number) => {
    for (let p = parent.get(id) ?? null, guard = 0; p !== null && guard < 1000; p = parent.get(p) ?? null, guard++) if (want.has(p)) return true;
    return false;
  };
  return layers.filter(l => want.has(l.id) && !insideWanted(l.id)).map(l => ({ layerId: l.id, name: l.name, kind: l.kind }));
}

/** Start exporting (send prepare) on the move where the drag *first* leaves the panel: once per
 *  drag, only for layer drags with something to export, and only while the helper is connected.
 *  Reordering inside the list never gets here. */
export function shouldPrepareExternalDrag(input: {
  active: boolean; previousRegion: LayerDragRegion; region: LayerDragRegion;
  started: boolean; candidates: number; connected: boolean; sub: boolean;
}): boolean {
  return input.active && !input.started && !input.sub && input.connected && input.candidates > 0
    && input.region === "outside" && input.previousRegion !== "outside";
}

export function createExternalDragSession(sessionId: string, docId: number, layers: ExternalDragLayer[], now = Date.now()): ExternalDragSession {
  return { sessionId, docId, layers: layers.slice(), phase: "idle", files: [], filesRemoved: false, startedAt: now };
}

/** prepare was sent: idle → exporting. */
export function beginExternalExport(s: ExternalDragSession): boolean {
  if (s.phase !== "idle") return false;
  s.phase = "exporting";
  return true;
}

/** One PNG is written. False when the session is no longer exporting (it was cancelled meanwhile):
 *  the caller deletes that file right away. */
export function recordExportedFile(s: ExternalDragSession, file: ExternalDragFile): boolean {
  if (s.phase !== "exporting") return false;
  s.files.push(file);
  return true;
}

/** Every PNG is written: send ready only while the drag is still going (exporting → ready). */
export function finishExternalExport(s: ExternalDragSession, dragActive: boolean): boolean {
  if (s.phase !== "exporting" || !dragActive || s.files.length !== s.layers.length) return false;
  s.phase = "ready";
  return true;
}

/** The WaveLayer drag ended (release, Escape, disconnect, finished) or the export failed. Unless the helper took the
 *  session over, it is cancelled and the helper told so; the temporary files go either way (after
 *  a hand-over the helper works from its own copies). */
export function endExternalDrag(s: ExternalDragSession): { sendCancel: boolean; removeFiles: boolean } {
  const sendCancel = s.phase === "exporting" || s.phase === "ready";
  if (sendCancel || s.phase === "idle") s.phase = "cancelled";
  return { sendCancel, removeFiles: takeFilesForRemoval(s) };
}

/** external-drag-finished: the system drag is over, the helper owns the outcome (exporting / ready
 *  → handedOff). False for a session that already ended. */
export function helperFinishedExternalDrag(s: ExternalDragSession): boolean {
  if (s.phase !== "exporting" && s.phase !== "ready") return false;
  s.phase = "handedOff";
  return true;
}

/** external-drag-files-copied: the helper has its own copies, the plugin's can go. */
export function helperCopiedExternalFiles(s: ExternalDragSession): boolean {
  return takeFilesForRemoval(s);
}

/** True exactly once: the first time the files should be deleted. */
function takeFilesForRemoval(s: ExternalDragSession): boolean {
  if (s.filesRemoved) return false;
  s.filesRemoved = true;
  return true;
}

/** Nothing more can happen to the session (it can be forgotten once its files are gone). */
export const externalDragOver = (s: ExternalDragSession) => (s.phase === "cancelled" || s.phase === "handedOff") && s.filesRemoved;
