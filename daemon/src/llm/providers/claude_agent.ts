import { limitRequestImages } from "../prepare_images.ts";
import { recordProviderEvent } from "../provider_events.ts";
import { retryToolStream } from "../tool_loop.ts";
import { addUsage } from "./generic_loop.ts";
import { ToolLoopStop } from "../tool_loop_control.ts";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import {
  query,
  type CanUseTool,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BetaMessage, BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";
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
import { claudeCodeLaunchFailure, claudeCodeOptions } from "./claude_code.ts";
import { nativeHistoryStore, seedNativeHistory, throwawayHistoryStore } from "./claude_agent_history.ts";
import { anchorKeys, contextFilterEnvironment, resultAnchor, type SystemNote } from "./claude_agent_injections.ts";
import { currentWireScope } from "../wire_capture.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import { budgetBlockFor } from "../../ledger/gate.ts";
import {
  claudeAccountInUse,
  claudeAccountNamed,
  claudeAccountSignedOut,
  claudeAccountsFreeAt,
  nextClaudeAccount,
  observeClaudeRateLimit,
  useClaudeAccount,
  type ClaudePlanCheck,
} from "../../ledger/plan_limits.ts";
import type { ClaudeAccount } from "../claude_accounts.ts";
import { claudePlanUsageEnvironment, fetchClaudePlanLimits, type ClaudePlanUsageQuery } from "../claude_plan_limits.ts";
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
  seeded?: true;
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
      sessionStore: nativeHistoryStore(path, key),
    };
  }
  const seeded = await seedNativeHistory(req, nativeHistoryStore(path, key));
  shoreLog.info("claude_agent: initialized native history from Shore's active conversation");
  return {
    content: seeded.promptContent,
    sessionStore: seeded.sessionStore,
    resume: seeded.sessionId,
    seeded: true,
    fork: false,
    keptEntries: req.messages.slice(0, -1).map((message, index) => {
      const uuid = seeded.assistantUuids.get(index);
      return { hash: messageHash(message), ...(uuid === undefined ? {} : { uuid }) };
    }),
    delivered: req.messages.slice(-1),
  };
}

function splitSystemNotes(req: SidecarRequest): { request: SidecarRequest; notes: SystemNote[] } {
  if (!req.messages.some((message) => message.role === "system")) return { request: req, notes: [] };
  const messages = req.messages.filter((message) => message.role !== "system");
  const keys = anchorKeys(messages);
  const notes: SystemNote[] = [];
  let before = 0;
  for (const message of req.messages) {
    if (message.role !== "system") {
      before += 1;
      continue;
    }
    const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    if (text.trim() === "") continue;
    let reply = before;
    while (reply < messages.length && messages[reply]?.role !== "assistant") reply += 1;
    const anchor = messages[reply - 1]?.role === "user" ? keys[reply - 1]?.[0] : undefined;
    if (anchor === undefined) {
      shoreLog.warn("claude_agent: left out a system message with no user turn before the reply it applies to");
      continue;
    }
    notes.push({ anchor, text });
  }
  return { request: { ...req, messages }, notes };
}

function turnNotes(record: SessionRecord | undefined, plan: NativeTurnPlan, messages: readonly WireMessage[], current: readonly SystemNote[]): SystemNote[] {
  const prefix = new Set(plan.seeded === true ? [] : anchorKeys(messages.slice(0, plan.keptEntries.length)).flat());
  const notes: SystemNote[] = (record?.systemNotes ?? []).flatMap(({ anchor, text }) => prefix.has(anchor) ? [{ anchor, text }] : []);
  for (const note of current) {
    if (!notes.some((kept) => kept.anchor === note.anchor && kept.text === note.text)) notes.push({ ...note });
  }
  return notes;
}

