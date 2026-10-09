import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testTmp } from "./support/tmp.ts";
import { writeState, readState } from "../src/storage/store.ts";
import { readBook, writeBook } from "../src/llm/providers/agent_sessions.ts";
import { mergeToolLoopMessages } from "../src/engine/merge.ts";
import type { Message } from "../src/engine/types.ts";
import { applyDotenv } from "../src/config/dotenv.ts";
import { loadConfig } from "../src/config/loader.ts";
import { setTestEnv, restoreTestEnv } from "./support/env.ts";
import { applySubscriptionProviders } from "../src/runtime.ts";
import { ProviderRegistry, DEFAULT_SUBSCRIPTION_PROVIDERS } from "../src/config/providers.ts";
import { Ledger, setSubscriptionProviders } from "../src/ledger/store.ts";
import { setNanoGptSubscriptionCacheDir } from "../src/ledger/record.ts";
import type { CharacterRegistry } from "../src/characters.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { eventMatchesSession } from "../src/swp/routing.ts";

test("a restored legacy file cannot overwrite authoritative database state", async () => {
  const root = await mkdtemp(testTmp("legacy-conflict-"));
  await mkdir(join(root, "ada"));
  writeState(root, "ada/state", "new DB content", "ada");
  await writeFile(join(root, "ada/state"), "old restored file");
  expect(readState(root, "ada/state")).toBe("new DB content");
  expect(readState(root, "ada/state")).toBe("new DB content");
});

test("a restored SDK book cannot restore sessions that were deliberately removed", async () => {
  const root = await mkdtemp(testTmp("book-conflict-"));
  const path = join(root, "sessions.json");
  writeBook(path, {});
  await writeFile(path, JSON.stringify({ old: { sessionId: "stale", entries: [] } }));
  expect(readBook(path)).toEqual({});
});

test("history keeps generated images from every assistant round and deduplicates them", () => {
  const message = (id: string, blocks: Message["content_blocks"], images: Message["images"] = []): Message => ({
    msg_id: id, role: "assistant", content: "", content_blocks: blocks, images,
    timestamp: "2026-09-10T00:00:00Z",
  });
  const picture = { path: "/images/generated.png", caption: "picture" };
  const merged = mergeToolLoopMessages([
    message("tool", [{ type: "tool_use", id: "image", name: "generate_image", input: {} }], [picture]),
    { ...message("result", [{ type: "tool_result", tool_use_id: "image", content: "ok" }]), role: "user" },
    message("final", [{ type: "text", text: "Here it is" }]),
  ]);
  expect(merged[0]?.images).toEqual([picture]);
});

test("dotenv removal restores the inherited value and deletes file-only keys", async () => {
  const root = await mkdtemp(testTmp("dotenv-removal-"));
  const path = join(root, ".env");
  const target: Record<string, string | undefined> = { INHERITED: "shell" };
  await writeFile(path, "INHERITED=file\nFILE_ONLY=old\n");
  applyDotenv(path, target);
  await writeFile(path, "");
  applyDotenv(path, target);
  expect(target).toEqual({ INHERITED: "shell" });
});

test("invalid config reload does not adopt candidate environment values", async () => {
  const root = await mkdtemp(testTmp("dotenv-invalid-"));
  const path = join(root, "config.toml");
  setTestEnv("SHORE_RELIABILITY_ENV", "running");
  try {
    await writeFile(join(root, ".env"), "SHORE_RELIABILITY_ENV=candidate\n");
    await writeFile(path, "[invalid");
    expect(() => loadConfig(path)).toThrow();
    expect(process.env["SHORE_RELIABILITY_ENV"]).toBe("running");
  } finally { restoreTestEnv(); }
});

test("subscription accounting follows each character regardless of enumeration order", async () => {
  const root = await mkdtemp(testTmp("subscription-scopes-"));
  const global = loadConfig(join(root, "config.toml"));
  global.dirs = { config: root, data: root, cache: root, runtime: root };
  const configs = new Map([true, false].map((subscription) => [subscription ? "sub" : "paid", {
    ...global, providers: ProviderRegistry.fromSection({ audit: { subscription } }),
  }]));
  const ledger = Ledger.create(join(root, "shore.db"));
  try {
    for (const names of [["paid", "sub"], ["sub", "paid"]]) {
      applySubscriptionProviders({
        globalConfig: () => global, availableCharacters: () => names,
        effectiveConfig: (name: string) => configs.get(name),
      } as unknown as CharacterRegistry);
      for (const character of ["paid", "sub"]) ledger.record({
        character, provider: "audit", model: "model", call_type: "message", thinking_enabled: false,
        finish_reason: "end_turn", timing: { total_ms: 1, time_to_first_token_ms: 1 },
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 1 },
      });
    }
    expect(ledger.database.query("SELECT character, cost_source, total_cost FROM calls ORDER BY id").all()).toEqual([
      { character: "paid", cost_source: "provider_reported", total_cost: 1 },
      { character: "sub", cost_source: "subscription", total_cost: 0 },
      { character: "paid", cost_source: "provider_reported", total_cost: 1 },
      { character: "sub", cost_source: "subscription", total_cost: 0 },
    ]);
  } finally {
    ledger.close();
    setSubscriptionProviders(DEFAULT_SUBSCRIPTION_PROVIDERS);
    setNanoGptSubscriptionCacheDir(undefined);
  }
});

test("new messages from a side thread cannot enter the main thread's event stream", async () => {
  const h = await reliabilityGeneration({
    generate: async () => { throw new Error("stream only"); },
    async *stream() {
      yield { type: "done", content: "reply", finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
  }, "side");
  await h.run();
  const events = h.frames.filter((frame) => frame.type === "new_message");
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(eventMatchesSession(event, "ada", true, false, "main")).toBe(false);
    expect(eventMatchesSession(event, "ada", true, false, "side")).toBe(true);
  }
});
