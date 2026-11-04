/** WaveLayer context actions operate on explicit row IDs, but legacy smart-object
 * tools inspect Photoshop's activeLayers. Synchronise the exact target BEFORE invoking
 * the tool, so a double-click on 链接×N never acts on a stale native selection.
 */
export async function onSmartTarget<T>(
  ids: readonly number[],
  select: (ids: number[]) => Promise<void>,
  execute: () => Promise<T>,
): Promise<T> {
  if (ids.length) await select([...new Set(ids)]);
  return execute();
}
