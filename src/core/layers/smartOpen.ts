import type { ToolResult } from "./smart.ts";

/** Only PNG-backed smart objects are automatically converted before editing.
 * The string is Photoshop's smartObject.fileReference (not the outer PSD filename). */
export function needsPsbBeforeEditing(fileReference: string | null | undefined): boolean {
  return typeof fileReference === "string" && /\.png$/i.test(fileReference.trim());
}

export interface SmartContentOpenOps {
  /** Same existing conversion used by the smart-object tools panel. */
  convertPng(): Promise<ToolResult>;
  /** Photoshop can replace the layer ID while converting to PSB. */
  convertedLayerId(): number | null;
  /** Opens only the requested final layer ID, never the stale PNG layer ID. */
  open(layerId: number): Promise<void>;
}

/** Fail closed: an incomplete PNG conversion must NOT fall through to opening the PNG.
 * PSB/PSD and all other formats keep the original direct-open behaviour. */
export async function openSmartContents(
  originalId: number, fileReference: string | null | undefined, ops: SmartContentOpenOps,
): Promise<{ layerId: number; converted: boolean }> {
  if (!needsPsbBeforeEditing(fileReference)) {
    await ops.open(originalId);
    return { layerId: originalId, converted: false };
  }
  const result = await ops.convertPng();
  if (result.done !== 1 || result.skipped.length) {
    throw new Error("PNG 转为可编辑 PSB 失败：" + (result.skipped.join("；") || "没有成功转换智能对象"));
  }
  const layerId = ops.convertedLayerId();
  if (!layerId || layerId === originalId) {
    throw new Error("PNG 已尝试转换，但无法确认新的 PSB 图层，未打开内容");
  }
  await ops.open(layerId);
  return { layerId, converted: true };
}
