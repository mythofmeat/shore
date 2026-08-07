/**
 * `serde_json::to_value` for the config structs.
 *
 * The `config` command ships the effective `AppConfig` and the built-in default
 * `AppConfig` side by side so a client can show what the user actually changed.
 * That makes the serialised shape a wire format, not an implementation detail,
 * which is why this is a named function with its own parity rows rather than a
 * `JSON.stringify` at the call site.
 *
 * Four rules are the whole of it, and they are all serde's:
 *
 * - **Field names pass through.** The interfaces in `app.ts` are already spelled
 *   the way the Rust structs are, so there is no case conversion to get wrong.
 * - **`Option::None` is `null`,** not an absent key. A field that is
 *   `undefined` on this side has to appear, spelled `null`.
 * - **A `BTreeMap` is an object with sorted keys.** `subagents` and `mcp` are
 *   maps, and the Rust's ordering is the `BTreeMap`'s, so the keys are sorted
 *   by code point rather than left in insertion order.
 * - **A `ConfigDuration` is its `Display`,** which `toString` already matches.
 *
 * Object key *order* is not part of the contract — the fixture is compared
 * structurally — but the sorted map keys are, because a client that renders the
 * sub-agent roster in the order it receives shows them alphabetically.
 */

import { ConfigDuration } from "./duration.ts";

/**
 * One value, as serde would have written it.
 *
 * Recursive and untyped on purpose: the config tree is plain data, and a walk
 * that knows every struct by name would have to be edited every time a field is
 * added — exactly the kind of second copy that drifts.
 */
export function serializeConfigValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof ConfigDuration) return value.toString();
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const key of [...value.keys()].sort()) {
      out[key] = serializeConfigValue(value.get(key));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(serializeConfigValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeConfigValue(v);
    }
    return out;
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}