function deliveredNotes(notes: readonly SystemNote[]): Pick<SessionRecord, "systemNotes"> {
  const sent = notes.flatMap((note) => note.delivered === true ? [{ anchor: note.anchor, text: note.text }] : []);
  return sent.length === 0 ? {} : { systemNotes: sent };
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

interface AgentToolSurface {
  instance: McpServer;
  canUseTool: CanUseTool;
  maxTurns: number | undefined;
  timeoutMs: number;
}

export function claudeAgentEnvironment(baseUrl?: string, apiKey = "", configDir?: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TZ: hostZone(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    CLAUDE_CODE_THINKING_DISPLAY_UPDATES: "0",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    CLAUDE_SECURESTORAGE_CONFIG_DIR:
      configDir ?? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "",
  };
  const config = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (config !== undefined) env.CLAUDE_CONFIG_DIR = config;
  if (baseUrl !== undefined) env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey !== "") env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

function buildOptions(
  req: SidecarRequest,
  plan: NativeTurnPlan,
  abort: AbortController,
  surface: AgentToolSurface | undefined,
  notes: readonly SystemNote[],
): Options {
  const account = accountFor(req);
  const env = { ...claudeAgentEnvironment(req.base_url, req.api_key, account.configDir), ...contextFilterEnvironment(req.base_url, currentWireScope(), notes) };
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
    permissionMode: "default",
    settings: { autoCompactEnabled: false, ...(cacheTtl === undefined ? {} : { promptCacheTtl: cacheTtl }) },
    includePartialMessages: true,
    cwd: req.context?.workspace_dir ?? tmpdir(),
    env,
    ...claudeCodeOptions(),
    abortController: abort,
    ...(surface === undefined
      ? { maxTurns: 1 }
      : {
          ...(surface.maxTurns === undefined ? {} : { maxTurns: surface.maxTurns }),
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

function agentThinking(req: SidecarRequest): NonNullable<Options["thinking"]> {
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

function accountFor(req: Pick<SidecarRequest, "context">): ClaudeAccount {
  return claudeAccountNamed(req.context?.api_key_name) ?? claudeAccountInUse();
}

const ACCOUNT_REFUSALS: Partial<Record<SDKAssistantMessageError, { status: number; type: string; reason: string }>> = {
  rate_limit: { status: 429, type: "rate_limit_error", reason: "usage limit reached" },
  billing_error: { status: 402, type: "billing_error", reason: "payment required" },
  authentication_failed: { status: 401, type: "authentication_error", reason: "authentication failed" },
};

class ClaudeAccountRefusal extends Error {
  readonly status: number;
  readonly body: string;
  resetAt?: string;

  constructor(status: number, type: string, message: string) {
    super(`claude_agent: ${message}`);
    this.name = "ClaudeAccountRefusal";
    this.status = status;
    this.body = JSON.stringify({ type: "error", error: { type, message } });
  }
}

function noteWhenAccountsFree(e: unknown): void {
  if (!(e instanceof ClaudeAccountRefusal)) return;
  const free = claudeAccountsFreeAt();
  if (free !== undefined) e.resetAt = free;
}

function accountRefusal(error: SDKAssistantMessageError, message: BetaMessage): ClaudeAccountRefusal | undefined {
  const refusal = ACCOUNT_REFUSALS[error];
  if (refusal === undefined) return undefined;
  const said = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ").trim();
  return new ClaudeAccountRefusal(refusal.status, refusal.type, said === "" ? refusal.reason : `${refusal.reason}: ${said}`);
}

interface SdkTurnFacts {
  account: string;
  subtype: string;
  sessionId?: string;
  assistantUuids: string[];
  lastMessageId?: string;
  stopReason?: string;
  usage?: Usage;
  sawStopReason?: boolean;
  warnedNested?: boolean;
  refusal?: ClaudeAccountRefusal;
}

function finishReasonOf(seen: SdkTurnFacts, streamed: string): string {
  if (seen.subtype !== "success") return seen.subtype;
  if (seen.sawStopReason === true) return streamed;
  return seen.stopReason ?? streamed;
}

function endsATurn(event: RawMessageStreamEvent): boolean {
  return event.type === "message_delta" && event.delta.stop_reason !== null;
}

function captureAgentEvent(msg: SDKMessage, account: string): void {
  if (msg.type === "rate_limit_event") {
    recordProviderEvent("claude_agent", msg);
    observeClaudeRateLimit(msg.rate_limit_info, account);
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

const SYNTHETIC_MODEL = "<synthetic>";

function* unstreamedEvents(message: BetaMessage): Generator<BetaRawMessageStreamEvent> {
  yield { type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null, stop_details: null } };
  for (const [index, block] of message.content.entries()) {
    switch (block.type) {
      case "text":
        yield { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } };
        yield { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } };
        break;
      case "thinking":
        yield { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } };
        yield { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking, estimated_tokens: null } };
        yield { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } };
        break;
      case "redacted_thinking":
        yield { type: "content_block_start", index, content_block: block };
        break;
      case "tool_use":
        yield { type: "content_block_start", index, content_block: { ...block, input: {} } };
        yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } };
        break;
      default:
        continue;
    }
    yield { type: "content_block_stop", index };
  }
  yield {
    type: "message_delta",
    context_management: message.context_management,
    delta: {
      container: message.container,
      stop_details: message.stop_details,
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence,
    },
    usage: message.usage,
  };
  yield { type: "message_stop" };
}

