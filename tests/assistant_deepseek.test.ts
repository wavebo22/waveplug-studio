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

test("DeepSeek 看图：图片放在 user 消息的 image_url 块里，不开 JSON 模式", async () => {
  let body: any = null;
  const f = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return reply(200, { choices: [{ finish_reason: "stop", message: { content: "```json\n{\"issues\":[]}\n```" } }] }); }) as unknown as typeof fetch;
  const r = await deepseekJson(f, { key: "k", model: "deepseek-flash" }, { system: "s", user: "看图", images: ["data:image/png;base64,AAAA"] });
  assert.deepEqual(body.messages[1].content, [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
  assert.equal("response_format" in body, false);
  assert.deepEqual(r.value, { issues: [] });
});

test("DeepSeek：可以关掉思考模式或指定思考强度，不写就用 DeepSeek 的默认", async () => {
  const bodies: any[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return reply(200, { choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
  }) as unknown as typeof fetch;
  await deepseekJson(f, { key: "k" }, { system: "", user: "", thinking: "off" });
  await deepseekJson(f, { key: "k" }, { system: "", user: "", thinking: "low" });
  await deepseekJson(f, { key: "k" }, { system: "", user: "" });
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.deepEqual(bodies[1].thinking, { type: "enabled" });
  assert.equal(bodies[1].reasoning_effort, "low");
  assert.equal(bodies[2].thinking, undefined);
});
