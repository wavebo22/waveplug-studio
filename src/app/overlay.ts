// Connection to the WavePlug overlay helper (native/overlay) and the hub of external surfaces on
// it. Optional: while the helper isn't running this quietly retries every few seconds, surfaces
// keep updating their state, and the UXP panels work as before.

import { onDispose } from "../ui/dom.ts";
import { log } from "./log.ts";
import { OVERLAY_URL, type ComfyManagerStatus, type OverlayCommand, type ScreenRect, parseOverlayEvent } from "../core/overlay/protocol.ts";
import { type Hub, createHub } from "../core/overlay/hub.ts";

const RETRY_MS = 3000;
/** state changes are gathered this long, then sent as one message */
const SYNC_MS = 40;

export interface Overlay {
  hub: Hub;
  /** state may have changed: sends the changed sections shortly (many calls → one message) */
  queueSync(): void;
  /** Tell the native helper that a WaveLayer row is being dragged toward a reference slot. */
  beginLayerDrag(docId: number, layers: { layerId: number; name: string }[], totalCount: number, thumb?: string): boolean;
  /** Cancel an external layer-to-reference drag (Escape). */
  cancelLayerDrag(): void;
  /** 悬停边框: frame `rect` (screen px) cut to `clip` on the canvas; null takes it away. */
  hoverFrame(frame: { rect: ScreenRect; clip: ScreenRect } | null): void;
  /** Ask the native helper to reconcile the configured local ComfyUI process. */
  manageComfy(options: { path: string; base: string; closeWithPhotoshop: boolean; restartIfNeeded?: boolean; disableBrowser?: boolean; startIfMissing?: boolean }): void;
  onConnected(cb: () => void): () => void;
  onDisconnected(cb: () => void): () => void;
  onComfyStatus(cb: (status: ComfyManagerStatus) => void): () => void;
  readonly connected: boolean;
}

export function connectOverlay(ensureHelper?: () => Promise<string | null>): Overlay {
  let ws: WebSocket | null = null, retryTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null, closed = false, connected = false;
  let helperLaunchAttempted = false;
  const connectionListeners = new Set<() => void>();
  const disconnectionListeners = new Set<() => void>();
  const comfyListeners = new Set<(status: ComfyManagerStatus) => void>();
  const send = (m: OverlayCommand) => {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } }
  };
  const sendChecked = (m: OverlayCommand): boolean => {
    const socket = ws;
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(m)); return true; }
    catch { return false; }
  };
  const hub = createHub(send);
  const retry = () => {
    if (closed) return;
    if (!helperLaunchAttempted && ensureHelper) {
      helperLaunchAttempted = true;
      void ensureHelper().then(error => {
        if (error) log("error", "overlay helper launch failed", error);
      }).catch(error => log("error", "overlay helper launch failed", error));
    }
    retryTimer = setTimeout(open, RETRY_MS);
  };
  function open() {
    if (closed) return;
    try { ws = new WebSocket(OVERLAY_URL); } catch { ws = null; retry(); return; }
    const sock = ws;
    sock.onopen = () => {
      connected = true;
      log("info", "overlay connected");
      hub.connected();
      connectionListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "overlay connect listener", err); } });
    };
    sock.onmessage = e => {
      const m = parseOverlayEvent(String(e.data));
      if (m?.type === "ready") log("info", "overlay ready", m.version);
      if (m?.type === "comfy-status") {
        log("info", "ComfyUI manager", m.state, m.owned, m.message);
        comfyListeners.forEach(cb => { try { cb(m); } catch (err) { log("warn", "ComfyUI status listener", err); } });
      }
      if (m) { try { hub.receive(m); } catch (err) { log("warn", "overlay action failed", err); } }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      if (connected) {
        log("info", "overlay disconnected");
        disconnectionListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "overlay disconnect listener", err); } });
      }
      connected = false;
      ws = null;
      if (!closed) retry();
    };
    sock.onerror = () => { /* onclose follows */ };
  }
  open();
  // the development loader's ⟳ replaces this build: don't leave a second connection behind
  onDispose(() => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (syncTimer) clearTimeout(syncTimer);
    try { ws?.close(); } catch { /* gone */ }
    connectionListeners.clear();
    disconnectionListeners.clear();
    comfyListeners.clear();
  });
  return {
    hub,
    beginLayerDrag(docId, layers, totalCount, thumb) {
      if (!connected) return false;
      return sendChecked({ type: "layer-drag-start", docId, layers, totalCount, thumb });
    },
    cancelLayerDrag() {
      send({ type: "layer-drag-cancel" });
    },
    hoverFrame(frame) {
      send(frame ? { type: "hover-frame", rect: frame.rect, clip: frame.clip } : { type: "hover-frame", rect: null });
    },
    manageComfy(options) {
      send({
        type: "manage-comfy",
        path: options.path,
        base: options.base,
        closeWithPhotoshop: options.closeWithPhotoshop,
        restartIfNeeded: options.restartIfNeeded ?? false,
        disableBrowser: options.disableBrowser ?? true,
        startIfMissing: options.startIfMissing ?? true,
      });
    },
    onConnected(cb) {
      connectionListeners.add(cb);
      if (connected) cb();
      return () => connectionListeners.delete(cb);
    },
    onDisconnected(cb) {
      disconnectionListeners.add(cb);
      return () => disconnectionListeners.delete(cb);
    },
    onComfyStatus(cb) {
      comfyListeners.add(cb);
      return () => comfyListeners.delete(cb);
    },
    queueSync() {
      if (syncTimer || !connected) return;
      syncTimer = setTimeout(() => { syncTimer = null; hub.sync(); }, SYNC_MS);
    },
    get connected() { return connected; },
  };
}
