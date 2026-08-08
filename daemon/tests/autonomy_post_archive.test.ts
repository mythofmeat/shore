import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CharacterRegistry } from "../src/characters.ts";
import { LastRequestCache } from "../src/autonomy/last_request.ts";
import { InProcessAutonomyExecutor } from "../src/autonomy/in_process.ts";
import { reloadAndApplyDeferred } from "../src/autonomy/post_archive.ts";
import { beginCompaction, tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarProvider } from "../src/llm/types.ts";
import { testTmp } from "./support/tmp.ts";

const FIXTURE_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_FIXTURE_API_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 4,
} as never;

function message(role: "user" | "assistant", id: string, text: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
}

function conversation(): Message[] {
  return [
    message("user", "m_1", "morning"),
    message("assistant", "m_2", "morning to you"),
    message("user", "m_3", "did you sleep"),
    message("assistant", "m_4", "in a manner of speaking"),
    message("user", "m_5", "tell me about boats"),
    message("assistant", "m_6", "they float"),
  ];
}

async function world(): Promise<{ config: LoadedConfig; characterDir: string }> {
  const root = await mkdtemp(testTmp("shore-postarchive-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const workspace = join(dirs.config, "characters", "ada", "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "# Ada\n");

  const characterDir = join(dirs.data, "ada");
  await mkdir(characterDir, { recursive: true });
  await writeFile(
    join(characterDir, "active.jsonl"),
    conversation()
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n",
  );

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);

  return {
    characterDir,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

function writingProvider(): SidecarProvider {
  let round = 0;
  return {
    stream: () => {
      throw new Error("compaction does not stream");
    },
    generate: async (): Promise<GenerateResponse> => {
      round += 1;
      const blocks =
        round === 1
          ? [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "edit",
                input: { path: "memory/boats.md", content: "- a thing that floats\n" },
              },
            ]
          : [{ type: "text", text: "done" }];
      return {
        content: round === 1 ? "" : "done",
        content_blocks: blocks,
        finish_reason: round === 1 ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        timing: {},
        model: "claude-fixture",
      } as never;
    },
  };
}

async function activeIds(characterDir: string): Promise<string[]> {
  const raw = await readFile(join(characterDir, "active.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as Message).msg_id);
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";
  return fn().finally(() => {
    delete process.env["SHORE_FIXTURE_API_KEY"];
  });
}

describe("autonomy compaction reloads the engine it shares with chat", () => {
  test("a chat turn appended after an idle compaction does not restore the archived messages", async () => {
    const { config, characterDir } = await world();
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);

    const engine = await registry.getOrCreate("ada");
    expect(engine.messages().length).toBe(6);

    const executor = new InProcessAutonomyExecutor({
      registry,
      cache: new LastRequestCache(),
      providers: { anthropic: writingProvider() },
    });

    const result = await withKey(() => executor.runCompaction("ada", "idle"));
    expect(result.failed).toBeUndefined();
    expect(await activeIds(characterDir)).toEqual(["m_3", "m_4", "m_5", "m_6"]);

    expect(engine.messages().length).toBe(4);

    await engine.appendMessage(message("user", "m_7", "still here"));

    expect(await activeIds(characterDir)).toEqual(["m_3", "m_4", "m_5", "m_6", "m_7"]);
  });
});

describe("post-archive memory writes hold the compaction guard", () => {
  test("a compaction cannot begin while deferred edits are being applied", async () => {
    const { config } = await world();

    let acquiredDuringApply: boolean | undefined;
    const engine = {
      reload: async () => {
        const guard = tryBeginCompaction(config.dirs.data, "ada");
        acquiredDuringApply = guard !== undefined;
        guard?.release();
      },
    };

    await reloadAndApplyDeferred("ada", { config, cache: new LastRequestCache(), engine }, "test");

    expect(acquiredDuringApply).toBe(false);
  });

  test("the guard is released afterwards, so the next compaction can begin", async () => {
    const { config } = await world();

    await reloadAndApplyDeferred("ada", { config, cache: new LastRequestCache() }, "test");

    const guard = tryBeginCompaction(config.dirs.data, "ada");
    expect(guard).toBeDefined();
    guard?.release();
  });

  test("a waiting acquirer runs after the holder releases, not concurrently", async () => {
    const { config } = await world();
    const order: string[] = [];

    const held = await beginCompaction(config.dirs.data, "ada");
    const waiter = beginCompaction(config.dirs.data, "ada").then((guard) => {
      order.push("second");
      guard.release();
    });

    order.push("first");
    held.release();
    await waiter;

    expect(order).toEqual(["first", "second"]);
  });
});
