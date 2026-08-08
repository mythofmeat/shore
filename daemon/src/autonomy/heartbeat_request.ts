import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import {
  configView,
  resolveBackgroundModel,
  resolveChatModelForCharacter,
} from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { toRequestModel, type ResolvedModel } from "../config/models.ts";
import { resolveDisplayName } from "../config/app.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { hostZone } from "../ledger/zoned.ts";
import { buildRequestWithProviderKeys, pushInlineSystem } from "../llm/request.ts";
import type { SidecarRequest } from "../llm/types.ts";
import { ensureActivePromptSnapshot } from "../memory/deferred_edits.ts";
import { buildHeartbeatPrompt } from "./heartbeat_shape.ts";
import type { LastRequestCache } from "./last_request.ts";
import { rebuildRequestFromDisk, type RebuildDeps } from "./rebuild.ts";

const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;

function copyForTick(request: SidecarRequest): SidecarRequest {
  const copy: SidecarRequest = { ...request, messages: [...request.messages] };
  if (copy.context !== undefined) {
    const { rid: _rid, ...rest } = copy.context;
    copy.context = rest;
  }
  return copy;
}

export function fallbackIntervalPhrase(secs: bigint): string {
  if (secs >= SECONDS_PER_HOUR && secs % SECONDS_PER_HOUR === 0n) {
    const hours = secs / SECONDS_PER_HOUR;
    return hours === 1n ? "1 hour" : `${hours} hours`;
  }
  return `${secs / SECONDS_PER_MINUTE} minutes`;
}

export interface HeartbeatModelChoice {
  request: SidecarRequest;
  override: ResolvedModel | undefined;
}

export interface HeartbeatModelDeps {
  env?: NodeJS.ProcessEnv;
}

export function applyHeartbeatModelOverride(
  request: SidecarRequest,
  config: LoadedConfig,
  character: string,
  deps: HeartbeatModelDeps = {},
): HeartbeatModelChoice {
  const view = configView(config);
  const configuredName = view.app.defaults.backgroundModelName("heartbeat");
  if (configuredName === undefined) return { request, override: undefined };

  try {
    findEffectiveModel(view, config.dirs.cache, configuredName, true);
  } catch (e) {
    console.warn(
      `shore: heartbeat model "${configuredName}" not found in catalog for ${character}; ` +
        `keeping chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }

  const resolved = resolveBackgroundModel(view, "heartbeat", character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (resolved === undefined) return { request, override: undefined };
  if (resolved.modelId === request.model) {
    return { request, override: undefined };
  }

  const entry = config.providers.get(resolved.providerKey);
  try {
    const built = buildRequestWithProviderKeys(
      toRequestModel(resolved),
      entry === undefined ? undefined : credentialEntry(entry),
      {
        messages: request.messages,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        replay: request.replay_prior_thinking,
      },
      deps.env,
    );
    console.info(
      `shore: heartbeat for ${character} using configured model ${resolved.name} (${built.request.model})`,
    );
    return { request: built.request, override: resolved };
  } catch (e) {
    console.warn(
      `shore: heartbeat could not build a request on ${resolved.name} for ${character}, ` +
        `falling back to the chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }
}

export interface PrepareHeartbeatDeps {
  cache: LastRequestCache;
  rebuild?: RebuildDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
}

export interface PreparedHeartbeat {
  request: SidecarRequest;
  maxToolIterations: number | undefined;
  override: ResolvedModel | undefined;
}

export async function prepareHeartbeatRequest(
  character: string,
  config: LoadedConfig,
  deps: PrepareHeartbeatDeps,
): Promise<PreparedHeartbeat | undefined> {
  let source = deps.cache.get(character);
  if (source === undefined) {
    const rebuilt = await rebuildRequestFromDisk(
      character,
      config.dirs.data,
      config,
      deps.rebuild ?? {},
    );
    if (rebuilt === undefined) {
      console.info(
        `shore: heartbeat skipping tick for ${character} (conversation mid-turn or model unresolved)`,
      );
      return undefined;
    }
    source = rebuilt.request;
    deps.cache.set(character, source, rebuilt.keepalive_interval_ms);
  }

  const { request, override } = applyHeartbeatModelOverride(
    copyForTick(source),
    config,
    character,
    deps.env === undefined ? {} : { env: deps.env },
  );

  const maxToolIterations =
    override !== undefined
      ? override.maxToolIterations
      : resolveChatModelForCharacter(configView(config), character, (v, c, n, h) =>
          findEffectiveModel(v, c, n, h),
        )?.maxToolIterations;

  try {
    await ensureActivePromptSnapshot(
      join(config.dirs.data, character),
      config.dirs.config,
      character,
      config.dirs.workspace,
    );
  } catch (e) {
    console.warn(`shore: heartbeat could not prepare the prompt snapshot for ${character}: ${String(e)}`);
  }

  const nowMs = deps.now?.() ?? Date.now();
  const prompt = buildHeartbeatPrompt(
    formatWallClock(nowMs, deps.timeZone ?? hostZone()),
    resolveDisplayName(config.app.defaults, deps.env),
    fallbackIntervalPhrase(config.app.behavior.autonomy.heartbeat.fallback_heartbeat_interval.asSecs()),
  );

  pushInlineSystem(request, prompt);

  return {
    request,
    maxToolIterations,
    override,
  };
}
