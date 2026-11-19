// One fill: snapshot Photoshop → upload → queue (once per variation) → write each result as a
// variation of the fill group. Variations are always generated from the original pixels (the fill
// group is hidden while reading), and every write-back targets the document captured at the start.

import { encodePng, type Pixels } from "../core/image/png.ts";
import { bleedTransparent, downscale, featherInside, fullSelection, hasTransparency, resize, transferDetail, transferDetailWhereSame, imageFile, isEmptySelection, maskFile, onWhite, outpaintSeam, resizeAlpha, withAlpha } from "../core/image/compose.ts";
import { decodePng } from "../core/image/decode.ts";
import { dilate, keepInside } from "../core/layers/islands.ts";
import { MAX_REFERENCES } from "../core/workflow/references.ts";
import { type Rect, clampRect, expandBy, rectH, rectW } from "../core/image/region.ts";
import { sameMaskAt } from "../core/image/maskIdentity.ts";
import { type Comfy, type JobEvent, outputImage, pngSize, utf8 } from "../core/comfy/client.ts";
import { log } from "./log.ts";
import { prepareRun } from "../core/workflow/inject.ts";
import type { LoraSlot } from "../core/workflow/loras.ts";
import type { Profile } from "../core/workflow/profile.ts";
import type { FillGroup, Pads, PsHost, Variation } from "../ps/host.ts";

export type RefSource =
  | { kind: "layer"; docId: number; layerId: number; name: string }
  | { kind: "file"; name: string; bytes: Uint8Array };

export interface RunInput {
  profile: Profile;
  prompt: string;
  negative?: string;
  seed: number | null;
  params: Record<string, number | boolean>;
  /** extra LoRAs chosen in 高级参数 (only the enabled ones are applied) */
  loras?: LoraSlot[];
  references: Record<number, RefSource | undefined>;
  /** variations to generate in this run (each with its own seed) */
  count: number;
  /** clear ComfyUI's cache before each variation so every node runs (slower: models reload) */
  fullRun?: boolean;
  /** 融图: keep the original's fine detail under the new light */
  keepDetail?: boolean;
  /** add variations to this fill, using its own mask (the current selection is ignored);
   *  without it a new fill is created from the current selection */
  addTo?: FillGroup;
  /** 再生成: reuse the selected AI layer mask despite any current Photoshop selection. */
  reuseMask?: boolean;
  /** outpaint profiles: pixels to add on each side (ignored when adding to an existing expand) */
  pads?: Pads;
  /** text-to-image profiles: size to generate. The result goes into `addTo`'s area, else the
   *  selection, else the whole canvas, else a new document of that size. */
  size?: { width: number; height: number };
  /** upscale profiles: factor. The selection (else the whole canvas) is upscaled into a new document. */
  scale?: number;
  /** upscale profiles: upscale these layers instead, one after another, each into a smart object above it */
  layers?: { id: number; name: string }[];
  /** use this mask (255 = repaint, covering `rect`) instead of Photoshop's selection */
  selectionMask?: { pixels: Pixels; rect: Rect };
  /** hide this fill while reading the canvas (e.g. a cut-out lying over what is being removed) */
  hide?: FillGroup;
}

/**
 * Whether a workflow's output is the whole sent picture, resized: same aspect ratio, allowing for
 * workflows that round each side to a multiple of 32 px (up to ~16 px per side, a few percent on
 * small images). An output of only the selection's crop differs far more.
 */
export function sameAspect(out: { width: number; height: number }, sent: { width: number; height: number }): boolean {
  const a = out.width / out.height, b = sent.width / sent.height;
  return Math.abs(a - b) / b <= Math.max(0.01, 48 / Math.min(out.width, out.height));
}

/**
 * 抠图 → removal: where the cut-out is (alpha > 16), at the size of the area it covers, grown by
 * ~1 % of that area (≥ 6 px) so the removal also takes the object's soft edge and shadow line.
 */
export function cutoutMask(png: Uint8Array, width: number, height: number): Pixels {
  const a = resizeAlpha(decodePng(png), width, height), n = width * height, solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = a.data[i] > 16 ? 1 : 0;
  const grown = dilate(solid, width, height, Math.max(6, Math.round(Math.min(width, height) * 0.01)));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = grown[i] ? 255 : 0;
  return { width, height, channels: 1, data: out };
}

/** 抠图: context sent around the selection, in multiples of its shorter side. */
const EXTRACT_MARGIN = 0.15;
/** Longest side these workflows sample at (孤海 最大采样尺寸); used to size the detail transfer. */
const SAMPLE_EDGE = 2048;
/** Width (px) of the band inside the selection where a 融图 result fades into the original. */
export const blendFeather = (w: number, h: number) => Math.max(8, Math.min(96, Math.round(Math.min(w, h) * 0.06)));

/** Longest side of the image sent for 局部重绘 / 融图; larger crops are scaled down before upload. */
export const MAX_SEND_EDGE = 4096;

/** Longest side an upscale result may have (larger PNGs make placing in Photoshop very heavy). */
export const MAX_UPSCALE_EDGE = 12288;

export interface RunHooks {
  stage(text: string): void;
  progress(fraction: number | null, text?: string): void;
  /** called after each variation has been written */
  variationAdded?(group: FillGroup, v: Variation, seed: number): void;
  promptQueued?(promptId: string): void;
  /** Saves a copy of an exchanged file (images, the submitted workflow) for diagnosis (optional). */
  debug?(name: string, bytes: Uint8Array): void;
  signal: { aborted: boolean };
}

export interface RunResult {
  group?: FillGroup; variations: Variation[]; seeds: number[]; continued: boolean;
  /** 放大 · 当前图层: layers upscaled, and "name：reason" for those that failed */
  upscaled?: number; failed?: string[];
  /** 抠图: the cut-out's shape (255 = object, grown a little) over `rect`, for removing it from the original */
  cutout?: { pixels: Pixels; rect: Rect };
}

