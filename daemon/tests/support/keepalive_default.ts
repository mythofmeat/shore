/**
 * The one deliberate divergence in the `cache_keepalive` default.
 *
 * The Rust defaulted `cache_keepalive` to `"55m"` for every Anthropic model,
 * and the parity fixtures recorded that value wherever the input set nothing.
 * The port defaults it to nothing (#47). Two shapes save money against a 1h
 * TTL — `cache_ttl = "1h"` with a `55m` cadence, or off — and picking the
 * former for everyone is a per-character spend decision the config is there to
 * make. It was harmless in the Rust only because the cadence never reached the
 * scheduler; #47 connects that wire, so the default has to move in the same
 * change or every Anthropic character starts pinging without a config edit.
 *
 * The fixtures keep the Rust's value. Rewriting it here, keyed on the exact old
 * string, is what makes the divergence a decision rather than a drift: an
 * explicit `cache_keepalive = "55m"` in a fixture's input would be rewritten
 * too, so `expectedKeepalive` must only be reached for a *defaulted* field.
 * Every current caller compares a whole resolved model, where the only `"55m"`
 * the generator produced was the default — the explicit rows use `"off"` and
 * `"10m"` precisely so they stay distinguishable.
 */
const RUST_DEFAULT_KEEPALIVE = "55m";

export function expectedKeepalive(recorded: string | null): string | null {
  return recorded === RUST_DEFAULT_KEEPALIVE ? null : recorded;
}

/** `expectedKeepalive` applied to the `cache_keepalive` key of a wire model. */
export function withoutDefaultedKeepalive<T>(wire: T): T {
  if (wire === null || typeof wire !== "object") return wire;
  if (!("cache_keepalive" in wire)) return wire;
  const row = wire as Record<string, unknown>;
  return {
    ...row,
    cache_keepalive: expectedKeepalive((row["cache_keepalive"] ?? null) as string | null),
  } as T;
}

/**
 * The same divergence in a scope map, which answers *where* a field's value
 * came from rather than what it is. A field nothing supplies has no scope at
 * all, so `"static_default"` becomes an absent key rather than a null one.
 */
export function withoutDefaultedKeepaliveScope(
  scopes: Record<string, string>,
): Record<string, string> {
  if (scopes["cache_keepalive"] !== "static_default") return scopes;
  const { cache_keepalive: _defaulted, ...rest } = scopes;
  return rest;
}

const RUST_DEFAULT_KEEPALIVE_SCOPE = "static_default";

/**
 * Both of the above, applied at every depth.
 *
 * `model_commands_parity` records whole command replies, which nest a resolved
 * model, its per-field scopes, and the catalog rows the command listed. The
 * scope map there spells an unset field `null` rather than dropping the key,
 * so this collapses both the value and the scope onto it. Nothing in that
 * fixture ever sets `cache_keepalive` on the way in, so every occurrence it
 * records is the Rust default.
 */
export function deepWithoutDefaultedKeepalive<T>(blob: T): T {
  if (Array.isArray(blob)) return blob.map(deepWithoutDefaultedKeepalive) as T;
  if (blob === null || typeof blob !== "object") return blob;
  return Object.fromEntries(
    Object.entries(blob as Record<string, unknown>).map(([key, value]) =>
      key === "cache_keepalive" &&
      (value === RUST_DEFAULT_KEEPALIVE || value === RUST_DEFAULT_KEEPALIVE_SCOPE)
        ? [key, null]
        : [key, deepWithoutDefaultedKeepalive(value)],
    ),
  ) as T;
}
