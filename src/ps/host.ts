// What the panel needs from Photoshop. Implemented for real UXP (uxpHost.ts) and for the
// browser preview (main.preview.ts) so the UI can be developed without Photoshop.
//
// Results follow Photoshop's Generative Fill model: one layer group per fill, one masked pixel
// layer per variation inside it, exactly one variation visible. New
// variations are always generated from the document *without* the group, i.e. from the original.

import type { Pixels } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";
import type { Side, TaskType } from "../core/workflow/profile.ts";
import type { ToolLayer, ToolResult } from "../core/layers/smart.ts";
import type { DocScan, SlimKind } from "../core/layers/slim.ts";

export type Pads = Record<Side, number>;

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
  kind: TaskType;
  /** outpaint: pixels added on each side (the original image sits inside at left/top) */
  pads?: Pads;
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

/** The active layer, for upscaling one layer. */
export interface ActiveLayer { id: number; name: string; kind: string; rect: Rect }

export interface Capture {
  doc: DocInfo;
  /** area that was read and will be sent to ComfyUI */
  rect: Rect;
  image: Pixels;
  /** 1-channel, 255 = repaint */
  selection: Pixels;
}

export const FILL_PREFIX = "AI填充 · ";
export const EXPAND_PREFIX = "AI扩图 · ";
export const GENERATE_PREFIX = "AI生成 · ";
export const UPSCALE_PREFIX = "AI放大 · ";
export const BLEND_PREFIX = "AI融图 · ";
export const EXTRACT_PREFIX = "AI抠图 · ";

export const padsLabel = (p: Pads) => `←${p.left} →${p.right} ↑${p.top} ↓${p.bottom}`;
export function parsePads(name: string): Pads | null {
  const m = /←(\d+)\s*→(\d+)\s*↑(\d+)\s*↓(\d+)/.exec(name);
  return m ? { left: +m[1], right: +m[2], top: +m[3], bottom: +m[4] } : null;
}

/** Layer mask for a variation: `pixels` cover `rect`; everything outside is hidden or revealed. */
export interface VariationMask { pixels: Pixels; rect: Rect; outside: "hide" | "reveal" }

export interface PsHost {
  readonly kind: "uxp" | "mock";
  activeDoc(): DocInfo | null;
  docExists(id: number): boolean;
  /** Bounds of the active selection, or null when there is none. */
  selectionBounds(docId: number): Promise<Rect | null>;
  /** The fill group the active layer is (or is inside), else null. */
  activeFillGroup(): Promise<FillGroup | null>;
  /** All AI fill groups in the document (top to bottom). */
  listFillGroups(docId: number): { layerId: number; name: string; kind: TaskType }[];
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
  /** The (first) selected layer of the document, or null. */
  activeLayer(docId: number): ActiveLayer | null;
  /** All selected layers of the document (top to bottom as Photoshop lists them). */
  activeLayers(docId: number): ActiveLayer[];
  /** A layer's own pixels at full resolution (RGBA when it has transparency) and where they are. */
  layerImage(docId: number, layerId: number): Promise<{ pixels: Pixels; rect: Rect }>;
  /** Places the PNG as an embedded smart object directly above `layerId`, scaled to cover `rect`,
   *  named `name`, with the layer's opacity and blend mode; the original layer is hidden. One undo step. */
  placeUpscaledLayer(docId: number, layerId: number, png: Uint8Array, rect: Rect, name: string): Promise<number>;
  /** Image currently on the clipboard (pasted through Photoshop), or null if there is none. */
  clipboardImage(maxEdge: number): Promise<Pixels | null>;

  variations(g: FillGroup): Promise<Variation[]>;
  showVariation(g: FillGroup, layerId: number): Promise<void>;
  /** Shows / hides the whole fill (compare with the original). Not recorded in history. */
  setFillVisible(g: FillGroup, visible: boolean): Promise<void>;
  deleteVariation(g: FillGroup, layerId: number): Promise<void>;
  /** New, empty fill group for the area `rect` (an outpaint group when `pads` is given, a
   *  text-to-image / upscale group when `kind` says so; an upscale group is named by `prompt`). */
  createFillGroup(docId: number, rect: Rect, prompt: string, pads?: Pads, kind?: TaskType): Promise<FillGroup>;
  /** New RGB 8-bit document (text-to-image without an open document, upscale results). */
  createDocument(width: number, height: number, name: string): Promise<DocInfo>;
  /** Places the PNG (which covers `placement` in document pixels) as the next variation with the
   *  given layer mask, and shows it. */
  addVariation(g: FillGroup, png: Uint8Array, placement: Rect, prompt: string, mask: VariationMask): Promise<Variation>;
  /** Moves layer `layerId` (e.g. a fill group) directly below layer `belowId`. */
  placeBelow(docId: number, layerId: number, belowId: number): Promise<void>;
  /** Grows the canvas by `pads` (part of the document's history). */
  expandCanvas(docId: number, pads: Pads): Promise<DocInfo>;
  /** Small composite image of the whole document, for the expand editor. */
  docThumbnail(docId: number, maxEdge: number): Promise<string>;
  thumbnail(g: FillGroup, layerId: number, size: number): Promise<string>;
  /** Called (debounced) whenever document, selection or layers may have changed. */
  onChange(cb: () => void): void;
}

/** 工具 · 智能对象: each acts on the layers selected in the active document, as one undo step. */
export interface LayerTools {
  /** Layers of the active document with their smart-object details, or null without a document. */
  inspect(): Promise<ToolLayer[] | null>;
  /** 断开链接: selected instances get their own copy of the shared content */
  makeUnique(): Promise<ToolResult>;
  /** 查找同源: selects every instance sharing content with a selected smart object */
  selectSameSource(): Promise<ToolResult>;
  /** 转换为智能对象: all selected layers into one, or each into its own */
  convert(separately: boolean): Promise<ToolResult>;
  /** 转为可编辑: smart objects with image / vector / linked content become embedded ones whose
   *  content is a PSB, at full resolution, with their transform kept */
  makeEditable(): Promise<ToolResult>;
  /** 解包图层: smart objects back into their layers */
  unpack(): Promise<ToolResult>;
  resetTransform(): Promise<ToolResult>;
  /** null when the user cancels the file / folder picker */
  replaceContents(): Promise<ToolResult | null>;
  exportContents(): Promise<ToolResult | null>;
  /** 裁剪边缘: clears faint pixels and small specks of selected pixel layers (清理强度 0–1) */
  trimEdges(strength: number): Promise<ToolResult>;
  /** 像素岛: how many layers splitting the selected pixel layers would make */
  countIslands(minArea: number, merge: number): Promise<number>;
  /** 像素岛: each island (≥ minArea px; pieces ≤ merge px apart count as one) into its own layer */
  splitIslands(minArea: number, merge: number): Promise<ToolResult>;
  /** 按行拆分文字: each line of the selected text layers into its own text layer, in place */
  splitTextLines(): Promise<ToolResult>;
  /** 文档瘦身: what the active document holds that could go, or null without a document */
  scanDoc(): Promise<DocScan | null>;
  /** 文档瘦身: removes the given kinds of items (one undo step) */
  slim(kinds: SlimKind[]): Promise<ToolResult>;
  /** Photoshop's 清理 → 全部 (history, clipboard, caches); can't be undone */
  purgeMemory(): Promise<void>;
}
