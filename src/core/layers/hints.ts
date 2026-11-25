// 提示栏 (the line at the bottom of the WaveLayer panel, like Blender's status bar): which mouse /
// key actions apply where the pointer is now, what the panel is in (selection, filters, modes), and
// the last results. Pure: the panel tells what it sees, this says what to show.

import type { LayerKind } from "./tree.ts";

/** the part of the panel under the pointer */
export type HintZone =
  | "row" | "name" | "thumb" | "mask" | "vmask" | "filterMask" | "eye" | "fx" | "filters" | "chip"
  | "lock" | "variant" | "twisty" | "blank" | "tool" | "none";

export interface HeldKeys { ctrl: boolean; shift: boolean; alt: boolean }
export const NO_KEYS: HeldKeys = { ctrl: false, shift: false, alt: false };

export interface HintInput {
  mode: "idle" | "drag" | "fileDrag" | "rename";
  zone?: HintZone;
  /** the layer under the pointer */
  kind?: LayerKind;
  artboard?: boolean;
  variant?: boolean;
  /** what Photoshop paints on for the selected layer: its pixels or one of its masks */
  target?: "layer" | "mask" | "vmask" | "filterMask" | null;
  /** the mask under the pointer is on (false: 已停用) */
  maskOn?: boolean;
  /** a mask is shown alone / in red (Alt+click) */
  maskView?: boolean;
  /** a layer (or a mask, effect …) being dragged */
  drag?: {
    region: "list" | "outside" | "tool" | "trash" | "workbench";
    /** what is dragged instead of layers: "mask", "effects", "filter" … */
    sub?: string | null;
    /** the toolbar button under the pointer: what letting go there does */
    tool?: "groupLayers" | "duplicate" | "delete" | "stampSelected" | null;
    canDelete: boolean;
    /** files for other programs being prepared (done / total), or ready */
    export?: { done: number; total: number; ready: boolean } | null;
  };
  /** files / web content from another program over the panel */
  fileDrag?: { count: number; fromWeb: boolean };
  keys: HeldKeys;
}

/** one hint: keys / mouse buttons, and what they do; `on`: its modifiers are the ones held now */
export interface HintItem { keys: string[]; label: string; on?: boolean }

const MODS = ["Ctrl", "Shift", "Alt"] as const;
const held = (k: HeldKeys, m: string) => m === "Ctrl" ? k.ctrl : m === "Shift" ? k.shift : m === "Alt" ? k.alt : false;
/** the item's modifiers are exactly the held ones (an item without modifiers is never lit) */
function lit(item: HintItem, k: HeldKeys): boolean {
  const mods = item.keys.filter(x => (MODS as readonly string[]).includes(x));
  if (!mods.length) return false;
  return MODS.every(m => mods.includes(m) === held(k, m));
}
const it = (keys: string[], label: string): HintItem => ({ keys, label });

/** The hints for what the pointer is on now, most used first. */
export function hintItems(h: HintInput): HintItem[] {
  return mark(itemsFor(h), h.keys);
}

function mark(items: HintItem[], k: HeldKeys): HintItem[] {
  return items.map(i => lit(i, k) ? { ...i, on: true } : i);
}

function itemsFor(h: HintInput): HintItem[] {
  if (h.mode === "rename") return [it(["Enter"], "确定"), it(["Esc"], "取消")];
  if (h.mode === "fileDrag") {
    const f = h.fileDrag;
    if (f?.fromWeb) return [it(["松开"], "置入网页内容（图片嵌入为智能对象，文字新建文字图层）")];
    const n = f && f.count > 1 ? ` ${f.count} 个文件` : "";
    // the mode itself is the bar's badge (嵌入 / 链接); the hints say how to change it
    return h.keys.alt
      ? [it(["松开"], `链接${n}到插入线位置`), it(["Alt"], "放开 Alt 改为嵌入"), it(["移出面板"], "取消")]
      : [it(["松开"], `嵌入${n}到插入线位置`), it(["Alt"], "按住改为链接"), it(["移出面板"], "取消")];
  }
  if (h.mode === "drag" && h.drag) return dragItems(h);
  return idleItems(h);
}

