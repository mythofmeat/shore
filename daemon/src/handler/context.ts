import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { resolveDisplayName } from "../config/app.ts";
import { anyToolEnabled } from "../config/app.ts";
import {
  resolvedReasoningReplay,
  toRequestModel,
  type ResolvedModel,
} from "../config/models.ts";
import { assemblePrompt, type AssembledPrompt, type PromptSection, type ThreadPrompt } from "../engine/prompt.ts";
import { homeThread, readThreadsIndexIn, threadRecord } from "../engine/threads.ts";
import type { PriorContext } from "../engine/segments.ts";
import type { Message } from "../engine/types.ts";
import {
  ensureActivePromptSnapshot,
  loadPromptFile,
  loadThreadPins,
  resetActivePromptSnapshot,
} from "../memory/deferred_edits.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import { buildRequestWithProviderKeys, type BuiltRequest } from "../llm/request.ts";
import { imageTierForModel } from "../llm/image_tokens.ts";
import type { SystemBlock, ToolDefinition, WireMessage } from "../llm/types.ts";
import { toCredentialsEntry } from "../config/providers.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { assembleToolSurface, renderToolDefs, subagentToolDefs } from "../tools/registry.ts";
import { withoutWakeWorking } from "../autonomy/wake_working.ts";
import { assistantImageModeForRequest, buildLlmMessages } from "./wire_messages.ts";

export interface PrepareChatContextParams {
  thread?: string;
  character: string;
  characterDataDir: string;
  config: LoadedConfig;
  resolved: ResolvedModel;
  messages: Message[];
  prior: PriorContext;
  activeConversation?: boolean;
  mcpToolDefs: readonly ToolDefinition[];
  timeZone?: string;
}

export interface PreparedChatContext {
  llmMessages: WireMessage[];
  system: SystemBlock[];
  toolDefs: ToolDefinition[] | undefined;
  prompt: AssembledPrompt;
}

async function configFile(config: LoadedConfig, file: string, setting: string): Promise<string> {
  const path = resolve(config.dirs.config, file);
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`${setting} could not be read at ${path}: ${(e as Error).message}`, { cause: e });
  }
}

export async function loadSystemPrompt(
  config: LoadedConfig,
  resolved: ResolvedModel,
): Promise<string | undefined> {
  const configured = resolved.systemPrompt ?? config.app.chat.system_prompt;
  if (configured === undefined) return undefined;
  return await configFile(config, configured, `system_prompt "${configured}" for ${resolved.qualifiedName}`);
}

async function promptSections(
  config: LoadedConfig,
  resolved: ResolvedModel,
  workspaceFile: (path: string) => Promise<string | undefined>,
): Promise<PromptSection[]> {
  if (config.app.prompt.length === 0) {
    throw new Error("the config has no [[prompt]] list, so there is no system prompt: add [[prompt]] parts to config.toml");
  }
  return await Promise.all(config.app.prompt.map(async (part): Promise<PromptSection> => {
    if ("file" in part) return { label: part.file, text: await configFile(config, part.file, `prompt file "${part.file}"`), template: true };
    if ("workspace" in part) return { label: part.workspace, text: await workspaceFile(part.workspace), template: false };
    if (part.shore === "system_prompt") return { label: "system_prompt", text: await loadSystemPrompt(config, resolved), template: true };
    return { shore: part.shore };
  }));
}

async function threadPrompt(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  thread: string | undefined,
): Promise<ThreadPrompt | undefined> {
  if (thread === undefined) return undefined;
  const index = await readThreadsIndexIn(characterDataDir);
  if (index === undefined) return undefined;
  const home = homeThread(index);
  const record = threadRecord(index, thread);
  if (record === undefined || record.id === home) return undefined;
  return {
    id: record.id,
    home,
    created_at: record.created_at,
    started_by_you: record.created_by === "character",
    label: record.label,
    purpose: record.purpose,
    pins: await loadThreadPins(characterDataDir, workspace, record.id, record.pins ?? []),
  };
}

export async function prepareChatContext(
  params: PrepareChatContextParams,
): Promise<PreparedChatContext> {
  const { character, characterDataDir, config, resolved, messages, mcpToolDefs } = params;
  const displayName = resolveDisplayName(config.app.chat);

  const workspace = characterWorkspace(config, character);
  const activeConversation = params.activeConversation ?? messages.length > 0;
  if (activeConversation) {
    try {
      await ensureActivePromptSnapshot(
        characterDataDir,
        workspace,
        params.thread,
      );
    } catch (e) {
      shoreLog.warn(`shore: failed to prepare active prompt snapshot for ${character}: ${String(e)}`);
    }
  } else {
    try {
      await resetActivePromptSnapshot(characterDataDir, params.thread);
    } catch (e) {
      shoreLog.warn(`shore: failed to reset the prompt snapshot for ${character}: ${String(e)}`);
    }
  }

  const sections = await promptSections(config, resolved, async (path) => await loadPromptFile(
    characterDataDir,
    workspace,
    path,
    params.thread,
  ));

  const promptParams = {
    thread: await threadPrompt(characterDataDir, workspace, params.thread),
    character_name: character,
    display_name: displayName,
    sections,
    has_prior_context: params.prior.archived,
    archived_last_at: params.prior.lastAt,
    messages: withoutWakeWorking(messages),
    max_context_tokens: resolved.maxContextTokens,
    max_output_tokens: resolved.maxOutputTokens,
    user_timestamp_mode: config.app.chat.user_timestamps,
    image_tier: imageTierForModel(resolved.modelId),
  };
  const prompt =
    params.timeZone === undefined
      ? assemblePrompt(promptParams)
      : assemblePrompt(promptParams, params.timeZone);

  const toolsAvailable = anyToolEnabled(config.app) || mcpToolDefs.length > 0;

  const { messages: llmMessages, system } = await buildLlmMessages(
    prompt,
    assistantImageModeForRequest(resolved.sdk, toolsAvailable),
  );

  const toolDefs = toolsAvailable
    ? assembleToolSurface(
        renderToolDefs(config.app.tools, character, displayName),
        subagentToolDefs(
          config.app.subagents.agents,
          config.app.subagents.enabled,
          character,
          displayName,
        ),
        mcpToolDefs,
      )
    : undefined;

  return { llmMessages, system, toolDefs, prompt };
}

export async function buildChatShapeRequestFromDisk(
  character: string,
  characterDataDir: string,
  config: LoadedConfig,
  resolved: ResolvedModel,
  messages: Message[],
  prior: PriorContext,
  options: {
    thread?: string;
    mcpToolDefs?: readonly ToolDefinition[];
    timeZone?: string;
    activeConversation?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<BuiltRequest & { messageBudget: number }> {
  const prepared = await prepareChatContext({
    ...(options.thread === undefined ? {} : { thread: options.thread }),
    character,
    characterDataDir,
    config,
    resolved,
    messages,
    prior,
    mcpToolDefs: options.mcpToolDefs ?? [],
    ...(options.activeConversation === undefined
      ? {}
      : { activeConversation: options.activeConversation }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });

  const entry = config.providers.get(resolved.providerKey);
  return {
    ...buildRequestWithProviderKeys(
      toRequestModel(resolved),
      entry === undefined ? undefined : toCredentialsEntry(entry),
      {
        messages: prepared.llmMessages,
        system: prepared.system,
        ...(prepared.toolDefs === undefined ? {} : { tools: prepared.toolDefs }),
        replay: resolvedReasoningReplay(
          resolved,
          config.app.chat.reasoning_replay,
        ),
      },
      options.env,
    ),
    messageBudget: prepared.prompt.messageBudget,
  };
}
