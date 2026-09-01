import { shoreLog } from "../log.ts";

import type { Sdk } from "./types.ts";

const HONORS_CACHE_TTL: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic", "nanogpt"]);

const REPORTS_CACHE_WRITES: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic", "nanogpt"]);

export function honorsCacheTtl(sdk: Sdk): boolean {
  return HONORS_CACHE_TTL.has(sdk);
}

export function reportsCacheWrites(sdk: Sdk): boolean {
  return REPORTS_CACHE_WRITES.has(sdk);
}

export function effectiveCacheTtl(sdk: Sdk, requested: string): string {
  if (requested === "") return "";
  if (!honorsCacheTtl(sdk)) {
    shoreLog.warn(
      `shore: cache_ttl=${requested} was requested for sdk ${sdk}, which has no prompt-cache ` +
        `control to carry it; no cache hint is being sent`,
    );
    return "";
  }
  return requested;
}
