// 一句话选图层: the AI button beside the WavePlug 图层 panel's search box (and Enter in the box).
// What is typed in the search box is the request; DeepSeek picks the layers
// (core/assistant/pick.ts) and the panel selects them.

import type { LayerTree } from "../ps/host.ts";
import type { TreeLayer } from "../core/layers/tree.ts";
import { deepseekJson } from "../core/assistant/deepseek.ts";
import { describeLayers } from "../core/assistant/organize.ts";
import { PICK_SYSTEM, parsePick, pickScope, pickUserPrompt } from "../core/assistant/pick.ts";
import { log, withTimeout } from "../app/log.ts";
import { h } from "./dom.ts";

type Status = (text: string, kind?: "info" | "ok" | "error" | "busy") => void;

export interface AiPickDeps {
  tree: LayerTree;
  state(): { docId: number | null; layers: TreeLayer[]; width: number; height: number };
  /** the search box's text */
  ask(): string;
  status: Status;
  fetch: typeof fetch;
  settings(): { key: string; model: string };
  /** the layers were selected: clear the name filter, show them */
  picked(ids: number[]): void;
}

const TIMEOUT_MS = 120_000;

export function createAiPick(d: AiPickDeps) {
  const button = h("button", { class: "lt-head-btn lt-ai-pick", title: "AI 选图层：在左边的搜索框里用一句话描述，例如「所有按钮」「标题相关的文字」「隐藏的产品图」「左上角的图标」，再点这里或按 Enter，DeepSeek 按图层名字、文字内容、类型和位置挑出来并选中。API Key 在 WavePlug 程序 › 功能设置 › AI 助手 里填写" }, "AI 选");
  let busy = false;

  async function run() {
    if (busy) return;
    const ask = d.ask().trim();
    if (!ask) { d.status("在搜索框里用一句话描述要选的图层，例如「所有按钮」「隐藏的产品图」，再点 AI 选", "error"); return; }
    const cfg = d.settings();
    if (!cfg.key.trim()) { d.status("还没有填写 DeepSeek API Key：在 WavePlug 程序 › 功能设置 › AI 助手 里填写", "error"); return; }
    const s = d.state();
    if (s.docId === null) { d.status("没有打开的文档", "error"); return; }
    const id = s.docId, sc = pickScope(s.layers);
    if (!sc.ids.length) { d.status("文档里没有可以选的图层", "error"); return; }
    busy = true; button.classList.add("busy");
    d.status(`DeepSeek 正在找「${ask.slice(0, 20)}」…`, "busy");
    const t0 = Date.now();
    try {
      const textIds = sc.ids.filter(x => s.layers.find(l => l.id === x)?.kind === "text");
      const texts = textIds.length ? await d.tree.texts(id, textIds).catch(e => { log("warn", "ai pick texts", e); return new Map<number, string>(); }) : new Map<number, string>();
      const user = pickUserPrompt(describeLayers(s.layers, sc.ids, texts, false), ask, { width: s.width, height: s.height, cut: sc.cut });
      const r = await withTimeout(deepseekJson(d.fetch, { key: cfg.key, model: cfg.model }, { system: PICK_SYSTEM, user, maxTokens: 2000 }), TIMEOUT_MS, "DeepSeek ");
      const now = d.state();
      if (now.docId !== id) throw new Error("文档已切换，没有选");
      const p = parsePick(r.value, now.layers);
      log("info", "ai pick", JSON.stringify({ layers: sc.ids.length, picked: p.ids.length, usage: r.usage, ms: Date.now() - t0 }));
      if (!p.ids.length) { d.status(`没找到「${ask.slice(0, 20)}」${p.note ? "：" + p.note : ""}`, "error"); return; }
      await d.tree.select(id, p.ids);
      d.picked(p.ids);
      d.status(`选中了 ${p.ids.length} 个图层${p.note ? "：" + p.note : ""}`, "ok");
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log("warn", "ai pick", msg);
      d.status("AI 选图层失败：" + msg, "error");
    } finally {
      busy = false; button.classList.remove("busy");
    }
  }

  button.addEventListener("click", () => void run());
  return { button, run };
}
