import { test } from "node:test";
import assert from "node:assert/strict";
import { clickPair } from "../src/ui/popupMenu.ts";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("链接状态单击仅选择同源一次", async () => {
  const executed: string[] = [];
  const action = clickPair(() => executed.push("selectSameSource"), () => executed.push("makeUnique"), 12);
  action.press();
  assert.deepEqual(executed, []); // do not fire while waiting for a potential second click
  await delay(28);
  assert.deepEqual(executed, ["selectSameSource"]);
  action.cancel();
});

test("快速双击只断开共享，不先选中其他同源", async () => {
  const executed: string[] = [];
  const action = clickPair(() => executed.push("selectSameSource"), () => executed.push("makeUnique"), 22);
  action.press();
  action.press();
  assert.deepEqual(executed, ["makeUnique"]);
  await delay(35);
  assert.deepEqual(executed, ["makeUnique"]);
  action.cancel();
});

test("关闭菜单取消待执行的单击", async () => {
  const executed: string[] = [];
  const action = clickPair(() => executed.push("selectSameSource"), () => executed.push("makeUnique"), 12);
  action.press();
  action.cancel();
  await delay(26);
  assert.deepEqual(executed, []);
});

test("UXP click + dblclick 事件序列只执行断开共享一次", async () => {
  const executed: string[] = [];
  const action = clickPair(() => executed.push("selectSameSource"), () => executed.push("makeUnique"), 28);
  action.press();
  action.doublePress();
  await delay(40);
  assert.deepEqual(executed, ["makeUnique"]);
  action.cancel();
});

test("UXP click + click + dblclick 事件序列不会重复执行断开共享", async () => {
  const executed: string[] = [];
  const action = clickPair(() => executed.push("selectSameSource"), () => executed.push("makeUnique"), 28);
  action.press();
  action.press();
  action.doublePress();
  await delay(40);
  assert.deepEqual(executed, ["makeUnique"]);
  action.cancel();
});

test("仅发出 dblclick 时也能断开共享，后续 click 不应再误选同源", async () => {
  const executed: string[] = [];
  const action = clickPair(() => executed.push("selectSameSource"), () => executed.push("makeUnique"), 12);
  action.doublePress();
  action.press();
  await delay(28);
  assert.deepEqual(executed, ["makeUnique"]);
});
