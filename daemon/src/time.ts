/**
 * RFC 3339 with the local UTC offset, matching `chrono::Local::now().to_rfc3339()`.
 *
 * The daemon stamps message timestamps, segment manifests and deferred-edit
 * entries in local time rather than UTC, so anything that writes one of those
 * needs this exact shape.
 *
 * Deliberate divergence: the Rust emits nanosecond precision, JavaScript only
 * has milliseconds, so this writes three fractional digits where the Rust wrote
 * nine. Padding with six zeros would claim a precision that is not there.
 * Nothing parses this field — `engine/segments.ts` carries it as an opaque
 * string and the message store never reads it back as a date.
 *
 * This lived privately in `memory/deferred_edits.ts` and `memory/compaction_writer.ts`,
 * character-identical in both. `commands/conversation.ts` would have been the
 * third copy.
 */
export function localRfc3339(now: Date): string {
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
