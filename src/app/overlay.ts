// Connection to the WavePlug overlay helper (native/overlay) and the hub of external surfaces on
// it. Optional: while the helper isn't running this quietly retries every few seconds, surfaces
// keep updating their state, and the UXP panels work as before.
//
// 随 Photoshop 启动: the plugin is loaded when Photoshop starts, so the first failed connection
// starts the helper's exe (once per session, when `autoLaunch()` allows); the helper quits with
// Photoshop by itself. `launchHelper` / `restartHelper` are the settings page's 启动 / 重启.

import { onDispose } from "../ui/dom.ts";
import { log, setLogContext } from "./log.ts";
import { EXPECTED_HELPER_VERSION, OVERLAY_URL, type ComfyManagerStatus, type ExternalDragEvent, type ExternalDragFile, type MenuNode, type OverlayCommand, MENU_HELPER_VERSION, type ScreenRect, helperOutdated, parseOverlayEvent } from "../core/overlay/protocol.ts";
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
  /** Start/update/end the independent cursor-following drag card. */
  beginLayerDragPreview(layers: { layerId: number; name: string; thumb?: string }[], totalCount: number): boolean;
  updateLayerDragPreview(action: string, tone: "move" | "copy" | "delete" | "workbench" | "invalid"): void;
  endLayerDragPreview(): void;
  /** 悬停边框: frame `rect` (screen px) cut to `clip` on the canvas; null takes it away. */
  hoverFrame(frame: { rect: ScreenRect; clip: ScreenRect } | null): void;
  /** Cross-app drag (把图层拖出 Photoshop): PNGs are being written / are written / the session is
   *  over without the helper. Return false when the message could not be sent. */
  prepareExternalDrag(sessionId: string, docId: number, totalCount: number, keys: string[]): boolean;
  readyExternalDrag(sessionId: string, files: ExternalDragFile[]): boolean;
  progressExternalDrag(sessionId: string, done: number, total: number): void;
  cancelExternalDrag(sessionId: string, reason: string): void;
  /** Ask the native helper to reconcile the configured local ComfyUI process (`restart`: stop the
   *  one it started and start it again). */
  manageComfy(options: { path: string; base: string; closeWithPhotoshop: boolean; restartIfNeeded?: boolean; disableBrowser?: boolean; startIfMissing?: boolean; restart?: boolean }): void;
  /** Starts the helper's exe unless it is connected, and waits up to `waitMs` for it to connect:
   *  null when it did, else why not. */
  launchHelper(waitMs?: number): Promise<string | null>;
  /** Restarts a connected helper (keeping its ComfyUI); starts it when it isn't running. */
  restartHelper(waitMs?: number): Promise<string | null>;
  /** Shows `items` as a native menu at the mouse (outside the panel, submenus to the side): the id
   *  of the row picked, or null when it was closed. Returns null instead of a promise when the
   *  helper isn't connected or is older than MENU_HELPER_VERSION: the panel then shows its own menu. */
  openMenu(title: string, items: MenuNode[]): Promise<string | null> | null;
  /** Takes the native menu away (Esc; the keys stay in Photoshop while it is open). */
  closeMenu(): void;
  /** the connected helper's version, null while not connected */
  readonly helperVersion: string | null;
  onConnected(cb: () => void): () => void;
  onDisconnected(cb: () => void): () => void;
  onComfyStatus(cb: (status: ComfyManagerStatus) => void): () => void;
  /** external-drag-cached / -files-copied / -finished from the helper */
  onExternalDrag(cb: (event: ExternalDragEvent) => void): () => void;
  readonly connected: boolean;
}

