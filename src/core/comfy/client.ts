// ComfyUI native API client. No custom nodes or server changes are required.
// fetch / WebSocket are injected so the same code runs in UXP, the browser preview and tests.

import type { ApiGraph } from "../workflow/api.ts";
import type { ObjectInfo } from "../workflow/uiToApi.ts";

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
  | { type: "interrupted"; promptId: string };

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

  /** Saved UI-format workflows from ComfyUI's user directory (native userdata API). */
  async listWorkflows(): Promise<string[]> {
    const list = await this.json<string[]>("/api/userdata?dir=workflows&recurse=true&split=false");
    return list.filter(p => p.endsWith(".json"));
  }
  readWorkflow(path: string) {
    return this.json<unknown>("/api/userdata/" + encodeURIComponent("workflows/" + path));
  }

  async uploadImage(bytes: Uint8Array, name: string, subfolder = "waveplug"): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([bytes as BlobPart], { type: "image/png" }), name);
    form.append("subfolder", subfolder);
    form.append("type", "input");
    form.append("overwrite", "true");
    const r = await this.json<{ name: string; subfolder?: string }>("/upload/image", { method: "POST", body: form });
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

  private connectWs(): Promise<void> {
    if (this.wsReady) return this.wsReady;
    const WS = this.deps.WebSocket;
    if (!WS) return Promise.reject(new Error("WebSocket 不可用"));
    this.wsReady = new Promise((resolve, reject) => {
      const ws = new WS(this.base.replace(/^http/, "ws").replace(/\/$/, "") + "/ws?clientId=" + this.clientId);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => { this.wsReady = null; reject(new Error("WebSocket 连接失败")); };
      ws.onclose = () => { this.ws = null; this.wsReady = null; };
      ws.onmessage = ev => { if (typeof ev.data === "string") this.dispatch(ev.data); };
    });
    return this.wsReady;
  }

  private dispatch(raw: string) {
    let msg: { type: string; data: Record<string, any> };
    try { msg = JSON.parse(raw); } catch { return; }
    const d = msg.data ?? {}, id = d.prompt_id as string | undefined;
    const fire = (e: JobEvent) => { if (id) this.listeners.get(id)?.(e); };
    switch (msg.type) {
      case "executing": if (id && d.node !== null) fire({ type: "running", promptId: id, node: d.node ?? null }); break;
      case "progress": if (id) fire({ type: "progress", promptId: id, value: d.value, max: d.max, node: d.node ?? null }); break;
      case "execution_success": if (id) fire({ type: "done", promptId: id }); break;
      case "execution_error": if (id) fire({ type: "error", promptId: id, message: d.exception_message ?? "执行出错", node: d.node_id }); break;
      case "execution_interrupted": if (id) fire({ type: "interrupted", promptId: id }); break;
    }
  }

  /**
   * Waits for a job to finish. Uses WebSocket events when available and always confirms
   * through /history, so a dropped socket can't lose a result.
   */
  async waitFor(promptId: string, onEvent: (e: JobEvent) => void, opts: { pollMs?: number; timeoutMs?: number; signal?: { aborted: boolean } } = {}): Promise<HistoryEntry> {
    const pollMs = opts.pollMs ?? 1500, deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    let settled = false;
    let wake: (() => void) | null = null;
    this.listeners.set(promptId, e => {
      onEvent(e);
      if (e.type === "done" || e.type === "error" || e.type === "interrupted") { settled = true; wake?.(); }
    });
    try {
      await this.connectWs().catch(() => undefined);
      for (;;) {
        if (opts.signal?.aborted) throw new ComfyError("已取消");
        const h = await this.history(promptId).catch(() => null);
        if (h?.status?.completed || h?.status?.status_str === "error" || settled && h) {
          if (h.status?.status_str === "error") throw new ComfyError(historyError(h) ?? "ComfyUI 执行失败", h);
          return h;
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
