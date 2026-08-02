/**
 * Building an outbound LLM request from a resolved model profile.
 *
 * Ported from `crates/daemon/src/llm/mod.rs`, pinned by
 * `tests/llm_fixtures/request_parity.json`.
 *
 * A {@link ResolvedModel} is the end of config resolution — catalog entry,
 * provider registry, and the runtime preference overlay already merged. This
 * turns one into the request that goes to a provider: credential resolved,
 * sampler knobs mapped, provider-specific options derived, orphaned tool blocks
 * stripped.
 *
 * # Three entry points, because credential resolution differs
 *
 * - {@link buildRequestWithResolvedKey} takes the key as a string. It is the
 *   shared core, and the only one the rotation path calls — that path resolves
 *   candidates itself so it can rotate on a *missing* env var as readily as on
 *   a rejected key.
 * - {@link buildRequestWithProviderKeys} walks the provider registry's ordered
 *   key list. This is the right entry point for non-streaming callers, which
 *   otherwise silently ignore `[providers.<name>].keys`.
 * - {@link buildRequest} is the single-key path: the model's `api_key_env`, or
 *   the provider's conventional variable.
 *
 * # `off` is not an effort
 *
 * `reasoning_effort = "off"` is a sentinel, not a value. It becomes
 * `thinking_enabled: false` so the OpenRouter adapter can send
 * `reasoning: { effort: "none" }` and actually turn thinking off on an
 * always-on reasoning model, while every other adapter simply omits reasoning.
 * The comparison is case-sensitive, so `"OFF"` passes through as a literal
 * effort — pinned, because it is the kind of thing a port "helpfully" fixes.
 */

import { defaultApiKeyEnv, readCandidateEnv, resolveKeyCandidates } from "./credentials";
import type { ProviderEntry } from "./credentials";
import { sanitizeToolPairs } from "./sanitize";
import type {
  GenerateResponse,
  ProviderOptions,
  Sdk,
  SidecarRequest,
  ThinkingReplay,
  WireMessage,
} from "./types";
import type { ContentBlock } from "../engine/types";
import { rustTrim } from "../memory/lines";

/** Wire default when a model declares no output cap. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * A model profile after config resolution.
 *
 * Mirrors Rust `ResolvedModel`. Only the fields the request builder reads are
 * modelled; the rest of that struct is catalog bookkeeping.
 */
export interface ResolvedModel {
  name: string;
  qualified_name: string;
  category: string;
  provider_key: string;
  sdk: Sdk;
  model_id: string;
  api_key_env?: string;
  base_url?: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  budget_tokens?: number;
  cache_ttl?: string;
  /** `"off"` or a duration string (`"55m"`). Absent inherits the sdk default. */
  cache_keepalive?: string;
  openrouter_provider?: unknown;
  gemini_generation?: number;
  zai_clear_thinking?: boolean;
  zai_subscription?: boolean;
  max_tool_iterations?: number;
}

/**
 * A built request, plus the daemon-side fields that never reach a provider.
 *
 * `keepalive_interval` is `#[serde(skip)]` in the Rust for a reason worth
 * keeping: it is a scheduling hint the autonomy manager reads back off the
 * cached `last_request`, not something a provider should ever see. Modelling it
 * outside {@link SidecarRequest} keeps it structurally impossible to serialize
 * by accident.
 */
export interface BuiltRequest {
  request: SidecarRequest;
  /** Which configured key this used, for diagnostics. Never the key itself. */
  api_key_name?: string;
  /** Keepalive cadence in milliseconds; absent means keepalive is off. */
  keepalive_interval_ms?: number;
}

/** A credential could not be resolved. Carries the variable name, never a value. */
export class MissingApiKey extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`API key environment variable ${variable} is not set`);
    this.name = "MissingApiKey";
    this.variable = variable;
  }
}

// ── Provider tables ─────────────────────────────────────────────────────

/**
 * The conventional base URL for a provider, when one is well-known.
 *
 * Absent for providers whose endpoint is deployment-specific — custom
 * OpenAI-compatible upstreams, on-prem — which must set `base_url` explicitly.
 */
export function defaultBaseUrl(providerKey: string): string | undefined {
  switch (providerKey) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "deepseek":
      return "https://api.deepseek.com";
    case "moonshot":
    case "moonshotai":
      return "https://api.moonshot.ai/v1";
    case "xai":
      return "https://api.x.ai/v1";
    // Z.AI's standard OpenAI-compatible endpoint, used for discovery only —
    // chat routes through the Z.AI adapter, which owns its own base URL and
    // the subscription-endpoint switch.
    case "zai":
      return "https://api.z.ai/api/paas/v4";
    case "opencode-go":
      return "https://opencode.ai/zen/go/v1";
    default:
      return undefined;
  }
}

/**
 * Whether the provider's thinking-mode API rejects requests that omit
 * `reasoning_content` from prior assistant turns.
 *
 * DeepSeek V3.1+ and Moonshot's Kimi-thinking enforce this: stripping thinking
 * from history for them produces a 400 reading *"reasoning_content in the
 * thinking mode must be passed back to the API"*. This is a hint about shaping
 * prompt history, not a wire rule — the adapters own request conversion.
 */
