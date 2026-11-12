import { chmodSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const DAEMON_ONLY = 0o700;

const providerCaches = (cache: string): string => join(cache, "providers");

export const providerCacheDir = (cache: string, provider: string): string => join(providerCaches(cache), provider);

export function closeProviderCaches(cache: string): void {
  const caches = providerCaches(cache);
  mkdirSync(caches, { recursive: true, mode: DAEMON_ONLY });
  chmodSync(caches, DAEMON_ONLY);
}

export async function makeProviderCacheFolder(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: DAEMON_ONLY });
}

export function makeProviderCacheFolderSync(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: DAEMON_ONLY });
}
