import { test } from "node:test";
import assert from "node:assert/strict";
import { CORNER_IDLE, type Claim, cornerStep, cornerWinner } from "../src/core/overlay/corner.ts";

const gen = (wanted: boolean, docId: number | null = 1): Claim => ({ id: "generate", priority: 10, wish: { docId, wanted } });
const setup = (wanted: boolean, docId: number | null = 1): Claim => ({ id: "check-setup", priority: 20, wish: { docId, wanted } });
const D = 450;

test("角落面板：没有文档、没人要时什么都不显示；有选区时显示生图面板", () => {
  assert.deepEqual(cornerStep(CORNER_IDLE, [gen(false), setup(false)], 0, D).actions, []);
  assert.deepEqual(cornerStep(CORNER_IDLE, [gen(true, null)], 0, D).actions, []);
  const v = cornerStep(CORNER_IDLE, [gen(true), setup(false)], 0, D);
  assert.deepEqual(v.actions, [{ do: "show", id: "generate", docId: 1, replaces: null }]);
  assert.equal(v.state.current, "generate");
  // still wanted: nothing more to do
  assert.deepEqual(cornerStep(v.state, [gen(true)], 10, D).actions, []);
});

test("打开设置面板时它优先，盖过生图面板（先显示新的再隐藏旧的）；关掉后生图面板回来", () => {
  const up = cornerStep(CORNER_IDLE, [gen(true)], 0, D).state;
  const s = cornerStep(up, [gen(true), setup(true)], 5, D);
  assert.deepEqual(s.actions, [{ do: "show", id: "check-setup", docId: 1, replaces: "generate" }]);
  const back = cornerStep(s.state, [gen(true), setup(false)], 10, D);
  assert.deepEqual(back.actions, [{ do: "show", id: "generate", docId: 1, replaces: "check-setup" }]);
  // the settings closed and there is no selection: it goes after the delay, nothing replaces it
  const gone = cornerStep(s.state, [gen(false), setup(false)], 10, D);
  assert.deepEqual(gone.actions, []);
  assert.equal(gone.againInMs, D);
  assert.deepEqual(cornerStep(gone.state, [gen(false), setup(false)], 10 + D, D).actions, [{ do: "hide", id: "check-setup" }]);
});

test("选区闪一下没了不会让生图面板消失；没有文档时立刻消失", () => {
  const up = cornerStep(CORNER_IDLE, [gen(true)], 0, D).state;
  const blink = cornerStep(up, [gen(false)], 100, D);
  assert.deepEqual(blink.actions, []);
  assert.deepEqual(cornerStep(blink.state, [gen(true)], 200, D).actions, []);
  assert.deepEqual(cornerStep(up, [gen(false, null)], 100, D).actions, [{ do: "hide", id: "generate" }]);
});

test("同优先级时已经显示的那个留着；只认当前文档的", () => {
  const a: Claim = { id: "a", priority: 20, wish: { docId: 1, wanted: true } }, b: Claim = { id: "b", priority: 20, wish: { docId: 1, wanted: true } };
  assert.equal(cornerWinner([a, b], "b")?.id, "b");
  assert.equal(cornerWinner([a, b], null)?.id, "a");
  assert.equal(cornerWinner([{ ...a, wish: { docId: null, wanted: true } }], null), null);
});
