const MAX_ID = 64;

function slug(name: string): string {
  const plain = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return plain.replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, MAX_ID).replace(/[-.]+$/, "");
}

export function threadIdFor(name: string, taken: readonly string[]): string {
  const base = slug(name) || "thread";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) {
    const suffix = `-${String(n)}`;
    id = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
  }
  return id;
}

export interface NamedThread { id: string; label?: string }

export function namedThread(name: string, taken: readonly string[]): NamedThread {
  const label = name.trim();
  const id = threadIdFor(label, taken);
  return id === label ? { id } : { id, label };
}