async function* rawEventsOf(
  run: AsyncIterable<SDKMessage>,
  seen: SdkTurnFacts,
  onRoundStart?: () => Promise<void>,
  onRoundEnd?: () => Promise<void>,
): AsyncIterable<RawMessageStreamEvent> {
  const toolStarts = new Map<string, Extract<RawMessageStreamEvent, { type: "content_block_start" }>>();
  const streamedToolIndexes = new Set<number>();
  const startedMessages = new Set<string>();
  async function* emit(event: RawMessageStreamEvent): AsyncIterable<RawMessageStreamEvent> {
    if (endsATurn(event)) seen.sawStopReason = true;
    if (event.type === "message_start" && onRoundStart !== undefined) await onRoundStart();
    yield event;
    if (event.type === "message_stop") await onRoundEnd?.();
  }
  for await (const msg of refusedAtEnd(run, seen)) {
    captureAgentEvent(msg, seen.account);
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
      const refusal = msg.error === undefined ? undefined : accountRefusal(msg.error, msg.message);
      if (refusal !== undefined) {
        if (msg.error === "authentication_failed") claudeAccountSignedOut(seen.account);
        seen.refusal = refusal;
        continue;
      }
      if (!startedMessages.has(msg.message.id) && msg.error === undefined && msg.message.model !== SYNTHETIC_MODEL) {
        startedMessages.add(msg.message.id);
        for (const event of unstreamedEvents(msg.message)) yield* emit(event as RawMessageStreamEvent);
        continue;
      }
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
        startedMessages.add(event.message.id);
        toolStarts.clear();
        streamedToolIndexes.clear();
      }
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        toolStarts.set(event.content_block.id, event);
        streamedToolIndexes.add(event.index);
      }
      if ("index" in event && streamedToolIndexes.has(event.index)) continue;
      yield* emit(event);
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

