// Reference images for workflows that don't have their own reference loaders.
// Qwen-Image encoders (e.g. 孤海 TextEncodeQwenImage21GH: image_01 … image_10) take several
// pictures; the workflow wires only image_01 (the canvas). For each reference the user adds, a
// LoadImage node is added to the *execution copy* and linked to the encoder's next free image
// input, so the prompt can say "把选区里的杯子换成图2中的饮料". The saved workflow is not changed
// and nothing is added when no reference is given.

import { type ApiGraph, isLink } from "./api.ts";
import type { ObjectInfo } from "./uiToApi.ts";

export interface ReferenceSlots {
  /** encoder node id → its free IMAGE inputs, in order (image_02, image_03, …) */
  nodes: { nodeId: string; inputs: string[] }[];
}

export const MAX_REFERENCES = 2;

export function findReferenceSlots(api: ApiGraph, info: ObjectInfo): ReferenceSlots | null {
  const nodes: ReferenceSlots["nodes"] = [];
  for (const [id, node] of Object.entries(api)) {
    const def = info[node.class_type];
    if (!def || !(def.output ?? []).includes("CONDITIONING")) continue;
    const imageInputs = [...Object.entries(def.input.required ?? {}), ...Object.entries(def.input.optional ?? {})]
      .filter(([, spec]) => spec?.[0] === "IMAGE").map(([name]) => name);
    const linked = imageInputs.filter(n => isLink(node.inputs[n]));
    if (!linked.length) continue; // only encoders that already receive the canvas
    const lastLinked = imageInputs.indexOf(linked[linked.length - 1]);
    const free = imageInputs.slice(lastLinked + 1).filter(n => !isLink(node.inputs[n]));
    if (free.length) nodes.push({ nodeId: id, inputs: free });
  }
  return nodes.length ? { nodes } : null;
}

/**
 * Adds one LoadImage per uploaded reference and links it into every detected encoder.
 * `variant` changes the added node ids, so each variation gets its own (uncached) reference
 * encoding — with cached conditioning only the first of several variations followed the reference.
 */
export function applyReferences(api: ApiGraph, slots: ReferenceSlots, files: string[], variant = 0) {
  let next = Math.max(0, ...Object.keys(api).map(Number).filter(Number.isFinite)) + 1000 + variant * 10;
  files.forEach((file, i) => {
    const id = String(next++);
    api[id] = { class_type: "LoadImage", inputs: { image: file, upload: "image" }, _meta: { title: `WavePlug 参考图 ${i + 1}` } };
    for (const s of slots.nodes) {
      const input = s.inputs[i];
      if (input && api[s.nodeId] && !isLink(api[s.nodeId].inputs[input])) api[s.nodeId].inputs[input] = [id, 0];
    }
  });
}
