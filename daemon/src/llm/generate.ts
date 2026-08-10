import { budgetBlockFor } from "../ledger/gate.ts";
import { recordGenerate, recordGenerateError } from "../ledger/record.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ResolvedModel } from "../config/models.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { readCandidateEnv, resolveKeyCandidates } from "./credentials.ts";
import { MissingApiKey } from "./request.ts";
import {
  streamWithCredentialFallback,
  streamWithRetry,
  DEFAULT_RETRY,
  type FallbackEvent,
  type RetrySettings,
  type Sleep,
} from "./fallback.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "./types.ts";

export class BudgetBlocked extends Error {
  readonly kind = "budget_blocked" as const;
  readonly scope: string | undefined;

  constructor(message: string, scope?: string) {
    super(message);
    this.name = "BudgetBlocked";
    this.scope = scope;
  }
}

export interface GenerateDeps {
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  config: LoadedConfig;
  env?: NodeJS.ProcessEnv;
  sleep?: Sleep;
  retry?: RetrySettings;
  now?: () => number;
}

export interface KeySource {
  providerKey: string;
  apiKeyEnv?: string | undefined;
}

export interface GenerateOutcome {
  response: GenerateResponse;
  fallbacks: FallbackEvent[];
}

export function withResolvedCredential(
  request: SidecarRequest,
  config: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): SidecarRequest {
  const providerKey = request.provider_key ?? request.sdk;
  const entry = config.providers.get(providerKey);
  const candidates = resolveKeyCandidates(
    providerKey,
    entry === undefined ? undefined : credentialEntry(entry),
  );
  for (const candidate of candidates) {
    const apiKey = readCandidateEnv(candidate, env);
    if (apiKey !== undefined) return { ...request, api_key: apiKey };
  }
  if (request.api_key !== "") return request;
  throw new MissingApiKey(candidates[0]?.env ?? providerKey);
}

export function resolveModelForRequest(
  config: LoadedConfig,
  request: SidecarRequest,
): ResolvedModel | undefined {
  for (const model of config.models.chat.values()) {
    if (model.modelId !== request.model) continue;
    if (model.sdk !== request.sdk) continue;
    if (request.provider_key !== undefined && request.provider_key !== model.providerKey) continue;
    return model;
  }
  return undefined;
}

async function callProvider(
  request: SidecarRequest,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const provider = deps.providers[request.sdk];
  if (provider === undefined) throw new Error(`unsupported sdk: ${request.sdk}`);

  const blocked = budgetBlockFor(request);
  if (blocked) throw new BudgetBlocked(blocked.message, blocked.scope);

  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  try {
    const response = await provider.generate(request, signal);
    recordGenerate(request.context, request, response);
    return response;
  } catch (e) {
    recordGenerateError(request.context, request, startedAt, clock);
    throw e;
  }
}

export async function generateWithCredentialFallback(
  request: SidecarRequest,
  resolved: KeySource,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateOutcome> {
  const entry = deps.config.providers.get(resolved.providerKey);
  const candidates = resolveKeyCandidates(
    resolved.providerKey,
    entry === undefined ? undefined : credentialEntry(entry),
    resolved.apiKeyEnv,
  );

  const fallbacks: FallbackEvent[] = [];
  const response = await streamWithCredentialFallback(
    resolved.providerKey,
    candidates,
    (candidate) => readCandidateEnv(candidate, deps.env ?? process.env),
    (apiKey, candidate) =>
      streamWithRetry(
        () => {
          request.api_key = apiKey;
          if (request.context !== undefined) request.context.api_key_name = candidate.name;
          return callProvider(request, deps, signal);
        },
        deps.retry ?? DEFAULT_RETRY,
        undefined,
        deps.sleep,
      ),
    { record: (event) => fallbacks.push(event) },
  );

  return { response, fallbacks };
}

export async function generate(
  request: SidecarRequest,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateOutcome> {
  const resolved = resolveModelForRequest(deps.config, request);
  if (resolved !== undefined) {
    return await generateWithCredentialFallback(request, resolved, deps, signal);
  }
  console.debug(
    `shore: ${request.provider_key ?? request.sdk}/${request.model} is not in the static catalog; ` +
      `calling with the request's own key`,
  );
  return { response: await callProvider(request, deps, signal), fallbacks: [] };
}
