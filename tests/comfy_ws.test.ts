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
