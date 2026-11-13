import { shoreLog } from "../log.ts";

import { localWallClock } from "./activity.ts";
import { homeThreadOf, threadActivityNow } from "../engine/threads.ts";
import { hostZone } from "../ledger/zoned.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { loadCompactionCheckpoint } from "../memory/compaction/checkpoint.ts";
import { dreamRunnerConfig, type AutonomyRunnerConfig, type CompactionRunnerConfig, type DreamRunnerConfig, type RestoredIdle } from "./runner.ts";
import type { DormancyConfig } from "./dormancy.ts";
import type { AutonomyService, RegisterCharacter } from "./service.ts";

export function runnerConfigFor(config: LoadedConfig): AutonomyRunnerConfig {
  return {
    autonomyEnabled: config.app.triggers.enabled,
    ...compactionConfigFor(config),
    dream: dreamConfigFor(config),
  };
}

export function dreamConfigFor(config: LoadedConfig): DreamRunnerConfig {
  return dreamRunnerConfig(config.app.dreaming);
}

function compactionConfigFor(config: LoadedConfig): CompactionRunnerConfig {
  const compaction = config.app.compaction;
  return {
    compactionEnabled: compaction.enabled,
    minTurns: compaction.min_turns,
    maxTurns: compaction.max_turns,
    idleTriggerSecs: Number(compaction.idle_after.asSecs()),
    archiveAfterSecs: Number(compaction.archive_after.asSecs()),
    maxContextTokens: compaction.max_context_tokens,
  };
}

export function dormancyConfigFor(config: LoadedConfig): DormancyConfig {
  const { triggers } = config.app;
  return {
    maxIdleWakes: triggers.max_idle_wakes,
    maxSilentMs: Number(triggers.idle_timeout.asMillisExact()),
  };
}

async function restoredIdle(dataDir: string, character: string): Promise<RestoredIdle | undefined> {
  try {
    const thread = await homeThreadOf(dataDir, character);
    const { user_turns: turns, last_active: lastActive } = threadActivityNow(dataDir, character, thread);
    const checkpoint = await loadCompactionCheckpoint(dataDir, character, thread).catch(() => undefined);
    const diedCompacting = checkpoint?.state === "running";
    return {
      turnCount: turns,
      ...(lastActive === undefined || diedCompacting ? {} : { lastActivityAt: Date.parse(lastActive) }),
    };
  } catch (e) {
    shoreLog.warn(`shore: could not restore ${character}'s idle state: ${String(e)}`);
    return undefined;
  }
}

export function registrationFor(character: string, config: LoadedConfig): RegisterCharacter {
  return {
    character,
    data_dir: `${config.dirs.data}/${character}`,
    config: runnerConfigFor(config),
    dormancy: dormancyConfigFor(config),
    restoreIdle: async () => await restoredIdle(config.dirs.data, character),
  };
}

type ServiceSlice = Pick<
  AutonomyService,
  | "register"
  | "setCompactionConfig"
  | "setDormancyConfig"
  | "setDreamConfig"
  | "backfillActivity"
  | "onUserMessage"
  | "onUserActivityElsewhere"
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

  onUserActivityElsewhere(character: string): void {
    const localAt = localWallClock(this.#now(), this.#zone);
    this.#after(character, () => {
      this.#service.onUserActivityElsewhere(character, localAt);
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
        this.#service.setDormancyConfig(character, dormancyConfigFor(config));
        this.#service.setDreamConfig(character, dreamConfigFor(config));
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
