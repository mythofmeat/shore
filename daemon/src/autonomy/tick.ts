export type CompactionReason =
  | "max_turns"
  | "idle";

export interface TickInputs {
  readonly autonomyEnabled: boolean;

  readonly compactionEnabled: boolean;
  readonly compactionTriggered: boolean;
  readonly deepArchiveDone: boolean;
  readonly activeTurnCount: number;
  readonly minTurns: number;
  readonly idleSecs: number;
  readonly idleTriggerSecs: number;
  readonly archiveAfterSecs: number;

}

export interface TickDecision {
  readonly wakesMayRun: boolean;
  readonly compaction: CompactionReason | undefined;
  readonly deepArchive: boolean;
}

export function tickDecision(i: TickInputs): TickDecision {
  const compaction = compactionReason(i);

  return {
    wakesMayRun: i.autonomyEnabled,
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

function compactionReason(i: TickInputs): CompactionReason | undefined {
  if (!(i.autonomyEnabled && i.compactionEnabled && !i.compactionTriggered)) {
    return undefined;
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

export interface DayWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface DreamInputs {
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly foreground: boolean;
  readonly now: number;
  readonly localMinute: number;
  readonly lastDreamAt: number | undefined;
  readonly everyMs: number;
  readonly window: DayWindow | undefined;
  readonly quietMs: number;
  readonly idleAfterMs: number;
  readonly turnsSince: number;
  readonly minTurns: number;
  readonly retryAt: number | undefined;
}

export function inDayWindow(window: DayWindow, minute: number): boolean {
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute;
}

export function dreamDue(i: DreamInputs): boolean {
  if (i.foreground) return false;
  if (i.retryAt !== undefined && i.now < i.retryAt) return false;
  if (i.forced) return true;
  if (!i.enabled) return false;
  if (i.lastDreamAt !== undefined && i.now - i.lastDreamAt < i.everyMs) return false;
  if (i.window !== undefined && !inDayWindow(i.window, i.localMinute)) return false;
  return i.quietMs >= i.idleAfterMs && i.turnsSince >= i.minTurns;
}

export function dreamRetryDelayMs(failures: number, everyMs: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 6);
  return Math.min(3_600_000 * 2 ** exponent, Math.max(everyMs, 3_600_000));
}
