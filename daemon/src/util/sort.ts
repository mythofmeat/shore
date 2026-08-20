export function compareByCodePoint(a: string, b: string): number {
  const ac = Array.from(a);
  const bc = Array.from(b);
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
