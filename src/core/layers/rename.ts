/** Keep an inline name editor only while its virtual row still represents the same base layer. */
export function matchesInlineRenameRow(
  editingLayerId: number | null,
  rowLayerId: number,
  isSubRow: boolean,
): boolean {
  return editingLayerId !== null && !isSubRow && editingLayerId === rowLayerId;
}
