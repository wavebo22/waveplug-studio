// "Repaint only inside the selection": some inpaint workflows crop around the mask and let an
// edit model redraw the whole crop, using the mask only when pasting back. If the encoder has an
// unconnected MASK input and the node feeding its image also outputs the matching (cropped,
// resized) mask, linking the two makes the sampler change only the masked area.
// The link is added to the execution copy only; the saved workflow is never modified.

import { type ApiGraph, type Link, isLink } from "./api.ts";
import type { ObjectInfo } from "./uiToApi.ts";

export interface MaskLink { nodeId: string; input: string; from: Link }

function inputType(info: ObjectInfo, cls: string, name: string): unknown {
  const d = info[cls]?.input;
  return (d?.required?.[name] ?? d?.optional?.[name])?.[0];
}

export function findLocalMaskLinks(api: ApiGraph, info: ObjectInfo): MaskLink[] {
  const out: MaskLink[] = [];
  for (const [id, node] of Object.entries(api)) {
    const def = info[node.class_type]?.input;
    if (!def) continue;
    // only nodes that feed sampling (encoders/conditioning), not resize/crop helpers
    if (!(info[node.class_type].output ?? []).some(t => t === "LATENT" || t === "CONDITIONING")) continue;
    const names = [...Object.keys(def.required ?? {}), ...Object.keys(def.optional ?? {})];
    const maskInput = names.find(n => inputType(info, node.class_type, n) === "MASK" && !isLink(node.inputs[n]));
    if (!maskInput) continue;
    // the first linked IMAGE input is the picture the mask has to line up with
    const imageInput = names.find(n => inputType(info, node.class_type, n) === "IMAGE" && isLink(node.inputs[n]));
    if (!imageInput) continue;
    const [srcId, srcSlot] = node.inputs[imageInput] as Link;
    const outputs = info[api[srcId]?.class_type]?.output ?? [];
    if (outputs[srcSlot] !== "IMAGE") continue;
    const maskSlot = outputs.indexOf("MASK");
    if (maskSlot < 0) continue;
    out.push({ nodeId: id, input: maskInput, from: [srcId, maskSlot] });
  }
  return out;
}

export function applyMaskLinks(api: ApiGraph, links: MaskLink[]) {
  for (const l of links) {
    const n = api[l.nodeId];
    if (!n || !api[l.from[0]] || isLink(n.inputs[l.input])) continue;
    n.inputs[l.input] = l.from;
  }
}
