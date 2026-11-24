// 提示栏: the bottom line of the WaveLayer panel (Blender's status bar). Line 1: what the mouse /
// keys do where the pointer is (core/layers/hints.ts); line 2: what the panel is in, and on the
// right the last result (click it for the last ten). Replaces the old status text.

import { type HintItem, type HintMessage, type StatePart, messageLife, pushMessage } from "../core/layers/hints.ts";
import { h, isShown, listen, replace, setShown } from "./dom.ts";

export interface HintBar {
  el: HTMLElement;
  hints(items: HintItem[]): void;
  state(parts: StatePart[]): void;
  message(text?: string, kind?: HintMessage["kind"]): void;
  /** a state part with an action was clicked */
  onAction(cb: (action: NonNullable<StatePart["action"]>) => void): void;
}

export function createHintBar(): HintBar {
  const hintsEl = h("div", { class: "hb-hints" });
  const stateEl = h("div", { class: "hb-state" });
  const msgEl = h("button", { class: "hb-msg", title: "最近的操作结果：单击查看最近 10 条" });
  const historyEl = h("div", { class: "hb-history" });
  setShown(historyEl, false);
  const el = h("div", { class: "hb" }, hintsEl, h("div", { class: "hb-line" }, stateEl, msgEl), historyEl);
  let history: HintMessage[] = [], clear: ReturnType<typeof setTimeout> | null = null, lastHints = "", lastState = "";
  const actions: ((a: NonNullable<StatePart["action"]>) => void)[] = [];

  const key = (k: string) => h("span", { class: "hb-key" }, k);
  function hints(items: HintItem[]) {
    const sig = items.map(i => i.keys.join("+") + ":" + i.label + (i.on ? "*" : "")).join("|");
    if (sig === lastHints) return;
    lastHints = sig;
    replace(hintsEl, ...items.map(i => h("span", { class: "hb-item" + (i.on ? " on" : "") },
      ...i.keys.map(key), h("span", { class: "hb-label" }, i.label))));
    hintsEl.title = items.map(i => `${i.keys.join(" + ")}：${i.label}`).join("\n");
  }
  function state(parts: StatePart[]) {
    const sig = parts.map(p => p.kind + ":" + p.text).join("|");
    if (sig === lastState) return;
    lastState = sig;
    replace(stateEl, ...parts.map(p => {
      const s = h("span", { class: "hb-part " + p.kind + (p.action ? " act" : ""), title: p.tip ?? p.text }, p.text);
      if (p.action) s.addEventListener("click", () => { for (const cb of actions) cb(p.action!); });
      return s;
    }));
  }
  function message(text?: string, kind: HintMessage["kind"] = "info") {
    if (clear) { clearTimeout(clear); clear = null; }
    if (!text) { replace(msgEl); msgEl.className = "hb-msg"; return; }
    history = pushMessage(history, { text, kind, at: Date.now() });
    replace(msgEl, text);
    msgEl.className = "hb-msg " + kind;
    msgEl.title = text + "\n单击查看最近的操作结果";
    const life = messageLife(kind);
    if (life !== null) clear = setTimeout(() => { replace(msgEl); msgEl.className = "hb-msg"; }, life);
    if (isShown(historyEl)) drawHistory();
  }
  const time = (t: number) => new Date(t).toTimeString().slice(0, 8);
  function drawHistory() {
    replace(historyEl, ...(history.length ? history.map(m => h("div", { class: "hb-history-row " + m.kind },
      h("span", { class: "hb-time" }, time(m.at)), h("span", {}, m.text))) : [h("div", { class: "hb-history-row" }, "还没有操作结果")]));
  }
  msgEl.addEventListener("click", () => {
    const open = !isShown(historyEl);
    if (open) drawHistory();
    setShown(historyEl, open);
  });
  listen(document, "mousedown", e => { if (!historyEl.contains(e.target as Node) && !msgEl.contains(e.target as Node)) setShown(historyEl, false); });
  return { el, hints, state, message, onAction: cb => { actions.push(cb); } };
}
