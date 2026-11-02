// Suggests bindings for the inpaint contract by reading the graph structure.
// Nothing here is applied automatically: the calibration dialog shows each suggestion with its
// confidence, "certain" ones are pre-filled, everything else waits for the user.

import { type ApiGraph, consumers, downstream, isLink, literalSource, title } from "./api.ts";
import type { Binding, OutpaintCanvas, Role, Side, TaskType, Txt2ImgSize, UpscaleOptions } from "./profile.ts";

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
  taskType: TaskType;
  outpaint?: OutpaintCanvas;
  txt2img?: Txt2ImgSize;
  upscale?: UpscaleOptions;
}

const PAD_INPUTS: Record<Side, RegExp> = { left: /^(左|left)$/i, right: /^(右|right)$/i, top: /^(上|top)$/i, bottom: /^(下|bottom)$/i };

/** A node taking an image plus left/right/top/bottom amounts = an outpaint canvas (孤海外补画板 etc.). */
function findOutpaintCanvas(g: ApiGraph): { id: string; pads: Record<Side, string>; image: string } | null {
  for (const [id, n] of Object.entries(g)) {
    const keys = Object.keys(n.inputs);
    const pads = {} as Record<Side, string>;
    for (const side of Object.keys(PAD_INPUTS) as Side[]) {
      const k = keys.find(x => PAD_INPUTS[side].test(x));
      if (!k) break;
      pads[side] = k;
    }
    if (Object.keys(pads).length !== 4) continue;
    const imageInput = keys.find(k => isLink(n.inputs[k]) && LOAD_IMAGE.test(g[(n.inputs[k] as [string, number])[0]]?.class_type ?? ""));
    if (imageInput) return { id, pads, image: (n.inputs[imageInput] as [string, number])[0] };
  }
  return null;
}

/**
 * Where a generated image's size is set: a resolution node with custom width/height (孤海比例与分辨率:
 * 自定宽度/自定高度, its 比例 fixed to 自定义宽高) or an empty-latent node's width/height.
 */
function findSizeSource(g: ApiGraph): { w: { nodeId: string; input: string }; h: { nodeId: string; input: string }; size: Txt2ImgSize } | null {
  for (const [id, n] of Object.entries(g)) {
    const keys = Object.keys(n.inputs);
    const cw = keys.find(k => /^(自定宽度|custom_width)$/i.test(k)), ch = keys.find(k => /^(自定高度|custom_height)$/i.test(k));
    if (!cw || !ch) continue;
    const w = literalSource(g, id, cw, "number"), h = literalSource(g, id, ch, "number");
    if (!w || !h) continue;
    const forced: Txt2ImgSize["forced"] = [];
    const ratio = keys.find(k => /^(比例|ratio)$/i.test(k));
    if (ratio && typeof n.inputs[ratio] === "string") forced.push({ nodeId: id, input: ratio, value: /^[a-z]/i.test(String(n.inputs[ratio])) ? "custom" : "自定义宽高" });
    const mult = keys.find(k => /^(倍数取整|multiple|divisible_by)$/i.test(k));
    const m = mult && typeof n.inputs[mult] === "number" ? Number(n.inputs[mult]) : 16;
    return { w, h, size: { forced, multiple: m > 0 ? m : 1, max: 10240 } };
  }
  for (const [id, n] of Object.entries(g)) {
    if (!/^Empty.*Latent/i.test(n.class_type) || !("width" in n.inputs) || !("height" in n.inputs)) continue;
    const w = literalSource(g, id, "width", "number"), h = literalSource(g, id, "height", "number");
    if (w && h) return { w, h, size: { forced: [], multiple: 16, max: 16384 } };
  }
  return null;
}

/** A node taking a loaded image plus a scale factor (VOSR2 放大, ImageScaleBy …) = an upscaler. */
function findUpscaler(g: ApiGraph): { image: string; scale: { nodeId: string; input: string } } | null {
  for (const [id, n] of Object.entries(g)) {
    const keys = Object.keys(n.inputs);
    const sk = keys.find(k => /^(scale|scale_by|upscale_by|放大倍数|倍数)$/i.test(k));
    if (!sk) continue;
    const imageInput = keys.find(k => isLink(n.inputs[k]) && LOAD_IMAGE.test(g[(n.inputs[k] as [string, number])[0]]?.class_type ?? ""));
    const scale = literalSource(g, id, sk, "number");
    if (imageInput && scale) return { image: (n.inputs[imageInput] as [string, number])[0], scale };
  }
  return null;
}

