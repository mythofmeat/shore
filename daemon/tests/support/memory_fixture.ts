import { join } from "node:path";
import { HISTORY_DB_FILE, HistoryStore } from "../../src/engine/history_store.ts";
import type { ShoreRuntime } from "../../src/runtime.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";

export const cacheFixture: SidecarProvider["generate"] = (request) => Promise.resolve({
  content: "", content_blocks: [], finish_reason: "end_turn", model: request.model,
  usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 100, cache_creation_tokens: 0 },
  timing: { total_ms: 1, time_to_first_token_ms: 1 },
});

export function seedArchivedSegment(runtime: ShoreRuntime, character: string): void {
  const store = HistoryStore.open(join(runtime.registry.globalConfig().dirs.data, HISTORY_DB_FILE));
  try {
    store.putSegment(character, 0, { file: HISTORY_DB_FILE, compacted_at: "2026-09-01T12:00:00Z", label: "Recovery fixture" }, [{ msg_id: "archived-fixture-message", role: "user", content: "Archived message from an earlier session", content_blocks: [{ type: "text", text: "Archived message from an earlier session" }], images: [], timestamp: "2026-09-01T11:00:00Z" }]);
  } finally { store.close(); }
}
