/**
 * A compaction pass: split the conversation, let the model write memory, and
 * archive only if it did.
 *
 * Ported from `crates/daemon/src/memory/compaction/mod.rs`, the densest file in
 * the daemon, pinned by `tests/memory_fixtures/compaction_parity.json`.
 *
 * # The rule the whole file exists for
 *
 * A pass archives the active conversation **only when at least one allowed
 * memory write actually landed**. Zero writes returns `no_memory_writes` and
 * leaves `active.jsonl` untouched. Before the tool-loop redesign the parser
 * path fell through to archive when the model emitted tool calls instead of the
 * XML payload it expected, which silently cleared the transcript without
 * updating a single memory file. Every guard here is downstream of not letting
 * that happen again: the path filter, the rollback list, and the split between
 * "the model called tools" and "the model wrote memory".
 *
 * # What did not come across
 *
 * Four things in the Rust had no caller left at the commit this was ported
 * from, verified by grep across `crates/` rather than assumed:
 *
 *   - **`IdleTimer`, `notify_activity`, `idle_timer()`** — a `tokio::select!`
 *     between a sleep and a notification, deciding when a conversation had gone
 *     quiet enough to compact. The autonomy tick answers that now, from stored
 *     timestamps rather than a live timer, and it is already ported:
 *     `autonomy/tick.ts`'s `compactionReason` is the idle trigger. A second,
 *     unreachable copy of the same decision is exactly the drift that made the
 *     tick worth having.
 *   - **`should_force_compact` / `has_enough_turns`** — likewise superseded, by
 *     `CharacterAutonomy.shouldCompactNow` in `autonomy/runner.ts`. That one is
 *     load-bearing where these were not: saying yes there takes the latch.
 *   - **`build_prompt`** — `#[cfg(test)]`, a flattened-prompt helper for tests
 *     of a prompt shape that is no longer built.
 *   - The XML response parser — see `prompts.ts`.
 *
 * With the timer and the trigger predicates gone, the manager reads exactly one
 * field of `CompactionConfig`, which is why it takes {@link CompactionSettings}
 * rather than the whole struct. The rest of that struct is read by the autonomy
 * layer, which models its own slice of it.
 */

import { dirname, join } from "node:path";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";

import { pushAssistantTurn } from "../../llm/request";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";
import { runToolLoop, type ToolLoopDriver, type ToolUseEvent } from "../../engine/tool_loop";
import type { ContentBlock } from "../../engine/types";
import type { MarkdownMemoryStore } from "../markdown_store";
import { MEMORY_INDEX_FILE, noteMemoryIndexDeferred } from "../deferred_edits";
import { rustTrim } from "../lines";
import {
  normalizePromptVisiblePath,
  pathComponents,
  PathError,
  resolvePath,
} from "../../tools/workspace_path";
import {
  CompactionError,
  type AppliedCompactionWrite,
  type CompactionLlm,
  type CompactionOutcome,
  type CompactionTools,
  type ConversationManager,
  type ConversationMessage,
  type MemoryFileOp,
} from "./types";

// ── Single-flight guard ─────────────────────────────────────────────────

/**
 * Character data roots with a compaction pass in flight.
 *
 * Manual and idle-triggered compaction both mutate the same active transcript,
 * segment manifest, markdown files and prompt-refresh queue, so a slow provider
 * response must not overlap with another pass against the same pre-compaction
 * window. Keyed by data root rather than character name because tests host
 * separate daemon instances for one character in a single process.
 *
 * The Rust held a `tokio::Mutex` per key and returned an RAII guard; here the
 * key is simply present or absent and the guard has a {@link CompactionRunGuard.release}
 * to call, since JavaScript has no drop. It is also a `Symbol.dispose`, so
 * `using guard = tryBeginCompaction(...)` releases on scope exit.
 */
const inFlight = new Set<string>();

export interface CompactionRunGuard {
  release(): void;
  [Symbol.dispose](): void;
}

/** `<data_dir>/<character>` — `shore_common::config::character_data_dir`. */
export function characterDataDir(dataDir: string, character: string): string {
  return join(dataDir, character);
}

/**
 * Claim the compaction slot for a character, or return undefined if a pass is
 * already running against the same data root.
 */
