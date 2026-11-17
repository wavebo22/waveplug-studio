// 一键更新 (update.cmd, WavePlug › 开发者 › 从源码更新): everything a code change needs on the
// Windows machine, in order, doing only what is out of date:
//   0. the newest code from GitHub (git pull --ff-only, when the folder has an origin): the Mac
//      pushes every change, so this machine doesn't need the shared folder. The first time Git's
//      own sign-in window asks for the GitHub account (the repository is private).
//   1. the overlay helper (native/overlay/build.cmd) when its source is newer than the built exe;
//      the running helper switches to the new exe by itself
//   2. npm run build: the Photoshop plugin, the Illustrator panel; both panels see the new
//      build-stamp.txt and load the new build within 2 s (no ⟳, no refresh button)
//   3. the Illustrator panel's dev install (ai/install_dev.cmd) when it isn't installed
// and what still needs a restart (a changed manifest) is said at the end.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHelper } from "./helper_build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
// no leading dot: a dot file made through the shared folder gets Windows' hidden attribute, and
// Node can't overwrite a hidden file (EPERM). The old name is still read once.
const STATE = "dist/update-state.json";
const OLD_STATE = "dist/.update-state.json";
const win = process.platform === "win32";

/** newest modification time under `paths` (files or folders), 0 if none */
function newest(paths) {
  let t = 0;
  const walk = p => {
    if (!existsSync(p)) return;
    const s = statSync(p);
    if (s.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); }
    else t = Math.max(t, s.mtimeMs);
  };
  for (const p of paths) walk(p);
  return t;
}
const hash = p => existsSync(p) ? createHash("sha1").update(readFileSync(p)).digest("hex") : "";
const step = (n, text) => console.log(`\n[${n}/4] ${text}`);
/** runs a .cmd with "nopause"; false when it failed */
function cmd(file) {
  const r = spawnSync("cmd.exe", ["/c", file, "nopause"], { stdio: "inherit" });
  if (r.status === 0) return true;
  // nothing printed above: say at least why (cmd.exe not started, killed, or its exit code)
  console.log(`  ${file} 结束：${r.error ? "没能运行（" + r.error.message + "）" : r.signal ? "被终止（" + r.signal + "）" : "退出码 " + r.status}`);
  console.log(`  看完整错误：直接双击 ${file}`);
  return false;
}

let state = {};
for (const f of [STATE, OLD_STATE]) { try { state = JSON.parse(readFileSync(f, "utf8")); break; } catch { /* first run */ } }
const notes = [];
let failed = false;

// 1. 最新代码
step(1, "从 GitHub 取最新代码");
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const remote = existsSync(".git") ? git("remote", "get-url", "origin") : null;
if (!remote || remote.status !== 0) console.log("  不是从 GitHub 克隆的文件夹，跳过");
else {
  const before = git("rev-parse", "HEAD").stdout.trim();
  // inherit: Git's sign-in window and its messages reach the user
  const r = spawnSync("git", ["pull", "--ff-only"], { stdio: "inherit" });
  if (r.error) console.log("  没找到 git：安装 Git for Windows（https://git-scm.com），跳过");
  else if (r.status !== 0) {
    failed = true;
    console.log("  [失败] 没取到最新代码（上面是 Git 的说明）：没登录 GitHub 时按弹出的窗口登录后再点一次；"
      + "本机改过的文件挡住了更新时，把它们发给 Claude 或先删掉。下面照旧用现有代码构建");
  } else {
    const after = git("rev-parse", "HEAD").stdout.trim();
    if (after === before) console.log("  已经是最新");
    else {
      console.log(`  [OK] 已更新到 ${after.slice(0, 7)}：${git("log", "-1", "--format=%s").stdout.trim()}`);
      if (git("diff", "--name-only", before, after, "--", "scripts/update.mjs").stdout.trim())
        notes.push("更新脚本本身也变了：再点一次「从源码更新」，用新脚本跑一遍");
    }
  }
}

// 2. 外置框架
step(2, "外置框架");
const exe = "dist/waveplug-overlay.exe";
const src = newest(["native/overlay/src", "native/overlay/Cargo.toml", "native/overlay/Cargo.lock"]);
const built = existsSync(exe) ? statSync(exe).mtimeMs : 0;
if (!win) console.log("  不是 Windows，跳过");
else if (src <= built) console.log("  没有改动，跳过");
else {
  console.log("  源码比 exe 新，重新编译（几分钟）…");
  if (!(await buildHelper(ROOT, t => console.log(t)))) { failed = true; console.log("  [失败] 外置框架没有编译成功：把上面的错误发给 Claude。插件照样继续构建"); }
}

// 3. 插件和 Illustrator 面板
step(3, "构建 Photoshop 插件和 Illustrator 面板");
try {
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("  [OK] 已构建：打开着的 WavePlug 面板和 WaveLayer 面板 2 秒内自动载入新版本");
} catch {
  failed = true;
  console.log("  [失败] 构建出错：把上面的错误发给 Claude");
}

// 4. Illustrator 面板的安装
step(4, "Illustrator 面板");
const appdata = process.env.APPDATA ?? "";
const installed = appdata && existsSync(join(appdata, "Adobe/CEP/extensions/com.waveplug.ai.wavelayer/CSXS/manifest.xml"));
if (!win) console.log("  不是 Windows，跳过");
else if (installed) console.log("  已安装");
else {
  console.log("  还没安装，正在安装…");
  if (cmd("ai\\install_dev.cmd")) notes.push("Illustrator 面板刚装上：完全退出 Illustrator 再打开，在 窗口 › 扩展功能 › WaveLayer 打开");
  else { failed = true; console.log("  [失败] 安装没成功"); }
}

// what a reload can't pick up
const now = { pluginManifest: hash("plugin/manifest.json"), aiManifest: hash("ai/CSXS/manifest.xml") };
if (state.pluginManifest && state.pluginManifest !== now.pluginManifest) notes.push("Photoshop 插件的 manifest 改了：需要重启 Photoshop（权限有变化时还要用 WavePlug 重新安装插件）");
if (state.aiManifest && state.aiManifest !== now.aiManifest && installed) notes.push("Illustrator 面板的 manifest 改了：需要重启 Illustrator");
if (!failed) {
  // only remembers what was built (for the "manifest changed" note): never fails the update
  try { writeFileSync(STATE, JSON.stringify(now, null, 2)); }
  catch (e) { console.log(`  （没能记下构建状态 ${STATE}：${e.message}；不影响使用）`); }
}

console.log("");
for (const n of notes) console.log("注意：" + n);
console.log(failed ? "有步骤失败，见上面的 [失败]。日志在 reports\\uxp_runtime.log。" : "全部完成。");
process.exitCode = failed ? 1 : 0;
