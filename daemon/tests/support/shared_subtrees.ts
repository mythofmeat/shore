export const SHARED_KEY = "$shared";
export const REF_KEY = "$ref";

function substitute(node: unknown, shared: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((v) => substitute(v, shared));
  if (node === null || typeof node !== "object") return node;

  const record = node as Record<string, unknown>;
  const ref = record[REF_KEY];
  if (typeof ref === "string" && Object.keys(record).length === 1) {
    const target = shared[ref];
    if (target === undefined) throw new Error(`fixture references missing subtree ${ref}`);
    return substitute(target, shared);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = substitute(value, shared);
  return out;
}

export function expandShared<T>(doc: unknown): T {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return doc as T;
  const record = doc as Record<string, unknown>;
  const shared = record[SHARED_KEY];
  if (shared === undefined) return doc as T;

  const table = shared as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== SHARED_KEY) rest[key] = value;
  }
  return substitute(rest, table) as T;
}
