// One fill: snapshot Photoshop → upload → queue (once per variation) → write each result as a
// variation of the fill group. Variations are always generated from the original pixels (the fill
// group is hidden while reading), and every write-back targets the document captured at the start.

import { encodePng, type Pixels } from "../core/image/png.ts";
import { fullSelection, imageFile, isEmptySelection, maskFile, onWhite, outpaintSeam } from "../core/image/compose.ts";
import { MAX_REFERENCES } from "../core/workflow/references.ts";
import { type Rect, clampRect, expandBy, rectH, rectW } from "../core/image/region.ts";
import { type Comfy, type JobEvent, outputImage, pngSize, utf8 } from "../core/comfy/client.ts";
import { log } from "./log.ts";
import { prepareRun } from "../core/workflow/inject.ts";
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
  references: Record<number, RefSource | undefined>;
  /** variations to generate in this run (each with its own seed) */
  count: number;
  /** clear ComfyUI's cache before each variation so every node runs (slower: models reload) */
  fullRun?: boolean;
  /** add variations to this fill, using its own mask (the current selection is ignored);
   *  without it a new fill is created from the current selection */
  addTo?: FillGroup;
  /** outpaint profiles: pixels to add on each side (ignored when adding to an existing expand) */
  pads?: Pads;
  /** text-to-image profiles: size to generate. The result goes into `addTo`'s area, else the
   *  selection, else the whole canvas, else a new document of that size. */
  size?: { width: number; height: number };
}

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

export interface RunResult { group: FillGroup; variations: Variation[]; seeds: number[]; continued: boolean }

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
  const target = input.addTo ? await host.refreshFillGroup(input.addTo) : null;
  const selBounds = input.addTo ? null : await host.selectionBounds(doc.id);
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
  const sendRect = profile.options.sendScope === "canvas" ? canvas
    : expandBy(focus, Math.ceil(Math.min(rectW(focus), rectH(focus)) * profile.options.cropMargin), doc.width, doc.height);

  let selection: "active" | Pixels = "active";
  if (!selBounds && target) selection = paste(await host.groupMask(target), sendRect, target.rect);
  const cap = await host.capture(doc.id, sendRect, selection, target ?? undefined);
  if (isEmptySelection(cap.selection)) throw new Error("选区为空");
  check();

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
    image: await upload(imageFile(cap.image, img.encoding ?? "rgb", cap.selection), "image"),
    mask: undefined as string | undefined,
    references: {} as Record<number, string>,
  };
  const maskB = profile.bindings.find(b => b.role === "mask");
  if (maskB) values.mask = await upload(maskFile(cap.selection, maskB.encoding === "mask-alpha" ? "mask-alpha" : "mask-gray"), "mask");
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
  const refBindings = profile.bindings.filter(x => x.role === "reference");
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
    const run = prepareRun(profile, { ...values, prompt: input.prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, variant: k });
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
    const png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
    hooks.debug?.(`${stamp}_output${k ? "_" + k : ""}.png`, png);
    const outSize = pngSize(png);
    log("info", "run timing", `upload ${(tUpload / 1000).toFixed(1)}s`, `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`,
      "sent", `${rectW(sendRect)}x${rectH(sendRect)}`, "output", outSize ? `${outSize.width}x${outSize.height}` : "?");
    // A workflow that returns only its crop (not the full sent image) can't be placed by stretching.
    if (outSize) {
      const a = outSize.width / outSize.height, b = rectW(sendRect) / rectH(sendRect);
      if (Math.abs(a - b) / b > 0.01) {
        throw new StashedResult(`工作流输出 ${outSize.width}×${outSize.height} 与发送的画面 ${rectW(sendRect)}×${rectH(sendRect)} 比例不同，为避免错位未写入`, png);
      }
    }
    check();

    // ── 4. write back to the snapshot's document ──
    hooks.stage("写入 Photoshop" + tag);
    if (!host.docExists(doc.id)) throw new StashedResult("发起任务的 PSD 已关闭，结果未写入", png);
    try {
      group = group
        ? await host.refreshFillGroup(group)
        : await host.createFillGroup(doc.id, groupRect, input.prompt);
    } catch (e) {
      throw new StashedResult((e as Error).message + "，结果未写入", png);
    }
    const v = await host.addVariation(group, png, sendRect, input.prompt, { pixels: crop(cap.selection, sendRect, groupRect), rect: groupRect, outside: "hide" });
    variations.push(v); seeds.push(run.seed);
    hooks.variationAdded?.(group, v, run.seed);
    check();
  }
  return { group: group!, variations, seeds, continued: !!target };
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
  const bound = profile.bindings.filter(x => x.role === "reference").map(b => b.slot!);
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
  // original image area: the whole canvas for a new expand, the inner area for an existing one
  const orig: Rect = target
    ? { left: pads.left, top: pads.top, right: doc.width - pads.right, bottom: doc.height - pads.bottom }
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
    const run = prepareRun(profile, { image, references, prompt: input.prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, variant: k, pads });
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
    try {
      if (!group) {
        await host.expandCanvas(doc.id, pads);
        group = await host.createFillGroup(doc.id, { left: 0, top: 0, right: outW, bottom: outH }, input.prompt, pads);
      } else group = await host.refreshFillGroup(group);
    } catch (e) {
      throw new StashedResult((e as Error).message + "，结果未写入", png);
    }
    const inner: Rect = { left: pads.left, top: pads.top, right: pads.left + w, bottom: pads.top + h };
    const feather = Math.max(4, Math.min(32, Math.round(Math.min(w, h) * 0.01)));
    const v = await host.addVariation(group, png, { left: 0, top: 0, right: outW, bottom: outH }, input.prompt,
      { pixels: outpaintSeam(w, h, pads, feather), rect: inner, outside: "reveal" });
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
  const target = input.addTo ? await host.refreshFillGroup(input.addTo) : null;
  if (target && target.kind !== "txt2img") throw new Error("当前选中的不是 AI 生成的图层组");
  if (target) doc = { ...doc!, id: target.docId };
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
    const run = prepareRun(profile, { references, prompt: input.prompt, negative: input.negative, seed: input.seed === null ? null : input.seed + k, params: input.params, variant: k, size });
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
