// 右键菜单: the WaveLayer context menu as one tree — a title, everyday commands, and submenus by
// subject (the way Blender lays out its context menus). The same tree is shown by the native
// helper at the mouse (native/overlay/src/menu.rs, submenus opening to the side) or, without the
// helper, by the panel's own popup. Rows carry ids only; LayerTree.runMenu turns an id into the
// command. Worked out from the tree already read: opening the menu asks Photoshop nothing.

import type { MenuNode } from "../overlay/protocol.ts";
import { WORKBENCH_ENABLED } from "./workbench.ts";
import { selectMenu } from "./selectSets.ts";
import { type MenuItem, type TreeLayer, ALIGNS, DISTRIBUTES, arrangeProblem, arrangeTarget, isVariantLayer, layerMenu, smartQuickMenu } from "./tree.ts";

/** Photoshop's shortcuts, shown at the right (the panel runs the same ones, LayerTree keydown). */
const SHORTCUTS: Record<string, string> = {
  duplicate: "Ctrl+J", groupLayers: "Ctrl+G", ungroup: "Shift+Ctrl+G", merge: "Ctrl+E", mergeDown: "Ctrl+E",
  mergeVisible: "Shift+Ctrl+E", clip: "Alt+Ctrl+G", unclip: "Alt+Ctrl+G", lock: "Ctrl+/", unlock: "Ctrl+/",
};
const ARRANGE: ["front" | "forward" | "backward" | "back", string, string][] = [
  ["front", "置为顶层", "Shift+Ctrl+]"], ["forward", "前移一层", "Ctrl+]"],
  ["backward", "后移一层", "Ctrl+["], ["back", "置为底层", "Shift+Ctrl+["],
];
const KIND_NAMES: Record<string, string> = {
  pixel: "像素图层", adjustment: "调整图层", text: "文字图层", shape: "形状图层", smartObject: "智能对象",
  group: "图层组", fill: "填充图层", background: "背景", other: "图层",
};

export interface ContextMenuInput {
  layers: TreeLayer[];
  selected: ReadonlySet<number>;
  /** smart objects sharing each content (contentUsers) */
  users: ReadonlyMap<string, number>;
  /** the 工具 page's smart-object commands are available (替换内容, 解包 …) */
  smartTools: boolean;
  /** 图层颜色 labels: Photoshop's key and its name */
  colors: readonly (readonly [string, string])[];
  /** AI 助手 is available: row "assist:organize" (AI 整理图层) */
  assistant?: boolean;
  /** 发送到: the other open documents, and the settings shown as check rows */
  send?: {
    docs: readonly { id: number; name: string }[];
    prefs: { restore: boolean; scaleLongEdge?: boolean; scaleWithCanvas: boolean; matchParents: boolean; position: "top" | "selection"; switchAfter: boolean };
    /** the WaveLayer panel in Illustrator is connected (牵手 Illustrator): row "send:ai" */
    illustrator?: boolean;
    /** the right-clicked layer came from Illustrator (a link): rows "ai:update" / "ai:reveal" */
    illustratorLink?: boolean;
  };
}

/** 发送到 ▸ documents, then its settings (rows "send:<docId>" / "sendopt:<which>"), and 加入工作台. */
export function sendMenu(send: NonNullable<ContextMenuInput["send"]>, n: number): MenuNode[] {
  const p = send.prefs;
  const docs: MenuNode[] = send.docs.length
    ? send.docs.map(d => ({ id: "send:" + d.id, label: short(d.name || "文档 " + d.id), enabled: n > 0 }))
    : [{ id: "send:none", label: "没有其他打开的文档", enabled: false }];
  return [
    ...(send.illustrator ? [
      { id: "send:ai", label: "Illustrator：选中的图层", enabled: n > 0 },
      { id: "send:aiboard", label: "Illustrator：当前画板全部（新画板，保留可编辑）", enabled: true },
      { separator: true }] : []),
    ...docs,
    { separator: true },
    { id: "sendopt:restore", label: "还原画面位置", checked: p.restore },
    { id: "sendopt:longEdge", label: "按长边缩放（当前画面为 100%）", checked: !!p.scaleLongEdge, enabled: p.restore },
    { id: "sendopt:scale", label: "随画布缩放", checked: p.scaleWithCanvas, enabled: p.restore },
    { id: "sendopt:parents", label: "放进同名的组 / 画板", checked: p.matchParents },
    { id: "sendopt:position", label: "否则放在选中图层上方", checked: p.position === "selection" },
    { id: "sendopt:switch", label: "发送后切到目标文档", checked: p.switchAfter },
  ];
}

