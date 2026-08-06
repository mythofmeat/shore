/**
 * One non-streaming provider call, with the credential rotation and the ledger
 * row around it.
 *
 * Ported from `LedgerClient::generate_with_config_fallback`,
 * `generate_with_credential_fallback` and `resolve_model_for_request` in
 * `crates/daemon/src/ledger/client.rs`.
 *
 * # The seam every background pass was waiting for
 *
 * Compaction, the deep archive and the heartbeat all reach a model without a
 * client attached, and each of them has been carrying an injected `generate`
 * with a note saying the real one "lands with `handler/`". This is it. The
 * streaming half of the same job is `handler/generation.ts`, and the two share
 * every piece that decides *which credential* — `resolveKeyCandidates`,
 * `streamWithCredentialFallback`, `streamWithRetry` — because a background pass
 * that rotated keys differently from a chat turn would be a second policy to
 * keep in step with the first.
 *
 * # `/v1/generate` is deliberately not rewired to this
 *
 * The endpoint looks like it should call this and must not while the Rust
 * daemon is the one calling it. `LedgerClient` does the rotation on that side,
 * one key per request, so routing the endpoint through here would rotate twice
 * and burn every credential on a single failure. The endpoint keeps its
 * one-call-one-key contract and dies with the hop (#18, step 5); this is for
 * callers already in this process.
 *
 * # Why a rotation is reported rather than logged
 *
 * A heartbeat folds its rotations into the ring buffer `shore log --heartbeat`
 * reads; a chat turn sends them to the client as a warning frame. Neither is
 * this module's to do, so both come back in {@link GenerateOutcome.fallbacks}
 * and the caller decides. The Rust returned the same vector for the same
 * reason.
 */

import { budgetBlockFor } from "../ledger/gate.ts";
import { recordGenerate, recordGenerateError } from "../ledger/record.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ResolvedModel } from "../config/models.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { readCandidateEnv, resolveKeyCandidates } from "./credentials.ts";
import {
  streamWithCredentialFallback,
  streamWithRetry,
  DEFAULT_RETRY,
  type FallbackEvent,
  type RetrySettings,
  type Sleep,
} from "./fallback.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "./types.ts";

/** A provider call was refused before it happened, by `[usage]`. */
export class BudgetBlocked extends Error {
  readonly scope: string | undefined;

  constructor(message: string, scope?: string) {
    super(message);
    this.name = "BudgetBlocked";
    this.scope = scope;
  }
}

/** What one call needs that is not the request. */
export interface GenerateDeps {
  /** Adapters by sdk, as `server.ts` assembles them. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  config: LoadedConfig;
  env?: NodeJS.ProcessEnv;
  sleep?: Sleep;
  retry?: RetrySettings;
  /** Injected so a test does not wait on the transient-retry backoff. */
  now?: () => number;
}

/** A completed call, and every credential it had to rotate past to get there. */
export interface GenerateOutcome {
  response: GenerateResponse;
  fallbacks: FallbackEvent[];
}

/**
 * The catalog entry a request was built from, if the catalog still has one.
 *
 * Matched on `(model_id, sdk)` and, when the request names one, `provider_key`.
 * A request whose provider is absent matches the first catalog model with that
 * id and sdk — which is the Rust's `is_none_or`, and is how a request built
 * before a provider key was recorded still resolves.
 *
 * `undefined` is not an error. It means the request was built against something
 * the static catalog does not describe — a discovered model, or a pin — and the
 * call falls back to the single credential the request is already carrying.
 */
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

/** One attempt: gate, call, record. The unit both paths below are built from. */
async function callProvider(
  request: SidecarRequest,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const provider = deps.providers[request.sdk];
  if (provider === undefined) throw new Error(`unsupported sdk: ${request.sdk}`);

  // Inside the attempt rather than before the rotation, deliberately. The gate
  // reads `[usage]` off the request's own call context, and a rotation rewrites
  // the credential rather than the budget — but a gate hoisted out would also
  // be a gate that stops applying the moment a caller reaches this by another
  // path. One call, one check.
  const blocked = budgetBlockFor(request);
  if (blocked) throw new BudgetBlocked(blocked.message, blocked.scope);

  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  try {
    const response = await provider.generate(request, signal);
    recordGenerate(request.context, request, response);
    return response;
  } catch (e) {
    // The row exists either way. A call that failed still consumed an attempt,
    // and a ledger with holes in it reads as a quiet period rather than a
    // broken provider.
    recordGenerateError(request.context, request, startedAt, clock);
    throw e;
  }
}

/**
 * Call the model, rotating through the provider's configured keys.
 *
 * `request.api_key` is overwritten per attempt, so the caller's request object
 * is mutated — as the Rust's `&mut LlmRequest` was. Callers hand over a body
 * they own; see `autonomy/heartbeat_request.ts` for what handing over one they
 * do not would cost.
 */
export async function generateWithCredentialFallback(
  request: SidecarRequest,
  resolved: ResolvedModel,
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

/**
 * Call the model, rotating keys when the catalog knows which ones to rotate.
 *
 * The outer half of the Rust's pair. A request the static catalog cannot place
 * still runs — on the single credential it was built with — rather than
 * failing, because "I do not recognise this model" is not a reason to refuse a
 * request that already carries a working key.
 */
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
