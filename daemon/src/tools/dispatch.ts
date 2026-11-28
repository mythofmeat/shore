import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";

import { shoreLog } from "../log.ts";

import { handleActivityHeatmap, type ActivityStatsLookup } from "./activity.ts";
import { handleApplyPatch } from "./apply_patch.ts";
import { handleBash, withPromptChanges } from "./bash.ts";
import { CharacterWorkspace } from "./character_workspace.ts";
import { DEFAULT_MAX_INLINE_IMAGE_BYTES } from "./media.ts";
import type { ProcessStreams } from "./process.ts";
import { decodeToolValue } from "./workspace_ops.ts";
import { InvalidArgs, NotImplemented, ToolIoError, ToolTimedOut } from "./errors.ts";
import { handleChatLogs, type ChatLogOptions } from "./history.ts";
import { handleModelHistory, type ModelHistoryQuery } from "./model_history.ts";
import { handleListTriggers } from "./list_triggers.ts";
import type { TriggersView } from "../autonomy/trigger_loop.ts";
import { hostZone } from "../ledger/zoned.ts";
import type { StartedSealedThread } from "./start_sealed_thread.ts";
import type { StartThreadRequest } from "./start_thread.ts";
import { handleSendMessage, type SendMessage } from "./send_message.ts";
import { handleThreads } from "./threads.ts";
import { reachableThreads } from "../autonomy/outbox.ts";
import { handleWakeInThread, type WaitingWake, type WakeHandOff, type WakeInThreadRequest } from "./wake_in_thread.ts";
import type { EditThreadRequest } from "./edit_thread.ts";
import type { ToolInput } from "./workspace.ts";
import { McpCancelled } from "../mcp/client.ts";
import type { ImagesConfig, SubagentConfig, ToolsConfig } from "../config/app.ts";
import type { Message } from "../engine/types.ts";
import type { NewSealedThread } from "../engine/sealed.ts";
import type { ThreadRecord } from "../engine/threads.ts";
import type { Texts } from "../texts/texts.ts";

export interface ToolContext {
  texts: Texts;
  thread?: string;
  conversation?: readonly Message[];
  fresh?: boolean;
  dryRun?: boolean;
  maxResultChars?: number;
  maxInlineImageBytes?: number;
  images?: ImagesConfig;
  cacheDir?: string;
  workspaceDir: string;
  workspace?: CharacterWorkspace;
  characterDataDir: string;
  conversationDir: string;
  characterName: string;
  historyDbPath: string;
  configDir: string;

  modelHistoryQuery?: ModelHistoryQuery;
  activityStats?: ActivityStatsLookup;

  historyIndexPath?: string;
  userName?: string;

  deferEdit?: (path: string) => Promise<void> | void;
  stoppedOutput?: (output: ProcessStreams) => void;
  trackWorkspaceWrite?: (name: string, input: unknown, write: () => Promise<unknown>) => Promise<unknown>;
  recordWorkspaceWrite?: <T>(run: () => Promise<T>) => Promise<T>;

  runSubagent?: (
    name: string,
    query: string,
    signal?: AbortSignal,
    toolUseId?: string,
  ) => Promise<unknown>;


  toolUseId?: string;

  mcpCall?: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;


  triggers?: () => Promise<TriggersView>;

  sendMessage?: SendMessage;

  guide?: (input: ToolInput) => string;

  wakeInThread?: (request: WakeInThreadRequest) => WakeHandOff;

  callOffWake?: (thread: string) => WaitingWake | undefined;

  startThread?: (request: StartThreadRequest) => Promise<void>;

  sealThread?: (request: NewSealedThread) => Promise<StartedSealedThread>;

  editThread?: (request: EditThreadRequest) => Promise<ThreadRecord | undefined>;

  signal?: AbortSignal;
}

export function deferEditTo(
  characterDataDir: string,
  queue: (dir: string, path: string) => Promise<void>,
): (path: string) => Promise<void> {
  return async (path: string) => {
    try {
      await queue(characterDataDir, path);
    } catch (e) {
      shoreLog.warn(`Failed to queue deferred edit: ${path}: ${String(e)}`);
    }
  };
}

