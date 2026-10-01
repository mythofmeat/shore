import { shoreLog } from "../log.ts";

import { localWallClock } from "./activity.ts";
import { hostZone } from "../ledger/zoned.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { AutonomyRunnerConfig, CompactionRunnerConfig } from "./runner.ts";
import type { HeartbeatClockConfig } from "./heartbeat.ts";
import type { AutonomyService, RegisterCharacter } from "./service.ts";

export function runnerConfigFor(config: LoadedConfig): AutonomyRunnerConfig {
  const autonomy = config.app.behavior.autonomy;
  return {
    autonomyEnabled: autonomy.enabled,
    heartbeatEnabled: autonomy.enabled,
    ...compactionConfigFor(config),
  };
}

function compactionConfigFor(config: LoadedConfig): CompactionRunnerConfig {
  const compaction = config.app.memory.compaction;
  return {
    compactionEnabled: compaction.enabled,
    minTurns: compaction.min_turns,
    maxTurns: compaction.max_turns,
    idleTriggerSecs: Number(compaction.idle_trigger.asSecs()),
    archiveAfterSecs: Number(compaction.archive_after.asSecs()),
    maxContextTokens: compaction.max_context_tokens,
  };
}

export function clockConfigFor(config: LoadedConfig): HeartbeatClockConfig {
  const heartbeat = config.app.behavior.autonomy.heartbeat;
  return {
    defaultIntervalMs: Number(heartbeat.default_interval.asMillisExact()),
    maxIdleTicks: heartbeat.dormant_after_heartbeat_turns,
    maxSilentMs: Number(heartbeat.dormant_after_idle_time.asMillisExact()),
    minIntervalMs: Number(heartbeat.min_interval.asMillisExact()),
    maxIntervalMs: Number(heartbeat.max_interval.asMillisExact()),
  };
}

export function registrationFor(character: string, config: LoadedConfig): RegisterCharacter {
  return {
    character,
    data_dir: `${config.dirs.data}/${character}`,
    config: runnerConfigFor(config),
    clock: clockConfigFor(config),
  };
}

type ServiceSlice = Pick<
  AutonomyService,
  | "register"
  | "setCompactionConfig"
  | "setHeartbeatConfig"
  | "backfillActivity"
  | "onUserMessage"
  | "onAssistantMessage"
  | "shouldCompactNow"
  | "onCompactionComplete"
  | "onCompactionFailed"
>;

export class TurnAutonomyBridge {
  readonly #service: ServiceSlice;
  readonly #now: () => number;
  readonly #zone: string;
  readonly #registered = new Map<string, Promise<void>>();
  readonly #activityBackfilled = new Set<string>();

  constructor(
    service: ServiceSlice,
    now: () => number = () => Date.now(),
    zone: string = hostZone(),
  ) {
    this.#service = service;
    this.#now = now;
    this.#zone = zone;
  }

  ensureState(character: string, config: LoadedConfig): boolean {
    if (this.#registered.has(character)) return false;

    const pending = this.#service.register(registrationFor(character, config)).catch((e: unknown) => {
      shoreLog.warn(`shore: autonomy registration failed for ${character}: ${String(e)}`);
    });
    this.#registered.set(character, pending);
    return true;
  }

  needsActivityBackfill(character: string): boolean {
    return !this.#activityBackfilled.has(character);
  }

  backfillActivity(character: string, timestamps: readonly Date[]): void {
    this.#activityBackfilled.add(character);
    const instants = timestamps.map((t) => t.getTime());
    const localStamps = instants.map((at) => localWallClock(at, this.#zone));
    const latestUserAt = instants.length === 0 ? undefined : Math.max(...instants);
    this.#after(character, () => {
      this.#service.backfillActivity(character, localStamps, latestUserAt);
    });
  }

  onUserMessage(character: string, turnCount: number): void {
    const localAt = localWallClock(this.#now(), this.#zone);
    this.#after(character, () => {
      this.#service.onUserMessage(character, turnCount, localAt);
    });
  }

  forget(character: string): void {
    this.#registered.delete(character);
    this.#activityBackfilled.delete(character);
  }

  reloadConfig(effectiveConfig: (character: string) => LoadedConfig): void {
    for (const character of Array.from(this.#registered.keys())) {
      this.#after(character, () => {
        const config = effectiveConfig(character);
        this.#service.setCompactionConfig(
          character,
          compactionConfigFor(config),
        );
        this.#service.setHeartbeatConfig(character, clockConfigFor(config));
      });
    }
  }

  onAssistantMessage(character: string, turnCount: number): void {
    this.#after(character, () => {
      this.#service.onAssistantMessage(character, turnCount);
    });
  }

  shouldCompactNow(character: string, turnCount: number, contextTokens: number, crowded = false): boolean {
    return this.#service.shouldCompactNow(character, turnCount, contextTokens, crowded) ?? false;
  }

  onCompactionComplete(character: string, retained: number): void {
    this.#after(character, () => {
      this.#service.onCompactionComplete(character, retained);
    });
  }

  onCompactionFailed(character: string, retryAt?: number): void {
    this.#after(character, () => {
      this.#service.onCompactionFailed(character, retryAt);
    });
  }

  #after(character: string, fn: () => void): void {
    const pending = this.#registered.get(character);
    if (pending === undefined) {
      return;
    }
    this.#registered.set(
      character,
      pending.then(fn).catch((e: unknown) => {
        shoreLog.warn(`shore: autonomy update failed for ${character}: ${String(e)}`);
      }),
    );
  }

  async settled(character: string): Promise<void> {
    await this.#registered.get(character);
  }
}
