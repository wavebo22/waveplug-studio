// 图层树的连接线 (like a file tree / Blender's outliner): for each row in the list as shown, one
// mark per level of indent —
//   "pipe"  │  an ancestor's children go on below this row
//   "tee"   ├  this layer, and its parent has more children below it
//   "elbow" └  this layer is its parent's last child shown (the line ends here)
//   "blank"    nothing: that ancestor's children ended above
// A row under a layer (its effects, smart filters, variations) continues the lines of that layer and
// leaves its own last column blank. `hot`: the marks on the selected layers' own path (their parent
// group's line), drawn in the selection colour so that it is clear which group a layer belongs to.

export type Guide = "pipe" | "tee" | "elbow" | "blank";
export interface GuideRow { id: number; depth: number; parentId: number | null; sub?: boolean }
export interface GuideMark { kind: Guide; hot: boolean }

export function treeGuides(rows: readonly GuideRow[], selected: ReadonlySet<number> = new Set()): GuideMark[][] {
  const n = rows.length;
  // last among its siblings shown: no later layer row at the same depth before one less deep
  const last: boolean[] = new Array(n).fill(false);
  const later: boolean[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.sub) continue;
    const d = Math.max(0, r.depth);
    last[i] = !later[d];
    later[d] = true;
    later.length = d + 1;
  }
  // parents whose line is lit: the groups holding a selected layer (its direct parent)
  const hotParents = new Set<number>();
  for (const r of rows) if (!r.sub && selected.has(r.id) && r.parentId !== null) hotParents.add(r.parentId);
  const out: GuideMark[][] = [];
  // per depth on the current path: the line goes on below (not last), and whose children it carries
  const cont: boolean[] = [];
  const pathParent: (number | null)[] = [];
  /** the line in column c belongs to the children of the ancestor at depth c */
  const hot = (c: number) => { const p = pathParent[c + 1]; return p !== null && p !== undefined && hotParents.has(p); };
  for (let i = 0; i < n; i++) {
    const r = rows[i], d = Math.max(0, r.depth);
    if (r.sub) {
      // the layer's own lines carry on; its own column (d) is the sub row's lead, blank
      const marks: GuideMark[] = [];
      for (let c = 0; c < d; c++) marks.push({ kind: cont[c + 1] ? "pipe" : "blank", hot: !!cont[c + 1] && hot(c) });
      marks.push({ kind: "blank", hot: false });
      out.push(marks);
      continue;
    }
    pathParent[d] = r.parentId;
    pathParent.length = d + 1;
    const marks: GuideMark[] = [];
    for (let c = 0; c < d - 1; c++) marks.push({ kind: cont[c + 1] ? "pipe" : "blank", hot: !!cont[c + 1] && hot(c) });
    if (d > 0) marks.push({ kind: last[i] ? "elbow" : "tee", hot: hot(d - 1) });
    out.push(marks);
    cont[d] = !last[i];
    cont.length = d + 1;
  }
  return out;
}

/** the marks as a short key (a row is redrawn when its lines change) */
export const guideKey = (marks: readonly GuideMark[] | undefined) =>
  (marks ?? []).map(m => (m.kind === "pipe" ? "|" : m.kind === "tee" ? "+" : m.kind === "elbow" ? "L" : ".") + (m.hot ? "*" : "")).join("");
