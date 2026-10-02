import { shoreLog } from "../log.ts";

import type { Sdk } from "./types.ts";
import { nanogptSupportsExplicitCache } from "./providers/nanogpt_config.ts";

const HONORS_CACHE_TTL: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic", "nanogpt"]);

export function honorsCacheTtl(sdk: Sdk, model?: string): boolean {
  return HONORS_CACHE_TTL.has(sdk) &&
    (sdk !== "nanogpt" || model === undefined || nanogptSupportsExplicitCache(model));
}

export function acceptsCacheTtl(sdk: Sdk, model?: string): boolean {
  return sdk === "claude_agent" || honorsCacheTtl(sdk, model);
}

export function cacheTtlTier(ttl: string | undefined): "5m" | "1h" | undefined {
  if (ttl === undefined || ttl === "") return undefined;
  return ttl === "1h" ? "1h" : "5m";
}

export function keepaliveTtlWarning(sdk: Sdk, model: string, ttl: string | undefined, intervalMs: number): string | undefined {
  const known = acceptsCacheTtl(sdk, model) ? cacheTtlTier(ttl) : undefined;
  if (known === undefined) return undefined;
  const ttlMs = known === "1h" ? 3_600_000 : 300_000;
  if (intervalMs < ttlMs) return undefined;
  return `cache_keepalive is not shorter than this model's ${known} cache TTL, so each ping will land after the cache has already expired`;
}

export function cachingIsSilentlyOff(sdk: Sdk, requested: string, model?: string): boolean {
  return requested === "" && honorsCacheTtl(sdk, model);
}

const warnedUncached = new Set<Sdk>();

export function effectiveCacheTtl(sdk: Sdk, requested: string, model?: string): string {
  if (requested === "") {
    if (cachingIsSilentlyOff(sdk, requested, model) && !warnedUncached.has(sdk)) {
      warnedUncached.add(sdk);
      shoreLog.warn(
        `shore: no cache_ttl is set for sdk ${sdk}, which does support prompt caching; ` +
          `requests will carry no cache breakpoints and pay full input price on every turn. ` +
          `Set cache_ttl on the model or on the provider's defaults to turn caching on`,
      );
    }
    return "";
  }
  if (!honorsCacheTtl(sdk, model)) {
    shoreLog.warn(
      `shore: cache_ttl=${requested} was requested for sdk ${sdk}${model === undefined ? "" : ` model ${model}`}, which has no prompt-cache ` +
        `control to carry it; no cache hint is being sent`,
    );
    return "";
  }
  return requested;
}
