import { required } from "../util/required.ts";

import { shoreLog } from "../log.ts";

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rustTrim } from "../memory/lines.ts";
import {
  auditAlternatives,
  describeAlternativeDefects,
  type AlternativeDefect,
} from "./alt_audit.ts";
import { backupBeforeWrite, quarantineLines } from "./backup.ts";
import { mergeToolLoopMessages } from "./merge";
import type { ContentBlock, ImageRef, Message, MessageAlternative } from "./types";

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

export interface MessageStoreIo {
  backup(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  tempPath(dir: string): string;
}

const messageStoreIo: MessageStoreIo = {
  backup: async (path) => {
    await backupBeforeWrite(path);
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, contents) => {
    await writeFile(path, contents, "utf8");
  },
  rename,
  remove: async (path) => {
    await rm(path, { force: true });
  },
  tempPath: (dir) => join(dir, `.${crypto.randomUUID()}.tmp`),
};

interface Mutation<T> {
  changed: boolean;
  result: T;
}

const changed = <T>(result: T): Mutation<T> => ({ changed: true, result });
const unchanged = <T>(result: T): Mutation<T> => ({ changed: false, result });

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
        const out: Record<string, unknown> = {
          content: a.content,
          images: stripImageData(a.images) ?? [],
          content_blocks: a.content_blocks,
          timestamp: a.timestamp,
        };
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
  const last = required(ordered.pop());
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
    kept.push({ ...msg, content_blocks: blocks, content: deriveContentFromBlocks(blocks, true) });
  }
  return kept;
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
  };
}

function messageFromAlternative(template: Message, index: number): Message | undefined {
  const alt = template.alternatives?.[index];
  if (alt === undefined) return undefined;
  const provider = alt.provider_key ?? template.provider_key;
  const model = alt.model ?? template.model;
  return normalizeMessage({
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
  readonly #io: MessageStoreIo;
  #mutationTail: Promise<void> = Promise.resolve();
  #quarantined = 0;
  #altDefects: readonly AlternativeDefect[] = [];

  private constructor(path: string, messages: Message[], io: MessageStoreIo) {
    this.#path = path;
    this.#messages = messages;
    this.#io = io;
  }

  static create(path: string, io: MessageStoreIo = messageStoreIo): MessageStore {
    return new MessageStore(path, [], io);
  }

  static async load(path: string, io: MessageStoreIo = messageStoreIo): Promise<MessageStore> {
    return (await MessageStore.loadWithRaw(path, io)).store;
  }

  static async loadWithRaw(
    path: string,
    io: MessageStoreIo = messageStoreIo,
  ): Promise<{ store: MessageStore; raw: string }> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { store: new MessageStore(path, [], io), raw: "" };
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
        `shore: ${String(unreadable.length)} unreadable line(s) in ${path} were quarantined` +
          `${quarantined === undefined ? "" : ` to ${quarantined}`}; ` +
          `${String(messages.length)} message(s) loaded`,
      );
    }

    const defects = auditAlternatives(messages);
    const report = describeAlternativeDefects(path, defects);
    if (report !== undefined) shoreLog.warn(report);

    const store = new MessageStore(path, messages, io);
    store.#quarantined = unreadable.length;
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

  async clear(): Promise<void> {
    await this.#mutate((messages) => {
      messages.length = 0;
      return changed(undefined);
    });
  }

  async append(msg: Message): Promise<void> {
    const candidate = structuredClone(msg);
    await this.#mutate((messages) => {
      messages.push(candidate);
      return changed(undefined);
    });
  }

  async insertByTimestamp(msg: Message): Promise<void> {
    const candidate = structuredClone(msg);
    await this.#mutate((messages) => {
      const at = Date.parse(candidate.timestamp);
      let pos: number;
      if (Number.isNaN(at)) {
        pos = messages.length;
      } else {
        pos = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
          const existing = Date.parse(required(messages[i]).timestamp);
          if (Number.isNaN(existing) || existing <= at) {
            pos = i + 1;
            break;
          }
        }
      }
      messages.splice(pos, 0, candidate);
      return changed(undefined);
    });
  }

  async edit(msgId: string, newContent: string): Promise<void> {
    await this.#mutate((messages) => {
      const msg = messages.find((m) => m.msg_id === msgId);
      if (msg === undefined) throw new MessageNotFound(msgId);
      msg.content = newContent;
      msg.content_blocks = [{ type: "text", text: newContent }];
      return changed(undefined);
    });
  }

  async truncateAfterLastUserTurn(): Promise<number> {
    return await this.#mutate((messages) => {
      const keep = this.#keepIndex(messages);
      const removed = messages.length - keep;
      if (removed === 0) return unchanged(0);
      messages.length = keep;
      return changed(removed);
    });
  }

  async replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    const replacements = structuredClone(newMessages);
    return await this.#mutate((messages) => {
      const keep = this.#keepIndex(messages);
      const removed = messages.length - keep;
      messages.length = keep;
      messages.push(...replacements);
      return changed(removed);
    });
  }

  async delete(msgId: string): Promise<void> {
    await this.deleteAll([msgId]);
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

  async setAlt(msgId: string, index: number, count: number): Promise<void> {
    await this.#mutate((messages) => {
      const msg = messages.find((m) => m.msg_id === msgId);
      if (msg === undefined) throw new MessageNotFound(msgId);
      msg.alt_index = index;
      msg.alt_count = count;
      return changed(undefined);
    });
  }

  async addAltCandidate(msgId: string): Promise<number> {
    return await this.#mutate((messages) => {
      const msg = messages.find((m) => m.msg_id === msgId);
      if (msg === undefined) throw new MessageNotFound(msgId);
      const next = (msg.alt_count ?? 1) + 1;
      msg.alt_count = next;
      msg.alt_index = next - 1;
      return changed(next);
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

  async #mutate<T>(mutation: (messages: Message[]) => Mutation<T>): Promise<T> {
    const predecessor = this.#mutationTail;
    const gate = Promise.withResolvers<void>();
    this.#mutationTail = gate.promise;
    await predecessor;
    try {
      const nextMessages = structuredClone(this.#messages);
      const { changed: didChange, result } = mutation(nextMessages);
      if (!didChange) return result;
      await this.#persist(nextMessages);
      this.#messages = nextMessages;
      return result;
    } finally {
      gate.resolve();
    }
  }

  async #persist(messages: readonly Message[]): Promise<void> {
    await this.#io.backup(this.#path);
    let buf = "";
    for (const msg of messages) buf += `${serializeForStorage(msg)}\n`;

    const dir = dirname(this.#path);
    await this.#io.mkdir(dir);
    const tmp = this.#io.tempPath(dir);
    try {
      await this.#io.writeFile(tmp, buf);
      await this.#io.rename(tmp, this.#path);
    } catch (error) {
      await this.#io.remove(tmp).catch((cleanupError: unknown) => {
        shoreLog.warn(
          `shore: could not remove failed message-store write ${tmp}: ${String(cleanupError)}`,
        );
      });
      throw error;
    }
  }
}
