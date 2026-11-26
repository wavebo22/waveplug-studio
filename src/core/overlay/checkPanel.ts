// The native 检查结果 window (helper ≥ CHECK_HELPER_VERSION, native/overlay/src/panel/check.rs): the
// document check's list beside the WavePlug 图层 panel. The plugin does every check and every fix;
// the window shows the list and reports hovering (the issue's layers light up red / yellow in the
// panel and on the canvas), clicks, fixes, the two AI options and 重新检查 / 关闭. 收起 is the
// window's own. Pure (tests/overlay_check.test.ts).

import { CATEGORY_NAMES, type Category, type Issue } from "../check/rules.ts";

export const CHECK_PANEL = "check";

export interface CheckPanelIssue {
  key: string;
  sev: Issue["severity"];
  /** the category's name, the list is grouped by it */
  cat: string;
  title: string;
  detail: string;
  /** the fix button's label; absent: no button */
  fix?: string;
  /** 处理中… / 已处理: shown instead of the button */
  state?: string;
  /** it has layers: hovering lights them up, a click selects them */
  pick: boolean;
}

export interface CheckSections {
  head: { summary: string; busy: string; error: string };
  opts: { copy: boolean; visual: boolean; ai: boolean };
  issues: CheckPanelIssue[];
}

export type CheckAction =
  | { kind: "hover"; key: string | null }
  | { kind: "pick"; key: string }
  | { kind: "fix"; key: string }
  | { kind: "opt"; name: "copy" | "visual"; on: boolean }
  | { kind: "recheck" }
  | { kind: "close" };

const ORDER: Category[] = ["font", "smart", "delivery", "text", "copy", "visual", "design", "hygiene"];
const SEV_RANK = { error: 0, warn: 1, info: 2 } as const;

/** The list in the window's order: by category, worst first within each. */
export function checkIssues(issues: readonly Issue[], states: ReadonlyMap<string, string>): CheckPanelIssue[] {
  return [...issues]
    .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || SEV_RANK[a.severity] - SEV_RANK[b.severity])
    .map(i => ({
      key: i.key, sev: i.severity, cat: CATEGORY_NAMES[i.category], title: i.title, detail: i.detail, pick: i.ids.length > 0,
      ...(states.get(i.key) ? { state: states.get(i.key) } : i.fix ? { fix: i.fixLabel ?? "处理" } : {}),
    }));
}

/** 3 个错误 · 4 个警告 · 9 个提示 (what isn't dealt with yet) */
export function checkSummary(issues: readonly Issue[], states: ReadonlyMap<string, string>): string {
  const open = issues.filter(i => states.get(i.key) !== "已处理");
  if (!open.length) return issues.length ? "都处理好了" : "没有发现问题";
  const n = (s: Issue["severity"]) => open.filter(i => i.severity === s).length;
  return [["error", "错误"], ["warn", "警告"], ["info", "提示"]].map(([s, label]) => [n(s as Issue["severity"]), label] as const)
    .filter(([c]) => c > 0).map(([c, label]) => `${c} 个${label}`).join(" · ");
}

export function parseCheckAction(raw: unknown): CheckAction | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  const key = typeof a.key === "string" && a.key.length <= 400 ? a.key : null;
  switch (a.kind) {
    case "hover": return a.key === null ? { kind: "hover", key: null } : key !== null ? { kind: "hover", key } : null;
    case "pick": return key !== null ? { kind: "pick", key } : null;
    case "fix": return key !== null ? { kind: "fix", key } : null;
    case "opt": return (a.name === "copy" || a.name === "visual") && typeof a.on === "boolean" ? { kind: "opt", name: a.name, on: a.on } : null;
    case "recheck": return { kind: "recheck" };
    case "close": return { kind: "close" };
    default: return null;
  }
}

/** The one colour scheme for issues, the same in the 检查结果 window (badge, row outline, the line),
 *  the 图层 panel rows (.chk-error / .chk-warn) and the tint on the canvas: red for 错误, yellow for
 *  警告 and 提示 (plugin/styles.css --c-err / --c-warn; native/overlay/src/panel/theme.rs ERR / WARN). */
export const SEVERITY_COLOR: Record<Issue["severity"], string> = { error: "#EC7A69", warn: "#E3B04B", info: "#E3B04B" };
