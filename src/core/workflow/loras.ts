// Extra LoRAs chosen in the panel (高级参数 › LoRA). They are added to the execution copy only:
// a LoRA loader chain is inserted right after each base-model loader, and everything that used
// the loader's MODEL (and, for checkpoints, CLIP) is rewired to the end of the chain. LoRAs the
// workflow already has stay where they are and stack on top.

import { type ApiGraph, isLink } from "./api.ts";
import type { ObjectInfo } from "./uiToApi.ts";

export interface LoraSlot {
  /** file name as ComfyUI lists it (may include a subfolder), "" = none chosen */
  name: string;
  strength: number;
  on: boolean;
}

export const MAX_LORAS = 4;
export const LORA_MIN = -2;
export const LORA_MAX = 2;

/** Loaders whose output 0 is a diffusion MODEL (diffusion-model, GGUF and checkpoint loaders). */
const MODEL_LOADER = /^(UNETLoader|UnetLoaderGGUF.*|UNETLoaderGGUF.*|DiffusionModelLoader.*|CheckpointLoaderSimple|CheckpointLoader|CheckpointLoaderNF4|ImageOnlyCheckpointLoader|unCLIPCheckpointLoader)$/;
const CHECKPOINT = /Checkpoint/;

export interface LoraTarget {
  nodeId: string;
  /** checkpoints also output CLIP (slot 1); their LoRAs patch it too */
  clip: boolean;
}

/** Base-model loaders whose MODEL output is used somewhere in the graph. */
export function loraTargets(g: ApiGraph): LoraTarget[] {
  const used = (id: string, slot: number) => Object.values(g).some(n => Object.values(n.inputs).some(v => isLink(v) && v[0] === id && v[1] === slot));
  return Object.keys(g)
    .filter(id => MODEL_LOADER.test(g[id].class_type) && used(id, 0))
    .map(id => ({ nodeId: id, clip: CHECKPOINT.test(g[id].class_type) && !/ImageOnly/.test(g[id].class_type) && used(id, 1) }));
}

/** Slots that actually take part in a run. */
export function activeLoras(slots: LoraSlot[] | undefined): LoraSlot[] {
  return (slots ?? []).filter(s => s.on && s.name && Number.isFinite(s.strength) && s.strength !== 0).slice(0, MAX_LORAS);
}

/** LoRA file names from ComfyUI's /object_info for LoraLoaderModelOnly (or LoraLoader). */
export function loraNamesFrom(info: ObjectInfo | null | undefined): string[] {
  for (const cls of ["LoraLoaderModelOnly", "LoraLoader"]) {
    const spec = info?.[cls]?.input?.required?.lora_name?.[0];
    if (Array.isArray(spec)) return spec.filter((x): x is string => typeof x === "string");
    // newer ComfyUI: ["COMBO", { options: [...] }]
    const opts = (info?.[cls]?.input?.required?.lora_name?.[1] as { options?: unknown } | undefined)?.options;
    if (spec === "COMBO" && Array.isArray(opts)) return opts.filter((x): x is string => typeof x === "string");
  }
  return [];
}

/** Display name: file name without folders and extension. */
export function loraLabel(name: string): string {
  return name.split(/[\\/]/).pop()!.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "");
}

/**
 * Inserts the active LoRAs into `api` (mutated: it must be the execution copy). Returns the ids of
 * the added nodes. Throws when LoRAs are on but the workflow has no base-model loader to attach to.
 */
export function applyLoras(api: ApiGraph, slots: LoraSlot[] | undefined): string[] {
  const active = activeLoras(slots);
  if (!active.length) return [];
  for (const s of active) if (s.strength < LORA_MIN || s.strength > LORA_MAX) throw new Error(`LoRA ${loraLabel(s.name)} 的强度要在 ${LORA_MIN} 到 ${LORA_MAX} 之间`);
  const targets = loraTargets(api);
  if (!targets.length) throw new Error("这个工作流里找不到模型加载节点（UNETLoader / Checkpoint），没法挂 LoRA。请在「高级参数」里关掉 LoRA");
  let next = Math.max(0, ...Object.keys(api).map(Number).filter(Number.isFinite)) + 1;
  const added: string[] = [];
  for (const t of targets) {
    const consumers = Object.entries(api).flatMap(([id, n]) => Object.entries(n.inputs)
      .filter(([, v]) => isLink(v) && v[0] === t.nodeId && (v[1] === 0 || (t.clip && v[1] === 1)))
      .map(([input, v]) => ({ id, input, slot: (v as [string, number])[1] })));
    let model: [string, number] = [t.nodeId, 0], clip: [string, number] = [t.nodeId, 1];
    for (const s of active) {
      const id = String(next++);
      api[id] = t.clip
        ? { class_type: "LoraLoader", inputs: { model, clip, lora_name: s.name, strength_model: s.strength, strength_clip: s.strength }, _meta: { title: "WavePlug LoRA · " + loraLabel(s.name) } }
        : { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: s.name, strength_model: s.strength }, _meta: { title: "WavePlug LoRA · " + loraLabel(s.name) } };
      model = [id, 0];
      if (t.clip) clip = [id, 1];
      added.push(id);
    }
    for (const c of consumers) api[c.id].inputs[c.input] = c.slot === 0 ? model : clip;
  }
  return added;
}
