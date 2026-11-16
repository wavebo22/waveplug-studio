// A small model of Illustrator's scripting object model — just what ai/host/wavelayer.jsx uses —
// so the host script runs (and is tested) outside Illustrator: tests/ai_host.test.ts and the
// browser preview (src/ai/preview.ts). Not a full emulation: menu commands, export and placing
// files do the simple thing or only record what was asked.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const BlendModes = { NORMAL: 0, MULTIPLY: 1, SCREEN: 2, OVERLAY: 3, SOFTLIGHT: 4, HARDLIGHT: 5, COLORDODGE: 6, COLORBURN: 7, DARKEN: 8, LIGHTEN: 9,
  DIFFERENCE: 10, EXCLUSION: 11, HUE: 12, SATURATIONBLEND: 13, COLORBLEND: 14, LUMINOSITY: 15 } as const;

export const ElementPlacement = { PLACEBEFORE: 1, PLACEAFTER: 2, PLACEATBEGINNING: 3, PLACEATEND: 4, INSIDE: 5 } as const;

type Kids = any[] & { add?: () => any };

export class RGBColor { typename = "RGBColor"; red = 0; green = 0; blue = 0; }
export const rgb = (red: number, green: number, blue: number) => Object.assign(new RGBColor(), { red, green, blue });

abstract class FNode {
  parent: any = null;
  kids: FNode[] = [];
  abstract typename: string;
  name = "";
  locked = false;
  note = "";
  get zOrderPosition(): number {
    const sib = this.parent?.kids ?? [];
    return sib.length - sib.indexOf(this);
  }
  detach() {
    if (!this.parent) return;
    const i = this.parent.kids.indexOf(this);
    if (i >= 0) this.parent.kids.splice(i, 1);
    this.parent = null;
  }
  insert(rel: FNode, placement: number) {
    const P = ElementPlacement;
    if (placement === P.PLACEATBEGINNING || placement === P.INSIDE) { this.detach(); rel.kids.unshift(this); this.parent = rel; return; }
    if (placement === P.PLACEATEND) { this.detach(); rel.kids.push(this); this.parent = rel; return; }
    if (!rel.parent) throw new Error("no parent");
    this.detach();
    const sib = rel.parent.kids, i = sib.indexOf(rel);
    sib.splice(placement === P.PLACEBEFORE ? i : i + 1, 0, this);
    this.parent = rel.parent;
  }
  move(rel: FNode, placement: number) {
    for (let p: any = rel; p; p = p.parent) if (p === this) throw new Error("can't move into itself");
    this.insert(rel, placement);
    return this;
  }
  remove() { this.detach(); }
  get doc(): FakeDocument { let p: any = this; while (p && !(p instanceof FakeDocument)) p = p.parent; return p; }
  get inert(): boolean {
    for (let p: any = this; p && !(p instanceof FakeDocument); p = p.parent) {
      if (p.locked) return true;
      if (p instanceof FakeLayer ? !p.visible : p.hidden) return true;
    }
    return false;
  }
}

/** groupItems / placedItems of a layer or group: `add()` puts a new one on top; an imported SVG
 *  (`createFromFile`) is one group with a path, 100 × 50 pt */
function containerKids(owner: FNode, typename: string): Kids {
  const list: Kids = owner.kids.filter(k => k instanceof FakeItem && k.typename === typename);
  const top = (n: FakeItem) => { n.parent = owner; owner.kids.unshift(n); return n; };
  list.add = () => top(new FakeItem(typename));
  if (typename === "GroupItem") (list as any).createFromFile = (_f: any) => top(new FakeItem("GroupItem", { children: [new FakeItem("PathItem", { bounds: [0, 50, 100, 0] })] }));
  return list;
}