export function tryBeginCompaction(
  dataDir: string,
  character: string,
): CompactionRunGuard | undefined {
  const key = characterDataDir(dataDir, character);
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlight.delete(key);
  };
  return { release, [Symbol.dispose]: release };
}

// ── Prompt rendering ────────────────────────────────────────────────────

/** Render a template's `{{char}}` / `{{user}}` placeholders. */
export function buildSystem(template: string, charName: string, userName: string): string {
  return template.replaceAll("{{char}}", charName).replaceAll("{{user}}", userName);
}

const IF_RECAP = "{{#if recap}}";
const END_IF = "{{/if}}";

/**
 * Render the final compaction user message.
 *
 * Beyond `{{char}}`/`{{user}}` this strips the legacy `{{#if recap}}...{{/if}}`
 * blocks and the `{{recap}}` placeholder, because recaps are no longer
 * generated. Existing memory is not inlined: the model already has the
 * `MEMORY.md` index in its system prompt and reaches whole files through its
 * own `read`/`search` tools.
 *
 * **Divergence, deliberate.** The Rust searched for `{{/if}}` from the start of
 * the string on every iteration, not from the `{{#if recap}}` it had just
 * found. A template whose first `{{/if}}` came *before* its first
 * `{{#if recap}}` therefore spliced a growing copy of its own middle back in
 * and never terminated — an operator with a hand-edited `compact.md` could hang
 * the pass. Here the closer is looked for after the opener, so a malformed
 * template strips what it can and stops. For any template where the two are in
 * the order the syntax implies, the two agree exactly, which is every template
 * shipped and every one pinned.
 */
export function buildFinalMessage(
  template: string,
  charName: string,
  userName: string,
): string {
  let out = template.replaceAll("{{char}}", charName).replaceAll("{{user}}", userName);
  for (;;) {
    const ifStart = out.indexOf(IF_RECAP);
    if (ifStart < 0) break;
    const endIf = out.indexOf(END_IF, ifStart);
    if (endIf < 0) break;
    out = out.slice(0, ifStart) + out.slice(endIf + END_IF.length);
  }
  return out.replaceAll("{{recap}}", "");
}

// ── Conversation splitting ──────────────────────────────────────────────

/**
 * A user turn that is a turn, rather than a tool-loop intermediate.
 *
 * The Rust asked this in two pieces: `is_tool_loop_message`, which answered for
 * all three roles, and a `role == "user" && !is_tool_loop_message(msg)` at each
 * of its two call sites. The other two arms were unreachable — every caller had
 * already established the role is `user` — so an assistant message's
 * `content.is_empty()` test and the `_ => false` fallthrough decided nothing.
 * Mutation testing finds all three of those arms unkillable, which is what
 * unreachable code looks like from the outside. Collapsed to the one arm that
 * runs.
 */
const isRealUserTurn = (msg: ConversationMessage): boolean =>
  msg.role === "user" && !msg.isToolResultOnly;

/**
 * The index of the first retained message, keeping `keepTurns` complete user
 * turns at the tail.
 *
 * Zero means there is not enough to compact. `keepTurns === 0` returns the
 * message count, so the caller retains nothing and compacts everything.
 */
export function findTurnSplit(messages: ConversationMessage[], keepTurns: number): number {
  if (keepTurns === 0) return messages.length;
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isRealUserTurn(messages[i]!)) {
      turnsSeen += 1;
      if (turnsSeen >= keepTurns) return i;
    }
  }
  return 0;
}

export function countTurns(messages: ConversationMessage[]): number {
  return messages.filter(isRealUserTurn).length;
}

/**
 * The trailing run of autonomous assistant messages — heartbeat
 * `<sendMessage>` output the user has not answered yet, since any user message
 * after it would end the run. Deep-idle archiving keeps this tail in the active
 * conversation so the user still sees it when they come back.
 */
export function trailingAutonomousLen(messages: ConversationMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !msg.isAutonomous) break;
    n += 1;
  }
  return n;
}

/**
 * Where to cut, retaining `keepTurns` user turns and optionally holding back a
 * trailing autonomous run.
 *
 * The clamp only ever bites on a keep-0 split: any keep of one or more already
 * lands at or before the last real user turn, which precedes the autonomous
 * tail by construction.
 */
