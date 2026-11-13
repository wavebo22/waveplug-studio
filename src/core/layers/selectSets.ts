// 「选择」命令: which layers a "select …" command of the WavePlug 图层 panel picks, worked out from
// the tree that is already read (no Photoshop query). The panel then makes them the selection
// through the ordinary select path, so every existing command (delete, group, lock, drag …)
// works on the result. Tested in tests/layer_select_sets.test.ts.

import { type TreeLayer, isVariantLayer } from "./tree.ts";

export type SelectSet = "all" | "invert" | "similar" | "linked" | "sameColor" | "siblings" | "hidden" | "empty";

export interface SelectChoice {
  which: SelectSet;
  label: string;
  hint: string;
  /** the selection it would make, in list order */
  ids: number[];
  /** false when it has nothing to select or would change nothing */
  enabled: boolean;
  disabledReason?: string;
}

/** A layer's kind for 选择相似图层: a 变体图层 (AI result group) is a kind of its own. */
const similarKind = (l: TreeLayer) => isVariantLayer(l) ? "variant" : l.kind;

const isEmpty = (l: TreeLayer) => l.kind === "pixel" && l.width === 0 && l.height === 0;

/**
 * The layers `which` selects, in list order. Never the versions inside a 变体图层 (the panel shows
 * such a group as one row). 反向选择 and 隐藏的图层 pick whole groups, not a group and its layers.
 */
export function selectSet(layers: readonly TreeLayer[], selected: ReadonlySet<number>, which: SelectSet): number[] {
  const byId = new Map(layers.map(l => [l.id, l]));
  const chain = (l: TreeLayer) => {
    const out: TreeLayer[] = [];
    for (let p = l.parentId === null ? undefined : byId.get(l.parentId); p; p = p.parentId === null ? undefined : byId.get(p.parentId)) out.push(p);
    return out;
  };
  // the rows a command may pick: not the versions inside a 变体图层
  const pickable = layers.filter(l => !chain(l).some(isVariantLayer));
  const sel = pickable.filter(l => selected.has(l.id));
  /** Only the outermost of `pick`: a layer whose group is also picked is left out. */
  const outermost = (pick: (l: TreeLayer) => boolean) => {
    const out = new Set<number>();
    for (const l of pickable) if (pick(l) && !chain(l).some(p => out.has(p.id))) out.add(l.id);
    return pickable.filter(l => out.has(l.id)).map(l => l.id);
  };
  const ids = (pick: (l: TreeLayer) => boolean) => pickable.filter(pick).map(l => l.id);

  switch (which) {
    // as Photoshop's 选择 › 所有图层: everything but the background
    case "all": return ids(l => l.kind !== "background");
    case "invert": {
      // a group holding a selected layer stays out (selecting it would take that layer back in)
      const holders = new Set(sel.flatMap(l => chain(l).map(p => p.id)));
      const inside = (l: TreeLayer) => chain(l).some(p => selected.has(p.id));
      return outermost(l => !selected.has(l.id) && !holders.has(l.id) && !inside(l) && l.kind !== "background");
    }
    case "similar": {
      const kinds = new Set(sel.map(similarKind));
      return ids(l => kinds.has(similarKind(l)));
    }
    case "linked": {
      const peers = new Set<number>(sel.map(l => l.id));
      for (const l of sel) for (const id of l.links) peers.add(id);
      // Photoshop lists a layer's partners; also take layers that list a selected one
      for (const l of layers) if (l.links.some(id => selected.has(id))) peers.add(l.id);
      return ids(l => peers.has(l.id));
    }
    case "sameColor": {
      const colors = new Set(sel.map(l => l.color).filter(c => c && c !== "none"));
      return ids(l => colors.has(l.color));
    }
    case "siblings": {
      const parents = new Set(sel.map(l => l.parentId));
      return sel.length ? ids(l => parents.has(l.parentId) && l.kind !== "background") : [];
    }
    case "hidden": return outermost(l => !l.visible && l.kind !== "background");
    case "empty": return ids(isEmpty);
  }
}

const same = (ids: readonly number[], selected: ReadonlySet<number>) => ids.length === selected.size && ids.every(id => selected.has(id));

/** The 选择 menu for the current selection: each command with what it would select. */
export function selectMenu(layers: readonly TreeLayer[], selected: ReadonlySet<number>): SelectChoice[] {
  const has = selected.size > 0;
  const sel = layers.filter(l => selected.has(l.id));
  const choice = (which: SelectSet, label: string, hint: string, needs: string | null, none: string): SelectChoice => {
    const ids = needs ? [] : selectSet(layers, selected, which);
    const reason = needs ?? (!ids.length ? none : same(ids, selected) ? "已经是当前的选择" : undefined);
    return { which, label, hint, ids, enabled: !reason, disabledReason: reason };
  };
  const pick = has ? null : "请先选中图层";
  return [
    choice("all", "所有图层", "除背景以外的全部图层", null, "没有可选的图层"),
    choice("invert", "反向选择", "改选其余的图层；整个组没被选中时只选组本身", pick, "没有其余的图层"),
    choice("similar", "相似图层", "和选中图层同一类型的全部图层（文字、形状、智能对象、变体图层…）", pick, "没有同类型的图层"),
    choice("sameColor", "相同颜色的图层", "和选中图层颜色标签相同的全部图层",
      pick ?? (sel.some(l => l.color && l.color !== "none") ? null : "选中的图层没有颜色标签"), "没有相同颜色的图层"),
    choice("linked", "链接的图层", "和选中图层链接在一起的图层",
      pick ?? (sel.some(l => l.links.length > 0) || layers.some(l => l.links.some(id => selected.has(id))) ? null : "选中的图层没有链接"), "没有链接的图层"),
    choice("siblings", "同一组内的图层", "和选中图层在同一个组（或同在最外层）的全部图层", pick, "没有同组的图层"),
    choice("hidden", "隐藏的图层", "全部隐藏的图层和组（之后可以一次删除或显示）", null, "没有隐藏的图层"),
    choice("empty", "空图层", "没有任何像素的普通图层（之后可以一次删除）", null, "没有空图层"),
  ];
}
