import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { filterInjectedContext, RESUME_PROMPT } from "../src/llm/providers/claude_agent_injections.ts";
import type { AnthropicRequestRecord } from "../src/testing/mock_anthropic.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import { toolResultText, type WireMessage } from "../src/llm/types.ts";
import { toolPhase } from "../src/tools/execute.ts";
import { noisePng } from "./support/test_images.ts";

const EMAIL = "someone.private@example.com";
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const SOUL = "# YOU ARE HEIDI\nYou are a companion, not a coding agent.";

function blocksOf(message: unknown): unknown {
  const { role, content } = message as { role: string; content: unknown };
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return JSON.stringify({ role, blocks }, (key, value: unknown) => key === "cache_control" ? undefined : value);
}

function keepsCachedPrefix(earlier: AnthropicRequestRecord, later: AnthropicRequestRecord): boolean {
  const before = earlier.body.messages.map(blocksOf);
  const after = later.body.messages.map(blocksOf);
  return before.every((message, index) => message === after[index]);
}

test("the model sees only what Shore sent, plus the SDK identity line subscription logins require, across tool loops, follow-ups, model switches and images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-injected-"));
  const workspace = join(dir, "heidi");
  await mkdir(workspace);
  await Bun.$`git -C ${workspace} init -q && git -C ${workspace} -c user.email=a@b -c user.name=a commit -q --allow-empty -m init`.quiet();
  await writeFile(join(workspace, "CLAUDE.md"), "PROJECT INSTRUCTIONS MARKER");
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: {
    emailAddress: EMAIL, accountUuid: "00000000-0000-4000-8000-000000000001",
    organizationUuid: "00000000-0000-4000-8000-000000000002",
  } }));
  const memory = join(dir, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, "MEMORY.md"), "- [AUTO MEMORY MARKER](note.md)");
  const mock = await startMockAnthropic({ script: [
    { toolUses: [{ id: "toolu_look", name: "bash", input: { command: "ls" } }] },
    { text: "First answer." }, { text: "Second answer." }, { text: "Third answer." },
  ] });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: dir, data: dir, cache: dir, runtime: dir },
    },
    providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
  };
  const image: ContentBlock = { type: "image", source: {
    type: "base64", media_type: "image/png", data: (await noisePng(8, 8)).toString("base64"),
  } };
  const history: WireMessage[] = [];
  const turn = async (model: string, content: ContentBlock[]) => {
    history.push({ role: "user", content });
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model,
      system: [{ label: "soul", text: SOUL }],
      tools: [{ name: "bash", description: "Run a shell command", input_schema: {
        type: "object", properties: { command: { type: "string" } }, required: ["command"],
      } }],
      context: { character: "heidi", workspace_dir: workspace, thinking_enabled: false, call_type: "message" },
      provider_options: { reasoning_effort: "max" },
      max_tokens: 1024, reasoning_replay: "all", messages: [...history],
    }, { providerKey: "claude-code" }, deps, {
      signal: AbortSignal.timeout(30_000), sink: () => {},
      tools: { messages: [], recordTurn: () => {}, runTool: (use: { id: string }) =>
        Promise.resolve({ type: "tool_result" as const, tool_use_id: use.id, content: "notes.txt" }) },
    });
    history.push({ role: "assistant", content: [{ type: "text", text: result.content }] });
  };
  try {
    await turn("opus", [{ type: "text", text: "What is in your room?" }]);
    await turn("opus", [{ type: "text", text: "Tell me more." }]);
    await turn("sonnet", [{ type: "text", text: "Look at this." }, image]);

    expect(mock.requests).toHaveLength(4);
    for (const sent of mock.requests) {
      expect(sent.body.messages).toContainEqual({ role: "system", content: [], output_config: { effort: "max" } });
    }
    const authored = new Set(["What is in your room?", "Tell me more.", "Look at this.", "First answer.", "Second answer."]);
    for (const sent of mock.requests) {
      const wire = JSON.stringify(sent.body);
      for (const leak of [EMAIL, "<system-reminder>", "PROJECT INSTRUCTIONS MARKER", "AUTO MEMORY MARKER",
        workspace, "x-anthropic-billing-header", "The exact model ID is", "Today's date is", "[Image: source:"]) {
        expect(wire).not.toContain(leak);
      }
      expect((sent.body.system as { text: string }[]).map(block => block.text)).toEqual([SDK_IDENTITY, SOUL]);
      for (const message of sent.body.messages as WireMessage[]) {
        if ((message.role as string) === "system") {
          expect(message.content.filter(block => block.type === "text")).toEqual([]);
          continue;
        }
        expect(["user", "assistant"]).toContain(message.role);
        for (const block of message.content) {
          if (block.type === "text") expect(authored).toContain(block.text);
          else expect(["tool_use", "tool_result", "image"]).toContain(block.type);
        }
      }
    }
    const [loopStart, loopEnd] = [required(mock.requests[0]), required(mock.requests[1])];
    expect(keepsCachedPrefix(loopStart, loopEnd)).toBe(true);
    expect(loopEnd.usage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(keepsCachedPrefix(loopStart, required(mock.requests[2]))).toBe(true);
    expect(required(mock.requests[2]).usage.cache_read_input_tokens).toBeGreaterThan(0);
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

test("a long tool result reaches the model as Shore made it, whole or cut once, and a long tool description arrives whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-results-"));
  const workspace = join(dir, "heidi");
  await mkdir(workspace);
  const mock = await startMockAnthropic({ script: [
    { toolUses: [{ id: "toolu_long", name: "bash", input: { command: "seq 1 30000" } }] },
    { toolUses: [{ id: "toolu_longer", name: "bash", input: { command: "head -c 300000 /dev/zero | tr '\\0' x" } }] },
    { text: "Done." },
  ] });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: dir, data: dir, cache: dir, runtime: dir },
    },
    providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
  };
  const phase = toolPhase({
    ctx: {
      workspaceDir: workspace, characterName: "heidi", characterDataDir: dir,
      imageDir: dir, conversationDir: dir, historyDbPath: join(dir, "history.db"), configDir: dir,
    },
    sendDirect: () => {}, limits: { max_result_chars: 0, timeout_ms: 20_000 },
    now: () => new Date().toISOString(), newMessageId: () => "unused",
  });
  const description = `Run a shell command. ${"Every word of this must arrive. ".repeat(200)}The end.`;
  try {
    await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "opus",
      system: [{ label: "soul", text: SOUL }],
      tools: [{ name: "bash", description, input_schema: {
        type: "object", properties: { command: { type: "string" } }, required: ["command"],
      } }],
      context: { character: "heidi", workspace_dir: workspace, thinking_enabled: false, call_type: "message" },
      max_tokens: 1024, reasoning_replay: "all",
      messages: [{ role: "user", content: [{ type: "text", text: "Count for me." }] }],
    }, { providerKey: "claude-code" }, deps, { signal: AbortSignal.timeout(60_000), sink: () => {}, tools: phase });

    const sent = required(mock.requests.at(-1));
    const tools = sent.body.tools as { name: string; description: string }[];
    expect(description.length).toBeGreaterThan(6_000);
    expect(required(tools.find(tool => tool.name === "bash")).description).toBe(description);

    const results = (sent.body.messages as WireMessage[]).flatMap(message => message.content)
      .flatMap(block => block.type === "tool_result" ? [toolResultText(block.content)] : []);
    const [long, longer] = [required(results[0]), required(results[1])];
    expect(results).toHaveLength(2);
    expect(long.length).toBeGreaterThan(168_000);
    expect(long.endsWith("\n29999\n30000")).toBe(true);
    expect(long).not.toContain("[tool_result truncated");
    expect(longer.match(/\[tool_result truncated/g)).toHaveLength(1);
    expect(longer).toContain("the first 144,000 characters are above this note and the last 96,000 are below it");
    expect(longer.endsWith("x".repeat(96_000))).toBe(true);
    expect(JSON.stringify(sent.body)).not.toContain("persisted-output");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

test("the context filter drops injected blocks, reports each with where it sat, keeps their cache breakpoint on the block before, and keeps the CLI's effort and tool controls", () => {
  const ttl = { type: "ephemeral", ttl: "1h" };
  const body = {
    model: "claude-opus-5",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=sdk-ts; cch=00000;" },
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: ttl },
      { type: "text", text: "You are Heidi.", cache_control: ttl },
    ],
    messages: [
      { role: "user", content: [
        { type: "text", text: "<system-reminder>\nThe user's email address is x.\n</system-reminder>\n" },
        { type: "text", text: "hello" },
      ] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        { type: "text", text: "[Image: source: /tmp/claude/images/1.png]", cache_control: ttl }] },
      { role: "user", content: "<system-reminder>context</system-reminder>" },
      { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
      { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
      { role: "system", content: [{ type: "text", text: "# Environment", cache_control: ttl }], output_config: { effort: "high" } },
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
      { role: "system", content: [{ type: "text", text: "<system-reminder>later</system-reminder>" },
        { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "look" } } }] },
      { role: "system", content: "<system-reminder>folded</system-reminder>", clear_at: "next_user_message" },
    ],
  };
  const filtered = filterInjectedContext(body);
  expect(filtered.body).toEqual({
    model: "claude-opus-5",
    system: [
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: ttl },
      { type: "text", text: "You are Heidi.", cache_control: ttl },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" }, cache_control: ttl }] },
      { role: "user", content: [{ type: "text", text: "continue", cache_control: ttl }] },
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
      { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "look" } } }] },
    ],
  });
  expect(filtered.removed).toEqual([
    { at: "system[0]", after: "the start", kind: "billing header", text: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=sdk-ts; cch=00000;" },
    { at: "messages[0].content[0]", after: "the start", kind: "system reminder", text: "<system-reminder>\nThe user's email address is x.\n</system-reminder>\n" },
    { at: "messages[2].content[1]", after: "user image", kind: "image source note", text: "[Image: source: /tmp/claude/images/1.png]" },
    { at: "messages[3]", after: "user text", kind: "system reminder", text: "<system-reminder>context</system-reminder>" },
    { at: "messages[4].content[0]", after: "user text", kind: "placeholder reply", text: "No response requested." },
    { at: "messages[5].content[0]", after: "assistant text", kind: "interruption note", text: "[Request interrupted by user for tool use]" },
    { at: "messages[7].content[0]", after: "user text", kind: "system message", text: "# Environment" },
    { at: "messages[9].content[0]", after: "assistant text", kind: "system message", text: "<system-reminder>later</system-reminder>" },
    { at: "messages[10]", after: "system tool_addition", kind: "system message", text: "<system-reminder>folded</system-reminder>" },
  ]);
});

