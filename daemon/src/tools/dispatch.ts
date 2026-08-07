/**
 * Tool dispatch — the name-to-handler routing table, and the deadline and
 * truncation that bound every result.
 *
 * Ported from `dispatch_tool` in `crates/daemon/src/tools/mod.rs`, the
 * `SharedToolContext` wiring in `tools/context.rs`, and the two pieces of
 * `engine/tools.rs` that are real behaviour rather than seam
 * (`dispatch_within_deadline`) — plus `truncate_tool_result` from
 * `content_util.rs`. Pinned by `tests/tools_fixtures/dispatch_parity.json`.
 *
 * This is the file the rest of the daemon hangs off. Every handler in this
 * directory is reachable only through {@link dispatchTool}, and the order and
 * spelling of what it returns is what the model reads.
 */

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

// ── Retrieval mode ──────────────────────────────────────────────────────

/**
 * `[retrieval] mode`, which decides what a `search` call with no explicit
 * `mode` gets.
 *
 * Lives here rather than on {@link RetrievalConfig} because it is the only
 * field of `[retrieval]` that no search code reads — it is consumed entirely
 * by {@link applyDefaultSearchMode}, before the handler is called.
 */
export type RetrievalMode = "auto" | "lexical" | "hybrid";

// ── Tool context ────────────────────────────────────────────────────────

/**
 * The wiring a tool handler may need.
 *
 * The Rust was an 18-method trait with a default body per method, because a
 * trait is how you spell "some implementations supply this and others do not"
 * in a language with no structural optionality. Here that is just an optional
 * property, and the trait's defaults collapse into it: **an absent field means
 * the same thing the `None`-returning default meant** — this path is not wired
 * for that capability, and the tool depending on it reports itself
 * unavailable.
 *
 * The one thing that does *not* collapse is which error it reports.
 * `runSubagent`, `mcpCall` and `scheduleNextWake` being absent is
 * `NotImplemented`, because the name is not callable here at all;
 * `modelHistoryQuery` and `imageGenerator` being absent is `io:`, because the
 * tool is registered and routed and merely has nothing behind it. The Rust
 * drew that line and it is worth keeping — see the note on
 * {@link NotImplemented}.
 */
export interface ToolContext {
  /** Where `generate_image` writes. */
  imageDir: string;
  /** Root for the workspace filesystem tools. Empty means unconfigured. */
  workspaceDir: string;
  /** Where the transcript and deferred-edit queue live. Empty means none. */
  characterDataDir: string;
  /** Used for `git` commit identity and `model_history` scoping. */
  characterName: string;
  /** Root the memory index is resolved under. */
  configDir: string;
  searchConfig: SearchConfigView;
  retrievalConfig: RetrievalConfig;
  retrievalMode: RetrievalMode;

  imageGenConfig?: ImageGenConfigView;
  imageGenerator?: ImageGenerator;
  modelHistoryQuery?: ModelHistoryQuery;
  activityStats?: ActivityStatsLookup;

  /**
   * Kept separate rather than bundled into the one `SearchSemantics` argument
   * `handleSearch` takes, because {@link defaultSearchMode} asks about them
   * individually: an embedder with no index and an index with no embedder are
   * distinct wirings that happen to produce the same answer.
   */
  embedder?: Embedder;
  memoryIndexPath?: string;

  /**
   * Record that a prompt-visible file changed. Absent is a no-op, matching the
   * Rust's empty default body — a context with nowhere to queue to.
   */
  deferEdit?: (path: string) => Promise<void> | void;

  /**
   * Run a configured sub-agent. Absent is also the recursion cap: a sub-agent's
   * own loop runs against a context that leaves this out, so it cannot delegate
   * further.
   *
   * Takes the deadline's `signal` because these are the two tool families that
   * legitimately run long — `[tools.config]`'s own documentation names them —
   * and therefore the two most likely to hit their deadline. A closure that
   * ignores the signal is merely abandoned; one that honours it is stopped.
   */
  runSubagent?: (name: string, query: string, signal?: AbortSignal) => Promise<unknown>;

  /** Invoke an MCP tool. Absent leaves every `mcp__*` name uncallable. */
  mcpCall?: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

  /**
   * `set_next_wake`, which exists only inside a heartbeat tick.
   *
   * The Rust returned `Option<Result<…>>` and the outer `Option` meant exactly
   * "is this a heartbeat context" — so an optional method says it instead, and
   * the nesting goes away. The clamp is deliberately not applied on this side:
   * a character asking for a moment in a year is told the hour it will actually
   * get, and computing that here too would put the bound in two places to
   * drift apart.
   */
  scheduleNextWake?: (input: unknown) => Promise<unknown>;

  /** Aborts when the tool's deadline expires. See {@link dispatchWithinDeadline}. */
  signal?: AbortSignal;
  /** Injectable for tests; the handlers default to global `fetch`. */
  fetchImpl?: FetchLike;
}

// ── Search-mode defaulting ──────────────────────────────────────────────

/**
 * The `mode` a `search` call gets when it names none.
 *
 * Only `auto` consults the wiring, and it demands *both* an embedder and an
 * index path — either alone falls back to lexical, because a semantic search
 * needs something to embed with and something to search.
 */