async function* refusedAtEnd(run: AsyncIterable<SDKMessage>, seen: SdkTurnFacts): AsyncIterable<SDKMessage> {
  try {
    yield* run;
  } catch (e) {
    throw seen.refusal ?? e;
  }
  if (seen.refusal !== undefined) throw seen.refusal;
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

class BlockAssembler {
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

function agentPrompt(plan: NativeTurnPlan): AgentPrompt {
  return oneUserTurn(plan.content);
}

const KEEPALIVE_REFUSAL = "a keepalive ping runs no tools";
const KEEPALIVE_PROMPT: ContentBlock[] = [{ type: "text", text: "." }];

export async function keepalivePlan(req: SidecarRequest, record: SessionRecord | undefined, path: string, key: string): Promise<NativeTurnPlan & { notes: SystemNote[] }> {
  if (record?.version !== SESSION_BOOK_VERSION || record.storedTranscript !== true) return await unstoredKeepalivePlan(req);
  const kept = record.pendingAssistantUuids?.at(-1);
  const store = nativeHistoryStore(path, key);
  return {
    resume: record.sessionId,
    ...(kept === undefined ? {} : { resumeSessionAt: kept }),
    fork: true,
    keptEntries: [],
    delivered: [],
    content: KEEPALIVE_PROMPT,
    sessionStore: { ...store, append: () => Promise.resolve() },
    notes: (record.systemNotes ?? []).map(({ anchor, text }) => ({ anchor, text })),
  };
}

async function unstoredKeepalivePlan(req: SidecarRequest): Promise<NativeTurnPlan & { notes: SystemNote[] }> {
  const limited = await limitRequestImages(req);
  const answered = limited.messages.filter((message) => message.role !== "system").at(-1)?.role === "assistant";
  const { request, notes } = splitSystemNotes(answered
    ? { ...limited, messages: [...limited.messages, { role: "user", content: KEEPALIVE_PROMPT }] }
    : limited);
  const history = throwawayHistoryStore();
  const sessionStore = { ...history, append: () => Promise.resolve() };
  if (request.messages.length === 1) {
    return { fork: false, keptEntries: [], delivered: [], content: request.messages[0]?.content ?? [], sessionStore, notes };
  }
  const seeded = await seedNativeHistory(request, history);
  return { resume: seeded.sessionId, fork: true, keptEntries: [], delivered: [], content: seeded.promptContent, sessionStore, notes };
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

async function keepaliveUsage(run: AsyncIterable<SDKMessage>, account: string): Promise<Usage> {
  for await (const msg of run) {
    captureAgentEvent(msg, account);
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
  planQuery?: ClaudePlanUsageQuery;
}

export class ClaudeAgentProvider implements SidecarProvider {
  readonly #runQuery: AgentQuery;
  readonly #bookPath: () => string;
  readonly #planQuery: ClaudePlanUsageQuery | undefined;

  constructor(deps: ClaudeAgentDeps = {}) {
    this.#runQuery = deps.runQuery ?? query;
    this.#bookPath = deps.bookPath ?? bookPath;
    this.#planQuery = deps.planQuery;
  }

  planLimits(account: ClaudeAccount): Promise<ClaudePlanCheck> {
    const planQuery = this.#planQuery;
    if (planQuery === undefined) return Promise.resolve({ status: "unavailable" });
    return fetchClaudePlanLimits(planQuery, claudePlanUsageEnvironment(claudeAgentEnvironment(undefined, "", account.configDir)));
  }

  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const prepared = splitSystemNotes(await limitRequestImages(req));
    req = prepared.request;
    let notes: SystemNote[] = [];
    const startedAt = Date.now();
    let firstTokenAt = 0;
    const acc = newTurnAccumulator();
    let blocks = new BlockAssembler();
    const seen: SdkTurnFacts = { account: accountFor(req).name, subtype: "success", assistantUuids: [] };
    const restartRound = (): Promise<void> => {
      blocks = new BlockAssembler();
      acc.text = "";
      return Promise.resolve();
    };

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
      notes = turnNotes(record, native, req.messages, prepared.notes);

      const run = this.#runQuery({ prompt: agentPrompt(native), options: buildOptions(req, native, abort, undefined, notes) });

      for await (const event of anthropicContentEvents(rawEventsOf(run, seen, restartRound), acc)) {
        if (firstTokenAt === 0 && marksFirstToken(event)) firstTokenAt = Date.now();
        blocks.absorb(event);
        yield event;
      }

      const finalBlocks = blocks.finish();
      if (seen.sessionId !== undefined) {
        writeSession(path, key, {
          version: SESSION_BOOK_VERSION,
          sessionId: seen.sessionId,
          entries: nextEntries(plan, record?.pendingAssistantUuids),
          storedTranscript: true,
          model: req.model,
          ...deliveredNotes(notes),
          ...(seen.assistantUuids.length === 0
            ? {}
            : {
                pendingAssistantUuids: seen.assistantUuids,
                pendingAssistantHashes: [messageHash({ role: "assistant", content: finalBlocks })],
              }),
        }, { record });
      }

      const total = Date.now() - startedAt;
      const context = lastRoundUsage(acc);
      yield {
        type: "done",
        content: acc.text,
        finish_reason: finishReasonOf(seen, acc.stopReason),
        content_blocks: finalBlocks,
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
      const launch = claudeCodeLaunchFailure(e);
      noteWhenAccountsFree(e);
      const cause = launch ?? (e instanceof ClaudeAccountRefusal ? e : undefined);
      yield {
        ...streamErrorEvent(launch ?? e, seen.usage ?? acc.usage, startedAt, firstTokenAt, Date.now),
        ...(cause === undefined ? {} : { cause }),
      };
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
    const plan = await keepalivePlan(req, readBook(path)[key], path, key);
    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });
    try {
      const run = this.#runQuery({
        prompt: agentPrompt(plan),
        options: buildOptions(req, plan, abort, keepaliveSurface(req), plan.notes),
      });
      const usage = await keepaliveUsage(run, accountFor(req).name);
      const total = Date.now() - startedAt;
      return {
        content: "",
        content_blocks: [],
        finish_reason: "keepalive",
        usage,
        timing: { total_ms: total, time_to_first_token_ms: total },
        model: req.model,
      };
    } catch (e) {
      throw claudeCodeLaunchFailure(e) ?? e;
    } finally {
      abort.abort();
    }
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    if (req.context?.call_type === "keepalive") return await this.#keepalive(req, signal);
    let content = "";
    let content_blocks: ContentBlock[] = [];
    let finish_reason = "end_turn";
    let usage = emptyUsage();
    let timing = { total_ms: 0, time_to_first_token_ms: 0 };

    for await (const event of this.stream(req, signal)) {
      if (event.type === "done") {
        content = event.content;
        content_blocks = (event.content_blocks ?? []) as ContentBlock[];
        finish_reason = event.finish_reason;
        usage = event.usage;
        timing = event.timing;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    return {
      content,
      content_blocks,
      finish_reason,
      usage,
      timing,
      model: req.model,
    };
  }
}

const MCP_TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MCP_OUTPUT_CEILING_TOKENS = 1_000_000;

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
  readonly #notes: SystemNote[];
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

  constructor(phase: ToolPhase, request: SidecarRequest, notes: SystemNote[]) {
    this.#phase = phase;
    this.#request = request;
    this.#notes = notes;
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
    this.#request.messages.splice(before.length);
    for (const [index, message] of this.#request.messages.entries()) message.content.splice(before[index] ?? message.content.length);
    const result = results.find((block) => block.type === "tool_result");
    if (added.trim() !== "" && result?.type === "tool_result") {
      this.#notes.push({ anchor: resultAnchor(result.tool_use_id), text: added });
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

  get betweenRounds(): boolean {
    return this.#turn === undefined || this.#finished;
  }

  handOff(): WireMessage[] {
    const finished = this.#nativeMessages.map(({ message }) => message);
    this.#nativeMessages = [];
    this.#assistantRounds = 0;
    this.#recordedAssistantRounds = 0;
    return finished;
  }

  async close(acc: TurnAccumulator): Promise<void> {
    if (this.#turn !== undefined) {
      if (!this.#finished) {
        if (this.#results.length > 0) await this.finishTools();
        else await this.#phase.afterTurn?.(this.#turn);
      }
      this.#results = [];
      this.#claimed.clear();
      this.#turn = undefined;
      this.#finished = false;
      this.#failure = undefined;
      this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
    }
    this.#assembler = new BlockAssembler();
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

function onAccount(req: SidecarRequest, name: string): SidecarRequest {
  return req.context === undefined ? req : { ...req, context: { ...req.context, api_key_name: name } };
}

export async function* claudeAgentToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  deps: ClaudeAgentDeps = {},
  options: ToolLoopOptions = {},
): AsyncIterable<StreamEvent> {
  req = await limitRequestImages(req);
  const defs = req.tools ?? [];
  if (defs.length === 0) {
    yield* new ClaudeAgentProvider(deps).stream(req, signal);
    return;
  }

  const startedAt = Date.now();
  let firstTokenAt = 0;
  const acc = newTurnAccumulator();
  let seen: SdkTurnFacts = { account: accountFor(req).name, subtype: "success", assistantUuids: [] };
  let spent = emptyUsage();
  const usageSoFar = (): Usage => addUsage(spent, seen.usage ?? acc.usage);
  let current = req;

  const path = (deps.bookPath ?? bookPath)();
  const key = conversationKey(req);
  const record = readBook(path)[key];
  let plan = planTurn(record, req.messages);

  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const names = new ToolNames(defs);
  const notes: SystemNote[] = [];
  const round = new RoundLog(tools, req, notes);
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
    const blocked = budgetBlockFor(current);
    if (blocked !== undefined) {
      return Promise.resolve({ behavior: "deny", message: blocked.message });
    }
    return Promise.resolve({ behavior: "allow" });
  };

  try {
    yield { type: "start", model: req.model };
    await tools.beforeTurn?.(req);
    const prepared = splitSystemNotes(await limitRequestImages(req));
    Object.assign(req, prepared.request);
    plan = planTurn(record, req.messages);
    let native = await withNativeHistory(plan, req, path, key, record);
    plan = native;
    notes.push(...turnNotes(record, native, req.messages, prepared.notes));
    const refused = new Set<string>();
    for (;;) {
      const leg = new AbortController();
      const stopLeg = (): void => { leg.abort(); };
      if (abort.signal.aborted) stopLeg();
      abort.signal.addEventListener("abort", stopLeg, { once: true });
      try {
        const run = (deps.runQuery ?? query)({
          prompt: agentPrompt(native),
          options: buildOptions(current, native, leg, {
            instance,
            canUseTool,
            maxTurns: cap === undefined ? undefined : options.capBehavior === "stop_after_dispatch" ? Math.max(1, cap) : cap + 2,
            timeoutMs: MCP_TOOL_TIMEOUT_MS,
          }, notes),
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
        break;
      } catch (e) {
        if (!(e instanceof ClaudeAccountRefusal) || toolFailure !== undefined || !round.betweenRounds) throw e;
        refused.add(seen.account);
        let next = nextClaudeAccount(refused);
        while (next !== undefined && budgetBlockFor(onAccount(current, next.name)) !== undefined) {
          refused.add(next.name);
          next = nextClaudeAccount(refused);
        }
        if (next === undefined) throw e;
        abort.signal.removeEventListener("abort", stopLeg);
        stopLeg();
        const why = e.message.replace(/^claude_agent: /, "");
        useClaudeAccount(next.name, `"${seen.account}" refused a call partway through a turn: ${why}`);
        yield { type: "provider_warning", message: `Claude account ${seen.account} refused to go on (${why}); carrying on with ${next.name}` };
        spent = usageSoFar();
        await round.close(acc);
        acc.usage = emptyUsage();
        current = { ...onAccount(current, next.name), messages: [...current.messages, ...round.handOff()] };
        seen = { account: next.name, subtype: "success", assistantUuids: [] };
        native = await withNativeHistory(planTurn(record, current.messages), current, path, key, record);
        plan = native;
      }
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
        ...deliveredNotes(notes),
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
      usage: usageSoFar(),
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
        usage: usageSoFar(),
        timing: { total_ms: Date.now() - startedAt, time_to_first_token_ms: firstTokenAt === 0 ? Date.now() - startedAt : firstTokenAt - startedAt },
      };
      return;
    }
    await round.finish();
    discardMissingAnchor(path, key, record, plan, e);
    noteWhenAccountsFree(e);
    const failure = claudeCodeLaunchFailure(e) ?? e;
    yield { ...streamErrorEvent(failure, usageSoFar(), startedAt, firstTokenAt, Date.now), cause: toolFailure ?? failure };
  } finally {
    abort.abort();
  }
}
