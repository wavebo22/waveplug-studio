// 智能对象工具: which layers each tool touches. Pure, so the planning is tested without Photoshop.

/** A layer of the active document as the tools see it. */
export interface ToolLayer {
  id: number;
  name: string;
  kind: string;
  selected: boolean;
  /** smart objects: id of the embedded content; instances made by duplicating share it */
  contentId?: string | null;
  /** smart objects: linked to an external file (not embedded) */
  linked?: boolean;
  /** smart objects: file name of the content, e.g. "logo.psb" */
  file?: string;
  locked?: boolean;
}

export interface ToolResult {
  done: number;
  /** "layer name：reason" for each layer left alone */
  skipped: string[];
  /** extra remark for the status line */
  note?: string;
  /** counting word, "个" by default */
  unit?: string;
}

export const isSmart = (l: ToolLayer) => l.kind === "smartObject";

/**
 * 断开链接: the selected embedded smart objects that must become independent copies. In a set of
 * instances sharing one content, every selected one is copied, except that when the whole set is
 * selected the first keeps the original content (it is then the only one using it).
 */
export function uniquePlan(layers: ToolLayer[]): { copy: ToolLayer[]; skipped: string[] } {
  const copy: ToolLayer[] = [], skipped: string[] = [];
  const users = new Map<string, ToolLayer[]>();
  for (const l of layers) if (isSmart(l) && !l.linked && l.contentId) users.set(l.contentId, [...users.get(l.contentId) ?? [], l]);
  const seen = new Set<string>();
  for (const l of layers.filter(x => x.selected)) {
    if (!isSmart(l)) { skipped.push(`${l.name}：不是智能对象`); continue; }
    if (l.linked) { skipped.push(`${l.name}：链接到外部文件，没有共享的嵌入内容`); continue; }
    if (l.locked) { skipped.push(`${l.name}：图层已锁定`); continue; }
    if (!l.contentId || seen.has(l.contentId)) continue;
    seen.add(l.contentId);
    const all = users.get(l.contentId)!, sel = all.filter(x => x.selected && !x.locked);
    if (all.length === 1) { skipped.push(`${l.name}：本来就是独立的`); continue; }
    copy.push(...(sel.length === all.length ? sel.slice(1) : sel));
  }
  return { copy, skipped };
}

/** Content Photoshop edits as layers: such smart objects are already editable. */
const EDITABLE_FILE = /\.(psb|psd)$/i;

/** 转为可编辑: the selected smart objects whose content isn't an embedded PSB / PSD (an image, a
 *  vector file, or a link); the rest are reported. */
export function editablePlan(layers: ToolLayer[]): { targets: ToolLayer[]; skipped: string[] } {
  const targets: ToolLayer[] = [], skipped: string[] = [];
  for (const l of layers.filter(x => x.selected)) {
    if (!isSmart(l)) skipped.push(`${l.name}：不是智能对象`);
    else if (l.locked) skipped.push(`${l.name}：图层已锁定`);
    else if (!l.linked && EDITABLE_FILE.test(l.file ?? "")) skipped.push(`${l.name}：已经可以编辑`);
    else targets.push(l);
  }
  return { targets, skipped };
}

/** 查找同源: ids of every smart object sharing content with a selected one. */
export function sameSourceIds(layers: ToolLayer[]): number[] {
  const ids = new Set(layers.filter(l => l.selected && isSmart(l) && l.contentId).map(l => l.contentId));
  return layers.filter(l => isSmart(l) && l.contentId && ids.has(l.contentId)).map(l => l.id);
}

/** The selected smart objects, one per content (替换内容 / 导出内容 act on the content, which all
 *  instances share). */
export function selectedContents(layers: ToolLayer[]): { layers: ToolLayer[]; skipped: string[] } {
  const out: ToolLayer[] = [], skipped: string[] = [], seen = new Set<string>();
  for (const l of layers.filter(x => x.selected)) {
    if (!isSmart(l)) { skipped.push(`${l.name}：不是智能对象`); continue; }
    const key = l.contentId ?? "layer:" + l.id;
    if (seen.has(key)) continue;
    seen.add(key); out.push(l);
  }
  return { layers: out, skipped };
}

