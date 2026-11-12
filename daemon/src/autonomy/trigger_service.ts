import { join, resolve } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { characterDataDir } from "../config/dirs.ts";
import { hostZone } from "../ledger/zoned.ts";
import { shoreLog } from "../log.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { localWallClock } from "./activity.ts";
import { lastSeen, presence, type Presence } from "./presence.ts";
import type { AutonomyService } from "./service.ts";
import { runCheck } from "./trigger_check.ts";
import { CharacterTriggers, type TriggerSettings, type TriggersView } from "./trigger_loop.ts";
import { TRIGGERS_FILE } from "./triggers.ts";

const TRIGGER_TICK_MS = 30_000;

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

export interface TriggerServiceDeps {
  autonomy: Pick<AutonomyService, "characters" | "status" | "wakeFor" | "activityStats" | "onEvents">;
  config(character: string): LoadedConfig;
}

export interface CheckFacts {
  facts: Record<string, unknown>;
  env: Record<string, string>;
}

export interface UserFacts {
  lastUserAt: number | undefined;
  lastSeenAt: number | undefined;
  status: Presence | undefined;
}

export function checkFacts(now: number, user: UserFacts, activity: Record<string, unknown> | undefined): CheckFacts {
  const at = new Date(now).toISOString();
  const last = user.lastUserAt === undefined ? undefined : new Date(user.lastUserAt).toISOString();
  const quiet = user.lastUserAt === undefined ? undefined : Math.floor((now - user.lastUserAt) / 1000);
  const seen = user.lastSeenAt === undefined ? undefined : new Date(user.lastSeenAt).toISOString();
  const status = user.status === undefined || user.status.status === "" ? undefined : user.status;
  return {
    facts: {
      now: at,
      user: { last_message_at: last ?? null, quiet_secs: quiet ?? null, last_seen_at: seen ?? null, status: status?.status ?? null, status_set_at: status?.set_at ?? null },
      activity: activity ?? null,
    },
    env: {
      SHORE_NOW: at,
      SHORE_USER_LAST_MESSAGE_AT: last ?? "",
      SHORE_USER_QUIET_SECS: quiet === undefined ? "" : String(quiet),
      SHORE_USER_LAST_SEEN_AT: seen ?? "",
      SHORE_USER_STATUS: status?.status ?? "",
      SHORE_USER_STATUS_SET_AT: status?.set_at ?? "",
    },
  };
}

export function triggerSettings(autonomy: LoadedConfig["app"]["behavior"]["autonomy"]): TriggerSettings {
  return {
    enabled: autonomy.enabled && autonomy.triggers.enabled,
    wakeCooldownMs: autonomy.triggers.wake_cooldown.asMillis(),
    checkLimitMs: autonomy.triggers.check_time_limit.asMillis(),
    maxWakeLimitMs: autonomy.triggers.max_wake_limit.asMillis(),
    off: autonomy.triggers.off,
  };
}

export class TriggerService {
  readonly #deps: TriggerServiceDeps;
  readonly #now = (): number => Date.now();
  readonly #stop = new AbortController();
  readonly #triggers = new Map<string, CharacterTriggers>();

  constructor(deps: TriggerServiceDeps) {
    this.#deps = deps;
    deps.autonomy.onEvents((character) => ({
      wakeDone: (names) => { void this.#for(character).finished(names); },
      dreamDone: () => { void this.#for(character).dreamDone(); },
    }));
  }

  async tick(): Promise<void> {
    await Promise.all(this.#deps.autonomy.characters().map(async (character) => { await this.#for(character).tick(); }));
  }

  async userBack(character: string): Promise<void> {
    const last = this.#deps.autonomy.status(character)?.last_user_at;
    if (last !== undefined) await this.#for(character).userBack(this.#now() - last);
  }

  async statusChanged(): Promise<void> {
    await Promise.all(this.#deps.autonomy.characters().map(async (character) => { await this.#for(character).statusChanged(); }));
  }

  view(character: string): TriggersView {
    return this.#for(character).view();
  }

  stop(): void {
    this.#stop.abort(new Error("Shore is shutting down"));
  }

  #for(character: string): CharacterTriggers {
    const known = this.#triggers.get(character);
    if (known !== undefined) return known;
    const { autonomy } = this.#deps;
    const config = (): LoadedConfig => this.#deps.config(character);
    const made = new CharacterTriggers({
      characterDir: characterDataDir(config().dirs.data, character),
      timeZone: hostZone(),
      now: this.#now,
      settings: () => triggerSettings(config().app.behavior.autonomy),
      dormant: () => autonomy.status(character)?.heartbeat_state !== "Active",
      lastUserAt: () => autonomy.status(character)?.last_user_at,
      readFile: async () => {
        const workspace = characterWorkspace(config(), character);
        const [read] = await workspace.call("readFiles", { paths: [join(resolve(workspace.dir), TRIGGERS_FILE)] });
        if (read === undefined || "data" in read) return read === undefined ? undefined : Buffer.from(read.data, "base64").toString("utf8");
        if (ABSENT.has(read.error.code ?? "")) return undefined;
        throw new Error(read.error.message);
      },
      runCheck: async (trigger, limitMs) => {
        const now = this.#now();
        const stats = autonomy.activityStats(character, localWallClock(now));
        const activity = stats === undefined ? undefined : {
          messages: stats.messageCount,
          share_of_messages_by_local_hour: stats.stats.pooledHourHistogram,
          median_secs_between_sessions: stats.stats.medianSessionGap ?? null,
        };
        return await runCheck({
          workspace: characterWorkspace(config(), character),
          character,
          trigger: trigger.name,
          command: trigger.check ?? "",
          ...checkFacts(now, { lastUserAt: autonomy.status(character)?.last_user_at, lastSeenAt: lastSeen(config().dirs.data), status: presence(config().dirs.data) }, activity),
          limitMs,
          signal: this.#stop.signal,
        });
      },
      wake: (firing) => { autonomy.wakeFor(character, firing); },
    });
    this.#triggers.set(character, made);
    return made;
  }
}

export function startTriggerTimer(service: TriggerService, everyMs: number = TRIGGER_TICK_MS): { stop: () => void } {
  const timer = setInterval(() => {
    void service.tick().catch((error: unknown) => {
      shoreLog.error(`shore: looking at triggers failed: ${String(error)}`);
    });
  }, everyMs);
  return { stop: () => { clearInterval(timer); } };
}
