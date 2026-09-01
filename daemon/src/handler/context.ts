import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { resolveDisplayName } from "../config/app.ts";
import { anyToolEnabled } from "../config/app.ts";
import { AGENTS_FILE, SOUL_FILE, TOOLS_FILE, USER_FILE } from "../config/dirs.ts";
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
import type { SystemBlock, ToolDefinition, WireMessage } from "../llm/types.ts";
import { toCredentialsEntry } from "../config/providers.ts";
import { assembleToolSurface, renderToolDefs, subagentToolDefs } from "../tools/registry.ts";
import { assistantImageModeForRequest, buildLlmMessages } from "./wire_messages.ts";

export interface PrepareChatContextParams {
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

export async function prepareChatContext(
  params: PrepareChatContextParams,
): Promise<PreparedChatContext> {
  const { character, characterDataDir, config, resolved, messages, mcpToolDefs } = params;
  const displayName = resolveDisplayName(config.app.defaults);

  const activeConversation = params.activeConversation ?? messages.length > 0;
  if (activeConversation) {
    try {
      await ensureActivePromptSnapshot(
        characterDataDir,
        config.dirs.config,
        character,
        config.dirs.workspace,
      );
    } catch (e) {
      shoreLog.warn(`shore: failed to prepare active prompt snapshot for ${character}: ${String(e)}`);
    }
  } else {
    try {
      await resetActivePromptSnapshot(characterDataDir);
      await ensureCharacterWorkspace(
        characterDataDir,
        config.dirs.config,
        character,
        config.dirs.workspace,
      );
    } catch (e) {
      shoreLog.warn(`shore: failed to prepare character workspace for ${character}: ${String(e)}`);
    }
  }

  const promptFile = (name: string) =>
    loadPromptFile(
      characterDataDir,
      config.dirs.config,
      character,
      name,
      config.dirs.workspace,
    );
  const characterDefinition = await promptFile(SOUL_FILE);
  const userDefinition = await promptFile(USER_FILE);
  const systemPrompt = await promptFile(AGENTS_FILE);
  const toolsGuidance = await promptFile(TOOLS_FILE);
  const memoryIndex = await loadMemoryIndex(
    characterDataDir,
    config.dirs.config,
    character,
    config.dirs.workspace,
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
    mcpToolDefs?: readonly ToolDefinition[];
    timeZone?: string;
    activeConversation?: boolean;
  } = {},
): Promise<BuiltRequest> {
  const prepared = await prepareChatContext({
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
  );
}
