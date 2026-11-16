// 原版命令（测试）: WaveLayer commands run as Photoshop's own menu items instead of the plugin's
// wrapped batchPlay (one history step, extra checks). The rows are selected in Photoshop first,
// then the menu item runs on that selection, exactly as if it were clicked in Photoshop's menu.
//
// Only items whose title is unambiguous are listed: a title found more than once (and not settled
// by a nearby anchor) is never guessed — the command then runs the plugin's way, and the log says so.

/** localStorage key of the switch ("on" / anything else = off) */
export const NATIVE_COMMANDS_KEY = "wp.layers.nativeCommands";

/** a menu item by its titles (Chinese, English; compared without spaces, dots and &) */
export interface MenuSpec { titles: string[]; near?: string[] }

/** Commands that go to Photoshop's menu while the switch is on. */
export const NATIVE_MENU: Readonly<Record<string, MenuSpec>> = {
  groupLayers: { titles: ["图层编组", "GroupLayers"] },
  ungroup: { titles: ["取消图层编组", "UngroupLayers"] },
  merge: { titles: ["合并图层", "MergeLayers"] },
  mergeDown: { titles: ["向下合并", "MergeDown"] },
  mergeVisible: { titles: ["合并可见图层", "MergeVisible"] },
  flatten: { titles: ["拼合图像", "FlattenImage"] },
  convertSmart: { titles: ["转换为智能对象", "ConverttoSmartObject"] },
  smartViaCopy: { titles: ["通过拷贝新建智能对象", "NewSmartObjectviaCopy"] },
  embedLinked: { titles: ["嵌入链接的智能对象", "EmbedLinked"] },
  clip: { titles: ["创建剪贴蒙版", "CreateClippingMask"] },
  unclip: { titles: ["释放剪贴蒙版", "ReleaseClippingMask"] },
  copyStyle: { titles: ["拷贝图层样式", "CopyLayerStyle"] },
  pasteStyle: { titles: ["粘贴图层样式", "PasteLayerStyle"] },
  clearStyle: { titles: ["清除图层样式", "ClearLayerStyle"] },
};

/** Commands Photoshop records as one plain action (no menu title of their own to find safely):
 *  run as that action on the selection, with Photoshop's own history name. */
export const NATIVE_ACTIONS = new Set(["delete"]);

export const isNativeCommand = (action: string) => action in NATIVE_MENU || NATIVE_ACTIONS.has(action);

/** The menu id to run: the only one found; with anchors, the single nearest within `maxGap` ids.
 *  Anything less certain is undefined (the command then runs the plugin's way). */
export function pickMenuId(found: readonly number[], anchors: readonly number[] = [], maxGap = 40): number | undefined {
  const ids = [...new Set(found)];
  if (!anchors.length) return ids.length === 1 ? ids[0] : undefined;
  const dist = (id: number) => Math.min(...anchors.map(a => Math.abs(a - id)));
  const near = ids.filter(id => dist(id) <= maxGap).sort((a, b) => dist(a) - dist(b));
  if (!near.length) return undefined;
  if (near.length > 1 && dist(near[0]) === dist(near[1])) return undefined;
  return near[0];
}

/** what a native delete did: ids gone, ids still there */
export function nativeDeleteOutcome(requested: readonly number[], surviving: ReadonlySet<number>, names: ReadonlyMap<number, string>) {
  const deleted = requested.filter(id => !surviving.has(id));
  const skipped = requested.filter(id => surviving.has(id))
    .map(id => ({ id, name: names.get(id) ?? "#" + id, reason: "Photoshop 没有删除这个图层" }));
  return { deleted, skipped };
}
