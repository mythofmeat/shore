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

const inFlight = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

export interface CompactionRunGuard {
  release(): void;
  [Symbol.dispose](): void;
}

export function characterDataDir(dataDir: string, character: string): string {
  return join(dataDir, character);
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

export function trailingAutonomousLen(messages: ConversationMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
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

interface ToolLoopState {
  writesApplied: AppliedCompactionWrite[];
  rejectedPaths: string[];
  toolsCalled: string[];
  dryRunPreviews: MemoryFileOp[];
  toolRounds: number;
  maxRoundsHit: boolean;
  dryRun: boolean;
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

export interface CompactionSettings {
  keepRecentTurns: number;
}

export interface CompactOptions {
  conversationId: string;
  messages: ConversationMessage[];
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
  chatRequest: SidecarRequest;
  dataDir?: string;
  tools: CompactionTools;
  maxToolIterations?: number;
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

async function queueMemoryIndexRefresh(
  memoryIndexUpdated: boolean,
  tools: CompactionTools,
  dataDir: string | undefined,
  charName: string,
): Promise<void> {
  if (!memoryIndexUpdated || tools.configDir !== "") return;
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
