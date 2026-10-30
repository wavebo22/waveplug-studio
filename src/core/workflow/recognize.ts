// Suggests bindings for the inpaint contract by reading the graph structure.
// Nothing here is applied automatically: the calibration dialog shows each suggestion with its
// confidence, "certain" ones are pre-filled, everything else waits for the user.

import { type ApiGraph, consumers, downstream, isLink, literalSource, title } from "./api.ts";
import type { Binding, Role } from "./profile.ts";

export type Confidence = "certain" | "likely" | "ambiguous";

export interface Suggestion {
  binding: Binding;
  confidence: Confidence;
  reason: string;
  /** Other plausible targets for the same role (shown as a dropdown). */
  alternatives?: Binding[];
}

export interface Recognition {
  suggestions: Suggestion[];
  /** Why the workflow can't serve the inpaint contract, if it can't. */
  blockers: string[];
  notes: string[];
}

const LOAD_IMAGE = /^LoadImage$|^LoadImageFromPath|^Load ?Image(?!.*Mask)/;
const LOAD_MASK = /^LoadImageMask$/;
const OUTPUT = /^(SaveImage|PreviewImage)$/;
const ENCODER = /TextEncode|CLIPText|Conditioning|Prompt/i;
const PROMPT_TITLE = /提示词|prompt|正向|positive|描述/i;
const NEGATIVE_TITLE = /负面|反向|negative/i;
const EXPOSED_TITLE = /^\s*#\s*\d+/;
const LORA = /lora/i;

function numberedTitle(t: string): number | null {
  const m = /^\s*#\s*(\d+)/.exec(t);
  return m ? Number(m[1]) : null;
}

function bindingFor(g: ApiGraph, role: Role, nodeId: string, input: string, extra: Partial<Binding> = {}): Binding {
  return { role, nodeId, input, classType: g[nodeId].class_type, title: title(g, nodeId), ...extra };
}

