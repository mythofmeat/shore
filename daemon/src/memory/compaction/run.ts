import { required } from "../../util/required.ts";

import { shoreLog } from "../../log.ts";

import { join } from "node:path";

import type { LoadedConfig } from "../../config/loader.ts";
import { HISTORY_DB_FILE } from "../../engine/history_store.ts";
import { conversationRef } from "../../engine/segments.ts";
import { loadCharacterConfig } from "../../config/loader.ts";
import { resolvePromptTemplate } from "../../config/dirs.ts";
import { archiveKey, characterDataDir, characterMemoryDir } from "../../config/dirs.ts";
import { homeThreadOf, threadChatModel } from "../../engine/threads.ts";
import { resolveDisplayName } from "../../config/app.ts";
import { resolveBackgroundModel, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { configView } from "../../config/preferences.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import { toRequestModel } from "../../config/models.ts";
import type { FrameSink } from "../../llm/stream.ts";
import type { SidecarRequest } from "../../llm/types.ts";
import type { LastRequestCache } from "../../cache/last_request.ts";
import type { RebuildDeps } from "../../cache/rebuild.ts";
import { buildChatShapeRequestFromDisk } from "../../handler/context.ts";
import { buildToolContext, credentialEntry, type ToolContextDeps } from "../../handler/tool_context.ts";
import { toolLimitsFrom, type ToolContext } from "../../tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../../tools/execute.ts";
import { BUILTIN_TOOL_SCHEMAS } from "../../tools/registry.ts";
import {
  ensureWorkspaceGitRepoBestEffort,
  gitCommitAll,
  gitHead,
  gitPushWorkspaceBestEffort,
} from "../../tools/workspace.ts";
import { MarkdownMemoryStore } from "../markdown_store.ts";
import { applyDeferredEdits, queueDeferredEdit } from "../deferred_edits.ts";
import type { CompactionRunner } from "../../handler/turn.ts";
import { conversationManager, hasCompactionOperation, segmentCount } from "./archive.ts";
import { handleCompactionOutcome, loadMessagesForCompaction, pushAfterCompaction } from "./background.ts";
import { RealCompactionLlm, type RealCompactionLlmOptions } from "./llm.ts";
import { compact, countTurns, tryBeginCompaction } from "./manager.ts";
import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM } from "./prompts.ts";
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
import { removeCompactionCheckpoint } from "./checkpoint.ts";
import {
  messagesFromJsonl,
  openArchivalCommit,
  resolveArchivalPlan,
  type ArchivalPlan,
} from "./plan.ts";

export interface CompactionRunDeps {
  config: LoadedConfig;
  generate: RealCompactionLlmOptions["generate"];
  notify?: (title: string, body: string) => void;
  tools?: Omit<ToolContextDeps, "runSubagent">;
  now?: () => string;
  newId?: () => string;
  emit?: FrameSink;
}

export interface CompactionRunOptions {
  thread?: string;
  dryRun?: boolean;
  keepTurnsOverride?: number;
  restart?: boolean;
  retainTrailingAutonomous?: boolean;
}

export async function runCompaction(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<number> {
  const outcome = await runCompactionPass(character, deps, options);
  if (outcome === undefined) return 0;
  if (outcome.kind === "paused") {
    deps.notify?.(
      `Shore — ${character}`,
      `Compaction paused after ${outcome.toolRounds} rounds (${outcome.reason}); conversation kept`,
    );
    throw new CompactionPaused(outcome.checkpointId, outcome.reason, outcome.resumeAt);
  }
  return handleCompactionOutcome(character, deps.notify ?? (() => {}), outcome);
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
  const commit = dryRun
    ? { liveContent: plan.sourceContent, retained: plan.messages.length - plan.splitAt }
    : await openArchivalCommit(dataDir, character, thread, plan);
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
      deps.now ?? (() => new Date().toISOString()),
      deps.newId ?? (() => crypto.randomUUID()),
      {
        dbPath: join(dataDir, HISTORY_DB_FILE),
        archiveKey: archiveKey(character, thread),
        retain: effective.app.memory.retain.enabled,
      },
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
    retainedTurns: countRetainedLines(commit.liveContent, plan.splitAt),
  };
}

