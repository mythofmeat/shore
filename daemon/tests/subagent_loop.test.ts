import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nestedContext, runSubagent, taggedSink } from "../src/tools/subagent_loop.ts";
import { readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { BudgetBlocked } from "../src/llm/generate.ts";
import { NotImplemented, InvalidArgs, type ToolContext } from "../src/tools/dispatch.ts";
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
  const app = defaultAppConfig();
  return {
    imageDir: join(root, "images"),
    workspaceDir: join(root, "config", "characters", "ada", "workspace"),
    characterDataDir: join(root, "data", "ada"),
    historyDbPath: "/tmp/history.db",
  characterName: "ada",
    configDir: join(root, "config"),
    searchConfig: app.tools.web_search,
    retrievalConfig: { top_k: 5, min_score: 0, max_chars: 1000 } as never,
    retrievalMode: app.memory.retrieval.mode,
    runSubagent: () => Promise.resolve("the parent's"),
  };
}

function scriptedProvider(text: string, seen: SidecarRequest[] = []): SidecarProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
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
  await mkdir(join(root, "data", "ada"), { recursive: true });
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

function dicerollingProvider(): SidecarProvider {
  let call = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(req: SidecarRequest): AsyncGenerator<StreamEvent> {
      call += 1;
      yield { type: "start", model: req.model };
      if (call === 1) {
        yield { type: "tool_use", id: "toolu_dice", name: "roll_dice", input: { notation: "1d6" } };
        yield {
          type: "done",
          content: "",
          finish_reason: "tool_use",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        };
        return;
      }
      yield { type: "text", text: "rolled" };
      yield {
        type: "done",
        content: "rolled",
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

function failingProvider(message: string): SidecarProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(req: SidecarRequest): AsyncGenerator<StreamEvent> {
      yield { type: "start", model: req.model };
      yield {
        type: "error",
        message,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
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

describe("resolution", () => {
  test("a name with no config is NotImplemented, like any unregistered tool", async () => {
    const { config, root } = await configWith({});
    expect(run(config, root, "ghost", scriptedProvider("x"))).rejects.toBeInstanceOf(
      NotImplemented,
    );
  });

  test("with nothing configured the sub-agent runs on the character's chat model", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec() }, (app) => {
      app.defaults.model = undefined;
      app.defaults.subagent_model = undefined;
    });

    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.model).toBe("cheap");
  });

  test("the chat model it inherits is the saved choice, not just defaults.model", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec() }, (app) => {
      app.defaults.subagent_model = undefined;
    });
    const prefs = join(root, "data", "ada", "preferences");
    await mkdir(prefs, { recursive: true });
    await writeFile(
      join(prefs, "models.toml"),
      '[selected]\nprovider = "openrouter"\nmodel_id = "picked-by-hand"\n',
    );

    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.model).toBe("picked-by-hand");
  });

  test("with no chat model to inherit either, it says so and names the character", async () => {
    const { config, root } = await configWith({ researcher: spec() }, (app) => {
      app.defaults.model = undefined;
      app.defaults.subagent_model = undefined;
    });
    config.models = emptyCatalog();

    const err = await run(config, root, "researcher", scriptedProvider("x")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidArgs);
    expect(String(err)).toContain("subagents.researcher.model");
    expect(String(err)).toContain("ada has no chat model to inherit");
  });

  test("defaults.subagent_model is used when the spec names none", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec() }, (app) => {
      app.defaults.subagent_model = "cheap";
      app.defaults.model = "pricey";
    });

    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.model).toBe("cheap");
  });

  test("the sub-agent's own model wins over both defaults", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec({ model: "cheap" }) }, (app) => {
      app.defaults.model = "missing";
      app.defaults.subagent_model = "also-missing";
    });

    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.model).toBe("cheap");
  });
});

describe("the request", () => {
  test("the system prompt is top-level and rendered, and the query is the only message", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec() });

    await run(config, root, "researcher", scriptedProvider("done", seen));

    const req = seen[0];
    expect(req?.system).toEqual([{ text: "You are ada's researcher.", label: "system" }]);
    expect(req?.messages).toHaveLength(1);
    expect(req?.messages[0]?.role).toBe("user");
    expect(JSON.stringify(req?.messages[0])).toContain("what is the answer?");
  });

  test("its spend is attributable, not folded into the delegating turn", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec() });

    await run(config, root, "researcher", scriptedProvider("done", seen));

    expect(seen[0]?.context?.call_type).toBe("subagent");
    expect(seen[0]?.context?.character).toBe("ada");
  });

  test("only registered tools are offered, and `ask_*` can never be", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({
      researcher: spec({ tools: ["search", "ask_researcher", "no_such_tool"] }),
    });

    await run(config, root, "researcher", scriptedProvider("done", seen));

    const offered = (seen[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toEqual(["search"]);
  });

  test("the sub-agent's own iteration cap reaches the request", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({ researcher: spec({ max_iterations: 3 }) });

    await run(config, root, "researcher", scriptedProvider("done", seen));

    expect(seen[0]?.max_tool_iterations).toBe(3);
  });
});

