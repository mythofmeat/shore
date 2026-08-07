export type WireRole = "user" | "assistant" | "system";

export interface WireTextBlock {
  type: "text";
  text: string;
}

export interface WireMessageLike {
  role: WireRole;
  content: { type: string; [key: string]: unknown }[];
}

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

export function extractSendMessage(content: string): string | undefined {
  return extractTag(content, "<sendMessage>", "</sendMessage>");
}

export function isSendMessageTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "sendmessage" || lower === "send_message";
}

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

export type ToolUse = readonly [string, string, unknown];

export function captureToolSendMessage(toolUses: readonly ToolUse[]): string | undefined {
  let found: string | undefined;
  for (const [, name, input] of toolUses) {
    if (!isSendMessageTool(name)) continue;
    const text = extractToolSendMessage(input);
    if (text !== undefined) found = text;
  }
  return found;
}

export type BudgetAction =
  | "continue"
  | "nudge"
  | "break";

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

export function appendWrapUpNudge(messages: WireMessageLike[]): void {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "user") {
    last.content.push({ type: "text", text: WRAP_UP_NUDGE_TEXT });
    return;
  }
  messages.push({ role: "user", content: [{ type: "text", text: WRAP_UP_NUDGE_TEXT }] });
}

export interface ImageRef {
  path: string;
  caption?: string | undefined;
  data?: string | undefined;
}

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

export interface AutonomousMessageShape {
  role: "assistant";
  origin: "autonomous";
  content: string;
  contentBlocks: WireTextBlock[];
  images: ImageRef[];
  providerKey: string | undefined;
  model: string | undefined;
}

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

function deriveContentFromBlocks(blocks: readonly WireTextBlock[]): string {
  return blocks.map((block) => block.text).join("");
}

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
