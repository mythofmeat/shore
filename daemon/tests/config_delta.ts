export const UNCHANGED = Symbol("unchanged");
const REPLACE = Symbol("replace");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && deepEqual(a[k], b[k]));
}

export function pathsSetBy(table: unknown, prefix: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  if (!isRecord(table)) return out;
  for (const [key, value] of Object.entries(table)) {
    const path = [...prefix, key];
    out.add(path.join("."));
    for (const nested of pathsSetBy(value, path)) out.add(nested);
  }
  return out;
}

function changesFrom(
  want: unknown,
  base: unknown,
  explicit: ReadonlySet<string>,
  path: readonly string[],
): unknown {
  const here = path.join(".");
  if (path.length > 0 && !explicit.has(here) && deepEqual(want, base)) return UNCHANGED;
  if (!isRecord(want) || !isRecord(base)) return want;

  const keys = Object.keys(want);
  const sameShape = keys.length === Object.keys(base).length && keys.every((k) => k in base);
  if (!sameShape) return { [REPLACE]: want };

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const sub = changesFrom(want[key], base[key], explicit, [...path, key]);
    if (sub !== UNCHANGED) out[key] = sub;
  }
  return out;
}

export function changesAgainst(
  want: unknown,
  base: unknown,
  explicit: ReadonlySet<string> = new Set(),
): unknown {
  return changesFrom(want, base, explicit, []);
}

export function withChanges(base: unknown, changes: unknown): unknown {
  if (changes === UNCHANGED) return base;
  if (isRecord(changes) && REPLACE in changes) {
    return (changes as Record<symbol, unknown>)[REPLACE];
  }
  if (!isRecord(base) || !isRecord(changes)) return changes;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    out[key] = key in base ? withChanges(base[key], value) : value;
  }
  return out;
}

export function replayOntoCurrentDefaults(
  recordedWant: unknown,
  recordedDefaults: unknown,
  currentDefaults: unknown,
  explicit: ReadonlySet<string> = new Set(),
): unknown {
  return withChanges(currentDefaults, changesAgainst(recordedWant, recordedDefaults, explicit));
}
