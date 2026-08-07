/**
 * The conversation store — `active.jsonl` and everything that reads or writes
 * it.
 *
 * Ported from `crates/daemon/src/engine/messages.rs`, pinned by
 * `tests/engine_fixtures/messages_parity.json`. That fixture is operation
 * *traces* rather than single calls, because a store is stateful and the
 * interesting behaviour is what a sequence leaves on disk.
 *
 * One line of JSON per message, rewritten whole on every mutation through a
 * temporary file and a rename, so a reader never sees half a conversation. The
 * whole-file rewrite is not an oversight: edits, deletes and alternate
 * selection all change messages in place, and an append-only log would need
 * compaction to stay readable by the CLI that tails it.
 */

import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rustTrim } from "../memory/lines.ts";
import { mergeToolLoopMessages } from "./merge";
import type { ContentBlock, ImageRef, Message, MessageAlternative, Role } from "./types";

/** What the Rust's `EngineError` says, so callers can match on the same text. */
export class MessageNotFound extends Error {
  constructor(msgId: string) {
    super(`message not found: ${msgId}`);
    this.name = "MessageNotFound";
  }
}

export class InvalidAlt extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAlt";
  }
}

export class JsonParseError extends Error {
  constructor(path: string, cause: string) {
    super(`failed to parse ${path}: ${cause}`);
    this.name = "JsonParseError";
  }
}

/** Alternatives captured before a regeneration replaces the active response. */
export interface PendingAlt {
  alternatives: MessageAlternative[];
}

/** What selecting a stored alternate produced. */
export interface AltSelection {
  msg_id: string;
  alt_index: number;
  alt_count: number;
  content: string;
}

// ── content derivation ──────────────────────────────────────────────────────

/**
 * The human-readable summary of a set of blocks: text (and optionally tool
 * results), each trimmed, empties dropped, joined by newlines.
 *
 * Mirrors `derive_content_from_blocks_with`. Thinking and tool_use never
 * contribute — the first is not for the reader and the second is not prose.
 *
 * The trim is Rust's, not JavaScript's. The two disagree at both ends: `.trim()`
 * strips U+FEFF, which Rust keeps, and keeps U+0085, which Rust strips. A block
 * whose text is only one of those is dropped by one and preserved by the other,
 * and this function decides both what a message reads as and whether a
 * completion notification has anything to say.
 */
export function deriveContentFromBlocks(
  blocks: ContentBlock[],
  includeToolResults: boolean,
): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      const t = rustTrim(b.text);
      if (t !== "") parts.push(t);
    } else if (b.type === "tool_result" && includeToolResults) {
      const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      const t = rustTrim(raw);
      if (t !== "") parts.push(t);
    }
  }
  return parts.join("\n");
}

/**
 * Reconcile `content` and `content_blocks` after a read, and clamp the alt
 * counters.
 *
 * Two storage generations meet here: old messages have `content` and no blocks,
 * new ones have blocks and derive `content`. Blocks win when both are present,
 * which means a hand-edited `content` in the file is silently discarded.
 */
export function normalizeMessage(msg: Message): Message {
  // `content`, `images` and `content_blocks` are all `#[serde(default)]` in the
  // Rust, and `serialize_for_storage` *omits* `content` — so every line on disk
  // is missing it. Left undefined, the branch below would build a text block
  // holding `undefined`.
  const m: Message = {
    ...msg,
    content: msg.content ?? "",
    images: msg.images ?? [],
    content_blocks: msg.content_blocks ?? [],
  };

  if (m.content_blocks.length === 0 && m.content !== "") {
    m.content_blocks = [{ type: "text", text: m.content }];
  } else if (m.content_blocks.length > 0) {
    m.content = deriveContentFromBlocks(m.content_blocks, true);
  }

  if (m.alternatives !== undefined && m.alternatives.length > 0) {
    m.alternatives = m.alternatives.map(normalizeAlternative);
    const count = m.alternatives.length;
    m.alt_count = count;
    m.alt_index = Math.min(m.alt_index ?? count - 1, count - 1);
  }
  return m;
}

