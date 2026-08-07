/**
 * Model capability matrix — typed accessors over the SINGLE SOURCE OF TRUTH
 * `capabilities.toml` beside this file, which `bun build` inlines into the
 * sidecar bundle (so this is compiled in, not read from disk at runtime).
 *
 * It used to live in `crates/common/` and be read by both languages. Rust's
 * reader went with the config layer in #29, so this is now the only consumer
 * and the file moved here to match. `capability_parity_fixture.toml` came
 * along to `tests/`; nothing cross-language is left to keep in lockstep, and
 * the fixture now pins this parser against its own frozen expectations.
 *
 * Each adapter calls into here instead of hand-coding effort/thinking tables.
 */

// Bun resolves this `.toml` import at build time and inlines the parsed object.
import rawCaps from "./capabilities.toml";

import { parseCacheKeepalive } from "../config/models.ts";

export type Sdk =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "gemini"
  | "zai"
  | "deepseek"
  | "moonshot";
type ClaudeFamily = "opus" | "sonnet" | "haiku";

interface SdkEffort {
  domain: readonly string[];
  fold?: Record<string, string>;
  budget?: Record<string, number>;
}

interface ModelOverride {
  match: string;
  reasoning_effort?: readonly string[];
  rejects_sampling?: boolean;
}

interface ClaudeRule {
  contains?: string;
  family?: string;
  min_major?: number;
  min_minor?: number;
  max_major?: number;
  max_minor?: number;
  adaptive?: boolean;
  enabled?: boolean;
  rejects_sampling?: boolean;
}

interface CapabilitiesDoc {
  reasoning_effort: {
    anthropic: SdkEffort;
    openai: SdkEffort;
    openrouter: SdkEffort;
    gemini: SdkEffort;
    zai: SdkEffort;
    deepseek: SdkEffort;
    moonshot: SdkEffort;
  };
  claude: {
    default_adaptive: boolean;
    default_enabled: boolean;
    default_rejects_sampling: boolean;
    thinking_rule?: ClaudeRule[];
    sampler_rule?: ClaudeRule[];
  };
  // Per-model capability overlay for the OpenRouter passthrough (issue #164).
  model_override?: ModelOverride[];
}

const caps = rawCaps as CapabilitiesDoc;

function sdkEffort(sdk: Sdk): SdkEffort {
  switch (sdk) {
    case "anthropic":
      return caps.reasoning_effort.anthropic;
    case "openai":
      return caps.reasoning_effort.openai;
    case "openrouter":
      return caps.reasoning_effort.openrouter;
    case "gemini":
      return caps.reasoning_effort.gemini;
    case "zai":
      return caps.reasoning_effort.zai;
    case "deepseek":
      return caps.reasoning_effort.deepseek;
    case "moonshot":
      return caps.reasoning_effort.moonshot;
  }
}

// ── reasoning_effort ─────────────────────────────────────────────────────────

/** Accepted reasoning_effort values for an sdk, honoring a per-model override
 *  (first whose `match` is a substring of `modelId` wins). */
export function reasoningDomain(sdk: Sdk, modelId?: string): readonly string[] {
  if (modelId !== undefined) {
    const lower = modelId.toLowerCase();
    for (const ov of caps.model_override ?? []) {
      if (ov.reasoning_effort && lower.includes(ov.match.toLowerCase())) return ov.reasoning_effort;
    }
  }
  return sdkEffort(sdk).domain;
}

/** The wire value to send for `effort` on `sdk` (applies the fold map; identity
 *  for in-domain values without a fold), or `undefined` if out of domain. */
export function foldEffort(sdk: Sdk, effort: string, modelId?: string): string | undefined {
  if (!reasoningDomain(sdk, modelId).includes(effort)) return undefined;
  return sdkEffort(sdk).fold?.[effort] ?? effort;
}

/** Anthropic "enabled"-mode `budget_tokens` for a named effort (default 8192). */
export function effortBudget(effort: string): number {
  return caps.reasoning_effort.anthropic.budget?.[effort] ?? 8192;
}

/** The Gemini thinkingLevel name for `effort` (case-insensitive), or undefined. */
export function geminiLevelName(effort: string): string | undefined {
  const e = effort.toLowerCase();
  return reasoningDomain("gemini").includes(e) ? e : undefined;
}

// ── Claude version rules ─────────────────────────────────────────────────────

interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number;
}

/** Mirror of the Rust `parse_claude_version`: see that doc-comment. */
export function parseClaudeModel(modelId: string): ClaudeVersion | undefined {
  const slash = modelId.lastIndexOf("/");
  const lower = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();

  // Tokenize on non-alphanumeric boundaries: require a distinct `claude` token
  // (an id that merely contains "opus"/"sonnet"/"haiku" is not a Claude model)
  // plus a family token. Mirrors Rust `parse_claude_version`.
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.includes("claude")) return undefined;

  let family: ClaudeFamily | undefined;
  if (tokens.includes("opus")) family = "opus";
  else if (tokens.includes("sonnet")) family = "sonnet";
  else if (tokens.includes("haiku")) family = "haiku";
  else return undefined;

  let major: number | undefined;
  let minor = 0;
  for (const tok of tokens) {
    if (tok.length > 2 || !/^[0-9]+$/.test(tok)) continue;
    const n = Number.parseInt(tok, 10);
    if (Number.isNaN(n)) continue;
    if (major === undefined) major = n;
    else {
      minor = n;
      break;
    }
  }
  if (major === undefined) return undefined;
  return { family, major, minor };
}

function familyInSet(set: string, family: ClaudeFamily): boolean {
  return set.split("|").includes(family);
}

function ruleMatches(rule: ClaudeRule, idLower: string, v: ClaudeVersion | undefined): boolean {
  if (rule.contains !== undefined && !idLower.includes(rule.contains)) return false;
  const needsVersion =
    rule.family !== undefined || rule.min_major !== undefined || rule.max_major !== undefined;
  if (needsVersion) {
    if (v === undefined) return false;
    if (rule.family !== undefined && !familyInSet(rule.family, v.family)) return false;
    if (rule.min_major !== undefined) {
      const minMinor = rule.min_minor ?? 0;
      if (v.major < rule.min_major || (v.major === rule.min_major && v.minor < minMinor)) return false;
    }
    if (rule.max_major !== undefined) {
      const maxMinor = rule.max_minor ?? Number.MAX_SAFE_INTEGER;
      if (v.major > rule.max_major || (v.major === rule.max_major && v.minor > maxMinor)) return false;
    }
  }
  return rule.contains !== undefined || needsVersion;
}

/** Anthropic per-model thinking-mode capability. Mirrors Rust `claude_thinking_caps`. */
export function claudeThinkingCaps(model: string): { adaptive: boolean; enabled: boolean } {
  const lower = model.toLowerCase();
  const v = parseClaudeModel(model);
  for (const rule of caps.claude.thinking_rule ?? []) {
    if (ruleMatches(rule, lower, v)) {
      return {
        adaptive: rule.adaptive ?? caps.claude.default_adaptive,
        enabled: rule.enabled ?? caps.claude.default_enabled,
      };
    }
  }
  return { adaptive: caps.claude.default_adaptive, enabled: caps.claude.default_enabled };
}

/** Whether the model's wire rejects sampler knobs via the Claude version cutoff.
 *  Mirrors Rust `claude_rejects_sampling`. */
export function claudeRejectsSampling(model: string): boolean {
  const lower = model.toLowerCase();
  const v = parseClaudeModel(model);
  for (const rule of caps.claude.sampler_rule ?? []) {
    if (ruleMatches(rule, lower, v)) {
      return rule.rejects_sampling ?? caps.claude.default_rejects_sampling;
    }
  }
  return caps.claude.default_rejects_sampling;
}

/** Whether a `[[model_override]]` flags the model's underlying vendor as
 *  rejecting samplers (the OpenRouter passthrough case, issue #164). Mirrors
 *  Rust `model_override_rejects_sampling`. */
export function modelOverrideRejectsSampling(model: string): boolean {
  const lower = model.toLowerCase();
  for (const ov of caps.model_override ?? []) {
    if (ov.rejects_sampling !== undefined && lower.includes(ov.match.toLowerCase())) {
      return ov.rejects_sampling;
    }
  }
  return false;
}

/** Whether the model's wire rejects sampler knobs (`temperature` / `top_p`),
 *  from the Claude >=4.7 cutoff OR a per-model override. Mirrors Rust
 *  `rejects_sampling`. No adapter calls this — requests arrive with samplers
 *  already stripped, because {@link applicability} strips them during catalog
 *  resolution, which is the caller. */
