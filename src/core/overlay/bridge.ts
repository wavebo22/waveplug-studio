// 牵手 Photoshop ⇄ Illustrator: the messages the two panels send each other through the overlay
// helper (native/overlay/src/server.rs relays `bridge` messages between its two clients).
// Illustrator asks, Photoshop answers: every request has a `reqId`, the answer is a `result`
// with the same id. Pure: shared by the Photoshop plugin (src/app/illustratorBridge.ts) and the
// Illustrator panel (src/ai/bridge.ts); tested in tests/ai_bridge.test.ts.

export type BridgeRequest =
  /** what Photoshop has open, and where to put files for it */
  | { kind: "info"; reqId: string }
  /** a file Illustrator wrote into Photoshop's inbox: place it (a new layer; `pixels`: rasterized).
   *  `link` ties the layer to the Illustrator items, for `update`. */
  | { kind: "place"; reqId: string; fileName: string; name: string; pixels: boolean; link?: string; newDoc?: boolean }
  /** the linked layer's contents replaced by this new file */
  | { kind: "update"; reqId: string; link: string; fileName: string }
  /** the linked layer selected in Photoshop (its document brought to the front) */
  | { kind: "reveal"; reqId: string; link: string }
  /** the layers selected in Photoshop as PNG files, for Illustrator to place */
  | { kind: "pull"; reqId: string }
  /** Photoshop's foreground colour: read it, or set it (#rrggbb) */
  | { kind: "get-color"; reqId: string }
  | { kind: "set-color"; reqId: string; hex: string }
  /** 画板 → Photoshop: a new document the size of the artboard (points, at `ppi`), every item its
   *  own vector smart object in the artboard's layer / group structure, attributes kept */
  | { kind: "board"; reqId: string; name: string; width: number; height: number; ppi: number; nodes: BoardNode[] };

/** One node of an artboard sent to Photoshop: a layer / group (`children`, top first) or an item
 *  (`fileName` in Photoshop's inbox). Opacity, blend mode and visibility are the Photoshop layer's:
 *  the item's file is exported without them (Illustrator's `bare` export). */