test("a refused reply ends the turn with the refusal instead of a hidden retry, nudge or model switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-refusal-"));
  const mock = await startMockAnthropic({
    script: [{ text: "Partial reply before the stop", stopReason: "refusal" }],
    fallback: { text: "A retried answer." },
  });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  try {
    const turn = runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "opus",
      system: [{ label: "soul", text: SOUL }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      context: { character: "heidi", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
      max_tokens: 1024, reasoning_replay: "all",
    }, { providerKey: "claude-code" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: dir, data: dir, cache: dir, runtime: dir },
      },
      providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, { signal: AbortSignal.timeout(30_000), sink: () => {} });
    expect(await turn.then(() => "", (error: unknown) => (error as { message?: string }).message ?? String(error))).toContain("safeguards flagged this message");
    expect(mock.requests).toHaveLength(1);
    expect(JSON.stringify(mock.requests[0]?.body)).not.toContain("safety classifier");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("the filter tells injected context from the conversation by role, shape and exact wording", () => {
  const user = (content: unknown) => ({ role: "user", content });
  const text = (value: unknown, extra: Record<string, unknown> = {}) => ({ type: "text", text: value, ...extra });
  const nudge = "Your tool call was malformed and could not be parsed. Please retry.";
  const filtered = filterInjectedContext({
    system: [text("x-anthropic-billing-header: cc_version=1"), text("you are ada")],
    messages: [
      user([text("hello")]),
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
      user([text("<system-reminder>be brief</system-reminder>", { cache_control: { type: "ephemeral" } })]),
      user([text(RESUME_PROMPT), text(nudge)]),
      { role: "tool", content: [text("<system-reminder>not ours to judge</system-reminder>")] },
      user([text(5)]),
      user("plain words"),
      { role: "assistant", content: "<system-reminder>quoted by the model</system-reminder>" },
      user("<system-reminder>injected as a string</system-reminder>"),
      user(null),
    ],
  });
  expect(filtered.body).toStrictEqual({
    system: [text("you are ada")],
    messages: [
      user([text("hello", { cache_control: { type: "ephemeral" } })]),
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
      { role: "tool", content: [text("<system-reminder>not ours to judge</system-reminder>")] },
      user([text(5)]),
      user("plain words"),
      { role: "assistant", content: "<system-reminder>quoted by the model</system-reminder>" },
      user(null),
    ],
  });
  expect(filtered.removed.map((item) => item.kind)).toEqual(["billing header", "system reminder", "resume prompt", "retry nudge", "system reminder"]);
  expect(filterInjectedContext({ system: [text("x-anthropic-billing-header: cc_version=1")] })).toStrictEqual({ body: { system: [] }, removed: [{ at: "system[0]", after: "the start", kind: "billing header", text: "x-anthropic-billing-header: cc_version=1" }] });
});

