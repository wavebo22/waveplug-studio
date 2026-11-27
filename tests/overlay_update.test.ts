import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOverlayEvent } from "../src/core/overlay/protocol.ts";

test("更新提醒：ready 带上更新文件夹和安装的程序；找到新版本、更新进度逐个检查", () => {
  assert.deepEqual(parseOverlayEvent('{"type":"ready","version":"0.37.0","liveRoot":"C:/W/data/plugin-live/","appExe":"C:\\\\W\\\\WavePlug.exe"}'),
    { type: "ready", version: "0.37.0", liveRoot: "C:/W/data/plugin-live/", appExe: "C:\\W\\WavePlug.exe" });
  assert.deepEqual(parseOverlayEvent('{"type":"ready","version":"0.2.0"}'), { type: "ready", version: "0.2.0" });
  assert.deepEqual(parseOverlayEvent('{"type":"update-available","version":"1.4.0","notes":"新功能","dev":false}'), { type: "update-available", version: "1.4.0", notes: "新功能", dev: false });
  assert.deepEqual(parseOverlayEvent('{"type":"update-progress","text":"正在下载 1.4.0…","done":false,"ok":false}'), { type: "update-progress", text: "正在下载 1.4.0…", done: false, ok: false });
  assert.equal(parseOverlayEvent('{"type":"update-available"}'), null);
});
