import test from "node:test";
import assert from "node:assert/strict";
import { diagnose, uxpFetch } from "../src/ps/net.ts";
import { ComfyClient } from "../src/core/comfy/client.ts";

test("UXP diagnostic and XHR fallback work without TextDecoder, preserving UTF-8 and binary", async () => {
  const NativeResponse = globalThis.Response;
  const original = { fetch: globalThis.fetch, XMLHttpRequest: globalThis.XMLHttpRequest,
    WebSocket: globalThis.WebSocket, TextDecoder: globalThis.TextDecoder };
  const body = JSON.stringify({ system: { comfyui_version: "测试 0.37.0 🐬" } });
  const bytes = Uint8Array.from(Buffer.from(body, "utf8"));
  const png = Uint8Array.from([137, 80, 78, 71, 0, 255, 128, 254]);
  let requests = 0;
  class Xhr {
    status = 200;
    responseType = "";
    response: ArrayBuffer = bytes.slice().buffer;
    onload?: () => void;
    open(_method: string, url: string) { if (url.includes("/view?")) this.response = png.slice().buffer; }
    setRequestHeader() {}
    send() { requests++; queueMicrotask(() => this.onload?.()); }
  }
  class Ws {
    onopen?: () => void;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    close() {}
  }
  try {
    // Response is supported in UXP; TextDecoder is not. Model the actual host boundary.
    Object.assign(globalThis, {
      TextDecoder: undefined,
      fetch: async () => new NativeResponse(bytes),
      XMLHttpRequest: Xhr,
      WebSocket: Ws,
    });
    const lines = await diagnose("http://127.0.0.1:8188");
    assert.ok(lines.some(line => line.startsWith("XHR → HTTP 200")), lines.join("\n"));
    assert.ok(lines.some(line => line.startsWith("WebSocket → 已连接")));
    globalThis.fetch = async () => { throw new TypeError("simulated fetch network failure"); };
    const client = new ComfyClient("http://127.0.0.1:8188", { fetch: uxpFetch });
    assert.equal((await client.systemStats()).system.comfyui_version, "测试 0.37.0 🐬");
    const r = await uxpFetch("http://127.0.0.1:8188/system_stats");
    assert.deepEqual(await r.json(), JSON.parse(body));
    assert.deepEqual(await client.view({filename:"sample.png",subfolder:"",type:"output"}), png);
    assert.equal(requests, 4);
  } finally { Object.assign(globalThis, original); }
});
