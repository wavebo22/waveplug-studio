// 生成安装包 (release.cmd runs this): build the plugin and the Illustrator panel, compile the
// WavePlug program and the installer (native\overlay\build.cmd), pack
// releases\WavePlug_Setup_<version>.exe and latest.json. Every line also goes to
// reports\release.log, so a window that closed still leaves what happened.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildHelper, spawnRun } from "./helper_build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
mkdirSync("reports", { recursive: true });
const LOG = "reports/release.log";
writeFileSync(LOG, `release ${new Date().toISOString()}\n`);
const say = text => { console.log(text); try { appendFileSync(LOG, text + "\n"); } catch { /* still shown */ } };

const pass = chunk => { process.stdout.write(chunk); try { appendFileSync(LOG, chunk); } catch { /* ignore */ } };
/** runs a program in `cwd`, its output shown and logged; resolves to the exit code */
const run = (program, args, cwd = ROOT) => spawnRun(program, args, cwd, pass);

const win = process.platform === "win32";
const steps = [
  ["[1/3] 构建 Photoshop 插件和 Illustrator 面板", process.execPath, ["scripts/build.mjs"]],
  ["[2/3] 编译 WavePlug 程序和安装程序（Rust，第一次要几分钟）", "helper", []],
  ["[3/3] 打包", process.execPath, ["scripts/package_setup.mjs"]],
];
for (const [title, program, args] of steps) {
  say("\n" + title);
  const code = program === "helper"
    ? (win ? ((await buildHelper(ROOT, say, run)) ? 0 : 1) : (say("  只能在 Windows 上编译"), 1))
    : await run(program, args);
  if (code !== 0) {
    say(`\n[失败] ${title.replace(/^\[\d\/\d\] /, "")} 没有完成（退出码 ${code}）。`);
    say(`把上面的内容截图发给 Claude，或者把 ${ROOT}reports\\release.log 发过去。`);
    process.exit(1);
  }
}
say("\n[完成] 安装包在 releases 文件夹里：WavePlug_Setup_版本.exe");
