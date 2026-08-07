/**
 * The `memory` command: what is in the markdown store, or what in it matches.
 *
 * Ported from the `memory` half of `crates/daemon/src/commands/state/memory.rs`,
 * pinned by `tests/commands_fixtures/memory_command_parity.json`. The other
 * half, `compact`, is an LLM round trip and lands separately.
 *
 * # One command, two answers
 *
 * A `query` that is a non-empty string searches; anything else — absent, empty,
 * a number — reports counts. That is one `filter(|s| !s.is_empty())` in the
 * Rust and it is the whole of the routing, so the two shapes stay as two
 * functions here and this one only chooses between them.
 *
 * # Opening the store creates it
 *
 * `MarkdownMemoryStore.open` makes the directory when it is missing, so asking
 * a fresh character for its memory status writes to disk. That is the Rust's,
 * it is what makes the first `memory_write` land somewhere, and the fixture
 * records it per case rather than leaving it as prose.
 *
 * The two failure prefixes are worth keeping apart, and the fixture pins which
 * one each path produces: only `open` says `Failed to open markdown store`, and
 * only the search says `Memory query failed`. A memory path that is a *file*
 * opens successfully — it exists, and it canonicalises — and fails when the
 * listing walks it, so it reports through neither prefix on the status path.
 */

import { characterMemoryDir } from "../config/dirs.ts";
import { formatDirectResponse, memoryStatus } from "../memory/markdown_query.ts";
import { MarkdownMemoryStore } from "../memory/markdown_store.ts";
import { internalError } from "./errors.ts";
import type { Args } from "./navigation.ts";

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Open the character's store, or fail with the prefix only `open` adds. */
async function openStore(configDir: string, character: string): Promise<MarkdownMemoryStore> {
  try {
    return await MarkdownMemoryStore.open(characterMemoryDir(configDir, character));
  } catch (e) {
    throw internalError(`Failed to open markdown store: ${message(e)}`);
  }
}

/**
 * Counts, or hits.
 *
 * The character is the session's — there is no name argument, so this always
 * answers for whoever is talking.
 */
export async function memory(configDir: string, character: string, args: Args): Promise<unknown> {
  const query = asStr(args["query"]);
  return query === undefined || query === ""
    ? await memoryStatusCommand(configDir, character)
    : await memoryQueryCommand(configDir, character, query);
}

/** File counts by bucket. The three always sum to `entries`. */
async function memoryStatusCommand(configDir: string, character: string): Promise<unknown> {
  const store = await openStore(configDir, character);
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

/**
 * A text search, rendered for a person to read.
 *
 * `query` is echoed exactly as it arrived, untrimmed — the tokenizer deals with
 * the whitespace, the echo does not.
 */
async function memoryQueryCommand(
  configDir: string,
  character: string,
  query: string,
): Promise<unknown> {
  const store = await openStore(configDir, character);
  let hits;
  try {
    hits = await store.searchText(query);
  } catch (e) {
    throw internalError(`Memory query failed: ${message(e)}`);
  }
  return { character, query, result: formatDirectResponse(query, hits) };
}
