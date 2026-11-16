// 外置删除区 (native/overlay/src/drag/trash.rs): while a WaveLayer drag runs, the helper shows a
// red square with a trash can beside the panel; letting go over it deletes what was dragged. The
// helper decides the hover and the release (one hit test with the drag card); the plugin says what
// the card reads there and does the deleting. Pure (tests/drag_trash.test.ts).
import type { DeleteDragPart } from "./tree.ts";

/** What the card says over the square: what letting go deletes. */
export function trashAction(count: number, part?: DeleteDragPart): string {
  switch (part) {
    case "mask": return "松开删除图层蒙版";
    case "vmask": return "松开删除矢量蒙版";
    case "filterMask": return "松开删除智能滤镜蒙版";
    case "filter": return "松开删除这个智能滤镜";
    case "filters": return "松开删除全部智能滤镜";
    case "effect": return "松开删除这个效果";
    case "effects": return "松开清除图层样式";
    case "variant": return "松开删除这个变体";
    default: return count > 1 ? `松开删除 ${count} 个图层` : "松开删除图层";
  }
}

/** How long after the panel's own release a drop on the square still names that drag: the
 *  helper's message can come just before or just after the panel sees the mouseup. */
export const TRASH_DROP_MS = 3000;

/** Which drag the helper's drop means: the one still under way (the release comes next), else
 *  the one that ended last, if it ended within TRASH_DROP_MS and could show the square. */
export function trashDropTarget<T extends { trash: boolean }>(
  live: T | null, recent: { drag: T; at: number } | null, now: number,
): { drag: T; live: boolean } | null {
  if (live?.trash) return { drag: live, live: true };
  if (recent && recent.drag.trash && now - recent.at >= 0 && now - recent.at < TRASH_DROP_MS) return { drag: recent.drag, live: false };
  return null;
}