/** A finished result that could not be written back (document closed, group deleted …). */
export class StashedResult extends Error {
  readonly png: Uint8Array;
  constructor(message: string, png: Uint8Array) { super(message); this.png = png; }
}

export function crop(p: Pixels, from: Rect, to: Rect): Pixels {
  const w = rectW(to), h = rectH(to), ch = p.channels, out = new Uint8Array(w * h * ch);
  const dx = to.left - from.left, dy = to.top - from.top;
  if (dx < 0 || dy < 0 || dx + w > p.width || dy + h > p.height) throw new Error("裁剪范围超出读取区域");
  for (let y = 0; y < h; y++) out.set(p.data.subarray(((y + dy) * p.width + dx) * ch, ((y + dy) * p.width + dx + w) * ch), y * w * ch);
  return { width: w, height: h, channels: ch, data: out };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function paste(mask: Pixels, into: Rect, at: Rect): Pixels {
  const w = rectW(into), h = rectH(into), out = new Uint8Array(w * h);
  for (let y = 0; y < mask.height; y++) {
    const ty = y + at.top - into.top;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < mask.width; x++) {
      const tx = x + at.left - into.left;
      if (tx >= 0 && tx < w) out[ty * w + tx] = mask.data[y * mask.width + x];
    }
  }
  return { width: w, height: h, channels: 1, data: out };
}

