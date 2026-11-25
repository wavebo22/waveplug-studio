// The second native overlay: one vertical rail of variations for the selected AI result.
export const VARIANTS_PANEL = "variants";

export interface VariantItem {
  layerId: number;
  number: number;
  visible: boolean;
  thumb: string | null;
}

export interface VariantsSections {
  docId: number;
  groupId: number;
  name: string;
  items: VariantItem[];
}

/** 单击切换 a variation; 删除 one (the bin in a hovered thumbnail's corner) */
export type VariantsAction = { kind: "show-variant" | "delete-variant"; layerId: number; groupId: number };

export function parseVariantsAction(raw: unknown): VariantsAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  return (a.kind === "show-variant" || a.kind === "delete-variant") && Number.isInteger(a.groupId) && Number.isInteger(a.layerId)
    && Number(a.groupId) > 0 && Number(a.layerId) > 0
    ? { kind: a.kind, groupId: Number(a.groupId), layerId: Number(a.layerId) } : null;
}
