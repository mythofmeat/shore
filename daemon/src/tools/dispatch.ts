import { handleActivityHeatmap, type ActivityStatsLookup } from "./activity.ts";
import { handleRollDice } from "./basic.ts";
import { InvalidArgs, NotImplemented, ToolIoError, ToolTimedOut } from "./errors.ts";
import { handleSearchHistory } from "./history.ts";
import { handleGenerateImage, type ImageGenConfigView, type ImageGenerator } from "./images.ts";
import { handleModelHistory, type ModelHistoryQuery } from "./model_history.ts";
import { handleFetchUrl, handleWebSearch, type FetchLike, type SearchConfigView } from "./web.ts";
import {
  handleDelete,
  handleEdit,
  handleGit,
  handleRead,
  handleSearch,
  type ToolInput,
} from "./workspace.ts";
import { normalizeProtectedPath, normalizePromptVisiblePath } from "./workspace_path.ts";
import type { Embedder } from "../llm/embed.ts";
import type { RetrievalConfig } from "../memory/workspace_index.ts";

export type RetrievalMode = "auto" | "lexical" | "hybrid";

export interface ToolContext {
  imageDir: string;
  workspaceDir: string;
  characterDataDir: string;
  characterName: string;
  configDir: string;
  searchConfig: SearchConfigView;
  retrievalConfig: RetrievalConfig;
  retrievalMode: RetrievalMode;

  imageGenConfig?: ImageGenConfigView;
  imageGenerator?: ImageGenerator;
  modelHistoryQuery?: ModelHistoryQuery;
  activityStats?: ActivityStatsLookup;

  embedder?: Embedder;
  memoryIndexPath?: string;

  deferEdit?: (path: string) => Promise<void> | void;

  runSubagent?: (
    name: string,
    query: string,
    signal?: AbortSignal,
    toolUseId?: string,
  ) => Promise<unknown>;

  toolUseId?: string;

  mcpCall?: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

  scheduleNextWake?: (input: unknown) => Promise<unknown>;

  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

function defaultSearchMode(
  mode: RetrievalMode,
  embedderAvailable: boolean,
  indexPathAvailable: boolean,
): "lexical" | "hybrid" {
  switch (mode) {
    case "lexical":
      return "lexical";
    case "hybrid":
      return "hybrid";
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
      console.warn(`Failed to queue deferred edit: ${path}: ${String(e)}`);
    }
  };
}

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const args = (input ?? {}) as ToolInput;

  switch (name) {
    case "search_chat_logs":
      return await handleSearchHistory(args, ctx.characterDataDir);

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
      return await handleWebSearch(args, ctx.searchConfig, process.env, ctx.fetchImpl ?? fetch, ctx.signal);

    case "fetch_url":
      return await handleFetchUrl(args, ctx.fetchImpl ?? fetch, ctx.signal);

    case "roll_dice":
      return handleRollDice(args);

    case "activity_heatmap":
      return handleActivityHeatmap(args, ctx.activityStats ?? (() => undefined));

    case "read":
      return await handleRead(args, ctx.workspaceDir);

    case "edit": {
      const path = typeof args["path"] === "string" ? args["path"] : "";
      const result = await handleEdit(args, ctx.workspaceDir);
      await annotateDeferredEdit(path, result, ctx);
      return result;
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
          ? { embedder: ctx.embedder, indexPath: ctx.memoryIndexPath }
          : undefined;
      return await handleSearch(args, ctx.workspaceDir, ctx.retrievalConfig, semantics);
    }

    case "delete":
      return await handleDelete(args, ctx.workspaceDir, ctx.characterDataDir);

    case "git":
      return await handleGit(args, ctx.workspaceDir, ctx.characterName);

    case "set_next_wake": {
      if (ctx.scheduleNextWake === undefined) {
        throw new InvalidArgs("set_next_wake is only available during heartbeat ticks");
      }
      return await ctx.scheduleNextWake(args);
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
  timeout_ms: number;
  config?: Record<string, { max_result_chars?: number; timeout_ms?: number }>;
}

export function resultCharsFor(cfg: ToolLimitsView, name: string): number {
  return cfg.config?.[name]?.max_result_chars ?? cfg.max_result_chars;
}

export function timeoutFor(cfg: ToolLimitsView, name: string): number | undefined {
  const resolved = cfg.config?.[name]?.timeout_ms ?? cfg.timeout_ms;
  return resolved > 0 ? resolved : undefined;
}

export function truncateToolResult(output: string, maxChars: number): string {
  if (maxChars === 0) return output;
  const chars = [...output];
  if (chars.length <= maxChars) return output;
  const kept = chars.slice(0, maxChars).join("");
  return `${kept}\n\n[tool_result truncated: showing first ${maxChars} of ${chars.length} characters]`;
}

export async function dispatchWithinDeadline(
  name: string,
  input: unknown,
  ctx: ToolContext,
  deadlineMs: number | undefined,
): Promise<unknown> {
  if (deadlineMs === undefined) return await dispatchTool(name, input, ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const signal =
    ctx.signal === undefined
      ? controller.signal
      : AbortSignal.any([ctx.signal, controller.signal]);

  try {
    return await Promise.race([
      dispatchTool(name, input, { ...ctx, signal }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          console.warn(`Tool exceeded its deadline and was cancelled: ${name}`);
          reject(new ToolTimedOut(Math.floor(deadlineMs / 1000)));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { InvalidArgs, NotImplemented, ToolIoError, ToolTimedOut };
