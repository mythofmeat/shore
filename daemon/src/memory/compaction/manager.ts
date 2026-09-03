import { required } from "../../util/required.ts";

import { shoreLog } from "../../log.ts";

import { dirname } from "node:path";

import { characterActiveJsonl, characterDataDir, MAIN_THREAD } from "../../config/dirs.ts";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";

import { pushAssistantTurn } from "../../llm/request";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";
import { runToolLoop, type ToolLoopDriver, type ToolUseEvent } from "../../engine/tool_loop";
import { hitTokenCeiling } from "../../llm/finish_reason.ts";
import { budgetStopIn } from "../../llm/errors.ts";
import { retainedTurns as retentionForBudget } from "./retention.ts";
import type { ContentBlock } from "../../engine/types";
import type { MarkdownMemoryStore } from "../markdown_store";
import { rustLines, rustTrim } from "../lines";
import { hasCompactionOperation } from "./archive.ts";
import { conversationRef } from "../../engine/segments.ts";
import {
  normalizePromptVisiblePath,
  pathComponents,
  PathError,
  resolvePath,
} from "../../tools/workspace_path";
import type { FrameSink } from "../../llm/stream.ts";
import {
  COMPACTION_SUBAGENT,
  CompactionError,
  type AppliedCompactionWrite,
  type CompactionLlm,
  type CompactionOutcome,
  type CompactionTools,
  type ConversationManager,
  type ConversationMessage,
  type MemoryFileOp,
} from "./types";
import {
  checkpointSourceIsCompatible,
  loadCompactionCheckpoint,
  newCompactionCheckpoint,
  removeCompactionCheckpoint,
  saveCompactionCheckpoint,
  type CheckpointLoopState,
  type CompactionCheckpoint,
  type CompactionPauseReason,
} from "./checkpoint.ts";

const inFlight = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

export interface CompactionRunGuard {
  release(): void;
  [Symbol.dispose](): void;
}

function handOff(key: string): void {
  const queue = waiting.get(key);
  const next = queue?.shift();
  if (queue !== undefined && queue.length === 0) waiting.delete(key);
  if (next === undefined) {
    inFlight.delete(key);
    return;
  }
  next();
}

function guardFor(key: string): CompactionRunGuard {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    handOff(key);
  };
  return { release, [Symbol.dispose]: release };
}

export function tryBeginCompaction(
  dataDir: string,
  character: string,
): CompactionRunGuard | undefined {
  const key = characterDataDir(dataDir, character);
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  return guardFor(key);
}

export async function beginCompaction(
  dataDir: string,
  character: string,
): Promise<CompactionRunGuard> {
  const key = characterDataDir(dataDir, character);
  if (!inFlight.has(key)) {
    inFlight.add(key);
    return guardFor(key);
  }
  await new Promise<void>((resolve) => {
    const queue = waiting.get(key);
    if (queue === undefined) waiting.set(key, [resolve]);
    else queue.push(resolve);
  });
  return guardFor(key);
}

export function buildSystem(template: string, charName: string, userName: string): string {
  return template.replaceAll("{{char}}", charName).replaceAll("{{user}}", userName);
}

const IF_RECAP = "{{#if recap}}";
const END_IF = "{{/if}}";

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

const isRealUserTurn = (msg: ConversationMessage): boolean =>
  msg.role === "user" && !msg.isToolResultOnly;

export function findTurnSplit(messages: ConversationMessage[], keepTurns: number): number {
  if (keepTurns === 0) return messages.length;
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isRealUserTurn(required(messages[i]))) {
      turnsSeen += 1;
      if (turnsSeen >= keepTurns) return i;
    }
  }
  return 0;
}

export function countTurns(messages: ConversationMessage[]): number {
  return messages.filter(isRealUserTurn).length;
}

export function trailingAutonomousLen(messages: ConversationMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = required(messages[i]);
    if (msg.role !== "assistant" || !msg.isAutonomous) break;
    n += 1;
  }
  return n;
}

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

export function writeAllowedPath(path: string): boolean {
  let normalized = rustTrim(path).replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);

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

