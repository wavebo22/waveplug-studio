// Browser preview: the real panel UI driven by a simulated Photoshop document and ComfyUI backend.
// Only for looking at layout and interaction — nothing here talks to Photoshop or ComfyUI.

import { type Comfy, type HistoryEntry, type JobEvent, pngSize } from "../core/comfy/client.ts";
import { encodePng, type Pixels } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";
import { uiToApi } from "../core/workflow/uiToApi.ts";
import { recognize } from "../core/workflow/recognize.ts";
import { newProfile } from "../core/workflow/profile.ts";
import type { Services } from "../app/services.ts";
import type { ActiveLayer, Capture, DocInfo, FillGroup, LayerInfo, LayerTools, LayerTree, Pads, PsHost, Variation, VariationMask } from "../ps/host.ts";
import { type LayerAction, type MoveStep, type RawLayer, type TreeLayer, buildTree } from "../core/layers/tree.ts";
import { type ToolLayer, editablePlan, sameSourceIds, selectedContents, uniquePlan } from "../core/layers/smart.ts";
import type { DocScan, SlimKind } from "../core/layers/slim.ts";
import { mountApp } from "../ui/app.ts";
import { mountLayersPanel } from "../ui/layersPanel.ts";

const HUES = [168, 24, 210, 280, 96, 340];
function swatch(n: number, w = 96, h = 72): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const hue = HUES[n % HUES.length];
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 35% 72%)`); grad.addColorStop(1, `hsl(${hue + 30} 30% 42%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.75)"; g.beginPath(); g.ellipse(w * .55, h * .55, w * .18, h * .3, -.4, 0, 7); g.fill();
  return c.toDataURL();
}

class MockHost implements PsHost {
  readonly kind = "mock" as const;
  doc: DocInfo = { id: 1, name: "poster_v3.psd", width: 1920, height: 1200, mode: "RGBColorMode", bits: 8 };
  sel: Rect | null = { left: 1020, top: 260, right: 1640, bottom: 900 };
  groupSelected = true;
  group: FillGroup = { kind: "inpaint", docId: 1, layerId: 42, name: "橘子汁", rect: { left: 1020, top: 260, right: 1640, bottom: 900 } };
  list: Variation[] = [1, 2, 4].map(n => ({ layerId: 100 + n, number: n, label: String(n), prompt: n === 4 ? "把杯子换成橘子汁" : "橘子汁，玻璃杯", visible: n === 4 }));
  private cbs: (() => void)[] = [];

