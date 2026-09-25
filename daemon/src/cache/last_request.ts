import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import type { BuiltRequest } from "../llm/request.ts";
import type { CallContext, SidecarRequest } from "../llm/types.ts";
import type { KeepalivePrefix, KeepaliveService } from "./keepalive.ts";
import { homeThreadOf } from "../engine/threads.ts";
import { keepaliveWindowSecs } from "../config/keepalive.ts";
import { rebuildRequestFromDisk, type RebuildDeps } from "./rebuild.ts";

export type InvalidationReason =
  | "compaction"
  | "idle_compaction"
  | "deep_idle_archive"
  | "model_change"
  | "model_setting_change"
  | "thread_change"
  | "prompt_reload"
  | "mcp_reload"
  | "mcp_recovery"
  | "character_deleted";

const UNARMED: KeepaliveArming = { intervalMs: undefined, pings: undefined };

export interface KeepaliveArming {
  intervalMs: number | undefined;
  pings: number | undefined;
}

export type KeepaliveReprime =
  | { kind: "push"; request: SidecarRequest; keepalive: KeepaliveArming }
  | { kind: "disarm" };

export function reprimeDecision(rebuilt: BuiltRequest | undefined): KeepaliveReprime {
  return rebuilt === undefined
    ? { kind: "disarm" }
    : {
        kind: "push",
        request: rebuilt.request,
        keepalive: {
          intervalMs: rebuilt.keepalive_interval_ms,
          pings: rebuilt.keepalive_pings,
        },
      };
}

export class LastRequestCache {
  readonly #bodies = new Map<string, SidecarRequest>();
  readonly #keepalive: KeepaliveService | undefined;

  constructor(keepalive?: KeepaliveService) {
    this.#keepalive = keepalive;
  }

  get(character: string): SidecarRequest | undefined {
    return this.#bodies.get(character);
  }

  cachedCharacters(): string[] {
    return [...this.#bodies.keys()];
  }

  set(
    character: string,
    request: SidecarRequest,
    keepalive?: KeepaliveArming,
    warm = true,
    thread?: string,
  ): void {
    this.#bodies.set(character, request);
    this.#keepalive?.arm(toPrefix(character, request, keepalive ?? UNARMED, thread), warm);
  }

  invalidate(character: string, reason: InvalidationReason): void {
    const had = this.#bodies.delete(character);
    this.#keepalive?.forgetMisses(character);
    shoreLog.debug(
      `shore: invalidated the cached request for ${character} (reason=${reason}, had=${had})`,
    );
  }

  async reprimeFromDisk(
    character: string,
    dataDir: string,
    config: LoadedConfig,
    deps: RebuildDeps = {},
  ): Promise<KeepaliveReprime> {
    const thread = deps.thread ?? (await homeThreadOf(dataDir, character));
    const decision = reprimeDecision(
      await rebuildRequestFromDisk(character, dataDir, config, { ...deps, thread }),
    );
    if (decision.kind === "push") {
      this.#bodies.set(character, decision.request);
      this.#keepalive?.arm(toPrefix(character, decision.request, decision.keepalive, thread));
    } else {
      this.#keepalive?.disarm(character);
    }
    return decision;
  }
}

function toPrefix(
  character: string,
  request: SidecarRequest,
  keepalive: KeepaliveArming,
  thread?: string,
): KeepalivePrefix {
  const context = request.context;
  const base: CallContext =
    context === undefined
      ? {
          character,
          call_type: "keepalive",
          thinking_enabled: false,
          ...(thread === undefined ? {} : { thread }),
        }
      : { ...context, character };
  return {
    ...request,
    context: { ...base, keepalive_window_secs: keepaliveWindowSecs(keepalive.intervalMs, keepalive.pings) },
    ...(keepalive.intervalMs === undefined
      ? {}
      : { keepalive_interval_ms: keepalive.intervalMs }),
    ...(keepalive.pings === undefined ? {} : { keepalive_pings: keepalive.pings }),
  };
}