function countRetainedLines(liveContent: string, splitAt: number): number {
  return countTurns(
    messagesFromJsonl(liveContent)
      .slice(splitAt)
      .map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        isToolResultOnly:
          message.role === "user" &&
          message.content_blocks.length > 0 &&
          message.content_blocks.every((block) => block.type === "tool_result"),
        isAutonomous: message.origin === "autonomous",
      })),
  );
}

export async function runCompactionPass(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<CompactionOutcome | undefined> {
  const dataDir = deps.config.dirs.data;

  const thread = options.thread ?? (await homeThreadOf(dataDir, character));

  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) throw CompactionError.busy(character);

  try {
    const loaded = await loadMessagesForCompaction(dataDir, character, thread);
    if (loaded.messages.length === 0) return undefined;

    const effective = effectiveConfig(character, deps.config);
    const compaction = effective.app.memory.compaction;
    const plan = await resolveArchivalPlan(dataDir, character, thread, loaded, {
      keepRecentTurns: compaction.keep_recent_turns,
      maxContextTokens: compaction.max_context_tokens,
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
      shoreLog.warn(
        `shore: skipping compaction for ${character}/${thread}: another pass holds the memory ` +
          `claim on everything it would archive. The conversation is kept as it is; this retries ` +
          `once that claim finishes or its lease runs out`,
      );
      return undefined;
    }
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

    const resolved = await resolveDeps(character, deps, effective);
    const chatRequest = await resolveChatRequest(character, thread, loaded, resolved.effective);

    const outcome = await compact(
      {
        conversationId: character,
        plan,
        systemTemplate: resolved.systemTemplate,
        promptTemplate: resolved.promptTemplate,
        charName: character,
        thread,
        userName: resolved.displayName,
        llm: resolved.llm,
        conversationMgr: conversationManager(
          loaded.conversationDir,
          deps.now ?? (() => new Date().toISOString()),
          deps.newId ?? (() => crypto.randomUUID()),
          {
            dbPath: join(dataDir, HISTORY_DB_FILE),
            archiveKey: archiveKey(character, thread),
            retain: resolved.effective.app.memory.retain.enabled,
          },
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
        tools: resolved.tools,
        ...(planned.coverage === undefined ? {} : { coverage: planned.coverage }),
        ...(resolved.maxToolIterations === undefined
          ? {}
          : { maxToolIterations: resolved.maxToolIterations }),
        ...(deps.emit === undefined ? {} : { emit: tagCompactionFrames(deps.emit) }),
      },
      {
        keepRecentTurns: resolved.effective.app.memory.compaction.keep_recent_turns,
        maxContextTokens: resolved.effective.app.memory.compaction.max_context_tokens,
      },
    );

    if (
      planned.coverage !== undefined &&
      outcome.kind !== "compacted" &&
      outcome.kind !== "paused"
    ) {
      releaseCompactionCoverage(dataDir, character, planned.coverage.claim);
    }

    await pushAfterCompaction(resolved.effective.app.memory.git_push, outcome, async () => {
      await gitPushWorkspaceBestEffort(resolved.tools.workspaceDir);
    });

    return outcome;
  } finally {
    guard.release();
  }
}

interface ResolvedDeps {
  effective: LoadedConfig;
  systemTemplate: string;
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
  const claimed = withCoverageStore(dbPath, (store) =>
    claimUncovered(store, character, "compaction", plan.archival, {
      contiguous: true,
      ...(resumeClaim === undefined ? {} : { claim: resumeClaim }),
    }),
  );

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
): Promise<ResolvedDeps> {
  const configDir = effective.dirs.config;
  const systemTemplate =
    resolvePromptTemplate(configDir, character, "compact_system.md") ?? DEFAULT_COMPACT_SYSTEM;
  const promptTemplate =
    resolvePromptTemplate(configDir, character, "compact.md") ?? DEFAULT_COMPACT_PROMPT;

  const model = resolveBackgroundModel(configView(effective), "compaction", character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (model === undefined) {
    throw CompactionError.llm("No model configured for background compaction");
  }

  let markdownStore: MarkdownMemoryStore | undefined;
  try {
    markdownStore = await MarkdownMemoryStore.open(
      characterMemoryDir(configDir, character, effective.dirs.workspace),
    );
  } catch (e) {
    shoreLog.warn(`shore: markdown memory store unavailable for ${character}: ${String(e)}`);
  }

  const toolCtx = await buildToolContext(effective, effective.dirs.data, character, deps.tools ?? {});
  const entry = effective.providers.get(model.providerKey);
  const providerEntry = entry === undefined ? undefined : credentialEntry(entry);

  return {
    effective,
    systemTemplate,
    promptTemplate,
    displayName: resolveDisplayName(effective.app.defaults),
    llm: new RealCompactionLlm({
      model: toRequestModel(model),
      character,
      generate: deps.generate,
      cacheDir: effective.dirs.cache,
      ...(providerEntry === undefined ? {} : { providerEntry }),
      ...(deps.emit === undefined ? {} : { emit: tagCompactionFrames(deps.emit) }),
    }),
    markdownStore,
    tools: compactionTools(toolCtx, effective),
    maxToolIterations: model.maxToolIterations,
  };
}

function compactionTools(ctx: ToolContext, config: LoadedConfig): CompactionTools {
  const exec: ToolExecution = {
    sendDirect: () => {},
    ctx,
    limits: toolLimitsFrom(config.app.tools, config.app.subagents),
    now: () => new Date().toISOString(),
    newMessageId: () => `m_${crypto.randomUUID()}`,
    schemas: BUILTIN_TOOL_SCHEMAS,
  };
  return {
    workspaceDir: ctx.workspaceDir,
    dispatch: async (name, input) => {
      const run = await runToolUse(
        { id: `compaction_${crypto.randomUUID()}`, name, input },
        exec,
        [],
      );
      return { output: run.window?.output ?? run.raw, isError: run.isError };
    },
    deferEdit: async (path) => await queueDeferredEdit(ctx.characterDataDir, path),
    ensureWorkspaceGitRepo: async (workspaceDir) => {
      await ensureWorkspaceGitRepoBestEffort(workspaceDir);
    },
    gitHead: async (workspaceDir) => await gitHead(workspaceDir),
    gitCommitAll: async (workspaceDir, charName, message) =>
      await gitCommitAll(workspaceDir, charName, message),
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
  loaded: Awaited<ReturnType<typeof loadMessagesForCompaction>>,
  effective: LoadedConfig,
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

  const hasPriorContext =
    (await segmentCount(conversationRef(effective.dirs.data, character, thread, false))) > 0;
  const built = await buildChatShapeRequestFromDisk(
    character,
    characterDataDir(effective.dirs.data, character),
    effective,
    chatModel,
    [...loaded.store.messages()],
    hasPriorContext,
  );
  return built.request;
}

export function compactionRunner(
  deps: Omit<CompactionRunDeps, "config"> & {
    cache?: LastRequestCache;
    rebuild?: RebuildDeps;
  },
): CompactionRunner {
  return {
    run: (character, config) => {
      const { cache: _cache, rebuild: _rebuild, ...rest } = deps;
      return runCompaction(character, {
        ...rest,
        config,
      });
    },
    applyDeferredEdits: (charDataDir, configDir, charName, workspaceRoot) =>
      applyDeferredEdits(charDataDir, configDir, charName, workspaceRoot),
    ...(deps.cache === undefined
      ? {}
      : {
          repoint: async (character: string, config: LoadedConfig) => {
            required(deps.cache).invalidate(character, "compaction");
            await required(deps.cache).reprimeFromDisk(
              character,
              config.dirs.data,
              config,
              deps.rebuild ?? {},
            );
          },
        }),
  };
}
