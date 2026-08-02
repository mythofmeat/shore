/**
 * Rust's `str::lines()`, and its byte-wise string ordering.
 *
 * Two small primitives that several memory modules need and that JavaScript
 * gets subtly wrong by default. Both are pinned by
 * `tests/memory_fixtures/markdown_parity.json`.
 */

/**
 * Split like Rust's `str::lines()`.
 *
 * Three differences from a plain `split("\n")`, all of them observable:
 *
 * 1. A trailing `\r` is stripped, so a CRLF file yields the same lines as an
 *    LF one. Without this the `\r` rides along into every downstream trim,
 *    comparison and excerpt.
 * 2. A trailing newline does *not* produce an empty final element — `"a\n"` is
 *    one line, not two. This is load-bearing wherever line *count* matters,
 *    and it is why `excerptForQuery`'s window does not run off the end.
 * 3. An empty string is zero lines, not one.
 *
 * Interior blank lines are kept. Rust keeps them and the excerpt logic depends
 * on seeing them: `"a\n\nb"` is three lines, and its middle one is skipped by
 * name rather than by never existing.
 */
export function rustLines(text: string): string[] {
  const parts = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Compare two strings as Rust's `String::cmp` does — by UTF-8 bytes.
 *
 * JavaScript's `<` compares UTF-16 code units, which disagrees with UTF-8 byte
 * order for anything above the BMP: an emoji sorts *before* U+E000..U+FFFF in
 * UTF-16 and *after* it in UTF-8. Memory entries are sorted by path and the
 * search results break ties on it, so a filename with an emoji in it would
 * come back in a different order than the Rust returned.
 */
export function compareRustStrings(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