export function connectOverlay(opts: { launch?: () => Promise<string | null>; autoLaunch?: () => boolean; onAutoLaunchFailed?: (error: string) => void } = {}): Overlay {
  let ws: WebSocket | null = null, retryTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null, closed = false, connected = false;
  let helperLaunchAttempted = false, helperVersion: string | null = null;
  const connectionListeners = new Set<() => void>();
  const disconnectionListeners = new Set<() => void>();
  const comfyListeners = new Set<(status: ComfyManagerStatus) => void>();
  const externalDragListeners = new Set<(event: ExternalDragEvent) => void>();
  let menuSeq = 0;
  const menus = new Map<string, (item: string | null) => void>();
  const endMenus = () => { for (const done of menus.values()) done(null); menus.clear(); };
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
  const waitConnected = async (ms: number) => {
    const t0 = Date.now();
    while (!connected && !closed && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 250));
    return connected;
  };
  async function launchHelper(waitMs = 15_000): Promise<string | null> {
    if (connected) return null;
    if (!opts.launch) return "这个环境不能启动外置框架";
    helperLaunchAttempted = true;
    log("info", "overlay helper launch");
    const error = await opts.launch().catch(e => (e as Error).message);
    if (error) { log("error", "overlay helper launch failed", error); return error; }
    // connect now rather than at the next retry
    if (!ws) { if (retryTimer) clearTimeout(retryTimer); open(); }
    if (await waitConnected(waitMs)) return null;
    log("warn", "overlay helper launched but not connected", waitMs);
    return `外置框架已启动，但 ${Math.round(waitMs / 1000)} 秒内没有连上（端口 47821）`;
  }
  const retry = () => {
    if (closed) return;
    if (!helperLaunchAttempted && opts.launch && (opts.autoLaunch?.() ?? true)) {
      void launchHelper().then(error => { if (error) opts.onAutoLaunchFailed?.(error); });
    }
    retryTimer = setTimeout(open, RETRY_MS);
  };
  function open() {
    if (closed) return;
    try { ws = new WebSocket(OVERLAY_URL); } catch { ws = null; retry(); return; }
    const sock = ws;
    sock.onopen = () => {
      connected = true;
      // once a helper has been here, losing it is a restart in progress (or Photoshop quitting):
      // starting another copy would race the one coming up
      helperLaunchAttempted = true;
      log("info", "overlay connected");
      hub.connected();
      connectionListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "overlay connect listener", err); } });
    };
    sock.onmessage = e => {
      const m = parseOverlayEvent(String(e.data));
      if (m?.type === "ready") {
        helperVersion = m.version;
        setLogContext({ 外置框架: m.version });
        log("info", "overlay ready", m.version);
        if (helperOutdated(m.version)) log("warn", "overlay helper outdated: rebuild native/overlay (build.cmd)", JSON.stringify({ running: m.version, expected: EXPECTED_HELPER_VERSION }));
      }
      if (m?.type === "comfy-status") {
        log("info", "ComfyUI manager", m.state, m.owned, m.message);
        comfyListeners.forEach(cb => { try { cb(m); } catch (err) { log("warn", "ComfyUI status listener", err); } });
      }
      if (m?.type === "menu-result") {
        const done = menus.get(m.menuId);
        menus.delete(m.menuId);
        done?.(m.item);
        return;
      }
      if (m?.type === "external-drag-cached" || m?.type === "external-drag-files-copied" || m?.type === "external-drag-finished") {
        externalDragListeners.forEach(cb => { try { cb(m); } catch (err) { log("warn", "external drag listener", err); } });
        return;
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
      helperVersion = null;
      ws = null;
      setLogContext({ 外置框架: "未连接" });
      endMenus(); // a menu the helper was showing went with it
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
    externalDragListeners.clear();
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
    beginLayerDragPreview(layers, totalCount) {
      if (!connected) return false;
      return sendChecked({ type: "layer-drag-preview-start", layers, totalCount });
    },
    updateLayerDragPreview(action, tone) {
      send({ type: "layer-drag-preview-update", action, tone });
    },
    endLayerDragPreview() {
      send({ type: "layer-drag-preview-end" });
    },
    hoverFrame(frame) {
      send(frame ? { type: "hover-frame", rect: frame.rect, clip: frame.clip } : { type: "hover-frame", rect: null });
    },
    prepareExternalDrag(sessionId, docId, totalCount, keys) {
      if (!connected) return false;
      return sendChecked({ type: "external-drag-prepare", sessionId, docId, totalCount, keys });
    },
    readyExternalDrag(sessionId, files) {
      if (!connected) return false;
      return sendChecked({ type: "external-drag-ready", sessionId, files });
    },
    progressExternalDrag(sessionId, done, total) {
      send({ type: "external-drag-progress", sessionId, done, total });
    },
    cancelExternalDrag(sessionId, reason) {
      send({ type: "external-drag-cancel", sessionId, reason });
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
        restart: options.restart ?? false,
      });
    },
    openMenu(title, items) {
      if (!connected || helperVersion === null || helperOutdated(helperVersion, MENU_HELPER_VERSION)) return null;
      const menuId = "m" + (++menuSeq);
      if (!sendChecked({ type: "menu-open", menuId, title, items })) return null;
      return new Promise<string | null>(resolve => { menus.set(menuId, resolve); });
    },
    closeMenu() {
      if (menus.size) send({ type: "menu-close" });
    },
    launchHelper,
    async restartHelper(waitMs = 15_000) {
      if (!connected) return launchHelper(waitMs);
      log("info", "overlay helper restart");
      helperLaunchAttempted = true;
      send({ type: "restart-helper" });
      // the old copy goes away, the new one connects within a few seconds
      const t0 = Date.now();
      while (connected && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 200));
      if (connected) return "外置框架没有响应重启";
      return (await waitConnected(waitMs)) ? null : "外置框架重启后没有重新连上，请点「启动」";
    },
    get helperVersion() { return helperVersion; },
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
    onExternalDrag(cb) {
      externalDragListeners.add(cb);
      return () => externalDragListeners.delete(cb);
    },
    queueSync() {
      if (syncTimer || !connected) return;
      syncTimer = setTimeout(() => { syncTimer = null; hub.sync(); }, SYNC_MS);
    },
    get connected() { return connected; },
  };
}
