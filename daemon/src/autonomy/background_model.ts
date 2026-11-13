import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { applyBackgroundSettings, configView } from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { resolvedReplayPriorThinking, toRequestModel, type ResolvedModel } from "../config/models.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { buildRequestWithProviderKeys } from "../llm/request.ts";
import type { SidecarRequest } from "../llm/types.ts";

export interface BackgroundModelChoice {
  request: SidecarRequest;
  override: ResolvedModel | undefined;
}

export function backgroundTaskModel(
  config: LoadedConfig,
  character: string,
  task: "heartbeat" | "dreaming",
): ResolvedModel | undefined {
  const view = configView(config);
  const name = view.app.defaults.backgroundModelName(task);
  try {
    return name === undefined ? undefined : applyBackgroundSettings(config.dirs.data, character, task, findEffectiveModel(view, config.dirs.cache, name, true));
  } catch (e) {
    shoreLog.warn(`shore: ${task} model "${String(name)}" not found in catalog for ${character}; keeping chat model: ${String(e)}`);
    return undefined;
  }
}

export function backgroundModelRequest(
  request: SidecarRequest,
  config: LoadedConfig,
  character: string,
  env: NodeJS.ProcessEnv | undefined,
  resolved: ResolvedModel | undefined,
  task: "wake" | "dream",
): BackgroundModelChoice {
  if (resolved === undefined) return { request, override: undefined };

  const entry = config.providers.get(resolved.providerKey);
  try {
    const built = buildRequestWithProviderKeys(
      toRequestModel(resolved),
      entry === undefined ? undefined : credentialEntry(entry),
      {
        messages: request.messages,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),
      },
      env,
    );
    shoreLog.info(
      `shore: ${task} for ${character} using configured model ${resolved.name} (${built.request.model})`,
    );
    return { request: built.request, override: resolved };
  } catch (e) {
    shoreLog.warn(
      `shore: ${task} could not build a request on ${resolved.name} for ${character}, ` +
        `falling back to the chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }
}
