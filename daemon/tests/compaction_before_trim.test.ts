import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import {
  assemblePrompt,
  COMPACT_BEFORE_TRIM_FRACTION,
  estimateHistoryTokens,
  nearMessageBudget,
} from "../src/engine/prompt.ts";
import { estimateTokens, withSafetyMargin } from "../src/engine/tokens.ts";
import type { Message } from "../src/engine/types.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../src/handler/generation.ts";
import type { TurnAutonomy } from "../src/handler/turn.ts";
import type { SidecarProvider } from "../src/llm/types.ts";
import { canArchiveTurns } from "../src/memory/compaction/plan.ts";
import { writeDurable } from "../src/storage/files.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(restoreTestEnv);

const KEY_ENV = "SHORE_CROWDED_FIXTURE_KEY";

function message(i: number, role: Message["role"], bytes: number): Message {
  const prefix = `${role} ${String(i)} `;
  const text = `${prefix}${"x".repeat(Math.max(0, bytes - prefix.length))}`;
  return {
    msg_id: `m${String(i)}`,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: new Date(Date.UTC(2026, 8, 30, 0, i)).toISOString(),
  };
}

function conversation(turns: number, bytesPerMessage: number): Message[] {
  return Array.from({ length: turns * 2 }, (_, i) => message(i, i % 2 === 0 ? "user" : "assistant", bytesPerMessage));
}

describe("the prompt's message budget", () => {
  const prompt = (messages: Message[]) => assemblePrompt({
    character_name: "ada",
    display_name: "ren",
    has_prior_context: false,
    messages,
    max_context_tokens: 12_000,
    max_output_tokens: 1_000,
    user_timestamp_mode: "never",
  }, "UTC");

  test("is the budget trimming works to, and is reported with the prompt", () => {
    const assembled = prompt(conversation(2, 320));
    const system = estimateTokens(assembled.system.map((block) => block.content).join("\n"));
    expect(assembled.messageBudget).toBe(withSafetyMargin(12_000 - 1_000 - system));
  });

  test("messages over it are trimmed, messages under it are not", () => {
    const fits = conversation(4, 3_200);
    expect(estimateHistoryTokens(fits)).toBeLessThan(prompt(fits).messageBudget);
    expect(prompt(fits).messages).toHaveLength(fits.length);

    const over = conversation(8, 3_200);
    expect(estimateHistoryTokens(over)).toBeGreaterThan(prompt(over).messageBudget);
    expect(prompt(over).messages.length).toBeLessThan(over.length);
  });

  test("counts as nearly full from nine tenths of it", () => {
    const budget = 10_000;
    const atThreshold = Array.from({ length: 9 }, (_, i) => message(i, "user", 3_200));
    expect(estimateHistoryTokens(atThreshold)).toBe(budget * COMPACT_BEFORE_TRIM_FRACTION);
    expect(nearMessageBudget(atThreshold, budget)).toBe(true);
    expect(nearMessageBudget(atThreshold.slice(1), budget)).toBe(false);
    expect(nearMessageBudget([], budget)).toBe(false);
  });
});

describe("whether compaction could archive anything", () => {
  test("not while every turn is one the planner keeps", () => {
    expect(canArchiveTurns(conversation(4, 100), 4, 500_000)).toBe(false);
    expect(canArchiveTurns(conversation(5, 100), 4, 500_000)).toBe(true);
  });

  test("a token-heavy tail keeps fewer turns, so fewer turns are enough", () => {
    expect(canArchiveTurns(conversation(3, 64_000), 4, 200_000)).toBe(true);
  });

  test("nothing to archive in an empty conversation", () => {
    expect(canArchiveTurns([], 0, 200_000)).toBe(false);
  });
});

