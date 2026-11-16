// 牵手 Illustrator, Photoshop's side: answers the WaveLayer panel in Illustrator (ai/) through the
// overlay helper. Illustrator sends selections over as .ai (vector smart objects) or PNG, updates
// those smart objects later, takes the layers selected here, and swaps colours. Photoshop never
// starts anything itself; it only answers (core/overlay/bridge.ts has the messages).

import { log } from "./log.ts";
import type { Overlay } from "./overlay.ts";
import { type BoardNode, type BridgeRequest, type LinkTarget, type PlanLeaf, type PsInfo, type PullResult, boardFiles, illustratorPlan, keepLinks, layerSvg, parseBridgeRequest, vectorKind } from "../core/overlay/bridge.ts";
import type { TreeLayer } from "../core/layers/tree.ts";
import { vectorFragment } from "../core/overlay/svgFragment.ts";
import type { PsHost } from "../ps/host.ts";

const LINKS_KEY = "wp.aiLinks";

/** a timer that doesn't keep a test process alive (unref where there is one) */
function later(fn: () => void, ms: number) {
  const t: any = setTimeout(fn, ms);
  t?.unref?.();
}

/** What the bridge needs from Photoshop (src/ps/uxpBridge.ts). */
export interface BridgePs {
  inboxPath(): Promise<string>;
  activeDocInfo(): { docId: number; name: string; ppi: number; width: number; height: number } | null;
  placeFromIllustrator(fileName: string, name: string, pixels: boolean, newDoc?: boolean): Promise<{ docId: number; layerId: number; docName: string }>;
  replaceFromIllustrator(docId: number, docName: string, layerId: number, fileName: string): Promise<{ docId: number }>;
  dropInbox(fileName: string): Promise<void>;
  foregroundHex(): string;
  setForegroundHex(hex: string): Promise<void>;
  layerExists(docId: number, layerId: number): boolean;
  revealLayer(docId: number, docName: string, layerId: number): Promise<void>;
  /** a text file in the plugin's temporary folder: its native path */
  writeTemp(name: string, text: string): Promise<{ path: string; remove(): Promise<void> }>;
  /** 画板 from Illustrator: a new document with every item a smart object (src/ps/uxpBridge.ts) */
  buildBoardFromIllustrator(req: { name: string; width: number; height: number; ppi: number; nodes: BoardNode[] }): Promise<{ docId: number; docName: string; placed: { link: string; layerId: number; name: string }[]; failed: string[] }>;
  /** a smart object's own file written out, and where the layer is */
  exportSmartContents(docId: number, layerId: number, name: string): Promise<{ path: string; rect: { left: number; top: number; right: number; bottom: number }; remove(): Promise<void> }>;
}

/** Layers for Illustrator: text and shape layers as SVG (editable there), vector smart objects as
 *  their own file (`how: "vector"`), the rest as PNG; a vector that can't be read goes as PNG. */
async function exportLayers(host: PsHost, bridgePs: BridgePs, docId: number, layers: { id: number; name: string; kind: string; how?: PlanLeaf["how"]; vectorKind?: "text" | "shape"; ext?: string }[], ppi: number): Promise<PullResult["files"]> {
  const session = "ai" + Date.now(), files: PullResult["files"] = [];
  for (const [i, l] of layers.entries()) {
    if (l.how === "vector" && l.ext) {
      try {
        const f = await bridgePs.exportSmartContents(docId, l.id, `waveplug_${session}_${i}.${l.ext}`);
        files.push({ path: f.path, name: l.name, left: f.rect.left, top: f.rect.top, width: f.rect.right - f.rect.left, height: f.rect.bottom - f.rect.top, how: "vector" });
        later(() => { void f.remove(); }, 120_000);
        continue;
      } catch (e) { log("warn", "bridge smart object contents", l.id, e); }
    }
    const vk = l.vectorKind ?? vectorKind(l.kind);
    if (vk && l.how !== "png") {
      try {
        const info = await host.layerDragInfo(docId, l.id, vk);
        const v = info.vector ? vectorFragment(info.vector) : null;
        if (v?.svg && info.rect) {
          const f = await bridgePs.writeTemp(`waveplug_${session}_${i}.svg`, layerSvg(v.svg, info.rect, ppi));
          files.push({ path: f.path, name: l.name, left: info.rect.left, top: info.rect.top, width: info.rect.right - info.rect.left, height: info.rect.bottom - info.rect.top, how: "svg" });
          later(() => { void f.remove(); }, 120_000);
          continue;
        }
        if (v && v.svg === null) log("info", "bridge vector fallback", l.id, v.reason);
      } catch (e) { log("warn", "bridge vector", l.id, e); }
    }
    const png = await host.exportLayerPng(docId, l.id, session, i);
    files.push({ path: png.path, name: l.name, left: png.rect.left, top: png.rect.top, width: png.rect.right - png.rect.left, height: png.rect.bottom - png.rect.top, how: "png" });
    // Illustrator embeds them; the temporary files go after a while
    later(() => { void png.remove(); }, 120_000);
  }
  return files;
}