export function defaultSearchMode(
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

/**
 * Fill in `input.mode` when the caller left it out.
 *
 * `"mode" in input` rather than a value check, because the Rust asked
 * `input.get("mode").is_some()` — which is true for an explicit `null`. A
 * `search` called with `{"mode": null}` keeps its null and fails downstream
 * rather than silently becoming a hybrid search. A non-object input has
 * nowhere to insert and is left exactly as it came.
 */
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

// ── Deferred-edit annotation ────────────────────────────────────────────

/**
 * Flag a workspace write whose target is prompt-visible.
 *
 * A write to `MEMORY.md` or `SOUL.md` lands on disk immediately but does not
 * reach the system prompt until the next compaction boundary, and without
 * saying so the model reads its own edit back from the stale snapshot and
 * concludes the write failed. The five keys are what tell it otherwise.
 *
 * Insertion order is preserved because it is observable: the result is
 * serialized to JSON and handed to the model as text.
 */
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

/**
 * The `deferEdit` a context with a character directory should carry.
 *
 * The Rust guarded this with `is_prompt_visible_path` before queueing;
 * `queueDeferredEdit` already makes that check itself, so the guard is dropped
 * rather than duplicated. A queue failure is logged and swallowed — the write
 * it describes already succeeded, and failing the tool over the bookkeeping
 * would tell the model the opposite of what happened.
 */
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

// ── Dispatch ────────────────────────────────────────────────────────────

/**
 * Route a tool call to its handler.
 *
 * Three families, in the order the `match` tried them: the named arms, then
 * `ask_*`, then `mcp__*`, then nothing. The prefix tests are exact and
 * case-sensitive — `Ask_researcher` and `mcp_hue__x` are unknown names, not
 * near-misses to be forgiven — and they test the *start* of the name, so
 * `x_ask_researcher` is unknown too.
 *
 * Throws rather than returning a result union: every caller was going to
 * convert `Err` into a failed tool result anyway, and a thrown
 * {@link InvalidArgs} carries the same `Display` string the Rust produced.
 */
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
      // Read `path` before the handler runs: the Rust took `input` by value
      // here, and reading it back off a handler that may have consumed or
      // rewritten it would be reading a different thing.
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

    // Undeclared and heartbeat-only: the heartbeat loop intercepts this name
    // before dispatch. Reaching here means some other context dispatched it.
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
        return await ctx.runSubagent(agent, query, ctx.signal);
      }
      if (name.startsWith("mcp__")) {
        if (ctx.mcpCall === undefined) throw new NotImplemented(name);
        return await ctx.mcpCall(name, input, ctx.signal);
      }
      throw new NotImplemented(name);
    }
  }
}

// ── Per-tool limits ─────────────────────────────────────────────────────

/** The `[tools]` fields the execution path reads. */
export interface ToolLimitsView {
  max_result_chars: number;
  /** Global deadline in milliseconds. Zero means no deadline. */
  timeout_ms: number;
  /** `[tools.config.<name>]` overrides. */
  config?: Record<string, { max_result_chars?: number; timeout_ms?: number }>;
}

/** The tool's `max_result_chars` override, else the global. Zero means no cap. */
export function resultCharsFor(cfg: ToolLimitsView, name: string): number {
  return cfg.config?.[name]?.max_result_chars ?? cfg.max_result_chars;
}

/**
 * The tool's effective deadline in milliseconds, or `undefined` for none.
 *
 * A resolved value of zero disables the deadline, which is how a single tool
 * opts out of a global timeout — and how a global zero opts everything out
 * except the tools that name their own.
 */
export function timeoutFor(cfg: ToolLimitsView, name: string): number | undefined {
  const resolved = cfg.config?.[name]?.timeout_ms ?? cfg.timeout_ms;
  return resolved > 0 ? resolved : undefined;
}

/**
 * Cap a single tool result's contribution to the conversation.
 *
 * `[...output]` iterates **code points**, because the Rust counted
 * `chars()`. `output.length` would count UTF-16 units and cut four emoji at
 * two, reporting a character count the model can see is wrong. A limit of zero
 * leaves the output untouched.
 *
 * The cut is by code point, not grapheme, so a combining sequence can split
 * between its base and its mark. That is what the Rust did and it is left
 * alone: the alternative is a segmenter in the hot path of every tool result,
 * to move a boundary the model never sees.
 */
export function truncateToolResult(output: string, maxChars: number): string {
  if (maxChars === 0) return output;
  const chars = [...output];
  if (chars.length <= maxChars) return output;
  const kept = chars.slice(0, maxChars).join("");
  return `${kept}\n\n[tool_result truncated: showing first ${maxChars} of ${chars.length} characters]`;
}

/**
 * Run one tool, failing it if it outlives its deadline.
 *
 * **This abandons rather than cancels, and the difference is real.** Dropping
 * a Rust future stops the work; a JavaScript promise has no such handle, so a
 * timed-out handler keeps running to completion with nobody waiting. The
 * mitigation is the `AbortSignal` threaded onto the context: the handlers that
 * can actually be interrupted — the two that wait on the network — abort with
 * it, which covers the case the deadline exists for. A filesystem or CPU-bound
 * handler still runs on, and there is no way to make it not.
 *
 * The timeout becomes a failed tool result rather than a transport error, so
 * the model is told and the loop continues.
 */
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
          // Rust reported whole seconds because its deadline was a `Duration`
          // built from a `ConfigDuration`; the millisecond value is carried
          // here and floored at the message boundary to say the same thing.
          reject(new ToolTimedOut(Math.floor(deadlineMs / 1000)));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { InvalidArgs, NotImplemented, ToolIoError, ToolTimedOut };
