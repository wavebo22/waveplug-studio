// AI 整理图层: DeepSeek proposes clear Chinese names and new groups for related layers; the panel
// shows the plan, the user ticks what to keep, Photoshop applies it as one undo step. Everything
// here is pure (tests/assistant_organize.test.ts): which layers are in play, what the model is told,
// and checking its answer so that applying it never changes how the document looks — new groups
// only take adjacent siblings (stacking order unchanged), never split a clipping chain, and leave
// the background, artboards, fully locked layers and the AI result groups' insides alone.

import { type TreeLayer, aiLabel } from "../layers/tree.ts";

/** More than this many layers in one request and the answer gets long and slow: select fewer. */
export const ORGANIZE_MAX_LAYERS = 300;
/** Longest name accepted from the model. */
const MAX_NAME = 60;
/** Longest text-layer content sent (characters). */
const MAX_TEXT = 80;

export interface OrganizeScope {
  /** layers that may be renamed or grouped, top to bottom */
  ids: number[];
  /** what the user sees: 整个文档 / 选中的 N 个图层 / 组「…」 */
  label: string;
}

export interface OrganizeRename { id: number; from: string; to: string }
export interface OrganizeGroup { name: string; ids: number[]; parentId: number | null }
export interface OrganizePlan {
  renames: OrganizeRename[];
  groups: OrganizeGroup[];
  /** parts of the answer that were left out, and why (shown under the plan) */
  dropped: string[];
}

const byIdOf = (layers: readonly TreeLayer[]) => new Map(layers.map(l => [l.id, l]));

function ancestorsOf(byId: Map<number, TreeLayer>, l: TreeLayer): TreeLayer[] {
  const out: TreeLayer[] = [];
  const seen = new Set<number>();
  let p = l.parentId;
  while (p !== null && !seen.has(p)) {
    seen.add(p);
    const a = byId.get(p);
    if (!a) break;
    out.push(a);
    p = a.parentId;
  }
  return out;
}

const isAiGroup = (l: TreeLayer) => l.kind === "group" && (!!l.ai || aiLabel(l.name) !== null);
/** inside one of the panel's AI result groups: their variations' names are the panel's own */
const insideAi = (byId: Map<number, TreeLayer>, l: TreeLayer) => ancestorsOf(byId, l).some(isAiGroup);

/** The layers the request covers: the selected groups' contents (and the groups), several selected
 *  layers, or — with one plain layer or nothing selected — the whole document. The background and
 *  the AI result groups' insides never count. */
export function organizeScope(layers: readonly TreeLayer[], selected: ReadonlySet<number>): OrganizeScope {
  const byId = byIdOf(layers);
  const usable = (l: TreeLayer) => l.kind !== "background" && !insideAi(byId, l);
  const sel = layers.filter(l => selected.has(l.id));
  const groups = sel.filter(l => l.kind === "group" && !isAiGroup(l));
  if (groups.length || sel.length > 1) {
    const roots = new Set(groups.map(g => g.id));
    const ids = layers.filter(l => usable(l) && (selected.has(l.id) || ancestorsOf(byId, l).some(a => roots.has(a.id)))).map(l => l.id);
    const label = sel.length === 1 ? `组「${sel[0].name}」` : `选中的 ${sel.length} 个图层` + (groups.length ? "（含组内）" : "");
    return { ids, label };
  }
  return { ids: layers.filter(usable).map(l => l.id), label: "整个文档" };
}

/** May the plan rename this layer? (not the background, not an AI result group or its insides) */
function renamable(byId: Map<number, TreeLayer>, l: TreeLayer): boolean {
  return l.kind !== "background" && !isAiGroup(l) && !insideAi(byId, l);
}
/** May the plan put this layer into a new group? (artboards stay top level; fully locked layers can't move) */
function groupable(byId: Map<number, TreeLayer>, l: TreeLayer): boolean {
  return l.kind !== "background" && !l.artboard && !l.lockAll && !insideAi(byId, l);
}

const KIND_WORD: Record<string, string> = {
  pixel: "pixel", adjustment: "adjustment", text: "text", shape: "shape", smartObject: "smartObject",
  group: "group", fill: "fill", background: "background", other: "other",
};

/** One JSON line per layer for the model: the layers in scope, plus their parent groups (marked
 *  fixed) so it knows where they sit. `texts`: text layers' contents. */
