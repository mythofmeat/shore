import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InProcessAutonomyExecutor } from "../src/autonomy/in_process.ts";
import { registrationFor, TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { prepareHeartbeatRequest } from "../src/autonomy/heartbeat_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { Message } from "../src/engine/types.ts";
import { buildCommandPathDeps, chatCompactionRunner, chatToolDeps } from "../src/handler/deps.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest, ToolDefinition } from "../src/llm/types.ts";
import { runCompactionPass } from "../src/memory/compaction/run.ts";
import { loadCompactionCheckpoint } from "../src/memory/compaction/checkpoint.ts";
import { ensureActivePromptSnapshot, loadPromptFileFromWorkspace } from "../src/memory/deferred_edits.ts";
import { createRuntime, sharedToolDeps } from "../src/runtime.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { dispatchTool } from "../src/tools/dispatch.ts";
import type { McpRegistry } from "../src/tools/mcp_registry.ts";
import { expandPromptMacros } from "../src/tools/subagent.ts";
import { required } from "../src/util/required.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";

beforeEach(() => {
  setTestEnv(KEY, "fixture-key");
});

afterAll(restoreTestEnv);
const KEY = "SHORE_BACKGROUND_CONTEXT_KEY";
const PROMPT_FILES = ["MEMORY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"];
const ARCHIVE_TOOL: ToolDefinition = {
  name: "mcp__archive__recall", description: "Recall the archive",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const MODEL = {
  name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
  sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY,
  maxContextTokens: 200_000, maxOutputTokens: 4096, maxToolIterations: 3,
} as const;

function messages(marker: string): Message[] {
  return ["user", "assistant"].map((role, i) => ({
    role: role as Message["role"], msg_id: `${marker}_${i}`, content: `${marker} ${role}`,
    content_blocks: [{ type: "text", text: `${marker} ${role}` }], images: [], alternatives: [],
    timestamp: "2026-09-11T00:00:00Z",
  }));
}

function results(request: SidecarRequest | undefined) {
  return request?.messages.flatMap((message) => typeof message.content === "string" ? [] : message.content)
    .filter((block) => block.type === "tool_result") ?? [];
}

async function world(options: { nestedWrite?: boolean; invalidMcp?: boolean; pauseAfterTools?: boolean } = {}) {
  const root = await mkdtemp(testTmp("shore-background-context-"));
  const workspace = join(root, "config", "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  const writePrompt = async (marker: string) => {
    for (const file of PROMPT_FILES) await writeFile(join(workspace, file), `${marker} ${file}`);
  };
  await writePrompt("MAIN SNAPSHOT");
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.git_push = false;
  app.memory.compaction.keep_recent_turns = 0;
  app.tools.enabled_tools = ["bash", ARCHIVE_TOOL.name];
  app.tools.enabled_subagents = ["research"];
  app.behavior.autonomy.enabled = true;
  app.subagents.set("research", {
    description: "Consult a researcher", tools: ["bash"], model: undefined,
    max_iterations: undefined, timeout: undefined,
    prompt: "History:\n{{active_history:10}}\n" + PROMPT_FILES.map((file) => `{{file:${file}}}`).join("\n"),
  });
  const models = emptyCatalog();
  models.chat.set("chat.fixture", { ...MODEL });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const seen: SidecarRequest[] = [];
  const mcpCalls: unknown[] = [];
  const reply = (request: SidecarRequest): GenerateResponse => {
    seen.push(structuredClone(request));
    const last = request.messages.at(-1)?.content;
    const completed = Array.isArray(last) && last.some((block) => block.type === "tool_result");
    const child = request.context?.call_type === "subagent";
    if (!child && completed && options.pauseAfterTools) throw new Error("fixture provider unavailable");
    const blocks: GenerateResponse["content_blocks"] = completed || (child && !options.nestedWrite)
      ? [{ type: "text", text: child ? "Research complete." : "HEARTBEAT_OK" }]
      : child
      ? [{ type: "tool_use", id: "nested_edit", name: "bash", input: { command: "mkdir -p projects && printf 'delegated write' > projects/notes.md" } }]
      : [
          { type: "tool_use", id: "recall", name: ARCHIVE_TOOL.name, input: { query: options.invalidMcp ? 7 : "Review the archive" } },
          { type: "tool_use", id: "research", name: "ask_research", input: { query: "Review our current context" } },
        ];
    return {
      content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
      content_blocks: blocks, finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      model: request.model,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  };
  const provider: SidecarProvider = {
    generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)),
  };
  const runtime = await createRuntime({ config, providers: { anthropic: provider } });
  const oldMcp = runtime.mcp.replace({
    toolDefsFiltered: (patterns: readonly string[]) => patterns.includes(ARCHIVE_TOOL.name) ? [ARCHIVE_TOOL] : [],
    namesMatching: () => [],
    call: async (_name: string, input: unknown) => { mcpCalls.push(input); return "archive fact"; },
    shutdown: async () => {},
  } as unknown as McpRegistry);
  await oldMcp.shutdown();
  const characterDir = join(config.dirs.data, "ada");
  const main = await runtime.registry.getOrCreate("ada", "main");
  for (const message of messages("MAIN_CONVERSATION")) await main.appendMessage(message);
  await ensureActivePromptSnapshot(characterDir, config.dirs.config, "ada", undefined, "main");
  await runtime.registry.createThread("ada", "diary");
  await runtime.registry.setHomeThread("ada", "diary");
  const diary = await runtime.registry.getOrCreate("ada", "diary");
  for (const message of messages("DIARY_CONVERSATION")) await diary.appendMessage(message);
  await writePrompt("DIARY SNAPSHOT");
  await ensureActivePromptSnapshot(characterDir, config.dirs.config, "ada", undefined, "diary");
  await writePrompt("LIVE WORKSPACE");
  const bridge = new TurnAutonomyBridge(runtime.autonomy);
  await runtime.autonomy.register(registrationFor("ada", config));
  const assembly = {
    runtime, providers: runtime.providers, autonomy: bridge,
    diagnostics: new Diagnostics(), emitEvent: () => {},
  };
  const command = buildCommandPathDeps({
    ...assembly, router: new SessionRouter(),
    handshake: { hello: () => ({}) as never, history: () => Promise.resolve({} as never) },
  });
  return {
    root, config, runtime, workspace, characterDir, diary, assembly, command, seen, mcpCalls,
    close: async () => {
      await runtime.autonomy.shutdown();
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function expectDiarySubagent(seen: SidecarRequest[]) {
  const child = required(seen.find((request) => request.context?.call_type === "subagent"));
  expect(child.context?.thread).toBe("diary");
  const prompt = child.system?.map((block) => block.text).join("\n") ?? "";
  expect(prompt).toContain("DIARY_CONVERSATION user");
  expect(prompt).not.toContain("MAIN_CONVERSATION");
  expect(prompt).not.toContain("LIVE WORKSPACE");
  for (const file of PROMPT_FILES) expect(prompt).toContain(`DIARY SNAPSHOT ${file}`);
}

test.each(["chat", "heartbeat"] as const)("%s subagents receive their parent's thread, conversation, and prompt snapshot", async (flow) => {
  const w = await world();
  try {
    if (flow === "chat") {
      const ctx = await buildToolContext(w.config, w.config.dirs.data, "ada", chatToolDeps(w.assembly, "ada", {
        thread: "diary", conversation: w.diary.messages(), signal: new AbortController().signal,
        send: () => {}, now: () => new Date().toISOString(), newMessageId: () => crypto.randomUUID(),
      }));
      expect(await dispatchTool("ask_research", { query: "Review our context" }, ctx)).toBe("Research complete.");
    } else {
      w.runtime.autonomy.forceHeartbeatNow("ada");
      await w.runtime.autonomy.tick();
      const parent = w.seen.filter((request) => request.context?.call_type !== "subagent");
      expect(parent[0]?.context?.thread).toBe("diary");
      expect(results(parent.at(-1)).map((result) => result.is_error)).toEqual([false, false]);
      expect(w.mcpCalls).toHaveLength(1);
    }
    expectDiarySubagent(w.seen);
  } finally { await w.close(); }
});

test.each(["inline", "command", "idle"] as const)("%s compaction advertises and executes configured MCP and subagent tools", async (flow) => {
  const w = await world({ nestedWrite: true });
  try {
    if (flow === "inline") await chatCompactionRunner(w.assembly).run("ada", w.config, "diary");
    else if (flow === "command") {
      const outcome = await runCompactionPass("ada", { ...required(w.command.commands.compaction).run, config: w.config }, { thread: "diary" });
      expect(outcome).toMatchObject({ kind: "compacted", memoryFilesWritten: ["projects/notes.md"] });
    } else {
      const executor = new InProcessAutonomyExecutor({
        registry: w.runtime.registry, cache: w.runtime.cache, providers: w.runtime.providers,
        tools: sharedToolDeps(w.config, w.runtime.mcp, w.runtime.autonomy, {
          providers: w.runtime.providers, registry: w.runtime.registry,
        }),
        rebuild: { mcpRegistry: w.runtime.mcp.current },
      });
      expect((await executor.runCompaction("ada", "idle")).failed).toBeUndefined();
    }
    const parent = w.seen.filter((request) => request.context?.call_type !== "subagent");
    expect(parent[0]?.tools?.map((tool) => tool.name)).toContain(ARCHIVE_TOOL.name);
    expect(parent[0]?.tools?.map((tool) => tool.name)).toContain("ask_research");
    expect(w.mcpCalls).toEqual([{ query: "Review the archive" }]);
    expect(results(parent.at(-1)).map((result) => result.is_error)).toEqual([false, false]);
    expectDiarySubagent(w.seen);
    expect(await readFile(join(w.workspace, "projects/notes.md"), "utf8")).toBe("delegated write");
  } finally { await w.close(); }
});

test("compaction checkpoints delegated writes with their original content", async () => {
  const w = await world({ nestedWrite: true, pauseAfterTools: true });
  try {
    await mkdir(join(w.workspace, "projects"), { recursive: true });
    await writeFile(join(w.workspace, "projects/notes.md"), "original note");
    const outcome = await runCompactionPass("ada", { ...required(w.command.commands.compaction).run, config: w.config }, { thread: "diary" });
    expect(outcome?.kind).toBe("paused");
    const checkpoint = required(await loadCompactionCheckpoint(w.config.dirs.data, "ada", "diary"));
    expect(checkpoint.loop.writesApplied).toEqual([{
      displayPath: "projects/notes.md", resolvedPath: join(w.workspace, "projects/notes.md"),
      previousState: { kind: "file", content: Buffer.from("original note").toString("base64"), mode: 0o644 },
      resultingState: { kind: "file", content: Buffer.from("delegated write").toString("base64"), mode: 0o644 },
    }]);
  } finally { await w.close(); }
});

test("dry-run compaction allows subagent inspection but blocks delegated writes and external tools", async () => {
  const w = await world({ nestedWrite: true });
  try {
    await runCompactionPass("ada", { ...required(w.command.commands.compaction).run, config: w.config }, { thread: "diary", dryRun: true });
    expectDiarySubagent(w.seen);
    expect(w.mcpCalls).toHaveLength(0);
    const child = w.seen.filter((request) => request.context?.call_type === "subagent");
    expect(results(child.at(-1))[0]).toMatchObject({ is_error: true });
    expect(results(child.at(-1))[0]?.content).toContain("dry-run");
    expect(await readFile(join(w.workspace, "projects/notes.md"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(w.workspace, "MEMORY.md"), "utf8")).toBe("LIVE WORKSPACE MEMORY.md");
  } finally { await w.close(); }
});

test("compaction validates MCP arguments against the advertised schema", async () => {
  const w = await world({ invalidMcp: true });
  try {
    await chatCompactionRunner(w.assembly).run("ada", w.config, "diary");
    expect(w.mcpCalls).toHaveLength(0);
    const parent = w.seen.filter((request) => request.context?.call_type !== "subagent");
    expect(results(parent.at(-1))[0]?.is_error).toBe(true);
    expect(results(parent.at(-1))[0]?.content).toContain("string");
  } finally { await w.close(); }
});

test("file macros use workspace fallback only when the selected thread has no prompt snapshot", async () => {
  const w = await world();
  try {
    const expand = (thread: string) => expandPromptMacros("{{file:MEMORY.md}}", {
      thread, characterDataDir: w.characterDir, workspaceDir: w.workspace, history: [], charName: "ada", userName: "user",
    });
    expect(await expand("fresh")).toBe("LIVE WORKSPACE MEMORY.md");
    await w.runtime.registry.createThread("ada", "empty");
    await rm(join(w.workspace, "MEMORY.md"));
    await ensureActivePromptSnapshot(w.characterDir, w.config.dirs.config, "ada", undefined, "empty");
    await writeFile(join(w.workspace, "MEMORY.md"), "DEFERRED NEW MEMORY");
    expect(await loadPromptFileFromWorkspace(w.characterDir, w.workspace, "MEMORY.md", "empty")).toBeUndefined();
    expect(await expand("empty")).toBe("");
    expect(await expand("diary")).toBe("DIARY SNAPSHOT MEMORY.md");
  } finally { await w.close(); }
});

test.each(["anthropic", "alternate"])("heartbeat applies a same-ID alias's token and iteration limits through %s", async (providerKey) => {
  const w = await world();
  try {
    w.config.models.chat.set("chat.quiet", {
      ...MODEL, name: "quiet", qualifiedName: "chat.quiet", providerKey,
      maxOutputTokens: 512, maxToolIterations: 1,
    });
    w.config.app.defaults.background.heartbeat = "quiet";
    const prepared = required(await prepareHeartbeatRequest("ada", w.config, { cache: w.runtime.cache }));
    expect(prepared.request.model).toBe(MODEL.modelId);
    expect(prepared.request.provider_key).toBe(providerKey);
    expect(prepared.request.max_tokens).toBe(512);
    expect(prepared.maxToolIterations).toBe(1);
    expect(prepared.override?.name).toBe("quiet");
    expect(prepared.thread).toBe("diary");
  } finally { await w.close(); }
});