function readLinks(): Record<string, LinkTarget> {
  try { return JSON.parse(localStorage.getItem(LINKS_KEY) ?? "{}") ?? {}; } catch { return {}; }
}
function saveLinks(l: Record<string, LinkTarget>) {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(keepLinks(l, 1000))); } catch (e) { log("warn", "bridge links not saved", e); }
}

/** The link of a layer that came from Illustrator ("发送" there), or null. */
export function linkOfLayer(docId: number, layerId: number): string | null {
  for (const [link, t] of Object.entries(readLinks())) if (t.docId === docId && t.layerId === layerId) return link;
  return null;
}

/** Asks the Illustrator panel to send a link again (it answers with an `update`) or to select its items. */
export function askIllustrator(overlay: Overlay, kind: "update" | "reveal", link: string) {
  overlay.sendBridge({ kind: kind === "update" ? "update-request" : "reveal-request", link });
  log("info", "bridge ask illustrator", kind, link);
}

/** 发送到 › Illustrator (WaveLayer's menu): layers `ids` of `docId` as PNG files, handed to the
 *  Illustrator panel, which places them in its current document at their place (`push`). */
export async function pushToIllustrator(overlay: Overlay, host: PsHost, bridgePs: BridgePs, docId: number, ids: number[]): Promise<number> {
  const info = bridgePs.activeDocInfo();
  const known = new Map(host.activeLayers(docId).map(l => [l.id, l]));
  const files = await exportLayers(host, bridgePs, docId, ids.map(id => known.get(id) ?? { id, name: `图层 ${id}`, kind: "" }), info?.ppi ?? 72);
  overlay.sendBridge({ kind: "push", docName: info?.name ?? "Photoshop", ppi: info?.ppi ?? 72, files });
  log("info", "bridge push", files.length);
  return files.length;
}

/** 当前画板置入 Illustrator (WaveLayer's menu): the artboard the selection is on (else the first,
 *  else the whole canvas), every layer the way it stays most editable (core/overlay/bridge.ts
 *  illustratorPlan), sent to the Illustrator panel, which puts it on a new artboard. */
export async function pushBoardToIllustrator(overlay: Overlay, host: PsHost, bridgePs: BridgePs, docId: number, layers: readonly TreeLayer[], selected: readonly number[]): Promise<{ count: number; name: string; notes: string[] }> {
  const info = bridgePs.activeDocInfo();
  const ppi = info?.ppi ?? 72;
  const plan = illustratorPlan(layers, selected, { name: info?.name ?? "Photoshop", width: info?.width ?? 0, height: info?.height ?? 0 });
  if (!plan.leaves.length) throw new Error(`「${plan.name}」上没有能发送的图层`);
  if (plan.leaves.length > 300) throw new Error(`「${plan.name}」上有 ${plan.leaves.length} 个图层，一次最多 300 个`);
  const files = await exportLayers(host, bridgePs, docId, plan.leaves.map(l => ({ ...l, kind: "" })), ppi);
  // against the artboard's corner, with the layer's place in groups and its looks
  const out = files.map((f, i) => {
    const l = plan.leaves[i];
    return { ...f, left: f.left - plan.left, top: f.top - plan.top, group: l.group, hidden: l.hidden, opacity: l.opacity, blend: l.blend };
  });
  overlay.sendBridge({ kind: "push", docName: info?.name ?? "Photoshop", ppi, files: out, board: { name: plan.name, width: plan.width, height: plan.height }, groups: plan.groups });
  log("info", "bridge push board", plan.name, out.length, JSON.stringify(out.map(f => f.how)));
  return { count: out.length, name: plan.name, notes: plan.notes };
}

