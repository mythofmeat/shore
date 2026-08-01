/**
 * Collapsing a tool loop into one assistant turn.
 *
 * Storage keeps the rounds apart because the provider APIs need them that way —
 * assistant `tool_use`, user `tool_result`, assistant text are separate
 * messages. Anything showing a conversation to a person wants one message:
 *
 *     [user, asst(tool_use), user(tool_result), asst(text)]
 *       -> [user, asst(thinking + tool_use + tool_result + text)]
 *
 * Ported from `crates/common/src/protocol/merge.rs` and pinned by
 * `tests/engine_fixtures/merge_parity.json`.
 *
 * That file lived in `common` because it was filed as client-side rendering,
 * but no Rust client ever called it — `merge_tool_loop_messages` was its only
 * export and its three consumers were all in the daemon. It comes across with
 * the daemon rather than staying behind with the TUI and CLI.
 */

import type { ContentBlock, Message, Role } from "./types";

/** Any `tool_use` block makes an assistant part of a tool loop.
 *
 *  Note this is *not* the same predicate as `prompt.ts`'s orphan check, which
 *  additionally requires the message to carry no non-empty text. An assistant
 *  that says "let me check" and then calls a tool is a tool-loop assistant here
 *  and is not an orphan there. Two similar names, two different questions. */
function isToolLoopAssistant(msg: Message): boolean {
  return msg.role === "assistant" && msg.content_blocks.some((b) => b.type === "tool_use");
}

/** A results message is a user turn carrying *only* `tool_result` blocks. */
function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === "user" &&
    msg.content_blocks.length > 0 &&
    msg.content_blocks.every((b) => b.type === "tool_result")
  );
}

/**
 * The `content` string for a merged message: text blocks only, each trimmed,
 * empties dropped, joined with newlines.
 *
 * Tool results are deliberately excluded even though they are in
 * `content_blocks` — this mirrors `derive_content_from_blocks_with(_, false)`.
 * Putting them in would mean a tool's entire output landing in the field
 * clients use for a one-line summary.
 */
function deriveContentTextOnly(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") continue;
    const trimmed = block.text.trim();
    if (trimmed !== "") parts.push(trimmed);
  }
  return parts.join("\n");
}

/**
 * One round's blocks: the assistant's, with each `tool_use` followed by the
 * matching `tool_result` from the paired user message.
 *
 * Ordering is the point. Blocks come out in the assistant's own order, so
 * thinking and text stay where the model put them, and a result sits directly
 * after the call it answers rather than in a clump at the end.
 *
 * Two behaviours here are easy to lose:
 *   - whitespace-only text blocks are dropped, as model noise;
 *   - a `tool_use` whose id matches nothing emits no result, rather than
 *     borrowing the next one.
 */
function collectRound(
  assistant: Message,
  results: Message | undefined,
  out: ContentBlock[],
): void {
  for (const block of assistant.content_blocks) {
    if (block.type === "tool_use") {
      out.push(block);
      const match = results?.content_blocks.find(
        (b) => b.type === "tool_result" && b.tool_use_id === block.id,
      );
      if (match !== undefined) out.push(match);
      continue;
    }
    if (block.type === "text" && block.text.trim() === "") continue;
    out.push(block);
  }
}

/**
 * Merge tool-loop messages into logical assistant turns.
 *
 * Messages outside a loop pass through untouched — including their `content`,
 * which is *not* re-derived. Tool-result-only user messages are consumed and do
 * not appear in the output at all, which is also what happens to one that is
 * left orphaned at the head of a trimmed history.
 */
export function mergeToolLoopMessages(messages: Message[]): Message[] {
  const output: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role !== "assistant") {
      if (!isToolResultOnly(msg)) output.push(msg);
      i += 1;
      continue;
    }

    if (!isToolLoopAssistant(msg)) {
      output.push(msg);
      i += 1;
      continue;
    }

    // ── a loop starts here ────────────────────────────────────────────
    const mergedBlocks: ContentBlock[] = [];
    let lastAssistant = msg;

    while (i < messages.length) {
      const current = messages[i]!;
      const next = messages[i + 1];
      const results = next !== undefined && isToolResultOnly(next) ? next : undefined;

      collectRound(current, results, mergedBlocks);
      lastAssistant = current;
      i += results !== undefined ? 2 : 1;

      if (i >= messages.length) break;

      const following = messages[i]!;
      if (following.role === "assistant" && isToolLoopAssistant(following)) {
        continue; // another round
      }
      if (following.role === "assistant") {
        // The closing message. Its blocks are appended **raw** — not through
        // `collectRound` — so unlike every other round, a whitespace-only text
        // block here survives and a `tool_use` here is not paired with a
        // result. Faithful to the Rust; the fixture pins both.
        mergedBlocks.push(...following.content_blocks);
        lastAssistant = following;
        i += 1;
        break;
      }
      break; // a user turn interrupted the loop
    }

    // Everything but the blocks and the derived content comes from the last
    // assistant seen — the closing message when there was one, otherwise the
    // final tool-calling round.
    output.push({
      msg_id: lastAssistant.msg_id,
      role: "assistant" as Role,
      content: deriveContentTextOnly(mergedBlocks),
      images: lastAssistant.images,
      content_blocks: mergedBlocks,
      ...(lastAssistant.alt_index !== undefined ? { alt_index: lastAssistant.alt_index } : {}),
      ...(lastAssistant.alt_count !== undefined ? { alt_count: lastAssistant.alt_count } : {}),
      ...(lastAssistant.alternatives !== undefined
        ? { alternatives: lastAssistant.alternatives }
        : {}),
      timestamp: lastAssistant.timestamp,
      ...(lastAssistant.provider_key !== undefined
        ? { provider_key: lastAssistant.provider_key }
        : {}),
      ...(lastAssistant.model !== undefined ? { model: lastAssistant.model } : {}),
      ...(lastAssistant.origin !== undefined ? { origin: lastAssistant.origin } : {}),
    });
  }

  return output;
}
