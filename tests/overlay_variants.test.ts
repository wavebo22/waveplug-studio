import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseVariantsAction } from "../src/core/overlay/variantsPanel.ts";

test("native variants only accept a valid existing variation selection", () => {
  assert.deepEqual(parseVariantsAction({kind:"show-variant",groupId:17,layerId:38}),
    {kind:"show-variant",groupId:17,layerId:38});
  assert.equal(parseVariantsAction({kind:"show-variant",groupId:17,layerId:-1}), null);
  assert.equal(parseVariantsAction({kind:"show-variant",groupId:17,layerId:4.3}), null);
  assert.equal(parseVariantsAction({kind:"show-variant",groupId:0,layerId:3}), null);
  assert.equal(parseVariantsAction({kind:"delete",groupId:17,layerId:38}), null);
});
