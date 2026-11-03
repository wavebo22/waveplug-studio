// 图层样式 as Photoshop describes them (a layer's `layerEffects`): one effect taken out, put on another
// layer, or removed — what dragging an effect in the Layers panel does (move; Alt: copy). Effects that
// Photoshop allows more than once (投影, 内阴影, 描边, 颜色叠加, 渐变叠加) are kept in `<key>Multi`
// lists with the first one also as `<key>`; the others are single.

/** effects that can be applied more than once in one layer style */
export const MULTI_EFFECTS = new Set(["dropShadow", "innerShadow", "frameFX", "solidFill", "gradientFill"]);

type Fx = Record<string, any>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** One effect (`multi` -1: a single one, else its place in `<key>Multi`), copied; undefined when it isn't there. */
export function effectItem(fx: Fx | undefined, key: string, multi: number): Fx | undefined {
  const list = fx?.[key + "Multi"];
  const one = Array.isArray(list) ? list[Math.max(0, multi)] : fx?.[key];
  return one ? clone(one) : undefined;
}

/** The style without that effect; null when no effect would be left (clear the style instead). */
export function removeEffect(fx: Fx, key: string, multi: number): Fx | null {
  const out = clone(fx), list = out[key + "Multi"];
  if (Array.isArray(list)) {
    list.splice(Math.max(0, multi), 1);
    if (list.length) out[key] = list[0];
    else { delete out[key + "Multi"]; delete out[key]; }
  } else delete out[key];
  return hasEffects(out) ? out : null;
}

/** The style with `item` added as effect `key`: another instance of a repeatable effect (on top, as a
 *  new one is in Photoshop), or in place of a single one. `fx` undefined: a layer without a style. */
export function addEffect(fx: Fx | undefined, key: string, item: Fx): Fx {
  const out: Fx = fx ? clone(fx) : { _obj: "layerEffects", scale: { _unit: "percentUnit", _value: 100 } };
  const it = { ...clone(item), enabled: true, present: true };
  if (MULTI_EFFECTS.has(key)) {
    const was = Array.isArray(out[key + "Multi"]) ? out[key + "Multi"] : out[key] ? [out[key]] : [];
    out[key + "Multi"] = [it, ...was];
    out[key] = it;
  } else {
    delete out[key + "Multi"];
    out[key] = it;
  }
  return out;
}

/** whether a style descriptor still holds any effect */
export function hasEffects(fx: Fx | undefined): boolean {
  if (!fx) return false;
  return Object.entries(fx).some(([k, v]) => k !== "_obj" && k !== "scale" && k !== "masterFXSwitch" && (Array.isArray(v) ? v.length > 0 : !!v && typeof v === "object" && v.present !== false));
}