export function rejectsSampling(model: string): boolean {
  return claudeRejectsSampling(model) || modelOverrideRejectsSampling(model);
}

// ── The applicability matrix ─────────────────────────────────────────────────

/** How an sdk treats a config field. Mirrors Rust `Applicability`. */
export type Applicability =
  /** Accepted and acted on. */
  | "honored"
  /** Silently dropped upstream: harmless, but not useful. */
  | "ignored"
  /** Sending it is an upstream 400; catalog resolution drops it first. */
  | "rejected";

/**
 * The settable knobs — the non-transport subset of `ModelConfigFields`.
 *
 * Rust models this as an enum with a `key()` returning the TOML name; here the
 * TOML name *is* the type, so `key()` is the identity and `from_key` is
 * {@link fieldFromKey}.
 */
export type Field =
  | "max_context_tokens"
  | "max_output_tokens"
  | "temperature"
  | "top_p"
  | "reasoning_effort"
  | "budget_tokens"
  | "cache_ttl"
  | "cache_keepalive"
  | "openrouter_provider"
  | "gemini_generation"
  | "zai_clear_thinking"
  | "zai_subscription"
  | "replay_prior_thinking";

const FIELDS: readonly Field[] = [
  "max_context_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning_effort",
  "budget_tokens",
  "cache_ttl",
  "cache_keepalive",
  "openrouter_provider",
  "gemini_generation",
  "zai_clear_thinking",
  "zai_subscription",
  "replay_prior_thinking",
];

/** A TOML key as a {@link Field}, or `undefined` for keys the matrix has no
 *  opinion about (Shore-only behaviors like `max_tool_iterations`, or transport
 *  like `sdk`) — which callers treat as "always applicable". */
export function fieldFromKey(key: string): Field | undefined {
  return (FIELDS as readonly string[]).includes(key) ? (key as Field) : undefined;
}

/** `honored` on the owning sdk, `ignored` everywhere else. */
function vendorField(sdk: Sdk, owner: Sdk): Applicability {
  return sdk === owner ? "honored" : "ignored";
}

/**
 * How `sdk` (resolving `modelId`) treats `field`. Mirrors Rust `applicability`.
 *
 * `modelId` matters only for the Claude sampler cutoff; every other rule
 * ignores it.
 */
export function applicability(sdk: Sdk, modelId: string, field: Field): Applicability {
  switch (field) {
    // Generic knobs every sdk understands. `cache_keepalive` is a daemon-side
    // scheduling cadence rather than a wire field, so it is meaningful for any
    // provider with a cache; the sdk only changes its default.
    case "max_context_tokens":
    case "max_output_tokens":
    case "cache_keepalive":
      return "honored";

    // Honored on every sdk, but the accepted value set differs — Moonshot and
    // Z.AI only take an on/off toggle. See `reasoningDomain`.
    case "reasoning_effort":
      return "honored";

    // The cutoff follows the model id, not the sdk: the same model is reachable
    // through several sdks and every adapter forwards these verbatim.
    case "temperature":
    case "top_p":
      return rejectsSampling(modelId) ? "rejected" : "honored";

    // Read by the Anthropic, Gemini and Moonshot wires only. On Anthropic it
    // follows the same Claude >=4.7 cutoff as the samplers.
    case "budget_tokens":
      return budgetTokensApplicability(sdk, modelId);

    // `cache_ttl` only produces `cache_control` blocks on the Anthropic sdk.
    case "cache_ttl":
      return vendorField(sdk, "anthropic");

    case "openrouter_provider":
      return vendorField(sdk, "openrouter");

    case "gemini_generation":
      return vendorField(sdk, "gemini");

    case "zai_clear_thinking":
    case "zai_subscription":
      return vendorField(sdk, "zai");

    // Honored wherever an adapter puts surviving thinking blocks on the wire.
    // Ignored on Gemini (no reasoning-replay surface) and on native
    // DeepSeek/Moonshot, where the provider contract forces full replay
    // regardless, so the knob can change nothing.
    case "replay_prior_thinking":
      return replayApplicability(sdk);
  }
}

function budgetTokensApplicability(sdk: Sdk, modelId: string): Applicability {
  switch (sdk) {
    case "anthropic":
      return claudeRejectsSampling(modelId) ? "rejected" : "honored";
    case "gemini":
    case "moonshot":
      return "honored";
    case "openai":
    case "openrouter":
    case "zai":
    case "deepseek":
      return "ignored";
  }
}

