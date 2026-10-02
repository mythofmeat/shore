import { shoreLog } from "../log.ts";

import { handleActivityHeatmap, type ActivityStatsLookup } from "./activity.ts";
import { handleEdit } from "./edit.ts";
import { handleApplyPatch } from "./apply_patch.ts";
import { handleBash, withPromptChanges } from "./bash.ts";
import { handleRead } from "./read.ts";
import { DEFAULT_MAX_INLINE_IMAGE_BYTES } from "./media.ts";
import { InvalidArgs, NotImplemented, ToolIoError, ToolTimedOut } from "./errors.ts";
import { handleSearchHistory } from "./history.ts";
import { handleGenerateImage, type ImageGenConfigView, type ImageGenerator } from "./images.ts";
import { handleModelHistory, type ModelHistoryQuery } from "./model_history.ts";
import type { FetchLike } from "./web.ts";
import {
  handleSearch,
  type ToolInput,
} from "./workspace.ts";
import { normalizeProtectedPath, normalizePromptVisiblePath } from "./workspace_path.ts";
import { McpCancelled } from "../mcp/client.ts";
import type { ImagesConfig, SubagentConfig, ToolsConfig } from "../config/app.ts";
import type { Message } from "../engine/types.ts";
import type { Embedder } from "../llm/embed.ts";
import type { RetrievalConfig } from "../memory/workspace_index.ts";

export type RetrievalMode = "auto" | "lexical" | "hybrid" | "vector";

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
  characterDataDir: string;
  conversationDir: string;
  characterName: string;
  historyDbPath: string;
  configDir: string;
  retrievalConfig: RetrievalConfig;
  retrievalMode: RetrievalMode;

  imageGenConfig?: ImageGenConfigView;
  imageGenerator?: ImageGenerator;
  modelHistoryQuery?: ModelHistoryQuery;
  activityStats?: ActivityStatsLookup;

  embedder?: Embedder;
  minSimilarity?: number;
  memoryIndexPath?: string;
  historyIndexPath?: string;

  deferEdit?: (path: string) => Promise<void> | void;
  trackWorkspaceWrite?: (name: string, input: unknown, write: () => Promise<unknown>) => Promise<unknown>;

  runSubagent?: (
    name: string,
    query: string,
    signal?: AbortSignal,
    toolUseId?: string,
  ) => Promise<unknown>;


  toolUseId?: string;

  mcpCall?: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

  scheduleNextWake?: (hoursFromNow: number, reason: string) => number | undefined;

  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  lookupImpl?: (hostname: string) => Promise<string[]>;
}

function defaultSearchMode(
  mode: RetrievalMode,
  embedderAvailable: boolean,
  indexPathAvailable: boolean,
): "lexical" | "hybrid" | "vector" {
  switch (mode) {
    case "lexical":
      return "lexical";
    case "hybrid":
      return "hybrid";
    case "vector":
      return "vector";
    case "auto":
      return embedderAvailable && indexPathAvailable ? "hybrid" : "lexical";
  }
}

