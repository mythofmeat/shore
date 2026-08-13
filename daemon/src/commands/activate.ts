import type { AutonomyService } from "../autonomy/service.ts";
import type { KeepaliveService } from "../cache/keepalive.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import type { RebuildDeps } from "../cache/rebuild.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { Json } from "./conversation.ts";
import { rfc3339, untilSecs } from "./status.ts";

export interface SessionActivateContext {
  keepalive: KeepaliveService;
  lastRequest: LastRequestCache;
  autonomy: AutonomyService;
  register: (character: string, config: LoadedConfig) => Promise<boolean>;
  config: LoadedConfig;
  dataDir: string;
  rebuild?: RebuildDeps;
  now?: () => number;
}

interface ScheduledPing {
  interval_secs: number;
  next_ping_at: string;
  seconds_until_ping: number;
}

export type KeepaliveActivation =
  | { status: "unavailable"; detail: string }
  | { status: "off" }
  | ({ status: "resumed" } & ScheduledPing)
  | ({
      status: "primed";
      input_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      wrote_cache: boolean;
    } & ScheduledPing)
  | { status: "skipped"; detail: string }
  | { status: "failed"; detail: string };

async function ensurePrefix(
  character: string,
  ctx: SessionActivateContext,
): Promise<string | undefined> {
  if (ctx.lastRequest.get(character) !== undefined) return undefined;
  const decision = await ctx.lastRequest.reprimeFromDisk(
    character,
    ctx.dataDir,
    ctx.config,
    ctx.rebuild ?? {},
  );
  return decision.kind === "disarm" ? "no cached or rebuildable request" : undefined;
}

function scheduled(at: number, intervalMs: number, now: number): ScheduledPing {
  return {
    interval_secs: Math.trunc(intervalMs / 1000),
    next_ping_at: rfc3339(at),
    seconds_until_ping: untilSecs(at, now),
  };
}

export async function activateKeepalive(
  character: string,
  ctx: SessionActivateContext,
): Promise<KeepaliveActivation> {
  const now = ctx.now ?? Date.now;
  const missing = await ensurePrefix(character, ctx);
  if (missing !== undefined) return { status: "unavailable", detail: missing };

  const intervalMs = ctx.keepalive.intervalFor(character);
  if (intervalMs === undefined) return { status: "off" };

  const alreadyScheduled = ctx.keepalive.nextPingAt(character);
  if (alreadyScheduled !== undefined) {
    return { status: "resumed", ...scheduled(alreadyScheduled, intervalMs, now()) };
  }

  const outcome = await ctx.keepalive.primeNow(character);
  if (outcome.status === "failed") return { status: "failed", detail: outcome.detail ?? "" };
  if (outcome.status === "skipped") return { status: "skipped", detail: outcome.detail ?? "" };

  const usage = outcome.usage;
  const created = usage?.cache_creation_tokens ?? 0;
  return {
    status: "primed",
    input_tokens: usage?.input_tokens ?? 0,
    cache_read_tokens: usage?.cache_read_tokens ?? 0,
    cache_creation_tokens: created,
    wrote_cache: created > 0,
    ...scheduled(ctx.keepalive.nextPingAt(character) ?? now() + intervalMs, intervalMs, now()),
  };
}

export async function sessionActivateCommand(
  character: string,
  ctx: SessionActivateContext,
): Promise<Json> {
  const now = (ctx.now ?? Date.now)();
  const registered = await ctx.register(character, ctx.config);
  const keepalive = await activateKeepalive(character, ctx);
  const status = ctx.autonomy.status(character);
  const wake = status?.next_wake_at;

  return {
    character,
    registered,
    keepalive,
    heartbeat:
      status === undefined
        ? null
        : {
            state: status.heartbeat_state,
            paused: status.paused,
            ...(wake === undefined
              ? {}
              : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),
          },
  };
}
