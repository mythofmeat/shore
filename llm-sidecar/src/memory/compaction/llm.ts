/**
 * The production {@link CompactionLlm}: build a compaction request from chat's,
 * and run one round against it.
 *
 * Ported from `RealCompactionLlm` in
 * `crates/daemon/src/memory/compaction_impls.rs`, pinned by
 * `tests/memory_fixtures/compaction_llm_parity.json`.
 *
 * # The whole point is the cache
 *
 * Compaction is, semantically, chat with one extra instruction appended. The
 * request is rebuilt against the *compaction* model and its sampler settings,
 * but the cacheable prefix — `system`, `tools`, `messages` — comes through from
 * chat verbatim. Anthropic's prompt-cache hash covers all three, so this rebuild
 * is the lever that keeps compaction's call hitting the cache chat already
 * seeded for this conversation. Anything that rewrites the prefix gives that up
 * silently: the call still succeeds, it just costs full price and evicts what
 * chat's next turn would have hit.
 *
 * `chatRequest` is either the live cached `last_request` (cache warm) or a
 * chat-shape request rebuilt from disk (cache cold). The wire shape is
 * identical either way, which is the point of unifying the two paths.
 */

import { buildRequestWithProviderKeys, pushInlineSystem, type ResolvedModel } from "../../llm/request";
import type { ProviderEntry } from "../../llm/credentials";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";
import { CompactionError, type CompactionLlm } from "./types";

/**
 * Entries appended to the chat prefix when a compaction request is built: one
 * `role:"user"` ("compact now") and one `role:"system"` (the instruction).
 *
 * The system entry sits immediately after the user entry, and the tool loop
 * pushes assistant + tool-result turns *after* both, so its index never shifts
 * across rounds. That fixed index is the invariant:
 *
 * The instruction goes inline via {@link pushInlineSystem} at build time, so its
 * position in `messages` is settled before the loop starts. Each provider
 * adapter then handles it the way its dialect expects — Anthropic-family
 * providers merge it into the preceding user turn, OpenAI-family providers emit
 * a real `role:"system"` or wrap it as a user turn with `<system_instruction>`
 * — and because the index is fixed, whatever the adapter merges into or wraps
 * is fixed too. Every byte at or before that position is stable round to round,
 * which is what keeps the content-addressed prefix cache valid.
 *
 * The earlier `system_suffix` affordance was removed for exactly this: it
 * re-expanded the instruction at the *moving* tail on every call, busting the
 * cache on every round.
 */
export const COMPACTION_TAIL_ENTRY_COUNT = 2;

/**
 * Apply the canonical compaction tail to a chat-shape request.
 *
 * One named operation rather than two open-coded field mutations, so the
 * wire-shape invariant is visible wherever it is applied. See
 * {@link COMPACTION_TAIL_ENTRY_COUNT} for why the instruction rides inline.
 */
export function appendCompactionTail(
  request: SidecarRequest,
  userPrompt: WireMessage,
  systemPrompt: string,
): void {
  request.messages.push(userPrompt);
  pushInlineSystem(request, systemPrompt);
}

/**
 * Run one compaction round against a built request.
 *
 * The Rust reached `LedgerClient::generate_with_credential_fallback`, which
 * posted to the sidecar over HTTP and recorded the call in the ledger. In one
 * process there is no post: it becomes a direct call into the provider adapter
 * with the same credential-rotation and ledger-recording around it. That entry
 * point does not exist yet — it is the seam every background pass needs, not
 * just this one, and it lands with `handler/`, which is where the streaming
 * pipeline it shares comes from. Injected here so this module can be finished
 * and pinned now without inventing that shape ahead of its other callers.
 */
export type LedgerGenerate = (
  request: SidecarRequest,
  model: ResolvedModel,
  character: string,
) => Promise<GenerateResponse>;

export interface RealCompactionLlmOptions {
  model: ResolvedModel;
  /**
   * The `[providers.<key>]` entry for the compaction model's provider.
   *
   * Carried so the request honours `[providers.<name>].keys`. Without it a
   * compaction would look only at the model's own `api_key_env` and fail with
   * `MissingApiKey` for anyone who configures provider-level keys.
   */
  providerEntry?: ProviderEntry;
  character: string;
  generate: LedgerGenerate;
  env?: NodeJS.ProcessEnv;
}

export class RealCompactionLlm implements CompactionLlm {
  readonly #opts: RealCompactionLlmOptions;

  constructor(opts: RealCompactionLlmOptions) {
    this.#opts = opts;
  }

  /**
   * The Rust set three more fields here: `rid = None` (a compaction is not the
   * chat turn whose trace id it would otherwise inherit), `forensic_character`,
   * and `retain_long` — compaction is low-frequency and high-value for
   * cache-regression forensics, so its payload log goes to a longer retention
   * tier than per-turn chat. All three were `#[serde(skip)]` transients that
   * never reached a provider, and `SidecarRequest` deliberately does not carry
   * them: they cross in the call context instead, "where they cannot be
   * mistaken for provider input". They are the generate seam's to set, with the
   * rest of that context, and land with it.
   */
  buildInitialRequest(
    system: string,
    compactNowUser: WireMessage,
    chatRequest: SidecarRequest,
  ): SidecarRequest {
    let built;
    try {
      built = buildRequestWithProviderKeys(
        this.#opts.model,
        this.#opts.providerEntry,
        {
          // A copy, not the caller's array. The Rust took `chat_request` by
          // value and *moved* its `messages` into the rebuilt request, so the
          // caller had nothing left to alias. Here the caller keeps its object,
          // and the compaction tail plus every tool-loop round would otherwise
          // be appended straight into it — which for the warm-cache path is the
          // autonomy manager's cached `last_request`, i.e. chat's own history.
          // The elements are shared, which is correct: they are never mutated.
          messages: [...chatRequest.messages],
          ...(chatRequest.system === undefined ? {} : { system: chatRequest.system }),
          ...(chatRequest.tools === undefined ? {} : { tools: chatRequest.tools }),
          // Chat's exact replay policy. The messages come through verbatim, so
          // a different policy here would render a different prefix and give up
          // the cache this rebuild exists to reuse.
          replay: chatRequest.replay_prior_thinking,
        },
        this.#opts.env,
      );
    } catch (e) {
      throw CompactionError.llm((e as Error).message);
    }

    const request = built.request;
    appendCompactionTail(request, compactNowUser, system);
    return request;
  }

  async generate(request: SidecarRequest): Promise<GenerateResponse> {
    try {
      return await this.#opts.generate(request, this.#opts.model, this.#opts.character);
    } catch (e) {
      throw CompactionError.llm((e as Error).message);
    }
  }
}