function chatLogOptions(ctx: ToolContext): ChatLogOptions {
  return {
    texts: ctx.texts,
    character: ctx.characterName,
    dbPath: ctx.historyDbPath,
    dataDir: dirname(ctx.historyDbPath),
    thread: ctx.thread,
    fresh: ctx.fresh,
    indexPath: ctx.historyIndexPath,
    userName: ctx.userName,
  };
}

export function writesWorkspace(name: string): boolean {
  return ["bash", "edit", "apply_patch"].includes(name) || name.startsWith("mcp__");
}

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  if (ctx.dryRun && (["bash", "edit", "apply_patch", "wake_in_thread"].includes(name) || name.startsWith("mcp__"))) {
    throw new ToolIoError(ctx.texts.always("tool_dry_run", { tool: name }));
  }
  const args = (input ?? {}) as ToolInput;
  const workspace = ctx.workspace ?? new CharacterWorkspace(ctx.workspaceDir);

  switch (name) {
    case "read":
      return decodeToolValue(await workspace.call("read", {
        input: args,
        workspaceDir: ctx.workspaceDir,
        texts: ctx.texts.overrides(),
        ...(ctx.maxResultChars === undefined ? {} : { maxChars: ctx.maxResultChars }),
        ...(ctx.maxInlineImageBytes === undefined ? {} : { maxImageBytes: ctx.maxInlineImageBytes }),
        ...(ctx.images === undefined ? {} : { images: ctx.images }),
      }, ctx.signal));
    case "edit":
    case "apply_patch": {
      const write = () => withPromptChanges(ctx.texts, workspace,
        () => name === "edit" ? workspace.call("edit", { input: args, workspaceDir: ctx.workspaceDir, texts: ctx.texts.overrides() }, ctx.signal) : handleApplyPatch(args, workspace, ctx.signal), ctx.deferEdit);
      return await (ctx.trackWorkspaceWrite?.(name, input, write) ?? write());
    }
    case "chat_logs":
      return await handleChatLogs(args, ctx.conversationDir, chatLogOptions(ctx));

    case "model_history":
      return await handleModelHistory(ctx.texts, args, ctx.characterName, ctx.modelHistoryQuery);

    case "activity_heatmap":
      if (ctx.activityStats === undefined) {
        throw new ToolIoError(ctx.texts.always("activity_unavailable"));
      }
      return handleActivityHeatmap(args, ctx.activityStats);

    case "bash": {
      const write = () => handleBash(args, workspace, ctx.characterName, ctx.signal, ctx.deferEdit, ctx.stoppedOutput);
      return ctx.trackWorkspaceWrite === undefined ? await write()
        : await ctx.trackWorkspaceWrite(name, input, write);
    }

    case "threads":
      return await handleThreads(args, {
        list: {
          texts: ctx.texts,
          dataDir: dirname(ctx.historyDbPath),
          character: ctx.characterName,
          userName: ctx.userName ?? "the user",
          ...(ctx.thread === undefined ? {} : { thread: ctx.thread }),
        },
        timeZone: hostZone(),
        dryRun: ctx.dryRun,
        start: ctx.startThread,
        seal: ctx.sealThread,
        edit: ctx.editThread,
      });

    case "list_triggers":
      return handleListTriggers(ctx.texts, ctx.triggers?.(), ctx.userName ?? "the user");

    case "wake_in_thread": {
      const handOff = ctx.wakeInThread;
      const reach = await reachableThreads(dirname(ctx.historyDbPath), ctx.characterName);
      return handleWakeInThread(ctx.texts, args, ctx.thread, {
        handOff: handOff === undefined ? undefined : (request): WakeHandOff => [...reach.open, ...reach.sealed].includes(request.thread) ? handOff(request) : { kind: "no_thread" },
        callOff: ctx.callOffWake,
      }, ctx.userName ?? "the user");
    }

    case "send_message":
      return await handleSendMessage(ctx.texts, args, ctx.sendMessage);

    case "guide":
      if (ctx.guide === undefined) throw new ToolIoError(ctx.texts.always("guide_unavailable"));
      return ctx.guide(args);

    default: {
      if (name.startsWith("ask_")) {
        const agent = name.slice("ask_".length);
        const query = args["query"];
        if (typeof query !== "string") {
          throw new InvalidArgs(`${name} requires a string \`query\``);
        }
        if (ctx.runSubagent === undefined) throw new NotImplemented(`ask_${agent}`);
        return await ctx.runSubagent(agent, query, ctx.signal, ctx.toolUseId);
      }
      if (name.startsWith("mcp__")) {
        if (ctx.mcpCall === undefined) throw new NotImplemented(name);
        return await ctx.mcpCall(name, input, ctx.signal);
      }
      throw new NotImplemented(name);
    }
  }
}

