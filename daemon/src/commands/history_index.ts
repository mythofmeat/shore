import { existsSync } from "node:fs";

import { HistoryIndex } from "../memory/history_index.ts";
import type { HistoryIndexProgress } from "../memory/history_index_service.ts";
import type { HistoryIndexResult } from "../protocol/HistoryIndexResult.ts";
import type { IndexBackgroundStatus } from "../protocol/IndexBackgroundStatus.ts";

export interface HistoryIndexSource {
  progressFor: (character: string) => HistoryIndexProgress | undefined;
  noteMutation?: (character: string) => void;
  now?: () => number;
}

export function historyIndexSection(
  source: HistoryIndexSource | undefined,
  character: string,
): HistoryIndexResult | null {
  if (source === undefined) return null;

  const progress = source.progressFor(character);
  if (progress === undefined) return null;

  let messages = 0;
  if (existsSync(progress.indexPath)) {
    try {
      const index = HistoryIndex.open(progress.indexPath);
      try {
        messages = Number(index.metadata("messages") ?? 0);
      } finally {
        index.close();
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const now = (source.now ?? (() => Date.now()))();
  return {
    path: progress.indexPath,
    messages,
    background: backgroundView(progress, now),
  };
}

function backgroundView(progress: HistoryIndexProgress, now: number): IndexBackgroundStatus {
  return {
    failures: progress.failures,
    ...(progress.lastError === undefined ? {} : { last_error: progress.lastError }),
    ...(progress.retryAt > now
      ? { retry_in_secs: Math.ceil((progress.retryAt - now) / 1000) }
      : {}),
  };
}
