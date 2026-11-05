// A surface's state goes out as named sections; only those that changed since the last message
// are sent (typing the prompt doesn't resend the parameters, a progress tick doesn't resend the
// favourites). Works for any surface's sections.

/** The sections of `next` that differ from what was sent last (`sent`, updated in place);
 *  null when nothing changed. Pass an empty map to get everything (after a reconnect). */
export function changedSections<T extends object>(sent: Map<string, string>, next: T): Partial<T> | null {
  const out: Partial<T> = {};
  let any = false;
  for (const [name, value] of Object.entries(next)) {
    const json = JSON.stringify(value);
    if (sent.get(name) === json) continue;
    sent.set(name, json);
    (out as Record<string, unknown>)[name] = value;
    any = true;
  }
  return any ? out : null;
}
