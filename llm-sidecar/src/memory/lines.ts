/**
 * Rust's `str::lines()`, its trimming, and its byte-wise string ordering.
 *
 * Small primitives that several memory modules need and that JavaScript gets
 * subtly wrong by default. Pinned by `tests/memory_fixtures/markdown_parity.json`
 * and `tests/memory_fixtures/workspace_index_parity.json`.
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
 * The characters Rust's `str::trim*` family strips: the Unicode `White_Space`
 * property, which is exactly what `char::is_whitespace` tests.
 *
 * JavaScript's own `trim` uses a *different* set, and it differs in both
 * directions:
 *
 * - It strips **U+FEFF**, the byte-order mark, which Rust leaves alone. A file
 *   saved with a BOM therefore looks like it begins with its heading to JS and
 *   like it begins with a stray character to Rust — a 50-point swing in the
 *   lexical score, since the heading weight never applies.
 * - It does *not* strip **U+0085** (NEL), which Rust does.
 *
 * Both cases are pinned; neither is hypothetical, as a BOM is what several
 * Windows editors write by default.
 */
const WHITESPACE_START = /^\p{White_Space}+/u;
const WHITESPACE_END = /\p{White_Space}+$/u;

/** Rust's `str::trim_start()`. */
export function rustTrimStart(text: string): string {
  return text.replace(WHITESPACE_START, "");
}

/** Rust's `str::trim_end()`. */
export function rustTrimEnd(text: string): string {
  return text.replace(WHITESPACE_END, "");
}

/** Rust's `str::trim()`. */
export function rustTrim(text: string): string {
  return rustTrimEnd(rustTrimStart(text));
}

/**
 * Split a lowercased query into scoring terms.
 *
 * Separators are everything that is neither alphanumeric nor `_`/`-`, so
 * `snake_case` and `kebab-case` survive as single terms.
 *
 * The length floor is two *bytes*, not two characters — Rust's `str::len()`.
 * That is not a typo carried across: it means a one-character multibyte term
 * like `é` passes the filter while a one-character ASCII term like `x` does
 * not, and both fixtures pin a search on each.
 *
 * The Rust wrote this split out three times — the markdown store, its excerpt
 * picker, and the workspace index — and all three had to agree for a hit's
 * excerpt to contain the term it was ranked for. One copy is the whole reason
 * this lives here rather than in any of them.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .split(/[^\p{Alphabetic}\p{Nd}\p{Nl}\p{No}_-]/u)
    .filter((term) => Buffer.byteLength(term, "utf8") >= 2);
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
