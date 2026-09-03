import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { MAIN_THREAD, resolveShoreDirs, rustJoin } from "../../config/dirs.ts";
import { shoreLog } from "../../log.ts";
import type { ContentBlock } from "../../engine/types.ts";
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

const BUILTIN_TOOLS = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "Edit",
  "EndConversation",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "KillShell",
  "ListAgents",
  "ListMcpResources",
  "Monitor",
  "NotebookEdit",
  "NotebookRead",
  "PushNotification",
  "Read",
  "ReadMcpResource",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendFeedback",
  "SendMessage",
  "Skill",
  "SlashCommand",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
];

const SEPARATOR = "\u0000";

export interface DeliveredEntry {
  hash: string;
  uuid?: string;
}

export interface SessionRecord {
  sessionId: string;
  entries: DeliveredEntry[];
  pendingAssistantUuid?: string;
}

type SessionBook = Record<string, SessionRecord>;

function bookPath(): string {
  return rustJoin(resolveShoreDirs().data, "claude_agent_sessions.json");
}

function readBook(path: string): SessionBook {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionBook;
  } catch {
    return {};
  }
}

function writeBook(path: string, book: SessionBook): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(book), "utf8");
  } catch {
    shoreLog.warn("claude_agent: session book unwritable");
  }
}

function messageText(msg: WireMessage): string {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function messageHash(msg: WireMessage): string {
  return createHash("sha256")
    .update(msg.role)
    .update(SEPARATOR)
    .update(messageText(msg))
    .digest("hex")
    .slice(0, 32);
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

function renderReplay(msgs: readonly WireMessage[]): string {
  return msgs
    .map((m) => {
      const text = messageText(m);
      if (text.trim() === "") return "";
      if (m.role === "assistant") return `<prior_assistant_turn>\n${text}\n</prior_assistant_turn>`;
      return text;
    })
    .filter((t) => t !== "")
    .join("\n\n");
}

export interface TurnPlan {
  prompt: string;
  resume?: string;
  resumeSessionAt?: string;
  fork: boolean;
  keptEntries: DeliveredEntry[];
  delivered: WireMessage[];
}

function coldStart(msgs: readonly WireMessage[]): TurnPlan {
  return { prompt: renderReplay(msgs), fork: false, keptEntries: [], delivered: [...msgs] };
}

export function planTurn(record: SessionRecord | undefined, msgs: readonly WireMessage[]): TurnPlan {
  if (record === undefined) return coldStart(msgs);

  const hashes = msgs.map(messageHash);
  const k = commonPrefix(hashes, record.entries);
  const tail = msgs.slice(k);

  if (k === 0) return coldStart(msgs);

  if (k === record.entries.length && tail.length > 0) {
    return {
      prompt: renderReplay(tail.filter((m) => m.role !== "assistant")),
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
    prompt: renderReplay(resumed),
    resume: record.sessionId,
    resumeSessionAt: at,
    fork: true,
    keptEntries: record.entries.slice(0, anchor + 1),
    delivered: [...resumed],
  };
}

export function nextEntries(plan: TurnPlan, pendingAssistantUuid: string | undefined): DeliveredEntry[] {
  const entries = [...plan.keptEntries];
  let pending = pendingAssistantUuid;
  for (const m of plan.delivered) {
    const entry: DeliveredEntry = { hash: messageHash(m) };
    if (m.role === "assistant" && pending !== undefined) {
      entry.uuid = pending;
      pending = undefined;
    }
    entries.push(entry);
  }
  return entries;
}

export function conversationKey(req: SidecarRequest): string {
  const character = req.context?.character ?? "default";
  const ledger = req.context?.ledger ?? "";
  const thread = req.context?.thread ?? MAIN_THREAD;
  const base = `${character}${SEPARATOR}${ledger}`;
  return thread === MAIN_THREAD ? base : `${base}${SEPARATOR}${thread}`;
}

function buildOptions(req: SidecarRequest, plan: TurnPlan): Options {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  if (req.base_url !== undefined) env.ANTHROPIC_BASE_URL = req.base_url;
  if (req.api_key !== "") env.ANTHROPIC_API_KEY = req.api_key;

  const system = systemToText(req.system);
  const effort = agentEffort(req.provider_options?.reasoning_effort);

  return {
    model: req.model,
    ...(effort === undefined ? {} : { effort }),
    ...(system === "" ? {} : { systemPrompt: system }),
    settingSources: [],
    allowedTools: [],
    disallowedTools: BUILTIN_TOOLS,
    includePartialMessages: true,
    maxTurns: 1,
    cwd: tmpdir(),
    env,
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

export class ClaudeAgentProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let usage = emptyUsage();
    let text = "";
    let thinking = "";
    let finish = "end_turn";
    let sessionId: string | undefined;
    let assistantUuid: string | undefined;

    const path = bookPath();
    const key = conversationKey(req);
    const book = readBook(path);
    const record = book[key];
    const plan = planTurn(record, req.messages);

    try {
      yield { type: "start", model: req.model };

      const run = query({ prompt: plan.prompt, options: buildOptions(req, plan) });
      if (signal !== undefined) {
        signal.addEventListener("abort", () => void run.interrupt?.(), { once: true });
      }

      for await (const msg of run as AsyncIterable<SDKMessage>) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid !== undefined) sessionId = sid;

        if (msg.type === "assistant") {
          const uuid = (msg as { uuid?: string }).uuid;
          if (uuid !== undefined) assistantUuid = uuid;
          continue;
        }

        if (msg.type === "stream_event") {
          const event = msg.event as {
            type: string;
            delta?: { type?: string; text?: string; thinking?: string };
          };
          if (event.type !== "content_block_delta") continue;
          if (firstTokenAt === 0) firstTokenAt = Date.now();
          if (event.delta?.type === "text_delta" && event.delta.text !== undefined) {
            text += event.delta.text;
            yield { type: "text", text: event.delta.text };
          } else if (event.delta?.type === "thinking_delta" && event.delta.thinking !== undefined) {
            thinking += event.delta.thinking;
            yield { type: "thinking", text: event.delta.thinking };
          }
          continue;
        }

        if (msg.type === "result") {
          usage = usageFrom((msg as { usage?: unknown }).usage);
          const subtype = (msg as { subtype?: string }).subtype ?? "success";
          if (subtype !== "success") finish = subtype;
        }
      }

      if (sessionId !== undefined) {
        book[key] = {
          sessionId,
          entries: nextEntries(plan, record?.pendingAssistantUuid),
          ...(assistantUuid === undefined ? {} : { pendingAssistantUuid: assistantUuid }),
        };
        writeBook(path, book);
      }

      const content_blocks: unknown[] = [];
      if (thinking !== "") content_blocks.push({ type: "thinking", thinking });
      content_blocks.push({ type: "text", text });

      yield {
        type: "done",
        content: text,
        finish_reason: finish,
        content_blocks,
        usage,
        timing: {
          total_ms: Date.now() - startedAt,
          time_to_first_token_ms: firstTokenAt === 0 ? 0 : firstTokenAt - startedAt,
        },
      };
    } catch (e) {
      yield streamErrorEvent(e, usage, startedAt, firstTokenAt, Date.now);
    }
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
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

    return { content, content_blocks, finish_reason, usage, timing, model: req.model };
  }
}