  changed() { this.cbs.forEach(c => c()); }
  docOpen = true;
  activeDoc() { return this.docOpen ? this.doc : null; }
  async createDocument(width: number, height: number, name: string) { this.doc = { id: this.doc.id + 1, name, width, height, mode: "RGBColorMode", bits: 8 }; this.docOpen = true; this.sel = null; this.list = []; this.groupSelected = false; return this.doc; }
  docExists() { return true; }
  async selectionBounds() { return this.sel; }
  async selectionMask(_docId: number, rect: Rect): Promise<Pixels> {
    const w = rect.right - rect.left, h = rect.bottom - rect.top, data = new Uint8Array(w * h);
    if (this.sel) {
      const left = Math.max(rect.left, this.sel.left), right = Math.min(rect.right, this.sel.right);
      const top = Math.max(rect.top, this.sel.top), bottom = Math.min(rect.bottom, this.sel.bottom);
      for (let y = top; y < bottom; y++) if (left < right) data.fill(255, (y - rect.top) * w + left - rect.left, (y - rect.top) * w + right - rect.left);
    }
    return { width: w, height: h, channels: 1, data };
  }
  async activeFillGroup() { return this.groupSelected ? this.group : null; }
  listFillGroups() { return this.list.length || this.groupSelected ? [{ layerId: this.group.layerId, name: this.group.name, kind: this.group.kind }, { layerId: 77, name: "价格牌", kind: "inpaint" as const }] : []; }
  async fillGroupById(_d: number, id: number) { return id === this.group.layerId ? this.group : id === 77 ? { ...this.group, kind: "inpaint" as const, layerId: 77, name: "价格牌", rect: { left: 200, top: 200, right: 600, bottom: 500 } } : null; }
  async expandCanvas(_d: number, p: Pads) { this.doc = { ...this.doc, width: this.doc.width + p.left + p.right, height: this.doc.height + p.top + p.bottom }; return this.doc; }
  async docThumbnail() { const c = document.createElement("canvas"); const r = this.doc.width / this.doc.height; c.width = r >= 1 ? 240 : Math.round(240 * r); c.height = r >= 1 ? Math.round(240 / r) : 240; const g = c.getContext("2d")!; const gr = g.createLinearGradient(0, 0, c.width, c.height); gr.addColorStop(0, "#c9a36b"); gr.addColorStop(1, "#7a3b2e"); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "rgba(255,255,255,.8)"; g.beginPath(); g.ellipse(c.width * .5, c.height * .55, c.width * .18, c.height * .25, 0, 0, 7); g.fill(); return c.toDataURL(); }
  async refreshFillGroup(g: FillGroup) { return g; }
  async groupMask(g: FillGroup): Promise<Pixels> { const w = g.rect.right - g.rect.left, h = g.rect.bottom - g.rect.top; return { width: w, height: h, channels: 1, data: new Uint8Array(w * h).fill(255) }; }
  async capture(_d: number, rect: Rect): Promise<Capture> {
    const w = rect.right - rect.left, h = rect.bottom - rect.top;
    const sel = new Uint8Array(w * h);
    const s = this.sel ?? this.group.rect;
    for (let y = s.top - rect.top; y < s.bottom - rect.top; y++) sel.fill(255, y * w + (s.left - rect.left), y * w + (s.right - rect.left));
    return { doc: this.doc, rect, image: { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3).fill(128) }, selection: { width: w, height: h, channels: 1, data: sel } };
  }
  activeLayer(): ActiveLayer | null { return this.docOpen ? { id: 7, name: "产品参考", kind: "pixel", rect: { left: 300, top: 200, right: 700, bottom: 650 } } : null; }
  activeLayers(): ActiveLayer[] { return this.docOpen ? [this.activeLayer()!, { id: 8, name: "瓶子", kind: "smartObject", rect: { left: 900, top: 300, right: 1300, bottom: 900 } }, { id: 9, name: "装饰组", kind: "group", rect: { left: 0, top: 0, right: 100, bottom: 100 } }] : []; }
  async layerImage() { const w = 400, h = 450, data = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { data[i * 4] = 200; data[i * 4 + 1] = 120; data[i * 4 + 2] = 60; data[i * 4 + 3] = (i % w) > 40 ? 255 : 0; } await sleep(100); return { pixels: { width: w, height: h, channels: 4 as const, data }, rect: { left: 300, top: 200, right: 700, bottom: 650 } }; }
  docVersion(_d: number) { return "1"; }
  async placeDroppedFiles(files: { name: string; mode: string }[], at?: unknown) { await sleep(300); console.log("placed dropped files", files.map(f => `${f.name}:${f.mode}`).join(", "), JSON.stringify(at ?? null)); return { linked: files.filter(f => f.mode === "linked").length, embedded: files.filter(f => f.mode !== "linked").length, opened: 0, failed: [] as string[] }; }
  async exportLayerPng(_d: number, layerId: number, sessionId: string, order: number) { await sleep(80); const path = `/tmp/waveplug_drag_${sessionId}_${order}.png`; console.log("exported drag png", layerId, path); return { path, rect: { left: 0, top: 0, right: 10, bottom: 10 }, remove: async () => {} }; }
  async layerDragInfo() { return { rect: { left: 0, top: 0, right: 10, bottom: 10 }, vector: null, res: 72 }; }
  async placeUpscaledLayer(_d: number, _l: number, _png: Uint8Array, _r: Rect, name: string) { console.log("placed smart object", name); await sleep(150); return 99; }
  listLayers(): LayerInfo[] { return [{ id: 1, name: "标题文字", depth: 0, kind: "text" }, { id: 42, name: "AI填充 · 橘子汁", depth: 0, kind: "group" }, { id: 7, name: "产品参考", depth: 0, kind: "pixel" }, { id: 3, name: "背景", depth: 0, kind: "pixel" }]; }
  async layerPixels(): Promise<Pixels> { return { width: 8, height: 8, channels: 3, data: new Uint8Array(192) }; }
  async layerThumbnail(_d: number, id: number) { return swatch(id, 64, 64); }
  async clipboardImage(): Promise<Pixels | null> { const w = 40, h = 30; return { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3).map((_, i) => (i * 37) & 255) }; }
  async variations() { return this.list.map(v => ({ ...v })); }
  async selectFillGroup(g: FillGroup) { this.group = g; this.groupSelected = true; this.changed(); }
  async setFillVisible() {}
  async placeBelow() {}
  async showVariation(_g: FillGroup, layerId: number) { this.list.forEach(v => { v.visible = v.layerId === layerId; }); }
  async deleteVariation(_g: FillGroup, layerId: number) { this.list = this.list.filter(v => v.layerId !== layerId); if (!this.list.some(v => v.visible) && this.list.length) this.list[this.list.length - 1].visible = true; }
  async createFillGroup(d: number, rect: Rect, prompt: string, pads?: Pads, kind?: FillGroup["kind"]): Promise<FillGroup> { this.groupSelected = true; this.list = []; this.group = { ...this.group, docId: d, kind: pads ? "outpaint" : kind ?? "inpaint", pads, layerId: this.group.layerId + 1, rect, name: pads ? `←${pads.left} →${pads.right} ↑${pads.top} ↓${pads.bottom}` : prompt.slice(0, 24) }; return this.group; }
  async addVariation(_g: FillGroup, _png: Uint8Array, _p: Rect, prompt: string, _m: VariationMask): Promise<Variation> {
    const n = Math.max(0, ...this.list.map(v => v.number)) + 1;
    const v = { layerId: 100 + n, number: n, label: String(n), prompt, visible: true };
    this.list.forEach(x => { x.visible = false; }); this.list.push(v);
    return { ...v };
  }
  async thumbnail(g: FillGroup, layerId: number) {
    const ratio = (g.rect.right - g.rect.left) / (g.rect.bottom - g.rect.top);
    return swatch(layerId - 100, Math.round(96 * ratio), 96);
  }
  onChange(cb: () => void) { this.cbs.push(cb); }
}

