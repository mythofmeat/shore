import { restoreWorkspaceEntry, sameWorkspaceEntry, snapshotWorkspace, workspaceEntry } from "../../tools/workspace_snapshot.ts";
import { readDurable, threadFile } from "../../storage/files.ts";
import { required } from "../../util/required.ts";

import { shoreLog } from "../../log.ts";

import { dirname, join } from "node:path";

import { characterDataDir, MAIN_THREAD } from "../../config/dirs.ts";
import { lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";

import { pushAssistantTurn } from "../../llm/request";
import type { GenerateResponse, SidecarRequest } from "../../llm/types";
import type { ToolUseEvent } from "../../engine/tool_loop";
import type { ToolPhase } from "../../tools/execute.ts";
import { hitTokenCeiling } from "../../llm/finish_reason.ts";
import { budgetStopIn } from "../../llm/errors.ts";
import type { ContentBlock } from "../../engine/types";
import type { MarkdownMemoryStore } from "../markdown_store";
import { rustLines, rustTrim } from "../lines";
import { hasCompactionOperation } from "./archive.ts";
import { conversationRef } from "../../engine/segments.ts";
import { PathError, resolvePath, normalizePromptVisiblePath } from "../../tools/workspace_path";
import type { FrameSink } from "../../llm/stream.ts";
import {
  COMPACTION_SUBAGENT,
  CompactionError,
  type CompactionCoverage,
  type AppliedCompactionWrite,
  type CompactionLlm,
  type CompactionOutcome,
  type CompactionTools,
  type ConversationManager,
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
import {
  countTurns,
  openArchivalCommit,
  retainedTurnCount,
  type ArchivalPlan,
} from "./plan.ts";

export { archiveSplitIndex, countTurns, findTurnSplit, trailingAutonomousLen } from "./plan.ts";

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

interface ToolLoopState extends CheckpointLoopState {
  writesApplied: AppliedCompactionWrite[];
  toolsCalled: string[];
  dryRunPreviews: MemoryFileOp[];
  toolRounds: number;
  maxRoundsHit: boolean;
  truncatedTurns?: number;
}

function changedFilePaths(writes: readonly AppliedCompactionWrite[]): string[] {
  return writes.filter((write) => {
    if (write.previousState === undefined && write.resultingState === undefined) return true;
    return write.previousState?.kind === "file" || write.previousState?.kind === "symlink" ||
      write.resultingState?.kind === "file" || write.resultingState?.kind === "symlink";
  }).map((write) => write.displayPath);
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
): Promise<import("./types.ts").ToolOutput> {
  if (["bash", "edit", "apply_patch"].includes(name)) {
    if (state.dryRun) return { output: `${name} blocked: dry-run compaction does not modify files`, isError: true };
    const before = await snapshotWorkspace(workspaceDir);
    try {
      return await tools.dispatch(name, input);
    } finally {
      const after = await snapshotWorkspace(workspaceDir);
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        const previousState = before.get(path) ?? null;
        const resultingState = after.get(path) ?? null;
        if (sameWorkspaceEntry(previousState, resultingState)) continue;
        state.writesApplied.push({
          displayPath: path, resolvedPath: join(workspaceDir, path), previousState, resultingState,
          ...(resultingState === null ? { deleted: true } : {}),
        });
        if (normalizePromptVisiblePath(path) !== undefined) await tools.deferEdit?.(path);
      }
    }
  }

  if (name === "git" && state.dryRun) {
    return {
      output: "git blocked: dry-run compaction does not run commands",
      isError: true,
    };
  }

  const isWriteLike = name === "delete";

  if (isWriteLike) {
    const intent = extractMemoryWriteIntent(input);
    if (intent === undefined) {
      return { output: `${name} blocked: missing required 'path' field`, isError: true };
    }
    const displayPath = intent.path;

    let resolved: string;
    try {
      resolved = resolvePath(workspaceDir, displayPath);
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
      return { output: `${name} blocked: ${e.message}`, isError: true };
    }

    if (state.dryRun) {
      state.dryRunPreviews.push({
        path: displayPath,
        content: name === "delete" ? "<delete: move to trash>"
          : intent.content ?? "<edit: in-place edits, no preview available>",
      });
      return {
        output: `${name} blocked: dry-run compaction does not modify files`,
        isError: true,
      };
    }

    let previousContent: string | undefined;
    let previousEncoding: "base64" | undefined;
    let previousSymlink: string | undefined;
    try {
      if (name === "delete" && (await lstat(resolved)).isSymbolicLink()) {
        previousSymlink = await readlink(resolved);
      } else {
        const bytes = await readFile(resolved);
        previousContent = bytes.toString("utf8");
        if (!Buffer.from(previousContent).equals(bytes)) {
          previousContent = bytes.toString("base64");
          previousEncoding = "base64";
        }
      }
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
        ...(previousEncoding === undefined ? {} : { previousEncoding }),
        ...(previousSymlink === undefined ? {} : { previousSymlink }),
        ...(name === "delete" ? { deleted: true } : {}),
      });
    }
    return result;
  }

  return await tools.dispatch(name, input, (nestedName, nestedInput, write) =>
    dispatchCompactionTool(nestedName, nestedInput, { ...tools, dispatch: write }, workspaceDir, state));
}

