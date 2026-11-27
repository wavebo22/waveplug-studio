// Connection to the WavePlug overlay helper (native/overlay) and the hub of external surfaces on
// it. Optional: while the helper isn't running this quietly retries every few seconds, surfaces
// keep updating their state, and the UXP panels work as before.
//
// 随 Photoshop 启动: the plugin is loaded when Photoshop starts, so the first failed connection
// starts the helper's exe (once per session, when `autoLaunch()` allows); the helper quits with
// Photoshop by itself. `launchHelper` / `restartHelper` are the settings page's 启动 / 重启.

import { onDispose } from "../ui/dom.ts";
import { log, setLogContext } from "./log.ts";
import { ASSIST_HELPER_VERSION, CHECK_HELPER_VERSION, REWRITE_HELPER_VERSION, SETUP_HELPER_VERSION, EXPECTED_HELPER_VERSION, OVERLAY_URL, type ComfyManagerStatus, type ExternalDragEvent, type ExternalDragFile, HANG_SECONDS, type HangDoc, type MenuNode, type OverlayCommand, MENU_HELPER_VERSION, OPEN_APP_HELPER_VERSION, type ScreenRect, TRASH_HELPER_VERSION, WEBDROP_HELPER_VERSION, KEYS_HELPER_VERSION, STATUSBAR_HELPER_VERSION, TINT_HELPER_VERSION, type StatusBarHint, type StatusBarMode, type StatusBarPart, type UpdateEvent, type WebDropEvent, helperOutdated, parseOverlayEvent } from "../core/overlay/protocol.ts";
import { type Hub, createHub } from "../core/overlay/hub.ts";
import { type CornerSlot, createCornerSlot } from "./cornerSlot.ts";

const RETRY_MS = 3000;
/** state changes are gathered this long, then sent as one message */
const SYNC_MS = 40;

