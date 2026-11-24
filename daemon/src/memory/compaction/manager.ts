import { characterDataDir } from "../../config/dirs.ts";

const inFlight = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

export interface CompactionRunGuard {
  release(): void;
  [Symbol.dispose](): void;
}

function handOff(key: string): void {
  const queue = waiting.get(key);
  const next = queue?.shift();
  if (queue !== undefined && queue.length === 0) waiting.delete(key);
  if (next === undefined) {
    inFlight.delete(key);
    return;
  }
  next();
}

function guardFor(key: string): CompactionRunGuard {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    handOff(key);
  };
  return { release, [Symbol.dispose]: release };
}

export function tryBeginCompaction(
  dataDir: string,
  character: string,
): CompactionRunGuard | undefined {
  const key = characterDataDir(dataDir, character);
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  return guardFor(key);
}

export async function beginCompaction(
  dataDir: string,
  character: string,
): Promise<CompactionRunGuard> {
  const key = characterDataDir(dataDir, character);
  if (!inFlight.has(key)) {
    inFlight.add(key);
    return guardFor(key);
  }
  await new Promise<void>((resolve) => {
    const queue = waiting.get(key);
    if (queue === undefined) waiting.set(key, [resolve]);
    else queue.push(resolve);
  });
  return guardFor(key);
}


