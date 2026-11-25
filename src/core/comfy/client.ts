// ComfyUI native API client. No custom nodes or server changes are required.
// fetch / WebSocket are injected so the same code runs in UXP, the browser preview and tests.

import type { ApiGraph } from "../workflow/api.ts";
import type { ObjectInfo } from "../workflow/uiToApi.ts";
import { loraNamesFrom } from "../workflow/loras.ts";

export interface ComfyDeps {
  fetch: typeof fetch;
  WebSocket?: new (url: string) => WebSocket;
}

export interface ImageRef { filename: string; subfolder: string; type: string }

export type JobEvent =
  | { type: "queued"; promptId: string; position: number }
  | { type: "running"; promptId: string; node: string | null; nodeTitle?: string }
  | { type: "progress"; promptId: string; value: number; max: number; node: string | null }
  | { type: "done"; promptId: string }
  | { type: "error"; promptId: string; message: string; node?: string }
  | { type: "interrupted"; promptId: string }
  /** nodes ComfyUI reused from its cache (loaders listed here were NOT reloaded) */
  | { type: "cached"; promptId: string; nodes: string[] };

/** UTF-8 encoder — UXP has no TextEncoder/TextDecoder. */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else { out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); c = 0; }
  }
  return new Uint8Array(out);
}

export class ComfyError extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) { super(message); this.detail = detail; }
}

export class ComfyClient {
  readonly clientId = "waveplug-" + Math.random().toString(36).slice(2, 10);
  private ws: WebSocket | null = null;
  private listeners = new Map<string, (e: JobEvent) => void>();
  private wsReady: Promise<void> | null = null;

  readonly base: string;
  private deps: ComfyDeps;
  constructor(base: string, deps: ComfyDeps) { this.base = base; this.deps = deps; }

