// 按行拆分文字: the lines of a text layer. Photoshop separates paragraphs with "\r" and forced line
// breaks (Shift+Enter) with "\u0003"; both count as line ends here.

const BREAK = /(\r\n|\r|\n|\u0003)/;

/** The text split into lines, separators kept at odd indexes (as String.split with a capture). */
const tokens = (text: string) => text.split(BREAK);

/** Indexes (into the line list) and texts of the non-blank lines. */
export function textLines(text: string): { index: number; text: string }[] {
  return tokens(text).filter((_, i) => i % 2 === 0).map((t, index) => ({ index, text: t })).filter(l => l.text.trim() !== "");
}

/**
 * The text with every line but `index` emptied, line breaks kept: set on a copy of the layer it
 * shows that one line exactly where it was (the empty lines above still take their height).
 */
export function onlyLine(text: string, index: number): string {
  return tokens(text).map((t, i) => i % 2 === 1 || i / 2 === index ? t : "").join("");
}

/** Layer name for a line: its text, shortened. */
export const lineName = (line: string) => {
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40).trimEnd() + "…" : t;
};
