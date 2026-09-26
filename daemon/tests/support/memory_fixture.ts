import { join } from "node:path";
import { HISTORY_DB_FILE, HistoryStore } from "../../src/engine/history_store.ts";
import type { ShoreRuntime } from "../../src/runtime.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";

export const cacheFixture: SidecarProvider["generate"] = (request) => Promise.resolve({
  content: "", content_blocks: [], finish_reason: "end_turn", model: request.model,
  usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 100, cache_creation_tokens: 0 },
  timing: { total_ms: 1, time_to_first_token_ms: 1 },
});

export function compactionFixture(cleanup?: AbortSignal): SidecarProvider["stream"] {
  let paused = false;
  let truncated = false;
  let writes = 0;
  let cancelled = false;
  let toolCancelled = false;
  return async function* (request, signal) {
    yield { type: "start", model: request.model };
    yield { type: "thinking", text: "Reviewing the archived conversation" };
    const written = request.messages.at(-1)?.content.some((block) => block.type === "tool_result" && block.tool_use_id === "memory-fixture-write") === true;
    const conversation = JSON.stringify(request.messages);
    if (written && conversation.includes("cancel memory once") && !cancelled) {
      cancelled = true;
      yield { type: "thinking", text: "Waiting for compaction cancellation" };
      const stopped = signal === undefined ? cleanup : cleanup === undefined ? signal : AbortSignal.any([signal, cleanup]);
      await new Promise<void>((resolve) => { if (stopped?.aborted === true) resolve(); else stopped?.addEventListener("abort", () => resolve(), { once: true }); });
      throw new Error("Compaction fixture cancelled");
    }
    if (written && conversation.includes("pause memory once") && !paused) { paused = true; throw new Error("Memory fixture provider temporarily unavailable"); }
    const stop = written && conversation.includes("truncate memory once") && !truncated;
    if (stop) truncated = true;
    if (!written) {
      writes += 1;
      const hold = !toolCancelled && conversation.includes("cancel memory tool once");
      if (hold) toolCancelled = true;
      yield { type: "tool_use", id: "memory-fixture-write", name: "bash", input: { workdir: ".", command: hold
        ? `mkdir -p memory; printf '%s' "$$" > memory/cancel-pid; sleep 60; printf unexpected > memory/cancel-finished`
        : `mkdir -p memory && printf '# Retained fixture\\nMemory write ${String(writes)}\\n' > memory/fixture.md` } };
    } else yield { type: "text", text: stop ? "Incomplete memory summary" : "Memory summary completed" };
    yield { type: "done", content: written ? "Memory summary" : "", finish_reason: written ? stop ? "max_tokens" : "end_turn" : "tool_use", usage: { input_tokens: 12, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
  };
}

export function seedArchivedSegment(runtime: ShoreRuntime, character: string): void {
  const store = HistoryStore.open(join(runtime.registry.globalConfig().dirs.data, HISTORY_DB_FILE));
  try {
    store.putSegment(character, 0, { file: HISTORY_DB_FILE, message_count: 1, compacted_at: "2026-09-01T12:00:00Z", label: "Recovery fixture" }, [{ msg_id: "archived-fixture-message", role: "user", content: "Archived message from an earlier session", content_blocks: [{ type: "text", text: "Archived message from an earlier session" }], images: [], timestamp: "2026-09-01T11:00:00Z" }]);
  } finally { store.close(); }
}