export class FakeItem extends FNode {
  typename: string;
  hidden = false;
  private _selected = false;
  filled = true;
  fillColor: any = rgb(200, 200, 200);
  clipped = false;
  clipping = false;
  contents = "";
  file: any = null;
  opacity = 100;
  blendingMode: number = BlendModes.NORMAL;
  stroked = false;
  pathPoints: any[] = [{}, {}, {}, {}];
  bounds: [number, number, number, number] = [0, 100, 100, 0];
  constructor(typename: string, props: Partial<FakeItem> & { children?: FakeItem[] } = {}) {
    super();
    this.typename = typename;
    const { children, ...rest } = props as any;
    Object.assign(this, rest);
    for (const c of children ?? []) { c.parent = this; this.kids.push(c); }
  }
  get selected() { return this._selected; }
  set selected(v: boolean) {
    if (v && this.inert) throw new Error("目标图层无法修改");
    this._selected = v;
    if (v) for (const k of this.kids) if (k instanceof FakeItem) k.walk(x => { x._selected = true; });
  }
  walk(f: (x: FakeItem) => void) { f(this); for (const k of this.kids) if (k instanceof FakeItem) k.walk(f); }
  get pageItems(): Kids { return this.typename === "GroupItem" ? [...this.kids] : []; }
  get groupItems(): Kids { return containerKids(this, "GroupItem"); }
  get placedItems(): Kids { return containerKids(this, "PlacedItem"); }
  get pathItems(): Kids { return this.typename === "CompoundPathItem" ? [...this.kids] : []; }
  get visibleBounds(): number[] {
    if (this.kids.length) {
      const b: number[][] = (this.kids as FakeItem[]).map(k => k.visibleBounds);
      return [Math.min(...b.map(x => x[0])), Math.max(...b.map(x => x[1])), Math.max(...b.map(x => x[2])), Math.min(...b.map(x => x[3]))];
    }
    return [...this.bounds];
  }
  get position() { const b = this.visibleBounds; return [b[0], b[1]]; }
  set position(p: number[]) {
    // moves everything inside (a group's bounds come from its children)
    const b = this.visibleBounds, dx = p[0] - b[0], dy = p[1] - b[1];
    this.walk(x => { const o = x.bounds; x.bounds = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy]; });
  }
  get width() { return this.bounds[2] - this.bounds[0]; }
  set width(w: number) { this.bounds = [this.bounds[0], this.bounds[1], this.bounds[0] + w, this.bounds[3]]; }
  get height() { return this.bounds[1] - this.bounds[3]; }
  set height(h: number) { this.bounds = [this.bounds[0], this.bounds[1], this.bounds[2], this.bounds[1] - h]; }
  get textRange() { const self = this; return { characterAttributes: { set fillColor(c: any) { self.fillColor = c; }, get fillColor() { return self.fillColor; } } }; }
  clone(): FakeItem {
    const c = new FakeItem(this.typename, { opacity: this.opacity, blendingMode: this.blendingMode, stroked: this.stroked, pathPoints: this.pathPoints, name: this.name, hidden: this.hidden, locked: this.locked, filled: this.filled, fillColor: this.fillColor, clipped: this.clipped, clipping: this.clipping, contents: this.contents, file: this.file, bounds: [...this.bounds] as any, note: this.note });
    for (const k of this.kids as FakeItem[]) { const kc = k.clone(); kc.parent = c; c.kids.push(kc); }
    return c;
  }
  duplicate(rel: FNode, placement: number) { const c = this.clone(); c.insert(rel, placement); return c; }
  embed() {
    if (this.typename !== "PlacedItem") return;
    const r = new FakeItem("RasterItem", { bounds: [...this.bounds] as any, name: this.name });
    r.insert(this, ElementPlacement.PLACEBEFORE);
    this.remove();
  }
}