function dragItems(h: HintInput): HintItem[] {
  const d = h.drag!, what = d.sub ? subName(d.sub) : "图层";
  if (d.region === "trash") return d.canDelete ? [it(["松开"], `删除${what}`)] : [it(["松开"], `这些${what}不能删除`)];
  if (d.region === "workbench") return [it(["松开"], "加入工作台（原 PSD 不改）")];
  if (d.region === "tool") {
    const label = d.tool === "groupLayers" ? "从图层新建组" : d.tool === "duplicate" ? "复制图层" : d.tool === "stampSelected" ? "创建合并图（原图层不变）" : d.tool === "delete" ? (d.canDelete ? `删除${what}` : `这些${what}不能删除`) : "松开取消";
    return [it(["松开"], label), it(["Esc"], "取消")];
  }
  if (d.region === "outside") {
    const e = d.export;
    const out = !e ? "拖到其他软件：复制为 PNG" : e.ready ? "松开：复制到光标下的软件" : `正在准备 ${e.done}/${e.total} 个文件…`;
    return [it(["其他软件"], out), it(["左侧红区"], d.canDelete ? `删除${what}` : `${what}不能删除`), it(["拖回面板"], "继续排序")];
  }
  // in the list
  if (d.sub === "mask" || d.sub === "vmask" || d.sub === "filterMask")
    return [it(["松开"], "移到这个图层"), it(["Alt", "松开"], "复制到这个图层"), it(["拖到垃圾桶"], "删除蒙版"), it(["Esc"], "取消")];
  if (d.sub === "effects" || d.sub === "effect" || d.sub === "filters" || d.sub === "filter")
    return [it(["松开"], `移到这个图层`), it(["Alt", "松开"], "复制过去"), it(["拖到垃圾桶"], `删除${what}`), it(["Esc"], "取消")];
  if (d.sub === "variant") return [it(["松开"], "放到这里"), it(["拖到垃圾桶"], "删除变体"), it(["Esc"], "取消")];
  return [it(["松开"], "放到这里（拖到组中间：放进组）"), it(["Alt", "松开"], "复制到这里"), it(["拖出面板"], "复制到其他软件 / 删除"), it(["Esc"], "取消")];
}

function subName(sub: string): string {
  return sub === "mask" ? "图层蒙版" : sub === "vmask" ? "矢量蒙版" : sub === "filterMask" ? "智能滤镜蒙版"
    : sub === "effects" ? "图层样式" : sub === "effect" ? "效果" : sub === "filters" ? "智能滤镜" : sub === "filter" ? "滤镜"
    : sub === "variant" ? "变体" : "图层";
}

