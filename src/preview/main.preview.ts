// Browser preview: the real panel UI driven by a simulated Photoshop document and ComfyUI backend.
// Only for looking at layout and interaction — nothing here talks to Photoshop or ComfyUI.

import { type Comfy, type HistoryEntry, type JobEvent, pngSize } from "../core/comfy/client.ts";
import { encodePng, type Pixels } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";
import { uiToApi } from "../core/workflow/uiToApi.ts";
import { recognize } from "../core/workflow/recognize.ts";
import { newProfile } from "../core/workflow/profile.ts";
import type { Services } from "../app/services.ts";
import type { ActiveLayer, Capture, DocInfo, FillGroup, LayerInfo, LayerTools, Pads, PsHost, Variation, VariationMask } from "../ps/host.ts";
import { type ToolLayer, sameSourceIds, selectedContents, uniquePlan } from "../core/layers/smart.ts";
import { mountApp } from "../ui/app.ts";

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
  async layerImage() { const w = 400, h = 450, data = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { data[i * 4] = 200; data[i * 4 + 1] = 120; data[i * 4 + 2] = 60; data[i * 4 + 3] = (i % w) > 40 ? 255 : 0; } await sleep(100); return { pixels: { width: w, height: h, channels: 4 as const, data }, rect: { left: 300, top: 200, right: 700, bottom: 650 } }; }
  async placeUpscaledLayer(_d: number, _l: number, _png: Uint8Array, _r: Rect, name: string) { console.log("placed smart object", name); await sleep(150); return 99; }
  listLayers(): LayerInfo[] { return [{ id: 1, name: "标题文字", depth: 0, kind: "text" }, { id: 42, name: "AI填充 · 橘子汁", depth: 0, kind: "group" }, { id: 7, name: "产品参考", depth: 0, kind: "pixel" }, { id: 3, name: "背景", depth: 0, kind: "pixel" }]; }
  async layerPixels(): Promise<Pixels> { return { width: 8, height: 8, channels: 3, data: new Uint8Array(192) }; }
  async layerThumbnail(_d: number, id: number) { return swatch(id, 64, 64); }
  async clipboardImage(): Promise<Pixels | null> { const w = 40, h = 30; return { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3).map((_, i) => (i * 37) & 255) }; }
  async variations() { return this.list.map(v => ({ ...v })); }
  async setFillVisible() {}
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

/** 工具: a few layers, three instances of one smart object; the first two and the pixel layer start selected. */
class MockTools implements LayerTools {
  layers: ToolLayer[] = [
    { id: 1, name: "徽章", kind: "smartObject", selected: true, contentId: "a", file: "徽章.psb" },
    { id: 2, name: "徽章 拷贝", kind: "smartObject", selected: true, contentId: "a", file: "徽章.psb" },
    { id: 3, name: "徽章 拷贝 2", kind: "smartObject", selected: false, contentId: "a", file: "徽章.psb" },
    { id: 4, name: "产品图", kind: "smartObject", selected: false, contentId: "b", file: "产品.png" },
    { id: 5, name: "标题", kind: "text", selected: false },
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
  async resetTransform() { return this.done(this.smart()); }
  async replaceContents() { const r = selectedContents(this.layers); return this.done({ done: r.layers.length, skipped: r.skipped }); }
  async exportContents() { const r = selectedContents(this.layers); return this.done({ done: r.layers.length, skipped: r.skipped }); }
  private pixels() { return { done: this.layers.filter(l => l.selected && l.kind === "pixel").length, skipped: [] }; }
  async trimEdges() { const sel = this.layers.filter(l => l.selected && (l.kind === "pixel" || l.kind === "smartObject")); return this.done({ done: sel.length, skipped: [], note: sel.some(l => l.kind === "smartObject") ? "1 个智能对象的内容不是 PNG，用图层蒙版隐藏了杂色" : undefined }); }
  async countIslands() { await sleep(200); return this.layers.some(l => l.selected && (l.kind === "pixel" || l.kind === "smartObject")) ? 26 : 0; }
  async splitIslands() { const so = this.layers.filter(l => l.selected && l.kind === "smartObject").length; return this.done({ done: this.pixels().done + so, skipped: [], note: so ? `${so} 个智能对象已栅格化` : undefined }); }
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
  const svc: Services = {
    host, comfy: () => comfy, tools: new MockTools(() => host.changed()),
    async pickJson() { return null; },
    async pickImage() { return { name: "参考.png", bytes: new Uint8Array(), url: swatch(3, 80, 80) }; },
    async saveImage() { return true; },
    async pickLauncher() { return "J:\\AI things\\ComfyUI\\ComfyUI_windows_portable\\run_nvidia_gpu.bat"; },
    async launch() { setTimeout(() => { comfy.online = true; }, 5000); return null; },
    version: "0.1.0 preview",
  };
  mountApp(document.getElementById("app")!, svc);

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
