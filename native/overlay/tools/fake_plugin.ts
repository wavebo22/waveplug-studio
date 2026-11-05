// Stands in for the plugin, to try the helper without Photoshop: the real hub (src/core/overlay),
// a made-up generate page. Prints what the helper sends back. Run the helper first, then:
//   node native/overlay/tools/fake_plugin.ts
// With WAVEPLUG_HOST_SHOT=<file.bmp> set for the helper, it saves a picture of the panel and quits.
import { createHub } from "../../../src/core/overlay/hub.ts";
import { parseOverlayEvent } from "../../../src/core/overlay/protocol.ts";
import { type GenerateSections, parseGenerateAction } from "../../../src/core/overlay/generatePanel.ts";

const state: GenerateSections = {
  mode: "extract", prompt: "白色运动鞋", hint: "可选：要抠的东西，例如 护肤品、红色价格牌；留空 = 抠选区里的主体",
  favorites: ["白色运动鞋", "红色价格牌", "透明玻璃瓶"], refs: [], count: 3, action: "抠图", blocked: null,
  params: [
    { kind: "number", key: "7.strength", label: "边缘柔和", value: 0.6, base: 0.4, min: 0, max: 2, int: false },
    { kind: "seed", random: false, value: 123456 },
    { kind: "toggle", key: "keepDetail", label: "保留原图细节", value: true, tip: "" },
    { kind: "toggle", key: "fullRun", label: "每次完整运行（不使用 ComfyUI 缓存，较慢）", value: false, tip: "" },
  ],
  run: { stage: "生成中 · 2/3", progress: 0.62 }, status: { tone: "info", text: "抠图中…" },
};
const ws = new WebSocket("ws://127.0.0.1:47821");
const hub = createHub(m => ws.send(JSON.stringify(m)));
hub.register({ id: "generate", sections: () => state, parseAction: parseGenerateAction, onAction: a => console.log("ACTION", JSON.stringify(a)) });
ws.onopen = () => {
  hub.connected();
  hub.show("generate", { left: 0, top: 0, right: 1600, bottom: 1000 });
  hub.toast("图片生成完毕", "已加入 AI 结果 · 变体 3", null, 6000);
  console.log("SENT state + show + toast");
  // an older revision must be dropped by the helper
  ws.send(JSON.stringify({ type: "state", panel: "generate", rev: 1, sections: { prompt: "旧的不该出现" } }));
};
ws.onmessage = e => console.log("GOT", String(e.data), JSON.stringify(parseOverlayEvent(String(e.data))));
ws.onclose = () => { console.log("CLOSED"); process.exit(0); };
setTimeout(() => process.exit(0), 15000);
