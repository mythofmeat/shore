let follower: ((key: string, value: string) => void) | undefined;
const listeners = new Set<() => void>();

export function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
  follower?.(key, value);
}

export function followStoredWrites(next: (key: string, value: string) => void): void { follower = next; }

export function subscribeStored(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function storedChanged(): void { for (const listener of listeners) listener(); }
