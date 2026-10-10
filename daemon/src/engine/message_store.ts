import { readDurable, writeDurable, appendDurableLine, initializeDurableLines, replaceDurableSuffix, updateDurableLine, durablePath, type DurableFile } from "../storage/files.ts";
import { required } from "../util/required.ts";

import { shoreLog } from "../log.ts";


import { rustTrim } from "../memory/lines.ts";
import {
  auditAlternatives,
  describeAlternativeDefects,
  type AlternativeDefect,
} from "./alt_audit.ts";
import { backupBeforeWrite, quarantineLines } from "./backup.ts";
import { mergeToolLoopMessages } from "./merge";
import type { ContentBlock, ImageRef, Message, MessageAlternative } from "./types";
import { alternativeVersionOf, isRealUserTurn, newMessageVersion, versionOf } from "./versions.ts";

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

export interface PendingAlt {
  alternatives: MessageAlternative[];
}

export interface AltSelection {
  msg_id: string;
  alt_index: number;
  alt_count: number;
  content: string;
}

function versioned(msg: Message): Message {
  return versionOf(msg) === undefined ? { ...msg, version: newMessageVersion() } : msg;
}

interface Mutation<T> {
  changed: boolean;
  result: T;
}

const changed = <T>(result: T): Mutation<T> => ({ changed: true, result });
const unchanged = <T>(result: T): Mutation<T> => ({ changed: false, result });

function editAssistantText(blocks: ContentBlock[], newContent: string): ContentBlock[] {
  const edited: ContentBlock[] = [];
  let replaced = false;
  for (const block of blocks) {
    if (block.type !== "text") {
      edited.push(block);
    } else if (!replaced) {
      edited.push({ type: "text", text: newContent });
      replaced = true;
    }
  }
  if (!replaced) edited.push({ type: "text", text: newContent });
  return edited;
}

function toolResultBlockText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
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
      const raw = typeof b.content === "string" ? b.content : toolResultBlockText(b.content);
      const t = rustTrim(raw);
      if (t !== "") parts.push(t);
    }
  }
  return parts.join("\n");
}

export function normalizeMessage(msg: Message): Message {
  const m: Message = {
    ...msg,
    content: deriveContentFromBlocks(msg.content_blocks, true),
  };

  if (m.alternatives !== undefined && m.alternatives.length > 0) {
    m.alternatives = m.alternatives.map(normalizeAlternative);
    const count = m.alternatives.length;
    m.alt_count = count;
    m.alt_index = Math.min(m.alt_index ?? count - 1, count - 1);
  }
  return m;
}

function normalizeAlternative(alt: MessageAlternative): MessageAlternative {
  return {
    ...alt,
    content: deriveContentFromBlocks(alt.content_blocks, true),
  };
}

const stripImageData = (images: ImageRef[] | undefined): ImageRef[] | undefined =>
  images?.map(({ data: _data, ...image }) => image);

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
        const out: Record<string, unknown> = {
          content: a.content,
          images: stripImageData(a.images) ?? [],
          content_blocks: a.content_blocks,
          timestamp: a.timestamp,
        };
        if (a.provider_key !== undefined) out["provider_key"] = a.provider_key;
        if (a.model !== undefined) out["model"] = a.model;
        if (a.version !== undefined) out["version"] = a.version;
        return out;
      }),
    ]);
  }
  if (msg.version !== undefined) ordered.push(["version", msg.version]);
  ordered.push(["timestamp", msg.timestamp]);
  if (msg.provider_key !== undefined) ordered.push(["provider_key", msg.provider_key]);
  if (msg.model !== undefined) ordered.push(["model", msg.model]);
  if (msg.origin !== undefined) ordered.push(["origin", msg.origin]);

  const contentAt = 2;
  const last = required(ordered.pop());
  if (ordered.length > contentAt) ordered[contentAt] = last;

  const obj: Record<string, unknown> = {};
  for (const [k, v] of ordered) obj[k] = v;
  return JSON.stringify(obj);
}

export function serializeMessages(messages: readonly Message[]): string {
  let out = "";
  for (const message of messages) out += `${serializeForStorage(message)}\n`;
  return out;
}

export function isToolResultOnly(m: Message): boolean {
  return (
    m.role === "user" &&
    m.content_blocks.length > 0 &&
    m.content_blocks.every((b) => b.type === "tool_result")
  );
}

function toolUseIdsOffered(msg: Message | undefined): Set<string> {
  if (msg === undefined || msg.role !== "assistant") return new Set();
  const ids = msg.content_blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
  return new Set(ids);
}

export function withoutOrphanToolResults(messages: readonly Message[]): Message[] {
  const kept: Message[] = [];
  for (const msg of messages) {
    if (!msg.content_blocks.some((b) => b.type === "tool_result")) {
      kept.push(msg);
      continue;
    }
    const offered = toolUseIdsOffered(kept[kept.length - 1]);
    const blocks = msg.content_blocks.filter(
      (b) => b.type !== "tool_result" || offered.has(b.tool_use_id),
    );
    if (blocks.length === 0) continue;
    if (blocks.length === msg.content_blocks.length) {
      kept.push(msg);
      continue;
    }
    kept.push({
      ...msg,
      content_blocks: blocks,
      content: deriveContentFromBlocks(blocks, true),
      version: newMessageVersion(),
    });
  }
  return kept;
}

