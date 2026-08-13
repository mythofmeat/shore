import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rustTrim } from "../memory/lines.ts";
import { mergeToolLoopMessages } from "./merge";
import type { ContentBlock, ImageRef, Message, MessageAlternative, Role } from "./types";

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

export interface PendingAlt {
  alternatives: MessageAlternative[];
}

export interface AltSelection {
  msg_id: string;
  alt_index: number;
  alt_count: number;
  content: string;
}

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

export function normalizeMessage(msg: Message): Message {
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

const stripImageData = (images: ImageRef[] | undefined): ImageRef[] | undefined =>
  images?.map(({ path, caption }) => ({
    path,
    ...(caption !== undefined ? { caption } : {}),
  }));

function serializeForStorage(msg: Message): string {
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

  const contentAt = 2;
  const last = ordered.pop()!;
  if (ordered.length > contentAt) ordered[contentAt] = last;

  const obj: Record<string, unknown> = {};
  for (const [k, v] of ordered) obj[k] = v;
  return JSON.stringify(obj);
}

export function isToolResultOnly(m: Message): boolean {
  return (
    m.role === "user" &&
    m.content_blocks.length > 0 &&
    m.content_blocks.every((b) => b.type === "tool_result")
  );
}

const isRealUserTurn = (m: Message): boolean => m.role === "user" && !isToolResultOnly(m);

function keptInAlternative(b: ContentBlock): boolean {
  if (b.type === "thinking" || b.type === "redacted_thinking") return true;
  return b.type === "text" && b.text.trim() !== "";
}

function alternativeFromMessage(msg: Message): MessageAlternative {
  let blocks: ContentBlock[] = msg.content_blocks.filter(keptInAlternative);
  let content = deriveContentFromBlocks(blocks, false);
  if (content === "" && msg.content.trim() !== "") {
    content = msg.content;
    blocks = [...blocks, { type: "text", text: msg.content }];
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

export class MessageStore {
  #messages: Message[];
  readonly #path: string;

  private constructor(path: string, messages: Message[]) {
    this.#path = path;
    this.#messages = messages;
  }

  static create(path: string): MessageStore {
    return new MessageStore(path, []);
  }

  static async load(path: string): Promise<MessageStore> {
    return (await MessageStore.loadWithRaw(path)).store;
  }

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

  turnCount(): number {
    return this.#messages.filter(isRealUserTurn).length;
  }

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

  async edit(msgId: string, newContent: string): Promise<void> {
    const msg = this.#messages.find((m) => m.msg_id === msgId);
    if (msg === undefined) throw new MessageNotFound(msgId);
    msg.content = newContent;
    msg.content_blocks = [{ type: "text", text: newContent }];
    await this.#persist();
  }

  async truncateAfterLastUserTurn(): Promise<number> {
    const keep = this.#keepIndex();
    const removed = this.#messages.length - keep;
    if (removed > 0) {
      this.#messages.length = keep;
      await this.#persist();
    }
    return removed;
  }

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

  async addAltCandidate(msgId: string): Promise<number> {
    const msg = this.#messages.find((m) => m.msg_id === msgId);
    if (msg === undefined) throw new MessageNotFound(msgId);
    const next = (msg.alt_count ?? 1) + 1;
    msg.alt_count = next;
    msg.alt_index = next - 1;
    await this.#persist();
    return next;
  }

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

  async #persist(): Promise<void> {
    let buf = "";
    for (const msg of this.#messages) buf += `${serializeForStorage(msg)}\n`;

    const dir = dirname(this.#path);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, buf, "utf8");
    await rename(tmp, this.#path);
  }
}