/** Inpaint (selection → masked fill) or outpaint (whole image → expanded canvas), by the profile's task type. */
export async function runInpaint(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks): Promise<RunResult> {
  const { profile } = input;
  const check = () => { if (hooks.signal.aborted) throw new Error("已取消"); };

  if (profile.taskType === "txt2img") return runTxt2img(host, comfy, input, hooks);
  // ── 1. snapshot ──
  hooks.stage("读取 Photoshop 画面…");
  const doc = host.activeDoc();
  if (!doc) throw new Error("请先打开一个 PSD");
  if (!/RGB|CMYK/i.test(doc.mode) || doc.bits !== 8) throw new Error(`目前支持 RGB / CMYK 8 位文档（当前：${doc.mode} ${doc.bits} 位）`);
  if (profile.taskType === "outpaint") return runOutpaint(host, comfy, input, hooks, doc);
  if (profile.taskType === "upscale") return runUpscale(host, comfy, input, hooks, doc);
  const blend = profile.taskType === "blend", extract = profile.taskType === "extract";
  // 抠图: an empty name keeps the workflow's own (e.g. 「主体」)
  const promptB = profile.bindings.find(b => b.role === "prompt");
  const prompt = extract && !input.prompt.trim() && promptB ? String(profile.api[promptB.nodeId]?.inputs[promptB.input] ?? "主体") : input.prompt;
  let target = input.addTo ? await host.refreshFillGroup(input.addTo) : null;
  const selBounds = input.selectionMask ? input.selectionMask.rect : input.reuseMask ? null : await host.selectionBounds(doc.id);
  // A rectangular selection may have an entirely different silhouette inside the same bounds.
  // Never append a variation unless the actual grayscale mask agrees, including soft edges.
  if (target && selBounds) {
    const rect = clampRect(selBounds, doc.width, doc.height);
    let matched = false;
    if (sameRect(rect, target.rect)) {
      const selected = input.selectionMask?.pixels ?? await host.selectionMask(doc.id, rect);
      const mask = blend ? featherInside(selected, blendFeather(rectW(rect), rectH(rect))) : selected;
      matched = sameMaskAt(mask, rect, await host.groupMask(target), target.rect);
    }
    if (!matched) {
      log("info", "selection mask changed; creating AI layer", target.layerId, JSON.stringify(rect));
      target = null;
    }
  }
  if (!target && !selBounds) throw new Error("请先用选区框出要重绘的区域");

  const groupRect = target ? target.rect : clampRect(selBounds!, doc.width, doc.height);
  const canvas: Rect = { left: 0, top: 0, right: doc.width, bottom: doc.height };
  // area of interest always contains the group rect, so every variation covers the whole fill
  let focus = groupRect;
  if (target && selBounds) {
    const s = clampRect(selBounds, doc.width, doc.height);
    focus = { left: Math.min(s.left, focus.left), top: Math.min(s.top, focus.top), right: Math.max(s.right, focus.right), bottom: Math.max(s.bottom, focus.bottom) };
  }
  // Crop: the selection plus a margin of `cropMargin` × its shorter side (≥ what crop-and-restore
  // workflows such as 孤海遮罩裁剪V2 expand by), so the workflow sees the same context while
  // files stay small — a full 3508×4959 canvas made write-back heavy enough to crash Photoshop.
  // The margin shrinks on very large selections so the crop stays within MAX_SEND_EDGE.
  // 抠图 sends little context so the object fills the picture the model sees
  const margin = Math.min(Math.ceil(Math.min(rectW(focus), rectH(focus)) * (extract ? EXTRACT_MARGIN : profile.options.cropMargin)),
    Math.max(0, Math.floor((MAX_SEND_EDGE - Math.max(rectW(focus), rectH(focus))) / 2)));
  const sendRect = profile.options.sendScope === "canvas" ? canvas : expandBy(focus, margin, doc.width, doc.height);

  let selection: "active" | Pixels = "active";
  if (input.selectionMask) selection = paste(input.selectionMask.pixels, sendRect, input.selectionMask.rect);
  else if (!selBounds && target) selection = paste(await host.groupMask(target), sendRect, target.rect);
  const cap = await host.capture(doc.id, sendRect, selection, target ?? input.hide);
  if (isEmptySelection(cap.selection)) throw new Error("选区为空");
  check();

  // Larger crops are sent scaled down (ComfyUI accepts at most 100 MB per upload, and these workflows
  // sample at ≤ 2048 px anyway); the result is still placed over the full sendRect.
  const sendScale = Math.min(1, MAX_SEND_EDGE / Math.max(rectW(sendRect), rectH(sendRect)));
  const sw = Math.max(1, Math.round(rectW(sendRect) * sendScale)), sh = Math.max(1, Math.round(rectH(sendRect) * sendScale));
  const sentImage = sendScale < 1 ? downscale(cap.image, sw, sh) : cap.image;
  const sentSel = sendScale < 1 ? downscale(cap.selection, sw, sh) : cap.selection;
  log("info", "send", `${rectW(sendRect)}x${rectH(sendRect)}`, sendScale < 1 ? `scaled to ${sw}x${sh}` : "");

  // ── 2. upload ──
  hooks.stage("上传到 ComfyUI…");
  const stamp = Date.now().toString(36);
  const upload = (p: Pixels, role: string) => {
    const png = encodePng(p);
    hooks.debug?.(`${stamp}_${role}.png`, png);
    return comfy.uploadImage(png, `wp_${stamp}_${role}.png`);
  };
  const t0 = Date.now();
  const img = profile.bindings.find(b => b.role === "image")!;
  const values = {
    image: await upload(imageFile(sentImage, img.encoding ?? "rgb", sentSel), "image"),
    mask: undefined as string | undefined,
    references: {} as Record<number, string>,
  };
  const maskB = profile.bindings.find(b => b.role === "mask");
  if (maskB) values.mask = await upload(maskFile(sentSel, maskB.encoding === "mask-alpha" ? "mask-alpha" : "mask-gray"), "mask");
  // reference bytes are kept so every variation can upload its own copy (see below)
  const refBytes: Record<number, { bytes: Uint8Array; ext: string }> = {};
  const uploadRef = async (slot: number, src: RefSource, k = 0) => {
    refBytes[slot] ??= src.kind === "file"
      ? { bytes: src.bytes, ext: (/\.(png|jpe?g|webp)$/i.exec(src.name)?.[1] ?? "png").toLowerCase() }
      : { bytes: encodePng(onWhite(await host.layerPixels(src.docId, src.layerId, 1536))), ext: "png" };
    const { bytes, ext } = refBytes[slot];
    if (k === 0) hooks.debug?.(`${stamp}_ref${slot}.${ext}`, bytes);
    return comfy.uploadImage(bytes, `wp_${stamp}_ref${slot}_v${k}.${ext}`);
  };
  const refBindings = profile.bindings.filter(x => x.role === "reference"
    && Number.isInteger(x.slot) && x.slot! >= 1 && x.slot! <= MAX_REFERENCES);
  for (const b of refBindings) {
    const src = input.references[b.slot ?? 0];
    if (!src) throw new Error(`参考图 ${b.slot} 还没有选择素材`);
    values.references[b.slot!] = await uploadRef(b.slot!, src);
  }
  if (!refBindings.length && profile.options.refSlots) {
    for (let slot = 1; slot <= MAX_REFERENCES; slot++) {
      const src = input.references[slot];
      if (src) { hooks.stage(`上传参考图 ${slot}…`); values.references[slot] = await uploadRef(slot, src); }
    }
  }
  check();

  // ── 3. run, once per variation ──
  let group: FillGroup | null = target;
  const variations: Variation[] = [], seeds: number[] = [];
  let cutout: RunResult["cutout"];
  const count = Math.max(1, Math.min(4, Math.floor(input.count) || 1));
  for (let k = 0; k < count; k++) {
    const tag = count > 1 ? `（${k + 1}/${count}）` : "";
    // ComfyUI caches by input contents: with the same reference file the conditioning of the first
    // variation was reused and only that one followed the reference. A per-variation file name
    // makes the reference loader and the encoder run again for every variation.
    if (k > 0) for (const slot of Object.keys(values.references).map(Number)) {
      const src = input.references[slot];
      if (src) values.references[slot] = await uploadRef(slot, src, k);
    }
    const run = prepareRun(profile, { ...values, prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, loras: input.loras, variant: k });
    log("info", "run", JSON.stringify({ prompt: input.prompt, seed: run.seed, profile: profile.name, localMask: !!profile.options.localMask?.enabled, continued: !!target }));
    if (input.fullRun) { hooks.stage("清空 ComfyUI 缓存" + tag); await comfy.freeCache(); }
    // the exact execution copy — can be dragged into ComfyUI to inspect or re-run it there
    hooks.debug?.(`${stamp}_workflow${k ? "_" + k : ""}.json`, utf8(JSON.stringify(run.api, null, 1)));
    const job = await comfy.queue(run.api);
    hooks.promptQueued?.(job.promptId);
    hooks.stage("排队中" + tag);
    const tQueued = Date.now(), tUpload = k === 0 ? tQueued - t0 : 0;
    const history = await comfy.waitFor(job.promptId, (e: JobEvent) => {
      if (e.type === "cached") log("info", "comfy cached nodes", e.nodes.join(","));
      if (e.type === "running") { hooks.stage((e.node ? `执行中 · #${e.node} ${run.api[e.node]?._meta?.title ?? run.api[e.node]?.class_type ?? ""}` : "执行中") + tag); log("info", "comfy executing", e.node, run.api[e.node ?? ""]?.class_type ?? "", `+${((Date.now() - tQueued) / 1000).toFixed(1)}s`); }
      if (e.type === "progress") hooks.progress(e.max ? (k + e.value / e.max) / count : null, `采样 ${e.value}/${e.max}${tag}`);
    }, { signal: hooks.signal });
    const out = run.outputs[0];
    hooks.stage("取回结果" + tag);
    let png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
    hooks.debug?.(`${stamp}_output${k ? "_" + k : ""}.png`, png);
    const outSize = pngSize(png);
    log("info", "run timing", `upload ${(tUpload / 1000).toFixed(1)}s`, `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`,
      "sent", `${rectW(sendRect)}x${rectH(sendRect)}`, "output", outSize ? `${outSize.width}x${outSize.height}` : "?");
    // A workflow that returns only its crop (not the full sent image) can't be placed by stretching.
    if (outSize) {
      if (!sameAspect(outSize, { width: rectW(sendRect), height: rectH(sendRect) })) {
        throw new StashedResult(`工作流输出 ${outSize.width}×${outSize.height} 与发送的画面 ${rectW(sendRect)}×${rectH(sendRect)} 比例不同，为避免错位未写入`, png);
      }
    }
    // 抠图, like 局部重绘: keep only what the selection takes in whole (the model sometimes cuts out
    // neighbours too, or things the selection only touches)
    if (extract && outSize) {
      const cut = decodePng(png);
      if (cut.channels !== 4) throw new StashedResult("这个工作流没有输出透明图（PNG 没有透明通道），请确认用的是抠图工作流", png);
      const sel = resize(sentSel, cut.width, cut.height);
      const r = keepInside(cut, sel, Math.round(Math.min(cut.width, cut.height) * 0.03));
      log("info", "extract islands", `kept ${r.kept}`, `dropped ${r.dropped}`);
      if (!r.kept) throw new StashedResult("选区里没有被完整框住的东西：把要抠的物件整个框进去（可以框大一点），或者写上物件名", png);
      // 保留原图细节: at full resolution, the original's detail where the cut-out still shows the same
      // thing; the model's own pixels where it completed or changed something
      if (input.keepDetail) {
        hooks.stage("保留原图细节" + tag);
        const W = cap.image.width, H = cap.image.height;
        const sigma = Math.max(1.5, Math.max(W, H) / Math.max(cut.width, cut.height) * 1.2);
        png = encodePng(withAlpha(transferDetailWhereSame(resize(r.pixels, W, H), cap.image, sigma), resizeAlpha(r.pixels, W, H)));
        log("info", "extract keep detail", `sigma ${sigma.toFixed(1)}`, `${W}x${H}`);
      } else png = encodePng(r.pixels);
      cutout = { pixels: cutoutMask(png, rectW(sendRect), rectH(sendRect)), rect: sendRect };
    }
    // 融图 · 保留原图细节: light, shadow and colour from the result, fine detail from the original at
    // full resolution (the workflow samples at ≤ 2048 px, so a large selection came back soft)
    if (blend && input.keepDetail && outSize) {
      hooks.stage("保留原图细节" + tag);
      const factor = Math.max(cap.image.width, cap.image.height) / Math.min(SAMPLE_EDGE, Math.max(outSize.width, outSize.height));
      const sigma = Math.max(1.5, factor * 1.2);
      png = encodePng(transferDetail(resize(decodePng(png), cap.image.width, cap.image.height), cap.image, sigma));
      log("info", "blend keep detail", `sigma ${sigma.toFixed(1)}`);
    }
    check();

    // ── 4. write back to the snapshot's document ──
    hooks.stage("写入 Photoshop" + tag);
    if (!host.docExists(doc.id)) throw new StashedResult("发起任务的 PSD 已关闭，结果未写入", png);
    try {
      group = group
        ? await host.refreshFillGroup(group)
        : await host.createFillGroup(doc.id, groupRect, extract ? prompt : input.prompt, undefined, blend ? "blend" : extract ? "extract" : undefined);
    } catch (e) {
      throw new StashedResult((e as Error).message + "，结果未写入", png);
    }
    // 融图 changes the light around the subject too: fade it into the original inside the selection's edge
    // (a fill's own mask, used when adding variations without a new selection, is already soft)
    const selMask = crop(cap.selection, sendRect, groupRect);
    const mask = blend && selection === "active" ? featherInside(selMask, blendFeather(rectW(groupRect), rectH(groupRect))) : selMask;
    // 抠图: the cut-out's own transparency is the shape; the layer isn't masked by the selection
    const v = await host.addVariation(group, png, sendRect, extract ? prompt : input.prompt, extract
      ? { pixels: fullSelection(rectW(groupRect), rectH(groupRect)), rect: groupRect, outside: "reveal" }
      : { pixels: mask, rect: groupRect, outside: "hide" });
    variations.push(v); seeds.push(run.seed);
    hooks.variationAdded?.(group, v, run.seed);
    check();
  }
  return { group: group!, variations, seeds, continued: !!target, cutout };
}

