// Network access inside UXP: fetch with an XMLHttpRequest fallback, plus a connection
// diagnostic that tries every transport and reports exactly what happened.

import { log, withTimeout } from "../app/log.ts";

/** Minimal Response-like object built from an XHR, enough for ComfyClient. */
function xhrFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(init.method ?? "GET", url, true);
    x.responseType = "arraybuffer";
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) x.setRequestHeader(k, v);
    x.onload = () => {
      const buf = x.response as ArrayBuffer;
      resolve({
        ok: x.status >= 200 && x.status < 300,
        status: x.status,
        // UXP exposes Response but not TextDecoder. Keep the original binary body intact.
        text: async () => new Response(buf).text(),
        json: async () => new Response(buf).json(),
        arrayBuffer: async () => buf,
      } as unknown as Response);
    };
    x.onerror = () => reject(new TypeError(`XHR 网络错误（status ${x.status}）`));
    x.ontimeout = () => reject(new TypeError("XHR 超时"));
    x.send((init.body as XMLHttpRequestBodyInit | null) ?? null);
  });
}

let preferXhr = false;

/** fetch first; if it fails at the network level, retry the same request over XHR and stick with it. */
export const uxpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!preferXhr && typeof fetch === "function") {
    try { return await fetch(url, init); }
    catch (e) {
      if (typeof XMLHttpRequest !== "function") throw e;
      log("warn", "fetch failed, trying XHR", url, e);
    }
  }
  const r = await xhrFetch(url, init);
  if (!preferXhr) log("info", "XHR works, using it from now on");
  preferXhr = true;
  return r;
}) as typeof fetch;

function describe(e: unknown): string {
  const err = e as Error;
  return `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
}

/** Tries fetch, XHR and WebSocket against the ComfyUI address and returns one line per check. */
export async function diagnose(base: string): Promise<string[]> {
  const out: string[] = [];
  const add = (s: string) => { out.push(s); log("info", "diagnose", s); };
  add(`地址 ${base}`);
  add(`可用：fetch=${typeof fetch} XHR=${typeof XMLHttpRequest} WebSocket=${typeof WebSocket} Response=${typeof Response} TextEncoder=${typeof TextEncoder} TextDecoder=${typeof TextDecoder}`);
  const url = base.replace(/\/$/, "") + "/system_stats";
  try {
    const r = await withTimeout(fetch(url), 5000, "fetch ");
    add(`fetch → HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
  } catch (e) { add(`fetch → 失败 ${describe(e)}`); }
  try {
    const r = await withTimeout(xhrFetch(url), 5000, "XHR ");
    add(`XHR → HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
  } catch (e) { add(`XHR → 失败 ${describe(e)}`); }
  try {
    const ws = new WebSocket(base.replace(/^http/, "ws").replace(/\/$/, "") + "/ws?clientId=waveplug-diagnose");
    const r = await withTimeout(new Promise<string>((res, rej) => {
      ws.onopen = () => res("已连接");
      ws.onerror = ev => rej(new Error("onerror " + ((ev as any)?.message ?? "")));
      ws.onclose = ev => rej(new Error(`closed code=${(ev as CloseEvent).code} reason=${(ev as CloseEvent).reason}`));
    }), 5000, "WebSocket ");
    add(`WebSocket → ${r}`);
    ws.close();
  } catch (e) { add(`WebSocket → 失败 ${describe(e)}`); }
  return out;
}
