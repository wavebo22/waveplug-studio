import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekError, deepseekJson, parseJsonAnswer } from "../src/core/assistant/deepseek.ts";

const reply = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300, status, text: async () => typeof body === "string" ? body : JSON.stringify(body),
} as unknown as Response);

test("DeepSeek：JSON 模式请求，带 Key 和模型，返回解析后的对象", async () => {
  let sent: any = null, url = "";
  const f = (async (u: string, init: RequestInit) => {
    url = u; sent = { headers: init.headers, body: JSON.parse(String(init.body)) };
    return reply(200, { model: "deepseek-chat", choices: [{ finish_reason: "stop", message: { content: "{\"renames\":[]}" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  }) as unknown as typeof fetch;
  const r = await deepseekJson(f, { key: " sk-test ", model: "" }, { system: "s", user: "u" });
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer sk-test");
  assert.equal(sent.body.model, "deepseek-chat");
  assert.deepEqual(sent.body.response_format, { type: "json_object" });
  assert.deepEqual(r.value, { renames: [] });
  assert.deepEqual(r.usage, { prompt: 10, completion: 3 });
});

test("DeepSeek：没有 Key、Key 错、余额不足、被截断都给出能看懂的原因", async () => {
  const never = (async () => { throw new Error("不该发送"); }) as unknown as typeof fetch;
  await assert.rejects(deepseekJson(never, { key: "" }, { system: "", user: "" }), /还没有填写/);
  const with401 = (async () => reply(401, { error: { message: "Authentication Fails" } })) as unknown as typeof fetch;
  await assert.rejects(deepseekJson(with401, { key: "k" }, { system: "", user: "" }), (e: unknown) => e instanceof DeepSeekError && e.status === 401 && /Key 不对/.test(e.message));
  const with402 = (async () => reply(402, "x")) as unknown as typeof fetch;
  await assert.rejects(deepseekJson(with402, { key: "k" }, { system: "", user: "" }), /余额不足/);
  const cut = (async () => reply(200, { choices: [{ finish_reason: "length", message: { content: "{\"ren" } }] })) as unknown as typeof fetch;
  await assert.rejects(deepseekJson(cut, { key: "k" }, { system: "", user: "" }), /截断/);
  const down = (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch;
  await assert.rejects(deepseekJson(down, { key: "k" }, { system: "", user: "" }), /连不上 DeepSeek/);
});

test("回复外面包了 ```json 也能读", () => {
  assert.deepEqual(parseJsonAnswer("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.throws(() => parseJsonAnswer("好的"), /不是有效的 JSON/);
});
