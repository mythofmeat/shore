/**
 * What a heartbeat says, and when it stops saying it.
 *
 * A heartbeat is a private turn: the character gets tools and time, and
 * whatever it does stays private *unless* it wraps something in
 * `<sendMessage>`. So two questions decide everything the user ever sees of
 * one — did it ask to speak, and has the tool loop run long enough to stop.
 * Both are answered here, from values alone.
 *
 * Ported from `crates/daemon/src/autonomy/manager.rs` and pinned against it by
 * `tests/heartbeat_shape_parity.test.ts`, which replays a fixture generated
 * from the Rust at 9023b46d.
 *
 * The effects are not here: running the loop, dispatching the tools, persisting
 * the message. Those are still Rust and move with the engine and the memory
 * store (#12). What is here is every decision they act on.
 */

/** Wire roles, as `WireMessage` spells them. */
export type WireRole = "user" | "assistant" | "system";

export interface WireTextBlock {
  type: "text";
  text: string;
}

export interface WireMessageLike {
  role: WireRole;
  content: { type: string; [key: string]: unknown }[];
}

/**
 * Text between XML-style tags, last match wins.
 *
 * Last-wins rather than first because a model that reconsiders mid-turn writes
 * a second tag rather than editing the first, and the second is the one it
 * meant. Empty and whitespace-only bodies do not count as a match at all, so a
 * trailing `<sendMessage></sendMessage>` cannot silently erase a real message
 * earlier in the same response.
 *
 * An unclosed opening tag ends the scan. The text after it is not a message:
 * the model was cut off mid-write, and delivering the fragment would send the
 * user half a thought.
 */
export function extractTag(content: string, startTag: string, endTag: string): string | undefined {
  let result: string | undefined;
  let searchFrom = 0;
  for (;;) {
    const startPos = content.indexOf(startTag, searchFrom);
    if (startPos === -1) break;
    const absStart = startPos + startTag.length;
    const endPos = content.indexOf(endTag, absStart);
    if (endPos === -1) break;
    const inner = content.slice(absStart, endPos).trim();
    if (inner.length > 0) result = inner;
    searchFrom = endPos + endTag.length;
  }
  return result;
}

/** The text a heartbeat asked to send, if it asked. */
export function extractSendMessage(content: string): string | undefined {
  return extractTag(content, "<sendMessage>", "</sendMessage>");
}

/**
 * Names the model reaches for when it calls `sendMessage` as a tool.
 *
 * The tool is deliberately undeclared — declaring it would make the heartbeat's
 * tool array differ from chat's and bust the prompt-cache prefix, which is a
 * real cost on every turn. So the model hallucinates it, and the dispatch
 * intercepts these names rather than letting them fall through as unimplemented.
 */
export function isSendMessageTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "sendmessage" || lower === "send_message";
}

/**
 * The message text out of a hallucinated `sendMessage` call.
 *
 * With no declared schema the model picks its own field name, so four are
 * accepted in a fixed order, plus a bare string input. Order matters when it
 * sends more than one: `message` wins over `text`, `text` over `content`,
 * `content` over `body`.
 */
export function extractToolSendMessage(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null) {
    for (const key of ["message", "text", "content", "body"] as const) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/** One tool call, as the loop collects them: id, name, input. */
export type ToolUse = readonly [string, string, unknown];

/**
 * The message a round of tool calls asked to send, last wins.
 *
 * Same last-wins rule as the tag, so a turn that uses both spellings does not
 * depend on which one the model happened to reach for first. A call with
 * nothing extractable in it is skipped rather than counted as an empty message,
 * which is what stops a malformed second call erasing a good first one.
 */
export function captureToolSendMessage(toolUses: readonly ToolUse[]): string | undefined {
  let found: string | undefined;
  for (const [, name, input] of toolUses) {
    if (!isSendMessageTool(name)) continue;
    const text = extractToolSendMessage(input);
    if (text !== undefined) found = text;
  }
  return found;
}

/** What the tool-loop budget concluded at the top of an iteration. */
export type BudgetAction =
  /** Run another round. */
  | "continue"
  /** Budget reached, grace available: tell the model to wrap up. */
  | "nudge"
  /** Stop. */
  | "break";

/**
 * Whether the heartbeat's tool loop should keep going.
 *
 * Two independent limits: a round cap and a wall-clock deadline. Reaching
 * either spends the one wrap-up nudge, which buys the model a grace window to
 * finish the thought and write anything durable down. A deadline that trips
 * *during* that grace ends the loop; the round cap does not, which is why
 * `{cap reached, already nudged, no deadline}` continues. That looks like an
 * oversight and is not: the grace exists precisely to run past the round cap,
 * and only the wall clock is allowed to cut it short.
 *
 * With no grace configured, reaching either limit stops immediately — there is
 * nothing to nudge toward.
 */
export function budgetDecision(
  deadlineReached: boolean,
  normalCapReached: boolean,
  wrapUpGrace: number,
  wrapUpNudged: boolean,
): BudgetAction {
  if ((deadlineReached || normalCapReached) && !wrapUpNudged) {
    return wrapUpGrace === 0 ? "break" : "nudge";
  }
  if (deadlineReached && wrapUpNudged) return "break";
  return "continue";
}

export const WRAP_UP_NUDGE_TEXT =
  "[System nudge: heartbeat tool-use budget reached. Wrap up now — " +
  "if you have unfinished work, note it in MEMORY.md with today's date so future-you can pick it up " +
  "where you left off. Then either send a final <sendMessage> or respond HEARTBEAT_OK and stop.]";

/**
 * Put the wrap-up nudge where a provider will accept it.
 *
 * Anthropic rejects two consecutive user turns, and the request almost always
 * ends on one — the tool results from the round just finished. So the nudge
 * folds into that message as an extra block, and only becomes a message of its
 * own when the request happens to end on an assistant turn or is empty.
 */
export function appendWrapUpNudge(messages: WireMessageLike[]): void {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "user") {
    last.content.push({ type: "text", text: WRAP_UP_NUDGE_TEXT });
    return;
  }
  messages.push({ role: "user", content: [{ type: "text", text: WRAP_UP_NUDGE_TEXT }] });
}

