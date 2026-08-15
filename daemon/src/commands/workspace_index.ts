import { workspaceIndexStats } from "../memory/workspace_index.ts";
import type { WorkspaceIndexProgress } from "../memory/workspace_index_service.ts";
import type { Json } from "./conversation.ts";

export interface WorkspaceIndexSource {
  indexPathFor: (character: string) => string | undefined;
  progressFor: (character: string) => WorkspaceIndexProgress | undefined;
  now?: () => number;
}

export async function workspaceIndexSection(
  source: WorkspaceIndexSource | undefined,
  character: string,
): Promise<Json | null> {
  if (source === undefined) return null;

  const indexPath = source.indexPathFor(character);
  if (indexPath === undefined) return null;

  let stats;
  try {
    stats = await workspaceIndexStats(indexPath);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const progress = source.progressFor(character);
  const now = (source.now ?? (() => Date.now()))();

  return {
    path: indexPath,
    files: stats.files,
    embedded: stats.embedded,
    pending: progress?.pending ?? stats.pending,
    skipped: stats.skipped,
    skip_reasons: stats.skipReasons,
    vectors: stats.vectors,
    models: stats.models,
    bytes: stats.bytes,
    last_indexed_at: stats.lastIndexedAt ?? null,
    background: backgroundView(progress, now),
  };
}

function backgroundView(progress: WorkspaceIndexProgress | undefined, now: number): Json {
  if (progress === undefined) return { registered: false };
  return {
    registered: true,
    swept: progress.sweptAt !== undefined,
    failures: progress.failures,
    ...(progress.lastError === undefined ? {} : { last_error: progress.lastError }),
    ...(progress.retryAt > now
      ? { retry_in_secs: Math.ceil((progress.retryAt - now) / 1000) }
      : {}),
  };
}