export function attachIllustratorBridge(overlay: Overlay, bridgePs: BridgePs, host: PsHost, say: (text: string, kind: "info" | "ok" | "error") => void) {
  async function answer(r: BridgeRequest): Promise<unknown> {
    switch (r.kind) {
      case "info": {
        // asked every few seconds while the Illustrator panel is open: kept cheap (no layer lookups)
        const d = bridgePs.activeDocInfo();
        const info: PsInfo = { doc: d ? { name: d.name, ppi: d.ppi, width: d.width, height: d.height } : null, inbox: await bridgePs.inboxPath(), links: [] };
        return info;
      }
      case "place": {
        try {
          const placed = await bridgePs.placeFromIllustrator(r.fileName, r.name, r.pixels, r.newDoc === true);
          if (r.link && !r.pixels) {
            const links = readLinks();
            links[r.link] = { docId: placed.docId, docName: placed.docName, layerId: placed.layerId, name: r.name, at: Date.now() };
            saveLinks(links);
          }
          say(`已从 Illustrator 置入「${r.name}」`, "ok");
          return placed;
        } finally { await bridgePs.dropInbox(r.fileName); }
      }
      case "update": {
        try {
          const t = readLinks()[r.link];
          if (!t) throw new Error("Photoshop 里没有和它关联的图层（是在别的电脑或很久以前发送的？）。请重新发送");
          const done = await bridgePs.replaceFromIllustrator(t.docId, t.docName, t.layerId, r.fileName);
          const links = readLinks();
          links[r.link] = { ...t, docId: done.docId, at: Date.now() };
          saveLinks(links);
          say(`已从 Illustrator 更新「${t.name}」`, "ok");
          return { name: t.name, docName: t.docName };
        } finally { await bridgePs.dropInbox(r.fileName); }
      }
      case "reveal": {
        const t = readLinks()[r.link];
        if (!t) throw new Error("Photoshop 里没有和它关联的图层");
        await bridgePs.revealLayer(t.docId, t.docName, t.layerId);
        return { name: t.name, docName: t.docName };
      }
      case "pull": {
        const d = bridgePs.activeDocInfo();
        if (!d) throw new Error("Photoshop 没有打开的文档");
        const layers = host.activeLayers(d.docId);
        if (!layers.length) throw new Error("先在 Photoshop 里选中要取的图层");
        const out: PullResult = { docName: d.name, ppi: d.ppi, files: await exportLayers(host, bridgePs, d.docId, layers, d.ppi) };
        say(`已把 ${out.files.length} 个图层交给 Illustrator`, "ok");
        return out;
      }
      case "board": {
        try {
          const done = await bridgePs.buildBoardFromIllustrator(r);
          const links = readLinks(), at = Date.now();
          for (const p of done.placed) links[p.link] = { docId: done.docId, docName: done.docName, layerId: p.layerId, name: p.name, at };
          saveLinks(links);
          say(`已从 Illustrator 打开画板「${done.docName}」：${done.placed.length} 个智能对象` + (done.failed.length ? `，${done.failed.length} 个没置入` : ""), done.failed.length ? "error" : "ok");
          return { docName: done.docName, placed: done.placed.length, failed: done.failed };
        } finally { for (const f of boardFiles(r.nodes)) await bridgePs.dropInbox(f); }
      }
      case "get-color": return { hex: bridgePs.foregroundHex() };
      case "set-color": await bridgePs.setForegroundHex(r.hex); return { hex: r.hex };
    }
  }

  return overlay.onBridge(async raw => {
    const r = parseBridgeRequest(raw);
    if (!r) { log("warn", "bridge: not a request", JSON.stringify(raw)?.slice(0, 200)); return; }
    // info comes every few seconds: not worth a log line each time
    if (r.kind !== "info") log("info", "bridge request", r.kind, r.reqId);
    try {
      const value = await answer(r);
      overlay.sendBridge({ kind: "result", reqId: r.reqId, ok: true, value });
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      log("warn", "bridge request failed", r.kind, error);
      overlay.sendBridge({ kind: "result", reqId: r.reqId, ok: false, error });
    }
  });
}