/** 工具: a few layers, three instances of one smart object; the first two, the text and the pixel layer start selected. */
class MockTools implements LayerTools {
  layers: ToolLayer[] = [
    { id: 1, name: "徽章", kind: "smartObject", selected: true, contentId: "a", file: "徽章.psb" },
    { id: 2, name: "徽章 拷贝", kind: "smartObject", selected: true, contentId: "a", file: "徽章.psb" },
    { id: 3, name: "徽章 拷贝 2", kind: "smartObject", selected: false, contentId: "a", file: "徽章.psb" },
    { id: 4, name: "产品图", kind: "smartObject", selected: false, contentId: "b", file: "产品.png" },
    { id: 5, name: "标题", kind: "text", selected: true },
    { id: 6, name: "背景", kind: "pixel", selected: true },
  ];
  private next = 100;
  constructor(private changed: () => void) {}
  async inspect() { return this.layers.map(l => ({ ...l })); }
  private async done<T>(r: T) { await sleep(300); this.changed(); return r; }
  async makeUnique() {
    const { copy, skipped } = uniquePlan(this.layers);
    for (const l of copy) l.contentId = "c" + this.next++;
    return this.done({ done: copy.length, skipped });
  }
  async selectSameSource() { const ids = sameSourceIds(this.layers); this.layers.forEach(l => { l.selected = ids.includes(l.id); }); return this.done({ done: ids.length, skipped: [] }); }
  async convert(separately: boolean) { const n = this.layers.filter(l => l.selected).length; return this.done({ done: separately ? n : 1, skipped: [] }); }
  private smart() { const sel = this.layers.filter(l => l.selected); return { done: sel.filter(l => l.kind === "smartObject").length, skipped: sel.filter(l => l.kind !== "smartObject").map(l => l.name + "：不是智能对象") }; }
  async unpack() { return this.done(this.smart()); }
  async makeEditable() { const r = editablePlan(this.layers); return this.done({ done: r.targets.length, skipped: r.skipped }); }
  async resetTransform() { return this.done(this.smart()); }
  async replaceContents() { const r = selectedContents(this.layers); return this.done({ done: r.layers.length, skipped: r.skipped }); }
  async exportContents() { const r = selectedContents(this.layers); return this.done({ done: r.layers.length, skipped: r.skipped }); }
  private pixels() { return { done: this.layers.filter(l => l.selected && l.kind === "pixel").length, skipped: [] }; }
  async trimEdges() { const sel = this.layers.filter(l => l.selected && (l.kind === "pixel" || l.kind === "smartObject")); return this.done({ done: sel.length, skipped: [], note: sel.some(l => l.kind === "smartObject") ? "1 个智能对象的内容不是 PNG，用图层蒙版隐藏了杂色" : undefined }); }
  async countIslands() { await sleep(200); return this.layers.some(l => l.selected && (l.kind === "pixel" || l.kind === "smartObject")) ? 26 : 0; }
  async splitTextLines() { return this.done({ done: this.layers.filter(l => l.selected && l.kind === "text").length, skipped: [] }); }
  private slimmed = false;
  async scanDoc(): Promise<DocScan> {
    await sleep(300);
    const px = (id: number, name: string, r: [number, number, number, number], extra = {}) => ({ id, name, kind: "pixel", visible: true, bounds: { left: r[0], top: r[1], right: r[2], bottom: r[3] }, ...extra });
    const so = (id: number, name: string, shown: number, content: number, extra = {}) => ({ id, name, kind: "smartObject", visible: true, bounds: { left: 0, top: 0, right: shown, bottom: shown },
      smart: { file: "背景.jpg", linked: false, filters: false, shared: false, styled: false, quad: [0, 0, shown, 0, shown, shown, 0, shown] as [number, number, number, number, number, number, number, number], width: content, height: content, ...extra } });
    if (this.slimmed) return { width: 2480, height: 3508, bytesPerPixel: 5, bits: 8, layers: [], alphaChannels: [], maxCompatibility: true };
    return { width: 2480, height: 3508, bytesPerPixel: 5, bits: 8, maxCompatibility: true, alphaChannels: ["Alpha 1"], layers: [
      ...[1, 2, 3].map(i => px(200 + i, "v" + i, [0, 0, 1200, 900], { variationOf: 300, visible: i === 3 })),
      so(210, "背景大图", 1600, 7952), so(211, "产品图", 300, 4000, { shared: true }), so(212, "LOGO", 200, 3000, { file: "logo.psb" }),
      px(220, "旧版本", [0, 0, 2480, 3508], { visible: false }), px(221, "移出画布的图", [-1500, 0, 1500, 2000]), px(222, "图层 5", [0, 0, 0, 0]),
    ] };
  }
  async slim(kinds: SlimKind[]) { this.slimmed = true; return this.done({ done: kinds.length, skipped: [], unit: "项", note: "约 180 MB，保存后文件才会变小" }); }
  async purgeMemory() { await sleep(200); }
  async renameLayers(names: { id: number; name: string }[]) {
    for (const n of names) { const l = this.layers.find(x => x.id === n.id); if (l) l.name = n.name; }
    return this.done({ done: names.length, skipped: [] });
  }
  async splitIslands() { const so = this.layers.filter(l => l.selected && l.kind === "smartObject").length; return this.done({ done: this.pixels().done + so, skipped: [], note: so ? `${so} 个智能对象已栅格化` : undefined }); }
}

/** 图层列表: a poster with AI results, shared / linked smart objects, and a big group of 3000 layers. */
/** a white ellipse on black, like a typical layer mask */
function maskPicture(size: number): string {
  const c = document.createElement("canvas"); c.width = size; c.height = Math.round(size * 0.625);
  const g = c.getContext("2d")!;
  g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#fff"; g.beginPath(); g.ellipse(c.width / 2, c.height / 2, c.width * .3, c.height * .35, 0, 0, 7); g.fill();
  return c.toDataURL();
}

