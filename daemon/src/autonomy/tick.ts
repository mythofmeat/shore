export type CompactionReason =
  | "max_turns"
  | "idle";

export interface TickInputs {
  readonly autonomyEnabled: boolean;
  readonly paused: boolean;
  readonly heartbeatEnabled: boolean;

  readonly compactionEnabled: boolean;
  readonly compactionTriggered: boolean;
  readonly deepArchiveDone: boolean;
  readonly activeTurnCount: number;
  readonly minTurns: number;
  readonly maxTurns: number;
  readonly idleSecs: number;
  readonly idleTriggerSecs: number;
  readonly archiveAfterSecs: number;

}

export interface TickDecision {
  readonly heartbeatMayTick: boolean;
  readonly compaction: CompactionReason | undefined;
  readonly deepArchive: boolean;
}

export function tickDecision(i: TickInputs): TickDecision {
  const compaction = compactionReason(i);

  return {
    heartbeatMayTick: i.autonomyEnabled && i.heartbeatEnabled && !i.paused,
    compaction,
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

export function compactionReason(i: TickInputs): CompactionReason | undefined {
  if (!(i.autonomyEnabled && i.compactionEnabled && !i.compactionTriggered)) {
    return undefined;
  }
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

export function backgroundRetryDelayMs(failureCount: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 6);
  return Math.min(60_000 * 2 ** exponent, 3_600_000);
}
