// 批量重命名: the new names of several layers from one rule — find / replace, a prefix and a
// suffix, and a running number. Pure (tested in tests/batch_rename.test.ts); the 工具 page shows the
// result before anything is renamed, Photoshop then sets the names in one undo step.

export interface RenameOptions {
  /** text to look for in each name; empty: the whole name is kept (or replaced, see `replace`) */
  find: string;
  /** what `find` becomes; with an empty `find` and text here, the whole name becomes this */
  replace: string;
  prefix: string;
  suffix: string;
  /** add a running number at the end, in list order */
  number: boolean;
  start: number;
  /** at least this many digits (01, 02 …) */
  digits: number;
}

export const RENAME_DEFAULTS: RenameOptions = { find: "", replace: "", prefix: "", suffix: "", number: false, start: 1, digits: 2 };

/** Photoshop's limit on a layer name */
const MAX_NAME = 255;

/** Whether the rule changes anything at all. */
export const renameActive = (o: RenameOptions): boolean => !!(o.find || o.replace || o.prefix || o.suffix || o.number);

/** One layer's new name (`index`: its place among the layers being renamed, from 0). */
export function renamed(name: string, index: number, o: RenameOptions): string {
  let base = o.find ? name.split(o.find).join(o.replace) : o.replace ? o.replace : name;
  base = o.prefix + base + o.suffix;
  if (o.number) {
    const n = String(Math.max(0, Math.round(o.start) || 0) + index).padStart(Math.max(1, Math.min(6, Math.round(o.digits) || 1)), "0");
    base = base ? `${base} ${n}` : n;
  }
  return base.replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_NAME);
}

/** The layers whose name changes, in the order given, with the old and the new name. A layer
 *  whose new name would be empty is left alone. */
export function renamePlan(layers: readonly { id: number; name: string }[], o: RenameOptions): { id: number; from: string; to: string }[] {
  if (!renameActive(o)) return [];
  return layers.map((l, i) => ({ id: l.id, from: l.name, to: renamed(l.name, i, o) })).filter(x => x.to && x.to !== x.from);
}
