import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import fixture from "./memory_fixtures/compaction.json";

import { pushAssistantTurn, pushInlineSystem } from "../src/llm/request";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../src/llm/types";
import { MarkdownMemoryStore } from "../src/memory/markdown_store";
import {
  handleCompactionOutcome,
  loadMessagesForCompaction,
  pushAfterCompaction,
} from "../src/memory/compaction/background";
import {
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_COMPACT_SYSTEM,
  stripOneTrailingNewline,
} from "../src/memory/compaction/prompts";
import {
  archiveSplitIndex,
  buildFinalMessage,
  buildSystem,
  compact,
  countTurns,
  findTurnSplit,
  trailingAutonomousLen,
  tryBeginCompaction,
  writeAllowedPath,
} from "../src/memory/compaction/manager";
import type {
  CompactionLlm,
  CompactionOutcome,
  CompactionTools,
  ConversationManager,
  ConversationMessage,
  ToolOutput,
} from "../src/memory/compaction/types";
import {
  normalizeProtectedPath,
  normalizePromptVisiblePath,
  normalizeWorkspacePath,
  resolvePath,
} from "../src/tools/workspace_path";

type Json = Record<string, unknown>;
const fx = fixture as unknown as Record<string, Json[] | string>;
const section = (name: string): Json[] => fx[name] as Json[];

describe("writeAllowedPath", () => {
  for (const rec of section("write_allowed_path")) {
    const path = rec.path as string;
    test(`${JSON.stringify(path)} -> ${String(rec.allowed)}`, () => {
      expect(writeAllowedPath(path)).toBe(rec.allowed as boolean);
    });
  }
});

describe("workspace path normalization", () => {
  for (const rec of section("workspace_paths")) {
    const path = rec.path as string;
    test(JSON.stringify(path), () => {
      expect(normalizeWorkspacePath(path)).toBe(rec.normalize_workspace_path as string);
      expect(normalizeProtectedPath(path) ?? null).toBe(
        (rec.normalize_protected_path as string | null) ?? null,
      );
      expect(normalizePromptVisiblePath(path) ?? null).toBe(
        (rec.normalize_prompt_visible_path as string | null) ?? null,
      );
      expect(normalizePromptVisiblePath(path) !== undefined).toBe(
        rec.is_prompt_visible_path as boolean,
      );

      const backslashTraversal = path.includes("\\") && path.split(/[/\\]/).includes("..");
      if (backslashTraversal) {
        expect(rec.resolve_path).toHaveProperty("ok");
        expect(() => resolvePath("/ws", path)).toThrow("path traversal (..) is not allowed");
        return;
      }

      const expected = rec.resolve_path as { ok?: string; err?: string };
      let actual: { ok?: string; err?: string };
      try {
        actual = { ok: resolvePath("/ws", path) };
      } catch (e) {
        actual = { err: (e as Error).message };
      }
      expect(actual).toEqual(expected);
    });
  }
});

describe("prompt rendering", () => {
  test("buildSystem", () => {
    for (const rec of section("build_system")) {
      expect(
        buildSystem(rec.template as string, rec.char as string, rec.user as string),
      ).toBe(rec.out as string);
    }
  });

  test("buildFinalMessage", () => {
    for (const rec of section("build_final_message")) {
      expect(
        buildFinalMessage(rec.template as string, rec.char as string, rec.user as string),
      ).toBe(rec.out as string);
    }
  });

  test("a stray closer before the opener terminates, where the Rust hung", () => {
    expect(buildFinalMessage("{{/if}} stray closer only", "C", "U")).toBe(
      "{{/if}} stray closer only",
    );
    expect(buildFinalMessage("{{/if}}A{{#if recap}}B{{/if}}C", "C", "U")).toBe("{{/if}}AC");
  });
});

