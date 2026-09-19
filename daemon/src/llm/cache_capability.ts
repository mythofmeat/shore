import { shoreLog } from "../log.ts";

import type { Sdk } from "./types.ts";
import { nanogptSupportsExplicitCache } from "./providers/nanogpt_config.ts";

const HONORS_CACHE_TTL: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic", "nanogpt"]);

const REPORTS_CACHE_WRITES: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic", "nanogpt"]);

export function honorsCacheTtl(sdk: Sdk, model?: string): boolean {
  return HONORS_CACHE_TTL.has(sdk) &&
    (sdk !== "nanogpt" || model === undefined || nanogptSupportsExplicitCache(model));
}

export function supportsKeepalive(sdk: Sdk, model: string, ttl: string | undefined): boolean {
  return honorsCacheTtl(sdk, model) && ttl !== undefined && ttl !== "";
}

export function keepalivePolicyError(sdk: Sdk, model: string, ttl: string | undefined, intervalMs: number): string | undefined {
  if (!supportsKeepalive(sdk, model, ttl)) {
    return `cache_keepalive requires an explicit cache_ttl honored by ${sdk} for ${model}`;
  }
  const ttlMs = ttl === "1h" ? 3_600_000 : 300_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= ttlMs) {
    return `cache_keepalive must be positive and shorter than the effective cache TTL (${ttl === "1h" ? "1h" : "5m"})`;
  }
  return undefined;
}

export function reportsCacheWrites(sdk: Sdk): boolean {
  return REPORTS_CACHE_WRITES.has(sdk);
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
