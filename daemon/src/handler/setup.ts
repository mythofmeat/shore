import type { LoadedConfig } from "../config/loader.ts";
import type { ErrorCode } from "../protocol/ErrorCode.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import {
  firstChatModel,
  NO_CHAT_MODELS_MESSAGE,
  toRequestModel,
  type ResolvedModel,
} from "../config/models.ts";
import {
  applySamplerOverlay,
  configView,
  samplerIsEmpty,
  type SamplerSettings,
} from "../config/preferences.ts";
import { characterDataDir } from "../config/dirs.ts";
import { resolvedReplayPriorThinking } from "../config/models.ts";
import type { Message } from "../engine/types.ts";
import { buildRequestWithResolvedKey, type BuiltRequest } from "../llm/request.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";
import { prepareChatContext } from "./context.ts";

export interface SetupEngine {
  messages(): readonly Message[];
  messagesThroughLastUserTurn(): Message[];
  segmentCount(): number;
}

export interface MessageOverrides {
  temperature?: number;
  top_p?: number;
  thinking_budget?: number;
}

export class NoModelError extends Error {
  readonly code: ErrorCode = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "NoModelError";
  }
}

export class ImagesUnsupportedError extends Error {
  readonly code: ErrorCode = "invalid_request";

  constructor(qualifiedName: string, count: number) {
    super(
      `${qualifiedName} does not accept images, so the ${
        count === 1 ? "attachment was" : `${String(count)} attachments were`
      } not sent. Switch to a vision-capable model and send again.`,
    );
    this.name = "ImagesUnsupportedError";
  }
}

export function resolveGenerationModel(
  activeModel: ResolvedModel | undefined,
  config: LoadedConfig,
  overlay: SamplerSettings,
): ResolvedModel {
  let base: ResolvedModel;
  if (activeModel !== undefined) {
    base = activeModel;
  } else {
    const name = config.app.defaults.model;
    if (name !== undefined) {
      base = findEffectiveModel(configView(config), config.dirs.cache, name, true);
    } else {
      const first = firstChatModel(config.models);
      if (first === undefined) throw new NoModelError(NO_CHAT_MODELS_MESSAGE);
      base = first;
    }
  }

  return samplerIsEmpty(overlay) ? base : applySamplerOverlay(base, overlay);
}

export interface BuildGenerationRequestParams {
  engine: SetupEngine;
  dataDir: string;
  charName: string;
  config: LoadedConfig;
  resolved: ResolvedModel;
  regen: boolean;
  mcpRegistry: Pick<McpRegistry, "toolDefsFiltered">;
  overrides?: MessageOverrides;
  timeZone?: string;
}

export async function buildGenerationRequest(
  params: BuildGenerationRequestParams,
): Promise<BuiltRequest> {
  const { engine, config, resolved, charName } = params;

  const messages = params.regen
    ? engine.messagesThroughLastUserTurn()
    : [...engine.messages()];
  const hasPriorContext = engine.segmentCount() > 0;

  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(config.app.tools.enabled_tools);

  const prepared = await prepareChatContext({
    character: charName,
    characterDataDir: characterDataDir(params.dataDir, charName),
    config,
    resolved,
    messages,
    hasPriorContext,
    mcpToolDefs,
    ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
  });

  const built = buildRequestWithResolvedKey(toRequestModel(resolved), "", {
    messages: prepared.llmMessages,
    system: prepared.system,
    ...(prepared.toolDefs === undefined ? {} : { tools: prepared.toolDefs }),
    replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),
  });

  return params.overrides === undefined
    ? built
    : { ...built, request: withOverrides(built.request, params.overrides) };
}

function withOverrides<T extends { temperature?: number; top_p?: number; provider_options?: object }>(
  request: T,
  overrides: MessageOverrides,
): T {
  const out = { ...request };
  if (overrides.temperature !== undefined) out.temperature = overrides.temperature;
  if (overrides.top_p !== undefined) out.top_p = overrides.top_p;
  if (overrides.thinking_budget !== undefined) {
    out.provider_options = { ...out.provider_options, budget_tokens: overrides.thinking_budget };
  }
  return out;
}