export interface ToolLimitsView {
  max_result_chars: number;
  max_inline_image_bytes?: number;
  timeout_ms: number;
  config?: Record<string, { max_result_chars?: number; max_inline_image_bytes?: number; timeout_ms?: number }>;
}

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 3_600_000;

export function toolLimitsFrom(
  cfg: ToolsConfig,
  subagents?: ReadonlyMap<string, SubagentConfig>,
): ToolLimitsView {
  const overrides: NonNullable<ToolLimitsView["config"]> = {};
  for (const [name, override] of cfg.per_tool) {
    overrides[name] = {
      ...(override.max_result_chars === undefined
        ? {}
        : { max_result_chars: override.max_result_chars }),
      ...(override.timeout === undefined ? {} : { timeout_ms: override.timeout.asMillis() }),
      ...(override.max_inline_image_bytes === undefined ? {} : { max_inline_image_bytes: override.max_inline_image_bytes }),
    };
  }
  for (const [name, spec] of subagents ?? []) {
    const toolName = `ask_${name}`;
    const explicit = overrides[toolName];
    if (explicit?.timeout_ms !== undefined) continue;
    overrides[toolName] = {
      ...explicit,
      timeout_ms: spec.timeout?.asMillis() ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
    };
  }
  return {
    max_result_chars: cfg.max_result_chars,
    max_inline_image_bytes: cfg.max_inline_image_bytes,
    timeout_ms: cfg.timeout.asMillis(),
    config: overrides,
  };
}

const resultCeilings = new AsyncLocalStorage<number>();

export function withResultCeiling<T>(maxChars: number, run: () => T): T {
  return resultCeilings.run(maxChars, run);
}

export function resultCharsFor(cfg: ToolLimitsView, name: string): number {
  const configured = cfg.config?.[name]?.max_result_chars ?? cfg.max_result_chars;
  const ceiling = resultCeilings.getStore();
  if (ceiling === undefined) return configured;
  return configured === 0 ? ceiling : Math.min(configured, ceiling);
}

export function inlineImageBytesFor(cfg: ToolLimitsView, name: string): number {
  return cfg.config?.[name]?.max_inline_image_bytes ?? cfg.max_inline_image_bytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES;
}

export function timeoutFor(cfg: ToolLimitsView, name: string): number | undefined {
  const resolved = cfg.config?.[name]?.timeout_ms ?? cfg.timeout_ms;
  return resolved > 0 ? resolved : undefined;
}

export interface ToolResultWindow {
  output: string;
  truncated: boolean;
  originalChars: number;
  headChars: number;
  tailChars: number;
}

const HEAD_SHARE = 0.6;

function lineBreakBefore(chars: readonly string[], end: number): number {
  for (let at = end; at > end / 2; at -= 1) if (chars[at - 1] === "\n") return at;
  return end;
}

