import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import {
  query,
  type CanUseTool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

import { shoreLog } from "../../log.ts";
import {
  anthropicContentEvents,
  marksFirstToken,
  newTurnAccumulator,
  type TurnAccumulator,
} from "./anthropic.ts";

import { MAIN_THREAD } from "../../config/dirs.ts";
import {
  SESSION_BOOK_VERSION,
  SESSION_KEY_SEPARATOR,
  bookPath,
  readBook,
  sessionKey,
  writeBook,
  type DeliveredEntry,
  type SessionRecord,
} from "./agent_sessions.ts";
import type { ContentBlock } from "../../engine/types.ts";
import { compareByCodePoint } from "../../util/sort.ts";
import { omissionNotice } from "../images.ts";
import { SHORE_MCP_SERVER, ToolNames, shoreToolServer } from "./claude_agent_tools.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import { budgetBlockFor } from "../../ledger/gate.ts";
import {
  REASONING_OFF,
  streamErrorEvent,
  systemToText,
  type GenerateResponse,
  type SidecarProvider,
  type SidecarRequest,
  type StreamEvent,
  type Usage,
  type WireMessage,
} from "../types.ts";

const NESTED_LOOP_TOOLS = ["Task", "Agent", "Skill"];

export type { DeliveredEntry, SessionRecord } from "./agent_sessions.ts";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function canonicalJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareByCodePoint(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function blockFingerprint(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text:${block.text}`;
    case "image":
      return `image:${block.source.media_type}:${digest(block.source.data)}`;
    case "tool_use":
      return `tool_use:${block.id}:${block.name}:${canonicalJson(block.input)}`;
    case "tool_result": {
      const body =
        typeof block.content === "string"
          ? block.content
          : block.content.map(blockFingerprint).join(SESSION_KEY_SEPARATOR);
      return `tool_result:${block.tool_use_id}:${block.is_error === true ? "1" : "0"}:${digest(body)}`;
    }
    case "thinking":
      return `thinking:${block.signature ?? ""}:${digest(block.thinking)}`;
    case "redacted_thinking":
      return `redacted_thinking:${digest(block.data)}`;
  }
}

function hashableBlocks(msg: WireMessage): ContentBlock[] {
  return msg.content.filter((b) => !(b.type === "text" && b.text.trim() === ""));
}

function messageHash(msg: WireMessage): string {
  return digest([msg.role, ...hashableBlocks(msg).map(blockFingerprint)].join(SESSION_KEY_SEPARATOR));
}

function commonPrefix(hashes: readonly string[], entries: readonly DeliveredEntry[]): number {
  const limit = Math.min(hashes.length, entries.length);
  let i = 0;
  while (i < limit && hashes[i] === entries[i]?.hash) i += 1;
  return i;
}

function lastAssistantEntry(entries: readonly DeliveredEntry[], upto: number): number {
  for (let i = upto - 1; i >= 0; i -= 1) {
    if (entries[i]?.uuid !== undefined) return i;
  }
  return -1;
}

function resultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((inner) => {
      if (inner.type === "text") return inner.text;
      if (inner.type === "image") {
        return omissionNotice(inner.source.media_type, "this provider replays history as text");
      }
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function replayBlock(block: ContentBlock, attached: ContentBlock[]): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      attached.push(block);
      return `[image attached: ${block.source.media_type}]`;
    case "tool_use":
      return (
        `<prior_tool_call name="${block.name}">\n` +
        `${JSON.stringify(block.input)}\n</prior_tool_call>`
      );
    case "tool_result":
      return (
        `<prior_tool_result${block.is_error === true ? ' failed="true"' : ""}>\n` +
        `${resultText(block.content)}\n</prior_tool_result>`
      );
    case "thinking":
    case "redacted_thinking":
      return "";
  }
}

function replayText(msg: WireMessage, attached: ContentBlock[]): string {
  return hashableBlocks(msg)
    .map((block) => replayBlock(block, attached))
    .filter((text) => text !== "")
    .join("\n");
}


export interface Replay {
  text: string;
  images: ContentBlock[];
  content: ContentBlock[];
}

function renderReplay(msgs: readonly WireMessage[]): Replay {
  const images: ContentBlock[] = [];
  const text = msgs
    .map((m) => {
      const rendered = replayText(m, images);
      if (rendered.trim() === "") return "";
      if (m.role === "assistant") {
        return `<prior_assistant_turn>\n${rendered}\n</prior_assistant_turn>`;
      }
      return rendered;
    })
    .filter((t) => t !== "")
    .join("\n\n");
  return { text, images, content: replayContent(msgs) };
}

function replayContent(msgs: readonly WireMessage[]): ContentBlock[] {
  const latestUser = msgs.findLastIndex((m) => m.role === "user" &&
    hashableBlocks(m).some((block) => block.type === "text" || block.type === "image"));
  const content: ContentBlock[] = [{
    type: "text",
    text: "Conversation replay follows. Images inside prior_user_turn belong to that earlier turn; they are not new uploads. Respond to current_user_turn.",
  }];
  for (const [index, message] of msgs.entries()) {
    const tag = message.role === "assistant" ? "prior_assistant_turn"
      : index === latestUser ? "current_user_turn" : "prior_user_turn";
    content.push({ type: "text", text: `<${tag}>\n` });
    for (const block of hashableBlocks(message)) {
      if (block.type === "image") {
        content.push({ type: "text", text: `[image attached: ${block.source.media_type}]` }, block);
      } else {
        const text = replayBlock(block, []);
        if (text.trim() !== "") content.push({ type: "text", text });
      }
    }
    content.push({ type: "text", text: `\n</${tag}>` });
  }
  return content;
}

export interface TurnPlan {
  prompt: string;
  replayContent?: ContentBlock[];
  images: ContentBlock[];
  resume?: string;
  resumeSessionAt?: string;
  fork: boolean;
  keptEntries: DeliveredEntry[];
  delivered: WireMessage[];
}

function coldStart(msgs: readonly WireMessage[]): TurnPlan {
  const replay = renderReplay(msgs);
  return {
    prompt: replay.text,
    images: replay.images,
    replayContent: replay.content,
    fork: false,
    keptEntries: [],
    delivered: [...msgs],
  };
}

export function planTurn(record: SessionRecord | undefined, msgs: readonly WireMessage[]): TurnPlan {
  if (record === undefined || record.version !== SESSION_BOOK_VERSION) return coldStart(msgs);

  const hashes = msgs.map(messageHash);
  const k = commonPrefix(hashes, record.entries);
  const tail = msgs.slice(k);

  if (k === 0) return coldStart(msgs);

  if (k === record.entries.length && tail.length > 0) {
    const replay = renderReplay(tail.filter((m) => m.role !== "assistant"));
    return {
      prompt: replay.text,
      images: replay.images,
      replayContent: replay.content,
      resume: record.sessionId,
      fork: false,
      keptEntries: record.entries.slice(0, k),
      delivered: [...tail],
    };
  }

  const anchor = lastAssistantEntry(record.entries, k);
  const at = anchor < 0 ? undefined : record.entries[anchor]?.uuid;
  if (at === undefined) return coldStart(msgs);

  const resumed = msgs.slice(anchor + 1);
  const replay = renderReplay(resumed);
  return {
    prompt: replay.text,
    images: replay.images,
    replayContent: replay.content,
    resume: record.sessionId,
    resumeSessionAt: at,
    fork: true,
    keptEntries: record.entries.slice(0, anchor + 1),
    delivered: [...resumed],
  };
}

export function nextEntries(
  plan: TurnPlan,
  pendingAssistantUuids: readonly string[] | undefined,
): DeliveredEntry[] {
  const entries: DeliveredEntry[] = plan.keptEntries.map((entry) =>
    plan.fork ? { hash: entry.hash } : { ...entry },
  );
  const pending = plan.fork ? [] : [...(pendingAssistantUuids ?? [])];
  for (const m of plan.delivered) {
    const entry: DeliveredEntry = { hash: messageHash(m) };
    if (m.role === "assistant") {
      const uuid = pending.shift();
      if (uuid !== undefined) entry.uuid = uuid;
    }
    entries.push(entry);
  }
  return entries;
}

const MISSING_RESUME_ANCHOR = "No message found with message.uuid of:";

function errorChainContains(error: unknown, text: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (!seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") return current.includes(text);
    if (!(current instanceof Error)) return false;
    if (current.message.includes(text)) return true;
    current = current.cause;
  }
  return false;
}

function discardMissingAnchor(
  path: string,
  key: string,
  record: SessionRecord | undefined,
  plan: TurnPlan,
  error: unknown,
): void {
  if (
    record === undefined ||
    plan.resumeSessionAt === undefined ||
    !errorChainContains(error, MISSING_RESUME_ANCHOR)
  ) {
    return;
  }

  const latest = readBook(path);
  if (canonicalJson(latest[key]) !== canonicalJson(record)) return;
  delete latest[key];
  writeBook(path, latest);
  shoreLog.warn("claude_agent: discarded a session with a missing resume anchor");
}

export function conversationKey(req: SidecarRequest): string {
  return sessionKey(
    req.context?.character ?? "default",
    req.context?.ledger ?? "",
    req.context?.thread ?? MAIN_THREAD,
  );
}

export interface AgentToolSurface {
  instance: McpServer;
  canUseTool: CanUseTool;
  maxTurns: number;
  timeoutMs: number;
}

function buildOptions(
  req: SidecarRequest,
  plan: TurnPlan,
  abort: AbortController,
  surface?: AgentToolSurface,
): Options {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  if (surface !== undefined) env.MAX_MCP_OUTPUT_TOKENS = String(MCP_OUTPUT_CEILING_TOKENS);
  if (req.base_url !== undefined) env.ANTHROPIC_BASE_URL = req.base_url;
  if (req.api_key !== "") env.ANTHROPIC_API_KEY = req.api_key;

  const system = systemToText(req.system);
  const effort = agentEffort(req.provider_options?.reasoning_effort);

  return {
    model: req.model,
    ...(effort === undefined ? {} : { effort }),
    ...(system === "" ? {} : { systemPrompt: system }),
    settingSources: [],
    tools: [],
    skills: [],
    allowedTools: [],
    disallowedTools: NESTED_LOOP_TOOLS,
    settings: { autoCompactEnabled: false },
    includePartialMessages: true,
    cwd: tmpdir(),
    env,
    abortController: abort,
    ...(surface === undefined
      ? { maxTurns: 1 }
      : {
          maxTurns: surface.maxTurns,
          canUseTool: surface.canUseTool,
          mcpServers: {
            [SHORE_MCP_SERVER]: {
              type: "sdk" as const,
              name: SHORE_MCP_SERVER,
              instance: surface.instance,
              timeout: surface.timeoutMs,
            },
          },
        }),
    ...(plan.resume === undefined ? {} : { resume: plan.resume }),
    ...(plan.resumeSessionAt === undefined ? {} : { resumeSessionAt: plan.resumeSessionAt }),
    ...(plan.fork ? { forkSession: true } : {}),
  };
}

const AGENT_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;

type AgentEffort = (typeof AGENT_EFFORT)[number];

export function agentEffort(raw: string | undefined): AgentEffort | undefined {
  if (raw === undefined || raw === REASONING_OFF) return undefined;
  return (AGENT_EFFORT as readonly string[]).includes(raw) ? (raw as AgentEffort) : undefined;
}

function usageFrom(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, number>;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function lastRoundUsage(acc: TurnAccumulator): Usage | undefined {
  const u = acc.usage;
  const context = u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens;
  return context === 0 ? undefined : u;
}

interface SdkTurnFacts {
  subtype: string;
  sessionId?: string;
  assistantUuids: string[];
  lastMessageId?: string;
  stopReason?: string;
  usage?: Usage;
  sawStopReason?: boolean;
  warnedNested?: boolean;
}

function finishReasonOf(seen: SdkTurnFacts, streamed: string): string {
  if (seen.subtype !== "success") return seen.subtype;
  if (seen.sawStopReason === true) return streamed;
  return seen.stopReason ?? streamed;
}

function endsATurn(event: RawMessageStreamEvent): boolean {
  return event.type === "message_delta" && event.delta.stop_reason !== null;
}

async function* rawEventsOf(
  run: AsyncIterable<SDKMessage>,
  seen: SdkTurnFacts,
  onRoundStart?: () => Promise<void>,
): AsyncIterable<RawMessageStreamEvent> {
  for await (const msg of run) {
    const sid = (msg as { session_id?: string }).session_id;
    if (sid !== undefined) seen.sessionId = sid;

    if (isNestedFrame(msg)) {
      if (seen.warnedNested !== true) {
        seen.warnedNested = true;
        shoreLog.warn("claude_agent: ignoring nested frames — the SDK ran an agent of its own");
      }
      continue;
    }

    if (msg.type === "assistant") {
      noteAssistant(seen, msg.message.id, msg.uuid);
      continue;
    }

    if (msg.type === "stream_event") {
      const event = msg.event as RawMessageStreamEvent;
      if (endsATurn(event)) seen.sawStopReason = true;
      if (event.type === "message_start" && onRoundStart !== undefined) await onRoundStart();
      yield event;
      continue;
    }

    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      throw new Error(
        "claude_agent: the SDK compacted mid-turn, so its history no longer matches shore's",
      );
    }

    if (msg.type === "result") {
      seen.subtype = msg.subtype;
      seen.usage = usageFrom(msg.usage);
      if (msg.subtype === "success" && msg.stop_reason !== null) {
        seen.stopReason = msg.stop_reason;
      }
    }
  }
}

function noteAssistant(seen: SdkTurnFacts, messageId: string, uuid: string): void {
  const last = seen.assistantUuids.length - 1;
  if (seen.lastMessageId === messageId && last >= 0) {
    seen.assistantUuids[last] = uuid;
    return;
  }
  seen.lastMessageId = messageId;
  seen.assistantUuids.push(uuid);
}

function isNestedFrame(msg: SDKMessage): msg is SDKMessage & { parent_tool_use_id: string } {
  const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return typeof parent === "string";
}

export class BlockAssembler {
  readonly #blocks: ContentBlock[] = [];
  #text = "";
  #thinking = "";
  #signature: string | undefined;

  absorb(event: StreamEvent): void {
    switch (event.type) {
      case "text":
        this.#flushThinking();
        this.#text += event.text;
        break;
      case "thinking":
        this.#flushText();
        this.#thinking += event.text;
        break;
      case "thinking_signature":
        this.#signature = event.signature;
        break;
      case "redacted_thinking":
        this.#flushText();
        this.#flushThinking();
        this.#blocks.push({ type: "redacted_thinking", data: event.data });
        break;
      case "tool_use":
        this.#flushText();
        this.#flushThinking();
        this.#blocks.push({
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;
      default:
        break;
    }
  }

  finish(): ContentBlock[] {
    this.#flushText();
    this.#flushThinking();
    return this.#blocks;
  }

  #flushText(): void {
    if (this.#text === "") return;
    this.#blocks.push({ type: "text", text: this.#text });
    this.#text = "";
  }

  #flushThinking(): void {
    if (this.#thinking === "") return;
    this.#blocks.push({
      type: "thinking",
      thinking: this.#thinking,
      ...(this.#signature === undefined ? {} : { signature: this.#signature }),
    });
    this.#thinking = "";
    this.#signature = undefined;
  }
}

export type AgentPrompt = string | AsyncIterable<SDKUserMessage>;

export type AgentQuery = (params: {
  prompt: AgentPrompt;
  options: Options;
}) => AsyncIterable<SDKMessage>;

async function* oneUserTurn(content: ContentBlock[]): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

export function agentPrompt(plan: TurnPlan): AgentPrompt {
  if (plan.images.length === 0) return plan.prompt;
  return oneUserTurn(plan.replayContent ?? [{ type: "text", text: plan.prompt }, ...plan.images]);
}

export interface ClaudeAgentDeps {
  runQuery?: AgentQuery;
  bookPath?: () => string;
}

export class ClaudeAgentProvider implements SidecarProvider {
  readonly #runQuery: AgentQuery;
  readonly #bookPath: () => string;

  constructor(deps: ClaudeAgentDeps = {}) {
    this.#runQuery = deps.runQuery ?? query;
    this.#bookPath = deps.bookPath ?? bookPath;
  }

  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    let firstTokenAt = 0;
    const acc = newTurnAccumulator();
    const seen: SdkTurnFacts = { subtype: "success", assistantUuids: [] };

    const path = this.#bookPath();
    const key = conversationKey(req);
    const book = readBook(path);
    const record = book[key];
    const plan = planTurn(record, req.messages);

    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });

    try {
      yield { type: "start", model: req.model };

      const run = this.#runQuery({ prompt: agentPrompt(plan), options: buildOptions(req, plan, abort) });

      for await (const event of anthropicContentEvents(rawEventsOf(run, seen), acc)) {
        if (firstTokenAt === 0 && marksFirstToken(event)) firstTokenAt = Date.now();
        yield event;
      }

      if (seen.sessionId !== undefined) {
        book[key] = {
          version: SESSION_BOOK_VERSION,
          sessionId: seen.sessionId,
          entries: nextEntries(plan, record?.pendingAssistantUuids),
          ...(seen.assistantUuids.length === 0
            ? {}
            : { pendingAssistantUuids: seen.assistantUuids }),
        };
        writeBook(path, book);
      }

      const total = Date.now() - startedAt;
      const context = lastRoundUsage(acc);
      yield {
        type: "done",
        content: acc.text,
        finish_reason: finishReasonOf(seen, acc.stopReason),
        usage: seen.usage ?? acc.usage,
        ...(context === undefined ? {} : { context_usage: context }),
        timing: {
          total_ms: total,
          time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
        },
      };
    } catch (e) {
      abort.abort();
      discardMissingAnchor(path, key, record, plan, e);
      yield streamErrorEvent(e, seen.usage ?? acc.usage, startedAt, firstTokenAt, Date.now);
    }
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const blocks = new BlockAssembler();
    let content = "";
    let finish_reason = "end_turn";
    let usage = emptyUsage();
    let timing = { total_ms: 0, time_to_first_token_ms: 0 };

    for await (const event of this.stream(req, signal)) {
      if (event.type === "done") {
        content = event.content;
        finish_reason = event.finish_reason;
        usage = event.usage;
        timing = event.timing;
      } else if (event.type === "error") {
        throw new Error(event.message);
      } else {
        blocks.absorb(event);
      }
    }

    return {
      content,
      content_blocks: blocks.finish(),
      finish_reason,
      usage,
      timing,
      model: req.model,
    };
  }
}

const MCP_TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MCP_OUTPUT_CEILING_TOKENS = 1_000_000;

const TURN_BACKSTOP = 64;

const TOOL_BUDGET_SPENT =
  "You have used the tool budget for this turn. Answer with what you already have.";

function withBareName(event: StreamEvent, names: ToolNames): StreamEvent {
  if (event.type !== "tool_use") return event;
  const bare = names.bareOf(event.name);
  return bare === undefined ? event : { ...event, name: bare };
}

class RoundLog {
  readonly #phase: ToolPhase;
  readonly #pending = new Map<string, string[]>();
  #assembler = new BlockAssembler();
  #results: ContentBlock[] = [];
  #minted = 0;
  iterations = 0;

  constructor(phase: ToolPhase) {
    this.#phase = phase;
  }

  absorb(event: StreamEvent): void {
    this.#assembler.absorb(event);
    if (event.type !== "tool_use") return;
    const queue = this.#pending.get(event.name) ?? [];
    queue.push(event.id);
    this.#pending.set(event.name, queue);
  }

  claimId(bare: string): string {
    const claimed = this.#pending.get(bare)?.shift();
    if (claimed !== undefined) return claimed;
    this.#minted += 1;
    return `toolu_shore_${String(this.#minted)}`;
  }

  addResult(block: ContentBlock): void {
    this.#results.push(block);
  }

  finalBlocks(): ContentBlock[] {
    return this.#assembler.finish();
  }

  async close(acc: TurnAccumulator): Promise<void> {
    const blocks = this.#assembler.finish();
    this.#assembler = new BlockAssembler();
    acc.text = "";
    if (this.#results.length === 0) return;
    const results = this.#results;
    this.#results = [];
    this.iterations += 1;
    await this.#phase.recordTurn("assistant", blocks);
    await this.#phase.recordTurn("user", results);
  }
}

export async function* claudeAgentToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  deps: ClaudeAgentDeps = {},
): AsyncIterable<StreamEvent> {
  const defs = req.tools ?? [];
  if (defs.length === 0) {
    yield* new ClaudeAgentProvider(deps).stream(req, signal);
    return;
  }

  const startedAt = Date.now();
  let firstTokenAt = 0;
  const acc = newTurnAccumulator();
  const seen: SdkTurnFacts = { subtype: "success", assistantUuids: [] };

  const path = (deps.bookPath ?? bookPath)();
  const key = conversationKey(req);
  const book = readBook(path);
  const record = book[key];
  const plan = planTurn(record, req.messages);

  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const names = new ToolNames(defs);
  const round = new RoundLog(tools);
  const cap = req.max_tool_iterations;

  const instance = shoreToolServer(defs, names, async (bare, input) => {
    const block = await tools.runTool({ id: round.claimId(bare), name: bare, input });
    round.addResult(block);
    return block;
  });

  const canUseTool: CanUseTool = (toolName) => {
    if (names.bareOf(toolName) === undefined) {
      return Promise.resolve({
        behavior: "deny",
        message: `${toolName} is not one of shore's tools`,
      });
    }
    if (cap !== undefined && round.iterations >= cap) {
      return Promise.resolve({ behavior: "deny", message: TOOL_BUDGET_SPENT });
    }
    const blocked = budgetBlockFor(req);
    if (blocked !== undefined) {
      return Promise.resolve({ behavior: "deny", message: blocked.message });
    }
    return Promise.resolve({ behavior: "allow" });
  };

  try {
    yield { type: "start", model: req.model };

    const run = (deps.runQuery ?? query)({
      prompt: agentPrompt(plan),
      options: buildOptions(req, plan, abort, {
        instance,
        canUseTool,
        maxTurns: cap === undefined ? TURN_BACKSTOP : cap + 2,
        timeoutMs: MCP_TOOL_TIMEOUT_MS,
      }),
    });

    const events = anthropicContentEvents(
      rawEventsOf(run, seen, () => round.close(acc)),
      acc,
    );
    for await (const streamed of events) {
      const event = withBareName(streamed, names);
      if (firstTokenAt === 0 && marksFirstToken(event)) firstTokenAt = Date.now();
      round.absorb(event);
      yield event;
    }

    if (seen.sessionId !== undefined) {
      book[key] = {
        version: SESSION_BOOK_VERSION,
        sessionId: seen.sessionId,
        entries: nextEntries(plan, record?.pendingAssistantUuids),
        ...(seen.assistantUuids.length === 0
          ? {}
          : { pendingAssistantUuids: seen.assistantUuids }),
      };
      writeBook(path, book);
    }

    const total = Date.now() - startedAt;
    const context = lastRoundUsage(acc);
    yield {
      type: "done",
      content: acc.text,
      finish_reason: finishReasonOf(seen, acc.stopReason),
      content_blocks: round.finalBlocks(),
      usage: seen.usage ?? acc.usage,
      ...(context === undefined ? {} : { context_usage: context }),
      timing: {
        total_ms: total,
        time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
      },
    };
  } catch (e) {
    discardMissingAnchor(path, key, record, plan, e);
    yield streamErrorEvent(e, seen.usage ?? acc.usage, startedAt, firstTokenAt, Date.now);
  } finally {
    abort.abort();
  }
}
