/**
 * What an autonomy tick may do, decided from numbers alone.
 *
 * Every loop of the autonomy manager asks the same four questions: may the
 * heartbeat run, should the active conversation be compacted, should what is
 * left of it be archived, and is it quiet enough to dream. This answers all
 * four together, because they are not independent — compaction and the deep
 * archive share a latch and must not both fire against one conversation.
 *
 * Ported from `crates/daemon/src/autonomy/manager.rs` and pinned against it by
 * `tests/tick_parity.test.ts`, which replays a sweep of input combinations
 * recorded from the Rust.
 *
 * The decision is deliberately stateless: it reads no clock, holds no lock,
 * and changes nothing. Everything it depends on arrives in {@link TickInputs},
 * and everything it concludes leaves in {@link TickDecision}. Acting on the
 * conclusion — taking the latch, running the clock, writing the log line — is
 * the caller's, because those mutate and a decision that mutates cannot be
 * replayed against another implementation.
 */

/** Why compaction fired. */
export type CompactionReason =
  /** The active conversation grew past `max_turns`. */
  | "max_turns"
  /** It has been quiet for `idle_trigger`, with enough turns to be worth it. */
  | "idle";

/**
 * Everything a tick's triggers depend on.
 *
 * The units are not uniform, and that is deliberate. Compaction compares whole
 * seconds, truncating both sides; dreaming compares milliseconds. Those two
 * roundings disagree on any threshold carrying a fraction of a second, so
 * config validation rejects that range outright (#15) — the units stay as each
 * trigger reads them, and no configurable value can tell them apart.
 */
export interface TickInputs {
  readonly autonomyEnabled: boolean;
  readonly paused: boolean;
  readonly heartbeatEnabled: boolean;

  readonly compactionEnabled: boolean;
  /** Already fired for this idle period; the single-flight latch. */
  readonly compactionTriggered: boolean;
  /** The deep archive already ran for this idle period. */
  readonly deepArchiveDone: boolean;
  readonly activeTurnCount: number;
  readonly minTurns: number;
  readonly maxTurns: number;
  /** Since the last message activity, truncated to seconds. */
  readonly idleSecs: number;
  readonly idleTriggerSecs: number;
  readonly archiveAfterSecs: number;

}

/** What a tick may do, before anything is done about it. */
export interface TickDecision {
  /** Whether the heartbeat clock gets to run at all this tick. The clock's own
   *  decision is separate, and mutates, so it stays with the clock. */
  readonly heartbeatMayTick: boolean;
  readonly compaction: CompactionReason | undefined;
  readonly deepArchive: boolean;
}

/**
 * The whole per-tick trigger decision, as a function of the numbers.
 *
 * Compaction and the deep archive are mutually exclusive: they share one
 * single-flight latch, and running both against the same conversation would
 * have the second work from what the first had already archived. Compaction
 * wins, because it is the trigger with a turn threshold behind it — the deep
 * archive exists for the short conversations the idle trigger never picks up.
 */
export function tickDecision(i: TickInputs): TickDecision {
  const compaction = compactionReason(i);

  return {
    heartbeatMayTick: i.autonomyEnabled && i.heartbeatEnabled && !i.paused,
    compaction,
    // Not `compaction === undefined` alone: a latch taken on an earlier tick
    // also suppresses this one, and in that case nothing fires now to notice.
    deepArchive:
      i.autonomyEnabled &&
      i.compactionEnabled &&
      i.archiveAfterSecs > 0 &&
      compaction === undefined &&
      !i.compactionTriggered &&
      !i.deepArchiveDone &&
      i.idleSecs >= i.archiveAfterSecs,
  };
}

/**
 * Which compaction trigger, if either, this tick's numbers satisfy.
 *
 * A zero threshold is an off switch in every case, not an always-on one — which
 * is what a bare `>=` against an unset config would give.
 */
export function compactionReason(i: TickInputs): CompactionReason | undefined {
  if (!(i.autonomyEnabled && i.compactionEnabled && !i.compactionTriggered)) {
    return undefined;
  }
  // A conversation still under `min_turns` is too short to be worth compacting
  // however far past `max_turns` it is, which can only happen when the two are
  // configured out of order.
  if (i.maxTurns > 0 && i.activeTurnCount >= i.maxTurns && i.activeTurnCount >= i.minTurns) {
    return "max_turns";
  }
  if (
    i.activeTurnCount >= i.minTurns &&
    i.idleTriggerSecs > 0 &&
    i.idleSecs >= i.idleTriggerSecs
  ) {
    return "idle";
  }
  return undefined;
}

/**
 * How long to wait before retrying a failed background job.
 *
 * Doubles from a minute, capping at an hour — so a persistently failing dream
 * settles into hourly retries rather than either giving up or spinning.
 */
export function backgroundRetryDelayMs(failureCount: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 6);
  return Math.min(60_000 * 2 ** exponent, 3_600_000);
}
