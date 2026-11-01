// A profile = one imported API workflow + the user-confirmed bindings to the task contract.
// The original API JSON is stored untouched; every run injects values into a fresh copy.

import { type ApiGraph, isLink, title } from "./api.ts";

export type TaskType = "inpaint" | "outpaint" | "txt2img" | "upscale";
export type Role = "image" | "mask" | "prompt" | "negative" | "seed" | "reference" | "param" | "output" | "pad" | "size" | "scale";
export type Side = "left" | "right" | "top" | "bottom";
export const SIDES: Side[] = ["left", "right", "top", "bottom"];

/** Fixed inputs of an outpaint canvas node (孤海外补画板) that the plugin sets on every run. */
export interface OutpaintCanvas {
  nodeId: string;
  /** e.g. "单位" → "像素", so pads are exact pixels */
  unit?: { input: string; value: string };
  /** e.g. "gh_visual_ratio" → "自由比例", so the node does not re-fit the pads to a ratio */
  ratio?: { input: string; value: string };
  /** e.g. "gh_visual_layout" → "", so a stale layout from the ComfyUI editor is ignored */
  layout?: { input: string };
  /** largest value one pad input accepts (pixels) */
  maxPad: number;
}

/** Text-to-image: inputs the plugin fixes so its width/height are used as given (e.g. 比例 → 自定义宽高). */
export interface Txt2ImgSize {
  forced: { nodeId: string; input: string; value: string | number | boolean }[];
  /** sizes are rounded to this multiple (the latent grid) */
  multiple: number;
  /** largest width/height the size inputs accept */
  max: number;
}

/** Upscale workflows: the factors the scale input accepts. */
export interface UpscaleOptions {
  /** factors offered in the panel (1 = restore at the original size) */
  factors: number[];
}

export const ROLE_LABEL: Record<Role, string> = {
  image: "主画面（当前画面）",
  pad: "扩展尺寸",
  size: "输出尺寸",
  scale: "放大倍数",
  mask: "选区遮罩",
  prompt: "提示词",
  negative: "负面提示词",
  seed: "随机种子",
  reference: "参考图",
  param: "高级参数",
  output: "输出图片",
};

/**
 * How pixels are written for image-like roles:
 *  rgba-alpha-mask – canvas RGB + selection as alpha (transparent = repaint), for LoadImage whose MASK output is used
 *  rgb             – plain image
 *  mask-alpha      – mask stored in the alpha channel (LoadImageMask channel=alpha)
 *  mask-gray       – white = repaint (LoadImageMask channel=red/green/blue)
 */
export type Encoding = "rgba-alpha-mask" | "rgb" | "mask-alpha" | "mask-gray";

export interface Binding {
  role: Role;
  nodeId: string;
  input: string;
  classType: string;
  title?: string;
  encoding?: Encoding;
  /** reference slot number (1-based) */
  slot?: number;
  /** output image index within the node's result list */
  imageIndex?: number;
  /** which side a pad binding controls */
  side?: Side;
  /** which dimension a size binding controls */
  axis?: "w" | "h";
  /** reference loaders that can run without a picture (e.g. LoadImageGoohai's 「无」) */
  emptyValue?: string;
  /** display label for params */
  label?: string;
  min?: number;
  max?: number;
}

export interface Profile {
  schema: "waveplug.profile.v1";
  id: string;
  name: string;
  taskType: TaskType;
  createdAt: number;
  updatedAt: number;
  /** Where the workflow came from; ComfyUI-saved workflows are re-read before every run. */
  source?: { kind: "comfy"; path: string } | { kind: "file" };
  api: ApiGraph;
  bindings: Binding[];
  options: {
    /** empty prompt is a valid mode (e.g. "remove" branch) */
    allowEmptyPrompt: boolean;
    /** what part of the document is sent: whole canvas or selection bounds + margin */
    sendScope: "canvas" | "crop";
    /** margin around the selection when sendScope = crop, in multiples of the selection's shorter side */
    cropMargin: number;
    /** set once the crop default (introduced in 0.2.3) has been applied to an older profile */
    cropDefault?: boolean;
    /** outpaint workflows: the canvas node's fixed inputs */
    outpaint?: OutpaintCanvas;
    /** text-to-image workflows: how the output size is set */
    txt2img?: Txt2ImgSize;
    /** upscale workflows: the factors offered */
    upscale?: UpscaleOptions;
    /** free encoder image inputs for reference images (execution copy only), see references.ts */
    refSlots?: { nodes: { nodeId: string; inputs: string[] }[] };
    /** links that make the sampler respect the selection (execution copy only), see localMask.ts */
    localMask?: { enabled: boolean; links: { nodeId: string; input: string; from: [string, number] }[] };
  };
}

