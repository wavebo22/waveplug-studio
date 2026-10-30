// One inpaint run: snapshot Photoshop → upload → queue → wait → write back into the task group.
// Every write-back target is the one captured at the start, never "whatever is active now".

import { encodePng, type Pixels } from "../core/image/png.ts";
import { imageFile, isEmptySelection, maskFile } from "../core/image/compose.ts";
import { type Rect, clampRect, expand, placementInGroup, rectH, rectW } from "../core/image/region.ts";
import { type Comfy, type JobEvent, outputImage, pngSize } from "../core/comfy/client.ts";
import { log } from "./log.ts";
import { prepareRun } from "../core/workflow/inject.ts";
import type { Profile } from "../core/workflow/profile.ts";
import type { PsHost, TaskGroup, Version } from "../ps/host.ts";

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
}

export interface RunHooks {
  stage(text: string): void;
  progress(fraction: number | null, text?: string): void;
  promptQueued?(promptId: string): void;
  /** Saves a copy of an exchanged image for diagnosis (optional). */
  debug?(name: string, png: Uint8Array): void;
  signal: { aborted: boolean };
}

export interface RunResult { group: TaskGroup; version: Version; seed: number; continued: boolean }

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

const newTaskId = () => (Date.now().toString(36).slice(-3) + Math.random().toString(36).slice(2, 4)).toUpperCase();

export async function runInpaint(host: PsHost, comfy: Comfy, input: RunInput, hooks: RunHooks): Promise<RunResult> {
  const { profile } = input;
  const check = () => { if (hooks.signal.aborted) throw new Error("已取消"); };

  // ── 1. snapshot ──
  hooks.stage("读取 Photoshop 画面…");
  const doc = host.activeDoc();
  if (!doc) throw new Error("请先打开一个 PSD");
  if (!/RGB|CMYK/i.test(doc.mode) || doc.bits !== 8) throw new Error(`目前支持 RGB / CMYK 8 位文档（当前：${doc.mode} ${doc.bits} 位）`);
  const target = await host.activeTaskGroup();
  const selBounds = await host.selectionBounds(doc.id);
  if (!target && !selBounds) throw new Error("请先用选区框出要重绘的区域（或选中已有的 AI 结果智能对象以续写）");

  const groupRect = target ? target.rect : clampRect(selBounds!, doc.width, doc.height);
  const canvas: Rect = { left: 0, top: 0, right: doc.width, bottom: doc.height };
  // area of interest always contains the group rect, so the result can be placed into the PSB
  let focus = groupRect;
  if (target && selBounds) {
    const s = clampRect(selBounds, doc.width, doc.height);
    focus = { left: Math.min(s.left, focus.left), top: Math.min(s.top, focus.top), right: Math.max(s.right, focus.right), bottom: Math.max(s.bottom, focus.bottom) };
  }
  const sendRect = profile.options.sendScope === "canvas" ? canvas : expand(focus, profile.options.cropMargin, doc.width, doc.height);

  let selection: "active" | Pixels = "active";
  if (!selBounds && target) selection = paste(await host.groupMask(target), sendRect, target.rect);
  const cap = await host.capture(doc.id, sendRect, selection);
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
  for (const b of profile.bindings.filter(x => x.role === "reference")) {
    const src = input.references[b.slot ?? 0];
    if (!src) throw new Error(`参考图 ${b.slot} 还没有选择素材`);
    values.references[b.slot!] = src.kind === "file"
      ? await comfy.uploadImage(src.bytes, `wp_${stamp}_ref${b.slot}_${src.name.replace(/[^\w.-]/g, "_")}`)
      : await upload(imageFile(await host.layerPixels(src.docId, src.layerId), "rgb"), "ref" + b.slot);
  }
  check();

  // ── 3. run ──
  const run = prepareRun(profile, { ...values, prompt: input.prompt, negative: input.negative, seed: input.seed, params: input.params });
  const job = await comfy.queue(run.api);
  hooks.promptQueued?.(job.promptId);
  hooks.stage("排队中…");
  const tQueued = Date.now();
  const history = await comfy.waitFor(job.promptId, (e: JobEvent) => {
    if (e.type === "cached") log("info", "comfy cached nodes", e.nodes.join(","));
    if (e.type === "running") { hooks.stage(e.node ? `执行中 · 节点 #${e.node} ${run.api[e.node]?._meta?.title ?? run.api[e.node]?.class_type ?? ""}` : "执行中…"); log("info", "comfy executing", e.node, run.api[e.node ?? ""]?.class_type ?? "", `+${((Date.now() - tQueued) / 1000).toFixed(1)}s`); }
    if (e.type === "progress") hooks.progress(e.max ? e.value / e.max : null, `采样 ${e.value}/${e.max}`);
  }, { signal: hooks.signal });
  const out = run.outputs[0];
  hooks.stage("取回结果…");
  const png = await comfy.view(outputImage(history, out.nodeId, out.imageIndex ?? 0));
  hooks.debug?.(`${stamp}_output.png`, png);
  const outSize = pngSize(png);
  log("info", "run timing", `upload ${((tQueued - t0) / 1000).toFixed(1)}s`, `comfy ${((Date.now() - tQueued) / 1000).toFixed(1)}s`,
    "sent", `${rectW(sendRect)}x${rectH(sendRect)}`, "output", outSize ? `${outSize.width}x${outSize.height}` : "?");
  // A workflow that returns only its crop (not the full sent image) can't be placed by stretching.
  if (outSize) {
    const a = outSize.width / outSize.height, b = rectW(sendRect) / rectH(sendRect);
    if (Math.abs(a - b) / b > 0.01) {
      throw new StashedResult(`工作流输出 ${outSize.width}×${outSize.height} 与发送的画面 ${rectW(sendRect)}×${rectH(sendRect)} 比例不同，为避免错位未写入`, png);
    }
  }
  check();

  // ── 4. write back to the snapshot's document / group ──
  hooks.stage("写入智能对象…");
  if (!host.docExists(doc.id)) throw new StashedResult("发起任务的 PSD 已关闭，结果未写入", png);
  let group: TaskGroup;
  try {
    group = target
      ? await host.refreshTaskGroup(target)
      : await host.createTaskGroup(doc.id, groupRect, crop(cap.image, sendRect, groupRect), crop(cap.selection, sendRect, groupRect), newTaskId());
  } catch (e) {
    throw new StashedResult((e as Error).message + "，结果未写入", png);
  }
  const comment = [`seed ${run.seed}`, input.prompt.trim().slice(0, 60) || "（无提示词）", profile.name].join(" · ");
  const version = await host.appendVersion(group, png, placementInGroup(sendRect, groupRect), comment);
  return { group, version, seed: run.seed, continued: !!target };
}
