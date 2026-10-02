const DYNAMIC_SYSTEM_LABELS: ReadonlySet<string> = new Set(["memory_index"]);

export function isDynamicSystemBlock(label: string): boolean {
  return DYNAMIC_SYSTEM_LABELS.has(label);
}

export function withDynamicBlocksLast<T extends { label: string }>(blocks: readonly T[]): T[] {
  const stable = blocks.filter((b) => !isDynamicSystemBlock(b.label));
  const dynamic = blocks.filter((b) => isDynamicSystemBlock(b.label));
  return [...stable, ...dynamic];
}

export function cacheBoundaryIndex(blocks: readonly { label: string }[]): number {
  const firstDynamic = blocks.findIndex((b) => isDynamicSystemBlock(b.label));
  return firstDynamic === -1 ? blocks.length - 1 : firstDynamic - 1;
}
