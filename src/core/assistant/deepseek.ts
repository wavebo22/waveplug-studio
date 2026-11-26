// DeepSeek 接入: one chat request that answers with a JSON object (the AI assistant's features ask
// for a plan, never free text). Pure apart from the `fetch` passed in, so it is tested without the
// network (tests/assistant_deepseek.test.ts). The key comes from 功能设置 in the WavePlug program.

export const DEEPSEEK_BASE = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export interface DeepSeekConfig {
  key: string;
  /** deepseek-chat by default; empty: the default */
  model?: string;
  /** https://api.deepseek.com by default (tests, a proxy) */
  base?: string;
}

export interface JsonRequest {
  system: string;
  user: string;
  /** the answer's length limit in tokens (default 8000, DeepSeek's maximum for deepseek-chat) */
  maxTokens?: number;
  temperature?: number;
}

/** What the request cost, for the log and the status line. */
export interface Usage { prompt: number; completion: number }

export class DeepSeekError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "DeepSeekError"; this.status = status; }
}

/** The user-facing reason for an HTTP status from DeepSeek (https://api-docs.deepseek.com/quick_start/error_codes). */
export function statusMessage(status: number, detail = ""): string {
  const d = detail ? `（${detail.slice(0, 120)}）` : "";
  switch (status) {
    case 400: return "DeepSeek 拒绝了请求格式" + d;
    case 401: return "DeepSeek API Key 不对：请在 WavePlug 程序 › 功能设置 › AI 助手 里重新填写";
    case 402: return "DeepSeek 账户余额不足，请到 DeepSeek 开放平台充值";
    case 422: return "DeepSeek 不接受请求参数" + d + "：检查功能设置里的模型名";
    case 429: return "DeepSeek 请求太频繁，请稍后再试";
    case 500: return "DeepSeek 服务出错，请稍后再试";
    case 503: return "DeepSeek 服务繁忙，请稍后再试";
    default: return `DeepSeek 返回 HTTP ${status}` + d;
  }
}

/** The JSON object in an answer; tolerates a ```json fence around it. */
export function parseJsonAnswer(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  try { return JSON.parse(t); }
  catch { throw new DeepSeekError("DeepSeek 的回复不是有效的 JSON，请重试"); }
}

/** Sends one request (JSON output mode) and returns the parsed object. */
export async function deepseekJson(
  fetchFn: typeof fetch, cfg: DeepSeekConfig, req: JsonRequest,
): Promise<{ value: unknown; usage: Usage | null; model: string }> {
  const key = cfg.key.trim();
  if (!key) throw new DeepSeekError("还没有填写 DeepSeek API Key：在 WavePlug 程序 › 功能设置 › AI 助手 里填写");
  const model = cfg.model?.trim() || DEEPSEEK_DEFAULT_MODEL;
  const url = (cfg.base?.trim() || DEEPSEEK_BASE).replace(/\/+$/, "") + "/chat/completions";
  let r: Response;
  try {
    r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        response_format: { type: "json_object" },
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 8000,
        stream: false,
      }),
    });
  } catch (e) {
    throw new DeepSeekError(`连不上 DeepSeek（${(e as Error)?.message ?? e}）：检查网络`);
  }
  const body = await r.text();
  if (!r.ok) {
    let detail = "";
    try { detail = String(JSON.parse(body)?.error?.message ?? ""); } catch { detail = body.slice(0, 120); }
    throw new DeepSeekError(statusMessage(r.status, detail), r.status);
  }
  let data: any;
  try { data = JSON.parse(body); } catch { throw new DeepSeekError("DeepSeek 的回复无法解析，请重试"); }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason === "length") throw new DeepSeekError("回复太长被截断了：少选一些图层再试");
  if (typeof content !== "string" || !content.trim()) throw new DeepSeekError("DeepSeek 返回了空回复，请重试");
  const u = data?.usage;
  const usage = u && typeof u.prompt_tokens === "number" ? { prompt: u.prompt_tokens, completion: Number(u.completion_tokens) || 0 } : null;
  return { value: parseJsonAnswer(content), usage, model: String(data?.model ?? model) };
}
