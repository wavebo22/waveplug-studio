// 牵手 Photoshop, Illustrator's side: a WebSocket to the WavePlug overlay helper (it runs while
// Photoshop runs; native/overlay/src/server.rs), introduced as "illustrator". Requests go to the
// Photoshop plugin and come back as results with the same id (core/overlay/bridge.ts).

import { type PullResult, parseBridgeResult } from "../core/overlay/bridge.ts";
import { BRIDGE_HELPER_VERSION, helperOutdated } from "../core/overlay/protocol.ts";

export const HELPER_URL = "ws://127.0.0.1:47821";
const RETRY_MS = 3000;

export interface PsLink {
  /** the helper is there and the Photoshop plugin is connected to it */
  readonly ready: boolean;
  readonly helper: boolean;
  /** the helper's version when it is too old to share (it would drop the Photoshop plugin for us) */
  readonly outdated: string | null;
  request<T = any>(msg: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onChange(cb: () => void): () => void;
  /** layers Photoshop sends over by itself (WaveLayer › 发送到 › Illustrator) */
  onPush(cb: (push: PullResult) => void): () => void;
  /** Photoshop asks for a link to be sent again ("update") or its items selected ("reveal") */
  onAsk(cb: (kind: "update" | "reveal", link: string) => void): () => void;
}

type Socket = { readyState: number; send(t: string): void; close(): void; onopen: any; onclose: any; onmessage: any; onerror: any };

export function connectPs(makeSocket: (url: string) => Socket = url => new WebSocket(url) as unknown as Socket): PsLink {
  let ws: Socket | null = null, helper = false, photoshop = false, seq = 0, outdated: string | null = null;
  const waiting = new Map<string, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<() => void>();
  const pushListeners = new Set<(push: PullResult) => void>();
  const askListeners = new Set<(kind: "update" | "reveal", link: string) => void>();
  const changed = () => listeners.forEach(cb => { try { cb(); } catch { /* listener */ } });
  const failAll = (why: string) => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error(why)); } waiting.clear(); };

  function open() {
    try { ws = makeSocket(HELPER_URL); } catch { ws = null; setTimeout(open, RETRY_MS); return; }
    const s = ws;
    s.onopen = () => { helper = true; s.send(JSON.stringify({ type: "join", role: "illustrator" })); changed(); };
    s.onmessage = (e: { data: unknown }) => {
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      // a helper from before 0.15 serves one client: staying would cut the Photoshop plugin off
      // (and its reconnecting would cut us off, back and forth). Leave and don't come back.
      if (m?.type === "ready" && typeof m.version === "string" && helperOutdated(m.version, BRIDGE_HELPER_VERSION)) {
        outdated = m.version;
        helper = false;
        ws = null;
        try { s.close(); } catch { /* closing */ }
        changed();
        return;
      }
      if (m?.type === "peer" && m.role === "photoshop") { photoshop = !!m.connected; if (!photoshop) failAll("Photoshop 的 WavePlug 插件断开了"); changed(); return; }
      if (m?.type !== "bridge") return;
      if (m.msg?.kind === "push" && Array.isArray(m.msg.files)) {
        const b = m.msg.board;
        const push: PullResult = { docName: String(m.msg.docName ?? "Photoshop"), ppi: Number(m.msg.ppi) || 72, files: m.msg.files,
          ...(b && Number(b.width) > 0 && Number(b.height) > 0 ? { board: { name: String(b.name ?? "Photoshop"), width: Number(b.width), height: Number(b.height) } } : {}),
          ...(m.msg.groups && typeof m.msg.groups === "object" ? { groups: m.msg.groups } : {}) };
        pushListeners.forEach(cb => { try { cb(push); } catch { /* listener */ } });
        return;
      }
      if ((m.msg?.kind === "update-request" || m.msg?.kind === "reveal-request") && typeof m.msg.link === "string" && m.msg.link) {
        const kind = m.msg.kind === "update-request" ? "update" : "reveal";
        askListeners.forEach(cb => { try { cb(kind, m.msg.link); } catch { /* listener */ } });
        return;
      }
      const r = parseBridgeResult(m.msg);
      if (!r) return;
      if (r.kind === "missing") {
        photoshop = false; changed();
        const w = r.reqId ? waiting.get(r.reqId) : undefined;
        if (w && r.reqId) { clearTimeout(w.timer); waiting.delete(r.reqId); w.reject(new Error("Photoshop 的 WavePlug 插件没有连接")); }
        return;
      }
      const w = waiting.get(r.reqId);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(r.reqId);
      if (r.ok) w.resolve(r.value); else w.reject(new Error(r.error));
    };
    s.onclose = () => {
      if (ws !== s || outdated) return;
      const was = helper;
      ws = null; helper = false; photoshop = false;
      failAll("和 Photoshop 的连接断开了");
      if (was) changed();
      setTimeout(open, RETRY_MS);
    };
    s.onerror = () => { /* onclose follows */ };
  }
  open();

  return {
    get ready() { return helper && photoshop; },
    get helper() { return helper; },
    get outdated() { return outdated; },
    request<T>(msg: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
      if (!ws || ws.readyState !== 1 || !helper) return Promise.reject(new Error("Photoshop 没有运行，或 WavePlug 外置框架没有启动"));
      if (!photoshop) return Promise.reject(new Error("Photoshop 的 WavePlug 插件没有连接"));
      const reqId = "r" + (++seq) + "_" + Date.now();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error("Photoshop 没有回应（可能正忙）")); }, timeoutMs);
        waiting.set(reqId, { resolve, reject, timer });
        ws!.send(JSON.stringify({ type: "bridge", to: "photoshop", msg: { ...msg, reqId } }));
      });
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onPush(cb) { pushListeners.add(cb); return () => pushListeners.delete(cb); },
    onAsk(cb) { askListeners.add(cb); return () => askListeners.delete(cb); },
  };
}
