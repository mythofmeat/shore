import { prepareRequestImages } from "../prepare_images.ts";
import { recordProviderEvent } from "../provider_events.ts";
import { retryToolStream } from "../tool_loop.ts";
import { ToolLoopStop } from "../tool_loop_control.ts";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import {
  query,
  type CanUseTool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
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
  writeSession,
  type DeliveredEntry,
  type SessionRecord,
} from "./agent_sessions.ts";
import type { ContentBlock } from "../../engine/types.ts";
import { compareByCodePoint } from "../../util/sort.ts";
import { SHORE_MCP_SERVER, ToolNames, shoreToolServer } from "./claude_agent_tools.ts";
import { nativeHistoryStore, seedNativeHistory } from "./claude_agent_history.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import { budgetBlockFor } from "../../ledger/gate.ts";
import { cacheTtlTier } from "../cache_capability.ts";
import { hostZone } from "../../ledger/zoned.ts";
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
  type ToolLoopOptions,
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

export interface TurnPlan {
  resume?: string;
  resumeSessionAt?: string;
  fork: boolean;
  keptEntries: DeliveredEntry[];
  delivered: WireMessage[];
}

function coldStart(msgs: readonly WireMessage[]): TurnPlan {
  return {
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
    return {
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
  return {
    resume: record.entries[anchor]?.sessionId ?? record.sessionId,
    resumeSessionAt: at,
    fork: true,
    keptEntries: record.entries.slice(0, anchor + 1),
    delivered: [...resumed],
  };
}

interface NativeTurnPlan extends TurnPlan {
  content: ContentBlock[];
  sessionStore: SessionStore;
}

async function withNativeHistory(plan: TurnPlan, req: SidecarRequest, path: string, key: string, record: SessionRecord | undefined): Promise<NativeTurnPlan> {
  const continuing = plan.resume !== undefined && !plan.fork;
  const pending = continuing ? record?.pendingAssistantHashes ?? [] : [];
  const acknowledged = !continuing || (
    pending.length === (record?.pendingAssistantUuids?.length ?? 0) &&
    pending.every((hash, index) => {
      const message = plan.delivered[index];
      return message?.role === "assistant" && messageHash(message) === hash;
    })
  );
  const remaining = plan.delivered.slice(pending.length);
  const current = remaining[0];
  if ((plan.resume === undefined || record?.storedTranscript === true) && acknowledged && remaining.length === 1 && current?.role === "user" &&
    !current.content.some((block) => block.type === "tool_use" || block.type === "tool_result")) {
    const kept = continuing ? record?.pendingAssistantUuids?.at(-1) : undefined;
    return {
      ...plan,
      ...(kept === undefined ? {} : { resumeSessionAt: kept }),
      content: current.content,
      sessionStore: nativeHistoryStore(path, key, record?.model === req.model),
    };
  }
  const seeded = await seedNativeHistory(req, nativeHistoryStore(path, key, record?.model === req.model));
  shoreLog.info("claude_agent: initialized native history from Shore's active conversation");
  return {
    content: seeded.promptContent,
    sessionStore: seeded.sessionStore,
    resume: seeded.sessionId,
    fork: false,
    keptEntries: req.messages.slice(0, -1).map((message, index) => {
      const uuid = seeded.assistantUuids.get(index);
      return { hash: messageHash(message), ...(uuid === undefined ? {} : { uuid }) };
    }),
    delivered: req.messages.slice(-1),
  };
}

function withSystemInstructions(req: SidecarRequest): { request: SidecarRequest; instructions: ContentBlock[] } {
  const instructions: ContentBlock[] = req.messages
    .filter((message) => message.role === "system")
    .map((message) => ({ type: "text", text: message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") }));
  if (instructions.length === 0 && req.messages.at(-1)?.role !== "assistant") return { request: req, instructions };
  const messages = req.messages.filter((message) => message.role !== "system");
  if (messages.at(-1)?.role === "assistant") {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue according to the system instructions." }] });
  }
  return { request: { ...req, messages }, instructions };
}

export function nextEntries(
  plan: TurnPlan,
  pendingAssistantUuids: readonly string[] | undefined,
): DeliveredEntry[] {
  const entries: DeliveredEntry[] = plan.keptEntries.map((entry) =>
    plan.fork && entry.uuid !== undefined && plan.resume !== undefined
      ? { ...entry, sessionId: entry.sessionId ?? plan.resume }
      : { ...entry },
  );
  const pending = plan.resume === undefined || plan.fork ? [] : [...(pendingAssistantUuids ?? [])];
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
  const callType = req.context?.call_type;
  const scope = callType === undefined || callType === "message" || callType === "tool_loop" || callType === "keepalive"
    ? undefined : callType === "heartbeat_tool_loop" ? "heartbeat" : callType;
  return sessionKey(
    req.context?.character ?? "default",
    req.context?.ledger ?? "",
    req.context?.thread ?? MAIN_THREAD,
    scope,
  );
}

export interface AgentToolSurface {
  instance: McpServer;
  canUseTool: CanUseTool;
  maxTurns: number;
  timeoutMs: number;
}

export function claudeAgentEnvironment(baseUrl?: string, apiKey = ""): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TZ: hostZone(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    CLAUDE_SECURESTORAGE_CONFIG_DIR:
      process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "",
  };
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  if (baseUrl !== undefined) env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey !== "") env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

function buildOptions(
  req: SidecarRequest,
  plan: NativeTurnPlan,
  abort: AbortController,
  surface?: AgentToolSurface,
): Options {
  const env = claudeAgentEnvironment(req.base_url, req.api_key);
  if (surface !== undefined) env.MAX_MCP_OUTPUT_TOKENS = String(MCP_OUTPUT_CEILING_TOKENS);

  const system = systemToText(req.system);
  const effort = agentEffort(req.provider_options?.reasoning_effort);
  const cacheTtl = cacheTtlTier(req.provider_options?.cache_ttl);

  return {
    model: req.model,
    thinking: agentThinking(req),
    ...(effort === undefined ? {} : { effort }),
    ...(system === "" ? {} : { systemPrompt: { type: "custom" as const, prompt: system, snapshot: false } }),
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    skills: [],
    allowedTools: [],
    disallowedTools: NESTED_LOOP_TOOLS,
    settings: { autoCompactEnabled: false, ...(cacheTtl === undefined ? {} : { promptCacheTtl: cacheTtl }) },
    includePartialMessages: true,
    cwd: req.context?.workspace_dir ?? tmpdir(),
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
    sessionStore: plan.sessionStore,
    ...(plan.resumeSessionAt === undefined ? {} : { resumeSessionAt: plan.resumeSessionAt }),
    ...(plan.fork ? { forkSession: true } : {}),
  };
}

export function agentThinking(req: SidecarRequest): NonNullable<Options["thinking"]> {
  return { type: "adaptive", display: req.provider_options?.thinking_display ?? "summarized" };
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

function captureAgentEvent(msg: SDKMessage): void {
  if (msg.type === "rate_limit_event") {
    recordProviderEvent("claude_agent", msg);
  } else if (msg.type === "result") {
    recordProviderEvent("claude_agent", {
      type: msg.type,
      subtype: msg.subtype,
      session_id: msg.session_id,
      uuid: msg.uuid,
      result_index: msg.result_index,
      usage: msg.usage,
      modelUsage: msg.modelUsage,
      total_cost_usd: msg.total_cost_usd,
      num_turns: msg.num_turns,
      duration_ms: msg.duration_ms,
      duration_api_ms: msg.duration_api_ms,
      fast_mode_state: msg.fast_mode_state,
    });
  } else if (msg.type === "system" && msg.subtype === "init") {
    recordProviderEvent("claude_agent", {
      type: msg.type,
      subtype: msg.subtype,
      session_id: msg.session_id,
      model: msg.model,
      claude_code_version: msg.claude_code_version,
      apiKeySource: msg.apiKeySource,
    });
  }
}

async function* rawEventsOf(
  run: AsyncIterable<SDKMessage>,
  seen: SdkTurnFacts,
  onRoundStart?: () => Promise<void>,
  onRoundEnd?: () => Promise<void>,
): AsyncIterable<RawMessageStreamEvent> {
  const toolStarts = new Map<string, Extract<RawMessageStreamEvent, { type: "content_block_start" }>>();
  const streamedToolIndexes = new Set<number>();
  for await (const msg of run) {
    captureAgentEvent(msg);
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
      for (const block of msg.message.content) {
        if (block.type !== "tool_use") continue;
        const start = toolStarts.get(block.id);
        if (start === undefined) continue;
        toolStarts.delete(block.id);
        yield start;
        yield {
          type: "content_block_delta", index: start.index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        };
        yield { type: "content_block_stop", index: start.index };
      }
      continue;
    }

    if (msg.type === "stream_event") {
      const event = msg.event as RawMessageStreamEvent;
      if (event.type === "message_start") {
        toolStarts.clear();
        streamedToolIndexes.clear();
      }
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        toolStarts.set(event.content_block.id, event);
        streamedToolIndexes.add(event.index);
      }
      if ("index" in event && streamedToolIndexes.has(event.index)) continue;
      if (endsATurn(event)) seen.sawStopReason = true;
      if (event.type === "message_start" && onRoundStart !== undefined) await onRoundStart();
      yield event;
      if (event.type === "message_stop") await onRoundEnd?.();
      continue;
    }

    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      throw new Error(
        "claude_agent: the SDK compacted mid-turn, so its history no longer matches shore's",
      );
    }

    if (msg.type === "system" && msg.subtype === "mirror_error") {
      throw new Error(`claude_agent: failed to persist native history: ${msg.error}`);
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
  return (msg.type === "assistant" || msg.type === "user" || msg.type === "stream_event") &&
    typeof msg.parent_tool_use_id === "string";
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

export type AgentPrompt = AsyncIterable<SDKUserMessage>;

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

function agentPrompt(plan: NativeTurnPlan, instructions: ContentBlock[] = []): AgentPrompt {
  return oneUserTurn([...plan.content, ...instructions]);
}

const KEEPALIVE_REFUSAL = "a keepalive ping runs no tools";

export function keepalivePlan(record: SessionRecord | undefined, path: string, key: string, model: string): NativeTurnPlan {
  if (record?.version !== SESSION_BOOK_VERSION || record.storedTranscript !== true) {
    throw new Error("claude_agent: no stored session to keep warm; the next real turn creates one");
  }
  const kept = record.pendingAssistantUuids?.at(-1);
  const store = nativeHistoryStore(path, key, record.model === model);
  return {
    resume: record.sessionId,
    ...(kept === undefined ? {} : { resumeSessionAt: kept }),
    fork: true,
    keptEntries: [],
    delivered: [],
    content: [{ type: "text", text: "." }],
    sessionStore: { ...store, append: () => Promise.resolve() },
  };
}

function keepaliveSurface(req: SidecarRequest): AgentToolSurface | undefined {
  const defs = req.tools ?? [];
  if (defs.length === 0) return undefined;
  return {
    instance: shoreToolServer(defs, new ToolNames(defs), () => Promise.reject(new Error(KEEPALIVE_REFUSAL))),
    canUseTool: () => Promise.resolve({ behavior: "deny", message: KEEPALIVE_REFUSAL }),
    maxTurns: 1,
    timeoutMs: MCP_TOOL_TIMEOUT_MS,
  };
}

async function keepaliveUsage(run: AsyncIterable<SDKMessage>): Promise<Usage> {
  for await (const msg of run) {
    captureAgentEvent(msg);
    if (msg.type === "stream_event" && !isNestedFrame(msg) && msg.event.type === "message_start") {
      return usageFrom(msg.event.message.usage);
    }
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`claude_agent: keepalive ping failed (${msg.subtype})`);
      return usageFrom(msg.usage);
    }
  }
  throw new Error("claude_agent: keepalive ping ended before the API reported usage");
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
    const prepared = withSystemInstructions(await prepareRequestImages(req));
    req = prepared.request;
    const startedAt = Date.now();
    let firstTokenAt = 0;
    const acc = newTurnAccumulator();
    const blocks = new BlockAssembler();
    const seen: SdkTurnFacts = { subtype: "success", assistantUuids: [] };

    const path = this.#bookPath();
    const key = conversationKey(req);
    const record = readBook(path)[key];
    let plan = planTurn(record, req.messages);

    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });

    try {
      if ((req.tools?.length ?? 0) > 0) {
        throw new Error("Tool-capable generation requires a tool executor; use the shared tool loop");
      }
      yield { type: "start", model: req.model };
      const native = await withNativeHistory(plan, req, path, key, record);
      plan = native;

      const run = this.#runQuery({ prompt: agentPrompt(native, prepared.instructions), options: buildOptions(req, native, abort) });

      for await (const event of anthropicContentEvents(rawEventsOf(run, seen), acc)) {
        if (firstTokenAt === 0 && marksFirstToken(event)) firstTokenAt = Date.now();
        blocks.absorb(event);
        yield event;
      }

      if (seen.sessionId !== undefined) {
        writeSession(path, key, {
          version: SESSION_BOOK_VERSION,
          sessionId: seen.sessionId,
          entries: nextEntries(plan, record?.pendingAssistantUuids),
          storedTranscript: true,
          model: req.model,
          ...(seen.assistantUuids.length === 0
            ? {}
            : {
                pendingAssistantUuids: seen.assistantUuids,
                pendingAssistantHashes: [messageHash({ role: "assistant", content: blocks.finish() })],
              }),
        }, { record });
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

  streamWithTools(req: SidecarRequest, phase: ToolPhase, signal?: AbortSignal, options: ToolLoopOptions = {}): AsyncIterable<StreamEvent> {
    return retryToolStream(
      (tools, abortSignal) => claudeAgentToolLoopEvents(req, tools, abortSignal, {
        runQuery: this.#runQuery,
        bookPath: this.#bookPath,
      }, options),
      phase, signal, options.retry,
    );
  }

  async #keepalive(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const path = this.#bookPath();
    const key = conversationKey(req);
    const plan = keepalivePlan(readBook(path)[key], path, key, req.model);
    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });
    try {
      const run = this.#runQuery({
        prompt: agentPrompt(plan),
        options: buildOptions(req, plan, abort, keepaliveSurface(req)),
      });
      const usage = await keepaliveUsage(run);
      const total = Date.now() - startedAt;
      return {
        content: "",
        content_blocks: [],
        finish_reason: "keepalive",
        usage,
        timing: { total_ms: total, time_to_first_token_ms: total },
        model: req.model,
      };
    } finally {
      abort.abort();
    }
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    if (req.context?.call_type === "keepalive") return await this.#keepalive(req, signal);
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
  readonly #request: SidecarRequest;
  #assembler = new BlockAssembler();
  #results: ContentBlock[] = [];
  #claimed = new Set<string>();
  #turn: GenerateResponse | undefined;
  #finished = false;
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #failure: unknown;
  #serial: Promise<unknown> = Promise.resolve();
  #nativeMessages: { message: WireMessage; assistantRound?: number }[] = [];
  #assistantRounds = 0;
  #recordedAssistantRounds = 0;
  iterations = 0;
  stopped = false;

  constructor(phase: ToolPhase, request: SidecarRequest) {
    this.#phase = phase;
    this.#request = request;
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
  }

  absorb(event: StreamEvent): void {
    this.#assembler.absorb(event);
  }

  async modelFinished(acc: TurnAccumulator): Promise<void> {
    if (this.#turn !== undefined) return;
    const assistantRound = this.#assistantRounds++;
    this.#turn = {
      model: this.#request.model,
      content: acc.text,
      content_blocks: this.#assembler.finish(),
      finish_reason: acc.stopReason,
      usage: { ...acc.usage },
      timing: { total_ms: 0, time_to_first_token_ms: 0 },
    };
    try {
      await this.#phase.onTurn?.(this.#turn);
      if (this.#turn.content_blocks.some((block) => block.type === "tool_use")) {
        await this.#phase.recordTurn("assistant", this.#turn.content_blocks);
        this.#nativeMessages.push({
          message: { role: "assistant", content: this.#turn.content_blocks },
          assistantRound,
        });
        this.#recordedAssistantRounds = this.#assistantRounds;
      }
    } catch (error) {
      this.#failure = error;
      throw error;
    } finally {
      this.#resolveReady();
    }
  }

  async runTool(bare: string, input: unknown, signal: AbortSignal): Promise<ContentBlock> {
    const run = async (): Promise<ContentBlock> => {
      if (signal.aborted) throw new Error("SDK tool run aborted");
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("SDK tool run aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([this.#ready, aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (this.#failure !== undefined) throw this.#failure;
      const turn = this.#turn;
      const use = turn?.content_blocks.find((block) =>
        block.type === "tool_use" && block.name === bare &&
        canonicalJson(block.input) === canonicalJson(input) &&
        !this.#claimed.has(block.id));
      if (use?.type !== "tool_use") throw new Error(`SDK invoked ${bare} without a streamed tool call`);
      this.#claimed.add(use.id);
      const result = await this.#phase.runTool({ id: use.id, name: bare, input });
      this.#results.push(result);
      if (this.#results.length === turn?.content_blocks.filter((block) => block.type === "tool_use").length) {
        await this.finishTools();
      }
      return result;
    };
    if (this.#phase.parallel !== false) return run();
    const result = this.#serial.then(run);
    this.#serial = result.catch(() => {});
    return result;
  }

  async finishTools(): Promise<void> {
    if (this.#finished || this.#turn === undefined) return;
    this.#finished = true;
    this.iterations += 1;
    const results = this.#turn.content_blocks.flatMap((block) => {
      if (block.type !== "tool_use") return [];
      const found = this.#results.find((result) => result.type === "tool_result" && result.tool_use_id === block.id);
      return found === undefined ? [] : [found];
    });
    await this.#phase.recordTurn("user", results);
    this.#nativeMessages.push({ message: { role: "user", content: results } });
    await this.#phase.afterTurn?.(this.#turn);
    const before = this.#request.messages.map((message) => message.content.length);
    try {
      await this.#phase.beforeTurn?.(this.#request);
    } catch (error) {
      if (!(error instanceof ToolLoopStop)) throw error;
      this.stopped = true;
      return;
    }
    const added = this.#request.messages
      .flatMap((message, index) => message.content.slice(before[index] ?? 0)
        .flatMap((block) => block.type === "text" ? [block.text] : []))
      .join("\n");
    const last = this.#results.at(-1);
    if (added !== "" && last?.type === "tool_result") {
      last.content = typeof last.content === "string"
        ? `${last.content}\n\n${added}`
        : [...last.content, { type: "text", text: added }];
    }
  }

  finalBlocks(): ContentBlock[] {
    return this.#assembler.finish();
  }

  nativeEntries(assistantUuids: readonly string[]): DeliveredEntry[] {
    return this.#nativeMessages.map(({ message, assistantRound }) => {
      const uuid = assistantRound === undefined ? undefined : assistantUuids[assistantRound];
      return { hash: messageHash(message), ...(uuid === undefined ? {} : { uuid }) };
    });
  }

  pendingAssistantUuids(assistantUuids: readonly string[]): string[] {
    return assistantUuids.slice(this.#recordedAssistantRounds);
  }

  async close(acc: TurnAccumulator): Promise<void> {
    if (this.#turn === undefined) return;
    if (!this.#finished) {
      if (this.#results.length > 0) await this.finishTools();
      else await this.#phase.afterTurn?.(this.#turn);
    }
    this.#assembler = new BlockAssembler();
    this.#results = [];
    this.#claimed.clear();
    this.#turn = undefined;
    this.#finished = false;
    this.#failure = undefined;
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
    acc.text = "";
  }

  async finish(): Promise<void> {
    if (this.#turn !== undefined && !this.#finished) {
      if (this.#results.length > 0) await this.finishTools();
      else {
        this.#finished = true;
        await this.#phase.afterTurn?.(this.#turn);
      }
    }
  }
}

export async function* claudeAgentToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  deps: ClaudeAgentDeps = {},
  options: ToolLoopOptions = {},
): AsyncIterable<StreamEvent> {
  req = await prepareRequestImages(req);
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
  const record = readBook(path)[key];
  let plan = planTurn(record, req.messages);

  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const names = new ToolNames(defs);
  const round = new RoundLog(tools, req);
  const cap = req.max_tool_iterations;

  let toolFailure: unknown;
  const instance = shoreToolServer(defs, names, async (bare, input) => {
    try {
      return await round.runTool(bare, input, abort.signal);
    } catch (error) {
      toolFailure = error;
      abort.abort();
      throw error;
    }
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
    await tools.beforeTurn?.(req);
    const prepared = withSystemInstructions(await prepareRequestImages(req));
    Object.assign(req, prepared.request);
    plan = planTurn(record, req.messages);
    const native = await withNativeHistory(plan, req, path, key, record);
    plan = native;
    const run = (deps.runQuery ?? query)({
      prompt: agentPrompt(native, prepared.instructions),
      options: buildOptions(req, native, abort, {
        instance,
        canUseTool,
        maxTurns: cap === undefined ? TURN_BACKSTOP : options.capBehavior === "stop_after_dispatch" ? Math.max(1, cap) : cap + 2,
        timeoutMs: MCP_TOOL_TIMEOUT_MS,
      }),
    });

    const events = anthropicContentEvents(
      rawEventsOf(run, seen, async () => {
        if (round.stopped || (options.capBehavior === "stop_after_dispatch" && cap !== undefined && round.iterations >= cap)) {
          throw new ToolLoopStop();
        }
        await round.close(acc);
      }, () => round.modelFinished(acc)),
      acc,
    );
    for await (const streamed of events) {
      const event = withBareName(streamed, names);
      if (firstTokenAt === 0 && marksFirstToken(event)) firstTokenAt = Date.now();
      round.absorb(event);
      yield event;
    }

    if (toolFailure !== undefined) throw toolFailure;
    if (round.stopped) throw new ToolLoopStop();
    await round.finish();

    if (seen.sessionId !== undefined) {
      const pendingAssistantUuids = round.pendingAssistantUuids(seen.assistantUuids);
      writeSession(path, key, {
        version: SESSION_BOOK_VERSION,
        sessionId: seen.sessionId,
        entries: [
          ...nextEntries(plan, record?.pendingAssistantUuids),
          ...round.nativeEntries(seen.assistantUuids),
        ],
        storedTranscript: true,
        model: req.model,
        ...(pendingAssistantUuids.length === 0
          ? {}
          : {
              pendingAssistantUuids,
              pendingAssistantHashes: [messageHash({ role: "assistant", content: round.finalBlocks() })],
            }),
      }, { record });
    }

    const total = Date.now() - startedAt;
    const context = lastRoundUsage(acc);
    yield {
      type: "done",
      content: acc.text,
      finish_reason: options.capBehavior === "stop_after_dispatch" && cap !== undefined && round.iterations >= cap
        ? "tool_use" : finishReasonOf(seen, acc.stopReason),
      content_blocks: round.finalBlocks(),
      usage: seen.usage ?? acc.usage,
      ...(context === undefined ? {} : { context_usage: context }),
      timing: {
        total_ms: total,
        time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
      },
    };
  } catch (e) {
    if (e instanceof ToolLoopStop || toolFailure instanceof ToolLoopStop) {
      yield {
        type: "done", content: acc.text, content_blocks: round.finalBlocks(),
        finish_reason: options.capBehavior === "stop_after_dispatch" ? "tool_use" : "end_turn",
        usage: seen.usage ?? acc.usage,
        timing: { total_ms: Date.now() - startedAt, time_to_first_token_ms: firstTokenAt === 0 ? Date.now() - startedAt : firstTokenAt - startedAt },
      };
      return;
    }
    await round.finish();
    discardMissingAnchor(path, key, record, plan, e);
    yield { ...streamErrorEvent(e, seen.usage ?? acc.usage, startedAt, firstTokenAt, Date.now), cause: toolFailure ?? e };
  } finally {
    abort.abort();
  }
}