interface ToolLoopState extends CheckpointLoopState {
  writesApplied: AppliedCompactionWrite[];
  toolsCalled: string[];
  dryRunPreviews: MemoryFileOp[];
  toolRounds: number;
  maxRoundsHit: boolean;
  truncatedTurns?: number;
}

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
      shoreLog.warn(
        `shore: compaction refusing to write disallowed path ${displayPath} (tool ${name})`,
      );
      return {
        output:
          `${name} blocked: compaction may only write under memory/* or to the workspace-root ` +
          `prompt files (MEMORY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md) (got: ${displayPath})`,
        isError: true,
      };
    }

    let resolved: string;
    try {
      resolved = resolvePath(workspaceDir, displayPath);
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
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
      let resultingContent: string | undefined;
      try {
        resultingContent = await readFile(resolved, "utf8");
      } catch {
        resultingContent = intent.content;
      }
      state.writesApplied.push({
        displayPath,
        resolvedPath: resolved,
        ...(previousContent === undefined ? {} : { previousContent }),
        ...(resultingContent === undefined ? {} : { resultingContent }),
      });
      await tools.deferEdit?.(displayPath);
    }
    return result;
  }

  return await tools.dispatch(name, input);
}

class CompactionDriver implements ToolLoopDriver<GenerateResponse> {
  readonly state: ToolLoopState;
  #pending: ContentBlock[] = [];

  constructor(
    private readonly llm: CompactionLlm,
    private readonly request: SidecarRequest,
    private readonly tools: CompactionTools,
    private readonly workspaceDir: string,
    dryRun: boolean,
    restored: ToolLoopState | undefined,
    private readonly persist: (state: ToolLoopState, request: SidecarRequest) => Promise<void>,
    private readonly emit: FrameSink = () => {},
  ) {
    this.state = restored ?? {
      writesApplied: [],
      toolsCalled: [],
      dryRunPreviews: [],
      toolRounds: 0,
      maxRoundsHit: false,
      dryRun,
      pendingResults: [],
      pendingUseCount: 0,
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
    this.emit({
      type: "phase",
      rid: null,
      phase: `compacting round ${String(this.state.toolRounds + 1)}`,
      model: null,
    });
    const resp = await this.llm.generate(this.request);
    if (hitTokenCeiling(resp.finish_reason)) {
      this.state.truncatedTurns = (this.state.truncatedTurns ?? 0) + 1;
    }
    pushAssistantTurn(this.request, resp);
    this.state.pendingTurn = resp;
    this.state.pendingResults = [];
    this.state.pendingUseCount = 0;
    await this.persist(this.state, this.request);
    return resp;
  }

  async dispatch(_turn: GenerateResponse, uses: ToolUseEvent[]): Promise<void> {
    this.#pending = this.state.pendingResults.map((result, index) => ({
      type: "tool_result" as const,
      tool_use_id: required(uses[index]).id,
      content: result.output,
      is_error: result.isError,
    }));
    for (let i = this.state.pendingUseCount; i < uses.length; i += 1) {
      const use = required(uses[i]);
      this.state.toolsCalled.push(use.name);
      this.emit({
        type: "tool_call",
        rid: null,
        tool_id: use.id,
        tool_name: use.name,
        input: use.input,
        subagent: COMPACTION_SUBAGENT,
        task_id: null,
      });
      const result = await dispatchCompactionTool(
        use.name,
        use.input,
        this.tools,
        this.workspaceDir,
        this.state,
      );
      const { output, isError } = result;
      this.emit({
        type: "tool_result",
        rid: null,
        tool_id: use.id,
        tool_name: use.name,
        output,
        is_error: isError,
        subagent: COMPACTION_SUBAGENT,
        task_id: null,
      });
      this.state.pendingResults.push(result);
      this.state.pendingUseCount = i + 1;
      this.#pending.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: output,
        is_error: isError,
      });
      await this.persist(this.state, this.request);
    }
    this.request.messages.push({ role: "user", content: this.#pending });
    this.state.toolRounds += 1;
    delete this.state.pendingTurn;
    this.state.pendingResults = [];
    this.state.pendingUseCount = 0;
    await this.persist(this.state, this.request);
  }

  appendToolResults(): void {
  }
}

async function runCompactionToolLoop(
  llm: CompactionLlm,
  request: SidecarRequest,
  tools: CompactionTools,
  workspaceDir: string,
  maxToolIterations: number | undefined,
  dryRun: boolean,
  restored: ToolLoopState | undefined,
  persist: (state: ToolLoopState, request: SidecarRequest) => Promise<void>,
  emit?: FrameSink,
): Promise<ToolLoopState> {
  const driver = new CompactionDriver(
    llm,
    request,
    tools,
    workspaceDir,
    dryRun,
    restored,
    persist,
    emit,
  );
  const outcome = await runToolLoop(
    driver,
    driver.state.pendingTurn,
    maxToolIterations,
    "stop_after_dispatch",
  );
  driver.state.maxRoundsHit = outcome.stop === "cap_reached";
  return driver.state;
}

