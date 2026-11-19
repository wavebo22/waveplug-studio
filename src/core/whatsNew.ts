// 更新内容: the build embeds the latest git commits (scripts/build.mjs → __CHANGES__); after an
// update the panel lists the ones the user has not seen yet.

export interface Change {
  hash: string;
  /** ISO commit date */
  date: string;
  subject: string;
  body: string;
}

/** Commits that only touch docs, experiments, tests or tooling are not shown to users either. */
const HIDDEN = /^(docs|poc|test|tests|chore|refactor|ci|build|style|wip)(\([^)]*\))?!?\s*[:：]/i;
const KIND: Record<string, string> = { feat: "新功能", fix: "修复", perf: "优化" };

/** Changes are written for users in Chinese; older English-only commits are left out. */
const CHINESE = /[\u4e00-\u9fff]/;

export function userVisible(c: Change): boolean {
  return !HIDDEN.test(c.subject) && CHINESE.test(c.subject);
}

/** "feat: 生图…" → { kind: "新功能", text: "生图…" } */
export function describe(c: Change): { kind: string; text: string; detail: string[] } {
  const m = /^([a-z]+)(\([^)]*\))?!?\s*[:：]\s*(.*)$/i.exec(c.subject);
  const kind = m ? KIND[m[1].toLowerCase()] ?? "改动" : "改动";
  // hard-wrapped lines join into paragraphs; a blank line or a "- " bullet starts a new one
  const detail: string[] = [];
  let open = false;
  for (const raw of c.body.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^(co-authored-by|signed-off-by|🤖)/i.test(l)) { open = false; continue; }
    if (!l) { open = false; continue; }
    if (open && !/^[-*•]\s/.test(l)) {
      const prev = detail[detail.length - 1];
      detail[detail.length - 1] = prev + (/[\u3000-\u9fff\uff00-\uffef]$/.test(prev) && /^[\u3000-\u9fff\uff00-\uffef]/.test(l) ? "" : " ") + l;
    } else { detail.push(l); open = true; }
  }
  return { kind, text: m ? m[3] : c.subject, detail };
}

/**
 * Changes to announce, newest first. `seen` is the newest commit already shown (null = never):
 * then only the latest few are listed. A `seen` that is not in the list (a very old build) lists
 * the latest ten.
 */
export function unseenChanges(changes: readonly Change[], seen: string | null): Change[] {
  if (!changes.length || changes[0].hash === seen) return [];
  const i = seen ? changes.findIndex(c => c.hash === seen) : -1;
  const fresh = i >= 0 ? changes.slice(0, i) : changes;
  return fresh.filter(userVisible).slice(0, i >= 0 ? 30 : seen ? 10 : 3);
}
