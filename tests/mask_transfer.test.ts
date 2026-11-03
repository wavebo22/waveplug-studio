import { test } from "node:test";
import assert from "node:assert/strict";
import { maskTransferDescriptors } from "../src/ps/maskTransfer.ts";

test("图层蒙版：先建立目标通道，再按原 ID 删除源通道", () => {
  const d = maskTransferDescriptors("mask", 19, 101, 202);
  assert.deepEqual(d.copy, {
    _obj: "make", new: { _class: "channel" },
    using: { _ref: [
      { _ref: "channel", _enum: "channel", _value: "mask" },
      { _ref: "layer", _id: 101 }, { _ref: "document", _id: 19 },
    ] },
    duplicate: true,
    at: { _ref: [
      { _ref: "channel", _enum: "channel", _value: "mask" },
      { _ref: "layer", _id: 202 }, { _ref: "document", _id: 19 },
    ] },
  });
  assert.deepEqual(d.removeSource, {
    _obj: "delete", _target: [
      { _ref: "channel", _enum: "channel", _value: "mask" },
      { _ref: "layer", _id: 101 }, { _ref: "document", _id: 19 },
    ],
  });
});

test("矢量蒙版与智能滤镜蒙版：保留类型和源、目标图层 ID", () => {
  for (const [kind, ref, part] of [
    ["vmask", "path", "vectorMask"],
    ["filterMask", "channel", "filterMask"],
  ] as const) {
    const d = maskTransferDescriptors(kind, 7, 5, 9);
    assert.equal(d.copy.new._class, ref);
    assert.equal(d.copy.using._ref[0]._value, part);
    assert.deepEqual(d.copy.using._ref[1], { _ref: "layer", _id: 5 });
    assert.deepEqual(d.copy.at._ref[1], { _ref: "layer", _id: 9 });
    assert.equal(d.removeSource._target[0]._value, part);
    assert.deepEqual(d.removeSource._target[1], { _ref: "layer", _id: 5 });
  }
});