describe("a turn that leaves the prompt nearly full compacts straight away", () => {
  function model(maxContextTokens: number): ResolvedModel {
    return {
      name: "fixture",
      qualifiedName: "chat.fixture",
      category: "chat",
      providerKey: "anthropic",
      sdk: "anthropic",
      modelId: "claude-fixture",
      apiKeyEnv: KEY_ENV,
      maxContextTokens,
      maxOutputTokens: 1_000,
    };
  }

  async function turn(history: Message[], maxContextTokens: number, text = "and another thing", thread = "main") {
    setTestEnv(KEY_ENV, "fixture-key");
    const root = await mkdtemp(testTmp("shore-crowded-"));
    const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const app = defaultAppConfig();
    app.defaults.model = "fixture";
    app.memory.compaction.keep_recent_turns = 1;
    const models = emptyCatalog();
    models.chat.set("chat.fixture", model(maxContextTokens));
    const config: LoadedConfig = { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
    await mkdir(join(dirs.config, "characters", "ada", "workspace"), { recursive: true });
    await writeFile(join(dirs.config, "characters", "ada", "workspace", "SOUL.md"), "ada");
    await mkdir(join(dirs.data, "ada", "threads", thread), { recursive: true });
    writeDurable(join(dirs.data, "ada", "threads", thread, "active.jsonl"), history.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const asked: { turns: number; crowded: boolean | undefined }[] = [];
    let compactions = 0;
    const autonomy: TurnAutonomy & GenerationDeps["autonomy"] = {
      ensureState: () => false,
      needsActivityBackfill: () => false,
      backfillActivity: () => {},
      onUserMessage: () => {},
      shouldCompactNow: (_character, turns, _tokens, crowded) => {
        asked.push({ turns, crowded });
        return crowded === true;
      },
      onCompactionComplete: () => {},
      onCompactionFailed: () => {},
      notifyLastRequest: () => {},
      notifyAssistantMessage: () => {},
    };
    const provider: SidecarProvider = {
      stream: () => eventsForResponse({
        content: "ok",
        content_blocks: [{ type: "text", text: "ok" }],
        model: "claude-fixture",
        finish_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      }),
      generate: () => { throw new Error("no case generates"); },
    };
    const engine = generationEngine(await ConversationEngine.load("ada", dirs.data, undefined, thread));
    const deps: GenerationDeps = {
      registry: {
        getOrCreate: async () => engine,
        effectiveConfig: () => config,
        listThreads: () => [
          { id: "main", created_at: "2026-09-30T00:00:00.000Z", compaction: true },
          { id: "scratch", created_at: "2026-09-30T00:00:00.000Z", compaction: true },
        ],
      },
      dataDir: dirs.data,
      providers: { anthropic: provider },
      autonomy,
      notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
      diagnostics: { key_fallbacks: { push: () => {} } },
      emitEvent: () => {},
      mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
      compaction: {
        run: async () => {
          compactions += 1;
          return { kind: "completed", retained: 0 };
        },
        applyDeferredEdits: async () => {},
      },
      newlyCrossedUsageBudgetWarnings: async () => [],
      newlyCrossedPlanLimitWarnings: async () => [],
      now: () => "2026-09-30T05:00:00+10:00",
      newMessageId: () => `m_${crypto.randomUUID()}`,
      monotonicMs: () => 0,
      sleep: async () => {},
    };
    await runGeneration(deps, {
      meta: {
        session: {
          clientId: 1, sessionId: 1, clientType: "test-client", clientName: "test-1",
          capabilities: ["streaming"], selectedCharacter: "ada",
        },
        rid: null,
        kind: "message",
      } as never,
      body: { rid: null, text, stream: true, images: [], image_data: [] },
      regen: false,
      charName: "ada",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    });
    return { asked, compactions };
  }

  test("below min_turns and both ceilings, a nearly full prompt still compacts", async () => {
    const { asked, compactions } = await turn(conversation(4, 4_800), 12_000);
    expect(asked).toEqual([{ turns: 5, crowded: true }]);
    expect(compactions).toBe(1);
  });

  test("a prompt with room left waits for the usual triggers", async () => {
    const { asked, compactions } = await turn(conversation(4, 400), 12_000);
    expect(asked).toEqual([{ turns: 5, crowded: false }]);
    expect(compactions).toBe(0);
  });

  test("a nearly full prompt with nothing the planner would archive does not ask", async () => {
    const { asked, compactions } = await turn([], 12_000, "y".repeat(40_000));
    expect(asked).toEqual([{ turns: 1, crowded: false }]);
    expect(compactions).toBe(0);
  });

  test("a side thread, which decides from config, compacts the same way", async () => {
    const { asked, compactions } = await turn(conversation(4, 4_800), 12_000, "and another thing", "scratch");
    expect(asked).toEqual([]);
    expect(compactions).toBe(1);
  });
});
