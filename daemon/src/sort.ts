/**
 * Ordering helpers shared by every port of a Rust `BTreeMap<String, _>` or a
 * sorted `Vec<String>`.
 *
 * Rust's `String: Ord` compares bytes. UTF-8 byte order and code-point order
 * agree, so a `BTreeMap<String, _>` iterates in code-point order.
 *
 * JavaScript's default string comparison does **not** agree. It compares UTF-16
 * code units, so anything outside the BMP is a surrogate pair starting at
 * 0xD800 and sorts *below* the 0xE000–0xFFFF range instead of above it. A
 * sub-agent named `🎵drum` and one named `ﬀute` come out in opposite orders
 * under the two rules — which, for the tool surface, reorders the head of the
 * Anthropic cache key and invalidates every block after it.
 */

/** Compare two strings by Unicode code point, matching Rust's `String::cmp`. */
export function compareByCodePoint(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  const shared = Math.min(ac.length, bc.length);
  for (let i = 0; i < shared; i += 1) {
    // Safe: `i < shared <= ac.length`, and every element of a spread string is
    // a non-empty code point, so `codePointAt(0)` is defined.
    const x = (ac[i] as string).codePointAt(0) as number;
    const y = (bc[i] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return ac.length - bc.length;
}

/**
 * A record's keys in the order a Rust `BTreeMap` would yield them.
 *
 * `toml::Table` is a `BTreeMap` (the `toml` crate is built without
 * `preserve_order`), so anything that walks a parsed TOML table and can stop at
 * the first bad key has to walk it in this order to fail on the same key.
 */
export function sortedKeys(table: Record<string, unknown>): string[] {
  return Object.keys(table).sort(compareByCodePoint);
}

/** Build a `Map` whose iteration order matches a Rust `BTreeMap`'s. */
export function sortedMap<T>(entries: Iterable<readonly [string, T]>): Map<string, T> {
  return new Map([...entries].sort((a, b) => compareByCodePoint(a[0], b[0])));
}