export class FakeLayer extends FNode {
  typename = "Layer";
  visible = true;
  printable = true;
  preview = true;
  opacity = 100;
  blendingMode: number = BlendModes.NORMAL;
  color = rgb(79, 128, 255);
  constructor(name: string, kids: FNode[] = [], props: Partial<FakeLayer> = {}) {
    super();
    this.name = name;
    Object.assign(this, props);
    for (const k of kids) { k.parent = this; this.kids.push(k); }
  }
  get layers(): Kids {
    const list: Kids = this.kids.filter(k => k instanceof FakeLayer);
    list.add = () => { const n = new FakeLayer(this.doc.nextLayerName()); n.parent = this; this.kids.unshift(n); return n; };
    return list;
  }
  get pageItems(): Kids { return this.kids.filter(k => k instanceof FakeItem); }
  get groupItems(): Kids { return containerKids(this, "GroupItem"); }
  get placedItems(): Kids { return containerKids(this, "PlacedItem"); }
  get hasSelectedArtwork() { return this.allItems().some(i => i.selected); }
  set hasSelectedArtwork(v: boolean) { for (const i of this.allItems()) { try { i.selected = v; } catch { /* locked */ } } }
  allItems(): FakeItem[] {
    const out: FakeItem[] = [];
    for (const k of this.kids) {
      if (k instanceof FakeLayer) out.push(...k.allItems());
      else (k as FakeItem).walk(x => out.push(x));
    }
    return out;
  }
  move(rel: FNode, placement: number) {
    if (rel instanceof FakeItem) throw new Error("a layer goes next to a layer");
    return super.move(rel, placement);
  }
}

export class FakeDocument extends FNode {
  typename = "Document";
  path: string;
  saved = true;
  documentColorSpace = 1;
  private layerSeq = 1;
  private _active: FakeLayer | null = null;
  board = 0;
  artboardList: { name: string; artboardRect: number[] }[] = [{ name: "画板 1", artboardRect: [0, 800, 600, 0] }];
  exports: { file: string; type: string; opts: any }[] = [];
  swatchList: { name: string; color: any }[] = [];
  get swatches(): any {
    const list: any = [...this.swatchList];
    list.add = () => { const s = { name: "", color: null }; this.swatchList.push(s); return s; };
    return list;
  }
  closed = false;
  constructor(name: string, layers: FakeLayer[] = [], path = "") {
    super();
    this.name = name;
    this.path = path;
    for (const l of layers) { l.parent = this; this.kids.push(l); }
    this.layerSeq = layers.length + 1;
  }
  nextLayerName() { return `图层 ${this.layerSeq++}`; }
  get fullName() { if (!this.path) throw new Error("not saved"); return { fsName: this.path }; }
  get layers(): Kids {
    const list: Kids = [...this.kids];
    list.add = () => { const n = new FakeLayer(this.nextLayerName()); n.parent = this; this.kids.unshift(n); return n; };
    return list;
  }
  allLayers(): FakeLayer[] {
    const out: FakeLayer[] = [];
    const walk = (l: FakeLayer) => { out.push(l); for (const k of l.kids) if (k instanceof FakeLayer) walk(k); };
    for (const l of this.kids as FakeLayer[]) walk(l);
    return out;
  }
  get pageItems(): Kids { return (this.kids as FakeLayer[]).flatMap(l => l.allItems()); }
  get selection(): any {
    // a selected group's own children count as selected too, but Illustrator lists the group
    const out: FakeItem[] = [];
    const walk = (k: FNode) => {
      if (k instanceof FakeItem && k.selected) { out.push(k); return; }
      for (const c of k.kids) walk(c);
    };
    for (const l of this.kids) walk(l);
    return out;
  }
  set selection(v: any) {
    for (const i of this.pageItems as FakeItem[]) (i as any)._selected = false;
    if (Array.isArray(v)) for (const i of v) i.selected = true;
  }
  get activeLayer() { return this._active && this._active.doc === this ? this._active : this.kids[0] as FakeLayer; }
  set activeLayer(l: FakeLayer) { this._active = l; }
  get artboards(): any {
    const list: any = [...this.artboardList];
    list.getActiveArtboardIndex = () => this.board;
    list.setActiveArtboardIndex = (i: number) => { if (i < 0 || i >= this.artboardList.length) throw new Error("no artboard"); this.board = i; };
    list.add = (rect: number[]) => { const b = { name: `画板 ${this.artboardList.length + 1}`, artboardRect: [...rect] }; this.artboardList.push(b); return b; };
    for (const b of list) (b as any).remove = () => { this.artboardList.splice(this.artboardList.indexOf(b), 1); if (this.board >= this.artboardList.length) this.board = 0; };
    return list;
  }
  exportFile(file: any, type: string, opts: any) { this.exports.push({ file: file.fsName, type, opts }); written.add(file.fsName); }
  saveAs(file: any, opts: any) { this.exports.push({ file: file.fsName, type: "ai", opts }); written.add(file.fsName); }
  close() { this.closed = true; app.documents.splice(app.documents.indexOf(this), 1); if (app.active === this) app.active = app.documents[0] ?? null; }
}

