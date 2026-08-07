import { characterMemoryDir } from "../config/dirs.ts";
import { formatDirectResponse, memoryStatus } from "../memory/markdown_query.ts";
import { MarkdownMemoryStore } from "../memory/markdown_store.ts";
import { internalError } from "./errors.ts";
import type { Args } from "./navigation.ts";

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function openStore(
  configDir: string,
  character: string,
  workspaceRoot: string | undefined,
): Promise<MarkdownMemoryStore> {
  try {
    return await MarkdownMemoryStore.open(characterMemoryDir(configDir, character, workspaceRoot));
  } catch (e) {
    throw internalError(`Failed to open markdown store: ${message(e)}`);
  }
}

export async function memory(
  configDir: string,
  character: string,
  args: Args,
  workspaceRoot?: string | undefined,
): Promise<unknown> {
  const query = asStr(args["query"]);
  return query === undefined || query === ""
    ? await memoryStatusCommand(configDir, character, workspaceRoot)
    : await memoryQueryCommand(configDir, character, query, workspaceRoot);
}

async function memoryStatusCommand(
  configDir: string,
  character: string,
  workspaceRoot: string | undefined,
): Promise<unknown> {
  const store = await openStore(configDir, character, workspaceRoot);
  let status;
  try {
    status = await memoryStatus(store);
  } catch (e) {
    throw internalError(message(e));
  }
  return {
    character,
    entries: status.totalFiles,
    curated_files: status.topicFiles,
    daily_files: status.dailyFiles,
    image_files: status.imageFiles,
  };
}

async function memoryQueryCommand(
  configDir: string,
  character: string,
  query: string,
  workspaceRoot: string | undefined,
): Promise<unknown> {
  const store = await openStore(configDir, character, workspaceRoot);
  let hits;
  try {
    hits = await store.searchText(query);
  } catch (e) {
    throw internalError(`Memory query failed: ${message(e)}`);
  }
  return { character, query, result: formatDirectResponse(query, hits) };
}
