import { readCharacterState, writeCharacterState } from "../../storage/store.ts";
import type { DreamOutcome } from "../../protocol/DreamOutcome.ts";
import type { DreamRecord } from "../../protocol/DreamRecord.ts";
import type { DreamStop } from "../../protocol/DreamStop.ts";

const RECORDS_STATE = "dreams.json";

const RECORDS_KEPT = 20;

export interface StoredDream extends DreamRecord {
  head?: string;
}

const OUTCOMES: readonly DreamOutcome[] = ["finished", "cut_off", "failed", "interrupted"];

const STOPS: readonly DreamStop[] = ["time_limit", "round_limit", "shutdown", "budget"];

function storedDream(raw: unknown): StoredDream | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const { started_at, ended_at, outcome, conversations, commits, files } = o;
  if (typeof started_at !== "string" || typeof ended_at !== "string") return undefined;
  if (!OUTCOMES.includes(outcome as DreamOutcome)) return undefined;
  if (typeof conversations !== "number" || typeof commits !== "number" || !Array.isArray(files)) return undefined;
  return {
    started_at,
    ended_at,
    outcome: outcome as DreamOutcome,
    conversations,
    commits,
    files: files.filter((file): file is string => typeof file === "string"),
    ...(typeof o.pushed === "boolean" ? { pushed: o.pushed } : {}),
    ...(typeof o.summary === "string" ? { summary: o.summary } : {}),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
    ...(STOPS.includes(o.stopped_by as DreamStop) ? { stopped_by: o.stopped_by as DreamStop } : {}),
    ...(typeof o.head === "string" ? { head: o.head } : {}),
  };
}

export function dreamRecords(characterDataDir: string): StoredDream[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readCharacterState(characterDataDir, RECORDS_STATE) ?? "[]");
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.flatMap((raw) => storedDream(raw) ?? []) : [];
}

export function lastDream(characterDataDir: string): StoredDream | undefined {
  return dreamRecords(characterDataDir).at(-1);
}

export function lastFinishedDream(characterDataDir: string): StoredDream | undefined {
  return dreamRecords(characterDataDir).findLast((record) => record.outcome === "finished");
}

export function appendDreamRecord(characterDataDir: string, record: StoredDream): void {
  const all = [...dreamRecords(characterDataDir), record];
  const kept = all.slice(-RECORDS_KEPT);
  const finished = all.findLast((each) => each.outcome === "finished");
  const anchored = finished === undefined || kept.includes(finished) ? kept : [finished, ...kept.slice(1)];
  writeCharacterState(characterDataDir, RECORDS_STATE, JSON.stringify(anchored));
}

export function publicRecord(record: StoredDream): DreamRecord {
  const { head: _head, ...shown } = record;
  return shown;
}
