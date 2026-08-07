/**
 * Stripping orphaned `tool_use` / `tool_result` blocks from an outbound
 * request.
 *
 * Ported from `crates/daemon/src/llm/sanitize.rs`, pinned by
 * `tests/llm_fixtures/stream_parity.json`.
 *
 * Anthropic and the OpenAI family both hard-reject a conversation containing a
 * `tool_use` nothing answered, or a `tool_result` answering nothing, and
 * translation proxies mangle it in more interesting ways. Either can happen
 * legitimately — a turn interrupted between the call and the result, a history
 * trimmed to fit a context window — so this runs defensively on every request
 * rather than trying to prevent the states upstream.
 *
 * # Pairing is role-scoped, and that is load-bearing
 *
 * Only `tool_use` on an **assistant** message and `tool_result` on a **user**
 * message participate. A `tool_use` sitting on a user message is neither
 * collected as a known id nor considered for stripping — it is invisible to
 * both passes and passes through untouched. That is not obviously right, but it
 * is symmetric: the same role pair gates the collection and the filter, so
 * nothing can be stripped for failing to match an id that was never collected.
 * The fixture pins both directions.
 *
 * # `undefined` is an answer
 *
 * A conversation with no orphans returns `undefined`, meaning "send the
 * original". That is deliberately distinct from returning a cleaned copy that
 * happens to be identical: the healthy path is the overwhelmingly common one
 * and it allocates nothing.
 */

import type { ContentBlock } from "../engine/types";
import type { WireMessage } from "./types";

/**
 * Strip orphans, or return `undefined` when there are none.
 *
 * A message whose content empties out entirely is dropped rather than sent as
 * an empty turn, which providers also reject.
 */
export function sanitizeToolPairs(messages: WireMessage[]): WireMessage[] | undefined {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (msg.role === "assistant" && block.type === "tool_use") {
        toolUseIds.add(block.id);
      } else if (msg.role === "user" && block.type === "tool_result") {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const orphanUses = difference(toolUseIds, toolResultIds);
  const orphanResults = difference(toolResultIds, toolUseIds);

  if (orphanUses.size === 0 && orphanResults.size === 0) return undefined;

  const out: WireMessage[] = [];
  for (const msg of messages) {
    const kept = msg.content.filter((block) => keep(msg.role, block, orphanUses, orphanResults));
    if (kept.length === 0) continue;
    out.push({
      role: msg.role,
      content: kept,
      // Provenance survives the rebuild: `provider_key` drives the
      // thinking-replay portability filter, and losing it would make an
      // assistant turn look like it came from nowhere.
      ...(msg.provider_key !== undefined ? { provider_key: msg.provider_key } : {}),
      ...(msg.model !== undefined ? { model: msg.model } : {}),
    });
  }
  return out;
}

function keep(
  role: WireMessage["role"],
  block: ContentBlock,
  orphanUses: Set<string>,
  orphanResults: Set<string>,
): boolean {
  if (role === "assistant" && block.type === "tool_use") return !orphanUses.has(block.id);
  if (role === "user" && block.type === "tool_result") return !orphanResults.has(block.tool_use_id);
  // Text, images, thinking, and any tool block on the "wrong" role: verbatim.
  return true;
}

function difference(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (!b.has(v)) out.add(v);
  return out;
}
