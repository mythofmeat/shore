import type { LoadedConfig } from "../config/loader.ts";
import type { SidecarRequest } from "../llm/types.ts";
import type { KeepalivePrefix, KeepaliveService } from "./keepalive.ts";
import { rebuildRequestFromDisk, type RebuildDeps } from "./rebuild.ts";

export type InvalidationReason =
  | "compaction"
  | "idle_compaction"
  | "deep_idle_archive"
  | "prompt_reload";

export type KeepaliveReprime =
  | { kind: "push"; request: SidecarRequest }
  | { kind: "disarm" };

export function reprimeDecision(rebuilt: SidecarRequest | undefined): KeepaliveReprime {
  return rebuilt === undefined ? { kind: "disarm" } : { kind: "push", request: rebuilt };
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

  set(character: string, request: SidecarRequest, keepaliveIntervalMs?: number): void {
    this.#bodies.set(character, request);
    this.#keepalive?.arm(toPrefix(character, request, keepaliveIntervalMs), true);
  }

  invalidate(character: string, reason: InvalidationReason): void {
    const had = this.#bodies.delete(character);
    console.debug(
      `shore: invalidated the cached request for ${character} (reason=${reason}, had=${had})`,
    );
  }

  async reprimeFromDisk(
    character: string,
    dataDir: string,
    config: LoadedConfig,
    deps: RebuildDeps & { keepaliveIntervalMs?: number } = {},
  ): Promise<KeepaliveReprime> {
    const decision = reprimeDecision(
      await rebuildRequestFromDisk(character, dataDir, config, deps),
    );
    if (decision.kind === "push") {
      this.#bodies.set(character, decision.request);
      this.#keepalive?.arm(toPrefix(character, decision.request, deps.keepaliveIntervalMs));
    } else {
      this.#keepalive?.disarm(character);
    }
    return decision;
  }
}

function toPrefix(
  character: string,
  request: SidecarRequest,
  keepaliveIntervalMs?: number,
): KeepalivePrefix {
  const context = request.context;
  return {
    ...request,
    context:
      context === undefined
        ? { character, call_type: "keepalive", thinking_enabled: false }
        : { ...context, character },
    ...(keepaliveIntervalMs === undefined ? {} : { keepalive_interval_ms: keepaliveIntervalMs }),
  };
}