class MockLayerTree implements LayerTree {
  private raw: RawLayer[];
  selected = [21];
  constructor(private changed: () => void, private listen: (cb: () => void) => void) {
    const L = (id: number, name: string, kind: number, extra: Partial<RawLayer> = {}): RawLayer => ({ id, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, width: 120, height: 80, ...extra });
    const end = (): RawLayer => ({ id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false });
    const many: RawLayer[] = [];
    for (let i = 0; i < 3000; i++) many.push(L(10000 + i, `碎片 ${i + 1}`, i % 7 === 0 ? 5 : 1, i % 7 === 0 ? { contentId: "frag" + (i % 3), file: "碎片.png" } : { visible: i % 11 !== 0 }));
    this.raw = [
      L(1, "标题文字", 3, { links: [32] }),
      L(10, "AI填充 · 橘子汁", 7), L(11, "v3 · 橘子汁，玻璃杯", 5, { mask: true, contentId: "v3" }), L(12, "v2 · 橘子汁", 5, { mask: true, visible: false, contentId: "v2" }), L(13, "v1 · 橘子汁", 5, { mask: true, visible: false, contentId: "v1" }), end(),
      L(14, "AI扩图 · ←200 →200 ↑0 ↓0", 7), L(15, "v1", 1), end(),
      L(20, "徽章组", 7, { artboard: true }),
      L(21, "徽章", 5, { contentId: "a", file: "徽章.psb", effects: true, effectList: [
        { key: "bevelEmboss", multi: -1, name: "斜面和浮雕", enabled: true }, { key: "frameFX", multi: 0, name: "描边", enabled: true }, { key: "frameFX", multi: 1, name: "描边", enabled: true },
        { key: "innerShadow", multi: -1, name: "内阴影", enabled: true }, { key: "innerGlow", multi: -1, name: "内发光", enabled: true }, { key: "chromeFX", multi: -1, name: "光泽", enabled: true },
        { key: "solidFill", multi: -1, name: "颜色叠加", enabled: true }, { key: "gradientFill", multi: -1, name: "渐变叠加", enabled: true }, { key: "patternFill", multi: -1, name: "图案叠加", enabled: true },
        { key: "outerGlow", multi: -1, name: "外发光", enabled: true }, { key: "dropShadow", multi: -1, name: "投影", enabled: true }] }), L(22, "徽章 拷贝", 5, { contentId: "a", file: "徽章.psb" }),
      L(23, "内层", 7), L(24, "徽章 拷贝 2", 5, { contentId: "a", file: "徽章.psb", mask: true }), L(25, "LOGO", 5, { contentId: "l", linked: true, file: "logo.ai" }), end(),
      end(),
      L(60, "场景", 7), L(61, "天空", 1), L(62, "人物", 7), L(63, "身体", 1), L(64, "头部", 7), L(65, "眼睛", 1), L(66, "头发", 1), end(), L(67, "衣服", 1), end(), L(68, "地面", 1), end(),
      L(31, "色彩平衡 1", 2, { clipped: true }), L(33, "阴影", 1, { clipped: true, mask: true, maskOn: false, maskLinked: false }),
      L(30, "产品图", 5, { contentId: "b", file: "产品.png", filters: [{ name: "表面模糊", enabled: true }, { name: "亮度/对比度", enabled: false }], filtersOn: true, filterMask: true }), L(34, "空白图层", 1, { width: 0, height: 0, mask: true }), L(32, "形状 1", 4, { locked: true, lockPosition: true, links: [1], vmask: true }), L(35, "带矢量蒙版", 1, { vmask: true, mask: true }),
      L(40, "碎片（3000 个图层）", 7, { artboard: true, color: "violet" }), ...many, end(),
      L(50, "背景", 12, { locked: true, lockAll: true }),
    ];
  }
  async placeStaged(
    entries: import("../core/layers/workbench.ts").StagedLayer[],
    options?: import("../ps/uxpWorkbench.ts").WorkbenchPlacementOptions,
  ) {
    const refs = entries.filter(x => x.docId === 1 && x.layerId > 0);
    if (!refs.length) throw new Error("预览中没有可用的来源图层");
    const copies: RawLayer[] = [];
    for (const ref of refs) {
      const [a, b] = this.block(ref.layerId);
      if (a < 0) throw new Error("来源图层已不存在");
      copies.push(...this.raw.slice(a, b).map(l => ({
        ...l, id: l.section === "end" ? 0 : this.next++,
      })));
    }
    // the preview has one real document: 发送到 the other one only reports success
    if (options?.targetDocId === 2) {
      await sleep(30);
      return { docId: 2, groupId: null, groupName: null, count: refs.length, nestedSkipped: 0, placement: "top" as const, restored: refs.length, scale: 1, ids: [] };
    }
    const wrap = options?.wrapGroup !== false;
    const groupId = this.next++, groupName = wrap ? (options?.groupName || "工作台素材") : null;
    const start: RawLayer = { id: groupId, name: groupName ?? "", kind: 7, section: "start", visible: true, locked: false, mask: false };
    const end: RawLayer = { id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false };
    const anchorIndex = options?.position === "selection" && this.selected.length
      ? this.raw.findIndex(layer => this.selected.includes(layer.id) && layer.section !== "end") : -1;
    const insertAt = anchorIndex >= 0 ? anchorIndex : 0;
    if (wrap) this.raw.splice(insertAt, 0, start, ...copies, end);
    else this.raw.splice(insertAt, 0, ...copies);
    this.selected = wrap ? [groupId] : copies.filter(c => c.id).map(c => c.id);
    await sleep(30);
    this.changed();
    return {
      docId: 1, groupId: wrap ? groupId : null, groupName, count: refs.length, nestedSkipped: 0,
      placement: anchorIndex >= 0 ? "above-selection" as const : "top" as const,
      anchorName: anchorIndex >= 0 ? this.raw[anchorIndex + copies.length + (wrap ? 2 : 0)]?.name : undefined,
      restored: refs.length, scale: 1, ids: this.selected,
    };
  }
  async snapshotStaged(_docId: number, docKey: string, layerId: number) { return `wb_preview${docKey.length}_${layerId}.png`; }
  async dropSnapshots() {}
  async openDocs() { return [{ docId: 1, docKey: "preview.psd", name: "preview.psd" }, { docId: 2, docKey: "D:/设计/另一份.psd", name: "另一份.psd" }]; }
  async probeStaged(refs: { docId: number; layerId: number }[]) {
    return refs.map(r => {
      if (r.docId !== 1) return null;
      const l = this.raw.find(x => x.id === r.layerId && x.section !== "end");
      return l ? { name: l.name } : null;
    });
  }
  async read(): Promise<{ docId: number; docKey: string; layers: TreeLayer[]; selected: number[]; width: number; height: number }> { return { docId: 1, docKey: "preview.psd", layers: buildTree(this.raw), selected: [...this.selected], width: 1920, height: 1200 }; }
  async pickColor(hex: string) { return hex === "#3fb59f" ? "#e07ad0" : "#3fb59f"; }
  private next = 90000;
  /** enough of each command to see the list react */
  async run(_d: number, action: LayerAction, ids: number[], arg?: string) {
    const L = (name: string, kind = 1): RawLayer => ({ id: this.next++, name, kind, section: kind === 7 ? "start" : "content", visible: true, locked: false, mask: false, width: 120, height: 80 });
    const at = () => Math.max(0, this.raw.findIndex(x => ids.includes(x.id) && x.section !== "end"));
    const each = (f: (l: RawLayer) => void) => this.raw.filter(x => ids.includes(x.id) && x.section !== "end").forEach(f);
    console.info("[mock] run", action, JSON.stringify(ids), arg ?? "");
    // Photoshop selects the layer a mask / the pixels are targeted on
    if (action.startsWith("target")) this.selected = [...ids];
    switch (action) {
      case "newLayer": this.raw.splice(at(), 0, L("图层 " + (this.next - 89999))); break;
      case "newGroup": this.raw.splice(at(), 0, L("组 " + (this.next - 89999), 7), { id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false }); break;
      case "duplicate": each(l => { if (l.section === "content") this.raw.splice(this.raw.indexOf(l), 0, { ...l, id: this.next++, name: l.name + " 拷贝" }); }); break;
      case "delete": for (const id of ids) { if (this.raw.some(x => x.id === id && x.section !== "end")) { const [a, b] = this.block(id); this.raw.splice(a, b - a); } } break;
      case "rename": each(l => { l.name = arg ?? l.name; }); break;
      case "deleteVariant": { const v = this.raw.find(x => x.id === Number(arg)); if (v) { const shown = v.visible; this.raw.splice(this.raw.indexOf(v), 1); const [a, b] = this.block(ids[0]); const rest = this.raw.slice(a + 1, b).filter(x => /^v\d+/.test(x.name)); if (shown && rest.length) rest[rest.length - 1].visible = true; } break; }
      case "setColor": each(l => { l.color = arg; }); break;
      case "showVariant": { const [a, b] = this.block(ids[0]); for (const x of this.raw.slice(a + 1, b)) if (/^v\d+/.test(x.name)) x.visible = x.id === Number(arg); break; }
      case "addMask": case "addMaskHide": each(l => { l.mask = true; l.maskOn = true; }); break;
      case "deleteMask": case "applyMask": each(l => { l.mask = false; }); break;
      case "toggleMask": each(l => { l.maskOn = arg === "on"; }); break;
      case "deleteVectorMask": each(l => { l.vmask = false; }); break;
      case "deleteFilterMask": each(l => { l.filterMask = false; }); break;
      case "toggleVectorMask": each(l => { l.vmaskOn = arg === "on"; }); break;
      case "toggleMaskLink": { const o = JSON.parse(arg ?? "{}"); each(l => { if (o.vector) l.vmaskLinked = o.on; else l.maskLinked = o.on; }); break; }
      case "clip": each(l => { l.clipped = true; }); break;
      case "unclip": each(l => { l.clipped = false; }); break;
      case "pasteStyle": each(l => { l.effects = true; l.effectsOn = true; }); break;
      case "clearStyle": each(l => { l.effects = false; }); break;
      case "toggleEffects": each(l => { l.effectsOn = arg === "on"; }); break;
      case "lock": each(l => { l.locked = true; l.lockAll = true; }); break;
      case "setLock": {
        for (const { id, locks: k } of JSON.parse(arg ?? "[]")) {
          const l = this.raw.find(x => x.id === id && x.section !== "end");
          if (!l) continue;
          l.lockAll = !!k.protectAll; l.lockPosition = !!k.protectPosition; l.lockPixels = !!k.protectComposite; l.lockTransparency = !!k.protectTransparency;
          l.locked = l.lockAll || l.lockPosition || l.lockPixels || l.lockTransparency;
        }
        break;
      }
      case "toggleFilter": {
        const { index } = JSON.parse(arg ?? "{}");
        each(l => {
          const fs = l.filters ?? [];
          if (!index) { const on = !fs.some(f => f.enabled); fs.forEach(f => { f.enabled = on; }); }
          else if (fs[index - 1]) fs[index - 1].enabled = !fs[index - 1].enabled;
          l.filtersOn = fs.some(f => f.enabled);
        });
        break;
      }
      case "moveFilter": {
        const { from, toLayer, toPos } = JSON.parse(arg ?? "{}");
        const a = this.raw.find(x => x.id === ids[0])!, b = this.raw.find(x => x.id === toLayer)!;
        const [f] = a.filters!.splice(from, 1);
        (b.filters ??= []).splice(toPos, 0, f);
        break;
      }
      case "toggleEffect": {
        const { key, multi, on } = JSON.parse(arg ?? "{}");
        each(l => { const e = l.effectList?.find(x => x.key === key && x.multi === multi); if (e) e.enabled = on; });
        break;
      }
      case "setProps": { const p = JSON.parse(arg ?? "{}"); each(l => { if (p.mode) l.mode = p.mode; if (p.opacity !== undefined) l.opacity = p.opacity; if (p.fill !== undefined) l.fill = p.fill; }); break; }
      case "link": each(l => { l.links = ids.filter(x => x !== l.id); }); break;
      case "unlink": each(l => { l.links = []; }); this.raw.forEach(l => { l.links = l.links?.filter(x => !ids.includes(x)); }); break;
      case "unlock": each(l => { l.locked = false; l.lockAll = false; }); break;
      case "adjustment": this.raw.splice(at(), 0, L(arg + " 1", 2)); break;
      default: console.log("mock layer command", action, ids, arg);
    }
    await sleep(60); this.changed();
  }
  async select(_d: number, ids: number[]) { await sleep(60); this.selected = ids; this.changed(); }
  async texts(_d: number, ids: number[]) { return new Map(this.raw.filter(l => l.kind === 3 && ids.includes(l.id)).map(l => [l.id, l.name])); }
  async organize(_d: number, plan: { renames: { id: number; name: string }[]; groups: { name: string; ids: number[] }[] }) {
    for (const r of plan.renames) { const l = this.raw.find(x => x.id === r.id && x.section !== "end"); if (l) l.name = r.name; }
    // the ids are adjacent siblings (organize.ts): the group starts above the first and ends below the last
    for (const g of plan.groups) {
      const spans = g.ids.map(id => this.block(id)), from = Math.min(...spans.map(s => s[0])), to = Math.max(...spans.map(s => s[1]));
      const id = Math.max(...this.raw.map(l => l.id)) + 1;
      this.raw.splice(to, 0, { id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false });
      this.raw.splice(from, 0, { id, name: g.name, kind: 7, section: "start", visible: true, locked: false, mask: false });
    }
    await sleep(300); this.changed();
    return { done: plan.renames.length + plan.groups.length, skipped: [] };
  }
  async setVisible(_d: number, ids: number[], visible: boolean) { for (const l of this.raw) if (ids.includes(l.id)) l.visible = visible; await sleep(60); this.changed(); }
  /** a layer's records in the flat list: itself, or a group from its start to its end marker */
  private block(id: number): [number, number] {
    const a = this.raw.findIndex(x => x.id === id && x.section !== "end");
    if (this.raw[a].section !== "start") return [a, a + 1];
    let depth = 0;
    for (let i = a; i < this.raw.length; i++) { if (this.raw[i].section === "start") depth++; else if (this.raw[i].section === "end" && !--depth) return [a, i + 1]; }
    return [a, this.raw.length];
  }
  async move(_d: number, steps: MoveStep[]) {
    for (const s of steps) {
      const [a, b] = this.block(s.id), part = this.raw.splice(a, b - a);
      const [ra, rb] = this.block(s.rel);
      this.raw.splice(s.place === "before" ? ra : s.place === "after" ? rb : ra + 1, 0, ...part);
    }
    await sleep(80); this.changed();
    return { done: steps.length, skipped: [] };
  }
  async copy(_d: number, steps: MoveStep[]) {
    const copied = new Map<number, number>(), ids: number[] = [], skipped: string[] = [];
    for (const step of steps) {
      const [start, end] = this.block(step.id);
      if (start < 0 || end <= start) { skipped.push("#" + step.id + "：来源已不存在"); continue; }
      const relId = copied.get(step.rel) ?? step.rel;
      const [ra, rb] = this.block(relId);
      if (ra < 0) { skipped.push("#" + step.id + "：目标已不存在"); continue; }
      const local = new Map<number, number>();
      const part = this.raw.slice(start, end).map((layer, i) => {
        if (layer.section === "end") return { ...layer };
        const id = this.next++;
        local.set(layer.id, id);
        return { ...layer, id, name: i ? layer.name : layer.name + " 拷贝" };
      });
      for (const layer of part) if (layer.links) layer.links = layer.links.map(id => local.get(id) ?? id);
      const pos = step.place === "before" ? ra : step.place === "after" ? rb : ra + 1;
      this.raw.splice(pos, 0, ...part);
      copied.set(step.id, part[0].id);
      ids.push(part[0].id);
    }
    this.selected = ids;
    await sleep(80);
    this.changed();
    return { done: ids.length, ids, skipped };
  }

