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
import { handleReadChatLogs, handleSearchChatLogs, type ChatLogOptions } from "./history.ts";
import { handleGenerateImage, type ImageGenConfigView, type ImageGenerator } from "./images.ts";
import { handleModelHistory, type ModelHistoryQuery } from "./model_history.ts";
import { handleListThreads } from "./list_threads.ts";
import { handleListTriggers } from "./list_triggers.ts";
import { addDiaryNote } from "../autonomy/diary.ts";
import type { PushOutcome } from "../autonomy/push.ts";
import type { TriggersView } from "../autonomy/trigger_loop.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { hostZone } from "../ledger/zoned.ts";
import { handleStartSealedThread, type StartedSealedThread } from "./start_sealed_thread.ts";
import { handleStartThread, type StartThreadRequest } from "./start_thread.ts";
import { handleWakeInThread, type WakeHandOff, type WakeInThreadRequest } from "./wake_in_thread.ts";
import { handleEditThread, type EditThreadRequest } from "./edit_thread.ts";
import type { FetchLike } from "./web.ts";
import type { ToolInput } from "./workspace.ts";
import { normalizeProtectedPath, normalizePromptVisiblePath } from "./workspace_path.ts";
import { McpCancelled } from "../mcp/client.ts";
import { readWorkspacePath } from "../memory/dreaming/reads.ts";
import type { ImagesConfig, SubagentConfig, ToolsConfig } from "../config/app.ts";
import type { Message } from "../engine/types.ts";
import type { NewSealedThread } from "../engine/sealed.ts";
import type { ThreadRecord } from "../engine/threads.ts";

export interface ToolContext {
  thread?: string;
  conversation?: readonly Message[];
  dryRun?: boolean;
  maxResultChars?: number;
  maxInlineImageBytes?: number;
  images?: ImagesConfig;
  imageDir: string;
  cacheDir?: string;
  workspaceDir: string;
  workspace?: CharacterWorkspace;
  characterDataDir: string;
  conversationDir: string;
  characterName: string;
  historyDbPath: string;
  configDir: string;

  imageGenConfig?: ImageGenConfigView;
  imageGenerator?: ImageGenerator;
  modelHistoryQuery?: ModelHistoryQuery;
  activityStats?: ActivityStatsLookup;

  historyIndexPath?: string;
  userName?: string;

  deferEdit?: (path: string) => Promise<void> | void;
  stoppedOutput?: (output: ProcessStreams) => void;
  trackWorkspaceWrite?: (name: string, input: unknown, write: () => Promise<unknown>) => Promise<unknown>;
  recordRead?: (path: string) => void;
  recordWorkspaceWrite?: <T>(run: () => Promise<T>) => Promise<T>;

  runSubagent?: (
    name: string,
    query: string,
    signal?: AbortSignal,
    toolUseId?: string,
  ) => Promise<unknown>;


  toolUseId?: string;

  mcpCall?: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

  scheduleNextWake?: (hoursFromNow: number, reason: string) => number | undefined;

  triggers?: () => TriggersView;

  push?: (message: string) => Promise<PushOutcome>;

  guide?: (input: ToolInput) => string;

  wakeInThread?: (request: WakeInThreadRequest) => WakeHandOff;

  startThread?: (request: StartThreadRequest) => Promise<void>;

  sealThread?: (request: NewSealedThread) => Promise<StartedSealedThread>;

  editThread?: (request: EditThreadRequest) => Promise<ThreadRecord | undefined>;

  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  lookupImpl?: (hostname: string) => Promise<string[]>;
}

