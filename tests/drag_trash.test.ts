import { test } from "node:test";
import assert from "node:assert/strict";
import { TRASH_DROP_MS, trashAction, trashDropTarget } from "../src/core/layers/dragTrash.ts";
import { parseOverlayEvent, TRASH_HELPER_VERSION, helperOutdated } from "../src/core/overlay/protocol.ts";

test("外置删除区：卡片文字说明松手删除什么", () => {
  assert.equal(trashAction(1), "松开删除图层");
  assert.equal(trashAction(3), "松开删除 3 个图层");
  assert.equal(trashAction(0, "mask"), "松开删除图层蒙版");
  assert.equal(trashAction(0, "effects"), "松开清除图层样式");
  assert.equal(trashAction(0, "filter"), "松开删除这个智能滤镜");
});

test("外置删除区：helper 的松手先到时删正在拖的，后到时删刚结束的那次（限时）", () => {
  const a = { id: "a", trash: true }, b = { id: "b", trash: true };
  assert.deepEqual(trashDropTarget(a, { drag: b, at: 0 }, 10), { drag: a, live: true });
  assert.deepEqual(trashDropTarget(null, { drag: b, at: 1000 }, 1500), { drag: b, live: false });
  assert.equal(trashDropTarget(null, { drag: b, at: 0 }, TRASH_DROP_MS), null);
  // a drag that never showed the square is never deleted by it
  assert.equal(trashDropTarget({ id: "c", trash: false }, null, 0), null);
  assert.equal(trashDropTarget(null, { drag: { id: "d", trash: false }, at: 0 }, 10), null);
});

test("外置删除区：协议事件和 helper 版本", () => {
  assert.deepEqual(parseOverlayEvent(JSON.stringify({ type: "layer-drag-trash-drop" })), { type: "layer-drag-trash-drop" });
  assert.equal(helperOutdated("0.11.0", TRASH_HELPER_VERSION), true);
  assert.equal(helperOutdated("0.12.0", TRASH_HELPER_VERSION), false);
});
