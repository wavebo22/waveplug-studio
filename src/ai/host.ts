// The panel's way into Illustrator: one call into the host script (ai/host/wavelayer.jsx) at a
// time, through CEP's evalScript. Calls queue up (Illustrator runs scripts one by one anyway); a
// call made while the same read is already waiting is merged into it.

export interface AiHost {
  call<T = any>(op: string, args?: unknown): Promise<T>;
  /** calls waiting or running */
  readonly busy: number;
}

/** evalScript as CEP gives it; `load` evaluates the host script file again (after an update). */
export interface Evaluator {
  evalScript(code: string): Promise<string>;
  load?(): Promise<void>;
}

/** The script text for one call: JSON is an ES3 literal once U+2028 / U+2029 are escaped. */
export function callScript(op: string, args: unknown): string {
  const a = JSON.stringify(args ?? {}).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `WavePlugWL.call(${JSON.stringify(op)},${a})`;
}

/** Reads the host script's answer; throws its error. */
export function readAnswer<T>(text: string): T {
  let r: any;
  try { r = JSON.parse(text); }
  catch { throw new Error(text && text !== "undefined" ? `Illustrator 脚本没有正常返回：${text.slice(0, 120)}` : "Illustrator 脚本没有加载"); }
  if (!r || r.ok !== true) throw new Error(String(r?.error ?? "Illustrator 出错"));
  return r.value as T;
}

export function createHost(ev: Evaluator): AiHost {
  let chain: Promise<unknown> = Promise.resolve(), waiting = 0, reloaded = false;
  const pendingReads = new Map<string, Promise<unknown>>();
  async function run<T>(op: string, args: unknown): Promise<T> {
    const code = callScript(op, args);
    let text = await ev.evalScript(code);
    // the host script isn't there (Illustrator restarted the engine, or a new build): load and retry
    if ((!text || text === "EvalScript error." || text === "undefined") && ev.load && !reloaded) {
      reloaded = true;
      await ev.load();
      text = await ev.evalScript(code);
    }
    return readAnswer<T>(text);
  }
  return {
    call<T>(op: string, args?: unknown): Promise<T> {
      const read = op === "sig" || op === "tree";
      const key = read ? op + JSON.stringify(args ?? {}) : "";
      if (read && pendingReads.has(key)) return pendingReads.get(key) as Promise<T>;
      waiting++;
      const p = chain.then(() => run<T>(op, args)).finally(() => { waiting--; if (read) pendingReads.delete(key); });
      chain = p.catch(() => undefined);
      if (read) pendingReads.set(key, p);
      return p;
    },
    get busy() { return waiting; },
  };
}