export function recognize(g: ApiGraph): Recognition {
  const suggestions: Suggestion[] = [], blockers: string[] = [], notes: string[] = [];
  const ids = Object.keys(g);
  const taken = new Set<string>();
  const take = (b: Binding) => taken.add(b.nodeId + "." + b.input);

  // ── output ──
  const outs = ids.filter(id => OUTPUT.test(g[id].class_type) && isLink(g[id].inputs.images));
  const saves = outs.filter(id => g[id].class_type === "SaveImage");
  const pool = saves.length ? saves : outs;
  if (!pool.length) blockers.push("没有找到 SaveImage / PreviewImage 输出节点");
  else {
    const [first, ...rest] = pool;
    suggestions.push({
      binding: bindingFor(g, "output", first, "images", { imageIndex: 0 }),
      confidence: pool.length === 1 ? "certain" : "ambiguous",
      reason: pool.length === 1 ? "唯一的图片输出节点" : `有 ${pool.length} 个输出节点，请确认取哪一个`,
      alternatives: rest.map(id => bindingFor(g, "output", id, "images", { imageIndex: 0 })),
    });
  }

  // ── image + mask ──
  const loaders = ids.filter(id => LOAD_IMAGE.test(g[id].class_type) && typeof g[id].inputs.image === "string");
  const maskLoaders = ids.filter(id => LOAD_MASK.test(g[id].class_type));
  const alphaMasked = loaders.filter(id => consumers(g, id, 1).length > 0);
  let mainImage: string | null = null;

  const rankImage = (id: string) => {
    const t = title(g, id);
    return (numberedTitle(t) ?? 99) * -1 + (/加载图像|主图|原图|input|source/i.test(t) ? 50 : 0) + (consumers(g, id, 1).length ? 30 : 0);
  };

  if (alphaMasked.length) {
    const sorted = [...alphaMasked].sort((a, b) => rankImage(b) - rankImage(a));
    mainImage = sorted[0];
    const b = bindingFor(g, "image", mainImage, "image", { encoding: "rgba-alpha-mask" });
    suggestions.push({
      binding: b,
      confidence: alphaMasked.length === 1 ? "certain" : "ambiguous",
      reason: alphaMasked.length === 1
        ? "该加载图像节点的 MASK 输出被使用：画面与选区将合成为一张带透明通道的 PNG（透明处=重绘区）"
        : "多个加载图像节点都使用了 MASK 输出，请确认哪个是主画面",
      alternatives: sorted.slice(1).map(id => bindingFor(g, "image", id, "image", { encoding: "rgba-alpha-mask" })),
    });
  } else if (maskLoaders.length && loaders.length) {
    const sorted = [...loaders].sort((a, b) => rankImage(b) - rankImage(a));
    mainImage = sorted[0];
    suggestions.push({
      binding: bindingFor(g, "image", mainImage, "image", { encoding: "rgb" }),
      confidence: loaders.length === 1 ? "certain" : "ambiguous",
      reason: loaders.length === 1 ? "唯一的加载图像节点" : "多个加载图像节点，请确认哪个是主画面",
      alternatives: sorted.slice(1).map(id => bindingFor(g, "image", id, "image", { encoding: "rgb" })),
    });
    const m = maskLoaders[0];
    const channel = String(g[m].inputs.channel ?? "alpha");
    suggestions.push({
      binding: bindingFor(g, "mask", m, "image", { encoding: channel === "alpha" ? "mask-alpha" : "mask-gray" }),
      confidence: maskLoaders.length === 1 ? "certain" : "ambiguous",
      reason: `独立的加载遮罩节点（通道：${channel}）`,
      alternatives: maskLoaders.slice(1).map(id => bindingFor(g, "mask", id, "image", { encoding: "mask-gray" })),
    });
  } else {
    blockers.push(loaders.length
      ? "工作流有加载图像节点，但没有任何遮罩入口（未使用 MASK 输出，也没有加载遮罩节点），不能用于局部重绘"
      : "工作流没有加载图像节点，不能用于局部重绘");
  }
  for (const s of suggestions) take(s.binding);

  // ── reference images: remaining loaders ──
  const refs = loaders.filter(id => id !== mainImage)
    .sort((a, b) => (numberedTitle(title(g, a)) ?? 1e6 + Number(a)) - (numberedTitle(title(g, b)) ?? 1e6 + Number(b)));
  refs.forEach((id, i) => {
    const b = bindingFor(g, "reference", id, "image", { slot: i + 1, encoding: "rgb" });
    suggestions.push({ binding: b, confidence: "likely", reason: `其余的加载图像节点，按顺序作为参考图 ${i + 1}` });
    take(b);
  });

  // ── prompt / negative prompt ──
  interface Cand { nodeId: string; input: string; score: number; negative: boolean; why: string[] }
  const cands: Cand[] = [];
  for (const id of ids) {
    const n = g[id];
    for (const [input, v] of Object.entries(n.inputs)) {
      if (typeof v !== "string" || taken.has(id + "." + input)) continue;
      if (/\.(safetensors|ckpt|pt|pth|gguf|bin|png|jpe?g|webp)$/i.test(v)) continue;
      if (/^(filename_prefix|image|channel|upload|sampler_name|scheduler|ckpt_name|unet_name|vae_name|clip_name|lora_name|type|device|weight_dtype)$/.test(input)) continue;
      const t = title(g, id), why: string[] = [];
      let score = 0;
      const isEncoder = ENCODER.test(n.class_type);
      const reachesEncoder = [...downstream(g, id)].some(d => ENCODER.test(g[d].class_type));
      if (!isEncoder && !reachesEncoder) continue;
      if (PROMPT_TITLE.test(t)) { score += 50; why.push("标题含「提示词」"); }
      if (EXPOSED_TITLE.test(t)) { score += 20; why.push("作者标注的公开参数"); }
      if (!isEncoder && reachesEncoder) { score += 25; why.push("文本来源节点，连到编码器"); }
      if (/^(text|prompt|value|string|Text)$/i.test(input)) score += 10;
      if (isEncoder && consumers(g, id).length === 0) score -= 20;
      const negative = NEGATIVE_TITLE.test(t) || /negative/i.test(input);
      cands.push({ nodeId: id, input, score, negative, why });
    }
  }
  const pick = (neg: boolean) => cands.filter(c => c.negative === neg).sort((a, b) => b.score - a.score);
  const pos = pick(false), neg = pick(true);
  if (pos.length) {
    const [top, second] = pos;
    suggestions.push({
      binding: bindingFor(g, "prompt", top.nodeId, top.input),
      confidence: !second || top.score - second.score >= 30 ? "certain" : top.score - second.score >= 10 ? "likely" : "ambiguous",
      reason: top.why.join("；") || "可写入的文本字段",
      alternatives: pos.slice(1).filter(c => c.score >= 10).slice(0, 5).map(c => bindingFor(g, "prompt", c.nodeId, c.input)),
    });
    take(suggestions[suggestions.length - 1].binding);
  } else notes.push("没有找到可写入的提示词字段；如果该工作流不需要提示词可以忽略");
  if (neg.length) {
    suggestions.push({ binding: bindingFor(g, "negative", neg[0].nodeId, neg[0].input), confidence: "likely", reason: "标题或字段名为负面提示词" });
    take(suggestions[suggestions.length - 1].binding);
  }

  // ── seeds ──
  for (const id of ids) for (const [input, v] of Object.entries(g[id].inputs)) {
    if (typeof v === "number" && /^(seed|noise_seed)$/.test(input)) {
      const b = bindingFor(g, "seed", id, input);
      suggestions.push({ binding: b, confidence: "certain", reason: "随机种子字段，由插件生成" });
      take(b);
    }
  }

  // ── exposed parameters: "# n." titled primitives, then LoRA strengths ──
  for (const id of ids) {
    const t = title(g, id);
    if (!EXPOSED_TITLE.test(t)) continue;
    for (const [input, v] of Object.entries(g[id].inputs)) {
      if (taken.has(id + "." + input)) continue;
      if (typeof v === "number" || typeof v === "boolean") {
        const b = bindingFor(g, "param", id, input, { label: t.replace(EXPOSED_TITLE, "").replace(/^[.．、\s]+/, "") || input });
        suggestions.push({ binding: b, confidence: "certain", reason: "作者用「# 编号」标出的公开参数" });
        take(b);
      }
    }
  }
  for (const id of ids) {
    if (!LORA.test(g[id].class_type)) continue;
    const loraName = String(g[id].inputs.lora_name ?? "").split(/[\\/]/).pop()?.replace(/\.[a-z]+$/i, "") ?? "";
    for (const input of ["strength_model", "strength_clip", "strength"]) {
      if (!(input in g[id].inputs)) continue;
      const src = literalSource(g, id, input, "number");
      if (!src) { notes.push(`LoRA #${id}.${input} 的数值来源无法追溯，未列入`); continue; }
      if (taken.has(src.nodeId + "." + src.input)) continue;
      const via = src.nodeId !== id ? `（经 #${src.nodeId} ${title(g, src.nodeId)} 连入）` : "";
      const b = bindingFor(g, "param", src.nodeId, src.input, { label: `LoRA ${loraName} · ${input}`, min: 0, max: 2 });
      suggestions.push({ binding: b, confidence: "likely", reason: "已有 LoRA 的强度" + via });
      take(b);
    }
  }

  return { suggestions, blockers, notes };
}
