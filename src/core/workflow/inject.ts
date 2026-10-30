// Builds the execution copy of a profile's workflow. The stored template is never mutated.

import { type ApiGraph, cloneGraph } from "./api.ts";
import { type Binding, type Profile, checkBinding, validateProfile } from "./profile.ts";
import { applyMaskLinks } from "./localMask.ts";

export interface RunValues {
  /** uploaded file name (as returned by /upload/image, including subfolder) */
  image: string;
  mask?: string;
  prompt: string;
  negative?: string;
  /** reference slot → uploaded file name */
  references?: Record<number, string>;
  /** "nodeId.input" → value */
  params?: Record<string, number | boolean>;
  /** null = random per run */
  seed: number | null;
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
      case "image": set(b, v.image); break;
      case "mask":
        if (!v.mask) throw new Error("缺少选区遮罩");
        set(b, v.mask); break;
      case "prompt": set(b, v.prompt); break;
      case "negative": if (v.negative !== undefined) set(b, v.negative); break;
      case "seed": set(b, seed); break;
      case "reference": {
        const file = v.references?.[b.slot ?? 0];
        if (!file) throw new Error(`参考图 ${b.slot} 未选择素材`);
        set(b, file); break;
      }
      case "param": {
        const key = b.nodeId + "." + b.input;
        if (v.params && key in v.params) set(b, v.params[key]);
        break;
      }
      case "output": break;
    }
  }
  if (p.options.localMask?.enabled) applyMaskLinks(api, p.options.localMask.links);
  return { api, seed, outputs: p.bindings.filter(b => b.role === "output") };
}
