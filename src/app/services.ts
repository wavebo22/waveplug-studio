// Everything the UI depends on, injected so the same UI runs in Photoshop and in the browser preview.

import type { Comfy } from "../core/comfy/client.ts";
import type { Profile, TaskType } from "../core/workflow/profile.ts";
import type { LayerTools, LayerTree, PsHost } from "../ps/host.ts";
import type { Overlay } from "./overlay.ts";

export interface PickedImage { name: string; bytes: Uint8Array; url?: string }

export interface Services {
  host: PsHost;
  tools: LayerTools;
  layers: LayerTree;
  /** Shared native helper connection, created by the Studio panel and used by WaveLayer drag/drop. */
  overlay?: Overlay;
  /** Created on demand from the configured address. */
  comfy(base: string): Comfy;
  pickJson(): Promise<{ name: string; text: string } | null>;
  pickImage(): Promise<PickedImage | null>;
  saveImage(png: Uint8Array, suggested: string): Promise<boolean>;
  /** Tries every transport against the ComfyUI address; one human-readable line per check. */
  diagnose?(base: string): Promise<string[]>;
  /** Saves an exchanged image next to the diagnostic log (F:\\waveplug\\studio\\reports\\debug_*). */
  debugSave?(name: string, png: Uint8Array): void;
  /** Lets the user pick the ComfyUI start script/exe; returns its native path. */
  pickLauncher?(): Promise<string | null>;
  /** Starts the ComfyUI script/exe; returns an error message or null (legacy manual launch). */
  launch?(path: string): Promise<string | null>;
  /** Ensures the native overlay helper is running; the helper then manages ComfyUI itself. */
  launchOverlay?(): Promise<string | null>;
  /** present only in the development build: reloads the code from disk */
  devReload?(): void;
  version: string;
}

// ── persistent settings / profiles (UXP localStorage is per-plugin and survives restarts) ──

export interface Settings {
  comfyUrl: string; activeProfile: string | null; advancedOpen: boolean;
  /** save sent/received images and the submitted workflow to reports\debug_* (large files) */
  debugFiles: boolean;
  /** ComfyUI start script / executable for one-click start (e.g. run_nvidia_gpu.bat) */
  comfyLaunch: string;
  /** Close only a ComfyUI instance launched by WavePlug when Photoshop exits; default true. */
  comfyCloseWithPhotoshop: boolean;
  /** Do not open a browser when the native helper starts ComfyUI; default true. */
  comfyNoBrowser: boolean;
  /** Whether Photoshop startup also launches ComfyUI; default true (needs the helper running). */
  comfyAutoStartWithPhotoshop: boolean;
  /** Whether the plugin starts the overlay helper (外置框架) when Photoshop starts; default true.
   *  The helper always quits with Photoshop. */
  helperAutoStart: boolean;
  /** 生成 (the AI modes) or 工具 */
  view?: "generate" | "tools";
  /** panel mode and the workflow last used in each mode */
  mode?: TaskType;
  activeByMode?: Partial<Record<TaskType, string>>;
  /** text-to-image size: "跟随" (selection / canvas aspect) or "w:h", and the long side in px */
  t2iRatio?: string;
  t2iLong?: number;
  /** 放大 factor */
  upScale?: number;
  /** 放大: whole canvas / selection into a new document, or the active layer into a smart object */
  upTarget?: "canvas" | "layer";
  /** 抠图: afterwards remove the object from the original with the 局部重绘 workflow (拆图) */
  extractRemove?: boolean;
}
export interface ProfileState { prompt: string; params: Record<string, number | boolean>; seedMode: "random" | "fixed"; seed: number; count?: number; fullRun?: boolean; keepDetail?: boolean }

const KEY = { settings: "wp.settings", profiles: "wp.profiles", state: "wp.state.", thumb: "wp.thumb.", favorites: "wp.favorites" };

/** Saved prompts per place they are typed in: inpaint, outpaint, txt2img. */
export type Favorites = Record<string, string[]>;

function read<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("保存失败", k, e); }
}

export const store = {
  settings: (): Settings => ({ comfyUrl: "http://127.0.0.1:8188", activeProfile: null, advancedOpen: false, debugFiles: false, comfyLaunch: "", comfyCloseWithPhotoshop: true, comfyNoBrowser: true, comfyAutoStartWithPhotoshop: true, helperAutoStart: true, ...read<Partial<Settings>>(KEY.settings, {}) }),
  saveSettings: (s: Settings) => write(KEY.settings, s),
  profiles: (): Profile[] => read<Profile[]>(KEY.profiles, []),
  saveProfiles: (p: Profile[]) => write(KEY.profiles, p),
  state: (id: string): ProfileState => ({ prompt: "", params: {}, seedMode: "random", seed: 0, ...read<Partial<ProfileState>>(KEY.state + id, {}) }),
  saveState: (id: string, s: ProfileState) => write(KEY.state + id, s),
  favorites: (): Favorites => read<Favorites>(KEY.favorites, {}),
  saveFavorites: (f: Favorites) => write(KEY.favorites, f),
  thumb: (taskId: string, label: string): string | null => { try { return localStorage.getItem(KEY.thumb + taskId + "." + label); } catch { return null; } },
  saveThumb: (taskId: string, label: string, url: string) => { try { localStorage.setItem(KEY.thumb + taskId + "." + label, url); } catch { /* quota */ } },
};
