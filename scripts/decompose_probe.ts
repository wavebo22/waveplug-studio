// AI 拆层 · 框选试验（只在 Mac 上用，要 macOS 自带的 sips）：把几张图发给 DeepSeek，让它列出要拆的部分和
// 大致范围，再把框画到图上，看准不准。和插件用同一套规划逻辑（src/core/assistant/decompose.ts）。
//
//   DEEPSEEK_API_KEY=sk-... node scripts/decompose_probe.ts [--detail coarse|medium|fine] [--hint "补充要求"] 图1.jpg 图2.png ...
//
// 结果写到 poc/tmp/decompose/（不提交）：每张图一个 HTML，实线是 DeepSeek 给的框，虚线是要送给心宝抠图的裁剪范围。
// Key 只从环境变量读，不写进任何文件。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEEPSEEK_VISION_MODEL, deepseekJson } from "../src/core/assistant/deepseek.ts";
import {
  DECOMPOSE_SYSTEM, type DecomposeDetail, decomposeRequest, isDecomposeDetail, parseDecomposeAnswer, visionSize,
} from "../src/core/assistant/decompose.ts";

const args = process.argv.slice(2);
let detail: DecomposeDetail = "medium", hint = "";
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--detail") { const v = args[++i] ?? ""; if (!isDecomposeDetail(v)) throw new Error("--detail 只能是 coarse / medium / fine"); detail = v; }
  else if (args[i] === "--hint") hint = args[++i] ?? "";
  else files.push(args[i]);
}
const key = process.env.DEEPSEEK_API_KEY ?? "";
if (!key) { console.error("先设置环境变量 DEEPSEEK_API_KEY"); process.exit(1); }
if (!files.length) { console.error("用法：node scripts/decompose_probe.ts [--detail coarse|medium|fine] [--hint 文字] 图片..."); process.exit(1); }

const outDir = resolve("poc/tmp/decompose");
mkdirSync(outDir, { recursive: true });
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const COLORS = ["#ff3b30", "#34c759", "#007aff", "#ff9500", "#af52de", "#00c7be", "#ff2d55", "#5856d6", "#ffcc00", "#8e8e93"];

function sizeOf(file: string) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]), h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!w || !h) throw new Error(`读不出 ${file} 的尺寸`);
  return { width: w, height: h };
}

for (const file of files) {
  const size = sizeOf(file);
  const thumb = visionSize(size.width, size.height);
  const tmp = join(tmpdir(), `wp-decompose-${process.pid}.png`);
  execFileSync("sips", ["-s", "format", "png", "--resampleHeightWidth", String(thumb.height), String(thumb.width), file, "--out", tmp], { stdio: "ignore" });
  const png = readFileSync(tmp);
  rmSync(tmp, { force: true });
  const dataUrl = "data:image/png;base64," + png.toString("base64");
  const started = Date.now();
  let raw: unknown = null, err = "", usage = "";
  try {
    const r = await deepseekJson(fetch, { key, model: DEEPSEEK_VISION_MODEL },
      { system: DECOMPOSE_SYSTEM, user: decomposeRequest(detail, thumb, hint), images: [dataUrl], maxTokens: 8000, temperature: 0.2 });
    raw = r.value;
    usage = r.usage ? `输入 ${r.usage.prompt} / 输出 ${r.usage.completion} tokens · ${r.model}` : r.model;
  } catch (e) { err = (e as Error).message; }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  // boxes are drawn on the thumbnail, so plan in its pixels
  const plan = parseDecomposeAnswer(raw, thumb);
  const rect = (r: { left: number; top: number; right: number; bottom: number }, color: string, dash: boolean) =>
    `<rect x="${r.left}" y="${r.top}" width="${r.right - r.left}" height="${r.bottom - r.top}" fill="none" stroke="${color}" stroke-width="${dash ? 2 : 4}"${dash ? ' stroke-dasharray="10 8" opacity="0.7"' : ""}/>`;
  const svg = plan.parts.map((p, i) => {
    const c = COLORS[i % COLORS.length];
    return rect(p.crop, c, true) + rect(p.box, c, false)
      + `<text x="${p.box.left + 6}" y="${p.box.top + 30}" fill="${c}" stroke="#000" stroke-width="4" paint-order="stroke" font-size="26" font-weight="700">${i + 1}</text>`;
  }).join("");
  const rows = plan.parts.map((p, i) => `<li><b style="color:${COLORS[i % COLORS.length]}">${i + 1}. ${esc(p.name)}</b> <small>${p.kind}</small></li>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>拆层试验 · ${esc(basename(file))}</title>
<style>body{font:14px system-ui;margin:16px;background:#1e1e1e;color:#ddd}.wrap{display:flex;gap:20px;align-items:flex-start}
svg{max-width:75vw;height:auto;background:#000}pre{white-space:pre-wrap;font-size:12px;color:#999}small{color:#888}</style>
<h2>${esc(basename(file))}</h2>
<p>原图 ${size.width}×${size.height} · 发送 ${thumb.width}×${thumb.height} · 粒度 ${detail}${hint ? " · 补充：" + esc(hint) : ""} · 用时 ${secs} 秒 · ${esc(usage)}</p>
${err ? `<p style="color:#ff453a">出错：${esc(err)}</p>` : ""}
<div class="wrap"><svg viewBox="0 0 ${thumb.width} ${thumb.height}" width="${thumb.width}" height="${thumb.height}"><image href="${dataUrl}" width="${thumb.width}" height="${thumb.height}"/>${svg}</svg>
<div><p>实线：DeepSeek 给的框；虚线：送给心宝抠图的裁剪范围。编号 = 从前到后。</p><ol style="list-style:none;padding:0">${rows}</ol>
${plan.dropped.length ? `<p>丢掉的：</p><ul>${plan.dropped.map(d => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
<p>原始回答：</p><pre>${esc(JSON.stringify(raw, null, 1))}</pre></div></div>`;
  const out = join(outDir, basename(file, extname(file)) + `.${detail}.html`);
  writeFileSync(out, html);
  console.log(`${basename(file)}：${err ? "出错 " + err : plan.parts.length + " 个部分"}（${secs} 秒）→ ${out}`);
}
