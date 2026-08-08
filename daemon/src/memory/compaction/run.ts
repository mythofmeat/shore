import { join } from "node:path";

import type { LoadedConfig } from "../../config/loader.ts";
import { loadCharacterConfig } from "../../config/loader.ts";
import { resolvePromptTemplate } from "../../config/dirs.ts";
import { characterMemoryDir } from "../../config/dirs.ts";
import { resolveDisplayName } from "../../config/app.ts";
import { resolveBackgroundModel, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { configView } from "../../config/preferences.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import { toRequestModel } from "../../config/models.ts";
import type { SidecarRequest } from "../../llm/types.ts";
import { buildChatShapeRequestFromDisk } from "../../handler/context.ts";
import { buildToolContext, credentialEntry, type ToolContextDeps } from "../../handler/tool_context.ts";
import { dispatchTool } from "../../tools/dispatch.ts";
import {
  ensureWorkspaceGitRepoBestEffort,
  gitCommitAll,
  gitPushWorkspaceBestEffort,
} from "../../tools/workspace.ts";
import { MarkdownMemoryStore } from "../markdown_store.ts";
import { applyDeferredEdits } from "../deferred_edits.ts";
import type { CompactionRunner } from "../../handler/turn.ts";
import { conversationManager, segmentCount } from "./archive.ts";
import { handleCompactionOutcome, loadMessagesForCompaction, pushAfterCompaction } from "./background.ts";
import { RealCompactionLlm, type RealCompactionLlmOptions } from "./llm.ts";
import { compact, tryBeginCompaction } from "./manager.ts";
import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM } from "./prompts.ts";
import { CompactionError, type CompactionOutcome, type CompactionTools } from "./types.ts";

export interface CompactionRunDeps {
  config: LoadedConfig;
  generate: RealCompactionLlmOptions["generate"];
  cachedRequest?: SidecarRequest;
  notify?: (title: string, body: string) => void;
  tools?: Omit<ToolContextDeps, "runSubagent">;
  now?: () => string;
  newId?: () => string;
}

export interface CompactionRunOptions {
  dryRun?: boolean;
  keepTurnsOverride?: number;
  retainTrailingAutonomous?: boolean;
}

export async function runCompaction(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<number> {
  const outcome = await runCompactionPass(character, deps, options);
  if (outcome === undefined) return 0;
  return handleCompactionOutcome(character, deps.notify ?? (() => {}), outcome);
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

    const resolved = await resolveDeps(character, deps);
    const chatRequest = await resolveChatRequest(character, deps, loaded, resolved.effective);

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
          loaded.characterDir,
          deps.now ?? (() => new Date().toISOString()),
          deps.newId ?? (() => crypto.randomUUID()),
        ),
        ...(resolved.markdownStore === undefined ? {} : { markdownStore: resolved.markdownStore }),
        dryRun: options.dryRun ?? false,
        ...(options.keepTurnsOverride === undefined
          ? {}
          : { keepTurnsOverride: options.keepTurnsOverride }),
        retainTrailingAutonomous: options.retainTrailingAutonomous ?? false,
        chatRequest,
        dataDir,
        tools: resolved.tools,
        ...(resolved.maxToolIterations === undefined
          ? {}
          : { maxToolIterations: resolved.maxToolIterations }),
      },
      { keepRecentTurns: resolved.effective.app.memory.compaction.keep_recent_turns },
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

async function resolveDeps(character: string, deps: CompactionRunDeps): Promise<ResolvedDeps> {
  let effective = deps.config;
  try {
    effective = loadCharacterConfig(deps.config, character) ?? deps.config;
  } catch (e) {
    console.warn(
      `shore: character config failed to load for ${character}; ` +
        `compacting under the global config: ${String(e)}`,
    );
  }

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
    console.warn(`shore: markdown memory store unavailable for ${character}: ${String(e)}`);
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
      ...(providerEntry === undefined ? {} : { providerEntry }),
    }),
    markdownStore,
    tools: compactionTools(toolCtx),
    maxToolIterations: model.maxToolIterations,
  };
}

function compactionTools(ctx: Parameters<typeof dispatchTool>[2]): CompactionTools {
  return {
    workspaceDir: ctx.workspaceDir,
    configDir: ctx.configDir,
    dispatch: (name, input) => renderToolOutcome(() => dispatchTool(name, input, ctx)),
    ensureWorkspaceGitRepo: async (workspaceDir) => {
      await ensureWorkspaceGitRepoBestEffort(workspaceDir);
    },
    gitCommitAll: async (workspaceDir, charName, message) =>
      await gitCommitAll(workspaceDir, charName, message),
  };
}

export async function renderToolOutcome(
  call: () => Promise<unknown>,
): Promise<{ output: string; isError: boolean }> {
  try {
    const value = await call();
    return { output: typeof value === "string" ? value : (JSON.stringify(value) ?? ""), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

async function resolveChatRequest(
  character: string,
  deps: CompactionRunDeps,
  loaded: Awaited<ReturnType<typeof loadMessagesForCompaction>>,
  effective: LoadedConfig,
): Promise<SidecarRequest> {
  if (deps.cachedRequest !== undefined) return deps.cachedRequest;

  const chatModel = resolveChatModelForCharacter(configView(effective), character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (chatModel === undefined) {
    throw CompactionError.llm("No chat model configured for compaction prefix rebuild");
  }

  const hasPriorContext = (await segmentCount(loaded.characterDir)) > 0;
  const built = await buildChatShapeRequestFromDisk(
    character,
    loaded.characterDir,
    effective,
    chatModel,
    [...loaded.store.messages()],
    hasPriorContext,
  );
  return built.request;
}

function characterDir(dataDir: string, character: string): string {
  return join(dataDir, character);
}

export function compactionRunner(
  deps: Omit<CompactionRunDeps, "config" | "cachedRequest"> & {
    cachedRequest?: (character: string) => SidecarRequest | undefined;
  },
): CompactionRunner {
  return {
    run: (character, config) => {
      const { cachedRequest, ...rest } = deps;
      const cached = cachedRequest?.(character);
      return runCompaction(character, {
        ...rest,
        config,
        ...(cached === undefined ? {} : { cachedRequest: cached }),
      });
    },
    applyDeferredEdits: (charDataDir, configDir, charName, workspaceRoot) =>
      applyDeferredEdits(charDataDir, configDir, charName, workspaceRoot),
  };
}
