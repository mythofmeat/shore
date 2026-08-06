/**
 * Joining a chat turn to the autonomy loop.
 *
 * Two halves of one seam. `registrationFor` reads the config sections a
 * character's loop runs on; {@link TurnAutonomyBridge} is what `handler/turn.ts`
 * calls into, and it exists because the two sides disagree about time.
 *
 * # The disagreement
 *
 * {@link TurnAutonomy} is synchronous — a turn asks "should I compact?" and
 * needs the answer before it continues. {@link AutonomyService.register} is not:
 * it reads `autonomy_state.json` off disk and shuts down any runner it is
 * replacing. So the first turn for a character arrives before the loop knows
 * that character exists.
 *
 * Every write is queued behind the registration rather than dropped. The one
 * that cannot be is `shouldCompactNow`, which has to answer *now* and takes a
 * single-flight latch when it says yes — so before registration finishes it
 * says **no**. That is the safe direction: the turn after this one asks again,
 * and a conversation compacts a few turns late. Answering yes would take a
 * latch on a runner that does not exist, which releases never.
 *
 * # Why the seeding moment matters
 *
 * `ensureState` returns true exactly once per character, and that return is the
 * only signal `ensureAndBackfillAutonomy` gets to walk the conversation and
 * seed the activity tracker. Returning true twice re-seeds a heatmap that
 * already has counts in it; returning it zero times leaves a character's
 * activity blank until it has talked for a fortnight.
 */

import type { LoadedConfig } from "../config/loader.ts";
import type { AutonomyRunnerConfig } from "./runner.ts";
import type { HeartbeatClockConfig } from "./heartbeat.ts";
import type { AutonomyService, RegisterCharacter } from "./service.ts";

/**
 * The loop's own settings, read out of the config a character runs under.
 *
 * `[behavior.autonomy]` gates the loop as a whole and its heartbeat;
 * `[memory.compaction]` supplies everything about when a conversation is
 * folded away. Both are read from the *effective* config, so a per-character
 * override reaches its own loop and nobody else's.
 */
export function runnerConfigFor(config: LoadedConfig): AutonomyRunnerConfig {
  const autonomy = config.app.behavior.autonomy;
  const compaction = config.app.memory.compaction;
  return {
    autonomyEnabled: autonomy.enabled,
    heartbeatEnabled: autonomy.heartbeat.enabled,
    compactionEnabled: compaction.enabled,
    minTurns: compaction.min_turns,
    maxTurns: compaction.max_turns,
    idleTriggerSecs: Number(compaction.idle_trigger.asSecs()),
    archiveAfterSecs: Number(compaction.archive_after.asSecs()),
    maxContextTokens: compaction.max_context_tokens,
  };
}

/**
 * The heartbeat clock's bounds.
 *
 * Four durations that each answer a different question, and whose names on the
 * config side say what they are for: how long to wait when the character did
 * not schedule its own wake, how many unanswered ticks before it goes dormant,
 * how much wall-clock silence before the same, and how close to a user message
 * a tick may fire.
 */
export function clockConfigFor(config: LoadedConfig): HeartbeatClockConfig {
  const heartbeat = config.app.behavior.autonomy.heartbeat;
  return {
    defaultIntervalMs: Number(heartbeat.fallback_heartbeat_interval.asMillisExact()),
    maxIdleTicks: heartbeat.dormant_after_heartbeat_turns,
    maxSilentMs: Number(heartbeat.dormant_after_idle_time.asMillisExact()),
    minWakeIntervalMs: Number(heartbeat.minimum_heartbeat_latency.asMillisExact()),
  };
}

/** Everything the loop needs to take up a character. */
export function registrationFor(character: string, config: LoadedConfig): RegisterCharacter {
  return {
    character,
    // The character's own directory under the data root: where
    // `autonomy_state.json` and `heartbeat.jsonl` live.
    data_dir: `${config.dirs.data}/${character}`,
    config: runnerConfigFor(config),
    clock: clockConfigFor(config),
  };
}

/** The slice of {@link AutonomyService} this bridge drives. */
type ServiceSlice = Pick<
  AutonomyService,
  | "register"
  | "backfillActivity"
  | "onUserMessage"
  | "shouldCompactNow"
  | "onCompactionComplete"
  | "onCompactionFailed"
>;