function normalizeAlternative(alt: MessageAlternative): MessageAlternative {
  const a: MessageAlternative = {
    ...alt,
    content: alt.content ?? "",
    images: alt.images ?? [],
    content_blocks: alt.content_blocks ?? [],
  };
  if (a.content_blocks.length === 0 && a.content !== "") {
    a.content_blocks = [{ type: "text", text: a.content }];
  } else if (a.content_blocks.length > 0) {
    a.content = deriveContentFromBlocks(a.content_blocks, true);
  }
  return a;
}

// ── serialization ───────────────────────────────────────────────────────────

const stripImageData = (images: ImageRef[] | undefined): ImageRef[] | undefined =>
  images?.map(({ path, caption }) => ({
    path,
    ...(caption !== undefined ? { caption } : {}),
  }));

/**
 * One message as its `active.jsonl` line.
 *
 * Two things here look wrong and are not.
 *
 * **`content` is dropped.** It is derived from `content_blocks` on load, so
 * storing it would let the two disagree, and the disagreement would survive a
 * round trip. The wire protocol still carries it; only disk does not.
 *
 * **The key order is strange, and it is reproduced deliberately.** The Rust
 * builds the full object in field order and then calls `Map::remove("content")`
 * — and with serde_json's `preserve_order` that map is an `IndexMap`, whose
 * `remove` is a *swap*-remove. The last key is moved into the hole. So a plain
 * message serializes `msg_id, role, timestamp, images, content_blocks` with
 * `timestamp` sitting third, and a message carrying `origin` puts `origin`
 * there instead. Which key lands in slot 2 depends on which optionals are
 * present.
 *
 * Nothing depends on key order to parse, so this could be normalised — but the
 * daemon is still writing this file too, and byte-identity is the only version
 * of parity that cannot quietly drift. Worth normalising once the Rust side is
 * gone; it costs one whole-file rewrite when it happens.
 */
export function serializeForStorage(msg: Message): string {
  // Declaration order from `shore_common::protocol::types::Message`, skipping
  // what serde skips: absent options and empty `alternatives`.
  const ordered: [string, unknown][] = [
    ["msg_id", msg.msg_id],
    ["role", msg.role],
    ["content", msg.content],
    ["images", stripImageData(msg.images) ?? []],
    ["content_blocks", msg.content_blocks],
  ];
  if (msg.alt_index !== undefined) ordered.push(["alt_index", msg.alt_index]);
  if (msg.alt_count !== undefined) ordered.push(["alt_count", msg.alt_count]);
  if (msg.alternatives !== undefined && msg.alternatives.length > 0) {
    ordered.push([
      "alternatives",
      msg.alternatives.map((a) => {
        const out: Record<string, unknown> = { content: a.content };
        out["images"] = stripImageData(a.images) ?? [];
        out["content_blocks"] = a.content_blocks;
        out["timestamp"] = a.timestamp;
        if (a.provider_key !== undefined) out["provider_key"] = a.provider_key;
        if (a.model !== undefined) out["model"] = a.model;
        return out;
      }),
    ]);
  }
  ordered.push(["timestamp", msg.timestamp]);
  if (msg.provider_key !== undefined) ordered.push(["provider_key", msg.provider_key]);
  if (msg.model !== undefined) ordered.push(["model", msg.model]);
  if (msg.origin !== undefined) ordered.push(["origin", msg.origin]);

  // The swap-remove: drop `content` at index 2 and move the last entry there.
  const contentAt = 2;
  const last = ordered.pop()!;
  if (ordered.length > contentAt) ordered[contentAt] = last;

  const obj: Record<string, unknown> = {};
  for (const [k, v] of ordered) obj[k] = v;
  return JSON.stringify(obj);
}

// ── predicates ──────────────────────────────────────────────────────────────

/** A user turn carrying only tool results is part of the previous turn. */
export function isToolResultOnly(m: Message): boolean {
  return (
    m.role === "user" &&
    m.content_blocks.length > 0 &&
    m.content_blocks.every((b) => b.type === "tool_result")
  );
}

