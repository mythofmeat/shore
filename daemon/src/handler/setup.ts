/**
 * Resolving the model a turn runs on, and assembling the request it sends.
 *
 * Ported from `resolve_generation_model` and `build_generation_request` in
 * `crates/daemon/src/handler/task.rs`, pinned by
 * `tests/handler_fixtures/setup_parity.json`.
 *
 * These are the two steps between "a message arrived" and "something is
 * streaming", and they are the last part of the generation path that neither
 * touches the client stream nor goes through the sidecar hop — so they port now,
 * and the rest of `task.rs` waits for the socket to move (#18).
 *
 * The engine arrives as a narrow interface rather than a `ConversationEngine`.
 * The Rust took an `Arc<Mutex<ConversationEngine>>` and locked it twice for two
 * reads; here the two reads are the whole dependency, and naming them keeps this
 * testable without a conversation on disk — the same shape `persistence.ts`
 * uses, and for the same reason.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { firstChatModel, toRequestModel, type ResolvedModel } from "../config/models.ts";
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
import type { CachedResize } from "./images.ts";
import { warmImageCache } from "./resize.ts";

/** The two reads this phase makes of the conversation. */
export interface SetupEngine {
  /** Every message in the live window, in order. */
  messages(): readonly Message[];
  /** The window truncated after the most recent user turn. */
  messagesThroughLastUserTurn(): Message[];
  /** How many archived segments exist. Non-zero means context was compacted
   *  away, which the prompt needs to know to anchor the first turn in time. */
  segmentCount(): number;
}

/** One-shot parameter overrides a client attached to a single message. */
export interface MessageOverrides {
  temperature?: number;
  top_p?: number;
  /** Enables extended thinking with this budget. */
  thinking_budget?: number;
}

/** No model could be resolved for this turn. */
export class NoModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoModelError";
  }
}

/**
 * Resolve the model this generation runs on, and apply any per-model sampler
 * overlay.
 *
 * `activeModel` and `overlay` are the pair `resolveActiveModelAndOverlay` returns
 * — kept apart there rather than merged, so the overlay reaching
 * {@link applySamplerOverlay} here holds only what preferences set.
 *
 * `activeModel` is the model preference resolution already picked, and it is
 * passed through rather than re-resolved on purpose: a discovered-only model has
 * a synthetic `chat.<provider>.<model_id>` qualified name that
 * {@link findEffectiveModel} does not accept as *input*, so re-resolving it
 * would fail on exactly the models discovery exists to reach.
 *
 * With no such model, the configured `defaults.model` is looked up with hidden
 * models included — an app default is user configuration rather than a
 * discovery-cache selection, so `discovery.ignore` should not silently make a
 * name the user typed unreachable, but a *misspelled* one should still say so
 * rather than quietly becoming the first model in the catalog.
 */
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
      if (first === undefined) throw new NoModelError("No model configured");
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
  /** The image-resize ladder, for cache warming and encoding. */
  resize?: CachedResize;
  /** Pinned by the parity replay; defaults to the host's, as `chrono::Local` did. */
  timeZone?: string;
}

/**
 * Assemble the prompt, warm the image cache, and build the request.
 *
 * The API key is left empty: the credential-fallback wrapper resolves and
 * rewrites it just-in-time during rotation, so baking one in here would be a key
 * that goes stale between assembly and send. The caller sets `rid` and the
 * forensic character on the way out.
 *
 * A regen sends history *through the last user turn* rather than all of it, so
 * the assistant turn being regenerated is not also in the prompt — otherwise the
 * model would continue past the answer instead of giving a different one.
 */
export async function buildGenerationRequest(
  params: BuildGenerationRequestParams,
): Promise<BuiltRequest> {
  const { engine, config, resolved, charName } = params;

  const messages = params.regen
    ? engine.messagesThroughLastUserTurn()
    : [...engine.messages()];
  const hasPriorContext = engine.segmentCount() > 0;

  // Filter the live MCP surface by the character's `enabled_tools` allowlist —
  // exact names or `mcp__server__*` globs. Appended last, which is what keeps
  // the static prefix stable when a server connects or drops.
  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(config.app.tools.enabled_tools);

  const prepared = await prepareChatContext({
    character: charName,
    characterDataDir: characterDataDir(params.dataDir, charName),
    config,
    resolved,
    messages,
    hasPriorContext,
    mcpToolDefs,
    ...(params.resize === undefined ? {} : { resize: params.resize }),
    ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
  });

  await warmImageCache(
    prepared.prompt.messages,
    config.app.advanced.max_image_size,
    config.dirs.cache,
  );

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

/**
 * Apply a client's one-shot overrides, last.
 *
 * Each field is independent: setting `top_p` alone must leave the model's own
 * temperature in place rather than clearing it. `thinking_budget` creates
 * `provider_options` when the model had none, which is the one case that is not
 * a plain field write.
 */
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
