import { expect, test } from "bun:test";
import { join } from "node:path";

import { statusContext } from "../src/commands/status_context.ts";
import type { CommandDeps, CommandSession } from "../src/commands/dispatch.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message } from "../src/engine/types.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";

function config(withModel: boolean): LoadedConfig {
  const app = promptedAppConfig();
  const models = emptyCatalog();
  if (withModel) {
    app.chat.model = "fixture";
    models.chat.set("chat.fixture", {
      name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
      sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: "SHORE_STATUS_TEST_KEY", maxContextTokens: 200_000, maxOutputTokens: 4096,
    } as unknown as ResolvedModel);
  }
  const root = "/nowhere/status";
  return { app, models, providers: ProviderRegistry.empty(), rawTable: undefined, dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") } };
}

const said: Message = { msg_id: "m1", role: "user", content: "hello there", images: [], content_blocks: [{ type: "text", text: "hello there" }], timestamp: "2026-10-30T12:00:00Z" };

const engine = { thread: "main", characterName: "ada", turnCount: () => 1, startedAt: () => undefined, messages: () => [said] } as unknown as ConversationEngine;

test("the status is told the chat model and the context's size, with or without a model, and the index, clock and MCP servers only when there are any", () => {
  const now = (): number => 7;
  const index = { path: "/nowhere/index" };
  const servers = [{ name: "web" }];
  const bare = statusContext(engine, { config: config(false) } as CommandSession, {} as CommandDeps);
  expect([bare.activeModel, bare.contextTokens, bare.historyIndex, "mcpServers" in bare] as unknown[]).toEqual([undefined, statusContext(engine, { config: config(true) } as CommandSession, {} as CommandDeps).contextTokens, undefined, false]);
  const modelled = statusContext(engine, { config: config(true) } as CommandSession, { historyIndex: index, mcpStatus: () => servers } as unknown as CommandDeps);
  expect([modelled.activeModel, modelled.historyIndex, modelled.mcpServers] as unknown[]).toEqual(["chat.fixture", { path: "/nowhere/index" }, servers]);
  const timed = statusContext(engine, { config: config(true) } as CommandSession, { historyIndex: index, now } as unknown as CommandDeps);
  expect([timed.historyIndex, timed.now] as unknown[]).toEqual([{ path: "/nowhere/index", now }, now]);
});
