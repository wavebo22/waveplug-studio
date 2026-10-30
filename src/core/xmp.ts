// "Highest version number ever issued" for a task group lives in the PSB's own XMP
// (photoshop:Instructions), so it travels with the file and survives deleting the latest layer.
// Verified on Photoshop 27.10: XMPMetadataAsUTF8 can be read and replaced via set/document.

const TAG = /<photoshop:Instructions(?:\s[^>]*)?>([^<]*)<\/photoshop:Instructions>/;
const ATTR = /photoshop:Instructions="([^"]*)"/;
const KEY = /waveplug:last=(\d+)/;

export function readCounter(xmp: string): number {
  const m = TAG.exec(xmp) ?? ATTR.exec(xmp);
  const k = m ? KEY.exec(m[1]) : null;
  return k ? Number(k[1]) : 0;
}

export function writeCounter(xmp: string, n: number): string {
  const value = (old: string) => (old.replace(/\s*waveplug:last=\d+/, "").trim() + " waveplug:last=" + n).trim();
  if (TAG.test(xmp)) return xmp.replace(TAG, (all, old: string) => all.replace(">" + old + "<", ">" + value(old) + "<"));
  if (ATTR.test(xmp)) return xmp.replace(ATTR, (_all, old: string) => `photoshop:Instructions="${value(old)}"`);
  const el = `<photoshop:Instructions xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">waveplug:last=${n}</photoshop:Instructions>`;
  if (!/<\/rdf:Description>/.test(xmp)) throw new Error("PSB 元数据格式无法识别");
  return xmp.replace(/<\/rdf:Description>/, el + "</rdf:Description>");
}
