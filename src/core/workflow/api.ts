// ComfyUI "API format" workflow: { [nodeId]: { class_type, inputs, _meta } }.
// An input value is either a literal (widget value) or a link [sourceNodeId, outputIndex].

export type Link = [string, number];
export type InputValue = string | number | boolean | null | Link | unknown[] | Record<string, unknown>;

export interface ApiNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta?: { title?: string };
}
export type ApiGraph = Record<string, ApiNode>;

export function isLink(v: unknown): v is Link {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
}

export function title(g: ApiGraph, id: string): string {
  return g[id]?._meta?.title ?? g[id]?.class_type ?? id;
}

export function cloneGraph(g: ApiGraph): ApiGraph {
  return JSON.parse(JSON.stringify(g)) as ApiGraph;
}

/** Accepts parsed JSON and returns it as an API graph, or throws a readable error. */
export function asApiGraph(json: unknown): ApiGraph {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("不是有效的 JSON 对象");
  const o = json as Record<string, unknown>;
  if (Array.isArray(o.nodes) && Array.isArray(o.links)) {
    throw new Error("这是 ComfyUI 界面格式的工作流，请在 ComfyUI 中用「导出 (API)」保存后再导入");
  }
  const g: ApiGraph = {};
  for (const [id, n] of Object.entries(o)) {
    if (!n || typeof n !== "object") throw new Error(`节点 ${id} 格式错误`);
    const node = n as ApiNode;
    if (typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
      throw new Error(`节点 ${id} 缺少 class_type / inputs，不是 API 格式`);
    }
    g[id] = node;
  }
  if (!Object.keys(g).length) throw new Error("工作流为空");
  return g;
}

export interface Edge { from: string; slot: number; to: string; input: string }

/** All links in the graph, source → consumer. */
export function edges(g: ApiGraph): Edge[] {
  const out: Edge[] = [];
  for (const [to, n] of Object.entries(g)) {
    for (const [input, v] of Object.entries(n.inputs)) if (isLink(v)) out.push({ from: v[0], slot: v[1], to, input });
  }
  return out;
}

export function consumers(g: ApiGraph, id: string, slot?: number): Edge[] {
  return edges(g).filter(e => e.from === id && (slot === undefined || e.slot === slot));
}

/** Breadth-first set of nodes reachable downstream from `id` (excluding itself). */
export function downstream(g: ApiGraph, id: string, maxDepth = 12): Set<string> {
  const all = edges(g), seen = new Set<string>();
  let frontier = [id];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) for (const e of all) if (e.from === f && !seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
    frontier = next;
  }
  return seen;
}

/**
 * Follow a linked input upstream until reaching a node input that holds a literal of the wanted
 * primitive type. Pass-through nodes (one linked input, e.g. "easy float", primitives) are walked.
 */
export function literalSource(
  g: ApiGraph, nodeId: string, input: string, want: "number" | "string" | "boolean", maxDepth = 6,
): { nodeId: string; input: string } | null {
  let cur = { nodeId, input };
  for (let d = 0; d <= maxDepth; d++) {
    const v = g[cur.nodeId]?.inputs[cur.input];
    if (typeof v === want) return cur;
    if (!isLink(v)) return null;
    const src = g[v[0]];
    if (!src) return null;
    const literals = Object.entries(src.inputs).filter(([, x]) => typeof x === want);
    const links = Object.entries(src.inputs).filter(([, x]) => isLink(x));
    if (literals.length === 1 && links.length === 0) return { nodeId: v[0], input: literals[0][0] };
    if (literals.length === 0 && links.length === 1) { cur = { nodeId: v[0], input: links[0][0] }; continue; }
    return null;
  }
  return null;
}