export function applyDefaultSearchMode(
  input: unknown,
  mode: RetrievalMode,
  embedderAvailable: boolean,
  indexPathAvailable: boolean,
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  if ("mode" in input) return;
  (input as Record<string, unknown>)["mode"] = defaultSearchMode(
    mode,
    embedderAvailable,
    indexPathAvailable,
  );
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

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  if (ctx.dryRun && (["bash", "edit", "apply_patch", "generate_image", "set_next_wake"].includes(name) || name.startsWith("mcp__"))) {
    throw new ToolIoError(`${name} blocked: dry-run tools cannot change files or external state`);
  }
  const args = (input ?? {}) as ToolInput;

  switch (name) {
    case "read":
      return await handleRead(args, ctx.workspaceDir, ctx.signal, ctx.maxResultChars, ctx.maxInlineImageBytes, ctx.images);
    case "edit":
    case "apply_patch": {
      const write = () => withPromptChanges(ctx.workspaceDir,
        () => name === "edit" ? handleEdit(args, ctx.workspaceDir, ctx.signal) : handleApplyPatch(args, ctx.workspaceDir, ctx.signal), ctx.deferEdit);
      return await (ctx.trackWorkspaceWrite?.(name, input, write) ?? write());
    }
    case "delete":
    case "git":
    case "fetch_url":
    case "roll_dice":
      throw new InvalidArgs(`${name} has been replaced by bash; use a Bash command instead`);

    case "search_chat_logs":
      return await handleSearchHistory(args, ctx.conversationDir, {
        character: ctx.characterName,
        dbPath: ctx.historyDbPath,
        ...(ctx.historyIndexPath === undefined ? {} : { indexPath: ctx.historyIndexPath }),
        ...(ctx.embedder === undefined ? {} : { embedder: ctx.embedder }),
        ...(ctx.minSimilarity === undefined ? {} : { minSimilarity: ctx.minSimilarity }),
        defaultMode: ctx.retrievalMode,
      });

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

    case "web_search":
      throw new InvalidArgs("web_search has been removed; use a search tool from a configured MCP server instead");

    case "activity_heatmap":
      if (ctx.activityStats === undefined) {
        throw new ToolIoError("activity history is not available in this context");
      }
      return handleActivityHeatmap(args, ctx.activityStats);

    case "bash": {
      const write = () => handleBash(args, ctx.workspaceDir, ctx.characterName, ctx.signal, ctx.deferEdit);
      return ctx.trackWorkspaceWrite === undefined ? await write()
        : await ctx.trackWorkspaceWrite(name, input, write);
    }

    case "search": {
      applyDefaultSearchMode(
        args,
        ctx.retrievalMode,
        ctx.embedder !== undefined,
        ctx.memoryIndexPath !== undefined,
      );
      const semantics =
        ctx.embedder !== undefined && ctx.memoryIndexPath !== undefined
          ? {
              embedder: ctx.embedder,
              indexPath: ctx.memoryIndexPath,
              ...(ctx.minSimilarity === undefined ? {} : { minSimilarity: ctx.minSimilarity }),
            }
          : undefined;
      return await handleSearch(args, ctx.workspaceDir, ctx.retrievalConfig, semantics);
    }

    case "set_next_wake": {
      if (ctx.scheduleNextWake === undefined) {
        throw new ToolIoError("the heartbeat schedule is not available in this context");
      }
      const hours = typeof args["hours_from_now"] === "number" ? args["hours_from_now"] : 1;
      const reason = typeof args["reason"] === "string" ? args["reason"] : "";
      const used = ctx.scheduleNextWake(hours, reason);
      if (used === undefined) throw new ToolIoError("heartbeats are not running for this character");
      return `Scheduled next moment in ${used.toFixed(1)} hours.`;
    }

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

export function resultCharsFor(cfg: ToolLimitsView, name: string): number {
  return cfg.config?.[name]?.max_result_chars ?? cfg.max_result_chars;
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

  const headChars = Math.max(1, Math.ceil(maxChars * HEAD_SHARE));
  const tailChars = maxChars - headChars;
  const head = chars.slice(0, headChars).join("");
  const tail = tailChars > 0 ? chars.slice(chars.length - tailChars).join("") : "";
  const elided = chars.length - headChars - tailChars;

  const marker =
    `[tool_result truncated: ${String(chars.length)} characters, showing the first ` +
    `${String(headChars)}${tailChars > 0 ? ` and the last ${String(tailChars)}` : ""}; ` +
    `${String(elided)} elided. Narrow the call — a more specific path, pattern, or range — ` +
    `to see the rest.]`;

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

export const CANCEL_GRACE_MS = 2_000;

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

  const work = settled(dispatchTool(name, input, { ...ctx, signal }));

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
  throw new ToolTimedOut(seconds, true);
}

export { InvalidArgs, NotImplemented };
