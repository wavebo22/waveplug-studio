// WaveLayer for Illustrator: what the panel works out from the tree the host script sends
// (ai/host/wavelayer.jsx `tree`). Pure, tested in tests/ai_model.test.ts.

export type Kind = "layer" | "path" | "compound" | "group" | "clip" | "text" | "placed" | "raster" | "symbol" | "mesh" | "plugin" | "graph" | "other";

export interface AiNode {
  key: string;
  kind: Kind;
  /** what the row shows: the name, or Illustrator's own <路径> / <编组> … / the text */
  label: string;
  name: string;
  hidden: boolean;
  locked: boolean;
  /** selected in Illustrator (a layer: has selected artwork) */
  sel: boolean;
  /** layer colour */
  color?: string | null;
  /** fill colour of a path, "gradient" / "pattern", or null */
  fill?: string | null;
  count: number;
  /** the clipping path of a clip group */
  mask?: boolean;
  /** sent to Photoshop (core/overlay/bridge.ts): the link id */
  link?: string | null;
  /** a linked file that isn't there any more */
  missing?: boolean;
  /** listed only when open */
  children?: AiNode[];
  /** more children than listed */
  more?: number;
  /** layers: printed / shown in preview (false: outline) */
  printable?: boolean;
  preview?: boolean;
  /** search results: where it is (图层 › 编组) */
  trail?: string;
}

export interface AiTree {
  doc: { name: string; path: string; saved: boolean; artboards: string[]; artboard: number } | null;
  active?: string | null;
  selCount?: number;
  layers?: AiNode[];
}

export interface Row { node: AiNode; depth: number; open: boolean; /** the layer it is in (for the colour bar) */ layerColor: string | null; /** shown dimmed: inside something hidden */ dim: boolean }

/** The rows on screen, top to bottom. A node is open when its children were listed. */
export function rows(layers: readonly AiNode[]): Row[] {
  const out: Row[] = [];
  const walk = (n: AiNode, depth: number, color: string | null, dim: boolean) => {
    const c = n.kind === "layer" ? n.color ?? color : color;
    out.push({ node: n, depth, open: !!n.children, layerColor: c, dim });
    for (const k of n.children ?? []) walk(k, depth + 1, c, dim || n.hidden);
  };
  for (const l of layers) walk(l, 0, null, false);
  return out;
}

export const isContainer = (k: Kind) => k === "layer" || k === "group" || k === "clip";
export const depthOf = (key: string) => key.split("/").length;
export const parentKey = (key: string): string | null => { const i = key.lastIndexOf("/"); return i < 0 ? null : key.slice(0, i); };
/** `a` is `b` or inside it */
export const within = (a: string, b: string) => a === b || a.startsWith(b + "/");

/** Every node by key (open ones and their children). */
export function index(layers: readonly AiNode[]): Map<string, AiNode> {
  const m = new Map<string, AiNode>();
  const walk = (n: AiNode) => { m.set(n.key, n); for (const k of n.children ?? []) walk(k); };
  for (const l of layers) walk(l);
  return m;
}

/** The selected items as rows show them: the outermost selected ones (a selected group's
 *  children are selected too, but it's the group that was picked). */
export function selectedKeys(layers: readonly AiNode[]): string[] {
  const out: string[] = [];
  const walk = (n: AiNode) => {
    if (n.kind !== "layer" && n.sel) { out.push(n.key); return; }
    for (const k of n.children ?? []) walk(k);
  };
  for (const l of layers) walk(l);
  return out;
}

/** Click / Ctrl+click / Shift+click on a row: the new selection and anchor. `order` is the
 *  rows' keys top to bottom. */
export function clickSelect(order: readonly string[], current: readonly string[], anchor: string | null, key: string, mods: { ctrl: boolean; shift: boolean }): { keys: string[]; anchor: string } {
  if (mods.shift && anchor !== null && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(key);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { keys: mods.ctrl ? [...new Set([...current, ...range])] : range, anchor };
  }
  if (mods.ctrl) return { keys: current.includes(key) ? current.filter(k => k !== key) : [...current, key], anchor: key };
  return { keys: [key], anchor: key };
}

