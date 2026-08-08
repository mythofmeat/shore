import type { LoadedConfig } from "../config/loader.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import type { KeepaliveService, PingNowOutcome } from "../cache/keepalive.ts";
import type { RebuildDeps } from "../cache/rebuild.ts";
import { internalError } from "./errors.ts";

export type KeepalivePing =
  | {
      kind: "sent";
      fromCachedRequest: boolean;
      cold: boolean;
      usage: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
    }
  | { kind: "failed"; detail: string }
  | { kind: "skipped"; detail: string };

export interface KeepalivePingContext {
  keepalive: KeepaliveService;
  lastRequest: LastRequestCache;
  config: LoadedConfig;
  dataDir: string;
  rebuild?: RebuildDeps;
}

export async function pingNow(
  character: string,
  ctx: KeepalivePingContext,
): Promise<KeepalivePing> {
  let outcome = await ctx.keepalive.pingNow(character);

  let fromCachedRequest = true;
  if (outcome.reason === "no_prefix") {
    fromCachedRequest = false;
    const decision = await ctx.lastRequest.reprimeFromDisk(
      character,
      ctx.dataDir,
      ctx.config,
      ctx.rebuild ?? {},
    );
    if (decision.kind === "disarm") {
      return { kind: "skipped", detail: "no cached or rebuildable request" };
    }
    outcome = await ctx.keepalive.pingNow(character);
  }

  return classify(fromCachedRequest, outcome);
}

export function classify(
  fromCachedRequest: boolean,
  outcome: PingNowOutcome,
): KeepalivePing {
  const detail = outcome.detail ?? "";
  if (outcome.status === "sent") {
    const usage = outcome.usage;
    return {
      kind: "sent",
      fromCachedRequest,
      cold: outcome.cold,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_tokens ?? 0,
        cacheCreationTokens: usage?.cache_creation_tokens ?? 0,
      },
    };
  }
  if (outcome.status === "failed") return { kind: "failed", detail };
  return { kind: "skipped", detail };
}

export async function keepalivePingNowCommand(
  character: string,
  ctx: KeepalivePingContext,
): Promise<unknown> {
  const ping = await pingNow(character, ctx);

  if (ping.kind === "failed") {
    throw internalError(`keepalive ping failed: ${ping.detail}`);
  }
  if (ping.kind === "skipped") {
    return { status: "skipped", character, reason: ping.detail };
  }

  return {
    status: ping.cold ? "cold" : "warm",
    character,
    source: ping.fromCachedRequest ? "cached_last_request" : "rebuilt_from_disk",
    input_tokens: ping.usage.inputTokens,
    cache_read_tokens: ping.usage.cacheReadTokens,
    cache_creation_tokens: ping.usage.cacheCreationTokens,
    note: ping.cold
      ? "Read 0 and paid a write: this ping recreated the prefix at full " +
        "price rather than refreshing it. The autonomous keepalive treats " +
        "this as proof the prefix is gone and disarms."
      : ping.usage.cacheReadTokens === 0
        ? "Read 0 with no write — caching is off for this model, or a " +
          "non-cached fallback answered. Not a cold write."
        : "Read the cached prefix, which is what the keepalive exists to do.",
  };
}
