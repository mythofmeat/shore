export function compareByCodePoint(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  const shared = Math.min(ac.length, bc.length);
  for (let i = 0; i < shared; i += 1) {
    const x = (ac[i] as string).codePointAt(0) as number;
    const y = (bc[i] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return ac.length - bc.length;
}

export function sortedKeys(table: Record<string, unknown>): string[] {
  return Object.keys(table).sort(compareByCodePoint);
}

function sortedMap<T>(entries: Iterable<readonly [string, T]>): Map<string, T> {
  return new Map([...entries].sort((a, b) => compareByCodePoint(a[0], b[0])));
}