export function requiresReasoningReplay(providerKey: string): boolean {
  return providerKey === "deepseek" || providerKey === "moonshot" || providerKey === "moonshotai";
}

// ── Provider options ────────────────────────────────────────────────────

/**
 * Derive the provider knobs from a model profile, or `undefined` when it sets
 * none — so the key is omitted rather than sent as an empty object.
 */
export function providerOptionsFor(model: ResolvedModel): ProviderOptions | undefined {
  const disabled = model.reasoning_effort === "off";

  const options: ProviderOptions = {
    ...(!disabled && model.reasoning_effort !== undefined
      ? { reasoning_effort: model.reasoning_effort }
      : {}),
    ...(disabled ? { thinking_enabled: false } : {}),
    // A zero budget and a `false` flag are *set* fields, not absent ones:
    // `zai_clear_thinking: false` is what enables Preserved-Thinking replay.
    ...(model.budget_tokens !== undefined ? { budget_tokens: model.budget_tokens } : {}),
    ...(model.cache_ttl !== undefined ? { cache_ttl: model.cache_ttl } : {}),
    ...(model.openrouter_provider !== undefined && model.openrouter_provider !== null
      ? { openrouter_provider: model.openrouter_provider }
      : {}),
    ...(model.gemini_generation !== undefined
      ? { gemini_generation: model.gemini_generation }
      : {}),
    ...(model.zai_clear_thinking !== undefined
      ? { zai_clear_thinking: model.zai_clear_thinking }
      : {}),
    ...(model.zai_subscription !== undefined
      ? { zai_subscription: model.zai_subscription }
      : {}),
  };

  return Object.keys(options).length === 0 ? undefined : options;
}

// ── Request construction ────────────────────────────────────────────────

export interface BuildInputs {
  messages: WireMessage[];
  system?: SidecarRequest["system"];
  tools?: SidecarRequest["tools"];
  /** Overrides the model-derived options entirely when given. */
  providerOptions?: ProviderOptions;
  replay: ThinkingReplay;
}

/**
 * Build a request from an already-resolved credential.
 *
 * The shared core of all three entry points. Note that `max_tokens` has no
 * absent state on the wire: a model with no cap sends
 * {@link DEFAULT_MAX_TOKENS}, and an explicit `0` is *not* the same thing.
 */
export function buildRequestWithResolvedKey(
  model: ResolvedModel,
  apiKey: string,
  inputs: BuildInputs,
): BuiltRequest {
  const request: SidecarRequest = {
    sdk: model.sdk,
    model: model.model_id,
    api_key: apiKey,
    ...(model.base_url !== undefined ? { base_url: model.base_url } : {}),
    messages: inputs.messages,
    ...(inputs.system !== undefined ? { system: inputs.system } : {}),
    ...(inputs.tools !== undefined ? { tools: inputs.tools } : {}),
    max_tokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.top_p !== undefined ? { top_p: model.top_p } : {}),
    ...(() => {
      // A caller-supplied set replaces the derived one wholesale rather than
      // merging — the caller has already decided.
      const options = inputs.providerOptions ?? providerOptionsFor(model);
      return options === undefined ? {} : { provider_options: options };
    })(),
    provider_key: model.provider_key,
    replay_prior_thinking: inputs.replay,
  };

  const intervalMs = keepaliveIntervalMs(model.cache_keepalive);
  return {
    request,
    ...(intervalMs !== undefined ? { keepalive_interval_ms: intervalMs } : {}),
  };
}

/**
 * Parse a `cache_keepalive` setting into a cadence.
 *
 * This sees an *already resolved* setting, which is narrower than what a user
 * may write. `CacheKeepaliveSetting::parse` folded `none`/`disabled`/`false`/`0`
 * into a single `off` and rejected a zero-length interval outright — a zero
 * would re-arm the timer at `now` on every tick and spin a ping loop. So only
 * two shapes reach here: `"off"`, or a duration.
 *
 * Re-implementing those spellings would be code no input can reach, which is
 * how it started out and why the mutation testing flagged it.
 */
function keepaliveIntervalMs(setting: string | undefined): number | undefined {
  if (setting === undefined || setting === "off") return undefined;
  return parseDurationMs(setting);
}

/** `90s`, `55m`, `2h`, `1500ms` — the shapes `ConfigDuration` accepts. */
function parseDurationMs(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(raw);
  if (m === null) return undefined;
  const value = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return undefined;
  }
}

/**
 * Build a request, resolving the credential from a single environment variable.
 *
 * The model's `api_key_env` when set, otherwise the provider's conventional
 * variable. Callers with a provider registry available should prefer
 * {@link buildRequestWithProviderKeys}, which honours configured key lists.
 *
 * @throws {MissingApiKey} when the variable is unset.
 */
