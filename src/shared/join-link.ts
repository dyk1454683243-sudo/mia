/**
 * The shareable table URL, split so the waiting room can print the host and
 * the path on two lines — the form you read aloud on a phone call.
 *
 * `href` is what `navigator.share` and the clipboard already send. The split
 * is display only: nothing here is a second source of truth for the join.
 */
export function joinLink(origin: string, tableId: string): { href: string; host: string; path: string } {
  const path = `/t/${encodeURIComponent(tableId)}`;
  const href = `${origin.replace(/\/$/, "")}${path}`;
  let host = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    host = new URL(href).host;
  } catch {
    // origin is unparseable (a test fixture, or a scheme `URL` rejects): keep
    // the scheme-stripped fallback so the waiting room still has something to
    // print.
  }
  return { href, host, path };
}