const isRealUserTurn = (m: Message): boolean => m.role === "user" && !isToolResultOnly(m);

/**
 * An alternative captured from a message: its non-blank text blocks only.
 *
 * Thinking, tool calls and tool results are all dropped — an alternative is a
 * response a person chooses between, and the machinery that produced it is not
 * part of that choice. When nothing survives, the message's own `content` is
 * used so an alternative is never empty for a message that said something.
 */
function alternativeFromMessage(msg: Message): MessageAlternative {
  let blocks: ContentBlock[] = msg.content_blocks.filter(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text" && b.text.trim() !== "",
  );
  let content = deriveContentFromBlocks(blocks, false);
  if (content === "" && msg.content.trim() !== "") {
    content = msg.content;
    blocks = [{ type: "text", text: msg.content }];
  }
  return {
    content,
    images: [...msg.images],
    content_blocks: blocks,
    timestamp: msg.timestamp,
    ...(msg.provider_key !== undefined ? { provider_key: msg.provider_key } : {}),
    ...(msg.model !== undefined ? { model: msg.model } : {}),
  };
}

/**
 * Rebuild a message from one of its own alternatives.
 *
 * Provenance prefers the alternative's own and falls back to the template's,
 * for alternatives stored before per-alternative tracking existed. The same
 * rule covers the timestamp, where the marker for "not recorded" is an empty
 * string rather than an absent field.
 */
