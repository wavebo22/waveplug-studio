// Browser preview: the real panel UI driven by a simulated Photoshop document and ComfyUI backend.
// Only for looking at layout and interaction — nothing here talks to Photoshop or ComfyUI.

import { type Comfy, type HistoryEntry, type JobEvent, pngSize } from "../core/comfy/client.ts";
import { encodePng, type Pixels } from "../core/image/png.ts";
import type { Rect } from "../core/image/region.ts";
import { uiToApi } from "../core/workflow/uiToApi.ts";
import { recognize } from "../core/workflow/recognize.ts";
import { newProfile } from "../core/workflow/profile.ts";
import type { Services } from "../app/services.ts";
import type { Capture, DocInfo, FillGroup, LayerInfo, PsHost, Variation } from "../ps/host.ts";
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
  group: FillGroup = { docId: 1, layerId: 42, name: "橘子汁", rect: { left: 1020, top: 260, right: 1640, bottom: 900 } };
  list: Variation[] = [1, 2, 4].map(n => ({ layerId: 100 + n, number: n, label: String(n), prompt: n === 4 ? "把杯子换成橘子汁" : "橘子汁，玻璃杯", visible: n === 4 }));
  private cbs: (() => void)[] = [];

  changed() { this.cbs.forEach(c => c()); }
  activeDoc() { return this.doc; }
  docExists() { return true; }
  async selectionBounds() { return this.sel; }
  async activeFillGroup() { return this.groupSelected ? this.group : null; }
  listFillGroups() { return this.list.length || this.groupSelected ? [{ layerId: this.group.layerId, name: this.group.name }, { layerId: 77, name: "价格牌" }] : []; }
  async fillGroupById(_d: number, id: number) { return id === this.group.layerId ? this.group : id === 77 ? { ...this.group, layerId: 77, name: "价格牌", rect: { left: 200, top: 200, right: 600, bottom: 500 } } : null; }
  async refreshFillGroup(g: FillGroup) { return g; }
  async groupMask(g: FillGroup): Promise<Pixels> { const w = g.rect.right - g.rect.left, h = g.rect.bottom - g.rect.top; return { width: w, height: h, channels: 1, data: new Uint8Array(w * h).fill(255) }; }
  async capture(_d: number, rect: Rect): Promise<Capture> {
    const w = rect.right - rect.left, h = rect.bottom - rect.top;
    const sel = new Uint8Array(w * h);
    const s = this.sel ?? this.group.rect;
    for (let y = s.top - rect.top; y < s.bottom - rect.top; y++) sel.fill(255, y * w + (s.left - rect.left), y * w + (s.right - rect.left));
    return { doc: this.doc, rect, image: { width: w, height: h, channels: 3, data: new Uint8Array(w * h * 3).fill(128) }, selection: { width: w, height: h, channels: 1, data: sel } };
  }
  listLayers(): LayerInfo[] { return [{ id: 1, name: "标题文字", depth: 0, kind: "text" }, { id: 42, name: "AI填充 · 橘子汁", depth: 0, kind: "group" }, { id: 7, name: "产品参考", depth: 0, kind: "pixel" }, { id: 3, name: "背景", depth: 0, kind: "pixel" }]; }
  async layerPixels(): Promise<Pixels> { return { width: 8, height: 8, channels: 3, data: new Uint8Array(192) }; }
  async variations() { return this.list.map(v => ({ ...v })); }
  async showVariation(_g: FillGroup, layerId: number) { this.list.forEach(v => { v.visible = v.layerId === layerId; }); }
  async deleteVariation(_g: FillGroup, layerId: number) { this.list = this.list.filter(v => v.layerId !== layerId); if (!this.list.some(v => v.visible) && this.list.length) this.list[this.list.length - 1].visible = true; }
  async createFillGroup(_d: number, rect: Rect, prompt: string): Promise<FillGroup> { this.groupSelected = true; this.list = []; this.group = { ...this.group, rect, name: prompt.slice(0, 24) }; return this.group; }
  async addVariation(_g: FillGroup, _png: Uint8Array, _p: Rect, prompt: string): Promise<Variation> {
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

class MockComfy implements Comfy {
  readonly base = "http://127.0.0.1:8188";
  online = true;
  async systemStats() { if (!this.online) throw new Error("无法连接 ComfyUI（模拟离线）"); return { system: { comfyui_version: "0.37.0" }, devices: [] }; }
  async objectInfo() { return {}; }
  async listWorkflows() { return ["孤海 Qwen2.1 Turbo PS专用/Qwen-2.1-移除、局部重绘_PS插件连接本地comfyui专用_本机适配.json"]; }
  async readWorkflow() { return fixtureUi; }
  last = { width: 16, height: 10 };
  async uploadImage(b: Uint8Array, name: string) { this.last = pngSize(b) ?? this.last; await sleep(150); return "waveplug/" + name; }
  async queue() { return { promptId: "mock-" + Date.now(), number: 1 }; }
  async history(): Promise<HistoryEntry | null> { return null; }
  async view() { // same aspect as the uploaded image, tiny
    const { width, height } = this.last;
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
    return { outputs: { "38": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let fixtureUi: unknown = null;

async function boot() {
  fixtureUi = await (await fetch("fixture.json")).json();
  const host = new MockHost(), comfy = new MockComfy();
  if (!localStorage.getItem("wp.profiles")) {
    const { api } = uiToApi(fixtureUi);
    const rec = recognize(api);
    const p = newProfile("孤海 Qwen2.1 局部重绘", api, rec.suggestions.filter(s => s.confidence === "certain").map(s => s.binding));
    p.options.allowEmptyPrompt = true;
    localStorage.setItem("wp.profiles", JSON.stringify([p]));
    localStorage.setItem("wp.state." + p.id, JSON.stringify({ prompt: "磨砂玻璃瓶，瓶身有细小水珠，柔和侧光", params: {}, seedMode: "random", seed: 0 }));
  }
  const svc: Services = {
    host, comfy: () => comfy,
    async pickJson() { return null; },
    async pickImage() { return { name: "参考.png", bytes: new Uint8Array(), url: swatch(3, 80, 80) }; },
    async saveImage() { return true; },
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
  toggle("ComfyUI 在线", () => comfy.online, v => { comfy.online = v; });
  const reset = document.createElement("button"); reset.textContent = "重置预览数据";
  reset.onclick = () => { localStorage.clear(); location.reload(); }; ctl.append(reset);
}
void boot();