export function archiveSplitIndex(
  messages: ConversationMessage[],
  keepTurns: number,
  retainTrailingAutonomous: boolean,
): number {
  const splitAt = findTurnSplit(messages, keepTurns);
  if (!retainTrailingAutonomous) return splitAt;
  const tail = trailingAutonomousLen(messages);
  return Math.min(splitAt, Math.max(messages.length - tail, 0));
}

// ── The compaction path filter ──────────────────────────────────────────

/**
 * May a compaction pass write here?
 *
 * Three allowances and two refusals, in the order they are decided:
 *
 *   - `MEMORY.md` at the workspace root — compaction's job includes updating
 *     the conversational throughline.
 *   - The other root prompt files (`SOUL.md`, `USER.md`, `AGENTS.md`,
 *     `TOOLS.md`), because the compaction prompt asks the model to distill
 *     durable facts into them. These go through the same deferred-edit queue as
 *     chat-turn edits, so they only become prompt-active at the boundary this
 *     pass is creating.
 *   - Anything under `memory/`, except the dreaming artifacts, so a compaction
 *     cannot stomp on what a dream wrote.
 *
 * Absolute paths and any `..` component are refused before any of that.
 * `resolvePath` enforces confinement again at write time; failing closed here
 * as well keeps this documented guard self-contained, at the layer whose job is
 * to keep compaction inside its own corner of the workspace.
 */
export function writeAllowedPath(path: string): boolean {
  // Order copied exactly: the `./` strip runs before the backslash rewrite, so
  // a Windows-style `.\x` still carries its `./` afterwards. It survives the
  // component check as a `CurDir` and is stripped again by
  // `normalizePromptVisiblePath` below, so nothing downstream sees it — but
  // moving the rewrite earlier would change which spellings reach the
  // `memory/` prefix test.
  let normalized = rustTrim(path);
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replaceAll("\\", "/");

  for (const component of pathComponents(normalized)) {
    if (component === ".." || component === "/") return false;
  }

  const lower = normalized.toLowerCase();
  if (lower === "memory.md") return true;
  if (normalizePromptVisiblePath(normalized) !== undefined) return true;

  if (!normalized.startsWith("memory/")) return false;
  const rest = normalized.slice("memory/".length);
  if (rest === "") return false;

  const restLower = rest.toLowerCase();
  return !(
    restLower === "dreams.md" ||
    restLower === "dreams" ||
    restLower === "dreams/" ||
    restLower.startsWith(".dreams/") ||
    restLower.startsWith("dreaming/")
  );
}

// ── Tool-loop state ─────────────────────────────────────────────────────

/**
 * What a pass accumulates while the model works: the writes that landed (with
 * their previous content, for rollback), the paths the filter refused, every
 * tool name in call order, and the previews a dry run would have written.
 */
interface ToolLoopState {
  writesApplied: AppliedCompactionWrite[];
  rejectedPaths: string[];
  toolsCalled: string[];
  dryRunPreviews: MemoryFileOp[];
  toolRounds: number;
  maxRoundsHit: boolean;
  dryRun: boolean;
}

/**
 * The model's intended path, and the whole-file body when the call carries one.
 *
 * Only `edit`'s `content` form names the resulting file outright. Its `edits`
 * form describes replacements against what is on disk, so a dry run — which by
 * definition has not applied them — can preview the path but not the result.
 */
function extractMemoryWriteIntent(
  input: unknown,
): { path: string; content?: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.path !== "string") return undefined;
  return typeof obj.content === "string"
    ? { path: obj.path, content: obj.content }
    : { path: obj.path };
}

/**
 * Run one tool call from the compaction loop, wrapping the canonical dispatch.
 *
 *   - `delete` is always refused. `git` is allowed so the pass can commit its
 *     writes — the tool is git-only by construction, so compaction does not
 *     have to read a command line to know that — but not during a dry run,
 *     which runs no commands at all.
 *   - In a dry run `edit` is blocked and the intended path recorded, so the
 *     preview is still useful.
 *   - For a live `edit` the path filter runs, and the resolved file's previous
 *     content is snapshotted so a downstream archive failure can roll it back.
 *
 * Everything else passes through untouched.
 */
