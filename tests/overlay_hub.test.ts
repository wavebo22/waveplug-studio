import { test } from "node:test";
import assert from "node:assert/strict";
import { createHub } from "../src/core/overlay/hub.ts";
import type { OverlayCommand } from "../src/core/overlay/protocol.ts";

function setup() {
  const sent: OverlayCommand[] = [];
  const hub = createHub(m => sent.push(m));
  const state = { text: "a", n: 1 };
  const got: string[] = [];
  let viewRequests = 0;
  hub.register({
    id: "demo",
    sections: () => ({ ...state }),
    parseAction: (raw: any) => (typeof raw?.say === "string" ? raw.say as string : null),
    onAction: a => got.push(a),
    onViewRequest: () => { viewRequests++; },
  });
  return { sent, hub, state, got, views: () => viewRequests };
}

test("外附介面：只发变化的区块，版本号递增", () => {
  const { sent, hub, state } = setup();
  hub.sync();
  hub.sync();
  state.n = 2;
  hub.sync();
  assert.deepEqual(sent, [
    { type: "state", panel: "demo", rev: 1, sections: { text: "a", n: 1 } },
    { type: "state", panel: "demo", rev: 2, sections: { n: 2 } },
  ]);
});

test("外附介面：显示前先送状态，隐藏只发一次", () => {
  const { sent, hub } = setup();
  hub.show("demo", { left: 0, top: 0, right: 10, bottom: 10 });
  hub.hide("demo");
  hub.hide("demo");
  assert.deepEqual(sent.map(m => m.type), ["state", "show", "hide"]);
  assert.equal(hub.isShown("demo"), false);
});

test("外附介面：重连后全部重发并恢复显示", () => {
  const { sent, hub } = setup();
  const view = { left: 1, top: 2, right: 3, bottom: 4 };
  hub.show("demo", view);
  sent.length = 0;
  hub.connected();
  assert.deepEqual(sent, [
    { type: "hello" },
    { type: "state", panel: "demo", rev: 2, sections: { text: "a", n: 1 } },
    { type: "show", panel: "demo", view },
  ]);
});

test("外附介面：操作交给对应介面，格式不对的丢掉", () => {
  const { hub, got, views } = setup();
  hub.receive({ type: "action", panel: "demo", action: { say: "hi" } });
  hub.receive({ type: "action", panel: "demo", action: { say: 3 } });
  hub.receive({ type: "action", panel: "other", action: { say: "x" } });
  hub.receive({ type: "view-request", panel: "demo" }); // not shown: ignored
  hub.show("demo", null);
  hub.receive({ type: "view-request", panel: "demo" });
  assert.deepEqual(got, ["hi"]);
  assert.equal(views(), 1);
});

test("外附介面：提醒沿用介面最后的位置", () => {
  const { sent, hub } = setup();
  const view = { left: 0, top: 0, right: 800, bottom: 600 };
  hub.show("demo", view);
  hub.hide("demo");
  assert.deepEqual(hub.viewOf("demo"), view);
  sent.length = 0;
  hub.toast("图片生成完毕", "变体 3", hub.viewOf("demo"));
  assert.deepEqual(sent, [{ type: "toast", title: "图片生成完毕", text: "变体 3", view, ms: 8000 }]);
});