/** Uploads the run's references; `forVariation(k)` re-uploads them under new names for variation k
 *  (ComfyUI caches by input contents, so a shared file let later variations reuse the first
 *  variation's encoding and ignore the reference). */
async function referenceUploader(host: PsHost, comfy: Comfy, input: RunInput, stamp: string, hooks: RunHooks) {
  const { profile } = input;
  const files: Record<number, string> = {};
  const bytesOf: Record<number, { bytes: Uint8Array; ext: string }> = {};
  const uploadRef = async (slot: number, src: RefSource, k: number) => {
    bytesOf[slot] ??= src.kind === "file"
      ? { bytes: src.bytes, ext: (/\.(png|jpe?g|webp)$/i.exec(src.name)?.[1] ?? "png").toLowerCase() }
      : { bytes: encodePng(onWhite(await host.layerPixels(src.docId, src.layerId, 1536))), ext: "png" };
    const { bytes, ext } = bytesOf[slot];
    if (k === 0) hooks.debug?.(`${stamp}_ref${slot}.${ext}`, bytes);
    return comfy.uploadImage(bytes, `wp_${stamp}_ref${slot}_v${k}.${ext}`);
  };
  const bound = profile.bindings.filter(x => x.role === "reference").map(b => b.slot!)
    .filter(slot => Number.isInteger(slot) && slot >= 1 && slot <= MAX_REFERENCES).slice(0, MAX_REFERENCES);
  const slots = bound.length ? bound : profile.options.refSlots ? Array.from({ length: MAX_REFERENCES }, (_, i) => i + 1) : [];
  const forVariation = async (k: number) => {
    for (const slot of slots) {
      const src = input.references[slot];
      if (!src) {
        const b = profile.bindings.find(x => x.role === "reference" && x.slot === slot);
        if (b && !b.emptyValue) throw new Error(`参考图 ${slot} 还没有选择素材`);
        continue;
      }
      if (k === 0) hooks.stage(`上传参考图 ${slot}…`);
      files[slot] = await uploadRef(slot, src, k);
    }
    return files;
  };
  return { forVariation };
}

