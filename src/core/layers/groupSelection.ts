// Ctrl+单击组的图标：组的选区 = 组里看得见的图层的像素合在一起。
// 填充图层和调整图层不算（它们铺满整个画布，算进去选区就成了全图）；剪贴到下方的图层只在底图范围内显示，
// 也不算；隐藏的图层、隐藏的子组里的图层、空图层不算。子组本身不出像素，算的是它里面的图层。

import type { TreeLayer } from "./tree.ts";

const NO_PIXELS = new Set(["group", "adjustment", "fill"]);

/** the layers whose pixels make up group `groupId`'s selection, in list order */
export function groupSelectionLayers(layers: readonly TreeLayer[], groupId: number): number[] {
  const byId = new Map(layers.map(l => [l.id, l]));
  /** inside the group, with it and every group in between shown (the clicked group itself may be hidden) */
  const shownInside = (l: TreeLayer): boolean => {
    for (let p = l.parentId; p !== null; ) {
      if (p === groupId) return true;
      const g = byId.get(p);
      if (!g || !g.visible) return false;
      p = g.parentId;
    }
    return false;
  };
  return layers
    .filter(l => !NO_PIXELS.has(l.kind) && l.visible && !l.clipped && !(l.kind === "pixel" && l.width === 0 && l.height === 0) && shownInside(l))
    .map(l => l.id);
}
