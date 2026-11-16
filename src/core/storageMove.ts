// Moving the old development plugin's data (com.waveplug.studio.dev: imported workflows, settings,
// links — UXP keeps localStorage per plugin) into the one plugin (com.waveplug.studio). The old
// plugin, while it still runs the new code through its old loader, writes everything to a file in
// the development folder; the one plugin takes it over once, the first time it runs from there.

/** set once the data has been taken over (never moved again, later changes stay) */
export const MOVED_FLAG = "wp.movedFromDev.v1";
/** keys that belong to one installation and are never carried over */
const LOCAL_ONLY = new Set(["wp.loadFrom", "wp.devRoot", MOVED_FLAG]);

export interface StorageLike {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
}

/** every key / value, in a form that can be written to a file */
export function dumpStorage(s: StorageLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k === null || LOCAL_ONLY.has(k)) continue;
    const v = s.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** What to write when taking over `dump` (the file's text): nothing once moved or when the file
 *  isn't a dump. The old plugin's values win: that is where the user has been working. */
export function importPlan(fileText: string, alreadyMoved: boolean): [string, string][] {
  if (alreadyMoved) return [];
  let dump: unknown;
  try { dump = JSON.parse(fileText); } catch { return []; }
  if (!dump || typeof dump !== "object" || Array.isArray(dump)) return [];
  return Object.entries(dump as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string" && !LOCAL_ONLY.has(e[0]));
}