/** files the fake has "written" (and any the test says exist) */
export const written = new Set<string>();

export class FakeFile {
  fsName: string;
  constructor(p: string) { this.fsName = String(p); }
  get exists() { return written.has(this.fsName); }
}
export class FakeFolder extends FakeFile {
  static temp = "/tmp";
  /** what the folder dialog answers (null: cancelled) */
  static picked: string | null = "/out";
  static selectDialog() { return FakeFolder.picked === null ? null : new FakeFolder(FakeFolder.picked); }
  create() { written.add(this.fsName); return true; }
}

export interface FakeApp {
  documents: FakeDocument[] & { add?: (...a: any[]) => FakeDocument };
  active: FakeDocument | null;
  activeDocument: FakeDocument;
  menuLog: string[];
  version: string;
  executeMenuCommand(id: string): void;
  redraw(): void;
  undo(): void;
  redo(): void;
}

export const app: FakeApp = {
  documents: [] as any,
  active: null,
  menuLog: [],
  version: "30.0 (fake)",
  get activeDocument() { if (!this.active) throw new Error("no document"); return this.active; },
  set activeDocument(d: FakeDocument) { this.active = d; },
  executeMenuCommand(id: string) {
    this.menuLog.push(id);
    const d = this.activeDocument;
    const sel = d.selection as FakeItem[];
    if (id === "deselectall") d.selection = null;
    else if (id === "showAll") { for (const i of d.pageItems as FakeItem[]) i.hidden = false; }
    else if (id === "unlockAll") { for (const i of d.pageItems as FakeItem[]) i.locked = false; }
    else if (id === "selectallinartboard") {
      const r = d.artboardList[d.board].artboardRect;
      for (const l of d.kids as FakeLayer[]) for (const it of l.allItems()) {
        if (it.parent instanceof FakeItem) continue;
        const b = it.visibleBounds;
        if (b[0] < r[2] && b[2] > r[0] && b[3] < r[1] && b[1] > r[3]) { try { it.selected = true; } catch { /* locked */ } }
      }
    }
    else if (id === "group" && sel.length) {
      const g = new FakeItem("GroupItem");
      g.insert(sel[0], ElementPlacement.PLACEBEFORE);
      for (const s of sel) s.insert(g, ElementPlacement.PLACEATEND);
      d.selection = null; g.selected = true;
    } else if (id === "ungroup") {
      for (const g of sel.filter(s => s.typename === "GroupItem")) {
        for (const k of [...g.kids].reverse()) k.insert(g, ElementPlacement.PLACEAFTER);
        g.remove();
      }
    }
  },
  redraw() { /* nothing to draw */ },
  undo() { this.menuLog.push("undo"); },
  redo() { this.menuLog.push("redo"); },
};

function resetApp() {
  const list: any = [];
  list.add = (_space: number, w = 100, h = 100) => {
    const d = new FakeDocument(`未标题-${list.length + 1}`, [new FakeLayer("图层 1")]);
    d.artboardList = [{ name: "画板 1", artboardRect: [0, h, w, 0] }];
    list.push(d);
    app.active = d;
    return d;
  };
  app.documents = list;
  app.active = null;
  app.menuLog = [];
}
resetApp();

/** Starts over with `docs` open, the first one active. */
export function openDocuments(...docs: FakeDocument[]) {
  resetApp();
  for (const d of docs) app.documents.push(d);
  app.active = docs[0] ?? null;
}

