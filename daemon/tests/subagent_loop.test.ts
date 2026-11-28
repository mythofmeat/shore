import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
import { Texts } from "../src/texts/texts.ts";
import { BudgetBlocked } from "../src/llm/generate.ts";
import { readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { required } from "../src/util/required.ts";
import { writePromptSnapshotFile } from "./support/storage.ts";
import { rejectionOf } from "./support/outcome.ts";
import { readEvents } from "../src/storage/store.ts";

const KEY_ENV = "SHORE_SUBAGENT_TEST_KEY";

function spec(over: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    description: "a researcher",
    prompt: "You are {{char}}'s researcher.",
    tools: [],
    model: undefined,
    max_tool_rounds: undefined,
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
  const app = defaultAppConfig();
  app.chat.model = "cheap";
  app.chat.max_retries = 0;
  for (const [name, s] of Object.entries(subagents)) app.subagents.agents.set(name, s);
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
    texts: new Texts(), userName: "eve",
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

  test("the nested context keeps the parent's abort signal unless it is given its own", () => {
    const parentSignal = new AbortController().signal;
    const own = new AbortController().signal;
    const parent = { ...contextIn("/tmp/whatever"), signal: parentSignal };
    expect(nestedContext(parent).signal).toBe(parentSignal);
    expect(nestedContext(parent, own).signal).toBe(own);
  });

  test("everything else is forwarded, so a sub-agent reaches the same workspace", () => {
    const parent = { ...contextIn("/tmp/whatever"), mcpCall: () => Promise.resolve(1) };
    const nested = nestedContext(parent);
    expect(nested.mcpCall).toBe(parent.mcpCall);
    expect(nested.configDir).toBe(parent.configDir);
  });
});

describe("a sub-agent's rounds of tool use", () => {
  test("are held to its own max_tool_rounds, else to its model's, and to nothing when neither is set", async () => {
    const asked = async (own: number | undefined, models: number | undefined): Promise<number | undefined> => {
      const { config, root } = await configWith({ researcher: spec({ max_tool_rounds: own }) });
      const cheap = config.models.chat.get("cheap");
      if (cheap !== undefined && models !== undefined) cheap.maxToolRounds = models;
      const seen: SidecarRequest[] = [];
      await run(config, root, "researcher", scriptedProvider("done", seen));
      return seen[0]?.max_tool_rounds;
    };
    expect([await asked(3, 7), await asked(undefined, 7), await asked(3, undefined), await asked(undefined, undefined)]).toEqual([3, 7, 3, undefined]);
  });
});

describe("a sub-agent's tool calls", () => {
  test("are held to the limits in [tools], and to a tool's own where it has them", async () => {
    const { config, root } = await configWith({ researcher: spec({ tools: ["read", "bash"] }) }, (app) => {
      app.tools.max_result_chars = 60;
      app.tools.per_tool.set("bash", { max_result_chars: 20, timeout: undefined });
    });
    const workspace = join(root, "config", "characters", "ada", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "long.md"), `${"a".repeat(400)}\n`);
    const results: string[] = [];
    const provider: SidecarProvider = {
      ...scriptedProvider("done"),
      async *streamWithTools(req, phase) {
        for (const [id, name, input] of [["t1", "read", { file_path: "long.md" }], ["t2", "bash", { command: "printf '%0200d' 7" }]] as const) {
          results.push(JSON.stringify(await phase.runTool({ id, name, input })));
        }
        yield* scriptedProvider("done").stream(req);
      },
    };
    await run(config, root, "researcher", provider);
    const kept = results.map((result) => {
      const cut = /the first (\d+) characters are above this note and the last (\d+) are below it/.exec(result);
      return cut === null ? result : Number(cut[1]) + Number(cut[2]);
    });
    expect(kept).toEqual([60, 20]);
  });
});

const refusal = (error: unknown): string => (error as Error).message;