export function newProfile(name: string, api: ApiGraph, bindings: Binding[]): Profile {
  const now = Date.now();
  return {
    schema: "waveplug.profile.v1",
    id: "p" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name, taskType: "inpaint", createdAt: now, updatedAt: now, api, bindings,
    options: { allowEmptyPrompt: false, sendScope: "crop", cropMargin: 1, cropDefault: true },
  };
}

export type BindingStatus =
  | { ok: true }
  | { ok: false; kind: "missing-node" | "class-changed" | "missing-input" | "now-linked"; message: string };

export function checkBinding(g: ApiGraph, b: Binding): BindingStatus {
  const n = g[b.nodeId];
  if (!n) return { ok: false, kind: "missing-node", message: `节点 #${b.nodeId} 已不存在` };
  if (n.class_type !== b.classType) return { ok: false, kind: "class-changed", message: `#${b.nodeId} 的类型由 ${b.classType} 变为 ${n.class_type}` };
  if (b.role === "output") return isLink(n.inputs.images) ? { ok: true } : { ok: false, kind: "missing-input", message: `输出节点 #${b.nodeId} 没有连接图片` };
  if (!(b.input in n.inputs)) return { ok: false, kind: "missing-input", message: `#${b.nodeId} 没有字段 ${b.input}` };
  if (isLink(n.inputs[b.input])) return { ok: false, kind: "now-linked", message: `#${b.nodeId}.${b.input} 已改为由其他节点连线输入，无法直接写入` };
  return { ok: true };
}

export function validateProfile(p: Profile): string[] {
  const problems: string[] = [];
  for (const b of p.bindings) { const s = checkBinding(p.api, b); if (!s.ok) problems.push(s.message); }
  const has = (r: Role) => p.bindings.some(b => b.role === r);
  if (p.taskType === "txt2img") {
    if (!has("output")) problems.push("未绑定输出图片");
    for (const axis of ["w", "h"] as const) if (!p.bindings.some(b => b.role === "size" && b.axis === axis)) problems.push(`未绑定输出${axis === "w" ? "宽度" : "高度"}`);
    return problems;
  }
  if (!has("image")) problems.push("未绑定主画面");
  if (!has("output")) problems.push("未绑定输出图片");
  if (p.taskType === "upscale") {
    if (!has("scale")) problems.push("未绑定放大倍数");
    return problems;
  }
  if (p.taskType === "outpaint") {
    for (const side of SIDES) if (!p.bindings.some(b => b.role === "pad" && b.side === side)) problems.push(`未绑定扩展尺寸（${side}）`);
    return problems;
  }
  const img = p.bindings.find(b => b.role === "image");
  if (img && img.encoding !== "rgba-alpha-mask" && !has("mask")) problems.push("未绑定选区遮罩");
  return problems;
}

/** Fingerprint of only the parts the bindings depend on, so unrelated edits don't invalidate a profile. */
export function bindingFingerprint(g: ApiGraph, bindings: Binding[]): string {
  const parts = bindings.map(b => {
    const n = g[b.nodeId];
    return `${b.role}:${b.nodeId}:${n?.class_type ?? "-"}:${b.input}:${n ? (isLink(n.inputs[b.input]) ? "L" : typeof n.inputs[b.input]) : "-"}`;
  }).sort();
  return fnv1a(parts.join("|"));
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export interface CarryOver {
  profile: Profile;
  kept: Binding[];
  remapped: { from: Binding; to: Binding }[];
  broken: { binding: Binding; reason: string }[];
}

/**
 * Re-import of an edited workflow: keep bindings that still match; if a node id changed but a
 * node with the same class and title exists exactly once, remap to it; everything else is broken
 * and must be recalibrated (never sent).
 */
export function carryOver(old: Profile, api: ApiGraph): CarryOver {
  const kept: Binding[] = [], remapped: CarryOver["remapped"] = [], broken: CarryOver["broken"] = [];
  for (const b of old.bindings) {
    const s = checkBinding(api, b);
    if (s.ok) { kept.push(b); continue; }
    if (s.kind === "missing-node" || s.kind === "class-changed") {
      const same = Object.keys(api).filter(id => api[id].class_type === b.classType && title(api, id) === b.title);
      if (same.length === 1) {
        const to = { ...b, nodeId: same[0] };
        if (checkBinding(api, to).ok) { remapped.push({ from: b, to }); continue; }
      }
    }
    broken.push({ binding: b, reason: s.message });
  }
  const profile: Profile = { ...old, api, bindings: [...kept, ...remapped.map(r => r.to)], updatedAt: Date.now() };
  return { profile, kept, remapped, broken };
}