async function dispatchCompactionTool(
  name: string,
  input: unknown,
  tools: CompactionTools,
  workspaceDir: string,
  state: ToolLoopState,
): Promise<{ output: string; isError: boolean }> {
  if (name === "delete") {
    return { output: `${name} is not available during compaction`, isError: true };
  }
  if (name === "git" && state.dryRun) {
    return {
      output: "git blocked: dry-run compaction does not run commands",
      isError: true,
    };
  }

  const isWriteLike = name === "edit";

  if (state.dryRun && isWriteLike) {
    const intent = extractMemoryWriteIntent(input);
    if (intent !== undefined) {
      if (writeAllowedPath(intent.path)) {
        state.dryRunPreviews.push({
          path: intent.path,
          content: intent.content ?? `<${name}: in-place edits, no preview available>`,
        });
      }
      // The Rust pushed the refused path onto `rejectedPaths` here. Nothing
      // read it: a dry run always returns the `dry_run` outcome, which has no
      // rejected-paths field, and a pass cannot be both dry and live. Dropped
      // rather than carried as an accumulation with no reader.
    }
    return {
      output: `${name} blocked: dry-run compaction does not modify files`,
      isError: true,
    };
  }

  if (isWriteLike) {
    const intent = extractMemoryWriteIntent(input);
    if (intent === undefined) {
      return { output: `${name} blocked: missing required 'path' field`, isError: true };
    }
    const displayPath = intent.path;
    if (!writeAllowedPath(displayPath)) {
      console.warn(
        `shore: compaction refusing to write disallowed path ${displayPath} (tool ${name})`,
      );
      state.rejectedPaths.push(displayPath);
      return {
        output:
          `${name} blocked: compaction may only write under memory/* or to the workspace-root ` +
          `prompt files (MEMORY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md) (got: ${displayPath})`,
        isError: true,
      };
    }

    // Resolve to disk so the previous content can be snapshotted. A failure
    // here means the path was malformed — traversal, symlink escape — so it is
    // surfaced to the model and recorded as rejected.
    let resolved: string;
    try {
      resolved = resolvePath(workspaceDir, displayPath);
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
      state.rejectedPaths.push(displayPath);
      return { output: `${name} blocked: ${e.message}`, isError: true };
    }

    let previousContent: string | undefined;
    try {
      previousContent = await readFile(resolved, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          output: `${name} failed to read existing file: ${(e as Error).message}`,
          isError: true,
        };
      }
    }

    const result = await tools.dispatch(name, input);
    if (!result.isError) {
      state.writesApplied.push({
        displayPath,
        resolvedPath: resolved,
        ...(previousContent === undefined ? {} : { previousContent }),
        memoryIndexTarget: normalizePromptVisiblePath(displayPath) === MEMORY_INDEX_FILE,
      });
    }
    return result;
  }

  return await tools.dispatch(name, input);
}

/** Drives the shared tool loop for one compaction pass. */
class CompactionDriver implements ToolLoopDriver<GenerateResponse> {
  readonly state: ToolLoopState;
  #pending: ContentBlock[] = [];

  constructor(
    private readonly llm: CompactionLlm,
    private readonly request: SidecarRequest,
    private readonly tools: CompactionTools,
    private readonly workspaceDir: string,
    dryRun: boolean,
  ) {
    this.state = {
      writesApplied: [],
      rejectedPaths: [],
      toolsCalled: [],
      dryRunPreviews: [],
      toolRounds: 0,
      maxRoundsHit: false,
      dryRun,
    };
  }

  finishReason(turn: GenerateResponse): string {
    return turn.finish_reason;
  }

  toolUses(turn: GenerateResponse): ToolUseEvent[] {
    return turn.content_blocks.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
  }

  async callModel(): Promise<GenerateResponse> {
    const resp = await this.llm.generate(this.request);
    pushAssistantTurn(this.request, resp);
    return resp;
  }