export interface BoardNode {
  name: string;
  hidden: boolean;
  /** 0–100 */
  opacity: number;
  /** Illustrator's BlendModes name (NORMAL, MULTIPLY …) */
  blend: string;
  children?: BoardNode[];
  fileName?: string;
  /** the item's link (wavelink): 更新 works on it later */
  link?: string;
  /** points from the artboard's top-left corner */
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** at most this many items in one artboard (each is a smart object Photoshop places) */
export const BOARD_MAX_ITEMS = 300;

export type BridgeResult = { kind: "result"; reqId: string; ok: true; value: unknown } | { kind: "result"; reqId: string; ok: false; error: string };

export interface PsInfo {
  doc: { name: string; ppi: number; width: number; height: number } | null;
  /** native folder Illustrator writes its files into */
  inbox: string;
  /** reserved: links Photoshop knows (left empty: checking them on every poll was too slow) */
  links: string[];
}

/** A Photoshop layer exported for Illustrator: position and size in document pixels (against the
 *  artboard's corner when `board` is sent). `how`: an SVG of a text / shape layer, a vector file
 *  out of a smart object (.ai / .pdf / .eps / .svg), or a PNG. `group`: the ids of the groups it is
 *  in, outermost first (`groups` names them). */
export interface PulledLayer {
  path: string; name: string; left: number; top: number; width: number; height: number;
  how?: PushHow; group?: string[]; hidden?: boolean; opacity?: number; blend?: string;
}
export type PushHow = "svg" | "vector" | "png";
export interface PushGroup { name: string; hidden: boolean; opacity: number; /** Illustrator's BlendModes name */ blend: string }
export interface PullResult {
  docName: string; ppi: number; files: PulledLayer[];
  /** 画板置入 Illustrator: a new artboard (document pixels) the files go on, and the groups they are in */
  board?: { name: string; width: number; height: number };
  groups?: Record<string, PushGroup>;
}

/** Where a linked Illustrator item went in Photoshop. */
export interface LinkTarget { docId: number; docName: string; layerId: number; name: string; at: number }

const str = (v: unknown): v is string => typeof v === "string";

/** Checks a request from Illustrator; null when it isn't one. */
export function parseBridgeRequest(m: any): BridgeRequest | null {
  if (!m || typeof m !== "object" || !str(m.reqId) || !m.reqId) return null;
  const reqId = m.reqId;
  switch (m.kind) {
    case "info": return { kind: "info", reqId };
    case "pull": return { kind: "pull", reqId };
    case "get-color": return { kind: "get-color", reqId };
    case "set-color": return str(m.hex) && /^#[0-9a-f]{6}$/i.test(m.hex) ? { kind: "set-color", reqId, hex: m.hex.toLowerCase() } : null;
    case "place":
      if (!str(m.fileName) || !safeFileName(m.fileName)) return null;
      return { kind: "place", reqId, fileName: m.fileName, name: str(m.name) && m.name ? m.name.slice(0, 255) : m.fileName, pixels: m.pixels === true,
        ...(str(m.link) && m.link ? { link: m.link } : {}), ...(m.newDoc === true ? { newDoc: true } : {}) };
    case "reveal": return str(m.link) && m.link ? { kind: "reveal", reqId, link: m.link } : null;
    case "board": {
      const nodes = parseBoardNodes(m.nodes, 0, { n: 0 });
      const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
      if (!nodes || !num(m.width) || !num(m.height) || !num(m.ppi)) return null;
      return { kind: "board", reqId, name: str(m.name) && m.name ? m.name.slice(0, 255) : "画板", width: m.width, height: m.height, ppi: Math.min(1200, m.ppi), nodes };
    }
    case "update":
      if (!str(m.fileName) || !safeFileName(m.fileName) || !str(m.link) || !m.link) return null;
      return { kind: "update", reqId, link: m.link, fileName: m.fileName };
  }
  return null;
}

/** Checks the nodes of a `board` request (null if any is wrong). */
function parseBoardNodes(v: unknown, depth: number, count: { n: number }): BoardNode[] | null {
  if (!Array.isArray(v) || depth > 30) return null;
  const out: BoardNode[] = [];
  const fin = (x: unknown, d: number) => typeof x === "number" && Number.isFinite(x) ? x : d;
  for (const m of v as any[]) {
    if (!m || typeof m !== "object") return null;
    const base = { name: str(m.name) ? m.name.slice(0, 255) : "", hidden: m.hidden === true, opacity: Math.max(0, Math.min(100, fin(m.opacity, 100))), blend: str(m.blend) ? m.blend : "NORMAL" };
    if (Array.isArray(m.children)) {
      const children = parseBoardNodes(m.children, depth + 1, count);
      if (!children) return null;
      out.push({ ...base, children });
      continue;
    }
    if (!str(m.fileName) || !safeFileName(m.fileName) || ++count.n > BOARD_MAX_ITEMS) return null;
    out.push({ ...base, fileName: m.fileName, ...(str(m.link) && m.link ? { link: m.link } : {}),
      left: fin(m.left, 0), top: fin(m.top, 0), width: Math.max(0, fin(m.width, 0)), height: Math.max(0, fin(m.height, 0)) });
  }
  return out;
}

/** every item's file in a board, for cleaning up the inbox */
export function boardFiles(nodes: readonly BoardNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: readonly BoardNode[]) => { for (const n of ns) { if (n.children) walk(n.children); else if (n.fileName) out.push(n.fileName); } };
  walk(nodes);
  return out;
}

const AI_TO_PS: Record<string, string> = {
  NORMAL: "NORMAL", MULTIPLY: "MULTIPLY", SCREEN: "SCREEN", OVERLAY: "OVERLAY", SOFTLIGHT: "SOFTLIGHT", HARDLIGHT: "HARDLIGHT",
  COLORDODGE: "COLORDODGE", COLORBURN: "COLORBURN", DARKEN: "DARKEN", LIGHTEN: "LIGHTEN", DIFFERENCE: "DIFFERENCE", EXCLUSION: "EXCLUSION",
  HUE: "HUE", SATURATIONBLEND: "SATURATION", COLORBLEND: "COLOR", LUMINOSITY: "LUMINOSITY",
};
/** Photoshop's BlendMode constant (its key in `constants.BlendMode`) for an Illustrator blend mode.
 *  A group in normal mode passes through: Illustrator groups don't isolate their blending. */
