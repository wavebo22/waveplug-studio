// AI 改写文字 (WavePlug 图层 panel's 改写 button / right-click menu): DeepSeek translates or rewrites
// the text layers in scope by one instruction (翻译成英文, 更口语化, 缩短…); the window beside the
// panel lists old → new, the user unticks what to keep, Photoshop replaces the ticked layers' text as
// one undo step. A layer with several styles (mixed fonts / sizes / colours) only gets a suggestion:
// replacing its text would flatten the styling. Pure (tests/assistant_rewrite.test.ts).

import { type TreeLayer, ancestors } from "../layers/tree.ts";

export const REWRITE_MAX_LAYERS = 150;
/** characters of text sent in one request at most */
export const REWRITE_MAX_CHARS = 12_000;
export const REWRITE_PRESETS = ["翻译成英文", "翻译成日文", "翻译成繁体中文", "更口语化", "更简洁，缩短一半", "更正式"];

export const REWRITE_SYSTEM = `你是设计稿文案助手。按用户的要求逐条改写 Photoshop 文字图层里的文字。只输出 JSON。

规则：
1. 每条按要求改写，保留原意和语气层级（标题仍像标题，按钮仍像按钮）。原文有换行的，改写后在相近的位置换行，换行写成 \\n。
2. 品牌名、产品型号、数字、价格、日期、网址、电话、邮箱保持不变；翻译时品牌名也不翻译。
3. 设计稿空间有限：长度尽量接近原文，除非用户要求缩短或扩写。
4. 不需要改的（改完和原文一样的）不要输出。
5. name 是图层名，只用来理解用途，不要改写它。

输出格式：{"items":[{"id":数字,"text":"改写后的文字"}]}`;

export interface RewriteText { id: number; name: string; text: string }
export interface RewriteItem { id: number; from: string; to: string }

/** The text layers covered: the selected ones and those inside selected groups; nothing (or no
 *  text) selected: every text layer of the document. */
export function rewriteScope(layers: readonly TreeLayer[], selected: ReadonlySet<number>): { ids: number[]; label: string } {
  const texts = layers.filter(l => l.kind === "text");
  const chosen = texts.filter(l => selected.has(l.id) || ancestors(layers as TreeLayer[], l.id).some(a => selected.has(a)));
  if (chosen.length) return { ids: chosen.map(l => l.id), label: `选中的 ${chosen.length} 个文字图层` };
  return { ids: texts.map(l => l.id), label: `全部 ${texts.length} 个文字图层` };
}

/** The request: one JSON line per text, as many as fit. */
export function rewriteUserPrompt(texts: readonly RewriteText[], instruction: string): { user: string; count: number; cut: number } {
  const lines: string[] = [];
  let size = 0;
  for (const t of texts) {
    if (!t.text.trim()) continue;
    const line = JSON.stringify({ id: t.id, name: t.name, text: t.text });
    if (lines.length && size + line.length > REWRITE_MAX_CHARS) break;
    lines.push(line); size += line.length;
  }
  const all = texts.filter(t => t.text.trim()).length;
  return {
    user: [`改写要求：${instruction.replace(/\s+/g, " ").trim().slice(0, 300)}`, "文字图层，每行一个：", lines.join("\n")].join("\n\n"),
    count: lines.length, cut: all - lines.length,
  };
}

/** The answer's rewrites of layers that were sent, changed, not empty. */
export function parseRewrite(value: unknown, texts: readonly RewriteText[]): RewriteItem[] {
  const v = (value && typeof value === "object" ? value : {}) as { items?: unknown };
  const byId = new Map(texts.map(t => [t.id, t]));
  const out: RewriteItem[] = [];
  const seen = new Set<number>();
  for (const it of Array.isArray(v.items) ? v.items : []) {
    const raw = (it as any)?.id;
    const id = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    const t = typeof id === "number" ? byId.get(id) : undefined;
    const to = typeof (it as any)?.text === "string" ? (it as any).text.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim().slice(0, 4000) : "";
    if (!t || seen.has(t.id) || !to || to === t.text.trim()) continue;
    seen.add(t.id);
    out.push({ id: t.id, from: t.text, to });
  }
  return out;
}