export function describeLayers(
  layers: readonly TreeLayer[], scopeIds: readonly number[], texts: ReadonlyMap<number, string>,
  /** false: no "fixed" marks (only describing, nothing is renamed: 一句话选图层) */
  marks = true,
): string {
  const byId = byIdOf(layers);
  const scope = new Set(scopeIds);
  const context = new Set<number>();
  for (const id of scopeIds) {
    const l = byId.get(id);
    if (l) for (const a of ancestorsOf(byId, l)) if (!scope.has(a.id)) context.add(a.id);
  }
  const lines: string[] = [];
  for (const l of layers) {
    if (!scope.has(l.id) && !context.has(l.id)) continue;
    const o: Record<string, unknown> = { id: l.id, name: l.name, kind: l.artboard ? "artboard" : KIND_WORD[l.kind] ?? "other" };
    if (l.parentId !== null) o.parent = l.parentId;
    if (l.kind === "group") o.children = l.children;
    if (l.width > 0 && l.height > 0) o.box = [Math.round(l.left), Math.round(l.top), Math.round(l.width), Math.round(l.height)];
    const t = texts.get(l.id);
    if (t) o.text = oneLine(t).slice(0, MAX_TEXT);
    if (l.smart?.file) o.file = l.smart.file;
    if (l.effectList.length) o.fx = [...new Set(l.effectList.map(e => e.name))];
    if (l.clipped) o.clip = true;
    if (l.mask || l.vmask) o.mask = true;
    if (!l.visible) o.hidden = true;
    if (l.mode && l.mode !== "normal" && l.mode !== "passThrough") o.mode = l.mode;
    if (marks && (!scope.has(l.id) || !renamable(byId, l))) o.fixed = true;
    lines.push(JSON.stringify(o));
  }
  return lines.join("\n");
}

export const ORGANIZE_SYSTEM = `你是 Photoshop 图层整理助手。根据图层信息给图层起清楚的中文名字，并把属于同一元素的相邻图层归进新组。只输出 JSON。

规则：
1. 名字用简短中文（2～10 个字），说明图层是什么或做什么用，例如「主标题」「购买按钮」「背景渐变」「人物投影」。文字图层按文字内容和用途命名，可以直接用简短的文字内容。同类有多个时加区分（「图标-购物车」「图标-搜索」），不要加序号，除非实在无法区分。
2. 已经清楚的名字不要改，也不要出现在 renames 里。「图层 3」「矩形 1 拷贝」「组 2」「Layer 1」「Group 1」这类默认名一定要改。
3. 只能改没有 "fixed": true 的图层。
4. groups：把同一个元素或同一块区域的图层归成一组，组名也用简短中文。每组至少 2 个图层；组内图层的 parent 必须相同（没有 parent 的都算顶层），并且在列表里紧挨着，中间不能隔着别的同级图层；带 "clip": true 的剪贴图层必须和它下面紧挨着的基底图层在同一组。不要把一个 parent 下的全部图层归成一组；不要嵌套新组；artboard 和 fixed 的图层不能归组。拿不准就不归组。
5. 推测依据：box 是 [左, 上, 宽, 高]（像素），text 是文字内容，file 是智能对象的文件名，fx 是图层样式，hidden 表示隐藏，children 是组内图层数。你看不到图像，只能根据这些信息判断。

输出格式：{"renames":[{"id":数字,"name":"新名字"}],"groups":[{"name":"组名","ids":[数字,…]}]}`;

/** The user message: canvas size, the layer lines, and the user's own wishes. */
export function organizeUserPrompt(lines: string, opts: { width: number; height: number; renameOnly: boolean; extra: string }): string {
  const parts = [`画布 ${Math.round(opts.width)}×${Math.round(opts.height)} 像素。图层从上到下（和 Photoshop 图层面板顺序相同），每行一个：`, lines];
  if (opts.renameOnly) parts.push("这次只重命名：groups 返回空数组。");
  const extra = oneLine(opts.extra);
  if (extra) parts.push(`用户的补充要求（不违反上面的规则时照做）：${extra}`);
  return parts.join("\n\n");
}