async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  } catch (e) {
    throw CompactionError.markdownStore((e as Error).message);
  }
}

async function rollbackCompaction(writes: AppliedCompactionWrite[]): Promise<void> {
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const write = required(writes[i]);
    if (write.previousContent !== undefined) {
      try {
        await writeWorkspaceFile(write.resolvedPath, write.previousContent);
      } catch (e) {
        shoreLog.warn(
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
      shoreLog.warn(
        `shore: rollback failed to delete compaction write at ${write.resolvedPath} ` +
          `(${write.displayPath}): ${(e as Error).message}`,
      );
    }
  }
}

export interface CompactionSettings {
  keepRecentTurns: number;
  maxContextTokens?: number;
}

export function compactThread(opts: Pick<CompactOptions, "thread">): string {
  return opts.thread ?? MAIN_THREAD;
}

export interface CompactOptions {
  conversationId: string;
  messages: ConversationMessage[];
  activeContent: string;
  systemTemplate: string;
  promptTemplate: string;
  charName: string;
  thread?: string;
  userName: string;
  llm: CompactionLlm;
  conversationMgr: ConversationManager;
  markdownStore?: MarkdownMemoryStore;
  dryRun: boolean;
  keepTurnsOverride?: number;
  restart?: boolean;
  retainTrailingAutonomous: boolean;
  chatRequest: SidecarRequest;
  dataDir?: string;
  tools: CompactionTools;
  maxToolIterations?: number;
  resumable?: boolean;
  emit?: FrameSink;
}

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

export async function compact(opts: CompactOptions, settings: CompactionSettings): Promise<CompactionOutcome> {
  const { messages, tools } = opts;

  const keepTurns =
    opts.keepTurnsOverride ??
    retentionForBudget(messages, settings.keepRecentTurns, settings.maxContextTokens ?? 0);
  const splitAt = archiveSplitIndex(messages, keepTurns, opts.retainTrailingAutonomous);
  if (splitAt === 0) throw CompactionError.insufficientMessages();

  if (!opts.dryRun && opts.markdownStore === undefined) {
    throw CompactionError.markdownStore("markdown memory store not available");
  }

  const initialRequest = buildCompactLlmRequest(opts);
  const workspaceDir = await preparePassWorkspace(
    opts.markdownStore,
    tools,
    opts.charName,
    opts.dryRun,
  );
  const workspaceHead = opts.dryRun ? undefined : await tools.gitHead?.(workspaceDir);

  const compactedTurns = countTurns(messages.slice(0, splitAt));
  const originalRetained = messages.length - splitAt;
  const originalRetainedTurns = countTurns(messages.slice(splitAt));
  let checkpoint = await resolveCheckpoint(
    opts,
    splitAt,
    compactedTurns,
    initialRequest,
    workspaceHead,
  );
  checkpoint.request.api_key = initialRequest.api_key;
  const alreadyArchived = opts.resumable === true && opts.dataDir !== undefined
    ? await hasCompactionOperation(
        conversationRef(opts.dataDir, opts.charName, compactThread(opts), false),
        checkpoint.id,
      )
    : false;
  if (alreadyArchived && !checkpointSourceIsCompatible(checkpoint, await currentActiveContent(opts))) {
    const liveContent = await currentActiveContent(opts);
    const liveLines = rustLines(liveContent).filter((line) => rustTrim(line) !== "");
    const markdownPaths = checkpoint.loop.writesApplied.map((write) => write.displayPath);
    await clearCheckpoint(opts);
    return {
      kind: "compacted",
      memoryFilesWritten: markdownPaths,
      conversationId: opts.conversationId,
      newConversationId: checkpoint.id,
      messageCount: checkpoint.splitAt,
      compactedTurns: checkpoint.compactedTurns,
      retainedCount: liveLines.length,
      retainedTurns: countRetainedTurns(liveLines),
      markdownPaths,
      toolRounds: checkpoint.loop.toolRounds,
      toolsCalled: checkpoint.loop.toolsCalled,
    };
  }
  if (checkpoint.state === "paused" && checkpoint.resumeAt !== undefined) {
    if (Date.parse(checkpoint.resumeAt) > Date.now()) return pausedOutcome(opts, checkpoint);
  }
  const conflict = await checkpointConflict(checkpoint, opts.activeContent);
  if (conflict !== undefined) {
    if (conflict.reason !== "source_conflict") {
      checkpoint.state = "paused";
      checkpoint.pauseReason = conflict.reason;
      if (conflict.detail === undefined) delete checkpoint.pauseDetail;
      else checkpoint.pauseDetail = conflict.detail;
      await persistCheckpoint(opts, checkpoint);
      return pausedOutcome(opts, checkpoint);
    }
    shoreLog.warn(
      `shore: discarding compaction checkpoint ${checkpoint.id} for ${opts.charName}: the active ` +
        `conversation was rewritten under it, so the pass can never resume; summarizing from the ` +
        `current conversation instead. The memory it already wrote stays on disk`,
    );
    await clearCheckpoint(opts);
    checkpoint = newCompactionCheckpoint(
      opts.charName,
      opts.activeContent,
      splitAt,
      compactedTurns,
      initialRequest,
      opts.dryRun,
      workspaceHead,
    );
    checkpoint.request.api_key = initialRequest.api_key;
  }
  checkpoint.state = "running";
  delete checkpoint.pauseReason;
  delete checkpoint.pauseDetail;
  delete checkpoint.resumeAt;
  await persistCheckpoint(opts, checkpoint);

  const request = checkpoint.request;
  let state: ToolLoopState;
  try {
    state = await runCompactionToolLoop(
      opts.llm,
      request,
      tools,
      workspaceDir,
      opts.maxToolIterations,
      opts.dryRun,
      checkpoint.loop,
      async (nextState, nextRequest) => {
        checkpoint.loop = nextState;
        checkpoint.request = nextRequest;
        await persistCheckpoint(opts, checkpoint);
      },
      opts.emit,
    );
  } catch (e) {
    if (opts.resumable !== true) throw e;
    checkpoint.state = "paused";
    checkpoint.pauseReason = pauseReason(e);
    const resetAt = budgetResetAt(e);
    if (resetAt === undefined) delete checkpoint.resumeAt;
    else checkpoint.resumeAt = resetAt;
    await persistCheckpoint(opts, checkpoint);
    return pausedOutcome(opts, checkpoint, e instanceof Error ? e.message : String(e));
  }
  checkpoint.loop = state;

  if (opts.dryRun) {
    await clearCheckpoint(opts);
    return {
      kind: "dry_run",
      wouldWriteFiles: state.dryRunPreviews.length,
      fileOpsPreview: state.dryRunPreviews,
      messageCount: splitAt,
      compactedTurns,
      retainedCount: originalRetained,
      retainedTurns: originalRetainedTurns,
      markdownPreview: state.dryRunPreviews.map((op) => op.path),
      toolRounds: state.toolRounds,
      toolsCalled: state.toolsCalled,
    };
  }

  if (state.maxRoundsHit && opts.resumable === true) {
    checkpoint.state = "paused";
    checkpoint.pauseReason = "iteration_limit";
    await persistCheckpoint(opts, checkpoint);
    return pausedOutcome(opts, checkpoint);
  }

  const truncatedTurns = state.truncatedTurns ?? 0;
  if (truncatedTurns > 0) {
    await clearCheckpoint(opts);
    shoreLog.warn(
      `shore: compaction for ${opts.conversationId} was cut off at the token ceiling ` +
        `(${String(truncatedTurns)} truncated turn${truncatedTurns === 1 ? "" : "s"}); active ` +
        `conversation NOT archived — a partial summary is not a completed pass`,
    );
    return {
      kind: "truncated",
      conversationId: opts.conversationId,
      messageCount: splitAt,
      compactedTurns,
      toolRounds: state.toolRounds,
      toolsCalled: state.toolsCalled,
      truncatedTurns,
      partialWrites: state.writesApplied.map((write) => write.displayPath),
    };
  }

  const liveContent = await currentActiveContent(opts);
  if (!checkpointSourceIsCompatible(checkpoint, liveContent)) {
    checkpoint.state = "paused";
    checkpoint.pauseReason = "source_conflict";
    await persistCheckpoint(opts, checkpoint);
    return pausedOutcome(opts, checkpoint);
  }
  const liveLines = rustLines(liveContent).filter((line) => rustTrim(line) !== "");
  const retained = opts.resumable === true
    ? Math.max(liveLines.length - checkpoint.splitAt, 0)
    : originalRetained;
  const retainedTurns = opts.resumable === true
    ? countRetainedTurns(liveLines.slice(checkpoint.splitAt))
    : originalRetainedTurns;
  const archivedCount = opts.resumable === true ? checkpoint.splitAt : splitAt;
  const archivedTurns = opts.resumable === true ? checkpoint.compactedTurns : compactedTurns;
  const memoryAfter = await tools.gitHead?.(workspaceDir);

  const newConversationId = await archiveCompactPrefix(
    opts.conversationMgr,
    opts.conversationId,
    retained,
    liveContent,
    state.writesApplied,
    workspaceDir,
    opts.charName,
    tools,
    checkpoint.id,
    checkpoint.memoryBefore,
    memoryAfter,
  );
  await clearCheckpoint(opts);

  const markdownPaths = state.writesApplied.map((w) => w.displayPath);

  return {
    kind: "compacted",
    memoryFilesWritten: markdownPaths,
    conversationId: opts.conversationId,
    newConversationId,
    messageCount: archivedCount,
    compactedTurns: archivedTurns,
    retainedCount: retained,
    retainedTurns,
    markdownPaths,
    toolRounds: state.toolRounds,
    toolsCalled: state.toolsCalled,
  };
}

function buildCompactLlmRequest(opts: CompactOptions): SidecarRequest {
  const system = buildSystem(opts.systemTemplate, opts.charName, opts.userName);
  const finalMsg = buildFinalMessage(opts.promptTemplate, opts.charName, opts.userName);
  const compactNowUser: WireMessage = {
    role: "user",
    content: [{ type: "text", text: finalMsg }],
  };
  return opts.llm.buildInitialRequest(system, compactNowUser, opts.chatRequest);
}

async function archiveCompactPrefix(
  conversationMgr: ConversationManager,
  conversationId: string,
  retained: number,
  activeContent: string,
  writesApplied: AppliedCompactionWrite[],
  workspaceDir: string,
  charName: string,
  tools: CompactionTools,
  operationId?: string,
  memoryBefore?: string,
  memoryAfter?: string,
): Promise<string> {
  try {
    return await conversationMgr.archiveAndRetain(conversationId, {
      keepLastN: retained,
      activeContent,
      ...(operationId === undefined ? {} : { operationId }),
      ...(memoryBefore === undefined ? {} : { memoryBefore }),
      ...(memoryAfter === undefined ? {} : { memoryAfter }),
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
        shoreLog.info("shore: compaction recorded rollback commit");
      }
    } catch (gitErr) {
      shoreLog.warn(
        `shore: compaction failed to record rollback commit: ${(gitErr as Error).message}`,
      );
    }
    throw e;
  }
}

async function resolveCheckpoint(
  opts: CompactOptions,
  splitAt: number,
  compactedTurns: number,
  request: SidecarRequest,
  workspaceHead: string | undefined,
): Promise<CompactionCheckpoint> {
  if (opts.resumable === true && opts.dataDir !== undefined) {
    if (opts.restart === true) {
      const abandonedBefore = await discardCheckpoint(opts);
      return newCompactionCheckpoint(
        opts.charName,
        opts.activeContent,
        splitAt,
        compactedTurns,
        request,
        opts.dryRun,
        abandonedBefore ?? workspaceHead,
      );
    } else {
      const existing = await loadCompactionCheckpoint(
        opts.dataDir,
        opts.charName,
        compactThread(opts),
      );
      if (existing !== undefined) {
        if (opts.keepTurnsOverride === undefined || existing.splitAt === splitAt) return existing;
        shoreLog.warn(
          `shore: compaction checkpoint ${existing.id} for ${opts.charName} splits at ` +
            `${String(existing.splitAt)}, but this pass was asked to keep ` +
            `${String(opts.keepTurnsOverride)} turn(s), which splits at ${String(splitAt)}; ` +
            `starting a fresh pass at the requested split. The memory it already wrote ` +
            `(${JSON.stringify(existing.loop.writesApplied.map((w) => w.displayPath))}) stays on disk`,
        );
        await removeCompactionCheckpoint(opts.dataDir, opts.charName, compactThread(opts));
        return newCompactionCheckpoint(
          opts.charName,
          opts.activeContent,
          splitAt,
          compactedTurns,
          request,
          opts.dryRun,
          existing.memoryBefore ?? workspaceHead,
        );
      }
    }
  }
  return newCompactionCheckpoint(
    opts.charName,
    opts.activeContent,
    splitAt,
    compactedTurns,
    request,
    opts.dryRun,
    workspaceHead,
  );
}

async function persistCheckpoint(opts: CompactOptions, checkpoint: CompactionCheckpoint): Promise<void> {
  if (opts.resumable === true && opts.dataDir !== undefined) {
    await saveCompactionCheckpoint(opts.dataDir, checkpoint, compactThread(opts));
  }
}

async function clearCheckpoint(opts: CompactOptions): Promise<void> {
  if (opts.resumable === true && opts.dataDir !== undefined) {
    await removeCompactionCheckpoint(opts.dataDir, opts.charName, compactThread(opts));
  }
}

async function discardCheckpoint(opts: CompactOptions): Promise<string | undefined> {
  if (opts.dataDir === undefined) return undefined;
  const abandoned = await loadCompactionCheckpoint(
    opts.dataDir,
    opts.charName,
    compactThread(opts),
  ).catch(
    () => undefined,
  );
  if (abandoned !== undefined) {
    shoreLog.warn(
      `shore: discarding compaction checkpoint ${abandoned.id} for ${opts.charName} at the ` +
        `caller's request (state=${abandoned.state}, reason=${abandoned.pauseReason ?? "none"}, ` +
        `rounds=${abandoned.loop.toolRounds}, ` +
        `writes=${JSON.stringify(abandoned.loop.writesApplied.map((w) => w.displayPath))}); ` +
        `those memory writes stay on disk, and its turns were never archived`,
    );
  }
  await removeCompactionCheckpoint(opts.dataDir, opts.charName, compactThread(opts));
  return abandoned?.memoryBefore;
}

interface CheckpointConflict {
  reason: CompactionPauseReason;
  detail?: string;
}

async function checkpointConflict(
  checkpoint: CompactionCheckpoint,
  activeContent: string,
): Promise<CheckpointConflict | undefined> {
  if (!checkpointSourceIsCompatible(checkpoint, activeContent)) {
    return { reason: "source_conflict" };
  }
  const latest = new Map<string, AppliedCompactionWrite>();
  for (const write of checkpoint.loop.writesApplied) latest.set(write.resolvedPath, write);
  for (const write of latest.values()) {
    if (write.resultingContent === undefined) continue;
    try {
      if ((await readFile(write.resolvedPath, "utf8")) !== write.resultingContent) {
        return { reason: "workspace_conflict", detail: write.displayPath };
      }
    } catch {
      return { reason: "workspace_conflict", detail: write.displayPath };
    }
  }
  return undefined;
}

function pausedOutcome(
  opts: CompactOptions,
  checkpoint: CompactionCheckpoint,
  reasonOverride?: string,
): CompactionOutcome {
  return {
    kind: "paused",
    conversationId: opts.conversationId,
    checkpointId: checkpoint.id,
    messageCount: checkpoint.splitAt,
    compactedTurns: checkpoint.compactedTurns,
    toolRounds: checkpoint.loop.toolRounds,
    toolsCalled: checkpoint.loop.toolsCalled,
    reason: reasonOverride ?? checkpoint.pauseReason ?? "provider",
    ...(checkpoint.pauseDetail === undefined ? {} : { detail: checkpoint.pauseDetail }),
    ...(checkpoint.resumeAt === undefined ? {} : { resumeAt: checkpoint.resumeAt }),
  };
}

function pauseReason(e: unknown): CompactionPauseReason {
  return budgetStopIn(e) === undefined ? "provider" : "budget";
}

function budgetResetAt(e: unknown): string | undefined {
  return budgetStopIn(e)?.resetAt;
}

async function currentActiveContent(opts: CompactOptions): Promise<string> {
  if (opts.resumable !== true || opts.dataDir === undefined) return opts.activeContent;
  try {
    return await readFile(
      characterActiveJsonl(opts.dataDir, opts.charName, compactThread(opts)),
      "utf8",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return opts.activeContent;
    throw e;
  }
}

function countRetainedTurns(lines: readonly string[]): number {
  let count = 0;
  for (const line of lines) {
    try {
      const message = JSON.parse(line) as { role?: unknown; content_blocks?: unknown };
      if (message.role !== "user") continue;
      const blocks = Array.isArray(message.content_blocks) ? message.content_blocks : [];
      if (blocks.length > 0 && blocks.every((block) => {
        return typeof block === "object" && block !== null &&
          (block as { type?: unknown }).type === "tool_result";
      })) continue;
      count += 1;
    } catch {}
  }
  return count;
}