function replayApplicability(sdk: Sdk): Applicability {
  switch (sdk) {
    case "anthropic":
    case "openai":
    case "zai":
    case "openrouter":
      return "honored";
    case "gemini":
    case "deepseek":
    case "moonshot":
      return "ignored";
  }
}

/**
 * The code-level default for `field` under `sdk` in its TOML string form, or
 * `undefined` when the sdk has no default. Mirrors Rust `default_value`.
 *
 * This is the **lowest** tier of the cascade: it fills a field only when
 * nothing above it did.
 */
export function defaultValue(sdk: Sdk, field: Field): string | undefined {
  if (sdk !== "anthropic") return undefined;
  // Prompt caching is opt-in on the wire, and defaulting it on means users get
  // caching without explicit config (`cache_ttl = ""` disables). The paid 1h
  // tier is then worth keeping warm. Every other sdk leaves both off: their
  // cache lifetimes are opaque and carry no write surcharge to amortize, so a
  // default ping would be pure spend.
  if (field === "cache_ttl") return "1h";
  if (field === "cache_keepalive") return "55m";
  return undefined;
}

// ── the write boundary ───────────────────────────────────────────────────────

/**
 * Whether the `reasoning_effort = "off"` sentinel is HONORED for this sdk —
 * i.e. some adapter actually suppresses reasoning when it sees it.
 *
 * - `anthropic` — omitting the thinking params yields a non-thinking request.
 * - `deepseek` / `moonshot` / `zai` — `thinking.type = "disabled"`.
 * - `openrouter` — `reasoning.effort = "none"`, a real off-switch for the
 *   always-on vendors it fronts. A few thinking-only endpoints reject it at
 *   runtime; a documented limitation.
 *
 * `openai` and `gemini` have no disable path — reasoning is model-mandatory or
 * left at the model default — so `"off"` there would be a silent no-op.
 * {@link validate} uses this to reject it at the boundary instead, which the
 * plain domain check cannot do: `"off"` is absent from the graded domains, so
 * without this it would be rejected everywhere including the sdks that honor it.
 */
export function supportsReasoningOff(sdk: Sdk): boolean {
  return sdk === "anthropic" || sdk === "deepseek" || sdk === "moonshot" || sdk === "openrouter" || sdk === "zai";
}

/** Why a setting was rejected at the boundary. Mirrors Rust `CapabilityError`. */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * Reject a setting the model's resolved sdk cannot honor, before it reaches the
 * preferences file and later the wire.
 *
 * `probe` is the caller's value **already collapsed**: the string itself when
 * the domain matters, or `true` standing in for "some non-string value". That
 * collapse belongs to the caller (Rust built a `toml::Value` for the same
 * reason), and it has one visible consequence the fixture pins — a non-string
 * `cache_keepalive` is reported as being the value `"true"`, because the message
 * prints the probe rather than what the user typed.
 *
 * A field the sdk ignores or rejects is inapplicable: you cannot usefully set
 * something that will be dropped. Only `reasoning_effort` and `cache_keepalive`
 * have a value domain; every other honored field accepts any well-typed value.
 */
export function validate(
  sdk: Sdk,
  modelId: string,
  field: Field,
  probe: string | true,
): CapabilityError | undefined {
  if (applicability(sdk, modelId, field) !== "honored") {
    return new CapabilityError(`\`${field}\` is not applicable to the \`${sdk}\` sdk for this model`);
  }

  const outOfDomain = (value: string, allowed: string) =>
    new CapabilityError(`\`${field}\` value ${JSON.stringify(value)} is out of domain; allowed: ${allowed}`);

  if (field === "reasoning_effort" && probe !== true) {
    const domain = reasoningDomain(sdk, modelId);
    if (!domain.includes(probe)) return outOfDomain(probe, domain.join(", "));
  }

  if (field === "cache_keepalive") {
    const allowed = "off, or a duration string like 55m / 6h / 30s";
    // A non-string only fails at the next config load, so reject it here rather
    // than persisting a setting the daemon cannot read back.
    if (probe === true) return outOfDomain("true", allowed);
    if ("err" in parseCacheKeepalive(probe)) return outOfDomain(probe, allowed);
  }

  return undefined;
}
