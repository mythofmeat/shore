/**
 * Deciding whether a failure means "try the next API key".
 *
 * Ported from `crates/daemon/src/llm/credentials.rs`, pinned by
 * `tests/llm_fixtures/llm_decisions_parity.json`.
 *
 * A provider can declare ordered named keys. When a request fails in a
 * credential-shaped way — key missing or rejected, quota or account budget
 * exhausted, a rate limit clearly scoped to this key — the caller abandons that
 * key and retries the same request with the next one. Everything else is left
 * to the retry policy.
 *
 * # Both directions of a wrong answer cost something
 *
 * Classifying a real credential failure as transient means retrying a key that
 * cannot work, three times, and then failing the turn with a key still unused.
 * Classifying a *transient* failure as credential-shaped means burning through
 * every configured key on what was a passing 503, and arriving at
 * "all keys exhausted" when nothing was wrong with any of them. The classifier
 * is deliberately conservative in the second direction: a generic 429 is not a
 * credential failure, because those are usually global bursts.
 *
 * Secrets never leave this module's caller: candidates carry the *name* of an
 * env var, and only friendly key names reach a client.
 */

import type { LlmError } from "./errors";

/** How a failure looks from the perspective of key rotation. */
export type CredentialFailureKind =
  | "missing_key"
  | "invalid_key"
  | "quota_exhausted"
  | "budget_exhausted"
  | "rate_limited_credential"
  | "not_credential_failure"
  | "unknown";

/**
 * Whether this kind warrants rotating to the next configured key.
 *
 * Note that `unknown` rotates. The Rust defined it as "credential-adjacent but
 * not confidently classifiable", and chose to let it through — everything
 * except an outright `not_credential_failure` is eligible.
 */
export function shouldRotate(kind: CredentialFailureKind): boolean {
  return kind !== "not_credential_failure";
}

/**
 * Classify a failure for the multi-key fallback path.
 *
 * `providerKey` is informational. The Rust took it and ignored it, wired in so
 * provider-specific tweaks had somewhere to land; kept for the same reason.
 */
export function classifyCredentialFailure(
  _providerKey: string,
  error: LlmError,
): CredentialFailureKind {
  switch (error.kind) {
    case "missing_api_key":
      return "missing_key";
    case "http_status":
      return classifyHttp(error.status, error.body);
    // A stream that died mid-flight must not rotate: the provider already
    // accepted the credential, and the user may have seen partial output.
    case "incomplete_stream":
    case "stream_errored":
      return "not_credential_failure";
    // Transport, serde and refusals are not credential failures. A generic
    // provider error is too vague to rotate on.
    case "transport":
    case "serialize":
    case "deserialize":
    case "refusal":
    case "provider":
      return "not_credential_failure";
  }
}

function classifyHttp(status: number, body: string): CredentialFailureKind {
  const bodyLc = body.toLowerCase();

  switch (status) {
    // The credential was rejected — unless the body says it was accepted and
    // simply out of quota, which some providers report as a 403.
    case 401:
    case 403:
      return mentionsQuota(bodyLc) ? "quota_exhausted" : "invalid_key";

    // OpenRouter and Stripe-backed gateways use this for account budget.
    case 402:
      return "budget_exhausted";

    // A 429 needs the body to disambiguate, and the order of these three
    // checks is the behaviour: a body naming both budget and quota is budget.
    case 429:
      if (mentionsBudget(bodyLc)) return "budget_exhausted";
      if (mentionsQuota(bodyLc)) return "quota_exhausted";
      if (mentionsCredentialRateLimit(bodyLc)) return "rate_limited_credential";
      // Plain 429 — a global burst, not this key's problem.
      return "not_credential_failure";

    // Loose gateways put credential signals behind a 400. Invalid-credential
    // is checked before quota, so a body mentioning both is invalid_key.
    case 400:
      if (mentionsInvalidCredential(bodyLc)) return "invalid_key";
      if (mentionsQuota(bodyLc)) return "quota_exhausted";
      return "not_credential_failure";

    // 5xx and everything else.
    default:
      return "not_credential_failure";
  }
}

function mentionsQuota(bodyLc: string): boolean {
  return (
    bodyLc.includes("quota") ||
    bodyLc.includes("insufficient_quota") ||
    bodyLc.includes("usage limit") ||
    bodyLc.includes("monthly limit")
  );
}

function mentionsBudget(bodyLc: string): boolean {
  return (
    bodyLc.includes("budget") ||
    bodyLc.includes("payment required") ||
    bodyLc.includes("insufficient_funds") ||
    bodyLc.includes("credit")
  );
}