  async dispatch(_turn: GenerateResponse, uses: ToolUseEvent[]): Promise<void> {
    this.state.toolRounds += 1;
    this.#pending = [];
    for (const use of uses) {
      this.state.toolsCalled.push(use.name);
      const { output, isError } = await dispatchCompactionTool(
        use.name,
        use.input,
        this.tools,
        this.workspaceDir,
        this.state,
      );
      this.#pending.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: output,
        is_error: isError,
      });
    }
  }

  appendToolResults(): void {
    this.request.messages.push({ role: "user", content: this.#pending });
  }
}

/**
 * Alternate `generate()` and tool dispatch until the model ends cleanly or the
 * round budget runs out.
 *
 * `stop_after_dispatch`: a compaction's output is the writes it accumulated,
 * not a closing message, so a capped pass has nothing to spend another call on.
 * The chat path chooses otherwise.
 */
async function runCompactionToolLoop(
  llm: CompactionLlm,
  request: SidecarRequest,
  tools: CompactionTools,
  workspaceDir: string,
  maxToolIterations: number | undefined,
  dryRun: boolean,
): Promise<ToolLoopState> {
  const driver = new CompactionDriver(llm, request, tools, workspaceDir, dryRun);
  const outcome = await runToolLoop(driver, undefined, maxToolIterations, "stop_after_dispatch");
  driver.state.maxRoundsHit = outcome.stop === "cap_reached";
  return driver.state;
}

// ── Rollback ────────────────────────────────────────────────────────────

/** Write a file, creating its parent directories. Failures become markdown-store errors. */
async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  } catch (e) {
    throw CompactionError.markdownStore((e as Error).message);
  }
}

/**
 * Compensating-delete rollback for a failed pass.
 *
 * Walks the applied writes in reverse, restoring prior content where the file
 * existed and deleting it where it did not. Individual failures are logged and
 * skipped so one bad path cannot strand the rest.
 */
async function rollbackCompaction(writes: AppliedCompactionWrite[]): Promise<void> {
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const write = writes[i]!;
    if (write.previousContent !== undefined) {
      try {
        await writeWorkspaceFile(write.resolvedPath, write.previousContent);
      } catch (e) {
        console.warn(
          `shore: rollback failed to restore compaction write at ${write.resolvedPath} ` +
            `(${write.displayPath}): ${(e as Error).message}`,
        );
      }
      continue;
    }
    try {
      await rm(write.resolvedPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.warn(
        `shore: rollback failed to delete compaction write at ${write.resolvedPath} ` +
          `(${write.displayPath}): ${(e as Error).message}`,
      );
    }
  }
}

// ── The pass ────────────────────────────────────────────────────────────

/**
 * The one config field a pass reads.
 *
 * `CompactionConfig` has six more — `enabled`, `idle_trigger`, `archive_after`,
 * `min_turns`, `max_turns`, `max_context_tokens` — and every one of them is
 * read by the autonomy layer deciding *whether* to compact, never by the pass
 * itself. See the module note on what was dropped.
 */
export interface CompactionSettings {
  /** User turns retained in `active.jsonl` after a pass. */
  keepRecentTurns: number;
}

export interface CompactOptions {
  conversationId: string;
  messages: ConversationMessage[];
  /**
   * Pre-read content of `active.jsonl` from when `messages` was parsed. The
   * authority for the archive write, closing the window where the file changes
   * underneath a pass.
   */
  activeContent: string;
  systemTemplate: string;
  promptTemplate: string;
  charName: string;
  userName: string;
  llm: CompactionLlm;
  conversationMgr: ConversationManager;
  markdownStore?: MarkdownMemoryStore;
  dryRun: boolean;
  keepTurnsOverride?: number;
  retainTrailingAutonomous: boolean;
  /** Chat's `(system, tools, messages)`, which the LLM impl extends. */
  chatRequest: SidecarRequest;
  dataDir?: string;
  tools: CompactionTools;
  /** Dispatch rounds the loop may run. Undefined is unlimited, the default. */
  maxToolIterations?: number;
}

/**
 * The workspace root for path resolution and previous-content snapshots.
 *
 * Prefers the markdown store's parent, which is canonical in production, and
 * falls back to the tool context for dry runs without a store. When both exist
 * they must agree: `edit` resolution and the git bootstrap use the
 * store-derived root while the model's own `git` runs against the tool
 * context's, and if those were different trees a pass would commit one and roll
 * back the other. They are always the same in production, so this fails fast
 * rather than quietly operating on two repositories.
 */