export interface Overlay {
  hub: Hub;
  /** the canvas-corner window: who is up there (app/cornerSlot.ts) */
  corner: CornerSlot;
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
  /** 外置删除区 for the drag under way (after beginLayerDragPreview). False when the helper isn't
   *  connected or is older than TRASH_HELPER_VERSION: the panel then shows its own red rail. */
  showDragTrash(view: ScreenRect | null, enabled: boolean, action: string): boolean;
  /** the drag was let go over the 外置删除区 */
  onTrashDrop(cb: () => void): () => void;
  /** Ctrl+F in Photoshop (the helper takes it from Photoshop, hotkey.rs): 原位粘贴 */
  onPasteInPlace(cb: () => void): () => void;
  /** 悬停边框: frame `rect` (screen px) cut to `clip` on the canvas; null takes it away. */
  hoverFrame(frame: { rect: ScreenRect; clip: ScreenRect } | null): void;
  /** the canvas is somewhere else on screen now: every external window follows it */
  canvasMoved(view: ScreenRect): void;
  /** 悬停高亮: the hovered layer's shape tinted on the canvas; false when the helper is too old */
  hoverTint(tint: { rect: ScreenRect; clip: ScreenRect; width: number; height: number; alpha: string; color?: string } | null): boolean;
  /** 检查结果: the 图层 panel is under the cursor now (helper ≥ CHECK_HELPER_VERSION) */
  anchorPanel(): void;
  /** the helper can show the 检查结果 window */
  readonly checkReady: boolean;
  /** the helper can show the AI 整理 window and draw lines to the panel's rows */
  readonly assistReady: boolean;
  /** the helper can show the AI 改写 window */
  readonly rewriteReady: boolean;
  /** the helper can show the settings panels (检查 / AI 整理 / 改写) */
  readonly setupReady: boolean;
  /** the hovered item's rows in the 图层 panel (page CSS px); null: none */
  issueRows(rows: { left: number; right: number; rows: { top: number; bottom: number }[]; color: string } | null): void;
  /** the helper can tint (connected, ≥ TINT_HELPER_VERSION) */
  readonly tintReady: boolean;
  /** Cross-app drag (把图层拖出 Photoshop): PNGs are being written / are written / the session is
   *  over without the helper. Return false when the message could not be sent. */
  prepareExternalDrag(sessionId: string, docId: number, totalCount: number, keys: string[]): boolean;
  readyExternalDrag(sessionId: string, files: ExternalDragFile[]): boolean;
  progressExternalDrag(sessionId: string, done: number, total: number): void;
  cancelExternalDrag(sessionId: string, reason: string): void;
  /** Ask the native helper to reconcile the configured local ComfyUI process (`restart`: stop the
   *  one it started and start it again). */
  manageComfy(options: { path: string; base: string; closeWithPhotoshop: boolean; restartIfNeeded?: boolean; disableBrowser?: boolean; startIfMissing?: boolean; restart?: boolean }): void;
  /** 性能监视: the meters on the helper's status bar (canvas bottom, right), on or off; `comfy` is ComfyUI's
   *  address for its row. Remembered and sent again whenever a helper connects. */
  setMonitor(on: boolean, comfy: string): void;
  /** 牵手 Illustrator: a message for the Illustrator panel (dropped while it isn't connected). */
  sendBridge(msg: unknown): void;
  /** messages from the Illustrator panel */
  onBridge(cb: (msg: unknown) => void): () => void;
  /** whether the Illustrator panel is connected to the helper */
  readonly illustrator: boolean;
  onIllustrator(cb: (connected: boolean) => void): () => void;
  /** 卡死保护: on / off, and the open documents. Remembered and sent again whenever a helper connects. */
  setHangGuard(on: boolean, autoBackup: boolean, docs: HangDoc[]): void;
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
  /** 更新提醒: what the helper found and how 「更新」 is going */
  onUpdate(cb: (u: UpdateEvent) => void): () => void;
  /** 「更新」: the helper installs the update it found */
  updateNow(): void;
  /** 从网页拖入: put the helper's drop catcher over the panel's drop area (see web-catch). False
   *  when the helper isn't connected or is older than WEBDROP_HELPER_VERSION. */
  webCatch(at: { clientX: number; clientY: number; left: number; top: number; width: number; height: number; folder: string } | null): boolean;
  /** 功能设置 for the WavePlug app window: remembered, sent now and whenever a helper connects
   *  (only when it changed) */
  sendAppSettings(settings: Record<string, string | boolean>): void;
  onAppSettingsSet(cb: (changes: Record<string, string | boolean>) => void): () => void;
  /** opens the WavePlug app window on `tab` ("settings"); false when no helper or one too old */
  openApp(tab: string): boolean;
  /** 导出诊断信息 in the app window asks for the plugin's report in `folder` */
  onPluginReport(cb: (folder: string) => void): () => void;
  /** web-drop / web-drop-leave from the helper */
  onWebDrop(cb: (event: WebDropEvent) => void): () => void;
  /** 按键: ask the helper to report Ctrl / Shift / Alt (renew within 3 s while needed); false when
   *  it isn't connected or is older than KEYS_HELPER_VERSION */
  watchKeys(on: boolean): boolean;
  onKeys(cb: (keys: { ctrl: boolean; shift: boolean; alt: boolean }) => void): () => void;
  /** the helper's drag card is over another program and no files were prepared for it */
  onExternalWanted(cb: () => void): () => void;
  /** 状态栏: what the bar along the canvas' bottom edge shows (null: no panel speaks for it). False
   *  when the helper isn't connected or is older than STATUSBAR_HELPER_VERSION (show it in the panel). */
  statusBar(bar: { hints: StatusBarHint[]; state: StatusBarPart[]; message: StatusBarPart | null; mode?: StatusBarMode | null; view?: ScreenRect } | null): boolean;
  /** the helper draws the status bar (connected and new enough) */
  readonly statusBarReady: boolean;
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
  const updateListeners = new Set<(u: UpdateEvent) => void>();
  const externalDragListeners = new Set<(event: ExternalDragEvent) => void>();
  const trashListeners = new Set<() => void>();
  const pasteListeners = new Set<() => void>();
  const keysListeners = new Set<(keys: { ctrl: boolean; shift: boolean; alt: boolean }) => void>();
  const wantedListeners = new Set<() => void>();
  const webDropListeners = new Set<(event: WebDropEvent) => void>();
  const appSettingsListeners = new Set<(changes: Record<string, string | boolean>) => void>();
  const reportListeners = new Set<(folder: string) => void>();
  let appSettings: Record<string, string | boolean> | null = null, appSettingsSent = "";
  const bridgeListeners = new Set<(msg: unknown) => void>();
  const peerListeners = new Set<(connected: boolean) => void>();
  let illustrator = false;
  let monitor: { on: boolean; comfy: string } | null = null;
  /** the status bar's last content, sent again when a helper connects */
  let bar: OverlayCommand | null = null, barSent = "";
  const barReady = () => connected && helperVersion !== null && !helperOutdated(helperVersion, STATUSBAR_HELPER_VERSION);
  let hangGuard: OverlayCommand | null = null, hangKey = "";
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
  const corner = createCornerSlot(hub);
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
      if (monitor) send({ type: "monitor", ...monitor });
      // Ctrl+F = 原位粘贴 while this plugin is connected (the helper turns it off when it goes)
      send({ type: "hotkeys", on: true });
      barSent = "";
      if (hangGuard) send(hangGuard);
      if (appSettings) { appSettingsSent = JSON.stringify(appSettings); send({ type: "app-settings", settings: appSettings }); }
      connectionListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "overlay connect listener", err); } });
    };
    sock.onmessage = e => {
      const m = parseOverlayEvent(String(e.data));
      if (m?.type === "ready") {
        helperVersion = m.version;
        // where a one-click update puts the plugin's code, and the WavePlug.exe to start next time
        // (plugin/loader.js and launchOverlay read them)
        try {
          if (m.liveRoot) localStorage.setItem("wp.liveRoot", m.liveRoot);
          if (m.appExe) localStorage.setItem("wp.helperExe", m.appExe);
        } catch { /* storage off */ }
        // the status bar needs to know the helper is new enough: sent once its version is known
        if (bar && barReady()) { barSent = JSON.stringify(bar); send(bar); }
        setLogContext({ 外置框架: m.version });
        log("info", "overlay ready", m.version);
        if (helperOutdated(m.version)) log("warn", "overlay helper outdated: rebuild native/overlay (build.cmd)", JSON.stringify({ running: m.version, expected: EXPECTED_HELPER_VERSION }));
      }
      if (m?.type === "update-available" || m?.type === "update-progress") {
        log("info", "overlay update", JSON.stringify(m));
        updateListeners.forEach(cb => { try { cb(m); } catch (err) { log("warn", "update listener", err); } });
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
      if (m?.type === "bridge") {
        if (m.from === "illustrator" || m.from === "helper") bridgeListeners.forEach(cb => { try { cb(m.msg); } catch (err) { log("warn", "bridge listener", err); } });
        return;
      }
      if (m?.type === "peer") {
        if (m.role === "illustrator" && m.connected !== illustrator) {
          illustrator = m.connected;
          log("info", "illustrator panel", m.connected ? "connected" : "gone");
          peerListeners.forEach(cb => { try { cb(m.connected); } catch (err) { log("warn", "peer listener", err); } });
        }
        return;
      }
      if (m?.type === "app-settings-set") {
        appSettingsListeners.forEach(cb => { try { cb(m.changes); } catch (err) { log("warn", "app settings listener", err); } });
        return;
      }
      if (m?.type === "plugin-report") {
        reportListeners.forEach(cb => { try { cb(m.folder); } catch (err) { log("warn", "plugin report listener", err); } });
        return;
      }
      if (m?.type === "web-drop" || m?.type === "web-drop-leave") {
        webDropListeners.forEach(cb => { try { cb(m); } catch (err) { log("warn", "web drop listener", err); } });
        return;
      }
      if (m?.type === "paste-in-place") {
        pasteListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "paste in place listener", err); } });
      }
      if (m?.type === "layer-drag-trash-drop") {
        trashListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "trash drop listener", err); } });
        return;
      }
      if (m?.type === "keys") {
        const k = { ctrl: m.ctrl, shift: m.shift, alt: m.alt };
        keysListeners.forEach(cb => { try { cb(k); } catch (err) { log("warn", "keys listener", err); } });
        return;
      }
      if (m?.type === "external-drag-wanted") {
        wantedListeners.forEach(cb => { try { cb(); } catch (err) { log("warn", "external wanted listener", err); } });
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
      if (illustrator) { illustrator = false; peerListeners.forEach(cb => { try { cb(false); } catch { /* listener */ } }); }
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
    trashListeners.clear();
    pasteListeners.clear();
    bridgeListeners.clear();
    peerListeners.clear();
  });
  return {
    hub,
    corner,
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
    showDragTrash(view, enabled, action) {
      if (!connected || helperVersion === null || helperOutdated(helperVersion, TRASH_HELPER_VERSION)) return false;
      return sendChecked({ type: "layer-drag-trash", view, enabled, action });
    },
    sendAppSettings(s) {
      appSettings = { ...s };
      const text = JSON.stringify(appSettings);
      if (!connected || text === appSettingsSent) return;
      appSettingsSent = text;
      send({ type: "app-settings", settings: appSettings });
    },
    onAppSettingsSet(cb) {
      appSettingsListeners.add(cb);
      return () => appSettingsListeners.delete(cb);
    },
    openApp(tab) {
      if (!connected || helperVersion === null || helperOutdated(helperVersion, OPEN_APP_HELPER_VERSION)) return false;
      return sendChecked({ type: "open-app", tab });
    },
    onPluginReport(cb) {
      reportListeners.add(cb);
      return () => reportListeners.delete(cb);
    },
    webCatch(at) {
      if (!at) { if (connected) send({ type: "web-catch", on: false }); return true; }
      if (!connected || helperVersion === null || helperOutdated(helperVersion, WEBDROP_HELPER_VERSION)) return false;
      return sendChecked({ type: "web-catch", on: true, ...at });
    },
    onWebDrop(cb) {
      webDropListeners.add(cb);
      return () => webDropListeners.delete(cb);
    },
    statusBar(b) {
      bar = b ? { type: "status-bar", on: true, ...b } : { type: "status-bar", on: false, hints: [], state: [], message: null };
      if (!barReady()) return false;
      const text = JSON.stringify(bar);
      if (text !== barSent) { barSent = text; send(bar); }
      return true;
    },
    get statusBarReady() { return barReady(); },
    watchKeys(on) {
      if (!on) { if (connected) send({ type: "watch-keys", on: false }); return true; }
      if (!connected || helperVersion === null || helperOutdated(helperVersion, KEYS_HELPER_VERSION)) return false;
      return sendChecked({ type: "watch-keys", on: true });
    },
    onKeys(cb) {
      keysListeners.add(cb);
      return () => keysListeners.delete(cb);
    },
    onExternalWanted(cb) {
      wantedListeners.add(cb);
      return () => wantedListeners.delete(cb);
    },
    onPasteInPlace(cb) {
      pasteListeners.add(cb);
      return () => { pasteListeners.delete(cb); };
    },
    onTrashDrop(cb) {
      trashListeners.add(cb);
      return () => trashListeners.delete(cb);
    },
    canvasMoved(view) {
      send({ type: "canvas", view });
    },
    hoverFrame(frame) {
      send(frame ? { type: "hover-frame", rect: frame.rect, clip: frame.clip } : { type: "hover-frame", rect: null });
    },
    hoverTint(t) {
      if (!connected || helperVersion === null || helperOutdated(helperVersion, TINT_HELPER_VERSION)) return false;
      send(t ? { type: "hover-tint", ...t } : { type: "hover-tint", rect: null });
      return true;
    },
    anchorPanel() { send({ type: "panel-anchor" }); },
    get setupReady() { return connected && helperVersion !== null && !helperOutdated(helperVersion, SETUP_HELPER_VERSION); },
    get rewriteReady() { return connected && helperVersion !== null && !helperOutdated(helperVersion, REWRITE_HELPER_VERSION); },
    get assistReady() { return connected && helperVersion !== null && !helperOutdated(helperVersion, ASSIST_HELPER_VERSION); },
    issueRows(r) {
      if (!connected || helperVersion === null || helperOutdated(helperVersion, ASSIST_HELPER_VERSION)) return;
      send(r ? { type: "issue-rows", ...r } : { type: "issue-rows", left: 0, right: 0, rows: [] });
    },
    get checkReady() { return connected && helperVersion !== null && !helperOutdated(helperVersion, CHECK_HELPER_VERSION); },
    get tintReady() { return connected && helperVersion !== null && !helperOutdated(helperVersion, TINT_HELPER_VERSION); },
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
    setMonitor(on, comfy) {
      if (monitor && monitor.on === on && monitor.comfy === comfy) return;
      monitor = { on, comfy };
      log("info", "overlay monitor", on);
      send({ type: "monitor", on, comfy });
    },
    sendBridge(msg) {
      send({ type: "bridge", to: "illustrator", msg });
    },
    onBridge(cb) {
      bridgeListeners.add(cb);
      return () => bridgeListeners.delete(cb);
    },
    get illustrator() { return illustrator; },
    onIllustrator(cb) {
      peerListeners.add(cb);
      return () => peerListeners.delete(cb);
    },
    setHangGuard(on, autoBackup, docs) {
      const m: OverlayCommand = { type: "hang-guard", on, autoBackup, seconds: HANG_SECONDS, docs };
      const key = JSON.stringify(m);
      if (key === hangKey) return;
      if (!hangGuard || (hangGuard as { on: boolean }).on !== on) log("info", "overlay hang guard", on, autoBackup);
      hangGuard = m; hangKey = key;
      send(m);
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
    onUpdate(cb) {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
    updateNow() { send({ type: "update-now" }); },
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
