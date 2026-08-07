/**
 * Which of the daemon's stored blocks a given provider will actually accept.
 *
 * Three decisions live here, all of them provider-shaped and none of them
 * answerable without knowing the target:
 *
 *   1. **Carrier-less thinking.** Anthropic rejects a `thinking` block with no
 *      signature outright. The OpenAI-dialect providers echo raw reasoning back
 *      as `reasoning_content` and want it.
 *   2. **Replay portability.** A thinking block's opaque payload is only valid
 *      against the exact model that minted it; replaying a foreign one hard-fails
 *      the request.
 *   3. **The prior-thinking replay setting** (`all` / `none`), subject to the
 *      provider floor for models that hard-require replay.
 *
 * All three used to run daemon-side, in `content_util.rs`, against a `Sdk` enum
 * the daemon carried purely so it could guess. They had already drifted: the
 * chat path let carrier-less thinking through for DeepSeek and Moonshot while
 * every tool-loop continuation path stripped it — on the two providers whose
 * APIs *reject* a request that omits prior `reasoning_content`. One
 * implementation, on the side that knows the provider.
 *
 * Every function here is pure and total on its inputs, which is what makes the
 * keepalive ping byte-identical to the request it is pinging: the same stored
 * history projects the same way every time, rather than depending on when the
 * daemon happened to filter it.
 */

import type { ContentBlock } from "../engine/types.ts";
import type { Sdk, SidecarRequest, WireMessage } from "./types.ts";

/**
 * SDKs that accept a `thinking` block carrying no replay payload.
 *
 * These dialects round-trip raw reasoning text through `reasoning_content`, so
 * an uncarried block still says something. Everywhere else an uncarried block
 * replays nothing at best and fails the request at worst.
 */
const ECHOES_UNSIGNED_THINKING: ReadonlySet<Sdk> = new Set<Sdk>([
  "openai",
  "zai",
  "deepseek",
  "moonshot",
]);

/**
 * Provider keys that need prior `reasoning_content` replayed regardless of the
 * user's `replay_prior_thinking`. A floor, not a preference.
 *
 * Only Moonshot is on it. Kimi K2.5+/K3 are trained in preserved-thinking-history
 * mode and degrade erratically without the replay — observed as coin-flip
 * think/no-think on byte-identical requests (657f3590).
 *
 * DeepSeek used to be here, on the claim that V3.1+ rejects a request omitting
 * prior `reasoning_content`. Measured against the live API on 2026-08-08, that
 * is false, and so is the opposite claim this repo carried in `openai.ts` (that
 * DeepSeek rejects the field on the way in). It does neither: both shapes
 * return 200, and a ~600-token `reasoning_content` on a prior assistant turn
 * moves `prompt_tokens` by exactly zero. DeepSeek accepts the field, discards
 * it server-side, and bills nothing for it — so replaying to DeepSeek is inert
 * rather than required.
 */
const REQUIRES_REASONING_REPLAY: ReadonlySet<string> = new Set(["moonshot", "moonshotai"]);

/** Blocks that carry opaque, model-specific data rather than plain text. */
function carriesOpaqueData(block: ContentBlock): boolean {
  if (block.type === "redacted_thinking") return true;
  if (block.type !== "thinking") return false;
  return (
    block.signature !== undefined ||
    block.reasoning_details !== undefined ||
    block.reasoning_content !== undefined
  );
}

/** A carrier that only the exact minting model can read back — OpenRouter's
 * `reasoning_details` and Z.AI's `reasoning_content`. An Anthropic-style
 * `signature` is checked by provenance alone. */
function hasForeignCarrier(block: ContentBlock): boolean {
  if (block.type !== "thinking") return false;
  return block.reasoning_details !== undefined || block.reasoning_content !== undefined;
}

/**
 * Whether a block's opaque data is safe to replay to the active model.
 *
 * `mintingProvider`/`mintingModel` come off the turn; either is absent for
 * history persisted before provenance was tracked.
 */
export function isPortable(
  block: ContentBlock,
  mintingProvider: string | undefined,
  mintingModel: string | undefined,
  activeProvider: string,
  activeModel: string,
): boolean {
  if (!carriesOpaqueData(block)) return true;

  // Carrier backstop, checked before provenance so it holds for legacy messages
  // too: a foreign carrier is replayable only to its exact minter, and a
  // provenance-free history would otherwise sail straight onto the Anthropic wire.
  if (hasForeignCarrier(block) && mintingModel !== activeModel) return false;

  if (mintingProvider !== undefined && mintingModel !== undefined) {
    // Full provenance: opaque data is valid only against its exact minter.
    // Stripping on a mismatch costs reasoning continuity (already lost on a
    // model switch); keeping a foreign block hard-fails.
    return mintingProvider === activeProvider && mintingModel === activeModel;
  }
  if (mintingProvider !== undefined) {
    // Provider-only provenance: the coarse check is all that is available.
    return mintingProvider === activeProvider;
  }
  // Unknown provenance (legacy messages): fall back to the one signal readable
  // off the wire. OpenRouter tags relayed reasoning with an
  // `openrouter.reasoning:` prefix, and that envelope is OpenRouter-only. Other
  // legacy opaque blocks are kept, so working same-provider histories that
  // predate provenance tracking don't break.
  if (block.type === "redacted_thinking" && block.data.startsWith("openrouter.reasoning:")) {
    return activeProvider.includes("openrouter");
  }
  return true;
}

/** Every thinking-ish block, for the `none` replay mode. */
function isThinking(block: ContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

/**
 * Project the daemon's stored conversation onto what this provider accepts.
 *
 * A turn whose blocks all drop out is removed rather than sent empty — every
 * provider rejects an empty content array, and one such turn fails the whole
 * request.
 *
 * The `none` replay mode applies to *completed prior turns*. Thinking inside a
 * still-running tool loop is appended onto the live request by the daemon and
 * arrives here as ordinary history, so it is stripped along with the rest —
 * which is correct, because the request that carried it unstripped is the one
 * that was already sent, and this one is a new request built from the same
 * history. Both modes are prompt-cache-safe for the same reason: a given
 * history always projects to the same bytes.
 */
export function replayableMessages(req: SidecarRequest): WireMessage[] {
  const activeProvider = req.provider_key ?? "";
  const activeModel = req.model;
  const keepsUncarried = ECHOES_UNSIGNED_THINKING.has(req.sdk);

  // Provider floor beats the user setting: Kimi degrades without the replay.
  const stripPrior =
    req.replay_prior_thinking === "none" && !REQUIRES_REASONING_REPLAY.has(activeProvider);

  const out: WireMessage[] = [];
  for (const msg of req.messages) {
    const kept = msg.content.filter((block) => {
      if (block.type === "text" && block.text.trim() === "") return false;
      if (!isThinking(block)) return true;
      if (stripPrior && msg.role === "assistant") return false;
      if (block.type === "thinking" && !carriesOpaqueData(block) && !keepsUncarried) return false;
      return isPortable(block, msg.provider_key, msg.model, activeProvider, activeModel);
    });
    if (kept.length === 0) continue;
    out.push({ ...msg, content: kept });
  }
  return out;
}
