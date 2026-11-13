// Diagnostic log. In Photoshop it is appended to the plugin data folder
// (…\UXP\PluginsStorage\PHSP\<ver>\External\com.waveplug.studio\PluginData\waveplug.log)
// so problems can be read without access to the UXP developer console.
//
// Besides the running log it keeps, in memory, what a tester's report needs:
// - breadcrumbs: the last things the user did (`crumb`), so an error says what led to it;
// - problems: every warning / error with its likely cause (`explain`) and those breadcrumbs,
//   the same one counted instead of repeated;
// - the environment (`setLogContext`): versions, Photoshop, the helper.
// `diagnosticReport()` puts them into one text a tester can send (设置 › 排查问题 › 导出诊断报告).
// No UXP here: main.uxp.ts gives it the files (tested in tests/log.test.ts).

export type LogLevel = "info" | "warn" | "error";
type Sink = (line: string, level: LogLevel) => Promise<void>;

let sink: Sink | null = null;
let queue: Promise<void> = Promise.resolve();

export function setLogSink(s: Sink) { sink = s; }

/** Resolves once every line logged so far has been written (used before risky host calls). */
export function flushLog(): Promise<void> { return queue; }

/** An error with all it carries: name, message, own fields (Photoshop's `number`, ComfyUI's
 *  `detail` …), the first stack frames and what caused it. */
function fmtError(x: Error, depth = 0): string {
  const extra: string[] = [];
  for (const k of Object.keys(x)) {
    if (k === "name" || k === "message" || k === "stack" || k === "cause") continue;
    let v: string | undefined;
    try { v = JSON.stringify((x as any)[k]); } catch { v = String((x as any)[k]); }
    if (v !== undefined) extra.push(`${k}=${v.length > 300 ? v.slice(0, 300) + "…" : v}`);
  }
  const frames = x.stack ? x.stack.split("\n").slice(1, 7).map(f => f.trim()).filter(Boolean) : [];
  const cause = (x as any).cause;
  return `${x.name}: ${x.message}`
    + (extra.length ? ` {${extra.join(", ")}}` : "")
    + (frames.length ? "\n    " + frames.join("\n    ") : "")
    + (cause !== undefined && depth < 3 ? "\n  caused by " + (cause instanceof Error ? fmtError(cause, depth + 1) : fmt(cause)) : "");
}

function fmt(x: unknown): string {
  if (x instanceof Error) return fmtError(x);
  if (typeof x === "string") return x;
  if (x === undefined) return "undefined";
  try { return JSON.stringify(x) ?? String(x); } catch { return String(x); }
}

// ── breadcrumbs: what the user did lately ──

interface Crumb { at: number; text: string; count: number }
const CRUMBS = 40;
let crumbs: Crumb[] = [];

/** Notes something the user did (a command, a menu row, a tool): shown with the next problem. */
export function crumb(text: string) {
  const last = crumbs[crumbs.length - 1], now = Date.now();
  if (last && last.text === text && now - last.at < 5000) { last.count++; last.at = now; return; }
  crumbs.push({ at: now, text, count: 1 });
  if (crumbs.length > CRUMBS) crumbs = crumbs.slice(-CRUMBS);
}
const clock = (t: number) => new Date(t).toISOString().slice(11, 23);
const crumbLines = (n: number) => crumbs.slice(-n).map(c => `${clock(c.at)} ${c.text}${c.count > 1 ? ` ×${c.count}` : ""}`);

// ── likely causes ──

/** What usually lies behind a message, for the person reading the report. */
const CAUSES: [RegExp, string][] = [
  [/当前文档已切换/, "操作途中切换了文档，为避免改错文件已取消"],
  [/当前不可用|not currently available|is not available/i, "Photoshop 拒绝了这个命令：图层的状态不允许（锁定、背景图层、没有蒙版 / 样式、没选中图层），或正处于自由变换、文字编辑等状态"],
  [/modal state|正在执行其他命令|host is busy|is busy/i, "Photoshop 正忙：有对话框开着、正在变换 / 输入文字，或另一个命令还没结束"],
  [/does not exist|已不存在|No such element/i, "图层或文档已经不在了：面板列表比 Photoshop 旧（刚删除、撤销或切换了文档）"],
  [/activeDocument|未打开文档|no document/i, "没有打开的文档"],
  [/Network request failed|无法连接 ComfyUI|XHR 网络错误|ECONNREFUSED/i, "连不上 ComfyUI：没有启动、地址或端口不对，或被防火墙拦住"],
  [/超时|timed? ?out/i, "等待超时：ComfyUI 或 Photoshop 没有在限定时间内回应（卡住、显存不足、模型加载很慢）"],
  [/403|来源校验/, "ComfyUI 拒绝了插件的来源：启动参数需要允许跨域（--enable-cors-header）"],
  [/helper outdated|外置框架.*(旧|没有响应|没有重新连上)/, "外置框架（waveplug-overlay.exe）版本旧或没在运行：在 Windows 上运行 native\\overlay\\build.cmd 后重启它"],
  [/user cancell?ed|用户已取消|已取消|-128/i, "用户取消了操作（不是故障）"],
  [/grabPixels|invalid empty image region|图层太大/, "读取像素失败：图层是空的、在画布外，或尺寸超过限制"],
  [/out of memory|内存不足|scratch disk|暂存盘/i, "Photoshop 内存或暂存盘不足"],
  [/Invalid target|无效的目标/i, "目标位置不允许：例如把图层移进它自己、移到背景下面，或移进画板 / 变体图层"],
  [/permission|权限|EACCES|access is denied/i, "没有读写这个文件或文件夹的权限"],
  [/Cannot read propert|is not a function|undefined is not|is not defined/i, "插件自身的错误（代码缺陷），请把这份报告发给开发者"],
];
/** The likely cause of a message; null when it isn't one of the known kinds. */
export function explain(text: string): string | null {
  for (const [re, why] of CAUSES) if (re.test(text)) return why;
  return null;
}

