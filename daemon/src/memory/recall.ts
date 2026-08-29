import type { LoadedConfig } from "../config/loader.ts";
import type { MemoryRecallEntry } from "../diagnostics.ts";
import type { Message } from "../engine/types.ts";
import type { CallStore } from "../call_store.ts";
import { shoreLog } from "../log.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

const MESSAGE_CHARS = 1_200;
const QUERY_CHARS = 4_000;
const MEMORY_CHARS = 600;

export interface MemoryRecallDiagnostics {
  memory_recall: { push: (entry: MemoryRecallEntry) => void };
}

export interface MemoryRecallRun {
  config: LoadedConfig;
  character: string;
  messages: readonly Message[];
  signal?: AbortSignal | undefined;
  rid?: string | undefined;
}

export interface MemoryRecallRunner {
  run(input: MemoryRecallRun): Promise<string | undefined>;
}

export const RECALL_TRANSCRIPT_SOURCE = "memory_recall";

export interface MemoryRecallDeps {
  mcpRegistry: Pick<McpRegistry, "call">;
  diagnostics: MemoryRecallDiagnostics;
  callStore?: Pick<CallStore, "recordTranscript"> | undefined;
  now?: (() => string) | undefined;
  monotonicMs?: (() => number) | undefined;
}

export interface RecalledMemory {
  text: string;
  occurred_at?: string | undefined;
}

export function memoryRecallRunner(deps: MemoryRecallDeps): MemoryRecallRunner {
  return {
    run: async (input) => await runMemoryRecall(input, deps),
  };
}

export async function runMemoryRecall(
  input: MemoryRecallRun,
  deps: MemoryRecallDeps,
): Promise<string | undefined> {
  const recall = input.config.app.memory.recall;
  if (recall.mode === "off") return undefined;

  const now = deps.now ?? (() => new Date().toISOString());
  const clock = deps.monotonicMs ?? Date.now;
  const base = {
    timestamp: now(),
    ...(input.rid === undefined ? {} : { rid: input.rid }),
    character: input.character,
  };

  const query = recallQuery(input.messages, recall.recent_messages);
  if (query === "") {
    deps.diagnostics.memory_recall.push({ ...base, status: "no_query", recalled: 0, elapsed_ms: 0 });
    return undefined;
  }

  const started = clock();
  try {
    const raw = await deps.mcpRegistry.call(
      `mcp__${recall.server}__${recall.tool}`,
      { query, max_tokens: recall.max_tokens },
      input.signal,
    );
    const memories = parseRecallResult(raw).slice(0, recall.max_memories);
    const status = memories.length === 0 ? "no_match" : "recalled";
    const elapsed = clock() - started;
    deps.diagnostics.memory_recall.push({
      ...base,
      status,
      recalled: memories.length,
      elapsed_ms: elapsed,
    });
    keepTranscript(deps, input.character, {
      status,
      query,
      elapsed_ms: elapsed,
      memories: memories.map((memory) => memory.text),
    });
    return memories.length === 0 ? undefined : formatMemories(memories);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const elapsed = clock() - started;
    deps.diagnostics.memory_recall.push({
      ...base,
      status: "failed",
      recalled: 0,
      elapsed_ms: elapsed,
      error: message,
    });
    keepTranscript(deps, input.character, {
      status: "failed",
      query,
      elapsed_ms: elapsed,
      memories: [],
      error: message,
    });
    return undefined;
  }
}

interface RecallTranscript {
  status: string;
  query: string;
  elapsed_ms: number;
  memories: string[];
  error?: string;
}

function keepTranscript(
  deps: MemoryRecallDeps,
  character: string,
  entry: RecallTranscript,
): void {
  const store = deps.callStore;
  if (store === undefined) return;
  try {
    store.recordTranscript({
      ts: new Date(),
      source: RECALL_TRANSCRIPT_SOURCE,
      character,
      call_type: RECALL_TRANSCRIPT_SOURCE,
      iteration: 0,
      model: null,
      provider: null,
      finish_reason: entry.status,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      entry_json: JSON.stringify(entry),
    });
  } catch (e) {
    shoreLog.warn(`shore: failed to record a memory recall transcript: ${String(e)}`);
  }
}

export function recallQuery(messages: readonly Message[], limit: number): string {
  const recent = messages
    .filter((message) => message.content.trim() !== "")
    .slice(-limit)
    .map((message) => truncate(message.content.trim(), MESSAGE_CHARS));
  return truncate(recent.join("\n\n"), QUERY_CHARS);
}

export function parseRecallResult(raw: unknown): RecalledMemory[] {
  const payload = typeof raw === "string" ? safeParse(raw) : raw;
  if (!isRecord(payload)) return [];
  const entries = payload["results"] ?? payload["memories"];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = entry["text"];
    if (typeof text !== "string" || text.trim() === "") return [];
    const occurredAt = entry["occurred_at"] ?? entry["occurred_start"];
    return [{
      text: truncate(text.trim(), MEMORY_CHARS),
      ...(typeof occurredAt === "string" ? { occurred_at: occurredAt } : {}),
    }];
  });
}

export function formatMemories(memories: readonly RecalledMemory[]): string {
  return memories
    .map((memory) => {
      const day = memory.occurred_at?.slice(0, 10);
      return day === undefined ? `- ${memory.text}` : `- ${memory.text} (said ${day})`;
    })
    .join("\n");
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}