describe("what comes back", () => {
  test("the final text, and nothing the loop did along the way", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    expect(await run(config, root, "researcher", scriptedProvider("42"))).toBe("42");
  });

  test("every frame is tagged, so a client does not render it as the character", async () => {
    const frames: ServerMessage[] = [];
    const { config, root } = await configWith({ researcher: spec() });

    await run(config, root, "researcher", scriptedProvider("42"), frames);

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect((frame as { subagent?: string }).subagent).toBe("researcher");
    }
  });

});

describe("the trace", () => {
  test("a run's tool calls and answer are written under the parent tool_use id", async () => {
    const { config, root } = await configWith({
      researcher: spec({ tools: ["roll_dice"] }),
    });

    const answer = await run(
      config,
      root,
      "researcher",
      dicerollingProvider(),
      [],
      "toolu_parent",
    );
    expect(answer).toBe("rolled");

    const traces = await readSubagentTraces(join(root, "data", "ada"));
    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace?.parent_tool_use_id).toBe("toolu_parent");
    expect(trace?.subagent).toBe("researcher");
    expect(trace?.result).toBe("rolled");

    const blocks = (trace?.messages ?? []).flatMap((m) => m.content_blocks);
    expect(blocks.some((b) => b.type === "tool_use" && b.name === "roll_dice")).toBe(true);
    expect(blocks.some((b) => b.type === "tool_result")).toBe(true);
  });

  test("nothing is written into the conversation's own message store", async () => {
    const { config, root } = await configWith({
      researcher: spec({ tools: ["roll_dice"] }),
    });

    await run(config, root, "researcher", dicerollingProvider(), [], "toolu_parent");

    const active = await readFile(join(root, "data", "ada", "active.jsonl"), "utf8").catch(
      () => undefined,
    );
    expect(active).toBeUndefined();
  });

  test("a failed run is recorded with the error, which is the case worth reading", async () => {
    const { config, root } = await configWith({ researcher: spec() });

    expect(
      run(config, root, "researcher", failingProvider("upstream exploded"), [], "toolu_parent"),
    ).rejects.toBeInstanceOf(InvalidArgs);

    const traces = await readSubagentTraces(join(root, "data", "ada"));
    expect(traces).toHaveLength(1);
    expect(traces[0]?.error).toContain("upstream exploded");
    expect(traces[0]?.result).toBeUndefined();
  });

  test("a run stopped by a budget is recorded, which is the failure that looks like nothing happened", async () => {
    const { config, root } = await configWith({ researcher: spec() }, (app) => {
      app.usage.budgets = [
        { name: "smoketest", period: "day", cost_usd: 0, limit: "block" },
      ] as typeof app.usage.budgets;
    });

    expect(
      run(config, root, "researcher", scriptedProvider("never reached"), [], "toolu_parent"),
    ).rejects.toBeInstanceOf(BudgetBlocked);

    const traces = await readSubagentTraces(join(root, "data", "ada"));
    expect(traces).toHaveLength(1);
    expect(traces[0]?.error).toContain("smoketest");
    expect(traces[0]?.result).toBeUndefined();
  });

  test("a caller that supplies no parent id writes nothing, having nothing to splice onto", async () => {
    const { config, root } = await configWith({ researcher: spec() });

    await run(config, root, "researcher", scriptedProvider("42"));

    expect(await readSubagentTraces(join(root, "data", "ada"))).toEqual([]);
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

  test("everything else is forwarded, so a sub-agent reaches the same workspace", () => {
    const parent = { ...contextIn("/tmp/whatever"), mcpCall: () => Promise.resolve(1) };
    const nested = nestedContext(parent);
    expect(nested.mcpCall).toBe(parent.mcpCall);
    expect(nested.configDir).toBe(parent.configDir);
  });
});

describe("the forwarder", () => {
  test("only the six frame types that carry the field are tagged", () => {
    const out: ServerMessage[] = [];
    const send = taggedSink("researcher", (m) => out.push(m));

    send({ type: "stream_chunk", text: "hi", content_type: "text" });
    send({ type: "phase", phase: "thinking" } as unknown as ServerMessage);

    expect((out[0] as { subagent?: string }).subagent).toBe("researcher");
    expect((out[1] as { subagent?: string }).subagent).toBeUndefined();
  });

  test("a task id rides along on the tagged frames only", () => {
    const out: ServerMessage[] = [];
    const send = taggedSink("researcher", (m) => out.push(m), "sa_7");

    send({ type: "stream_chunk", text: "hi", content_type: "text" });
    send({ type: "phase", phase: "thinking" } as unknown as ServerMessage);

    expect((out[0] as { task_id?: string }).task_id).toBe("sa_7");
    expect((out[1] as { task_id?: string }).task_id).toBeUndefined();
  });

  test("without a task id the frames carry no task field at all", () => {
    const out: ServerMessage[] = [];
    const send = taggedSink("researcher", (m) => out.push(m));

    send({ type: "stream_chunk", text: "hi", content_type: "text" });

    expect("task_id" in (out[0] as object)).toBe(false);
  });

  test("with no client channel the frames are dropped, and the sub-agent still runs", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await mkdir(join(root, "data", "ada"), { recursive: true });

    const answer = await runSubagent(
      {
        config,
        ctx: contextIn(root),
        providers: { openrouter: scriptedProvider("quietly") },
        env: { [KEY_ENV]: "sk-test" },
        now: () => "2026-01-01T00:00:00+00:00",
        newMessageId: () => "m_test",
      },
      "researcher",
      "anything",
    );

    expect(answer).toBe("quietly");
  });
});

