// Changing a text layer's words without touching how it looks: Photoshop's text descriptor (textKey)
// is the string plus style runs (textStyleRange: font, size, colour …; paragraphStyleRange …) given as
// character offsets. Setting only the string (the DOM's textItem.contents) makes Photoshop rebuild
// the runs from the first one — mixed fonts / sizes / colours are lost, and a paragraph box can move.
// Here the string is edited in the descriptor and every run is moved / stretched to match, so the
// layer keeps its styles, box, transform and position; the descriptor is then set back as a whole.
// Pure (tests/check_text_edit.test.ts).

/** Photoshop's line break in a text layer */
const CR = "\r";
/** "\n" / "\r\n" / ETX as Photoshop's "\r" */
export const toPsText = (s: string) => s.replace(/\r\n?|\n|\u0003/g, CR);

interface Run { from: number; to: number; [k: string]: unknown }
const isRun = (v: unknown): v is Run => !!v && typeof v === "object" && typeof (v as Run).from === "number" && typeof (v as Run).to === "number";

/** Where an offset goes when [at, at + len) becomes `len2` characters long. A run's start inside the
 *  replaced part moves after the new text; a run's end inside it moves there too, so the new text
 *  takes the style of the run that held the replaced part's first character. */
function moveOffset(p: number, at: number, len: number, len2: number, end: boolean): number {
  if (p < at || (p === at && (end ? len > 0 : true))) return p;
  if (p >= at + len) return p + len2 - len;
  return at + len2; // inside the replaced part
}

/** The text descriptor with `from` replaced by `to` once (line breaks either way), the style runs
 *  following; null when `from` isn't in the text. `whole`: replace everything (AI 改写). */
export function replaceInTextKey(textKey: Record<string, unknown>, from: string, to: string, whole = false): Record<string, unknown> | null {
  const text = typeof textKey.textKey === "string" ? textKey.textKey : null;
  if (text === null) return null;
  const src = toPsText(text), want = toPsText(from), put = toPsText(to);
  const at = whole ? 0 : src.indexOf(want);
  if (at < 0 || (!whole && !want)) return null;
  const len = whole ? src.length : want.length;
  const out = JSON.parse(JSON.stringify(textKey)) as Record<string, unknown>;
  out.textKey = src.slice(0, at) + put + src.slice(at + len);
  for (const [k, v] of Object.entries(out)) {
    if (!/Range$/.test(k) || !Array.isArray(v)) continue;
    const runs = v.filter(isRun);
    if (!runs.length) continue;
    for (const r of runs) {
      const f = moveOffset(r.from, at, len, put.length, false), t = moveOffset(r.to, at, len, put.length, true);
      r.from = f; r.to = Math.max(f, t);
    }
    // a run that the replacement swallowed whole is gone; at least one stays (it styles the new text)
    const kept = runs.filter(r => r.to > r.from);
    out[k] = kept.length ? kept : [{ ...runs[0], from: 0, to: (out.textKey as string).length }];
  }
  return out;
}
