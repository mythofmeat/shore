import type { LoadedConfig } from "../config/loader.ts";
import type { MemoryRecallQueryFrom } from "../config/app.ts";
import type { MemoryRecallEntry } from "../diagnostics.ts";
import type { Message } from "../engine/types.ts";
import type { CallStore } from "../call_store.ts";
import { shoreLog } from "../log.ts";
import type { MemoryBackend } from "./backend.ts";

const MESSAGE_CHARS = 1_200;
const QUERY_CHARS = 4_000;
const MEMORY_CHARS = 600;
const TRANSCRIPT_RESULTS = 12;

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

export const RECALL_TOOL = "recall";

export interface MemoryRecallDeps {
  backend: (character: string) => MemoryBackend | undefined;
  diagnostics: MemoryRecallDiagnostics;
  callStore?: Pick<CallStore, "recordTranscript"> | undefined;
  now?: (() => string) | undefined;
  monotonicMs?: (() => number) | undefined;
}

export interface RecalledMemory {
  text: string;
  occurred_at?: string | undefined;
  id?: string | undefined;
  type?: string | undefined;
  scores?: RecallScores | undefined;
}

export interface RecallScores {
  final?: number | null | undefined;
  reranker?: number | null | undefined;
  semantic?: number | null | undefined;
  keyword?: number | null | undefined;
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

  const query = recallQuery(input.messages, recall.recent_messages, recall.query_from);
  if (query === "") {
    deps.diagnostics.memory_recall.push({ ...base, status: "no_query", recalled: 0, elapsed_ms: 0 });
    return undefined;
  }

  const backend = deps.backend(input.character);
  if (backend === undefined) {
    deps.diagnostics.memory_recall.push({
      ...base,
      status: "failed",
      recalled: 0,
      elapsed_ms: 0,
      error: "memory backend is not configured",
    });
    return undefined;
  }

  const started = clock();
  const deadline = AbortSignal.timeout(recall.timeout.asMillis());
  const signal = input.signal === undefined
    ? deadline
    : AbortSignal.any([input.signal, deadline]);
  const queryTimestamp = latestUserTimestamp(input.messages);
  try {
    const raw = await settleBeforeAbort(
      backend.call(
        RECALL_TOOL,
        {
          query,
          max_tokens: recall.max_tokens,
          ...(queryTimestamp === undefined ? {} : { query_timestamp: queryTimestamp }),
        },
        signal,
      ),
      signal,
    );
    const results = parseRecallResult(raw);
    const memories = results.slice(0, recall.max_memories);
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
      query_from: recall.query_from,
      ...(queryTimestamp === undefined ? {} : { query_timestamp: queryTimestamp }),
      elapsed_ms: elapsed,
      returned: results.length,
      injected: memories.length,
      results: results.slice(0, TRANSCRIPT_RESULTS),
      results_truncated: results.length > TRANSCRIPT_RESULTS,
      memories: memories.map((memory) => memory.text),
    });
    return memories.length === 0 ? undefined : formatMemories(memories);
  } catch (error) {
    const message = deadline.aborted && input.signal?.aborted !== true
      ? `memory recall timed out after ${recall.timeout.toString()}`
      : error instanceof Error ? error.message : String(error);
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
      query_from: recall.query_from,
      ...(queryTimestamp === undefined ? {} : { query_timestamp: queryTimestamp }),
      elapsed_ms: elapsed,
      returned: 0,
      injected: 0,
      results: [],
      results_truncated: false,
      memories: [],
      error: message,
    });
    return undefined;
  }
}

interface RecallTranscript {
  status: string;
  query: string;
  query_from: MemoryRecallQueryFrom;
  query_timestamp?: string;
  elapsed_ms: number;
  returned: number;
  injected: number;
  results: RecalledMemory[];
  results_truncated: boolean;
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

export function recallQuery(
  messages: readonly Message[],
  limit: number,
  from: MemoryRecallQueryFrom = "user",
): string {
  if (from === "user") {
    const content = latestUserMessage(messages)?.content.trim() ?? "";
    return truncate(content, MESSAGE_CHARS);
  }
  const eligible = messages.filter((message) => message.content.trim() !== "");
  const recent = eligible.slice(-limit)
    .map((message) => truncate(message.content.trim(), MESSAGE_CHARS));
  return truncate(recent.join("\n\n"), QUERY_CHARS);
}

function latestUserTimestamp(messages: readonly Message[]): string | undefined {
  return latestUserMessage(messages)?.timestamp;
}

function latestUserMessage(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return message;
  }
  return undefined;
}

function settleBeforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
    const id = entry["id"];
    const type = entry["type"] ?? entry["fact_type"];
    const scores = parseRecallScores(entry["scores"]);
    return [{
      text: truncate(text.trim(), MEMORY_CHARS),
      ...(typeof occurredAt === "string" ? { occurred_at: occurredAt } : {}),
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof type === "string" ? { type } : {}),
      ...(scores === undefined ? {} : { scores }),
    }];
  });
}

function parseRecallScores(raw: unknown): RecallScores | undefined {
  if (!isRecord(raw)) return undefined;
  const scores: RecallScores = {};
  for (const key of ["final", "reranker", "semantic", "keyword"] as const) {
    const value = raw[key];
    if (value === null || (typeof value === "number" && Number.isFinite(value))) {
      scores[key] = value;
    }
  }
  return Object.keys(scores).length === 0 ? undefined : scores;
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
