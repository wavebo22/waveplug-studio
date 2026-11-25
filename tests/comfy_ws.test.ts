import { test } from "node:test";
import assert from "node:assert/strict";
import { ComfyClient } from "../src/core/comfy/client.ts";

const done = { outputs: {}, status: { completed: true } };

function client(WS: new (url: string) => any) {
  let historyCalls = 0;
  const fetch = (async () => { historyCalls++; return new Response(JSON.stringify({ p: done })); }) as unknown as typeof globalThis.fetch;
  return { c: new ComfyClient("http://127.0.0.1:8188", { fetch, WebSocket: WS }), calls: () => historyCalls };
}

test("waitFor falls back to /history when the WebSocket closes before opening (no error event)", async () => {
  class Ws { onclose?: (e: unknown) => void; constructor() { setTimeout(() => this.onclose?.({ code: 1006 }), 5); } close() {} }
  const { c, calls } = client(Ws);
  const h = await c.waitFor("p", () => {}, { pollMs: 10, timeoutMs: 2000 });
  assert.deepEqual(h, done);
  assert.ok(calls() >= 1);
});

test("waitFor falls back to /history when the WebSocket never answers", async () => {
  let closed = 0;
  class Ws { close() { closed++; } }
  const { c, calls } = client(Ws);
  const h = await c.waitFor("p", () => {}, { pollMs: 10, timeoutMs: 50 });
  assert.deepEqual(h, done);
  assert.ok(calls() >= 1);
  assert.equal(closed, 1);
});

test("a failed connection is retried by the next job", async () => {
  let made = 0;
  class Ws { onerror?: () => void; onclose?: () => void; constructor() { made++; setTimeout(() => { this.onerror?.(); this.onclose?.(); }, 1); } close() {} }
  const { c } = client(Ws);
  await c.waitFor("p", () => {}, { pollMs: 10, timeoutMs: 2000 });
  await c.waitFor("p", () => {}, { pollMs: 10, timeoutMs: 2000 });
  assert.equal(made, 2);
});

test("waitFor gives up when ComfyUI stops answering (closed / crashed) instead of waiting 30 minutes", async () => {
  const fetch = (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof globalThis.fetch;
  const c = new ComfyClient("http://127.0.0.1:8188", { fetch });
  const t0 = Date.now();
  await assert.rejects(c.waitFor("p", () => {}, { pollMs: 5, lostMs: 40 }), /连接断了/);
  assert.ok(Date.now() - t0 < 2000);
});

test("waitFor gives up when the job is in neither /history nor /queue (deleted in ComfyUI)", async () => {
  const paths: string[] = [];
  const fetch = (async (url: string) => {
    const path = String(url).replace("http://127.0.0.1:8188", "");
    paths.push(path);
    return new Response(JSON.stringify(path === "/queue" ? { queue_running: [], queue_pending: [] } : {}));
  }) as unknown as typeof globalThis.fetch;
  const c = new ComfyClient("http://127.0.0.1:8188", { fetch });
  await assert.rejects(c.waitFor("p", () => {}, { pollMs: 5, queueCheckMs: 10 }), /不在 ComfyUI 的队列里/);
  assert.ok(paths.filter(p => p === "/queue").length >= 2);
});

test("waitFor keeps waiting while the job is still queued", async () => {
  let historyReads = 0;
  const fetch = (async (url: string) => {
    const path = String(url).replace("http://127.0.0.1:8188", "");
    if (path === "/queue") return new Response(JSON.stringify({ queue_running: [], queue_pending: [[1, "p"]] }));
    historyReads++;
    return new Response(JSON.stringify(historyReads > 8 ? { p: done } : {}));
  }) as unknown as typeof globalThis.fetch;
  const c = new ComfyClient("http://127.0.0.1:8188", { fetch });
  assert.deepEqual(await c.waitFor("p", () => {}, { pollMs: 5, queueCheckMs: 5 }), done);
});

test("a job interrupted elsewhere says so", async () => {
  const h = { outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_interrupted", {}]] } };
  const fetch = (async () => new Response(JSON.stringify({ p: h }))) as unknown as typeof globalThis.fetch;
  const c = new ComfyClient("http://127.0.0.1:8188", { fetch });
  await assert.rejects(c.waitFor("p", () => {}, { pollMs: 5 }), /被中断/);
});