/** A file name not in `taken` (case-insensitive): "logo.psb", "logo 2.psb", … */
export function freeName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const clean = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "内容";
  if (!used.has(clean.toLowerCase())) return clean;
  const dot = clean.lastIndexOf("."), base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : "";
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}${ext}`.toLowerCase())) return `${base} ${i}${ext}`;
}

/** One status line for a finished tool. */
export function resultText(verb: string, r: ToolResult): string {
  const head = (r.done ? `${verb} ${r.done} ${r.unit ?? "个"}` : "没有可处理的图层") + (r.note ? `（${r.note}）` : "");
  return r.skipped.length ? `${head}；跳过 ${r.skipped.length} 个（${r.skipped.slice(0, 2).join("；")}${r.skipped.length > 2 ? "…" : ""}）` : head;
}

/** Corners of a placed smart object in document px: top-left, top-right, bottom-right, bottom-left
 *  (smartObjectMore.transform). */
export type Quad = [number, number, number, number, number, number, number, number];

/** A Photoshop free transform about a reference point: scale (%; negative = flipped), then
 *  horizontal skew and rotation (degrees, clockwise), then the reference point moved by offset. */
export interface FreeTransform { ref: [number, number]; offset: [number, number]; width: number; height: number; skew: number; angle: number }

/**
 * The free transform that takes content lying on quad `from` (as 解包 leaves it: untransformed) onto
 * quad `to` (where the smart object showed it). Affine only — a perspective or warp is approximated
 * by the parallelogram through `to`'s top-left, top-right and bottom-left corners.
 * Null when the two already match.
 */
export function transformBetween(from: Quad, to: Quad): FreeTransform | null {
  const len = (x: number, y: number) => Math.hypot(x, y);
  const fw = len(from[2] - from[0], from[3] - from[1]), fh = len(from[6] - from[0], from[7] - from[1]);
  if (fw < 1e-6 || fh < 1e-6) return null;
  const ux = to[2] - to[0], uy = to[3] - to[1], vx = to[6] - to[0], vy = to[7] - to[1];
  const a = Math.atan2(uy, ux), c = Math.cos(a), s = Math.sin(a);
  // the left edge in the rotated frame: x = skew, y = height (negative when flipped)
  const vxr = vx * c + vy * s, vyr = -vx * s + vy * c;
  const t: FreeTransform = {
    ref: [from[0], from[1]],
    offset: [to[0] - from[0], to[1] - from[1]],
    width: len(ux, uy) / fw * 100,
    height: vyr / fh * 100,
    skew: Math.atan(vxr / vyr) * 180 / Math.PI,
    angle: a * 180 / Math.PI,
  };
  const still = Math.abs(t.width - 100) < 0.01 && Math.abs(t.height - 100) < 0.01 && Math.abs(t.angle) < 0.01 && Math.abs(t.skew) < 0.01
    && Math.abs(t.offset[0]) < 0.01 && Math.abs(t.offset[1]) < 0.01;
  return still ? null : t;
}

/** Whether `q` is a parallelogram (no perspective / warp to lose). */
export function isAffineQuad(q: Quad, tolerance = 0.5): boolean {
  return Math.abs(q[0] + q[4] - q[2] - q[6]) < tolerance && Math.abs(q[1] + q[5] - q[3] - q[7]) < tolerance;
}

/** Rectangle of `width` × `height` centred on the quad's centre. */
export function centredQuad(q: Quad, width: number, height: number): Quad {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4, l = cx - width / 2, t = cy - height / 2;
  return [l, t, l + width, t, l + width, t + height, l, t + height];
}

/** Where the part `r` of a w × h content lies in the document, given the whole content's quad. */
export function subQuad(q: Quad, w: number, h: number, r: { left: number; top: number; right: number; bottom: number }): Quad {
  const at = (u: number, v: number): [number, number] => [
    q[0] + (q[2] - q[0]) * u / w + (q[6] - q[0]) * v / h,
    q[1] + (q[3] - q[1]) * u / w + (q[7] - q[1]) * v / h,
  ];
  return [...at(r.left, r.top), ...at(r.right, r.top), ...at(r.right, r.bottom), ...at(r.left, r.bottom)] as Quad;
}
