import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseVariantsAction } from "../src/core/overlay/variantsPanel.ts";

test("native variants only accept a valid existing variation selection", () => {
  assert.deepEqual(parseVariantsAction({kind:"show-variant",groupId:17,layerId:38}),
    {kind:"show-variant",groupId:17,layerId:38});
  assert.equal(parseVariantsAction({kind:"show-variant",groupId:17,layerId:-1}), null);
  // 变体栏缩略图角落的删除按钮
  assert.deepEqual(parseVariantsAction({kind:"delete-variant",groupId:17,layerId:38}),
    {kind:"delete-variant",groupId:17,layerId:38});
  assert.equal(parseVariantsAction({kind:"delete-variant",groupId:0,layerId:38}), null);
  assert.equal(parseVariantsAction({kind:"remove",groupId:17,layerId:38}), null);
  assert.equal(parseVariantsAction({kind:"show-variant",groupId:17,layerId:4.3}), null);
  assert.equal(parseVariantsAction({kind:"show-variant",groupId:0,layerId:3}), null);
  assert.equal(parseVariantsAction({kind:"delete",groupId:17,layerId:38}), null);
});