  private url(path: string) { return this.base.replace(/\/$/, "") + path; }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try { res = await this.deps.fetch(this.url(path), init); }
    catch (e) { throw new ComfyError(`无法连接 ComfyUI（${this.base}）：${(e as Error).message}`); }
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    if (!res.ok) {
      if (res.status === 403) throw new ComfyError("ComfyUI 拒绝了来自插件的请求（来源校验 403）", body);
      throw new ComfyError(describeError(body) ?? `ComfyUI 返回 HTTP ${res.status}`, body);
    }
    return body as T;
  }

  systemStats() { return this.json<{ system: { comfyui_version?: string; python_version?: string }; devices: { name: string; vram_total: number; vram_free: number }[] }>("/system_stats"); }
  objectInfo() { return this.json<ObjectInfo>("/object_info"); }
  /** LoRA files ComfyUI can load (re-read each time so new files show up without a restart). */
  async loraNames(): Promise<string[]> {
    const info = await this.json<ObjectInfo>("/object_info/LoraLoaderModelOnly").catch(() => this.json<ObjectInfo>("/object_info/LoraLoader"));
    return loraNamesFrom(info);
  }

  /** Saved UI-format workflows from ComfyUI's user directory (native userdata API). */
  async listWorkflows(): Promise<string[]> {
    const list = await this.json<string[]>("/api/userdata?dir=workflows&recurse=true&split=false");
    return list.filter(p => p.endsWith(".json"));
  }
  readWorkflow(path: string) {
    return this.json<unknown>("/api/userdata/" + encodeURIComponent("workflows/" + path));
  }

  async uploadImage(bytes: Uint8Array, name: string, subfolder = "waveplug"): Promise<string> {
    // multipart body built by hand: UXP's FormData/Blob support varies between host versions
    const boundary = "----waveplug" + Math.random().toString(36).slice(2);
    const enc = { encode: utf8 };
    const field = (k: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    const head = enc.encode(field("subfolder", subfolder) + field("type", "input") + field("overwrite", "true") +
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    const r = await this.json<{ name: string; subfolder?: string }>("/upload/image", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary }, body,
    });
    if (!r?.name) throw new ComfyError("上传图片后 ComfyUI 未返回文件名");
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  async queue(api: ApiGraph): Promise<{ promptId: string; number: number }> {
    const r = await this.json<{ prompt_id?: string; number?: number; error?: unknown; node_errors?: unknown }>(
      "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: api, client_id: this.clientId }) });
    if (!r.prompt_id) throw new ComfyError(describeError(r) ?? "ComfyUI 未接受任务", r);
    return { promptId: r.prompt_id, number: r.number ?? 0 };
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const r = await this.json<Record<string, HistoryEntry>>("/history/" + encodeURIComponent(promptId));
    return r?.[promptId] ?? null;
  }

  async view(img: ImageRef): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const res = await this.deps.fetch(this.url("/view?" + q.toString()));
    if (!res.ok) throw new ComfyError(`读取结果图片失败 HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Native /free: unloads models and clears ComfyUI's node cache, so the next job runs every node. */
  async freeCache(): Promise<void> {
    await this.json("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
  }

  /** Cancels only our own job: running → targeted interrupt, queued → delete from queue. */
  async cancel(promptId: string): Promise<void> {
    const q = await this.json<{ queue_running: unknown[][]; queue_pending: unknown[][] }>("/queue");
    if (q.queue_pending.some(item => item[1] === promptId)) {
      await this.json("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
    } else if (q.queue_running.some(item => item[1] === promptId)) {
      await this.json("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) });
    }
  }

  // ── progress over WebSocket (falls back to polling /history when unavailable) ──

  /** Opens the progress socket. Always settles: a close before open, an error or no answer within
   *  `timeoutMs` rejects, and waitFor then polls /history alone. */
  private connectWs(timeoutMs = 5000): Promise<void> {
    if (this.wsReady) return this.wsReady;
    const WS = this.deps.WebSocket;
    if (!WS) return Promise.reject(new Error("WebSocket 不可用"));
    const ready: Promise<void> = new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WS(this.base.replace(/^http/, "ws").replace(/\/$/, "") + "/ws?clientId=" + this.clientId); }
      catch (e) { reject(e); return; }
      let opened = false, failed = false;
      const fail = (why: string) => {
        if (opened || failed) return;
        failed = true;
        clearTimeout(timer);
        if (this.wsReady === ready) this.wsReady = null;
        reject(new Error(why));
      };
      const timer = setTimeout(() => { fail("WebSocket 连接超时"); try { ws.close(); } catch { /* already gone */ } }, timeoutMs);
      ws.onopen = () => {
        if (failed) { try { ws.close(); } catch { /* already gone */ } return; }
        opened = true; clearTimeout(timer); this.ws = ws; resolve();
      };
      ws.onerror = () => fail("WebSocket 连接失败");
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (this.wsReady === ready) this.wsReady = null;
        fail("WebSocket 连接前已关闭");
      };
      ws.onmessage = ev => { if (typeof ev.data === "string") this.dispatch(ev.data); };
    });
    this.wsReady = ready;
    return ready;
  }

  private dispatch(raw: string) {
    let msg: { type: string; data: Record<string, any> };
    try { msg = JSON.parse(raw); } catch { return; }
    const d = msg.data ?? {}, id = d.prompt_id as string | undefined;
    const fire = (e: JobEvent) => { if (id) this.listeners.get(id)?.(e); };
    switch (msg.type) {
      case "executing": if (id && d.node !== null) fire({ type: "running", promptId: id, node: d.node ?? null }); break;
      case "progress": if (id) fire({ type: "progress", promptId: id, value: d.value, max: d.max, node: d.node ?? null }); break;
      case "execution_cached": if (id) fire({ type: "cached", promptId: id, nodes: (d.nodes ?? []).map(String) }); break;
      case "execution_success": if (id) fire({ type: "done", promptId: id }); break;
      case "execution_error": if (id) fire({ type: "error", promptId: id, message: d.exception_message ?? "执行出错", node: d.node_id }); break;
      case "execution_interrupted": if (id) fire({ type: "interrupted", promptId: id }); break;
    }
  }

  /**
   * Waits for a job to finish. Uses WebSocket events when available and always confirms
   * through /history, so a dropped socket can't lose a result.
   *
   * Gives up early instead of waiting out `timeoutMs` (30 min) when
   * - ComfyUI can't be reached for `lostMs` in a row (closed, crashed, restarted), or
   * - the job is in neither /history nor /queue twice in a row, `queueCheckMs` apart (deleted
   *   from the queue in ComfyUI's own page, or lost in a restart: no event says so).
   */
  async waitFor(promptId: string, onEvent: (e: JobEvent) => void, opts: { pollMs?: number; timeoutMs?: number; lostMs?: number; queueCheckMs?: number; signal?: { aborted: boolean } } = {}): Promise<HistoryEntry> {
    const pollMs = opts.pollMs ?? 1500, deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    const lostMs = opts.lostMs ?? 30_000, queueCheckMs = opts.queueCheckMs ?? 10_000;
    let settled = false, interrupted = false;
    let wake: (() => void) | null = null;
    this.listeners.set(promptId, e => {
      onEvent(e);
      if (e.type === "interrupted") interrupted = true;
      if (e.type === "done" || e.type === "error" || e.type === "interrupted") { settled = true; wake?.(); }
    });
    /** since when ComfyUI hasn't answered (null: it answered last time) */
    let lostSince: number | null = null;
    let queueCheckedAt = Date.now(), missing = 0;
    /** notes whether ComfyUI answered; too long without an answer throws */
    const answered = (yes: boolean) => {
      if (yes) { lostSince = null; return; }
      lostSince ??= Date.now();
      if (Date.now() - lostSince >= lostMs) throw new ComfyError(`和 ComfyUI 的连接断了（${Math.round(lostMs / 1000)} 秒没有回应）：ComfyUI 可能已关闭或崩溃，这次生成没有结果`);
    };
    try {
      await this.connectWs(Math.min(5000, opts.timeoutMs ?? 5000)).catch(() => undefined);
      for (;;) {
        if (opts.signal?.aborted) throw new ComfyError("已取消");
        const got = await this.history(promptId).catch((): typeof LOST => LOST);
        answered(got !== LOST);
        const h = got === LOST ? null : got;
        if (h?.status?.completed || h?.status?.status_str === "error" || settled && h) {
          if (h.status?.status_str === "error") throw new ComfyError(historyError(h) ?? (interrupted || wasInterrupted(h) ? "任务在 ComfyUI 里被中断了" : "ComfyUI 执行失败"), h);
          return h;
        }
        if (!h && got !== LOST && Date.now() - queueCheckedAt >= queueCheckMs) {
          queueCheckedAt = Date.now();
          const q = await this.json<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue").catch((): typeof LOST => LOST);
          answered(q !== LOST);
          if (q !== LOST) {
            const listed = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some(item => item?.[1] === promptId);
            missing = listed ? 0 : missing + 1;
            if (missing >= 2) throw new ComfyError("这个任务已经不在 ComfyUI 的队列里了（可能在 ComfyUI 里被删除，或 ComfyUI 重启过），没有结果");
          }
        }
        if (Date.now() > deadline) throw new ComfyError("等待 ComfyUI 结果超时");
        await new Promise<void>(r => { wake = r; setTimeout(r, settled ? 200 : pollMs); });
        wake = null;
      }
    } finally {
      this.listeners.delete(promptId);
    }
  }

  close() { this.ws?.close(); }
}

/** The surface the app uses — lets the browser preview swap in a fake backend. */
export type Comfy = Pick<ComfyClient, "base" | "systemStats" | "objectInfo" | "loraNames" | "listWorkflows" | "readWorkflow" | "uploadImage" | "queue" | "history" | "view" | "cancel" | "waitFor" | "freeCache">;

export interface HistoryEntry {
  outputs: Record<string, { images?: ImageRef[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

export function outputImage(h: HistoryEntry, nodeId: string, index = 0): ImageRef {
  const imgs = h.outputs?.[nodeId]?.images ?? [];
  if (!imgs.length) throw new ComfyError(`输出节点 #${nodeId} 没有返回图片`);
  if (!imgs[index]) throw new ComfyError(`输出节点 #${nodeId} 只返回了 ${imgs.length} 张图片，没有第 ${index + 1} 张`);
  return imgs[index];
}

/** a request ComfyUI didn't answer (waitFor) */
const LOST: unique symbol = Symbol("lost");

function wasInterrupted(h: HistoryEntry): boolean {
  return !!h.status?.messages?.some(x => x[0] === "execution_interrupted");
}

function historyError(h: HistoryEntry): string | null {
  const m = h.status?.messages?.find(x => x[0] === "execution_error");
  if (!m) return null;
  const d = m[1] as { exception_message?: string; node_id?: string; node_type?: string };
  return `节点 #${d.node_id ?? "?"} ${d.node_type ?? ""} 执行失败：${d.exception_message ?? ""}`.trim();
}

/** Turns /prompt validation errors into one readable line. */
export function describeError(body: unknown): string | null {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 300) : null;
  const b = body as { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type: string; errors: { message: string; details: string }[] }> };
  const parts: string[] = [];
  if (b.error?.message) parts.push(b.error.message + (b.error.details ? `（${b.error.details}）` : ""));
  for (const [id, e] of Object.entries(b.node_errors ?? {})) {
    for (const x of e.errors ?? []) parts.push(`#${id} ${e.class_type}：${x.message}${x.details ? " " + x.details : ""}`);
  }
  return parts.length ? parts.join("；") : null;
}

/** Width/height from a PNG header without decoding it. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}
