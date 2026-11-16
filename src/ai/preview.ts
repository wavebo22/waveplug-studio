// WaveLayer for Illustrator in a browser (dist/ai-preview): the real panel and host script against
// the model of Illustrator in fake.ts, and a pretend Photoshop on the other end of the bridge.

import { createHost } from "./host.ts";
import type { PsLink } from "./bridge.ts";
import { mountPanel } from "./panel.ts";
import { FakeDocument, FakeItem, FakeLayer, demoDocument, loadHost, openDocuments, rgb, written } from "./fake.ts";
// the host script's text (esbuild loader "text", scripts/build.mjs)
import source from "../../ai/host/wavelayer.jsx";

declare const __BUILT_AT__: string;

openDocuments(demoDocument(), new FakeDocument("名片.ai", [new FakeLayer("正面", [new FakeItem("TextFrame", { contents: "张三 · 设计师" }), new FakeItem("PathItem", { name: "底色", fillColor: rgb(240, 184, 64) })]), new FakeLayer("背面")], "D:\\设计\\名片.ai"));
const wl = loadHost(source as unknown as string);
const host = createHost({ evalScript: async code => {
  // the panel only ever calls WavePlugWL.call(op, args)
  await new Promise(r => setTimeout(r, 15));
  return new Function("WavePlugWL", `return ${code};`)(wl);
} });

let pushCb: ((push: any) => void) | null = null;
/** what Photoshop's 发送到 › Illustrator：当前画板全部 would send (call from the console) */
(window as any).psBoard = () => {
  for (const f of ["title.svg", "logo.ai", "photo.png"]) written.add("C:\\Temp\\" + f);
  pushCb?.({ docName: "海报.psd", ppi: 300, board: { name: "画板 1", width: 1200, height: 900 }, groups: { "5": { name: "标题组", hidden: false, opacity: 80, blend: "NORMAL" } },
    files: [
      { path: "C:\\Temp\\title.svg", name: "标题", left: 100, top: 80, width: 600, height: 120, how: "svg", group: ["5"] },
      { path: "C:\\Temp\\logo.ai", name: "Logo", left: 800, top: 60, width: 300, height: 300, how: "vector", group: ["5"], blend: "MULTIPLY" },
      { path: "C:\\Temp\\photo.png", name: "产品照片", left: 0, top: 300, width: 1200, height: 600, how: "png", opacity: 60, hidden: true },
    ] });
};
const pretendPs =new URLSearchParams(location.search).get("ps") !== "off";
const ps: PsLink = {
  get ready() { return pretendPs; },
  get helper() { return pretendPs; },
  get outdated() { return null; },
  onChange() { return () => undefined; },
  onPush(cb) { pushCb = cb; return () => { pushCb = null; }; },
  onAsk() { return () => undefined; },
  async request(msg: any) {
    await new Promise(r => setTimeout(r, 200));
    switch (msg.kind) {
      case "info": return { doc: { name: "海报.psd", ppi: 300, width: 2480, height: 3508 }, inbox: "C:\\Temp\\aibridge", links: [] } as any;
      case "place": case "update": return { docId: 1, layerId: 99, docName: "海报.psd" } as any;
      case "board": {
        const n = JSON.stringify(msg.nodes).split('"fileName"').length - 1;
        return { docName: msg.name, placed: n, failed: [] } as any;
      }
      case "pull":
        written.add("C:\\Temp\\ps_layer.png");
        return { docName: "海报.psd", ppi: 300, files: [{ path: "C:\\Temp\\ps_layer.png", name: "产品抠图", left: 400, top: 600, width: 1200, height: 900 }] } as any;
      case "get-color": return { hex: "#e05a3c" } as any;
      case "set-color": return { hex: msg.hex } as any;
    }
    throw new Error("unknown");
  },
};

(window as any).wl = mountPanel(document.getElementById("app")!, { host, ps, version: `0.1.0 · 预览 · ${__BUILT_AT__}` });
