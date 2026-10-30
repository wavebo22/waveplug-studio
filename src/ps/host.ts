// What the panel needs from Photoshop. Implemented for real UXP (uxpHost.ts) and for the
// browser preview (main.preview.ts) so the UI can be developed without Photoshop.
//
// Results follow Photoshop's Generative Fill model: one layer group per fill, one masked pixel
// layer per variation inside it, exactly one variation visible. New
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
  /** All AI fill groups in the document (top to bottom). */
  listFillGroups(docId: number): { layerId: number; name: string }[];
  /** A fill group by id, or null if it no longer exists / has no variations. */
  fillGroupById(docId: number, layerId: number): Promise<FillGroup | null>;
  /** Fails with a readable message if the group is gone. */
  refreshFillGroup(g: FillGroup): Promise<FillGroup>;
  /** The group's own mask over its rect (used when adding variations without a new selection). */
  groupMask(g: FillGroup): Promise<Pixels>;
  /** Reads composite pixels of `rect`; `hide` (a fill group) is hidden while reading. */
  capture(docId: number, rect: Rect, selection: "active" | Pixels, hide?: FillGroup): Promise<Capture>;
  listLayers(docId: number): LayerInfo[];
  /** Pixels of a layer (RGBA when it has transparency), long edge capped at `maxEdge`. */
  layerPixels(docId: number, layerId: number, maxEdge?: number): Promise<Pixels>;
  layerThumbnail(docId: number, layerId: number, size: number): Promise<string>;

  variations(g: FillGroup): Promise<Variation[]>;
  showVariation(g: FillGroup, layerId: number): Promise<void>;
  /** Shows / hides the whole fill (compare with the original). Not recorded in history. */
  setFillVisible(g: FillGroup, visible: boolean): Promise<void>;
  deleteVariation(g: FillGroup, layerId: number): Promise<void>;
  /** New, empty fill group for the area `rect`. */
  createFillGroup(docId: number, rect: Rect, prompt: string): Promise<FillGroup>;
  /** Places the PNG (which covers `placement` in document pixels) as the next variation, masked by
   *  `mask` (1-channel over the group rect, everything outside hidden), and shows it. */
  addVariation(g: FillGroup, png: Uint8Array, placement: Rect, prompt: string, mask: Pixels): Promise<Variation>;
  thumbnail(g: FillGroup, layerId: number, size: number): Promise<string>;
  /** Called (debounced) whenever document, selection or layers may have changed. */
  onChange(cb: () => void): void;
}
