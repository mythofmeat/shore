import { withConversation } from "../../engine/lifecycle.ts";
import { threadDataDir } from "../../config/dirs.ts";
import { required } from "../../util/required.ts";

import { shoreLog } from "../../log.ts";

import { join } from "node:path";

import type { LoadedConfig } from "../../config/loader.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../../engine/history_store.ts";
import { conversationRef } from "../../engine/segments.ts";
import { loadCharacterConfig } from "../../config/loader.ts";
import { resolvePromptTemplate } from "../../config/dirs.ts";
import { MAIN_THREAD, archiveKey, characterDataDir, characterMemoryDir } from "../../config/dirs.ts";
import { homeThreadOf, threadChatModel } from "../../engine/threads.ts";
import { resolveDisplayName, toolGrants } from "../../config/app.ts";
import { resolveBackgroundModel, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { configView } from "../../config/preferences.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import { toRequestModel } from "../../config/models.ts";
import type { FrameSink } from "../../llm/stream.ts";
import type { SidecarRequest, ToolDefinition } from "../../llm/types.ts";
import type { Message } from "../../engine/types.ts";
import type { LastRequestCache } from "../../cache/last_request.ts";
import type { RebuildDeps } from "../../cache/rebuild.ts";
import { buildChatShapeRequestFromDisk } from "../../handler/context.ts";
import { buildToolContext, credentialEntry, type ToolContextDeps } from "../../handler/tool_context.ts";
import { toolLimitsFrom, type ToolContext } from "../../tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../../tools/execute.ts";
import { imageLimitsFor, type ImageLimits } from "../../llm/prepare_images.ts";
import { schemasFrom } from "../../tools/validate.ts";
import {
  ensureWorkspaceGitRepoBestEffort,
  gitCommitAll,
  gitHead,
  gitPushWorkspaceBestEffort,
} from "../../tools/workspace.ts";
import { MarkdownMemoryStore } from "../markdown_store.ts";
import { CharacterWorkspace, characterWorkspace } from "../../tools/character_workspace.ts";
import { applyDeferredEdits, queueDeferredEdit } from "../deferred_edits.ts";
import type { CompactionRunner } from "../../handler/turn.ts";
import { conversationManager, hasCompactionOperation, segmentCount } from "./archive.ts";
import { type CompactionCompletion, handleCompactionOutcome, loadMessagesForCompaction, pushAfterCompaction } from "./background.ts";
import { RealCompactionLlm, type RealCompactionLlmOptions } from "./llm.ts";
import { compact, compactSegment, countTurns, tryBeginCompaction, type CompactionRunGuard } from "./manager.ts";
import { startPass } from "./activity.ts";
import type { CompactionTrigger } from "../../protocol/CompactionTrigger.ts";
import { DEFAULT_COMPACT_PROMPT } from "./prompts.ts";
import { renderToolValue } from "../../tools/media.ts";
import {
  CompactionError,
  CompactionPaused,
  tagCompactionFrames,
  type CompactionCoverage,
  type CompactionOutcome,
  type CompactionTools,
} from "./types.ts";
import {
  claimUncovered,
  coverageIsPartial,
  coverageIsRedundant,
  withCoverageStore,
} from "../coverage.ts";
import {
  compactionHeld,
  loadCompactionCheckpoint,
  removeCompactionCheckpoint,
  type CompactionCheckpoint,
} from "./checkpoint.ts";
import {
  openArchivalCommit,
  readLiveSource,
  resolveArchivalPlan,
  type ArchivalPlan,
} from "./plan.ts";

export interface CompactionRunDeps {
  env?: NodeJS.ProcessEnv;
  config: LoadedConfig;
  generate: RealCompactionLlmOptions["generate"];
  notify?: (title: string, body: string) => void;
  tools?: ToolContextDeps;
  now?: () => string;
  newId?: () => string;
  emit?: FrameSink;
  signal?: AbortSignal;
}

export interface CompactionRunOptions {
  thread?: string;
  dryRun?: boolean;
  keepTurnsOverride?: number;
  restart?: boolean;
  retainTrailingAutonomous?: boolean;
  trigger?: CompactionTrigger;
}

export async function runCompaction(
  character: string,
  deps: CompactionRunDeps,
  trigger: Exclude<CompactionTrigger, "manual">,
  options: Omit<CompactionRunOptions, "trigger"> = {},
): Promise<CompactionCompletion> {
  const outcome = await runCompactionPass(character, deps, { ...options, trigger });
  if (outcome === undefined) return { kind: "skipped", reason: "empty_or_changed" };
  if (outcome.kind === "paused") {
    const why = outcome.detail ?? outcome.reason;
    if (outcome.held !== true) deps.notify?.(`Shore - ${character}`, pauseNotice(outcome.toolRounds, outcome.reason, why));
    throw new CompactionPaused(outcome.checkpointId, why, outcome.resumeAt);
  }
  return handleCompactionOutcome(character, deps.notify ?? (() => {}), outcome);
}

function pauseNotice(rounds: number, reason: string, why: string): string {
  if (reason !== "refusal") return `Compaction paused after ${rounds} rounds (${why}); conversation kept`;
  return `The model refused to go on with compaction after ${rounds} rounds; conversation kept. ` +
    "Automatic compaction is on hold: see why with `shore status`, retry with `shore compact`";
}

export async function rotateWithoutMemoryWrite(
  character: string,
  thread: string,
  deps: CompactionRunDeps,
  effective: LoadedConfig,
  plan: ArchivalPlan,
  conversationDir: string,
  options: CompactionRunOptions,
  note = "archive-only rotation; automatic memory writes disabled",
): Promise<CompactionOutcome | undefined> {
  const dryRun = options.dryRun ?? false;
  const dataDir = effective.dirs.data;
  const commit = openArchivalCommit(
    plan,
    dryRun
      ? plan.sourceContent
      : await readLiveSource(dataDir, character, thread, plan.sourceContent),
  );
  if (commit === undefined) {
    shoreLog.warn(
      `shore: not rotating ${character}/${thread}: the conversation was rewritten under the ` +
        `plan that resolved this range, so archiving it would commit a range nobody resolved`,
    );
    return undefined;
  }

  if (!dryRun) {
    await conversationManager(
      conversationDir,
      {
        dbPath: join(dataDir, HISTORY_DB_FILE),
        archiveKey: archiveKey(character, thread),
      },
      deps.now ?? (() => new Date().toISOString()),
      deps.newId ?? (() => crypto.randomUUID()),
    ).archiveAndRetain("archive-only", {
      keepLastN: commit.retained,
      activeContent: commit.liveContent,
      note,
    });
  }

  return {
    kind: "rotated",
    conversationId: character,
    dryRun,
    messageCount: plan.splitAt + commit.retained,
    archivedMessages: plan.splitAt,
    compactedTurns: countTurns([...plan.conversation].slice(0, plan.splitAt)),
    retainedCount: commit.retained,
    retainedTurns: commit.retainedTurns,
  };
}


export async function runCompactionPass(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<CompactionOutcome | undefined> {
  deps.signal?.throwIfAborted();
  const dataDir = deps.config.dirs.data;

  const thread = options.thread ?? (await homeThreadOf(dataDir, character));

  return await withConversation(threadDataDir(dataDir, character, thread), "update", async (scope) => {
    deps.signal?.throwIfAborted();
    const guard = tryBeginCompaction(dataDir, character);
    if (guard === undefined) throw CompactionError.busy(character);

    const trigger = options.trigger ?? "manual";
    if (trigger !== "manual") {
      const held = await compactionHeld(dataDir, character, thread);
      if (held !== undefined) {
        guard.release();
        return heldOutcome(character, held);
      }
    }
    const pass = startPass(dataDir, { character, thread, trigger, startedAt: Date.now() }, deps.emit, stoppedWith(deps.signal, scope));
    try {
      const outcome = await passUnderGuard(character, { ...deps, emit: pass.emit, signal: pass.signal }, { ...options, trigger }, thread, guard);
      pass.finish(outcome);
      return outcome;
    } catch (e) {
      pass.fail(e);
      throw e;
    }
  });
}

function stoppedWith(signal: AbortSignal | undefined, scope: AbortSignal): AbortSignal {
  const turn = new AbortController();
  const stop = () => turn.abort(new DOMException("the chat turn it ran after was cancelled", "AbortError"));
  if (scope.aborted) stop();
  else scope.addEventListener("abort", stop, { once: true });
  return signal === undefined ? turn.signal : AbortSignal.any([signal, turn.signal]);
}

function heldOutcome(character: string, checkpoint: CompactionCheckpoint): CompactionOutcome {
  return {
    kind: "paused",
    conversationId: character,
    checkpointId: checkpoint.id,
    messageCount: checkpoint.splitAt,
    compactedTurns: checkpoint.compactedTurns,
    toolRounds: checkpoint.loop.toolRounds,
    toolsCalled: checkpoint.loop.toolsCalled,
    reason: "refusal",
    ...(checkpoint.pauseDetail === undefined ? {} : { detail: checkpoint.pauseDetail }),
    held: true,
  };
}

async function passUnderGuard(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions,
  thread: string,
  guard: CompactionRunGuard,
): Promise<CompactionOutcome | undefined> {
  const dataDir = deps.config.dirs.data;
  let coverage: CompactionCoverage | undefined;
  try {
    const loaded = await loadMessagesForCompaction(dataDir, character, thread);
    if (loaded.messages.length === 0) return undefined;

    const effective = effectiveConfig(character, deps.config);
    const compaction = effective.app.memory.compaction;
    const plan = await resolveArchivalPlan(dataDir, character, thread, loaded, {
      keepRecentTurns: compaction.keep_recent_turns,
      ...(options.keepTurnsOverride === undefined
        ? {}
        : { keepTurnsOverride: options.keepTurnsOverride }),
      retainTrailingAutonomous: options.retainTrailingAutonomous ?? false,
      restart: options.restart ?? false,
    });
    if (plan === undefined) throw CompactionError.insufficientMessages();

    if (!compaction.write_memory) {
      return await rotateWithoutMemoryWrite(
        character,
        thread,
        deps,
        effective,
        plan,
        loaded.conversationDir,
        options,
      );
    }

    const planned = planCompactionCoverage(character, effective, plan, options);
    if (planned.blocked === true) {
      throw new CompactionError(
        "busy",
        `Compaction for ${character}/${thread} is waiting for another pass's memory claim ` +
          `to finish or expire; conversation kept`,
      );
    }
    coverage = planned.coverage;
    if (planned.redundant) {
      if (plan.checkpoint !== undefined) {
        const settled = await reconcileAbandonedPass(dataDir, character, thread, plan.checkpoint.id);
        if (settled) return undefined;
      }
      shoreLog.info(
        `shore: the whole archival range for ${character}/${thread} was already written to ` +
          `memory from another branch; rotating it into the archive without a second pass`,
      );
      return await rotateWithoutMemoryWrite(
        character,
        thread,
        deps,
        effective,
        plan,
        loaded.conversationDir,
        options,
        "archive-only rotation; this range was already covered by another branch's compaction",
      );
    }

    const chatRequest = await resolveChatRequest(character, thread, loaded.store.messages(), effective,
      deps.tools?.mcpToolDefs?.(toolGrants(effective.app.tools)) ?? [], deps.env);
    const resolved = await resolveDeps(character, deps, effective, thread,
      [...loaded.store.messages()], chatRequest.tools, options.dryRun ?? false);

    const outcome = await compact(
      {
        conversationId: character,
        plan,
        promptTemplate: resolved.promptTemplate,
        charName: character,
        thread,
        userName: resolved.displayName,
        llm: resolved.llm,
        conversationMgr: conversationManager(
          loaded.conversationDir,
          {
            dbPath: join(dataDir, HISTORY_DB_FILE),
            archiveKey: archiveKey(character, thread),
          },
          deps.now ?? (() => new Date().toISOString()),
          deps.newId ?? (() => crypto.randomUUID()),
        ),
        ...(resolved.markdownStore === undefined ? {} : { markdownStore: resolved.markdownStore }),
        dryRun: options.dryRun ?? false,
        restart: options.restart ?? false,
        ...(options.keepTurnsOverride === undefined
          ? {}
          : { keepTurnsOverride: options.keepTurnsOverride }),
        chatRequest,
        dataDir,
        resumable: true,
        foreground: options.trigger === "manual",
        tools: resolved.tools,
        ...(planned.coverage === undefined ? {} : { coverage: planned.coverage }),
        ...(resolved.maxToolIterations === undefined
          ? {}
          : { maxToolIterations: resolved.maxToolIterations }),
        ...(deps.emit === undefined ? {} : { emit: tagCompactionFrames(deps.emit) }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      },
      { keepRecentTurns: resolved.effective.app.memory.compaction.keep_recent_turns },
    );

    await pushAfterCompaction(resolved.effective.app.memory.git_push, outcome, async () => {
      await gitPushWorkspaceBestEffort(resolved.tools.workspace ?? resolved.tools.workspaceDir);
    });

    return outcome;
  } finally {
    try {
      if (coverage !== undefined) {
        const checkpoint = await loadCompactionCheckpoint(dataDir, character, thread);
        if (checkpoint?.coverageClaim !== coverage.claim) {
          releaseCompactionCoverage(dataDir, character, coverage.claim);
        }
      }
    } catch (e) {
      shoreLog.warn(`shore: failed to release uncheckpointed compaction claim for ${character}/${thread}: ${String(e)}`);
    } finally {
      guard.release();
    }
  }
}

export async function runSegmentCompactionPass(
  character: string,
  deps: CompactionRunDeps,
  options: { segment: number; thread?: string },
): Promise<CompactionOutcome> {
  deps.signal?.throwIfAborted();
  const dataDir = deps.config.dirs.data;
  const thread = options.thread ?? (await homeThreadOf(dataDir, character));
  const archived = readArchivedSegment(dataDir, character, thread, options.segment);
  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) throw CompactionError.busy(character);
  const pass = startPass(dataDir, { character, thread, trigger: "manual", startedAt: Date.now() }, deps.emit, deps.signal);
  try {
    const outcome = await segmentPass(character, { ...deps, emit: pass.emit, signal: pass.signal }, thread, options.segment, archived);
    pass.finish(outcome);
    return outcome;
  } catch (e) {
    pass.fail(e);
    throw e;
  } finally {
    guard.release();
  }
}

function readArchivedSegment(
  dataDir: string,
  character: string,
  thread: string,
  segment: number,
): { messages: Message[]; priorContext: boolean } {
  const key = archiveKey(character, thread);
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    const entries = store.entries(key);
    if (!entries.some((entry) => entry.idx === segment)) {
      const where = thread === MAIN_THREAD ? character : `${character} thread ${thread}`;
      throw new CompactionError("not_found", `segment ${String(segment)} not found for ${where}`);
    }
    const messages = store.readSegment(key, segment);
    if (messages.length === 0) throw CompactionError.insufficientMessages();
    return { messages, priorContext: entries.some((entry) => entry.idx < segment) };
  } finally {
    store.close();
  }
}

async function segmentPass(
  character: string,
  deps: CompactionRunDeps,
  thread: string,
  segment: number,
  archived: { messages: Message[]; priorContext: boolean },
): Promise<CompactionOutcome> {
  const effective = effectiveConfig(character, deps.config);
  if (!effective.app.memory.compaction.write_memory) {
    throw CompactionError.llm("memory writes are turned off (compaction.write_memory = false)");
  }
  const chatRequest = await resolveChatRequest(character, thread, archived.messages, effective,
    deps.tools?.mcpToolDefs?.(toolGrants(effective.app.tools)) ?? [], deps.env, archived.priorContext);
  const { scheduleNextWake: _unscheduled, ...tools } = deps.tools ?? {};
  const resolved = await resolveDeps(character, { ...deps, tools }, effective, thread, archived.messages, chatRequest.tools, false);
  const outcome = await compactSegment({
    segment,
    messages: archived.messages,
    promptTemplate: resolved.promptTemplate,
    charName: character,
    userName: resolved.displayName,
    llm: resolved.llm,
    ...(resolved.markdownStore === undefined ? {} : { markdownStore: resolved.markdownStore }),
    chatRequest,
    tools: resolved.tools,
    ...(resolved.maxToolIterations === undefined ? {} : { maxToolIterations: resolved.maxToolIterations }),
    ...(deps.emit === undefined ? {} : { emit: tagCompactionFrames(deps.emit) }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  await pushAfterCompaction(resolved.effective.app.memory.git_push, outcome, async () => {
    await gitPushWorkspaceBestEffort(resolved.tools.workspace ?? resolved.tools.workspaceDir);
  });
  return outcome;
}

interface ResolvedDeps {
  effective: LoadedConfig;
  promptTemplate: string;
  displayName: string;
  llm: RealCompactionLlm;
  markdownStore: MarkdownMemoryStore | undefined;
  tools: CompactionTools;
  maxToolIterations: number | undefined;
}

interface PlannedCoverage {
  redundant: boolean;
  blocked?: boolean;
  coverage?: CompactionCoverage;
}

export function planCompactionCoverage(
  character: string,
  effective: LoadedConfig,
  plan: ArchivalPlan,
  options: CompactionRunOptions,
): PlannedCoverage {
  if (options.dryRun === true || plan.archival.length === 0) return { redundant: false };

  const dbPath = join(effective.dirs.data, HISTORY_DB_FILE);
  const resumeClaim = plan.resumed ? plan.checkpoint?.coverageClaim : undefined;
  const claimed = withCoverageStore(dbPath, (store) => {
    if (!plan.resumed && plan.checkpoint?.coverageClaim !== undefined) {
      store.releaseMemoryCoverage(character, "compaction", plan.checkpoint.coverageClaim);
    }
    return claimUncovered(store, character, "compaction", plan.archival, {
      contiguous: true,
      ...(resumeClaim === undefined ? {} : { claim: resumeClaim }),
    });
  });

  if (coverageIsRedundant(claimed)) return { redundant: true };
  if (coverageIsPartial(claimed) || (claimed.pending === 0 && claimed.unversioned === 0)) {
    withCoverageStore(dbPath, (store) => {
      store.releaseMemoryCoverage(character, "compaction", claimed.claim);
    });
    return { redundant: false, blocked: true };
  }
  return {
    redundant: false,
    coverage: {
      claim: claimed.claim,
      unit: claimed.unit,
      claimed: claimed.claimed.length,
      background: claimed.backgroundMessages,
      fresh: plan.archival.length - claimed.backgroundMessages,
    },
  };
}

async function reconcileAbandonedPass(
  dataDir: string,
  character: string,
  thread: string,
  checkpointId: string,
): Promise<boolean> {
  const archived = await hasCompactionOperation(
    conversationRef(dataDir, character, thread, false),
    checkpointId,
  );
  await removeCompactionCheckpoint(dataDir, character, thread);
  shoreLog.warn(
    `shore: discarding compaction checkpoint ${checkpointId} for ${character}/${thread}: ` +
      `another branch wrote up everything it was going to summarise. ` +
      (archived
        ? "Its turns were already archived, so there is nothing left to do"
        : "Its turns are rotated into the archive without a second memory pass") +
      ". The memory it already wrote stays on disk",
  );
  return archived;
}

export function releaseCompactionCoverage(
  dataDir: string,
  character: string,
  claim: string,
): void {
  withCoverageStore(join(dataDir, HISTORY_DB_FILE), (store) => {
    store.releaseMemoryCoverage(character, "compaction", claim);
  });
}

export function effectiveConfig(character: string, config: LoadedConfig): LoadedConfig {
  try {
    return loadCharacterConfig(config, character) ?? config;
  } catch (e) {
    shoreLog.warn(
      `shore: character config failed to load for ${character}; ` +
        `compacting under the global config: ${String(e)}`,
    );
    return config;
  }
}

async function resolveDeps(
  character: string,
  deps: CompactionRunDeps,
  effective: LoadedConfig,
  thread: string,
  conversation: readonly Message[],
  tools: readonly ToolDefinition[] | undefined,
  dryRun: boolean,
): Promise<ResolvedDeps> {
  const configDir = effective.dirs.config;
  const promptTemplate =
    resolvePromptTemplate(configDir, character, "compact.md") ?? DEFAULT_COMPACT_PROMPT;

  const threadModel = await threadChatModel(effective.dirs.data, character, thread);
  const model = resolveBackgroundModel(
    configView(effective), "compaction", character,
    (v, c, n, h) => findEffectiveModel(v, c, n, h),
    threadModel,
  );
  if (model === undefined) {
    throw CompactionError.llm("No model configured for background compaction");
  }

  let markdownStore: MarkdownMemoryStore | undefined;
  try {
    markdownStore = await MarkdownMemoryStore.open(
      characterMemoryDir(configDir, character, effective.dirs.workspace),
      characterWorkspace(effective, character),
    );
  } catch (e) {
    shoreLog.warn(`shore: markdown memory store unavailable for ${character}: ${String(e)}`);
  }

  const toolCtx = await buildToolContext(effective, effective.dirs.data, character, {
    ...deps.tools, thread, conversation, dryRun,
  });
  if (deps.signal !== undefined) toolCtx.signal = deps.signal;
  const entry = effective.providers.get(model.providerKey);
  const providerEntry = entry === undefined ? undefined : credentialEntry(entry);

  return {
    effective,
    promptTemplate,
    displayName: resolveDisplayName(effective.app.defaults),
    llm: new RealCompactionLlm({
      model: toRequestModel(model),
      character,
      generate: deps.generate,
      cacheDir: effective.dirs.cache,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(providerEntry === undefined ? {} : { providerEntry }),
      ...(deps.emit === undefined ? {} : { emit: tagCompactionFrames(deps.emit) }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }),
    markdownStore,
    tools: compactionTools(toolCtx, effective, tools, imageLimitsFor(model.sdk, model.modelId)),
    maxToolIterations: model.maxToolIterations,
  };
}

function compactionTools(
  ctx: ToolContext,
  config: LoadedConfig,
  tools: readonly ToolDefinition[] | undefined,
  imageLimits: ImageLimits,
): CompactionTools {
  const exec: ToolExecution = {
    sendDirect: () => {},
    ctx,
    limits: toolLimitsFrom(config.app.tools, config.app.subagents),
    imageLimits,
    now: () => new Date().toISOString(),
    newMessageId: () => `m_${crypto.randomUUID()}`,
    schemas: schemasFrom(tools),
  };
  const workspace = ctx.workspace ?? new CharacterWorkspace(ctx.workspaceDir);
  return {
    workspaceDir: ctx.workspaceDir,
    workspace,
    dispatch: async (name, input, trackNestedWrite) => {
      if (trackNestedWrite !== undefined) {
        ctx.trackWorkspaceWrite = async (nestedName, nestedInput, write) => {
          let value: unknown;
          const result = await trackNestedWrite(nestedName, nestedInput, () => renderToolOutcome(async () => {
            value = await write();
            return value;
          }));
          if (result.isError) throw new Error(result.output);
          return value;
        };
      }
      try {
        const run = await runToolUse(
          { id: `compaction_${crypto.randomUUID()}`, name, input },
          exec,
          [],
        );
        return { output: run.output, isError: run.isError, ...(run.block.type === "tool_result" ? { content: run.block.content } : {}) };
      } finally {
        delete ctx.trackWorkspaceWrite;
      }
    },
    deferEdit: async (path) => await queueDeferredEdit(ctx.characterDataDir, path, ctx.thread),
    ensureWorkspaceGitRepo: async (workspaceDir) => {
      await ensureWorkspaceGitRepoBestEffort(workspace.at(workspaceDir));
    },
    gitHead: async (workspaceDir) => await gitHead(workspace.at(workspaceDir)),
    gitCommitAll: async (workspaceDir, charName, message) =>
      await gitCommitAll(workspace.at(workspaceDir), charName, message),
  };
}

export async function renderToolOutcome(
  call: () => Promise<unknown>,
): Promise<{ output: string; isError: boolean }> {
  try {
    const value = await call();
    return { output: renderToolValue(value), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

async function resolveChatRequest(
  character: string,
  thread: string,
  messages: readonly Message[],
  effective: LoadedConfig,
  mcpToolDefs: readonly ToolDefinition[],
  env: NodeJS.ProcessEnv | undefined,
  priorContext?: boolean,
): Promise<SidecarRequest> {
  const chatModel = resolveChatModelForCharacter(
    configView(effective),
    character,
    (v, c, n, h) => findEffectiveModel(v, c, n, h),
    await threadChatModel(effective.dirs.data, character, thread),
  );
  if (chatModel === undefined) {
    throw CompactionError.llm("No chat model configured for compaction prefix rebuild");
  }

  const hasPriorContext = priorContext ??
    (await segmentCount(conversationRef(effective.dirs.data, character, thread, false))) > 0;
  const built = await buildChatShapeRequestFromDisk(
    character,
    characterDataDir(effective.dirs.data, character),
    effective,
    chatModel,
    [...messages],
    hasPriorContext,
    { thread, mcpToolDefs, ...(env === undefined ? {} : { env }) },
  );
  return built.request;
}

export function compactionRunner(
  deps: Omit<CompactionRunDeps, "config"> & {
    cache?: LastRequestCache;
    rebuild: RebuildDeps;
  },
): CompactionRunner {
  return {
    run: (character, config, thread) => {
      const { cache: _cache, rebuild: _rebuild, ...rest } = deps;
      return runCompaction(character, {
        ...rest,
        config,
      }, "turn", thread === undefined ? {} : { thread });
    },
    applyDeferredEdits: (charDataDir, workspace, thread) =>
      applyDeferredEdits(charDataDir, workspace, thread),
    ...(deps.cache === undefined
      ? {}
      : {
          repoint: async (character: string, config: LoadedConfig, thread?: string) => {
            if (thread !== undefined && thread !== await homeThreadOf(config.dirs.data, character)) return;
            required(deps.cache).invalidate(character, "compaction");
            await required(deps.cache).reprimeFromDisk(
              character,
              config.dirs.data,
              config,
              { ...deps.rebuild, ...(deps.env === undefined ? {} : { env: deps.env }) },
            );
          },
        }),
  };
}