/** An image a heartbeat generated, as the message carries it. */
export interface ImageRef {
  path: string;
  caption?: string | undefined;
  /** Filled in just before the message goes on the wire, never here. */
  data?: string | undefined;
}

/**
 * An `ImageRef` from a successful `generate_image` result.
 *
 * No path means no image: the tool failed or answered something else, and a
 * reference to nothing would persist a broken attachment.
 */
export function generatedImageRef(value: unknown): ImageRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string") return undefined;
  const caption = record["caption"];
  return {
    path,
    caption: typeof caption === "string" ? caption : undefined,
    data: undefined,
  };
}

/** The shape of an autonomous message, minus what only the clock decides. */
export interface AutonomousMessageShape {
  role: "assistant";
  origin: "autonomous";
  content: string;
  contentBlocks: WireTextBlock[];
  images: ImageRef[];
  providerKey: string | undefined;
  model: string | undefined;
}

/**
 * The message a heartbeat sends, from its text and any images.
 *
 * An image-only tick carries no text block at all rather than an empty one. The
 * image is the message in that case, and a blank `ContentBlock::Text` beside it
 * renders as a stray empty line in every client that shows the conversation.
 */
export function buildAutonomousMessage(
  text: string,
  images: ImageRef[],
  providerKey: string | undefined,
  model: string | undefined,
): AutonomousMessageShape {
  const contentBlocks: WireTextBlock[] = text.length === 0 ? [] : [{ type: "text", text }];
  return {
    role: "assistant",
    origin: "autonomous",
    content: deriveContentFromBlocks(contentBlocks),
    contentBlocks,
    images,
    providerKey,
    model,
  };
}

/** The flat `content` string a message carries beside its blocks. */
function deriveContentFromBlocks(blocks: readonly WireTextBlock[]): string {
  return blocks.map((block) => block.text).join("");
}

/**
 * The heartbeat's user turn.
 *
 * `now` arrives formatted rather than as a timestamp: the Rust read
 * `Local::now()` inside this function and rendered it with a strftime pattern,
 * and reproducing that formatting here would be pinning a date library rather
 * than the prompt. The caller formats; this decides what is said.
 */
export function buildHeartbeatPrompt(
  now: string,
  userName: string,
  defaultInterval: string,
): string {
  return `[Current time: ${now}]

[This is a private heartbeat turn — your own time, to use however seems useful. \
You have real tools and can search or write workspace and memory files, search \
your conversation history, check the web, generate images, and schedule the next wake.

In addition, you can:

- Schedule your next heartbeat session: use set_next_wake(hours_from_now, \
reason). The minimum is 1 hour, the maximum is 48 hours. Sooner if you want \
to come back to something, later if you'd rather rest. If you don't \
schedule, your next moment will arrive in ${defaultInterval}. This is the \
next opportunity you will have to send ${userName} an autonomous message or \
to continue any unfinished or ongoing work from this current heartbeat \
session.

- Send a message to ${userName}: wrap it in <sendMessage>...</sendMessage>. \
You have the ability to autonomously and spontaneously send messages to \
${userName}. Any text included in the \`sendMessage\` tags will be delivered \
to ${userName}.

Thoughts, tool-use results, and any text in your response that is not part \
of \`<sendMessage>\` tags are private and ephemeral. If you want to carry \
something forward, write it down with a workspace tool.

If you have a multi-step task in progress and want future-you to pick it up, \
record it in MEMORY.md with today's date, and keep it short. MEMORY.md is in \
your system prompt for every turn — heartbeat and conversation alike — so notes \
you leave there are visible to your next session either way. Anything durable \
belongs in a memory/ file instead; MEMORY.md only carries what is still live, \
and you should clear entries out of it once they are done or stale.

Changes you make to workspace files, including files under memory/, will persist. \
If nothing needs doing right now, respond with HEARTBEAT_OK and stop.]`;
}
