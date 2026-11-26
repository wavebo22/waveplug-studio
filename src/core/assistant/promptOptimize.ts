// AI 优化提示词 (the generate page's 「AI 优化」 button, and the external generate panel's): DeepSeek
// turns what the user typed into a prompt Qwen-Image works well with, by mode. For the modes that
// change an existing picture it also sees a thumbnail of the canvas and where the selection is
// (deepseek-flash, when 功能设置 › AI 助手 › 优化提示词时参考画面 is on). Replaces the workflows' own
// prompt-optimiser nodes (QwenImagePromptOptimizer, stripped by core/workflow/stripOptimizer.ts).
// Pure (tests/assistant_prompt.test.ts).

import type { Rect } from "../image/region.ts";

export type PromptMode = "inpaint" | "blend" | "outpaint" | "txt2img";
export const isPromptMode = (m: string): m is PromptMode => m === "inpaint" || m === "blend" || m === "outpaint" || m === "txt2img";

const MAX_PROMPT = 1500;

export const PROMPT_SYSTEM = `你是 AI 生图提示词助手，为 Qwen-Image 图像模型写提示词。根据用户的想法（可能很短）写一段完整、具体的提示词。只输出 JSON。

规则：
1. 用自然语言描述画面，不要堆关键词，不要写权重符号和括号语法。写清主体、外观（材质、颜色、形状、细节）、动作或状态，以及和周围画面相关的光线、视角、透视、景深和风格。
2. 用户写了什么就保留什么，不要改掉用户指定的内容、数量、颜色、文字；只补充没说到的细节。用户要求画面里出现文字时，把文字原样放进英文双引号里。
3. 提示词的语言跟随用户的输入（用户用中文就写中文），长度 50～150 字（英文 40～120 词）。
4. 不要写负面提示词，不要写画质套话（如「8K、杰作、最佳质量」）。
5. 有画面截图时：截图里标出的选区就是要改的地方，描述要和截图里的光线方向、色调、透视、风格一致。

输出格式：{"prompt":"提示词"}`;

const MODE_GUIDE: Record<PromptMode, string> = {
  inpaint: "模式：局部重绘。只描述要画进选区的东西本身，以及它和周围的光影、透视如何衔接；不要描述选区外的整个画面。",
  blend: "模式：融图。画面里已经放了一个要融合进场景的元素，描述如何让它自然地融入：统一光线方向、色温、阴影、反光、透视和质感；用户想法为空时，就写一段让元素和场景自然融合的通用描述。",
  outpaint: "模式：扩图。描述扩展出来的画面，要和原有画面连成一体，延续场景、光线和风格。",
  txt2img: "模式：文生图。描述完整的画面：主体、环境、构图、光线、风格。",
};

/** Why it can't be optimised now (null: it can). */
export function optimizeBlocked(mode: string, text: string, withImage: boolean): string | null {
  if (!isPromptMode(mode)) return "这个模式不用提示词优化";
  if (text.trim()) return null;
  if (mode === "inpaint") return "局部重绘的提示词留空表示移除选区里的内容，不需要优化；要画新内容先写一句想法";
  if (mode === "blend" && withImage) return null;
  return "先写一句想法，例如「一只橘猫趴在窗台上」";
}

/** The request. `sel`: the selection on the canvas (px), `size`: the canvas; `image`: a thumbnail goes with it. */
export function promptRequest(mode: PromptMode, text: string, opts: { image: boolean; sel?: Rect | null; size?: { width: number; height: number } | null; ratio?: string }): string {
  const parts = [MODE_GUIDE[mode]];
  const { sel, size } = opts;
  if (opts.image && size && size.width > 0 && size.height > 0) {
    const pct = (v: number, of: number) => Math.round(Math.max(0, Math.min(1, v / of)) * 100);
    parts.push(sel
      ? `附图是整张画面的缩略图（${Math.round(size.width)}×${Math.round(size.height)} 像素）。选区（要改的地方）从左边 ${pct(sel.left, size.width)}%、上边 ${pct(sel.top, size.height)}% 到左边 ${pct(sel.right, size.width)}%、上边 ${pct(sel.bottom, size.height)}%，大小约 ${Math.round(sel.right - sel.left)}×${Math.round(sel.bottom - sel.top)} 像素。`
      : `附图是整张画面的缩略图（${Math.round(size.width)}×${Math.round(size.height)} 像素）。`);
  }
  if (mode === "txt2img" && opts.ratio) parts.push(`画面比例：${opts.ratio}。`);
  parts.push(`用户的想法：${text.replace(/\s+/g, " ").trim().slice(0, 600) || "（空）"}`);
  return parts.join("\n");
}

/** The prompt in the answer ("" when there is none). */
export function parsePromptAnswer(value: unknown): string {
  const v = value && typeof value === "object" ? (value as { prompt?: unknown }).prompt : value;
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, MAX_PROMPT) : "";
}