const LOAD_IMAGE = /^LoadImage$|^LoadImageFromPath|^Load ?Image(?!.*Mask)/;
const LOAD_MASK = /^LoadImageMask$/;
const OUTPUT = /^(SaveImage|PreviewImage)$/;
const ENCODER = /TextEncode|CLIPText|Conditioning|Prompt/i;
const PROMPT_TITLE = /提示词|prompt|正向|positive|描述/i;
const NEGATIVE_TITLE = /负面|反向|negative/i;
const EXPOSED_TITLE = /^\s*#\s*\d+/;
const LORA = /lora/i;
const EXTRACT_LORA = /fg[-_ ]?extract|chaitu|拆图/i;
const BLEND_LORA = /融图|blend|relight|光影融合/i;

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

  // ── outpaint: image + four pad amounts instead of image + mask ──
  const op = findOutpaintCanvas(g);
  let taskType: TaskType = "inpaint";
  let outpaint: OutpaintCanvas | undefined;
  if (op) {
    taskType = "outpaint";
    suggestions.push({ binding: bindingFor(g, "image", op.image, "image", { encoding: "rgb" }), confidence: "certain", reason: "扩图画布节点的原图输入" });
    for (const side of Object.keys(op.pads) as Side[]) {
      const src = literalSource(g, op.id, op.pads[side], "number");
      if (src) suggestions.push({ binding: bindingFor(g, "pad", src.nodeId, src.input, { side, label: `扩展 ${side}` }), confidence: "certain", reason: `#${op.id}.${op.pads[side]} 的数值来源` });
      else blockers.push(`扩图节点 #${op.id} 的「${op.pads[side]}」无法写入`);
    }
    const inputs = g[op.id].inputs;
    const unit = Object.keys(inputs).find(k => /^(单位|unit)$/i.test(k));
    const ratio = Object.keys(inputs).find(k => /ratio/i.test(k));
    const layout = Object.keys(inputs).find(k => /layout/i.test(k));
    outpaint = {
      nodeId: op.id,
      unit: unit && typeof inputs[unit] === "string" ? { input: unit, value: /^[a-z]/i.test(String(inputs[unit])) ? "pixels" : "像素" } : undefined,
      ratio: ratio && typeof inputs[ratio] === "string" ? { input: ratio, value: /^[a-z]/i.test(String(inputs[ratio])) ? "free" : "自由比例" } : undefined,
      layout: layout ? { input: layout } : undefined,
      maxPad: 3000,
    };
  }

  // ── text-to-image: the output size comes from a size node, not from an input image ──
  const sz = op ? null : findSizeSource(g);
  let txt2img: Txt2ImgSize | undefined;
  if (sz) {
    taskType = "txt2img";
    txt2img = sz.size;
    for (const axis of ["w", "h"] as const) {
      const s = sz[axis];
      suggestions.push({ binding: bindingFor(g, "size", s.nodeId, s.input, { axis, label: axis === "w" ? "宽度" : "高度" }), confidence: "certain", reason: "输出尺寸的来源" });
    }
  }

  // ── image + mask ──
  const loaders = ids.filter(id => LOAD_IMAGE.test(g[id].class_type) && typeof g[id].inputs.image === "string");
  const maskLoaders = ids.filter(id => LOAD_MASK.test(g[id].class_type));
  const alphaMasked = loaders.filter(id => consumers(g, id, 1).length > 0);
  let mainImage: string | null = null;

  // ── upscale: a loaded image into a scale-factor node, and no mask anywhere ──
  const up = op || sz || alphaMasked.length || maskLoaders.length ? null : findUpscaler(g);
  let upscale: UpscaleOptions | undefined;
  if (up) {
    taskType = "upscale";
    upscale = { factors: [1, 2, 3, 4] };
    suggestions.push({ binding: bindingFor(g, "image", up.image, "image", { encoding: "rgb" }), confidence: "certain", reason: "放大节点的原图输入" });
    suggestions.push({ binding: bindingFor(g, "scale", up.scale.nodeId, up.scale.input, { label: "放大倍数" }), confidence: "certain", reason: "放大倍数的来源" });
  }

  const rankImage = (id: string) => {
    const t = title(g, id);
    return (numberedTitle(t) ?? 99) * -1 + (/加载图像|主图|原图|input|source/i.test(t) ? 50 : 0) + (consumers(g, id, 1).length ? 30 : 0);
  };

  if (op) {
    mainImage = op.image;
  } else if (up) {
    mainImage = up.image;
  } else if (sz) {
    // every loader is an (optional) reference image
  } else if (alphaMasked.length) {
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
  } else if (loaders.length && !op && !sz && !up && findExtract(g)) {
    // 抠图 workflows that name the object instead of taking a mask: the selection's area is sent as is
    const sorted = [...loaders].sort((a, b) => rankImage(b) - rankImage(a));
    mainImage = sorted[0];
    suggestions.push({
      binding: bindingFor(g, "image", mainImage, "image", { encoding: "rgb" }),
      confidence: loaders.length === 1 ? "certain" : "ambiguous",
      reason: "抠图工作流的原图输入（按物件名抠图，不需要遮罩）",
      alternatives: sorted.slice(1).map(id => bindingFor(g, "image", id, "image", { encoding: "rgb" })),
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
    // loaders with a 「无」 choice (孤海加载图像) may run empty
    const b = bindingFor(g, "reference", id, "image", { slot: i + 1, encoding: "rgb", ...(/goohai/i.test(g[id].class_type) ? { emptyValue: "无" } : {}) });
    suggestions.push(sz && b.emptyValue
      ? { binding: b, confidence: "certain", reason: "可选的参考图（不放图时为「无」）" }
      : { binding: b, confidence: "likely", reason: `其余的加载图像节点，按顺序作为参考图 ${i + 1}` });
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

  // ── 拆图: an inpaint-shaped workflow (selection in the image's alpha) whose prompt names one element,
  // e.g. FG Extract's template with {el}. The element name is the prompt; the RGBA result is the output.
  const ex = taskType === "inpaint" && !!mainImage ? findExtract(g) : null;
  if (ex) {
    taskType = "extract";
    if (ex.name) {
      const i = suggestions.findIndex(s => s.binding.role === "prompt");
      if (i >= 0) suggestions.splice(i, 1);
      suggestions.push({ binding: bindingFor(g, "prompt", ex.name.nodeId, ex.name.input, { label: "物件名" }), confidence: "certain", reason: "提示词模板里 {el} 的来源（要拆的物件名，可留空）" });
    }
    // the cut-out, not a mask preview made from it
    const o = suggestions.findIndex(s => s.binding.role === "output");
    const cut = saves.find(id => !upstreamHas(g, id, "MaskToImage"));
    if (o >= 0 && cut) suggestions[o] = { binding: bindingFor(g, "output", cut, "images", { imageIndex: 0 }), confidence: "certain", reason: "拆出的透明图（不是遮罩预览）" };
  }

  // ── 融图: an inpaint workflow built around a relight / blend LoRA ──
  if (taskType === "inpaint" && isBlendGraph(g)) taskType = "blend";

  return { suggestions, blockers, notes, taskType, outpaint, txt2img, upscale };
}

/** A 融图 (product relight / blend) workflow: a blend LoRA, or the 融图 LoRA's trigger word. */
export function isBlendGraph(g: ApiGraph): boolean {
  return Object.values(g).some(n =>
    (LORA.test(n.class_type) && BLEND_LORA.test(String(n.inputs.lora_name ?? ""))) ||
    Object.values(n.inputs).some(v => typeof v === "string" && /\bpengyu\b/.test(v)));
}

/** An element-extraction workflow: a StringReplace filling "{el}" into a template, or an extraction LoRA. */
function findExtract(g: ApiGraph): { name: { nodeId: string; input: string } | null } | null {
  for (const [id, n] of Object.entries(g)) {
    if (n.class_type !== "StringReplace" || !/\{el\}/.test(String(n.inputs.find ?? ""))) continue;
    const src = literalSource(g, id, "replace", "string");
    return { name: src ? { nodeId: src.nodeId, input: src.input } : null };
  }
  const lora = Object.values(g).some(n => LORA.test(n.class_type) && EXTRACT_LORA.test(String(n.inputs.lora_name ?? "")));
  return lora ? { name: null } : null;
}

/** Whether a node of `classType` feeds `id`, directly or further up. */
function upstreamHas(g: ApiGraph, id: string, classType: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  for (const v of Object.values(g[id]?.inputs ?? {})) {
    if (!isLink(v)) continue;
    if (g[v[0]]?.class_type === classType || upstreamHas(g, v[0], classType, seen)) return true;
  }
  return false;
}
