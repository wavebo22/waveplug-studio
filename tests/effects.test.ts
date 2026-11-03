import { test } from "node:test";
import assert from "node:assert/strict";
import { addEffect, effectItem, hasEffects, removeEffect } from "../src/core/layers/effects.ts";
import { effectsOf } from "../src/core/layers/tree.ts";

const shadow = (d: number) => ({ _obj: "dropShadow", enabled: true, present: true, distance: d });
const style = () => ({
  _obj: "layerEffects", scale: { _unit: "percentUnit", _value: 100 },
  dropShadowMulti: [shadow(5), shadow(9)], dropShadow: shadow(5),
  bevelEmboss: { _obj: "bevelEmboss", enabled: false, present: true },
});

test("图层样式: one effect taken from a style, the source untouched", () => {
  const fx = style();
  assert.equal(effectItem(fx, "dropShadow", 1)?.distance, 9);
  assert.equal(effectItem(fx, "bevelEmboss", -1)?.enabled, false);
  assert.equal(effectItem(fx, "outerGlow", -1), undefined);
  effectItem(fx, "dropShadow", 1)!.distance = 1;
  assert.equal(fx.dropShadowMulti[1].distance, 9);
});

test("图层样式: removing an effect keeps the rest, nothing left is null", () => {
  const a = removeEffect(style(), "dropShadow", 0)!;
  assert.deepEqual(a.dropShadowMulti.map((x: any) => x.distance), [9]);
  assert.equal(a.dropShadow.distance, 9);
  const b = removeEffect(removeEffect(a, "dropShadow", 0)!, "bevelEmboss", -1);
  assert.equal(b, null);
  assert.deepEqual(effectsOf(removeEffect(style(), "bevelEmboss", -1)!).map(e => [e.key, e.multi]), [["dropShadow", 0], ["dropShadow", 1]]);
});

test("图层样式: adding an effect — repeatable ones stack on top, single ones replace, a bare layer gets a style", () => {
  const two = addEffect(style(), "dropShadow", shadow(20));
  assert.deepEqual(two.dropShadowMulti.map((x: any) => x.distance), [20, 5, 9]);
  assert.equal(two.dropShadow.distance, 20);
  const bev = addEffect(style(), "bevelEmboss", { _obj: "bevelEmboss", enabled: false, present: true, depth: 3 });
  assert.equal(bev.bevelEmboss.depth, 3);
  assert.equal(bev.bevelEmboss.enabled, true);
  const bare = addEffect(undefined, "frameFX", { _obj: "frameFX", size: 2 });
  assert.equal(bare._obj, "layerEffects");
  assert.deepEqual(effectsOf(bare).map(e => [e.key, e.multi]), [["frameFX", 0]]);
  assert.equal(hasEffects(bare), true);
  assert.equal(hasEffects({ _obj: "layerEffects", scale: {} }), false);
});