export async function annotateDeferredEdit(
  path: string,
  result: unknown,
  ctx: Pick<ToolContext, "deferEdit">,
): Promise<void> {
  const deferredPath = normalizePromptVisiblePath(path);
  if (deferredPath === undefined) return;

  await ctx.deferEdit?.(path);

  if (typeof result !== "object" || result === null || Array.isArray(result)) return;
  const obj = result as Record<string, unknown>;
  obj["prompt_visible_file"] = true;
  if (normalizeProtectedPath(path) !== undefined) {
    obj["protected_file"] = true;
  }
  obj["deferred_until_compaction"] = true;
  obj["deferred_path"] = deferredPath;
  obj["prompt_reload_required"] = true;
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
    character: ctx.characterName,
    dbPath: ctx.historyDbPath,
    dataDir: dirname(ctx.historyDbPath),
    ...(ctx.thread === undefined ? {} : { thread: ctx.thread }),
    ...(ctx.historyIndexPath === undefined ? {} : { indexPath: ctx.historyIndexPath }),
    ...(ctx.userName === undefined ? {} : { userName: ctx.userName }),
  };
}

function hoursPhrase(hours: number): string {
  const shown = Number(hours.toFixed(2));
  return `${String(shown)} ${shown === 1 ? "hour" : "hours"}`;
}

export function nextWakeAnswer(asked: number, scheduled: number, userName: string): string {
  const wanted = hoursPhrase(asked);
  const set = hoursPhrase(scheduled);
  if (wanted === set) return `The heartbeat you asked for is in ${set}.`;
  const held = Math.max(asked, scheduled) === scheduled ? "soonest" : "furthest ahead";
  return `You asked for ${wanted}, and the heartbeat is in ${set}: that is the ${held} ${userName} lets you ask for one.`;
}

