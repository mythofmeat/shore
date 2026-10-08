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
import { withoutInjectedContext } from "../src/llm/providers/claude_agent_injections.ts";
import type { AnthropicRequestRecord } from "../src/testing/mock_anthropic.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { WireMessage } from "../src/llm/types.ts";
import { noisePng } from "./support/test_images.ts";

const EMAIL = "someone.private@example.com";
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

test("the model sees only what Shore sent, across tool loops, follow-ups, model switches and images", async () => {
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
    { toolUses: [{ id: "toolu_look", name: "mcp__shore__bash", input: { command: "ls" } }] },
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
      max_tokens: 1024, replay_prior_thinking: "all", messages: [...history],
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
    const authored = new Set(["What is in your room?", "Tell me more.", "Look at this.", "First answer.", "Second answer."]);
    for (const sent of mock.requests) {
      const wire = JSON.stringify(sent.body);
      for (const leak of [EMAIL, "<system-reminder>", "PROJECT INSTRUCTIONS MARKER", "AUTO MEMORY MARKER",
        workspace, "x-anthropic-billing-header", "Claude Agent SDK", "The exact model ID is", "Today's date is", "[Image: source:"]) {
        expect(wire).not.toContain(leak);
      }
      expect((sent.body.system as { text: string }[]).map(block => block.text)).toEqual([SOUL]);
      for (const message of sent.body.messages as WireMessage[]) {
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

test("withoutInjectedContext drops injected blocks and keeps their cache breakpoint on the block before", () => {
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
      { role: "system", content: [{ type: "text", text: "# Environment", cache_control: ttl }], output_config: { effort: "high" } },
    ],
  };
  expect(withoutInjectedContext(body)).toEqual({
    model: "claude-opus-5",
    system: [{ type: "text", text: "You are Heidi.", cache_control: ttl }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" }, cache_control: ttl }] },
    ],
  });
});

test("withoutInjectedContext leaves Shore's own text, tool results and assistant text alone", () => {
  const body = { system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude, and also Heidi." }], messages: [
    { role: "user", content: [{ type: "text", text: "[Image attached: image/png; this client does not support structured image results]" }] },
    { role: "assistant", content: [{ type: "text", text: "<system-reminder> quoted by the character" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "<system-reminder> printed by a tool" }] },
  ] };
  expect(withoutInjectedContext(body)).toEqual(body);
});