test("a regenerate's note reaches the model with the new attempt and is gone from the next message, while an ordinary note stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-regen-note-"));
  const workspace = join(dir, "heidi");
  await mkdir(workspace);
  const mock = await startMockAnthropic({ script: [
    { text: "First answer." }, { text: "Second answer." }, { text: "Third answer." },
    { text: "Fourth answer." }, { text: "Fifth answer." },
  ] });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: dir, data: dir, cache: dir, runtime: dir },
    },
    providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
  };
  const send = async (thread: string, messages: WireMessage[]): Promise<string> => {
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "opus",
      system: [{ label: "soul", text: SOUL }],
      context: { character: "heidi", workspace_dir: workspace, thread, thinking_enabled: false, call_type: "message" },
      max_tokens: 1024, reasoning_replay: "all", messages,
    }, { providerKey: "claude-code" }, deps, { signal: AbortSignal.timeout(30_000), sink: () => {} });
    return result.content;
  };
  const user = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
  const said = (text: string): WireMessage => ({ role: "assistant", content: [{ type: "text", text }] });
  const note = (text: string, attemptOnly: boolean): WireMessage => ({
    role: "system", content: [{ type: "text", text }], ...(attemptOnly ? { attempt_only: true as const } : {}),
  });
  const wire = (index: number): string => JSON.stringify(required(mock.requests[index]).body.messages);
  try {
    const ask = user("What is in your room?");
    expect(await send("main", [ask])).toBe("First answer.");
    expect(await send("main", [ask, note("EARLIER ATTEMPT: First answer. REASON: too short", true)])).toBe("Second answer.");
    expect(await send("main", [ask, said("Second answer."), user("Tell me more.")])).toBe("Third answer.");
    expect(wire(1)).toContain("EARLIER ATTEMPT: First answer. REASON: too short");
    expect(wire(2)).toContain("Second answer.");
    expect(wire(2)).not.toContain("EARLIER ATTEMPT");

    const other = user("And outside?");
    expect(await send("side", [other, note("ORDINARY NOTE", false)])).toBe("Fourth answer.");
    expect(await send("side", [other, said("Fourth answer."), user("Go on.")])).toBe("Fifth answer.");
    expect(wire(3)).toContain("ORDINARY NOTE");
    expect(wire(4), "a note without the flag is still carried to later turns").toContain("ORDINARY NOTE");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);
