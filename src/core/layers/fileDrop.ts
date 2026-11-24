// Files dragged from the file manager onto the WaveLayer panel (拖拽文件置入): what each file
// becomes. A PSD / PSB is placed as a *linked* smart object by default (the document keeps pointing
// at the file, so a later edit of the PSD shows up); everything else is embedded. Holding Alt when
// letting go swaps the two. This module only decides; uxpHost.ts places, layersPanel.ts listens.

/** What Photoshop's 置入 takes. */
const PLACEABLE = new Set(["psd", "psb", "png", "jpg", "jpeg", "jpe", "webp", "gif", "bmp", "tif", "tiff", "tga", "heic", "heif", "avif", "svg", "ai", "pdf", "eps", "exr", "hdr", "dng"]);
/** Placed as a link unless Alt is held. */
const LINKED_BY_DEFAULT = new Set(["psd", "psb"]);

/** At most this many files in one drop: each is a Photoshop place command. */
export const MAX_DROP_FILES = 20;

export type FileDropMode = "linked" | "embedded";

export interface FileDropItem<T = unknown> { file: T; name: string; mode: FileDropMode }

export interface FileDropPlan<T = unknown> {
  items: FileDropItem<T>[];
  /** names of files Photoshop can't place (folders included) */
  unsupported: string[];
  /** placeable files left out by MAX_DROP_FILES */
  leftOut: number;
}

/** Lower-case extension without the dot; "" when there is none (a folder, a dot file). */
export function fileExt(name: string): string {
  const base = name.replace(/^.*[\\/]/, "");
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** The last part of a native path or name. */
export const fileBaseName = (path: string): string => path.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "");

/** The layer name of a placed file: the file name without its extension. */
export function fileLayerName(name: string): string {
  const base = fileBaseName(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

/** How a file is placed; null when Photoshop can't place it. `swap` (Alt held): the other way round. */
export function fileDropMode(name: string, swap = false): FileDropMode | null {
  const ext = fileExt(name);
  if (!PLACEABLE.has(ext)) return null;
  return LINKED_BY_DEFAULT.has(ext) !== swap ? "linked" : "embedded";
}

/** The files of one drop, in the order they came. */
export function planFileDrop<T>(files: readonly { file: T; name: string }[], swap = false, force?: FileDropMode): FileDropPlan<T> {
  const items: FileDropItem<T>[] = [], unsupported: string[] = [];
  for (const f of files) {
    const auto = fileDropMode(f.name, swap), mode = auto && (force ?? auto);
    if (mode) items.push({ file: f.file, name: f.name, mode }); else unsupported.push(fileBaseName(f.name));
  }
  return { items: items.slice(0, MAX_DROP_FILES), unsupported, leftOut: Math.max(0, items.length - MAX_DROP_FILES) };
}

/** The text over the panel while files hover it. */
export function fileDropHint(swap = false): string {
  return swap ? "松开置入（Alt：PSD 嵌入，其他链接）" : "松开置入文件（PSD 链接，其他嵌入；按住 Alt 互换）";
}

export interface FileDropResult { linked: number; embedded: number; opened: number; failed: string[] }
/** where dropped files go: before (above) / after (below) / inside layer `rel` (the insertion line) */
export interface FileDropSpot { rel: number; place: "before" | "after" | "inside" }

/** The WaveLayer status line after a drop. */
export function fileDropResultText(r: FileDropResult, plan: Pick<FileDropPlan, "unsupported" | "leftOut">): { text: string; kind: "ok" | "error" | "info" } {
  const done: string[] = [];
  if (r.linked) done.push(`链接置入 ${r.linked} 个`);
  if (r.embedded) done.push(`嵌入置入 ${r.embedded} 个`);
  if (r.opened) done.push(`打开 ${r.opened} 个`);
  const bad: string[] = [];
  if (r.failed.length) bad.push(`${r.failed.length} 个失败（${shortList(r.failed)}）`);
  if (plan.unsupported.length) bad.push(`${plan.unsupported.length} 个不支持（${shortList(plan.unsupported)}）`);
  if (plan.leftOut) bad.push(`超过 ${MAX_DROP_FILES} 个的 ${plan.leftOut} 个没有置入`);
  if (!done.length) return { text: bad.length ? `没有置入：${bad.join("，")}` : "没有可置入的文件", kind: bad.length ? "error" : "info" };
  return { text: `已${done.join("，")}${bad.length ? "；" + bad.join("，") : ""}`, kind: r.failed.length ? "error" : "ok" };
}

function shortList(names: readonly string[]): string {
  return names.slice(0, 2).join("、") + (names.length > 2 ? " 等" : "");
}

/** Native file paths in the text a drag offers (text/uri-list or text/plain): file:// URLs and
 *  plain Windows / macOS paths, one per line; comments (#) and anything else are skipped. */
export function pathsFromDropText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!line || line.startsWith("#")) continue;
    if (/^file:/i.test(line)) {
      let p = line.replace(/^file:\/\/(localhost)?/i, "");
      try { p = decodeURIComponent(p); } catch { /* keeps it as it is */ }
      if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1).replace(/\//g, "\\");
      if (p) out.push(p);
    } else if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith("\\\\") || line.startsWith("/")) out.push(line);
  }
  return out;
}

