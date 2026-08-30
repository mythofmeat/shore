import { shoreLog } from "../log.ts";

import type { Sdk } from "./types.ts";

const RESPECTS_INLINE_HINTS: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic"]);

const REPORTS_CACHE_WRITES: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic"]);

export function respectsInlineCacheHints(sdk: Sdk): boolean {
  return RESPECTS_INLINE_HINTS.has(sdk);
}

export function reportsCacheWrites(sdk: Sdk): boolean {
  return REPORTS_CACHE_WRITES.has(sdk);
}

export function effectiveCacheTtl(sdk: Sdk, requested: string): string {
  if (requested === "") return "";
  if (!respectsInlineCacheHints(sdk)) {
    shoreLog.warn(
      `shore: cache_ttl=${requested} was requested for sdk ${sdk}, which does not read inline ` +
        `cache_control markers; no marker is being sent`,
    );
    return "";
  }
  return requested;
}