export function writesWorkspace(name: string): boolean {
  return ["bash", "edit", "apply_patch"].includes(name) || name.startsWith("mcp__");
}

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  if (ctx.dryRun && (["bash", "edit", "apply_patch", "generate_image", "set_next_wake", "wake_in_thread", "start_thread", "start_sealed_thread", "edit_thread"].includes(name) || name.startsWith("mcp__"))) {
    throw new ToolIoError(`${name} blocked: dry-run tools cannot change files or external state`);
  }
  const args = (input ?? {}) as ToolInput;
  const workspace = ctx.workspace ?? new CharacterWorkspace(ctx.workspaceDir);

  switch (name) {
    case "read": {
      const value = decodeToolValue(await workspace.call("read", {
        input: args,
        workspaceDir: ctx.workspaceDir,
        ...(ctx.maxResultChars === undefined ? {} : { maxChars: ctx.maxResultChars }),
        ...(ctx.maxInlineImageBytes === undefined ? {} : { maxImageBytes: ctx.maxInlineImageBytes }),
        ...(ctx.images === undefined ? {} : { images: ctx.images }),
      }, ctx.signal));
      const read = ctx.recordRead === undefined ? undefined : readWorkspacePath(value, ctx.workspaceDir);
      if (read !== undefined) ctx.recordRead?.(read);
      return value;
    }
    case "edit":
    case "apply_patch": {
      const write = () => withPromptChanges(workspace,
        () => name === "edit" ? workspace.call("edit", { input: args, workspaceDir: ctx.workspaceDir }, ctx.signal) : handleApplyPatch(args, workspace, ctx.signal), ctx.deferEdit);
      return await (ctx.trackWorkspaceWrite?.(name, input, write) ?? write());
    }
    case "search_chat_logs":
      return await handleSearchChatLogs(args, ctx.conversationDir, chatLogOptions(ctx));

    case "read_chat_logs":
      return await handleReadChatLogs(args, ctx.conversationDir, chatLogOptions(ctx));

    case "model_history":
      return await handleModelHistory(args, ctx.characterName, ctx.modelHistoryQuery);

    case "generate_image":
      return await handleGenerateImage(
        args,
        ctx.imageDir,
        ctx.imageGenConfig,
        ctx.imageGenerator,
        new Date(),
        ctx.fetchImpl ?? fetch,
      );

    case "activity_heatmap":
      if (ctx.activityStats === undefined) {
        throw new ToolIoError("activity history is not available in this context");
      }
      return handleActivityHeatmap(args, ctx.activityStats);

    case "bash": {
      const write = () => handleBash(args, workspace, ctx.characterName, ctx.signal, ctx.deferEdit, ctx.stoppedOutput);
      return ctx.trackWorkspaceWrite === undefined ? await write()
        : await ctx.trackWorkspaceWrite(name, input, write);
    }

    case "list_threads":
      return await handleListThreads({
        dataDir: dirname(ctx.historyDbPath),
        character: ctx.characterName,
        userName: ctx.userName ?? "the user",
        ...(ctx.thread === undefined ? {} : { thread: ctx.thread }),
      });

    case "start_thread":
      return await handleStartThread(args, ctx.startThread, ctx.userName ?? "the user");

    case "start_sealed_thread":
      return await handleStartSealedThread(args, ctx.sealThread, ctx.userName ?? "the user", hostZone());

    case "edit_thread":
      return await handleEditThread(args, ctx.editThread, ctx.userName ?? "the user");

    case "set_next_wake": {
      if (ctx.scheduleNextWake === undefined) {
        throw new ToolIoError("the heartbeat schedule is not available in this context");
      }
      const hours = typeof args["hours_from_now"] === "number" ? args["hours_from_now"] : 1;
      const reason = typeof args["reason"] === "string" ? args["reason"] : "";
      const used = ctx.scheduleNextWake(hours, reason);
      if (used === undefined) throw new ToolIoError("heartbeats are not running for this character");
      return nextWakeAnswer(hours, used, ctx.userName ?? "the user");
    }

    case "list_triggers":
      return handleListTriggers(ctx.triggers?.(), ctx.userName ?? "the user");

    case "write_diary": {
      const text = typeof args["text"] === "string" ? args["text"].trim() : "";
      if (text === "") throw new InvalidArgs("text must be a non-empty string");
      addDiaryNote(ctx.characterDataDir, { at: Date.now(), thread: ctx.thread ?? "", source: "note", text });
      return "Noted in your diary. Your other turns will see it for the next day.";
    }

    case "wake_in_thread":
      return handleWakeInThread(args, ctx.thread, ctx.wakeInThread, ctx.userName ?? "the user");

    case "send_push": {
      const message = typeof args["message"] === "string" ? args["message"].trim() : "";
      if (message === "") throw new InvalidArgs("message must be a non-empty string");
      const user = ctx.userName ?? "the user";
      const outcome = await ctx.push?.(message);
      if (outcome === undefined || outcome.kind === "not_set_up") throw new ToolIoError(`push notifications aren't set up: ${user} hasn't given Shore a topic to send them to`);
      const next = formatWallClock(outcome.nextAt, hostZone());
      if (outcome.kind === "too_soon") {
        throw new ToolIoError(`not sent: your last push was ${formatWallClock(outcome.lastAt, hostZone())}, and the next one is allowed from ${next}`);
      }
      return `Sent to ${user}'s phone. The next push is allowed from ${next}.`;
    }

    case "guide":
      if (ctx.guide === undefined) throw new ToolIoError("the guide is not available in this context");
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
  for (const [name, override] of cfg.config) {
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

export function windowToolResult(output: string, maxChars: number): ToolResultWindow {
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
  const missing = `${count(elided.length)} of its ${count(chars.length)} characters`;
  const size = wholeLines ? `${missing}, ${count(lines)} line${lines === 1 ? "" : "s"}` : `${missing}; the cut falls inside a line`;
  const shown = tailChars > 0
    ? `the first ${count(headChars)} characters are above this note and the last ${count(tailChars)} are below it`
    : `only the first ${count(headChars)} characters are shown`;
  const marker =
    `[tool_result truncated: this result was too long, so ${tailChars > 0 ? "its middle" : "its end"} is left out here: ` +
    `${size}. Nothing else is missing: ${shown}. To see the rest, narrow the call to a more specific ` +
    `path, pattern or range, or write the output to a file and read it in parts.]`;
  const head = chars.slice(0, headChars).join("").replace(/\n$/, "");
  const tail = chars.slice(tailStart).join("");

  return {
    output: tailChars > 0 ? `${head}\n\n${marker}\n\n${tail}` : `${head}\n\n${marker}`,
    truncated: true,
    originalChars: chars.length,
    headChars,
    tailChars,
  };
}

export function truncateToolResult(output: string, maxChars: number): string {
  return windowToolResult(output, maxChars).output;
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
