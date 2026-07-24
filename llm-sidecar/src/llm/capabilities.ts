/**
 * Model capability matrix — typed accessors over the SINGLE SOURCE OF TRUTH
 * `crates/common/capabilities.toml`, which `bun build` inlines into the sidecar
 * bundle (so this is compiled in, not read from disk at runtime).
 *
 * The Rust daemon reads the same file (`crates/common/src/config/capabilities.rs`); the
 * model parser + rule evaluator here mirror the Rust ones, kept in lockstep by
 * the cross-language parity fixtures (this module's tests + the Rust tests).
 *
 * Each adapter calls into here instead of hand-coding effort/thinking tables.
 */

// Bun resolves this `.toml` import at build time and inlines the parsed object.
import rawCaps from "../../../crates/common/capabilities.toml";

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
 *  `rejects_sampling`. Exported for the cross-language parity fixture; the
 *  sidecar receives requests with samplers already stripped by the daemon, so no
 *  adapter calls this. */
export function rejectsSampling(model: string): boolean {
  return claudeRejectsSampling(model) || modelOverrideRejectsSampling(model);
}
