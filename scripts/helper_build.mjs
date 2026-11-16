// Compiles the WavePlug program (native/overlay: waveplug-overlay.exe, which is also WavePlug.exe,
// and the installer waveplug-setup.exe) with cargo directly and puts the program where the
// plugin and update.cmd expect it: dist\, dist\plugin\, and the installed WavePlug.exe when
// WavePlug is installed (so the one program on this computer is the newest). Used by release.mjs and
// update.mjs instead of native\overlay\build.cmd, which died silently (exit 255, no output) when
// another program started it.
//
// A running copy isn't stopped: its exe is renamed to waveplug-overlay.old-*.exe (Windows allows
// that) and the new one copied in; the running one notices and restarts into it (src/life.rs).
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** `run(program, args, cwd)` → exit code; `say(text)` a line. Resolves to true when it worked. */
export async function buildHelper(root, say, run = spawnRun) {
  const dir = join(root, "native", "overlay");
  const code = await run("cargo", ["build", "--release"], dir);
  if (code !== 0) {
    say(code === -1 ? "  没找到 cargo：先安装 Rust（https://rustup.rs），装完重新打开命令行" : `  cargo 编译失败（退出码 ${code}）：错误在上面`);
    return false;
  }
  const built = join(dir, "target", "release", "waveplug-overlay.exe");
  if (!existsSync(built)) { say(`  编译完了却没有 ${built}`); return false; }
  const targets = ["dist", join("dist", "plugin")].map(d => join(root, d, "waveplug-overlay.exe"));
  const installed = installedDir();
  if (installed) targets.push(join(installed, "WavePlug.exe"));
  for (const target of targets) {
    const to = dirname(target);
    try {
      mkdirSync(to, { recursive: true });
      if (existsSync(target)) renameSync(target, target.replace(/\.exe$/i, `.old-${Date.now()}${Math.floor(Math.random() * 1000)}.exe`));
      copyFileSync(built, target);
    } catch (e) {
      say(`  放不进 ${to}：${e.message}`);
      return false;
    }
  }
  say(`  [OK] WavePlug 程序已放进 dist、dist\\plugin${installed ? "和 " + installed : ""}；正在运行的会自动换成新版本`);
  return true;
}

/** The installed WavePlug folder (HKCU\\Software\\WavePlug InstallDir, with its marker file), or null. */
export function installedDir() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\WavePlug", "/v", "InstallDir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /InstallDir\s+REG_\w+\s+(.+)/i.exec(out);
    const dir = m?.[1].trim();
    return dir && existsSync(join(dir, "WavePlug.installed")) ? dir : null;
  } catch { return null; }
}

/** runs a program with its output passed through; -1 when it couldn't start */
export function spawnRun(program, args, cwd, onData = chunk => process.stdout.write(chunk)) {
  return new Promise(resolve => {
    const child = spawn(program, args, { cwd, shell: false });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => resolve(-1));
    child.on("close", code => resolve(code ?? -1));
  });
}