function lineBreakAfter(chars: readonly string[], start: number): number {
  const limit = start + (chars.length - start) / 2;
  for (let at = start; at < limit; at += 1) if (chars[at - 1] === "\n") return at;
  return start;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

export function windowToolResult(texts: Texts, output: string, maxChars: number): ToolResultWindow {
  const chars = Array.from(output);
  if (maxChars === 0 || chars.length <= maxChars) {
    return {
      output,
      truncated: false,
      originalChars: chars.length,
      headChars: chars.length,
      tailChars: 0,
    };
  }

  const headBudget = Math.max(1, Math.ceil(maxChars * HEAD_SHARE));
  const tailBudget = maxChars - headBudget;
  const headChars = lineBreakBefore(chars, headBudget);
  const tailStart = lineBreakAfter(chars, chars.length - tailBudget);
  const tailChars = chars.length - tailStart;
  const elided = chars.slice(headChars, tailStart);
  const wholeLines = chars[headChars - 1] === "\n" && (tailChars === 0 || chars[tailStart - 1] === "\n");
  const lines = elided.filter((char) => char === "\n").length;
  const marker = texts.render("result_cut", {
    tail: tailChars > 0 ? count(tailChars) : undefined,
    left_out: count(elided.length),
    total: count(chars.length),
    lines: wholeLines ? `${count(lines)} line${lines === 1 ? "" : "s"}` : undefined,
    head: count(headChars),
  });
  const head = chars.slice(0, headChars).join("").replace(/\n$/, "");
  const tail = chars.slice(tailStart).join("");
  const parts = [head, marker, ...(tailChars > 0 ? [tail] : [])].filter((part) => part !== undefined);

  return {
    output: parts.join("\n\n"),
    truncated: true,
    originalChars: chars.length,
    headChars,
    tailChars,
  };
}


const CANCEL_GRACE_MS = 2_000;

const STILL_RUNNING = Symbol("still running");

type Settled = { readonly ok: unknown } | { readonly err: unknown };

function settled(work: Promise<unknown>): Promise<Settled> {
  return work.then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err }),
  );
}

async function waitFor(
  work: Promise<Settled>,
  ms: number,
): Promise<Settled | typeof STILL_RUNNING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof STILL_RUNNING>((resolve) => {
    timer = setTimeout(() => resolve(STILL_RUNNING), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unwrap(outcome: Settled): unknown {
  if ("err" in outcome) throw outcome.err;
  return outcome.ok;
}

function drain(work: Promise<Settled>, name: string): void {
  void work.then((late) => {
    shoreLog.warn(
      "err" in late
        ? `Tool that outran its deadline has finally stopped: ${name}: ${String(late.err)}`
        : `Tool that outran its deadline finished after shore stopped waiting for it, ` +
          `so its work took effect: ${name}`,
    );
  });
}

export async function dispatchWithinDeadline(
  name: string,
  input: unknown,
  ctx: ToolContext,
  deadlineMs: number | undefined,
  graceMs: number = CANCEL_GRACE_MS,
): Promise<unknown> {
  if (deadlineMs === undefined) return await dispatchTool(name, input, ctx);

  const controller = new AbortController();
  const signal =
    ctx.signal === undefined
      ? controller.signal
      : AbortSignal.any([ctx.signal, controller.signal]);

  let output: ProcessStreams | undefined;
  const work = settled(dispatchTool(name, input, { ...ctx, signal, stoppedOutput: (streams) => { output = streams; } }));

  const onTime = await waitFor(work, deadlineMs);
  if (onTime !== STILL_RUNNING) return unwrap(onTime);

  shoreLog.warn(`Tool exceeded its deadline; asking it to stop: ${name}`);
  controller.abort();

  const seconds = Math.floor(deadlineMs / 1000);
  const stopping = await waitFor(work, graceMs);
  if (stopping === STILL_RUNNING) {
    shoreLog.warn(
      `Tool did not confirm it stopped within ${String(graceMs)}ms; ` +
        `reporting an unconfirmed timeout: ${name}`,
    );
    drain(work, name);
    throw new ToolTimedOut(seconds, false);
  }
  if ("ok" in stopping) {
    shoreLog.warn(`Tool finished as it was being cancelled; keeping its result: ${name}`);
    return stopping.ok;
  }
  if (stopping.err instanceof McpCancelled && !stopping.err.repeatable) {
    shoreLog.warn(
      `Tool was asked to stop but MCP cannot confirm that it did; ` +
        `reporting an unconfirmed timeout: ${name}`,
    );
    throw new ToolTimedOut(seconds, false);
  }
  throw new ToolTimedOut(seconds, true, output);
}

export { InvalidArgs, NotImplemented };
