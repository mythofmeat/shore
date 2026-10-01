import { toLlmError } from "./errors";
import { isZaiProvider } from "./providers/zai_config";

export const CREDENTIAL_FAILURE_KINDS = [
  "missing_key",
  "invalid_key",
  "quota_exhausted",
  "budget_exhausted",
  "rate_limited_credential",
  "not_credential_failure",
  "unknown",
] as const;

export type CredentialFailureKind =
  | "missing_key"
  | "invalid_key"
  | "quota_exhausted"
  | "budget_exhausted"
  | "rate_limited_credential"
  | "not_credential_failure"
  | "unknown";

export function shouldRotate(kind: CredentialFailureKind): boolean {
  return kind !== "not_credential_failure" && kind !== "unknown";
}

export function classifyCredentialFailure(
  _providerKey: string,
  raw: unknown,
): CredentialFailureKind {
  const error = toLlmError(raw);
  switch (error.kind) {
    case "missing_api_key":
      return "missing_key";
    case "http_status":
      return classifyHttp(error.status, error.body);
    case "incomplete_stream":
    case "stream_errored":
      return "not_credential_failure";
    case "transport":
    case "serialize":
    case "deserialize":
    case "provider":
      return "not_credential_failure";
    case "launch_failed":
    case "budget_blocked":
    case "aborted":
      return "not_credential_failure";
    default:
      return "unknown";
  }
}

function classifyHttp(status: number, body: string): CredentialFailureKind {
  const bodyLc = body.toLowerCase();

  switch (status) {
    case 401:
    case 403:
      return mentionsQuota(bodyLc) ? "quota_exhausted" : "invalid_key";

    case 402:
      return "budget_exhausted";

    case 429:
      if (mentionsBudget(bodyLc)) return "budget_exhausted";
      if (mentionsQuota(bodyLc)) return "quota_exhausted";
      if (mentionsCredentialRateLimit(bodyLc)) return "rate_limited_credential";
      return "not_credential_failure";

    case 400:
      if (mentionsInvalidCredential(bodyLc)) return "invalid_key";
      if (mentionsQuota(bodyLc)) return "quota_exhausted";
      return "not_credential_failure";

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

export interface KeyCandidate {
  name: string;
  env: string;
  warn_on_fallback: boolean;
}

export interface ProviderKeyEntry {
  name: string;
  env: string;
  enabled: boolean;
  warn_on_fallback: boolean;
}

export interface ProviderEntry {
  enabled: boolean;
  keys: ProviderKeyEntry[];
}

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
    case "nanogpt":
      return "NANOGPT_API_KEY";
    case "opencode-go":
      return "OPENCODE_API_KEY";
    default:
      return isZaiProvider(providerKey) ? "ZAI_API_KEY" : "LLM_API_KEY";
  }
}

const KEYLESS_SDKS = new Set<string>(["claude_agent"]);

export const KEYLESS_CANDIDATE: KeyCandidate = {
  name: "subscription",
  env: "",
  warn_on_fallback: false,
};

export function isKeylessSdk(sdk: string): boolean {
  return KEYLESS_SDKS.has(sdk);
}

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
  }

  return [
    {
      name: "default",
      env: fallbackApiKeyEnv ?? defaultApiKeyEnv(providerKey),
      warn_on_fallback: false,
    },
  ];
}

export function readCandidateEnv(
  candidate: KeyCandidate,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[candidate.env];
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}
