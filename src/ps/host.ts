// What the panel needs from Photoshop. Implemented for real UXP (uxpHost.ts) and for the
// browser preview (main.preview.ts) so the UI can be developed without Photoshop.
//
// Results follow Photoshop's Generative Fill model: one layer group per fill (masked by the
// selection), one pixel layer per variation inside it, exactly one variation visible. New
// variations are always generated from the document *without* the group, i.e. from the original.

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

export interface FillGroup {
  docId: number;
  /** the layer group's id */
  layerId: number;
  name: string;
  /** bounds of the fill area in the document (the selection's bounds when it was created) */
  rect: Rect;
}

export interface Variation {
  layerId: number;
  number: number;
  label: string;
  prompt: string;
  visible: boolean;
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

export const FILL_PREFIX = "AI填充 · ";

export interface PsHost {
  readonly kind: "uxp" | "mock";
  activeDoc(): DocInfo | null;
  docExists(id: number): boolean;
  /** Bounds of the active selection, or null when there is none. */
  selectionBounds(docId: number): Promise<Rect | null>;
  /** The fill group the active layer is (or is inside), else null. */
  activeFillGroup(): Promise<FillGroup | null>;
  /** Fails with a readable message if the group is gone. */
  refreshFillGroup(g: FillGroup): Promise<FillGroup>;
  /** The group's own mask over its rect (used when adding variations without a new selection). */
  groupMask(g: FillGroup): Promise<Pixels>;
  /** Reads composite pixels of `rect`; `hide` (a fill group) is hidden while reading. */
  capture(docId: number, rect: Rect, selection: "active" | Pixels, hide?: FillGroup): Promise<Capture>;
  listLayers(docId: number): LayerInfo[];
  layerPixels(docId: number, layerId: number): Promise<Pixels>;

  variations(g: FillGroup): Promise<Variation[]>;
  showVariation(g: FillGroup, layerId: number): Promise<void>;
  deleteVariation(g: FillGroup, layerId: number): Promise<void>;
  /** New group masked by `mask` (1-channel over `rect`). */
  createFillGroup(docId: number, rect: Rect, mask: Pixels, prompt: string): Promise<FillGroup>;
  /** Places the PNG (which covers `placement` in document pixels) as the next variation and shows it. */
  addVariation(g: FillGroup, png: Uint8Array, placement: Rect, prompt: string): Promise<Variation>;
  thumbnail(g: FillGroup, layerId: number, size: number): Promise<string>;
  /** Called (debounced) whenever document, selection or layers may have changed. */
  onChange(cb: () => void): void;
}
