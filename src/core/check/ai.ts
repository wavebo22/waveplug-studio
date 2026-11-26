// 文档检查 · AI part: DeepSeek reads every text layer's copy (typos, punctuation, inconsistent terms,
// suspicious prices / dates / phone numbers, placeholders, words banned in Chinese advertising,
// translations that don't match) and, when allowed, looks at the composite (obvious AI-generation
// flaws, garbled text in images, layout problems). Its answer is checked here: an issue must name
// a text layer of the document and quote text that is really in it, or it is left out.

import type { CheckText, Issue } from "./rules.ts";

/** Longest copy sent per text layer (characters); more copy than the request allows is cut. */
const MAX_TEXT = 600;
const MAX_TOTAL = 40_000;

export const COPY_SYSTEM = `你是资深中文文案校对，检查一份设计稿里每个文字图层的文案。只输出 JSON。

要找的问题（type 用括号里的英文）：
- 错别字、漏字、多字、语病（typo）
- 标点问题：中英文标点混用、成对的引号括号不配对、多余空格（punct）
- 同一个词前后写法不一致，如「登陆 / 登录」「APP / App」（inconsistent）
- 价格、日期、星期、电话、网址格式可疑或互相矛盾，如日期和星期对不上（format）
- 还没替换的占位文字，如「Lorem ipsum」「标题」「XXX」（placeholder）
- 广告法禁用或高风险用语，如「最」「第一」「国家级」「顶级」「100%」「绝对」（ad_law）
- 中英文（或其他语言）对照的两段内容意思不一致（translation）

规则：
1. 只报确实有问题的地方，宁缺毋滥。品牌名、产品名、人名、特意的写法不要改。
2. original 必须是该图层 text 里原样存在的一小段（不要整段），suggestion 是改好后的这一小段；只是提醒、没有具体改法时 suggestion 留空字符串。
3. reason 用一句中文说明原因。
4. 涉及多个图层（如前后不一致、翻译不一致）时，id 写需要改的那个，reason 里说明另一个图层。

输出格式：{"issues":[{"id":数字,"type":"typo","original":"原文片段","suggestion":"建议","reason":"原因"}]}`;

export const VISUAL_SYSTEM = `你是资深视觉设计审稿人。看这张设计稿的画面，只找明显的问题。只输出 JSON。

要找的：
- AI 生成图常见的瑕疵：手指数量或形状不对、肢体扭曲、五官错乱、图里出现乱码文字、物体结构不合理（ai_artifact）
- 明显的排版问题：文字被图片或色块挡住、文字压在杂乱背景上看不清、元素贴边或被裁掉（layout）
- 其他一眼就能看出的错误，如图片拉伸变形、明显的接缝和抠图残边（other）

规则：只报明显的问题，没有就返回空数组。where 用简短中文说明位置（如「左上角人物的右手」「底部按钮」）。

输出格式：{"issues":[{"type":"ai_artifact","where":"位置","problem":"问题","suggestion":"建议"}]}`;

const TYPE_NAMES: Record<string, string> = {
  typo: "错别字 / 语病", punct: "标点", inconsistent: "前后不一致", format: "格式可疑", placeholder: "占位文字",
  ad_law: "广告法用语", translation: "翻译不一致", ai_artifact: "AI 生成瑕疵", layout: "排版", other: "画面问题",
};

/** The user message for the copy check: one JSON line per text layer with copy. */
export function copyPrompt(texts: readonly CheckText[]): { user: string; count: number; cut: boolean } {
  const lines: string[] = [];
  let total = 0, cut = false;
  for (const t of texts) {
    const text = t.contents.replace(/\r\n?|\u0003/g, "\n").trim();
    if (!text) continue;
    const piece = JSON.stringify({ id: t.id, name: t.name, text: text.slice(0, MAX_TEXT), ...(t.visible ? {} : { hidden: true }) });
    if (total + piece.length > MAX_TOTAL) { cut = true; break; }
    total += piece.length;
    lines.push(piece);
  }
  return { user: `设计稿里的文字图层，每行一个（text 里的换行是原文换行）：\n${lines.join("\n")}`, count: lines.length, cut };
}

const str = (v: unknown) => typeof v === "string" ? v.trim() : "";

/** DeepSeek's copy issues as panel issues: unknown layers and quotes not in the text are left out.
 *  A suggestion becomes a fix only for a layer set in one style (replacing text keeps that style). */
export function parseCopyIssues(value: unknown, texts: readonly CheckText[]): Issue[] {
  const byId = new Map(texts.map(t => [t.id, t]));
  const raw = (value as { issues?: unknown })?.issues;
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(raw) ? raw : []) {
    const id = Number((it as any)?.id);
    const t = byId.get(id);
    if (!t) continue;
    const original = str((it as any)?.original), suggestion = str((it as any)?.suggestion), reason = str((it as any)?.reason);
    const type = str((it as any)?.type);
    const contents = t.contents.replace(/\r\n?|\u0003/g, "\n");
    if (original && !contents.includes(original)) continue;
    const key = `copy:${id}:${original}:${suggestion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = TYPE_NAMES[type] ?? "文案";
    const change = original && suggestion && suggestion !== original;
    out.push({
      key, category: "copy", severity: type === "ad_law" || type === "typo" ? "warn" : "info", ids: [id],
      title: change ? `「${t.name}」${label}：「${original}」→「${suggestion}」` : `「${t.name}」${label}${original ? `：「${original}」` : ""}`,
      detail: reason || "DeepSeek 认为这里可能有问题",
      ...(change && t.ranges === 1 ? { fix: { kind: "setText" as const, id, from: original, to: suggestion }, fixLabel: "采用建议" } : {}),
    });
  }
  return out;
}

/** DeepSeek's visual issues (they name places, not layers). */
export function parseVisualIssues(value: unknown): Issue[] {
  const raw = (value as { issues?: unknown })?.issues;
  return (Array.isArray(raw) ? raw : []).slice(0, 20).flatMap((it, i): Issue[] => {
    const problem = str((it as any)?.problem), where = str((it as any)?.where), suggestion = str((it as any)?.suggestion);
    if (!problem) return [];
    const type = str((it as any)?.type);
    return [{ key: `visual:${i}:${problem}`, category: "visual", severity: type === "ai_artifact" ? "warn" : "info", ids: [],
      title: `${TYPE_NAMES[type] ?? "画面问题"}${where ? `（${where}）` : ""}：${problem}`, detail: suggestion || "请对照画面确认" }];
  });
}

/** The copy with `from` replaced by `to` once (the first time it occurs); null when `from` is gone. */
export function replaceOnce(contents: string, from: string, to: string): string | null {
  // Photoshop separates lines with \r; the check compared with \n
  const norm = contents.replace(/\r\n?|\u0003/g, "\n");
  const at = norm.indexOf(from);
  if (at < 0) return null;
  return (norm.slice(0, at) + to + norm.slice(at + from.length)).replace(/\n/g, "\r");
}
