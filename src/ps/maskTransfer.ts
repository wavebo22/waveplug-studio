// Photoshop Action Manager descriptors for copying a mask between layers.
 // The channel form is the UXP equivalent of make(channel, using: source mask, duplicate:true,
 // at: destination mask). Vector masks use the same operation with a path reference.
 // Kept pure so that targets can be tested without opening or mutating a user's PSD.

export type MaskKind = "mask" | "vmask" | "filterMask";

const atLayer = (docId: number, id: number) => [{ _ref: "layer", _id: id }, { _ref: "document", _id: docId }];

export function maskTransferDescriptors(kind: MaskKind, docId: number, srcId: number, dstId: number) {
  const vector = kind === "vmask";
  const part = vector
    ? { _ref: "path", _enum: "path", _value: "vectorMask" }
    : { _ref: "channel", _enum: "channel", _value: kind };
  const source = [part, ...atLayer(docId, srcId)];
  const dest = [part, ...atLayer(docId, dstId)];
  return {
    copy: {
      _obj: "make",
      new: { _class: vector ? "path" : "channel" },
      using: { _ref: source },
      duplicate: true,
      at: { _ref: dest },
    },
    removeSource: { _obj: "delete", _target: source },
  };
}
