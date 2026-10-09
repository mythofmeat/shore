import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { resolveDisplayName } from "../config/app.ts";
import { anyToolEnabled } from "../config/app.ts";
import { SOUL_FILE, TOOLS_FILE, USER_FILE } from "../config/dirs.ts";
import {
  resolvedReplayPriorThinking,
  toRequestModel,
  type ResolvedModel,
} from "../config/models.ts";
import { assemblePrompt, type AssembledPrompt } from "../engine/prompt.ts";
import type { Message } from "../engine/types.ts";
import {
  ensureActivePromptSnapshot,
  ensureCharacterWorkspace,
  loadPromptFile,
  loadMemoryIndex,
  resetActivePromptSnapshot,
} from "../memory/deferred_edits.ts";
import { buildRequestWithProviderKeys, type BuiltRequest } from "../llm/request.ts";
import { imageTierForModel } from "../llm/image_tokens.ts";
import type { SystemBlock, ToolDefinition, WireMessage } from "../llm/types.ts";
import { toCredentialsEntry } from "../config/providers.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { assembleToolSurface, renderToolDefs, subagentToolDefs } from "../tools/registry.ts";
import { assistantImageModeForRequest, buildLlmMessages } from "./wire_messages.ts";

export interface PrepareChatContextParams {
  thread?: string;
  character: string;
  characterDataDir: string;
  config: LoadedConfig;
  resolved: ResolvedModel;
  messages: Message[];
  hasPriorContext: boolean;
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

export async function loadSystemPrompt(
  config: LoadedConfig,
  resolved: ResolvedModel,
): Promise<string | undefined> {
  const configured = resolved.systemPrompt ?? config.app.defaults.system_prompt;
  if (configured === undefined) return undefined;
  const path = resolve(config.dirs.config, configured);
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    throw new Error(
      `system_prompt "${configured}" for ${resolved.qualifiedName} could not be read at ${path}: ` +
        (e instanceof Error ? e.message : String(e)),
      { cause: e },
    );
  }
}

export async function prepareChatContext(
  params: PrepareChatContextParams,
): Promise<PreparedChatContext> {
  const { character, characterDataDir, config, resolved, messages, mcpToolDefs } = params;
  const displayName = resolveDisplayName(config.app.defaults);

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
      await ensureCharacterWorkspace(workspace);
    } catch (e) {
      shoreLog.warn(`shore: failed to prepare character workspace for ${character}: ${String(e)}`);
    }
  }

  const promptFile = (name: string) =>
    loadPromptFile(
      characterDataDir,
      workspace,
      name,
      params.thread,
    );
  const characterDefinition = await promptFile(SOUL_FILE);
  const userDefinition = await promptFile(USER_FILE);
  const systemPrompt = await loadSystemPrompt(config, resolved);
  const toolsGuidance = await promptFile(TOOLS_FILE);
  const memoryIndex = await loadMemoryIndex(
    characterDataDir,
    workspace,
    params.thread,
  );

  const promptParams = {
    character_name: character,
    display_name: displayName,
    system_prompt: systemPrompt,
    tools_guidance: toolsGuidance,
    character_definition: characterDefinition,
    user_definition: userDefinition,
    memory_index: memoryIndex,
    has_prior_context: params.hasPriorContext,
    messages,
    max_context_tokens: resolved.maxContextTokens,
    max_output_tokens: resolved.maxOutputTokens,
    user_timestamp_mode: config.app.behavior.user_message_timestamps,
    image_tier: imageTierForModel(resolved.modelId),
  };
  const prompt =
    params.timeZone === undefined
      ? assemblePrompt(promptParams)
      : assemblePrompt(promptParams, params.timeZone);

  const toolsAvailable = anyToolEnabled(config.app.tools) || mcpToolDefs.length > 0;

  const { messages: llmMessages, system } = await buildLlmMessages(
    prompt,
    assistantImageModeForRequest(resolved.sdk, toolsAvailable),
  );

  const toolDefs = toolsAvailable
    ? assembleToolSurface(
        renderToolDefs(config.app.tools, character, displayName),
        subagentToolDefs(
          config.app.subagents,
          config.app.tools.enabled_subagents,
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
  hasPriorContext: boolean,
  options: {
    thread?: string;
    mcpToolDefs?: readonly ToolDefinition[];
    timeZone?: string;
    activeConversation?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<BuiltRequest> {
  const prepared = await prepareChatContext({
    ...(options.thread === undefined ? {} : { thread: options.thread }),
    character,
    characterDataDir,
    config,
    resolved,
    messages,
    hasPriorContext,
    mcpToolDefs: options.mcpToolDefs ?? [],
    ...(options.activeConversation === undefined
      ? {}
      : { activeConversation: options.activeConversation }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });

  const entry = config.providers.get(resolved.providerKey);
  return buildRequestWithProviderKeys(
    toRequestModel(resolved),
    entry === undefined ? undefined : toCredentialsEntry(entry),
    {
      messages: prepared.llmMessages,
      system: prepared.system,
      ...(prepared.toolDefs === undefined ? {} : { tools: prepared.toolDefs }),
      replay: resolvedReplayPriorThinking(
        resolved,
        config.app.memory.thinking.replay_prior_thinking,
      ),
    },
    options.env,
  );
}
