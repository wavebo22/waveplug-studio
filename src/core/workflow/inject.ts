// Builds the execution copy of a profile's workflow. The stored template is never mutated.

import { type ApiGraph, cloneGraph } from "./api.ts";
import { type Binding, type Profile, type Side, checkBinding, validateProfile } from "./profile.ts";
import { applyMaskLinks } from "./localMask.ts";
import { MAX_REFERENCES, applyReferences } from "./references.ts";

export interface RunValues {
  /** uploaded file name (as returned by /upload/image, including subfolder) */
  image?: string;
  mask?: string;
  prompt: string;
  negative?: string;
  /** reference slot → uploaded file name */
  references?: Record<number, string>;
  /** "nodeId.input" → value */
  params?: Record<string, number | boolean>;
  /** null = random per run */
  seed: number | null;
  /** index of the variation within one run (keeps per-variation reference encodings separate) */
  variant?: number;
  /** outpaint: pixels to add on each side */
  pads?: Record<Side, number>;
  /** text-to-image: output size in pixels (already rounded to the workflow's multiple) */
  size?: { width: number; height: number };
  /** upscale: factor */
  scale?: number;
}

export const MAX_SEED = 2 ** 50;

export function randomSeed(): number {
  return Math.floor(Math.random() * MAX_SEED);
}

export interface Prepared { api: ApiGraph; seed: number; outputs: Binding[] }

export function prepareRun(p: Profile, v: RunValues): Prepared {
  const problems = validateProfile(p);
  if (problems.length) throw new Error("工作流配置需要重新校准：" + problems.join("；"));
  if (!p.options.allowEmptyPrompt && !v.prompt.trim() && p.bindings.some(b => b.role === "prompt")) {
    throw new Error("请输入提示词");
  }
  const api = cloneGraph(p.api);
  const seed = v.seed ?? randomSeed();
  const set = (b: Binding, value: string | number | boolean) => {
    const s = checkBinding(api, b);
    if (!s.ok) throw new Error(s.message);
    const cur = api[b.nodeId].inputs[b.input];
    if (typeof value === "number" && typeof cur === "number" && b.min !== undefined && value < b.min) throw new Error(`${b.label ?? b.input} 小于下限 ${b.min}`);
    if (typeof value === "number" && b.max !== undefined && value > b.max) throw new Error(`${b.label ?? b.input} 大于上限 ${b.max}`);
    if (cur !== undefined && cur !== null && typeof cur !== typeof value) {
      throw new Error(`#${b.nodeId}.${b.input} 期望 ${typeof cur}，实际写入 ${typeof value}`);
    }
    api[b.nodeId].inputs[b.input] = value;
  };
  for (const b of p.bindings) {
    switch (b.role) {
      case "image": set(b, v.image!); break;
      case "mask":
        if (!v.mask) throw new Error("缺少选区遮罩");
        set(b, v.mask); break;
      case "prompt": set(b, v.prompt); break;
      case "negative": if (v.negative !== undefined) set(b, v.negative); break;
      case "seed": set(b, seed); break;
      case "reference": {
        const file = v.references?.[b.slot ?? 0] ?? b.emptyValue;
        if (!file) throw new Error(`参考图 ${b.slot} 未选择素材`);
        set(b, file); break;
      }
      case "param": {
        const key = b.nodeId + "." + b.input;
        if (v.params && key in v.params) set(b, v.params[key]);
        break;
      }
      case "pad": {
        if (!v.pads) throw new Error("缺少扩展尺寸");
        const max = p.options.outpaint?.maxPad ?? Infinity;
        const px = Math.round(v.pads[b.side!]);
        if (px > max) throw new Error(`单边扩展最多 ${max} 像素（当前 ${px}）`);
        set(b, Math.max(0, px));
        break;
      }
      case "size": {
        if (!v.size) throw new Error("缺少输出尺寸");
        const px = Math.round(b.axis === "w" ? v.size.width : v.size.height);
        const max = p.options.txt2img?.max ?? Infinity;
        if (px > max) throw new Error(`输出尺寸最多 ${max} 像素（当前 ${px}）`);
        set(b, Math.max(8, px));
        break;
      }
      case "scale":
        if (!v.scale) throw new Error("缺少放大倍数");
        set(b, Math.round(v.scale));
        break;
      case "output": break;
    }
  }
  // "只重绘选区内" is an inpaint feature: an outpaint / text-to-image encoder must keep its own mask
  if (p.taskType === "inpaint" && p.options.localMask?.enabled) applyMaskLinks(api, p.options.localMask.links);
  // outpaint canvas: pads are exact pixels; ignore any ratio / layout chosen in ComfyUI's editor
  const op = p.options.outpaint;
  if (op && api[op.nodeId]) {
    const inputs = api[op.nodeId].inputs;
    if (op.unit) inputs[op.unit.input] = op.unit.value;
    if (op.ratio) inputs[op.ratio.input] = op.ratio.value;
    if (op.layout) inputs[op.layout.input] = "";
  }
  // text-to-image: make the size node use the given width/height (e.g. 比例 → 自定义宽高)
  for (const f of p.options.txt2img?.forced ?? []) if (api[f.nodeId]) api[f.nodeId].inputs[f.input] = f.value;
  // workflows without their own reference loaders: add the given references to the copy
  if (!p.bindings.some(b => b.role === "reference") && p.options.refSlots && v.references) {
    const files = Array.from({ length: MAX_REFERENCES }, (_, i) => v.references![i + 1]).filter((f): f is string => !!f);
    if (files.length) applyReferences(api, p.options.refSlots, files, v.variant ?? 0);
  }
  return { api, seed, outputs: p.bindings.filter(b => b.role === "output") };
}
