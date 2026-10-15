import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nestedContext, runSubagent } from "../src/tools/subagent_loop.ts";
import { type ToolContext } from "../src/tools/dispatch.ts";
import { defaultAppConfig, type SubagentConfig } from "../src/config/app.ts";
import { emptyCatalog, type ModelCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "../src/llm/types.ts";

const KEY_ENV = "SHORE_SUBAGENT_TEST_KEY";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function spec(over: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    description: "a researcher",
    prompt: "You are {{char}}'s researcher.",
    tools: [],
    model: undefined,
    max_iterations: undefined,
    timeout: undefined,
    ...over,
  };
}

function catalogWith(...names: string[]): ModelCatalog {
  const catalog = emptyCatalog();
  for (const name of names) {
    catalog.chat.set(name, {
      name,
      qualifiedName: `openrouter:${name}`,
      category: "chat",
      providerKey: "openrouter",
      sdk: "openrouter",
      modelId: name,
      apiKeyEnv: KEY_ENV,
    } as never);
  }
  return catalog;
}

async function configWith(
  subagents: Record<string, SubagentConfig>,
  over: (app: ReturnType<typeof defaultAppConfig>) => void = () => {},
): Promise<{ config: LoadedConfig; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "shore-subagent-"));
  roots.push(root);
  const app = defaultAppConfig();
  app.defaults.model = "cheap";
  app.advanced.max_retries = 0;
  for (const [name, s] of Object.entries(subagents)) app.subagents.set(name, s);
  over(app);
  return {
    root,
    config: {
      app,
      models: catalogWith("cheap", "pricey"),
      providers: ProviderRegistry.fromSection({ openrouter: { api_key_env: KEY_ENV } }),
      dirs: {
        config: join(root, "config"),
        data: join(root, "data"),
        cache: join(root, "cache"),
        runtime: join(root, "runtime"),
      },
      rawTable: undefined,
    },
  };
}

function contextIn(root: string): ToolContext {
  return {
    imageDir: join(root, "images"),
    workspaceDir: join(root, "config", "characters", "ada", "workspace"),
    characterDataDir: join(root, "data", "ada"),
    conversationDir: "",
  historyDbPath: "/tmp/history.db",
  characterName: "ada",
    configDir: join(root, "config"),
    runSubagent: () => Promise.resolve("the parent's"),
  };
}

function scriptedProvider(text: string, seen: SidecarRequest[] = []): SidecarProvider {
  return {
    async *stream(req: SidecarRequest): AsyncGenerator<StreamEvent> {
      seen.push(req);
      yield { type: "start", model: req.model };
      yield { type: "text", text };
      yield {
        type: "done",
        content: text,
        finish_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
    generate: () => {
      throw new Error("a sub-agent streams");
    },
  };
}

async function run(
  config: LoadedConfig,
  root: string,
  name: string,
  provider: SidecarProvider,
  frames: ServerMessage[] = [],
  toolUseId?: string,
): Promise<string> {
  await mkdir(join(root, "data", "ada", "threads", "main"), { recursive: true });
  return await runSubagent(
    {
      config,
      ctx: contextIn(root),
      providers: { openrouter: provider },
      sendDirect: (m) => frames.push(m),
      conversation: [],
      env: { [KEY_ENV]: "sk-test" },
      now: () => "2026-01-01T00:00:00+00:00",
      newMessageId: () => "m_test",
    },
    name,
    "what is the answer?",
    undefined,
    toolUseId,
  );
}

describe("the request", () => {

  test("only registered tools are offered, and `ask_*` can never be", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({
      researcher: spec({ tools: ["read", "ask_researcher", "no_such_tool"] }),
    });

    await run(config, root, "researcher", scriptedProvider("done", seen));

    const offered = (seen[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toEqual(["read"]);
  });
});

describe("the recursion cap", () => {
  test("the nested context has no way to reach another sub-agent", () => {
    const parent = contextIn("/tmp/whatever");
    expect(parent.runSubagent).toBeDefined();

    const nested = nestedContext(parent);

    expect("runSubagent" in nested).toBe(false);
    expect(nested.characterName).toBe(parent.characterName);
    expect(nested.workspaceDir).toBe(parent.workspaceDir);
  });

  test("the nested context has no heartbeat schedule, so a sub-agent cannot move its parent's wake", () => {
    const parent = { ...contextIn("/tmp/whatever"), scheduleNextWake: () => 1 };

    const nested = nestedContext(parent);

    expect("scheduleNextWake" in nested).toBe(false);
  });

  test("everything else is forwarded, so a sub-agent reaches the same workspace", () => {
    const parent = { ...contextIn("/tmp/whatever"), mcpCall: () => Promise.resolve(1) };
    const nested = nestedContext(parent);
    expect(nested.mcpCall).toBe(parent.mcpCall);
    expect(nested.configDir).toBe(parent.configDir);
  });
});