function unansweredTailToolUseIds(messages: readonly Message[]): string[] {
  let latestAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (required(messages[index]).role === "assistant") {
      latestAssistant = index;
      break;
    }
  }
  if (latestAssistant < 0) return [];

  const offered = required(messages[latestAssistant]).content_blocks.flatMap((block) =>
    block.type === "tool_use" ? [block.id] : [],
  );
  if (offered.length === 0) return [];

  const answered = new Set(
    messages.slice(latestAssistant + 1).flatMap((message) =>
      message.content_blocks.flatMap((block) =>
        block.type === "tool_result" ? [block.tool_use_id] : [],
      ),
    ),
  );
  return offered.filter((id) => !answered.has(id));
}

export function cannotTravelInAlternative(b: ContentBlock): boolean {
  if (b.type === "tool_use" || b.type === "tool_result") return true;
  return b.type === "text" && b.text.trim() === "";
}

function keptInAlternative(b: ContentBlock): boolean {
  return !cannotTravelInAlternative(b);
}

function alternativeFromMessage(msg: Message): MessageAlternative {
  let blocks: ContentBlock[] = structuredClone(msg.content_blocks).filter(keptInAlternative);
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
    ...(versionOf(msg) === undefined ? {} : { version: msg.version }),
  };
}

function stampAlternativeVersion(message: Message, index: number): void {
  const alternative = message.alternatives?.[index];
  if (alternative === undefined) return;
  if (alternativeVersionOf(alternative) === undefined) alternative.version = newMessageVersion();
}

