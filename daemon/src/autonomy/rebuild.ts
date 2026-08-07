/**
 * The body a heartbeat reuses and a keepalive pings, rebuilt from disk.
 *
 * Ported from `heartbeat_rebuild_messages`, `heartbeat_idle_anchor_message` and
 * `rebuild_request_from_disk` in `crates/daemon/src/autonomy/manager.rs`, pinned
 * by `tests/autonomy_fixtures/last_request_parity.json`.
 *
 * There is normally a cached `last_request` — the body a chat turn just sent,
 * still warm against the provider's prompt cache. This is what happens when
 * there is not: a restart, a compaction that invalidated it, or a character that
 * has not spoken since the process came up. The rebuild reads `active.jsonl` and
 * produces the request chat's *next* turn would have sent, so the prefix it
 * seeds is one a real turn can extend rather than a shape only background work
 * uses.
 *
 * # Empty is not "nothing to do"
 *
 * A conversation with no messages still has a system prompt and a memory index,
 * which is plenty for a heartbeat to act on and exactly what the keepalive wants
 * to keep warm. So an empty conversation gets a synthetic anchor turn rather
 * than a skip. The only real reason to skip is a conversation that is *mid-turn*
 * — a dangling tool-result tail, or a user message still waiting on an answer —
 * because anchoring onto one builds a request the provider rejects.
 *
 * # Why an anchor at all
 *
 * Providers merge the heartbeat's instruction into the immediately preceding
 * user message (`pushInlineSystem`), so a tick with no live user turn has
 * nothing to attach to. The anchor is one bracketed user message that says the
 * earlier conversation was archived. It exists only in the rebuilt in-memory
 * request and is never persisted, so it can never displace a warm chat prefix —
 * it appears only in the cold state where there is no prefix to displace.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { MessageStore, isToolResultOnly } from "../engine/message_store.ts";
import type { Message } from "../engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../handler/context.ts";
import type { SidecarRequest } from "../llm/types.ts";
import { segmentCount } from "../memory/compaction/archive.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";

/** The anchor's text. Bracketed, so it reads as a note rather than an utterance. */
export const IDLE_ANCHOR_TEXT =
  "[Resuming after an extended idle period — the earlier " +
  "conversation has been archived to memory.]";

/**
 * True when the conversation is at a turn boundary — the assistant spoke last.
 *
 * Only the *last* message's role, deliberately. A user message at the end means
 * a turn is in flight; a tool-result tail is a user message too, so the same
 * check covers the tool loop. Anything else — an empty conversation, a trailing
 * system message — is not a boundary either, and the callers below each decide
 * separately what to do about that.
 */
export function historyIsBetweenTurns(messages: readonly Message[]): boolean {
  return messages.at(-1)?.role === "assistant";
}

/**
 * Which messages a rebuild runs on, or `undefined` to skip the tick.
 *
 * Three answers, and the middle one is the interesting one:
 *
 * - **A real user turn exists**: rebuild on the conversation as it stands, but
 *   only at a turn boundary. Mid-turn means skip.
 * - **No real user turn** — empty, or only a retained autonomous tail the user
 *   has not answered: prepend the anchor and keep whatever is there, so the
 *   model still sees its own unanswered messages.
 * - **No real user turn and not at a boundary**: skip. Anchoring a dangling
 *   tool-result tail produces an invalid request.
 *
 * "Real" excludes a tool-result-only user message. Those are tool-loop
 * intermediates, and treating one as the user turn would rebuild a request with
 * nothing for the heartbeat prompt to merge into.
 */