class CompactionDriver {
  readonly state: ToolLoopState;

  constructor(
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

  toolUses(turn: GenerateResponse): ToolUseEvent[] {
    return turn.content_blocks.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
  }

  beforeTurn(): void {
    this.emit({
      type: "phase", rid: null,
      phase: `compacting round ${String(this.state.toolRounds + 1)}`, model: null,
    });
  }

  async onTurn(resp: GenerateResponse): Promise<void> {
    if (hitTokenCeiling(resp.finish_reason)) {
      this.state.truncatedTurns = (this.state.truncatedTurns ?? 0) + 1;
    }
    pushAssistantTurn(this.request, resp);
    this.state.pendingTurn = resp;
    this.state.pendingResults = [];
    this.state.pendingUseCount = 0;
    await this.persist(this.state, this.request);
  }

  async runTool(use: ToolUseEvent): Promise<ContentBlock> {
    const turn = required(this.state.pendingTurn);
    const uses = this.toolUses(turn);
    const index = uses.findIndex((candidate) => candidate.id === use.id);
    if (index < 0) throw new Error("Compaction tool was not checkpointed before execution");
    if (index > this.state.pendingUseCount) throw new Error("Compaction tools must execute in checkpoint order");
    const previous = this.state.pendingResults[index];
    if (previous !== undefined) {
      return { type: "tool_result", tool_use_id: use.id, content: previous.content ?? previous.output, is_error: previous.isError };
    }
    this.state.toolsCalled.push(use.name);
    this.emit({
      type: "tool_call", rid: null, tool_id: use.id, tool_name: use.name,
      input: use.input, subagent: COMPACTION_SUBAGENT, task_id: null,
    });
    const result = await dispatchCompactionTool(use.name, use.input, this.tools, this.workspaceDir, this.state);
    this.emit({
      type: "tool_result", rid: null, tool_id: use.id, tool_name: use.name,
      output: result.output, is_error: result.isError, subagent: COMPACTION_SUBAGENT, task_id: null,
    });
    this.state.pendingResults.push(result);
    this.state.pendingUseCount = index + 1;
    await this.persist(this.state, this.request);
    return { type: "tool_result", tool_use_id: use.id, content: result.content ?? result.output, is_error: result.isError };
  }

  async finishTools(): Promise<void> {
    const turn = this.state.pendingTurn;
    if (turn === undefined) return;
    const uses = this.toolUses(turn);
    if (this.state.pendingUseCount !== uses.length) return;
    const content: ContentBlock[] = this.state.pendingResults.map((result, index) => ({
      type: "tool_result", tool_use_id: required(uses[index]).id,
      content: result.content ?? result.output, is_error: result.isError,
    }));
    if (this.state.pendingNote !== undefined) content.push({ type: "text", text: this.state.pendingNote });
    delete this.state.pendingNote;
    this.request.messages.push({ role: "user", content });
    this.state.toolRounds += 1;
    delete this.state.pendingTurn;
    this.state.pendingResults = [];
    this.state.pendingUseCount = 0;
    await this.persist(this.state, this.request);
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
  const driver = new CompactionDriver(request, tools, workspaceDir, dryRun, restored, persist, emit);
  const startedRounds = driver.state.toolRounds;
  const pending = driver.state.pendingTurn;
  if (pending !== undefined) {
    const uses = driver.toolUses(pending);
    if (uses.length === 0 || pending.finish_reason !== "tool_use") return driver.state;
    if (maxToolIterations === 0) {
      driver.state.maxRoundsHit = true;
      return driver.state;
    }
    for (const use of uses) await driver.runTool(use);
    await driver.finishTools();
  }
  const spent = driver.state.toolRounds - startedRounds;
  if (maxToolIterations !== undefined && spent > 0 && spent >= maxToolIterations) {
    driver.state.maxRoundsHit = true;
    return driver.state;
  }
  deliverPendingNote(request, driver.state);
  const phase: ToolPhase = {
    messages: [],
    parallel: false,
    beforeTurn: () => driver.beforeTurn(),
    onTurn: (turn) => driver.onTurn(turn),
    runTool: (use) => driver.runTool(use),
    recordTurn: async (role) => {
      if (role === "user") await driver.finishTools();
    },
  };
  const response = await llm.run({
    ...request,
    messages: [...request.messages],
    ...(maxToolIterations === undefined ? {} : { max_tool_iterations: maxToolIterations - spent }),
  }, phase, { capBehavior: "stop_after_dispatch" });
  if (response.finish_reason.startsWith("error")) {
    throw CompactionError.llm(`Model run ended with ${response.finish_reason}`);
  }
  driver.state.maxRoundsHit = response.finish_reason === "tool_use" &&
    maxToolIterations !== undefined && driver.state.toolRounds - startedRounds >= maxToolIterations;
  return driver.state;
}

function deliverPendingNote(request: SidecarRequest, state: ToolLoopState): void {
  const note = state.pendingNote;
  if (note === undefined) return;
  delete state.pendingNote;
  const last = request.messages.at(-1);
  if (last?.role === "user") last.content.push({ type: "text", text: note });
  else request.messages.push({ role: "user", content: [{ type: "text", text: note }] });
}

async function writeWorkspaceFile(path: string, content: string | Uint8Array): Promise<void> {
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
    if (write.superseded === true) continue;
    if (write.previousState !== undefined) {
      try {
        await restoreWorkspaceEntry(write.resolvedPath, write.previousState);
      } catch (error) {
        shoreLog.warn(`shore: rollback failed to restore ${write.resolvedPath}: ${String(error)}`);
      }
      continue;
    }
    if (write.previousSymlink !== undefined) {
      try {
        await mkdir(dirname(write.resolvedPath), { recursive: true });
        await symlink(write.previousSymlink, write.resolvedPath);
      } catch (e) {
        shoreLog.warn(`shore: rollback failed to restore compaction symlink at ${write.resolvedPath}: ${String(e)}`);
      }
      continue;
    }
    if (write.previousContent !== undefined) {
      try {
        const content = write.previousEncoding === "base64"
          ? Buffer.from(write.previousContent, "base64") : write.previousContent;
        await writeWorkspaceFile(write.resolvedPath, content);
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

function compactThread(opts: Pick<CompactOptions, "thread">): string {
  return opts.thread ?? MAIN_THREAD;
}

export interface CompactOptions {
  conversationId: string;
  plan: ArchivalPlan;
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
  chatRequest: SidecarRequest;
  dataDir?: string;
  tools: CompactionTools;
  maxToolIterations?: number;
  resumable?: boolean;
  coverage?: CompactionCoverage;
  emit?: FrameSink;
  signal?: AbortSignal;
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
  const { plan, tools } = opts;
  void settings;
  const messages = [...plan.conversation];
  const splitAt = plan.splitAt;
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
  const recovered = await recoverArchivedPass(opts, plan);
  if (recovered !== undefined) return recovered;

  let checkpoint = await resolveCheckpoint(opts, compactedTurns, initialRequest, workspaceHead);
  checkpoint.request.api_key = initialRequest.api_key;
  if (opts.coverage === undefined) delete checkpoint.coverageClaim;
  else checkpoint.coverageClaim = opts.coverage.claim;
  if (checkpoint.state === "paused" && checkpoint.resumeAt !== undefined) {
    if (Date.parse(checkpoint.resumeAt) > Date.now()) return pausedOutcome(opts, checkpoint);
  }
  if (checkpointSourceIsCompatible(checkpoint, plan.sourceContent)) {
    await adoptOutsideEdits(opts, checkpoint);
  } else {
    shoreLog.warn(
      `shore: discarding compaction checkpoint ${checkpoint.id} for ${opts.charName}: the active ` +
        `conversation was rewritten under it, so the pass can never resume; summarizing from the ` +
        `current conversation instead. The memory it already wrote stays on disk`,
    );
    await clearCheckpoint(opts);
    checkpoint = newCompactionCheckpoint(
      opts.charName,
      plan.sourceContent,
      splitAt,
      compactedTurns,
      initialRequest,
      opts.dryRun,
      workspaceHead,
    );
    checkpoint.request.api_key = initialRequest.api_key;
    if (opts.coverage !== undefined) checkpoint.coverageClaim = opts.coverage.claim;
  }
  checkpoint.state = "running";
  delete checkpoint.pauseReason;
  delete checkpoint.pauseDetail;
  delete checkpoint.resumeAt;
  await persistCheckpoint(opts, checkpoint);

  const request = checkpoint.request;
  let state: ToolLoopState;
  try {
    opts.signal?.throwIfAborted();
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
    opts.signal?.throwIfAborted();
  } catch (e) {
    return await pauseCompaction(opts, checkpoint, e);
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
      partialWrites: changedFilePaths(state.writesApplied),
    };
  }

  const commit = openArchivalCommit(plan, await currentActiveContent(opts));
  if (commit === undefined) {
    checkpoint.state = "paused";
    checkpoint.pauseReason = "source_conflict";
    await persistCheckpoint(opts, checkpoint);
    return pausedOutcome(opts, checkpoint);
  }
  const { retained, retainedTurns } = commit;
  const archivedCount = plan.splitAt;
  const archivedTurns = opts.resumable === true ? checkpoint.compactedTurns : compactedTurns;
  const memoryAfter = await tools.gitHead?.(workspaceDir);
  if (opts.signal?.aborted === true) return await pauseCompaction(opts, checkpoint, opts.signal.reason);

  const newConversationId = await archiveCompactPrefix(
    opts.conversationMgr,
    opts.conversationId,
    retained,
    commit.liveContent,
    state.writesApplied,
    workspaceDir,
    opts.charName,
    tools,
    checkpoint.id,
    checkpoint.memoryBefore,
    memoryAfter,
    opts.coverage?.claim,
  );
  await clearCheckpoint(opts);

  const markdownPaths = changedFilePaths(state.writesApplied);

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

export function backgroundCoverageNotice(coverage: CompactionCoverage): string | undefined {
  if (coverage.background === 0 || coverage.fresh === 0) return undefined;
  return (
    `\n\nBackground: the oldest ${String(coverage.background)} message(s) of the range being ` +
    `archived were already written to memory from another branch of this conversation. They are ` +
    `here so the newer material reads in context — do not write them up again. Write memory for ` +
    `the ${String(coverage.fresh)} message(s) that follow them, which nothing has recorded yet.`
  );
}

function buildCompactLlmRequest(opts: CompactOptions): SidecarRequest {
  const notice =
    opts.coverage === undefined ? undefined : backgroundCoverageNotice(opts.coverage);
  const finalMsg =
    buildFinalMessage(opts.promptTemplate, opts.charName, opts.userName) + (notice ?? "");
  return opts.llm.buildInitialRequest(finalMsg, opts.chatRequest);
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
  coverageClaim?: string,
): Promise<string> {
  try {
    return await conversationMgr.archiveAndRetain(conversationId, {
      keepLastN: retained,
      activeContent,
      ...(operationId === undefined ? {} : { operationId }),
      ...(memoryBefore === undefined ? {} : { memoryBefore }),
      ...(memoryAfter === undefined ? {} : { memoryAfter }),
      ...(coverageClaim === undefined ? {} : { coverageClaim }),
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

async function recoverArchivedPass(
  opts: CompactOptions,
  plan: ArchivalPlan,
): Promise<CompactionOutcome | undefined> {
  const prior = plan.checkpoint;
  if (opts.resumable !== true || opts.dataDir === undefined || prior === undefined) return undefined;
  const archived = await hasCompactionOperation(
    conversationRef(opts.dataDir, opts.charName, compactThread(opts), false),
    prior.id,
  );
  if (!archived) return undefined;
  const liveContent = await currentActiveContent(opts);
  if (checkpointSourceIsCompatible(prior, liveContent)) return undefined;

  const liveLines = rustLines(liveContent).filter((line) => rustTrim(line) !== "");
  const markdownPaths = changedFilePaths(prior.loop.writesApplied);
  await clearCheckpoint(opts);
  return {
    kind: "compacted",
    memoryFilesWritten: markdownPaths,
    conversationId: opts.conversationId,
    newConversationId: prior.id,
    messageCount: prior.splitAt,
    compactedTurns: prior.compactedTurns,
    retainedCount: liveLines.length,
    retainedTurns: retainedTurnCount(liveContent, 0),
    markdownPaths,
    toolRounds: prior.loop.toolRounds,
    toolsCalled: prior.loop.toolsCalled,
  };
}

async function resolveCheckpoint(
  opts: CompactOptions,
  compactedTurns: number,
  request: SidecarRequest,
  workspaceHead: string | undefined,
): Promise<CompactionCheckpoint> {
  const { plan } = opts;
  if (opts.resumable === true && opts.dataDir !== undefined) {
    const abandoned = plan.checkpoint;
    const sameModel = abandoned !== undefined &&
      abandoned.request.sdk === request.sdk &&
      abandoned.request.model === request.model &&
      abandoned.request.provider_key === request.provider_key &&
      abandoned.request.base_url === request.base_url;
    if (plan.resumed && abandoned !== undefined && sameModel) return abandoned;
    if (abandoned !== undefined) {
      const reason = sameModel
        ? `the pass was restarted or its archival range changed (${String(abandoned.splitAt)} -> ${String(plan.splitAt)})`
        : `the model changed (${abandoned.request.sdk}:${abandoned.request.model} -> ${request.sdk}:${request.model})`;
      shoreLog.warn(
        `shore: starting a fresh compaction for ${opts.charName}: ${reason}. ` +
          `The memory checkpoint ${abandoned.id} already wrote ` +
          `(${JSON.stringify(abandoned.loop.writesApplied.map((w) => w.displayPath))}) stays on disk`,
      );
    }
    const abandonedBefore = abandoned === undefined ? undefined : await discardCheckpoint(opts);
    return newCompactionCheckpoint(
      opts.charName,
      plan.sourceContent,
      plan.splitAt,
      compactedTurns,
      request,
      opts.dryRun,
      abandonedBefore ?? abandoned?.memoryBefore ?? workspaceHead,
    );
  }
  return newCompactionCheckpoint(
    opts.charName,
    plan.sourceContent,
    plan.splitAt,
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

async function adoptOutsideEdits(opts: CompactOptions, checkpoint: CompactionCheckpoint): Promise<void> {
  const latest = new Map<string, AppliedCompactionWrite>();
  for (const write of checkpoint.loop.writesApplied) latest.set(write.resolvedPath, write);
  const changed: string[] = [];
  for (const write of latest.values()) {
    if (await stillAsWritten(write)) continue;
    changed.push(write.displayPath);
    for (const earlier of checkpoint.loop.writesApplied) {
      if (earlier.resolvedPath === write.resolvedPath) earlier.superseded = true;
    }
    write.resultingState = await workspaceEntry(write.resolvedPath);
  }
  if (changed.length === 0) return;
  shoreLog.info(
    `shore: compaction checkpoint ${checkpoint.id} for ${opts.charName} resumes over outside edits ` +
      `to ${JSON.stringify(changed)}; the pass keeps them and will not roll them back`,
  );
  const note =
    `[While this pass was paused, ${changed.join(", ")} changed outside it. The current ` +
    `contents are authoritative: read them again before editing, and keep those changes.]`;
  const earlier = checkpoint.loop.pendingNote;
  checkpoint.loop.pendingNote = earlier === undefined ? note : `${earlier}\n${note}`;
}

async function stillAsWritten(write: AppliedCompactionWrite): Promise<boolean> {
  if (write.resultingState !== undefined) {
    return sameWorkspaceEntry(await workspaceEntry(write.resolvedPath), write.resultingState);
  }
  if (write.deleted === true) {
    try {
      await lstat(write.resolvedPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    }
    return false;
  }
  if (write.resultingContent === undefined) return true;
  try {
    return (await readFile(write.resolvedPath, "utf8")) === write.resultingContent;
  } catch {
    return false;
  }
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
    messageCount: opts.plan.splitAt,
    compactedTurns: checkpoint.compactedTurns,
    toolRounds: checkpoint.loop.toolRounds,
    toolsCalled: checkpoint.loop.toolsCalled,
    reason: reasonOverride ?? checkpoint.pauseReason ?? "provider",
    ...(checkpoint.pauseDetail === undefined ? {} : { detail: checkpoint.pauseDetail }),
    ...(checkpoint.resumeAt === undefined ? {} : { resumeAt: checkpoint.resumeAt }),
  };
}

async function pauseCompaction(opts: CompactOptions, checkpoint: CompactionCheckpoint, error: unknown): Promise<CompactionOutcome> {
  if (opts.resumable !== true) throw error;
  checkpoint.state = "paused";
  checkpoint.pauseReason = pauseReason(error);
  const resetAt = budgetResetAt(error);
  if (resetAt === undefined) delete checkpoint.resumeAt;
  else checkpoint.resumeAt = resetAt;
  await persistCheckpoint(opts, checkpoint);
  return pausedOutcome(opts, checkpoint, error instanceof Error ? error.message : String(error));
}

function pauseReason(e: unknown): CompactionPauseReason {
  return budgetStopIn(e) === undefined ? "provider" : "budget";
}

function budgetResetAt(e: unknown): string | undefined {
  return budgetStopIn(e)?.resetAt;
}

async function currentActiveContent(opts: CompactOptions): Promise<string> {
  if (opts.resumable !== true || opts.dataDir === undefined) return opts.plan.sourceContent;
  try {
    return readDurable(threadFile(opts.dataDir, opts.charName, compactThread(opts), "active.jsonl"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return opts.plan.sourceContent;
    throw e;
  }
}
