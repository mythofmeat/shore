/**
 * A fingerprint of the tool surface a request carried.
 *
 * Tool definitions sit ahead of `system` and `messages` in Anthropic's cached
 * prefix, so adding, removing or re-describing one invalidates the whole cache.
 * The tracker modelled three warm→cold transitions — TTL expiry, model change,
 * a thinking toggle — and had no fourth for this, because the `calls` table had
 * no column describing the tools. The resulting full write was recorded as
 * `unexpected_write`: correct as billing, wrong as diagnosis (#33).
 *
 * Editing `enabled_tools` is rare. **MCP servers appearing and disappearing is
 * not**, and it has the same effect — a server that fails to start drops its
 * tools, one that recovers puts them back, and each transition rewrote the
 * prefix and raised an anomaly with no cause attached. A tracker that cries
 * wolf on a routine event is worse than one that says nothing, because
 * `unexpected_write` is the alert this repo relies on.
 *
 * The hash is over the definitions *as sent*, not over their names: an MCP
 * server that changes a tool's description or schema moves the prefix exactly
 * as much as one that disappears, and the fingerprint has to see it.
 */

import { createHash } from "node:crypto";

/** How much of the digest is kept. Sixteen hex chars is 64 bits — collision
 *  odds that round to zero against the handful of distinct surfaces one
 *  character ever has, and short enough to read in a `sqlite3` dump. */
const FINGERPRINT_CHARS = 16;

/**
 * The fingerprint for a request's tools, or `undefined` when there is nothing
 * to fingerprint.
 *
 * `undefined` means *unknown*, and the tracker treats it as "do not compare" —
 * which is what keeps pre-migration rows and non-tool providers from reporting
 * a spurious change. It is deliberately **not** what an empty tool array
 * produces: "this request carried no tools" is a real surface, and a character
 * whose tools were switched off did move the prefix.
 */
export function toolSurfaceFingerprint(tools: readonly unknown[] | undefined): string | undefined {
  if (tools === undefined) return undefined;
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, FINGERPRINT_CHARS);
}