/** The globals ExtendScript gives the host script. */
export function hostGlobals(): Record<string, unknown> {
  return {
    app, ElementPlacement, BlendModes, DocumentColorSpace: { RGB: 1, CMYK: 2 }, Folder: FakeFolder, File: FakeFile, RGBColor,
    ExportOptionsPNG24: class { transparency = false; artBoardClipping = false; antiAliasing = true; horizontalScale = 100; verticalScale = 100; },
    IllustratorSaveOptions: class { pdfCompatible = false; embedLinkedFiles = false; },
    ExportOptionsSVG: class { embedRasterImages = false; },
    ExportType: { PNG24: "png24", SVG: "svg" }, SaveOptions: { DONOTSAVECHANGES: 2 },
  };
}

/** Runs the host script's source with the fake globals: its WavePlugWL object. */
export function loadHost(source: string): { call(op: string, args?: unknown): string } {
  const g = hostGlobals(), names = Object.keys(g);
  return new Function(...names, `${source}\nreturn WavePlugWL;`)(...names.map(n => g[n]));
}

// ── a demo document, for the preview and the tests ──
const path = (name: string, fill: [number, number, number], b: [number, number, number, number], extra: Partial<FakeItem> = {}) =>
  new FakeItem("PathItem", { name, fillColor: rgb(...fill), bounds: b, ...extra });

export function demoDocument(): FakeDocument {
  const logo = new FakeItem("GroupItem", {
    name: "Logo", children: [
      new FakeItem("TextFrame", { contents: "WAVE PLUG", bounds: [40, 760, 260, 720], fillColor: rgb(255, 255, 255) }),
      path("", [63, 181, 159], [40, 790, 90, 740]),
      new FakeItem("CompoundPathItem", { children: [path("", [240, 184, 64], [100, 790, 140, 750])] }),
    ],
  });
  const clip = new FakeItem("GroupItem", {
    clipped: true, children: [
      path("", [0, 0, 0], [300, 600, 560, 340], { clipping: true, filled: false }),
      new FakeItem("PlacedItem", { file: { fsName: "D:\\素材\\产品图.psd", exists: true }, bounds: [280, 620, 600, 320] }),
    ],
  });
  const bg = new FakeLayer("背景", [path("底色", [34, 40, 48], [0, 800, 600, 0]), path("渐变光", [80, 60, 140], [0, 500, 600, 0], { fillColor: { typename: "GradientColor" } })], { color: rgb(255, 79, 79) });
  const deco = new FakeLayer("装饰", [
    path("星星 1", [255, 215, 106], [480, 760, 500, 740]),
    path("星星 2", [255, 215, 106], [520, 730, 536, 714], { hidden: true }),
    new FakeItem("SymbolItem", { symbol: { name: "光斑" }, bounds: [380, 700, 420, 660] } as any),
  ], { color: rgb(255, 215, 106) });
  const content = new FakeLayer("内容", [logo, new FakeLayer("产品", [clip], { color: rgb(79, 255, 160) }),
    new FakeItem("TextFrame", { contents: "限时 8 折\n全场包邮", bounds: [40, 300, 300, 220] }),
    new FakeItem("TextFrame", { contents: "", bounds: [40, 200, 60, 180] }),
    new FakeItem("GroupItem", { name: "空编组" }),
  ]);
  const notes = new FakeLayer("备注", [new FakeItem("TextFrame", { contents: "不要印刷这一层", bounds: [0, 900, 200, 860] }), path("", [0, 0, 0], [450, 650, 450, 650], { pathPoints: [{}], filled: false })], { locked: true, visible: false, color: rgb(180, 180, 180) });
  const d = new FakeDocument("海报.ai", [content, deco, bg, notes, new FakeLayer("空图层")], "D:\\设计\\海报.ai");
  d.artboardList = [{ name: "海报 A4", artboardRect: [0, 800, 600, 0] }, { name: "横幅", artboardRect: [700, 800, 1900, 400] }];
  return d;
}
