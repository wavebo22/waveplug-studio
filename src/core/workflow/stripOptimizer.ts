// Takes the prompt-optimiser nodes out of a workflow (API format): WavePlug optimises prompts with
// DeepSeek (core/assistant/promptOptimize.ts) before sending, so a workflow's own LLM step (e.g.
// QwenImagePromptOptimizer behind a 「# 3.提示词优化」 switch and an `easy ifElse`) would only be
// slow and run twice. What used the switched prompt gets the plain one (the switch's off branch);
// the optimiser, its display node, the switch and its binding go. Applied to every saved and
// imported workflow. Pure (tests/workflow_strip_optimizer.test.ts).

import type { Binding, Profile } from "./profile.ts";

type Api = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

export const OPTIMIZER_TITLE = /提示词优化|prompt\s*optimi[sz]/i;
const OPTIMIZER_CLASS = /PromptOptimi[sz]er|PromptEnhanc/i;

const ref = (v: unknown): string | null => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") ? String(v[0]) : null;

/** The workflow without its prompt optimiser; null when it has none (nothing to change). */
export function stripOptimizer(api: Api, bindings: readonly Binding[]): { api: Api; bindings: Binding[]; removed: string[] } | null {
  const a: Api = JSON.parse(JSON.stringify(api));
  const switches = Object.keys(a).filter(id => OPTIMIZER_TITLE.test(a[id]._meta?.title ?? "") && !Object.values(a[id].inputs).some(v => ref(v) !== null));
  const optimizers = Object.keys(a).filter(id => OPTIMIZER_CLASS.test(a[id].class_type));
  if (!switches.length && !optimizers.length) return null;
  const users = (id: string) => Object.keys(a).filter(u => Object.values(a[u].inputs).some(v => ref(v) === id));
  const rewire = (from: string, to: unknown) => {
    for (const n of Object.values(a)) for (const [k, v] of Object.entries(n.inputs)) if (ref(v) === from) n.inputs[k] = Array.isArray(to) ? [...to] : to;
  };
  const removed: string[] = [];
  const drop = (id: string) => { if (a[id]) { delete a[id]; removed.push(id); } };

  /** whether an input's value comes (somewhere upstream) from an optimiser */
  const fromOptimizer = (v: unknown): boolean => {
    const seen = new Set<string>(), stack = [ref(v)];
    while (stack.length) {
      const id = stack.pop();
      if (id === null || id === undefined || seen.has(id) || !a[id]) continue;
      seen.add(id);
      if (OPTIMIZER_CLASS.test(a[id].class_type)) return true;
      for (const x of Object.values(a[id].inputs)) stack.push(ref(x));
    }
    return false;
  };
  // each if-else the switch drives: its users take the branch without the optimiser (the plain
  // prompt; without an optimiser node in sight, on_false — the switch on means optimised)
  for (const s of switches) {
    for (const ie of users(s)) {
      const n = a[ie];
      if (!n || !("on_true" in n.inputs) || !("on_false" in n.inputs)) continue;
      const keep = fromOptimizer(n.inputs.on_false) && !fromOptimizer(n.inputs.on_true) ? n.inputs.on_true : n.inputs.on_false;
      rewire(ie, keep);
      drop(ie);
    }
    if (!users(s).length) drop(s);
  }
  // the optimisers, and what only showed their output (a display node nothing else uses any more)
  const gone = new Set<string>(optimizers);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of Object.keys(a)) {
      if (gone.has(id)) continue;
      const fedByGone = Object.values(a[id].inputs).some(v => { const r = ref(v); return r !== null && gone.has(r); });
      if (fedByGone && users(id).every(u => gone.has(u))) { gone.add(id); changed = true; }
    }
  }
  // an optimiser still feeding real nodes directly (no switch): its prompt output becomes the plain
  // prompt; a yes / no output (QwenImagePromptOptimizer's 是否反推, which blocked the reference
  // image when it described it instead) becomes false
  for (const id of optimizers) {
    const plain = Object.entries(a[id].inputs).find(([k, v]) => /提示词|prompt|text/i.test(k) && (ref(v) !== null || typeof v === "string"))?.[1];
    for (const u of users(id)) {
      if (gone.has(u)) continue;
      for (const [k, v] of Object.entries(a[u].inputs)) {
        if (ref(v) !== id) continue;
        const slot = Number((v as unknown[])[1]);
        if (slot === 0 && plain !== undefined) a[u].inputs[k] = Array.isArray(plain) ? [...plain] : plain;
        else if (slot > 0 && /是否|bool|enable|开关|阻断/i.test(k)) a[u].inputs[k] = false;
        else return null; // can't tell what to put there: leave the workflow alone
      }
    }
  }
  for (const id of gone) drop(id);
  const left = new Set(Object.keys(a));
  return { api: a, bindings: bindings.filter(b => left.has(b.nodeId)), removed };
}

/** A saved / imported profile without its prompt optimiser (the same profile when it has none). */
export function withoutOptimizer(p: Profile): Profile {
  const s = stripOptimizer(p.api as Api, p.bindings);
  return s ? { ...p, api: s.api as Profile["api"], bindings: s.bindings } : p;
}
