import { required } from "../../util/required.ts";

import { shoreLog } from "../../log.ts";

import { join } from "node:path";

import type { LoadedConfig } from "../../config/loader.ts";
import { HISTORY_DB_FILE } from "../../engine/history_store.ts";
import { conversationRef } from "../../engine/segments.ts";
import { loadCharacterConfig } from "../../config/loader.ts";
import { resolvePromptTemplate } from "../../config/dirs.ts";
import { characterDataDir, characterMemoryDir, MAIN_THREAD } from "../../config/dirs.ts";
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
import { conversationManager, segmentCount } from "./archive.ts";
import { handleCompactionOutcome, loadMessagesForCompaction, pushAfterCompaction } from "./background.ts";
import { RealCompactionLlm, type RealCompactionLlmOptions } from "./llm.ts";
import {
  archiveSplitIndex,
  compact,
  countTurns,
  tryBeginCompaction,
} from "./manager.ts";
import { retainedTurns as retentionForBudget } from "./retention.ts";
import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM } from "./prompts.ts";
import { renderToolValue } from "../../tools/media.ts";
import {
  CompactionError,
  CompactionPaused,
  tagCompactionFrames,
  type CompactionOutcome,
  type CompactionTools,
} from "./types.ts";

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

async function rotateWithoutMemoryWrite(
  character: string,
  deps: CompactionRunDeps,
  effective: LoadedConfig,
  loaded: Awaited<ReturnType<typeof loadMessagesForCompaction>>,
  options: CompactionRunOptions,
): Promise<CompactionOutcome> {
  const compaction = effective.app.memory.compaction;
  const keepTurns =
    options.keepTurnsOverride ??
    retentionForBudget(loaded.messages, compaction.keep_recent_turns, compaction.max_context_tokens);
  const splitAt = archiveSplitIndex(
    loaded.messages,
    keepTurns,
    options.retainTrailingAutonomous ?? false,
  );
  if (splitAt === 0) throw CompactionError.insufficientMessages();

  const retained = loaded.messages.length - splitAt;
  const dryRun = options.dryRun ?? false;

  if (!dryRun) {
    await conversationManager(
      loaded.conversationDir,
      deps.now ?? (() => new Date().toISOString()),
      deps.newId ?? (() => crypto.randomUUID()),
      {
        dbPath: join(deps.config.dirs.data, HISTORY_DB_FILE),
        character,
        retain: effective.app.memory.retain.enabled,
      },
    ).archiveAndRetain("archive-only", {
      keepLastN: retained,
      activeContent: loaded.rawContent,
      note: "archive-only rotation; automatic memory writes disabled",
    });
  }

  return {
    kind: "rotated",
    conversationId: character,
    dryRun,
    messageCount: loaded.messages.length,
    archivedMessages: splitAt,
    compactedTurns: countTurns(loaded.messages.slice(0, splitAt)),
    retainedCount: retained,
    retainedTurns: countTurns(loaded.messages.slice(splitAt)),
  };
}

export async function runCompactionPass(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<CompactionOutcome | undefined> {
  const dataDir = deps.config.dirs.data;

  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) throw CompactionError.busy(character);

  try {
    const loaded = await loadMessagesForCompaction(dataDir, character);
    if (loaded.messages.length === 0) return undefined;

    const effective = effectiveConfig(character, deps.config);
    if (!effective.app.memory.compaction.write_memory) {
      return await rotateWithoutMemoryWrite(character, deps, effective, loaded, options);
    }

    const resolved = await resolveDeps(character, deps, effective);
    const chatRequest = await resolveChatRequest(character, loaded, resolved.effective);

    const outcome = await compact(
      {
        conversationId: character,
        messages: loaded.messages,
        activeContent: loaded.rawContent,
        systemTemplate: resolved.systemTemplate,
        promptTemplate: resolved.promptTemplate,
        charName: character,
        userName: resolved.displayName,
        llm: resolved.llm,
        conversationMgr: conversationManager(
          loaded.conversationDir,
          deps.now ?? (() => new Date().toISOString()),
          deps.newId ?? (() => crypto.randomUUID()),
          {
            dbPath: join(dataDir, HISTORY_DB_FILE),
            character,
            retain: resolved.effective.app.memory.retain.enabled,
          },
        ),
        ...(resolved.markdownStore === undefined ? {} : { markdownStore: resolved.markdownStore }),
        dryRun: options.dryRun ?? false,
        restart: options.restart ?? false,
        ...(options.keepTurnsOverride === undefined
          ? {}
          : { keepTurnsOverride: options.keepTurnsOverride }),
        retainTrailingAutonomous: options.retainTrailingAutonomous ?? false,
        chatRequest,
        dataDir,
        resumable: true,
        tools: resolved.tools,
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
  loaded: Awaited<ReturnType<typeof loadMessagesForCompaction>>,
  effective: LoadedConfig,
): Promise<SidecarRequest> {
  const chatModel = resolveChatModelForCharacter(configView(effective), character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (chatModel === undefined) {
    throw CompactionError.llm("No chat model configured for compaction prefix rebuild");
  }

  const hasPriorContext =
    (await segmentCount(conversationRef(effective.dirs.data, character, MAIN_THREAD, false))) > 0;
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