export function heartbeatRebuildMessages(
  character: string,
  messages: readonly Message[],
  anchor: () => Message = () => idleAnchorMessage(),
): Message[] | undefined {
  const hasUserTurn = messages.some((m) => m.role === "user" && !isToolResultOnly(m));

  if (hasUserTurn) {
    if (!historyIsBetweenTurns(messages)) {
      console.info(
        `shore: heartbeat rebuild for ${character} skipped — the conversation is mid-turn`,
      );
      return undefined;
    }
    return [...messages];
  }

  // Empty anchors rather than skipping: the prefix is worth keeping warm even
  // before a single segment exists.
  if (messages.length > 0 && !historyIsBetweenTurns(messages)) {
    console.info(
      `shore: heartbeat rebuild for ${character} skipped — the conversation is mid-turn`,
    );
    return undefined;
  }

  console.info(
    `shore: heartbeat rebuild for ${character} — no live user turn, rebuilding from memory`,
  );
  return [anchor(), ...messages];
}

/**
 * The synthetic user turn a cold rebuild attaches to.
 *
 * A fresh id and timestamp per call, matching the Rust's `Uuid::new_v4()` and
 * `Local::now()`. Both are injectable so a replay can pin them; production takes
 * the defaults. The content block carries the same text as `content`, because a
 * block-less turn is an empty turn and an empty turn anchors nothing.
 */
export function idleAnchorMessage(
  newId: () => string = () => `m_${randomUUID()}`,
  now: () => string = () => new Date().toISOString(),
): Message {
  return {
    msg_id: newId(),
    role: "user",
    content: IDLE_ANCHOR_TEXT,
    images: [],
    content_blocks: [{ type: "text", text: IDLE_ANCHOR_TEXT }],
    alternatives: [],
    timestamp: now(),
  };
}

/** What a rebuild needs that is not the config. */
export interface RebuildDeps {
  /**
   * The live MCP surface. Passed rather than defaulted, because the whole point
   * of including it is that it matches what chat sends — see the note on
   * `buildChatShapeRequestFromDisk`.
   */
  mcpRegistry?: Pick<McpRegistry, "toolDefsFiltered">;
  /** Injected so a replay can pin the anchor. */
  newId?: () => string;
  now?: () => string;
  /** Injected so a replay can pin the prompt's time markers. */
  timeZone?: string;
}

/**
 * The request chat's next turn would send, built from what is on disk.
 *
 * `undefined` for the two reasons the Rust returned `None`: the conversation is
 * mid-turn, or no chat model resolves. Both are "do not ping and do not tick",
 * and the caller's job on either is to disarm rather than to keep the old body
 * armed.
 *
 * The *chat* model, not a heartbeat one. A heartbeat applies its own override
 * after this returns; the keepalive must not, because it is refreshing chat's
 * prefix and a heartbeat-only model would warm the wrong thing.
 */
export async function rebuildRequestFromDisk(
  character: string,
  dataDir: string,
  config: LoadedConfig,
  deps: RebuildDeps = {},
): Promise<SidecarRequest | undefined> {
  const characterDir = join(dataDir, character);

  let store: MessageStore;
  try {
    store = await MessageStore.load(join(characterDir, ACTIVE_JSONL_FILE));
  } catch (e) {
    console.warn(`shore: heartbeat rebuild for ${character} could not load messages: ${String(e)}`);
    return undefined;
  }

  const selected = heartbeatRebuildMessages(character, store.messages(), () =>
    idleAnchorMessage(
      deps.newId ?? (() => `m_${randomUUID()}`),
      deps.now ?? (() => new Date().toISOString()),
    ),
  );
  if (selected === undefined) return undefined;

  const resolved = resolveChatModelForCharacter(configView(config), character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (resolved === undefined) return undefined;

  const hasPriorContext = (await segmentCount(characterDir)) > 0;
  const mcpToolDefs = deps.mcpRegistry?.toolDefsFiltered(config.app.tools.enabled_tools) ?? [];

  try {
    const built = await buildChatShapeRequestFromDisk(
      character,
      characterDir,
      config,
      resolved,
      selected,
      hasPriorContext,
      { mcpToolDefs, ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }) },
    );
    console.info(`shore: heartbeat rebuilt the request for ${character} from disk`);
    return built.request;
  } catch (e) {
    console.warn(`shore: heartbeat rebuild for ${character} failed: ${String(e)}`);
    return undefined;
  }
}