describe("conversation splitting", () => {
  const shapes = fx["split_shapes"] as unknown as Record<string, Json[]>;
  for (const [i, rec] of section("splits").entries()) {
    const shape = shapes[rec.name as string];
    if (shape === undefined) throw new Error(`no split shape named ${String(rec.name)}`);
    const messages = shape.map(toConversationMessage);
    const keep = rec.keep_turns as number;
    const retain = rec.retain_trailing_autonomous as boolean;
    test(`${rec.name as string} keep=${keep} retain=${retain} [${i}]`, () => {
      expect(findTurnSplit(messages, keep)).toBe(rec.find_turn_split as number);
      expect(archiveSplitIndex(messages, keep, retain)).toBe(
        rec.archive_split_index as number,
      );
      expect(countTurns(messages)).toBe(rec.count_turns as number);
      expect(trailingAutonomousLen(messages)).toBe(rec.trailing_autonomous_len as number);
    });
  }
});

describe("the single-flight guard", () => {
  test("one pass per character data root", () => {
    const steps = section("run_guard");
    const held: Array<{ release(): void } | undefined> = [];
    const acquire = (dir: string, char: string) => {
      const g = tryBeginCompaction(dir, char);
      held.push(g);
      return g !== undefined;
    };

    expect(acquire("/guard-data-a", "Aria")).toBe(required(steps[0]).acquired as boolean);
    expect(acquire("/guard-data-a", "Aria")).toBe(required(steps[1]).acquired as boolean);
    expect(acquire("/guard-data-a", "Other")).toBe(required(steps[2]).acquired as boolean);
    expect(acquire("/guard-data-b", "Aria")).toBe(required(steps[3]).acquired as boolean);
    held[0]?.release();
    expect(acquire("/guard-data-a", "Aria")).toBe(required(steps[4]).acquired as boolean);

    for (const g of held) g?.release();
  });
});

describe("appending turns", () => {
  for (const [i, rec] of section("push_turns").entries()) {
    test(`${rec.name as string} provider=${String(rec.provider_key)} [${i}]`, () => {
      const req = chatRequest(twoMessages());
      const provider = rec.provider_key as string | null;
      if (provider === null) delete req.provider_key;
      else req.provider_key = provider;
      if (rec.name === "push_inline_system") {
        pushInlineSystem(req, "be brief");
      } else {
        pushAssistantTurn(req, responseFor(rec.name as string));
      }
      expect(normalizeMessages(req.messages)).toEqual(
        normalizeMessages(rec.messages as WireMessage[]),
      );
    });
  }
});

describe("the prompt templates", () => {
  test("import as text with exactly one trailing newline removed", () => {
    expect(DEFAULT_COMPACT_SYSTEM.length).toBeGreaterThan(0);
    expect(DEFAULT_COMPACT_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_COMPACT_SYSTEM.endsWith("\n")).toBe(false);
    expect(DEFAULT_COMPACT_PROMPT.endsWith("\n")).toBe(false);
  });

  test("stripping takes one trailing newline, not the run", () => {
    expect(stripOneTrailingNewline("a\n\n")).toBe("a\n");
    expect(stripOneTrailingNewline("a\n")).toBe("a");
    expect(stripOneTrailingNewline("a")).toBe("a");
    expect(stripOneTrailingNewline("")).toBe("");
  });
});

