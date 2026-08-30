import { HistorySearchIndex, withHistoryIndexLock } from "../memory/history_index.ts";
import type { HistoryIndexProgress } from "../memory/history_index_service.ts";
import type { Json } from "./conversation.ts";

export interface HistoryIndexSource {
  progressFor: (character: string) => HistoryIndexProgress | undefined;
  noteMutation?: (character: string) => void;
  noteMemoryWork?: (character: string) => void;
  now?: () => number;
}

export async function historyIndexSection(
  source: HistoryIndexSource | undefined,
  character: string,
): Promise<Json> {
  if (source === undefined) return null;

  const progress = source.progressFor(character);
  if (progress === undefined) return null;

  let view;
  try {
    view = await withHistoryIndexLock(progress.indexPath, async () => {
      const index = HistorySearchIndex.open({
        characterDataDir: progress.characterDataDir,
        path: progress.indexPath,
      });
      try {
        return {
          diagnostics: index.diagnostics(progress.embedder),
          messages: index.selectedMessageCount(),
        };
      } finally {
        index.close();
      }
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const now = (source.now ?? (() => Date.now()))();
  return {
    path: progress.indexPath,
    messages: view.messages,
    chunks: view.diagnostics.total_chunks,
    embedded: view.diagnostics.indexed_chunks,
    pending: view.diagnostics.pending_chunks,
    model: progress.embedder?.modelId ?? null,
    background: backgroundView(progress, now),
  };
}

function backgroundView(progress: HistoryIndexProgress, now: number): Json {
  return {
    registered: progress.embedder !== undefined,
    failures: progress.failures,
    ...(progress.lastError === undefined ? {} : { last_error: progress.lastError }),
    ...(progress.retryAt > now
      ? { retry_in_secs: Math.ceil((progress.retryAt - now) / 1000) }
      : {}),
  };
}