// ── 从网页拖入 ──
// A browser drag carries no file, only text (UXP gave text/plain, 11-16): an image's address, a
// data: image, or some words. Images are downloaded and embedded; anything else becomes a text layer.

/** What a drag without files carried. */
export type WebDrop = { kind: "images"; urls: string[] } | { kind: "text"; text: string } | null;

/** The longest text that becomes a text layer. */
export const MAX_DROP_TEXT = 2000;

/** `texts` are the drag's strings by type (text/uri-list, text/html, text/plain …). Image
 *  addresses win: <img src> in the HTML, then http(s) / data:image lines; else the plain text. */
export function webDrop(texts: readonly { type: string; text: string }[]): WebDrop {
  const urls: string[] = [];
  const add = (u: string) => { const t = u.trim().replace(/&amp;/g, "&"); if (isWebImageUrl(t) || /^https?:\/\//i.test(t)) { if (!urls.includes(t)) urls.push(t); } };
  for (const { type, text } of texts) {
    if (!/html/i.test(type)) continue;
    for (const m of text.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  }
  if (!urls.length) {
    for (const { type, text } of texts) {
      if (/html/i.test(type)) continue;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      if (lines.length && lines.every(l => /^(https?:\/\/|data:image\/)/i.test(l))) lines.forEach(add);
      if (urls.length) break;
    }
  }
  if (urls.length) return { kind: "images", urls: urls.slice(0, MAX_DROP_FILES) };
  const plain = texts.find(t => /^text\/plain/i.test(t.type) && t.text.trim()) ?? texts.find(t => !/html/i.test(t.type) && t.text.trim());
  const text = plain?.text.replace(/\r\n?/g, "\n").trim() ?? "";
  return text ? { kind: "text", text: text.slice(0, MAX_DROP_TEXT) } : null;
}

export function isWebImageUrl(u: string): boolean {
  return /^data:image\//i.test(u) || /^https?:\/\/[^\s]+\.(png|jpe?g|webp|gif|bmp|tiff?|svg|avif)(\?|#|$)/i.test(u);
}

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp", "image/tiff": "tif", "image/svg+xml": "svg", "image/avif": "avif" };
/** The extension for a downloaded image: from its content type, else its address; null = not an image. */
export function webImageExt(contentType: string, url: string): string | null {
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES[t]) return IMAGE_TYPES[t];
  if (t && !t.startsWith("application/octet-stream") && !t.startsWith("binary/")) return null;
  const m = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|avif)(\?|#|$)/i.exec(url);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg").replace("tiff", "tif") : null;
}

/** A layer name for a web image: the file name in its address, else 网页图片. */
export function webImageName(url: string): string {
  if (/^data:/i.test(url)) return "网页图片";
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const base = last.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    return base || "网页图片";
  } catch { return "网页图片"; }
}

/** The status line after a web drop. */
export function webDropResultText(r: { placed: number; failed: string[] }): { text: string; kind: "ok" | "error" } {
  if (!r.placed) return { text: `网页图片没有置入：${shortList(r.failed)}`, kind: "error" };
  return { text: `已置入 ${r.placed} 张网页图片${r.failed.length ? `；${r.failed.length} 个失败（${shortList(r.failed)}）` : ""}`, kind: r.failed.length ? "error" : "ok" };
}

/** A web page's own picture (a dragged image is often inside a link: the browser hands over the
 *  link's page, 11-16 bilibili / huaban): og:image, twitter:image, image_src — absolute, else null.
 *  `title` is og:title or <title>, for the layer name. */
export function pageImage(html: string, pageUrl: string): { url: string; title: string } | null {
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find(v => v !== undefined) ?? "";
  const metas = [...html.matchAll(/<(meta|link)\b[^>]*>/gi)].map(m => m[0]);
  const find = (keys: string[]) => {
    for (const k of keys) for (const t of metas) {
      const key = (attr(t, "property") || attr(t, "name") || attr(t, "itemprop") || attr(t, "rel")).toLowerCase();
      if (key === k) { const v = attr(t, "content") || attr(t, "href"); if (v.trim()) return v.trim().replace(/&amp;/g, "&"); }
    }
    return "";
  };
  const raw = find(["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src", "image", "image_src"]);
  if (!raw) return null;
  let url: string;
  try { url = new URL(raw, pageUrl).href; } catch { return null; }
  if (!/^https?:/i.test(url)) return null;
  const title = (find(["og:title", "twitter:title"]) || /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || "").trim();
  return { url, title };
}