function mentionsCredentialRateLimit(bodyLc: string): boolean {
  // A 429 that names the key or the account is credential-scoped. Plain
  // "rate limit" wording deliberately is not — those are global bursts, and
  // rotating on them would walk every key for nothing.
  return (
    bodyLc.includes("account_rate_limit") ||
    bodyLc.includes("per-key rate") ||
    bodyLc.includes("api key rate")
  );
}

function mentionsInvalidCredential(bodyLc: string): boolean {
  return (
    bodyLc.includes("invalid_api_key") ||
    bodyLc.includes("invalid api key") ||
    bodyLc.includes("authentication_error") ||
    bodyLc.includes("authentication failed") ||
    bodyLc.includes("unauthorized")
  );
}

// ── Key candidates ──────────────────────────────────────────────────────────

/** One candidate key: a friendly name, and the env var holding the value. */
export interface KeyCandidate {
  /** Surfaced to clients on fallback. Never the value. */
  name: string;
  /** Env var to read just before the attempt. */
  env: string;
  /** Whether falling away from this key should warn the user visibly. */
  warn_on_fallback: boolean;
}

/** One key as a provider entry declares it. */
export interface ProviderKeyEntry {
  name: string;
  env: string;
  enabled: boolean;
  warn_on_fallback: boolean;
}

/**
 * A `[providers.<key>]` entry, normalized.
 *
 * The Rust took a whole `ProviderRegistry` and looked the entry up itself.
 * Taking the entry directly is the one deliberate simplification in this port:
 * the registry is a config-module concern (parsing the `[providers]` TOML
 * section) and nothing in the resolution logic needs the rest of it. `undefined`
 * means the provider has no entry at all, which is different from having a
 * disabled one.
 */
export interface ProviderEntry {
  enabled: boolean;
  keys: ProviderKeyEntry[];
}

/**
 * The conventional env var for a provider that declares nothing.
 *
 * An unrecognised provider gets `LLM_API_KEY` rather than an error — a
 * provider added to `models.toml` and nowhere else still has somewhere to read
 * a key from.
 */
export function defaultApiKeyEnv(providerKey: string): string {
  switch (providerKey) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "zhipuai":
      return "ZHIPUAI_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "moonshot":
    case "moonshotai":
      return "MOONSHOT_API_KEY";
    case "xai":
      return "XAI_API_KEY";
    case "zai":
      return "ZAI_API_KEY";
    case "nanogpt":
      return "NANOGPT_API_KEY";
    case "opencode-go":
      return "OPENCODE_API_KEY";
    default:
      return "LLM_API_KEY";
  }
}

/**
 * The ordered keys to try for a provider.
 *
 * Three outcomes, and the middle one is the subtle one:
 *
 * 1. A provider entry that is **disabled** resolves to nothing. The caller
 *    treats an empty list as a hard failure without rotating.
 * 2. An entry with any **enabled** keys gives those, in configured order.
 *    Disabled ones are filtered out here rather than earlier, so they stay
 *    visible to anything inspecting the registry.
 * 3. Everything else — no entry, or an enabled entry declaring no usable keys —
 *    synthesizes a single `"default"` candidate. That third case is why an
 *    entry added purely for `sdk`/`base_url`/discovery does not break a model
 *    whose `api_key_env` was already working, and why an entry whose only key
 *    is disabled falls back rather than resolving to nothing.
 *
 * `fallbackApiKeyEnv` mirrors a static model's `api_key_env`; `undefined` uses
 * {@link defaultApiKeyEnv}.
 */
export function resolveKeyCandidates(
  providerKey: string,
  entry: ProviderEntry | undefined,
  fallbackApiKeyEnv?: string,
): KeyCandidate[] {
  if (entry !== undefined) {
    if (!entry.enabled) return [];
    const candidates = entry.keys
      .filter((k) => k.enabled)
      .map((k) => ({ name: k.name, env: k.env, warn_on_fallback: k.warn_on_fallback }));
    if (candidates.length > 0) return candidates;
    // Enabled but with nothing usable — fall through to the legacy single key.
  }

  return [
    {
      name: "default",
      env: fallbackApiKeyEnv ?? defaultApiKeyEnv(providerKey),
      warn_on_fallback: false,
    },
  ];
}

/**
 * Read a candidate's env var. Unset, empty and whitespace-only are all
 * "not configured" — `KEY=` is how a shell half-unsets something, and treating
 * it as a real value would send an empty credential to the provider and read
 * the 401 back as a rejected key.
 *
 * A value with surrounding whitespace is returned *as-is*, not trimmed: only
 * the emptiness test trims.
 */
export function readCandidateEnv(
  candidate: KeyCandidate,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[candidate.env];
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}
