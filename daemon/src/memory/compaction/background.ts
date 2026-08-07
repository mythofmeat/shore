/**
 * What runs around a compaction pass: loading the conversation, and turning the
 * outcome into a number and a notification.
 *
 * Ported from `crates/daemon/src/memory/compaction/background.rs`.
 *
 * # Deliberately partial
 *
 * `run_compaction` itself is dependency resolution and nothing else: it
 * resolves the effective config, the background model and the prompt templates
 * (`preferences`), builds a `SharedToolContext` (`tools`), and resolves the
 * chat-shape request compaction extends (`handler::build_chat_shape_request_from_disk`).
 * All three of those modules are later units of this phase. Wiring it here
 * against stubs would mean writing the wiring twice, so what came across now is
 * the part that is genuinely this module's: the load, the outcome mapping, and
 * the push rule. The assembly lands with `handler/`, which is also where its
 * one caller lives.
 */

import { join } from "node:path";

import { MessageStore, isToolResultOnly } from "../../engine/message_store";
import type { Message } from "../../engine/types";
import type { CompactionOutcome, ConversationMessage } from "./types";

const ACTIVE_JSONL_FILE = "active.jsonl";

export interface LoadedConversation {
  store: MessageStore;
  characterDir: string;
  /** The raw bytes of `active.jsonl`, for the archive write. */
  rawContent: string;
  messages: ConversationMessage[];
}

/** Flatten a stored message into what the compaction split logic reads. */
export function toConversationMessage(msg: Message): ConversationMessage {
  return {
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    isToolResultOnly: isToolResultOnly(msg),
    isAutonomous: msg.origin === "autonomous",
  };
}

/**
 * Load a character's active conversation for compaction.
 *
 * One read, not two: the parse and the raw bytes come back together. The
 * separate `read_to_string` this replaced re-read a potentially multi-megabyte
 * file, and the archive needs the exact bytes the messages were parsed from —
 * taking them from the same read is what closes the window where the file
 * changes in between.
 */
export async function loadMessagesForCompaction(
  dataDir: string,
  character: string,
): Promise<LoadedConversation> {
  const characterDir = join(dataDir, character);
  const { store, raw } = await MessageStore.loadWithRaw(join(characterDir, ACTIVE_JSONL_FILE));
  return {
    store,
    characterDir,
    rawContent: raw,
    messages: store.messages().map(toConversationMessage),
  };
}

/** A desktop notification: a title and a body. */
export type Notify = (title: string, body: string) => void;

/**
 * Report a finished pass and return the retained turn count the caller reports
 * upward.
 *
 * A `no_memory_writes` pass returns zero and says so loudly: the model ran but
 * produced nothing the filter allowed — usually one that ignored the tool
 * prompt, hit its round cap, or only tried disallowed paths — and the next
 * trigger will retry against a conversation that is still intact.
 *
 * A dry run cannot reach here from the background path, which hard-codes
 * `dryRun: false`. It returns zero rather than throwing, as the Rust did.
 */
export function handleCompactionOutcome(
  character: string,
  notify: Notify,
  outcome: CompactionOutcome,
): number {
  if (outcome.kind === "compacted") {
    console.info(
      `shore: background compaction completed for ${character} ` +
        `(entries=${outcome.memoryFilesWritten.length}, compacted_turns=${outcome.compactedTurns}, ` +
        `retained_turns=${outcome.retainedTurns}, tool_rounds=${outcome.toolRounds})`,
    );
    notify(
      `Shore — ${character}`,
      `Compaction complete: ${outcome.memoryFilesWritten.length} entries from ` +
        `${outcome.compactedTurns} turns`,
    );
    return outcome.retainedTurns;
  }

  if (outcome.kind === "no_memory_writes") {
    console.warn(
      `shore: background compaction produced no memory writes for ${character} — conversation ` +
        `NOT archived (tool_rounds=${outcome.toolRounds}, rejected=${outcome.rejectedPaths.length}, ` +
        `max_rounds_hit=${outcome.maxRoundsHit}, tools_called=${JSON.stringify(outcome.toolsCalled)})`,
    );
    notify(
      `Shore — ${character}`,
      `Compaction ran but wrote no memory (${outcome.toolRounds} tool round` +
        `${outcome.toolRounds === 1 ? "" : "s"}). Conversation kept; will retry on next trigger.`,
    );
    return 0;
  }

  return 0;
}

/**
 * Push the workspace memory history after a successful pass, when
 * `[memory] git_push` is on.
 *
 * Only for `compacted` — a pass that archived nothing has nothing new to push —
 * and best-effort, since a failed push must never undo an archive that already
 * happened. Shared by the background and manual compaction paths, which is why
 * it is a function rather than four lines at each call site.
 */
export async function pushAfterCompaction(
  gitPushEnabled: boolean,
  outcome: CompactionOutcome,
  push: () => Promise<void>,
): Promise<void> {
  if (!gitPushEnabled || outcome.kind !== "compacted") return;
  await push();
}
