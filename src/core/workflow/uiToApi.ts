// Converts a ComfyUI UI-format workflow (what ComfyUI saves under user/default/workflows)
// into API format. Frontend-only nodes (Reroute, Set/Get, notes, primitives) are resolved,
// bypassed nodes are passed through, muted nodes are dropped.
//
// Widget order: the node's own widget list (written by every recent ComfyUI frontend, and the
// only source that knows custom widget types such as colour pickers) is used first; /object_info
// adds the hidden "control after generate" values; a small built-in table covers old core nodes.

import type { ApiGraph, InputValue, Link } from "./api.ts";

interface UiInput { name: string; type: string; link: number | null; widget?: { name: string } }
interface UiOutput { name: string; type: string; links?: number[] | null }
interface UiNode {
  id: number; type: string; mode?: number; title?: string;
  inputs?: UiInput[]; outputs?: UiOutput[]; widgets_values?: unknown[] | Record<string, unknown>;
}
interface UiWorkflow { nodes: UiNode[]; links: [number, number, number, number, number, string][]; definitions?: { subgraphs?: unknown[] } }

const FRONTEND_ONLY = new Set(["Reroute", "SetNode", "GetNode", "Note", "MarkdownNote", "PrimitiveNode"]);
const MODE_MUTED = 2, MODE_BYPASS = 4;

export interface ObjectInfo {
  [classType: string]: {
    input: { required?: Record<string, [unknown, Record<string, unknown>?]>; optional?: Record<string, [unknown, Record<string, unknown>?]> };
    output_node?: boolean;
  };
}

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

type Spec = [unknown, Record<string, unknown>?];
const CONTROL_VALUE = /^(fixed|increment|decrement|randomize)$/;

function specOf(info: ObjectInfo | undefined, type: string, name: string): Spec | undefined {
  const d = info?.[type]?.input;
  return (d?.required?.[name] ?? d?.optional?.[name]) as Spec | undefined;
}

/** Ordered widget names for a node, with "$control" / "upload" placeholders for value-only slots. */
function widgetOrder(node: UiNode, info?: ObjectInfo): string[] | null {
  const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const own = node.inputs?.filter(i => i.widget).map(i => i.widget!.name) ?? [];
  // Older saves list only widgets that were converted to inputs, so the node's own list is
  // trusted only when it accounts for every stored value.
  const ownComplete = own.length > 0 && own.length + own.filter(n => /seed/i.test(n)).length >= values.length;
  if (own.length && (ownComplete || (!info?.[node.type] && !KNOWN[node.type]))) {
    const names: string[] = [];
    for (const name of own) {
      names.push(name);
      const spec = specOf(info, node.type, name);
      const control = spec
        ? !!spec[1]?.control_after_generate
        : typeof values[names.length] === "string" && CONTROL_VALUE.test(values[names.length] as string) && /seed/i.test(name);
      if (control) names.push("$control");
    }
    return names;
  }
  const def = info?.[node.type];
  if (def) {
    const names: string[] = [];
    for (const group of [def.input.required ?? {}, def.input.optional ?? {}]) {
      for (const [name, spec] of Object.entries(group)) {
        const [type, opts = {}] = spec;
        // combos, primitives, and custom widget types (they declare a default; link types don't)
        const isWidget = Array.isArray(type) || (typeof type === "string" && (WIDGET_TYPES.has(type) || "default" in opts));
        if (!isWidget) continue;
        names.push(name);
        if (opts.control_after_generate) names.push("$control");
        if (opts.image_upload) names.push("upload");
      }
    }
    return names;
  }
  return KNOWN[node.type] ?? null;
}

const KNOWN: Record<string, string[]> = {
  LoadImage: ["image", "upload"],
  LoadImageMask: ["image", "channel", "upload"],
  SaveImage: ["filename_prefix"],
  PreviewImage: [],
  RandomNoise: ["noise_seed", "$control"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  KSampler: ["seed", "$control", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  CLIPTextEncode: ["text"],
  EmptyLatentImage: ["width", "height", "batch_size"],
};

export function uiToApi(ui: unknown, info?: ObjectInfo): { api: ApiGraph; warnings: string[] } {
  const wf = ui as UiWorkflow;
  if (!wf || !Array.isArray(wf.nodes) || !Array.isArray(wf.links)) throw new Error("不是 ComfyUI 界面格式的工作流");
  if (wf.definitions?.subgraphs?.length) throw new Error("工作流包含子图，当前版本请在 ComfyUI 中导出 API 格式后再导入");
  const warnings: string[] = [];
  const byId = new Map(wf.nodes.map(n => [n.id, n]));
  const linkById = new Map(wf.links.map(l => [l[0], l]));

  // Resolve a link id to the real producing node/slot, walking through frontend-only and bypassed nodes.
  function resolve(linkId: number, depth = 0): Link | null {
    if (depth > 64) throw new Error("连线解析出现循环");
    const l = linkById.get(linkId);
    if (!l) return null;
    const [, fromId, fromSlot, , , type] = l;
    const src = byId.get(fromId);
    if (!src) return null;
    if (src.mode === MODE_MUTED) return null;
    if (src.type === "Reroute") {
      const inLink = src.inputs?.[0]?.link;
      return inLink == null ? null : resolve(inLink, depth + 1);
    }
    if (src.type === "GetNode") {
      const key = Array.isArray(src.widgets_values) ? src.widgets_values[0] : undefined;
      const setter = wf.nodes.find(n => n.type === "SetNode" && Array.isArray(n.widgets_values) && n.widgets_values[0] === key);
      const inLink = setter?.inputs?.[0]?.link;
      return inLink == null ? null : resolve(inLink, depth + 1);
    }
    if (src.mode === MODE_BYPASS) {
      const outType = src.outputs?.[fromSlot]?.type ?? type;
      const pass = src.inputs?.find(i => i.link != null && (i.type === outType || i.type === "*"));
      return pass ? resolve(pass.link!, depth + 1) : null;
    }
    return [String(fromId), fromSlot];
  }

  const api: ApiGraph = {};
  for (const n of wf.nodes) {
    if (FRONTEND_ONLY.has(n.type) || n.mode === MODE_MUTED || n.mode === MODE_BYPASS) continue;
    const names = widgetOrder(n, info);
    const hasLinks = n.inputs?.some(i => i.link != null) || n.outputs?.some(o => o.links?.length);
    if (!names && !hasLinks) continue; // isolated decoration (comments etc.)
    const inputs: Record<string, InputValue> = {};
    const values = n.widgets_values;
    if (names && Array.isArray(values) && values.length > names.length) {
      warnings.push(`#${n.id} ${n.type}: 参数个数（${values.length}）多于已知参数名（${names.length}），转换结果可能错位`);
    }
    if (names && Array.isArray(values)) {
      names.forEach((name, i) => { if (name !== "$control" && i < values.length) inputs[name] = values[i] as InputValue; });
    } else if (values && !Array.isArray(values)) {
      Object.assign(inputs, values);
    } else if (Array.isArray(values) && values.length) {
      warnings.push(`#${n.id} ${n.type}: 无法确定参数名，请连接 ComfyUI 后重新转换`);
    }
    for (const i of n.inputs ?? []) {
      if (i.link == null) continue;
      const src = resolve(i.link);
      if (src) inputs[i.name] = src;
      else delete inputs[i.name];
    }
    api[String(n.id)] = { class_type: n.type, inputs, ...(n.title ? { _meta: { title: n.title } } : { _meta: { title: n.type } }) };
  }
  return { api, warnings };
}
