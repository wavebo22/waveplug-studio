// The settings panels (检查 / AI 整理 / 改写 before they start): each feature's own surface in the
// canvas-corner window (app/cornerSlot.ts; native/overlay/src/panel/setup.rs draws them all). The
// plugin describes the form — a title, a line about what it covers, fields, the start button — and
// gets back the user's changes and 开始 / ×. Pure (tests/overlay_setup.test.ts).

export const CHECK_SETUP = "check-setup";
export const ORGANIZE_SETUP = "organize-setup";
export const REWRITE_SETUP = "rewrite-setup";
/** above the generate panel: what the user just opened goes in front of it */
export const SETUP_PRIORITY = 20;

export type SetupField =
  | { key: string; kind: "toggle"; label: string; tip?: string; value: boolean; disabled?: boolean }
  | { key: string; kind: "choice"; label: string; options: { value: string; label: string }[]; value: string }
  | { key: string; kind: "text"; label: string; hint?: string; value: string }
  /** a heading between groups of fields */
  | { key: string; kind: "heading"; label: string };

export interface SetupSections {
  form: {
    title: string;
    /** what it will cover (整个文档 · 120 个图层 …) */
    scope: string;
    fields: SetupField[];
    /** the start button's text; "" while it can't start */
    start: string;
    /** why it can't start / what went wrong */
    note: string;
  };
}

export type SetupAction =
  | { kind: "set"; key: string; value: boolean | string }
  | { kind: "start" }
  | { kind: "close" };

export function parseSetupAction(raw: unknown): SetupAction | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  switch (a.kind) {
    case "set": {
      if (typeof a.key !== "string" || !/^[\w:-]{1,40}$/.test(a.key)) return null;
      if (typeof a.value === "boolean") return { kind: "set", key: a.key, value: a.value };
      if (typeof a.value === "string") return { kind: "set", key: a.key, value: a.value.slice(0, 300) };
      return null;
    }
    case "start": return { kind: "start" };
    case "close": return { kind: "close" };
    default: return null;
  }
}