function messageFromAlternative(template: Message, index: number): Message | undefined {
  const alt = template.alternatives?.[index];
  if (alt === undefined) return undefined;
  const provider = alt.provider_key ?? template.provider_key;
  const model = alt.model ?? template.model;
  return normalizeMessage({
    msg_id: template.msg_id,
    role: "assistant" as Role,
    content: alt.content,
    images: alt.images,
    content_blocks: alt.content_blocks,
    alt_index: index,
    alt_count: template.alternatives?.length ?? 0,
    alternatives: template.alternatives ?? [],
    ...(provider !== undefined ? { provider_key: provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(template.origin !== undefined ? { origin: template.origin } : {}),
    timestamp: alt.timestamp === "" ? template.timestamp : alt.timestamp,
  });
}

// ── the store ───────────────────────────────────────────────────────────────

export class MessageStore {
  #messages: Message[];
  readonly #path: string;

  private constructor(path: string, messages: Message[]) {
    this.#path = path;
    this.#messages = messages;
  }

  /** An empty store that will persist to `path`. */
  static create(path: string): MessageStore {
    return new MessageStore(path, []);
  }

  /** Read a store from disk. A file that does not exist is an empty store —
   *  a character that has not spoken yet is not an error. */
  static async load(path: string): Promise<MessageStore> {
    return (await MessageStore.loadWithRaw(path)).store;
  }

  /**
   * Load, and hand back the raw bytes alongside.
   *
   * Compaction wants both views — the parsed messages to decide what to
   * archive, the exact bytes to write into the archive — and reading the file
   * twice is neither cheap nor guaranteed to see the same thing.
   */
  static async loadWithRaw(path: string): Promise<{ store: MessageStore; raw: string }> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { store: new MessageStore(path, []), raw: "" };
      }
      throw e;
    }
    const messages: Message[] = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      let parsed: Message;
      try {
        parsed = JSON.parse(line) as Message;
      } catch (e) {
        // A corrupt line fails the whole load rather than being skipped:
        // silently dropping a turn would leave a conversation with a hole in
        // it and no indication why.
        throw new JsonParseError(path, (e as Error).message);
      }
      messages.push(normalizeMessage(parsed));
    }
    return { store: new MessageStore(path, messages), raw };
  }

  get path(): string {
    return this.#path;
  }

  messages(): readonly Message[] {
    return this.#messages;
  }

  messageCount(): number {
    return this.#messages.length;
  }

  /** Real user turns. Tool exchanges belong to the turn that provoked them. */
  turnCount(): number {
    return this.#messages.filter(isRealUserTurn).length;
  }

  /** Everything up to and including the last real user turn — the history a
   *  regeneration prompts against, so the model does not see the reply it is
   *  being asked to replace. */
  messagesThroughLastUserTurn(): Message[] {
    return this.#messages.slice(0, this.#keepIndex());
  }

  async clear(): Promise<void> {
    this.#messages = [];
    await this.#persist();
  }

  async append(msg: Message): Promise<void> {
    this.#messages.push(msg);
    await this.#persist();
  }

  /**
   * Insert at the position the timestamp implies, rather than at the end.
   *
   * A heartbeat tick can finish after a user message has already landed, and
   * appending would put it out of order. An unparseable timestamp on the *new*
   * message falls back to appending; an unparseable one already in the file
   * compares as "before", so the new message lands after it — neither silently
   * reorders data that is already malformed.
   */
  async insertByTimestamp(msg: Message): Promise<void> {
    const at = Date.parse(msg.timestamp);
    let pos: number;
    if (Number.isNaN(at)) {
      pos = this.#messages.length;
    } else {
      pos = 0;
      for (let i = this.#messages.length - 1; i >= 0; i--) {
        const existing = Date.parse(this.#messages[i]!.timestamp);
        if (Number.isNaN(existing) || existing <= at) {
          pos = i + 1;
          break;
        }
      }
    }
    this.#messages.splice(pos, 0, msg);
    await this.#persist();
  }

  /** Rewrite a message's text. Blocks are replaced wholesale by a single text
   *  block, so an edit discards thinking and tool calls. */
  async edit(msgId: string, newContent: string): Promise<void> {
    const msg = this.#messages.find((m) => m.msg_id === msgId);
    if (msg === undefined) throw new MessageNotFound(msgId);
    msg.content = newContent;
    msg.content_blocks = [{ type: "text", text: newContent }];
    await this.#persist();
  }

  /** Drop everything after the last real user turn. Returns how many went. */
  async truncateAfterLastUserTurn(): Promise<number> {
    const keep = this.#keepIndex();
    const removed = this.#messages.length - keep;
    if (removed > 0) {
      this.#messages.length = keep;
      await this.#persist();
    }
    return removed;
  }

  /** Swap the tail for a freshly generated one, atomically. */
  async replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    const keep = this.#keepIndex();
    const removed = this.#messages.length - keep;
    this.#messages.length = keep;
    this.#messages.push(...newMessages);
    await this.#persist();
    return removed;
  }

  async delete(msgId: string): Promise<void> {
    const idx = this.#messages.findIndex((m) => m.msg_id === msgId);
    if (idx === -1) throw new MessageNotFound(msgId);
    this.#messages.splice(idx, 1);
    await this.#persist();
  }

  async setAlt(msgId: string, index: number, count: number): Promise<void> {
    const msg = this.#messages.find((m) => m.msg_id === msgId);
    if (msg === undefined) throw new MessageNotFound(msgId);
    msg.alt_index = index;
    msg.alt_count = count;
    await this.#persist();
  }

  /** Bump the candidate count and point at the newest. */
  async addAltCandidate(msgId: string): Promise<number> {
    const msg = this.#messages.find((m) => m.msg_id === msgId);
    if (msg === undefined) throw new MessageNotFound(msgId);
    const next = (msg.alt_count ?? 1) + 1;
    msg.alt_count = next;
    msg.alt_index = next - 1;
    await this.#persist();
    return next;
  }

  /**
   * The alternatives a regeneration is about to replace.
   *
   * The tail is merged first, so a response that took a tool loop is captured
   * as the one turn a person would see rather than as its rounds. When the
   * message already has alternatives, the active slot is overwritten with what
   * is currently there — the stored copy can be stale after an edit.
   */
  pendingRegenAlt(): PendingAlt | undefined {
    const tail = this.#messages.slice(this.#keepIndex());
    const merged = mergeToolLoopMessages(tail);
    const active = [...merged].reverse().find((m) => m.role === "assistant");
    if (active === undefined) return undefined;

    const alternatives = [...(active.alternatives ?? [])];
    const current = alternativeFromMessage(active);
    if (alternatives.length === 0) {
      alternatives.push(current);
    } else {
      const lastAlt = alternatives.length - 1;
      const idx = Math.min(active.alt_index ?? lastAlt, lastAlt);
      if (alternatives[idx] !== undefined) alternatives[idx] = current;
    }
    return { alternatives };
  }

  /**
   * Stamp `prior` plus the just-generated response onto the last assistant
   * message in `messages`.
   *
   * Static because it runs on a tail that has not been committed to the store
   * yet. The merge is only used to *find* which message is active; the fields
   * are written to the raw message with that id, since the merged copy is a
   * clone and would be thrown away.
   */
  static attachGeneratedAlt(
    messages: Message[],
    prior: MessageAlternative[],
  ): [number, number] | undefined {
    const merged = mergeToolLoopMessages(messages);
    const active = [...merged].reverse().find((m) => m.role === "assistant");
    if (active === undefined) return undefined;

    const all = [...prior, alternativeFromMessage(active)];
    const altIndex = all.length - 1;

    const target = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.msg_id === active.msg_id);
    if (target === undefined) return undefined;
    target.alt_index = altIndex;
    target.alt_count = all.length;
    target.alternatives = all;
    return [altIndex, all.length];
  }

  /**
   * Switch a message to one of its stored alternates.
   *
   * Two paths, and the difference matters. When the message is the current
   * tail, everything after the last real user turn is dropped and the selected
   * body replaces it — which discards the tool loop that produced the reply,
   * because that loop belongs to the response being replaced. When it is an
   * older message, it is swapped in place and the conversation after it stands.
   */
  async selectAlt(msgId: string, index: number): Promise<AltSelection> {
    const merged = mergeToolLoopMessages([...this.#messages]);
    const target = merged.find((m) => m.msg_id === msgId);
    if (target === undefined) throw new MessageNotFound(msgId);

    const altCount = target.alternatives?.length ?? 0;
    if (altCount === 0) {
      throw new InvalidAlt(`message ${msgId} has no alternate responses`);
    }
    const outOfRange = (): InvalidAlt =>
      new InvalidAlt(
        `alternate index ${index + 1} out of range (message has ${altCount} alternate response(s))`,
      );
    if (index >= altCount) throw outOfRange();

    if ((target.alt_index ?? 0) === index) {
      // Already showing it. Reported from the merged view, so the content is
      // the whole turn rather than the raw message's fragment.
      return { msg_id: target.msg_id, alt_index: index, alt_count: altCount, content: target.content };
    }

    const selected = messageFromAlternative(target, index);
    if (selected === undefined) throw outOfRange();

    const keep = this.#keepIndex();
    const tailMerged = mergeToolLoopMessages(this.#messages.slice(keep));
    const isCurrentTail =
      [...tailMerged].reverse().find((m) => m.role === "assistant")?.msg_id === msgId;

    if (isCurrentTail) {
      this.#messages.length = keep;
      this.#messages.push(selected);
    } else {
      const idx = this.#messages.findIndex((m) => m.msg_id === msgId);
      if (idx === -1) throw new MessageNotFound(msgId);
      this.#messages[idx] = selected;
    }

    await this.#persist();
    return {
      msg_id: selected.msg_id,
      alt_index: index,
      alt_count: altCount,
      content: selected.content,
    };
  }

  #keepIndex(): number {
    for (let i = this.#messages.length - 1; i >= 0; i--) {
      if (isRealUserTurn(this.#messages[i]!)) return i + 1;
    }
    return 0;
  }

  /** Rewrite the whole file through a temp file and a rename. */
  async #persist(): Promise<void> {
    let buf = "";
    for (const msg of this.#messages) buf += `${serializeForStorage(msg)}\n`;

    const dir = dirname(this.#path);
    await mkdir(dir, { recursive: true });
    // Same-directory temp so the rename stays on one filesystem and is atomic.
    const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, buf, "utf8");
    await rename(tmp, this.#path);
  }
}
