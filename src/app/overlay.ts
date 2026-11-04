// Connection to the WavePlug overlay helper (native/overlay). Optional: while the helper isn't
// running this quietly retries every few seconds and the panel works as before.

import { onDispose } from "../ui/dom.ts";
import { log } from "./log.ts";
import { OVERLAY_URL, type OverlayCommand, type OverlayEvent, parseOverlayEvent } from "../core/overlay/protocol.ts";

const RETRY_MS = 3000;

export function connectOverlay(onEvent: (e: OverlayEvent) => void) {
  let ws: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | null = null, closed = false, connected = false;
  const retry = () => { if (!closed) timer = setTimeout(open, RETRY_MS); };
  function open() {
    if (closed) return;
    try { ws = new WebSocket(OVERLAY_URL); } catch { ws = null; retry(); return; }
    const sock = ws;
    sock.onopen = () => { connected = true; log("info", "overlay connected"); send({ type: "hello" }); };
    sock.onmessage = e => {
      const m = parseOverlayEvent(String(e.data));
      if (m?.type === "ready") log("info", "overlay ready", m.version);
      if (m) onEvent(m);
    };
    sock.onclose = () => {
      if (connected) log("info", "overlay disconnected");
      connected = false;
      if (ws === sock) ws = null;
      retry();
    };
    sock.onerror = () => { /* onclose follows */ };
  }
  function send(m: OverlayCommand) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } }
  }
  open();
  // the development loader's ⟳ replaces this build: don't leave a second connection behind
  onDispose(() => { closed = true; if (timer) clearTimeout(timer); try { ws?.close(); } catch { /* gone */ } });
  return { send, get connected() { return connected; } };
}