/**
 * `TurnAutonomy`, backed by the real service.
 *
 * Holds one promise per character — the registration in flight — and nothing
 * else. Everything it defers is a notification the loop reads later; the only
 * question it answers immediately is the one a turn cannot wait for.
 */
export class TurnAutonomyBridge {
  readonly #service: ServiceSlice;
  readonly #now: () => number;
  /** Character → its registration. Presence means `ensureState` already fired. */
  readonly #registered = new Map<string, Promise<void>>();

  constructor(service: ServiceSlice, now: () => number = () => Date.now()) {
    this.#service = service;
    this.#now = now;
  }

  /**
   * Take up a character if this is the first turn for it.
   *
   * The map entry is written *before* the await, so a second turn arriving
   * while the first registration is still reading state gets `false` rather
   than starting a second one. Two registrations for one character would have
   * the later replace the earlier, shutting down a runner mid-tick.
   */
  ensureState(character: string, config: LoadedConfig): boolean {
    if (this.#registered.has(character)) return false;

    const pending = this.#service.register(registrationFor(character, config)).catch((e: unknown) => {
      // A registration that failed leaves the character unregistered, and every
      // deferred call below becomes a no-op against a name the loop does not
      // know. Logged rather than thrown: the turn itself is fine, and what is
      // lost is autonomy for one character until the daemon restarts.
      console.warn(`shore: autonomy registration failed for ${character}: ${String(e)}`);
    });
    this.#registered.set(character, pending);
    return true;
  }

  backfillActivity(character: string, timestamps: readonly Date[]): void {
    // Straight after `ensureState` returned true, so this is the call the queue
    // exists for: the registration it is waiting on is the one that just
    // started, and running it early seeds a character the loop has not created.
    const stamps = timestamps.map((t) => t.getTime());
    // The tracker wants the most recent user turn as well as the histogram, and
    // it is not `stamps[stamps.length - 1]`: the walk reads the active
    // conversation first and the archived segments after it, so the list runs
    // newest-block-then-older-blocks rather than in time order. Taking the last
    // element would seed the silence clock from the oldest surviving turn and
    // make a busy character look abandoned.
    const latestUserAt = stamps.length === 0 ? undefined : Math.max(...stamps);
    this.#after(character, () => {
      this.#service.backfillActivity(character, stamps, latestUserAt);
    });
  }

  onUserMessage(character: string, turnCount: number): void {
    // The clock is read now rather than when the queue drains: this is the
    // moment the user spoke, and a timestamp taken after an await is the moment
    // a disk read finished.
    const at = this.#now();
    this.#after(character, () => {
      this.#service.onUserMessage(character, turnCount, at);
    });
  }

  /**
   * The one question that cannot be deferred.
   *
   * Answering `false` for a character still registering costs a compaction that
   * happens one turn later. Answering `true` takes the single-flight latch on a
   * runner that does not exist yet, and nothing releases it.
   */
  shouldCompactNow(character: string, turnCount: number, contextTokens: number): boolean {
    return this.#service.shouldCompactNow(character, turnCount, contextTokens) ?? false;
  }

  onCompactionComplete(character: string, retained: number): void {
    this.#after(character, () => {
      this.#service.onCompactionComplete(character, retained);
    });
  }

  onCompactionFailed(character: string): void {
    this.#after(character, () => {
      this.#service.onCompactionFailed(character);
    });
  }

  /**
   * Run `fn` once the character is registered — immediately if it already is.
   *
   * Sequenced onto the same promise rather than each racing the registration
   * independently, so the loop sees these in the order the turn made them. An
   * `onUserMessage` landing after the `onCompactionComplete` that followed it
   * would restart the idle clock the compaction had just reset.
   */
  #after(character: string, fn: () => void): void {
    const pending = this.#registered.get(character);
    if (pending === undefined) {
      // Nothing registered this character, so there is no loop to tell. Not an
      // error: `ensureState` runs at the top of every turn, and anything
      // reaching here did so without one.
      return;
    }
    this.#registered.set(
      character,
      pending.then(fn).catch((e: unknown) => {
        console.warn(`shore: autonomy update failed for ${character}: ${String(e)}`);
      }),
    );
  }

  /** Resolves when every queued update for `character` has run. Tests use this. */
  async settled(character: string): Promise<void> {
    await this.#registered.get(character);
  }
}