function idleItems(h: HintInput): HintItem[] {
  const z = h.zone ?? "none";
  const editing = h.target && h.target !== "layer"
    ? [it(["键盘"], `快捷键作用在${h.target === "mask" ? "图层蒙版" : h.target === "vmask" ? "矢量蒙版" : "智能滤镜蒙版"}上（单击图层缩略图回到图层）`)] : [];
  switch (z) {
    case "mask": case "filterMask":
      return [...(z === "mask" && h.maskOn === false ? [it(["已停用"], "PS 不使用这个蒙版")] : []),
        it(["左键"], "编辑蒙版"), ...(z === "mask" ? [it(["Shift", "左键"], h.maskOn === false ? "启用蒙版" : "停用蒙版")] : []), it(["Alt", "左键"], h.maskView ? "恢复显示" : "只看蒙版"),
        it(["Alt", "Shift", "左键"], "红色叠加"), it(["Ctrl", "左键"], "载入选区"), it(["拖动"], "移到其他图层（Alt 复制）")];
    case "vmask":
      return [...(h.maskOn === false ? [it(["已停用"], "PS 不使用这个矢量蒙版")] : []),
        it(["左键"], "选中矢量蒙版"), it(["Shift", "左键"], h.maskOn === false ? "启用矢量蒙版" : "停用矢量蒙版"), it(["Ctrl", "左键"], "载入选区"), it(["拖动"], "移到其他图层（Alt 复制）")];
    case "thumb": {
      const dbl = h.kind === "smartObject" ? [it(["双击"], "编辑智能对象内容")] : h.artboard ? [it(["双击"], "画板颜色")] : [];
      return [it(["左键"], "编辑图层像素"), ...dbl, it(["Ctrl", "左键"], "载入选区"), it(["Ctrl", "Shift", "左键"], "添加到选区"),
        it(["Ctrl", "Alt", "左键"], "从选区减去"), ...editing];
    }
    case "eye": return [it(["左键"], "显示 / 隐藏"), it(["拖动"], "连续切换多行"), it(["Alt", "左键"], "只显示这个图层")];
    case "fx": return [it(["左键"], "展开 / 收起效果"), it(["右键"], "图层样式选项"), it(["拖动"], "移到其他图层（Alt 复制）")];
    case "filters": return [it(["左键"], "展开 / 收起智能滤镜"), it(["拖动"], "移到其他智能对象（Alt 复制）")];
    case "chip": return [it(["左键"], "开 / 关"), it(["双击"], "编辑设置"), it(["拖动"], "换位置 / 移到其他图层（Alt 复制）")];
    case "lock": return [it(["双击"], h.kind === "background" ? "转为普通图层" : "解除全部锁定")];
    case "variant": return [it(["双击"], "打开 / 收起变体栏")];
    case "twisty": return [it(["左键"], "展开 / 折叠组")];
    case "blank": return [it(["左键"], "取消全选"), it(["右键"], "图层菜单")];
    case "tool": return [it(["左键"], "执行"), it(["拖图层到这里"], "新建组 / 复制 / 删除 / 合并图")];
    case "name": case "row":
      return [it(["左键"], "选中"), it(["Ctrl", "左键"], "加选 / 减选"), it(["Shift", "左键"], "连续选择"),
        it(["双击"], z === "name" ? "重命名" : "图层样式"), it(["右键"], "菜单"), it(["拖动"], "排序（拖出面板：其他软件）"), ...editing];
    default: return editing.length ? editing : [it(["提示"], "鼠标移到 WavePlug 图层面板上，这里显示可用的操作")];
  }
}

/** the middle of the bar: what the panel is in now */
export type StatePart = { text: string; kind: "info" | "filter" | "mode" | "warn"; tip?: string; action?: "clearFilters" };

export function stateParts(s: {
  docOpen: boolean;
  selection: string;
  filter: { active: boolean; paused: boolean; shown: number; total: number; what: string };
  native: boolean; shortcutsOff: boolean; helper: boolean;
}): StatePart[] {
  const out: StatePart[] = [];
  if (!s.helper) out.push({ text: "helper 未连接", kind: "warn", tip: "外置 helper 没有连接：跨软件拖拽、悬停边框、按键提示等不可用" });
  if (!s.docOpen) return out;
  if (s.filter.active && !s.filter.paused)
    out.push({ text: `已筛选 ${s.filter.shown}/${s.filter.total}${s.filter.what ? " · " + s.filter.what : ""}`, kind: "filter", tip: "单击：清除筛选", action: "clearFilters" });
  else if (s.filter.active) out.push({ text: "筛选已暂停", kind: "mode", tip: "单击：清除筛选", action: "clearFilters" });
  if (s.native) out.push({ text: "原版命令", kind: "mode", tip: "删除、编组、合并等用 Photoshop 自己的菜单命令执行" });
  if (s.shortcutsOff) out.push({ text: "面板快捷键关", kind: "mode", tip: "面板菜单（左下角）里可以重新打开" });
  if (s.selection) out.push({ text: s.selection, kind: "info" });
  return out;
}

/** the last results, newest first, at most `max` */
export interface HintMessage { text: string; kind: "info" | "ok" | "error" | "busy"; at: number }
export function pushMessage(list: readonly HintMessage[], m: HintMessage, max = 10): HintMessage[] {
  // a busy line replaced by its outcome: keep one line per operation
  const rest = list[0]?.kind === "busy" ? list.slice(1) : list.slice();
  if (m.kind === "busy" && rest[0]?.kind === "busy") rest.shift();
  return [m, ...rest].slice(0, max);
}
/** how long a message stays on the bar (errors stay until the next one) */
export function messageLife(kind: HintMessage["kind"]): number | null {
  return kind === "error" || kind === "busy" ? null : kind === "ok" ? 4000 : 3000;
}