/** Targets of an action on the selection: the outermost of `keys` (removing a layer removes what's
 *  in it), in row order. */
export function outermost(keys: readonly string[], order: readonly string[]): string[] {
  const set = keys.filter(k => !keys.some(o => o !== k && within(k, o)));
  return set.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export type Where = "before" | "after" | "inside";

/** Where a drop at `frac` (0 = row top, 1 = bottom) of a row lands. Containers take the middle;
 *  an open container's lower edge means "at its top, inside". */
export function dropWhere(n: AiNode, frac: number, open: boolean): Where {
  if (isContainer(n.kind)) {
    if (frac < 0.25) return "before";
    if (frac > 0.75 && !open) return "after";
    return "inside";
  }
  return frac < 0.5 ? "before" : "after";
}

/** Why `drag` can't go `where` `target` (null: it can). Same rules as the host script's `move`. */
export function dropProblem(drag: readonly AiNode[], target: AiNode, where: Where): string | null {
  if (!drag.length) return "没有要移动的";
  for (const d of drag) if (within(target.key, d.key)) return "不能移到它自己里面";
  const layers = drag.filter(d => d.kind === "layer");
  if (layers.length && layers.length !== drag.length) return "图层和对象不能一起拖";
  if (layers.length && target.kind !== "layer") return "图层只能放在图层旁边或图层里";
  if (where === "inside" && !isContainer(target.kind)) return "只能放进图层或编组";
  if (target.locked) return "目标已锁定";
  return null;
}

/** what a drop does, for the status line */
export function dropText(where: Where, target: AiNode, copy: boolean, n: number): string {
  const what = copy ? `复制 ${n} 个` : `移动 ${n} 个`;
  if (where === "inside" || (target.kind === "layer" && n > 0)) return `${what}到「${target.label}」${where === "after" && target.kind === "layer" ? "底部" : "里"}`;
  return `${what}到「${target.label}」${where === "before" ? "上方" : "下方"}`;
}

/** The open keys still pointing at the same thing (keys are places; after a change elsewhere a
 *  key may name another node): those whose label is unchanged. */
export function keepOpen(open: ReadonlyMap<string, string>, layers: readonly AiNode[]): Map<string, string> {
  const now = index(layers), out = new Map<string, string>();
  for (const [k, label] of open) { const n = now.get(k); if (n && n.label === label) out.set(k, label); }
  return out;
}

export const KIND_LABEL: Record<Kind, string> = {
  layer: "图层", path: "路径", compound: "复合路径", group: "编组", clip: "剪切组", text: "文字", placed: "链接文件",
  raster: "图像", symbol: "符号", mesh: "网格", plugin: "插件对象", graph: "图表", other: "对象",
};

/** the kinds the search filter offers */
export const FILTER_KINDS: Kind[] = ["path", "compound", "group", "clip", "text", "placed", "raster", "symbol"];
export const FILTER_FLAGS: [string, string][] = [["hidden", "隐藏"], ["locked", "锁定"], ["empty", "空"], ["linked", "已发到 PS"], ["missing", "缺失链接"]];

/** "3 个图层 · 已选 2" */
export function footerText(tree: AiTree): string {
  if (!tree.doc) return "没有打开的文档";
  const n = tree.layers?.length ?? 0, s = tree.selCount ?? 0;
  return `${n} 个图层` + (s ? ` · 已选 ${s}` : "");
}

/** The next row's key for ↑ / ↓ from the last selected one. */
export function neighbour(order: readonly string[], current: readonly string[], up: boolean): string | null {
  if (!order.length) return null;
  if (!current.length) return order[up ? order.length - 1 : 0];
  const i = Math.max(...current.map(k => order.indexOf(k)));
  const j = up ? Math.max(0, Math.min(...current.map(k => order.indexOf(k)).filter(x => x >= 0)) - 1) : Math.min(order.length - 1, i + 1);
  return order[j] ?? null;
}
