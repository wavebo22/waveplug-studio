// 提示栏: what the mouse / keys do where the pointer is (core/layers/hints.ts), what the panel is in,
// and its last result. Drawn by the helper along the bottom of the canvas, the way Blender's status
// bar sits under its viewport (native/overlay/src/monitor.rs, the 性能监视 meters at its right);
// only while no helper new enough is connected, it is the bottom lines of the WaveLayer panel
// (line 1 the hints, line 2 the state and the last result — click it for the last ten).

import { type HintItem, type HintMessage, type StatePart, messageLife, pushMessage } from "../core/layers/hints.ts";
import { h, isShown, listen, replace, setShown } from "./dom.ts";
import type { Overlay } from "../app/overlay.ts";
import type { ScreenRect } from "../core/overlay/protocol.ts";

export interface HintBar {
  el: HTMLElement;
  hints(items: HintItem[]): void;
  state(parts: StatePart[]): void;
  message(text?: string, kind?: HintMessage["kind"]): void;
  /** a state part with an action was clicked */
  onAction(cb: (action: NonNullable<StatePart["action"]>) => void): void;
  /** the canvas on screen (where the helper draws the bar) */
  view(v: ScreenRect | null): void;
  /** the WaveLayer panel is shown: false takes its hints off the helper's bar */
  active(on: boolean): void;
}

export function createHintBar(overlay?: Overlay): HintBar {
  const hintsEl = h("div", { class: "hb-hints" });
  const stateEl = h("div", { class: "hb-state" });
  const msgEl = h("button", { class: "hb-msg", title: "最近的操作结果：单击查看最近 10 条" });
  const historyEl = h("div", { class: "hb-history" });
  setShown(historyEl, false);
  const el = h("div", { class: "hb" }, hintsEl, h("div", { class: "hb-line" }, stateEl, msgEl), historyEl);
  let history: HintMessage[] = [], clear: ReturnType<typeof setTimeout> | null = null, lastHints = "", lastState = "";
  const actions: ((a: NonNullable<StatePart["action"]>) => void)[] = [];
  // what the helper's bar shows, sent (deduplicated by the overlay) whenever a part changes
  let nHints: HintItem[] = [], nState: StatePart[] = [], nMessage: { text: string; kind: string } | null = null;
  let nView: ScreenRect | null = null, on = true, timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const native = !!overlay && (on
        ? overlay.statusBar({ hints: nHints.map(i => ({ keys: i.keys, label: i.label, on: !!i.on })), state: nState.map(p => ({ text: p.text, kind: p.kind })), message: nMessage, ...(nView ? { view: nView } : {}) })
        : overlay.statusBar(null));
      // the panel's own lines only while the helper can't draw the bar
      setShown(el, !native);
    }, 80); // a quick sweep over the rows sends the bar at most ~12 times a second
  };
  overlay?.onConnected(sync);
  overlay?.onDisconnected(() => setShown(el, true));
  // the helper's version (new enough or not) arrives a moment after it connects: check again
  setInterval(() => { if (!!overlay?.statusBarReady === isShown(el)) sync(); }, 1000);

  const key = (k: string) => h("span", { class: "hb-key" }, k);
  function hints(items: HintItem[]) {
    const sig = items.map(i => i.keys.join("+") + ":" + i.label + (i.on ? "*" : "")).join("|");
    if (sig === lastHints) return;
    lastHints = sig;
    nHints = items; sync();
    replace(hintsEl, ...items.map(i => h("span", { class: "hb-item" + (i.on ? " on" : "") },
      ...i.keys.map(key), h("span", { class: "hb-label" }, i.label))));
    hintsEl.title = items.map(i => `${i.keys.join(" + ")}：${i.label}`).join("\n");
  }
  function state(parts: StatePart[]) {
    const sig = parts.map(p => p.kind + ":" + p.text).join("|");
    if (sig === lastState) return;
    lastState = sig;
    nState = parts; sync();
    replace(stateEl, ...parts.map(p => {
      const s = h("span", { class: "hb-part " + p.kind + (p.action ? " act" : ""), title: p.tip ?? p.text }, p.text);
      if (p.action) s.addEventListener("click", () => { for (const cb of actions) cb(p.action!); });
      return s;
    }));
  }
  function message(text?: string, kind: HintMessage["kind"] = "info") {
    if (clear) { clearTimeout(clear); clear = null; }
    if (!text) { replace(msgEl); msgEl.className = "hb-msg"; nMessage = null; sync(); return; }
    nMessage = { text, kind }; sync();
    history = pushMessage(history, { text, kind, at: Date.now() });
    replace(msgEl, text);
    msgEl.className = "hb-msg " + kind;
    msgEl.title = text + "\n单击查看最近的操作结果";
    const life = messageLife(kind);
    if (life !== null) clear = setTimeout(() => { replace(msgEl); msgEl.className = "hb-msg"; nMessage = null; sync(); }, life);
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
  // a helper that connects later (or reconnects) gets the bar; until then the panel shows it
  sync();
  return {
    el, hints, state, message, onAction: cb => { actions.push(cb); },
    view: v => { if (JSON.stringify(v) !== JSON.stringify(nView)) { nView = v; sync(); } },
    active: v => { if (v !== on) { on = v; sync(); } },
  };
}