  async thumbnails(_d: number, ls: { id: number; mask?: boolean | "vector" }[], _c: { width: number; height: number }, size: number) {
    await sleep(40 * ls.length);
    return ls.map(l => l.mask ? maskPicture(size) : swatch(l.id, size, size));
  }
  onEdited() {}
  onTarget() {}
  onChange(cb: () => void) { this.listen(cb); }
}

class MockComfy implements Comfy {
  readonly base = "http://127.0.0.1:8188";
  online = true;
  async systemStats() { if (!this.online) throw new Error("无法连接 ComfyUI（模拟离线）"); return { system: { comfyui_version: "0.37.0" }, devices: [] }; }
  async objectInfo() {
    // just enough for the preview to detect the "只重绘选区内" and reference slots
    const images = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`image_${String(i + 1).padStart(2, "0")}`, ["IMAGE"]]));
    return {
      TextEncodeQwenImage21GH: { input: { required: { clip: ["CLIP"] }, optional: { vae: ["VAE"], mask: ["MASK"], ...images } }, output: ["CONDITIONING", "CONDITIONING", "LATENT", "INFO"] },
      "图像缩放V2_孤海": { input: { required: { "图像": ["IMAGE"] }, optional: { "遮罩": ["MASK"] } }, output: ["IMAGE", "INT", "INT", "MASK"] },
    } as any;
  }
  async loraNames() { return ["Qwen-Image-2.1-Lightning-8steps.safetensors", "人像/胶片质感_v2.safetensors", "产品/白底商品图.safetensors"]; }
  async listWorkflows() { return ["孤海 Qwen2.1 Turbo PS专用/Qwen-2.1-移除、局部重绘_PS插件连接本地comfyui专用_本机适配.json", "孤海 Qwen2.1 Turbo PS专用/Qwen-2.1-移除、局部重绘、扩图.json", "Qwen Image 2.1 文生图.json", "▶▷VOSR2-图像放大.json"]; }
  async readWorkflow(path?: string) { return path && /扩图/.test(path) ? outpaintUi : path && /文生图/.test(path) ? txt2imgUi : path && /放大/.test(path) ? upscaleUi : fixtureUi; }
  last = { width: 16, height: 10 };
  out = this.last;
  async uploadImage(b: Uint8Array, name: string) { if (!/_ref\d/.test(name)) this.last = pngSize(b) ?? this.last; await sleep(150); return "waveplug/" + name; }
  async queue(api?: Record<string, { class_type?: string; inputs: Record<string, unknown> }>) {
    // outpaint: the result has the padded size (pads come from the canvas node's sources)
    const pad = (id: string) => Number(api?.[id]?.inputs.value ?? 0);
    const size = api?.["39"]?.inputs;
    if (size && typeof size["自定宽度"] === "number") { this.out = { width: size["自定宽度"] as number, height: size["自定高度"] as number }; return { promptId: "mock-" + Date.now(), number: 1 }; }
    // upscale: the factor is on node 4 (easy int)
    if (api?.["11"]?.class_type === "TESpeedVOSR2Image") { const f = pad("4"); this.out = { width: this.last.width * f, height: this.last.height * f }; return { promptId: "mock-" + Date.now(), number: 1 }; }
    this.out = api?.["314"] ? { width: this.last.width + pad("342") + pad("343"), height: this.last.height + pad("346") + pad("347") } : this.last;
    return { promptId: "mock-" + Date.now(), number: 1 };
  }
  async history(): Promise<HistoryEntry | null> { return null; }
  async view() { // same aspect as the uploaded image, tiny
    const { width, height } = this.out;
    return encodePng({ width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(90) });
  }
  async cancel() {}
  async freeCache() {}
  async waitFor(promptId: string, onEvent: (e: JobEvent) => void, opts: { signal?: { aborted: boolean } } = {}): Promise<HistoryEntry> {
    onEvent({ type: "running", promptId, node: "255" });
    for (let i = 1; i <= 9; i++) {
      await sleep(260);
      if (opts.signal?.aborted) throw new Error("已取消");
      onEvent({ type: "progress", promptId, value: i, max: 9, node: "274" });
    }
    return { outputs: { "315": { images: [{ filename: "o.png", subfolder: "", type: "output" }] }, "38": { images: [{ filename: "o.png", subfolder: "", type: "output" }] }, "1": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let fixtureUi: unknown = null, outpaintUi: unknown = null, txt2imgUi: unknown = null, upscaleUi: unknown = null;

async function boot() {
  fixtureUi = await (await fetch("fixture.json")).json();
  outpaintUi = await (await fetch("fixture_outpaint.json")).json();
  txt2imgUi = await (await fetch("fixture_txt2img.json")).json();
  upscaleUi = await (await fetch("fixture_upscale.json")).json();
  const host = new MockHost(), comfy = new MockComfy();
  if (!localStorage.getItem("wp.profiles")) {
    const { api } = uiToApi(fixtureUi);
    const rec = recognize(api);
    const p = newProfile("孤海 Qwen2.1 局部重绘", api, rec.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
    p.options.allowEmptyPrompt = true;
    p.source = { kind: "comfy", path: (await comfy.listWorkflows())[0] };
    localStorage.setItem("wp.profiles", JSON.stringify([p]));
    localStorage.setItem("wp.state." + p.id, JSON.stringify({ prompt: "磨砂玻璃瓶，瓶身有细小水珠，柔和侧光", params: {}, seedMode: "random", seed: 0 }));
  }
  const tools = new MockTools(() => host.changed());
  // 文档检查 in the preview: the 文档优化 scan plus a few made-up text layers
  const checker: import("../ps/host.ts").DocChecker = {
    async read() {
      const scan = await tools.scanDoc();
      const t = (id: number, name: string, contents: string, extra = {}) => ({ id, name, contents, fonts: ["SourceHanSansSC-Regular"], fontNames: ["思源黑体"], sizesPx: [28], ranges: 1, rgb: { r: 30, g: 30, b: 30 }, bounds: { left: 120, top: 80 + id % 10 * 60, right: 520, bottom: 120 + id % 10 * 60 }, visible: true, ...extra });
      return { width: scan.width, height: scan.height, mode: "rgb" as const, bits: 8, ppi: 72, scan, installed: new Set(["SourceHanSansSC-Regular"]),
        texts: [t(901, "登录提示", "欢迎登陆会员中心"), t(902, "价格", "全网最低 ¥99", { rgb: { r: 255, g: 90, b: 31 } }), t(903, "角标", "限时", { fonts: ["FZLTCHJW--GB1-0"], fontNames: ["方正兰亭粗黑"], sizesPx: [9] }),
          t(904, "副标题", "标题文字", { rgb: { r: 255, g: 91, b: 32 }, sizesPx: [27.8] }), t(905, "浅色说明", "说明文字", { rgb: { r: 210, g: 210, b: 210 } })],
        links: [], fills: [], backgrounds: new Map([[905, { r: 250, g: 250, b: 250 }]]), contentIds: new Map<number, string>() };
    },
    async setText() { await sleep(200); return true; },
  };
  const svc: Services = {
    checker,
    host, comfy: () => comfy, tools, layers: new MockLayerTree(() => host.changed(), cb => host.onChange(cb)),
    async pickJson() { return null; },
    async pickImage() { return { name: "参考.png", bytes: new Uint8Array(), url: swatch(3, 80, 80) }; },
    async saveImage() { return true; },
    // the preview keeps the report where a test (or the console) can read it
    async saveText(text: string, suggested: string) { (window as any).__lastReport = { text, suggested }; console.info("[mock] saveText", suggested, text.length); return true; },
    async pickLauncher() { return "J:\\AI things\\ComfyUI\\ComfyUI_windows_portable\\run_nvidia_gpu.bat"; },
    async launch() { setTimeout(() => { comfy.online = true; }, 5000); return null; },
    version: "0.1.0 preview",
    // a stand-in for DeepSeek: renames default-looking names and groups the first two layers listed
    aiFetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const system = String(body.messages[0].content);
      const reply = async (value: unknown) => { await sleep(1500); return { ok: true, status: 200, text: async () => JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } as unknown as Response; };
      if (system.includes("文案校对")) return reply({ issues: [
        { id: 901, type: "typo", original: "登陆", suggestion: "登录", reason: "登录账号用「登录」，「登陆」指登上陆地" },
        { id: 902, type: "ad_law", original: "全网最低", suggestion: "超值", reason: "广告法禁止使用「最」等绝对化用语" },
      ] });
      if (system.includes("视觉设计审稿")) return reply({ issues: [{ type: "ai_artifact", where: "右侧人物的左手", problem: "手指看起来有六根", suggestion: "重新生成这只手或局部重绘" }] });
      const lines = String(body.messages[1].content).split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
      const free = lines.filter(l => !l.fixed);
      const renames = free.filter(l => /^(图层|矩形|组|碎片|Layer)\s*\d|拷贝/.test(l.name)).slice(0, 40).map(l => ({ id: l.id, name: l.text ? String(l.text).slice(0, 8) : (l.kind === "group" ? "区块 " : "元素 ") + l.id }));
      const pair = free.filter(l => l.kind !== "artboard" && l.parent === free.find(f => f.kind !== "artboard" && f.kind !== "group")?.parent);
      const top = pair.slice(0, 2).map(l => l.id);
      await sleep(1200);
      const content = JSON.stringify({ renames, groups: [{ name: "顶部区域", ids: top }] });
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: "mock", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } as unknown as Response;
    }) as unknown as typeof fetch,
  };
  try {
    const s = JSON.parse(localStorage.getItem("wp.settings") ?? "{}");
    if (!s.deepseekKey) localStorage.setItem("wp.settings", JSON.stringify({ ...s, deepseekKey: "sk-preview" }));
  } catch { /* preview only */ }
  mountApp(document.getElementById("app")!, svc);
  mountLayersPanel(document.getElementById("layers-app")!, svc, () => true).show();

  // dev controls outside the panel
  const ctl = document.getElementById("controls")!;
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const l = document.createElement("label"); const i = document.createElement("input"); i.type = "checkbox"; i.checked = get();
    i.onchange = () => { set(i.checked); host.changed(); }; l.append(i, " " + label); ctl.append(l);
  };
  toggle("PS 中有选区", () => !!host.sel, v => { host.sel = v ? { left: 1020, top: 260, right: 1640, bottom: 900 } : null; });
  toggle("选中了 AI 结果智能对象（续写）", () => host.groupSelected, v => { host.groupSelected = v; });
  toggle("PS 中有打开的文档", () => host.docOpen, v => { host.docOpen = v; });
  toggle("ComfyUI 在线", () => comfy.online, v => { comfy.online = v; });
  const reset = document.createElement("button"); reset.textContent = "重置预览数据";
  reset.onclick = () => { localStorage.clear(); location.reload(); }; ctl.append(reset);
}
void boot();
