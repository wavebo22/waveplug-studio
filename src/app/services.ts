// Everything the UI depends on, injected so the same UI runs in Photoshop and in the browser preview.

import type { Comfy } from "../core/comfy/client.ts";
import type { Profile } from "../core/workflow/profile.ts";
import type { PsHost } from "../ps/host.ts";

export interface PickedImage { name: string; bytes: Uint8Array; url: string }

export interface Services {
  host: PsHost;
  /** Created on demand from the configured address. */
  comfy(base: string): Comfy;
  pickJson(): Promise<{ name: string; text: string } | null>;
  pickImage(): Promise<PickedImage | null>;
  saveImage(png: Uint8Array, suggested: string): Promise<boolean>;
  /** Tries every transport against the ComfyUI address; one human-readable line per check. */
  diagnose?(base: string): Promise<string[]>;
  /** Saves an exchanged image next to the diagnostic log (F:\\waveplug\\studio\\reports\\debug_*). */
  debugSave?(name: string, png: Uint8Array): void;
  version: string;
}

// ── persistent settings / profiles (UXP localStorage is per-plugin and survives restarts) ──

export interface Settings { comfyUrl: string; activeProfile: string | null; advancedOpen: boolean }
export interface ProfileState { prompt: string; params: Record<string, number | boolean>; seedMode: "random" | "fixed"; seed: number; count?: number }

const KEY = { settings: "wp.settings", profiles: "wp.profiles", state: "wp.state.", thumb: "wp.thumb." };

function read<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("保存失败", k, e); }
}

export const store = {
  settings: (): Settings => ({ comfyUrl: "http://127.0.0.1:8188", activeProfile: null, advancedOpen: false, ...read<Partial<Settings>>(KEY.settings, {}) }),
  saveSettings: (s: Settings) => write(KEY.settings, s),
  profiles: (): Profile[] => read<Profile[]>(KEY.profiles, []),
  saveProfiles: (p: Profile[]) => write(KEY.profiles, p),
  state: (id: string): ProfileState => ({ prompt: "", params: {}, seedMode: "random", seed: 0, ...read<Partial<ProfileState>>(KEY.state + id, {}) }),
  saveState: (id: string, s: ProfileState) => write(KEY.state + id, s),
  thumb: (taskId: string, label: string): string | null => { try { return localStorage.getItem(KEY.thumb + taskId + "." + label); } catch { return null; } },
  saveThumb: (taskId: string, label: string, url: string) => { try { localStorage.setItem(KEY.thumb + taskId + "." + label, url); } catch { /* quota */ } },
};