async function preparePassWorkspace(
  markdownStore: MarkdownMemoryStore | undefined,
  tools: CompactionTools,
  charName: string,
  dryRun: boolean,
): Promise<string> {
  let workspaceDir: string;
  if (markdownStore !== undefined) {
    const base = markdownStore.baseDir;
    const fromStore = dirname(base);
    if (fromStore === base) {
      throw CompactionError.markdownStore(`memory store has no workspace parent: ${base}`);
    }
    const fromCtx = tools.workspaceDir;
    // Both resolve, or neither counts: the Rust compared canonical forms when
    // `canonicalize` succeeded on both and fell back to comparing the paths as
    // written otherwise, so a root that does not exist yet still matches itself.
    const realStore = await tryRealpath(fromStore);
    const realCtx = await tryRealpath(fromCtx);
    const agree =
      realStore !== undefined && realCtx !== undefined
        ? realStore === realCtx
        : fromStore === fromCtx;
    if (!agree) {
      throw CompactionError.markdownStore(
        `workspace root mismatch: store=${fromStore} tool_ctx=${fromCtx}`,
      );
    }
    workspaceDir = fromStore;
  } else {
    workspaceDir = tools.workspaceDir;
  }

  // Live passes commit their memory writes through the git-gated tool, so the
  // workspace has to be a repository before the loop starts.
  if (!dryRun) {
    await tools.ensureWorkspaceGitRepo(workspaceDir, charName, "compaction");
  }
  return workspaceDir;
}

