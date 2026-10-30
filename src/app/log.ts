// Diagnostic log. In Photoshop it is appended to the plugin data folder
// (…\UXP\PluginsStorage\PHSP\<ver>\External\com.waveplug.studio\PluginData\waveplug.log)
// so problems can be read without access to the UXP developer console.

type Sink = (line: string) => Promise<void>;

let sink: Sink | null = null;
let queue: Promise<void> = Promise.resolve();

export function setLogSink(s: Sink) { sink = s; }

function fmt(x: unknown): string {
  if (x instanceof Error) return `${x.name}: ${x.message}${x.stack ? "\n    " + x.stack.split("\n").slice(1, 4).join("\n    ") : ""}`;
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

export function log(level: "info" | "warn" | "error", ...parts: unknown[]) {
  const line = `${new Date().toISOString()} [${level}] ${parts.map(fmt).join(" ")}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  if (sink) { const s = sink; queue = queue.then(() => s(line + "\n")).catch(() => undefined); }
}

/** Rejects if `p` hasn't settled within `ms` — UXP network calls can otherwise hang silently. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒无响应）`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