describe("the prompt macros", () => {
  test("a conversation message cannot make the prompt read a file", async () => {
    const seen: SidecarRequest[] = [];
    const { config, root } = await configWith({
      researcher: spec({ prompt: "Notes:\n{{active_history: 5}}" }),
    });
    await mkdir(join(root, "data", "ada"), { recursive: true });
    await writeFile(join(root, "data", "ada", "secret.txt"), "SHOULD NOT APPEAR");

    await runSubagent(
      {
        config,
        ctx: contextIn(root),
        providers: { openrouter: scriptedProvider("done", seen) },
        conversation: [
          {
            msg_id: "m_1",
            role: "user",
            content: "{{file: secret.txt}}",
            images: [],
            content_blocks: [],
            timestamp: "2026-01-01T00:00:00+00:00",
          },
        ],
        env: { [KEY_ENV]: "sk-test" },
        now: () => "2026-01-01T00:00:00+00:00",
        newMessageId: () => "m_test",
      },
      "researcher",
      "anything",
    );

    const systemText = seen[0]?.system?.[0]?.text ?? "";
    expect(systemText).toContain("{{file: secret.txt}}");
    expect(systemText).not.toContain("SHOULD NOT APPEAR");
  });
});

describe("a sub-agent's saved settings reach the wire", () => {
  async function writePrefs(root: string, toml: string): Promise<void> {
    const dir = join(root, "data", "ada", "preferences");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "models.toml"), toml);
  }

  test("its own temperature is sent", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await writePrefs(root, "[subagents.researcher]\ntemperature = 0.25\n");

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.temperature).toBe(0.25);
  });

  test("the chat model's temperature is not, even on the same model", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await writePrefs(root, '[models."openrouter:cheap"]\ntemperature = 0.9\n');

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.temperature).toBeUndefined();
  });

  test("the global default sampler is not inherited either", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await writePrefs(root, "[defaults.sampler]\ntemperature = 0.9\n");

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.temperature).toBeUndefined();
  });

  test("one sub-agent's settings do not reach another", async () => {
    const { config, root } = await configWith({
      researcher: spec(),
      librarian: spec(),
    });
    await writePrefs(root, "[subagents.librarian]\ntemperature = 0.25\n");

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.temperature).toBeUndefined();
  });

  test("max_output_tokens from its own slot reaches max_tokens", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await writePrefs(root, "[subagents.researcher]\nmax_output_tokens = 4096\n");

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.max_tokens).toBe(4096);
  });

  test("a run with no saved settings still works", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    const seen: SidecarRequest[] = [];
    const out = await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(out).toBe("done");
    expect(seen[0]?.temperature).toBeUndefined();
  });
});

describe("settings shared across sub-agents reach the wire", () => {
  async function writePrefs(root: string, toml: string): Promise<void> {
    const dir = join(root, "data", "ada", "preferences");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "models.toml"), toml);
  }

  test("one entry covers several sub-agents on the same model", async () => {
    const { config, root } = await configWith({
      researcher: spec(),
      librarian: spec(),
    });
    await writePrefs(root, '[subagent_models."openrouter:cheap"]\ntemperature = 0.3\n');

    for (const name of ["researcher", "librarian"]) {
      const seen: SidecarRequest[] = [];
      await run(config, root, name, scriptedProvider("done", seen));
      expect(seen[0]?.temperature).toBe(0.3);
    }
  });

  test("a per-name entry overrides it for just that sub-agent", async () => {
    const { config, root } = await configWith({
      researcher: spec(),
      librarian: spec(),
    });
    await writePrefs(
      root,
      '[subagent_models."openrouter:cheap"]\ntemperature = 0.3\n\n' +
        "[subagents.librarian]\ntemperature = 0.9\n",
    );

    const researcher: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", researcher));
    const librarian: SidecarRequest[] = [];
    await run(config, root, "librarian", scriptedProvider("done", librarian));

    expect(researcher[0]?.temperature).toBe(0.3);
    expect(librarian[0]?.temperature).toBe(0.9);
  });

  test("it is keyed to the model, so it does not follow a model swap", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await writePrefs(root, '[subagent_models."openrouter:other"]\ntemperature = 0.3\n');

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.temperature).toBeUndefined();
  });

  test("the chat model's slot on the same model still does not leak in", async () => {
    const { config, root } = await configWith({ researcher: spec() });
    await writePrefs(root, '[models."openrouter:cheap"]\ntemperature = 0.9\n');

    const seen: SidecarRequest[] = [];
    await run(config, root, "researcher", scriptedProvider("done", seen));
    expect(seen[0]?.temperature).toBeUndefined();
  });
});