describe("loading a conversation", () => {
  test("flattens stored messages into what the split logic reads", async () => {
    const rec = fx.load_messages as unknown as Record<string, unknown>;
    const root = await mkdtemp(join(tmpdir(), "shore-compaction-load-"));
    try {
      await mkdir(join(root, "Aria"), { recursive: true });
      await writeFile(
        join(root, "Aria", "active.jsonl"),
        rec.active_jsonl as string,
        "utf8",
      );
      const loaded = await loadMessagesForCompaction(root, "Aria");
      expect(loaded.rawContent).toBe(rec.raw_content as string);
      expect(loaded.messages).toEqual(
        (rec.messages as Json[]).map(toConversationMessage),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("reporting an outcome", () => {
  for (const rec of section("outcome_mapping")) {
    test(rec.name as string, () => {
      const notifications: Json[] = [];
      const outcome = camelOutcome(rec.outcome as Json);
      const retained = handleCompactionOutcome("Aria", (title, body) => {
        notifications.push({ title, body, retained: 0 });
      }, outcome);
      expect(retained).toBe(rec.retained as number);
      const expected = (rec.notifications as Json[]).map((n) => ({
        title: n.title,
        body: n.body,
        retained: 0,
      }));
      expect(notifications).toEqual(expected);
    });
  }

  test("the post-compaction push fires only for a compacted outcome", async () => {
    for (const rec of section("outcome_mapping")) {
      const outcome = camelOutcome(rec.outcome as Json);
      for (const enabled of [true, false]) {
        let pushed = false;
        await pushAfterCompaction(enabled, outcome, async () => {
          pushed = true;
        });
        expect(pushed).toBe(enabled && outcome.kind === "compacted");
      }
    }
  });
});

describe("compaction passes", () => {
  for (const pass of section("passes")) {
    test(pass.name as string, async () => {
      await runPass(pass);
    });
  }
});

test("the fixture exercises dispatch, blocked tools, rejections and rollback", () => {
  const passes = section("passes");
  const dispatched = passes.filter((p) => (p.dispatches as Json[]).length > 0);
  expect(dispatched.length).toBeGreaterThan(10);

  const withRejections = passes.filter((p) =>
    ((p.final_request_messages as Json[] | null) ?? []).some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Json[]).some(
          (block) =>
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block.content.includes("blocked: compaction may only write"),
        ),
    ),
  );
  expect(withRejections.length).toBeGreaterThan(0);

  const rolledBack = passes.filter((p) => p.archive_fails === true);
  expect(rolledBack.length).toBeGreaterThan(0);
  for (const p of rolledBack) expect((p.dispatches as Json[]).length).toBeGreaterThan(0);

  const blocked = passes.filter((p) => {
    const outcome = p.outcome as Json | null;
    const called = (outcome?.tools_called as string[] | undefined) ?? [];
    return called.length > (p.dispatches as Json[]).length;
  });
  expect(blocked.length).toBeGreaterThan(2);
});

function toConversationMessage(m: Json): ConversationMessage {
  return {
    role: m.role as string,
    content: m.content as string,
    timestamp: m.timestamp as string,
    isToolResultOnly: m.is_tool_result_only as boolean,
    isAutonomous: m.is_autonomous as boolean,
  };
}

function twoMessages(): ConversationMessage[] {
  return [0, 1].map((i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i}`,
    timestamp: "2026-03-25T10:00:00Z",
    isToolResultOnly: false,
    isAutonomous: false,
  }));
}

function chatRequest(messages: ConversationMessage[]): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "mock-chat-model",
    api_key: "",
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: [{ type: "text", text: m.content }],
    })),
    system: [{ text: "mock chat system", label: "system" }],
    tools: [],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    provider_key: "mockprov",
  };
}

function responseFor(name: string): GenerateResponse {
  const base = { usage: emptyUsage(), timing: { total_ms: 0, time_to_first_token_ms: 0 }, model: "mock" };
  switch (name) {
    case "blocks":
      return {
        ...base,
        content: "",
        content_blocks: [
          { type: "tool_use", id: "call_0", name: "edit", input: { path: "memory/a.md", content: "x" } },
        ],
        finish_reason: "tool_use",
      };
    case "text_only":
      return { ...base, content: "hello", content_blocks: [{ type: "text", text: "hello" }], finish_reason: "end_turn" };
    case "empty":
      return { ...base, content: "", content_blocks: [], finish_reason: "end_turn" };
    case "whitespace_text":
      return { ...base, content: "   \n\t ", content_blocks: [], finish_reason: "end_turn" };
    case "unicode_space_text":
      return { ...base, content: " ", content_blocks: [], finish_reason: "end_turn" };
    case "bom_text":
      return { ...base, content: "﻿", content_blocks: [], finish_reason: "end_turn" };
    default:
      throw new Error(`unknown push_turns case ${name}`);
  }
}

const emptyUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
});

const READ_FAILED = /^(\w+) failed to read existing file: .*$/;

function normalizeMessageValue(key: string, value: unknown): unknown {
  if (key === "is_error" && value === false) return undefined;
  if (typeof value === "string") {
    const match = READ_FAILED.exec(value);
    if (match !== null) return `${match[1]} failed to read existing file: <io error>`;
  }
  return value;
}

function normalizeMessages(messages: readonly WireMessage[]): unknown {
  const normalized: unknown = JSON.parse(JSON.stringify(messages, normalizeMessageValue));
  return normalized;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[relative(root, path)] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return out;
}

class ScriptedLlm implements CompactionLlm {
  built: Json | undefined;
  request: SidecarRequest | undefined;
  readonly #responses: GenerateResponse[];

  constructor(responses: GenerateResponse[]) {
    this.#responses = [...responses];
  }

  buildInitialRequest(
    system: string,
    compactNowUser: WireMessage,
    chatRequest_: SidecarRequest,
  ): SidecarRequest {
    const first = compactNowUser.content[0];
    this.built = {
      system,
      chat_prefix_len: chatRequest_.messages.length,
      built_message_count: chatRequest_.messages.length + 1,
      compact_now_text: first?.type === "text" ? first.text : null,
    };
    const request: SidecarRequest = {
      ...chatRequest_,
      messages: [...chatRequest_.messages, compactNowUser],
    };
    pushInlineSystem(request, system);
    this.request = request;
    return request;
  }

  async generate(): Promise<GenerateResponse> {
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("llm: scripted LLM exhausted");
    return next;
  }
}

class RecordingMgr implements ConversationManager {
  readonly calls: Json[] = [];

  constructor(
    private readonly nextId: string,
    private readonly fail: boolean,
  ) {}

  async archiveAndRetain(
    conversationId: string,
    params: { keepLastN: number; activeContent: string },
  ): Promise<string> {
    this.calls.push({
      conversation_id: conversationId,
      keep_last_n: params.keepLastN,
      active_content: params.activeContent,
    });
    if (this.fail) throw new Error("conversation: simulated archive failure");
    return this.nextId;
  }
}

class ReplayTools implements CompactionTools {
  readonly gitCalls: Json[] = [];
  readonly seen: Json[] = [];
  #next = 0;

  constructor(
    readonly workspaceDir: string,
    readonly configDir: string,
    private readonly records: Json[],
  ) {}

  async dispatch(name: string, input: unknown): Promise<ToolOutput> {
    const rec = this.records[this.#next];
    this.#next += 1;
    if (rec === undefined) {
      throw new Error(`unexpected dispatch #${this.#next} for ${name}`);
    }
    this.seen.push({ name, input });
    expect({ name, input }).toEqual({ name: rec.name as string, input: rec.input });

    for (const [rel, body] of Object.entries(rec.writes as Record<string, string>)) {
      const path = join(this.workspaceDir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, "utf8");
    }
    for (const rel of rec.deletes as string[]) {
      await rm(join(this.workspaceDir, rel), { force: true });
    }
    return { output: rec.output as string, isError: rec.is_error as boolean };
  }

  async ensureWorkspaceGitRepo(
    workspaceDir: string,
    charName: string,
    reason: string,
  ): Promise<void> {
    expect(workspaceDir).toBe(this.workspaceDir);
    this.gitCalls.push({ call: "ensure_workspace_git_repo", char: charName, reason });
  }

  async gitCommitAll(
    workspaceDir: string,
    charName: string,
    message: string,
  ): Promise<boolean> {
    expect(workspaceDir).toBe(this.workspaceDir);
    this.gitCalls.push({ call: "git_commit_all", char: charName, message });
    return false;
  }

  get dispatchCount(): number {
    return this.#next;
  }
}

async function runPass(pass: Json): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shore-compaction-"));
  try {
    const workspace = join(root, "workspace");
    const memory = join(workspace, "memory");
    await mkdir(memory, { recursive: true });
    const dataDir = join(root, "data");
    await mkdir(join(dataDir, "Aria"), { recursive: true });

    for (const seed of pass.seed as Json[]) {
      const path = join(workspace, seed.path as string);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, seed.content as string, "utf8");
    }

    for (const rel of (pass.seed_dirs as string[] | undefined) ?? []) {
      await mkdir(join(workspace, rel), { recursive: true });
    }
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "not yours\n", "utf8");
    for (const link of (pass.seed_links as Json[] | undefined) ?? []) {
      const target = link.target === "<outside>" ? outside : join(workspace, link.target as string);
      await symlink(target, join(workspace, link.link as string));
    }

    const storeDir =
      pass.store_elsewhere === true ? join(root, "other", "memory") : memory;
    if (pass.store_elsewhere === true) await mkdir(storeDir, { recursive: true });
    const store =
      pass.with_store === true ? await MarkdownMemoryStore.open(storeDir) : undefined;
    const tools = new ReplayTools(
      workspace,
      pass.config_dir_set === true ? "/some/config" : "",
      pass.dispatches as Json[],
    );
    const llm = new ScriptedLlm(scriptFor(pass.name as string));
    const mgr = new RecordingMgr("new-conv-id", pass.archive_fails === true);
    const messageSets = fx["pass_message_sets"] as unknown as Record<string, Json[]>;
    const set = messageSets[pass.messages_ref as string];
    if (set === undefined) throw new Error(`no message set named ${String(pass.messages_ref)}`);
    const messages = set.map(toConversationMessage);

    expect(await snapshotTree(workspace)).toEqual(
      pass.workspace_before as Record<string, string>,
    );

    let outcome: unknown = null;
    let error: string | null = null;
    try {
      outcome = await compact(
        {
          conversationId: "conv-1",
          messages,
          activeContent: "line1\nline2\nline3\n",
          systemTemplate: "System for {{char}} and {{user}}.",
          promptTemplate: "Compact now, {{char}}.",
          charName: "Aria",
          userName: "Tom",
          llm,
          conversationMgr: mgr,
          ...(store === undefined ? {} : { markdownStore: store }),
          dryRun: pass.dry_run as boolean,
          ...(pass.keep_turns_override === null
            ? {}
            : { keepTurnsOverride: pass.keep_turns_override as number }),
          retainTrailingAutonomous: pass.retain_trailing_autonomous as boolean,
          chatRequest: chatRequest(messages),
          ...(pass.with_data_dir === true ? { dataDir } : {}),
          tools,
          ...(pass.max_tool_iterations === null
            ? {}
            : { maxToolIterations: pass.max_tool_iterations as number }),
        },
        { keepRecentTurns: pass.keep_recent_turns as number },
      );
    } catch (e) {
      error = (e as Error).message.replaceAll(await realpath(root), "<root>");
    }

    expect(error).toBe(pass.error as string | null);
    expect(outcome === null ? null : snakeOutcome(outcome as Json)).toEqual(
      pass.outcome as Json | null,
    );

    expect(tools.dispatchCount).toBe((pass.dispatches as Json[]).length);
    expect(tools.gitCalls).toEqual(pass.git_calls as Json[]);
    expect(mgr.calls).toEqual(pass.archive_calls as Json[]);
    expect(await snapshotTree(workspace)).toEqual(
      pass.workspace_after as Record<string, string>,
    );

    const built = pass.built_request as Json | null;
    expect(llm.built ?? null).toEqual(built);

    const finalMessages = pass.final_request_messages as WireMessage[] | null;
    if (finalMessages === null) {
      const expectedLength = ((built?.built_message_count as number | undefined) ?? 0) + 1;
      expect(llm.request?.messages.length ?? expectedLength).toBe(expectedLength);
    } else {
      expect(normalizeMessages(required(llm.request).messages)).toEqual(
        normalizeMessages(finalMessages),
      );
    }

    const queued = await queuedDeferredPaths(join(dataDir, "Aria"));
    expect(queued).toEqual(pass.deferred_queued_paths as string[]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function queuedDeferredPaths(characterDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(characterDir, "deferred_edits.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { path: string }).path);
}

function camelOutcome(outcome: Json): CompactionOutcome {
  const map: Record<string, string> = {
    memory_files_written: "memoryFilesWritten",
    conversation_id: "conversationId",
    new_conversation_id: "newConversationId",
    message_count: "messageCount",
    compacted_turns: "compactedTurns",
    retained_count: "retainedCount",
    retained_turns: "retainedTurns",
    markdown_paths: "markdownPaths",
    tool_rounds: "toolRounds",
    tools_called: "toolsCalled",
    would_write_files: "wouldWriteFiles",
    file_ops_preview: "fileOpsPreview",
    markdown_preview: "markdownPreview",
  };
  const out: Json = {};
  for (const [k, v] of Object.entries(outcome)) out[map[k] ?? k] = v;
  return out as unknown as CompactionOutcome;
}

function snakeOutcome(outcome: Json): Json {
  const map: Record<string, string> = {
    memoryFilesWritten: "memory_files_written",
    conversationId: "conversation_id",
    newConversationId: "new_conversation_id",
    messageCount: "message_count",
    compactedTurns: "compacted_turns",
    retainedCount: "retained_count",
    retainedTurns: "retained_turns",
    markdownPaths: "markdown_paths",
    toolRounds: "tool_rounds",
    toolsCalled: "tools_called",
    wouldWriteFiles: "would_write_files",
    fileOpsPreview: "file_ops_preview",
    markdownPreview: "markdown_preview",
  };
  const out: Json = {};
  for (const [k, v] of Object.entries(outcome)) out[map[k] ?? k] = v;
  return out;
}

const pass_name_is_dry = (n: string) => n.startsWith("dry_run");

function scriptFor(name: string): GenerateResponse[] {
  const base = {
    usage: emptyUsage(),
    timing: { total_ms: 0, time_to_first_token_ms: 0 },
    model: "mock",
  };
  const toolRound = (calls: Array<[string, unknown]>): GenerateResponse => ({
    ...base,
    content: "",
    content_blocks: calls.map(([toolName, input], i) => ({
      type: "tool_use" as const,
      id: `call_${i}`,
      name: toolName,
      input,
    })),
    finish_reason: "tool_use",
  });
  const editRound = (entries: Array<[string, string]>): GenerateResponse =>
    toolRound(entries.map(([path, content]) => ["edit", { path, content }]));
  const endTurn = (text: string): GenerateResponse => ({
    ...base,
    content: text,
    content_blocks: text === "" ? [] : [{ type: "text", text }],
    finish_reason: "end_turn",
  });

  const defaultScript = (): GenerateResponse[] => [
    editRound([["memory/daily/a.md", "# A\n"]]),
    endTurn("done"),
  ];

  switch (name) {
    case "two_writes_one_round":
      return [
        editRound([
          ["memory/daily/a.md", "# A\n"],
          ["memory/people/b.md", "# B\n"],
        ]),
        endTurn("done"),
      ];
    case "writes_memory_index":
      return [editRound([["MEMORY.md", "# Index\n- thread\n"]]), endTurn("done")];
    case "writes_memory_index_with_config_dir":
    case "writes_memory_index_without_data_dir":
      return [editRound([["MEMORY.md", "# Index\n"]]), endTurn("done")];
    case "no_writes_read_only":
      return [toolRound([["read", {}]]), endTurn("nothing to save")];
    case "no_writes_at_all":
      return [endTurn("nothing to save")];
    case "disallowed_paths_only":
      return [
        editRound([
          ["DREAMS.md", "x"],
          ["../escape.md", "y"],
          ["notes.md", "z"],
        ]),
        endTurn("tried"),
      ];
    case "mixed_allowed_and_disallowed":
      return [
        editRound([
          ["memory/ok.md", "# ok\n"],
          ["memory/dreams.md", "nope"],
          ["SOUL.md", "# soul\n"],
        ]),
        endTurn("mixed"),
      ];
    case "delete_is_blocked":
      return [
        toolRound([["delete", { path: "memory/a.md" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_missing_path":
      return [
        toolRound([["edit", { content: "no path" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_in_place_over_seed":
      return [
        toolRound([
          [
            "edit",
            {
              path: "memory/a.md",
              edits: [{ old_string: "old line", new_string: "new line" }],
            },
          ],
        ]),
        endTurn("edited"),
      ];
    case "edit_in_place_missing_file":
      return [
        toolRound([
          [
            "edit",
            { path: "memory/missing.md", edits: [{ old_string: "a", new_string: "b" }] },
          ],
        ]),
        endTurn("failed"),
      ];
    case "overwrite_existing_then_archive":
      return [editRound([["memory/a.md", "# replaced\n"]]), endTurn("done")];
    case "rollback_restores_on_archive_failure":
      return [
        editRound([
          ["memory/a.md", "# replaced\n"],
          ["memory/b.md", "# new\n"],
        ]),
        endTurn("done"),
      ];
    case "dry_run_records_preview":
      return [
        editRound([
          ["memory/a.md", "# A\n"],
          ["DREAMS.md", "nope"],
        ]),
        endTurn("preview"),
      ];
    case "dry_run_in_place_edit_has_no_preview_body":
      return [
        toolRound([
          ["edit", { path: "memory/a.md", edits: [{ old_string: "a", new_string: "b" }] }],
        ]),
        endTurn("preview"),
      ];
    case "dry_run_blocks_git":
      return [toolRound([["git", { subcommand: "status", args: [] }]]), endTurn("preview")];
    case "dry_run_without_store":
      return [editRound([["memory/a.md", "# A\n"]]), endTurn("preview")];
    case "cap_zero_rounds":
      return [editRound([["memory/a.md", "# A\n"]]), endTurn("done")];
    case "cap_one_round":
    case "two_rounds_uncapped":
      return [
        editRound([["memory/a.md", "# A\n"]]),
        editRound([["memory/b.md", "# B\n"]]),
        endTurn("done"),
      ];
    case "cap_two_rounds_model_stops_first":
      return [editRound([["memory/a.md", "# A\n"]]), endTurn("done")];
    case "llm_exhausted":
      return [editRound([["memory/a.md", "# A\n"]])];
    case "git_commit_allowed_live":
      return [
        editRound([["memory/a.md", "# A\n"]]),
        toolRound([["git", { subcommand: "add", args: ["memory/a.md"] }]]),
        endTurn("committed"),
      ];
    case "unknown_tool_passes_through":
      return [
        toolRound([["roll_dice", { notation: "1d1" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "write_tool_is_not_write_like":
      return [
        toolRound([["write", { path: "DREAMS.md", content: "x" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_with_non_string_path":
      return [
        toolRound([["edit", { path: 42, content: "x" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_with_non_string_content":
    case "dry_run_edit_with_non_string_content":
      return [
        toolRound([["edit", { path: "memory/a.md", content: 42 }]]),
        endTurn(pass_name_is_dry(name) ? "preview" : "done"),
      ];
    case "symlink_escape_only":
      return [editRound([["memory/link/secret.md", "owned"]]), endTurn("blocked")];
    case "edit_over_a_directory_only":
      return [editRound([["memory/sub", "clobber"]]), endTurn("blocked")];
    case "symlink_escape_is_rejected":
      return [
        editRound([["memory/link/secret.md", "owned"]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_over_a_directory":
      return [
        editRound([["memory/sub", "clobber"]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "index_plus_other_file":
      return [
        editRound([
          ["MEMORY.md", "# Index\n"],
          ["memory/a.md", "# A\n"],
        ]),
        endTurn("done"),
      ];
    case "other_file_only_queues_nothing":
      return [
        editRound([
          ["memory/a.md", "# A\n"],
          ["SOUL.md", "# soul\n"],
        ]),
        endTurn("done"),
      ];
    case "rollback_two_rounds_same_path":
      return [
        editRound([["memory/a.md", "# first\n"]]),
        editRound([["memory/a.md", "# second\n"]]),
        endTurn("done"),
      ];
    default:
      return defaultScript();
  }
}