export function psBlendOf(aiBlend: string, group = false): string {
  if (group && (!aiBlend || aiBlend === "NORMAL")) return "PASSTHROUGH";
  return AI_TO_PS[aiBlend] ?? "NORMAL";
}

const PS_TO_AI: Record<string, string> = {
  normal: "NORMAL", passThrough: "NORMAL", multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", softLight: "SOFTLIGHT", hardLight: "HARDLIGHT",
  colorDodge: "COLORDODGE", colorBurn: "COLORBURN", darken: "DARKEN", lighten: "LIGHTEN", difference: "DIFFERENCE", exclusion: "EXCLUSION",
  hue: "HUE", saturation: "SATURATIONBLEND", color: "COLORBLEND", luminosity: "LUMINOSITY",
};
/** Illustrator's BlendModes name for a Photoshop blend mode (its batchPlay name); Photoshop-only
 *  modes (线性加深 …) become normal. */
export const aiBlendOf = (psMode: string): string => PS_TO_AI[psMode] ?? "NORMAL";

/** What a Photoshop layer becomes in Illustrator (画板置入 Illustrator). */
export interface PlanLeaf {
  id: number; name: string; how: PushHow;
  /** for "svg": the kind layerDragInfo reads */
  vectorKind?: "text" | "shape";
  /** for "vector": the smart object's file type (ai, pdf …) */
  ext?: string;
  group: string[]; hidden: boolean; opacity: number; blend: string;
}
export interface IllustratorPlan {
  name: string;
  /** the artboard's corner and size in document pixels (the whole canvas when there is no artboard) */
  left: number; top: number; width: number; height: number;
  /** top first */
  leaves: PlanLeaf[];
  groups: Record<string, PushGroup>;
  /** what doesn't go, or not quite: shown to the user */
  notes: string[];
}

/** the layer fields the plan reads (core/layers/tree.ts TreeLayer) */
interface PlanLayer {
  id: number; name: string; kind: string; parentId: number | null; visible: boolean; opacity: number; mode: string;
  width: number; height: number; clipped: boolean; artboard: boolean; board?: { left: number; top: number; right: number; bottom: number };
  smart?: { file: string }; filters?: readonly unknown[];
}

const VECTOR_FILE = /\.(ai|pdf|eps|svg)$/i;

/** 当前画板置入 Illustrator: the artboard the first selected layer is on (else the first artboard,
 *  else the whole canvas), its layers as they go to Illustrator. `layers`: top to bottom. */
