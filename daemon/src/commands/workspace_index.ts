import { workspaceIndexStats } from "../memory/workspace_index.ts";
import type { WorkspaceIndexProgress } from "../memory/workspace_index_service.ts";
import { invalidRequest, internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

export interface WorkspaceIndexContext {
  characterName: string | undefined;
  indexPathFor: (character: string) => string | undefined;
  progressFor: (character: string) => WorkspaceIndexProgress | undefined;
  characters: () => string[];
  now?: () => number;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export async function workspaceIndex(ctx: WorkspaceIndexContext, args: Args): Promise<Json> {
  const requested = asStr(args["character"]) ?? ctx.characterName;
  if (requested === undefined) throw invalidRequest("no character selected");

  const known = ctx.characters();
  if (known.length > 0 && !known.includes(requested)) {
    throw invalidRequest(`unknown character '${requested}'`);
  }

  const indexPath = ctx.indexPathFor(requested);
  if (indexPath === undefined) {
    return { character: requested, enabled: false };
  }

  let stats;
  try {
    stats = await workspaceIndexStats(indexPath);
  } catch (e) {
    throw internalError(
      `workspace index query failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const progress = ctx.progressFor(requested);
  const now = (ctx.now ?? (() => Date.now()))();

  return {
    character: requested,
    enabled: true,
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

function backgroundView(
  progress: WorkspaceIndexProgress | undefined,
  now: number,
): Json {
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