function oneLine(s: string): string {
  return String(s).replace(/[\r\n\t\u0003]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
function cleanName(v: unknown): string {
  return typeof v === "string" ? oneLine(v).slice(0, MAX_NAME) : "";
}
const asId = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
};

/** Clipping chains among siblings (top to bottom): clipped layers and the base right below them
 *  share a chain number. */
function clipChains(siblings: readonly TreeLayer[]): Map<number, number> {
  const out = new Map<number, number>();
  let chain = 0, pending: number[] = [];
  for (const s of siblings) {
    pending.push(s.id);
    if (!s.clipped) { for (const id of pending) out.set(id, chain); chain++; pending = []; }
  }
  for (const id of pending) out.set(id, chain);
  return out;
}

/** Checks the model's answer (or a plan being re-checked against a fresh read) against the
 *  document: what is kept is safe to apply as is; what is left out is listed in `dropped`. */
export function parseOrganizePlan(value: unknown, layers: readonly TreeLayer[], scopeIds: readonly number[]): OrganizePlan {
  const byId = byIdOf(layers);
  const scope = new Set(scopeIds);
  const dropped: string[] = [];
  const v = (value && typeof value === "object" ? value : {}) as { renames?: unknown; groups?: unknown };
  const nameOf = (id: number) => byId.get(id)?.name ?? `#${id}`;

  const renames: OrganizeRename[] = [];
  const renamed = new Set<number>();
  for (const r of Array.isArray(v.renames) ? v.renames : []) {
    const id = asId((r as any)?.id), to = cleanName((r as any)?.name ?? (r as any)?.to);
    if (id === null || !to) continue;
    const l = byId.get(id);
    if (!l) { dropped.push(`改名 #${id}：没有这个图层`); continue; }
    if (!scope.has(id) || !renamable(byId, l)) { dropped.push(`「${l.name}」不在整理范围内，名字不改`); continue; }
    if (renamed.has(id) || to === l.name) continue;
    renamed.add(id);
    renames.push({ id, from: l.name, to });
  }

  const groups: OrganizeGroup[] = [];
  const grouped = new Set<number>();
  for (const g of Array.isArray(v.groups) ? v.groups : []) {
    const name = cleanName((g as any)?.name);
    const raw = Array.isArray((g as any)?.ids) ? (g as any).ids.map(asId).filter((x: number | null): x is number => x !== null) : [];
    const label = name || "（没有名字）";
    if (!name) { dropped.push("有一个新组没有名字，没建"); continue; }
    const ids: number[] = [];
    for (const id of new Set<number>(raw)) {
      const l = byId.get(id);
      if (!l) continue;
      if (!scope.has(id) || !groupable(byId, l)) { dropped.push(`「${l.name}」不能放进新组「${label}」`); continue; }
      if (grouped.has(id)) { dropped.push(`「${l.name}」已在别的新组里，不再放进「${label}」`); continue; }
      ids.push(id);
    }
    if (ids.length < 2) { if (raw.length) dropped.push(`新组「${label}」不足 2 个图层，没建`); continue; }
    // one parent: the one most of them share
    const count = new Map<number | null, number>();
    for (const id of ids) { const p = byId.get(id)!.parentId; count.set(p, (count.get(p) ?? 0) + 1); }
    const parentId = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const others = ids.filter(id => byId.get(id)!.parentId !== parentId);
    if (others.length) dropped.push(`新组「${label}」：${others.map(nameOf).map(n => `「${n}」`).join("")}不在同一层级，没放进去`);
    const siblings = layers.filter(l => l.parentId === parentId);
    const pos = new Map(siblings.map((s, i) => [s.id, i]));
    const mine = ids.filter(id => byId.get(id)!.parentId === parentId).sort((a, b) => pos.get(a)! - pos.get(b)!);
    // adjacent runs: putting layers that aren't next to each other into a group would move them
    const runs: number[][] = [];
    for (const id of mine) {
      const last = runs[runs.length - 1];
      if (last && pos.get(id)! === pos.get(last[last.length - 1])! + 1) last.push(id); else runs.push([id]);
    }
    const chains = clipChains(siblings);
    const keep = runs.filter(run => {
      if (run.length < 2) return false;
      if (run.length === siblings.length) { dropped.push(`新组「${label}」会包含同一层级的全部图层，没建`); return false; }
      const inRun = new Set(run);
      const split = siblings.some(s => !inRun.has(s.id) && run.some(id => chains.get(id) === chains.get(s.id)));
      if (split) { dropped.push(`新组「${label}」会拆开剪贴蒙版，没建`); return false; }
      return true;
    });
    if (runs.length > 1 && !keep.length && runs.every(r => r.length < 2)) dropped.push(`新组「${label}」的图层不相邻，没建（归组会改变上下顺序）`);
    else if (runs.length > 1 && keep.length < runs.length) dropped.push(`新组「${label}」的图层不相邻，只建了相邻的部分`);
    keep.forEach((run, i) => {
      for (const id of run) grouped.add(id);
      groups.push({ name: keep.length > 1 ? `${name} ${i + 1}` : name, ids: run, parentId });
    });
  }
  return { renames, groups, dropped };
}

/** The plan as sent to Photoshop: only the ticked items. */
export function chosenPlan(plan: OrganizePlan, offRenames: ReadonlySet<number>, offGroups: ReadonlySet<number>): { renames: { id: number; name: string }[]; groups: { name: string; ids: number[] }[] } {
  return {
    renames: plan.renames.filter(r => !offRenames.has(r.id)).map(r => ({ id: r.id, name: r.to })),
    groups: plan.groups.filter((_, i) => !offGroups.has(i)).map(g => ({ name: g.name, ids: [...g.ids] })),
  };
}