const sep: MenuNode = { separator: true };
/** what 裁剪边缘 / 拆分像素岛 work on */
const pixels = (l: TreeLayer) => l.kind === "pixel" || l.kind === "smartObject";
const short = (name: string) => name.length > 22 ? name.slice(0, 21) + "…" : name;

/** The menu's title: what was right-clicked, and for a smart object its content type and sharing. */
export function contextTitle(sel: readonly TreeLayer[], users: ReadonlyMap<string, number>): string {
  if (!sel.length) return "图层";
  if (sel.length > 1) return `已选 ${sel.length} 个图层`;
  const l = sel[0], kind = l.artboard ? "画板" : isVariantLayer(l) ? "变体图层" : KIND_NAMES[l.kind] ?? "图层";
  const q = l.kind === "smartObject" ? smartQuickMenu([l], users) : null;
  return q ? `${short(l.name)} · ${q.type.value} · ${q.shared.value}` : `${short(l.name)} · ${kind}`;
}

export function contextMenu(input: ContextMenuInput): { title: string; items: MenuNode[] } {
  const { layers, selected, users } = input;
  const sel = layers.filter(l => selected.has(l.id)), n = sel.length, one = n === 1 ? sel[0] : null;
  const flat = new Map(layerMenu(sel).flatMap(m => m === "-" ? [] : [[m.action as string, m] as const]));
  /** a command of the flat menu as a row; null when the menu doesn't offer it for this selection */
  const act = (action: string, label?: string): MenuNode | null => {
    const m = flat.get(action) as Exclude<MenuItem, "-"> | undefined;
    return m ? { id: "act:" + action, label: label ?? m.label, hint: SHORTCUTS[action], enabled: m.enabled } : null;
  };
  /** only while it applies */
  const when = (action: string) => { const r = act(action); return r?.enabled ? r : null; };
  const rows = (...r: (MenuNode | null)[]) => r.filter((x): x is MenuNode => !!x);
  const sub = (label: string, children: MenuNode[]): MenuNode | null =>
    children.some(c => c.id) ? { label, children, enabled: children.some(c => !!c.id && c.enabled !== false || !!c.children?.length) } : null;

  // ── 智能对象 (WavePlug's own tools first, like an add-on's entries in Blender) ──
  const q = input.smartTools ? smartQuickMenu(sel, users) : null;
  const smart = sel.some(l => l.kind === "smartObject") ? sub("智能对象", rows(
    act("editContents"),
    q && { id: "act:selectSameSource", label: "选中同源的智能对象", enabled: q.shared.enabled },
    q && { id: "act:makeUnique", label: "断开共用，成为独立内容", enabled: !!q.shared.doubleAction },
    q && { id: "act:makeEditable", label: "转为可编辑的 PSB", enabled: q.type.enabled },
    sep,
    ...(q ? q.actions.map(a => ({ id: "act:" + a.action, label: a.label, enabled: a.enabled })) : []),
    sep,
    when("updateModified"),
    act("smartViaCopy"), act("embedLinked"), act("convertToLinked"),
    // only for a linked smart object (Photoshop's own item is grayed for an embedded one): 替换内容 does that
    when("relink"), when("linkToFile"),
  )) : null;

  const lockRow = act("unlock") ?? act("lock");
  const colorNow = one ? one.color : null;
  const sm = selectMenu(layers, selected);

  const items = rows(
    smart, smart && sep,
    act("layerStyle"), act("rename"), act("duplicate"), act("delete"),
    sep,
    act("groupLayers"), when("ungroup"),
    input.assistant ? { id: "assist:organize", label: "AI 整理（重命名 + 归组）…", hint: "DeepSeek", enabled: true } : null,
    sub("合并", rows(act("merge"), act("mergeDown"), act("mergeVisible"), act("flatten"))),
    sub("转换", rows(
      act("convertSmart"),
      input.smartTools && n > 1 ? { id: "act:convertSeparately", label: "分别转换为智能对象", enabled: true } : null,
      act("rasterize"), act("rasterizeStyle"),
      sep,
      // the 工具 page's tools, with the settings last used there
      ...(input.smartTools ? [
        { id: "tool:textLines", label: "按行拆分文字", enabled: sel.some(l => l.kind === "text") },
        { id: "tool:trim", label: "裁剪边缘", enabled: sel.some(pixels) },
        { id: "tool:islands", label: "拆分像素岛", enabled: sel.some(pixels) },
      ] : []),
      sep,
      act("artboardFromLayers"),
    )),
    sub("排列", ARRANGE.map(([how, label, hint]) => ({ id: "arrange:" + how, label, hint, enabled: n > 0 && arrangeTarget(layers, selected, how) !== null }))),
    sub("对齐", ALIGNS.map(([k, label]) => ({ id: "align:" + k, label, enabled: !arrangeProblem(sel, "align") }))),
    sub("分布", DISTRIBUTES.map(([k, label]) => ({ id: "dist:" + k, label, enabled: !arrangeProblem(sel, "distribute") }))),
    sep,
    sub("蒙版", rows(
      act("toggleMask") ?? act("addMask"), act("applyMask"), act("deleteMask"),
      sep,
      act("toggleVectorMask") ?? act("addVectorMask"), act("deleteVectorMask"),
    )),
    act("unclip") ?? act("clip"),
    sub("图层样式", rows(act("copyStyle"), act("pasteStyle"), act("clearStyle"))),
    sep,
    lockRow, when("solo"), when("link"), sel.some(l => l.links.length > 0) ? act("unlink") : null,
    n > 0 ? sub("图层颜色", [
      { id: "color:none", label: "无颜色", checked: colorNow === "none" },
      ...input.colors.map(([k, label]) => ({ id: "color:" + k, label, checked: colorNow === k })),
      sep,
      { id: "color:custom", label: "自定义颜色…（只在本插件里显示）" },
    ]) : null,
    sep,
    sub("选择", sm.map(c => ({ id: "select:" + c.which, label: c.enabled ? `${c.label}（${c.ids.length}）` : c.label, enabled: c.enabled }))),
    input.send && n > 0 ? { label: "发送到", children: sendMenu(input.send, n), enabled: true } : null,
    input.send?.illustratorLink ? { id: "ai:update", label: "从 Illustrator 更新", enabled: !!input.send.illustrator } : null,
    input.send?.illustratorLink ? { id: "ai:reveal", label: "在 Illustrator 中选中", enabled: !!input.send.illustrator } : null,
    input.send && n > 0 && WORKBENCH_ENABLED ? { id: "wb:add", label: "加入工作台", enabled: true } : null,
    sub("导出", rows(act("quickExport"), act("copyCSS"), act("copySVG"))),
  );
  return { title: contextTitle(sel, users), items: tidy(items) };
}

/** No separator first, last or twice in a row (rows that didn't apply leave them behind). */
function tidy(items: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const it of items) {
    if (it.separator) { if (out.length && !out[out.length - 1].separator) out.push(it); }
    else out.push(it.children ? { ...it, children: tidy(it.children) } : it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/** Every command id in the menu (rows of submenus included). */
export function menuIds(items: readonly MenuNode[]): string[] {
  return items.flatMap(it => it.children ? menuIds(it.children) : it.id ? [it.id] : []);
}