/**
 * Outpaint: send the original image (the fill group hidden), get back the expanded image, grow the
 * canvas once, and place each variation over the whole canvas with a seam mask that keeps the
 * original pixels (so a result capped by the workflow's max output size never blurs them).
 */
async function runOutpaint(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks, doc: { id: number; width: number; height: number }): Promise<RunResult> {
  const { profile } = input;
  const check = () => { if (hooks.signal.aborted) throw new Error("已取消"); };
  const target = input.addTo ? await host.refreshFillGroup(input.addTo) : null;
  if (target && target.kind !== "outpaint") throw new Error("当前选中的是局部重绘的填充，请在扩图模式下新建扩图");
  const pads = target ? target.pads! : input.pads;
  if (!pads || !(pads.left || pads.right || pads.top || pads.bottom)) throw new Error("请先在画布上拖出要扩展的范围");
  // the expansion's whole area (where results go) and the original image inside it: the whole
  // canvas for a new expand; for an existing one its own area, which may no longer be the canvas
  const area: Rect = target ? target.rect : { left: 0, top: 0, right: doc.width + pads.left + pads.right, bottom: doc.height + pads.top + pads.bottom };
  const orig: Rect = target
    ? { left: area.left + pads.left, top: area.top + pads.top, right: area.right - pads.right, bottom: area.bottom - pads.bottom }
    : { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const w = rectW(orig), h = rectH(orig);
  if (w <= 0 || h <= 0) throw new Error("画布尺寸与扩图记录不符（画布可能被裁剪过），请新建扩图");
  const cap = await host.capture(doc.id, orig, fullSelection(w, h), target ?? undefined);
  check();

  hooks.stage("上传到 ComfyUI…");
  const stamp = Date.now().toString(36);
  const png0 = encodePng(onWhite(cap.image));
  hooks.debug?.(`${stamp}_image.png`, png0);
  const t0 = Date.now();
  const image = await comfy.uploadImage(png0, `wp_${stamp}_image.png`);
  const refs = await referenceUploader(host, comfy, input, stamp, hooks);
  check();

  const outW = w + pads.left + pads.right, outH = h + pads.top + pads.bottom;
  let group: FillGroup | null = target;
  const variations: Variation[] = [], seeds: number[] = [];
  const count = Math.max(1, Math.min(4, Math.floor(input.count) || 1));
  for (let k = 0; k < count; k++) {
    const tag = count > 1 ? `（${k + 1}/${count}）` : "";
    const references = await refs.forVariation(k);
    const run = prepareRun(profile, { image, references, prompt: input.prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, loras: input.loras, variant: k, pads });
    log("info", "run", JSON.stringify({ task: "outpaint", prompt: input.prompt, seed: run.seed, pads, profile: profile.name, continued: !!target }));
    if (input.fullRun) { hooks.stage("清空 ComfyUI 缓存" + tag); await comfy.freeCache(); }
    hooks.debug?.(`${stamp}_workflow${k ? "_" + k : ""}.json`, utf8(JSON.stringify(run.api, null, 1)));
    const job = await comfy.queue(run.api);
    hooks.promptQueued?.(job.promptId);
    hooks.stage("排队中" + tag);
    const tQueued = Date.now();
    const history = await comfy.waitFor(job.promptId, (e: JobEvent) => {
      if (e.type === "running") { hooks.stage((e.node ? `执行中 · #${e.node} ${run.api[e.node]?._meta?.title ?? run.api[e.node]?.class_type ?? ""}` : "执行中") + tag); log("info", "comfy executing", e.node, run.api[e.node ?? ""]?.class_type ?? "", `+${((Date.now() - tQueued) / 1000).toFixed(1)}s`); }
      if (e.type === "progress") hooks.progress(e.max ? (k + e.value / e.max) / count : null, `采样 ${e.value}/${e.max}${tag}`);
    }, { signal: hooks.signal });
    const out = run.outputs[0];
    hooks.stage("取回结果" + tag);
    const png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
    hooks.debug?.(`${stamp}_output${k ? "_" + k : ""}.png`, png);
    const outSize = pngSize(png);
    log("info", "run timing", `upload ${k ? 0 : ((tQueued - t0) / 1000).toFixed(1)}s`, `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`, "original", `${w}x${h}`, "expanded", `${outW}x${outH}`, "output", outSize ? `${outSize.width}x${outSize.height}` : "?");
    // the canvas node may cap / round the output size; the aspect must still match the expand
    if (outSize && Math.abs(outSize.width / outSize.height - outW / outH) / (outW / outH) > 0.02) {
      throw new StashedResult(`扩图输出 ${outSize.width}×${outSize.height} 与扩展后的画布 ${outW}×${outH} 比例不同，为避免错位未写入`, png);
    }
    check();

    hooks.stage("写入 Photoshop" + tag);
    if (!host.docExists(doc.id)) throw new StashedResult("发起任务的 PSD 已关闭，结果未写入", png);
    // expand, new group and the variation are separate undo steps: if a later one fails, keep the
    // result and say which earlier steps already changed the PSD
    let expanded = false, created = false, v: Variation;
    try {
      if (!group) {
        await host.expandCanvas(doc.id, pads);
        expanded = true;
        group = await host.createFillGroup(doc.id, area, input.prompt, pads);
        created = true;
      } else group = await host.refreshFillGroup(group);
      const inner: Rect = { left: area.left + pads.left, top: area.top + pads.top, right: area.left + pads.left + w, bottom: area.top + pads.top + h };
      const feather = Math.max(4, Math.min(32, Math.round(Math.min(w, h) * 0.01)));
      v = await host.addVariation(group, png, area, input.prompt,
        { pixels: outpaintSeam(w, h, pads, feather), rect: inner, outside: "reveal" });
    } catch (e) {
      const done = created ? "；画布已扩展并新建了空的扩图图层组，可在历史记录中撤销「WavePlug 新建 AI 扩图」「WavePlug 扩展画布」"
        : expanded ? "；画布已扩展，可在历史记录中撤销「WavePlug 扩展画布」" : "";
      throw new StashedResult((e as Error).message + "，结果未写入" + done, png);
    }
    variations.push(v); seeds.push(run.seed);
    hooks.variationAdded?.(group, v, run.seed);
    check();
  }
  return { group: group!, variations, seeds, continued: !!target };
}

/** Largest rect of aspect `ratio` (w / h) centred inside `area`. */
export function containRect(area: Rect, ratio: number): Rect {
  const aw = rectW(area), ah = rectH(area);
  const w = Math.min(aw, Math.round(ah * ratio)), h = Math.min(ah, Math.round(aw / ratio));
  const left = area.left + Math.round((aw - w) / 2), top = area.top + Math.round((ah - h) / 2);
  return { left, top, right: left + w, bottom: top + h };
}

/**
 * Text-to-image: nothing is read from the document (references aside). Each result becomes a
 * variation of an 「AI生成」 group, fitted into the selection / canvas, or a new document is made.
 */
async function runTxt2img(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks): Promise<RunResult> {
  const { profile } = input;
  const check = () => { if (hooks.signal.aborted) throw new Error("已取消"); };
  if (!input.size) throw new Error("缺少输出尺寸");
  const size = input.size;
  let doc = host.activeDoc();
  if (doc && (!/RGB|CMYK/i.test(doc.mode) || doc.bits !== 8)) throw new Error(`目前支持 RGB / CMYK 8 位文档（当前：${doc.mode} ${doc.bits} 位）`);
  let target = input.addTo ? await host.refreshFillGroup(input.addTo) : null;
  if (target && target.kind !== "txt2img") throw new Error("当前选中的不是 AI 生成的图层组");
  if (target) doc = { ...doc!, id: target.docId };
  // Text-to-image has a fully opaque rectangular layer mask. A new selection with different
  // pixels or a different rectangle must produce a new AI layer, even at identical bounds.
  if (doc && target && !input.reuseMask) {
    const bounds = await host.selectionBounds(doc.id);
    if (bounds) {
      const rect = clampRect(bounds, doc.width, doc.height);
      const matched = sameRect(rect, target.rect)
        && sameMaskAt(await host.selectionMask(doc.id, rect), rect, await host.groupMask(target), target.rect);
      if (!matched) {
        log("info", "txt2img selection mask changed; creating AI layer", target.layerId);
        target = null;
      }
    }
  }
  // where results go: the group's area, the selection, the whole canvas — or (no document) a new one
  let area: Rect | null = target ? target.rect : null;
  if (!area && doc) {
    const s = await host.selectionBounds(doc.id);
    area = s ? clampRect(s, doc.width, doc.height) : { left: 0, top: 0, right: doc.width, bottom: doc.height };
  }

  const stamp = Date.now().toString(36);
  const refs = await referenceUploader(host, comfy, input, stamp, hooks);
  check();

  let group: FillGroup | null = target;
  const variations: Variation[] = [], seeds: number[] = [];
  const count = Math.max(1, Math.min(4, Math.floor(input.count) || 1));
  for (let k = 0; k < count; k++) {
    const tag = count > 1 ? `（${k + 1}/${count}）` : "";
    const references = await refs.forVariation(k);
    const run = prepareRun(profile, { references, prompt: input.prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, loras: input.loras, variant: k, size });
    log("info", "run", JSON.stringify({ task: "txt2img", prompt: input.prompt, seed: run.seed, size, profile: profile.name, continued: !!target }));
    if (input.fullRun) { hooks.stage("清空 ComfyUI 缓存" + tag); await comfy.freeCache(); }
    hooks.debug?.(`${stamp}_workflow${k ? "_" + k : ""}.json`, utf8(JSON.stringify(run.api, null, 1)));
    const job = await comfy.queue(run.api);
    hooks.promptQueued?.(job.promptId);
    hooks.stage("排队中" + tag);
    const tQueued = Date.now();
    const history = await comfy.waitFor(job.promptId, (e: JobEvent) => {
      if (e.type === "running") { hooks.stage((e.node ? `执行中 · #${e.node} ${run.api[e.node]?._meta?.title ?? run.api[e.node]?.class_type ?? ""}` : "执行中") + tag); log("info", "comfy executing", e.node, run.api[e.node ?? ""]?.class_type ?? "", `+${((Date.now() - tQueued) / 1000).toFixed(1)}s`); }
      if (e.type === "progress") hooks.progress(e.max ? (k + e.value / e.max) / count : null, `采样 ${e.value}/${e.max}${tag}`);
    }, { signal: hooks.signal });
    const out = run.outputs[0];
    hooks.stage("取回结果" + tag);
    const png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
    hooks.debug?.(`${stamp}_output${k ? "_" + k : ""}.png`, png);
    const outSize = pngSize(png) ?? size;
    log("info", "run timing", `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`, "requested", `${size.width}x${size.height}`, "output", `${outSize.width}x${outSize.height}`);
    check();

    hooks.stage("写入 Photoshop" + tag);
    try {
      if (!doc) {
        doc = await host.createDocument(outSize.width, outSize.height, "AI生成 " + (input.prompt.trim().slice(0, 20) || "图像"));
        area = { left: 0, top: 0, right: outSize.width, bottom: outSize.height };
      }
      if (!host.docExists(doc.id)) throw new Error("发起任务的 PSD 已关闭");
      // keep the result's own aspect: fit it inside the area, centred
      const place = group ? group.rect : containRect(area!, outSize.width / outSize.height);
      group = group ? await host.refreshFillGroup(group) : await host.createFillGroup(doc.id, place, input.prompt, undefined, "txt2img");
      const full: Pixels = { width: rectW(place), height: rectH(place), channels: 1, data: new Uint8Array(rectW(place) * rectH(place)).fill(255) };
      const v = await host.addVariation(group, png, place, input.prompt, { pixels: full, rect: place, outside: "hide" });
      variations.push(v); seeds.push(run.seed);
      hooks.variationAdded?.(group, v, run.seed);
    } catch (e) {
      if (e instanceof StashedResult) throw e;
      throw new StashedResult((e as Error).message + "，结果未写入", png);
    }
    check();
  }
  return { group: group!, variations, seeds, continued: !!target };
}

/**
 * Upscale: the selection's bounds (else the whole canvas, all visible layers) are sent; the result
 * goes into a new document as variations of an 「AI放大」 group, so the source document is untouched.
 */
async function runUpscale(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks, doc: { id: number; name: string; width: number; height: number }): Promise<RunResult> {
  const { profile } = input;
  const check = () => { if (hooks.signal.aborted) throw new Error("已取消"); };
  const scale = input.scale ?? 2;
  if (input.layers?.length) return runUpscaleLayers(host, comfy, input, hooks, doc, input.layers, scale);
  const sel = await host.selectionBounds(doc.id);
  const rect: Rect = sel ? clampRect(sel, doc.width, doc.height) : { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const w = rectW(rect), h = rectH(rect);
  if (w <= 0 || h <= 0) throw new Error("选区为空");
  if (Math.max(w, h) * scale > MAX_UPSCALE_EDGE) throw new Error(`放大后 ${w * scale}×${h * scale} 超过上限 ${MAX_UPSCALE_EDGE} 像素，请框选一部分或降低倍数`);
  const cap = await host.capture(doc.id, rect, fullSelection(w, h));
  check();

  hooks.stage("上传到 ComfyUI…");
  const stamp = Date.now().toString(36);
  const png0 = encodePng(onWhite(cap.image));
  hooks.debug?.(`${stamp}_image.png`, png0);
  const image = await comfy.uploadImage(png0, `wp_${stamp}_image.png`);
  check();

  const label = `×${scale}` + (sel ? ` 选区 ${w}×${h}` : "");
  let target: { id: number } | null = null;
  let group: FillGroup | null = null;
  const variations: Variation[] = [], seeds: number[] = [];
  const count = Math.max(1, Math.min(4, Math.floor(input.count) || 1));
  for (let k = 0; k < count; k++) {
    const tag = count > 1 ? `（${k + 1}/${count}）` : "";
    const run = prepareRun(profile, { image, prompt: input.prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, loras: input.loras, variant: k, scale });
    log("info", "run", JSON.stringify({ task: "upscale", scale, rect, seed: run.seed, profile: profile.name }));
    if (input.fullRun) { hooks.stage("清空 ComfyUI 缓存" + tag); await comfy.freeCache(); }
    hooks.debug?.(`${stamp}_workflow${k ? "_" + k : ""}.json`, utf8(JSON.stringify(run.api, null, 1)));
    const job = await comfy.queue(run.api);
    hooks.promptQueued?.(job.promptId);
    hooks.stage("排队中" + tag);
    const tQueued = Date.now();
    const history = await comfy.waitFor(job.promptId, (e: JobEvent) => {
      if (e.type === "running") { hooks.stage((e.node ? `执行中 · #${e.node} ${run.api[e.node]?._meta?.title ?? run.api[e.node]?.class_type ?? ""}` : "执行中") + tag); log("info", "comfy executing", e.node, run.api[e.node ?? ""]?.class_type ?? "", `+${((Date.now() - tQueued) / 1000).toFixed(1)}s`); }
      if (e.type === "progress") hooks.progress(e.max ? (k + e.value / e.max) / count : null, `进度 ${e.value}/${e.max}${tag}`);
    }, { signal: hooks.signal });
    const out = run.outputs[0];
    hooks.stage("取回结果" + tag);
    const png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
    hooks.debug?.(`${stamp}_output${k ? "_" + k : ""}.png`, png);
    const outSize = pngSize(png) ?? { width: w * scale, height: h * scale };
    log("info", "run timing", `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`, "sent", `${w}x${h}`, "output", `${outSize.width}x${outSize.height}`);
    if (Math.abs(outSize.width / outSize.height - w / h) / (w / h) > 0.02) {
      throw new StashedResult(`放大输出 ${outSize.width}×${outSize.height} 与原图 ${w}×${h} 比例不同，未写入`, png);
    }
    check();

    hooks.stage("写入 Photoshop" + tag);
    try {
      // every variation of this run goes into the first one's document and group, at its size
      if (!target) target = await host.createDocument(outSize.width, outSize.height, `${doc.name.replace(/\.[a-z0-9]+$/i, "")} ${label}`);
      if (!host.docExists(target.id)) throw new Error("放大结果的文档已关闭");
      const area: Rect = group ? group.rect : { left: 0, top: 0, right: outSize.width, bottom: outSize.height };
      group = group ? await host.refreshFillGroup(group) : await host.createFillGroup(target.id, area, label, undefined, "upscale");
      const full: Pixels = { width: rectW(area), height: rectH(area), channels: 1, data: new Uint8Array(rectW(area) * rectH(area)).fill(255) };
      const v = await host.addVariation(group, png, area, label, { pixels: full, rect: area, outside: "hide" });
      variations.push(v); seeds.push(run.seed);
      hooks.variationAdded?.(group, v, run.seed);
    } catch (e) {
      if (e instanceof StashedResult) throw e;
      throw new StashedResult((e as Error).message + "，结果未写入", png);
    }
    check();
  }
  return { group: group!, variations, seeds, continued: false };
}

/**
 * Upscale one layer: its own pixels (full resolution, transparency kept) are sent and the result is
 * placed as a smart object above it at the same size, with the upscaled pixels inside; the original
 * layer is hidden. Transparent layers: the colour is upscaled by the workflow, the alpha locally.
 */
/** 放大 · 当前图层 for every selected layer in turn; one failing doesn't stop the others. */
async function runUpscaleLayers(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks, doc: { id: number }, layers: { id: number; name: string }[], scale: number): Promise<RunResult> {
  if (layers.length === 1) return runUpscaleLayer(host, comfy, input, hooks, doc, layers[0], scale);
  const seeds: number[] = [], failed: string[] = [];
  for (const [k, layer] of layers.entries()) {
    if (hooks.signal.aborted) throw new Error("已取消");
    const tag = `（${k + 1}/${layers.length}「${layer.name}」）`;
    const sub: RunHooks = { ...hooks, stage: t => hooks.stage(t + tag), progress: (f, t) => hooks.progress(f === null ? null : (k + f) / layers.length, t && t + tag) };
    try { seeds.push(...(await runUpscaleLayer(host, comfy, input, sub, doc, layer, scale)).seeds); }
    catch (e) {
      if (hooks.signal.aborted) throw e;
      failed.push(`${layer.name}：${(e as Error).message}`);
      log("warn", "upscale layer failed", layer.name, e);
    }
  }
  if (!seeds.length) throw new Error(`${layers.length} 个图层都没能放大：${failed[0]}`);
  return { variations: [], seeds, continued: false, upscaled: seeds.length, failed };
}

async function runUpscaleLayer(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks, doc: { id: number }, layer: { id: number; name: string }, scale: number): Promise<RunResult> {
  const { profile } = input;
  const check = () => { if (hooks.signal.aborted) throw new Error("已取消"); };
  hooks.stage("读取图层…");
  const src = await host.layerImage(doc.id, layer.id);
  const w = src.pixels.width, h = src.pixels.height;
  if (w <= 1 || h <= 1) throw new Error(`图层「${layer.name}」是空的`);
  if (Math.max(w, h) * scale > MAX_UPSCALE_EDGE) throw new Error(`放大后 ${w * scale}×${h * scale} 超过上限 ${MAX_UPSCALE_EDGE} 像素，请降低倍数`);
  const transparent = hasTransparency(src.pixels);
  check();

  hooks.stage("上传到 ComfyUI…");
  const stamp = Date.now().toString(36);
  const png0 = encodePng(transparent ? bleedTransparent(src.pixels) : onWhite(src.pixels));
  hooks.debug?.(`${stamp}_image.png`, png0);
  const image = await comfy.uploadImage(png0, `wp_${stamp}_image.png`);
  check();

  const run = prepareRun(profile, { image, prompt: input.prompt, negative: input.negative, seed: input.seed, params: input.params, loras: input.loras, scale });
  log("info", "run", JSON.stringify({ task: "upscale-layer", scale, layer: layer.id, rect: src.rect, transparent, seed: run.seed, profile: profile.name }));
  if (input.fullRun) { hooks.stage("清空 ComfyUI 缓存"); await comfy.freeCache(); }
  hooks.debug?.(`${stamp}_workflow.json`, utf8(JSON.stringify(run.api, null, 1)));
  const job = await comfy.queue(run.api);
  hooks.promptQueued?.(job.promptId);
  hooks.stage("排队中");
  const tQueued = Date.now();
  const history = await comfy.waitFor(job.promptId, (e: JobEvent) => {
    if (e.type === "running") { hooks.stage(e.node ? `执行中 · #${e.node} ${run.api[e.node]?._meta?.title ?? run.api[e.node]?.class_type ?? ""}` : "执行中"); log("info", "comfy executing", e.node, run.api[e.node ?? ""]?.class_type ?? "", `+${((Date.now() - tQueued) / 1000).toFixed(1)}s`); }
    if (e.type === "progress") hooks.progress(e.max ? e.value / e.max : null, `进度 ${e.value}/${e.max}`);
  }, { signal: hooks.signal });
  const out = run.outputs[0];
  hooks.stage("取回结果");
  let png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
  hooks.debug?.(`${stamp}_output.png`, png);
  const outSize = pngSize(png) ?? { width: w * scale, height: h * scale };
  log("info", "run timing", `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`, "sent", `${w}x${h}`, "output", `${outSize.width}x${outSize.height}`);
  if (Math.abs(outSize.width / outSize.height - w / h) / (w / h) > 0.02) {
    throw new StashedResult(`放大输出 ${outSize.width}×${outSize.height} 与图层 ${w}×${h} 比例不同，未写入`, png);
  }
  check();

  try {
    if (transparent) {
      hooks.stage("合成透明通道");
      const color = decodePng(png);
      png = encodePng(withAlpha(color, resizeAlpha(src.pixels, color.width, color.height)));
    }
    hooks.stage("写入 Photoshop");
    if (!host.docExists(doc.id)) throw new Error("发起任务的 PSD 已关闭");
    await host.placeUpscaledLayer(doc.id, layer.id, png, src.rect, `${layer.name} ×${scale}`);
  } catch (e) {
    throw new StashedResult((e as Error).message + "，结果未写入", png);
  }
  return { variations: [], seeds: [run.seed], continued: false, upscaled: 1 };
}
