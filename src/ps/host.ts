// What the panel needs from Photoshop. Implemented for real UXP (uxpHost.ts) and for the
// browser preview (mockHost.ts) so the UI can be developed and checked without Photoshop.

import type { Pixels } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";

export interface DocInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  /** "RGBColorMode" etc. */
  mode: string;
  bits: number;
}

export interface TaskGroup {
  docId: number;
  layerId: number;
  /** e.g. "T3K9" — from the embedded file name WavePlug_<taskId>.psb */
  taskId: string;
  fileName: string;
  layerName: string;
  /** where the SO sits in the document (must be axis-aligned, unrotated) */
  rect: Rect;
}

export interface Version {
  number: number;
  label: string;
  compId: number;
  comment: string;
}

export interface LayerInfo { id: number; name: string; depth: number; kind: string }

export interface Capture {
  doc: DocInfo;
  /** area that was read and will be sent to ComfyUI */
  rect: Rect;
  image: Pixels;
  /** 1-channel, 255 = repaint */
  selection: Pixels;
}

export interface PsHost {
  readonly kind: "uxp" | "mock";
  activeDoc(): DocInfo | null;
  docExists(id: number): boolean;
  /** Bounds of the active selection, or null when there is none. */
  selectionBounds(docId: number): Promise<Rect | null>;
  /** The selected layer if it is a WavePlug task group, else null. */
  activeTaskGroup(): Promise<TaskGroup | null>;
  /** Fails with a readable message if the group is gone or was transformed. */
  refreshTaskGroup(g: TaskGroup): Promise<TaskGroup>;
  /** The group's own layer mask over its rect (used when continuing without a new selection). */
  groupMask(g: TaskGroup): Promise<Pixels>;
  capture(docId: number, rect: Rect, selection: "active" | Pixels): Promise<Capture>;
  listLayers(docId: number): LayerInfo[];
  layerPixels(docId: number, layerId: number): Promise<Pixels>;

  versions(g: TaskGroup): Promise<{ versions: Version[]; currentCompId: number | null }>;
  switchVersion(g: TaskGroup, compId: number): Promise<void>;
  /** Creates the smart object (original pixels inside, selection as its layer mask). */
  createTaskGroup(docId: number, groupRect: Rect, base: Pixels, mask: Pixels, taskId: string): Promise<TaskGroup>;
  /** Places the PNG into the group's PSB as the next version layer, records comps, shows it. */
  appendVersion(g: TaskGroup, png: Uint8Array, placement: Rect, comment: string): Promise<Version>;
  thumbnail(g: TaskGroup, size: number): Promise<string>;
  /** Called (debounced) whenever document, selection or layers may have changed. */
  onChange(cb: () => void): void;
}