async function tryRealpath(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

/**
 * Run a compaction pass.
 *
 * Splits the messages into a compacted prefix and a retained tail, runs the
 * compaction LLM's tool loop against `tools`, and archives only if at least one
 * allowed memory write landed. A dry run blocks writes at the dispatch wrapper,
 * records the intended paths, and archives nothing.
 */
export async function compact(opts: CompactOptions, settings: CompactionSettings): Promise<CompactionOutcome> {
  const { messages, tools } = opts;

  // The Rust refused an empty conversation here and again below on a zero
  // split. The second check subsumes the first — an empty list splits at zero
  // for every `keepTurns`, including zero, where the split is the length — and
  // both raised the same error, so nothing could tell which had fired.
  const keepTurns = opts.keepTurnsOverride ?? settings.keepRecentTurns;
  const splitAt = archiveSplitIndex(messages, keepTurns, opts.retainTrailingAutonomous);
  if (splitAt === 0) throw CompactionError.insufficientMessages();

  if (!opts.dryRun && opts.markdownStore === undefined) {
    throw CompactionError.markdownStore("markdown memory store not available");
  }

  const request = buildCompactLlmRequest(opts);
  const workspaceDir = await preparePassWorkspace(
    opts.markdownStore,
    tools,
    opts.charName,
    opts.dryRun,
  );

  const compactedTurns = countTurns(messages.slice(0, splitAt));
  const retainedTurns = countTurns(messages.slice(splitAt));
  const retained = messages.length - splitAt;

  const state = await runCompactionToolLoop(
    opts.llm,
    request,
    tools,
    workspaceDir,
    opts.maxToolIterations,
    opts.dryRun,
  );

  if (opts.dryRun) {
    return {
      kind: "dry_run",
      wouldWriteFiles: state.dryRunPreviews.length,
      fileOpsPreview: state.dryRunPreviews,
      messageCount: splitAt,
      compactedTurns,
      retainedCount: retained,
      retainedTurns,
      markdownPreview: state.dryRunPreviews.map((op) => op.path),
      toolRounds: state.toolRounds,
      toolsCalled: state.toolsCalled,
    };
  }

  // The guard: no allowed write means the transcript stays where it is.
  if (state.writesApplied.length === 0) {
    console.warn(
      `shore: compaction wrote no memory for ${opts.conversationId}; active conversation NOT ` +
        `archived (rounds=${state.toolRounds}, rejected=${state.rejectedPaths.length}, ` +
        `max_rounds_hit=${state.maxRoundsHit})`,
    );
    return {
      kind: "no_memory_writes",
      conversationId: opts.conversationId,
      messageCount: splitAt,
      compactedTurns,
      toolRounds: state.toolRounds,
      toolsCalled: state.toolsCalled,
      rejectedPaths: state.rejectedPaths,
      maxRoundsHit: state.maxRoundsHit,
    };
  }

  const newConversationId = await archiveCompactPrefix(
    opts.conversationMgr,
    opts.conversationId,
    retained,
    opts.activeContent,
    state.writesApplied,
    workspaceDir,
    opts.charName,
    tools,
  );

  const markdownPaths = state.writesApplied.map((w) => w.displayPath);
  const memoryIndexUpdated = state.writesApplied.some((w) => w.memoryIndexTarget);
  await queueMemoryIndexRefresh(memoryIndexUpdated, tools, opts.dataDir, opts.charName);

  return {
    kind: "compacted",
    memoryFilesWritten: markdownPaths,
    conversationId: opts.conversationId,
    newConversationId,
    messageCount: splitAt,
    compactedTurns,
    retainedCount: retained,
    retainedTurns,
    markdownPaths,
    toolRounds: state.toolRounds,
    toolsCalled: state.toolsCalled,
  };
}

/**
 * Build the compaction system prompt and the single "compact now" user turn,
 * then hand both to the LLM impl to extend chat's request with.
 *
 * The instruction rides as an inline `role:"system"` entry at a fixed slot
 * rather than a system suffix, because that is what keeps the compact-now slot
 * byte-stable across the tool loop — and so keeps chat's cache prefix extending
 * cleanly instead of being invalidated by every round.
 */
function buildCompactLlmRequest(opts: CompactOptions): SidecarRequest {
  const system = buildSystem(opts.systemTemplate, opts.charName, opts.userName);
  const finalMsg = buildFinalMessage(opts.promptTemplate, opts.charName, opts.userName);
  const compactNowUser: WireMessage = {
    role: "user",
    content: [{ type: "text", text: finalMsg }],
  };
  return opts.llm.buildInitialRequest(system, compactNowUser, opts.chatRequest);
}

/**
 * Archive the compacted prefix, retaining the recent tail.
 *
 * On failure the applied writes are rolled back and a git revert commit is
 * recorded: the model may have committed its writes before the archive failed,
 * and history that no longer matches the tree is worse than an extra commit.
 * Both cleanup steps are best-effort; the original error is what propagates.
 */
async function archiveCompactPrefix(
  conversationMgr: ConversationManager,
  conversationId: string,
  retained: number,
  activeContent: string,
  writesApplied: AppliedCompactionWrite[],
  workspaceDir: string,
  charName: string,
  tools: CompactionTools,
): Promise<string> {
  try {
    return await conversationMgr.archiveAndRetain(conversationId, {
      keepLastN: retained,
      activeContent,
    });
  } catch (e) {
    await rollbackCompaction(writesApplied);
    try {
      if (
        await tools.gitCommitAll(
          workspaceDir,
          charName,
          "revert: compaction rolled back after archive failure",
        )
      ) {
        console.info("shore: compaction recorded rollback commit");
      }
    } catch (gitErr) {
      console.warn(
        `shore: compaction failed to record rollback commit: ${(gitErr as Error).message}`,
      );
    }
    throw e;
  }
}

/**
 * Queue a `MEMORY.md` prompt refresh when the pass wrote the index but the tool
 * context did not queue it itself.
 *
 * Production dispatch calls `defer_edit` on prompt-visible writes, so the queue
 * is already correct; an empty `configDir` marks a context that does not, which
 * in practice means a test stub. Exported for the fixture, which drives it on
 * both sides of that condition.
 */
export async function queueMemoryIndexRefresh(
  memoryIndexUpdated: boolean,
  tools: CompactionTools,
  dataDir: string | undefined,
  charName: string,
): Promise<void> {
  if (!memoryIndexUpdated || tools.configDir !== "") return;
  // Unkillable by construction, and kept anyway: without it the join below
  // throws on an undefined base and the catch turns that into the same warning
  // and the same empty queue. The message is the point — "no data dir" is a
  // wiring mistake an operator can act on, where a TypeError is not.
  if (dataDir === undefined) {
    console.warn(
      "shore: compaction updated MEMORY.md but no data dir was available for the prompt refresh queue",
    );
    return;
  }
  try {
    await noteMemoryIndexDeferred(characterDataDir(dataDir, charName));
  } catch (e) {
    console.warn(
      `shore: compaction failed to queue MEMORY.md prompt refresh: ${(e as Error).message}`,
    );
  }
}
