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

export function cachingIsSilentlyOff(sdk: Sdk, requested: string): boolean {
  return requested === "" && honorsCacheTtl(sdk);
}

const warnedUncached = new Set<Sdk>();

export function effectiveCacheTtl(sdk: Sdk, requested: string): string {
  if (requested === "") {
    if (cachingIsSilentlyOff(sdk, requested) && !warnedUncached.has(sdk)) {
      warnedUncached.add(sdk);
      shoreLog.warn(
        `shore: no cache_ttl is set for sdk ${sdk}, which does support prompt caching; ` +
          `requests will carry no cache breakpoints and pay full input price on every turn. ` +
          `Set cache_ttl on the model or on the provider's defaults to turn caching on`,
      );
    }
    return "";
  }
  if (!honorsCacheTtl(sdk)) {
    shoreLog.warn(
      `shore: cache_ttl=${requested} was requested for sdk ${sdk}, which has no prompt-cache ` +
        `control to carry it; no cache hint is being sent`,
    );
    return "";
  }
  return requested;
}