export function buildRequest(
  model: ResolvedModel,
  inputs: BuildInputs,
  env: NodeJS.ProcessEnv = process.env,
): BuiltRequest {
  const apiKeyEnv = model.api_key_env ?? defaultApiKeyEnv(model.provider_key);
  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") throw new MissingApiKey(apiKeyEnv);

  const built = buildRequestWithResolvedKey(model, apiKey, inputs);
  return { ...built, api_key_name: "default" };
}

/**
 * Build a request honouring the provider registry's ordered key list.
 *
 * Walks the candidates in configured order and takes the first whose variable
 * is set. A provider registered without a key list still resolves through the
 * legacy single-key candidate, so adding `[providers.x]` purely for `sdk` or
 * `base_url` does not break the models under it.
 *
 * @throws {MissingApiKey} when the provider is disabled, or when every
 * candidate's variable is unset — in which case the error names the *last*
 * variable tried, which is where the walk actually ended.
 */
export function buildRequestWithProviderKeys(
  model: ResolvedModel,
  entry: ProviderEntry | undefined,
  inputs: BuildInputs,
  env: NodeJS.ProcessEnv = process.env,
): BuiltRequest {
  const candidates = resolveKeyCandidates(model.provider_key, entry, model.api_key_env);

  if (candidates.length === 0) {
    // Explicitly disabled. Surfaced as a recognizable error rather than
    // falling through to an ambient environment lookup, which would quietly
    // re-enable a provider the user turned off.
    throw new MissingApiKey(`provider '${model.provider_key}' has no enabled keys`);
  }

  let lastEnv = candidates[0]?.env ?? "";
  for (const candidate of candidates) {
    const apiKey = readCandidateEnv(candidate, env);
    if (apiKey !== undefined) {
      const built = buildRequestWithResolvedKey(model, apiKey, inputs);
      return { ...built, api_key_name: candidate.name };
    }
    lastEnv = candidate.env;
  }

  throw new MissingApiKey(lastEnv);
}

// ── Preprocessing ───────────────────────────────────────────────────────

/**
 * The last thing that happens before a request goes out: strip orphaned
 * `tool_use` / `tool_result` blocks.
 *
 * Returns the original object unchanged when the conversation is clean, which
 * is the overwhelmingly common case and allocates nothing. The Rust expressed
 * that with `Cow::Borrowed`; identity is the same signal here, and the
 * fixture pins which cases take which branch.
 */
export function preprocessRequest(request: SidecarRequest): SidecarRequest {
  const cleaned = sanitizeToolPairs(request.messages);
  if (cleaned === undefined) return request;

  console.warn(
    `stripped orphan tool_use/tool_result blocks from outbound LLM request ` +
      `(${request.messages.length} messages -> ${cleaned.length})`,
  );
  return { ...request, messages: cleaned };
}

// ── Appending turns ─────────────────────────────────────────────────────

/**
 * Append a completed assistant turn, stamped with the provenance of the model
 * that produced it.
 *
 * Every tool loop in the daemon — chat, heartbeat, compaction, dreaming —
 * needs this between rounds, and each had its own copy. They had already
 * drifted: the heartbeat's lacked the `content` fallback, so a response that
 * arrived as plain text with no blocks vanished from its own history. One
 * implementation, so a fifth loop cannot drift again.
 *
 * A turn with neither blocks nor text is not appended at all: the API rejects
 * an empty content array, which would fail every later call in the loop. The
 * emptiness test is Rust's `trim`, not JavaScript's — see `memory/lines.ts`.
 *
 * The Rust also projected each stored `ContentBlock` onto a wire `WireBlock`
 * here, which is where a thinking block's opaque `orrd:`/`zair:` signature was
 * decoded into the field its provider actually reads. There is nothing to
 * project on this side: the adapters produce blocks with `reasoning_details` /
 * `reasoning_content` already populated, and `ContentBlock` is the one type
 * both halves use.
 */
export function pushAssistantTurn(request: SidecarRequest, resp: GenerateResponse): void {
  let content: ContentBlock[];
  if (resp.content_blocks.length === 0) {
    if (rustTrim(resp.content) === "") return;
    content = [{ type: "text", text: resp.content }];
  } else {
    content = resp.content_blocks;
  }
  // The spread is how an absent provider key stays absent rather than becoming
  // an explicit `undefined`. Nothing can tell the two apart today — the field
  // is `skip_serializing_if = "Option::is_none"` on the Rust side and
  // `JSON.stringify` drops `undefined` on this one, so both spellings produce
  // the same bytes, and mutation testing duly finds the difference unkillable.
  // It stays because `exactOptionalPropertyTypes` is on: writing the key
  // unconditionally needs a cast, and a cast here would be a cast that outlives
  // the reason for it.
  request.messages.push({
    role: "assistant",
    content,
    ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
    model: request.model,
  });
}

/**
 * Append an inline `role:"system"` turn at the tail.
 *
 * Used where an instruction has to sit at a fixed slot in the message list
 * rather than in the system prompt — compaction's, which must stay byte-stable
 * across its tool loop so chat's cache prefix keeps extending.
 */
export function pushInlineSystem(request: SidecarRequest, content: string): void {
  request.messages.push({ role: "system", content: [{ type: "text", text: content }] });
}
