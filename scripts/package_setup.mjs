// 生成安装包: releases/WavePlug_Setup_<version>.exe = the installer (native/overlay, bin
// waveplug-setup) with everything it installs appended (format: native/overlay/src/setup/payload.rs):
// WavePlug.exe (the app, which is also the helper), the Photoshop plugin as a .ccx, the Illustrator
// panel's files; and releases/latest.json for the update address.
// Run by release.cmd after npm run build and native\overlay\build.cmd.
//   node scripts/package_setup.mjs [path\to\waveplug-setup.exe]
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);

const fail = msg => { console.error("打包失败：" + msg); process.exit(1); };
const files = dir => {
  const out = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.push(p); } };
  walk(dir);
  return out.sort();
};

const plugin = JSON.parse(readFileSync("plugin/manifest.json", "utf8"));
const aiVersion = /ExtensionBundleVersion="([^"]+)"/.exec(readFileSync("ai/CSXS/manifest.xml", "utf8"))?.[1] ?? "?";
const helperVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("native/overlay/Cargo.toml", "utf8"))?.[1] ?? "?";
const exe = process.argv[2] ?? "native/overlay/target/release/waveplug-setup.exe";

if (!existsSync("dist/plugin/index.js")) fail("没有 dist/plugin：先 npm run build");
if (!existsSync("dist/ai/CSXS/manifest.xml")) fail("没有 dist/ai：先 npm run build");
if (!existsSync("dist/plugin/waveplug-overlay.exe")) fail("dist/plugin 里没有外置框架 waveplug-overlay.exe：先运行 native\\overlay\\build.cmd");
if (!existsSync(exe)) fail(`没有 ${exe}：先运行 native\\overlay\\build.cmd（会一起编译 WavePlug 设置）`);

// ── the Photoshop plugin as a .ccx (a zip with manifest.json at its root) ──
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8"), packed = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, packed);
    centrals.push(central, n);
    offset += local.length + n.length + packed.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const skip = p => /build-stamp\.txt$|\.old-.*\.exe$|(^|[\\/])\.debug$/i.test(p);
const ccx = zip(files("dist/plugin").filter(p => !skip(p)).map(p => ({ name: relative("dist/plugin", p).split(/[\\/]/).join("/"), data: readFileSync(p) })));

// ── the archive ──
const built = new Date().toISOString().slice(0, 16).replace("T", " ");
const entries = [
  ["payload.json", Buffer.from(JSON.stringify({ version: plugin.version, ai_version: aiVersion, helper_version: helperVersion, built }))],
  ["WavePlug.ccx", ccx],
  // the app the installer puts in the chosen folder: the same exe as the plugin's helper
  ["WavePlug.exe", readFileSync("dist/plugin/waveplug-overlay.exe")],
  // the panel ships without .debug (remote debugging); build-stamp.txt makes an open panel reload
  ...files("dist/ai").filter(p => !/(^|[\\/])\.debug$/.test(p)).map(p => ["ai/" + relative("dist/ai", p).split(/[\\/]/).join("/"), readFileSync(p)]),
];
const parts = [Buffer.from("WPPK1\n")];
for (const [name, data] of entries) {
  const n = Buffer.from(name, "utf8"), nl = Buffer.alloc(4), dl = Buffer.alloc(8);
  nl.writeUInt32LE(n.length);
  dl.writeBigUInt64LE(BigInt(data.length));
  parts.push(nl, n, dl, data);
}
const archive = Buffer.concat(parts), tail = Buffer.alloc(8);
tail.writeBigUInt64LE(BigInt(archive.length));

mkdirSync("releases", { recursive: true });
const name = `WavePlug_Setup_${plugin.version}.exe`;
const out = join("releases", name);
writeFileSync(out, Buffer.concat([readFileSync(exe), archive, tail, Buffer.from("WAVEPLUG-PAYLOAD")]));
// for the update address: upload both, the url is relative to latest.json
writeFileSync(join("releases", "latest.json"), JSON.stringify({ version: plugin.version, url: name, notes: "" }, null, 2) + "\n");
const mb = n => (n / 1048576).toFixed(1) + " MB";
console.log(`已生成 ${out}（${mb(statSync(out).size)}：WavePlug 程序 ${helperVersion}、Photoshop 插件 ${plugin.version}、Illustrator 面板 ${aiVersion}）`);
console.log("分享这一个 exe 就行。用更新地址的话，把它和 releases\\latest.json 放到同一个网址或共享文件夹。");