// ── problems and recent lines ──

export interface Problem {
  level: "warn" | "error";
  /** first and last time it happened (ms) */
  first: number;
  last: number;
  count: number;
  /** the log line's text without its time */
  text: string;
  cause: string | null;
  /** what the user did just before the first time */
  crumbs: string[];
}
const PROBLEMS = 200, RECENT = 600;
let problems: Problem[] = [];
let recent: string[] = [];
let context: Record<string, unknown> = {};
const session = Date.now().toString(36).slice(-6);

/** Facts about this run (versions, Photoshop, the helper …) for the report's head. */
export function setLogContext(more: Record<string, unknown>) { context = { ...context, ...more }; }
export function logProblems(): readonly Problem[] { return problems; }
/** For tests: start over. */
export function resetLog() { crumbs = []; problems = []; recent = []; context = {}; sink = null; queue = Promise.resolve(); }

/** The part of a message that stays the same when it happens again (numbers and ids taken out). */
const signature = (text: string) => text.split("\n")[0].replace(/\d+/g, "#").slice(0, 200);

function note(level: "warn" | "error", text: string, at: number): Problem {
  const sig = signature(text);
  const same = problems.find(p => p.level === level && signature(p.text) === sig);
  if (same) { same.count++; same.last = at; return same; }
  const p: Problem = { level, first: at, last: at, count: 1, text, cause: explain(text), crumbs: crumbLines(6) };
  problems.push(p);
  if (problems.length > PROBLEMS) problems = problems.slice(-PROBLEMS);
  return p;
}

export function log(level: LogLevel, ...parts: unknown[]) {
  const at = Date.now(), text = parts.map(fmt).join(" ");
  let line = `${new Date(at).toISOString()} [${level}] ${text}`;
  if (level !== "info") {
    const p = note(level, text, at);
    // the first time: why, and what came before it, right under the line
    if (p.count === 1) {
      if (p.cause) line += `\n    原因：${p.cause}`;
      if (p.crumbs.length) line += `\n    之前的操作：${p.crumbs.join(" → ")}`;
    }
  }
  recent.push(line);
  if (recent.length > RECENT) recent = recent.slice(-RECENT);
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  if (sink) { const s = sink; queue = queue.then(() => s(line + "\n", level)).catch(() => undefined); }
}

/**
 * Everything a tester needs to send: the environment, each problem once (how often, the likely
 * cause, what the user did before it), the last actions and the last lines of the log.
 */
export function diagnosticReport(now = Date.now()): string {
  const out: string[] = [];
  out.push("WavePlug Studio 诊断报告", `生成时间：${new Date(now).toISOString()}　会话：${session}`, "");
  out.push("== 环境 ==");
  for (const [k, v] of Object.entries(context)) out.push(`${k}: ${typeof v === "string" ? v : fmt(v)}`);
  const errors = problems.filter(p => p.level === "error"), warns = problems.filter(p => p.level === "warn");
  out.push("", `== 问题（${errors.length} 种错误，${warns.length} 种警告）==`);
  if (!problems.length) out.push("本次运行没有记录到错误或警告。");
  for (const p of [...errors, ...warns]) {
    out.push("", `[${p.level === "error" ? "错误" : "警告"}] ×${p.count}　${clock(p.first)}${p.count > 1 ? " – " + clock(p.last) : ""}`);
    out.push(p.text);
    out.push(`原因：${p.cause ?? "未归类（请连同下面的日志一起发给开发者）"}`);
    if (p.crumbs.length) out.push("之前的操作：", ...p.crumbs.map(c => "  " + c));
  }
  out.push("", "== 最近的操作 ==", ...(crumbs.length ? crumbLines(CRUMBS) : ["（无）"]));
  out.push("", `== 最近的日志（${recent.length} 行）==`, ...recent);
  return out.join("\n") + "\n";
}

/** Rejects if `p` hasn't settled within `ms` — UXP network calls can otherwise hang silently. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒无响应）`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