export function illustratorPlan(layers: readonly PlanLayer[], selected: readonly number[], doc: { name: string; width: number; height: number }): IllustratorPlan {
  const byId = new Map(layers.map(l => [l.id, l]));
  const topOf = (id: number): PlanLayer | undefined => { let l = byId.get(id); while (l && l.parentId !== null) l = byId.get(l.parentId); return l; };
  const boards = layers.filter(l => l.artboard && l.parentId === null && l.board);
  const picked = selected.map(topOf).find(l => l?.artboard && l.board) ?? (selected.length ? undefined : boards[0]);
  const root = picked && picked.board ? picked : null;
  const plan: IllustratorPlan = root
    ? { name: root.name, left: root.board!.left, top: root.board!.top, width: root.board!.right - root.board!.left, height: root.board!.bottom - root.board!.top, leaves: [], groups: {}, notes: [] }
    : { name: doc.name.replace(/\.[^.]+$/, ""), left: 0, top: 0, width: doc.width, height: doc.height, leaves: [], groups: {}, notes: [] };
  const kids = new Map<number | null, PlanLayer[]>();
  for (const l of layers) { const k = kids.get(l.parentId) ?? []; k.push(l); kids.set(l.parentId, k); }
  let adjust = 0, clipped = 0, filtered = 0;
  const walk = (parent: number | null, group: string[]) => {
    for (const l of kids.get(parent) ?? []) {
      const base = { id: l.id, name: l.name, group, hidden: !l.visible, opacity: l.opacity, blend: aiBlendOf(l.mode) };
      if (l.kind === "group") {
        plan.groups[String(l.id)] = { name: l.name, hidden: !l.visible, opacity: l.opacity, blend: aiBlendOf(l.mode) };
        walk(l.id, [...group, String(l.id)]);
        continue;
      }
      if (l.kind === "adjustment") { adjust++; continue; }
      if (l.clipped) clipped++;
      if (l.kind === "text") plan.leaves.push({ ...base, how: "svg", vectorKind: "text" });
      else if (l.kind === "shape" || l.kind === "fill") plan.leaves.push({ ...base, how: "svg", vectorKind: "shape" });
      else if (l.kind === "smartObject" && VECTOR_FILE.test(l.smart?.file ?? "")) {
        if (l.filters?.length) { filtered++; plan.leaves.push({ ...base, how: "png" }); }
        else plan.leaves.push({ ...base, how: "vector", ext: (l.smart!.file.match(VECTOR_FILE)![1]).toLowerCase() });
      }
      else if (l.width > 0 && l.height > 0) plan.leaves.push({ ...base, how: "png" });
    }
  };
  walk(root ? root.id : null, []);
  if (adjust) plan.notes.push(`${adjust} 个调整图层没有带过去（Illustrator 没有调整图层）`);
  if (clipped) plan.notes.push(`${clipped} 个剪贴蒙版里的图层是单独过去的（没有剪切）`);
  if (filtered) plan.notes.push(`${filtered} 个带智能滤镜的矢量智能对象按图片过去（保留滤镜效果）`);
  return plan;
}

/** A plain file name (no folders): Photoshop only reads its own inbox. */
export const safeFileName = (s: string) => /^[\w.\-]{1,120}$/.test(s) && !s.startsWith(".");

/** An answer from Photoshop; null when it isn't one. */
export function parseBridgeResult(m: any): BridgeResult | { kind: "missing"; reqId: string | null } | null {
  if (m?.kind === "missing") return { kind: "missing", reqId: str(m.reqId) ? m.reqId : null };
  if (m?.kind !== "result" || !str(m.reqId)) return null;
  return m.ok === true ? { kind: "result", reqId: m.reqId, ok: true, value: m.value } : { kind: "result", reqId: m.reqId, ok: false, error: str(m.error) ? m.error : "Photoshop 出错" };
}

/** Links kept (most recent first), at most `max`, dropping the oldest. */
export function keepLinks(links: Record<string, LinkTarget>, max = 300): Record<string, LinkTarget> {
  const list = Object.entries(links).sort((a, b) => b[1].at - a[1].at).slice(0, max);
  return Object.fromEntries(list);
}

/** One text / shape layer as an SVG file for Illustrator: the fragment (document pixels) inside a
 *  page that is the layer's rectangle, sized in points at `ppi` so it lands at its printed size. */
export function layerSvg(fragment: string, rect: { left: number; top: number; right: number; bottom: number }, ppi: number): string {
  const w = Math.max(1, rect.right - rect.left), h = Math.max(1, rect.bottom - rect.top), k = 72 / (ppi > 0 ? ppi : 72);
  const r = (v: number) => String(Math.round(v * 1000) / 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${r(w * k)}" height="${r(h * k)}" viewBox="${r(rect.left)} ${r(rect.top)} ${r(w)} ${r(h)}">\n${fragment}\n</svg>\n`;
}

/** The kind layerDragInfo knows for a layer of Photoshop's `kind` (shape layers are solid fills
 *  with a vector mask); "" when it can't be vectors. */
export const vectorKind = (psKind: string): "text" | "shape" | "" => psKind === "text" ? "text" : psKind === "solidColor" || psKind === "shape" ? "shape" : "";

/** Illustrator's PNG export scale (%) so 1 pt lands on `ppi` / 72 Photoshop pixels. */
export function pngScale(ppi: number): number {
  const s = Math.round((ppi > 0 ? ppi : 72) / 72 * 100);
  return Math.max(10, Math.min(776, s));
}
