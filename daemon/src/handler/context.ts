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
import { assemblePrompt, buildSystemBlocks, type AssembledPrompt, type PromptSection, type ThreadPrompt } from "../engine/prompt.ts";
import { homeThread, readThreadsIndexIn, threadRecord } from "../engine/threads.ts";
import type { PriorContext } from "../engine/segments.ts";
import type { Message } from "../engine/types.ts";
import {
  ensureActivePromptSnapshot,
  loadPromptFile,
  loadThreadPins,
  previewPromptFile,
  previewThreadPins,
  resetActivePromptSnapshot,
  type PinPreview,
  type ThreadPin,
} from "../memory/deferred_edits.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import { buildRequestWithProviderKeys, type BuiltRequest } from "../llm/request.ts";
import { imageTierForModel } from "../llm/image_tokens.ts";
import type { SystemBlock, ToolDefinition, WireMessage } from "../llm/types.ts";
import { toCredentialsEntry } from "../config/providers.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { assembleToolSurface, renderToolDefs, subagentToolDefs } from "../tools/registry.ts";
import { withoutWakeWorking } from "../autonomy/wake_working.ts";
import { assistantImageModeForRequest, buildLlmMessages, inReadingOrder, type SentMessage } from "./wire_messages.ts";
import { Texts } from "../texts/texts.ts";

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
  sent: SentMessage[];
}

function readInstead(stored: readonly Message[], seen: readonly Message[], sent: readonly SentMessage[]): SentMessage[] {
  const own = new Map(stored.map((message) => [message.msg_id, message]));
  const replaced = new Map(seen.filter((message) => own.get(message.msg_id) !== message).map((message) => [message.msg_id, message]));
  return sent.map(({ msg_id, notes }) => {
    const read = replaced.get(msg_id);
    if (read === undefined) return { msg_id, notes };
    const text = read.content_blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
    return { msg_id, notes: inReadingOrder([...notes, { place: "instead", text }]) };
  });
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

type PinLoader<P extends ThreadPin> = (texts: Texts, characterDataDir: string, workspace: CharacterWorkspace, thread: string, pins: readonly string[]) => Promise<P[]>;

async function threadPrompt<P extends ThreadPin>(
  texts: Texts,
  characterDataDir: string,
  workspace: CharacterWorkspace,
  thread: string | undefined,
  loadPins: PinLoader<P>,
): Promise<(ThreadPrompt & { pins: P[] }) | undefined> {
  if (thread === undefined) return undefined;
  const index = await readThreadsIndexIn(characterDataDir);
  const record = index === undefined ? undefined : threadRecord(index, thread);
  if (record === undefined) return undefined;
  return {
    id: record.id,
    home: homeThread(index),
    created_at: record.created_at,
    started_by_you: record.created_by === "character",
    label: record.label,
    purpose: record.purpose,
    pins: await loadPins(texts, characterDataDir, workspace, record.id, record.pins ?? []),
  };
}

export interface ThreadPromptPreview {
  system: AssembledPrompt["system"];
  changed: ReadonlySet<string>;
  pins: PinPreview[];
}

export async function previewThreadPrompt(params: {
  character: string;
  characterDataDir: string;
  config: LoadedConfig;
  resolved: ResolvedModel;
  thread: string;
  timeZone?: string;
}): Promise<ThreadPromptPreview> {
  const { character, characterDataDir, config, thread } = params;
  const workspace = characterWorkspace(config, character);
  const texts = Texts.of(config);
  const changed = new Set<string>();
  const sections = await promptSections(config, params.resolved, async (path) => {
    const file = await previewPromptFile(characterDataDir, workspace, path, thread);
    if (file.changed) changed.add(path);
    return file.content;
  });
  const prompt = await threadPrompt(texts, characterDataDir, workspace, thread, previewThreadPins);
  const system = buildSystemBlocks({ thread: prompt, character_name: character, display_name: resolveDisplayName(config.app.chat), sections, texts }, params.timeZone);
  return { system, changed, pins: prompt?.pins ?? [] };
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

  const texts = Texts.of(config);
  const seen = withoutWakeWorking(texts, messages);
  const sections = await promptSections(config, resolved, async (path) => await loadPromptFile(
    characterDataDir,
    workspace,
    path,
    params.thread,
  ));

  const promptParams = {
    thread: await threadPrompt(texts, characterDataDir, workspace, params.thread, loadThreadPins),
    character_name: character,
    display_name: displayName,
    sections,
    has_prior_context: params.prior.archived,
    archived_last_at: params.prior.lastAt,
    messages: seen,
    max_context_tokens: resolved.maxContextTokens,
    max_output_tokens: resolved.maxOutputTokens,
    user_timestamp_mode: config.app.chat.user_timestamps,
    image_tier: imageTierForModel(resolved.modelId),
    texts,
  };
  const prompt =
    params.timeZone === undefined
      ? assemblePrompt(promptParams)
      : assemblePrompt(promptParams, params.timeZone);

  const toolsAvailable = anyToolEnabled(config.app) || mcpToolDefs.length > 0;

  const { messages: llmMessages, system, sent } = await buildLlmMessages(
    prompt,
    assistantImageModeForRequest(resolved.sdk, toolsAvailable),
    texts,
  );

  const toolDefs = toolsAvailable
    ? assembleToolSurface(
        renderToolDefs(texts, config.app.tools, character, displayName),
        subagentToolDefs(
          texts,
          config.app.subagents.agents,
          config.app.subagents.enabled,
          character,
          displayName,
        ),
        mcpToolDefs,
      )
    : undefined;

  return { llmMessages, system, toolDefs, prompt, sent: readInstead(messages, seen, sent) };
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
): Promise<BuiltRequest & { messageBudget: number; sent: SentMessage[] }> {
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
    sent: prepared.sent,
  };
}