function messageFromAlternative(template: Message, index: number): Message | undefined {
  const alt = template.alternatives?.[index];
  if (alt === undefined) return undefined;
  const provider = alt.provider_key ?? template.provider_key;
  const model = alt.model ?? template.model;
  const version = alternativeVersionOf(alt);
  return normalizeMessage({
    ...(version === undefined ? {} : { version }),
    msg_id: template.msg_id,
    role: "assistant",
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
  readonly #file: DurableFile;
  #mutationTail: Promise<void> = Promise.resolve();
  #quarantined = 0;
  #repairRows = false;
  #altDefects: readonly AlternativeDefect[] = [];

  private constructor(path: DurableFile, messages: Message[]) {
    this.#path = durablePath(path);
    this.#file = path;
    this.#messages = messages;
  }

  static create(path: DurableFile): MessageStore {
    const store = new MessageStore(path, []);
    store.#repairRows = true;
    return store;
  }

  static async load(path: DurableFile): Promise<MessageStore> {
    return (await MessageStore.loadWithRaw(path)).store;
  }

  static async loadWithRaw(
    path: DurableFile,
  ): Promise<{ store: MessageStore; raw: string }> {
    let raw: string;
    try {
      raw = readDurable(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { store: new MessageStore(path, []), raw: "" };
      }
      throw e;
    }
    const messages: Message[] = [];
    const unreadable: string[] = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      let parsed: Message;
      try {
        parsed = JSON.parse(line) as Message;
      } catch {
        unreadable.push(rawLine);
        continue;
      }
      messages.push(normalizeMessage(parsed));
    }

    if (unreadable.length > 0) {
      const quarantined = await quarantineLines(path, unreadable);
      shoreLog.error(
        `shore: ${String(unreadable.length)} unreadable line(s) in ${durablePath(path)} were quarantined` +
          `${quarantined === undefined ? "" : ` to ${quarantined}`}; ` +
          `${String(messages.length)} message(s) loaded`,
      );
    }

    const defects = auditAlternatives(messages);
    const report = describeAlternativeDefects(durablePath(path), defects);
    if (report !== undefined) shoreLog.warn(report);

    const store = new MessageStore(path, messages);
    store.#quarantined = unreadable.length;
    store.#repairRows = (raw.match(/[^\n]*\n|[^\n]+$/g) ?? []).length !== messages.length;
    store.#altDefects = defects;
    return { store, raw };
  }

  get path(): string {
    return this.#path;
  }

  get quarantinedLines(): number {
    return this.#quarantined;
  }

  get alternativeDefects(): readonly AlternativeDefect[] {
    return this.#altDefects;
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

  startedAt(): string | undefined {
    const oldest = this.#messages[0];
    if (oldest === undefined) return undefined;
    const at = new Date(oldest.timestamp);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  }

  messagesThroughLastUserTurn(): Message[] {
    return this.#messages.slice(0, this.#keepIndex());
  }

  messagesAfterLastUserTurn(): Message[] {
    return this.#messages.slice(this.#keepIndex());
  }

  async append(msg: Message): Promise<void> {
    const candidate = versioned(structuredClone(msg));
    return await this.#enqueue(async () => {
      this.#prepareRows();
      appendDurableLine(this.#file, `${serializeForStorage(candidate)}\n`);
      this.#messages.push(candidate);
    });
  }

  async recoverInterruptedToolLoop(msgId: string, timestamp: string): Promise<number> {
    return await this.#mutate((messages) => {
      const tail = messages.slice(this.#keepIndex(messages));
      const missing = unansweredTailToolUseIds(tail);
      if (missing.length === 0) return unchanged(0);
      const blocks: ContentBlock[] = missing.map((toolUseId) => ({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "Tool execution was interrupted by a Shore daemon restart before it returned a result.",
        is_error: true,
      }));
      messages.push({
        msg_id: msgId,
        role: "user",
        content: deriveContentFromBlocks(blocks, true),
        images: [],
        content_blocks: blocks,
        timestamp,
        version: newMessageVersion(),
      });
      return changed(missing.length);
    });
  }

  async edit(msgId: string, newContent: string): Promise<void> {
    return await this.#enqueue(async () => {
      const index = this.#messages.findIndex(message => message.msg_id === msgId);
      if (index === -1) throw new MessageNotFound(msgId);
      const msg = structuredClone(required(this.#messages[index]));
      msg.content = newContent;
      msg.content_blocks = msg.role === "assistant" ? editAssistantText(msg.content_blocks, newContent) : [{ type: "text", text: newContent }];
      msg.version = newMessageVersion();
      await backupBeforeWrite(this.#file);
      this.#prepareRows();
      updateDurableLine(this.#file, index, `${serializeForStorage(msg)}\n`);
      this.#messages[index] = msg;
    });
  }

  async replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    const replacements = structuredClone(newMessages).map(versioned);
    return await this.#enqueue(async () => {
      const keep = this.#keepIndex();
      const removed = this.#messages.length - keep;
      const candidates = new Map(replacements.map(message => [message.msg_id, message]));
      const preserves = this.#messages.slice(keep).every(previous => {
        const replacement = candidates.get(previous.msg_id);
        if (replacement === undefined) return false;
        const { version: _beforeVersion, ...before } = previous;
        const { version: _afterVersion, ...after } = replacement;
        if (serializeForStorage(before) !== serializeForStorage(after)) return false;
        if (previous.version !== undefined) replacement.version = previous.version;
        return true;
      });
      if (!preserves) await backupBeforeWrite(this.#file);
      this.#prepareRows();
      replaceDurableSuffix(this.#file, keep, replacements.map(message => `${serializeForStorage(message)}\n`));
      this.#messages.length = keep;
      this.#messages.push(...replacements);
      return removed;
    });
  }

  async deleteAll(msgIds: readonly string[]): Promise<void> {
    const doomed = new Set(msgIds);
    await this.#mutate((messages) => {
      for (const msgId of doomed) {
        if (!messages.some((m) => m.msg_id === msgId)) throw new MessageNotFound(msgId);
      }
      const kept = withoutOrphanToolResults(messages.filter((m) => !doomed.has(m.msg_id)));
      messages.length = 0;
      messages.push(...kept);
      return changed(undefined);
    });
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
    return await this.#mutate((messages) => {
      const merged = mergeToolLoopMessages([...messages]);
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

      stampAlternativeVersion(target, index);

      if ((target.alt_index ?? 0) === index) {
        return unchanged({
          msg_id: target.msg_id,
          alt_index: index,
          alt_count: altCount,
          content: target.content,
        });
      }

      const selected = messageFromAlternative(target, index);
      if (selected === undefined) throw outOfRange();

      const keep = this.#keepIndex(messages);
      const tailMerged = mergeToolLoopMessages(messages.slice(keep));
      const isCurrentTail =
        [...tailMerged].reverse().find((m) => m.role === "assistant")?.msg_id === msgId;

      if (isCurrentTail) {
        messages.length = keep;
        messages.push(selected);
      } else {
        const idx = messages.findIndex((m) => m.msg_id === msgId);
        if (idx === -1) throw new MessageNotFound(msgId);
        messages[idx] = selected;
      }

      return changed({
        msg_id: selected.msg_id,
        alt_index: index,
        alt_count: altCount,
        content: selected.content,
      });
    });
  }

  #keepIndex(messages: readonly Message[] = this.#messages): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserTurn(required(messages[i]))) return i + 1;
    }
    return 0;
  }

  #prepareRows(): void {
    initializeDurableLines(this.#file, () => serializeMessages(this.#messages), this.#repairRows);
    this.#repairRows = false;
  }

  async #mutate<T>(mutation: (messages: Message[]) => Mutation<T>): Promise<T> {
    return await this.#enqueue(async () => {
      const nextMessages = structuredClone(this.#messages);
      const { changed: didChange, result } = mutation(nextMessages);
      if (!didChange) return result;
      await this.#persist(nextMessages);
      this.#messages = nextMessages;
      return result;
    });
  }

  async #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const predecessor = this.#mutationTail;
    const gate = Promise.withResolvers<void>();
    this.#mutationTail = gate.promise;
    await predecessor;
    try { return await run(); }
    finally { gate.resolve(); }
  }

  async #persist(messages: readonly Message[]): Promise<void> {
    await backupBeforeWrite(this.#file);
    writeDurable(this.#file, serializeMessages(messages));
  }
}