describe("asking a sub-agent", () => {
  test("is refused for one that isn't configured, whose model can't be found, with no model to inherit, or on an SDK Shore has no provider for", async () => {
    const { config, root } = await configWith({ scout: spec(), lost: spec({ model: "nowhere" }) });
    expect(refusal(await rejectionOf(run(config, root, "ghost", scriptedProvider("x"))))).toContain("ask_ghost: not yet implemented");
    expect(refusal(await rejectionOf(run(config, root, "lost", scriptedProvider("x"))))).toContain("invalid args: subagent 'lost': EffectiveCatalogError: model \"nowhere\" not found");
    const bare = { ...config, models: emptyCatalog() };
    expect(refusal(await rejectionOf(run(bare, root, "scout", scriptedProvider("x"))))).toContain("ada has no chat model to inherit");
    expect(refusal(await rejectionOf(runSubagent({ config, ctx: contextIn(root), providers: {}, sendDirect: () => {}, conversation: [], env: { [KEY_ENV]: "sk-test" } }, "scout", "q"))))
      .toBe("invalid args: unsupported sdk: openrouter");
  });

  test("sends the run it belongs to, the key it used and whether thinking is on, records the call, and keeps its answer for the trace", async () => {
    const { config, root } = await configWith({ scout: spec({ tools: ["read"] }) });
    await mkdir(join(root, "data", "ada", "threads", "main"), { recursive: true });
    const seen: SidecarRequest[] = [];
    const recorded: unknown[] = [];
    const frames: ServerMessage[] = [];
    const provider: SidecarProvider = {
      ...scriptedProvider("found it", seen),
      async *streamWithTools(req, phase) {
        await phase.runTool({ id: "t1", name: "read", input: { file_path: "nothing.md" } });
        yield* scriptedProvider("found it", seen).stream(req);
      },
    };
    const answer = await runSubagent({
      config, ctx: contextIn(root), providers: { openrouter: provider }, sendDirect: (frame) => frames.push(frame), conversation: [],
      env: { [KEY_ENV]: "sk-test" }, rid: "r1", callStore: { recordCall: (call) => { recorded.push(call); return 1; } },
    }, "scout", "what is the answer?", new AbortController().signal, "toolu_parent");
    expect(answer).toBe("found it");
    expect([seen[0]?.context?.rid, seen[0]?.context?.api_key_name, seen[0]?.context?.thinking_enabled]).toEqual(["r1", "default", false]);
    expect(recorded).toHaveLength(1);
    expect(frames.filter((frame) => "rid" in frame).map((frame) => (frame as { rid?: string }).rid)).toContain("r1");
    const [trace] = await readSubagentTraces(join(root, "data", "ada"));
    expect([trace?.subagent, trace?.parent_tool_use_id, trace?.rid, trace?.result, trace?.error]).toEqual(["scout", "toolu_parent", "r1", "found it", undefined]);
  });

  test("names the provider's key it used, works with no entry for its provider, and says thinking is off on a model whose reasoning is off", async () => {
    const { config, root } = await configWith({ scout: spec() });
    const seen: SidecarRequest[] = [];
    await run({ ...config, providers: ProviderRegistry.fromSection({ openrouter: { keys: [{ name: "work", api_key_env: KEY_ENV }] } }) }, root, "scout", scriptedProvider("named", seen));
    required(config.models.chat.get("cheap")).reasoningEffort = "off";
    expect(await run({ ...config, providers: ProviderRegistry.empty() }, root, "scout", scriptedProvider("bare", seen))).toBe("bare");
    expect(seen.map((request) => [request.context?.api_key_name, request.context?.thinking_enabled])).toEqual([["work", false], ["default", false]]);
  });

  test("a failure is kept for the trace and refused as bad arguments, a budget's block is passed on as it is, and an aborted run stops", async () => {
    const { config, root } = await configWith({ scout: spec() });
    await mkdir(join(root, "data", "ada", "threads", "main"), { recursive: true });
    const failing = (error: Error): SidecarProvider => ({
      ...scriptedProvider("x"),
      // eslint-disable-next-line require-yield
      async *stream() { throw error; },
    });
    const deps = (provider: SidecarProvider) => ({ config, ctx: contextIn(root), providers: { openrouter: provider }, sendDirect: () => {}, conversation: [], env: { [KEY_ENV]: "sk-test" } });
    expect(refusal(await rejectionOf(runSubagent(deps(failing(new Error("the model fell over"))), "scout", "q", undefined, "toolu_failed")))).toStartWith("invalid args: ");
    const [trace] = await readSubagentTraces(join(root, "data", "ada"));
    expect([trace?.parent_tool_use_id, trace?.result, trace?.error?.includes("the model fell over")]).toEqual(["toolu_failed", undefined, true]);
    const blocked = new BudgetBlocked("over budget");
    expect(await runSubagent(deps(failing(blocked)), "scout", "q").catch((error: unknown) => error)).toBe(blocked);
    expect(readEvents(join(root, "data"), "ada", ["subagent", "subagent_result"])).toHaveLength(1);
    const stopped = new AbortController();
    stopped.abort();
    expect(await rejectionOf(runSubagent(deps(scriptedProvider("late")), "scout", "q", stopped.signal))).toBeInstanceOf(Error);
  });

  test("reads a file the prompt names from the snapshot when the turn's workspace lists it in the prompt, and from the workspace otherwise", async () => {
    const { config, root } = await configWith({ scout: spec({ prompt: "Know this: {{file: SOUL.md}}" }) });
    const workspaceDir = join(root, "config", "characters", "ada", "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "SOUL.md"), "WORKSPACE SOUL");
    writePromptSnapshotFile(join(root, "data", "ada", "active_prompt", "SOUL.md"), "SNAPSHOT SOUL");
    const seen: SidecarRequest[] = [];
    const system = async (workspace?: CharacterWorkspace): Promise<string | undefined> => {
      await runSubagent({ config, ctx: { ...contextIn(root), ...(workspace === undefined ? {} : { workspace }) }, providers: { openrouter: scriptedProvider("ok", seen) }, sendDirect: () => {}, conversation: [], env: { [KEY_ENV]: "sk-test" } }, "scout", "q");
      return seen.at(-1)?.system?.[0]?.text;
    };
    expect([await system(new CharacterWorkspace(workspaceDir, undefined, ["SOUL.md"])), await system()]).toEqual(["Know this: SNAPSHOT SOUL", "Know this: WORKSPACE SOUL"]);
  });
});
